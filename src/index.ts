import type { Config, Plugin } from "@opencode-ai/plugin"
import {
  VIRTUAL_MODEL_ID,
  VIRTUAL_MODEL_NAME,
  VIRTUAL_PROVIDER_ID,
  VIRTUAL_PROVIDER_NAME,
  hashString,
  parseModelRef,
  resolveOptions,
  safeJson,
  truncate,
} from "./config.ts"
import { JevClient } from "./jev.ts"
import {
  chooseTier,
  classifyFailure,
  classifyLoopProgress,
  classifyPermission,
  classifyRoute,
  classifySkills,
} from "./classifier.ts"
import { decidePermission } from "./permission.ts"
import { filterLargeToolContext } from "./context.ts"
import {
  extractNativeSkillCatalog,
  sanitizeSkillToolDefinition,
  stripNativeSkillCatalog,
} from "./skills.ts"
import { verifyEvidence } from "./verification.ts"
import {
  createSessionState,
  eventSessionID,
  isMutationTool,
  isValidationTool,
  pushDirective,
  setLoopState,
} from "./runtime.ts"
import type {
  ModelRef,
  PermissionSignals,
  ResolvedOptions,
  RouteClassification,
  SessionRuntimeState,
  ToolSnapshot,
} from "./types.ts"

