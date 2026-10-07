import test from "node:test"
import assert from "node:assert/strict"

import type {
  CatalogModel,
  ModelProfile,
  PoolPressure,
  QuotaLedger,
  QuotaPoolState,
  RoutableModel,
  SubscriptionRoute,
  TaskRequirements,
} from "../src/routing/contracts.ts"
import { buildRoutableModels, providerIDsOf, toCatalogModels } from "../src/routing/catalog.ts"
import type { RoutableBuildOptions } from "../src/routing/catalog.ts"
import { compileExclusions } from "../src/routing/exclude.ts"
import { paceHeadroomOf } from "../src/routing/pace.ts"
import {
  estimateCostUsd,
  estimateWindowPressure,
  effortMultiplierFor,
  MAX_ESTIMATED_COST_USD,
  UNPRICED_REASONING_BURN_SCALE,
} from "../src/routing/estimate.ts"
import { DEFAULT_MODEL_PROFILE, type ModelCostPerMTok } from "../src/routing/profiles.ts"
import {
  DEFAULT_SELECT_OPTIONS,
  explainDecision,
  requiredEffortFor,
  resolveEffortVariant,
  selectModel,
} from "../src/routing/select.ts"

/** Profile shape used by fixtures: the contract plus optional curated rates. */
type FixtureProfile = Partial<ModelProfile> & { readonly costPerMTok?: ModelCostPerMTok }

interface RoutableFixture {
  providerID?: string
  modelID?: string
  tier?: "economy" | "balanced" | "advanced"
  tools?: boolean
  modalities?: readonly string[]
  context?: number
  variants?: readonly string[]
  catalogCost?: CatalogModel["costPerMTok"]
  profile?: FixtureProfile
  route?: Partial<SubscriptionRoute>
}

interface PoolWindowFixture {
  id?: string
  label: string
  usedPercent: number | null
  windowSecs?: number
  resetsAt?: string
}

interface PoolFixture {
  poolID: string
  label?: string
  windows?: readonly PoolWindowFixture[]
  status?: PoolPressure["status"]
  error?: string | null
}

const NO_COST: CatalogModel["costPerMTok"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

function routeFixture(overrides: Partial<SubscriptionRoute> = {}): SubscriptionRoute {
  return {
    id: "openai-chatgpt",
    label: "ChatGPT / Codex (OpenAI OAuth)",
    poolID: "openai-chatgpt",
    providerIDs: ["openai"],
    usageEntryIDs: ["openai"],
    connection: { requireOAuth: true },
    ...overrides,
  }
}

function profileFixture(overrides: FixtureProfile = {}): ModelProfile {
  return {
    tier: "advanced",
    coding: 0.9,
    reasoning: 0.9,
    research: 0.85,
    toolUse: 0.9,
    speed: 0.7,
    effortCost: {},
    includedUsageUsd: null,
    windowShares: {},
    source: "test fixture",
    confidence: "high",
    ...overrides,
  }
}

function routable(fixture: RoutableFixture = {}): RoutableModel {
  const providerID = fixture.providerID ?? "openai"
  const modelID = fixture.modelID ?? "gpt-6-luna"
  const ref = `${providerID}/${modelID}`
  const route = routeFixture(fixture.route)
  const tierOverrides: FixtureProfile = fixture.tier === undefined ? {} : { tier: fixture.tier }
  return {
    key: ref,
    ref,
    catalog: {
      providerID,
      modelID,
      name: modelID,
      context: fixture.context ?? 200_000,
      output: 32_000,
      inputModalities: fixture.modalities ?? ["text"],
      tools: fixture.tools ?? true,
      variantIDs: fixture.variants ?? [],
      variantSettings: {},
      costPerMTok: fixture.catalogCost ?? NO_COST,
    },
    route,
    profile: profileFixture({ ...tierOverrides, ...fixture.profile }),
  }
}

function requirementsFixture(overrides: Partial<TaskRequirements> = {}): TaskRequirements {
  return {
    tier: "balanced",
    needsTools: true,
    needsVision: false,
    needsReasoning: false,
    estimatedInputTokens: 10_000,
    estimatedOutputTokens: 2_000,
    estimatedTurns: 4,
    maxEffort: "high",
    deepReasoning: 0.1,
    highRisk: 0.1,
    research: 0.1,
    complexity: "normal",
    prefersSpeed: false,
    ...overrides,
  }
}

function poolFixture(fixture: PoolFixture): QuotaPoolState {
  const windows = (fixture.windows ?? []).map((window) => ({
    id: window.id ?? window.label,
    label: window.label,
    windowSecs: window.windowSecs ?? null,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt ?? null,
    dimension: "inference" as const,
  }))
  const consumed = windows
    .filter((window) => window.usedPercent !== null)
    .map((window) => window.usedPercent as number)
  const worst = consumed.length === 0 ? null : Math.max(...consumed)
  const status =
    fixture.status ?? (worst === null ? "unknown" : worst >= 100 ? "exhausted" : "available")
  return {
    poolID: fixture.poolID,
    label: fixture.label ?? fixture.poolID,
    status,
    windows,
    fetchedAt: null,
    error: fixture.error ?? null,
  }
}

function pressureOf(state: QuotaPoolState | undefined, poolID: string): PoolPressure {
  const consumed = (state?.windows ?? [])
    .filter((window) => window.dimension === "inference" && window.usedPercent !== null)
    .map((window) => window.usedPercent as number)
  const worst = consumed.length === 0 ? null : Math.max(...consumed)
  return {
    poolID,
    known: worst !== null,
    worstUsedPercent: worst,
    headroomRatio: worst === null ? null : (100 - worst) / 100,
    status: state?.status ?? "unknown",
    nextResetAt: null,
  }
}

function ledgerOf(...fixtures: readonly PoolFixture[]): QuotaLedger {
  const states = fixtures.map(poolFixture)
  return {
    pools: () => states,
    pool: (poolID: string) => states.find((state) => state.poolID === poolID),
    pressure: (poolID: string) => pressureOf(states.find((state) => state.poolID === poolID), poolID),
    subscriptions: () => [],
    refresh: async () => {},
    dispose: () => {},
  }
}

function reportFor<T extends { readonly ref: string }>(
  decision: { readonly considered: readonly T[] },
  ref: string,
): T {
  const found = decision.considered.find((entry) => entry.ref === ref)
  assert.ok(found !== undefined, `expected ${ref} in considered`)
  return found
}

function catalogEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerID: "openai",
    modelID: "gpt-6-luna",
    name: "GPT-6 Luna",
    enabled: true,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    limit: { context: 400_000, output: 128_000 },
    variants: [{ id: "high", settings: { reasoningEffort: "high" } }],
    cost: [],
    ...overrides,
  }
}

