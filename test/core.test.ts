import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Hooks } from "@opencode-ai/plugin"
import {
  VIRTUAL_MODEL_REF,
  parseModelRef,
  resolveOptions,
} from "../src/config.ts"
import { classifyPermission, requirementsFromRoute } from "../src/classifier.ts"
import { filterLargeToolContext, filterText } from "../src/context.ts"
import { JevClient } from "../src/jev.ts"
import type {
  ActiveSubscription,
  PoolPressure,
  QuotaLedger,
  QuotaPoolState,
} from "../src/routing/contracts.ts"
import {
  OpenCodeClassifierPlugin,
  installVirtualProvider,
  snapshotModelInventory,
} from "../src/v1.ts"
import { decidePermission } from "../src/permission.ts"
import { eventSessionID } from "../src/runtime.ts"
import type { RouteClassification } from "../src/types.ts"

function options(extra: Record<string, unknown> = {}) {
  return resolveOptions(extra)
}

function safeSignals(overrides: Record<string, number> = {}) {
  return {
    readOnly: 0.99,
    modifiesProjectFiles: 0.01,
    outsideWorkspace: 0.01,
    destructive: 0.01,
    reversible: 0.99,
    changesVcsHistory: 0.01,
    executesDownloadedCode: 0.01,
    externalSideEffect: 0.01,
    sensitiveData: 0.01,
    privilegeEscalation: 0.01,
    ...overrides,
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

function routeClassification(
  overrides: Partial<RouteClassification> = {},
): RouteClassification {
  return {
    complexity: "normal",
    complexityProbability: 0.5,
    deepReasoning: 0.1,
    highRisk: 0.1,
    research: 0.1,
    ...overrides,
  }
}

function taskEstimates() {
  return {
    estimatedInputTokens: 4_000,
    estimatedOutputTokens: 1_000,
    needsTools: true,
    needsVision: false,
    estimatedTurns: 3,
  }
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
      Object.entries(values).map(([key, noul]) => [
        key,
        { type: "noul", noul },
      ]),
    ),
  }
}

function pluginInput() {
  const permissionReplies: unknown[] = []
  const client = {
    permission: {
      async reply(input: unknown) {
        permissionReplies.push(input)
        return {}
      },
    },
  }

  return {
    input: {
      client,
      project: {},
      directory: "/workspace",
      worktree: "/workspace",
      experimental_workspace: { register() {} },
      serverUrl: new URL("http://localhost:4096"),
      $: {},
    } as any,
    permissionReplies,
  }
}

function userOutput(
  providerID = "jev-model-router",
  modelID = "auto",
  text = "fix the bug",
) {
  return {
    message: {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID, modelID },
    },
    parts: [
      {
        id: "part_1",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "text",
        text,
      },
    ],
  } as any
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

function routeHandler(
  complexity: "fast" | "normal" | "deep" = "normal",
): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(routeResponse(complexity, 0.95)), {
      status: 200,
    })) as typeof fetch
}

interface FakeQuotaPool {
  poolID: string
  usedPercent: number | null
}

/** What `ai-usagebar` reports by default: Codex by OAuth, Go and Z.AI by key. */
const DEFAULT_SUBSCRIPTIONS: readonly ActiveSubscription[] = [
  { id: "openai", label: "Codex (ChatGPT Team)", requireOAuth: true },
  { id: "opencode-go", label: "OpenCode Go", requireOAuth: false },
  { id: "zai", label: "Z.AI (GLM Coding Pro)", requireOAuth: false },
]

function fakeQuotaLedger(
  pools: readonly FakeQuotaPool[],
  subscriptions: readonly ActiveSubscription[] = DEFAULT_SUBSCRIPTIONS,
): QuotaLedger {
  const states: QuotaPoolState[] = pools.map((pool): QuotaPoolState => {
    const used = pool.usedPercent
    const status =
      used === null ? "unknown" : used >= 100 ? "exhausted" : "available"
    return {
      poolID: pool.poolID,
      label: pool.poolID,
      status,
      windows:
        used === null
          ? []
          : [
              {
                id: "weekly",
                label: "weekly",
                windowSecs: null,
                usedPercent: used,
                resetsAt: null,
                dimension: "inference",
              },
            ],
      fetchedAt: null,
      error: null,
    }
  })

  const pressure = (poolID: string): PoolPressure => {
    const state = states.find((entry) => entry.poolID === poolID)
    const worst = state?.windows[0]?.usedPercent ?? null
    const known =
      state !== undefined && state.status !== "unknown" && worst !== null
    return {
      poolID,
      known,
      worstUsedPercent: worst,
      headroomRatio: known ? Math.max(0, 1 - (worst ?? 0) / 100) : null,
      status: state?.status ?? "unknown",
      nextResetAt: null,
    }
  }

  return {
    pools: () => states,
    pool: (poolID) => states.find((entry) => entry.poolID === poolID),
    pressure,
    subscriptions: () => subscriptions,
    refresh: async () => {},
    dispose: () => {},
  }
}

