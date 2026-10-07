/**
 * The routing policy: which subscription model runs this task, and why.
 *
 * Order of decisions, and the reason the order matters:
 *
 * 1. **Capability gate** — a model that cannot call tools, cannot read an image,
 *    or cannot hold the prompt is not a candidate, whatever its quota.
 * 2. **Quality floor** — required quality is never traded for spare quota. A
 *    task that needs `advanced` gets an advanced model even when a free one
 *    exists, and a model with no curated profile is refused at that floor.
 * 3. **Quota gate** — an `exhausted` pool is skipped. `unknown` and `stale`
 *    pools are neither free nor blocked: they simply carry no pressure signal
 *    and pay a confidence penalty.
 * 4. **Effort choice** — the cheapest rung that still satisfies the reasoning
 *    need, resolved to a variant the model actually exposes.
 * 5. **Score** — quality surplus against quota pressure, burn and confidence.
 *
 * The module is pure: no I/O, no clock, no randomness, no mutation. The same
 * requirements, models and ledger always produce the same decision, and every
 * rejection is reported with a readable reason so a bad route is debuggable
 * from a log line alone.
 */

import type {
  CandidateReport,
  CapabilityTier,
  ModelProfile,
  PoolPressure,
  QuotaLedger,
  QuotaPoolID,
  QuotaPoolState,
  QuotaWindow,
  RoutableModel,
  RoutingDecision,
  TaskRequirements,
} from "./contracts.ts"
import { EFFORT_ORDER, TIER_ORDER } from "./contracts.ts"
import {
  estimateCostUsd,
  estimateWindowPressure,
  effortMultiplierFor,
  type EstimateInput,
} from "./estimate.ts"
import { paceHeadroomOf } from "./pace.ts"
import { DEFAULT_MODEL_PROFILE } from "./profiles.ts"

/** Reasoning effort rungs, weakest first. */
export type Effort = TaskRequirements["maxEffort"]

/** Signal cut-offs that turn Jev answers into a reasoning need. */
export interface SelectThresholds {
  /**
   * Deep-reasoning signal at or above which a `fast` complexity label is treated
   * as a misclassification and the task is routed as deep work.
   */
  readonly fastChoice: number
  /** At or above this a research-heavy task counts as deep work. */
  readonly deepChoice: number
  /** At or above this the task is deep reasoning. */
  readonly deepReasoning: number
  /** At or above this the task is high risk and gets the strongest rung. */
  readonly highRisk: number
}

/** Fully resolved policy knobs. */
export interface SelectOptions {
  /**
   * Fraction of a quota window held back on purpose. A pool is only treated as
   * comfortably usable while it still has this much headroom left.
   */
  readonly safetyMargin: number
  readonly thresholds: SelectThresholds
  /** Hard cap on scored candidates, so a huge host catalog cannot stall a prompt. */
  readonly maxCandidates: number
}

/** Partial policy knobs; anything omitted falls back to {@link DEFAULT_SELECT_OPTIONS}. */
export interface SelectOptionOverrides {
  readonly safetyMargin?: number
  readonly thresholds?: Partial<SelectThresholds>
  readonly maxCandidates?: number
  /**
   * Share of `estimatedInputTokens` assumed to be served from cache. Routing
   * time has no cache telemetry, so the default is `0`: never understate burn.
   */
  readonly cacheHitRatio?: number
}

/** Inputs of one routing decision. */
export interface RoutingInput {
  readonly requirements: TaskRequirements
  readonly models: readonly RoutableModel[]
  readonly ledger: QuotaLedger
  /** Clock for pace-adjusted headroom; defaults to `Date.now()`. */
  readonly now?: number
}

/**
 * Zero-config policy defaults.
 *
 * The margins are deliberately conservative: a subscription pool that runs dry
 * mid-task is worse than a slightly slower route, and the safety margin exists
 * so the router keeps a reserve instead of optimising the last percent.
 */
export const DEFAULT_SELECT_OPTIONS: SelectOptions = {
  safetyMargin: 0.15,
  thresholds: { fastChoice: 0.2, deepChoice: 0.6, deepReasoning: 0.5, highRisk: 0.5 },
  maxCandidates: 16,
}

/** Share of the prompt assumed to come from cache when the caller says nothing. */
export const ASSUMED_CACHE_HIT_RATIO = 0

/**
 * Quality surplus over the required floor, per full tier step.
 *
 * Ordered first because quality is the only term that reflects what the user
 * actually asked for; it is small (0.6 of a step) because the floor already
 * guarantees sufficiency, so surplus only breaks ties between acceptable
 * models instead of justifying a needless upgrade.
 */
