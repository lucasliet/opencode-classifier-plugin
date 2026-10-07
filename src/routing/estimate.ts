/**
 * Consumption forecast for one candidate model.
 *
 * The router compares subscription models, so it needs three different
 * currencies and one shared rule for turning them into "how much of this plan
 * would this task spend":
 *
 * 1. **Host truth** — a pay-as-you-go catalog entry publishes `costPerMTok`.
 * 2. **Curated burn** — a subscription catalog publishes an EMPTY `cost` array,
 *    so `src/routing/profiles.ts` carries the only per-token rate the router
 *    has for those models.
 * 3. **Burn proxy** — a model with neither is unprofiled; it gets a documented
 *    neutral rate instead of an invented market price.
 *
 * Everything here is pure: no clock, no I/O, no randomness. Forecasts are
 * monotonic in every workload input so a larger task can never look cheaper
 * than a smaller one, and every entry point returns a finite, non-negative
 * number for any input the host can produce.
 */

import type { ModelProfile, RoutableModel } from "./contracts.ts"
import type { ModelCostPerMTok, PricedModelProfile } from "./profiles.ts"

/** Tokens per USD rate unit: rates are published per million tokens. */
const TOKENS_PER_MTOK = 1_000_000

/**
 * Hard ceiling for any forecast, in USD.
 *
 * A forecast above this is noise from an implausible token count or from an
 * overflowing product; clamping keeps every downstream comparison finite
 * instead of letting a single `Infinity` win or lose a ranking.
 */
export const MAX_ESTIMATED_COST_USD = 1_000_000

/**
 * Neutral burn proxy, in USD per million tokens, for a model that publishes no
 * price anywhere.
 *
 * This is NOT a market price and must never be presented as one: it exists so
 * that an unprofiled model still lands on the same numeric scale as a priced
 * one. Its ratios are the only part that carries meaning — output is billed
 * dearer than input and a cache read is far cheaper than fresh input.
 */
export const UNPRICED_BURN_USD_PER_MTOK: Readonly<ModelCostPerMTok> = {
  input: 1,
  output: 4,
  cacheRead: 0.25,
  cacheWrite: 0,
}

/**
 * Extra burn charged to an unpriced model per point of `profile.reasoning`.
 *
 * Reasoning models emit far more reasoning tokens per turn, so treating them as
 * cheap under-states their quota cost. Bounded at +50% to keep the proxy from
 * out-ranking a published price it has no business contradicting.
 */
export const UNPRICED_REASONING_BURN_SCALE = 0.5

/**
 * Everything the caller knows about the task being routed.
 *
 * `effortMultiplier` is the profile's own `effortCost[variant] ?? 1`: the
 * selector resolves the variant first and passes the premium here, so the
 * forecast and the quota ledger can never disagree about what a variant costs.
 */
export interface EstimateInput {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly turns: number
  readonly cacheHitRatio: number
  readonly effortMultiplier: number
}

/** Per-million-token rates actually applied by {@link estimateCostUsd}. */
interface BurnRates {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
}

/**
 * Quota-burn multiplier of the effort gear a routing decision intends to use.
 *
 * When the selector emits no variant the host runs the model on its own
 * default gear, which plugins and providers are free to set to their most
 * expensive reasoning level (for example the zcode provider defaults GLM to
 * `max`). That default is invisible to this package, so the estimate must be
 * conservative: a model that exposes any priced gear is costed at its most
 * expensive one. Underestimating here would let a `max`-only model drain a
 * shared pool while the ledger still shows headroom.
 *
 * @param model Candidate whose curated profile holds the ladder.
 * @param variant Variant ID the selector intends to emit, or `undefined` when
 *   the host default is used.
 * @returns `profile.effortCost[variant]` when it is a positive finite number;
 *   the most expensive published gear when `variant` is `undefined` on a model
 *   that exposes priced gears; otherwise `1`.
 */
export function effortMultiplierFor(model: RoutableModel, variant: string | undefined): number {
  if (variant === undefined) {
    return worstGearMultiplier(model)
  }
  return priceOf(model.profile.effortCost[variant]) || 1
}

function worstGearMultiplier(model: RoutableModel): number {
  const gears = Object.values(model.profile.effortCost)
    .map((value) => priceOf(value))
    .filter((value): value is number => value !== undefined)
  if (gears.length === 0) return 1
  return Math.max(...gears)
}

/**
 * Forecast the USD one task would spend on a candidate model.
 *
 * Rate precedence, documented because it is the difference between a real
 * price and a guess:
 *
 * 1. `catalog.costPerMTok` when it publishes any price. The host is the source
 *    of truth for metered models.
 * 2. The curated `costPerMTok` from the model profile, which exists precisely
 *    because subscription providers report an empty `cost` array.
 * 3. {@link UNPRICED_BURN_USD_PER_MTOK} for a model with neither.
 *
 * A side that publishes no rate falls back to the other published side rather
 * than to zero, because a rate of zero in these payloads means "not published"
 * and never "free"; an unpublished cache-read rate therefore costs the same as
 * fresh input instead of pretending every turn is cached.
 *
 * Monotonicity contract: for finite, non-negative `inputTokens`, `outputTokens`,
 * `turns` and `effortMultiplier` the result is non-decreasing in each of them.
 * `cacheHitRatio` is intentionally the opposite direction — a higher cache hit
 * ratio is cheaper work, so the result is non-increasing in it.
 *
 * @param model Candidate whose rates and profile supply the forecast.
 * @param input Task shape plus the resolved variant premium.
 * @returns USD in `[0, MAX_ESTIMATED_COST_USD]`. `NaN`, `Infinity` and negative
 *   inputs collapse to `0` rather than propagating.
 */
