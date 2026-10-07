/**
 * Association: which host provider spends which `ai-usagebar` subscription.
 *
 * Nothing here names a plan. The active subscriptions come from the quota
 * ledger and the providers from the host catalog; this module only joins them,
 * in this order of precedence:
 *
 * 1. An explicit `providerPools` override from the user's config, for the
 *    provider or for the provider it is an alias of.
 * 2. The provider ID, or its configured alias, contains every token of the
 *    vendor ID (`zai-coding-plan` → `zai`, `github-copilot` → `copilot`).
 *
 * A provider that matches nothing is not a subscription and is never routed;
 * a custom provider whose ID does not carry its vendor's name needs an alias
 * or an override.
 */

import type {
  ActiveSubscription,
  SubscriptionID,
  SubscriptionRoute,
} from "./contracts.ts"

/** User-supplied associations that win over every heuristic. */
export interface AssociationOptions {
  /** Provider ID → `ai-usagebar` vendor ID. */
  readonly overrides: Readonly<Record<string, SubscriptionID>>
  /** Provider ID → the provider ID it stands for. */
  readonly aliases: Readonly<Record<string, string>>
}

/** Routes for the associated providers, plus why the others were left out. */
export interface AssociationResult {
  readonly routes: readonly SubscriptionRoute[]
  readonly unmatched: readonly string[]
}

/**
 * Join host providers to the active subscriptions.
 *
 * @param providerIDs Providers from the host catalog.
 * @param subscriptions Subscriptions the quota ledger currently verifies.
 * @param options User overrides.
 * @returns One route per subscription that at least one provider spends, and
 *   a reason for every provider left out.
 */
export function associateProviders(
  providerIDs: readonly string[],
  subscriptions: readonly ActiveSubscription[],
  options: AssociationOptions,
): AssociationResult {
  const byVendor = new Map<SubscriptionID, string[]>()
  const unmatched: string[] = []
  for (const providerID of providerIDs) {
    const match = matchProvider(providerID, subscriptions, options)
    if (typeof match === "string") {
      unmatched.push(match)
      continue
    }
    const matched = byVendor.get(match.id) ?? []
    matched.push(providerID)
    byVendor.set(match.id, matched)
  }
  const routes = subscriptions
    .filter((subscription) => byVendor.has(subscription.id))
    .map((subscription) => toRoute(subscription, byVendor.get(subscription.id) ?? []))
  return { routes, unmatched }
}

/** @returns The matched subscription, or why the provider has none. */
function matchProvider(
  providerID: string,
  subscriptions: readonly ActiveSubscription[],
  options: AssociationOptions,
): ActiveSubscription | string {
  const alias = options.aliases[providerID] ?? providerID
  const override = options.overrides[providerID] ?? options.overrides[alias]
  if (override !== undefined) {
    return (
      subscriptions.find((subscription) => subscription.id === override) ??
      `${providerID}: mapped to "${override}", which ai-usagebar does not report as an active subscription`
    )
  }
  return (
    matchByName(alias, subscriptions) ??
    `${providerID}: no active ai-usagebar subscription matches its name`
  )
}

/** The longest vendor ID wins, so `opencode-go` beats a bare `opencode`. */
function matchByName(
  providerID: string,
  subscriptions: readonly ActiveSubscription[],
): ActiveSubscription | undefined {
  const providerTokens = new Set(tokensOf(providerID))
  return subscriptions
    .filter((subscription) => tokensOf(subscription.id).every((token) => providerTokens.has(token)))
    .sort((left, right) => right.id.length - left.id.length)[0]
}

function toRoute(
  subscription: ActiveSubscription,
  providerIDs: readonly string[],
): SubscriptionRoute {
  return {
    id: subscription.id,
    label: subscription.label,
    poolID: subscription.id,
    providerIDs,
    usageEntryIDs: [subscription.id],
    connection: { requireOAuth: subscription.requireOAuth },
  }
}

function tokensOf(id: string): string[] {
  return id
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
}