export const SCORE_WEIGHT_QUALITY_SURPLUS = 0.6

/**
 * Quota pressure, the largest penalty in the policy.
 *
 * Every candidate here is already good enough, so the remaining decision is
 * almost entirely "which acceptable model spends the least of a shared
 * subscription pool". Pressure is measured on the tightest inference window
 * with the safety margin reserved, because a pool that is fine monthly can
 * still be minutes away from blocking a burst window.
 */
export const SCORE_WEIGHT_QUOTA_PRESSURE = 0.9

/**
 * Burn cost of the task itself.
 *
 * Kept below pressure because a dollar figure only means something relative
 * to an allowance; without one it would push the router towards models whose
 * pressure is unknown, which is exactly backwards.
 */
export const SCORE_WEIGHT_BURN_COST = 0.35

/**
 * Confidence penalty for a pool whose quota is `unknown` or `stale`.
 *
 * Such a pool is neither free nor blocked, so it must not win by default. The
 * penalty is smaller than one tier of quality surplus, so a strong model on a
 * blind pool still beats a weak model on a known one.
 */
export const SCORE_PENALTY_UNKNOWN_QUOTA = 0.25

/**
 * Preference for keeping the scarcest pool intact.
 *
 * Small and last: the pool closest to exhaustion is saved for tasks that have
 * no alternative, but never at the price of a blocked route.
 */
export const SCORE_WEIGHT_POOL_PRESERVATION = 0.12

/**
 * Extra penalty for a task predicted to cross the safety margin on the
 * tightest window. Crossing the margin is a prediction of failure rather than a
 * preference, so it is charged separately from the pressure ramp.
 */
export const SCORE_PENALTY_MARGIN_CROSSING = 0.8

/**
 * How much of the pressure term the task itself may contribute, at most.
 *
 * Capping it at half keeps a large task on an untouched pool from scoring like
 * a nearly dead one; the crossing penalty above already covers the extreme.
 */
export const PRESSURE_FROM_PREDICTED_TASK = 0.5

/** Burn that saturates the burn term. Real single tasks land well below it. */
export const BURN_REFERENCE_USD = 2

/** Headroom below which the scarcest pool is worth preserving. */
export const POOL_PRESERVE_HEADROOM_RATIO = 0.25

/**
 * Headroom assumed for a pool with no usable window report.
 *
 * Deliberately mid-scale: treating unknown quota as full headroom would make a
 * blind pool look free, which the policy forbids, while treating it as empty
 * would block routing on a metric nobody can read.
 */
export const NEUTRAL_HEADROOM_RATIO = 0.5

/**
 * Responsiveness fit, applied only when the task prefers speed.
 *
 * Latency is per-task comfort while quota is shared and finite, so this is
 * the smallest reward term: it breaks ties between affordable, good-enough
 * models but can never outweigh burn, let alone pressure or a tier step. When
 * the task does not prefer speed the term is exactly zero, so frontier work
 * is scored purely on correctness-per-quota.
 */
export const SCORE_WEIGHT_SPEED_FIT = 0.25

/**
 * Every weight of the scoring formula, gathered for auditing a route.
 *
 * The keys read in the order the terms are subtracted from quality surplus:
 * quality surplus first (what was asked), then quota pressure (what the plan
 * can afford), then burn, then data confidence, then pool preservation.
 */
export const SCORE_WEIGHTS = {
  qualitySurplus: SCORE_WEIGHT_QUALITY_SURPLUS,
  quotaPressure: SCORE_WEIGHT_QUOTA_PRESSURE,
  burnCost: SCORE_WEIGHT_BURN_COST,
  unknownQuota: SCORE_PENALTY_UNKNOWN_QUOTA,
  poolPreservation: SCORE_WEIGHT_POOL_PRESERVATION,
  speedFit: SCORE_WEIGHT_SPEED_FIT,
  marginCrossing: SCORE_PENALTY_MARGIN_CROSSING,
} as const

/**
 * Host variant IDs recognised at each effort rung.
 *
 * These are lookup keys, not variant IDs: the selector may only ever emit an ID
 * the host itself published. `xhigh` sits at the top because vendors that skip
 * `max` publish it instead, and `thinking` counts as `high` because a thinking
 * toggle requests a full reasoning pass.
 */
export const EFFORT_VARIANT_ALIASES: Readonly<Record<Effort, readonly string[]>> = {
  low: ["low", "none", "off", "minimal", "disabled"],
  medium: ["medium", "med", "standard", "default"],
  high: ["high", "think", "thinking", "reasoning"],
  max: ["max", "maximum", "ultra", "xhigh"],
}

