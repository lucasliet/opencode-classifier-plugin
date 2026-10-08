import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { setupV2 } from "../src/v2.ts"
import type {
  ActiveSubscription,
  PoolPressure,
  QuotaLedger,
  QuotaPoolState,
} from "../src/routing/contracts.ts"

interface HookCalls {
  permission: Array<(event: any) => Promise<void> | void>
  prompt: Array<(event: any) => Promise<void> | void>
  context: Array<(event: any) => Promise<void> | void>
  retry: Array<(event: any) => Promise<void> | void>
}

interface MockContext {
  ctx: any
  hooks: HookCalls
  switchedModels: unknown[]
  switchedAgents: unknown[]
  addedProviders: unknown[]
  permissionRequests: unknown[]
  emit: (event: Record<string, unknown>) => Promise<void>
}

interface MockScenario {
  readonly catalog?: readonly unknown[]
  readonly connections?: Record<string, unknown>
}

interface FakeQuotaPool {
  readonly poolID: string
  readonly usedPercent: number | null
}

const VIRTUAL_MODEL = { providerID: "jev-model-router", id: "auto" }

/** What `ai-usagebar` reports by default: Codex by OAuth, Go and Z.AI by key. */
const DEFAULT_SUBSCRIPTIONS: readonly ActiveSubscription[] = [
  { id: "openai", label: "Codex (ChatGPT Team)", requireOAuth: true },
  { id: "opencode-go", label: "OpenCode Go", requireOAuth: false },
  { id: "zai", label: "Z.AI (GLM Coding Pro)", requireOAuth: false },
]

function mockContext(
  rawOptions: Record<string, unknown>,
  modelDefault: { providerID: string; id: string } | null = VIRTUAL_MODEL,
  sessionModel: { providerID: string; id: string } | undefined = undefined,
  scenario: MockScenario = {},
): MockContext {
  const hooks: HookCalls = { permission: [], prompt: [], context: [], retry: [] }
  const switchedModels: unknown[] = []
  const switchedAgents: unknown[] = []
  const addedProviders: unknown[] = []
  const permissionRequests: unknown[] = []
  const pendingEvents: Record<string, unknown>[] = []
  const stored = new Map<string, unknown>()
  let drain: (() => void) | undefined = undefined

  const ctx = {
    app: { version: "2.0.15-test" },
    location: { directory: "/workspace" },
    options: rawOptions,
    storage: {
      async get(key: string) {
        return stored.get(key)
      },
      async set(key: string, value: unknown) {
        stored.set(key, value)
      },
    },
    permission: {
      async hook(_name: string, callback: (event: any) => Promise<void> | void) {
        hooks.permission.push(callback)
        return { dispose: async () => {} }
      },
      async reply(input: unknown) {
        permissionRequests.push(input)
      },
    },
    session: {
      async hook(
        name: "prompt" | "context" | "retry",
        callback: (event: any) => Promise<void> | void,
      ) {
        hooks[name].push(callback)
        return { dispose: async () => {} }
      },
      async switchModel(input: unknown) {
        switchedModels.push(input)
      },
      async switchAgent(input: unknown) {
        switchedAgents.push(input)
      },
      async get() {
        return {
          id: "ses_1",
          ...(sessionModel ? { model: sessionModel } : {}),
        }
      },
    },
    provider: {
      async transform(callback: (editor: any) => void) {
        callback({
          get: () => undefined,
          add: (input: unknown) => {
            addedProviders.push(input)
          },
        })
        return { dispose: async () => {} }
      },
    },
    integration: {
      connection: {
        async active(integrationID: string) {
          return (scenario.connections ?? defaultConnections())[integrationID]
        },
      },
    },
    model: {
      async list() {
        return {
          location: { directory: "/workspace" },
          data: [...(scenario.catalog ?? defaultCatalog())],
        }
      },
      async default() {
        return {
          location: { directory: "/workspace" },
          data: modelDefault,
        }
      },
    },
    event: {
      subscribe() {
        const iterable: AsyncIterable<unknown> = {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<unknown>> {
                const event = pendingEvents.shift()
                if (event) return { value: event, done: false }
                await new Promise<void>((resolve) => {
                  drain = resolve
                })
                const queued = pendingEvents.shift()
                return queued
                  ? { value: queued, done: false }
                  : { value: undefined, done: true }
              },
            }
          },
        }
        return iterable
      },
    },
  }

  const emit = async (event: Record<string, unknown>) => {
    pendingEvents.push(event)
    drain?.()
    drain = undefined
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  }

  return {
    ctx,
    hooks,
    switchedModels,
    switchedAgents,
    addedProviders,
    permissionRequests,
    emit,
  }
}

function hostModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    limit: { context: 400_000, output: 128_000 },
    variants: [],
    cost: [],
    ...overrides,
  }
}

function glmVariants(): Array<Record<string, unknown>> {
  return [{ id: "low" }, { id: "high" }, { id: "max" }].map((variant) => ({
    id: variant.id,
    settings: {},
  }))
}

/**
 * One model per interesting provider: an OAuth-gated subscription (openai), a
 * presence-proved subscription (opencode-go, my-glm), and a pay-as-you-go
 * catalog entry (opencode) that must never be routed.
 */
function defaultCatalog(): unknown[] {
  return [
    hostModel({
      providerID: "openai",
      modelID: "gpt-5.3-codex-spark",
      name: "GPT-5.3 Codex Spark",
      variants: [{ id: "medium", settings: {} }, { id: "high", settings: {} }],
    }),
    hostModel({
      providerID: "opencode-go",
      modelID: "glm-5.3-flash",
      name: "GLM 5.3 Flash",
      variants: glmVariants(),
    }),
    hostModel({
      providerID: "opencode",
      modelID: "muse-spark-1.3",
      name: "Muse Spark",
      cost: [{ input: 0.4, output: 2, cache: { read: 0.1, write: 0 } }],
    }),
    hostModel({
      providerID: "my-glm",
      modelID: "glm-5.3",
      name: "GLM 5.3",
      variants: glmVariants(),
    }),
  ]
}

function defaultConnections(): Record<string, unknown> {
  return {
    openai: { type: "credential", id: "cred_1", label: "ChatGPT", method: "oauth" },
    opencode: { type: "env", name: "OPENCODE_ZEN" },
    "zai-coding-plan": { type: "env", name: "ZAI_CODING_KEY" },
    "kimi-code-plan-global": { type: "env", name: "KIMI_CODING_KEY" },
  }
}

function fakePressure(state: QuotaPoolState | undefined, poolID: string): PoolPressure {
  const used = (state?.windows ?? [])
    .map((window) => window.usedPercent)
    .filter((value): value is number => value !== null)
  const worst = used.length === 0 ? null : Math.max(...used)
  return {
    poolID,
    known: worst !== null,
    worstUsedPercent: worst,
    headroomRatio: worst === null ? null : Math.max(0, (100 - worst) / 100),
    status: state?.status ?? "unknown",
    nextResetAt: null,
  }
}

/**
 * Plain-object ledger: no process is spawned and a hanging refresh stays
 * pending forever, which is exactly what the bounded prompt wait must survive.
 */
function fakeQuotaLedger(
  pools: readonly FakeQuotaPool[] = [],
  behavior: {
    readonly hangRefresh?: boolean
    readonly subscriptions?: readonly ActiveSubscription[]
  } = {},
): QuotaLedger {
  const subscriptions = behavior.subscriptions ?? DEFAULT_SUBSCRIPTIONS
  const states: QuotaPoolState[] = pools.map((pool) => {
    const used = pool.usedPercent
    return {
      poolID: pool.poolID,
      label: pool.poolID,
      status: used === null ? "unknown" : used >= 100 ? "exhausted" : "available",
      windows:
        used === null
          ? []
          : [
              {
                id: "5h",
                label: "5h",
                windowSecs: null,
                usedPercent: used,
                resetsAt: null,
                dimension: "inference" as const,
              },
            ],
      fetchedAt: null,
      error: null,
    }
  })
  return {
    pools: () => states,
    pool: (poolID: string) => states.find((state) => state.poolID === poolID),
    pressure: (poolID: string) =>
      fakePressure(states.find((state) => state.poolID === poolID), poolID),
    subscriptions: () => subscriptions,
    refresh: behavior.hangRefresh === true ? () => new Promise<void>(() => {}) : async () => {},
    dispose: () => {},
  }
}

