import type {
  FailureClassification,
  JevQuestion,
  LoopClassification,
  PermissionSignals,
  ResolvedOptions,
  RouteClassification,
  SkillCandidate,
  SkillSelection,
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

export async function classifyFailure(
  jev: JevClient,
  options: ResolvedOptions,
  error: unknown,
  tool?: string,
): Promise<FailureClassification> {
  const response = await jev.ask(
    {
      tool,
      failure: truncate(safeJson(error), options.privacy.maxEvidenceChars),
    },
    {
      kind: {
        type: "choice",
        instructions: "Classify the most likely primary cause of this coding-agent tool failure.",
        criteria: {
          transient: "Temporary network, service, rate limit, lock, or timing problem; retry may work unchanged.",
          environment: "Environment, platform, missing executable, unavailable service, or machine configuration issue.",
          permission: "Authorization, authentication, filesystem permission, policy, or elevated-access issue.",
          invalid_input: "The tool was called with invalid arguments, malformed input, or a bad command.",
          dependency: "A package, module, dependency, or version is missing or incompatible.",
          test_failure: "A test ran successfully but reported an assertion or behavioral failure.",
          code_bug: "The project code itself appears to contain the defect exposed by the tool.",
          tool_bug: "The tool or integration appears broken independently of the project.",
          unknown: "Evidence is insufficient for another class.",
        },
      },
      retry_safe: {
        type: "noul",
        instructions: "Is retrying the same action unchanged likely to be safe and useful?",
      },
      requires_user: {
        type: "noul",
        instructions: "Does resolving this failure likely require user authorization, credentials, a product decision, or information unavailable to the coding agent?",
      },
    },
  )

  const result = choice(response, "kind")
  const kinds = new Set([
    "transient",
    "environment",
    "permission",
    "invalid_input",
    "dependency",
    "test_failure",
    "code_bug",
    "tool_bug",
    "unknown",
  ])
  const kind = result.value && kinds.has(result.value) ? result.value : "unknown"

  return {
    kind: kind as FailureClassification["kind"],
    probability: result.probability,
    retrySafe: noul(response, "retry_safe"),
    requiresUser: noul(response, "requires_user"),
  }
}

export async function classifySkills(
  jev: JevClient,
  options: ResolvedOptions,
  task: string,
  candidates: readonly SkillCandidate[],
): Promise<SkillSelection[]> {
  const bounded: SkillCandidate[] = []
  let used = 0

  for (const candidate of candidates.slice(0, options.skills.maxCandidates)) {
    const item = {
      name: truncate(candidate.name, 160),
      description: truncate(candidate.description, options.privacy.maxResourceChars),
    }
    const cost = item.name.length + item.description.length + 64
    if (bounded.length > 0 && used + cost > options.privacy.maxStateChars) break
    bounded.push(item)
    used += cost
  }

  if (bounded.length === 0) return []

  const questions: Record<string, JevQuestion> = {}
  bounded.forEach((candidate, index) => {
    questions[`skill_${index}`] = {
      type: "noul",
      instructions:
        `Would the skill named "${candidate.name}" materially improve the current task, based only on its description and the task intent?`,
    }
  })

  const response = await jev.ask(
    {
      task: truncate(task, options.privacy.maxPromptChars),
      candidates: bounded,
      instruction:
        "Select only skills that are directly useful. Do not solve the task. Prefer no skill over a weak match.",
    },
    questions,
  )

  return bounded
    .map((candidate, index) => ({
      name: candidate.name,
      probability: noul(response, `skill_${index}`, 0),
    }))
    .filter((item) => item.probability >= options.skills.minimumProbability)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, options.skills.maxSelected)
}

export async function classifyLoopProgress(
  jev: JevClient,
  options: ResolvedOptions,
  input: {
    task: string
    tool: string
    evidence: string
    round: number
    verificationPending: boolean
  },
): Promise<LoopClassification> {
  const response = await jev.ask(
    {
      task: truncate(input.task, options.privacy.maxPromptChars),
      latest_tool: input.tool,
      latest_evidence: truncate(input.evidence, options.privacy.maxEvidenceChars),
      round: input.round,
      verification_pending: input.verificationPending,
      instruction:
        "Choose the next coding-agent control state. Do not solve the task. Be conservative about finish and human.",
    },
    {
      next_state: {
        type: "choice",
        instructions:
          "Choose the next controller state after this successful tool result.",
        criteria: {
          work: "More substantive tool work, investigation, or implementation is still needed.",
          retry: "The latest action should be repeated because the result is incomplete or transient.",
          verify: "Concrete validation should happen before more implementation or completion.",
          finish: "The available evidence is sufficient to answer the user's task without more tool calls.",
          human: "Progress requires user authorization, missing information, or a product decision unavailable to the agent.",
        },
      },
    },
  )

  const result = choice(response, "next_state")
  const allowed = new Set(["work", "retry", "verify", "finish", "human"])
  return {
    decision:
      result.value && allowed.has(result.value)
        ? (result.value as LoopClassification["decision"])
        : "work",
    probability: result.probability,
  }
}
