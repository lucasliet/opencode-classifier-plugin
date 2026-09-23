import type { Config, Plugin } from "@opencode-ai/plugin"
import { appendFileSync } from "node:fs"
import {
  VIRTUAL_MODEL_ID,
  VIRTUAL_MODEL_NAME,
  VIRTUAL_PROVIDER_ID,
  VIRTUAL_PROVIDER_NAME,
  parseModelRef,
  resolveOptions,
  safeJson,
  truncate,
} from "./config.ts"
import { JevClient } from "./jev.ts"
import {
  chooseTier,
  classifyPermission,
  classifyRoute,
} from "./classifier.ts"
import { decidePermission } from "./permission.ts"
import { filterLargeToolContext } from "./context.ts"
import {
  createSessionState,
  eventSessionID,
  pushDirective,
} from "./runtime.ts"
import type {
  ModelRef,
  ResolvedOptions,
  RouteClassification,
  SessionRuntimeState,
} from "./types.ts"

export const OpenCodeClassifierPlugin: Plugin = async (
  { client, directory, serverUrl },
  rawOptions,
) => {
  const options = resolveOptions(rawOptions)
  const jev = new JevClient(options)
  const sessions = new Map<string, SessionRuntimeState>()
  const permissionRequests = new Set<string>()
  const contextFilterCache = new Map<string, string | undefined>()

  // Trace goes to a file because stderr is interleaved into the TUI and
  // cannot be read comfortably mid-session. File logging is always on;
  // console output stays gated behind debug.
  const trace = (message: string, details: Record<string, unknown>) => {
    try {
      appendFileSync(
        process.env.OPENCODE_CLASSIFIER_LOG ??
          "/tmp/opencode-classifier-plugin.log",
        `${new Date().toISOString()} ${message} ${safeJson(details, 1_000)}\n`,
      )
    } catch {
      // Logging must never break the plugin.
    }
    if (!options.debug) return
    console.error(
      `[opencode-classifier-plugin] ${message} ${safeJson(details, 1_000)}`,
    )
  }

  const stateFor = (sessionID: string): SessionRuntimeState => {
    let state = sessions.get(sessionID)
    if (!state) {
      state = createSessionState()
      sessions.set(sessionID, state)
    }
    return state
  }

  return {
    config: async (config) => {
      if (options.router.enabled) installVirtualProvider(config)
    },

    "chat.message": async (_input, output) => {
      const sessionID = output.message.sessionID
      const state = stateFor(sessionID)
      resetTurnState(state)

      const prompt = extractPromptText(output.parts, options.privacy.maxPromptChars)
      state.task = prompt

      const messageModel = output.message.model as typeof output.message.model & {
        variant?: string
      }
      const selected: ModelRef = {
        providerID: messageModel.providerID,
        id: messageModel.modelID,
        ...(messageModel.variant ? { variant: messageModel.variant } : {}),
      }
      const selectedVirtual =
        selected.providerID === VIRTUAL_PROVIDER_ID &&
        selected.id === VIRTUAL_MODEL_ID
      const stickyContinuation =
        options.router.enabled &&
        options.router.sticky &&
        state.routerActive &&
        modelRefMatches(selected, state.lastRoutedModel)
      const useRouter =
        options.router.enabled && (selectedVirtual || stickyContinuation)

      if (selectedVirtual) {
        state.routerActive = options.router.sticky
      } else if (!useRouter) {
        state.routerActive = false
        delete state.lastRoutedModel
      }

      const needsClassification = useRouter || options.agents.enabled
      let route: RouteClassification | undefined
      let routeFailed = false

      if (needsClassification) {
        try {
          route = await classifyRoute(jev, options, prompt)
        } catch (error) {
          routeFailed = true
          route = {
            complexity: options.router.fallbackTier,
            complexityProbability: 0,
            deepReasoning: 0,
            highRisk: 0,
            research: 0,
          }
          pushDirective(
            state,
            `Jev prompt classification failed. ${errorMessage(error)}`,
          )
        }
      }

      if (
        route &&
        options.agents.enabled &&
        route.domain &&
        (route.domainProbability ?? 0) >= options.agents.minimumProbability
      ) {
        const agent = options.agents.byDomain[route.domain]
        if (agent) output.message.agent = agent
      }

      if (useRouter && route) {
        const tier = routeFailed
          ? options.router.fallbackTier
          : chooseTier(route, options)
        const target = parseModelRef(options.router.models[tier])
        const effort = options.router.efforts[tier]

        if (effort) target.variant = effort

        messageModel.providerID = target.providerID
        messageModel.modelID = target.id
        if (target.variant) messageModel.variant = target.variant
        else delete messageModel.variant

        state.routedTier = tier
        state.turnModel = target
        if (options.router.sticky) {
          state.routerActive = true
          state.lastRoutedModel = target
        } else {
          state.routerActive = false
          delete state.lastRoutedModel
        }
        return
      }

      state.turnModel = selected
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      if (!options.context.enabled) return

      const sessionID = latestSessionID(output.messages)
      if (!sessionID) return
      const state = sessions.get(sessionID)
      if (!state?.task) return

      try {
        const requestMessages = structuredClone(output.messages)
        await filterLargeToolContext(
          jev,
          options,
          state.task,
          requestMessages,
          contextFilterCache,
        )
        output.messages = requestMessages
      } catch {
        // Filtering is optional. Preserve the original request context on failure.
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      const state = sessions.get(input.sessionID)
      if (!state) return
      if (state.turnModel && !classicModelMatches(input.model, state.turnModel)) return

      if (state.directives.length > 0) {
        output.system.push(
          `Classifier guidance:\n- ${state.directives.join("\n- ")}`,
        )
        state.directives = []
      }
    },

    "permission.ask": async (input, output) => {
      if (!options.autoMode.enabled || output.status === "deny") return

      try {
        const metadata = options.privacy.includePermissionMetadata
          ? input.metadata
          : undefined
        const request = {
          action: input.type,
          resources: stringList(input.pattern),
          ...(metadata ? { metadata } : {}),
        }
        trace("permission.ask received", {
          action: request.action,
          status: output.status,
        })
        const signals = await classifyPermission(jev, options, request)

        const decision = decidePermission(output.status, signals, options, request)
        trace("permission.ask evaluated", {
          action: request.action,
          effect: decision.effect,
        })
        if (decision.effect === "allow") output.status = "allow"
        if (decision.effect === "deny") output.status = "deny"
      } catch (error) {
        trace("permission.ask classification failed", {
          error: errorMessage(error),
        })
        if (options.autoMode.onError === "ask") output.status = "ask"
      }
    },

    event: async ({ event }) => {
      const type = eventType(event)
      const properties = record(record(event).properties)

      if (type === "permission.asked" || type === "permission.v2.asked") {
        if (!options.autoMode.enabled) return

        const requestID = stringValue(properties.id)
        const sessionID = stringValue(properties.sessionID)
        if (!requestID || !sessionID || permissionRequests.has(requestID)) return

        permissionRequests.add(requestID)
        const v2 = type === "permission.v2.asked"
        trace("permission request received", {
          requestID,
          sessionID,
          action: v2 ? properties.action : properties.permission,
          host: describeReplyHost({ client, directory, serverUrl }),
        })

        try {
          const metadata = options.privacy.includePermissionMetadata
            ? record(properties.metadata)
            : undefined
          const request = {
            action: (v2
              ? stringValue(properties.action)
              : stringValue(properties.permission)) ?? "unknown",
            resources: stringList(v2 ? properties.resources : properties.patterns),
            ...(metadata ? { metadata } : {}),
          }
          const signals = await classifyPermission(jev, options, request)

          const decision = decidePermission("ask", signals, options, request)
          trace("permission policy evaluated", {
            requestID,
            effect: decision.effect,
          })
          if (decision.effect === "allow") {
            await replyToPermission(
              { client, directory, serverUrl },
              sessionID,
              requestID,
              "once",
            )
            trace("permission response sent", { requestID, reply: "once" })
          } else if (decision.effect === "deny") {
            await replyToPermission(
              { client, directory, serverUrl },
              sessionID,
              requestID,
              "reject",
            )
            trace("permission response sent", { requestID, reply: "reject" })
          }
        } catch (error) {
          trace("permission classification failed", {
            requestID,
            error: errorMessage(error),
          })
          if (options.autoMode.onError === "ask") return
        }
        return
      }

      if (type === "permission.replied" || type === "permission.v2.replied") {
        const requestID =
          stringValue(properties.requestID) ?? stringValue(properties.permissionID)
        if (requestID) permissionRequests.delete(requestID)
        return
      }

      if (type === "session.deleted") {
        const sessionID = eventSessionID(event)
        if (!sessionID) return
        sessions.delete(sessionID)
        clearSessionMap(contextFilterCache, sessionID)
        return
      }

      if (
        type === "session.idle" ||
        (type === "session.status" &&
          stringValue(record(properties.status).type) === "idle")
      ) {
        const sessionID = eventSessionID(event)
        if (!sessionID) return
        clearSessionMap(contextFilterCache, sessionID)
      }
    },

    dispose: async () => {
      sessions.clear()
      permissionRequests.clear()
      contextFilterCache.clear()
    },
  }
}

export default OpenCodeClassifierPlugin

export function installVirtualProvider(config: Config): void {
  const mutable = config as Config & {
    provider?: Record<string, any>
  }
  mutable.provider ??= {}

  const existing = mutable.provider[VIRTUAL_PROVIDER_ID] ?? {}
  const existingOptions = record(existing.options)
  const existingModels = record(existing.models)
  const existingAuto = record(existingModels[VIRTUAL_MODEL_ID])

  mutable.provider[VIRTUAL_PROVIDER_ID] = {
    ...existing,
    npm: "@ai-sdk/openai-compatible",
    name: VIRTUAL_PROVIDER_NAME,
    options: {
      ...existingOptions,
      baseURL: "http://127.0.0.1:9/opencode-classifier-plugin/virtual",
    },
    models: {
      ...existingModels,
      [VIRTUAL_MODEL_ID]: {
        ...existingAuto,
        name: VIRTUAL_MODEL_NAME,
      },
    },
  }
}

function resetTurnState(state: SessionRuntimeState): void {
  state.directives = []
  delete state.routedTier
  delete state.turnModel
}

function extractPromptText(parts: unknown[], maxChars: number): string {
  const text = parts
    .map((part) => {
      const item = record(part)
      if (item.type !== "text" || item.synthetic === true) return ""
      return stringValue(item.text) ?? ""
    })
    .filter(Boolean)
    .join("\n")
    .trim()

  return truncate(text || "[non-text user request]", maxChars)
}

function latestSessionID(
  messages: Array<{ info: unknown; parts: unknown[] }>,
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = record(messages[index]?.info)
    const sessionID = stringValue(info.sessionID)
    if (sessionID) return sessionID
  }
  return undefined
}