function pluginOptions(extra: Record<string, unknown> = {}) {
  return {
    decision: { apiKey: "test", retries: 0 },
    routing: {
      models: {
        referenceCatalog: "/nonexistent/opencode/models.json",
        providerAliases: { "my-glm": "zai-coding-plan" },
      },
      agents: { enabled: false },
    },
    context: { toolOutput: { enabled: false } },
    ...extra,
  }
}

/**
 * Route a prompt through a fully wired setup with a fake ledger, so tests
 * never shell out to `ai-usagebar`.
 */
async function setupRouted(
  mock: MockContext,
  ledger: QuotaLedger = fakeQuotaLedger(),
): Promise<void> {
  await setupV2(mock.ctx, { createLedger: () => ledger })
}

/**
 * Capture the plugin's trace log for one run. The tracer re-reads
 * `OPENCODE_CLASSIFIER_LOG` on every line, so redirecting it here exposes the
 * routing internals (gate exclusions, relaxed floors) without any new seam.
 */
async function withTraceLog<T>(run: (readTrace: () => string) => Promise<T>): Promise<T> {
  const path = join(tmpdir(), `v2-test-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}.log`)
  const previous = process.env.OPENCODE_CLASSIFIER_LOG
  process.env.OPENCODE_CLASSIFIER_LOG = path
  try {
    return await run(() => {
      try {
        return readFileSync(path, "utf8")
      } catch {
        return ""
      }
    })
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CLASSIFIER_LOG
    else process.env.OPENCODE_CLASSIFIER_LOG = previous
    rmSync(path, { force: true })
  }
}

function promptEvent(text: string): Record<string, unknown> {
  return {
    sessionID: "ses_1",
    prompt: { text },
    delivery: "steer",
  }
}

function contextEvent(model: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionID: "ses_1",
    agent: "build",
    model,
    system: [],
    messages: [],
    tools: {},
    options: {},
  }
}

function routeResponse(
  complexity: "fast" | "normal" | "deep",
  probability = 0.95,
  domain?: string,
) {
  const answers: Record<string, unknown> = {
    complexity: {
      type: "choice",
      choice: complexity,
      probabilities: {
        fast: complexity === "fast" ? probability : 0.02,
        normal: complexity === "normal" ? probability : 0.02,
        deep: complexity === "deep" ? probability : 0.02,
      },
    },
    deep_reasoning: { type: "noul", noul: complexity === "deep" ? 0.9 : 0.1 },
    high_risk: { type: "noul", noul: 0.1 },
    research: { type: "noul", noul: 0.1 },
  }
  if (domain) {
    answers.domain = {
      type: "choice",
      choice: domain,
      probabilities: { [domain]: 0.95, general: 0.05 },
    }
  }
  return { answers }
}

function permissionResponse(overrides: Record<string, number> = {}) {
  const values: Record<string, number> = {
    read_only: 0.99,
    modifies_project: 0.01,
    outside_workspace: 0.01,
    destructive: 0.01,
    reversible: 0.99,
    changes_vcs_history: 0.01,
    executes_downloaded_code: 0.01,
    external_side_effect: 0.01,
    sensitive_data: 0.01,
    privilege_escalation: 0.01,
    ...overrides,
  }
  return {
    answers: Object.fromEntries(
      Object.entries(values).map(([key, noul]) => [key, { type: "noul", noul }]),
    ),
  }
}

