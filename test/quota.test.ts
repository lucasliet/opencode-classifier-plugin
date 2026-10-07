import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createUsageBarLedger } from "../src/quota/ledger.ts"
import type { QuotaLedgerOptions } from "../src/quota/ledger.ts"
import {
  discoverPoolBindings,
  fetchUsageDocument,
  isSubscriptionReading,
  parseUsageDocument,
  parseVendorKinds,
  poolPressureFor,
  scopePoolToModel,
  unknownPoolStates,
} from "../src/quota/usagebar.ts"
import type { QuotaPoolBinding, UsageDocumentFetcher } from "../src/quota/usagebar.ts"

const OPENAI_POOL = binding("openai-chatgpt", "ChatGPT Team", ["openai"])
const ZAI_POOL = binding("zai-coding", "Z.AI GLM Coding Pro", ["zai"])
const GO_POOL = binding("opencode-go", "OpenCode Go", ["opencode-go"])

function binding(
  poolID: string,
  label: string,
  usageEntryIDs: readonly string[],
): QuotaPoolBinding {
  return { poolID, label, usageEntryIDs }
}

/** One metric exactly as `ai-usagebar usage --json` prints it. */
function metric(
  label: string,
  percent: number | null,
  windowSecs: number | null,
  resetAt: string | null = null,
): Record<string, unknown> {
  return {
    label,
    percent,
    value: `${percent ?? 0}%`,
    window_secs: windowSecs,
    reset_at: resetAt,
  }
}

/** One entry in the vendor wire shape; defaults describe a healthy reading. */
function entry(
  id: string,
  metrics: readonly Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    display_name: id,
    plan: "ChatGPT Team",
    status: "ready",
    stale: false,
    fetched_at: "2026-09-30T21:05:52.115Z",
    error: null,
    metrics,
    ...overrides,
  }
}

function document(entries: readonly Record<string, unknown>[]): unknown {
  return { schema_version: 1, primary: null, entries }
}

function codexEntry(): Record<string, unknown> {
  return entry("openai", [
    metric("Codex 5h", 4, 18_000, "2026-10-01T01:10:43Z"),
    metric("Codex weekly", 94, 604_800, "2026-10-04T20:04:09Z"),
  ])
}

function ledgerOptions(
  overrides: Partial<QuotaLedgerOptions> = {},
): QuotaLedgerOptions {
  return {
    binary: "ai-usagebar",
    args: ["usage", "--json"],
    timeoutMs: 2_000,
    refreshSeconds: 30,
    pools: [OPENAI_POOL, ZAI_POOL, GO_POOL],
    ...overrides,
  }
}

function manualClock(start: number): {
  now: () => number
  advance: (ms: number) => void
} {
  const state = { value: start }
  return {
    now: () => state.value,
    advance: (ms: number) => {
      state.value += ms
    },
  }
}

test("an unknown percent stays unknown instead of reading as available", () => {
  // Given
  const raw = document([
    entry("openai", [metric("Codex 5h", null, null)]),
  ])

  // When
  const [pool] = parseUsageDocument(raw, { pools: [OPENAI_POOL] })

  // Then
  assert.equal(pool?.windows[0]?.usedPercent, null)
  assert.equal(pool?.status, "unknown")
  const pressure = poolPressureFor(OPENAI_POOL.poolID, pool)
  assert.equal(pressure.worstUsedPercent, null)
  assert.equal(pressure.known, false)
  assert.equal(pressure.headroomRatio, null)
})

test("Codex at 4% on the 5h window and 94% weekly is under pressure", () => {
  // Given
  const raw = document([codexEntry()])

  // When
  const [pool] = parseUsageDocument(raw, { pools: [OPENAI_POOL] })
  const pressure = poolPressureFor(OPENAI_POOL.poolID, pool)

  // Then
  assert.deepEqual(
    pool?.windows.map((window) => [
      window.id,
      window.usedPercent,
      window.dimension,
    ]),
    [
      ["5h", 4, "inference"],
      ["weekly", 94, "inference"],
    ],
  )
  assert.equal(pool?.status, "available")
  assert.equal(pressure.worstUsedPercent, 94)
  assert.equal(pressure.headroomRatio, 0.06)
  assert.equal(pressure.known, true)
  assert.equal(pressure.nextResetAt, "2026-10-04T20:04:09Z")
})

