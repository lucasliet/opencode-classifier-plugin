import test from "node:test"
import assert from "node:assert/strict"

import type { ActiveSubscription } from "../src/routing/contracts.ts"
import { compileExclusions } from "../src/routing/exclude.ts"
import { associateProviders } from "../src/routing/subscriptions.ts"

const ZAI: ActiveSubscription = { id: "zai", label: "Z.AI (Pro)", requireOAuth: false }
const KIMI: ActiveSubscription = { id: "kimi", label: "Kimi", requireOAuth: false }
const ANTHROPIC: ActiveSubscription = { id: "anthropic", label: "Claude (Team)", requireOAuth: true }
const OPENCODE_GO: ActiveSubscription = { id: "opencode-go", label: "OpenCode Go", requireOAuth: false }
const COPILOT: ActiveSubscription = { id: "copilot", label: "GitHub Copilot", requireOAuth: true }

function routeMap(result: ReturnType<typeof associateProviders>): Record<string, readonly string[]> {
  return Object.fromEntries(result.routes.map((route) => [route.id, route.providerIDs]))
}

test("a provider whose name contains the vendor id joins that subscription", () => {
  // Given
  const providers = ["zai-coding-plan", "kimi-code-plan-global", "github-copilot"]

  // When
  const result = associateProviders(providers, [ZAI, KIMI, COPILOT], { overrides: {}, aliases: {} })

  // Then
  assert.deepEqual(routeMap(result), {
    zai: ["zai-coding-plan"],
    kimi: ["kimi-code-plan-global"],
    copilot: ["github-copilot"],
  })
  assert.equal(result.routes.find((route) => route.id === "copilot")?.connection.requireOAuth, true)
})

test("a custom provider without its vendor's name needs an override", () => {
  // Given
  const superGrok: ActiveSubscription = { id: "supergrok", label: "SuperGrok", requireOAuth: false }
  const providers = ["my-glm", "zai-coding-plan", "my-grok"]

  // When
  const unmapped = associateProviders(providers, [ZAI, superGrok], { overrides: {}, aliases: {} })
  const mapped = associateProviders(providers, [ZAI, superGrok], {
    overrides: { "my-glm": "zai", "my-grok": "supergrok" },
    aliases: {},
  })

  // Then
  assert.deepEqual(routeMap(unmapped), { zai: ["zai-coding-plan"] })
  assert.deepEqual(routeMap(mapped), { zai: ["my-glm", "zai-coding-plan"], supergrok: ["my-grok"] })
})

test("a provider alias is matched as the provider it stands for", () => {
  // Given
  const superGrok: ActiveSubscription = { id: "supergrok", label: "SuperGrok", requireOAuth: false }

  // When
  const byName = associateProviders(["my-glm", "my-grok"], [ZAI, superGrok], {
    overrides: {},
    aliases: { "my-glm": "zai-coding-plan", "my-grok": "supergrok" },
  })
  const byAliasOverride = associateProviders(["my-proxy"], [ANTHROPIC], {
    overrides: { "corp-gateway": "anthropic" },
    aliases: { "my-proxy": "corp-gateway" },
  })

  // Then
  assert.deepEqual(routeMap(byName), { zai: ["my-glm"], supergrok: ["my-grok"] })
  assert.deepEqual(routeMap(byAliasOverride), { anthropic: ["my-proxy"] })
})

test("the longest matching vendor id wins and a metered sibling never matches", () => {
  // When
  const result = associateProviders(["opencode-go", "opencode"], [OPENCODE_GO], { overrides: {}, aliases: {} })

  // Then
  assert.deepEqual(routeMap(result), { "opencode-go": ["opencode-go"] })
  assert.deepEqual(result.unmatched, ["opencode: no active ai-usagebar subscription matches its name"])
})

test("a provider whose name matches no vendor is never routed", () => {
  // When
  const result = associateProviders(["corp-proxy", "zhipuai"], [ZAI, ANTHROPIC], { overrides: {}, aliases: {} })

  // Then
  assert.deepEqual(result.routes, [])
  assert.equal(result.unmatched.length, 2)
})

test("an override wins, and an override to an inactive vendor explains itself", () => {
  // When
  const result = associateProviders(["my-proxy", "old-plan"], [ANTHROPIC], {
    overrides: { "my-proxy": "anthropic", "old-plan": "opencode-go" },
    aliases: {},
  })

  // Then
  assert.deepEqual(routeMap(result), { anthropic: ["my-proxy"] })
  assert.deepEqual(result.unmatched, [
    'old-plan: mapped to "opencode-go", which ai-usagebar does not report as an active subscription',
  ])
})

test("a cancelled subscription leaves its providers unmatched", () => {
  // When
  const result = associateProviders(["opencode-go"], [ZAI], { overrides: {}, aliases: {} })

  // Then
  assert.deepEqual(result.routes, [])
  assert.deepEqual(result.unmatched, ["opencode-go: no active ai-usagebar subscription matches its name"])
})

test("exclusions match whole providers, provider/model refs and wildcards, ignoring case", () => {
  // Given
  const isExcluded = compileExclusions(["corp-proxy", "my-glm/*-FLASH", "*-enterprise"])

  // When / Then
  assert.equal(isExcluded("corp-proxy", "claude-opus-5-5"), true)
  assert.equal(isExcluded("my-glm", "glm-5.3-flash"), true)
  assert.equal(isExcluded("my-glm", "glm-5.3"), false)
  assert.equal(isExcluded("github-copilot-enterprise", "gpt-5.4"), true)
  assert.equal(isExcluded("corp-proxy-2", "x"), false)
  assert.equal(compileExclusions([])("anything", "x"), false)
})

test("exclusion patterns treat regex characters literally", () => {
  // Given
  const isExcluded = compileExclusions(["a.b", "x/(y)"])

  // When / Then
  assert.equal(isExcluded("a.b", "m"), true)
  assert.equal(isExcluded("axb", "m"), false)
  assert.equal(isExcluded("x", "(y)"), true)
})