async function withFetch<T>(
  handler: typeof fetch,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = handler
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

function evaluateEvent(overrides: Record<string, unknown> = {}): {
  sessionID: string
  action: string
  resources: string[]
  effect: "ask"
  message?: string
} {
  return {
    sessionID: "ses_1",
    action: "bash",
    resources: ["git status"],
    effect: "ask",
    ...overrides,
  }
}

test("v2 registers the virtual router provider", async () => {
  const mock = mockContext(pluginOptions())
  await withFetch(
    (async () => new Response(JSON.stringify(routeResponse("fast")), { status: 200 })) as typeof fetch,
    async () => {
      await setupV2(mock.ctx)
    },
  )
  assert.equal(mock.addedProviders.length, 1)
  const added = mock.addedProviders[0] as {
    info: { id: unknown; name: string }
    models: Array<{ id: unknown; name: string }>
  }
  assert.equal(added.info.name, "jev model router")
  assert.equal(added.models[0]?.name, "Auto (Jev)")
})

test("v2 permission hook allows safe commands and caches the decision", async () => {
  const mock = mockContext(pluginOptions())
  let jevCalls = 0
  await withFetch(
    (async () => {
      jevCalls += 1
      return new Response(JSON.stringify(permissionResponse()), { status: 200 })
    }) as typeof fetch,
    async () => {
      await setupV2(mock.ctx)
      assert.equal(mock.hooks.permission.length, 1)

      const first = evaluateEvent()
      await mock.hooks.permission[0]?.(first)
      assert.equal(first.effect, "allow")

      const second = evaluateEvent()
      await mock.hooks.permission[0]?.(second)
      assert.equal(second.effect, "allow")
      assert.equal(jevCalls, 1)
    },
  )
})

test("v2 permission hook preserves explicit host effects without calling Jev", async () => {
  const mock = mockContext(pluginOptions())
  let jevCalls = 0
  await withFetch(
    (async () => {
      jevCalls += 1
      return new Response(JSON.stringify(permissionResponse()), { status: 200 })
    }) as typeof fetch,
    async () => {
      await setupV2(mock.ctx)

      const allowed = evaluateEvent({ effect: "allow" })
      await mock.hooks.permission[0]?.(allowed)
      assert.equal(allowed.effect, "allow")
      assert.equal(allowed.message, undefined)
      assert.equal(jevCalls, 0)

      const denied = evaluateEvent({ effect: "deny" })
      await mock.hooks.permission[0]?.(denied)
      assert.equal(denied.effect, "deny")
      assert.equal(denied.message, undefined)
      assert.equal(jevCalls, 0)

      const unresolved = evaluateEvent()
      await mock.hooks.permission[0]?.(unresolved)
      assert.equal(unresolved.effect, "allow")
      assert.equal(jevCalls, 1)
    },
  )
})

test("v2 permission hook keeps risky commands as ask with a reason", async () => {
  const mock = mockContext(pluginOptions())
  await withFetch(
    (async () =>
      new Response(JSON.stringify(permissionResponse({ destructive: 0.99 })), {
        status: 200,
      })) as typeof fetch,
    async () => {
      await setupV2(mock.ctx)
      const event = evaluateEvent({ resources: ["rm -rf /tmp/probe"] })
      await mock.hooks.permission[0]?.(event)
      assert.equal(event.effect, "ask")
      assert.match(String(event.message ?? ""), /risk|approval|confidence/i)
    },
  )
})

test("v2 permission hook leaves the effect untouched when Jev fails", async () => {
  const mock = mockContext(pluginOptions())
  await withFetch(
    (async () => new Response("boom", { status: 500 })) as typeof fetch,
    async () => {
      await setupV2(mock.ctx)
      const event = evaluateEvent()
      await mock.hooks.permission[0]?.(event)
      assert.equal(event.effect, "ask")
      assert.equal(event.message, undefined)
    },
  )
})

test("v2 prompt hook routes a virtual session to a subscription model with a variant", async () => {
  const mock = mockContext(pluginOptions())
  await withFetch(
    (async () => new Response(JSON.stringify(routeResponse("normal")), { status: 200 })) as typeof fetch,
    async () => {
      await setupRouted(mock)
      assert.equal(mock.hooks.prompt.length, 1)

      await mock.hooks.prompt[0]?.(promptEvent("fix the typo"))

      assert.equal(mock.switchedModels.length, 1)
      const switched = mock.switchedModels[0] as {
        sessionID: string
        model: { providerID: string; id: string; variant?: string }
      }
      assert.equal(switched.sessionID, "ses_1")
      assert.equal(switched.model.providerID, "my-glm")
      assert.equal(switched.model.id, "glm-5.3")
      assert.equal(switched.model.variant, "low")
    },
  )
})

test("v2 prompt hook excludes an API-key openai connection and routes elsewhere", async () => {
  const mock = mockContext(pluginOptions(), VIRTUAL_MODEL, undefined, {
    connections: {
      ...defaultConnections(),
      openai: { type: "credential", id: "cred_1", label: "key", method: "key" },
    },
  })
  await withFetch(
    (async () => new Response(JSON.stringify(routeResponse("normal")), { status: 200 })) as typeof fetch,
    async () => {
      await withTraceLog(async (readTrace) => {
        await setupRouted(mock)
        await mock.hooks.prompt[0]?.(promptEvent("fix the typo"))

        assert.equal(mock.switchedModels.length, 1)
        const switched = mock.switchedModels[0] as {
          model: { providerID: string }
        }
        assert.notEqual(switched.model.providerID, "openai")
        assert.match(readTrace(), /not an OAuth grant/)
      })
    },
  )
})

test("v2 prompt hook never routes the pay-as-you-go opencode provider", async () => {
  const mock = mockContext(pluginOptions(), VIRTUAL_MODEL, undefined, {
    catalog: [
      hostModel({
        providerID: "opencode",
        modelID: "muse-spark-1.3",
        name: "Muse Spark",
        cost: [{ input: 0.4, output: 2, cache: { read: 0.1, write: 0 } }],
      }),
    ],
  })
  await withFetch(
    (async () => new Response(JSON.stringify(routeResponse("normal")), { status: 200 })) as typeof fetch,
    async () => {
      await withTraceLog(async (readTrace) => {
        await setupRouted(mock)
        await mock.hooks.prompt[0]?.(promptEvent("fix the typo"))

        assert.deepEqual(mock.switchedModels, [])
        assert.match(readTrace(), /found no subscription model/)
      })
    },
  )
})

test("v2 prompt hook steers away from an exhausted subscription pool", async () => {
  const mock = mockContext(pluginOptions())
  const ledger = fakeQuotaLedger([{ poolID: "zai", usedPercent: 100 }])
  await withFetch(
    (async () => new Response(JSON.stringify(routeResponse("normal")), { status: 200 })) as typeof fetch,
    async () => {
      await setupRouted(mock, ledger)
      await mock.hooks.prompt[0]?.(promptEvent("fix the typo"))

      assert.equal(mock.switchedModels.length, 1)
      const switched = mock.switchedModels[0] as {
        model: { providerID: string; id: string; variant?: string }
      }
      assert.equal(switched.model.providerID, "opencode-go")
      assert.equal(switched.model.id, "glm-5.3-flash")
      assert.equal(switched.model.variant, "low")
    },
  )
})

test("v2 prompt hook routes on the first prompt while quota is still unknown", async () => {
  const mock = mockContext(pluginOptions())
  const ledger = fakeQuotaLedger([], { hangRefresh: true })
  await withFetch(
    (async () => new Response(JSON.stringify(routeResponse("normal")), { status: 200 })) as typeof fetch,
    async () => {
      await setupRouted(mock, ledger)
      const startedAt = Date.now()
      await mock.hooks.prompt[0]?.(promptEvent("fix the typo"))

      assert.equal(mock.switchedModels.length, 1)
      const switched = mock.switchedModels[0] as { model: { providerID: string } }
      assert.equal(switched.model.providerID, "my-glm")
      assert.ok(Date.now() - startedAt < 5_000, "prompt must not block on the quota binary")
    },
  )
})

test("v2 prompt hook relaxes the quality floor one band when the floor rejects everything", async () => {
  const mock = mockContext(pluginOptions(), VIRTUAL_MODEL, undefined, {
    catalog: defaultCatalog().filter(
      (entry) => (entry as Record<string, unknown>).providerID !== "my-glm",
    ),
  })
  await withFetch(
    (async () => new Response(JSON.stringify(routeResponse("deep")), { status: 200 })) as typeof fetch,
    async () => {
      await withTraceLog(async (readTrace) => {
        await setupRouted(mock)
        await mock.hooks.prompt[0]?.(promptEvent("refactor the auth architecture"))

        assert.equal(mock.switchedModels.length, 1)
        const switched = mock.switchedModels[0] as {
          model: { providerID: string; id: string; variant?: string }
        }
        assert.equal(switched.model.providerID, "opencode-go")
        assert.equal(switched.model.id, "glm-5.3-flash")
        assert.equal(switched.model.variant, "high")
        assert.match(readTrace(), /floorRelaxed/)
      })
    },
  )
})

test("v2 prompt hook still routes with a fallback classification when Jev fails", async () => {
  const mock = mockContext(pluginOptions())
  await withFetch(
    (async () => new Response("boom", { status: 500 })) as typeof fetch,
    async () => {
      await withTraceLog(async (readTrace) => {
        await setupRouted(mock)
        await mock.hooks.prompt[0]?.(promptEvent("fix the typo"))

        assert.equal(mock.switchedModels.length, 1)
        const switched = mock.switchedModels[0] as { model: { providerID: string } }
        assert.equal(switched.model.providerID, "my-glm")
        assert.match(readTrace(), /classification failed/)
      })
    },
  )
})

test("v2 prompt hook routes the agent by domain", async () => {
  const mock = mockContext(
    pluginOptions({
      routing: {
        models: { referenceCatalog: "/nonexistent/opencode/models.json" },
        agents: { enabled: true, minimumProbability: 0.85, byDomain: { backend: "backend" } },
      },
    }),
  )
  await withFetch(
    (async () =>
      new Response(JSON.stringify(routeResponse("normal", 0.95, "backend")), {
        status: 200,
      })) as typeof fetch,
    async () => {
      await setupRouted(mock)
      await mock.hooks.prompt[0]?.(promptEvent("migrate the database layer"))
      assert.deepEqual(mock.switchedAgents, [{ sessionID: "ses_1", agent: "backend" }])
    },
  )
})

test("v2 prompt hook skips routing once the user selects a real model", async () => {
  const mock = mockContext(pluginOptions())
  await withFetch(
    (async () => new Response(JSON.stringify(routeResponse("fast")), { status: 200 })) as typeof fetch,
    async () => {
      await setupRouted(mock)

      await mock.hooks.context[0]?.(
        contextEvent({ providerID: "p", id: "normal" }),
      )

      await mock.hooks.prompt[0]?.(promptEvent("fix the typo"))

      assert.deepEqual(mock.switchedModels, [])
    },
  )
})

test("v2 prompt hook leaves real-default sessions alone before first dispatch", async () => {
  const mock = mockContext(pluginOptions(), { providerID: "p", id: "normal" })
  let jevCalls = 0
  await withFetch(
    (async () => {
      jevCalls += 1
      return new Response(JSON.stringify(routeResponse("fast")), { status: 200 })
    }) as typeof fetch,
    async () => {
      await setupRouted(mock)
      await mock.hooks.prompt[0]?.(promptEvent("fix the typo"))
      assert.deepEqual(mock.switchedModels, [])
      assert.equal(jevCalls, 0)
    },
  )
})

test("v2 context hook detects a manual override and stops routing", async () => {
  const mock = mockContext(pluginOptions())
  await withFetch(
    (async () => new Response(JSON.stringify(routeResponse("fast")), { status: 200 })) as typeof fetch,
    async () => {
      await setupRouted(mock)

      await mock.hooks.prompt[0]?.(promptEvent("fix the typo"))
      assert.equal(mock.switchedModels.length, 1)
      const routed = (mock.switchedModels[0] as { model: Record<string, unknown> }).model

      await mock.hooks.context[0]?.(contextEvent(routed))

      await mock.hooks.context[0]?.(
        contextEvent({ providerID: "other", id: "model" }),
      )

      await mock.hooks.prompt[0]?.(promptEvent("another task"))
      assert.equal(mock.switchedModels.length, 1)
    },
  )
})

test("v2 context hook describes only the skills Jev selected for the task", async () => {
  // Given
  const mock = mockContext(pluginOptions(), { providerID: "p", id: "normal" })
  const codeMode = [
    "# Code Mode",
    "",
    "## Available tools",
    "",
    "- opencode (1 tool)",
    "  - tools.opencode.session_rename({ title: string }): Promise<string>",
    "",
    "<available_skills>",
    "  <skill>",
    "    <id>pdf</id>",
    "    <description>Read and edit PDF files.</description>",
    "  </skill>",
    "  <skill>",
    "    <id>docx</id>",
    "    <description>Create Word documents.</description>",
    "  </skill>",
    "</available_skills>",
  ].join("\n")
  const event = {
    ...contextEvent({ providerID: "p", id: "normal" }),
    system: [{ type: "text", text: codeMode }],
  }

  // When
  await withFetch(
    (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as { state: { candidates?: Array<{ name: string }> } }
      const candidates = body.state.candidates
      if (candidates === undefined) {
        return new Response(JSON.stringify(routeResponse("fast")), { status: 200 })
      }
      const answers = Object.fromEntries(
        candidates.map((item, index) => [`item_${index}`, { type: "noul", noul: item.name === "pdf" ? 0.9 : 0.05 }]),
      )
      return new Response(JSON.stringify({ answers }), { status: 200 })
    }) as typeof fetch,
    async () => {
      await setupRouted(mock)
      await mock.hooks.prompt[0]?.(promptEvent("fill the PDF form"))
      await mock.hooks.context[0]?.(event)
    },
  )

  // Then
  const narrowed = event.system[0]?.text ?? ""
  assert.match(narrowed, /<id>pdf<\/id>/)
  assert.doesNotMatch(narrowed, /<id>docx<\/id>/)
  assert.match(narrowed, /Other skills are available but not described here: docx\./)
  assert.match(narrowed, /tools\.opencode\.session_rename/)
})