function hostProviderConfig(
  providers: Record<string, string[]>,
): Record<string, unknown> {
  const provider: Record<string, unknown> = {}
  for (const [providerID, modelIDs] of Object.entries(providers)) {
    provider[providerID] = {
      npm: "@ai-sdk/openai-compatible",
      name: providerID,
      options: {},
      models: Object.fromEntries(
        modelIDs.map((modelID) => [modelID, { name: modelID }]),
      ),
    }
  }
  return { provider }
}

async function routingHarness(options: {
  providers: Record<string, string[]>
  pools?: readonly FakeQuotaPool[]
  plugin?: Record<string, unknown>
  ledger?: QuotaLedger
}) {
  const config = hostProviderConfig(options.providers)
  const ledger = options.ledger ?? fakeQuotaLedger(options.pools ?? [])
  const mock = pluginInput()
  const plugin = options.plugin ?? {}
  const hooks = await OpenCodeClassifierPlugin(
    mock.input,
    {
      decision: { apiKey: "test", retries: 0 },
      ...plugin,
      routing: {
        models: {
          referenceCatalog: "/nonexistent/opencode/models.json",
          providerAliases: { "my-glm": "zai-coding-plan" },
          ...((plugin.routing as { models?: Record<string, unknown> } | undefined)?.models),
        },
      },
    },
    { createLedger: () => ledger },
  )
  await hooks.config?.(config as never)
  return { config, hooks, ledger, mock }
}

function virtualTurn(text = "fix the bug") {
  const output = userOutput("jev-model-router", "auto", text)
  output.message.model.variant = "max"
  return output
}

async function sendTurn(
  hooks: Hooks,
  providerID: string,
  modelID: string,
  text: string,
) {
  const output = userOutput(providerID, modelID, text)
  await hooks["chat.message"]?.({ sessionID: "ses_1" } as never, output)
  return output
}

async function collectDirective(
  hooks: Hooks,
  providerID: string,
  modelID: string,
): Promise<string> {
  const system: string[] = []
  await hooks["experimental.chat.system.transform"]?.(
    { sessionID: "ses_1", model: { providerID, id: modelID } } as never,
    { system } as never,
  )
  return system.join("\n")
}

test("virtual model ref is stable", () => {
  assert.equal(VIRTUAL_MODEL_REF, "jev-model-router/auto")
})

test("parseModelRef preserves nested ids and variants", () => {
  assert.deepEqual(parseModelRef("openrouter/anthropic/claude#high"), {
    providerID: "openrouter",
    id: "anthropic/claude",
    variant: "high",
  })
})

test("configuration resolves zero-config routing without a router block", () => {
  const resolved = resolveOptions({}).routing.models
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.safetyMargin, 0.1)
  assert.deepEqual(resolved.exclude, [])
  assert.deepEqual(resolved.quota, {
    enabled: true,
    binary: "ai-usagebar",
    args: ["usage", "--json"],
    vendorArgs: ["vendors", "--json"],
    timeoutMs: 8_000,
    refreshSeconds: 120,
  })
  assert.deepEqual(resolved.thresholds, {
    fastChoice: 0.72,
    deepChoice: 0.58,
    deepReasoning: 0.72,
    highRisk: 0.72,
  })
})

test("configuration clamps routing safety margin and quota refresh window", () => {
  const clamped = resolveOptions({
    routing: { models: { safetyMargin: 5, quota: { refreshSeconds: 1 } } },
  }).routing.models
  const floored = resolveOptions({
    routing: { models: { safetyMargin: -2, quota: { refreshSeconds: 99_999 } } },
  }).routing.models
  assert.equal(clamped.safetyMargin, 0.9)
  assert.equal(clamped.quota.refreshSeconds, 30)
  assert.equal(floored.safetyMargin, 0)
  assert.equal(floored.quota.refreshSeconds, 3_600)
})

test("requirements map confident mechanical work to the economy tier", () => {
  const requirements = requirementsFromRoute(
    routeClassification({ complexity: "fast", complexityProbability: 0.9 }),
    options(),
    taskEstimates(),
  )
  assert.equal(requirements.tier, "economy")
  assert.equal(requirements.maxEffort, "low")
  assert.equal(requirements.needsReasoning, false)
  assert.equal(requirements.complexity, "fast")
  assert.equal(requirements.needsTools, true)
  assert.equal(requirements.estimatedTurns, 3)
  assert.equal(requirements.prefersSpeed, true)
})

test("requirements map uncertain work to the balanced tier", () => {
  const requirements = requirementsFromRoute(
    routeClassification({ complexity: "fast", complexityProbability: 0.4 }),
    options(),
    taskEstimates(),
  )
  assert.equal(requirements.tier, "balanced")
  assert.equal(requirements.maxEffort, "high")
  assert.equal(requirements.needsReasoning, true)
  assert.equal(requirements.prefersSpeed, false)
})

