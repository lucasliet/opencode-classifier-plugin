import type { PermissionSignals, ResolvedOptions } from "./types.ts"

export interface PermissionDecision {
  effect: "allow" | "ask" | "deny"
  reason: string
}

export interface PermissionRequest {
  action: string
  resources: readonly string[]
}

/**
 * Selects the permission outcome from deterministic command boundaries and Jev risk signals.
 *
 * @param current - The decision already supplied by the OpenCode host.
 * @param signals - The risk signals classified by Jev.
 * @param options - The resolved plugin configuration.
 * @param request - The action and resources under review.
 * @returns The resulting permission decision.
 */
export function decidePermission(
  current: "allow" | "ask" | "deny",
  signals: PermissionSignals,
  options: ResolvedOptions,
  request?: PermissionRequest,
): PermissionDecision {
  if (current === "deny") {
    return { effect: "deny", reason: "OpenCode configuration denied this action." }
  }

  const commandDecision = request ? decideCommandBoundary(request, options) : undefined
  if (commandDecision) return commandDecision

  const risk = Math.max(
    signals.outsideWorkspace,
    signals.destructive,
    signals.changesVcsHistory,
    signals.executesDownloadedCode,
    signals.externalSideEffect,
    signals.sensitiveData,
    signals.privilegeEscalation,
  )

  if (options.autoMode.denyHighRisk && risk >= options.autoMode.thresholds.deny) {
    return {
      effect: "ask",
      reason: `Jev classified this action as high-risk and requires human approval (risk=${risk.toFixed(3)}).`,
    }
  }

  if (
    signals.outsideWorkspace >= options.autoMode.thresholds.riskAsk ||
    signals.destructive >= options.autoMode.thresholds.riskAsk ||
    signals.changesVcsHistory >= options.autoMode.thresholds.riskAsk ||
    signals.executesDownloadedCode >= options.autoMode.thresholds.riskAsk ||
    signals.externalSideEffect >= options.autoMode.thresholds.riskAsk ||
    signals.sensitiveData >= options.autoMode.thresholds.riskAsk ||
    signals.privilegeEscalation >= options.autoMode.thresholds.riskAsk
  ) {
    return {
      effect: "ask",
      reason:
        "Jev detected elevated risk: destructive/outside-workspace/VCS/downloaded-code/external/sensitive/privileged behavior.",
    }
  }

  if (
    signals.readOnly >= options.autoMode.thresholds.autoAllow &&
    signals.modifiesProjectFiles < options.autoMode.thresholds.riskAsk &&
    signals.outsideWorkspace < options.autoMode.thresholds.riskAsk &&
    signals.destructive < options.autoMode.thresholds.riskAsk &&
    signals.changesVcsHistory < options.autoMode.thresholds.riskAsk &&
    signals.executesDownloadedCode < options.autoMode.thresholds.riskAsk &&
    signals.externalSideEffect < options.autoMode.thresholds.riskAsk &&
    signals.sensitiveData < options.autoMode.thresholds.riskAsk &&
    signals.privilegeEscalation < options.autoMode.thresholds.riskAsk
  ) {
    return {
      effect: "allow",
      reason: "Jev classified this operation as read-only and low-risk.",
    }
  }

  if (
    options.autoMode.allowReversibleProjectChanges &&
    signals.modifiesProjectFiles >= options.autoMode.thresholds.projectChange &&
    signals.reversible >= options.autoMode.thresholds.reversibleAllow &&
    signals.outsideWorkspace < options.autoMode.thresholds.riskAsk &&
    signals.destructive < options.autoMode.thresholds.riskAsk &&
    signals.changesVcsHistory < options.autoMode.thresholds.riskAsk &&
    signals.executesDownloadedCode < options.autoMode.thresholds.riskAsk &&
    signals.externalSideEffect < options.autoMode.thresholds.riskAsk &&
    signals.sensitiveData < options.autoMode.thresholds.riskAsk &&
    signals.privilegeEscalation < options.autoMode.thresholds.riskAsk
  ) {
    return {
      effect: "allow",
      reason: "Jev classified this as a reversible, low-risk project-local change.",
    }
  }

  return {
    effect: "ask",
    reason: "Jev confidence was insufficient for automatic approval.",
  }
}

/**
 * Applies command rules that must run before probabilistic classification.
 *
 * @param request - The action and resources under review.
 * @param options - The resolved plugin configuration.
 * @returns A deterministic decision when a boundary matches, otherwise undefined.
 */
function decideCommandBoundary(
  request: PermissionRequest,
  options: ResolvedOptions,
): PermissionDecision | undefined {
  if (!isShellAction(request.action)) return undefined

  if (request.resources.some(isCriticalDestruction)) {
    return {
      effect: "deny",
      reason: "Auto Mode blocked a command that can destroy a critical system path.",
    }
  }

  if (matchesCommandRules(request.resources, options.autoMode.commandRules.deny)) {
    return {
      effect: "deny",
      reason: "Auto Mode command deny rule matched this action.",
    }
  }

  if (matchesCommandRules(request.resources, options.autoMode.commandRules.ask)) {
    return {
      effect: "ask",
      reason: "Auto Mode command ask rule matched this action.",
    }
  }

  return undefined
}

/**
 * Determines whether an action invokes a shell-like tool.
 *
 * @param action - The OpenCode permission action.
 * @returns Whether the action can execute a command.
 */
function isShellAction(action: string): boolean {
  return /^(bash|shell|exec|command|powershell)$/i.test(action.trim())
}

/**
 * Detects commands that target critical filesystem or system resources.
 *
 * @param command - The shell command under review.
 * @returns Whether the command is always denied in Auto Mode.
 */
function isCriticalDestruction(command: string): boolean {
  const normalized = command.trim()
  return /(?:^|[;&|]\s*)(?:rm|rmdir)\s+(?:-[a-z]*\s+)*(?:\/|~)(?:\s|$)/i.test(
    normalized,
  ) || /(?:^|[;&|]\s*)(?:mkfs(?:\.[a-z0-9]+)?|shutdown|reboot|poweroff)\b/i.test(
    normalized,
  ) || /\bdd\b[^\n]*\bof=\/dev\//i.test(normalized)
}

/**
 * Matches full commands against exact patterns or trailing-wildcard prefixes.
 *
 * @param commands - The commands requested by the host.
 * @param patterns - The configured command rules.
 * @returns Whether at least one command matches a rule.
 */
function matchesCommandRules(commands: readonly string[], patterns: readonly string[]): boolean {
  return commands.some((command) =>
    patterns.some((pattern) => matchesCommandRule(command, pattern)),
  )
}

/**
 * Matches one command against an exact pattern or a trailing wildcard prefix.
 *
 * @param command - The command requested by the host.
 * @param pattern - The configured command rule.
 * @returns Whether the command matches the rule.
 */
function matchesCommandRule(command: string, pattern: string): boolean {
  const normalizedCommand = command.trim()
  const normalizedPattern = pattern.trim()
  if (!normalizedCommand || !normalizedPattern) return false
  if (!normalizedPattern.endsWith("*")) return normalizedCommand === normalizedPattern

  const prefix = normalizedPattern.slice(0, -1).trimEnd()
  return normalizedCommand === prefix || normalizedCommand.startsWith(`${prefix} `)
}