test("v2 prompt hook routes a session-level Auto selection before first dispatch", async () => {
  const mock = mockContext(
    pluginOptions(),
    { providerID: "p", id: "normal" },
    VIRTUAL_MODEL,
  )
  await withFetch(
    (async () => new Response(JSON.stringify(routeResponse("normal")), { status: 200 })) as typeof fetch,
    async () => {
      await setupRouted(mock)

      await mock.hooks.prompt[0]?.(promptEvent("fix the typo"))

      assert.equal(mock.switchedModels.length, 1)
      const switched = mock.switchedModels[0] as { model: { providerID: string } }
      assert.ok(
        ["openai", "opencode-go", "my-glm"].includes(switched.model.providerID),
        "expected a subscription provider",
      )
    },
  )
})

test("v2 prompt hook leaves a session-level real selection alone before first dispatch", async () => {
  const mock = mockContext(
    pluginOptions(),
    VIRTUAL_MODEL,
    { providerID: "p", id: "normal" },
  )
  let jevCalls = 0
  await withFetch(
    (async () => {
      jevCalls += 1
      return new Response(JSON.stringify(routeResponse("fast")), { status: 200 })
    }) as typeof fetch,
    async () => {
      await setupRouted(mock)

      await mock.hooks.prompt[0]?.(promptEvent("fix the typo"))

      assert.deepEqual(mock.switchedModels, [])
      assert.equal(jevCalls, 0)
    },
  )
})

