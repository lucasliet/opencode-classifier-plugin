import type { PermissionSignals, ResolvedOptions } from "./types.ts"

export interface PermissionDecision {
  effect: "allow" | "ask" | "deny"
  reason: string
}

export function decidePermission(
  current: "allow" | "ask" | "deny",
  signals: PermissionSignals,
  options: ResolvedOptions,
): PermissionDecision {
  if (current === "deny") {
    return { effect: "deny", reason: "OpenCode configuration denied this action." }
  }

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
      effect: "deny",
      reason: `Jev classified this action as high-risk (risk=${risk.toFixed(3)}).`,
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
