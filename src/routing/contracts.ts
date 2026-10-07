/**
 * Shared contracts for subscription-based model routing.
 *
 * Every module under `src/routing/` and `src/quota/` depends only on the
 * types declared here, so the pieces can be built and tested independently.
 */

/**
 * Subscription the router is allowed to spend, identified by the `ai-usagebar`
 * vendor id that reports its quota (for example `zai`, `kimi`, `cursor`).
 */
export type SubscriptionID = string

/**
 * Quota pool identifier. Several providers can draw from the same pool, so
 * availability must be tracked per pool instead of per provider.
 */
export type QuotaPoolID = string

/** Coarse quality band. Used as a floor, never as a precise ranking. */
export type CapabilityTier = "economy" | "balanced" | "advanced"

/** Confidence attached to a locally curated metadata profile. */
export type MetadataConfidence = "high" | "medium" | "low"

/** How a provider is proven to be a subscription rather than pay-as-you-go. */
export interface ConnectionRequirement {
  /**
   * When true, the provider's active connection must be an OAuth grant. Set
   * for vendors whose quota belongs to an OAuth login: an API key on the same
   * provider is metered, not that subscription.
   */
  readonly requireOAuth: boolean
}

/** One active subscription and the provider IDs associated with it. */
export interface SubscriptionRoute {
  readonly id: SubscriptionID
  readonly label: string
  readonly poolID: QuotaPoolID
  readonly providerIDs: readonly string[]
  /** `ai-usagebar` entry IDs that report this subscription's quota. */
  readonly usageEntryIDs: readonly string[]
  readonly connection: ConnectionRequirement
}

/** A subscription `ai-usagebar` currently reports with a usable quota window. */
export interface ActiveSubscription {
  readonly id: SubscriptionID
  readonly label: string
  /** True when the vendor authenticates by OAuth, or its method is unknown. */
  readonly requireOAuth: boolean
}

/** Technical capabilities as reported by the host. */
export interface CatalogModel {
  readonly providerID: string
  readonly modelID: string
  readonly name: string
  readonly context: number
  readonly output: number
  readonly inputModalities: readonly string[]
  readonly tools: boolean
  readonly variantIDs: readonly string[]
  readonly variantSettings: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly costPerMTok: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
  }
  /** Model family as the host reports it (for example `glm`), when known. */
  readonly family?: string
  /** Release time in epoch milliseconds, when the host reports one. */
  readonly releasedAt?: number
}

/** Locally curated quality and quota-burn metadata for one model. */
export interface ModelProfile {
  readonly tier: CapabilityTier
  /** Normalized 0..1 estimates used for tie-breaking, not absolute truth. */
  readonly coding: number
  readonly reasoning: number
  readonly research: number
  readonly toolUse: number
  readonly speed: number
  /** variant ID -> extra quota cost multiplier. Missing variants cost 1. */
  readonly effortCost: Readonly<Record<string, number>>
  /**
   * Locally curated per-token price in USD per million tokens, used when the
   * host catalog reports an empty `cost` array, which is the normal case for
   * subscription providers. Absent means "no curated price", never "free".
   */
  readonly costPerMTok?: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
  }
  /**
   * Included monthly usage in USD for this model on its plan, or null when the
   * vendor does not publish it. Required to translate an estimated cost into a
   * share of a quota window.
   */
  readonly includedUsageUsd: number | null
  /**
   * Window identifier -> share of `includedUsageUsd` granted to that window.
   * OpenCode Go publishes 5h = 20%, weekly = 50%, monthly = 100%. Empty when
   * unknown, in which case only percentage pressure is used.
   */
  readonly windowShares: Readonly<Record<string, number>>
  readonly source: string
  readonly confidence: MetadataConfidence
}

/** A host model joined with its subscription and its curated profile. */
export interface RoutableModel {
  readonly key: string
  readonly ref: string
  readonly catalog: CatalogModel
  readonly route: SubscriptionRoute
  readonly profile: ModelProfile
}

