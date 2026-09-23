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

export interface RouterOptions {
  enabled?: boolean
  sticky?: boolean
  models?: Partial<Record<ModelTier, string>>
  efforts?: Partial<Record<ModelTier, string>>
  fallbackTier?: ModelTier
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

export interface SkillRoutingOptions {
  enabled?: boolean
  minimumProbability?: number
  maxCandidates?: number
  maxSelected?: number
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
  router?: RouterOptions
  autoMode?: AutoModeOptions
  agents?: DomainRoutingOptions
  skills?: SkillRoutingOptions
  context?: ContextOptions
  privacy?: PrivacyOptions
}

export interface ResolvedOptions {
  debug: boolean
  decision: Required<DecisionOptions>
  router: {
    enabled: boolean
    sticky: boolean
    models: Record<ModelTier, string>
    efforts: Record<ModelTier, string>
    fallbackTier: ModelTier
    thresholds: Required<NonNullable<RouterOptions["thresholds"]>>
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
  skills: {
    enabled: boolean
    minimumProbability: number
    maxCandidates: number
    maxSelected: number
  }
  context: Required<ContextOptions>
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

export interface SkillCandidate {
  name: string
  description: string
}

export interface SkillSelection {
  name: string
  probability: number
}

export interface SessionRuntimeState {
  task?: string
  routerActive: boolean
  lastRoutedModel?: ModelRef
  turnModel?: ModelRef
  routedTier?: ModelTier
  routedSkills: string[]
  skillSelectionDone: boolean
  directives: string[]
}
