/**
 * Raw `ai-usagebar` access and normalization.
 *
 * The binary is the only quota source this plugin trusts, so every value that
 * reaches the router is produced here. Process execution is kept separate from
 * parsing on purpose: `parseUsageDocument` is pure, has no I/O, and owns every
 * rule about vendor data, which is what the quota tests exercise.
 */
import { execFile } from "node:child_process"
import type { ExecFileException } from "node:child_process"

import type {
  PoolPressure,
  QuotaPoolID,
  QuotaPoolState,
  QuotaWindow,
} from "../routing/contracts.ts"

/** Rolling five hour window shared by ChatGPT, Z.AI, Kimi and Go plans. */
const FIVE_HOURS_SECS = 18_000
const WEEK_SECS = 604_800
const MONTH_SECS = 2_592_000
/** Stable id of the month sized window, also used when the length is missing. */
const MONTHLY_ID = "monthly"
/** Vendor labels that describe a tool quota instead of model inference. */
const NON_INFERENCE_LABEL = /mcp/i
/** The payload is a few KB, so anything larger means the configured path is wrong. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
/** Raw vendor output is never stored beyond a single truncated message. */
const MAX_ERROR_CHARS = 200
/**
 * Vendors that meter model categories separately. Cursor keeps one quota for
 * its own models (Auto and Composer) and another for every third-party model.
 */
const MODEL_SCOPED_WINDOWS: readonly {
  readonly vendorID: string
  readonly label: RegExp
  readonly models: { readonly pattern: string; readonly matches: boolean }
}[] = [
  { vendorID: "cursor", label: /^cursor models$/i, models: { pattern: "^(default|auto|composer)", matches: true } },
  { vendorID: "cursor", label: /^other models$/i, models: { pattern: "^(default|auto|composer)", matches: false } },
]

/** A window at this consumption leaves no inference room on that plan. */
const EXHAUSTED_PERCENT = 100

/** One `ai-usagebar` entry id that reports quota for a configured pool. */
export interface QuotaPoolBinding {
  readonly poolID: QuotaPoolID
  readonly label: string
  readonly usageEntryIDs: readonly string[]
}

/** Configuration needed to normalize a usage document. */
export interface UsageDocumentOptions {
  readonly pools: readonly QuotaPoolBinding[]
}

/** One quota window reported by a vendor, already narrowed. */
interface UsageMetric {
  readonly label: string
  /** Consumed percentage, or null when the vendor did not report one. */
  readonly percent: number | null
  /** Window length in seconds, or null when absent or unparseable. */
  readonly windowSecs: number | null
  readonly resetAt: string | null
}

/** One subscription account as reported by `ai-usagebar`, already narrowed. */
interface UsageEntry {
  readonly id: string
  /** Human label: the vendor display name plus its plan, when reported. */
  readonly label: string
  /** Only `"ready"` means the reading may gate routing. */
  readonly status: string
  readonly stale: boolean
  readonly error: string | null
  readonly fetchedAt: string | null
  readonly metrics: readonly UsageMetric[]
}

/** Everything needed to run the binary once. */
export interface UsageBarInvocation {
  readonly binary: string
  readonly args: readonly string[]
  readonly timeoutMs: number
}

/**
 * Runs the usage bar and returns its decoded JSON payload. The signal must be
 * the caller's `AbortSignal` so a hung binary can be cancelled. Normalization
 * is left to `parseUsageDocument`, which is the single place that interprets
 * vendor fields.
 */
export type UsageDocumentFetcher = (
  invocation: UsageBarInvocation,
  signal: AbortSignal,
) => Promise<unknown>

/** Failure raised while running or decoding `ai-usagebar` output. */
export class UsageBarError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageBarError"
  }
}

/**
 * Runs the binary with `execFile`, so arguments never pass through a shell,
 * and decodes its JSON payload.
 *
 * @param invocation Binary path, argument vector and timeout to apply.
 * @param signal Abort signal that kills the child process when it fires.
 * @returns The decoded payload, still in the vendor wire shape.
 * @throws {UsageBarError} When the process fails, is aborted, times out, or
 * prints something that is not a usage document.
 */
export async function fetchUsageDocument(
  invocation: UsageBarInvocation,
  signal: AbortSignal,
): Promise<unknown> {
  const stdout = await runInvocation(invocation, signal)
  return assertUsageDocument(decodeJson(stdout, invocation), invocation)
}