test("toCatalogModels maps a bare array and the location/data envelope", () => {
  const bare = toCatalogModels([catalogEntry()])
  const enveloped = toCatalogModels([
    { location: { directory: "/workspace" }, data: [catalogEntry()] },
  ])
  assert.equal(bare.length, 1)
  assert.deepEqual(bare, enveloped)
  const model = bare[0]
  assert.ok(model !== undefined)
  assert.equal(model.providerID, "openai")
  assert.equal(model.modelID, "gpt-6-luna")
  assert.equal(model.name, "GPT-6 Luna")
  assert.equal(model.context, 400_000)
  assert.equal(model.output, 128_000)
  assert.deepEqual(model.inputModalities, ["text", "image"])
  assert.equal(model.tools, true)
  assert.deepEqual(model.variantIDs, ["high"])
  assert.deepEqual(model.variantSettings, { high: { reasoningEffort: "high" } })
})

test("toCatalogModels keeps the base cost tier and treats an empty cost array as zero", () => {
  const [tiered] = toCatalogModels([
    catalogEntry({
      cost: [
        { input: 2, output: 8, cache: { read: 0.4, write: 0 }, tier: { type: "context", size: 200_000 } },
        { input: 4, output: 16, cache: { read: 0.8, write: 0 }, tier: { type: "context", size: 400_000 } },
      ],
    }),
  ])
  assert.deepEqual(tiered?.costPerMTok, { input: 2, output: 8, cacheRead: 0.4, cacheWrite: 0 })

  const [subscription] = toCatalogModels([catalogEntry({ cost: [] })])
  assert.deepEqual(subscription?.costPerMTok, NO_COST)
})

test("toCatalogModels skips entries that cannot be routed", () => {
  const entries = [
    catalogEntry({ enabled: false }),
    catalogEntry({ capabilities: { tools: false, input: ["text"], output: ["text"] } }),
    catalogEntry({ limit: { output: 128_000 } }),
    catalogEntry({ limit: { context: 0, output: 128_000 } }),
    catalogEntry({ providerID: undefined }),
    catalogEntry({ modelID: undefined, id: undefined }),
  ]
  assert.deepEqual(toCatalogModels(entries), [])
})

test("toCatalogModels never throws on a malformed payload", () => {
  const junk = [null, undefined, 42, "model", [], catalogEntry({ variants: [null, 3, { settings: {} }] })]
  assert.doesNotThrow(() => toCatalogModels(junk))
  const catalog = toCatalogModels(junk)
  assert.equal(catalog.length, 1)
  assert.deepEqual(catalog[0]?.variantIDs, [])
  assert.deepEqual(toCatalogModels([{ data: "not-an-array" }]), [])
  assert.deepEqual(toCatalogModels([]), [])
})