/** A quota window observation reduced to what the policy needs. */
interface PoolUsage {
  readonly windowID: string | null
  readonly windowLabel: string | null
  readonly usedPercent: number | null
  readonly headroomRatio: number | null
}

/** Everything the policy knows about one pool. */
interface PoolQuota {
  readonly status: PoolPressure["status"]
  readonly known: boolean
  readonly headroomRatio: number | null
  readonly usage: PoolUsage
  readonly lookupError: string | null
}

/** One candidate after the gates, priced and scored. */
interface Evaluation {
  readonly model: RoutableModel
  readonly rejection: string | null
  readonly variant: string | undefined
  readonly effort: Effort
  readonly costUsd: number
  readonly windowPressure: number | null
  readonly quota: PoolQuota
  readonly justification: string
  readonly score: number
}

/** Policy knobs after defaults are applied. */
interface ResolvedSelectOptions extends SelectOptions {
  readonly cacheHitRatio: number
}

const NO_USAGE: PoolUsage = {
  windowID: null,
  windowLabel: null,
  usedPercent: null,
  headroomRatio: null,
}

/**
 * Decide which model runs the task.
 *
 * @param input Requirements, every routable model, and the quota ledger.
 * @param overrides Optional tuning; anything omitted uses {@link DEFAULT_SELECT_OPTIONS}.
 * @returns The winning model and its variant, or a decision with NO `selected`
 *   and an actionable `reason`. The caller must never dispatch to the virtual
 *   provider in that case: an unroutable task has to fail loudly rather than
 *   fall through to a metered or unknown model.
 */
export function selectModel(
  input: RoutingInput,
  overrides: SelectOptionOverrides = {},
): RoutingDecision {
  const options = resolveSelectOptions(overrides)
  const now = input.now ?? Date.now()
  const tightestPoolID = findTightestPoolID(input.ledger, now)
  const evaluations = input.models.map((model) =>
    evaluateCandidate(model, input, options, tightestPoolID),
  )
  const ranked = evaluations.filter(isEligible).sort(compareEvaluations)
  const kept = ranked.slice(0, Math.max(0, options.maxCandidates))
  const winner = kept[0]
  const capped = ranked.slice(Math.max(0, options.maxCandidates)).map((evaluation) =>
    withRejection(evaluation, `not evaluated: candidate cap ${options.maxCandidates} reached`),
  )
  const decided = [...evaluations.filter(isRejected), ...kept, ...capped]
  const reports = decided.map((evaluation) => reportFor(evaluation, winner)).sort(compareReports)
  return decisionFor(winner, reports)
}

/**
 * Effort a task needs, derived from the Jev signals and the thresholds.
 *
 * Ordered by how much a wrong answer costs: a risky task gets the strongest
 * rung first, then deep work (explicit `deep` complexity, deep reasoning, or
 * deep research), then any reasoning need at all, then `low` for everything
 * else. Paying for effort the task did not ask for is a quota bug, so the
 * ladder only ever escalates on a signal.
 *
 * @param requirements Task requirements as derived by the caller.
 * @param thresholds Signal cut-offs in use.
 * @returns The weakest rung that still satisfies the task.
 */
export function requiredEffortFor(
  requirements: TaskRequirements,
  thresholds: SelectThresholds,
): Effort {
  if (requirements.highRisk >= thresholds.highRisk) {
    return "max"
  }
  if (isDeepTask(requirements, thresholds)) {
    return "high"
  }
  if (requirements.needsReasoning) {
    return "medium"
  }
  return "low"
}

/**
 * Deep-work test shared by the effort ladder.
 *
 * A task counts as deep when complexity already says so, when the deep-reasoning
 * or research signal crosses its threshold, or when a `fast` label contradicts a
 * deep-reasoning signal that already reaches `fastChoice`. That last clause is
 * `fastChoice`'s job: below it a weak reasoning hint on a `fast` task is noise,
 * at or above it the contradiction is resolved in favour of the reasoning signal
 * rather than the classifier label.
 */
function isDeepTask(requirements: TaskRequirements, thresholds: SelectThresholds): boolean {
  if (requirements.complexity === "deep") {
    return true
  }
  if (requirements.deepReasoning >= thresholds.deepReasoning) {
    return true
  }
  if (requirements.research >= thresholds.deepChoice) {
    return true
  }
  return requirements.complexity === "fast" && requirements.deepReasoning >= thresholds.fastChoice
}

