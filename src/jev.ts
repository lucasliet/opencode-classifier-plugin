import type { JevQuestion, JevResponse, ResolvedOptions } from "./types.ts"
import { truncate } from "./config.ts"

export class JevClient {
  constructor(private readonly options: ResolvedOptions) {}

  async ask(state: unknown, questions: Record<string, JevQuestion>): Promise<JevResponse> {
    const token = this.resolveToken()
    let lastError: unknown

    for (let attempt = 0; attempt <= this.options.decision.retries; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.options.decision.timeoutMs)

      try {
        const response = await fetch(this.options.decision.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            model: this.options.decision.model,
            state,
            questions,
          }),
          signal: controller.signal,
        })

        if (!response.ok) {
          const body = truncate(await response.text(), 1_500)
          throw new SystemOneHttpError(
            response.status,
            `System One request failed with HTTP ${response.status}: ${body || response.statusText}`,
          )
        }

        return normalizeResponse(await response.json(), questions)
      } catch (error) {
        lastError = error
        if (
          attempt >= this.options.decision.retries ||
          !isRetryableSystemOneError(error)
        ) {
          throw error
        }
        await sleep(Math.min(500, 100 * 2 ** attempt))
      } finally {
        clearTimeout(timer)
      }
    }

    throw lastError
  }

  private resolveToken(): string | undefined {
    if (this.options.decision.apiKey) return this.options.decision.apiKey

    const envName = this.options.decision.apiKeyEnv
    const envToken = process.env[envName]
    if (envToken) return envToken

    if (this.options.decision.requireAuth) {
      throw new Error(
        `opencode-classifier-plugin: no credential available for Jev. OpenCode 1.18 does not expose connected provider secrets to plugins; set ${envName} or decision.apiKey.`,
      )
    }

    return undefined
  }
}

function normalizeResponse(
  value: unknown,
  questions: Record<string, JevQuestion>,
): JevResponse {
  if (!value || typeof value !== "object") {
    throw new Error("opencode-classifier-plugin: malformed System One response.")
  }

  const record = value as Record<string, unknown>
  if (!record.answers || typeof record.answers !== "object" || Array.isArray(record.answers)) {
    throw new Error("opencode-classifier-plugin: System One response is missing answers.")
  }

  const answers = record.answers as Record<string, unknown>
  for (const key of Object.keys(questions)) {
    if (!answers[key] || typeof answers[key] !== "object") {
      throw new Error(
        `opencode-classifier-plugin: System One response is missing answer "${key}".`,
      )
    }
  }

  return value as JevResponse
}

export function noul(response: JevResponse, key: string, fallback = 0.5): number {
  const answer = response.answers[key]
  return answer?.type === "noul" && Number.isFinite(answer.noul)
    ? clamp(answer.noul)
    : fallback
}

export function choice(
  response: JevResponse,
  key: string,
): { value?: string; probability: number; probabilities: Record<string, number> } {
  const answer = response.answers[key]
  if (!answer || answer.type !== "choice") {
    return { probability: 0, probabilities: {} }
  }

  const probabilities = answer.probabilities ?? {}
  const probability = clamp(probabilities[answer.choice] ?? answer.confidence ?? 0)
  return {
    value: answer.choice,
    probability,
    probabilities,
  }
}

export function score(response: JevResponse, key: string, fallback = 0): number {
  const answer = response.answers[key]
  return answer?.type === "score" && Number.isFinite(answer.score)
    ? answer.score
    : fallback
}

export function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

class SystemOneHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "SystemOneHttpError"
  }
}

function isRetryableSystemOneError(error: unknown): boolean {
  if (error instanceof SystemOneHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500
  }
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === "AbortError")
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