test("shared pools merge every reporter by taking the worst window", () => {
  // Given
  const shared = binding("zai-coding", "Z.AI GLM Coding Pro", ["zai", "zai-alt"])
  const raw = document([
    entry("zai", [
      metric("Session (5h)", 17, 18_000),
      metric("Weekly", 65, 604_800),
    ]),
    entry("zai-alt", [
      metric("Session (5h)", 40, 18_000),
      metric("Weekly", 30, 604_800),
    ]),
  ])

  // When
  const [pool] = parseUsageDocument(raw, { pools: [shared] })

  // Then
  assert.deepEqual(
    pool?.windows.map((window) => [window.id, window.usedPercent]),
    [
      ["5h", 40],
      ["weekly", 65],
    ],
  )
  assert.equal(poolPressureFor(shared.poolID, pool).worstUsedPercent, 65)
  assert.equal(pool?.status, "available")
})

test("MCP tool windows stay in the list but never create pressure", () => {
  // Given
  const raw = document([
    entry("zai", [
      metric("Session (5h)", 17, 18_000),
      metric("Weekly", 20, 604_800),
      metric("MCP tools (monthly)", 99, 2_592_000),
    ]),
  ])

  // When
  const [pool] = parseUsageDocument(raw, { pools: [ZAI_POOL] })
  const pressure = poolPressureFor(ZAI_POOL.poolID, pool)

  // Then
  assert.deepEqual(
    pool?.windows.map((window) => [window.id, window.dimension]),
    [
      ["5h", "inference"],
      ["weekly", "inference"],
      ["monthly", "other"],
    ],
  )
  assert.equal(pressure.worstUsedPercent, 20)
})

test("a window without window_secs is still an inference window", () => {
  // Given
  const raw = document([
    entry("opencode-go", [
      metric("Rolling (5h)", 5, 18_000),
      metric("Weekly (7d)", 5, 604_800),
      metric("Monthly", 54, null),
    ]),
  ])

  // When
  const [pool] = parseUsageDocument(raw, { pools: [GO_POOL] })
  const pressure = poolPressureFor(GO_POOL.poolID, pool)

  // Then
  assert.deepEqual(
    pool?.windows.map((window) => [
      window.id,
      window.windowSecs,
      window.usedPercent,
    ]),
    [
      ["5h", 18_000, 5],
      ["weekly", 604_800, 5],
      ["monthly", null, 54],
    ],
  )
  assert.equal(pressure.worstUsedPercent, 54)
  assert.equal(pool?.status, "available")
})

test("an unknown window length falls back to a stable w<window_secs> id", () => {
  // Given
  const raw = document([entry("openai", [metric("Rolling 3h", 12, 10_800)])])

  // When
  const [pool] = parseUsageDocument(raw, { pools: [OPENAI_POOL] })

  // Then
  assert.equal(pool?.windows[0]?.id, "w10800")
})

test("a stale reading is reported as stale and never as available", () => {
  // Given
  const raw = document([
    entry("openai", [metric("Codex weekly", 42, 604_800)], { stale: true }),
  ])

  // When
  const [pool] = parseUsageDocument(raw, { pools: [OPENAI_POOL] })
  const pressure = poolPressureFor(OPENAI_POOL.poolID, pool)

  // Then
  assert.equal(pool?.status, "stale")
  assert.notEqual(pool?.status, "available")
  assert.equal(pressure.status, "stale")
  assert.equal(pressure.worstUsedPercent, 42)
})

test("an entry error makes the pool unknown and keeps the message", () => {
  // Given
  const raw = document([
    entry("openai", [metric("Codex weekly", 42, 604_800)], {
      status: "error",
      error: "login required",
    }),
  ])

  // When
  const [pool] = parseUsageDocument(raw, { pools: [OPENAI_POOL] })
  const pressure = poolPressureFor(OPENAI_POOL.poolID, pool)

  // Then
  assert.equal(pool?.status, "unknown")
  assert.match(String(pool?.error), /login required/)
  assert.match(String(pool?.error), /"openai"/)
  assert.equal(pressure.known, false)
  assert.equal(pressure.headroomRatio, null)
})