/**
 * Resolve the variant a model should run with, if any.
 *
 * The ladder is walked from the requested rung DOWN only. Spending more effort
 * than the task needs is exactly the waste this router exists to avoid, so a
 * model that exposes nothing at or below the requested rung runs on its host
 * default instead of being upgraded.
 *
 * @param model Candidate whose catalog holds the published variant IDs.
 * @param effort Rung the task needs.
 * @returns A variant ID published by this very model, or `undefined` for the
 *   host default. Never a synthesised ID.
 */
export function resolveEffortVariant(model: RoutableModel, effort: Effort): string | undefined {
  for (let rank = effortRank(effort); rank >= 0; rank -= 1) {
    const rung = EFFORT_ORDER[rank]
    if (rung === undefined) {
      continue
    }
    const matched = findVariant(model, EFFORT_VARIANT_ALIASES[rung])
    if (matched !== undefined) {
      return matched
    }
  }
  return undefined
}

/**
 * Whether a profile carries curated evidence about a model.
 *
 * The profiles module hands uncurated models its documented default profile,
 * which is neutral on purpose. Recognising it is what lets the policy refuse
 * to promote an unknown model to the advanced tier instead of guessing.
 *
 * @param profile Profile attached to a candidate.
 * @returns `false` only for the documented default profile.
 */
export function isCuratedProfile(profile: ModelProfile): boolean {
  return profile.source !== DEFAULT_MODEL_PROFILE.source
}

/**
 * One-line human summary of a decision, for logs and `/autopilot explain`.
 *
 * @param decision Decision produced by {@link selectModel}.
 * @returns A single line naming the winner, its plan, its forecast and the most
 *   relevant exclusions, or why nothing was selectable.
 */
export function explainDecision(decision: RoutingDecision): string {
  if (decision.selected === undefined) {
    return `no model selected — ${decision.reason}`
  }
  const model = decision.selected
  const report = decision.considered.find((entry) => entry.ref === model.ref)
  const variant = decision.variant === undefined ? "" : `#${decision.variant}`
  const cost = report?.estimatedCostUsd ?? 0
  const headline = `${model.ref}${variant} (${model.route.label} pool, est. $${cost.toFixed(2)})`
  return `${headline} — ${decision.reason}${rivalClause(decision, report)}`
}

/** Apply the defaults a caller may have left out. */
function resolveSelectOptions(overrides: SelectOptionOverrides): ResolvedSelectOptions {
  return {
    safetyMargin: ratioOr(overrides.safetyMargin, DEFAULT_SELECT_OPTIONS.safetyMargin),
    thresholds: {
      fastChoice: ratioOr(
        overrides.thresholds?.fastChoice,
        DEFAULT_SELECT_OPTIONS.thresholds.fastChoice,
      ),
      deepChoice: ratioOr(
        overrides.thresholds?.deepChoice,
        DEFAULT_SELECT_OPTIONS.thresholds.deepChoice,
      ),
      deepReasoning: ratioOr(
        overrides.thresholds?.deepReasoning,
        DEFAULT_SELECT_OPTIONS.thresholds.deepReasoning,
      ),
      highRisk: ratioOr(overrides.thresholds?.highRisk, DEFAULT_SELECT_OPTIONS.thresholds.highRisk),
    },
    maxCandidates: Math.max(
      1,
      Math.trunc(overrides.maxCandidates ?? DEFAULT_SELECT_OPTIONS.maxCandidates),
    ),
    cacheHitRatio: ratioOr(overrides.cacheHitRatio, ASSUMED_CACHE_HIT_RATIO),
  }
}

/** Run the gates in the documented order and take the first failure. */
function firstRejection(
  model: RoutableModel,
  requirements: TaskRequirements,
  requiredEffort: Effort,
  quota: PoolQuota,
): string | null {
  return (
    capabilityRejection(model, requirements, requiredEffort) ??
    qualityRejection(model, requirements) ??
    quotaRejection(model, quota)
  )
}

/** Gate 1: can the model do the task at all. */
function capabilityRejection(
  model: RoutableModel,
  requirements: TaskRequirements,
  requiredEffort: Effort,
): string | null {
  if (requirements.needsTools && !model.catalog.tools) {
    return `needs tools but capabilities.tools=false for ${model.ref}`
  }
  const modality = missingVisionModality(model)
  if (requirements.needsVision && modality !== null) {
    return `needs vision but input modalities are [${modality}] for ${model.ref}`
  }
  const prompt = promptRejection(model, requirements)
  if (prompt !== null) {
    return prompt
  }
  return ladderRejection(model, requirements, requiredEffort)
}