function modelRefMatches(
  model: ModelRef | undefined,
  target: ModelRef | undefined,
): boolean {
  return Boolean(
    model &&
      target &&
      model.providerID === target.providerID &&
      model.id === target.id &&
      (model.variant ?? "") === (target.variant ?? ""),
  )
}

function classicModelMatches(model: unknown, target: ModelRef): boolean {
  const item = record(model)
  return (
    stringValue(item.providerID) === target.providerID &&
    (stringValue(item.id) ?? stringValue(item.modelID)) === target.id
  )
}

function clearSessionMap<T>(map: Map<string, T>, sessionID: string): void {
  const prefix = `${sessionID}:`
  for (const key of map.keys()) {
    if (key.startsWith(prefix)) map.delete(key)
  }
}

function eventType(event: unknown): string | undefined {
  return stringValue(record(event).type)
}

function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface PermissionReplyTarget {
  client: unknown
  directory: string | undefined
  serverUrl: URL
}

interface HostPermissionResponder {
  (input: {
    requestID: string
    reply: "once" | "reject"
    directory: string | undefined
  }): Promise<unknown>
}

interface HostSessionPermissionPoster {
  (input: {
    path: { id: string; permissionID: string }
    body: { response: "once" | "always" | "reject" }
    query?: { directory?: string }
  }): Promise<unknown>
}

