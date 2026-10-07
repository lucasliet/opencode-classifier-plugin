import type { Plugin } from "@opencode/plugin"
import {
  VIRTUAL_MODEL_ID,
  VIRTUAL_MODEL_NAME,
  VIRTUAL_PROVIDER_ID,
  VIRTUAL_PROVIDER_NAME,
  resolveOptions,
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
import { judgeCapabilities } from "./capabilities/judge.ts"
import { createCapabilitySelector } from "./capabilities/selection.ts"
import {
  createSessionState,
  eventSessionID,
  pushDirective,
} from "./runtime.ts"
import { createTracer } from "./trace.ts"
import type { Trace } from "./trace.ts"
import type { CandidateSources } from "./routing/assemble.ts"
import type { QuotaLedger, TaskRequirements } from "./routing/contracts.ts"
import { compileExclusions } from "./routing/exclude.ts"
import { createProviderHealth } from "./routing/health.ts"
import { profileResolver } from "./routing/profile-source.ts"
import { createReferenceLoader } from "./routing/reference.ts"
import type { SelectOptionOverrides } from "./routing/select.ts"
import { createSpeedTracker } from "./routing/speed.ts"
import type { SpeedTracker } from "./routing/speed.ts"
import { createUsageBarLedger } from "./quota/ledger.ts"
import type { QuotaLedgerOptions } from "./quota/ledger.ts"
import { narrowRequestCapabilities, pinnedCapabilityKeys } from "./v2-capabilities.ts"
import { createFailoverHook } from "./v2-failover.ts"
import { routeTask } from "./v2-route.ts"
import type { RouteOutcome } from "./v2-route.ts"
import { SPEED_STORAGE_KEY, createStepSpeedObserver } from "./v2-speed.ts"
import type {
  ModelRef,
  ResolvedOptions,
  RouteClassification,
  SessionRuntimeState,
} from "./types.ts"

type V2Context = Plugin.Context

/** Permission evaluations stay valid briefly; repeated commands skip Jev. */
const PERMISSION_CACHE_TTL_MS = 45_000
const PERMISSION_CACHE_MAX_ENTRIES = 256

/**
 * Longest a prompt may wait on the quota binary before it routes on `unknown`
 * pools. A prompt must never sit on a CLI run; the background interval and the
 * next prompt pick up the reading instead.
 */
const QUOTA_REFRESH_WAIT_MS = 400

/**
 * Deterministic task-shape heuristics. Routing time has no token telemetry, so
 * the forecast starts from the prompt length: four characters per token on top
 * of a floor that already covers the system prompt and tool context, clamped so
 * neither an empty nor a pasted-log prompt can produce an absurd estimate.
 */
const MIN_ESTIMATED_INPUT_TOKENS = 4_000
const MAX_ESTIMATED_INPUT_TOKENS = 200_000
const CHARS_PER_ESTIMATED_TOKEN = 4
const DEEP_ESTIMATED_OUTPUT_TOKENS = 16_000
const NORMAL_ESTIMATED_OUTPUT_TOKENS = 8_000
const DEEP_ESTIMATED_TURNS = 12
const NORMAL_ESTIMATED_TURNS = 6

/**
 * Replaces the `ai-usagebar` ledger in tests. Kept as a setup parameter rather
 * than an export so the production API surface stays `setupV2(ctx)`.
 */
type LedgerFactory = (options: QuotaLedgerOptions) => QuotaLedger

interface V2SetupOverrides {
  readonly createLedger?: LedgerFactory
}

interface CachedPermission {
  effect: "allow" | "ask" | "deny"
  message?: string
  expires: number
}

function permissionCacheKey(action: string, resources: readonly string[]): string {
  return `${action}\u0000${resources.join("\u0000")}`
}

function readPermissionCache(
  cache: Map<string, CachedPermission>,
  key: string,
): CachedPermission | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (entry.expires <= Date.now()) {
    cache.delete(key)
    return undefined
  }
  return entry
}

function writePermissionCache(
  cache: Map<string, CachedPermission>,
  key: string,
  entry: CachedPermission,
): void {
  cache.set(key, entry)
  while (cache.size > PERMISSION_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (typeof oldest !== "string") break
    cache.delete(oldest)
  }
}