/** Comma-joined input modalities, or `null` when at least one is image-capable. */
function missingVisionModality(model: RoutableModel): string | null {
  const modalities = model.catalog.inputModalities
  const imageCapable = modalities.some(isImageModality)
  if (imageCapable) {
    return null
  }
  return modalities.join(", ")
}

/** True for any modality name that denotes an image the model can look at. */
function isImageModality(modality: string): boolean {
  const normalized = modality.trim().toLowerCase()
  return normalized.includes("image") || normalized.includes("vision") || normalized.includes("photo")
}

/** Gate 1b: the prompt has to fit in the context window. */
function promptRejection(model: RoutableModel, requirements: TaskRequirements): string | null {
  const estimated = requirements.estimatedInputTokens
  if (!Number.isFinite(estimated) || estimated <= 0) {
    return null
  }
  if (model.catalog.context >= estimated) {
    return null
  }
  return `context ${model.catalog.context} is below the estimated ${estimated} input tokens`
}

/** Gate 1c: a published effort ladder must reach the rung the task needs. */
function ladderRejection(
  model: RoutableModel,
  requirements: TaskRequirements,
  requiredEffort: Effort,
): string | null {
  if (!requirements.needsReasoning || effortRank(requiredEffort) <= effortRank("low")) {
    return null
  }
  const strongest = strongestExposedEffort(model)
  if (strongest === undefined || effortRank(strongest) >= effortRank(requiredEffort)) {
    return null
  }
  return `reasoning ladder tops out at ${strongest} but the task needs ${requiredEffort}`
}

/** Gate 2: required quality is a floor, never a preference. */
function qualityRejection(
  model: RoutableModel,
  requirements: TaskRequirements,
): string | null {
  const floor = requirements.tier
  if (tierRank(model.profile.tier) < tierRank(floor)) {
    return `tier ${model.profile.tier} is below the required floor ${floor}`
  }
  if (floor === "advanced" && !isCuratedProfile(model.profile)) {
    return `no curated profile, refusing to assume advanced quality for ${model.ref}`
  }
  return null
}

/** Gate 3: an exhausted pool cannot be spent, whatever the model offers. */
function quotaRejection(model: RoutableModel, quota: PoolQuota): string | null {
  if (quota.status !== "exhausted") {
    return null
  }
  return `pool ${model.route.poolID} exhausted (${windowClause(model, quota)})`
}

/** Price, score and justify one candidate in a single pass. */
function evaluateCandidate(
  model: RoutableModel,
  input: RoutingInput,
  options: ResolvedSelectOptions,
  tightestPoolID: QuotaPoolID | null,
): Evaluation {
  const requirements = input.requirements
  const quota = readPoolQuota(input.ledger, model.route.poolID, model.catalog.modelID, input.now ?? Date.now())
  const requiredEffort = requiredEffortFor(requirements, options.thresholds)
  const effort = cheapestEffortAtLeast(requiredEffort, requirements.maxEffort)
  const variant = resolveEffortVariant(model, effort)
  const baseCostUsd = estimateCostUsd(model, estimateInputOf(requirements, options, 1))
  const costUsd = estimateCostUsd(
    model,
    estimateInputOf(requirements, options, effortMultiplierFor(model, variant)),
  )
  const windowPressure = windowPressureOf(model, variant, baseCostUsd, quota)
  const justification = justificationOf(model, requirements, effort, variant, quota)
  return {
    model,
    rejection: firstRejection(model, requirements, requiredEffort, quota),
    variant,
    effort,
    costUsd,
    windowPressure,
    quota,
    justification,
    score: scoreCandidate(model, quota, windowPressure, costUsd, requirements, options, tightestPoolID),
  }
}

/** Forecast inputs taken straight from the task requirements. */
function estimateInputOf(
  requirements: TaskRequirements,
  options: ResolvedSelectOptions,
  effortMultiplier: number,
): EstimateInput {
  return {
    inputTokens: requirements.estimatedInputTokens,
    outputTokens: requirements.estimatedOutputTokens,
    turns: requirements.estimatedTurns,
    cacheHitRatio: options.cacheHitRatio,
    effortMultiplier,
  }
}

/** Share of the tightest window's allowance this task is predicted to burn. */
function windowPressureOf(
  model: RoutableModel,
  variant: string | undefined,
  baseCostUsd: number,
  quota: PoolQuota,
): number | null {
  const windowID = quota.usage.windowID
  if (windowID === null) {
    return null
  }
  return estimateWindowPressure(model, variant, baseCostUsd, windowID)
}