test("requirements promote deep complexity, deep reasoning and high risk to the advanced tier", () => {
  const configured = options()
  const deepComplexity = requirementsFromRoute(
    routeClassification({ complexity: "deep", complexityProbability: 0.9 }),
    configured,
    taskEstimates(),
  )
  const deepReasoning = requirementsFromRoute(
    routeClassification({ deepReasoning: 0.8 }),
    configured,
    taskEstimates(),
  )
  const highRisk = requirementsFromRoute(
    routeClassification({ highRisk: 0.75 }),
    configured,
    taskEstimates(),
  )
  assert.equal(deepComplexity.tier, "advanced")
  assert.equal(deepComplexity.maxEffort, "max")
  assert.equal(deepComplexity.needsReasoning, true)
  assert.equal(deepComplexity.prefersSpeed, false)
  assert.equal(deepReasoning.tier, "advanced")
  assert.equal(highRisk.tier, "advanced")
})

test("research raises the effort ceiling by one step and never past max", () => {
  const configured = options()
  const belowBump = requirementsFromRoute(
    routeClassification({ complexity: "fast", complexityProbability: 0.9, research: 0.2 }),
    configured,
    taskEstimates(),
  )
  const economyWithResearch = requirementsFromRoute(
    routeClassification({ complexity: "fast", complexityProbability: 0.9, research: 0.9 }),
    configured,
    taskEstimates(),
  )
  const balancedWithResearch = requirementsFromRoute(
    routeClassification({ research: 0.9 }),
    configured,
    taskEstimates(),
  )
  const advancedWithResearch = requirementsFromRoute(
    routeClassification({ complexity: "deep", complexityProbability: 0.9, research: 0.9 }),
    configured,
    taskEstimates(),
  )
  assert.equal(belowBump.maxEffort, "low")
  assert.equal(economyWithResearch.tier, "economy")
  assert.equal(economyWithResearch.maxEffort, "medium")
  assert.equal(balancedWithResearch.maxEffort, "max")
  assert.equal(advancedWithResearch.maxEffort, "max")
})

test("permission policy allows read-only and reversible local changes", () => {
  assert.equal(decidePermission("ask", safeSignals(), options()).effect, "allow")
  assert.equal(
    decidePermission(
      "ask",
      safeSignals({
        readOnly: 0.05,
        modifiesProjectFiles: 0.96,
        reversible: 0.97,
      }),
      options(),
    ).effect,
    "allow",
  )
})

test("permission policy escalates outside-workspace and VCS-history risk", () => {
  assert.equal(
    decidePermission(
      "ask",
      safeSignals({ outsideWorkspace: 0.95, modifiesProjectFiles: 0.8 }),
      options(),
    ).effect,
    "ask",
  )
  assert.equal(
    decidePermission(
      "ask",
      safeSignals({ changesVcsHistory: 0.95, modifiesProjectFiles: 0.8 }),
      options(),
    ).effect,
    "ask",
  )
})

test("permission policy escalates command deny rules to ask instead of denying", () => {
  // Given
  const configured = resolveOptions({
    autoMode: {
      commandRules: {
        deny: ["git push *"],
        ask: ["git push origin main"],
      },
    },
  })

  // When
  const decision = decidePermission("ask", safeSignals(), configured, {
    action: "bash",
    resources: ["git push origin main"],
  })

  // Then
  assert.equal(decision.effect, "ask")
})

test("permission policy keeps explicit command ask rules as user checkpoints", () => {
  // Given
  const configured = resolveOptions({
    autoMode: {
      commandRules: {
        ask: ["npm publish"],
      },
    },
  })

  // When
  const decision = decidePermission("ask", safeSignals(), configured, {
    action: "bash",
    resources: ["npm publish"],
  })

  // Then
  assert.equal(decision.effect, "ask")
})

test("permission policy escalates critical destruction to ask instead of denying", () => {
  // Given
  const configured = options()

  // When
  const decision = decidePermission("ask", safeSignals(), configured, {
    action: "bash",
    resources: ["rm -rf /"],
  })

  // Then
  assert.equal(decision.effect, "ask")
})

test("permission metadata is omitted by default and opt-in when configured", async () => {
  let state: unknown
  const fakeJev = {
    async ask(nextState: unknown, questions: Record<string, unknown>) {
      state = nextState
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [
            key,
            { type: "noul", noul: key === "read_only" || key === "reversible" ? 0.9 : 0.1 },
          ]),
        ),
      }
    },
  } as unknown as JevClient

  await classifyPermission(fakeJev, options(), {
    action: "bash",
    resources: ["git status"],
    metadata: { secretLike: "do-not-send" },
  })
  assert.deepEqual(state, { action: "bash", resources: ["git status"] })

  const configured = options({
    privacy: { includePermissionMetadata: true },
  })
  await classifyPermission(fakeJev, configured, {
    action: "bash",
    resources: ["git status"],
    metadata: { reason: "context" },
  })
  assert.equal(
    (state as { metadata?: string }).metadata,
    JSON.stringify({ reason: "context" }),
  )
})

