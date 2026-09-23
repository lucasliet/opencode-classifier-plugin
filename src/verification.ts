import type { ResolvedOptions } from "./types.ts"
import type { JevClient } from "./jev.ts"
import { noul } from "./jev.ts"
import { truncate } from "./config.ts"

export interface VerificationResult {
  sufficient: number
  failuresPresent: number
  behaviorExercised: number
}

export async function verifyEvidence(
  jev: JevClient,
  options: ResolvedOptions,
  task: string,
  evidence: string,
): Promise<VerificationResult> {
  const response = await jev.ask(
    {
      task: truncate(task, options.privacy.maxPromptChars),
      evidence: truncate(evidence, options.privacy.maxEvidenceChars),
    },
    {
      sufficient: {
        type: "noul",
        instructions:
          "Does this evidence provide strong enough validation that the recent implementation work satisfies the requested task?",
      },
      failures_present: {
        type: "noul",
        instructions:
          "Does the evidence contain a failing test, type error, lint error, build failure, runtime error, or another unresolved validation failure?",
      },
      behavior_exercised: {
        type: "noul",
        instructions:
          "Does the evidence actually exercise or validate the behavior or code path that was changed, rather than merely showing an unrelated command succeeded?",
      },
    },
  )

  return {
    sufficient: noul(response, "sufficient"),
    failuresPresent: noul(response, "failures_present"),
    behaviorExercised: noul(response, "behavior_exercised"),
  }
}
