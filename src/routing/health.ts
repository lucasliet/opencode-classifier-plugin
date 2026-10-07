/**
 * Provider health: a provider whose request failed sits out the routing for a
 * cooldown, so a failover never lands on it again while it is still broken.
 */

/** How long a failed provider is skipped. */
export const FAILED_PROVIDER_COOLDOWN_MS = 10 * 60 * 1000

/** Failure bookkeeping shared by the failover and the candidate filter. */
export interface ProviderHealth {
  markFailed(providerID: string): void
  isCoolingDown(providerID: string): boolean
  /** Providers currently cooling down, for traces and directives. */
  coolingDown(): string[]
}

/**
 * Create the health tracker.
 *
 * @param now Clock source, injected so the cooldown is testable.
 * @param cooldownMs How long a failed provider is skipped.
 * @returns A tracker whose entries expire on their own.
 */
export function createProviderHealth(
  now: () => number = Date.now,
  cooldownMs = FAILED_PROVIDER_COOLDOWN_MS,
): ProviderHealth {
  const failedUntil = new Map<string, number>()
  const isCoolingDown = (providerID: string): boolean => {
    const until = failedUntil.get(providerID)
    if (until === undefined) return false
    if (until > now()) return true
    failedUntil.delete(providerID)
    return false
  }
  return {
    markFailed(providerID) {
      failedUntil.set(providerID, now() + cooldownMs)
    },
    isCoolingDown,
    coolingDown() {
      return [...failedUntil.keys()].filter(isCoolingDown)
    },
  }
}