test("runtime recognizes classic event session IDs", () => {
  assert.equal(eventSessionID({ sessionID: "direct" }), "direct")
  assert.equal(
    eventSessionID({ type: "session.idle", properties: { sessionID: "nested" } }),
    "nested",
  )
  assert.equal(
    eventSessionID({
      type: "message.part.updated",
      properties: { part: { sessionID: "tool-session" } },
    }),
    "tool-session",
  )
})

test("System One retries a timed-out attempt with a fresh signal", async () => {
  const configured = options({
    decision: {
      apiKey: "test",
      timeoutMs: 5,
      retries: 1,
    },
  })
  let calls = 0

  await withFetch(
    (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      if (calls === 1) {
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          )
        })
      }
      return new Response(
        JSON.stringify({ answers: { ok: { type: "noul", noul: 0.9 } } }),
        { status: 200 },
      )
    }) as typeof fetch,
    async () => {
      const client = new JevClient(configured)
      const response = await client.ask("state", {
        ok: { type: "noul", instructions: "ok?" },
      })
      assert.equal(calls, 2)
      assert.equal(response.answers.ok?.type, "noul")
    },
  )
})

test("System One does not retry definitive 401 responses", async () => {
  const configured = options({
    decision: { apiKey: "test", retries: 3 },
  })
  let calls = 0

  await withFetch(
    (async () => {
      calls += 1
      return new Response("unauthorized", { status: 401 })
    }) as typeof fetch,
    async () => {
      await assert.rejects(
        () =>
          new JevClient(configured).ask("state", {
            ok: { type: "noul", instructions: "ok?" },
          }),
        /HTTP 401/,
      )
      assert.equal(calls, 1)
    },
  )
})

test("System One retries 429 and rejects incomplete responses", async () => {
  const configured = options({
    decision: { apiKey: "test", retries: 1 },
  })
  let calls = 0

  await withFetch(
    (async () => {
      calls += 1
      if (calls === 1) return new Response("rate limited", { status: 429 })
      return new Response(JSON.stringify({ answers: {} }), { status: 200 })
    }) as typeof fetch,
    async () => {
      await assert.rejects(
        () =>
          new JevClient(configured).ask("state", {
            ok: { type: "noul", instructions: "ok?" },
          }),
        /missing answer "ok"/,
      )
      assert.equal(calls, 2)
    },
  )
})

test("context filtering supports OpenCode 1.18 ToolPart.state.output and cache", async () => {
  const configured = options()
  configured.context.toolOutput = {
    ...configured.context.toolOutput,
    minChars: 1_000,
    chunkChars: 1_000,
    minimumCandidates: 2,
    maxCandidates: 4,
    maxBatches: 2,
    relevantAt: 0.5,
  }
  configured.privacy = { ...configured.privacy, maxStateChars: 8_000 }

  let calls = 0
  const fakeJev = {
    async ask(_state: unknown, questions: Record<string, unknown>) {
      calls += 1
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [
            key,
            { type: "noul", noul: key.endsWith("_0") ? 0.1 : 0.9 },
          ]),
        ),
      }
    },
  } as unknown as JevClient

  const source = "A".repeat(1_000) + "B".repeat(1_000)
  const cache = new Map<string, string | undefined>()

  const makeMessages = () => [
    {
      info: { role: "assistant", sessionID: "ses_1" },
      parts: [
        {
          type: "tool",
          state: {
            status: "completed",
            output: source,
          },
        },
      ],
    },
  ]

  const first = makeMessages()
  await filterLargeToolContext(fakeJev, configured, "find evidence", first, cache)
  const firstOutput = first[0]!.parts[0]!.state.output
  assert.ok(firstOutput.length < source.length)
  assert.ok(!firstOutput.includes("A".repeat(100)))
  assert.ok(firstOutput.includes("B".repeat(100)))
  assert.equal(calls, 1)

  const second = makeMessages()
  await filterLargeToolContext(fakeJev, configured, "find evidence", second, cache)
  assert.equal(second[0]!.parts[0]!.state.output, firstOutput)
  assert.equal(calls, 1)
})

test("context filtering batches outputs larger than a single privacy request", async () => {
  const configured = options()
  configured.context.toolOutput = {
    ...configured.context.toolOutput,
    minChars: 1_000,
    chunkChars: 1_000,
    minimumCandidates: 2,
    maxCandidates: 2,
    maxBatches: 2,
    relevantAt: 0.5,
  }
  configured.privacy = { ...configured.privacy, maxStateChars: 4_000 }

  let calls = 0
  const fakeJev = {
    async ask(_state: unknown, questions: Record<string, unknown>) {
      calls += 1
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => {
            const index = Number(key.replace("chunk_", ""))
            return [key, { type: "noul", noul: index % 2 === 0 ? 0.1 : 0.9 }]
          }),
        ),
      }
    },
  } as unknown as JevClient

  const source =
    "A".repeat(1_000) +
    "B".repeat(1_000) +
    "C".repeat(1_000) +
    "D".repeat(1_000) +
    "E".repeat(1_000)

  const filtered = await filterText(fakeJev, configured, "find evidence", source)
  assert.ok(filtered)
  assert.equal(calls, 2)
  assert.ok(filtered.includes("B".repeat(100)))
  assert.ok(filtered.includes("D".repeat(100)))
  assert.ok(filtered.includes("E".repeat(100)))
})

