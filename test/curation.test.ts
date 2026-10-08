import test from "node:test"
import assert from "node:assert/strict"

import type { RoutableModel } from "../src/routing/contracts.ts"
import { canonicalModelID } from "../src/routing/model-id.ts"
import { DEFAULT_MODEL_PROFILE, MODEL_PROFILES, profileFor } from "../src/routing/profiles.ts"
import { SUPERSEDED_BY, dropSuperseded } from "../src/routing/supersede.ts"

function candidate(providerID: string, modelID: string): RoutableModel {
  return {
    key: `${providerID}/${modelID}`,
    ref: `${providerID}/${modelID}`,
    catalog: {
      providerID,
      modelID,
      name: modelID,
      context: 200_000,
      output: 32_000,
      inputModalities: ["text"],
      tools: true,
      variantIDs: [],
      variantSettings: {},
      costPerMTok: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    route: {
      id: providerID,
      label: providerID,
      poolID: providerID,
      providerIDs: [providerID],
      usageEntryIDs: [],
      connection: { requireOAuth: false },
    },
    profile: DEFAULT_MODEL_PROFILE,
  }
}

test("host spellings of one model reduce to the same canonical ID", () => {
  assert.equal(canonicalModelID("claude-opus-5-5@default"), "claude-opus-5-5")
  assert.equal(canonicalModelID("xai/grok-4.6"), "grok-4.6")
  assert.equal(canonicalModelID("zai-org/glm-5.2-maas"), "glm-5.2")
  assert.equal(canonicalModelID("mimo-v2.6-flash-free"), "mimo-v2.6-flash")
  assert.equal(canonicalModelID("K3"), "kimi-k3")
})

test("every provider serving a curated model gets the same profile", () => {
  // When
  const zcode = profileFor("glm-5.3")
  const vertex = profileFor("zai-org/glm-5.3-maas")

  // Then
  assert.ok(zcode)
  assert.equal(vertex, zcode)
})

test("no curated row describes a model that another release supersedes", () => {
  const superseded = Object.keys(MODEL_PROFILES).filter((modelID) => modelID in SUPERSEDED_BY)

  assert.deepEqual(superseded, [])
})

test("every successor named in the supersede table is curated", () => {
  const terminal = Object.values(SUPERSEDED_BY).filter((successor) => !(successor in SUPERSEDED_BY))
  const uncurated = terminal.filter((successor) => MODEL_PROFILES[successor] === undefined)

  assert.deepEqual(uncurated, [])
})

test("an older release is dropped when a newer one is available from any provider", () => {
  // Given
  const models = [candidate("vertex", "zai-org/glm-5.2-maas"), candidate("zcode", "glm-5.3")]

  // When
  const kept = dropSuperseded(models)

  // Then
  assert.deepEqual(kept.map((model) => model.ref), ["zcode/glm-5.3"])
})

test("an older release is dropped when only a later release down the line is available", () => {
  // When
  const kept = dropSuperseded([candidate("vertex", "claude-opus-4-6@default"), candidate("anthropic", "claude-opus-5-5")])

  // Then
  assert.deepEqual(kept.map((model) => model.ref), ["anthropic/claude-opus-5-5"])
})

test("an older release stays routable when no newer one is available", () => {
  // When
  const kept = dropSuperseded([candidate("vertex", "glm-5.2-maas")])

  // Then
  assert.equal(kept.length, 1)
})