/** One quota window reported by a vendor. */
export interface QuotaWindow {
  readonly id: string
  readonly label: string
  /** Window length in seconds, or null when the vendor does not report it. */
  readonly windowSecs: number | null
  /** Consumed percentage, or null when unknown. Never coerced to zero. */
  readonly usedPercent: number | null
  readonly resetsAt: string | null
  /**
   * `inference` windows bound model usage. `other` windows (for example MCP
   * tool quotas) must not gate routing.
   */
  readonly dimension: "inference" | "other"
  /**
   * Which models of the pool this window meters, for vendors that keep one
   * quota per model category. Absent means every model. `pattern` is a regular
   * expression source tested against the model ID; `matches: false` makes the
   * window meter every model the pattern does NOT match.
   */
  readonly models?: { readonly pattern: string; readonly matches: boolean }
}

/** Normalized availability of a single quota pool. */
export interface QuotaPoolState {
  readonly poolID: QuotaPoolID
  readonly label: string
  readonly status: "available" | "exhausted" | "unknown" | "stale"
  readonly windows: readonly QuotaWindow[]
  readonly fetchedAt: string | null
  readonly error: string | null
}

/** Quota pressure for one pool, derived from its inference windows. */
export interface PoolPressure {
  readonly poolID: QuotaPoolID
  readonly known: boolean
  /** Highest consumed percentage across inference windows, or null. */
  readonly worstUsedPercent: number | null
  /** Remaining headroom as 0..1. Null when quota is unknown. */
  readonly headroomRatio: number | null
  readonly status: "available" | "exhausted" | "unknown" | "stale"
  readonly nextResetAt: string | null
}

/** Quota source for every subscription pool. */
export interface QuotaLedger {
  pools(): readonly QuotaPoolState[]
  /**
   * State of one pool. With `modelID`, only the windows that meter that model
   * are kept and the status is recomputed from them.
   */
  pool(poolID: QuotaPoolID, modelID?: string): QuotaPoolState | undefined
  /** Pressure of one pool, scoped to `modelID` when given. */
  pressure(poolID: QuotaPoolID, modelID?: string): PoolPressure
  /**
   * Subscriptions with a verified quota window. Empty until the first
   * successful reading; a later failed reading keeps the last known list.
   */
  subscriptions(): readonly ActiveSubscription[]
  /** Refresh in the background. Resolves immediately when data is fresh. */
  refresh(force?: boolean): Promise<void>
  dispose(): void
}

/** What the task needs, derived from Jev signals and the local context. */
export interface TaskRequirements {
  readonly tier: CapabilityTier
  readonly needsTools: boolean
  readonly needsVision: boolean
  readonly needsReasoning: boolean
  readonly estimatedInputTokens: number
  readonly estimatedOutputTokens: number
  readonly estimatedTurns: number
  /** Highest reasoning effort that may be used. */
  readonly maxEffort: "low" | "medium" | "high" | "max"
  readonly deepReasoning: number
  readonly highRisk: number
  readonly research: number
  readonly complexity: "fast" | "normal" | "deep"
  /**
   * True when the task is latency-sensitive: a quick mechanical job where the
   * user waits interactively for the answer. The selector then rewards faster
   * models among the eligible ones. Frontier work optimizes
   * correctness-per-quota instead, so this stays false there and speed never
   * overrides the quality floor or quota gates in either case.
   */
  readonly prefersSpeed: boolean
}

/** Why one candidate was kept or dropped. */
export interface CandidateReport {
  readonly ref: string
  readonly subscription: SubscriptionID
  readonly poolID: QuotaPoolID
  readonly eligible: boolean
  readonly reason: string
  readonly quotaStatus: PoolPressure["status"]
  readonly headroomRatio: number | null
  readonly estimatedCostUsd: number
  readonly estimatedPressure: number | null
  readonly qualityTier: CapabilityTier
  readonly score: number
}

/** Result of one routing decision, including the rejected alternatives. */
export interface RoutingDecision {
  readonly selected?: RoutableModel
  readonly variant?: string
  readonly reason: string
  readonly considered: readonly CandidateReport[]
}

/** Tiers ordered from cheapest to strongest. */
export const TIER_ORDER: readonly CapabilityTier[] = [
  "economy",
  "balanced",
  "advanced",
]

/** Reasoning efforts ordered from cheapest to strongest. */
export const EFFORT_ORDER: readonly TaskRequirements["maxEffort"][] = [
  "low",
  "medium",
  "high",
  "max",
]
