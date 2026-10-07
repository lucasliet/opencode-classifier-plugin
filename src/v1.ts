import type {
  Config,
  Hooks,
  PluginInput,
  PluginOptions,
} from "@opencode-ai/plugin"
import {
  VIRTUAL_MODEL_ID,
  VIRTUAL_MODEL_NAME,
  VIRTUAL_PROVIDER_ID,
  VIRTUAL_PROVIDER_NAME,
  formatModelRef,
  resolveOptions,
  safeJson,
  sameModelRef,
  truncate,
} from "./config.ts"
import { JevClient } from "./jev.ts"
import {
  classifyPermission,
  classifyRoute,
  requirementsFromRoute,
} from "./classifier.ts"
import type { TaskRequirementsInput } from "./classifier.ts"
import { decidePermission } from "./permission.ts"
import { filterLargeToolContext } from "./context.ts"
import {
  createSessionState,
  eventSessionID,
  pushDirective,
} from "./runtime.ts"
import { candidatesFor, planRoutes } from "./routing/assemble.ts"
import type { CandidateSources } from "./routing/assemble.ts"
import type {
  CapabilityTier,
  CatalogModel,
  QuotaLedger,
  RoutingDecision,
  RoutableModel,
  TaskRequirements,
} from "./routing/contracts.ts"
import { compileExclusions } from "./routing/exclude.ts"
import { profileResolver } from "./routing/profile-source.ts"
import { createReferenceLoader } from "./routing/reference.ts"
import { explainDecision, selectModel } from "./routing/select.ts"
import { createSpeedTracker } from "./routing/speed.ts"
import { createUsageBarLedger } from "./quota/ledger.ts"
import type { QuotaLedgerOptions } from "./quota/ledger.ts"
import { createTracer } from "./trace.ts"
import type { Trace } from "./trace.ts"
import type {
  ModelRef,
  ResolvedOptions,
  RouteClassification,
  SessionRuntimeState,
} from "./types.ts"

/**
 * Internal seams for the test suite.
 *
 * Production hosts invoke the plugin with two arguments and never construct
 * this object, and the package entrypoint deliberately does not re-export
 * it, so an injected factory cannot leak into consumer code.
 */
export interface V1PluginInternals {
  /**
   * Replaces the `ai-usagebar` ledger factory so tests can drive quota
   * scenarios without spawning the real binary.
   */
  readonly createLedger?: (options: QuotaLedgerOptions) => QuotaLedger
}

/**
 * OpenCode 1.18 adapter of the zero-config subscription router.
 *
 * V1 host constraints that shape every decision below:
 *
 * - The host exposes no `ctx.model.list()` and no connection API. The only
 *   model inventory is the merged config handed to the `config` hook, whose
 *   provider blocks publish model ids and names but no context limits, no
 *   variants and no capability flags.
 * - Subscriptions whose vendor authenticates by OAuth
 *   (`connection.requireOAuth`, for example ChatGPT/Codex) are EXCLUDED on
 *   V1. V1 cannot observe connections, and an unprovable subscription must be
 *   treated as absent: a false negative only loses a route, a false positive
 *   bills real money.
 * - Quota behaves exactly as on V2: the `ai-usagebar` binary is runnable
 *   from a V1 plugin, so the ledger, its background refresh and its
 *   turn-time kick are identical.
 * - Turns are redirected by rewriting the saved message model in
 *   `chat.message`; V1 has no `switchModel` primitive.
 *
 * @param input Host plugin context.
 * @param rawOptions Untrusted plugin options; an empty object is valid.
 * @param internals Test-only seams. Never provided by a host.
 * @returns The V1 hook implementation.
 */
