import test from "node:test"
import assert from "node:assert/strict"

import { narrowCapabilityCatalog, readCapabilityCatalog } from "../src/capabilities/catalog.ts"
import { judgeCapabilities } from "../src/capabilities/judge.ts"
import type { CapabilityCandidate } from "../src/capabilities/judge.ts"
import { createCapabilitySelector } from "../src/capabilities/selection.ts"
import { resolveOptions } from "../src/config.ts"
import type { JevClient } from "../src/jev.ts"
import type { JevQuestion, JevResponse } from "../src/types.ts"
import { narrowRequestCapabilities, pinnedCapabilityKeys } from "../src/v2-capabilities.ts"

const CODE_MODE_PART = [
  "# Code Mode",
  "",
  "Use the `execute` tool to call the tools listed below. They cannot be called directly. They only work inside code you pass to `execute`.",
  "",
  "The catalog is complete. Do not guess tool names.",
  "",
  "## Available tools",
  "",
  "- context7 (2 tools) // Library documentation.",
  "  - tools.context7.resolve({",
  "  /** Library name. */",
  "  name: string,",
  "}): Promise<string> // Resolve a library ID.",
  "  - tools.context7.docs({ id: string }): Promise<string> // Fetch library docs.",
  "- image_gen (1 tool)",
  "  - tools.image_gen({ prompt: string }): Promise<string | null> // Generate an image.",
  "- opencode (5 tools) // Tools for managing OpenCode itself.",
  "  - tools.opencode.session_rename({ title: string }): Promise<string> // Rename a session.",
  "",
  "Skills provide specialized instructions and workflows for specific tasks.",
  "<available_skills>",
  "  <skill>",
  "    <id>pdf</id>",
  "    <name>pdf</name>",
  "    <description>Read and edit PDF files.</description>",
  "  </skill>",
  "  <skill>",
  "    <id>docx</id>",
  "    <name>docx</name>",
  "    <description>Create Word documents.</description>",
  "  </skill>",
  "</available_skills>",
  "",
  "Instructions from: /home/user/AGENTS.md",
  "# AGENTS.md",
].join("\n")

const NOTHING_HIDDEN = {
  skills: new Set(["pdf", "docx"]),
  namespaces: new Set(["context7", "image_gen", "opencode"]),
}

/** Jev double that answers every noul question from a fixed table. */
class FakeJev {
  readonly states: unknown[] = []
  private readonly failure: Error | undefined

  constructor(
    private readonly relevanceOf: (name: string) => number | undefined,
    failure?: Error,
  ) {
    this.failure = failure
  }

  async ask(state: unknown, questions: Record<string, JevQuestion>): Promise<JevResponse> {
    this.states.push(state)
    if (this.failure !== undefined) throw this.failure
    const candidates = (state as { candidates: Array<{ index: number; name: string }> }).candidates
    const answers: JevResponse["answers"] = {}
    for (const key of Object.keys(questions)) {
      const index = Number(key.slice("item_".length))
      const relevance = this.relevanceOf(candidates[index]?.name ?? "")
      if (relevance !== undefined) answers[key] = { type: "noul", noul: relevance }
    }
    return { answers }
  }
}

function candidate(kind: "skill" | "namespace", name: string, summary = `About ${name}.`): CapabilityCandidate {
  return { key: `${kind}:${name}`, kind, name, summary }
}

test("the catalog lists every namespace and skill of the Code Mode part", () => {
  // When
  const catalog = readCapabilityCatalog(CODE_MODE_PART)

  // Then
  assert.deepEqual(
    catalog.namespaces.map((namespace) => [namespace.name, namespace.count, namespace.description]),
    [
      ["context7", 2, "Library documentation."],
      ["image_gen", 1, undefined],
      ["opencode", 5, "Tools for managing OpenCode itself."],
    ],
  )
  assert.match(catalog.namespaces[0]?.block ?? "", /tools\.context7\.docs/)
  assert.deepEqual(
    catalog.skills.map((skill) => [skill.id, skill.description]),
    [
      ["pdf", "Read and edit PDF files."],
      ["docx", "Create Word documents."],
    ],
  )
})