export function estimateCostUsd(model: RoutableModel, input: EstimateInput): number {
  const rates = burnRatesOf(model)
  const inputTokens = nonNegative(input.inputTokens)
  const cachedTokens = inputTokens * clamp01(input.cacheHitRatio)
  const freshTokens = inputTokens - cachedTokens
  const outputTokens = nonNegative(input.outputTokens)
  const turns = nonNegative(input.turns)
  const premium = nonNegative(input.effortMultiplier)
  const costPerMTok =
    (freshTokens * rates.input + cachedTokens * rates.cacheRead + outputTokens * rates.output) / TOKENS_PER_MTOK
  return clampEstimate(costPerMTok * premium * turns)
}

/**
 * Translate a forecast into a share of one quota window's dollar allowance.
 *
 * A shared pool is why price-per-token alone is the wrong routing signal: two
 * models drawing from the same OpenCode Zen Go pool are billed against one
 * monthly allowance, but that allowance is split per model. `glm-5.3` and
 * `glm-5.3-flash` share the Go pool yet carry very different included
 * allowances, so the cheap model gets a proportionally larger share of the same
 * window and can legitimately absorb far more tokens before the pool is under
 * pressure. Ranking by USD alone would send every task to the cheap model and
 * then discover the pool is nearly empty.
 *
 * `windowShares` maps a window to the fraction of `includedUsageUsd` granted to
 * it (Go publishes 5h = 20%, weekly = 50%, monthly = 100%). Vendors that report
 * request windows instead of dollars have no allowance at all, so this returns
 * `null` and the router falls back to percentage pressure only.
 *
 * @param model Candidate whose profile holds the allowance.
 * @param variant Variant the selector intends to emit. Its effort premium is
 *   applied here, so pass the BASE forecast (effort multiplier of 1) to avoid
 *   charging the same variant twice.
 * @param costUsd Base forecast for the task, without the effort premium.
 * @param windowID Quota window being evaluated, such as `weekly` or `5h`.
 * @returns The fraction of that window's allowance the task is predicted to
 *   burn, which may exceed `1`, or `null` when the window has no published
 *   allowance. `null` means "unknown", never "free".
 */
export function estimateWindowPressure(
  model: RoutableModel,
  variant: string | undefined,
  costUsd: number,
  windowID: string,
): number | null {
  const share = priceOf(model.profile.windowShares[windowID])
  if (share <= 0) {
    return null
  }
  const allowance = priceOf(model.profile.includedUsageUsd) * share
  if (allowance <= 0) {
    return null
  }
  const burn = nonNegative(costUsd) * effortMultiplierFor(model, variant)
  return burn / allowance
}

/** Resolve the rates a candidate is scored with, following the documented precedence. */
function burnRatesOf(model: RoutableModel): BurnRates {
  const published = publishedRates(model.catalog.costPerMTok)
  if (published) {
    return published
  }
  const curated = curatedRates(model.profile)
  if (curated) {
    return curated
  }
  return proxyRates(model.profile)
}

/**
 * Rates a payload actually publishes.
 *
 * @returns `undefined` when no side publishes a price, which is the normal case
 *   for a subscription model reporting an empty `cost` array.
 */
function publishedRates(cost: ModelCostPerMTok): BurnRates | undefined {
  const input = priceOf(cost.input)
  const output = priceOf(cost.output)
  if (input === 0 && output === 0) {
    return undefined
  }
  const baseInput = input === 0 ? output : input
  const baseOutput = output === 0 ? input : output
  const cacheRead = priceOf(cost.cacheRead)
  return { input: baseInput, output: baseOutput, cacheRead: cacheRead === 0 ? baseInput : cacheRead }
}

/** Curated burn rates carried by a priced profile, when the row has any. */
function curatedRates(profile: ModelProfile): BurnRates | undefined {
  if (!Object.hasOwn(profile, "costPerMTok")) {
    return undefined
  }
  return publishedRates((profile as PricedModelProfile).costPerMTok)
}

/** Neutral proxy rates, scaled by how reasoning-heavy the profile looks. */
function proxyRates(profile: ModelProfile): BurnRates {
  const scale = 1 + clamp01(profile.reasoning) * UNPRICED_REASONING_BURN_SCALE
  return {
    input: UNPRICED_BURN_USD_PER_MTOK.input * scale,
    output: UNPRICED_BURN_USD_PER_MTOK.output * scale,
    cacheRead: UNPRICED_BURN_USD_PER_MTOK.cacheRead * scale,
  }
}

/** Accept only a finite positive number; anything else reads as "not published". */
function priceOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/** Collapse `NaN`, `Infinity` and negatives to `0`. */
function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** Clamp any ratio into `0..1`; `NaN` becomes `0`. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(1, Math.max(0, value))
}

/** Keep the forecast finite and non-negative, and cap an implausible overflow. */
function clampEstimate(value: number): number {
  if (Number.isNaN(value)) {
    return 0
  }
  if (value <= 0) {
    return 0
  }
  return Math.min(value, MAX_ESTIMATED_COST_USD)
}
