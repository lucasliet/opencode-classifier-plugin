import type {
  CapabilityTier,
  MetadataConfidence,
  ModelProfile,
} from "./contracts.ts"

/**
 * Curated, locally maintained metadata for every routable subscription model.
 *
 * This module is pure data plus small pure helpers: no I/O, no clocks, no
 * randomness. Every row answers three questions the host catalog cannot:
 *
 * 1. How good is this model, and how does that map to a quality tier? The
 *    catalog has no capability metadata.
 * 2. How much does one more turn burn? Subscription models publish no
 *    per-token price at call time, so the burn rates below are the only input
 *    the router has for comparing two models that share one quota pool.
 * 3. How does that burn translate into quota pressure? Only OpenCode Zen Go
 *    publishes a dollar allowance per model, so only Go rows carry
 *    `includedUsageUsd`; for every other vendor the router must fall back to
 *    percentage pressure alone.
 *
 * Provenance and confidence are recorded per row in `source` and `confidence`.
 * Anything not stated by a vendor is an explicitly marked local estimate — an
 * unknown model must never look as strong as a curated one.
 */

/** USD per million tokens, mirroring the shape of `CatalogModel.costPerMTok`. */
export interface ModelCostPerMTok {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/**
 * A curated profile plus the burn rates the host catalog omits for
 * subscription models.
 */
export interface PricedModelProfile extends ModelProfile {
  /** USD per million tokens. Zero means "not published", never "free". */
  readonly costPerMTok: ModelCostPerMTok
}

/**
 * Capability estimates are kept nested in the source table and flattened by
 * {@link buildProfiles} so the data reads as one comparable block per model.
 */
interface CuratedCapability {
  readonly coding: number
  readonly reasoning: number
  readonly research: number
  readonly toolUse: number
  readonly speed: number
}

/** Rates exactly as published, before the unpublished `cacheWrite` is added. */
interface CuratedRates {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
}

/** One row of the curated source table. */
interface CuratedRow {
  readonly tier: CapabilityTier
  readonly capability: CuratedCapability
  readonly costPerMTok: CuratedRates
  readonly effortCost: Readonly<Record<string, number>>
  readonly includedUsageUsd: number | null
  readonly windowShares: Readonly<Record<string, number>>
  readonly source: string
  readonly confidence: MetadataConfidence
}

/**
 * OpenCode Zen Go splits each model's monthly allowance across three windows.
 * Published by the Go plan: a 5-hour burst may spend 20% of the monthly
 * allowance, a rolling week 50%, and the month 100%. `includedUsageUsd` is the
 * monthly figure, so the shares translate a burst into a comparable share of the
 * month.
 */
export const OPENCODE_GO_WINDOW_SHARES: Readonly<Record<string, number>> = {
  "5h": 0.2,
  weekly: 0.5,
  monthly: 1,
}

/**
 * OpenAI/Codex effort ladder.
 *
 * A variant's number is how much MORE of the plan's quota it burns than the
 * model's cheapest variant, because raising reasoning effort mainly inflates
 * output and reasoning tokens. `none` and `low` are the baseline, and the ladder
 * grows deliberately steep at the top: `max` emits far more reasoning tokens
 * than `high`, so letting it through cheaply drains a shared pool. Codex rows
 * use this ladder because it is the one their catalog exposes.
 */
const CODEX_EFFORT_COST: Readonly<Record<string, number>> = {
  none: 1,
  low: 1,
  medium: 1.5,
  high: 2.5,
  xhigh: 4,
  max: 6,
}

/**
 * Codex ladder for `gpt-5.5*` and `gpt-5.3-codex-spark`, which expose no `max`
 * variant. Emitting a cost for a variant the model does not have would invent
 * quota burn, so the row stops at `xhigh`.
 */
const CODEX_EFFORT_COST_NO_MAX: Readonly<Record<string, number>> = {
  none: 1,
  low: 1,
  medium: 1.5,
  high: 2.5,
  xhigh: 4,
}

/**
 * GLM / Kimi / Z.AI effort ladder (`low | high | max`).
 *
 * These vendors skip the medium rungs, so the same reasoning as the Codex ladder
 * applies with three steps: baseline, strong, and a top setting that is treated
 * as a full reasoning budget.
 */
const GLM_EFFORT_COST: Readonly<Record<string, number>> = {
  low: 1,
  high: 2.5,
  max: 6,
}

/**
 * `kimi-k3` exposes only `max`.
 *
 * The multiplier is kept at the top of the ladder on purpose: even though it is
 * the cheapest exposed variant, it still requests a full reasoning budget, and
 * charging it the baseline would let the router drain a small pool for free.
 */
const KIMI_K3_EFFORT_COST: Readonly<Record<string, number>> = { max: 6 }

/**
 * `minimax-m3` exposes a `thinking` toggle rather than a graded effort ladder,
 * so both states cost the same and the variant must not be scored as a premium
 * effort.
 */
const THINKING_TOGGLE_EFFORT_COST: Readonly<Record<string, number>> = {
  none: 1,
  thinking: 1,
}

/** No catalog variant means no variant-specific cost, never a guessed one. */
const NO_EFFORT_COST: Readonly<Record<string, number>> = {}

/** Vendors in scope publish no cache-write rate; see {@link buildProfiles}. */
const UNPUBLISHED_CACHE_WRITE_RATE = 0

/** Provenance for every OpenCode Zen Go row. */
const GO_PLAN_SOURCE =
  "OpenCode Zen Go rate card; monthly allowance is the plan's included usage for this model, split 5h = 20%, weekly = 50%, monthly = 100%."

/**
 * Provenance for every Codex row. The catalog publishes an empty cost array for
 * subscription models, so these burn rates are local estimates and only their
 * ratio between Codex models matters: the pool exposes no dollar allowance.
 */
const CODEX_ESTIMATE_SOURCE =
  "ChatGPT / Codex subscription: the OpenCode catalog publishes an empty cost array, so these burn rates are a local estimate anchored to public list prices. Medium confidence; only their ratio between Codex models is used, because the pool reports no dollar allowance."

/** Provenance for every Kimi For Coding row. */
const KIMI_PLAN_SOURCE =
  "Kimi For Coding subscription: the vendor reports request-quota windows rather than a dollar allowance, so includedUsageUsd stays null and only percentage pressure is available."

/** Provenance for the Z.AI Coding Plan rows whose rate card was read directly. */
const ZAI_PLAN_SOURCE =
  "Z.AI Coding Plan subscription: the plan reports a GLM quota pool without a dollar allowance, so includedUsageUsd stays null."

/**
 * Capability tiers are calibrated against DeepSWE v1.1 (datacurve.ai,
 * 2026-09-22, mini-swe-agent harness, best-effort pass@1) for the models the
 * benchmark measured through a routable subscription: score >= 67% reads as
 * advanced, 50-66% as balanced, below 50% as economy. Each measured row cites
 * its score and the reasoning effort it was measured at, because the score only
 * transfers to the router when the router can emit that gear. Models the
 * benchmark did not measure keep curated relative tiers and never outrank a
 * measured peer without a stated reason.
 *
 * Responsiveness is calibrated from the same benchmark's per-task output
 * tokens as `0.95 - outTokPerTask / 200_000`: a proxy for how quickly a task
 * finishes (verbosity times agent turns), not for provider tokens-per-second.
 * A terse model therefore reads as fast even when it reasons hard. Rows the
 * benchmark did not measure keep coarse responsiveness classes. Speed only
 * breaks ties between affordable, good-enough models; it never overrides the
 * quality floor or quota gates.
 */
const DEEPSWE_V11 =
  "DeepSWE v1.1 (datacurve.ai, 2026-09-22, mini-swe-agent, best-effort pass@1)"

/** Provenance for the Z.AI rows whose rate card was inherited from ZCode. */
const ZAI_INHERITED_RATE_SOURCE =
  "Rate card mirrored from the ZCode row of the same model: both providers are the same Z.AI Coding Plan. The model IDs on this provider were inferred rather than probed, so confidence is medium."

/** Provenance shared by the unmetered, temporary Go models. */
const UNMETERED_SOURCE =
  "Temporary unmetered preview: no rate and no monthly cap are published, so burn rates are zero and includedUsageUsd is null. Very low confidence — treat capability as a guess, not a ranking."

/**
 * The curated table, keyed by `"<providerID>/<modelID>"` with the exact
 * lowercase IDs OpenCode reports.
 *
 * Rows are optional fine-tuning: a model without one gets a profile derived
 * from models.dev (`derive.ts`). A pay-as-you-go model must never be profiled
 * here.
 */
const CURATED_ROWS: Readonly<Record<string, CuratedRow>> = {
  "opencode-go/glm-5.3-flash": {
    tier: "balanced",
    capability: { coding: 0.76, reasoning: 0.62, research: 0.58, toolUse: 0.8, speed: 0.59 },
    costPerMTok: { input: 0.15, output: 0.5, cacheRead: 0.03 },
    effortCost: GLM_EFFORT_COST,
    includedUsageUsd: 60,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} ${DEEPSWE_V11} score 63% at max effort, inside the balanced band.`,
    confidence: "high",
  },
  "opencode-go/glm-5.3": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.95, research: 0.86, toolUse: 0.9, speed: 0.55 },
    costPerMTok: { input: 1.4, output: 4.4, cacheRead: 0.26 },
    effortCost: GLM_EFFORT_COST,
    includedUsageUsd: 15,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} ${DEEPSWE_V11} score 69% at max effort, an effort this row exposes.`,
    confidence: "high",
  },
  "opencode-go/glm-5.2": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.6, research: 0.58, toolUse: 0.64, speed: 0.56 },
    costPerMTok: { input: 1.4, output: 4.4, cacheRead: 0.26 },
    effortCost: GLM_EFFORT_COST,
    includedUsageUsd: 60,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} ${DEEPSWE_V11} score 44% at max effort: a full band below glm-5.3-flash at 63%, so economy, never a peer of the flash line.`,
    confidence: "high",
  },
  "opencode-go/kimi-k3": {
    tier: "advanced",
    capability: { coding: 0.94, reasoning: 0.96, research: 0.85, toolUse: 0.88, speed: 0.55 },
    costPerMTok: { input: 3, output: 15, cacheRead: 0.3 },
    effortCost: KIMI_K3_EFFORT_COST,
    includedUsageUsd: 15,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} ${DEEPSWE_V11} score 69% at max effort, the only gear this model exposes.`,
    confidence: "high",
  },
  "opencode-go/kimi-k2.7-code": {
    tier: "balanced",
    capability: { coding: 0.88, reasoning: 0.78, research: 0.66, toolUse: 0.9, speed: 0.68 },
    costPerMTok: { input: 0.95, output: 4, cacheRead: 0.19 },
    effortCost: GLM_EFFORT_COST,
    includedUsageUsd: 60,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: GO_PLAN_SOURCE,
    confidence: "high",
  },
  "opencode-go/grok-4.7": {
    tier: "advanced",
    capability: { coding: 0.9, reasoning: 0.92, research: 0.9, toolUse: 0.88, speed: 0.72 },
    costPerMTok: { input: 2, output: 6, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    includedUsageUsd: 15,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} No cache-read rate is published. Input and output double above 200K context.`,
    confidence: "high",
  },
  "opencode-go/grok-4.6": {
    tier: "advanced",
    capability: { coding: 0.88, reasoning: 0.88, research: 0.86, toolUse: 0.86, speed: 0.7 },
    costPerMTok: { input: 2, output: 6, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    includedUsageUsd: 15,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} ${DEEPSWE_V11} score 67% at medium effort. No cache-read rate is published. Input and output double above 200K context. The Go catalog exposes no effort variants for this model, so the router runs the host default and prices it conservatively.`,
    confidence: "high",
  },
  "opencode-go/gpt-6-luna": {
    tier: "balanced",
    capability: { coding: 0.78, reasoning: 0.72, research: 0.7, toolUse: 0.8, speed: 0.9 },
    costPerMTok: { input: 0.1, output: 0.5, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    includedUsageUsd: 15,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} Cheap per token and ungraded, so balanced. Input and output double above 272K context.`,
    confidence: "high",
  },
  "opencode-go/gpt-5.6-luna": {
    tier: "advanced",
    capability: { coding: 0.88, reasoning: 0.86, research: 0.84, toolUse: 0.86, speed: 0.59 },
    costPerMTok: { input: 0.2, output: 1.2, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    includedUsageUsd: 15,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} ${DEEPSWE_V11} score 67% at max effort: the best measured value per quota dollar on this plan. Input and output double above 272K context. The Go catalog exposes no effort variants, so the router runs the host default and prices it conservatively.`,
    confidence: "high",
  },
  "opencode-go/qwen3.8-max": {
    tier: "balanced",
    capability: { coding: 0.78, reasoning: 0.76, research: 0.78, toolUse: 0.8, speed: 0.48 },
    costPerMTok: { input: 2, output: 6, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    includedUsageUsd: 15,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} ${DEEPSWE_V11} score 57% at xhigh effort: mid-table, a full band below the 67% advanced cutoff. No cache-read rate is published.`,
    confidence: "medium",
  },
  "opencode-go/qwen3.8-flash": {
    tier: "balanced",
    capability: { coding: 0.75, reasoning: 0.66, research: 0.68, toolUse: 0.78, speed: 0.94 },
    costPerMTok: { input: 0.15, output: 0.47, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    includedUsageUsd: 30,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} No cache-read rate is published. Fast sibling of the 3.8 max line.`,
    confidence: "high",
  },
  "opencode-go/qwen3.7-plus": {
    tier: "balanced",
    capability: { coding: 0.8, reasoning: 0.74, research: 0.76, toolUse: 0.8, speed: 0.78 },
    costPerMTok: { input: 0.4, output: 1.6, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    includedUsageUsd: 60,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} Above 256K context the rate rises to $1.20 in / $4.80 out.`,
    confidence: "high",
  },
  "opencode-go/mimo-v2.6-flash": {
    tier: "economy",
    capability: { coding: 0.66, reasoning: 0.48, research: 0.55, toolUse: 0.7, speed: 0.96 },
    costPerMTok: { input: 0.14, output: 0.28, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    includedUsageUsd: 60,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} No cache-read rate is published.`,
    confidence: "high",
  },
  "opencode-go/mimo-v2.5": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.44, research: 0.52, toolUse: 0.68, speed: 0.97 },
    costPerMTok: { input: 0.14, output: 0.28, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    includedUsageUsd: 60,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} No cache-read rate is published. Previous generation.`,
    confidence: "high",
  },
  "opencode-go/mimo-v2.6-pro": {
    tier: "advanced",
    capability: { coding: 0.88, reasoning: 0.9, research: 0.87, toolUse: 0.86, speed: 0.7 },
    costPerMTok: { input: 0.435, output: 0.87, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    includedUsageUsd: 15,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} No cache-read rate is published.`,
    confidence: "high",
  },
  "opencode-go/mimo-v2.5-pro": {
    tier: "balanced",
    capability: { coding: 0.84, reasoning: 0.85, research: 0.82, toolUse: 0.83, speed: 0.72 },
    costPerMTok: { input: 0.435, output: 0.87, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    includedUsageUsd: 15,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} No cache-read rate is published. Previous generation of the pro line.`,
    confidence: "high",
  },
  "opencode-go/minimax-m3": {
    tier: "balanced",
    capability: { coding: 0.82, reasoning: 0.8, research: 0.78, toolUse: 0.8, speed: 0.8 },
    costPerMTok: { input: 0.3, output: 1.2, cacheRead: 0 },
    effortCost: THINKING_TOGGLE_EFFORT_COST,
    includedUsageUsd: 60,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} Exposes a none/thinking toggle instead of a graded ladder.`,
    confidence: "high",
  },
  "opencode-go/minimax-m2.7": {
    tier: "economy",
    capability: { coding: 0.68, reasoning: 0.6, research: 0.6, toolUse: 0.7, speed: 0.84 },
    costPerMTok: { input: 0.3, output: 1.2, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    includedUsageUsd: 60,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} No catalog variant is exposed. Previous generation.`,
    confidence: "high",
  },
  "opencode-go/deepseek-v4.1-flash": {
    tier: "economy",
    capability: { coding: 0.68, reasoning: 0.55, research: 0.58, toolUse: 0.7, speed: 0.95 },
    costPerMTok: { input: 0.15, output: 0.3, cacheRead: 0 },
    effortCost: GLM_EFFORT_COST,
    includedUsageUsd: 60,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} Peak hours double the published rate.`,
    confidence: "high",
  },
  "opencode-go/deepseek-v4-flash": {
    tier: "balanced",
    capability: { coding: 0.68, reasoning: 0.6, research: 0.6, toolUse: 0.7, speed: 0.41 },
    costPerMTok: { input: 0.15, output: 0.3, cacheRead: 0 },
    effortCost: GLM_EFFORT_COST,
    includedUsageUsd: 60,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} ${DEEPSWE_V11} score 53% at max effort: the floor of the balanced band. Peak hours double the published rate.`,
    confidence: "high",
  },
  "opencode-go/deepseek-v4-pro": {
    tier: "balanced",
    capability: { coding: 0.8, reasoning: 0.78, research: 0.76, toolUse: 0.82, speed: 0.42 },
    costPerMTok: { input: 0.66, output: 1.32, cacheRead: 0 },
    effortCost: GLM_EFFORT_COST,
    includedUsageUsd: 15,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} ${DEEPSWE_V11} score 63% at max effort: same as glm-5.3-flash, so the same balanced tier despite the pro name.`,
    confidence: "medium",
  },
  "opencode-go/deepseek-v4-flash-vision-exp": {
    tier: "economy",
    capability: { coding: 0.64, reasoning: 0.5, research: 0.6, toolUse: 0.66, speed: 0.9 },
    costPerMTok: { input: 0.15, output: 0.3, cacheRead: 0 },
    effortCost: GLM_EFFORT_COST,
    includedUsageUsd: 15,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} Experimental vision variant of the flash line.`,
    confidence: "medium",
  },
  "opencode-go/longcat-2.0": {
    tier: "balanced",
    capability: { coding: 0.78, reasoning: 0.72, research: 0.7, toolUse: 0.78, speed: 0.85 },
    costPerMTok: { input: 0.3, output: 1.2, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    includedUsageUsd: 60,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} No cache-read rate is published.`,
    confidence: "high",
  },
  "opencode-go/longcat-2.5-preview-free": {
    tier: "economy",
    capability: { coding: 0.6, reasoning: 0.5, research: 0.5, toolUse: 0.65, speed: 0.8 },
    costPerMTok: { input: 0, output: 0, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: UNMETERED_SOURCE,
    confidence: "low",
  },
  "opencode-go/hy3": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.55, research: 0.58, toolUse: 0.66, speed: 0.93 },
    costPerMTok: { input: 0.14, output: 0.58, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    includedUsageUsd: 60,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} No cache-read rate is published.`,
    confidence: "high",
  },
  "opencode-go/hy4-preview": {
    tier: "balanced",
    capability: { coding: 0.8, reasoning: 0.78, research: 0.76, toolUse: 0.8, speed: 0.72 },
    costPerMTok: { input: 0.834, output: 2.501, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    includedUsageUsd: 30,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} Preview build, so capability is provisional.`,
    confidence: "medium",
  },
  "opencode-go/muse-spark-1.3-contributor": {
    tier: "balanced",
    capability: { coding: 0.7, reasoning: 0.64, research: 0.62, toolUse: 0.72, speed: 0.92 },
    costPerMTok: { input: 0.1, output: 0.2, cacheRead: 0.002 },
    effortCost: NO_EFFORT_COST,
    includedUsageUsd: 60,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} Unmeasured; one generation above muse-spark-1.2, which scored 55% at xhigh effort on ${DEEPSWE_V11}, so balanced by generation inference at medium confidence. The listed rate is an estimate.`,
    confidence: "medium",
  },
  "opencode-go/muse-spark-1.2-contributor": {
    tier: "balanced",
    capability: { coding: 0.68, reasoning: 0.62, research: 0.6, toolUse: 0.7, speed: 0.46 },
    costPerMTok: { input: 0.1, output: 0.2, cacheRead: 0.002 },
    effortCost: NO_EFFORT_COST,
    includedUsageUsd: 60,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: `${GO_PLAN_SOURCE} ${DEEPSWE_V11} score 55% at xhigh effort: balanced floor. The listed rate is an estimate.`,
    confidence: "medium",
  },
  "opencode-go/space-bunny-free": {
    tier: "economy",
    capability: { coding: 0.58, reasoning: 0.46, research: 0.5, toolUse: 0.62, speed: 0.85 },
    costPerMTok: { input: 0, output: 0, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: OPENCODE_GO_WINDOW_SHARES,
    source: UNMETERED_SOURCE,
    confidence: "low",
  },
  "kimi-code-plan-global/kimi-for-coding": {
    tier: "advanced",
    capability: { coding: 0.9, reasoning: 0.86, research: 0.8, toolUse: 0.9, speed: 0.72 },
    costPerMTok: { input: 3, output: 15, cacheRead: 0.3 },
    effortCost: GLM_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: `${KIMI_PLAN_SOURCE} Rate assumed from the K3 family list price.`,
    confidence: "low",
  },
  "kimi-code-plan-global/kimi-for-coding-highspeed": {
    tier: "balanced",
    capability: { coding: 0.78, reasoning: 0.7, research: 0.66, toolUse: 0.8, speed: 0.92 },
    costPerMTok: { input: 3, output: 15, cacheRead: 0.3 },
    effortCost: GLM_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: `${KIMI_PLAN_SOURCE} Rate assumed from the K3 family list price.`,
    confidence: "low",
  },
  "kimi-code-plan-global/k3": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.95, research: 0.84, toolUse: 0.9, speed: 0.55 },
    costPerMTok: { input: 3, output: 15, cacheRead: 0.3 },
    effortCost: KIMI_K3_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: `${KIMI_PLAN_SOURCE} ${DEEPSWE_V11} score 69% at max effort, the only gear this model exposes. Rate taken from the K3 list price published on the Go rate card.`,
    confidence: "medium",
  },
  "kimi-code-plan-global/k3-256k": {
    tier: "balanced",
    capability: { coding: 0.85, reasoning: 0.86, research: 0.78, toolUse: 0.86, speed: 0.72 },
    costPerMTok: { input: 3, output: 15, cacheRead: 0.3 },
    effortCost: KIMI_K3_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: `${KIMI_PLAN_SOURCE} Context-limited K3 build, so one step below the full window.`,
    confidence: "medium",
  },
  "zcode/glm-5.3": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.95, research: 0.86, toolUse: 0.9, speed: 0.55 },
    costPerMTok: { input: 1.4, output: 4.4, cacheRead: 0.26 },
    effortCost: GLM_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: `${ZAI_PLAN_SOURCE} ${DEEPSWE_V11} score 69% at max effort, a gear this row exposes.`,
    confidence: "high",
  },
  "zcode/glm-5.3-flash": {
    tier: "balanced",
    capability: { coding: 0.76, reasoning: 0.62, research: 0.58, toolUse: 0.8, speed: 0.59 },
    costPerMTok: { input: 0.15, output: 0.5, cacheRead: 0.03 },
    effortCost: GLM_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: `${ZAI_PLAN_SOURCE} ${DEEPSWE_V11} score 63% at max effort, a gear this row exposes.`,
    confidence: "high",
  },
  "zai-coding-plan/glm-5.3": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.95, research: 0.86, toolUse: 0.9, speed: 0.55 },
    costPerMTok: { input: 1.4, output: 4.4, cacheRead: 0.26 },
    effortCost: GLM_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: ZAI_INHERITED_RATE_SOURCE,
    confidence: "medium",
  },
  "zai-coding-plan/glm-5.3-flash": {
    tier: "balanced",
    capability: { coding: 0.76, reasoning: 0.62, research: 0.58, toolUse: 0.8, speed: 0.59 },
    costPerMTok: { input: 0.15, output: 0.5, cacheRead: 0.03 },
    effortCost: GLM_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: ZAI_INHERITED_RATE_SOURCE,
    confidence: "medium",
  },
  "openai/gpt-6.1-sol": {
    tier: "advanced",
    capability: { coding: 0.95, reasoning: 0.96, research: 0.9, toolUse: 0.94, speed: 0.55 },
    costPerMTok: { input: 2.5, output: 15, cacheRead: 0.25 },
    effortCost: CODEX_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: CODEX_ESTIMATE_SOURCE,
    confidence: "medium",
  },
  "openai/gpt-6.1-sol-fast": {
    tier: "balanced",
    capability: { coding: 0.86, reasoning: 0.84, research: 0.8, toolUse: 0.88, speed: 0.82 },
    costPerMTok: { input: 1.25, output: 7.5, cacheRead: 0.125 },
    effortCost: CODEX_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: CODEX_ESTIMATE_SOURCE,
    confidence: "medium",
  },
  "openai/gpt-6-luna": {
    tier: "balanced",
    capability: { coding: 0.82, reasoning: 0.75, research: 0.72, toolUse: 0.84, speed: 0.9 },
    costPerMTok: { input: 0.6, output: 3.6, cacheRead: 0.06 },
    effortCost: CODEX_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: CODEX_ESTIMATE_SOURCE,
    confidence: "medium",
  },
  "openai/gpt-6-luna-fast": {
    tier: "economy",
    capability: { coding: 0.68, reasoning: 0.6, research: 0.58, toolUse: 0.72, speed: 0.95 },
    costPerMTok: { input: 0.3, output: 1.8, cacheRead: 0.03 },
    effortCost: CODEX_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: CODEX_ESTIMATE_SOURCE,
    confidence: "medium",
  },
  "openai/gpt-6-sol": {
    tier: "advanced",
    capability: { coding: 0.93, reasoning: 0.94, research: 0.9, toolUse: 0.92, speed: 0.58 },
    costPerMTok: { input: 2, output: 12, cacheRead: 0.2 },
    effortCost: CODEX_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: CODEX_ESTIMATE_SOURCE,
    confidence: "medium",
  },
  "openai/gpt-6-sol-fast": {
    tier: "balanced",
    capability: { coding: 0.85, reasoning: 0.82, research: 0.8, toolUse: 0.87, speed: 0.85 },
    costPerMTok: { input: 1, output: 6, cacheRead: 0.1 },
    effortCost: CODEX_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: CODEX_ESTIMATE_SOURCE,
    confidence: "medium",
  },
  "openai/gpt-6-astra": {
    tier: "advanced",
    capability: { coding: 0.9, reasoning: 0.9, research: 0.94, toolUse: 0.9, speed: 0.8 },
    costPerMTok: { input: 2, output: 12, cacheRead: 0.2 },
    effortCost: CODEX_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: `${CODEX_ESTIMATE_SOURCE} ${DEEPSWE_V11} score 74% at xhigh effort, a gear this row exposes.`,
    confidence: "medium",
  },
  "openai/gpt-6-astra-fast": {
    tier: "balanced",
    capability: { coding: 0.8, reasoning: 0.78, research: 0.86, toolUse: 0.84, speed: 0.86 },
    costPerMTok: { input: 1, output: 6, cacheRead: 0.1 },
    effortCost: CODEX_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: CODEX_ESTIMATE_SOURCE,
    confidence: "medium",
  },
  "openai/gpt-6-astra-ultrafast": {
    tier: "economy",
    capability: { coding: 0.66, reasoning: 0.62, research: 0.72, toolUse: 0.7, speed: 0.95 },
    costPerMTok: { input: 0.5, output: 3, cacheRead: 0.05 },
    effortCost: CODEX_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: CODEX_ESTIMATE_SOURCE,
    confidence: "medium",
  },
  "openai/gpt-5.6-luna": {
    tier: "advanced",
    capability: { coding: 0.88, reasoning: 0.86, research: 0.84, toolUse: 0.87, speed: 0.59 },
    costPerMTok: { input: 0.4, output: 2.4, cacheRead: 0.04 },
    effortCost: CODEX_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: `${CODEX_ESTIMATE_SOURCE} ${DEEPSWE_V11} score 67% at max effort, a gear this row exposes: the cheap line measures at the advanced cutoff.`,
    confidence: "medium",
  },
  "openai/gpt-5.6-luna-fast": {
    tier: "economy",
    capability: { coding: 0.66, reasoning: 0.58, research: 0.56, toolUse: 0.7, speed: 0.95 },
    costPerMTok: { input: 0.2, output: 1.2, cacheRead: 0.02 },
    effortCost: CODEX_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: CODEX_ESTIMATE_SOURCE,
    confidence: "medium",
  },
  "openai/gpt-5.6-terra": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.93, research: 0.89, toolUse: 0.9, speed: 0.6 },
    costPerMTok: { input: 2, output: 12, cacheRead: 0.2 },
    effortCost: CODEX_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: CODEX_ESTIMATE_SOURCE,
    confidence: "medium",
  },
  "openai/gpt-5.6-terra-fast": {
    tier: "balanced",
    capability: { coding: 0.84, reasoning: 0.81, research: 0.79, toolUse: 0.86, speed: 0.86 },
    costPerMTok: { input: 1, output: 6, cacheRead: 0.1 },
    effortCost: CODEX_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: CODEX_ESTIMATE_SOURCE,
    confidence: "medium",
  },
  "openai/gpt-5.6-sol": {
    tier: "advanced",
    capability: { coding: 0.94, reasoning: 0.95, research: 0.9, toolUse: 0.93, speed: 0.65 },
    costPerMTok: { input: 2.5, output: 15, cacheRead: 0.25 },
    effortCost: CODEX_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: `${CODEX_ESTIMATE_SOURCE} ${DEEPSWE_V11} score 73% at max effort, a gear this row exposes.`,
    confidence: "medium",
  },
  "openai/gpt-5.6-sol-fast": {
    tier: "balanced",
    capability: { coding: 0.85, reasoning: 0.83, research: 0.8, toolUse: 0.88, speed: 0.84 },
    costPerMTok: { input: 1.25, output: 7.5, cacheRead: 0.125 },
    effortCost: CODEX_EFFORT_COST,
    includedUsageUsd: null,
    windowShares: {},
    source: CODEX_ESTIMATE_SOURCE,
    confidence: "medium",
  },
  "openai/gpt-5.5": {
    tier: "advanced",
    capability: { coding: 0.88, reasoning: 0.87, research: 0.85, toolUse: 0.88, speed: 0.72 },
    costPerMTok: { input: 1.25, output: 7.5, cacheRead: 0.125 },
    effortCost: CODEX_EFFORT_COST_NO_MAX,
    includedUsageUsd: null,
    windowShares: {},
    source: `${CODEX_ESTIMATE_SOURCE} ${DEEPSWE_V11} score 67% at xhigh effort, the top gear this generation exposes. This generation stops at the xhigh effort rung.`,
    confidence: "medium",
  },
  "openai/gpt-5.5-fast": {
    tier: "economy",
    capability: { coding: 0.66, reasoning: 0.6, research: 0.6, toolUse: 0.7, speed: 0.94 },
    costPerMTok: { input: 0.63, output: 3.75, cacheRead: 0.06 },
    effortCost: CODEX_EFFORT_COST_NO_MAX,
    includedUsageUsd: null,
    windowShares: {},
    source: `${CODEX_ESTIMATE_SOURCE} This generation stops at the xhigh effort rung.`,
    confidence: "medium",
  },
  "openai/gpt-5.3-codex-spark": {
    tier: "balanced",
    capability: { coding: 0.78, reasoning: 0.7, research: 0.66, toolUse: 0.82, speed: 0.96 },
    costPerMTok: { input: 0.4, output: 2.4, cacheRead: 0.04 },
    effortCost: CODEX_EFFORT_COST_NO_MAX,
    includedUsageUsd: null,
    windowShares: {},
    source: `${CODEX_ESTIMATE_SOURCE} Spark tier: a fast code-specialised build, so never a frontier pick.`,
    confidence: "medium",
  },
}

/**
 * Flatten one curated row into a contract profile.
 *
 * `cacheWrite` is pinned to zero because no vendor in scope publishes a
 * cache-write rate; the omission is stated in the affected rows' `source` so an
 * estimate can be corrected when a rate card publishes one.
 */
function toPricedProfile(row: CuratedRow): PricedModelProfile {
  return {
    tier: row.tier,
    coding: row.capability.coding,
    reasoning: row.capability.reasoning,
    research: row.capability.research,
    toolUse: row.capability.toolUse,
    speed: row.capability.speed,
    effortCost: row.effortCost,
    includedUsageUsd: row.includedUsageUsd,
    windowShares: row.windowShares,
    costPerMTok: {
      input: row.costPerMTok.input,
      output: row.costPerMTok.output,
      cacheRead: row.costPerMTok.cacheRead,
      cacheWrite: UNPUBLISHED_CACHE_WRITE_RATE,
    },
    source: row.source,
    confidence: row.confidence,
  }
}

/** Build the public profile table once, from the curated rows. */
function buildProfiles(
  rows: Readonly<Record<string, CuratedRow>>,
): Readonly<Record<string, PricedModelProfile>> {
  const profiles: Record<string, PricedModelProfile> = {}
  for (const [ref, row] of Object.entries(rows)) {
    profiles[ref] = toPricedProfile(row)
  }
  return profiles
}

/**
 * Curated profiles keyed by `"<providerID>/<modelID>"`, exactly as OpenCode
 * reports the IDs.
 */
export const MODEL_PROFILES: Readonly<Record<string, PricedModelProfile>> =
  buildProfiles(CURATED_ROWS)

/**
 * Profile handed to a model with no curated entry.
 *
 * Deliberately conservative: a neutral mid-band score, no effort multipliers,
 * and no dollar allowance, so an unknown model can never be out-ranked by
 * preference, charged a guessed premium, or promoted to the advanced tier by
 * default. `confidence: "low"` and `tier: "economy"` keep the router on the
 * cautious side until the model is curated.
 */
export const DEFAULT_MODEL_PROFILE: ModelProfile = {
  tier: "economy",
  coding: 0.5,
  reasoning: 0.5,
  research: 0.5,
  toolUse: 0.5,
  speed: 0.5,
  effortCost: {},
  includedUsageUsd: null,
  windowShares: {},
  source:
    "No curated entry for this model. Neutral estimates, no effort cost and no dollar allowance, because nothing is known about it; re-curate before trusting its tier or its quota math.",
  confidence: "low",
}

/**
 * Look up the curated profile of one model.
 *
 * @param ref Model reference in `"<providerID>/<modelID>"` form.
 * @returns The curated profile, or `undefined` when the model is unknown. Callers
 *   decide whether to fall back to {@link DEFAULT_MODEL_PROFILE}; an absent
 *   profile must never be read as a strong one.
 */
export function profileFor(ref: string): ModelProfile | undefined {
  return MODEL_PROFILES[ref]
}
