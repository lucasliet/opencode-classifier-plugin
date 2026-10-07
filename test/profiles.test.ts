import test from "node:test"
import assert from "node:assert/strict"

import type { CatalogModel } from "../src/routing/contracts.ts"
import { deriveProfile, speedPriorFor } from "../src/routing/derive.ts"
import { profileResolver } from "../src/routing/profile-source.ts"
import { EMPTY_REFERENCE_INDEX, buildReferenceIndex } from "../src/routing/reference.ts"
import { createSpeedTracker } from "../src/routing/speed.ts"
import { createStepSpeedObserver } from "../src/v2-speed.ts"

const NOW = Date.parse("2026-10-07T00:00:00Z")

function catalogModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    providerID: "my-glm",
    modelID: "glm-5.3",
    name: "GLM 5.3",
    context: 200_000,
    output: 32_000,
    inputModalities: ["text"],
    tools: true,
    variantIDs: ["low", "high", "max"],
    variantSettings: {},
    costPerMTok: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  }
}

/** A models.dev payload with the same model sold by several providers. */
function modelsDev(): unknown {
  return {
    "zai-coding-plan": {
      models: { "glm-5.3": { family: "glm", reasoning: true, release_date: "2026-08-14", cost: { input: 0, output: 0 } } },
    },
    zhipuai: {
      models: {
        "glm-5.3": { family: "glm", reasoning: true, release_date: "2026-08-14", cost: { input: 1.4, output: 4.4, cache_read: 0.26 } },
        "glm-4": { family: "glm", reasoning: false, release_date: "2024-01-10", cost: { input: 0.1, output: 0.4 } },
      },
    },
    openrouter: {
      models: { "glm-5.3": { family: "glm", reasoning: true, cost: { input: 2, output: 8 } } },
    },
    anthropic: {
      models: { "claude-opus-5-5": { family: "claude-opus", reasoning: true, release_date: "2026-09-01", cost: { input: 5, output: 25 } } },
    },
  }
}

test("the reference index takes the median published price and ignores unpriced plans", () => {
  // Given / When
  const index = buildReferenceIndex(modelsDev())

  // Then
  const glm = index.byModel.get("glm-5.3")
  assert.deepEqual(glm?.price, { input: 2, output: 8, cacheRead: 2 })
  assert.equal(glm?.reasoning, true)
  assert.equal(glm?.releasedAt, Date.parse("2026-08-14"))
  assert.ok(index.byFamily.has("glm"))
  assert.equal(buildReferenceIndex("junk").byModel.size, 0)
})

test("an expensive reasoning model priced by its own id is derived as advanced", () => {
  // Given
  const reference = buildReferenceIndex(modelsDev())

  // When
  const profile = deriveProfile(catalogModel({ modelID: "claude-opus-5-5" }), reference, NOW)

  // Then
  assert.equal(profile.tier, "advanced")
  assert.equal(profile.confidence, "medium")
  assert.deepEqual(profile.costPerMTok, { input: 5, output: 25, cacheRead: 5, cacheWrite: 0 })
  assert.deepEqual(profile.effortCost, { low: 1, high: 2.5, max: 6 })
  assert.match(profile.source, /models\.dev median list price of this model ID/)
})

test("a speed serving tier inherits its base model's price", () => {
  // When
  const profile = deriveProfile(catalogModel({ modelID: "glm-5.3-highspeed" }), buildReferenceIndex(modelsDev()), NOW)

  // Then
  assert.equal(profile.costPerMTok.output, 8)
  assert.equal(profile.confidence, "medium")
})

test("a family-level price never promotes a model past balanced", () => {
  // Given
  const reference = buildReferenceIndex(modelsDev())

  // When
  const profile = deriveProfile(catalogModel({ modelID: "glm-9-unknown", family: "glm" }), reference, NOW)

  // Then
  assert.equal(profile.confidence, "low")
  assert.notEqual(profile.tier, "advanced")
})

