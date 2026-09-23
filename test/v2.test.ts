import test from "node:test"
import assert from "node:assert/strict"

import { setupV2 } from "../src/v2.ts"

interface HookCalls {
  permission: Array<(event: any) => Promise<void> | void>
  prompt: Array<(event: any) => Promise<void> | void>
  context: Array<(event: any) => Promise<void> | void>
}

interface MockContext {
  ctx: any
  hooks: HookCalls
  switchedModels: unknown[]
  switchedAgents: unknown[]
  addedProviders: unknown[]
  permissionRequests: unknown[]
}

function mockContext(
  rawOptions: Record<string, unknown>,
  modelDefault: { providerID: string; id: string } | null = {
    providerID: "jev-model-router",
    id: "auto",
  },
): MockContext {
  const hooks: HookCalls = { permission: [], prompt: [], context: [] }
  const switchedModels: unknown[] = []
  const switchedAgents: unknown[] = []
  const addedProviders: unknown[] = []
  const permissionRequests: unknown[] = []

  const ctx = {
    app: { version: "2.0.15-test" },
    location: { directory: "/workspace" },
    options: rawOptions,
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
        name: "prompt" | "context",
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
        return { id: "ses_1" }
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
    model: {
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
              next: () => new Promise(() => {}) as Promise<IteratorResult<unknown>>,
            }
          },
        }
        return iterable
      },
    },
  }

  return { ctx, hooks, switchedModels, switchedAgents, addedProviders, permissionRequests }
}

function routerOptions(extra: Record<string, unknown> = {}) {
  return {
    decision: { apiKey: "test", retries: 0 },
    router: {
      enabled: true,
      sticky: true,
      models: {
        fast: "p/fast",
        normal: "p/normal",
        deep: "p/deep",
      },
    },
    agents: { enabled: false },
    context: { enabled: false },
    ...extra,
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
  const mock = mockContext(routerOptions())
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
  const mock = mockContext({
    decision: { apiKey: "test", retries: 0 },
    router: { enabled: false },
    agents: { enabled: false },
    context: { enabled: false },
  })
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
  const mock = mockContext({
    decision: { apiKey: "test", retries: 0 },
    router: { enabled: false },
    agents: { enabled: false },
    context: { enabled: false },
  })
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
  const mock = mockContext({
    decision: { apiKey: "test", retries: 0 },
    router: { enabled: false },
    agents: { enabled: false },
    context: { enabled: false },
  })
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
  const mock = mockContext({
    decision: { apiKey: "test", retries: 0 },
    router: { enabled: false },
    agents: { enabled: false },
    context: { enabled: false },
  })
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

test("v2 prompt hook switches a virtual session to the routed tier", async () => {
  const mock = mockContext(routerOptions())
  await withFetch(
    (async () => new Response(JSON.stringify(routeResponse("fast")), { status: 200 })) as typeof fetch,
    async () => {
      await setupV2(mock.ctx)
      assert.equal(mock.hooks.prompt.length, 1)

      await mock.hooks.prompt[0]?.({
        sessionID: "ses_1",
        prompt: { text: "fix the typo" },
        delivery: "steer",
      })

      assert.deepEqual(mock.switchedModels, [
        { sessionID: "ses_1", model: { providerID: "p", id: "fast" } },
      ])
    },
  )
})

test("v2 prompt hook routes the agent by domain", async () => {
  const mock = mockContext(
    routerOptions({
      agents: { enabled: true, minimumProbability: 0.85, byDomain: { backend: "backend" } },
    }),
  )
  await withFetch(
    (async () =>
      new Response(JSON.stringify(routeResponse("normal", 0.95, "backend")), {
        status: 200,
      })) as typeof fetch,
    async () => {
      await setupV2(mock.ctx)
      await mock.hooks.prompt[0]?.({
        sessionID: "ses_1",
        prompt: { text: "migrate the database layer" },
        delivery: "steer",
      })
      assert.deepEqual(mock.switchedAgents, [{ sessionID: "ses_1", agent: "backend" }])
    },
  )
})

test("v2 prompt hook skips routing once the user selects a real model", async () => {
  const mock = mockContext(routerOptions())
  await withFetch(
    (async () => new Response(JSON.stringify(routeResponse("fast")), { status: 200 })) as typeof fetch,
    async () => {
      await setupV2(mock.ctx)

      // First dispatch observed a real model: mirror is not virtual.
      await mock.hooks.context[0]?.({
        sessionID: "ses_1",
        agent: "build",
        model: { providerID: "p", id: "normal" },
        system: [],
        messages: [],
        tools: {},
        options: {},
      })

      await mock.hooks.prompt[0]?.({
        sessionID: "ses_1",
        prompt: { text: "fix the typo" },
        delivery: "steer",
      })

      assert.deepEqual(mock.switchedModels, [])
    },
  )
})

test("v2 prompt hook leaves real-default sessions alone before first dispatch", async () => {
  const mock = mockContext(routerOptions(), { providerID: "p", id: "normal" })
  let jevCalls = 0
  await withFetch(
    (async () => {
      jevCalls += 1
      return new Response(JSON.stringify(routeResponse("fast")), { status: 200 })
    }) as typeof fetch,
    async () => {
      await setupV2(mock.ctx)
      await mock.hooks.prompt[0]?.({
        sessionID: "ses_1",
        prompt: { text: "fix the typo" },
        delivery: "steer",
      })
      assert.deepEqual(mock.switchedModels, [])
      assert.equal(jevCalls, 0)
    },
  )
})

test("v2 context hook detects a manual override and stops routing", async () => {
  const mock = mockContext(routerOptions())
  await withFetch(
    (async () => new Response(JSON.stringify(routeResponse("fast")), { status: 200 })) as typeof fetch,
    async () => {
      await setupV2(mock.ctx)

      await mock.hooks.prompt[0]?.({
        sessionID: "ses_1",
        prompt: { text: "fix the typo" },
        delivery: "steer",
      })
      assert.equal(mock.switchedModels.length, 1)

      // Dispatch ran on our routed model: routing stays armed.
      await mock.hooks.context[0]?.({
        sessionID: "ses_1",
        agent: "build",
        model: { providerID: "p", id: "fast" },
        system: [],
        messages: [],
        tools: {},
        options: {},
      })

      // User manually switched to an unrelated model.
      await mock.hooks.context[0]?.({
        sessionID: "ses_1",
        agent: "build",
        model: { providerID: "other", id: "model" },
        system: [],
        messages: [],
        tools: {},
        options: {},
      })

      await mock.hooks.prompt[0]?.({
        sessionID: "ses_1",
        prompt: { text: "another task" },
        delivery: "steer",
      })
      assert.equal(mock.switchedModels.length, 1)
    },
  )
})
