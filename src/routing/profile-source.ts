/**
 * Profile resolution: curated rows win, every other model gets a derived
 * profile, and measured speed replaces the static speed estimate of both.
 * Curation is keyed by model alone, so every provider serving a model gets the
 * same row; measured speed stays keyed by the real provider.
 */

import type { CatalogModel, ModelProfile } from "./contracts.ts"
import { deriveProfile } from "./derive.ts"
import { profileFor } from "./profiles.ts"
import type { ReferenceIndex } from "./reference.ts"
import type { SpeedTracker } from "./speed.ts"

/** Everything a profile can be resolved from. */
export interface ProfileSources {
  readonly reference: ReferenceIndex
  readonly speed: SpeedTracker
  /** Clock source for the staleness rule of derived profiles. */
  readonly now: () => number
}

/**
 * Build the resolver the catalog uses for each candidate.
 *
 * @param sources Reference index, speed tracker and clock.
 * @returns A function from a catalog model to its profile.
 */
export function profileResolver(sources: ProfileSources): (model: CatalogModel) => ModelProfile {
  return (model) => {
    const ref = `${model.providerID}/${model.modelID}`
    const base = profileFor(model.modelID) ?? deriveProfile(model, sources.reference, sources.now())
    return { ...base, speed: sources.speed.score(ref, base.speed) }
  }
}