function isVirtualModel(model: { providerID?: unknown; id?: unknown }): boolean {
  return (
    model.providerID === VIRTUAL_PROVIDER_ID && model.id === VIRTUAL_MODEL_ID
  )
}

function toModelRef(model: {
  providerID: string
  id: string
  variant?: string
}): ModelRef {
  return model.variant
    ? { providerID: model.providerID, id: model.id, variant: model.variant }
    : { providerID: model.providerID, id: model.id }
}

function sameModelRef(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  return Boolean(
    a &&
      b &&
      a.providerID === b.providerID &&
      a.id === b.id &&
      (a.variant ?? "") === (b.variant ?? ""),
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Extracts the selected model from a `session.model.selected` event. V2
 * payloads nest it under `data`; V1-style buses use `properties`.
 */
function eventModelRef(
  event: unknown,
): { providerID: string; id: string; variant?: string } | undefined {
  if (!event || typeof event !== "object") return undefined
  const record = event as Record<string, unknown>
  for (const key of ["data", "properties"]) {
    const container =
      record[key] && typeof record[key] === "object"
        ? (record[key] as Record<string, unknown>)
        : undefined
    const raw = container?.model
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const model = raw as Record<string, unknown>
    if (typeof model.providerID !== "string" || !model.providerID) continue
    if (typeof model.id !== "string" || !model.id) continue
    return {
      providerID: model.providerID,
      id: model.id,
      ...(typeof model.variant === "string" && model.variant
        ? { variant: model.variant }
        : {}),
    }
  }
  return undefined
}

/** Local, host-derived facts about the prompt that Jev cannot observe. */
interface PromptFacts {
  readonly promptChars: number
  readonly fileCount: number
}

/**
 * Task-shape estimates for the router, derived only from deterministic inputs:
 * the raw prompt length and the attachment count. Deep work doubles the output
 * budget and the turn count because reasoning tasks iterate far more.
 */
function taskContextOf(route: RouteClassification, facts: PromptFacts): TaskRequirementsInput {
  const deep = route.complexity === "deep"
  return {
    estimatedInputTokens: estimatedInputTokens(facts.promptChars),
    estimatedOutputTokens: deep ? DEEP_ESTIMATED_OUTPUT_TOKENS : NORMAL_ESTIMATED_OUTPUT_TOKENS,
    needsTools: true,
    needsVision: facts.fileCount > 0,
    estimatedTurns: deep ? DEEP_ESTIMATED_TURNS : NORMAL_ESTIMATED_TURNS,
  }
}

function estimatedInputTokens(promptChars: number): number {
  const guessed =
    MIN_ESTIMATED_INPUT_TOKENS + Math.ceil(promptChars / CHARS_PER_ESTIMATED_TOKEN)
  return Math.min(
    MAX_ESTIMATED_INPUT_TOKENS,
    Math.max(MIN_ESTIMATED_INPUT_TOKENS, guessed),
  )
}

/** Neutral classification used when Jev cannot answer; maps to `balanced`. */
function fallbackClassification(): RouteClassification {
  return {
    complexity: "normal",
    complexityProbability: 0,
    deepReasoning: 0,
    highRisk: 0,
    research: 0,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Bound how long a prompt can wait for the kicked refresh. The race resolves
 * with the ledger when it is quick and with the timer otherwise, so a slow
 * binary costs at most `QUOTA_REFRESH_WAIT_MS` of latency.
 */
async function settleQuotaKick(kick: Promise<void> | undefined): Promise<void> {
  if (kick === undefined) return
  await Promise.race([kick, sleep(QUOTA_REFRESH_WAIT_MS)])
}

/** Keep the warm-up interval from holding the host process open. */
function unrefTimer(timer: unknown): void {
  if (timer !== null && typeof timer === "object" && "unref" in timer) {
    const unref = (timer as { readonly unref?: unknown }).unref
    if (typeof unref === "function") unref.call(timer)
  }
}

/**
 * V2 setup for OpenCode >= 2. Implements the same product behavior as the
 * v1 adapter (src/v1.ts) through native V2 primitives:
 *
 * - permission Auto Mode via `permission.hook("evaluate")`;
 * - zero-config model routing via `session.hook("prompt")`: classify the
 *   task, discover subscription models from the live host catalog, prove the
 *   subscriptions through the connection gate, and dispatch the selector's
 *   winner through native `session.switchModel`;
 * - agent routing via native `session.switchAgent`;
 * - context filtering via `session.hook("context")` (outgoing call only,
 *   persisted history untouched);
 * - skill and Code Mode namespace selection in the same hook: only what Jev
 *   selects for the task is described to the model.
 *
 * @param ctx - The V2 plugin context.
 * @param overrides - Test-only injection points; production callers omit them.
 * @returns A cleanup function that stops the event subscription, the quota
 *   warm-up and the ledger.
 */
export async function setupV2(
  ctx: V2Context,
  overrides: V2SetupOverrides = {},
): Promise<(() => void) | void> {
  const options = resolveOptions(ctx.options)
  const trace = createTracer(options.debug)
  const jev = new JevClient(options)
  const sessions = new Map<string, SessionRuntimeState>()
  const permissionCache = new Map<string, CachedPermission>()
  const contextFilterCache = new Map<string, string | undefined>()
  const capabilitySelector = createCapabilitySelector(
    (task, candidates) => judgeCapabilities(jev, options, task, candidates),
    pinnedCapabilityKeys(options.capabilities.alwaysInclude),
  )

  const createLedger = overrides.createLedger ?? createUsageBarLedger
  const ledger = createLedger({
    binary: options.routing.quota.binary,
    args: options.routing.quota.args,
    vendorArgs: options.routing.quota.vendorArgs,
    timeoutMs: options.routing.quota.timeoutMs,
    refreshSeconds: options.routing.quota.refreshSeconds,
  })
  let warmTimer: ReturnType<typeof setInterval> | undefined
  if (options.routing.enabled && options.routing.quota.enabled) {
    void ledger.refresh().catch(() => undefined)
    warmTimer = setInterval(() => {
      void ledger.refresh().catch(() => undefined)
    }, options.routing.quota.refreshSeconds * 1_000)
    unrefTimer(warmTimer)
  }
  const loadReference = createReferenceLoader(options.routing.referenceCatalog)
  const blacklisted = compileExclusions(options.routing.exclude)
  const health = createProviderHealth()
  const isExcluded = (providerID: string, modelID: string): boolean =>
    health.isCoolingDown(providerID) || blacklisted(providerID, modelID)
  const lastRequirements = new Map<string, TaskRequirements>()
  const selectOverrides: SelectOptionOverrides = {
    safetyMargin: options.routing.safetyMargin,
    thresholds: options.routing.thresholds,
  }
  const speed = await restoreSpeed(ctx, trace)
  const observeStepSpeed = createStepSpeedObserver(speed, () => {
    void persistSpeed(ctx, speed, trace)
  })

  /** Sources for one routing decision, read fresh from the ledger. */
  const candidateSources = async (): Promise<CandidateSources> => ({
    subscriptions: ledger.subscriptions(),
    overrides: options.routing.providerPools,
    isExcluded,
    profileOf: profileResolver({
      reference: await loadReference(),
      speed,
      now: Date.now,
    }),
  })

  trace("v2 setup", {
    version: versionOf(ctx.app),
    directory: ctx.location.directory,
  })

  const stateFor = (sessionID: string): SessionRuntimeState => {
    let state = sessions.get(sessionID)
    if (!state) {
      state = createSessionState()
      sessions.set(sessionID, state)
    }
    return state
  }

  /**
   * Starts the bounded quota refresh for a routable prompt. The ledger itself
   * decides whether data is fresh, so the kick is a no-op when it is.
   */
  const kickQuotaRefresh = (): Promise<void> | undefined => {
    if (!options.routing.quota.enabled) return undefined
    return ledger.refresh().catch(() => undefined)
  }

  /**
   * Mirrors model selections as they happen instead of waiting for the next
   * dispatch. A selection that is neither the virtual router nor a model
   * this router chose is a manual override: routing stops until Auto is
   * selected again.
   */
  /**
   * Switch a session to a routed target and record that the router owns it.
   *
   * @returns False when the host refused the switch; routing then stops for
   *   the session and the user sees why.
   */
  const switchToRoute = async (
    sessionID: string,
    outcome: Extract<RouteOutcome, { kind: "routed" }>,
    directive: string,
  ): Promise<boolean> => {
    const state = stateFor(sessionID)
    const target = outcome.target
    try {
      await ctx.session.switchModel({ sessionID, model: target })
      state.turnModel = target
      state.routedByUs = true
      state.mirrorModel = target
      pushDirective(state, directive)
      trace("v2 model routed", {
        sessionID,
        model: `${target.providerID}/${target.id}`,
        variant: target.variant,
        reason: outcome.decision.reason,
        floorRelaxed: outcome.relaxedNote,
        considered: outcome.decision.considered,
      })
      return true
    } catch (error) {
      state.routedByUs = false
      pushDirective(state, `Model switch failed: ${errorMessage(error)}`)
      return false
    }
  }

  const observeModelSelection = (event: unknown): void => {
    const sessionID = eventSessionID(event)
    const model = eventModelRef(event)
    if (!sessionID || !model) return
    const selected = toModelRef(model)
    const state = stateFor(sessionID)
    state.mirrorModel = selected
    if (!isVirtualModel(selected) && !sameModelRef(selected, state.turnModel)) {
      state.routedByUs = false
      delete state.turnModel
    }
    trace("v2 model selection observed", {
      sessionID,
      model: `${selected.providerID}/${selected.id}`,
    })
  }

  if (options.routing.enabled) {
    try {
      await registerVirtualProvider(ctx)
      trace("v2 virtual provider registered", { ref: virtualRef() })
    } catch (error) {
      trace("v2 virtual provider failed", { error: errorMessage(error) })
    }
  }

  await ctx.permission.hook("evaluate", async (event) => {
    if (!options.autoMode.enabled || event.effect !== "ask") return

    const action = event.action
    const resources = [...event.resources]
    const request = {
      action,
      resources,
      ...(options.privacy.includePermissionMetadata && event.metadata
        ? { metadata: event.metadata as Record<string, unknown> }
        : {}),
    }
    trace("v2 permission received", { action, effect: event.effect })

    const cacheKey = permissionCacheKey(action, resources)
    const cached = readPermissionCache(permissionCache, cacheKey)
    if (cached) {
      trace("v2 permission cache hit", { action, effect: cached.effect })
      event.effect = cached.effect
      if (cached.message !== undefined) event.message = cached.message
      return
    }

    try {
      const signals = await classifyPermission(jev, options, request)
      const decision = decidePermission(event.effect, signals, options, request)
      trace("v2 permission evaluated", { action, effect: decision.effect })

      const entry: CachedPermission = {
        effect: decision.effect,
        expires: Date.now() + PERMISSION_CACHE_TTL_MS,
      }
      if (decision.effect !== "allow") entry.message = decision.reason
      writePermissionCache(permissionCache, cacheKey, entry)

      event.effect = decision.effect
      if (decision.effect !== "allow") event.message = decision.reason
    } catch (error) {
      // Fail-safe: leave the configured effect untouched so OpenCode follows
      // its normal prompt path. Never blanket allow on error.
      trace("v2 permission classification failed", {
        action,
        error: errorMessage(error),
      })
    }
  })

  await ctx.session.hook("prompt", async (event) => {
    const sessionID = event.sessionID
    const state = stateFor(sessionID)
    const rawText = typeof event.prompt.text === "string" ? event.prompt.text : ""
    const prompt = truncate(rawText.trim() || "[non-text user request]", options.privacy.maxPromptChars)
    state.task = prompt
    const facts: PromptFacts = {
      promptChars: rawText.length,
      fileCount: event.prompt.files?.length ?? 0,
    }

    // The prompt event carries no model info, so routing relies on a mirror
    // of the last model observed in the context hook. An unknown mirror
    // falls back to the session's own selected model, then the global
    // default: only sessions expected to dispatch on the virtual model are
    // treated as routable before the first dispatch.
    const mirror = state.mirrorModel
    let routable = false
    if (options.routing.enabled) {
      if (mirror) {
        routable = isVirtualModel(mirror) || state.routedByUs === true
      } else {
        routable = await sessionDispatchesVirtual(ctx, sessionID, trace)
      }
    }
    if (!routable && !options.agents.enabled) return

    const quotaKick = routable ? kickQuotaRefresh() : undefined

    let route: RouteClassification | undefined
    try {
      route = await classifyRoute(jev, options, prompt)
    } catch (error) {
      route = fallbackClassification()
      trace("v2 prompt classification failed", { sessionID, error: errorMessage(error) })
      pushDirective(state, `Jev prompt classification failed. ${errorMessage(error)}`)
    }

    if (
      route &&
      options.agents.enabled &&
      route.domain &&
      (route.domainProbability ?? 0) >= options.agents.minimumProbability
    ) {
      const agent = options.agents.byDomain[route.domain]
      if (agent) {
        try {
          await ctx.session.switchAgent({ sessionID, agent })
          trace("v2 agent switched", { sessionID, agent, domain: route.domain })
        } catch (error) {
          pushDirective(state, `Agent switch to "${agent}" failed: ${errorMessage(error)}`)
        }
      }
    }

    if (!routable || !route) return

    await settleQuotaKick(quotaKick)

    const requirements = requirementsFromRoute(route, options, taskContextOf(route, facts))
    lastRequirements.set(sessionID, requirements)
    const outcome = await routeTask({
      ctx,
      sources: await candidateSources(),
      ledger,
      requirements,
      overrides: selectOverrides,
      trace,
    })
    if (outcome.kind === "unroutable") {
      pushDirective(state, outcome.directive)
      trace("v2 routing found no subscription model", { sessionID, ...outcome.details })
      return
    }
    await switchToRoute(sessionID, outcome, outcome.directive)
  })

  await ctx.session.hook(
    "retry",
    createFailoverHook({
      health,
      isRoutedModel: (sessionID, model) => {
        const state = sessions.get(sessionID)
        return (
          state?.routedByUs === true &&
          state.turnModel?.providerID === model.providerID &&
          state.turnModel.id === model.id
        )
      },
      reroute: async (sessionID) => {
        const requirements = lastRequirements.get(sessionID)
        if (requirements === undefined) return undefined
        return routeTask({ ctx, sources: await candidateSources(), ledger, requirements, overrides: selectOverrides, trace })
      },
      switchTo: switchToRoute,
      trace,
    }) as (event: unknown) => Promise<void>,
  )

  await ctx.session.hook("context", async (event) => {
    const sessionID = event.sessionID
    const state = sessions.get(sessionID)
    const observed = toModelRef({
      providerID: event.model.providerID,
      id: event.model.id,
      ...(typeof event.model.variant === "string" ? { variant: event.model.variant } : {}),
    })
    const mirror = stateFor(sessionID)
    mirror.mirrorModel = observed
    if (!isVirtualModel(observed) && !sameModelRef(observed, mirror.turnModel)) {
      // The user (or another plugin) selected a different model: stop
      // routing until the virtual model is selected again.
      mirror.routedByUs = false
      delete mirror.turnModel
    }

    if (!state?.task) return
    if (options.capabilities.enabled) {
      try {
        await narrowRequestCapabilities(capabilitySelector, event, state.task, trace)
      } catch (error) {
        trace("v2 capability narrowing failed", { sessionID, error: errorMessage(error) })
      }
    }
    if (!options.context.enabled) return
    try {
      await filterLargeToolContext(
        jev,
        options,
        state.task,
        event.messages as unknown[],
        contextFilterCache,
      )
    } catch {
      // Filtering is optional. Preserve the original request context on failure.
    }
  })

  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "session.model.selected") {
          observeModelSelection(event)
          continue
        }
        if (event.type === "session.step.started" || event.type === "session.step.ended") {
          observeStepSpeed(event)
          continue
        }
        if (event.type !== "session.deleted") continue
        const sessionID = eventSessionID(event)
        if (!sessionID) continue
        sessions.delete(sessionID)
        lastRequirements.delete(sessionID)
        capabilitySelector.forget(sessionID)
        clearSessionMap(contextFilterCache, sessionID)
      }
    } catch {
      // Aborted on cleanup.
    }
  })()

  return () => {
    controller.abort()
    if (warmTimer !== undefined) clearInterval(warmTimer)
    ledger.dispose()
  }
}

