/**
 * Legacy complexity band.
 *
 * Retained only so the V1 adapter keeps compiling while it transitions to the
 * routing contracts; nothing in the plugin core uses it anymore. Task
 * complexity is a signal (`RouteClassification.complexity`), not a model
 * selector. Delete once `src/v1.ts` stops depending on it.
 */
export type ModelTier = "fast" | "normal" | "deep"

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface DecisionOptions {
  endpoint?: string
  model?: string
  apiKey?: string
  apiKeyEnv?: string
  requireAuth?: boolean
  timeoutMs?: number
  retries?: number
}

/**
 * Zero-config model routing.
 *
 * The router discovers subscription models from the host and picks one from
 * live quota, so no field is required: an empty block is a valid, working
 * configuration.
 */
export interface RoutingOptions {
  /** Master switch for subscription routing. */
  enabled?: boolean
  /** Share of a quota window the router refuses to spend. */
  safetyMargin?: number
  /**
   * Never route to these. A pattern without `/` matches a provider ID
   * (`claude-dipol`), one with `/` matches `provider/model`; `*` is a wildcard.
   */
  exclude?: string[]
  /**
   * Provider ID → `ai-usagebar` vendor ID, for providers the automatic
   * association cannot place (for example `{ "my-proxy": "anthropic" }`).
   */
  providerPools?: Record<string, string>
  /** models.dev cache used to derive profiles; defaults to OpenCode's cache. */
  referenceCatalog?: string
  quota?: {
    enabled?: boolean
    /** Executable that reports subscription quota. */
    binary?: string
    /** Arguments that make the binary print its usage document as JSON. */
    args?: string[]
    /** Arguments that make the binary list vendors and their auth kind as JSON. */
    vendorArgs?: string[]
    timeoutMs?: number
    /** How long a quota snapshot stays fresh before a refetch. */
    refreshSeconds?: number
  }
  /**
   * Signal cutoffs, kept identical to the retired fixed-model router so
   * existing tuning carries over unchanged.
   */
  thresholds?: {
    fastChoice?: number
    deepChoice?: number
    deepReasoning?: number
    highRisk?: number
  }
}

export interface AutoModeOptions {
  enabled?: boolean
  onError?: "ask" | "preserve"
  commandRules?: {
    ask?: string[]
    deny?: string[]
  }
  thresholds?: {
    autoAllow?: number
    projectChange?: number
    reversibleAllow?: number
    riskAsk?: number
    deny?: number
  }
  allowReversibleProjectChanges?: boolean
  denyHighRisk?: boolean
}

export interface DomainRoutingOptions {
  enabled?: boolean
  minimumProbability?: number
  byDomain?: Record<string, string>
}

export interface ContextOptions {
  enabled?: boolean
  minChars?: number
  chunkChars?: number
  minimumCandidates?: number
  maxCandidates?: number
  maxBatches?: number
  relevantAt?: number
}

/**
 * Skill and Code Mode namespace selection: Jev decides which skills and MCP
 * or plugin tool namespaces the task needs, and only those are described to
 * the model. The rest stay reachable by skill ID or Code Mode `search`.
 */
export interface CapabilityOptions {
  enabled?: boolean
  /** Minimum Jev relevance for a skill or namespace to be described in full. */
  relevantAt?: number
  /** Skills and Code Mode namespaces that are always described in full. */
  alwaysInclude?: {
    skills?: string[]
    namespaces?: string[]
  }
}

export interface PrivacyOptions {
  maxStateChars?: number
  maxPromptChars?: number
  maxEvidenceChars?: number
  maxResourceChars?: number
  includePermissionMetadata?: boolean
}

export interface PluginOptions {
  debug?: boolean
  decision?: DecisionOptions
  routing?: RoutingOptions
  autoMode?: AutoModeOptions
  agents?: DomainRoutingOptions
  context?: ContextOptions
  capabilities?: CapabilityOptions
  privacy?: PrivacyOptions
}

export interface ResolvedOptions {
  debug: boolean
  decision: Required<DecisionOptions>
  routing: {
    enabled: boolean
    safetyMargin: number
    exclude: string[]
    providerPools: Record<string, string>
    referenceCatalog: string
    quota: Required<NonNullable<RoutingOptions["quota"]>>
    thresholds: Required<NonNullable<RoutingOptions["thresholds"]>>
  }
  autoMode: {
    enabled: boolean
    onError: "ask" | "preserve"
    commandRules: {
      ask: string[]
      deny: string[]
    }
    thresholds: Required<NonNullable<AutoModeOptions["thresholds"]>>
    allowReversibleProjectChanges: boolean
    denyHighRisk: boolean
  }
  agents: {
    enabled: boolean
    minimumProbability: number
    byDomain: Record<string, string>
  }
  context: Required<ContextOptions>
  capabilities: {
    enabled: boolean
    relevantAt: number
    alwaysInclude: {
      skills: string[]
      namespaces: string[]
    }
  }
  privacy: Required<PrivacyOptions>
}

export type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] | Record<string, string> }

export type JevAnswer =
  | { type: "noul"; noul: number }
  | {
      type: "choice"
      choice: string
      confidence?: number
      probabilities?: Record<string, number>
    }
  | {
      type: "score"
      score: number
      confidence?: number
      probabilities?: Record<string, number>
      legend?: Record<string, string>
    }

export interface JevResponse {
  model?: string
  answers: Record<string, JevAnswer>
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
}

export interface RouteClassification {
  /**
   * Task-complexity signal only. It no longer names a model: the router reads
   * it together with `deepReasoning`, `highRisk` and `research` to pick a
   * capability tier and a reasoning-effort ceiling.
   */
  complexity: "fast" | "normal" | "deep"
  complexityProbability: number
  deepReasoning: number
  highRisk: number
  domain?: string
  domainProbability?: number
  research: number
}

export interface PermissionSignals {
  readOnly: number
  modifiesProjectFiles: number
  outsideWorkspace: number
  destructive: number
  reversible: number
  changesVcsHistory: number
  executesDownloadedCode: number
  externalSideEffect: number
  sensitiveData: number
  privilegeEscalation: number
}

export interface SessionRuntimeState {
  task?: string
  /** Whether the V1 adapter is currently steering the model. */
  routerActive: boolean
  lastRoutedModel?: ModelRef
  turnModel?: ModelRef
  /** Last model observed for the session (v2 context hook mirror). */
  mirrorModel?: ModelRef
  /** Whether the last model switch was performed by the router. */
  routedByUs?: boolean
  directives: string[]
}