test("a fully consumed inference window exhausts the pool", () => {
  // Given
  const raw = document([
    entry("openai", [
      metric("Codex 5h", 3, 18_000),
      metric("Codex weekly", 100, 604_800),
    ]),
  ])

  // When
  const [pool] = parseUsageDocument(raw, { pools: [OPENAI_POOL] })
  const pressure = poolPressureFor(OPENAI_POOL.poolID, pool)

  // Then
  assert.equal(pool?.status, "exhausted")
  assert.equal(pressure.status, "exhausted")
  assert.equal(pressure.headroomRatio, 0)
})

test("a pool with no known percent is unknown rather than unlimited", () => {
  // Given
  const raw = document([entry("openai", [])])

  // When
  const [pool] = parseUsageDocument(raw, { pools: [OPENAI_POOL] })

  // Then
  assert.equal(pool?.status, "unknown")
  assert.equal(pool?.error, null)
  assert.deepEqual(pool?.windows, [])
  const pressure = poolPressureFor(OPENAI_POOL.poolID, pool)
  assert.equal(pressure.known, false)
  assert.equal(pressure.headroomRatio, null)
})

test("a shared pool with a missing reporter is unknown", () => {
  // Given
  const shared = binding("zai-coding", "Z.AI", ["zai", "zai-alt"])
  const raw = document([entry("zai", [metric("Session (5h)", 17, 18_000)])])

  // When
  const [pool] = parseUsageDocument(raw, { pools: [shared] })

  // Then
  assert.equal(pool?.status, "unknown")
  assert.match(String(pool?.error), /zai-alt/)
})

test("junk in the document degrades every pool instead of throwing", () => {
  // Given / When / Then
  for (const raw of [null, "usage", 42, { entries: {} }]) {
    const [pool] = parseUsageDocument(raw, { pools: [OPENAI_POOL] })
    assert.equal(pool?.status, "unknown")
    assert.match(
      String(pool?.error),
      /expected an object with an "entries" array/,
    )
    assert.equal(poolPressureFor(OPENAI_POOL.poolID, pool).headroomRatio, null)
  }
})

test("unparseable vendor fields never become numbers", () => {
  // Given
  const raw = {
    entries: [
      {
        id: "openai",
        status: "ready",
        metrics: [
          { label: "Codex weekly", percent: "94", window_secs: 604_800 },
          { label: "Monthly", percent: -5 },
          "not a metric",
        ],
      },
      { id: 7, metrics: [] },
    ],
  }

  // When
  const [pool] = parseUsageDocument(raw, { pools: [OPENAI_POOL] })

  // Then
  assert.deepEqual(
    pool?.windows.map((window) => [window.id, window.usedPercent]),
    [
      ["weekly", null],
      ["monthly", null],
    ],
  )
  assert.equal(pool?.status, "unknown")
  assert.equal(pool?.error, null)
  assert.equal(pool?.fetchedAt, null)
})

test("an unknown pool id is answered safely", () => {
  // Given / When / Then
  assert.deepEqual(poolPressureFor("not-configured", undefined), {
    poolID: "not-configured",
    known: false,
    worstUsedPercent: null,
    headroomRatio: null,
    status: "unknown",
    nextResetAt: null,
  })
})

test("unknownPoolStates builds one unknown record per configured pool", () => {
  // Given / When
  const states = unknownPoolStates([OPENAI_POOL, ZAI_POOL], "boom")

  // Then
  assert.deepEqual(states, [
    {
      poolID: "openai-chatgpt",
      label: "ChatGPT Team",
      status: "unknown",
      windows: [],
      fetchedAt: null,
      error: "boom",
    },
    {
      poolID: "zai-coding",
      label: "Z.AI GLM Coding Pro",
      status: "unknown",
      windows: [],
      fetchedAt: null,
      error: "boom",
    },
  ])
})

test("the ledger starts unknown so the first prompt is never treated as free", () => {
  // Given
  const ledger = createUsageBarLedger(ledgerOptions())

  // When / Then
  assert.equal(ledger.pools().length, 3)
  assert.equal(ledger.pool("openai-chatgpt")?.status, "unknown")
  assert.deepEqual(ledger.pool("openai-chatgpt")?.windows, [])
  const pressure = ledger.pressure("openai-chatgpt")
  assert.equal(pressure.known, false)
  assert.equal(pressure.headroomRatio, null)
  assert.equal(ledger.pool("nope"), undefined)
  assert.equal(ledger.pressure("nope").status, "unknown")
})

