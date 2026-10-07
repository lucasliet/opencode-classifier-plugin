import type { SessionRuntimeState } from "./types.ts"

/**
 * Create the per-session scratchpad the hooks share.
 *
 * Starts inert: routing is off until a hook observes the virtual router or the
 * user switches models, so a session never rewrites the model by accident.
 *
 * @returns A fresh session state with no model recorded yet.
 */
export function createSessionState(): SessionRuntimeState {
  return {
    routerActive: false,
    directives: [],
  }
}

/**
 * Append a classifier directive for the next system prompt.
 *
 * Bounded to the last eight entries so a long session cannot grow the prompt
 * without limit.
 *
 * @param state Session state to mutate.
 * @param text Directive text; blank input is ignored.
 */
export function pushDirective(state: SessionRuntimeState, text: string): void {
  const cleaned = text.trim()
  if (!cleaned) return
  state.directives.push(cleaned)
  if (state.directives.length > 8) state.directives.shift()
}

/**
 * Extract the session ID from a hook event of either API generation.
 *
 * V2 event payloads nest fields under `data`; V1 buses use `properties`, and
 * some V1 permission events push the ID one level deeper inside `part`. Both
 * shapes are probed because the plugin runs on either host generation.
 *
 * @param event Raw hook event of unknown shape.
 * @returns The session ID when the event carries one, otherwise undefined.
 */
export function eventSessionID(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined
  const record = event as Record<string, unknown>

  if (typeof record.sessionID === "string") return record.sessionID

  for (const key of ["data", "properties"]) {
    const container =
      record[key] && typeof record[key] === "object"
        ? (record[key] as Record<string, unknown>)
        : undefined
    if (typeof container?.sessionID === "string") return container.sessionID

    const part =
      container?.part && typeof container.part === "object"
        ? (container.part as Record<string, unknown>)
        : undefined
    if (typeof part?.sessionID === "string") return part.sessionID
  }

  return undefined
}