/** Routes as the subscription association would produce them. */
const OPENAI_ROUTE = routeFixture()
const GO_ROUTE = routeFixture({
  id: "opencode-go",
  label: "OpenCode Go",
  poolID: "opencode-go",
  providerIDs: ["opencode-go"],
  usageEntryIDs: ["opencode-go"],
  connection: { requireOAuth: false },
})

function buildOptions(
  routes: readonly SubscriptionRoute[],
  overrides: Partial<RoutableBuildOptions> = {},
): RoutableBuildOptions {
  return { routes, profileOf: () => DEFAULT_MODEL_PROFILE, ...overrides }
}

test("buildRoutableModels keeps two providers of the same model id separate", () => {
  const catalog = toCatalogModels([
    catalogEntry({ providerID: "openai", modelID: "gpt-6-luna" }),
    catalogEntry({ providerID: "opencode-go", modelID: "gpt-6-luna" }),
  ])
  const routable = buildRoutableModels(catalog, buildOptions([OPENAI_ROUTE, GO_ROUTE]))
  assert.deepEqual(
    routable.map((model) => model.ref),
    ["openai/gpt-6-luna", "opencode-go/gpt-6-luna"],
  )
  assert.deepEqual(
    routable.map((model) => model.route.id),
    ["openai-chatgpt", "opencode-go"],
  )
  assert.deepEqual(
    routable.map((model) => model.key),
    ["openai/gpt-6-luna", "opencode-go/gpt-6-luna"],
  )
})

test("buildRoutableModels drops providers without a route and blacklisted models", () => {
  const catalog = toCatalogModels([
    catalogEntry({ providerID: "opencode", modelID: "gpt-5.6" }),
    catalogEntry({ providerID: "opencode-go", modelID: "glm-5.3" }),
    catalogEntry({ providerID: "opencode-go", modelID: "glm-5.3-flash" }),
  ])
  const routable = buildRoutableModels(
    catalog,
    buildOptions([GO_ROUTE], { isExcluded: compileExclusions(["opencode-go/*-flash"]) }),
  )
  assert.deepEqual(routable.map((model) => model.ref), ["opencode-go/glm-5.3"])
})

test("buildRoutableModels attaches the profile its resolver returns", () => {
  const curated = profileFixture({ source: "curated" })
  const routable = buildRoutableModels(
    toCatalogModels([catalogEntry({ providerID: "opencode-go", modelID: "kimi-k3" })]),
    buildOptions([GO_ROUTE], { profileOf: () => curated }),
  )
  assert.equal(routable[0]?.profile, curated)
})

test("toCatalogModels keeps the host family and widens a release time in seconds", () => {
  const [model] = toCatalogModels([
    { ...catalogEntry({ providerID: "zcode", modelID: "glm-5.3" }), family: "glm", time: { released: 1_760_000_000 } },
  ])
  assert.equal(model?.family, "glm")
  assert.equal(model?.releasedAt, 1_760_000_000_000)
})

test("providerIDsOf lists each provider once and skips fully blacklisted ones", () => {
  const catalog = toCatalogModels([
    catalogEntry({ providerID: "zcode", modelID: "glm-5.3" }),
    catalogEntry({ providerID: "zcode", modelID: "glm-5.3-flash" }),
    catalogEntry({ providerID: "claude-dipol", modelID: "claude-opus-5-5" }),
  ])
  assert.deepEqual(providerIDsOf(catalog, compileExclusions(["claude-dipol"])), ["zcode"])
})

test("selectModel rejects a model without tool support", () => {
  const decision = selectModel({
    requirements: requirementsFixture({ needsTools: true }),
    models: [routable({ tools: false, tier: "economy" })],
    ledger: ledgerOf(),
  })
  assert.equal(decision.selected, undefined)
  const report = reportFor(decision, "openai/gpt-6-luna")
  assert.equal(report.eligible, false)
  assert.match(report.reason, /needs tools but capabilities\.tools=false/)
})

test("selectModel rejects a model without an image modality and keeps one that has it", () => {
  const blind = selectModel({
    requirements: requirementsFixture({ needsVision: true, tier: "economy" }),
    models: [routable({ modalities: ["text", "audio"], tier: "economy" })],
    ledger: ledgerOf(),
  })
  assert.equal(blind.selected, undefined)
  assert.match(reportFor(blind, "openai/gpt-6-luna").reason, /needs vision but input modalities are \[text, audio\]/)

  const sighted = selectModel({
    requirements: requirementsFixture({ needsVision: true }),
    models: [routable({ modalities: ["text", "image"] })],
    ledger: ledgerOf(),
  })
  assert.equal(sighted.selected?.ref, "openai/gpt-6-luna")
})

