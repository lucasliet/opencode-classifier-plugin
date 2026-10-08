import type { CapabilityTier, MetadataConfidence } from "./contracts.ts"

/**
 * The curated model table, keyed by canonical model ID (see `model-id.ts`).
 *
 * A row describes the model itself, whichever provider serves it:
 *
 * - `tier` and `capability` come from public benchmarks, in this order:
 *   1. DeepSWE v1.1, because it measures long-horizon agentic coding, the work
 *      the router dispatches: >= 67% reads as advanced, 50-66% as balanced,
 *      below 50% as economy. A successor inherits its measured predecessor's
 *      tier when the indexes below do not place it lower.
 *   2. Without DeepSWE, advanced needs an Artificial Analysis Intelligence
 *      Index >= 45 plus one strong agentic signal (vendor SWE-bench Pro >= 65,
 *      Terminal-Bench 2.1 >= 88 or 4.0 >= 50). The index alone is not enough:
 *      qwen3.8-max scores 45 there but only 57% on DeepSWE.
 *   3. Balanced needs an index >= 35 or SWE-bench Pro >= 60; anything weaker
 *      or unmeasured is economy.
 *   Each row names its evidence in `source`.
 * - `speed` is a responsiveness proxy: `0.95 - outputTokensPerTask / 200_000`
 *   on DeepSWE where measured, otherwise `0.3 + tokensPerSecond / 500` from
 *   the Artificial Analysis median, capped at 0.95. Measured throughput
 *   replaces it at run time.
 * - `costPerMTok` is the vendor's list price. It is only a burn proxy for
 *   subscription plans, which publish no price at call time; a host price
 *   always wins over it.
 * - `effortCost` maps the variant IDs the model is known to expose to how much
 *   more quota each burns than the cheapest one.
 *
 * Older releases of a line are not curated: `supersede.ts` drops them while a
 * newer release is available, and a model without a row gets a profile derived
 * from models.dev.
 */

/** Capability estimates, 0..1. */
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

/** One row of the curated table. */
export interface CuratedRow {
  readonly tier: CapabilityTier
  readonly capability: CuratedCapability
  readonly costPerMTok: CuratedRates
  readonly effortCost: Readonly<Record<string, number>>
  readonly source: string
  readonly confidence: MetadataConfidence
}

/**
 * Graded effort ladder (`none | low | medium | high | xhigh | max`).
 *
 * A variant's number is how much MORE quota it burns than the cheapest one,
 * because raising effort mainly inflates output and reasoning tokens. The top
 * is deliberately steep: `max` emits far more reasoning than `high`, so letting
 * it through cheaply drains a shared pool.
 */
const GRADED_EFFORT_COST: Readonly<Record<string, number>> = {
  none: 1,
  minimal: 1,
  low: 1,
  medium: 1.5,
  high: 2.5,
  xhigh: 4,
  max: 6,
}

/** Graded ladder for models that stop at `xhigh`. */
const GRADED_NO_MAX_EFFORT_COST: Readonly<Record<string, number>> = {
  none: 1,
  minimal: 1,
  low: 1,
  medium: 1.5,
  high: 2.5,
  xhigh: 4,
}

/** Three-step ladder (`low | high | max`) used by GLM-style vendors. */
const THREE_STEP_EFFORT_COST: Readonly<Record<string, number>> = {
  low: 1,
  high: 2.5,
  max: 6,
}

/**
 * Kimi K3 exposes only `max`. It still requests a full reasoning budget, so it
 * is charged the top of the ladder rather than the baseline.
 */
const MAX_ONLY_EFFORT_COST: Readonly<Record<string, number>> = { max: 6 }

/** A `none | thinking` toggle: both states cost the same. */
const THINKING_TOGGLE_EFFORT_COST: Readonly<Record<string, number>> = {
  none: 1,
  thinking: 1,
}

/** No known variants means no variant-specific cost, never a guessed one. */
const NO_EFFORT_COST: Readonly<Record<string, number>> = {}

/** Primary capability evidence. */
const DEEPSWE = "DeepSWE v1.1 (deepswe.datacurve.ai, 2026-09-22, mini-swe-agent, pass@1)"

/** Secondary capability and speed evidence. */
const AA = "Artificial Analysis (2026-10-07)"

/** Price provenance. */
const LIST_PRICE = "Rates: vendor list price on models.dev (2026-09-25)."