test("v2 model selection event stops routing after the user picks a real model", async () => {
  const mock = mockContext(pluginOptions())
  await withFetch(
    (async () => new Response(JSON.stringify(routeResponse("fast")), { status: 200 })) as typeof fetch,
    async () => {
      await setupRouted(mock)

      await mock.hooks.prompt[0]?.(promptEvent("fix the typo"))
      assert.equal(mock.switchedModels.length, 1)
      const routed = (mock.switchedModels[0] as { model: Record<string, unknown> }).model

      await mock.hooks.context[0]?.(contextEvent(routed))

      await mock.emit({
        type: "session.model.selected",
        data: {
          sessionID: "ses_1",
          model: { providerID: "other", id: "model" },
        },
      })

      await mock.hooks.prompt[0]?.(promptEvent("another task"))
      assert.equal(mock.switchedModels.length, 1)
    },
  )
})

test("v2 model selection event stops routing on a stale virtual mirror", async () => {
  const mock = mockContext(pluginOptions())
  let jevCalls = 0
  await withFetch(
    (async () => {
      jevCalls += 1
      return new Response(JSON.stringify(routeResponse("fast")), { status: 200 })
    }) as typeof fetch,
    async () => {
      await setupRouted(mock)

      await mock.hooks.context[0]?.(contextEvent(VIRTUAL_MODEL))

      await mock.emit({
        type: "session.model.selected",
        data: {
          sessionID: "ses_1",
          model: { providerID: "other", id: "model" },
        },
      })

      await mock.hooks.prompt[0]?.(promptEvent("another task"))
      assert.deepEqual(mock.switchedModels, [])
      assert.equal(jevCalls, 0)
    },
  )
})