test("selectModel rejects a context window smaller than the prompt", () => {
  const decision = selectModel({
    requirements: requirementsFixture({ estimatedInputTokens: 120_000 }),
    models: [routable({ context: 32_000 })],
    ledger: ledgerOf(),
  })
  assert.equal(decision.selected, undefined)
  assert.match(
    reportFor(decision, "openai/gpt-6-luna").reason,
    /context 32000 is below the estimated 120000 input tokens/,
  )
})

test("selectModel never trades required quality for spare quota", () => {
  const decision = selectModel({
    requirements: requirementsFixture({ tier: "advanced" }),
    models: [
      routable({
        providerID: "free-tier",
        modelID: "economy-lite",
        tier: "economy",
        catalogCost: NO_COST,
      }),
      routable({ tier: "advanced" }),
    ],
    ledger: ledgerOf(),
  })
  assert.equal(decision.selected?.ref, "openai/gpt-6-luna")
  const rejected = reportFor(decision, "free-tier/economy-lite")
  assert.equal(rejected.eligible, false)
  assert.match(rejected.reason, /tier economy is below the required floor advanced/)
})

test("selectModel refuses to assume advanced quality without a curated profile", () => {
  const uncurated = routable({
    modelID: "mystery",
    profile: { ...DEFAULT_MODEL_PROFILE, tier: "advanced" },
  })
  const decision = selectModel({
    requirements: requirementsFixture({ tier: "advanced" }),
    models: [uncurated],
    ledger: ledgerOf(),
  })
  assert.equal(decision.selected, undefined)
  assert.match(
    reportFor(decision, "openai/mystery").reason,
    /no curated profile, refusing to assume advanced quality/,
  )
})

test("selectModel skips an exhausted pool and names it", () => {
  const decision = selectModel({
    requirements: requirementsFixture(),
    models: [
      routable({ tier: "balanced" }),
      routable({
        providerID: "opencode-go",
        tier: "balanced",
        route: { id: "opencode-go", label: "OpenCode Zen Go", poolID: "opencode-go" },
      }),
    ],
    ledger: ledgerOf(
      { poolID: "openai-chatgpt", windows: [{ label: "weekly", usedPercent: 100 }] },
      { poolID: "opencode-go", windows: [{ label: "weekly", usedPercent: 4 }] },
    ),
  })
  assert.equal(decision.selected?.ref, "opencode-go/gpt-6-luna")
  const exhausted = reportFor(decision, "openai/gpt-6-luna")
  assert.equal(exhausted.eligible, false)
  assert.equal(exhausted.quotaStatus, "exhausted")
  assert.match(exhausted.reason, /pool openai-chatgpt exhausted \(weekly window 100% used\)/)
})

test("selectModel does not treat unknown quota as available", () => {
  const blind = routable({
    modelID: "blind",
    route: { id: "zai-coding", label: "Z.AI Coding Plan", poolID: "zai" },
  })
  const fresh = routable({
    providerID: "opencode-go",
    route: { id: "opencode-go", label: "OpenCode Zen Go", poolID: "opencode-go" },
  })
  const ledger = ledgerOf(
    { poolID: "zai", label: "Z.AI", status: "unknown", windows: [{ label: "monthly", usedPercent: null }] },
    { poolID: "opencode-go", windows: [{ label: "weekly", usedPercent: 0 }] },
  )

  const compared = selectModel({ requirements: requirementsFixture({ tier: "advanced" }), models: [blind, fresh], ledger })
  assert.equal(compared.selected?.ref, "opencode-go/gpt-6-luna")
  const blindReport = reportFor(compared, "openai/blind")
  assert.equal(blindReport.eligible, true)
  assert.equal(blindReport.quotaStatus, "unknown")
  assert.equal(blindReport.headroomRatio, null)

  const only = selectModel({
    requirements: requirementsFixture({ tier: "advanced" }),
    models: [blind],
    ledger,
  })
  assert.equal(only.selected?.ref, "openai/blind")
  assert.match(reportFor(only, "openai/blind").reason, /quota unknown for pool zai/)
})

test("selectModel penalizes a stale pool exactly like an unknown one", () => {
  const stale = selectModel({
    requirements: requirementsFixture({ tier: "advanced" }),
    models: [
      routable({
        modelID: "stale",
        route: { id: "zai-coding", label: "Z.AI Coding Plan", poolID: "zai" },
      }),
      routable({
        providerID: "opencode-go",
        route: { id: "opencode-go", label: "OpenCode Zen Go", poolID: "opencode-go" },
      }),
    ],
    ledger: ledgerOf(
      {
        poolID: "zai",
        status: "stale",
        error: "usagebar did not answer within 2s",
        windows: [{ label: "monthly", usedPercent: null }],
      },
      { poolID: "opencode-go", windows: [{ label: "weekly", usedPercent: 0 }] },
    ),
  })
  assert.equal(stale.selected?.ref, "opencode-go/gpt-6-luna")
  assert.match(reportFor(stale, "openai/stale").reason, /quota lookup failed for pool zai/)
})