/**
 * Runs the binary and decodes any JSON payload, without asserting its shape.
 *
 * @param invocation Binary path, argument vector and timeout to apply.
 * @param signal Abort signal that kills the child process when it fires.
 * @returns The decoded payload.
 * @throws {UsageBarError} When the process fails or prints something that is
 * not JSON.
 */
export async function fetchJsonDocument(
  invocation: UsageBarInvocation,
  signal: AbortSignal,
): Promise<unknown> {
  const stdout = await runInvocation(invocation, signal)
  return decodeJson(stdout, invocation)
}

/**
 * Normalizes a raw usage document into one state per configured pool.
 *
 * Tolerant by design: a malformed payload never throws, it degrades every pool
 * to `unknown` with an actionable error, because a missing reading must never
 * be mistaken for free quota.
 *
 * @param raw Value decoded from the binary, or anything a caller has.
 * @param options Pool bindings the router expects to read.
 * @returns One `QuotaPoolState` per configured pool, in configuration order.
 */
export function parseUsageDocument(
  raw: unknown,
  options: UsageDocumentOptions,
): QuotaPoolState[] {
  const entries = readUsageEntries(raw)
  if (!entries) {
    return unknownPoolStates(
      options.pools,
      `ai-usagebar document is unusable: expected an object with an "entries" array, received ${describeShape(raw)}`,
    )
  }
  return options.pools.map((binding) => buildPoolState(binding, entries))
}

/**
 * Discovers one quota pool per entry the usage document reports, so the set
 * of subscriptions follows `ai-usagebar` instead of a table in this plugin.
 *
 * @param raw Value decoded from `ai-usagebar usage --json`.
 * @returns One binding per reported entry, keyed by its vendor id; empty when
 *   the document is unusable.
 */
export function discoverPoolBindings(raw: unknown): QuotaPoolBinding[] {
  const entries = readUsageEntries(raw) ?? []
  return entries.map((entry) => ({
    poolID: entry.id,
    label: entry.label,
    usageEntryIDs: [entry.id],
  }))
}

/**
 * Whether a pool reading proves a subscription: the vendor answered and
 * reported at least one inference window with a length and a percentage.
 * Credit balances and failed readings carry no window, so pay-as-you-go
 * vendors never qualify.
 *
 * @param pool Pool state produced by {@link parseUsageDocument}.
 * @returns True when the reading is a time-windowed subscription quota.
 */
export function isSubscriptionReading(pool: QuotaPoolState): boolean {
  if (pool.status === "unknown") return false
  return pool.windows.some(
    (window) =>
      isInferenceWindow(window) &&
      window.windowSecs !== null &&
      window.usedPercent !== null,
  )
}

/**
 * Reads how each vendor authenticates from `ai-usagebar vendors --json`.
 *
 * @param raw Decoded vendors payload.
 * @returns Vendor id to its authentication kind (`oauth`, `apikey`, `local`);
 *   empty when the payload is unusable.
 */
export function parseVendorKinds(raw: unknown): ReadonlyMap<string, string> {
  const kinds = new Map<string, string>()
  for (const item of asList(asRecord(raw)?.vendors)) {
    const record = asRecord(item)
    const id = record ? readText(record.id) : null
    const kind = record ? readText(record.kind) : null
    if (id !== null && kind !== null) kinds.set(id, kind)
  }
  return kinds
}

/**
 * Builds the placeholder state used before the first reading and after a failed
 * one. Dropping old percentages is deliberate: mixing a fresh error with an
 * older reading would let the router trust numbers it cannot verify.
 *
 * @param pools Pool bindings to describe.
 * @param error Failure to expose, or null when the state precedes any fetch.
 * @returns One `unknown` state per configured pool.
 */
export function unknownPoolStates(
  pools: readonly QuotaPoolBinding[],
  error: string | null = null,
): QuotaPoolState[] {
  return pools.map((binding) => ({
    poolID: binding.poolID,
    label: binding.label,
    status: "unknown",
    windows: [],
    fetchedAt: null,
    error,
  }))
}

/**
 * Derives pressure from the inference windows of one pool.
 *
 * Windows are independent, so the worst one decides the reading: a pool at 4%
 * on the 5h window and 94% on the weekly window is under pressure.
 *
 * @param poolID Requested pool id, echoed back even when the pool is unknown.
 * @param pool Pool state, or undefined when the id is not configured.
 * @returns A pressure record that is safe for an unknown pool.
 */
