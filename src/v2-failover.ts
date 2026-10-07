import type { ProviderHealth } from "./routing/health.ts"
import type { Trace } from "./trace.ts"
import type { ModelRef } from "./types.ts"
import type { RouteOutcome } from "./v2-route.ts"

/** The parts of the host's `session.hook("retry")` event the failover uses. */
export interface RetryEvent {
  readonly sessionID: string
  readonly model: { readonly providerID: string; readonly id: string }
  readonly error: { readonly type: string; readonly message: string; readonly status?: number }
  readonly attempt: number
  decision: { retry: false } | { retry: true; delay: number }
}

/** What the failover needs from the adapter. */
export interface FailoverDeps {
  readonly health: ProviderHealth
  /** True when the router chose the model that failed in this session. */
  readonly isRoutedModel: (sessionID: string, model: ModelRef) => boolean
  /** Route the session's last task again; cooling providers are already excluded. */
  readonly reroute: (sessionID: string) => Promise<RouteOutcome | undefined>
  /** Switch the session to the new target; resolves false when the switch failed. */
  readonly switchTo: (sessionID: string, outcome: Extract<RouteOutcome, { kind: "routed" }>, note: string) => Promise<boolean>
  readonly trace: Trace
}

/** Errors that come from the user or the host, not from the provider. */
const NON_PROVIDER_ERRORS = new Set(["aborted"])

/**
 * Build the `retry` hook. When a model the router chose fails, its provider
 * cools down, the task is routed again without it, and the host is told to
 * retry at once. The host reloads the session model before retrying, so the
 * retry runs on the new model without duplicating the user's message.
 *
 * Failures on a model the user picked by hand, or with nowhere else to go,
 * leave the host's own retry decision untouched.
 *
 * @param deps Health tracker, session lookups and the switch primitive.
 * @returns The hook callback.
 */
export function createFailoverHook(deps: FailoverDeps): (event: RetryEvent) => Promise<void> {
  return async (event) => {
    const failed: ModelRef = { providerID: event.model.providerID, id: event.model.id }
    if (NON_PROVIDER_ERRORS.has(event.error.type)) return
    if (!deps.isRoutedModel(event.sessionID, failed)) return
    deps.health.markFailed(failed.providerID)
    const outcome = await deps.reroute(event.sessionID)
    const details = {
      sessionID: event.sessionID,
      failed: `${failed.providerID}/${failed.id}`,
      error: `${event.error.type}${event.error.status === undefined ? "" : ` ${event.error.status}`}: ${event.error.message}`,
      attempt: event.attempt,
    }
    if (outcome === undefined || outcome.kind !== "routed") {
      deps.trace("v2 failover found no alternative", { ...details, ...(outcome?.details ?? {}) })
      return
    }
    const note = `${details.failed} failed (${details.error}); retrying on ${outcome.target.providerID}/${outcome.target.id}.`
    if (!(await deps.switchTo(event.sessionID, outcome, note))) return
    event.decision = { retry: true, delay: 0 }
    deps.trace("v2 failover switched model", {
      ...details,
      model: `${outcome.target.providerID}/${outcome.target.id}`,
      coolingDown: deps.health.coolingDown(),
    })
  }
}
