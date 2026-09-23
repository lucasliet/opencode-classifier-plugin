import type { LoopState, SessionRuntimeState } from "./types.ts"

export function createSessionState(): SessionRuntimeState {
  return {
    routerActive: false,
    routedSkills: [],
    skillSelectionDone: false,
    rounds: 0,
    verificationPending: false,
    sameFailureCount: 0,
    loopState: "work",
    directives: [],
  }
}

export function setLoopState(
  state: SessionRuntimeState,
  next: LoopState,
  reason?: string,
): void {
  state.loopState = next
  if (next !== "retry") {
    delete state.retryTool
    delete state.retryInputHash
  }
  if (reason?.trim()) state.loopReason = reason.trim()
  else delete state.loopReason
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

export function isMutationTool(tool: string, input?: unknown): boolean {
  if (/^(write|edit|patch|apply_patch|delete|move|rename|deploy|publish)/i.test(tool)) return true
  if (/^task/i.test(tool)) return true

  if (/^(bash|shell|exec|command)/i.test(tool)) {
    const command = extractCommand(input)
    if (!command) return true
    if (containsKnownMutation(command)) return true
    if (/[;&|><]/.test(command)) return true
    if (isKnownValidationCommand(command) || isKnownReadOnlyCommand(command)) return false
    return true
  }

  return false
}

export function isValidationTool(tool: string, input: unknown): boolean {
  if (/^(test|lint|typecheck|check|build)/i.test(tool)) return true
  const command = extractCommand(input)
  if (!command) return false
  return isKnownValidationCommand(command)
}

function extractCommand(input: unknown): string {
  if (typeof input === "string") return input
  if (!input || typeof input !== "object") return ""

  const record = input as Record<string, unknown>
  for (const key of ["command", "cmd", "script", "shell", "input"]) {
    const value = record[key]
    if (typeof value === "string") return value
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return value.join(" ")
    }
  }

  try {
    return JSON.stringify(input)
  } catch {
    return ""
  }
}

function isKnownValidationCommand(command: string): boolean {
  return /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|check|build)\b|\b(?:npx\s+)?(?:vitest|jest|pytest|tsc|eslint|biome\s+check|cargo\s+test|cargo\s+check|go\s+test|go\s+vet|dotnet\s+test|mvn\s+test|gradle\s+test)\b/i.test(
    command,
  )
}

function containsKnownMutation(command: string): boolean {
  return /(?:^|[;&|]\s*)(?:rm|mv|cp|install|mkdir|touch|tee|chmod|chown|git\s+(?:add|commit|reset|checkout|switch|restore|rebase|merge|cherry-pick|clean|push|tag)|npm\s+(?:install|i|uninstall|update|publish)|pnpm\s+(?:add|install|remove|update|publish)|yarn\s+(?:add|install|remove|publish)|bun\s+(?:add|install|remove|publish)|curl\b.*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s*(?:POST|PUT|PATCH|DELETE)))\b/i.test(
    command.trim(),
  )
}

function isKnownReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false

  return /^(?:pwd|ls(?:\s|$)|find(?:\s|$)|fd(?:\s|$)|rg(?:\s|$)|grep(?:\s|$)|cat(?:\s|$)|head(?:\s|$)|tail(?:\s|$)|sed\s+-n\b|wc(?:\s|$)|stat(?:\s|$)|git\s+(?:status|diff|log|show|branch|rev-parse|remote)(?:\s|$)|npm\s+(?:view|list|ls|why)(?:\s|$)|pnpm\s+(?:list|why)(?:\s|$)|node\s+--version\b|python\s+--version\b)/i.test(
    trimmed,
  )
}