export function poolPressureFor(
  poolID: QuotaPoolID,
  pool: QuotaPoolState | undefined,
): PoolPressure {
  const inferenceWindows = (pool?.windows ?? []).filter(isInferenceWindow)
  const worstUsedPercent = worstPercentOf(inferenceWindows)
  const verified = pool !== undefined && pool.status !== "unknown"
  return {
    poolID,
    known: verified && worstUsedPercent !== null,
    worstUsedPercent,
    headroomRatio:
      verified && worstUsedPercent !== null
        ? remainingRatio(worstUsedPercent)
        : null,
    status: pool?.status ?? "unknown",
    nextResetAt: nextResetOf(inferenceWindows, worstUsedPercent),
  }
}

/**
 * Narrow a pool to the windows that meter one model, recomputing its status.
 * A pool exhausted only by another model category is available to this one.
 *
 * @param pool Pool state for every model.
 * @param modelID Model the caller is about to spend.
 * @returns The same pool when no window is model-scoped, else a scoped copy.
 */
export function scopePoolToModel(pool: QuotaPoolState, modelID: string): QuotaPoolState {
  if (!pool.windows.some((window) => window.models !== undefined)) return pool
  const windows = pool.windows.filter((window) => metersModel(window, modelID))
  return { ...pool, windows, status: scopedStatus(pool, windows) }
}

function metersModel(window: QuotaWindow, modelID: string): boolean {
  if (window.models === undefined) return true
  return new RegExp(window.models.pattern, "i").test(modelID) === window.models.matches
}

function scopedStatus(pool: QuotaPoolState, windows: readonly QuotaWindow[]): QuotaPoolState["status"] {
  const worst = worstPercentOf(windows.filter(isInferenceWindow))
  if (worst !== null && worst >= EXHAUSTED_PERCENT) return "exhausted"
  if (pool.status !== "exhausted") return pool.status
  if (pool.error !== null || worst === null) return "unknown"
  return "available"
}

/**
 * Stable window identifier, so curated profiles can reference a window without
 * depending on the vendor wording.
 *
 * @param windowSecs Window length, or null when the vendor omits it.
 * @returns `5h`, `weekly`, `monthly`, or `w<windowSecs>`.
 */
export function windowIDFor(windowSecs: number | null): string {
  if (windowSecs === FIVE_HOURS_SECS) return "5h"
  if (windowSecs === WEEK_SECS) return "weekly"
  if (windowSecs === null || windowSecs === MONTH_SECS) return MONTHLY_ID
  return `w${windowSecs}`
}

/**
 * Turns a thrown value into a short, single line message.
 *
 * @param error Value caught from the usage bar or an injected fetcher.
 * @returns A message that never exceeds the error budget.
 */
export function describeUsageFailure(error: unknown): string {
  if (error instanceof Error) {
    return collapse(error.name, error.message)
  }
  return collapse("NonError", String(error))
}

function runInvocation(
  invocation: UsageBarInvocation,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      invocation.binary,
      [...invocation.args],
      {
        encoding: "utf8",
        signal,
        timeout: invocation.timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
      },
      (error, stdout) => {
        if (error) {
          reject(invocationFailure(error, invocation))
          return
        }
        resolve(stdout)
      },
    )
  })
}

function invocationFailure(
  error: ExecFileException,
  invocation: UsageBarInvocation,
): UsageBarError {
  const code = typeof error.code === "string" ? ` ${error.code}:` : ""
  return new UsageBarError(
    collapse(
      "UsageBarError",
      `ai-usagebar command failed:${code} ${error.message} (command: ${commandLineOf(invocation)})`,
    ),
  )
}

function decodeJson(stdout: string, invocation: UsageBarInvocation): unknown {
  try {
    return JSON.parse(stdout) as unknown
  } catch {
    throw new UsageBarError(
      collapse(
        "UsageBarError",
        `ai-usagebar printed output that is not JSON: ${stdout} (command: ${commandLineOf(invocation)})`,
      ),
    )
  }
}

function assertUsageDocument(
  value: unknown,
  invocation: UsageBarInvocation,
): unknown {
  if (!readUsageEntries(value)) {
    throw new UsageBarError(
      collapse(
        "UsageBarError",
        `ai-usagebar printed a payload without a usable "entries" array: ${describeShape(value)} (command: ${commandLineOf(invocation)})`,
      ),
    )
  }
  return value
}