/**
 * Combine the five policy terms.
 *
 * Positive: quality surplus. Negative: quota pressure, burn, confidence and
 * pool preservation, plus the crossing penalty for a task predicted to eat
 * through the safety margin.
 */
function scoreCandidate(
  model: RoutableModel,
  quota: PoolQuota,
  windowPressure: number | null,
  costUsd: number,
  requirements: TaskRequirements,
  options: ResolvedSelectOptions,
  tightestPoolID: QuotaPoolID | null,
): number {
  const unknownQuota = isUnknownQuota(quota)
  const headroom = quota.usage.headroomRatio ?? (unknownQuota ? NEUTRAL_HEADROOM_RATIO : 1)
  const reserve = headroom - options.safetyMargin
  const poolPressure = clamp01(1 - reserve)
  const predictedPressure =
    windowPressure === null ? 0 : clamp01(windowPressure) * PRESSURE_FROM_PREDICTED_TASK
  const pressureTerm = clamp01(poolPressure + predictedPressure)
  const crossesMargin = windowPressure !== null && (reserve <= 0 || windowPressure > reserve)
  const qualityTerm = qualitySurplus(model.profile.tier, requirements.tier)
  const burnTerm = clamp01(costUsd / BURN_REFERENCE_USD)
  const preservation = preservationPenalty(model.route.poolID, tightestPoolID, quota.usage.headroomRatio)
  const speedTerm = requirements.prefersSpeed ? clamp01(model.profile.speed) : 0
  return (
    SCORE_WEIGHT_QUALITY_SURPLUS * qualityTerm -
    SCORE_WEIGHT_QUOTA_PRESSURE * pressureTerm -
    SCORE_WEIGHT_BURN_COST * burnTerm -
    SCORE_PENALTY_UNKNOWN_QUOTA * (unknownQuota ? 1 : 0) -
    SCORE_WEIGHT_POOL_PRESERVATION * preservation -
    SCORE_PENALTY_MARGIN_CROSSING * (crossesMargin ? 1 : 0) +
    SCORE_WEIGHT_SPEED_FIT * speedTerm
  )
}

/** Quality above the floor, normalized so one full tier step is worth 1. */
function qualitySurplus(tier: CapabilityTier, floor: CapabilityTier): number {
  const steps = tierRank(tier) - tierRank(floor)
  const span = TIER_ORDER.length - 1
  return span <= 0 ? 0 : clamp01(steps / span)
}

/** 1 when this candidate would spend the scarcest pool while it is still scarce. */
function preservationPenalty(
  poolID: QuotaPoolID,
  tightestPoolID: QuotaPoolID | null,
  headroomRatio: number | null,
): number {
  if (poolID !== tightestPoolID || headroomRatio === null) {
    return 0
  }
  return headroomRatio < POOL_PRESERVE_HEADROOM_RATIO ? 1 : 0
}

/** `unknown` and `stale` carry no pressure signal but are never free. */
function isUnknownQuota(quota: PoolQuota): boolean {
  return !quota.known || quota.status === "unknown" || quota.status === "stale"
}

/** Read one pool defensively: a throwing ledger is unknown quota, not a crash. */
function readPoolQuota(ledger: QuotaLedger, poolID: QuotaPoolID, modelID: string, now: number): PoolQuota {
  let state: QuotaPoolState | undefined
  let pressure: PoolPressure | undefined
  let lookupError: string | null = null
  try {
    state = ledger.pool(poolID, modelID)
  } catch (error) {
    lookupError = describeError(error)
  }
  try {
    pressure = ledger.pressure(poolID, modelID)
  } catch (error) {
    lookupError = lookupError ?? describeError(error)
  }
  if (state?.error !== undefined && state.error !== null) {
    lookupError = state.error
  }
  return {
    status: pressure?.status ?? "unknown",
    known: pressure?.known ?? false,
    headroomRatio: pressure?.headroomRatio ?? null,
    usage: tightestWindowUsage(state, now),
    lookupError,
  }
}

/**
 * The inference window with the least room left.
 *
 * Windows nest (5h inside weekly inside monthly), so the tightest one is what
 * blocks the next turn: a healthy monthly balance does not help when the burst
 * window is spent. Room is pace-adjusted (`pace.ts`), so a monthly window
 * running ahead of its pace can outweigh a fuller weekly one. `other`
 * dimensions (MCP tool quotas and friends) never gate model routing.
 */