export async function OpenCodeClassifierPlugin(
  { client, directory, serverUrl }: PluginInput,
  rawOptions?: PluginOptions,
  internals?: V1PluginInternals,
): Promise<Hooks> {
  const options = resolveOptions(rawOptions)
  const jev = new JevClient(options)
  const sessions = new Map<string, SessionRuntimeState>()
  const permissionRequests = new Set<string>()
  const contextFilterCache = new Map<string, string | undefined>()

  // Trace goes to a file because stderr is interleaved into the TUI and
  // cannot be read comfortably mid-session. See src/trace.ts.
  const trace = createTracer(options)

  const ledgerFactory = internals?.createLedger ?? createUsageBarLedger
  let routerRuntime: RouterRuntime | undefined

  const stateFor = (sessionID: string): SessionRuntimeState => {
    let state = sessions.get(sessionID)
    if (!state) {
      state = createSessionState()
      sessions.set(sessionID, state)
    }
    return state
  }

  const loadReference = createReferenceLoader(options.routing.referenceCatalog)
  const isExcluded = compileExclusions(options.routing.exclude)
  const speed = createSpeedTracker()

  /**
   * Assemble the routing runtime from the merged config: snapshot the model
   * inventory and start the quota ledger. Which providers are subscriptions
   * is decided per turn from the ledger's live subscription list. The
   * `config` hook is the only moment a V1 host shows its provider catalog, so
   * the startup trace lines live here too.
   */
  const installRouter = (config: Config): void => {
    disposeRouterRuntime()

    const snapshot = snapshotModelInventory(config)
    trace("v1 model inventory", {
      providers: [...snapshot.entries()].map(
        ([providerID, modelIDs]) => `${providerID}:${modelIDs.size}`,
      ),
    })

    const ledger = ledgerFactory({
      binary: options.routing.quota.binary,
      args: options.routing.quota.args,
      vendorArgs: options.routing.quota.vendorArgs,
      timeoutMs: options.routing.quota.timeoutMs,
      refreshSeconds: options.routing.quota.refreshSeconds,
    })
    const runtime: RouterRuntime = {
      catalog: catalogFromSnapshot(snapshot),
      ledger,
      quotaEnabled: options.routing.quota.enabled,
      candidateSources: async () => ({
        subscriptions: ledger.subscriptions(),
        overrides: options.routing.providerPools,
        aliases: options.routing.providerAliases,
        isExcluded,
        profileOf: profileResolver({
          reference: await loadReference(),
          speed,
          aliases: options.routing.providerAliases,
          now: Date.now,
        }),
      }),
      refreshTimer: undefined,
    }
    if (runtime.quotaEnabled) {
      const intervalMs = Math.max(1, options.routing.quota.refreshSeconds) * 1_000
      runtime.refreshTimer = setInterval(
        () => refreshInBackground(runtime.ledger, trace),
        intervalMs,
      )
      unrefTimer(runtime.refreshTimer)
      refreshInBackground(runtime.ledger, trace)
    }
    routerRuntime = runtime
  }

  const disposeRouterRuntime = (): void => {
    const runtime = routerRuntime
    routerRuntime = undefined
    if (runtime === undefined) return
    if (runtime.refreshTimer !== undefined) clearInterval(runtime.refreshTimer)
    runtime.ledger.dispose()
  }

  return {
    config: async (config) => {
      if (!options.routing.enabled) return
      installVirtualProvider(config)
      installRouter(config)
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
      /**
       * Continuity is always on in the zero-config router. The retired
       * `router.sticky` switch existed only to disable it, and a multi-turn
       * task staying on the subscription model the router picked is the
       * correct default, so a session stays armed while the virtual model or
       * the last routed model keeps being selected.
       */
      const stickyContinuation =
        options.routing.enabled &&
        state.routerActive &&
        sameModelRef(selected, state.lastRoutedModel)
      const useRouter =
        options.routing.enabled && (selectedVirtual || stickyContinuation)
      trace("v1 router selected", {
        sessionID: output.message.sessionID,
        selected: formatModelRef(selected),
        selectedVirtual,
        stickyContinuation,
        useRouter,
        routerActive: state.routerActive,
        lastRouted: state.lastRoutedModel
          ? formatModelRef(state.lastRoutedModel)
          : undefined,
      })

      if (selectedVirtual) {
        state.routerActive = true
      } else if (!useRouter) {
        state.routerActive = false
        delete state.lastRoutedModel
      }

      const needsClassification = useRouter || options.agents.enabled
      let route: RouteClassification | undefined

      if (needsClassification) {
        try {
          route = await classifyRoute(jev, options, prompt)
        } catch (error) {
          route = {
            complexity: "normal",
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
        const routed = await routeSubscriptionTurn({
          runtime: routerRuntime,
          options,
          route,
          prompt,
          trace,
        })

        if (routed.target === undefined) {
          delete state.lastRoutedModel
          state.turnModel = selected
          pushDirective(state, unroutableDirective(routed.decision))
          trace("v1 router rejected", {
            sessionID: output.message.sessionID,
            reason: routed.decision.reason,
          })
          return
        }

        messageModel.providerID = routed.target.providerID
        messageModel.modelID = routed.target.id
        if (routed.target.variant !== undefined) {
          messageModel.variant = routed.target.variant
        } else {
          delete messageModel.variant
        }

        state.turnModel = routed.target
        state.routerActive = true
        state.lastRoutedModel = routed.target
        pushDirective(state, explainDecision(routed.decision))
        trace("v1 router routed", {
          sessionID: output.message.sessionID,
          target: formatModelRef(routed.target),
          reason: routed.decision.reason,
        })
        return
      }

      state.turnModel = selected
      trace("v1 router skipped", { sessionID: output.message.sessionID })
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
      if (!options.autoMode.enabled || output.status !== "ask") return

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
      disposeRouterRuntime()
      sessions.clear()
      permissionRequests.clear()
      contextFilterCache.clear()
    },
  }
}

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
  delete state.turnModel
}

/** Live routing state, assembled once per `config` hook invocation. */
interface RouterRuntime {
  readonly catalog: readonly CatalogModel[]
  readonly ledger: QuotaLedger
  readonly quotaEnabled: boolean
  /** Subscriptions, overrides, blacklist and profiles, read fresh per turn. */
  readonly candidateSources: () => Promise<CandidateSources>
  refreshTimer: ReturnType<typeof setInterval> | undefined
}

/** Outcome of routing one turn: a dispatch target, or why there is none. */
interface RoutedTurn {
  readonly target: ModelRef | undefined
  readonly decision: RoutingDecision
}

/**
 * Context sentinel for models discovered through the V1 config hook.
 *
 * LOUD, and deliberate: OpenCode 1.x publishes no context limit on that path,
 * and `select.ts` has no "unknown context" concept — a limit of `0` rejects
 * every candidate. Faking the TASK estimate down to zero to dodge the gate
 * would corrupt the burn forecast, so the unknown is declared on the MODEL
 * side instead: every V1 candidate passes the context-fit gate. V1 therefore
 * CANNOT enforce context fit; the subscription-identity, quality-floor and
 * quota gates remain fully enforced.
 */
export const UNKNOWN_CONTEXT_LIMIT = Number.MAX_SAFE_INTEGER

/** Deterministic input-token floor shared by every V1 estimate. */
const ESTIMATED_INPUT_MIN_TOKENS = 4_000
/** Deterministic input-token ceiling; V1 sees only the prompt text. */
const ESTIMATED_INPUT_MAX_TOKENS = 200_000
const INPUT_CHARS_PER_TOKEN = 4
const STANDARD_OUTPUT_TOKENS = 8_000
const DEEP_OUTPUT_TOKENS = 16_000
const STANDARD_TURNS = 6
const DEEP_TURNS = 12
/** Longest a quota refresh may delay a routable turn. */
const QUOTA_REFRESH_BUDGET_MS = 400

/**
 * Snapshot the model inventory from a merged V1 config.
 *
 * Every provider block is read except the virtual router; which of them are
 * subscriptions is decided per turn against the live `ai-usagebar` list, so a
 * metered provider here is harmless: it simply never matches a subscription.
 *
 * @param config Raw payload the host passed to the `config` hook.
 * @returns Provider id → the model ids its config block publishes.
 */
export function snapshotModelInventory(
  config: unknown,
): Map<string, Set<string>> {
  const providers = record(record(config).provider)
  const snapshot = new Map<string, Set<string>>()
  for (const [providerID, provider] of Object.entries(providers)) {
    if (providerID === VIRTUAL_PROVIDER_ID) continue
    const modelIDs = modelIDsOfProvider(provider)
    if (modelIDs !== undefined) snapshot.set(providerID, modelIDs)
  }
  return snapshot
}

/** Model ids of one provider block, or `undefined` when the block is absent. */
function modelIDsOfProvider(provider: unknown): Set<string> | undefined {
  if (
    typeof provider !== "object" ||
    provider === null ||
    Array.isArray(provider)
  ) {
    return undefined
  }
  const models = record(record(provider).models)
  const modelIDs = new Set<string>()
  for (const [modelID, entry] of Object.entries(models)) {
    const trimmed = modelID.trim()
    if (trimmed.length === 0 || typeof entry !== "object" || entry === null) {
      continue
    }
    modelIDs.add(trimmed)
  }
  return modelIDs
}

function catalogFromSnapshot(
  snapshot: Map<string, Set<string>>,
): CatalogModel[] {
  const catalog: CatalogModel[] = []
  for (const [providerID, modelIDs] of snapshot) {
    for (const modelID of modelIDs) {
      catalog.push(catalogModelWithUnknownMetadata(providerID, modelID))
    }
  }
  return catalog
}

/**
 * Best-effort catalog entry for an id the V1 config publishes without detail.
 *
 * Every field V1 cannot read carries its documented fail-open value while the
 * fail-closed gates are untouched: tool support and text-only input are
 * assumed because capability data is absent, no variants are claimed because
 * none are published, costs stay zero so the curated profile rates take over
 * in `estimate.ts`, and the context limit is {@link UNKNOWN_CONTEXT_LIMIT}
 * because the config hook never sees one.
 */
function catalogModelWithUnknownMetadata(
  providerID: string,
  modelID: string,
): CatalogModel {
  return {
    providerID,
    modelID,
    name: modelID,
    context: UNKNOWN_CONTEXT_LIMIT,
    output: 0,
    inputModalities: ["text"],
    tools: true,
    variantIDs: [],
    variantSettings: {},
    costPerMTok: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

/**
 * Route one classified turn to a subscription model.
 *
 * An empty inventory returns before any quota wait, so a host without
 * verifiable subscription models never pays the refresh budget per turn.
 */
async function routeSubscriptionTurn(input: {
  readonly runtime: RouterRuntime | undefined
  readonly options: ResolvedOptions
  readonly route: RouteClassification
  readonly prompt: string
  readonly trace: Trace
}): Promise<RoutedTurn> {
  const runtime = input.runtime
  if (runtime === undefined || runtime.catalog.length === 0) {
    return { target: undefined, decision: noInventoryDecision() }
  }
  if (runtime.quotaEnabled) {
    await refreshWithinBudget(
      runtime.ledger,
      QUOTA_REFRESH_BUDGET_MS,
      input.trace,
    )
  }
  const models = await subscriptionCandidates(runtime, input.trace)
  if (models.length === 0) {
    return { target: undefined, decision: noInventoryDecision() }
  }
  const requirements = requirementsFromRoute(
    input.route,
    input.options,
    taskContextFor(input.route, input.prompt),
  )
  const decision = selectWithFloorRelaxation(
    { models, ledger: runtime.ledger },
    input.options,
    requirements,
  )
  return { target: targetOf(decision), decision }
}

/**
 * Candidates for this turn. Routes whose vendor authenticates by OAuth are
 * dropped because V1 cannot prove the connection behind them.
 */
async function subscriptionCandidates(
  runtime: RouterRuntime,
  trace: Trace,
): Promise<RoutableModel[]> {
  const sources = await runtime.candidateSources()
  const plan = planRoutes(runtime.catalog, sources)
  const oauthRoutes = plan.routes.filter((route) => route.connection.requireOAuth)
  if (oauthRoutes.length > 0 || plan.unmatched.length > 0) {
    trace("v1 subscription association", {
      oauthExcluded: oauthRoutes.map((route) => `${route.id}:${route.providerIDs.join("+")}`),
      unmatched: plan.unmatched,
      reason:
        "OpenCode 1.x has no connection API, so an OAuth-bound subscription cannot be proven and is treated as absent",
    })
  }
  const provable = plan.routes.filter((route) => !route.connection.requireOAuth)
  return candidatesFor(runtime.catalog, provable, sources)
}

function noInventoryDecision(): RoutingDecision {
  return {
    reason:
      "no configured provider matches a subscription ai-usagebar reports with a quota window",
    considered: [],
  }
}

/**
 * Selection with one bounded retry: when every candidate is refused at the
 * quality floor, the floor relaxes exactly one band (advanced → balanced →
 * economy). Only the floor moves — token estimates and the effort ceiling
 * stay, because the task itself did not change.
 */
function selectWithFloorRelaxation(
  routingInput: { readonly models: readonly RoutableModel[]; readonly ledger: QuotaLedger },
  options: ResolvedOptions,
  requirements: TaskRequirements,
): RoutingDecision {
  const overrides = {
    safetyMargin: options.routing.safetyMargin,
    thresholds: options.routing.thresholds,
  }
  const first = selectModel({ ...routingInput, requirements }, overrides)
  if (first.selected !== undefined || requirements.tier === "economy") {
    return first
  }
  return selectModel(
    {
      ...routingInput,
      requirements: { ...requirements, tier: floorBelow(requirements.tier) },
    },
    overrides,
  )
}

function floorBelow(tier: CapabilityTier): CapabilityTier {
  return tier === "advanced" ? "balanced" : "economy"
}

function targetOf(decision: RoutingDecision): ModelRef | undefined {
  const winner = decision.selected
  if (winner === undefined) return undefined
  return {
    providerID: winner.catalog.providerID,
    id: winner.catalog.modelID,
    ...(decision.variant !== undefined ? { variant: decision.variant } : {}),
  }
}

/**
 * Directive for a turn nothing could serve. The saved turn keeps pointing
 * wherever it already points — never at a pay-as-you-go provider — and the
 * user is asked to pick a model manually.
 */
function unroutableDirective(decision: RoutingDecision): string {
  return (
    `No subscription model could take this turn: ${explainDecision(decision)}. ` +
    "Select a model manually; the router never falls back to pay-as-you-go providers."
  )
}

/**
 * V1 task estimates, deterministic by design.
 *
 * V1 parts carry no reliable file or image signal, so the estimate leans only
 * on the prompt text and the Jev complexity label: tools are always required
 * (a coding-agent turn without them is useless), vision never is (requiring
 * it would reject every V1 candidate, whose modalities are unknown), input is
 * a 4k floor plus one token per four prompt characters capped at 200k, and
 * deep work gets a 16k/12-turn budget where everything else gets 8k/6.
 */
function taskContextFor(
  route: RouteClassification,
  prompt: string,
): TaskRequirementsInput {
  const deep = route.complexity === "deep"
  return {
    estimatedInputTokens: estimateInputTokens(prompt),
    estimatedOutputTokens: deep ? DEEP_OUTPUT_TOKENS : STANDARD_OUTPUT_TOKENS,
    needsTools: true,
    needsVision: false,
    estimatedTurns: deep ? DEEP_TURNS : STANDARD_TURNS,
  }
}

function estimateInputTokens(prompt: string): number {
  const estimated =
    ESTIMATED_INPUT_MIN_TOKENS + prompt.length / INPUT_CHARS_PER_TOKEN
  return Math.round(
    Math.min(
      ESTIMATED_INPUT_MAX_TOKENS,
      Math.max(ESTIMATED_INPUT_MIN_TOKENS, estimated),
    ),
  )
}

/**
 * Kick a quota refresh without ever stalling the turn: the first fulfillment
 * of the refresh or the budget timer wins, and a rejected refresh is traced
 * and swallowed.
 */
async function refreshWithinBudget(
  ledger: QuotaLedger,
  budgetMs: number,
  trace: Trace,
): Promise<void> {
  try {
    await Promise.race([ledger.refresh(), sleepUnrefed(budgetMs)])
  } catch (error) {
    trace("v1 quota refresh failed", { error: errorMessage(error) })
  }
}

function refreshInBackground(ledger: QuotaLedger, trace: Trace): void {
  ledger.refresh().catch((error: unknown) => {
    trace("v1 quota refresh failed", { error: errorMessage(error) })
  })
}

function sleepUnrefed(ms: number): Promise<void> {
  return new Promise((resolve) => {
    unrefTimer(setTimeout(() => resolve(), ms))
  })
}

/**
 * Resolve the DOM/node timer typing ambiguity: unref when the platform
 * offers it, so a pending quota timer can never keep the host process alive.
 */
function unrefTimer(timer: unknown): void {
  const maybe = timer as { unref?: unknown } | null
  if (typeof maybe?.unref === "function") {
    ;(maybe.unref as () => void)()
  }
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