/** Price provenance for models whose vendor publishes no list price. */
const HOST_PRICE = "Rates: lowest published host price, as a burn proxy only."

/** Provenance for unpriced, unmeasured preview and stealth models. */
const UNMEASURED_PREVIEW =
  "Unmeasured preview or stealth model with no published rate: burn rates are zero and capability is a guess, not a ranking."

export const CURATED_MODELS: Readonly<Record<string, CuratedRow>> = {
  "claude-opus-5-5": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.92, research: 0.88, toolUse: 0.9, speed: 0.49 },
    costPerMTok: { input: 4, output: 20, cacheRead: 0.2 },
    effortCost: GRADED_EFFORT_COST,
    source: `${AA}: Intelligence 57.6 (first), 95 tok/s; vendor SWE-bench Pro 89.9. Successor of claude-opus-5 (${DEEPSWE}: 74% at max). ${LIST_PRICE}`,
    confidence: "high",
  },
  "claude-fable-5-1": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.92, research: 0.88, toolUse: 0.9, speed: 0.43 },
    costPerMTok: { input: 10, output: 50, cacheRead: 0.25 },
    effortCost: GRADED_EFFORT_COST,
    source: `${AA}: Intelligence 53.4, Terminal-Bench 2.1 91.4, 66 tok/s. Successor of claude-fable-5 (${DEEPSWE}: 70% at xhigh). ${LIST_PRICE}`,
    confidence: "high",
  },
  "claude-sonnet-5-5": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.92, research: 0.88, toolUse: 0.9, speed: 0.56 },
    costPerMTok: { input: 2, output: 10, cacheRead: 0.2 },
    effortCost: GRADED_EFFORT_COST,
    source: `${AA}: Intelligence 56.0, Terminal-Bench 4.0 63.6, 129 tok/s; vendor SWE-bench Pro 81.3. Not on models.dev yet, so rates are assumed from claude-sonnet-5.`,
    confidence: "medium",
  },
  "claude-haiku-5-5": {
    tier: "balanced",
    capability: { coding: 0.8, reasoning: 0.76, research: 0.74, toolUse: 0.8, speed: 0.78 },
    costPerMTok: { input: 1, output: 5, cacheRead: 0.1 },
    effortCost: GRADED_EFFORT_COST,
    source: `${AA}: Intelligence 43.4, 242 tok/s; vendor SWE-bench Pro 64.8. Not on models.dev yet, so rates are assumed from claude-haiku-4-5.`,
    confidence: "medium",
  },
  "gpt-6.1-sol": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.92, research: 0.88, toolUse: 0.9, speed: 0.41 },
    costPerMTok: { input: 2, output: 10, cacheRead: 0.2 },
    effortCost: GRADED_EFFORT_COST,
    source: `${AA}: Intelligence 51.8, Terminal-Bench 4.0 56.1, 55 tok/s. Not on models.dev yet, so rates are assumed from gpt-6-sol.`,
    confidence: "high",
  },
  "gpt-6.1-sol-fast": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.92, research: 0.88, toolUse: 0.9, speed: 0.52 },
    costPerMTok: { input: 4, output: 20, cacheRead: 0.4 },
    effortCost: GRADED_EFFORT_COST,
    source: `Priority serving tier of gpt-6.1-sol: same model, faster, at the twice-the-rate ratio models.dev lists for gpt-6-sol-fast.`,
    confidence: "medium",
  },
  "gpt-6-astra": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.92, research: 0.88, toolUse: 0.9, speed: 0.8 },
    costPerMTok: { input: 10, output: 50, cacheRead: 1 },
    effortCost: GRADED_EFFORT_COST,
    source: `${DEEPSWE}: 74% at xhigh, 30k output tokens per task. ${AA}: Intelligence 52.7. ${LIST_PRICE}`,
    confidence: "high",
  },
  "gpt-6-astra-fast": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.92, research: 0.88, toolUse: 0.9, speed: 0.85 },
    costPerMTok: { input: 20, output: 100, cacheRead: 2 },
    effortCost: GRADED_EFFORT_COST,
    source: `Priority serving tier of gpt-6-astra: same model, faster. Rates from models.dev.`,
    confidence: "medium",
  },
  "gpt-6-astra-ultrafast": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.92, research: 0.88, toolUse: 0.9, speed: 0.92 },
    costPerMTok: { input: 20, output: 100, cacheRead: 2 },
    effortCost: GRADED_EFFORT_COST,
    source: `Fastest serving tier of gpt-6-astra: same model. Not on models.dev, so rates are assumed from gpt-6-astra-fast.`,
    confidence: "low",
  },
  "gpt-6-luna": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.92, research: 0.88, toolUse: 0.9, speed: 0.56 },
    costPerMTok: { input: 0.1, output: 0.5, cacheRead: 0.01 },
    effortCost: GRADED_EFFORT_COST,
    source: `Successor of gpt-5.6-luna (${DEEPSWE}: 67% at max) and level with it on ${AA}: Intelligence 38.1 against 37.3, 129 tok/s. ${LIST_PRICE}`,
    confidence: "medium",
  },
  "gpt-6-luna-fast": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.92, research: 0.88, toolUse: 0.9, speed: 0.75 },
    costPerMTok: { input: 0.2, output: 1, cacheRead: 0.02 },
    effortCost: GRADED_EFFORT_COST,
    source: `Priority serving tier of gpt-6-luna: same model, faster. Rates from models.dev.`,
    confidence: "medium",
  },
  "gpt-5.6-terra": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.92, research: 0.88, toolUse: 0.9, speed: 0.52 },
    costPerMTok: { input: 2, output: 12, cacheRead: 0.2 },
    effortCost: GRADED_EFFORT_COST,
    source: `Between gpt-5.6-luna (67%) and gpt-5.6-sol (73%) on ${DEEPSWE}. ${AA}: Intelligence 42.1, Terminal-Bench 2.1 88.0, 108 tok/s; vendor SWE-bench Pro 63.4. ${LIST_PRICE}`,
    confidence: "medium",
  },
  "gpt-5.6-terra-fast": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.92, research: 0.88, toolUse: 0.9, speed: 0.7 },
    costPerMTok: { input: 4, output: 24, cacheRead: 0.4 },
    effortCost: GRADED_EFFORT_COST,
    source: `Priority serving tier of gpt-5.6-terra: same model, faster. Rates from models.dev.`,
    confidence: "medium",
  },
  "gpt-5.3-codex-spark": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.56, research: 0.56, toolUse: 0.66, speed: 0.95 },
    costPerMTok: { input: 0.4, output: 2.4, cacheRead: 0.04 },
    effortCost: GRADED_NO_MAX_EFFORT_COST,
    source: `Smaller build of gpt-5.3-codex (${AA}: Intelligence 32.5) served above 1000 tok/s; unmeasured itself. No list price is published, so rates are a local estimate.`,
    confidence: "medium",
  },
  "gemini-3.8-flash": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.92, research: 0.88, toolUse: 0.9, speed: 0.24 },
    costPerMTok: { input: 0.75, output: 3.75, cacheRead: 0.075 },
    effortCost: GRADED_EFFORT_COST,
    source: `${DEEPSWE}: 74% at high, 143k output tokens per task. ${AA}: Intelligence 40.9, Terminal-Bench 2.1 87.6. ${LIST_PRICE}`,
    confidence: "high",
  },
  "gemini-3.5-flash-lite": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.56, research: 0.56, toolUse: 0.66, speed: 0.95 },
    costPerMTok: { input: 0.3, output: 2.5, cacheRead: 0.03 },
    effortCost: GRADED_EFFORT_COST,
    source: `${AA}: Intelligence 22.2, 346 tok/s; vendor SWE-bench Pro 54.2. ${LIST_PRICE}`,
    confidence: "high",
  },
  "gemini-3.1-pro-preview": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.56, research: 0.56, toolUse: 0.66, speed: 0.54 },
    costPerMTok: { input: 2, output: 12, cacheRead: 0.2 },
    effortCost: GRADED_EFFORT_COST,
    source: `${AA}: Intelligence 29.7, 122 tok/s; vendor SWE-bench Pro 54.2. ${LIST_PRICE}`,
    confidence: "high",
  },
  "gemini-3-pro-image": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.56, research: 0.56, toolUse: 0.66, speed: 0.4 },
    costPerMTok: { input: 2, output: 120, cacheRead: 0.2 },
    effortCost: NO_EFFORT_COST,
    source: `Image-generation model, not a coding agent. ${LIST_PRICE} Output is priced per image token.`,
    confidence: "high",
  },
  "gemini-3.1-flash-image": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.56, research: 0.56, toolUse: 0.66, speed: 0.6 },
    costPerMTok: { input: 0.5, output: 60, cacheRead: 0.05 },
    effortCost: NO_EFFORT_COST,
    source: `Image-generation model, not a coding agent. ${LIST_PRICE} Output is priced per image token.`,
    confidence: "high",
  },
  "grok-4.7": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.92, research: 0.88, toolUse: 0.9, speed: 0.45 },
    costPerMTok: { input: 2, output: 6, cacheRead: 0.5 },
    effortCost: GRADED_EFFORT_COST,
    source: `Successor of grok-4.6 (${DEEPSWE}: 67% at medium). ${AA}: Intelligence 46.4, 73 tok/s. ${LIST_PRICE}`,
    confidence: "medium",
  },
  "grok-4.7-build-fast": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.92, research: 0.88, toolUse: 0.9, speed: 0.59 },
    costPerMTok: { input: 4, output: 12, cacheRead: 1 },
    effortCost: GRADED_EFFORT_COST,
    source: `grok-4.7 on faster serving, about twice the speed at twice the rate, offered only in Grok Build and Cursor.`,
    confidence: "medium",
  },
  "grok-build": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.56, research: 0.56, toolUse: 0.66, speed: 0.45 },
    costPerMTok: { input: 2, output: 6, cacheRead: 0.5 },
    effortCost: NO_EFFORT_COST,
    source: `${AA} lists Grok Build 0.1 at Intelligence 27.2 and 75 tok/s; the match with this ID is unconfirmed. Rates assumed from grok-4.7.`,
    confidence: "low",
  },
  "grok-composer-2.5-fast": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.56, research: 0.56, toolUse: 0.66, speed: 0.8 },
    costPerMTok: { input: 2, output: 6, cacheRead: 0.5 },
    effortCost: NO_EFFORT_COST,
    source: `Cursor Composer 2.5 on its fast serving tier: vendor SWE-bench Pro 54.0, Terminal-Bench 2.1 73.0; not on ${AA}. Rates assumed from grok-4.7.`,
    confidence: "low",
  },
  "glm-5.3": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.92, research: 0.88, toolUse: 0.9, speed: 0.55 },
    costPerMTok: { input: 1.4, output: 4.4, cacheRead: 0.26 },
    effortCost: THREE_STEP_EFFORT_COST,
    source: `${DEEPSWE}: 69% at max, 80k output tokens per task. ${AA}: Intelligence 44.8. ${LIST_PRICE}`,
    confidence: "high",
  },
  "glm-5.3-flash": {
    tier: "balanced",
    capability: { coding: 0.8, reasoning: 0.76, research: 0.74, toolUse: 0.8, speed: 0.59 },
    costPerMTok: { input: 0.15, output: 0.5, cacheRead: 0.03 },
    effortCost: THREE_STEP_EFFORT_COST,
    source: `${DEEPSWE}: 63% at max, 73k output tokens per task. ${AA}: Intelligence 42. ${LIST_PRICE}`,
    confidence: "high",
  },
  "kimi-k3": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.92, research: 0.88, toolUse: 0.9, speed: 0.55 },
    costPerMTok: { input: 3, output: 15, cacheRead: 0.3 },
    effortCost: MAX_ONLY_EFFORT_COST,
    source: `${DEEPSWE}: 69% at max, the only gear this model exposes, 81k output tokens per task. ${AA}: Intelligence 43.6. ${LIST_PRICE}`,
    confidence: "high",
  },
  "k3-256k": {
    tier: "advanced",
    capability: { coding: 0.92, reasoning: 0.92, research: 0.88, toolUse: 0.9, speed: 0.55 },
    costPerMTok: { input: 3, output: 15, cacheRead: 0.3 },
    effortCost: MAX_ONLY_EFFORT_COST,
    source: `Kimi K3 with a 256K window: same model, so the same tier; the context gate keeps oversized prompts away. Rates assumed from kimi-k3.`,
    confidence: "medium",
  },
  "kimi-for-coding": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.56, research: 0.56, toolUse: 0.66, speed: 0.6 },
    costPerMTok: { input: 3, output: 15, cacheRead: 0.3 },
    effortCost: THREE_STEP_EFFORT_COST,
    source: `Kimi Code plan alias serving K2.8 Preview since 2026-09-11; unmeasured, and its predecessor K2.7 Code scores Intelligence 25.8 on ${AA}. Rates assumed from kimi-k3.`,
    confidence: "low",
  },
  "kimi-for-coding-highspeed": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.56, research: 0.56, toolUse: 0.66, speed: 0.9 },
    costPerMTok: { input: 3, output: 15, cacheRead: 0.3 },
    effortCost: THREE_STEP_EFFORT_COST,
    source: `Kimi Code plan alias serving K2.7 Code HighSpeed: ${AA} Intelligence 25.8, Terminal-Bench 2.1 67.4. Rates assumed from kimi-k3.`,
    confidence: "medium",
  },
  "deepseek-v4.1-flash": {
    tier: "balanced",
    capability: { coding: 0.8, reasoning: 0.76, research: 0.74, toolUse: 0.8, speed: 0.73 },
    costPerMTok: { input: 0.2, output: 0.6, cacheRead: 0.006 },
    effortCost: THREE_STEP_EFFORT_COST,
    source: `${AA}: Intelligence 39.5, 216 tok/s. ${HOST_PRICE}`,
    confidence: "medium",
  },
  "deepseek-v4-pro": {
    tier: "balanced",
    capability: { coding: 0.8, reasoning: 0.76, research: 0.74, toolUse: 0.8, speed: 0.42 },
    costPerMTok: { input: 0.66, output: 1.32, cacheRead: 0 },
    effortCost: THREE_STEP_EFFORT_COST,
    source: `${DEEPSWE}: 63% at max, 106k output tokens per task. ${AA}: Intelligence 36.0. ${HOST_PRICE}`,
    confidence: "high",
  },
  "qwen3.8-max": {
    tier: "balanced",
    capability: { coding: 0.8, reasoning: 0.76, research: 0.74, toolUse: 0.8, speed: 0.48 },
    costPerMTok: { input: 2, output: 6, cacheRead: 0.25 },
    effortCost: GRADED_EFFORT_COST,
    source: `${DEEPSWE}: 57% at xhigh, 95k output tokens per task, despite ${AA} Intelligence 45.4 and vendor SWE-bench Pro 67.7. ${LIST_PRICE}`,
    confidence: "high",
  },
  "qwen3.8-flash": {
    tier: "balanced",
    capability: { coding: 0.8, reasoning: 0.76, research: 0.74, toolUse: 0.8, speed: 0.41 },
    costPerMTok: { input: 0.15, output: 0.47, cacheRead: 0.016 },
    effortCost: NO_EFFORT_COST,
    source: `${AA}: Intelligence 39.8, 56 tok/s; vendor SWE-bench Pro 62.5. ${LIST_PRICE}`,
    confidence: "medium",
  },
  "mimo-v2.6-flash": {
    tier: "balanced",
    capability: { coding: 0.8, reasoning: 0.76, research: 0.74, toolUse: 0.8, speed: 0.42 },
    costPerMTok: { input: 0.14, output: 0.28, cacheRead: 0.0028 },
    effortCost: NO_EFFORT_COST,
    source: `${AA}: Intelligence 37.9, 58 tok/s. ${LIST_PRICE}`,
    confidence: "medium",
  },
  "mimo-v2.6-pro": {
    tier: "balanced",
    capability: { coding: 0.8, reasoning: 0.76, research: 0.74, toolUse: 0.8, speed: 0.38 },
    costPerMTok: { input: 0.435, output: 0.87, cacheRead: 0.0036 },
    effortCost: NO_EFFORT_COST,
    source: `${AA}: Intelligence 46.3, the best open-weight model there, 38 tok/s; without a strong agentic coding score it stays balanced. ${LIST_PRICE}`,
    confidence: "medium",
  },
  "minimax-m3": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.56, research: 0.56, toolUse: 0.66, speed: 0.49 },
    costPerMTok: { input: 0.3, output: 1.2, cacheRead: 0 },
    effortCost: THINKING_TOGGLE_EFFORT_COST,
    source: `${AA}: Intelligence 29.2, 94 tok/s; vendor SWE-bench Pro 59.0. Exposes a none/thinking toggle instead of a graded ladder. ${HOST_PRICE}`,
    confidence: "medium",
  },
  "muse-spark-1.3-contributor": {
    tier: "balanced",
    capability: { coding: 0.8, reasoning: 0.76, research: 0.74, toolUse: 0.8, speed: 0.72 },
    costPerMTok: { input: 0.1, output: 0.2, cacheRead: 0.002 },
    effortCost: NO_EFFORT_COST,
    source: `${AA}: Intelligence 48.1, Terminal-Bench 2.1 84.3, 209 tok/s; its predecessor muse-spark-1.2 scored 55% on ${DEEPSWE}. ${HOST_PRICE}`,
    confidence: "medium",
  },
  "longcat-2.0": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.56, research: 0.56, toolUse: 0.66, speed: 0.6 },
    costPerMTok: { input: 0.3, output: 1.2, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    source: `${AA}: Intelligence 19.1. ${HOST_PRICE}`,
    confidence: "medium",
  },
  "longcat-2.5-preview": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.56, research: 0.56, toolUse: 0.66, speed: 0.6 },
    costPerMTok: { input: 0, output: 0, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    source: `No public benchmark found. ${UNMEASURED_PREVIEW}`,
    confidence: "low",
  },
  "hy4-preview": {
    tier: "balanced",
    capability: { coding: 0.8, reasoning: 0.76, research: 0.74, toolUse: 0.8, speed: 0.6 },
    costPerMTok: { input: 0.834, output: 2.501, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    source: `Vendor SWE-bench Pro 65.7; not on ${AA}. Preview build, so capability is provisional. ${HOST_PRICE}`,
    confidence: "low",
  },
  hy3: {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.56, research: 0.56, toolUse: 0.66, speed: 0.47 },
    costPerMTok: { input: 0.14, output: 0.58, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    source: `${AA}: Intelligence 25.3, 85 tok/s; vendor SWE-bench Pro 57.9. ${HOST_PRICE}`,
    confidence: "medium",
  },
  "nemotron-3-ultra": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.56, research: 0.56, toolUse: 0.66, speed: 0.61 },
    costPerMTok: { input: 0, output: 0, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    source: `${AA}: Intelligence 22.9, 155 tok/s. Served free, so no rate is published.`,
    confidence: "medium",
  },
  "nemotron-3.5-lightning": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.56, research: 0.56, toolUse: 0.66, speed: 0.9 },
    costPerMTok: { input: 0, output: 0, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    source: `${AA}: Intelligence 12.9, 301 tok/s. Served free, so no rate is published.`,
    confidence: "medium",
  },
  "ling-3.0-flash-fin": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.56, research: 0.56, toolUse: 0.66, speed: 0.95 },
    costPerMTok: { input: 0, output: 0, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    source: `Finance-tuned build of Ling 3.0 Flash (${AA}: Intelligence 20.1, 333 tok/s). Served free, so no rate is published.`,
    confidence: "low",
  },
  "big-pickle": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.56, research: 0.56, toolUse: 0.66, speed: 0.6 },
    costPerMTok: { input: 0, output: 0, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    source: `OpenCode Zen stealth model of undisclosed origin. ${UNMEASURED_PREVIEW}`,
    confidence: "low",
  },
  "space-bunny": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.56, research: 0.56, toolUse: 0.66, speed: 0.6 },
    costPerMTok: { input: 0, output: 0, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    source: `Stealth model of undisclosed origin. ${UNMEASURED_PREVIEW}`,
    confidence: "low",
  },
  "gpt-oss-120b": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.56, research: 0.56, toolUse: 0.66, speed: 0.67 },
    costPerMTok: { input: 0.09, output: 0.36, cacheRead: 0 },
    effortCost: GRADED_NO_MAX_EFFORT_COST,
    source: `${AA}: Intelligence 11.6, 183 tok/s; SWE-bench Pro 16.2 (Scale). ${HOST_PRICE}`,
    confidence: "high",
  },
  "llama-4-maverick-17b-128e-instruct": {
    tier: "economy",
    capability: { coding: 0.62, reasoning: 0.56, research: 0.56, toolUse: 0.66, speed: 0.37 },
    costPerMTok: { input: 0.35, output: 1.15, cacheRead: 0 },
    effortCost: NO_EFFORT_COST,
    source: `${AA}: Intelligence 10.0, 34 tok/s. ${HOST_PRICE}`,
    confidence: "high",
  },
}
