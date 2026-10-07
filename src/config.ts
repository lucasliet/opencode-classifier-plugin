import { defaultReferencePath, expandHome } from "./routing/reference.ts"
import type { ModelRef, PluginOptions, ResolvedOptions } from "./types.ts"

export const VIRTUAL_PROVIDER_ID = "jev-model-router"
export const VIRTUAL_PROVIDER_NAME = "jev model router"
export const VIRTUAL_MODEL_ID = "auto"
export const VIRTUAL_MODEL_NAME = "Auto (Jev)"
export const VIRTUAL_MODEL_REF = `${VIRTUAL_PROVIDER_ID}/${VIRTUAL_MODEL_ID}`

const DEFAULT_ENDPOINT = "https://opencode.ai/zen/v1/systemone"
const DEFAULT_JEV_MODEL = "jev-1.13-free"
const DEFAULT_QUOTA_BINARY = "ai-usagebar"
const DEFAULT_QUOTA_ARGS = ["usage", "--json"]
const DEFAULT_VENDOR_ARGS = ["vendors", "--json"]
/** The `opencode` namespace holds harness tools, not MCP servers. */
const DEFAULT_ALWAYS_INCLUDED_NAMESPACES = ["opencode"]

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(num(value, fallback, min, max))
}

function stringMap(value: unknown): Record<string, string> {
  const input = record(value)
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(input)) {
    if (typeof item === "string" && item.trim()) out[key] = item.trim()
  }
  return out
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim())
}

/** A configured list replaces the default only when it is non-empty. */
function listOr(value: unknown, fallback: readonly string[]): string[] {
  const list = stringList(value)
  return list.length > 0 ? list : [...fallback]
}

/**
 * Normalize untrusted plugin options into a fully populated configuration.
 *
 * Every option is optional and every unknown value falls back to a default, so
 * the plugin works with zero configuration. Out-of-range numbers are clamped
 * instead of rejected, because a misconfigured router should degrade to
 * default behavior rather than fail the whole host.
 *
 * @param raw Untrusted options object handed over by OpenCode.
 * @returns The resolved configuration used by every other module.
 * @throws When `autoMode.thresholds.deny` is below `autoMode.thresholds.riskAsk`,
 * which would silently invert the permission escalation ladder.
 */