test("config hook installs selectable jev model router provider", () => {
  const config: any = { provider: {} }
  installVirtualProvider(config)

  assert.equal(config.provider["jev-model-router"].name, "jev model router")
  assert.equal(
    config.provider["jev-model-router"].npm,
    "@ai-sdk/openai-compatible",
  )
  assert.equal(
    config.provider["jev-model-router"].models.auto.name,
    "Auto (Jev)",
  )
})

test("config hook snapshots every provider except the virtual router", () => {
  const config = hostProviderConfig({
    "opencode-go": ["glm-5.3", "glm-5.3-flash"],
    "my-glm": ["glm-5.3"],
    openai: ["gpt-6.1-sol"],
    opencode: ["gpt-5.6"],
  })
  installVirtualProvider(config as never)

  const snapshot = snapshotModelInventory(config)
  assert.deepEqual([...(snapshot.get("opencode-go") ?? [])], [
    "glm-5.3",
    "glm-5.3-flash",
  ])
  assert.deepEqual([...(snapshot.get("my-glm") ?? [])], ["glm-5.3"])
  assert.deepEqual([...(snapshot.get("openai") ?? [])], ["gpt-6.1-sol"])
  assert.deepEqual([...(snapshot.get("opencode") ?? [])], ["gpt-5.6"])
  assert.equal(snapshot.has("jev-model-router"), false)
})

test("model inventory snapshot tolerates malformed config shapes", () => {
  assert.equal(snapshotModelInventory({}).size, 0)
  assert.equal(snapshotModelInventory({ provider: null }).size, 0)
  assert.equal(snapshotModelInventory(undefined).size, 0)

  const weird = hostProviderConfig({ "my-glm": ["glm-5.3"] })
  ;(weird as any).provider["my-glm"] = {
    models: { "glm-5.3": {}, "  ": {}, "not-an-entry": 42 },
  }
  const snapshot = snapshotModelInventory(weird)
  assert.deepEqual([...(snapshot.get("my-glm") ?? [])], ["glm-5.3"])
})

test("disabling routing skips the virtual provider install", async () => {
  const mock = pluginInput()
  const hooks = await OpenCodeClassifierPlugin(mock.input, {
    routing: { enabled: false },
  })
  const config = hostProviderConfig({ "opencode-go": ["glm-5.3"] })

  await hooks.config?.(config as never)

  assert.equal((config as any).provider["jev-model-router"], undefined)
})

test("chat.message routes a virtual turn to a subscription model and drops the stale variant", async () => {
  await withFetch(routeHandler("normal"), async () => {
    const { hooks } = await routingHarness({
      providers: {
        "opencode-go": ["glm-5.3", "glm-5.3-flash"],
        "my-glm": ["glm-5.3"],
      },
    })

    const output = virtualTurn()
    await hooks["chat.message"]?.({ sessionID: "ses_1" } as never, output)

    const providerID = output.message.model.providerID
    assert.ok(
      providerID === "opencode-go" || providerID === "my-glm",
      `expected a subscription provider, got ${String(providerID)}`,
    )
    assert.equal(output.message.model.variant, undefined)

    const guidance = await collectDirective(
      hooks,
      providerID,
      output.message.model.modelID,
    )
    assert.match(guidance, /Classifier guidance:/)
    assert.match(guidance, /(opencode-go|my-glm)\//)
  })
})

test("OAuth-bound subscriptions are excluded on V1 with a trace line", async () => {
  const logPath = join(tmpdir(), `core.test.v1-trace-${process.pid}.log`)
  rmSync(logPath, { force: true })
  const previousLog = process.env.OPENCODE_CLASSIFIER_LOG
  process.env.OPENCODE_CLASSIFIER_LOG = logPath

  try {
    await withFetch(routeHandler("normal"), async () => {
      const { hooks } = await routingHarness({
        providers: { openai: ["gpt-6.1-sol"], "my-glm": ["glm-5.3"] },
      })

      const output = virtualTurn()
      await hooks["chat.message"]?.({ sessionID: "ses_1" } as never, output)

      assert.equal(output.message.model.providerID, "my-glm")
      assert.equal(output.message.model.modelID, "glm-5.3")

      const excluded = readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.includes("v1 subscription association"))
      assert.equal(excluded.length, 1)
      assert.match(excluded.join("\n"), /openai:openai/)
    })
  } finally {
    if (previousLog === undefined) delete process.env.OPENCODE_CLASSIFIER_LOG
    else process.env.OPENCODE_CLASSIFIER_LOG = previousLog
  }
})