function hostPermissionResponder(client: unknown): HostPermissionResponder | undefined {
  if (!client || typeof client !== "object") return undefined
  const permission = (client as Record<string, unknown>).permission
  if (!permission || typeof permission !== "object") return undefined
  const reply = (permission as Record<string, unknown>).reply
  if (typeof reply !== "function") return undefined
  return (input) =>
    (reply as (...args: unknown[]) => Promise<unknown>).call(permission, input)
}

function hostSessionPermissionPoster(
  client: unknown,
): HostSessionPermissionPoster | undefined {
  if (!client || typeof client !== "object") return undefined
  const post = (client as Record<string, unknown>)
    .postSessionIdPermissionsPermissionId
  if (typeof post !== "function") return undefined
  return (input) =>
    (post as (...args: unknown[]) => Promise<unknown>).call(client, input)
}

function throwIfSdkError(result: unknown): void {
  if (!result || typeof result !== "object") return
  const error = (result as Record<string, unknown>).error
  if (error !== undefined && error !== null) {
    throw new Error(safeJson(error, 500))
  }
}

function describeReplyHost(target: PermissionReplyTarget): Record<string, unknown> {
  const client = target.client
  const keys =
    client && typeof client === "object"
      ? Object.keys(client as Record<string, unknown>).slice(0, 40)
      : []
  return {
    serverUrl: String(target.serverUrl ?? "undefined"),
    directory: target.directory ?? "undefined",
    clientKeys: keys,
    hasPermissionReply: Boolean(hostPermissionResponder(client)),
    hasSessionPermissionPost: Boolean(hostSessionPermissionPoster(client)),
  }
}