test("selectModel only emits an effort the model actually exposes", () => {
  const laddered = routable({ variants: ["low", "high", "max"] })
  const deep = selectModel({
    requirements: requirementsFixture({ needsReasoning: true, deepReasoning: 0.9 }),
    models: [laddered],
    ledger: ledgerOf(),
  })
  assert.equal(deep.variant, "high")
  assert.ok(laddered.catalog.variantIDs.includes(deep.variant ?? ""))

  const cheap = selectModel({
    requirements: requirementsFixture({ needsReasoning: false, complexity: "fast" }),
    models: [laddered],
    ledger: ledgerOf(),
  })
  assert.equal(cheap.variant, "low")

  const maxOnly = routable({ modelID: "kimi-k3", variants: ["max"] })
  const noMatch = selectModel({
    requirements: requirementsFixture({ needsReasoning: true, deepReasoning: 0.9 }),
    models: [maxOnly],
    ledger: ledgerOf(),
  })
  assert.equal(noMatch.variant, undefined)
  assert.equal(resolveEffortVariant(maxOnly, "high"), undefined)
  assert.equal(resolveEffortVariant(maxOnly, "max"), "max")
})

test("selectModel rejects a reasoning ladder that tops out below the need", () => {
  const decision = selectModel({
    requirements: requirementsFixture({ needsReasoning: true, deepReasoning: 0.9 }),
    models: [routable({ variants: ["low"] })],
    ledger: ledgerOf(),
  })
  assert.equal(decision.selected, undefined)
  assert.match(reportFor(decision, "openai/gpt-6-luna").reason, /reasoning ladder tops out at low but the task needs high/)
})

test("selectModel charges the effort premium and prefers a roomier pool", () => {
  const goLike = (modelID: string, poolID: string) =>
    routable({
      providerID: "opencode-go",
      modelID,
      route: { id: "opencode-go", label: "OpenCode Zen Go", poolID },
      profile: {
        includedUsageUsd: 15,
        windowShares: { weekly: 0.5 },
        costPerMTok: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      },
    })
  const busy = goLike("busy", "opencode-go-busy")
  const calm = goLike("calm", "opencode-go-calm")
  const decision = selectModel({
    requirements: requirementsFixture({
      tier: "advanced",
      estimatedInputTokens: 20_000,
      estimatedOutputTokens: 8_000,
      estimatedTurns: 4,
    }),
    models: [busy, calm],
    ledger: ledgerOf(
      { poolID: "opencode-go-busy", windows: [{ label: "weekly", usedPercent: 92 }] },
      { poolID: "opencode-go-calm", windows: [{ label: "weekly", usedPercent: 3 }] },
    ),
  })
  assert.equal(decision.selected?.ref, "opencode-go/calm")
  const busyReport = reportFor(decision, "opencode-go/busy")
  assert.match(busyReport.reason, /weekly window 92% used/)
  assert.ok(busyReport.estimatedPressure !== null && busyReport.estimatedPressure > 0)
  assert.ok(busyReport.score < (reportFor(decision, "opencode-go/calm").score ?? 0))
})

test("selectModel is deterministic and breaks ties on ref ascending", () => {
  const first = routable({ modelID: "gpt-6-luna" })
  const second = routable({ providerID: "opencode-go", modelID: "gpt-6-luna" })
  const input = {
    requirements: requirementsFixture({ tier: "advanced" }),
    models: [first, second],
    ledger: ledgerOf({
      poolID: "openai-chatgpt",
      windows: [{ label: "weekly", usedPercent: 0 }],
    }),
  }
  const forward = selectModel(input)
  const again = selectModel({ ...input, models: [first, second] })
  const reversed = selectModel({ ...input, models: [second, first] })
  assert.equal(forward.selected?.ref, "openai/gpt-6-luna")
  assert.deepEqual(again, forward)
  assert.deepEqual(reversed, forward)
})

test("selectModel rewards speed only when the task prefers it", () => {
  const slow = routable({ modelID: "aaa-slow", profile: { speed: 0.3 } })
  const fast = routable({ modelID: "zzz-fast", profile: { speed: 0.95 } })
  const ledger = ledgerOf({
    poolID: "openai-chatgpt",
    windows: [{ label: "weekly", usedPercent: 10 }],
  })
  const hurried = selectModel({
    requirements: requirementsFixture({ tier: "advanced", prefersSpeed: true }),
    models: [slow, fast],
    ledger,
  })
  assert.equal(hurried.selected?.ref, "openai/zzz-fast")

  const patient = selectModel({
    requirements: requirementsFixture({ tier: "advanced", prefersSpeed: false }),
    models: [slow, fast],
    ledger,
  })
  assert.equal(patient.selected?.ref, "openai/aaa-slow")
})