test("a pay-as-you-go provider in the config is never routed to", async () => {
  await withFetch(routeHandler("normal"), async () => {
    const { hooks } = await routingHarness({
      providers: { opencode: ["gpt-5.6"], "opencode-go": ["glm-5.3-flash"] },
    })

    const output = virtualTurn()
    await hooks["chat.message"]?.({ sessionID: "ses_1" } as never, output)

    assert.equal(output.message.model.providerID, "opencode-go")
    assert.equal(output.message.model.modelID, "glm-5.3-flash")
  })
})

test("zero verifiable subscription models leave the turn untouched with a manual-pick directive", async () => {
  await withFetch(routeHandler("normal"), async () => {
    const { hooks } = await routingHarness({
      providers: { opencode: ["gpt-5.6"], openai: ["gpt-6.1-sol"] },
    })

    const output = virtualTurn()
    await hooks["chat.message"]?.({ sessionID: "ses_1" } as never, output)

    assert.equal(output.message.model.providerID, "jev-model-router")
    assert.equal(output.message.model.modelID, "auto")
    assert.equal(output.message.model.variant, "max")

    const guidance = await collectDirective(hooks, "jev-model-router", "auto")
    assert.match(guidance, /Select a model manually/)
  })
})

test("sticky continuation keeps routing on the chosen model and disarms on a manual override", async () => {
  await withFetch(routeHandler("normal"), async () => {
    const { hooks } = await routingHarness({
      providers: { "opencode-go": ["glm-5.3"], "my-glm": ["glm-5.3"] },
      pools: [
        { poolID: "opencode-go", usedPercent: 10 },
        { poolID: "zai", usedPercent: 10 },
      ],
    })

    const first = virtualTurn()
    await hooks["chat.message"]?.({ sessionID: "ses_1" } as never, first)
    const target = first.message.model
    assert.notEqual(target.providerID, "jev-model-router")

    const second = await sendTurn(
      hooks,
      target.providerID,
      target.modelID,
      "and then finish it",
    )
    assert.equal(second.message.model.providerID, target.providerID)
    assert.equal(second.message.model.modelID, target.modelID)

    const manual = await sendTurn(hooks, "opencode", "gpt-5.6", "manual choice")
    assert.deepEqual(manual.message.model, {
      providerID: "opencode",
      modelID: "gpt-5.6",
    })
  })
})

test("an exhausted quota pool steers the turn to another subscription model", async () => {
  await withFetch(routeHandler("normal"), async () => {
    const { hooks } = await routingHarness({
      providers: { "opencode-go": ["glm-5.3"], "my-glm": ["glm-5.3"] },
      pools: [
        { poolID: "opencode-go", usedPercent: 100 },
        { poolID: "zai", usedPercent: 4 },
      ],
    })

    const output = virtualTurn()
    await hooks["chat.message"]?.({ sessionID: "ses_1" } as never, output)

    assert.equal(output.message.model.providerID, "my-glm")
    assert.equal(output.message.model.modelID, "glm-5.3")

    const guidance = await collectDirective(hooks, "my-glm", "glm-5.3")
    assert.match(guidance, /opencode-go exhausted/)
  })
})

test("routing relaxes the quality floor by one band when no model meets it", async () => {
  await withFetch(routeHandler("deep"), async () => {
    const { hooks } = await routingHarness({
      providers: { "opencode-go": ["glm-5.3-flash"] },
    })

    const output = virtualTurn()
    await hooks["chat.message"]?.({ sessionID: "ses_1" } as never, output)

    assert.equal(output.message.model.providerID, "opencode-go")
    assert.equal(output.message.model.modelID, "glm-5.3-flash")
  })
})

test("a failed Jev classification still routes with balanced defaults", async () => {
  await withFetch(
    (async () => new Response("server exploded", { status: 500 })) as typeof fetch,
    async () => {
      const { hooks } = await routingHarness({
        providers: { "opencode-go": ["glm-5.3-flash"] },
      })

      const output = virtualTurn()
      await hooks["chat.message"]?.({ sessionID: "ses_1" } as never, output)

      assert.equal(output.message.model.providerID, "opencode-go")

      const guidance = await collectDirective(
        hooks,
        output.message.model.providerID,
        output.message.model.modelID,
      )
      assert.match(guidance, /classification failed/i)
    },
  )
})

test("disabling the quota ledger still routes under unknown quota", async () => {
  await withFetch(routeHandler("normal"), async () => {
    const { hooks } = await routingHarness({
      providers: { "opencode-go": ["glm-5.3-flash"] },
      plugin: { routing: { models: { quota: { enabled: false } } } },
    })

    const output = virtualTurn()
    await hooks["chat.message"]?.({ sessionID: "ses_1" } as never, output)

    assert.equal(output.message.model.providerID, "opencode-go")
  })
})

test("dispose disposes the quota ledger", async () => {
  let disposed = false
  const base = fakeQuotaLedger([])
  const tracked: QuotaLedger = {
    ...base,
    dispose: () => {
      disposed = true
    },
  }
  const { hooks } = await routingHarness({
    providers: { "opencode-go": ["glm-5.3"] },
    ledger: tracked,
  })

  await hooks.dispose?.()

  assert.equal(disposed, true)
})