/** Measured speed survives restarts through the plugin's own storage. */
async function restoreSpeed(ctx: V2Context, trace: Trace): Promise<SpeedTracker> {
  try {
    return createSpeedTracker(await ctx.storage.get(SPEED_STORAGE_KEY))
  } catch (error) {
    trace("v2 speed state unreadable", { error: errorMessage(error) })
    return createSpeedTracker()
  }
}

async function persistSpeed(ctx: V2Context, speed: SpeedTracker, trace: Trace): Promise<void> {
  try {
    await ctx.storage.set(SPEED_STORAGE_KEY, speed.state())
  } catch (error) {
    trace("v2 speed state not saved", { error: errorMessage(error) })
  }
}

function virtualRef(): string {
  return `${VIRTUAL_PROVIDER_ID}/${VIRTUAL_MODEL_ID}`
}

function versionOf(app: unknown): string {
  if (app && typeof app === "object" && "version" in app) {
    const version = (app as Record<string, unknown>).version
    if (typeof version === "string") return version
  }
  return String(app)
}

/**
 * Whether the session is expected to dispatch on the virtual router before
 * the plugin has observed any dispatch. Prefers the session's own selected
 * model (the model picker writes it to the session); falls back to the
 * global default when the session has no explicit choice. Without this,
 * session-level Auto selections dispatch straight to the virtual provider
 * and fail with a missing-credential error.
 */