function tightestWindowUsage(state: QuotaPoolState | undefined, now: number): PoolUsage {
  const windows = (state?.windows ?? []).filter(isConsumedInferenceWindow)
  const tightest = windows.reduce<QuotaWindow | undefined>(
    (current, window) =>
      current === undefined || paceHeadroomOf(window, now) < paceHeadroomOf(current, now) ? window : current,
    undefined,
  )
  if (tightest === undefined || tightest.usedPercent === null) {
    return NO_USAGE
  }
  return {
    windowID: tightest.id,
    windowLabel: tightest.label,
    usedPercent: tightest.usedPercent,
    headroomRatio: paceHeadroomOf(tightest, now),
  }
}

function isConsumedInferenceWindow(window: QuotaWindow): boolean {
  return window.dimension === "inference" && Number.isFinite(window.usedPercent)
}

/** Pool with the least known headroom, ties broken by ID for determinism. */
function findTightestPoolID(ledger: QuotaLedger, now: number): QuotaPoolID | null {
  const states = readPools(ledger).sort((left, right) => compareText(left.poolID, right.poolID))
  let tightest: { readonly poolID: QuotaPoolID; readonly headroom: number } | undefined
  for (const state of states) {
    const headroom = tightestWindowUsage(state, now).headroomRatio
    if (headroom === null) {
      continue
    }
    if (tightest === undefined || headroom < tightest.headroom) {
      tightest = { poolID: state.poolID, headroom }
    }
  }
  return tightest?.poolID ?? null
}

function readPools(ledger: QuotaLedger): QuotaPoolState[] {
  try {
    return [...ledger.pools()]
  } catch (error) {
    return []
  }
}

/** The weakest rung that satisfies the need, capped by the caller's ceiling. */
function cheapestEffortAtLeast(required: Effort, ceiling: Effort): Effort {
  const capped = Math.min(Math.max(0, effortRank(required)), Math.max(0, effortRank(ceiling)))
  return EFFORT_ORDER[capped] ?? "low"
}

/** Strongest rung the model publishes, or `undefined` when it publishes none. */
function strongestExposedEffort(model: RoutableModel): Effort | undefined {
  for (let rank = EFFORT_ORDER.length - 1; rank >= 0; rank -= 1) {
    const rung = EFFORT_ORDER[rank]
    if (rung === undefined) {
      continue
    }
    if (findVariant(model, EFFORT_VARIANT_ALIASES[rung]) !== undefined) {
      return rung
    }
  }
  return undefined
}

/** First published variant matching any alias, never a synthesised ID. */
function findVariant(model: RoutableModel, aliases: readonly string[]): string | undefined {
  const published = new Map<string, string>()
  for (const variantID of model.catalog.variantIDs) {
    published.set(normalizeLabel(variantID), variantID)
  }
  for (const alias of aliases) {
    const matched = published.get(alias)
    if (matched !== undefined) {
      return matched
    }
  }
  return undefined
}

/** Lowercase alphanumeric form, so `High`, `high-effort` and `high` all match. */
function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** Rank of an effort rung; `-1` only for a value outside {@link EFFORT_ORDER}. */
function effortRank(effort: Effort): number {
  return EFFORT_ORDER.indexOf(effort)
}

function tierRank(tier: CapabilityTier): number {
  return TIER_ORDER.indexOf(tier)
}

/** One-line justification carried by every eligible candidate. */
function justificationOf(
  model: RoutableModel,
  requirements: TaskRequirements,
  effort: Effort,
  variant: string | undefined,
  quota: PoolQuota,
): string {
  const variantClause = variant === undefined ? "host default effort" : `#${variant}`
  return (
    `${requirements.tier} floor met by ${model.profile.tier}` +
    `; effort ${effort} (${variantClause})` +
    `; ${windowClause(model, quota)}`
  )
}

/** Human description of what the pool looks like right now. */
function windowClause(model: RoutableModel, quota: PoolQuota): string {
  const poolID = model.route.poolID
  const usage = quota.usage
  if (usage.windowLabel !== null && usage.usedPercent !== null) {
    return `${usage.windowLabel} window ${Math.round(usage.usedPercent)}% used`
  }
  if (quota.lookupError !== null) {
    return `quota lookup failed for pool ${poolID} (${quota.lookupError})`
  }
  if (quota.status === "unknown") {
    return `quota unknown for pool ${poolID}`
  }
  if (quota.status === "stale") {
    return `quota stale for pool ${poolID}`
  }
  return `no inference window reported for pool ${poolID}`
}