test("agent routing works with a manually selected real model", async () => {
  const mock = pluginInput()

  await withFetch(
    (async () =>
      new Response(JSON.stringify(routeResponse("normal", 0.95, "backend")), {
        status: 200,
      })) as typeof fetch,
    async () => {
      const hooks = await OpenCodeClassifierPlugin(mock.input, {
        decision: { apiKey: "test", retries: 0 },
        routing: {
          agents: {
            enabled: true,
            minimumProbability: 0.8,
            byDomain: { backend: "backend-specialist" },
          },
        },
      })

      const output = userOutput("opencode-go", "gpt-5.6-luna")
      await hooks["chat.message"]?.({ sessionID: "ses_1" } as any, output)
      assert.equal(output.message.agent, "backend-specialist")
      assert.deepEqual(output.message.model, {
        providerID: "opencode-go",
        modelID: "gpt-5.6-luna",
      })
    },
  )
})

test("Auto Mode allows safe permission requests and keeps risky requests as ask", async () => {
  const mock = pluginInput()

  await withFetch(
    (async () =>
      new Response(JSON.stringify(permissionResponse()), {
        status: 200,
      })) as typeof fetch,
    async () => {
      const hooks = await OpenCodeClassifierPlugin(mock.input, {
        decision: { apiKey: "test", retries: 0 },
      })

      const safe = { status: "ask" as const }
      await hooks["permission.ask"]?.(
        {
          id: "perm_1",
          type: "read",
          pattern: ["src/**"],
          sessionID: "ses_1",
          messageID: "msg_1",
          callID: "call_read",
          title: "Read source",
          metadata: {},
          time: { created: Date.now() },
        },
        safe,
      )
      assert.equal(safe.status, "allow")
    },
  )

  const risky = pluginInput()
  await withFetch(
    (async () =>
      new Response(
        JSON.stringify(permissionResponse({ destructive: 0.95 })),
        { status: 200 },
      )) as typeof fetch,
    async () => {
      const hooks = await OpenCodeClassifierPlugin(risky.input, {
        decision: { apiKey: "test", retries: 0 },
      })

      const request = { status: "ask" as const }
      await hooks["permission.ask"]?.(
        {
          id: "perm_2",
          type: "bash",
          pattern: ["rm -rf dist"],
          sessionID: "ses_1",
          messageID: "msg_1",
          callID: "call_delete",
          title: "Delete files",
          metadata: {},
          time: { created: Date.now() },
        },
        request,
      )
      assert.equal(request.status, "ask")
    },
  )
})

test("Auto Mode preserves an explicitly allowed permission without calling Jev", async () => {
  const mock = pluginInput()

  await withFetch(
    (async () => {
      throw new Error("explicit host allow must not be classified")
    }) as typeof fetch,
    async () => {
      const hooks = await OpenCodeClassifierPlugin(mock.input, {
        decision: { apiKey: "test", retries: 0 },
      })

      const request = { status: "allow" as const }
      await hooks["permission.ask"]?.(
        {
          id: "perm_explicit_allow",
          type: "read",
          pattern: ["src/**"],
          sessionID: "ses_1",
          messageID: "msg_1",
          callID: "call_read",
          title: "Read source",
          metadata: {},
          time: { created: Date.now() },
        },
        request,
      )
      assert.equal(request.status, "allow")
    },
  )
})

test("Auto Mode keeps high-risk permissions available for human approval", async () => {
  const mock = pluginInput()

  await withFetch(
    (async () =>
      new Response(JSON.stringify(permissionResponse({ destructive: 0.99 })), {
        status: 200,
      })) as typeof fetch,
    async () => {
      const hooks = await OpenCodeClassifierPlugin(mock.input, {
        decision: { apiKey: "test", retries: 0 },
        autoMode: { denyHighRisk: true },
      })

      const request = { status: "ask" as const }
      await hooks["permission.ask"]?.(
        {
          id: "perm_3",
          type: "bash",
          pattern: ["rm -rf dist"],
          sessionID: "ses_1",
          messageID: "msg_1",
          callID: "call_delete",
          title: "Delete files",
          metadata: {},
          time: { created: Date.now() },
        },
        request,
      )
      assert.equal(request.status, "ask")
    },
  )
})

test("Auto Mode responds to the host permission.asked event", async () => {
  const mock = pluginInput()
  const requested: string[] = []

  await withFetch(
    (async (input) => {
      requested.push(String(input))
      return new Response(JSON.stringify(permissionResponse()), { status: 200 })
    }) as typeof fetch,
    async () => {
      const hooks = await OpenCodeClassifierPlugin(mock.input, {
        decision: { apiKey: "test", retries: 0 },
      })

      await hooks.event?.({
        event: {
          type: "permission.asked",
          properties: {
            id: "permission_1",
            sessionID: "ses_1",
            permission: "bash",
            patterns: ["git status"],
            metadata: {},
            tool: { callID: "call_status" },
          },
        },
      } as any)

      assert.deepEqual(mock.permissionReplies, [
        {
          requestID: "permission_1",
          reply: "once",
          directory: "/workspace",
        },
      ])
      assert.deepEqual(requested.filter((url) => url.includes("/permission/")), [])
    },
  )
})

