import { appendFileSync } from "node:fs"
import { safeJson } from "./config.ts"

export type Trace = (message: string, details: Record<string, unknown>) => void

/**
 * File-first tracing. Server/TUI stderr is interleaved into the interface
 * and cannot be read comfortably mid-session, so trace lines always append
 * to a log file. Console output stays gated behind debug.
 *
 * @param debug - Whether to also mirror trace lines to stderr.
 * @returns A trace function that never throws.
 */
export function createTracer(debug: boolean): Trace {
  return (message, details) => {
    try {
      appendFileSync(
        process.env.OPENCODE_CLASSIFIER_LOG ??
          "/tmp/opencode-classifier-plugin.log",
        `${new Date().toISOString()} ${message} ${safeJson(details, 1_000)}\n`,
      )
    } catch {
      // Logging must never break the plugin.
    }
    if (!debug) return
    console.error(`[opencode-classifier-plugin] ${message} ${safeJson(details, 1_000)}`)
  }
}
