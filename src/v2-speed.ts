import type { SpeedTracker } from "./routing/speed.ts"

/** Unfinished steps kept at once; older ones are dropped first. */
const MAX_PENDING_STEPS = 256

/** Storage key under which measured speed is persisted. */
export const SPEED_STORAGE_KEY = "routing.speed"

interface PendingStep {
  readonly ref: string
  readonly startedAt: number
}

/**
 * Measure model throughput from `session.step.started` / `session.step.ended`
 * event pairs, matched by assistant message ID. Both ends use the event
 * envelope's `created` time so the duration comes from one clock.
 *
 * @param speed Tracker that receives each finished step.
 * @param onSample Called after a sample is kept, so the caller can persist.
 * @returns An event listener; events of any other type are ignored.
 */
export function createStepSpeedObserver(
  speed: SpeedTracker,
  onSample: () => void,
): (event: unknown) => void {
  const pending = new Map<string, PendingStep>()
  return (event) => {
    const record = asRecord(event)
    const data = asRecord(record?.data)
    const messageID = readText(data?.assistantMessageID)
    if (record === undefined || data === undefined || messageID === undefined) return
    if (record.type === "session.step.started") {
      rememberStep(pending, messageID, data, readTime(record.created))
      return
    }
    if (record.type !== "session.step.ended") return
    const step = pending.get(messageID)
    pending.delete(messageID)
    const endedAt = readTime(record.created)
    if (step === undefined || endedAt === undefined || data.finish === "error") return
    if (speed.record(step.ref, generatedTokens(data), endedAt - step.startedAt)) onSample()
  }
}

function rememberStep(
  pending: Map<string, PendingStep>,
  messageID: string,
  data: Record<string, unknown>,
  created: number | undefined,
): void {
  const model = asRecord(data.model)
  const providerID = readText(model?.providerID)
  const modelID = readText(model?.id)
  if (providerID === undefined || modelID === undefined || created === undefined) return
  pending.set(messageID, { ref: `${providerID}/${modelID}`, startedAt: created })
  while (pending.size > MAX_PENDING_STEPS) {
    const oldest = pending.keys().next().value
    if (oldest === undefined) break
    pending.delete(oldest)
  }
}

function generatedTokens(data: Record<string, unknown>): number {
  const tokens = asRecord(data.tokens)
  return readCount(tokens?.output) + readCount(tokens?.reasoning)
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

function readTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
