import type { CapabilityCandidate } from "./judge.ts"

/** Judges candidates for a task and returns the keys it needs. */
export type CapabilityJudge = (
  task: string,
  candidates: readonly CapabilityCandidate[],
) => Promise<ReadonlySet<string>>

/** Per-session record of what Jev has selected. */
export interface CapabilitySelector {
  /**
   * Keys to keep described for the session's current task.
   *
   * @returns The selected keys, or undefined when Jev failed for this task and
   *   the full catalog must stay in place.
   */
  selectedFor(
    sessionID: string,
    task: string,
    candidates: readonly CapabilityCandidate[],
  ): Promise<ReadonlySet<string> | undefined>
  forget(sessionID: string): void
}

interface SessionSelection {
  /** Every key Jev ever selected in the session; selections accumulate. */
  readonly selected: Set<string>
  task: string | undefined
  /** Keys already judged for `task`, selected or not. */
  judged: Set<string>
  failed: boolean
  pending: Promise<void> | undefined
}

/**
 * Create the selector. Jev runs once per user prompt, only for candidates it
 * has not judged for that prompt, and what it selects stays selected for the
 * rest of the session: the described catalog then changes only when something
 * new is needed, which keeps the provider's prompt cache warm.
 *
 * @param judge Jev-backed relevance check.
 * @param pinnedKeys Candidate keys that are never judged and always kept.
 * @returns The selector.
 */
export function createCapabilitySelector(
  judge: CapabilityJudge,
  pinnedKeys: readonly string[],
): CapabilitySelector {
  const pinned = new Set(pinnedKeys)
  const sessions = new Map<string, SessionSelection>()

  const stateFor = (sessionID: string): SessionSelection => {
    let state = sessions.get(sessionID)
    if (state === undefined) {
      state = { selected: new Set(), task: undefined, judged: new Set(), failed: false, pending: undefined }
      sessions.set(sessionID, state)
    }
    return state
  }

  const judgePending = async (
    state: SessionSelection,
    task: string,
    pending: readonly CapabilityCandidate[],
  ): Promise<void> => {
    try {
      for (const key of await judge(task, pending)) state.selected.add(key)
    } catch {
      state.failed = true
    }
    for (const candidate of pending) state.judged.add(candidate.key)
  }

  return {
    async selectedFor(sessionID, task, candidates) {
      const state = stateFor(sessionID)
      if (state.pending !== undefined) await state.pending
      if (state.task !== task) {
        state.task = task
        state.judged = new Set()
        state.failed = false
      }
      const pending = candidates.filter(
        (candidate) => !pinned.has(candidate.key) && !state.selected.has(candidate.key) && !state.judged.has(candidate.key),
      )
      if (pending.length > 0) {
        state.pending = judgePending(state, task, pending)
        await state.pending
        state.pending = undefined
      }
      if (state.failed) return undefined
      const kept = candidates.filter((candidate) => pinned.has(candidate.key)).map((candidate) => candidate.key)
      return new Set([...state.selected, ...kept])
    },
    forget(sessionID) {
      sessions.delete(sessionID)
    },
  }
}
