import test from "node:test"
import assert from "node:assert/strict"

import { createProviderHealth } from "../src/routing/health.ts"
import type { RoutingDecision } from "../src/routing/contracts.ts"
import { createFailoverHook } from "../src/v2-failover.ts"
import type { FailoverDeps, RetryEvent } from "../src/v2-failover.ts"
import type { RouteOutcome } from "../src/v2-route.ts"

const EMPTY_DECISION: RoutingDecision = { reason: "test", considered: [] }

function retryEvent(overrides: Partial<RetryEvent> = {}): RetryEvent {
  return {
    sessionID: "ses_1",
    model: { providerID: "my-glm", id: "glm-5.3" },
    error: { type: "provider", message: "overloaded", status: 529 },
    attempt: 1,
    decision: { retry: false },
    ...overrides,
  }
}

function routedTo(providerID: string, id: string): RouteOutcome {
  return {
    kind: "routed",
    target: { providerID, id },
    decision: EMPTY_DECISION,
    directive: "routed",
    relaxedNote: undefined,
  }
}

function failoverDeps(overrides: Partial<FailoverDeps> = {}): FailoverDeps & { switched: string[] } {
  const switched: string[] = []
  return {
    health: createProviderHealth(),
    isRoutedModel: () => true,
    reroute: async () => routedTo("kimi-code-plan-global", "kimi-for-coding"),
    switchTo: async (_sessionID, outcome) => {
      switched.push(`${outcome.target.providerID}/${outcome.target.id}`)
      return true
    },
    trace: () => undefined,
    switched,
    ...overrides,
  }
}

test("a provider cools down after a failure and recovers after the cooldown", () => {
  // Given
  let now = 0
  const health = createProviderHealth(() => now, 1_000)

  // When
  health.markFailed("my-glm")

  // Then
  assert.equal(health.isCoolingDown("my-glm"), true)
  assert.deepEqual(health.coolingDown(), ["my-glm"])
  now = 1_000
  assert.equal(health.isCoolingDown("my-glm"), false)
  assert.deepEqual(health.coolingDown(), [])
})

test("a failed routed model cools down its provider, switches and retries at once", async () => {
  // Given
  const deps = failoverDeps()
  const event = retryEvent()

  // When
  await createFailoverHook(deps)(event)

  // Then
  assert.deepEqual(event.decision, { retry: true, delay: 0 })
  assert.deepEqual(deps.switched, ["kimi-code-plan-global/kimi-for-coding"])
  assert.equal(deps.health.isCoolingDown("my-glm"), true)
})

test("a failure on a model the user picked keeps the host decision", async () => {
  // Given
  const deps = failoverDeps({ isRoutedModel: () => false })
  const event = retryEvent({ decision: { retry: true, delay: 2_000 } })

  // When
  await createFailoverHook(deps)(event)

  // Then
  assert.deepEqual(event.decision, { retry: true, delay: 2_000 })
  assert.deepEqual(deps.switched, [])
  assert.equal(deps.health.isCoolingDown("my-glm"), false)
})

test("an aborted request is not a provider failure", async () => {
  // Given
  const deps = failoverDeps()
  const event = retryEvent({ error: { type: "aborted", message: "cancelled" } })

  // When
  await createFailoverHook(deps)(event)

  // Then
  assert.deepEqual(event.decision, { retry: false })
  assert.equal(deps.health.isCoolingDown("my-glm"), false)
})

test("with nowhere else to go the host decision stays and the provider still cools down", async () => {
  // Given
  const deps = failoverDeps({
    reroute: async () => ({ kind: "unroutable", directive: "none", details: {} }),
  })
  const event = retryEvent({ decision: { retry: true, delay: 500 } })

  // When
  await createFailoverHook(deps)(event)

  // Then
  assert.deepEqual(event.decision, { retry: true, delay: 500 })
  assert.equal(deps.health.isCoolingDown("my-glm"), true)
})

test("a refused model switch keeps the host decision", async () => {
  // Given
  const deps = failoverDeps({ switchTo: async () => false })
  const event = retryEvent()

  // When
  await createFailoverHook(deps)(event)

  // Then
  assert.deepEqual(event.decision, { retry: false })
})