export function resolveOptions(raw: unknown): ResolvedOptions {
  const source = record(raw) as PluginOptions & Record<string, unknown>
  const decision = record(source.decision)
  const routing = record(source.routing)
  const routingQuota = record(routing.quota)
  const routingThresholds = record(routing.thresholds)
  const autoMode = record(source.autoMode)
  const autoModeCommandRules = record(autoMode.commandRules)
  const autoModeThresholds = record(autoMode.thresholds)
  const agents = record(source.agents)
  const context = record(source.context)
  const capabilities = record(source.capabilities)
  const capabilitiesAlwaysInclude = record(capabilities.alwaysInclude)
  const privacy = record(source.privacy)

  const onErrorValue = str(autoMode.onError, "ask")
  const onError: "ask" | "preserve" = onErrorValue === "preserve" ? "preserve" : "ask"

  const resolved: ResolvedOptions = {
    debug: bool(source.debug, false),
    logFile: expandHome(str(source.logFile, "")),
    decision: {
      endpoint: str(decision.endpoint, DEFAULT_ENDPOINT),
      model: str(decision.model, DEFAULT_JEV_MODEL),
      apiKey: str(decision.apiKey, ""),
      apiKeyEnv: str(decision.apiKeyEnv, "OPENCODE_API_KEY"),
      requireAuth: bool(decision.requireAuth, true),
      timeoutMs: integer(decision.timeoutMs, 8_000, 250, 60_000),
      retries: integer(decision.retries, 1, 0, 5),
    },
    routing: {
      enabled: bool(routing.enabled, true),
      safetyMargin: num(routing.safetyMargin, 0.1, 0, 0.9),
      exclude: stringList(routing.exclude),
      providerPools: stringMap(routing.providerPools),
      providerAliases: stringMap(routing.providerAliases),
      referenceCatalog: expandHome(str(routing.referenceCatalog, defaultReferencePath())),
      quota: {
        enabled: bool(routingQuota.enabled, true),
        binary: str(routingQuota.binary, DEFAULT_QUOTA_BINARY),
        args: listOr(routingQuota.args, DEFAULT_QUOTA_ARGS),
        vendorArgs: listOr(routingQuota.vendorArgs, DEFAULT_VENDOR_ARGS),
        timeoutMs: integer(routingQuota.timeoutMs, 8_000, 500, 60_000),
        refreshSeconds: integer(routingQuota.refreshSeconds, 120, 30, 3_600),
      },
      thresholds: {
        fastChoice: num(routingThresholds.fastChoice, 0.72, 0, 1),
        deepChoice: num(routingThresholds.deepChoice, 0.58, 0, 1),
        deepReasoning: num(routingThresholds.deepReasoning, 0.72, 0, 1),
        highRisk: num(routingThresholds.highRisk, 0.72, 0, 1),
      },
    },
    autoMode: {
      enabled: bool(autoMode.enabled, true),
      onError,
      commandRules: {
        ask: stringList(autoModeCommandRules.ask),
        deny: stringList(autoModeCommandRules.deny),
      },
      thresholds: {
        autoAllow: num(autoModeThresholds.autoAllow, 0.80, 0, 1),
        projectChange: num(autoModeThresholds.projectChange, 0.60, 0, 1),
        reversibleAllow: num(autoModeThresholds.reversibleAllow, 0.88, 0, 1),
        riskAsk: num(autoModeThresholds.riskAsk, 0.45, 0, 1),
        deny: num(autoModeThresholds.deny, 0.65, 0, 1),
      },
      allowReversibleProjectChanges: bool(autoMode.allowReversibleProjectChanges, true),
      denyHighRisk: bool(autoMode.denyHighRisk, false),
    },
    agents: {
      enabled: bool(agents.enabled, false),
      minimumProbability: num(agents.minimumProbability, 0.85, 0, 1),
      byDomain: stringMap(agents.byDomain),
    },
    context: {
      enabled: bool(context.enabled, true),
      minChars: integer(context.minChars, 12_000, 1_000, 1_000_000),
      chunkChars: integer(context.chunkChars, 2_500, 300, 20_000),
      minimumCandidates: integer(context.minimumCandidates, 6, 2, 64),
      maxCandidates: integer(context.maxCandidates, 24, 2, 64),
      maxBatches: integer(context.maxBatches, 4, 1, 32),
      relevantAt: num(context.relevantAt, 0.52, 0, 1),
    },
    capabilities: {
      enabled: bool(capabilities.enabled, true),
      relevantAt: num(capabilities.relevantAt, 0.4, 0, 1),
      alwaysInclude: {
        skills: stringList(capabilitiesAlwaysInclude.skills),
        namespaces: Array.isArray(capabilitiesAlwaysInclude.namespaces)
          ? stringList(capabilitiesAlwaysInclude.namespaces)
          : [...DEFAULT_ALWAYS_INCLUDED_NAMESPACES],
      },
    },
    privacy: {
      maxStateChars: integer(privacy.maxStateChars, 24_000, 2_000, 200_000),
      maxPromptChars: integer(privacy.maxPromptChars, 8_000, 500, 50_000),
      maxEvidenceChars: integer(privacy.maxEvidenceChars, 12_000, 1_000, 100_000),
      maxResourceChars: integer(privacy.maxResourceChars, 4_000, 500, 20_000),
      includePermissionMetadata: bool(privacy.includePermissionMetadata, false),
    },
  }

  if (resolved.autoMode.thresholds.deny < resolved.autoMode.thresholds.riskAsk) {
    throw new Error(
      "opencode-classifier-plugin: autoMode.thresholds.deny must be >= autoMode.thresholds.riskAsk.",
    )
  }

  return resolved
}

export function parseModelRef(value: string): ModelRef {
  const trimmed = value.trim()
  const hash = trimmed.indexOf("#")
  const base = hash >= 0 ? trimmed.slice(0, hash) : trimmed
  const variant = hash >= 0 ? trimmed.slice(hash + 1).trim() : undefined
  const slash = base.indexOf("/")

  if (slash <= 0 || slash === base.length - 1) {
    throw new Error(
      `opencode-classifier-plugin: invalid model reference "${value}". Expected provider/model or provider/model#variant.`,
    )
  }

  const providerID = base.slice(0, slash).trim()
  const id = base.slice(slash + 1).trim()
  if (!providerID || !id) {
    throw new Error(`opencode-classifier-plugin: invalid model reference "${value}".`)
  }

  return variant ? { providerID, id, variant } : { providerID, id }
}

export function formatModelRef(model: ModelRef): string {
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
}

export function sameModelRef(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  return Boolean(
    a &&
      b &&
      a.providerID === b.providerID &&
      a.id === b.id &&
      (a.variant ?? "") === (b.variant ?? ""),
  )
}

export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 32))}\n...[truncated]`
}

export function safeJson(value: unknown, maxChars = 20_000): string {
  try {
    const seen = new WeakSet<object>()
    const json = JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return item.toString()
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]"
        seen.add(item)
      }
      return item
    })
    return truncate(json ?? String(value), maxChars)
  } catch {
    return truncate(String(value), maxChars)
  }
}

export function hashString(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}
