import type { SessionRuntimeState } from "./types.ts"

export function createSessionState(): SessionRuntimeState {
  return {
    routerActive: false,
    directives: [],
  }
}

export function pushDirective(state: SessionRuntimeState, text: string): void {
  const cleaned = text.trim()
  if (!cleaned) return
  state.directives.push(cleaned)
  if (state.directives.length > 8) state.directives.shift()
}

export function eventSessionID(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined
  const record = event as Record<string, unknown>

  if (typeof record.sessionID === "string") return record.sessionID

  // V2 event payloads nest fields under `data`; V1 buses use `properties`.
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
