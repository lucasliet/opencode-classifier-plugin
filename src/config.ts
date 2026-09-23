import type { ModelRef, ModelTier, PluginOptions, ResolvedOptions } from "./types.ts"

export const VIRTUAL_PROVIDER_ID = "jev-model-router"
export const VIRTUAL_PROVIDER_NAME = "jev model router"
export const VIRTUAL_MODEL_ID = "auto"
export const VIRTUAL_MODEL_NAME = "Auto (Jev)"
export const VIRTUAL_MODEL_REF = `${VIRTUAL_PROVIDER_ID}/${VIRTUAL_MODEL_ID}`

const DEFAULT_ENDPOINT = "https://opencode.ai/zen/v1/systemone"
const DEFAULT_JEV_MODEL = "jev-1.13-free"

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

export function resolveOptions(raw: unknown): ResolvedOptions {
  const source = record(raw) as PluginOptions & Record<string, unknown>
  const decision = record(source.decision)
  const router = record(source.router)
  const routerModels = record(router.models)
  const routerEfforts = record(router.efforts)
  const routerThresholds = record(router.thresholds)
  const autoMode = record(source.autoMode)
  const autoModeCommandRules = record(autoMode.commandRules)
  const autoModeThresholds = record(autoMode.thresholds)
  const agents = record(source.agents)
  const context = record(source.context)
  const privacy = record(source.privacy)

  const routerEnabled = bool(router.enabled, true)
  const models: Record<ModelTier, string> = {
    fast: str(routerModels.fast, ""),
    normal: str(routerModels.normal, ""),
    deep: str(routerModels.deep, ""),
  }
  const efforts: Record<ModelTier, string> = {
    fast: str(routerEfforts.fast, ""),
    normal: str(routerEfforts.normal, ""),
    deep: str(routerEfforts.deep, ""),
  }

  if (routerEnabled) {
    for (const tier of ["fast", "normal", "deep"] as const) {
      if (!models[tier]) {
        throw new Error(
          `opencode-classifier-plugin: router.models.${tier} is required when the selectable Jev model router is enabled. See opencode.example.json.`,
        )
      }
      const parsed = parseModelRef(models[tier])
      if (parsed.providerID === VIRTUAL_PROVIDER_ID && parsed.id === VIRTUAL_MODEL_ID) {
        throw new Error(
          `opencode-classifier-plugin: router.models.${tier} cannot point back to ${VIRTUAL_MODEL_REF}.`,
        )
      }
    }
  }

  const fallbackTierValue = str(router.fallbackTier, "normal")
  const fallbackTier: ModelTier =
    fallbackTierValue === "fast" || fallbackTierValue === "deep" ? fallbackTierValue : "normal"

  const onErrorValue = str(autoMode.onError, "ask")
  const onError: "ask" | "preserve" = onErrorValue === "preserve" ? "preserve" : "ask"

  const resolved: ResolvedOptions = {
    debug: bool(source.debug, false),
    decision: {
      endpoint: str(decision.endpoint, DEFAULT_ENDPOINT),
      model: str(decision.model, DEFAULT_JEV_MODEL),
      apiKey: str(decision.apiKey, ""),
      apiKeyEnv: str(decision.apiKeyEnv, "OPENCODE_API_KEY"),
      requireAuth: bool(decision.requireAuth, true),
      timeoutMs: integer(decision.timeoutMs, 8_000, 250, 60_000),
      retries: integer(decision.retries, 1, 0, 5),
    },
    router: {
      enabled: routerEnabled,
      sticky: bool(router.sticky, true),
      models,
      efforts,
      fallbackTier,
      thresholds: {
        fastChoice: num(routerThresholds.fastChoice, 0.72, 0, 1),
        deepChoice: num(routerThresholds.deepChoice, 0.58, 0, 1),
        deepReasoning: num(routerThresholds.deepReasoning, 0.72, 0, 1),
        highRisk: num(routerThresholds.highRisk, 0.72, 0, 1),
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