async function replyToPermission(
  target: PermissionReplyTarget,
  sessionID: string,
  requestID: string,
  reply: "once" | "reject",
): Promise<void> {
  // Prefer the host-provided SDK client: it carries the right base URL and
  // credentials. This mirrors how the OpenCode TUI answers permissions
  // itself in auto mode.
  const failures: string[] = []
  const responder = hostPermissionResponder(target.client)
  if (responder) {
    try {
      await responder({
        requestID,
        reply,
        directory: target.directory,
      })
      return
    } catch (error) {
      failures.push(`client: ${errorMessage(error)}`)
    }
  } else {
    failures.push("client: unavailable")
  }

  // Classic server-plugin API from @opencode-ai/sdk: the host client is
  // already pointed at the right server with credentials.
  const poster = hostSessionPermissionPoster(target.client)
  if (poster) {
    try {
      const result = await poster({
        path: { id: sessionID, permissionID: requestID },
        body: { response: reply },
        ...(target.directory ? { query: { directory: target.directory } } : {}),
      })
      throwIfSdkError(result)
      return
    } catch (error) {
      failures.push(`sdk: ${errorMessage(error)}`)
    }
  } else {
    failures.push("sdk: unavailable")
  }

  // Fallback when the host client is unavailable: raw HTTP. Prefer the v2
  // session-scoped endpoint since the server resolves the workspace from
  // the session, while the legacy experimental route depends on optional
  // directory/workspace query params the permission event does not carry.
  const paths = [
    `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`,
    `/permission/${encodeURIComponent(requestID)}/reply`,
  ]

  const statuses: number[] = []
  for (const path of paths) {
    let response: Response
    try {
      response = await fetch(new URL(path, target.serverUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reply }),
      })
    } catch (error) {
      failures.push(`${path}: ${errorMessage(error)}`)
      continue
    }
    if (response.ok) return
    statuses.push(response.status)
  }

  throw new Error(
    `opencode-classifier-plugin: OpenCode permission reply failed (${failures.join("; ")}; HTTP ${statuses.join("/")}).`,
  )
}
