import type {
  JevQuestion,
  PermissionSignals,
  ResolvedOptions,
  RouteClassification,
} from "./types.ts"
import type { CapabilityTier, TaskRequirements } from "./routing/contracts.ts"
import { EFFORT_ORDER } from "./routing/contracts.ts"
import { choice, JevClient, noul } from "./jev.ts"
import { safeJson, truncate } from "./config.ts"

/**
 * Research signal that buys one extra reasoning step. The public configuration
 * has no research cutoff, so this stays a local constant: above this value the
 * task needs gathering before implementation, which the cheapest effort on the
 * chosen model cannot do well.
 */
const RESEARCH_EFFORT_BUMP_AT = 0.5

/** Reasoning effort each capability tier is allowed to use by default. */
const TIER_BASE_EFFORT: Record<CapabilityTier, TaskRequirements["maxEffort"]> = {
  economy: "low",
  balanced: "high",
  advanced: "max",
}

/** Local, host-derived facts about the task that Jev cannot observe. */
export interface TaskRequirementsInput {
  estimatedInputTokens: number
  estimatedOutputTokens: number
  needsTools: boolean
  needsVision: boolean
  estimatedTurns: number
}

type RoutingThresholds = ResolvedOptions["routing"]["models"]["thresholds"]

/**
 * Ask Jev to describe the request, without solving it.
 *
 * The answers are signals only: the caller maps them onto a capability tier
 * and a reasoning-effort ceiling through `requirementsFromRoute`. A missing or
 * unrecognized complexity answer degrades to the neutral middle band instead of
 * a configured fallback model, because no model is configured anymore.
 *
 * @param jev Client used to reach System One.
 * @param options Resolved plugin configuration.
 * @param prompt Raw user prompt for the turn.
 * @returns The complexity, reasoning, risk, research and domain signals.
 */
export async function classifyRoute(
  jev: JevClient,
  options: ResolvedOptions,
  prompt: string,
): Promise<RouteClassification> {
  const domains = new Set<string>(Object.keys(options.routing.agents.byDomain))

  const questions: Record<string, JevQuestion> = {
    complexity: {
      type: "choice",
      instructions: "Choose the minimum model tier appropriate for solving this coding-agent request reliably.",
      criteria: {
        fast: "Simple, local, mechanical, lookup, small edit, straightforward explanation, or deterministic task.",
        normal: "Ordinary software engineering requiring several steps or moderate reasoning.",
        deep: "Architecture, ambiguous debugging, security-sensitive work, broad refactors, hard algorithms, or unusually high-consequence reasoning.",
      },
    },
    deep_reasoning: {
      type: "noul",
      instructions: "Does this request materially benefit from deep multi-step reasoning rather than ordinary coding reasoning?",
    },
    high_risk: {
      type: "noul",
      instructions: "Would a wrong answer or wrong implementation have unusually high operational, security, data-loss, financial, or release risk?",
    },
    research: {
      type: "noul",
      instructions: "Does this request require external research or substantial repository exploration before implementation?",
    },
  }

  if (domains.size > 0) {
    const criteria: Record<string, string> = {
      general: "No configured specialist domain is clearly dominant.",
    }
    for (const domain of domains) criteria[domain] = `The task primarily belongs to the ${domain} domain.`
    questions.domain = {
      type: "choice",
      instructions: "Choose the single configured specialist domain that best matches this request.",
      criteria,
    }
  }

  const response = await jev.ask(
    {
      task: truncate(prompt, options.privacy.maxPromptChars),
      instruction:
        "Classify the task only. Do not solve it. Prefer the least expensive tier that is still reliable.",
    },
    questions,
  )

  const complexity = choice(response, "complexity")
  const domain = choice(response, "domain")

  return {
    complexity: complexityBand(complexity.value),
    complexityProbability: complexity.probability,
    deepReasoning: noul(response, "deep_reasoning"),
    highRisk: noul(response, "high_risk"),
    research: noul(response, "research"),
    ...(domain.value && domain.value !== "general"
      ? { domain: domain.value, domainProbability: domain.probability }
      : {}),
  }
}

/**
 * Turn a Jev classification plus host-side estimates into routing requirements.
 *
 * Pure and side-effect free so the routing pipeline can be reasoned about
 * without a model catalog or a quota ledger.
 *
 * Tier selection, in order:
 * - `advanced` when the complexity signal is a confident `deep`, or the
 *   reasoning or risk signal crosses its threshold: those tasks have the
 *   highest cost of a wrong answer, so the cheapest usable model is not enough.
 * - `economy` when complexity is a confident `fast` and both the reasoning and
 *   the risk signals stay below their thresholds: mechanical work does not
 *   repay a stronger model.
 * - `balanced` otherwise, which is the safe default for anything uncertain.
 *
 * The effort ceiling starts at the tier's base effort and is raised by one step
 * when the research signal shows the task needs gathering before implementation.
 * It never exceeds `max`, so an already maximum effort stays maximum.
 *
 * Reasoning is requested everywhere except on the economy tier, which is only
 * reached when no deep, reasoning or risk signal fired.
 *
 * Speed is preferred exactly on the economy tier: that tier is only reached
 * for confident-fast work with low reasoning and risk signals, which is the
 * interactive quick-answer case. Anything stronger optimizes
 * correctness-per-quota, so latency stays out of its score.
 *
 * @param route Signals returned by `classifyRoute`.
 * @param options Resolved plugin configuration, for the routing thresholds.
 * @param context Host-side token, turn, tool and vision estimates.
 * @returns The requirement contract consumed by the router.
 */
