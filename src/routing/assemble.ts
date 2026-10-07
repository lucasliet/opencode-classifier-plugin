/**
 * Candidate assembly shared by the V1 and V2 adapters: host catalog plus the
 * live subscription list in, routable candidates out. The adapters only add
 * their own connection proof between the two steps.
 */

import { buildRoutableModels, providerIDsOf } from "./catalog.ts"
import type {
  ActiveSubscription,
  CatalogModel,
  ModelProfile,
  RoutableModel,
  SubscriptionRoute,
} from "./contracts.ts"
import type { ExclusionMatcher } from "./exclude.ts"
import { associateProviders } from "./subscriptions.ts"
import type { AssociationResult } from "./subscriptions.ts"

/** Everything candidate assembly reads besides the catalog. */
export interface CandidateSources {
  readonly subscriptions: readonly ActiveSubscription[]
  /** Provider ID → vendor ID overrides from the config. */
  readonly overrides: Readonly<Record<string, string>>
  readonly isExcluded: ExclusionMatcher
  readonly profileOf: (model: CatalogModel) => ModelProfile
}

/**
 * Associate the catalog's providers with the active subscriptions.
 *
 * @param catalog Host models, the virtual router already removed.
 * @param sources Subscriptions, overrides and blacklist.
 * @returns Routes per subscription and why other providers were left out.
 */
export function planRoutes(
  catalog: readonly CatalogModel[],
  sources: CandidateSources,
): AssociationResult {
  return associateProviders(
    providerIDsOf(catalog, sources.isExcluded),
    sources.subscriptions,
    { overrides: sources.overrides },
  )
}

/**
 * Turn proven routes into scored candidates.
 *
 * @param catalog Host models.
 * @param routes Routes that passed the adapter's connection proof.
 * @param sources Blacklist and profile source.
 * @returns Routable candidates.
 */
export function candidatesFor(
  catalog: readonly CatalogModel[],
  routes: readonly SubscriptionRoute[],
  sources: CandidateSources,
): RoutableModel[] {
  return buildRoutableModels(catalog, {
    routes,
    profileOf: sources.profileOf,
    isExcluded: sources.isExcluded,
  })
}
