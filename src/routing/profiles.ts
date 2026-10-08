import type { ModelProfile } from "./contracts.ts"
import { CURATED_MODELS, type CuratedRow } from "./curated-models.ts"
import { canonicalModelID } from "./model-id.ts"

/**
 * Curated profiles, keyed by model rather than by the provider serving it.
 *
 * A row answers two questions the host catalog cannot: how good the model is
 * (its quality tier, from public benchmarks) and how much one more turn burns
 * (the vendor's list price, used as a burn proxy when a subscription publishes
 * no price). Plan terms such as allowances and quota windows belong to the
 * provider and come from the live quota ledger, never from this table.
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

/** Vendors in scope publish no cache-write rate, so it is pinned to zero. */
const UNPUBLISHED_CACHE_WRITE_RATE = 0

function toPricedProfile(row: CuratedRow): PricedModelProfile {
  return {
    tier: row.tier,
    coding: row.capability.coding,
    reasoning: row.capability.reasoning,
    research: row.capability.research,
    toolUse: row.capability.toolUse,
    speed: row.capability.speed,
    effortCost: row.effortCost,
    includedUsageUsd: null,
    windowShares: {},
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

function buildProfiles(
  rows: Readonly<Record<string, CuratedRow>>,
): Readonly<Record<string, PricedModelProfile>> {
  const profiles: Record<string, PricedModelProfile> = {}
  for (const [modelID, row] of Object.entries(rows)) {
    profiles[modelID] = toPricedProfile(row)
  }
  return profiles
}

/** Curated profiles keyed by canonical model ID (see `model-id.ts`). */
export const MODEL_PROFILES: Readonly<Record<string, PricedModelProfile>> =
  buildProfiles(CURATED_MODELS)

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
 * Look up the curated profile of one model, whichever provider serves it.
 *
 * @param modelID Model ID as the host reports it; version pins, vendor
 *   prefixes and serving suffixes are ignored.
 * @returns The curated profile, or `undefined` when the model is unknown. Callers
 *   decide whether to fall back to {@link DEFAULT_MODEL_PROFILE}; an absent
 *   profile must never be read as a strong one.
 */
export function profileFor(modelID: string): ModelProfile | undefined {
  return MODEL_PROFILES[canonicalModelID(modelID)]
}