test("a model with no price anywhere stays economy", () => {
  // When
  const profile = deriveProfile(catalogModel({ modelID: "mystery" }), EMPTY_REFERENCE_INDEX, NOW)

  // Then
  assert.equal(profile.tier, "economy")
  assert.equal(profile.confidence, "low")
  assert.deepEqual(profile.costPerMTok, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
})

test("an old model drops one tier", () => {
  // Given
  const reference = buildReferenceIndex(modelsDev())
  const fresh = deriveProfile(catalogModel({ modelID: "claude-opus-5-5" }), reference, NOW)

  // When
  const stale = deriveProfile(
    catalogModel({ modelID: "claude-opus-5-5", releasedAt: Date.parse("2024-01-01") }),
    reference,
    NOW,
  )

  // Then
  assert.equal(fresh.tier, "advanced")
  assert.equal(stale.tier, "balanced")
})

test("a host price wins over the reference index", () => {
  // Given
  const model = catalogModel({ costPerMTok: { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 } })

  // When
  const profile = deriveProfile(model, buildReferenceIndex(modelsDev()), NOW)

  // Then
  assert.equal(profile.costPerMTok.output, 1.25)
  assert.match(profile.source, /host catalog price/)
})

test("speed priors follow fast and slow name hints", () => {
  assert.equal(speedPriorFor("glm-5.3-flash"), 0.75)
  assert.equal(speedPriorFor("claude-opus-5-5"), 0.4)
  assert.equal(speedPriorFor("glm-5.3"), 0.55)
})

test("measured speed replaces the prior gradually and ignores tiny steps", () => {
  // Given
  const speed = createSpeedTracker()

  // When
  const tiny = speed.record("my-glm/glm-5.3", 10, 1_000)
  for (let index = 0; index < 5; index += 1) speed.record("my-glm/glm-5.3", 2_000, 10_000)

  // Then
  assert.equal(tiny, false)
  assert.equal(speed.score("unseen/model", 0.42), 0.42)
  const measured = speed.score("my-glm/glm-5.3", 0.55)
  assert.ok(Math.abs(measured - Math.log(20) / Math.log(20)) < 1e-9)
})

test("speed state round-trips and drops invalid rows", () => {
  // Given
  const speed = createSpeedTracker()
  speed.record("kimi/k3", 1_000, 10_000)

  // When
  const restored = createSpeedTracker({ ...speed.state(), "bad/row": { tokensPerSecond: -1, samples: 3 } })

  // Then
  assert.deepEqual(restored.state(), { "kimi/k3": { tokensPerSecond: 100, samples: 1 } })
})

test("the resolver keeps curated rows and overlays measured speed", () => {
  // Given
  const speed = createSpeedTracker({ "zai-coding-plan/glm-5.3": { tokensPerSecond: 200, samples: 10 } })
  const resolve = profileResolver({ reference: EMPTY_REFERENCE_INDEX, speed, aliases: {}, now: () => NOW })

  // When
  const curated = resolve(catalogModel({ providerID: "zai-coding-plan", modelID: "glm-5.3" }))
  const derived = resolve(catalogModel({ providerID: "zai-coding-plan", modelID: "never-curated" }))

  // Then
  assert.equal(curated.speed, 1)
  assert.equal(curated.tier, "advanced")
  assert.match(derived.source, /^Derived from/)
})

test("an aliased provider gets the profile of the provider it stands for", () => {
  // Given
  const speed = createSpeedTracker({ "my-glm/glm-5.3": { tokensPerSecond: 200, samples: 10 } })
  const aliased = profileResolver({
    reference: EMPTY_REFERENCE_INDEX,
    speed,
    aliases: { "my-glm": "zai-coding-plan" },
    now: () => NOW,
  })
  const unaliased = profileResolver({ reference: EMPTY_REFERENCE_INDEX, speed, aliases: {}, now: () => NOW })

  // When
  const curated = aliased(catalogModel({ providerID: "my-glm", modelID: "glm-5.3" }))
  const derived = unaliased(catalogModel({ providerID: "my-glm", modelID: "glm-5.3" }))

  // Then
  assert.equal(curated.tier, "advanced")
  assert.match(curated.source, /Z\.AI Coding Plan/)
  assert.equal(curated.speed, 1)
  assert.match(derived.source, /^Derived from/)
})

test("the step observer records throughput from started/ended pairs", () => {
  // Given
  const speed = createSpeedTracker()
  let saved = 0
  const observe = createStepSpeedObserver(speed, () => {
    saved += 1
  })

  // When
  observe({
    type: "session.step.started",
    created: 1_000,
    data: { assistantMessageID: "m1", model: { providerID: "my-glm", id: "glm-5.3" } },
  })
  observe({
    type: "session.step.ended",
    created: 11_000,
    data: { assistantMessageID: "m1", finish: "stop", tokens: { output: 800, reasoning: 200 } },
  })
  observe({ type: "session.step.ended", created: 12_000, data: { assistantMessageID: "unknown" } })

  // Then
  assert.equal(saved, 1)
  assert.deepEqual(speed.state(), { "my-glm/glm-5.3": { tokensPerSecond: 100, samples: 1 } })
})

test("the step observer skips failed steps", () => {
  // Given
  const speed = createSpeedTracker()
  const observe = createStepSpeedObserver(speed, () => undefined)

  // When
  observe({
    type: "session.step.started",
    created: 1_000,
    data: { assistantMessageID: "m1", model: { providerID: "my-glm", id: "glm-5.3" } },
  })
  observe({
    type: "session.step.ended",
    created: 5_000,
    data: { assistantMessageID: "m1", finish: "error", tokens: { output: 900, reasoning: 0 } },
  })

  // Then
  assert.deepEqual(speed.state(), {})
})