function readUsageEntries(value: unknown): readonly UsageEntry[] | undefined {
  const record = asRecord(value)
  if (!record || !Array.isArray(record.entries)) return undefined
  return (record.entries as readonly unknown[]).flatMap(readUsageEntry)
}

function readUsageEntry(value: unknown): readonly UsageEntry[] {
  const record = asRecord(value)
  const id = record ? readText(record.id) : null
  if (!record || id === null) return []
  return [
    {
      id,
      label: entryLabelOf(record, id),
      status: readText(record.status) ?? "",
      stale: record.stale === true,
      error: readText(record.error),
      fetchedAt: readText(record.fetched_at),
      metrics: readUsageMetrics(record.metrics),
    },
  ]
}

function entryLabelOf(record: Record<string, unknown>, id: string): string {
  const name = readText(record.display_name) ?? id
  const plan = readText(record.plan)
  return plan === null ? name : `${name} (${plan})`
}

function readUsageMetrics(value: unknown): readonly UsageMetric[] {
  return asList(value).flatMap(readUsageMetric)
}

function readUsageMetric(value: unknown): readonly UsageMetric[] {
  const record = asRecord(value)
  if (!record) return []
  return [
    {
      label: readText(record.label) ?? "unnamed",
      percent: readPercent(record.percent),
      windowSecs: readWindowSecs(record.window_secs),
      resetAt: readText(record.reset_at),
    },
  ]
}

function buildPoolState(
  binding: QuotaPoolBinding,
  entries: readonly UsageEntry[],
): QuotaPoolState {
  const contributors = binding.usageEntryIDs
    .map((entryID) => entries.find((entry) => entry.id === entryID))
    .filter((entry): entry is UsageEntry => entry !== undefined)
  const missing = binding.usageEntryIDs.filter(
    (entryID) => !contributors.some((entry) => entry.id === entryID),
  )
  const windows = mergeWindows(contributors.flatMap(entryWindows))
  const error =
    firstErrorOf(contributors) ?? missingErrorOf(missing, contributors.length)
  return {
    poolID: binding.poolID,
    label: binding.label,
    status: derivePoolStatus({ windows, error, contributors }),
    windows,
    fetchedAt: newestTimestampOf(contributors),
    error,
  }
}

function entryWindows(entry: UsageEntry): readonly QuotaWindow[] {
  return entry.metrics.map((metric) => toWindow(entry.id, metric))
}

function toWindow(vendorID: string, metric: UsageMetric): QuotaWindow {
  const scope = MODEL_SCOPED_WINDOWS.find(
    (candidate) => candidate.vendorID === vendorID && candidate.label.test(metric.label),
  )
  return {
    id: scope === undefined ? windowIDFor(metric.windowSecs) : `${windowIDFor(metric.windowSecs)}:${metric.label.toLowerCase()}`,
    label: metric.label,
    windowSecs: metric.windowSecs,
    usedPercent: metric.percent,
    resetsAt: metric.resetAt,
    dimension: isNonInference(metric) ? "other" : "inference",
    ...(scope === undefined ? {} : { models: scope.models }),
  }
}

/**
 * MCP tool quotas do not bound model inference. Every other signal stays
 * inference on purpose: an unclassified quota must never silently free a pool.
 */
function isNonInference(metric: UsageMetric): boolean {
  return NON_INFERENCE_LABEL.test(metric.label)
}

/**
 * Collapses windows that share an id, taking the highest consumption, because
 * a shared account cannot be less consumed than the reporters describing it.
 */
function mergeWindows(windows: readonly QuotaWindow[]): readonly QuotaWindow[] {
  const merged = new Map<string, QuotaWindow>()
  for (const window of windows) {
    const current = merged.get(window.id)
    merged.set(window.id, current ? mergePair(current, window) : window)
  }
  return [...merged.values()]
}

function mergePair(current: QuotaWindow, incoming: QuotaWindow): QuotaWindow {
  const binding = bindingWindow(current, incoming)
  const secondary = binding === current ? incoming : current
  return {
    id: binding.id,
    label: binding.label,
    windowSecs: binding.windowSecs ?? secondary.windowSecs,
    usedPercent: binding.usedPercent,
    resetsAt: binding.resetsAt ?? secondary.resetsAt,
    dimension: binding.dimension === "other" ? "other" : secondary.dimension,
  }
}