test("v2 model selection event re-arms routing when Auto is picked again", async () => {
  const mock = mockContext(pluginOptions())
  await withFetch(
    (async () => new Response(JSON.stringify(routeResponse("fast")), { status: 200 })) as typeof fetch,
    async () => {
      await setupRouted(mock)

      await mock.hooks.prompt[0]?.(promptEvent("fix the typo"))
      assert.equal(mock.switchedModels.length, 1)
      const routed = (mock.switchedModels[0] as { model: Record<string, unknown> }).model

      await mock.hooks.context[0]?.(contextEvent(routed))

      await mock.emit({
        type: "session.model.selected",
        data: {
          sessionID: "ses_1",
          model: { providerID: "other", id: "model" },
        },
      })

      await mock.hooks.prompt[0]?.(promptEvent("another task"))
      assert.equal(mock.switchedModels.length, 1)

      await mock.emit({
        type: "session.model.selected",
        data: {
          sessionID: "ses_1",
          model: VIRTUAL_MODEL,
        },
      })

      await mock.hooks.prompt[0]?.(promptEvent("one more task"))
      assert.equal(mock.switchedModels.length, 2)
    },
  )
})

test("v2 prompt hook never routes a blacklisted provider", async () => {
  const mock = mockContext(
    pluginOptions({
      routing: { models: { referenceCatalog: "/nonexistent/opencode/models.json", exclude: ["my-glm"] } },
    }),
  )
  await withFetch(
    (async () => new Response(JSON.stringify(routeResponse("normal")), { status: 200 })) as typeof fetch,
    async () => {
      await setupRouted(mock)
      await mock.hooks.prompt[0]?.(promptEvent("fix the typo"))

      assert.equal(mock.switchedModels.length, 1)
      const switched = mock.switchedModels[0] as { model: { providerID: string } }
      assert.notEqual(switched.model.providerID, "my-glm")
    },
  )
})

