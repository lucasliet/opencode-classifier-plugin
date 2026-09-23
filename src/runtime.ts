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

  const properties =
    record.properties && typeof record.properties === "object"
      ? (record.properties as Record<string, unknown>)
      : undefined
  if (typeof properties?.sessionID === "string") return properties.sessionID

  const part =
    properties?.part && typeof properties.part === "object"
      ? (properties.part as Record<string, unknown>)
      : undefined
  if (typeof part?.sessionID === "string") return part.sessionID

  return undefined
}
