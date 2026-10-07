import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { safeJson } from "./config.ts"

export type Trace = (message: string, details: Record<string, unknown>) => void

/** Where trace lines go, if anywhere. */
export interface TraceOptions {
  readonly debug: boolean
  /** Explicit log file from the config; empty when unset. */
  readonly logFile: string
}

/** Environment variable that redirects the trace file without a config change. */
export const TRACE_LOG_ENV = "OPENCODE_CLASSIFIER_LOG"

/**
 * Default trace file under the user's state directory, private to the user
 * unlike a shared temporary directory.
 *
 * @param env Environment to read `XDG_STATE_HOME` from.
 * @returns Absolute path of `opencode/opencode-classifier-plugin.log`.
 */
export function defaultTracePath(env: NodeJS.ProcessEnv = process.env): string {
  const stateHome = env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state")
  return join(stateHome, "opencode", "opencode-classifier-plugin.log")
}

/**
 * Resolve the trace file: the configured `logFile`, then the
 * `OPENCODE_CLASSIFIER_LOG` environment variable, then the default path when
 * `debug` is on. Nothing is written otherwise.
 *
 * @param options Debug flag and configured log file.
 * @param env Environment, read on every call so tests can redirect it.
 * @returns The file to append to, or undefined when tracing is off.
 */
export function tracePathOf(options: TraceOptions, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (options.logFile !== "") return options.logFile
  const fromEnv = env[TRACE_LOG_ENV]?.trim()
  if (fromEnv) return fromEnv
  return options.debug ? defaultTracePath(env) : undefined
}

/**
 * File-first tracing. Server/TUI stderr is interleaved into the interface
 * and cannot be read comfortably mid-session, so trace lines append to a log
 * file when one is enabled. Console output stays gated behind debug.
 *
 * @param options - Debug flag and configured log file.
 * @returns A trace function that never throws.
 */
export function createTracer(options: TraceOptions): Trace {
  const preparedDirectories = new Set<string>()
  return (message, details) => {
    const line = `${new Date().toISOString()} ${message} ${safeJson(details, 1_000)}\n`
    const path = tracePathOf(options)
    if (path !== undefined) appendTraceLine(path, line, preparedDirectories)
    if (!options.debug) return
    console.error(`[opencode-classifier-plugin] ${message} ${safeJson(details, 1_000)}`)
  }
}

function appendTraceLine(path: string, line: string, preparedDirectories: Set<string>): void {
  try {
    const directory = dirname(path)
    if (!preparedDirectories.has(directory)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      preparedDirectories.add(directory)
    }
    appendFileSync(path, line, { mode: 0o600 })
  } catch {
    // Logging must never break the plugin.
  }
}
