import type { ResolvedOptions } from "./types.ts"
import { noul, type JevClient } from "./jev.ts"
import { hashString, truncate } from "./config.ts"

export async function filterLargeToolContext(
  jev: JevClient,
  options: ResolvedOptions,
  task: string,
  messages: unknown[],
  cache?: Map<string, string | undefined>,
): Promise<void> {
  if (!options.context.enabled || !task.trim()) return

  for (const message of messages) {
    if (!isAssistantMessage(message)) continue
    await visitForToolText(
      jev,
      options,
      task,
      message,
      false,
      new WeakSet<object>(),
      cache,
    )
  }
}

async function visitForToolText(
  jev: JevClient,
  options: ResolvedOptions,
  task: string,
  value: unknown,
  insideTool: boolean,
  seen: WeakSet<object>,
  cache?: Map<string, string | undefined>,
): Promise<void> {
  if (!value || typeof value !== "object") return
  if (seen.has(value)) return
  seen.add(value)

  if (Array.isArray(value)) {
    for (const item of value) {
      await visitForToolText(jev, options, task, item, insideTool, seen, cache)
    }
    return
  }

  const record = value as Record<string, unknown>
  const nextInsideTool =
    insideTool ||
    record.type === "tool" ||
    record.type === "tool-result" ||
    record.type === "tool_result" ||
    typeof record.tool === "string"

  if (record.type === "tool" && record.state && typeof record.state === "object") {
    const state = record.state as Record<string, unknown>
    if (
      state.status === "completed" &&
      typeof state.output === "string" &&
      state.output.length >= options.context.minChars
    ) {
      const filtered = await cachedFilter(
        jev,
        options,
        task,
        state.output,
        cache,
      )
      if (filtered && filtered.length < state.output.length) state.output = filtered
    }
  }

  if (
    nextInsideTool &&
    record.type === "text" &&
    typeof record.text === "string" &&
    record.text.length >= options.context.minChars
  ) {
    const filtered = await cachedFilter(
      jev,
      options,
      task,
      record.text,
      cache,
    )
    if (filtered && filtered.length < record.text.length) record.text = filtered
  }

  for (const [key, child] of Object.entries(record)) {
    const keySuggestsTool = /^(tool|tools|result|results|content|output|state)$/i.test(key)
    await visitForToolText(
      jev,
      options,
      task,
      child,
      nextInsideTool || (insideTool && keySuggestsTool),
      seen,
      cache,
    )
  }
}

function isAssistantMessage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>

  if (record.type === "assistant" || record.role === "assistant") return true
  if (record.info && typeof record.info === "object") {
    return (record.info as Record<string, unknown>).role === "assistant"
  }
  return false
}

async function cachedFilter(
  jev: JevClient,
  options: ResolvedOptions,
  task: string,
  text: string,
  cache?: Map<string, string | undefined>,
): Promise<string | undefined> {
  const cacheKey = contextCacheKey(task, text, options)
  if (cache?.has(cacheKey)) return cache.get(cacheKey)

  const filtered = await filterText(jev, options, task, text)
  if (cache) {
    cache.set(cacheKey, filtered)
    trimCache(cache, 128)
  }
  return filtered
}

export async function filterText(
  jev: JevClient,
  options: ResolvedOptions,
  task: string,
  text: string,
): Promise<string | undefined> {
  const chunks = splitChunks(text, options.context.chunkChars)
  if (chunks.length < options.context.minimumCandidates) return undefined

  const scores = new Array<number>(chunks.length).fill(1)
  const batchSize = Math.max(1, options.context.maxCandidates)
  const maxChunks = Math.min(chunks.length, batchSize * options.context.maxBatches)
  const taskBudget = Math.max(
    128,
    Math.min(
      options.privacy.maxPromptChars,
      Math.floor(options.privacy.maxStateChars / 3),
    ),
  )
  const taskText = truncate(task, taskBudget)
  const batchBudget = Math.max(
    512,
    options.privacy.maxStateChars - taskText.length - 512,
  )
  let processed = 0
  let batches = 0

  while (processed < maxChunks && batches < options.context.maxBatches) {
    const batch = chunks.slice(processed, Math.min(maxChunks, processed + batchSize))
    const bounded = fitBatchToBudget(
      batch,
      processed,
      batchBudget,
      options.context.chunkChars,
    )
    if (bounded.items.length === 0) break

    const questions: Record<string, { type: "noul"; instructions: string }> = {}
    bounded.items.forEach((item) => {
      questions[`chunk_${item.index}`] = {
        type: "noul",
        instructions: `Is chunk ${item.index} materially relevant evidence for answering the stated coding task?`,
      }
    })

    const response = await jev.ask(
      {
        task: taskText,
        chunks: bounded.items,
        instruction:
          "Judge relevance only. Keep chunks needed to understand errors, code behavior, file locations, constraints, or requested output.",
      },
      questions,
    )

    for (const item of bounded.items) {
      scores[item.index] = noul(response, `chunk_${item.index}`, 1)
    }

    processed += bounded.items.length
    batches += 1
  }
  const kept: string[] = []
  let removed = 0
  let bestProcessedIndex = 0
  let bestProcessedScore = -1

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index] ?? ""
    if (index >= processed) {
      kept.push(chunk)
      continue
    }

    const score = scores[index] ?? 1
    if (score > bestProcessedScore) {
      bestProcessedScore = score
      bestProcessedIndex = index
    }

    if (score >= options.context.relevantAt) kept.push(chunk)
    else removed += 1
  }

  if (removed === 0) return undefined

  if (kept.length === 0) {
    kept.push(chunks[bestProcessedIndex] ?? "")
  }

  const unprocessed = Math.max(0, chunks.length - processed)
  return [
    ...kept,
    `\n[opencode-classifier-plugin: Jev omitted ${removed} low-relevance context chunk(s) from this model request only; ${unprocessed} chunk(s) were retained without classification due to configured batching limits; persisted session history is unchanged.]`,
  ].join("\n")
}

function splitChunks(text: string, chunkChars: number): string[] {
  const size = Math.max(1, chunkChars)
  const chunks: string[] = []
  for (let start = 0; start < text.length; start += size) {
    chunks.push(text.slice(start, start + size))
  }
  return chunks
}

function fitBatchToBudget(
  chunks: string[],
  startIndex: number,
  maxStateChars: number,
  maxChunkChars: number,
): { items: Array<{ index: number; text: string }> } {
  const items: Array<{ index: number; text: string }> = []
  let used = 0

  for (let offset = 0; offset < chunks.length; offset += 1) {
    const text = truncate(chunks[offset] ?? "", maxChunkChars)
    const cost = text.length + 64
    if (items.length > 0 && used + cost > maxStateChars) break
    if (items.length === 0 && cost > maxStateChars) {
      items.push({
        index: startIndex + offset,
        text: truncate(text, Math.max(256, maxStateChars - 64)),
      })
      break
    }
    items.push({ index: startIndex + offset, text })
    used += cost
  }

  return { items }
}

function contextCacheKey(
  task: string,
  text: string,
  options: ResolvedOptions,
): string {
  return hashString(
    [
      task,
      text,
      options.context.chunkChars,
      options.context.maxCandidates,
      options.context.maxBatches,
      options.context.relevantAt,
      options.privacy.maxStateChars,
      options.privacy.maxPromptChars,
    ].join("\u0000"),
  )
}

function trimCache(
  cache: Map<string, string | undefined>,
  maxEntries: number,
): void {
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value
    if (typeof oldest !== "string") break
    cache.delete(oldest)
  }
}