/** Turn one evaluation into its audit row. */
function reportFor(evaluation: Evaluation, winner: Evaluation | undefined): CandidateReport {
  const eligible = evaluation.rejection === null && winner !== undefined
  return {
    ref: evaluation.model.ref,
    subscription: evaluation.model.route.id,
    poolID: evaluation.model.route.poolID,
    eligible,
    reason: reportReason(evaluation, winner),
    quotaStatus: evaluation.quota.status,
    headroomRatio: evaluation.quota.headroomRatio,
    estimatedCostUsd: evaluation.costUsd,
    estimatedPressure: evaluation.windowPressure,
    qualityTier: evaluation.model.profile.tier,
    score: eligible ? evaluation.score : 0,
  }
}

/** Reason a candidate was kept, chosen or passed over. */
function reportReason(evaluation: Evaluation, winner: Evaluation | undefined): string {
  if (evaluation.rejection !== null) {
    return evaluation.rejection
  }
  if (winner === undefined) {
    return `${evaluation.justification}; nothing else was routable`
  }
  if (winner.model.ref === evaluation.model.ref) {
    return `${evaluation.justification}; selected`
  }
  return `${evaluation.justification}; not chosen, ${winner.model.ref} scored higher`
}

/** Assemble the decision, including the mandatory "no safe candidate" reason. */
function decisionFor(
  winner: Evaluation | undefined,
  reports: readonly CandidateReport[],
): RoutingDecision {
  if (winner === undefined) {
    return { reason: noCandidateReason(reports), considered: reports }
  }
  return {
    selected: winner.model,
    ...(winner.variant === undefined ? {} : { variant: winner.variant }),
    reason: winner.justification,
    considered: reports,
  }
}

/** Actionable failure reason naming what was rejected and why. */
function noCandidateReason(reports: readonly CandidateReport[]): string {
  if (reports.length === 0) {
    return (
      "no routable models: the host catalog exposed no enabled model on a connected " +
      "subscription provider"
    )
  }
  const clauses = rankedRejections(reports)
    .slice(0, 3)
    .map((report) => `${report.ref} rejected: ${report.reason}`)
  return `no eligible model out of ${reports.length}: ${clauses.join("; ")}`
}

/** Exclusions worth showing: an exhausted pool first, then a stable ref order. */
function rankedRejections(reports: readonly CandidateReport[]): CandidateReport[] {
  return reports
    .filter((report) => !report.eligible)
    .slice()
    .sort(
      (left, right) =>
        Number(right.quotaStatus === "exhausted") - Number(left.quotaStatus === "exhausted") ||
        compareText(left.ref, right.ref),
    )
}

/**
 * Trailing clause naming why the winner beat the field.
 *
 * Rejections are the more actionable half, so they come first; when nothing was
 * rejected the runner-up is named with both scores, which is what makes a
 * surprising quota preference auditable instead of mysterious. Empty when the
 * winner was the only candidate.
 */
function rivalClause(decision: RoutingDecision, winner: CandidateReport | undefined): string {
  const rejected = rankedRejections(decision.considered)
  if (rejected.length > 0) {
    const shown = rejected
      .slice(0, 2)
      .map((report) => `${shortRef(report.ref)} excluded: ${report.reason}`)
    const rest = rejected.length - shown.length
    return `; ${shown.join("; ")}${rest > 0 ? `; +${rest} more rejected` : ""}`
  }
  const runnerUp = decision.considered
    .filter((report) => report.eligible && report.ref !== decision.selected?.ref)
    .sort((left, right) => right.score - left.score || compareText(left.ref, right.ref))[0]
  if (runnerUp === undefined) {
    return ""
  }
  const winnerScore = winner === undefined ? "" : ` < ${winner.score.toFixed(2)}`
  return `; ${shortRef(runnerUp.ref)} runner-up (${runnerUp.score.toFixed(2)}${winnerScore})`
}

/** Last path segment of a `"<providerID>/<modelID>"` reference. */
function shortRef(ref: string): string {
  const segments = ref.split("/")
  return segments[segments.length - 1] ?? ref
}

function isEligible(evaluation: Evaluation): boolean {
  return evaluation.rejection === null
}

function isRejected(evaluation: Evaluation): boolean {
  return evaluation.rejection !== null
}

function withRejection(evaluation: Evaluation, rejection: string): Evaluation {
  return { ...evaluation, rejection }
}

/** Highest score first, then `ref` ascending, so ties are stable. */
function compareEvaluations(left: Evaluation, right: Evaluation): number {
  if (left.score !== right.score) {
    return right.score - left.score
  }
  return compareText(left.model.ref, right.model.ref)
}

function compareReports(left: CandidateReport, right: CandidateReport): number {
  return compareText(left.ref, right.ref)
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0
  }
  return left < right ? -1 : 1
}

function ratioOr(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback
  }
  return clamp01(value)
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0
  }
  return Math.min(1, Math.max(0, value))
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