test("refresh reads the binary once and exposes pool pressure", async () => {
  // Given
  const calls: string[][] = []
  const fetcher: UsageDocumentFetcher = async (invocation) => {
    calls.push([...invocation.args])
    return document([codexEntry()])
  }
  const ledger = createUsageBarLedger(ledgerOptions({ fetchDocument: fetcher }))

  // When
  await ledger.refresh(true)

  // Then
  assert.deepEqual(calls, [["usage", "--json"]])
  assert.equal(ledger.pool("openai-chatgpt")?.status, "available")
  assert.equal(
    ledger.pool("openai-chatgpt")?.fetchedAt,
    "2026-09-30T21:05:52.115Z",
  )
  assert.equal(ledger.pressure("openai-chatgpt").worstUsedPercent, 94)
  assert.equal(ledger.pool("zai-coding")?.status, "unknown")
})

test("refresh respects the TTL and dedupes concurrent callers", async () => {
  // Given
  const clock = manualClock(0)
  let calls = 0
  const fetcher: UsageDocumentFetcher = async () => {
    calls += 1
    await new Promise<void>((resolve) => setImmediate(resolve))
    return document([codexEntry()])
  }
  const ledger = createUsageBarLedger(
    ledgerOptions({
      fetchDocument: fetcher,
      now: clock.now,
      refreshSeconds: 5,
    }),
  )

  // When
  await Promise.all([ledger.refresh(), ledger.refresh(), ledger.refresh()])
  await ledger.refresh()

  // Then
  assert.equal(calls, 1)

  // When the TTL expires the binary runs again, and force always runs.
  clock.advance(5_000)
  await ledger.refresh()
  await ledger.refresh(true)

  // Then
  assert.equal(calls, 3)
})

test("a hung binary is cancelled by timeout and captured as an error", async () => {
  // Given
  let signal: AbortSignal | undefined
  const fetcher: UsageDocumentFetcher = (_invocation, next) => {
    signal = next
    return new Promise<unknown>(() => {})
  }
  const ledger = createUsageBarLedger(
    ledgerOptions({ fetchDocument: fetcher, timeoutMs: 20, refreshSeconds: 0 }),
  )

  // When
  await ledger.refresh(true)

  // Then
  assert.equal(signal?.aborted, true)
  const pool = ledger.pool("openai-chatgpt")
  assert.equal(pool?.status, "unknown")
  assert.match(String(pool?.error), /timed out after 20ms/)
  assert.match(String(pool?.error), /ai-usagebar usage --json/)
  assert.equal(ledger.pressure("openai-chatgpt").known, false)
})

test("a rejected fetch is captured instead of reaching the router", async () => {
  // Given
  const fetcher: UsageDocumentFetcher = async () => {
    throw new Error("ENOENT: no such file or directory")
  }
  const ledger = createUsageBarLedger(ledgerOptions({ fetchDocument: fetcher }))

  // When
  await ledger.refresh(true)

  // Then
  const pool = ledger.pool("zai-coding")
  assert.equal(pool?.status, "unknown")
  assert.match(String(pool?.error), /ENOENT/)
  assert.ok((pool?.error?.length ?? 0) <= 220)
  assert.deepEqual(
    ledger.pools().map((state) => state.poolID),
    ["openai-chatgpt", "zai-coding", "opencode-go"],
  )
})

test("a failed refresh drops old percentages instead of mixing them", async () => {
  // Given
  let calls = 0
  const fetcher: UsageDocumentFetcher = async () => {
    calls += 1
    if (calls > 1) throw new Error("usage bar not installed")
    return document([codexEntry()])
  }
  const ledger = createUsageBarLedger(
    ledgerOptions({ fetchDocument: fetcher, refreshSeconds: 0 }),
  )

  // When
  await ledger.refresh(true)
  assert.equal(ledger.pressure("openai-chatgpt").worstUsedPercent, 94)

  // Then
  await ledger.refresh(true)
  const pool = ledger.pool("openai-chatgpt")
  assert.equal(pool?.status, "unknown")
  assert.deepEqual(pool?.windows, [])
  assert.equal(ledger.pressure("openai-chatgpt").headroomRatio, null)
})

