/**
 * Measured model speed.
 *
 * Every finished step reports how many tokens a model produced and how long
 * it took. The tracker keeps an exponentially weighted throughput per model
 * and turns it into the 0..1 `speed` score the selector reads, blending in the
 * name-based prior until enough samples exist. State is a plain JSON object so
 * the host can persist it between sessions.
 */

/** Weight of the newest sample in the moving average. */
const SMOOTHING = 0.3
/** Samples needed before the measurement fully replaces the prior. */
const TRUSTED_SAMPLES = 5
/** Steps shorter than this are dominated by latency, not throughput. */
const MIN_TOKENS_PER_SAMPLE = 64
/** Throughput, tokens per second, that maps to speed 0. */
const SLOWEST_TPS = 10
/** Throughput, tokens per second, that maps to speed 1. */
const FASTEST_TPS = 200

/** Moving throughput for one model. */
export interface SpeedRecord {
  readonly tokensPerSecond: number
  readonly samples: number
}

/**
 * Persistable tracker state, keyed by `"<providerID>/<modelID>"`. Mutable
 * plain objects so it is assignable to the host's JSON storage type.
 */
export type SpeedState = Record<string, { tokensPerSecond: number; samples: number }>

/** Records step throughput and scores models by it. */
export interface SpeedTracker {
  /**
   * Add one finished step.
   *
   * @returns True when the sample was kept, so callers know to persist.
   */
  record(ref: string, outputTokens: number, durationMs: number): boolean
  /** Speed 0..1 for a model, blending `prior` until samples are trusted. */
  score(ref: string, prior: number): number
  state(): SpeedState
}

/**
 * Create a tracker, optionally restoring persisted state.
 *
 * @param initial State saved by a previous session; invalid rows are dropped.
 * @returns A tracker that never throws on bad input.
 */
export function createSpeedTracker(initial: unknown = {}): SpeedTracker {
  const records = new Map<string, SpeedRecord>(restore(initial))
  return {
    record(ref, outputTokens, durationMs) {
      if (!(outputTokens >= MIN_TOKENS_PER_SAMPLE) || !(durationMs > 0)) return false
      const sample = outputTokens / (durationMs / 1000)
      const current = records.get(ref)
      records.set(ref, {
        tokensPerSecond:
          current === undefined ? sample : current.tokensPerSecond + SMOOTHING * (sample - current.tokensPerSecond),
        samples: (current?.samples ?? 0) + 1,
      })
      return true
    },
    score(ref, prior) {
      const current = records.get(ref)
      if (current === undefined) return prior
      const trust = Math.min(1, current.samples / TRUSTED_SAMPLES)
      return prior + trust * (speedOf(current.tokensPerSecond) - prior)
    },
    state() {
      const state: SpeedState = {}
      for (const [ref, record] of records) {
        state[ref] = { tokensPerSecond: record.tokensPerSecond, samples: record.samples }
      }
      return state
    },
  }
}

function speedOf(tokensPerSecond: number): number {
  const scaled = Math.log(tokensPerSecond / SLOWEST_TPS) / Math.log(FASTEST_TPS / SLOWEST_TPS)
  return Math.min(1, Math.max(0, scaled))
}

function restore(value: unknown): [string, SpeedRecord][] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return []
  const rows: [string, SpeedRecord][] = []
  for (const [ref, raw] of Object.entries(value)) {
    const record = raw as Partial<SpeedRecord> | null
    const tps = record?.tokensPerSecond
    const samples = record?.samples
    if (typeof tps === "number" && tps > 0 && Number.isFinite(tps) && typeof samples === "number" && samples > 0) {
      rows.push([ref, { tokensPerSecond: tps, samples: Math.floor(samples) }])
    }
  }
  return rows
}
