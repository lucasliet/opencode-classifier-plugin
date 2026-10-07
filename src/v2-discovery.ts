import type { Plugin } from "@opencode/plugin"
import { VIRTUAL_PROVIDER_ID } from "./config.ts"
import { candidatesFor, planRoutes } from "./routing/assemble.ts"
import type { CandidateSources } from "./routing/assemble.ts"
import { toCatalogModels } from "./routing/catalog.ts"
import type { RoutableModel, SubscriptionRoute } from "./routing/contracts.ts"
import type { Trace } from "./trace.ts"

type V2Context = Plugin.Context

/** Discovery outcome: gated candidates plus why routes were excluded. */
export interface DiscoveryResult {
  readonly models: readonly RoutableModel[]
  readonly exclusions: readonly string[]
  readonly error: string | undefined
}

type ConnectionVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/** Routes that kept at least one proven provider, plus the rejections. */
interface RouteGate {
  readonly routes: readonly SubscriptionRoute[]
  readonly exclusions: readonly string[]
}

/**
 * Read the live host catalog, associate it with the subscriptions
 * `ai-usagebar` reports, prove OAuth-bound providers and build candidates.
 * Discovery runs on every routable prompt — it is a cheap local call and keeps
 * the candidates fresh — and any failure degrades to zero models rather than
 * throwing inside the prompt hook.
 *
 * @param ctx V2 plugin context.
 * @param sources Subscriptions, overrides, blacklist and profile source.
 * @param trace Debug tracer.
 * @returns Candidates and the reasons anything was left out.
 */
export async function discoverRoutableModels(
  ctx: V2Context,
  sources: CandidateSources,
  trace: Trace,
): Promise<DiscoveryResult> {
  try {
    const listed = await ctx.model.list()
    const catalog = toCatalogModels(listed.data).filter(
      (model) => model.providerID !== VIRTUAL_PROVIDER_ID,
    )
    const plan = planRoutes(catalog, sources)
    trace("v2 subscription association", {
      subscriptions: sources.subscriptions.map((subscription) => subscription.id),
      routes: plan.routes.map((route) => `${route.id}:${route.providerIDs.join("+")}`),
      unmatched: plan.unmatched,
    })
    const gate = await gateOAuthProviders(ctx, plan.routes)
    if (gate.exclusions.length > 0) {
      trace("v2 subscription providers excluded", { exclusions: gate.exclusions })
    }
    const models = candidatesFor(catalog, gate.routes, sources)
    trace("v2 subscription candidates", { refs: models.map((model) => model.ref) })
    return {
      models,
      exclusions: [...noSubscriptionNote(sources), ...gate.exclusions],
      error: undefined,
    }
  } catch (error) {
    return { models: [], exclusions: [], error: errorMessage(error) }
  }
}

function noSubscriptionNote(sources: CandidateSources): string[] {
  if (sources.subscriptions.length > 0) return []
  return ["ai-usagebar reports no active subscription with a quota window yet"]
}

/**
 * Providers of a vendor whose quota belongs to an OAuth login must show an
 * OAuth grant: the same provider with a key or env credential is metered, and
 * an unreadable connection fails closed with the error in the reason.
 */
async function gateOAuthProviders(
  ctx: V2Context,
  routes: readonly SubscriptionRoute[],
): Promise<RouteGate> {
  const proven: SubscriptionRoute[] = []
  const exclusions: string[] = []
  for (const route of routes) {
    const providerIDs: string[] = []
    for (const providerID of route.providerIDs) {
      const verdict = route.connection.requireOAuth
        ? await verifyOAuthProvider(ctx, providerID)
        : ({ ok: true } as const)
      if (verdict.ok) providerIDs.push(providerID)
      else exclusions.push(`${route.label}: ${verdict.reason}`)
    }
    if (providerIDs.length > 0) proven.push({ ...route, providerIDs })
  }
  return { routes: proven, exclusions }
}

async function verifyOAuthProvider(
  ctx: V2Context,
  providerID: string,
): Promise<ConnectionVerdict> {
  let connection: unknown
  try {
    connection = await ctx.integration.connection.active(providerID)
  } catch (error) {
    return {
      ok: false,
      reason: `${providerID} connection state unreadable (${errorMessage(error)})`,
    }
  }
  if (isOAuthCredential(connection)) return { ok: true }
  if (connection === undefined) {
    return { ok: false, reason: `${providerID} has no active connection` }
  }
  if (isCredentialConnection(connection)) {
    return {
      ok: false,
      reason: `${providerID} active connection is not an OAuth grant; API keys are pay-as-you-go`,
    }
  }
  return {
    ok: false,
    reason: `${providerID} active connection is an env credential, not an OAuth grant`,
  }
}

function isCredentialConnection(
  value: unknown,
): value is { readonly type: "credential"; readonly method: string } {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return record["type"] === "credential" && typeof record["method"] === "string"
}

function isOAuthCredential(value: unknown): boolean {
  return isCredentialConnection(value) && value.method === "oauth"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