test("dispose stops the ledger from running the binary again", async () => {
  // Given
  let calls = 0
  const fetcher: UsageDocumentFetcher = async () => {
    calls += 1
    return document([codexEntry()])
  }
  const ledger = createUsageBarLedger(ledgerOptions({ fetchDocument: fetcher }))

  // When
  ledger.dispose()
  await ledger.refresh(true)

  // Then
  assert.equal(calls, 0)
  assert.equal(ledger.pools().length, 3)
})

test("the binary is executed without a shell", async () => {
  // Given
  const canary = join(tmpdir(), "usagebar-injection-canary")
  rmSync(canary, { force: true })
  const controller = new AbortController()

  // When a shell metacharacter reaches the binary name, execFile must not run it.
  await assert.rejects(() =>
    fetchUsageDocument(
      {
        binary: `ai-usagebar; touch ${canary}`,
        args: ["usage", "--json"],
        timeoutMs: 2_000,
      },
      controller.signal,
    ),
  )

  // Then
  assert.equal(existsSync(canary), false)
})

test("a missing binary produces an actionable error", async () => {
  // Given
  const controller = new AbortController()

  // When
  await assert.rejects(
    () =>
      fetchUsageDocument(
        {
          binary: "/nonexistent/ai-usagebar",
          args: ["usage", "--json"],
          timeoutMs: 2_000,
        },
        controller.signal,
      ),
    (error: Error) => {
      assert.match(error.message, /\/nonexistent\/ai-usagebar usage --json/)
      assert.ok(error.message.length <= 300)
      return true
    },
  )
})
function dynamicLedgerOptions(
  usage: unknown,
  vendors: unknown,
): QuotaLedgerOptions {
  const { pools: _fixedPools, ...base } = ledgerOptions()
  return {
    ...base,
    vendorArgs: ["vendors", "--json"],
    fetchDocument: async () => usage,
    fetchVendors: async () => vendors,
  }
}

function vendorsDocument(kinds: Record<string, string>): unknown {
  return {
    vendors: Object.entries(kinds).map(([id, kind]) => ({ id, kind, enabled: true })),
  }
}

test("discoverPoolBindings yields one pool per reported entry, labelled with its plan", () => {
  // Given
  const raw = document([
    codexEntry(),
    entry("zai", [metric("Session (5h)", 3, 18_000)], { display_name: "Z.AI", plan: "GLM Coding Pro" }),
  ])

  // When
  const bindings = discoverPoolBindings(raw)

  // Then
  assert.deepEqual(bindings, [
    { poolID: "openai", label: "openai (ChatGPT Team)", usageEntryIDs: ["openai"] },
    { poolID: "zai", label: "Z.AI (GLM Coding Pro)", usageEntryIDs: ["zai"] },
  ])
  assert.deepEqual(discoverPoolBindings("not a document"), [])
})

test("only a windowed, readable quota counts as a subscription reading", () => {
  // Given
  const raw = document([
    codexEntry(),
    entry("openrouter", [metric("Credits", 40, null)]),
    entry("antigravity", [], { status: "error", error: "HTTP 401" }),
  ])
  const states = parseUsageDocument(raw, { pools: discoverPoolBindings(raw) })

  // When
  const verdicts = states.map((state) => [state.poolID, isSubscriptionReading(state)])

  // Then
  assert.deepEqual(verdicts, [
    ["openai", true],
    ["openrouter", false],
    ["antigravity", false],
  ])
})

test("parseVendorKinds maps vendor ids to their authentication kind", () => {
  // Given
  const raw = vendorsDocument({ openai: "oauth", zai: "apikey" })

  // When
  const kinds = parseVendorKinds(raw)

  // Then
  assert.deepEqual([...kinds], [["openai", "oauth"], ["zai", "apikey"]])
  assert.equal(parseVendorKinds(null).size, 0)
})

