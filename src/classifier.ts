import type {
  JevQuestion,
  PermissionSignals,
  ResolvedOptions,
  RouteClassification,
} from "./types.ts"
import { choice, JevClient, noul } from "./jev.ts"
import { safeJson, truncate } from "./config.ts"

export async function classifyRoute(
  jev: JevClient,
  options: ResolvedOptions,
  prompt: string,
): Promise<RouteClassification> {
  const domains = new Set<string>(Object.keys(options.agents.byDomain))

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
  const selected =
    complexity.value === "fast" || complexity.value === "deep" || complexity.value === "normal"
      ? complexity.value
      : options.router.fallbackTier

  return {
    complexity: selected,
    complexityProbability: complexity.probability,
    deepReasoning: noul(response, "deep_reasoning"),
    highRisk: noul(response, "high_risk"),
    research: noul(response, "research"),
    ...(domain.value && domain.value !== "general"
      ? { domain: domain.value, domainProbability: domain.probability }
      : {}),
  }
}
export function chooseTier(
  route: RouteClassification,
  options: ResolvedOptions,
): "fast" | "normal" | "deep" {
  const t = options.router.thresholds

  if (
    (route.complexity === "deep" &&
      route.complexityProbability >= t.deepChoice) ||
    route.deepReasoning >= t.deepReasoning ||
    route.highRisk >= t.highRisk
  ) {
    return "deep"
  }

  if (
    route.complexity === "fast" &&
    route.complexityProbability >= t.fastChoice &&
    route.deepReasoning < t.deepReasoning &&
    route.highRisk < t.highRisk
  ) {
    return "fast"
  }

  return "normal"
}

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
