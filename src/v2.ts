import type { Plugin } from "@opencode/plugin"
import {
  VIRTUAL_MODEL_ID,
  VIRTUAL_MODEL_NAME,
  VIRTUAL_PROVIDER_ID,
  VIRTUAL_PROVIDER_NAME,
  parseModelRef,
  resolveOptions,
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
import { createTracer } from "./trace.ts"
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
 * V2 setup for OpenCode >= 2. Implements the same product behavior as the
 * v1 adapter (src/v1.ts) through native V2 primitives:
 *
 * - permission Auto Mode via `permission.hook("evaluate")` (no async reply
 *   workaround);
 * - model router via `session.hook("prompt")` classification plus native
 *   `session.switchModel` (no sticky workaround; routing is per prompt);
 * - agent routing via native `session.switchAgent`;
 * - context filtering via `session.hook("context")` (outgoing call only,
 *   persisted history untouched).
 *
 * @param ctx - The V2 plugin context.
 * @returns An optional cleanup function for the event subscription.
 */
export async function setupV2(ctx: V2Context): Promise<(() => void) | void> {
  const options = resolveOptions(ctx.options)
  const trace = createTracer(options.debug)
  const jev = new JevClient(options)
  const sessions = new Map<string, SessionRuntimeState>()
  const permissionCache = new Map<string, CachedPermission>()
  const contextFilterCache = new Map<string, string | undefined>()

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

  if (options.router.enabled) {
    try {
      await registerVirtualProvider(ctx)
      trace("v2 virtual provider registered", { ref: virtualRef() })
    } catch (error) {
      trace("v2 virtual provider failed", { error: errorMessage(error) })
    }
  }

  await ctx.permission.hook("evaluate", async (event) => {
    if (!options.autoMode.enabled) return

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
      // Fail-safe: leave the configured effect untouched so OpenCode
      // follows its normal prompt path. Never blanket allow on error.
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

    // The prompt event carries no model info, so routing relies on a mirror
    // of the last model observed in the context hook. An unknown mirror
    // falls back to the global default: only sessions that default to the
    // virtual model are treated as routable before the first dispatch.
    const mirror = state.mirrorModel
    let routable = false
    if (options.router.enabled) {
      if (mirror) {
        routable = isVirtualModel(mirror) || state.routedByUs === true
      } else {
        routable = await defaultIsVirtual(ctx, trace)
      }
    }
    if (!routable && !options.agents.enabled) return

    let route: RouteClassification | undefined
    let routeFailed = false
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
    const tier = routeFailed ? options.router.fallbackTier : chooseTier(route, options)
    const target = parseModelRef(options.router.models[tier])
    const effort = options.router.efforts[tier]
    if (effort) target.variant = effort

    try {
      await ctx.session.switchModel({
        sessionID,
        model: {
          providerID: target.providerID,
          id: target.id,
          ...(target.variant ? { variant: target.variant } : {}),
        },
      })
      state.routedTier = tier
      state.turnModel = target
      state.routedByUs = true
      state.mirrorModel = target
      trace("v2 model switched", {
        sessionID,
        tier,
        model: `${target.providerID}/${target.id}`,
      })
    } catch (error) {
      state.routedByUs = false
      pushDirective(state, `Model switch failed: ${errorMessage(error)}`)
    }
  })

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
      delete mirror.routedTier
    }

    if (!options.context.enabled || !state?.task) return
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
        if (event.type !== "session.deleted") continue
        const sessionID = eventSessionID(event)
        if (!sessionID) continue
        sessions.delete(sessionID)
        clearSessionMap(contextFilterCache, sessionID)
      }
    } catch {
      // Aborted on cleanup.
    }
  })()

  return () => controller.abort()
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
 * Whether the global default model is the virtual router marker. Used only
 * when the session mirror is still unknown (before the first dispatch):
 * sessions that default to Auto are treated as routable, sessions with a
 * real default are left alone until the mirror is observed.
 */
async function defaultIsVirtual(
  ctx: V2Context,
  trace: (message: string, details: Record<string, unknown>) => void,
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