test("a dynamic ledger lists the subscriptions ai-usagebar reports, with their OAuth need", async () => {
  // Given
  const usage = document([
    codexEntry(),
    entry("zai", [metric("Session (5h)", 3, 18_000)], { display_name: "Z.AI", plan: "Pro" }),
    entry("cursor", [metric("Monthly", 10, 2_592_000)], { display_name: "Cursor", plan: null }),
  ])
  const ledger = createUsageBarLedger(
    dynamicLedgerOptions(usage, vendorsDocument({ openai: "oauth", zai: "apikey" })),
  )

  // When
  await ledger.refresh(true)

  // Then
  assert.deepEqual(ledger.subscriptions(), [
    { id: "openai", label: "openai (ChatGPT Team)", requireOAuth: true },
    { id: "zai", label: "Z.AI (Pro)", requireOAuth: false },
    { id: "cursor", label: "Cursor", requireOAuth: true },
  ])
  assert.equal(ledger.pool("zai")?.status, "available")
})

test("a cancelled subscription disappears on the next reading", async () => {
  // Given
  let usage = document([codexEntry(), entry("zai", [metric("Session (5h)", 3, 18_000)])])
  const clock = manualClock(0)
  const ledger = createUsageBarLedger({
    ...dynamicLedgerOptions(undefined, vendorsDocument({})),
    now: clock.now,
    fetchDocument: async () => usage,
  })
  await ledger.refresh(true)

  // When
  usage = document([entry("zai", [metric("Session (5h)", 3, 18_000)])])
  await ledger.refresh(true)

  // Then
  assert.deepEqual(ledger.subscriptions().map((item) => item.id), ["zai"])
  assert.equal(ledger.pool("openai"), undefined)
})

test("a failed reading keeps the last known subscriptions as unknown quota", async () => {
  // Given
  let fail = false
  const ledger = createUsageBarLedger({
    ...dynamicLedgerOptions(undefined, vendorsDocument({ zai: "apikey" })),
    fetchDocument: async () => {
      if (fail) throw new Error("binary vanished")
      return document([entry("zai", [metric("Session (5h)", 3, 18_000)])])
    },
  })
  await ledger.refresh(true)

  // When
  fail = true
  await ledger.refresh(true)

  // Then
  assert.deepEqual(ledger.subscriptions().map((item) => item.id), ["zai"])
  assert.equal(ledger.pool("zai")?.status, "unknown")
  assert.match(ledger.pool("zai")?.error ?? "", /binary vanished/)
})

function cursorEntry(cursorPercent: number, otherPercent: number): Record<string, unknown> {
  return entry(
    "cursor",
    [metric("Cursor Models", cursorPercent, 2_678_400), metric("Other Models", otherPercent, 2_678_400)],
    { display_name: "Cursor", plan: "Cursor Pro" },
  )
}

test("Cursor windows stay separate and each meters its own model category", () => {
  // Given
  const raw = document([cursorEntry(49, 100)])
  const [pool] = parseUsageDocument(raw, { pools: discoverPoolBindings(raw) })
  assert.ok(pool !== undefined)

  // When
  const own = scopePoolToModel(pool, "composer-2.5")
  const auto = scopePoolToModel(pool, "default")
  const thirdParty = scopePoolToModel(pool, "claude-fable-5")

  // Then
  assert.equal(pool.windows.length, 2)
  assert.equal(pool.status, "exhausted")
  assert.equal(own.status, "available")
  assert.deepEqual(own.windows.map((window) => window.label), ["Cursor Models"])
  assert.equal(auto.status, "available")
  assert.equal(thirdParty.status, "exhausted")
  assert.deepEqual(thirdParty.windows.map((window) => window.label), ["Other Models"])
})

test("a pool without model-scoped windows is returned untouched", () => {
  // Given
  const raw = document([codexEntry()])
  const [pool] = parseUsageDocument(raw, { pools: discoverPoolBindings(raw) })
  assert.ok(pool !== undefined)

  // When / Then
  assert.equal(scopePoolToModel(pool, "gpt-6-luna"), pool)
})

test("the ledger answers pressure per model for a model-scoped pool", async () => {
  // Given
  const ledger = createUsageBarLedger(
    dynamicLedgerOptions(document([cursorEntry(49, 100)]), vendorsDocument({ cursor: "local" })),
  )

  // When
  await ledger.refresh(true)

  // Then
  assert.equal(ledger.pressure("cursor").status, "exhausted")
  assert.equal(ledger.pressure("cursor", "composer-2.5").status, "available")
  assert.equal(ledger.pressure("cursor", "composer-2.5").worstUsedPercent, 49)
  assert.equal(ledger.pressure("cursor", "gpt-5.5").status, "exhausted")
})