test("selectModel never lets speed outvote quota pressure", () => {
  const fastFull = routable({
    modelID: "fast-full",
    profile: { speed: 0.95 },
    route: { id: "opencode-go", poolID: "pool-full" },
  })
  const slowRoomy = routable({
    modelID: "slow-roomy",
    profile: { speed: 0.2 },
    route: { id: "kimi-coding", poolID: "pool-roomy" },
  })
  const decision = selectModel({
    requirements: requirementsFixture({ tier: "advanced", prefersSpeed: true }),
    models: [fastFull, slowRoomy],
    ledger: ledgerOf(
      { poolID: "pool-full", windows: [{ label: "weekly", usedPercent: 95 }] },
      { poolID: "pool-roomy", windows: [{ label: "weekly", usedPercent: 5 }] },
    ),
  })
  assert.equal(decision.selected?.ref, "openai/slow-roomy")
})

test("selectModel returns no selection and an actionable reason when nothing is safe", () => {
  const decision = selectModel({
    requirements: requirementsFixture({ tier: "advanced", needsVision: true }),
    models: [routable({ tools: false, tier: "economy", modalities: ["text"] })],
    ledger: ledgerOf(),
  })
  assert.equal(decision.selected, undefined)
  assert.equal(decision.variant, undefined)
  assert.match(decision.reason, /no eligible model out of 1: openai\/gpt-6-luna rejected: needs tools/)
  assert.equal(decision.considered.length, 1)

  const empty = selectModel({
    requirements: requirementsFixture(),
    models: [],
    ledger: ledgerOf(),
  })
  assert.equal(empty.selected, undefined)
  assert.match(empty.reason, /no routable models: the host catalog exposed no enabled model/)
})

test("selectModel reports capped candidates instead of dropping them silently", () => {
  const models = Array.from({ length: 4 }, (_, index) =>
    routable({ providerID: "opencode-go", modelID: `go-${index}` }),
  )
  const decision = selectModel(
    {
      requirements: requirementsFixture({ tier: "advanced" }),
      models,
      ledger: ledgerOf(),
    },
    { maxCandidates: 2 },
  )
  assert.ok(decision.selected !== undefined)
  const capped = decision.considered.filter((entry) => /candidate cap 2 reached/.test(entry.reason))
  assert.equal(capped.length, 2)
  assert.equal(capped[0]?.eligible, false)
})

test("selectModel survives a ledger that throws", () => {
  const broken: QuotaLedger = {
    pools: () => {
      throw new Error("usagebar socket closed")
    },
    pool: () => {
      throw new Error("usagebar socket closed")
    },
    pressure: () => {
      throw new Error("usagebar socket closed")
    },
    subscriptions: () => [],
    refresh: async () => {},
    dispose: () => {},
  }
  const decision = selectModel({
    requirements: requirementsFixture({ tier: "advanced" }),
    models: [routable()],
    ledger: broken,
  })
  assert.equal(decision.selected?.ref, "openai/gpt-6-luna")
  assert.match(reportFor(decision, "openai/gpt-6-luna").reason, /quota lookup failed for pool openai-chatgpt/)
})

test("requiredEffortFor derives the rung from the task signals", () => {
  const thresholds = DEFAULT_SELECT_OPTIONS.thresholds
  const base = requirementsFixture()
  assert.equal(requiredEffortFor(base, thresholds), "low")
  assert.equal(requiredEffortFor({ ...base, complexity: "fast" }, thresholds), "low")
  assert.equal(requiredEffortFor({ ...base, needsReasoning: true }, thresholds), "medium")
  assert.equal(requiredEffortFor({ ...base, complexity: "deep" }, thresholds), "high")
  assert.equal(requiredEffortFor({ ...base, deepReasoning: 0.9 }, thresholds), "high")
  assert.equal(requiredEffortFor({ ...base, research: 0.9 }, thresholds), "high")
  assert.equal(
    requiredEffortFor({ ...base, complexity: "fast", deepReasoning: 0.3 }, thresholds),
    "high",
  )
  assert.equal(requiredEffortFor({ ...base, highRisk: 0.9 }, thresholds), "max")
  assert.equal(
    requiredEffortFor({ ...base, complexity: "fast", deepReasoning: 0.9, highRisk: 0.9 }, thresholds),
    "max",
  )
})