test("Auto Mode replies through the host SDK session permission API", async () => {
  const mock = pluginInput()
  const posted: unknown[] = []
  mock.input.client = {
    async postSessionIdPermissionsPermissionId(input: unknown) {
      posted.push(input)
      return { data: true }
    },
  }
  const requested: string[] = []

  await withFetch(
    (async (input) => {
      requested.push(String(input))
      return new Response(JSON.stringify(permissionResponse()), { status: 200 })
    }) as typeof fetch,
    async () => {
      const hooks = await OpenCodeClassifierPlugin(mock.input, {
        decision: { apiKey: "test", retries: 0 },
      })

      await hooks.event?.({
        event: {
          type: "permission.asked",
          properties: {
            id: "permission_1",
            sessionID: "ses_1",
            permission: "bash",
            patterns: ["git status"],
            metadata: {},
            tool: { callID: "call_status" },
          },
        },
      } as any)

      assert.deepEqual(posted, [
        {
          path: { id: "ses_1", permissionID: "permission_1" },
          body: { response: "once" },
          query: { directory: "/workspace" },
        },
      ])
      assert.deepEqual(requested.filter((url) => url.includes("/permission/")), [])
    },
  )
})

test("Auto Mode falls back to HTTP when the host client reply fails", async () => {
  const mock = pluginInput()
  mock.input.client.permission.reply = async () => {
    throw new Error("client unavailable")
  }
  const replies: Array<{ url: string; body: string }> = []

  await withFetch(
    (async (input, init) => {
      const url = String(input)
      if (url.includes("/permission/")) {
        replies.push({ url, body: String(init?.body) })
        return new Response("true", { status: 200 })
      }
      return new Response(JSON.stringify(permissionResponse()), { status: 200 })
    }) as typeof fetch,
    async () => {
      const hooks = await OpenCodeClassifierPlugin(mock.input, {
        decision: { apiKey: "test", retries: 0 },
      })

      await hooks.event?.({
        event: {
          type: "permission.asked",
          properties: {
            id: "permission_1",
            sessionID: "ses_1",
            permission: "bash",
            patterns: ["git status"],
            metadata: {},
            tool: { callID: "call_status" },
          },
        },
      } as any)

      assert.deepEqual(replies, [
        {
          url: "http://localhost:4096/api/session/ses_1/permission/permission_1/reply",
          body: '{"reply":"once"}',
        },
      ])
    },
  )
})

test("Auto Mode falls back to the legacy permission reply endpoint", async () => {
  const mock = pluginInput()
  mock.input.client = {}
  const replies: Array<{ url: string; body: string }> = []

  await withFetch(
    (async (input, init) => {
      const url = String(input)
      if (url.includes("/permission/")) {
        replies.push({ url, body: String(init?.body) })
        if (url.includes("/api/session/")) {
          return new Response("not found", { status: 404 })
        }
        return new Response("true", { status: 200 })
      }
      return new Response(JSON.stringify(permissionResponse()), { status: 200 })
    }) as typeof fetch,
    async () => {
      const hooks = await OpenCodeClassifierPlugin(mock.input, {
        decision: { apiKey: "test", retries: 0 },
      })

      await hooks.event?.({
        event: {
          type: "permission.asked",
          properties: {
            id: "permission_1",
            sessionID: "ses_1",
            permission: "bash",
            patterns: ["git status"],
            metadata: {},
            tool: { callID: "call_status" },
          },
        },
      } as any)

      assert.deepEqual(replies, [
        {
          url: "http://localhost:4096/api/session/ses_1/permission/permission_1/reply",
          body: '{"reply":"once"}',
        },
        {
          url: "http://localhost:4096/permission/permission_1/reply",
          body: '{"reply":"once"}',
        },
      ])
    },
  )
})

test("Auto Mode does not reject a high-risk host permission event", async () => {
  const mock = pluginInput()
  const replies: Array<{ url: string; body: string }> = []

  await withFetch(
    (async (input, init) => {
      const url = String(input)
      if (url.includes("/permission/")) {
        replies.push({ url, body: String(init?.body) })
        return new Response("true", { status: 200 })
      }
      return new Response(
        JSON.stringify(permissionResponse({ destructive: 0.99 })),
        { status: 200 },
      )
    }) as typeof fetch,
    async () => {
      const hooks = await OpenCodeClassifierPlugin(mock.input, {
        decision: { apiKey: "test", retries: 0 },
        autoMode: { denyHighRisk: true },
      })

      await hooks.event?.({
        event: {
          type: "permission.asked",
          properties: {
            id: "permission_2",
            sessionID: "ses_1",
            permission: "bash",
            patterns: ["rm -rf /tmp/opencode-classifier-plugin-test"],
            metadata: {},
            tool: { callID: "call_remove" },
          },
        },
      } as any)

      assert.deepEqual(replies, [])
    },
  )
})