test("hidden namespaces are left out and the catalog turns partial", () => {
  // When
  const narrowed = narrowCapabilityCatalog(CODE_MODE_PART, {
    ...NOTHING_HIDDEN,
    namespaces: new Set(["opencode"]),
  })

  // Then
  assert.doesNotMatch(narrowed, /context7/)
  assert.doesNotMatch(narrowed, /image_gen/)
  assert.match(narrowed, /tools\.opencode\.session_rename/)
  assert.match(narrowed, /The catalog is partial\. Inside `execute`, use `search\(\.\.\.\)`/)
  assert.match(narrowed, /^- search\(\{ query\?: string/m)
  assert.match(narrowed, /and neither can `search`\. Both only work/)
  assert.doesNotMatch(narrowed, /The catalog is complete/)
  assert.ok(narrowed.endsWith("Instructions from: /home/user/AGENTS.md\n# AGENTS.md"))
})

test("hidden skills collapse into one line of IDs after the list", () => {
  // When
  const narrowed = narrowCapabilityCatalog(CODE_MODE_PART, {
    ...NOTHING_HIDDEN,
    skills: new Set(["pdf"]),
  })

  // Then
  assert.match(narrowed, /<id>pdf<\/id>/)
  assert.doesNotMatch(narrowed, /Create Word documents/)
  assert.match(
    narrowed,
    /<\/available_skills>\nOther skills are available but not described here: docx\. Load one with the skill tool by its ID/,
  )
  assert.match(narrowed, /The catalog is complete/)
  assert.ok(narrowed.endsWith("\n\nInstructions from: /home/user/AGENTS.md\n# AGENTS.md"))
})

test("hiding every namespace leaves a placeholder instead of an empty catalog", () => {
  // When
  const narrowed = narrowCapabilityCatalog(CODE_MODE_PART, { ...NOTHING_HIDDEN, namespaces: new Set() })

  // Then
  assert.match(narrowed, /## Available tools\n\nNo tool namespaces are listed for this task\.\n\nSkills provide/)
  assert.doesNotMatch(narrowed, /tools\.opencode/)
})

test("a selection that hides nothing leaves the part untouched", () => {
  // When
  const narrowed = narrowCapabilityCatalog(CODE_MODE_PART, NOTHING_HIDDEN)

  // Then
  assert.equal(narrowed, CODE_MODE_PART)
})

test("Jev keeps candidates at the relevance cutoff and treats missing answers as needed", async () => {
  // Given
  const options = resolveOptions({ context: { capabilities: { relevantAt: 0.4 } } })
  const jev = new FakeJev((name) => ({ pdf: 0.9, docx: 0.1, context7: 0.4 })[name])
  const candidates = [
    candidate("skill", "pdf"),
    candidate("skill", "docx"),
    candidate("namespace", "context7"),
    candidate("namespace", "image_gen"),
  ]

  // When
  const selected = await judgeCapabilities(jev as unknown as JevClient, options, "fill the PDF form", candidates)

  // Then
  assert.deepEqual([...selected].sort(), ["namespace:context7", "namespace:image_gen", "skill:pdf"])
})

test("candidates that overflow the state budget are judged in separate batches", async () => {
  // Given
  const options = resolveOptions({ privacy: { maxStateChars: 2_000 } })
  const jev = new FakeJev(() => 0.9)
  const candidates = Array.from({ length: 6 }, (_, index) =>
    candidate("skill", `skill-${index}`, "x".repeat(700)),
  )

  // When
  const selected = await judgeCapabilities(jev as unknown as JevClient, options, "task", candidates)

  // Then
  assert.equal(selected.size, 6)
  assert.ok(jev.states.length > 1, `expected several batches, got ${jev.states.length}`)
})

test("the selector judges each candidate once per task and keeps selections for the session", async () => {
  // Given
  const judged: string[][] = []
  const verdicts: Record<string, string[]> = { "fill the PDF": ["skill:pdf"], "write a report": ["skill:docx"] }
  const selector = createCapabilitySelector(async (task, candidates) => {
    judged.push(candidates.map((item) => item.key))
    return new Set(verdicts[task] ?? [])
  }, ["namespace:opencode"])
  const candidates = [
    candidate("skill", "pdf"),
    candidate("skill", "docx"),
    candidate("skill", "opencode"),
    candidate("namespace", "opencode"),
  ]

  // When
  const first = await selector.selectedFor("ses_1", "fill the PDF", candidates)
  const repeated = await selector.selectedFor("ses_1", "fill the PDF", candidates)
  const next = await selector.selectedFor("ses_1", "write a report", candidates)

  // Then
  assert.deepEqual([...(first ?? [])].sort(), ["namespace:opencode", "skill:pdf"])
  assert.deepEqual([...(repeated ?? [])].sort(), ["namespace:opencode", "skill:pdf"])
  assert.deepEqual([...(next ?? [])].sort(), ["namespace:opencode", "skill:docx", "skill:pdf"])
  assert.deepEqual(judged, [["skill:pdf", "skill:docx", "skill:opencode"], ["skill:docx", "skill:opencode"]])
})

test("a Jev failure keeps the full catalog for that task and retries on the next one", async () => {
  // Given
  let calls = 0
  const selector = createCapabilitySelector(async () => {
    calls += 1
    if (calls === 1) throw new Error("System One request failed with HTTP 503")
    return new Set(["skill:pdf"])
  }, [])
  const candidates = [candidate("skill", "pdf"), candidate("skill", "docx")]

  // When
  const failed = await selector.selectedFor("ses_1", "fill the PDF", candidates)
  const sameTask = await selector.selectedFor("ses_1", "fill the PDF", candidates)
  const nextTask = await selector.selectedFor("ses_1", "fill another PDF", candidates)

  // Then
  assert.equal(failed, undefined)
  assert.equal(sameTask, undefined)
  assert.deepEqual([...(nextTask ?? [])], ["skill:pdf"])
  assert.equal(calls, 2)
})

test("the context event gets a narrowed Code Mode part and keeps every other part", async () => {
  // Given
  const selector = createCapabilitySelector(async () => new Set(["skill:pdf"]), ["namespace:opencode"])
  const harness = { type: "text" as const, text: "You are an AI agent running in OpenCode." }
  const event = { sessionID: "ses_1", system: [harness, { type: "text" as const, text: CODE_MODE_PART }] }
  const traces: string[] = []

  // When
  await narrowRequestCapabilities(selector, event, "fill the PDF form", (message) => {
    traces.push(message)
  })

  // Then
  assert.equal(event.system[0], harness)
  const narrowed = event.system[1]?.text ?? ""
  assert.match(narrowed, /<id>pdf<\/id>/)
  assert.doesNotMatch(narrowed, /<id>docx<\/id>/)
  assert.doesNotMatch(narrowed, /context7/)
  assert.match(narrowed, /tools\.opencode\.session_rename/)
  assert.deepEqual(traces, ["v2 capabilities narrowed"])
})

test("a request without a Code Mode part is left alone and Jev is not asked", async () => {
  // Given
  let calls = 0
  const selector = createCapabilitySelector(async () => {
    calls += 1
    return new Set<string>()
  }, [])
  const event = { sessionID: "ses_1", system: [{ type: "text" as const, text: "You are an AI agent." }] }

  // When
  await narrowRequestCapabilities(selector, event, "task", () => undefined)

  // Then
  assert.equal(event.system[0]?.text, "You are an AI agent.")
  assert.equal(calls, 0)
})

test("capability options default to on with the harness namespace pinned", () => {
  // When
  const defaults = resolveOptions({}).context.capabilities
  const emptyPins = resolveOptions({ context: { capabilities: { alwaysInclude: { namespaces: [] } } } }).context.capabilities

  // Then
  assert.deepEqual(defaults, {
    enabled: true,
    relevantAt: 0.4,
    alwaysInclude: { skills: [], namespaces: ["opencode"] },
  })
  assert.deepEqual(emptyPins.alwaysInclude, { skills: [], namespaces: [] })
  assert.deepEqual(pinnedCapabilityKeys({ skills: ["pdf"], namespaces: ["opencode"] }), [
    "skill:pdf",
    "namespace:opencode",
  ])
})
