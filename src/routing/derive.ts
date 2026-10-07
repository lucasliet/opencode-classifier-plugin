/**
 * Derived profiles: a usable quality and burn estimate for a model nobody
 * curated, built from host facts and the models.dev reference index.
 *
 * The heuristics are coarse on purpose and say so in `source`/`confidence`:
 *
 * - **Capability** follows the reference list price on a log scale. Vendors
 *   price their strongest models highest, so price is the one capability
 *   signal available for every model without a benchmark.
 * - **Tier** reaches `advanced` only for a reasoning model priced from its own
 *   model ID; a family-level price is too loose to promote a model that far.
 *   Models older than {@link STALE_MODEL_AGE_MS} drop one tier.
 *   A `-highspeed`/`-turbo`/`-fast` serving tier inherits its base model's
 *   price, because it runs the same weights.
 * - **Burn** uses that same list price, which `estimate.ts` already treats as
 *   a relative rate when the plan publishes no dollar allowance.
 * - **Speed** starts from name hints and is replaced by measured throughput
 *   once enough turns have run (see `speed.ts`).
 */

import type { CapabilityTier, CatalogModel, MetadataConfidence } from "./contracts.ts"
import type { ModelCostPerMTok, PricedModelProfile } from "./profiles.ts"
import type { ReferenceIndex, ReferencePrice } from "./reference.ts"

/** Output price, USD per million tokens, that maps to capability 0. */
const FLOOR_OUTPUT_PRICE = 0.3
/** Output price, USD per million tokens, that maps to capability 1. */
const CEILING_OUTPUT_PRICE = 30
/** Capability needed for the advanced tier. */
const ADVANCED_CAPABILITY = 0.55
/** Capability needed for the balanced tier. */
const BALANCED_CAPABILITY = 0.3
/** Capability assumed when no price is known anywhere. */
const UNPRICED_CAPABILITY = 0.35
/** About 18 months: older models have usually been superseded. */
const STALE_MODEL_AGE_MS = 548 * 24 * 60 * 60 * 1000

/**
 * Quota multiplier per reasoning effort. Raising effort mainly inflates output
 * and reasoning tokens, so the top of the ladder is deliberately steep.
 */
const EFFORT_LADDER: Readonly<Record<string, number>> = {
  none: 1,
  minimal: 1,
  low: 1,
  medium: 1.5,
  high: 2.5,
  xhigh: 4,
  max: 6,
  thinking: 1,
}

/** Faster serving tiers of the same weights, priced like their base model. */
const SPEED_SUFFIX = /-(highspeed|turbo|fast)$/

const FAST_NAME = /(flash|highspeed|turbo|mini|nano|lite|fast|haiku|spark|air)/
const SLOW_NAME = /(pro|max|opus|ultra|heavy|deep)/

/** Where a derived price came from, strongest first. */
type PriceSource = "host" | "model" | "family" | "none"

interface ResolvedPrice {
  readonly price: ReferencePrice | undefined
  readonly source: PriceSource
}

/**
 * Derive a profile for one host model.
 *
 * @param model Host catalog entry.
 * @param reference models.dev index.
 * @param now Current time in epoch milliseconds, for the staleness rule.
 * @returns A priced profile whose `source` explains every estimate.
 */
export function deriveProfile(
  model: CatalogModel,
  reference: ReferenceIndex,
  now: number,
): PricedModelProfile {
  const facts = reference.byModel.get(model.modelID.toLowerCase())
  const resolved = resolvePrice(model, reference)
  const capability = capabilityOf(resolved.price)
  const reasoning = facts?.reasoning === true || model.variantIDs.length > 0
  const releasedAt = model.releasedAt ?? facts?.releasedAt
  const tier = demoteIfStale(tierOf(capability, reasoning, resolved.source), releasedAt, now)
  return {
    tier,
    coding: capability,
    reasoning: reasoning ? capability : capability * 0.8,
    research: capability,
    toolUse: model.tools ? capability : 0,
    speed: speedPriorFor(model.modelID),
    effortCost: effortCostFor(model.variantIDs),
    costPerMTok: toCost(resolved.price),
    includedUsageUsd: null,
    windowShares: {},
    source: describeSource(resolved),
    confidence: confidenceOf(resolved.source),
  }
}

/**
 * Speed estimate from the model name, used until measurements exist.
 *
 * @param modelID Model ID as the host reports it.
 * @returns 0..1, higher for names that advertise a fast variant.
 */
export function speedPriorFor(modelID: string): number {
  const name = modelID.toLowerCase()
  if (FAST_NAME.test(name)) return 0.75
  if (SLOW_NAME.test(name)) return 0.4
  return 0.55
}

function resolvePrice(model: CatalogModel, reference: ReferenceIndex): ResolvedPrice {
  const host = model.costPerMTok
  if (host.output > 0) {
    return {
      price: { input: host.input || host.output, output: host.output, cacheRead: host.cacheRead || host.input || host.output },
      source: "host",
    }
  }
  const modelID = model.modelID.toLowerCase()
  const byModel =
    reference.byModel.get(modelID)?.price ??
    reference.byModel.get(modelID.replace(SPEED_SUFFIX, ""))?.price
  if (byModel !== undefined) return { price: byModel, source: "model" }
  const family = model.family?.toLowerCase()
  const byFamily = family === undefined ? undefined : reference.byFamily.get(family)
  if (byFamily !== undefined) return { price: byFamily, source: "family" }
  return { price: undefined, source: "none" }
}

function capabilityOf(price: ReferencePrice | undefined): number {
  if (price === undefined) return UNPRICED_CAPABILITY
  const scaled = Math.log(price.output / FLOOR_OUTPUT_PRICE) / Math.log(CEILING_OUTPUT_PRICE / FLOOR_OUTPUT_PRICE)
  return Math.min(1, Math.max(0, scaled))
}

function tierOf(capability: number, reasoning: boolean, source: PriceSource): CapabilityTier {
  const exactPrice = source === "host" || source === "model"
  if (capability >= ADVANCED_CAPABILITY && reasoning && exactPrice) return "advanced"
  if (capability >= BALANCED_CAPABILITY && source !== "none") return "balanced"
  return "economy"
}

function demoteIfStale(tier: CapabilityTier, releasedAt: number | undefined, now: number): CapabilityTier {
  if (releasedAt === undefined || now - releasedAt < STALE_MODEL_AGE_MS) return tier
  if (tier === "advanced") return "balanced"
  return "economy"
}

function effortCostFor(variantIDs: readonly string[]): Readonly<Record<string, number>> {
  const ladder: Record<string, number> = {}
  for (const variantID of variantIDs) {
    const multiplier = EFFORT_LADDER[variantID.toLowerCase()]
    if (multiplier !== undefined) ladder[variantID] = multiplier
  }
  return ladder
}

function toCost(price: ReferencePrice | undefined): ModelCostPerMTok {
  if (price === undefined) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  return { input: price.input, output: price.output, cacheRead: price.cacheRead, cacheWrite: 0 }
}

function confidenceOf(source: PriceSource): MetadataConfidence {
  if (source === "host" || source === "model") return "medium"
  return "low"
}

function describeSource(resolved: ResolvedPrice): string {
  const origin: Record<PriceSource, string> = {
    host: "the host catalog price",
    model: "the models.dev median list price of this model ID",
    family: "the models.dev median list price of its family",
    none: "no published price",
  }
  const price = resolved.price === undefined ? "" : ` ($${resolved.price.output}/MTok output)`
  return `Derived from ${origin[resolved.source]}${price}; capability follows list price on a log scale and speed starts from name hints.`
}