test("estimateCostUsd is monotonic in workload and immune to junk input", () => {
  const model = routable({
    catalogCost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
    profile: { costPerMTok: { input: 99, output: 99, cacheRead: 99, cacheWrite: 0 } },
  })
  const base = { inputTokens: 10_000, outputTokens: 2_000, turns: 4, cacheHitRatio: 0, effortMultiplier: 1 }
  const bigger = estimateCostUsd(model, { ...base, inputTokens: 20_000 })
  assert.ok(bigger > estimateCostUsd(model, base))
  assert.ok(estimateCostUsd(model, { ...base, outputTokens: 4_000 }) > estimateCostUsd(model, base))
  assert.ok(estimateCostUsd(model, { ...base, turns: 8 }) > estimateCostUsd(model, base))
  assert.ok(estimateCostUsd(model, { ...base, effortMultiplier: 2 }) > estimateCostUsd(model, base))
  assert.equal(estimateCostUsd(model, { ...base, turns: 0 }), 0)
  assert.ok(estimateCostUsd(model, { ...base, cacheHitRatio: 0.9 }) < estimateCostUsd(model, base))

  const junk = estimateCostUsd(model, {
    inputTokens: Number.NaN,
    outputTokens: Number.NEGATIVE_INFINITY,
    turns: -4,
    cacheHitRatio: Number.NaN,
    effortMultiplier: -2,
  })
  assert.equal(junk, 0)
  assert.ok(Number.isFinite(junk) && junk >= 0)
  const overflow = estimateCostUsd(model, { ...base, inputTokens: Number.POSITIVE_INFINITY })
  assert.ok(Number.isFinite(overflow) && overflow >= 0)
  const huge = estimateCostUsd(model, { ...base, inputTokens: 1e300, outputTokens: 1e300, turns: 1e300 })
  assert.equal(huge, MAX_ESTIMATED_COST_USD)
})

test("estimateCostUsd falls back from the catalog price to curated burn to a proxy", () => {
  const workload = { inputTokens: 1_000_000, outputTokens: 0, turns: 1, cacheHitRatio: 0, effortMultiplier: 1 }
  const published = routable({
    catalogCost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 },
    profile: { costPerMTok: { input: 50, output: 50, cacheRead: 50, cacheWrite: 0 } },
  })
  assert.equal(estimateCostUsd(published, workload), 2)

  const curated = routable({
    profile: { costPerMTok: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 } },
  })
  assert.equal(estimateCostUsd(curated, workload), 3)

  const proxied = routable({ profile: { reasoning: 0.5 } })
  assert.ok(Math.abs(estimateCostUsd(proxied, workload) - (1 + UNPRICED_REASONING_BURN_SCALE * 0.5)) < 1e-9)
})

test("effortMultiplierFor is conservative about the host default gear", () => {
  const model = routable({ profile: { effortCost: { max: 6, broken: 0, negative: -2 } } })
  assert.equal(effortMultiplierFor(model, "max"), 6)
  assert.equal(effortMultiplierFor(model, "low"), 1)
  assert.equal(effortMultiplierFor(model, "broken"), 1)
  assert.equal(effortMultiplierFor(model, "negative"), 1)
  assert.equal(effortMultiplierFor(model, undefined), 6)

  const singleGear = routable({ profile: { effortCost: { low: 1 } } })
  assert.equal(effortMultiplierFor(singleGear, undefined), 1)

  const unpriced = routable({ profile: {} })
  assert.equal(effortMultiplierFor(unpriced, undefined), 1)
})

test("a max-only model is estimated at its worst gear even when no variant is emitted", () => {
  const maxOnly = routable({
    providerID: "kimi-code-plan-global",
    modelID: "kimi-k3",
    variants: ["max"],
    profile: { effortCost: { max: 6 } },
  })
  assert.equal(resolveEffortVariant(maxOnly, "high"), undefined)
  assert.equal(effortMultiplierFor(maxOnly, undefined), 6)
})

test("estimateWindowPressure needs a published allowance and returns null otherwise", () => {
  const goLike = routable({
    profile: {
      includedUsageUsd: 15,
      windowShares: { weekly: 0.5 },
      costPerMTok: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      effortCost: { max: 6 },
    },
  })
  assert.ok(Math.abs((estimateWindowPressure(goLike, undefined, 1, "weekly") ?? 0) - 6 / 7.5) < 1e-9)
  assert.ok(Math.abs((estimateWindowPressure(goLike, "max", 1, "weekly") ?? 0) - 6 / 7.5) < 1e-9)
  assert.equal(estimateWindowPressure(goLike, undefined, 1, "5h"), null)

  const noDollars = routable({ profile: { includedUsageUsd: null, windowShares: {} } })
  assert.equal(estimateWindowPressure(noDollars, undefined, 1, "weekly"), null)
  assert.equal(estimateWindowPressure(goLike, undefined, Number.NaN, "weekly"), 0)
})