async function sessionDispatchesVirtual(
  ctx: V2Context,
  sessionID: string,
  trace: Trace,
): Promise<boolean> {
  try {
    const session = await ctx.session.get({ sessionID })
    const model = session?.model
    if (model) return isVirtualModel(model)
  } catch (error) {
    trace("v2 session model unreadable", {
      sessionID,
      error: errorMessage(error),
    })
  }
  return defaultIsVirtual(ctx, trace)
}

/**
 * Whether the global default model is the virtual router marker. Used only
 * when the session has no explicit model: sessions whose global default is
 * Auto are treated as routable.
 */
async function defaultIsVirtual(
  ctx: V2Context,
  trace: Trace,
): Promise<boolean> {
  try {
    const current = await ctx.model.default()
    const model = current?.data
    return Boolean(
      model &&
        model.providerID === VIRTUAL_PROVIDER_ID &&
        model.id === VIRTUAL_MODEL_ID,
    )
  } catch (error) {
    trace("v2 default model unreadable", {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * Registers the selectable `Auto (Jev)` marker model. The prompt hook
 * switches sessions away from it before any dispatch, so it is never used
 * for inference.
 */
async function registerVirtualProvider(ctx: V2Context): Promise<void> {
  // Imported lazily so v1 hosts never evaluate the v2 schema runtime.
  const { Model, Provider } = await import("@opencode/plugin")
  const providerID = Provider.ID.make(VIRTUAL_PROVIDER_ID)
  await ctx.provider.transform((editor) => {
    if (editor.get(VIRTUAL_PROVIDER_ID)) return
    editor.add({
      info: {
        ...Provider.Info.empty(providerID),
        name: VIRTUAL_PROVIDER_NAME,
        package: "@opencode/ai/providers/openai-compatible",
        settings: {
          baseURL: "http://127.0.0.1:9/opencode-classifier-plugin/virtual",
        },
      },
      models: [
        {
          ...Model.Info.default(providerID, Model.ID.make(VIRTUAL_MODEL_ID)),
          name: VIRTUAL_MODEL_NAME,
        },
      ],
    })
  })
}

function clearSessionMap<T>(map: Map<string, T>, sessionID: string): void {
  const prefix = `${sessionID}:`
  for (const key of map.keys()) {
    if (key.startsWith(prefix)) map.delete(key)
  }
}
