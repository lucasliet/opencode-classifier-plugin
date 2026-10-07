import { truncate } from "../config.ts"
import { noul } from "../jev.ts"
import type { JevClient } from "../jev.ts"
import type { JevQuestion, ResolvedOptions } from "../types.ts"

/** A skill or Code Mode namespace Jev can select for a task. */
export interface CapabilityCandidate {
  /** `skill:<id>` or `namespace:<name>`. */
  readonly key: string
  readonly kind: "skill" | "namespace"
  readonly name: string
  /** What the model would otherwise read about it. */
  readonly summary: string
}

/** Longest summary sent to Jev for one candidate. */
const MAX_SUMMARY_CHARS = 800
/** Room kept in each batch for the state envelope and the instruction. */
const ENVELOPE_CHARS = 512

/**
 * Ask Jev which skills and namespaces the task needs. Candidates are split
 * into batches that fit `privacy.maxStateChars` and judged in parallel; an
 * answer Jev leaves out counts as needed, so a partial reply never hides a
 * capability.
 *
 * @param jev Client used to reach System One.
 * @param options Resolved plugin configuration.
 * @param task The user's request for this turn.
 * @param candidates Skills and namespaces to judge.
 * @returns Keys of the candidates relevant at `capabilities.relevantAt` or above.
 * @throws When any Jev request fails; the caller keeps the full catalog.
 */
export async function judgeCapabilities(
  jev: JevClient,
  options: ResolvedOptions,
  task: string,
  candidates: readonly CapabilityCandidate[],
): Promise<Set<string>> {
  const taskText = truncate(task, options.privacy.maxPromptChars)
  const budget = Math.max(MAX_SUMMARY_CHARS * 2, options.privacy.maxStateChars - taskText.length - ENVELOPE_CHARS)
  const batches = batchByBudget(candidates, budget)
  const verdicts = await Promise.all(batches.map((batch) => judgeBatch(jev, options, taskText, batch)))
  return new Set(verdicts.flat())
}

async function judgeBatch(
  jev: JevClient,
  options: ResolvedOptions,
  task: string,
  batch: readonly CapabilityCandidate[],
): Promise<string[]> {
  const questions: Record<string, JevQuestion> = {}
  batch.forEach((candidate, index) => {
    questions[`item_${index}`] = { type: "noul", instructions: questionFor(candidate) }
  })
  const response = await jev.ask(
    {
      task,
      candidates: batch.map((candidate, index) => ({
        index,
        kind: candidate.kind,
        name: candidate.name,
        summary: truncate(candidate.summary, MAX_SUMMARY_CHARS),
      })),
      instruction:
        "Judge relevance only; do not solve the task. A candidate is needed when the task plausibly uses it while being carried out. Generic engineering work needs no specialized skill.",
    },
    questions,
  )
  return batch
    .filter((_candidate, index) => noul(response, `item_${index}`, 1) >= options.capabilities.relevantAt)
    .map((candidate) => candidate.key)
}

function questionFor(candidate: CapabilityCandidate): string {
  if (candidate.kind === "skill") {
    return `Will the coding agent need the "${candidate.name}" skill to carry out this task?`
  }
  return `Will the coding agent need tools from the "${candidate.name}" tool namespace to carry out this task?`
}

function batchByBudget(
  candidates: readonly CapabilityCandidate[],
  budget: number,
): CapabilityCandidate[][] {
  const batches: CapabilityCandidate[][] = []
  let current: CapabilityCandidate[] = []
  let used = 0
  for (const candidate of candidates) {
    const cost = Math.min(candidate.summary.length, MAX_SUMMARY_CHARS) + candidate.name.length + 64
    if (current.length > 0 && used + cost > budget) {
      batches.push(current)
      current = []
      used = 0
    }
    current.push(candidate)
    used += cost
  }
  if (current.length > 0) batches.push(current)
  return batches
}