test("v2 prompt hook stops routing to a subscription ai-usagebar no longer reports", async () => {
  const mock = mockContext(pluginOptions())
  const ledger = fakeQuotaLedger([], {
    subscriptions: [{ id: "zai", label: "Z.AI", requireOAuth: false }],
  })
  await withFetch(
    (async () => new Response(JSON.stringify(routeResponse("normal")), { status: 200 })) as typeof fetch,
    async () => {
      await setupRouted(mock, ledger)
      await mock.hooks.prompt[0]?.(promptEvent("fix the typo"))

      const switched = mock.switchedModels.map(
        (input) => (input as { model: { providerID: string } }).model.providerID,
      )
      assert.deepEqual(switched, ["my-glm"])
    },
  )
})

test("v2 step events persist measured model speed", async () => {
  const mock = mockContext(pluginOptions())
  await setupRouted(mock)

  await mock.emit({
    type: "session.step.started",
    created: 1_000,
    data: { sessionID: "ses_1", assistantMessageID: "m1", model: { providerID: "my-glm", id: "glm-5.3" } },
  })
  await mock.emit({
    type: "session.step.ended",
    created: 6_000,
    data: { sessionID: "ses_1", assistantMessageID: "m1", finish: "stop", tokens: { output: 500, reasoning: 0 } },
  })

  assert.deepEqual(await mock.ctx.storage.get("routing.speed"), {
    "my-glm/glm-5.3": { tokensPerSecond: 100, samples: 1 },
  })
})

test("v2 retry hook fails over to another subscription and keeps the failed provider out", async () => {
  const mock = mockContext(pluginOptions())
  await withFetch(
    (async () => new Response(JSON.stringify(routeResponse("normal")), { status: 200 })) as typeof fetch,
    async () => {
      await setupRouted(mock)
      await mock.hooks.prompt[0]?.(promptEvent("fix the typo"))
      const first = (mock.switchedModels[0] as { model: { providerID: string; id: string } }).model
      assert.equal(first.providerID, "my-glm")

      const event = {
        sessionID: "ses_1",
        agent: "build",
        model: { providerID: first.providerID, id: first.id },
        error: { type: "provider", message: "overloaded", status: 529 },
        attempt: 1,
        decision: { retry: false },
      }
      await mock.hooks.retry[0]?.(event)

      assert.deepEqual(event.decision, { retry: true, delay: 0 })
      const second = (mock.switchedModels[1] as { model: { providerID: string } }).model
      assert.notEqual(second.providerID, "my-glm")

      await mock.hooks.prompt[0]?.(promptEvent("fix another typo"))
      const third = (mock.switchedModels[2] as { model: { providerID: string } }).model
      assert.notEqual(third.providerID, "my-glm")
    },
  )
})