export const OpenCodeClassifierPlugin: Plugin = async ({ client, serverUrl }, rawOptions) => {
  const options = resolveOptions(rawOptions)
  const jev = new JevClient(options)
  const sessions = new Map<string, SessionRuntimeState>()
  const toolCalls = new Map<string, ToolSnapshot>()
  const permissionSignalsByCall = new Map<string, PermissionSignals>()
  const permissionRequests = new Set<string>()
  const failedToolCalls = new Set<string>()
  const blockedToolCalls = new Set<string>()
  const contextFilterCache = new Map<string, string | undefined>()

  const trace = (message: string, details: Record<string, unknown>) => {
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
      const nativeSkills = options.skills.enabled
        ? extractNativeSkillCatalog(output.system)
        : []
      if (options.skills.enabled) stripNativeSkillCatalog(output.system)

      if (!input.sessionID) return
      const state = sessions.get(input.sessionID)
      if (!state) return
      if (state.turnModel && !classicModelMatches(input.model, state.turnModel)) return

      if (
        options.skills.enabled &&
        !state.skillSelectionDone
      ) {
        state.skillSelectionDone = true
        if (state.task && nativeSkills.length > 0) {
          try {
            const selected = await classifySkills(
              jev,
              options,
              state.task,
              nativeSkills,
            )
            state.routedSkills = selected.map((item) => item.name)
          } catch (error) {
            pushDirective(
              state,
              `Skill selection was unavailable: ${errorMessage(error)}`,
            )
          }
        }
      }

      if (
        options.loop.enabled &&
        state.rounds >= options.loop.maxRounds &&
        state.loopState !== "finish" &&
        state.loopState !== "human"
      ) {
        setLoopState(
          state,
          "finish",
          "The configured maximum tool rounds was reached.",
        )
      }

      const control = options.loop.enabled
        ? loopSystemInstruction(state)
        : state.verificationPending
          ? "A mutation is pending verification. Before claiming completion, run a relevant test, typecheck, lint, build, or another concrete validation that exercises the changed behavior."
          : undefined
      if (control) output.system.push(control)

      if (state.routedSkills.length > 0) {
        output.system.push(
          `Jev selected the following skill(s) for this task: ${state.routedSkills.join(", ")}. Before substantive work, call the built-in skill tool with exactly the selected name(s). Do not enumerate, discover, or guess other skills.`,
        )
      }

      if (state.directives.length > 0) {
        output.system.push(
          `Classifier guidance:\n- ${state.directives.join("\n- ")}`,
        )
        state.directives = []
      }
    },

    "tool.definition": async (input, output) => {
      if (options.skills.enabled && input.toolID === "skill") {
        sanitizeSkillToolDefinition(output)
      }
    },

    "tool.execute.before": async (input, output) => {
      const state = stateFor(input.sessionID)
      const key = callKey(input.sessionID, input.callID)

      if (
        options.loop.enabled &&
        state.rounds >= options.loop.maxRounds &&
        state.loopState !== "finish" &&
        state.loopState !== "human"
      ) {
        setLoopState(
          state,
          "finish",
          "The configured maximum tool rounds was reached.",
        )
      }

      if (
        options.loop.enabled &&
        (state.loopState === "finish" || state.loopState === "human")
      ) {
        blockedToolCalls.add(key)
        await client.session
          .abort({ path: { id: input.sessionID } })
          .catch(() => undefined)
        throw new Error(
          state.loopState === "human"
            ? "opencode-classifier-plugin loop controller: tool execution blocked because user input or authorization is required."
            : "opencode-classifier-plugin loop controller: tool execution blocked because the task is in finish state.",
        )
      }

      if (
        options.loop.enabled &&
        state.loopState === "verify" &&
        isMutationTool(input.tool, output.args) &&
        !isValidationTool(input.tool, output.args)
      ) {
        blockedToolCalls.add(key)
        throw new Error(
          "opencode-classifier-plugin loop controller: verification is required before another mutation.",
        )
      }

      if (options.loop.enabled && state.loopState === "retry") {
        const sameRetry =
          state.retryTool === input.tool &&
          state.retryInputHash === hashString(safeJson(output.args))
        if (!sameRetry) {
          setLoopState(
            state,
            "work",
            "The agent chose a different action instead of the authorized retry; resume normal work.",
          )
        }
      }

      state.rounds += 1
      toolCalls.set(key, {
        tool: input.tool,
        input: cloneValue(output.args),
        sessionID: input.sessionID,
        callID: input.callID,
      })
    },

    "tool.execute.after": async (input, output) => {
      const key = callKey(input.sessionID, input.callID)
      const snapshot = toolCalls.get(key)
      const permissionSignals = permissionSignalsByCall.get(key)
      const state = stateFor(input.sessionID)
      const args = snapshot?.input ?? input.args
      const mutated = didMutate(input.tool, args, permissionSignals)
      const validation = isValidationTool(input.tool, args)

      toolCalls.delete(key)
      permissionSignalsByCall.delete(key)
      failedToolCalls.delete(key)
      blockedToolCalls.delete(key)

      if (
        options.verification.enabled &&
        options.verification.requiredAfterMutation &&
        mutated
      ) {
        state.verificationPending = true
        if (options.loop.enabled) {
          setLoopState(
            state,
            "verify",
            "A state-changing action completed and requires concrete validation.",
          )
        }
      }

      if (
        options.verification.enabled &&
        (state.verificationPending || state.loopState === "verify") &&
        state.task &&
        validation
      ) {
        const evidence = truncate(
          output.output,
          options.privacy.maxEvidenceChars,
        )

        try {
          const verification = await verifyEvidence(
            jev,
            options,
            state.task,
            evidence,
          )

          if (
            verification.sufficient >= options.verification.sufficientAt &&
            verification.failuresPresent < 0.35 &&
            verification.behaviorExercised >= 0.55
          ) {
            state.verificationPending = false
            if (options.loop.enabled) {
              setLoopState(
                state,
                "finish",
                "Relevant validation evidence is sufficient and no unresolved failure is present.",
              )
            } else {
              pushDirective(
                state,
                "Validation evidence is sufficient. Finish the task if no other work remains.",
              )
            }
          } else if (verification.failuresPresent >= 0.5) {
            if (options.loop.enabled) {
              setLoopState(
                state,
                "work",
                "Validation found unresolved failures that require additional work.",
              )
            } else {
              pushDirective(
                state,
                "Validation found unresolved failures. Fix them before claiming completion.",
              )
            }
          } else {
            const reason =
              verification.sufficient <= options.verification.needsMoreBelow
                ? "Validation evidence is too weak or unrelated; run a more relevant check."
                : "More validation evidence is required before completion."
            if (options.loop.enabled) {
              setLoopState(state, "verify", reason)
            } else {
              pushDirective(state, reason)
            }
          }
        } catch {
          if (options.loop.enabled) {
            setLoopState(
              state,
              "verify",
              "Verification classification was unavailable; obtain concrete validation before completion.",
            )
          } else {
            pushDirective(
              state,
              "Verification classification was unavailable. Use concrete test/build/typecheck evidence before claiming completion.",
            )
          }
        }
        return
      }

      if (mutated) return

      if (
        options.loop.enabled &&
        options.loop.classifySuccesses &&
        state.task &&
        input.tool !== "skill"
      ) {
        try {
          const progress = await classifyLoopProgress(jev, options, {
            task: state.task,
            tool: input.tool,
            evidence: output.output,
            round: state.rounds,
            verificationPending: state.verificationPending,
          })

          if (progress.probability >= options.loop.decisionAt) {
            let next = progress.decision
            if (!options.verification.enabled && next === "verify") {
              next = "work"
            }
            if (state.verificationPending && next === "finish") {
              next = "verify"
            }
            setLoopState(
              state,
              next,
              `Jev selected the next loop state "${next}" with probability ${progress.probability.toFixed(2)}.`,
            )
            if (next === "retry") {
              state.retryTool = input.tool
              state.retryInputHash = hashString(safeJson(args))
            }
          } else if (state.loopState === "retry") {
            setLoopState(
              state,
              "work",
              "The retry completed; continue normal task execution.",
            )
          }
        } catch {
          if (state.loopState === "retry") {
            setLoopState(
              state,
              "work",
              "The retry completed; continue normal task execution.",
            )
          }
        }
      } else if (state.loopState === "retry") {
        setLoopState(
          state,
          "work",
          "The retry completed; continue normal task execution.",
        )
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
        const signals = await classifyPermission(jev, options, request)

        if (input.callID) {
          permissionSignalsByCall.set(
            callKey(input.sessionID, input.callID),
            signals,
          )
        }

        const decision = decidePermission(output.status, signals, options, request)
        if (decision.effect === "allow") output.status = "allow"
        if (decision.effect === "deny") output.status = "deny"
      } catch {
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
        const source = v2 ? record(properties.source) : record(properties.tool)
        trace("permission request received", {
          requestID,
          sessionID,
          action: v2 ? properties.action : properties.permission,
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
          const callID = stringValue(source.callID)
          if (callID) {
            permissionSignalsByCall.set(callKey(sessionID, callID), signals)
          }

          const decision = decidePermission("ask", signals, options, request)
          trace("permission policy evaluated", {
            requestID,
            effect: decision.effect,
          })
          if (decision.effect === "allow") {
            await replyToPermission(serverUrl, requestID, "once")
            trace("permission response sent", { requestID, reply: "once" })
          } else if (decision.effect === "deny") {
            await replyToPermission(serverUrl, requestID, "reject")
            trace("permission response sent", { requestID, reply: "reject" })
          }
        } catch {
          trace("permission classification failed", { requestID })
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

      if (type === "message.part.updated") {
        const part = record(properties.part)
        if (part.type !== "tool") return

        const stateData = record(part.state)
        if (stateData.status !== "error") return

        const sessionID =
          stringValue(part.sessionID) ??
          stringValue(properties.sessionID)
        const callID = stringValue(part.callID)
        const tool = stringValue(part.tool) ?? "unknown"
        if (!sessionID || !callID) return

        const key = callKey(sessionID, callID)

        if (blockedToolCalls.has(key)) {
          blockedToolCalls.delete(key)
          toolCalls.delete(key)
          permissionSignalsByCall.delete(key)
          return
        }

        if (failedToolCalls.has(key)) return
        failedToolCalls.add(key)

        const state = stateFor(sessionID)
        const snapshot = toolCalls.get(key)
        const args = snapshot?.input ?? stateData.input
        const permissionSignals = permissionSignalsByCall.get(key)

        if (
          options.verification.enabled &&
          options.verification.requiredAfterMutation &&
          didMutate(tool, args, permissionSignals)
        ) {
          state.verificationPending = true
        }

        toolCalls.delete(key)
        permissionSignalsByCall.delete(key)

        if (options.loop.enabled) {
          const error = stringValue(stateData.error) ?? safeJson(stateData.error)
          const evidence = truncate(error, options.privacy.maxEvidenceChars)
          const failureKey = hashString(`${tool}:${evidence}`)

          if (state.lastFailureKey === failureKey) state.sameFailureCount += 1
          else {
            state.lastFailureKey = failureKey
            state.sameFailureCount = 1
          }

          try {
            const failure = await classifyFailure(jev, options, evidence, tool)
            if (failure.requiresUser >= 0.75) {
              setLoopState(
                state,
                "human",
                "The latest failure requires user authorization, credentials, missing information, or a product decision.",
              )
            } else if (
              failure.kind === "transient" &&
              failure.retrySafe >= 0.75 &&
              state.sameFailureCount <= options.loop.maxSameFailure
            ) {
              setLoopState(
                state,
                "retry",
                "The latest failure appears transient and safe to retry once.",
              )
              state.retryTool = tool
              state.retryInputHash = hashString(safeJson(args))
            } else {
              setLoopState(
                state,
                "work",
                `The latest failure was classified as ${failure.kind}; change approach or fix the underlying problem.`,
              )
            }
          } catch {
            setLoopState(
              state,
              "work",
              "Failure classification was unavailable; inspect the failure and change approach conservatively.",
            )
          }

          if (state.sameFailureCount > options.loop.maxSameFailure) {
            setLoopState(
              state,
              "human",
              "The same failure repeated beyond the configured limit; stop retrying and report the blocker to the user.",
            )
          }
        }
        return
      }

      if (type === "session.deleted") {
        const sessionID = eventSessionID(event)
        if (!sessionID) return
        sessions.delete(sessionID)
        clearSessionMap(toolCalls, sessionID)
        clearSessionMap(permissionSignalsByCall, sessionID)
        clearSessionSet(failedToolCalls, sessionID)
        clearSessionSet(blockedToolCalls, sessionID)
        return
      }

      if (
        type === "session.idle" ||
        (type === "session.status" &&
          stringValue(record(properties.status).type) === "idle")
      ) {
        const sessionID = eventSessionID(event)
        if (!sessionID) return
        clearSessionMap(toolCalls, sessionID)
        clearSessionMap(permissionSignalsByCall, sessionID)
        clearSessionSet(failedToolCalls, sessionID)
        clearSessionSet(blockedToolCalls, sessionID)
      }
    },

    dispose: async () => {
      sessions.clear()
      toolCalls.clear()
      permissionSignalsByCall.clear()
      permissionRequests.clear()
      failedToolCalls.clear()
      blockedToolCalls.clear()
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
  state.routedSkills = []
  state.skillSelectionDone = false
  state.rounds = 0
  state.verificationPending = false
  state.sameFailureCount = 0
  setLoopState(state, "work")
  state.directives = []
  delete state.routedTier
  delete state.turnModel
  delete state.lastFailureKey
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

function didMutate(
  tool: string,
  input: unknown,
  signals?: PermissionSignals,
): boolean {
  if (signals) {
    if (
      signals.modifiesProjectFiles >= 0.55 ||
      signals.outsideWorkspace >= 0.55 ||
      signals.destructive >= 0.55 ||
      signals.changesVcsHistory >= 0.55 ||
      signals.externalSideEffect >= 0.55
    ) {
      return true
    }

    if (
      signals.readOnly >= 0.9 &&
      signals.modifiesProjectFiles <= 0.2 &&
      signals.outsideWorkspace <= 0.2 &&
      signals.destructive <= 0.2 &&
      signals.changesVcsHistory <= 0.2 &&
      signals.externalSideEffect <= 0.2
    ) {
      return false
    }
  }

  return isMutationTool(tool, input)
}

function loopSystemInstruction(state: SessionRuntimeState): string | undefined {
  const reason = state.loopReason ? ` Reason: ${state.loopReason}` : ""

  switch (state.loopState) {
    case "retry":
      return `Loop controller state RETRY: retry the latest transient/safe action at most once, then reassess instead of repeating blindly.${reason}`
    case "verify":
      return `Loop controller state VERIFY: obtain concrete validation before completion. Prefer tests, typecheck, lint, build, or another check that exercises the changed behavior. Avoid new mutations until verification resolves.${reason}`
    case "finish":
      return `Loop controller state FINISH: do not call additional tools. Produce the final response now, stating completed work, validation evidence, and any remaining limitation.${reason}`
    case "human":
      return `Loop controller state HUMAN: do not call additional tools. Ask the user for the missing authorization, information, credential, or decision and explain the blocker precisely.${reason}`
    case "work":
      return state.verificationPending
        ? `Loop controller state WORK: continue fixing or investigating, but completion remains blocked until pending mutation verification succeeds.${reason}`
        : undefined
  }
}

function callKey(sessionID: string, callID: string): string {
  return `${sessionID}:${callID}`
}

function clearSessionMap<T>(map: Map<string, T>, sessionID: string): void {
  const prefix = `${sessionID}:`
  for (const key of map.keys()) {
    if (key.startsWith(prefix)) map.delete(key)
  }
}

function clearSessionSet(set: Set<string>, sessionID: string): void {
  const prefix = `${sessionID}:`
  for (const key of set) {
    if (key.startsWith(prefix)) set.delete(key)
  }
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch {
    try {
      return JSON.parse(JSON.stringify(value)) as T
    } catch {
      return value
    }
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

async function replyToPermission(
  serverUrl: URL,
  requestID: string,
  reply: "once" | "reject",
): Promise<void> {
  const response = await fetch(
    new URL(`/permission/${encodeURIComponent(requestID)}/reply`, serverUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply }),
    },
  )
  if (!response.ok) {
    throw new Error(
      `opencode-classifier-plugin: OpenCode permission reply failed with HTTP ${response.status}.`,
    )
  }
}