export function requirementsFromRoute(
  route: RouteClassification,
  options: ResolvedOptions,
  context: TaskRequirementsInput,
): TaskRequirements {
  const tier = requiredTier(route, options.routing.models.thresholds)

  return {
    tier,
    needsTools: context.needsTools,
    needsVision: context.needsVision,
    needsReasoning: tier !== "economy",
    estimatedInputTokens: context.estimatedInputTokens,
    estimatedOutputTokens: context.estimatedOutputTokens,
    estimatedTurns: context.estimatedTurns,
    maxEffort: effortFor(tier, route.research),
    deepReasoning: route.deepReasoning,
    highRisk: route.highRisk,
    research: route.research,
    complexity: route.complexity,
    prefersSpeed: tier === "economy",
  }
}

function complexityBand(value: string | undefined): "fast" | "normal" | "deep" {
  if (value === "fast" || value === "deep" || value === "normal") return value
  return "normal"
}

function requiredTier(
  route: RouteClassification,
  thresholds: RoutingThresholds,
): CapabilityTier {
  if (needsAdvancedTier(route, thresholds)) return "advanced"
  if (prefersEconomyTier(route, thresholds)) return "economy"
  return "balanced"
}

function needsAdvancedTier(
  route: RouteClassification,
  thresholds: RoutingThresholds,
): boolean {
  return (
    (route.complexity === "deep" && route.complexityProbability >= thresholds.deepChoice) ||
    route.deepReasoning >= thresholds.deepReasoning ||
    route.highRisk >= thresholds.highRisk
  )
}

function prefersEconomyTier(
  route: RouteClassification,
  thresholds: RoutingThresholds,
): boolean {
  return (
    route.complexity === "fast" &&
    route.complexityProbability >= thresholds.fastChoice &&
    route.deepReasoning < thresholds.deepReasoning &&
    route.highRisk < thresholds.highRisk
  )
}

function effortFor(tier: CapabilityTier, research: number): TaskRequirements["maxEffort"] {
  const base = TIER_BASE_EFFORT[tier]
  if (research < RESEARCH_EFFORT_BUMP_AT) return base
  return nextEffort(base)
}

function nextEffort(effort: TaskRequirements["maxEffort"]): TaskRequirements["maxEffort"] {
  const index = EFFORT_ORDER.indexOf(effort)
  if (index < 0) return effort
  return EFFORT_ORDER[Math.min(index + 1, EFFORT_ORDER.length - 1)] ?? effort
}

/**
 * Ask Jev to score a host permission request on the axes the auto-mode policy
 * needs. Metadata is only sent when `privacy.includePermissionMetadata` is on,
 * so secrets never reach the classifier by default.
 *
 * @param jev Client used to reach System One.
 * @param options Resolved plugin configuration.
 * @param input Action name, matched resources, and optional permission metadata.
 * @returns One normalized 0..1 score per permission axis.
 */
export async function classifyPermission(
  jev: JevClient,
  options: ResolvedOptions,
  input: {
    action: string
    resources: readonly string[]
    metadata?: Record<string, unknown>
  },
): Promise<PermissionSignals> {
  const response = await jev.ask(
    {
      action: input.action,
      resources: input.resources.map((item) =>
        truncate(item, options.privacy.maxResourceChars),
      ),
      ...(options.privacy.includePermissionMetadata && input.metadata
        ? {
            metadata: safeJson(
              input.metadata,
              options.privacy.maxStateChars,
            ),
          }
        : {}),
    },
    {
      read_only: {
        type: "noul",
        instructions: "Is this action read-only with no persistent state change?",
      },
      modifies_project: {
        type: "noul",
        instructions: "Can this action modify project files, repository state, dependencies, or generated artifacts?",
      },
      outside_workspace: {
        type: "noul",
        instructions: "Can this action modify files or state outside the current project/workspace?",
      },
      destructive: {
        type: "noul",
        instructions: "Can this action irreversibly delete data, overwrite important state, rewrite history, or cause difficult-to-recover damage?",
      },
      reversible: {
        type: "noul",
        instructions: "If the action changes state, is the change normally straightforward to reverse using local project information?",
      },
      changes_vcs_history: {
        type: "noul",
        instructions: "Can this action create, rewrite, discard, push, or otherwise alter version-control history or refs?",
      },
      executes_downloaded_code: {
        type: "noul",
        instructions: "Can this action download and execute code or pipe remotely retrieved content into an interpreter or shell?",
      },
      external_side_effect: {
        type: "noul",
        instructions: "Can this action create an external side effect such as publishing, deploying, sending, purchasing, mutating a remote service, or contacting third parties with data?",
      },
      sensitive_data: {
        type: "noul",
        instructions: "Can this action expose credentials, secrets, private data, or otherwise sensitive information?",
      },
      privilege_escalation: {
        type: "noul",
        instructions: "Does this action request elevated operating-system, administrator, root, or similarly privileged access?",
      },
    },
  )

  return {
    readOnly: noul(response, "read_only"),
    modifiesProjectFiles: noul(response, "modifies_project"),
    outsideWorkspace: noul(response, "outside_workspace"),
    destructive: noul(response, "destructive"),
    reversible: noul(response, "reversible"),
    changesVcsHistory: noul(response, "changes_vcs_history"),
    executesDownloadedCode: noul(response, "executes_downloaded_code"),
    externalSideEffect: noul(response, "external_side_effect"),
    sensitiveData: noul(response, "sensitive_data"),
    privilegeEscalation: noul(response, "privilege_escalation"),
  }
}