test("explainDecision summarises the winner and its exclusions", () => {
  const decision = selectModel({
    requirements: requirementsFixture({ tier: "advanced" }),
    models: [
      routable({ modelID: "gpt-6-luna", variants: ["low", "high"], profile: { effortCost: { high: 2.5 } } }),
      routable({
        providerID: "opencode-go",
        modelID: "gpt-6-luna",
        route: { id: "opencode-go", label: "OpenCode Zen Go", poolID: "opencode-go" },
      }),
    ],
    ledger: ledgerOf(
      { poolID: "openai-chatgpt", windows: [{ label: "weekly", usedPercent: 94 }] },
      { poolID: "opencode-go", windows: [{ label: "weekly", usedPercent: 17 }] },
    ),
  })
  assert.equal(decision.selected?.ref, "opencode-go/gpt-6-luna")
  const summary = explainDecision(decision)
  assert.match(summary, /^opencode-go\/gpt-6-luna \(OpenCode Zen Go pool, est\. \$\d+\.\d\d\) — /)
  assert.match(summary, /weekly window 17% used/)
  assert.match(summary, /gpt-6-luna runner-up/)

  const excluded = selectModel({
    requirements: requirementsFixture({ tier: "advanced" }),
    models: [
      routable({ modelID: "gpt-6-luna" }),
      routable({
        providerID: "opencode-go",
        modelID: "gpt-6-luna",
        route: { id: "opencode-go", label: "OpenCode Zen Go", poolID: "opencode-go" },
      }),
    ],
    ledger: ledgerOf(
      { poolID: "openai-chatgpt", windows: [{ label: "weekly", usedPercent: 100 }] },
      { poolID: "opencode-go", windows: [{ label: "weekly", usedPercent: 17 }] },
    ),
  })
  assert.match(explainDecision(excluded), /gpt-6-luna excluded: pool openai-chatgpt exhausted/)

  const blocked = selectModel({
    requirements: requirementsFixture({ tier: "advanced" }),
    models: [routable({ tools: false })],
    ledger: ledgerOf(),
  })
  assert.match(explainDecision(blocked), /^no model selected — no eligible model out of 1/)
})

const PACE_NOW = Date.parse("2026-10-07T12:00:00Z")
const WEEK_SECS = 604_800
const MONTH_SECS = 2_678_400

/** A window `daysLeft` days before its reset, at `usedPercent` consumption. */
function pacedWindow(usedPercent: number, windowSecs: number, daysLeft: number): QuotaPoolState["windows"][number] {
  return {
    id: "w",
    label: "w",
    windowSecs,
    usedPercent,
    resetsAt: new Date(PACE_NOW + daysLeft * 86_400_000).toISOString(),
    dimension: "inference",
  }
}

test("pace headroom divides the remaining share by the remaining time share", () => {
  assert.ok(Math.abs(paceHeadroomOf(pacedWindow(49, MONTH_SECS, 19.53), PACE_NOW) - 0.51 / 0.63) < 0.01)
  assert.equal(paceHeadroomOf(pacedWindow(23, WEEK_SECS, 3.5), PACE_NOW), 1)
  assert.equal(paceHeadroomOf(pacedWindow(100, WEEK_SECS, 3), PACE_NOW), 0)
})

test("pace headroom falls back to the plain remaining share without a reset time", () => {
  const window = { ...pacedWindow(40, WEEK_SECS, 2), resetsAt: null }
  assert.equal(paceHeadroomOf(window, PACE_NOW), 0.6)
})

test("pace headroom does not explode for a window about to reset", () => {
  assert.ok(Math.abs(paceHeadroomOf(pacedWindow(99, WEEK_SECS, 0.001), PACE_NOW) - 0.2) < 1e-9)
})

test("a weekly pool on pace beats a monthly pool that is running ahead of its pace", () => {
  const monthly = routable({
    providerID: "cursor",
    modelID: "composer-2.5",
    tier: "advanced",
    route: { id: "cursor", poolID: "cursor", providerIDs: ["cursor"], usageEntryIDs: ["cursor"] },
  })
  const weekly = routable({
    providerID: "zcode",
    modelID: "glm-5.3",
    tier: "advanced",
    route: { id: "zai", poolID: "zai", providerIDs: ["zcode"], usageEntryIDs: ["zai"] },
  })
  const ledger = ledgerOf(
    { poolID: "cursor", windows: [{ label: "Cursor Models", usedPercent: 30, windowSecs: MONTH_SECS, resetsAt: new Date(PACE_NOW + 28 * 86_400_000).toISOString() }] },
    { poolID: "zai", windows: [{ label: "Weekly", usedPercent: 50, windowSecs: WEEK_SECS, resetsAt: new Date(PACE_NOW + 1 * 86_400_000).toISOString() }] },
  )

  const decision = selectModel({
    requirements: requirementsFixture({ tier: "balanced" }),
    models: [monthly, weekly],
    ledger,
    now: PACE_NOW,
  })

  assert.equal(decision.selected?.ref, "zcode/glm-5.3")
})
