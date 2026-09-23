import test from "node:test"
import assert from "node:assert/strict"

import {
  VIRTUAL_MODEL_REF,
  parseModelRef,
  resolveOptions,
} from "../src/config.ts"
import { chooseTier, classifyPermission } from "../src/classifier.ts"
import { filterLargeToolContext, filterText } from "../src/context.ts"
import { JevClient } from "../src/jev.ts"
import {
  OpenCodeClassifierPlugin,
  installVirtualProvider,
} from "../src/index.ts"
import { decidePermission } from "../src/permission.ts"
import { eventSessionID } from "../src/runtime.ts"

function options(extra: Record<string, unknown> = {}) {
  return resolveOptions({
    router: {
      models: {
        fast: "opencode-go/glm-5.3-flash",
        normal: "opencode-go/gpt-5.6-luna",
        deep: "opencode/gpt-5.6-sol",
      },
    },
    ...extra,
  })
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

test("configuration rejects recursive router models", () => {
  assert.throws(
    () =>
      resolveOptions({
        router: {
          models: {
            fast: VIRTUAL_MODEL_REF,
            normal: "opencode-go/gpt-5.6-luna",
            deep: "opencode/gpt-5.6-sol",
          },
        },
      }),
    /cannot point back/,
  )
})

test("configuration resolves router efforts by tier", () => {
  // Given
  const options = resolveOptions({
    router: {
      models: {
        fast: "p/fast",
        normal: "p/normal",
        deep: "p/deep",
      },
      efforts: {
        fast: "low",
        normal: "medium",
        deep: "high",
      },
    },
  })

  // When
  const efforts = options.router.efforts

  // Then
  assert.deepEqual(efforts, {
    fast: "low",
    normal: "medium",
    deep: "high",
  })
})

test("chooseTier promotes deep reasoning and selects confident fast", () => {
  const configured = options()
  assert.equal(
    chooseTier(
      {
        complexity: "normal",
        complexityProbability: 0.8,
        deepReasoning: 0.95,
        highRisk: 0.1,
        research: 0.1,
      },
      configured,
    ),
    "deep",
  )
  assert.equal(
    chooseTier(
      {
        complexity: "fast",
        complexityProbability: 0.95,
        deepReasoning: 0.1,
        highRisk: 0.1,
        research: 0,
      },
      configured,
    ),
    "fast",
  )
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
    router: {
      models: {
        fast: "p/fast",
        normal: "p/normal",
        deep: "p/deep",
      },
    },
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
    router: {
      models: {
        fast: "p/fast",
        normal: "p/normal",
        deep: "p/deep",
      },
    },
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
  configured.context = {
    ...configured.context,
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
  configured.context = {
    ...configured.context,
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

test("chat.message activates sticky routing and a different manual model disables it", async () => {
  const mock = pluginInput()
  let routeCalls = 0

  await withFetch(
    (async () => {
      routeCalls += 1
      return new Response(JSON.stringify(routeResponse("fast")), {
        status: 200,
      })
    }) as typeof fetch,
    async () => {
      const hooks = await OpenCodeClassifierPlugin(mock.input, {
        decision: { apiKey: "test", retries: 0 },
        router: {
          sticky: true,
          models: {
            fast: "opencode-go/glm-5.3-flash",
            normal: "opencode-go/gpt-5.6-luna",
            deep: "opencode/gpt-5.6-sol",
          },
        },
      })

      const activated = userOutput()
      await hooks["chat.message"]?.({ sessionID: "ses_1" } as any, activated)
      assert.deepEqual(activated.message.model, {
        providerID: "opencode-go",
        modelID: "glm-5.3-flash",
      })

      const restoredByTui = userOutput("opencode-go", "glm-5.3-flash")
      await hooks["chat.message"]?.(
        { sessionID: "ses_1" } as any,
        restoredByTui,
      )
      assert.deepEqual(restoredByTui.message.model, {
        providerID: "opencode-go",
        modelID: "glm-5.3-flash",
      })
      assert.equal(routeCalls, 2)

      let unexpectedCalls = 0
      const original = globalThis.fetch
      globalThis.fetch = (async () => {
        unexpectedCalls += 1
        throw new Error("should not classify")
      }) as typeof fetch
      try {
        const manual = userOutput("opencode-go", "gpt-5.6-luna")
        await hooks["chat.message"]?.({ sessionID: "ses_1" } as any, manual)
        assert.deepEqual(manual.message.model, {
          providerID: "opencode-go",
          modelID: "gpt-5.6-luna",
        })
        assert.equal(unexpectedCalls, 0)
      } finally {
        globalThis.fetch = original
      }
    },
  )
})

test("router uses configured fallback when Jev is unavailable", async () => {
  const mock = pluginInput()
  await withFetch(
    (async () => {
      throw new TypeError("network down")
    }) as typeof fetch,
    async () => {
      const hooks = await OpenCodeClassifierPlugin(mock.input, {
        decision: { apiKey: "test", retries: 0 },
        router: {
          fallbackTier: "normal",
          models: {
            fast: "p/fast",
            normal: "p/normal",
            deep: "p/deep",
          },
        },
      })

      const output = userOutput()
      await hooks["chat.message"]?.({ sessionID: "ses_1" } as any, output)
      assert.deepEqual(output.message.model, {
        providerID: "p",
        modelID: "normal",
      })
    },
  )
})

test("router applies the configured effort to the selected model", async () => {
  // Given
  const mock = pluginInput()
  const output = userOutput()

  await withFetch(
    (async () =>
      new Response(JSON.stringify(routeResponse("deep")), {
        status: 200,
      })) as typeof fetch,
    async () => {
      const hooks = await OpenCodeClassifierPlugin(mock.input, {
        decision: { apiKey: "test", retries: 0 },
        router: {
          models: {
            fast: "p/fast#embedded",
            normal: "p/normal",
            deep: "p/deep",
          },
          efforts: {
            deep: "high",
          },
        },
      })

      // When
      await hooks["chat.message"]?.({ sessionID: "ses_1" } as any, output)
    },
  )

  // Then
  assert.deepEqual(output.message.model, {
    providerID: "p",
    modelID: "deep",
    variant: "high",
  })
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
        router: { enabled: false },
        agents: {
          enabled: true,
          minimumProbability: 0.8,
          byDomain: { backend: "backend-specialist" },
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
        router: { enabled: false },
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
        router: { enabled: false },
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
        router: { enabled: false },
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
        router: { enabled: false },
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
        router: { enabled: false },
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
        router: { enabled: false },
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
        router: { enabled: false },
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
        router: { enabled: false },
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