function bindingWindow(current: QuotaWindow, incoming: QuotaWindow): QuotaWindow {
  const left = current.usedPercent
  const right = incoming.usedPercent
  if (left === null) return right === null ? current : incoming
  if (right === null) return current
  return right > left ? incoming : current
}

interface PoolStatusInput {
  readonly windows: readonly QuotaWindow[]
  readonly error: string | null
  readonly contributors: readonly UsageEntry[]
}

/**
 * Status precedence: a fully consumed window is a hard block no matter how old
 * the reading is, then anything unverified becomes `unknown`, and a stale but
 * readable pool keeps its numbers under the weaker `stale` status.
 */
function derivePoolStatus(input: PoolStatusInput): QuotaPoolState["status"] {
  const worstUsedPercent = worstPercentOf(input.windows.filter(isInferenceWindow))
  if (worstUsedPercent !== null && worstUsedPercent >= EXHAUSTED_PERCENT) {
    return "exhausted"
  }
  if (input.error !== null) return "unknown"
  if (input.contributors.length === 0) return "unknown"
  if (!input.contributors.every((entry) => entry.status === "ready")) return "unknown"
  if (worstUsedPercent === null) return "unknown"
  if (input.contributors.some((entry) => entry.stale)) return "stale"
  return "available"
}

function isInferenceWindow(window: QuotaWindow): boolean {
  return window.dimension === "inference"
}

function worstPercentOf(windows: readonly QuotaWindow[]): number | null {
  const known = windows
    .map((window) => window.usedPercent)
    .filter((percent): percent is number => percent !== null)
  return known.length === 0 ? null : Math.max(...known)
}

function firstErrorOf(entries: readonly UsageEntry[]): string | null {
  const failed = entries.find((entry) => entry.error !== null)
  if (!failed) return null
  return `ai-usagebar entry "${failed.id}" failed: ${failed.error ?? "unknown error"}`
}

function missingErrorOf(
  missing: readonly string[],
  contributorCount: number,
): string | null {
  if (missing.length === 0) return null
  return `ai-usagebar did not report shared pool entries: ${missing.join(", ")} (reported ${contributorCount})`
}

function newestTimestampOf(entries: readonly UsageEntry[]): string | null {
  const known = entries
    .map((entry) => entry.fetchedAt)
    .filter((stamp): stamp is string => stamp !== null)
  return known.length === 0 ? null : (known.sort().at(-1) ?? null)
}

/** Remaining share of a window, computed from the untouched numerator to avoid float drift. */
function remainingRatio(worstUsedPercent: number): number {
  const remaining = EXHAUSTED_PERCENT - Math.max(0, worstUsedPercent)
  return Math.max(0, Math.min(1, remaining / EXHAUSTED_PERCENT))
}

/**
 * The reset that matters is the one of the binding window; other resets are
 * only a fallback for when the binding window announces none.
 */
function nextResetOf(
  inferenceWindows: readonly QuotaWindow[],
  worstUsedPercent: number | null,
): string | null {
  if (worstUsedPercent === null) return null
  const binding = inferenceWindows.find(
    (window) => window.usedPercent === worstUsedPercent,
  )
  if (binding?.resetsAt) return binding.resetsAt
  return earliestResetOf(inferenceWindows)
}

function earliestResetOf(windows: readonly QuotaWindow[]): string | null {
  const known = windows
    .map((window) => window.resetsAt)
    .filter((stamp): stamp is string => stamp !== null)
  return known.length === 0 ? null : (known.sort().at(0) ?? null)
}

/** A vendor that reports no percentage, or a nonsense one, yields no percentage. */
function readPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null
  }
  return value
}

function readWindowSecs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null
  }
  return Math.round(value)
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

function asList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : []
}

function describeShape(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  return `a value of type ${typeof value}`
}

function commandLineOf(invocation: UsageBarInvocation): string {
  return [invocation.binary, ...invocation.args].join(" ")
}

function collapse(head: string, body: string): string {
  const flat = `${head}: ${body}`.replace(/\s+/g, " ").trim()
  if (flat.length <= MAX_ERROR_CHARS) return flat
  return `${flat.slice(0, MAX_ERROR_CHARS)}… (truncated)`
}