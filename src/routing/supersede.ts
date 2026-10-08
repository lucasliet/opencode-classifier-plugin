/**
 * Superseded models: an older release of a model line is never routed while a
 * newer release of the same line is available, from any provider.
 *
 * The old model stays routable when its successor is missing, so a catalog
 * that only carries `glm-5.2` still has a GLM to route to.
 */

import type { RoutableModel } from "./contracts.ts"
import { canonicalModelID } from "./model-id.ts"

/** Older canonical model ID → the next release of the same line. */
export const SUPERSEDED_BY: Readonly<Record<string, string>> = {
  "claude-opus-4-5": "claude-opus-4-6",
  "claude-opus-4-6": "claude-opus-4-7",
  "claude-opus-4-7": "claude-opus-4-8",
  "claude-opus-4-8": "claude-opus-5",
  "claude-opus-5": "claude-opus-5-5",
  "claude-sonnet-4-5": "claude-sonnet-4-6",
  "claude-sonnet-4-6": "claude-sonnet-5",
  "claude-sonnet-5": "claude-sonnet-5-5",
  "claude-haiku-4-5": "claude-haiku-5-5",
  "claude-fable-5": "claude-fable-5-1",
  "gpt-5.5": "gpt-5.6-sol",
  "gpt-5.5-fast": "gpt-5.6-sol-fast",
  "gpt-5.6-sol": "gpt-6-sol",
  "gpt-5.6-sol-fast": "gpt-6-sol-fast",
  "gpt-6-sol": "gpt-6.1-sol",
  "gpt-6-sol-fast": "gpt-6.1-sol-fast",
  "gpt-5.6-luna": "gpt-6-luna",
  "gpt-5.6-luna-fast": "gpt-6-luna-fast",
  "gemini-2.5-flash": "gemini-3-flash-preview",
  "gemini-3-flash-preview": "gemini-3.5-flash",
  "gemini-3.5-flash": "gemini-3.6-flash",
  "gemini-3.6-flash": "gemini-3.7-flash",
  "gemini-3.7-flash": "gemini-3.8-flash",
  "gemini-2.5-flash-lite": "gemini-3.1-flash-lite",
  "gemini-3.1-flash-lite": "gemini-3.5-flash-lite",
  "gemini-2.5-pro": "gemini-3.1-pro-preview",
  "gemini-2.5-flash-image": "gemini-3.1-flash-image",
  "grok-4.20-0309-reasoning": "grok-4.3",
  "grok-4.20-0309-non-reasoning": "grok-4.3",
  "grok-4.20-reasoning": "grok-4.3",
  "grok-4.20-non-reasoning": "grok-4.3",
  "grok-4.3": "grok-4.5",
  "grok-4.5": "grok-4.6",
  "grok-4.6": "grok-4.7",
  "glm-5.2": "glm-5.3",
  "kimi-k2.7-code": "kimi-k3",
  "deepseek-v4-flash": "deepseek-v4.1-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-v4.1-flash",
  "mimo-v2.5": "mimo-v2.6-flash",
  "mimo-v2.5-pro": "mimo-v2.6-pro",
  "minimax-m2.7": "minimax-m3",
  "muse-spark-1.2-contributor": "muse-spark-1.3-contributor",
  "qwen3.7-plus": "qwen3.8-flash",
}

/**
 * Drop every candidate whose model line has a newer release among the
 * candidates.
 *
 * @param models Routable candidates from every provider.
 * @returns The candidates that are the newest available release of their line.
 */
export function dropSuperseded(models: readonly RoutableModel[]): RoutableModel[] {
  const available = new Set(models.map((model) => canonicalModelID(model.catalog.modelID)))
  return models.filter((model) => !hasAvailableSuccessor(canonicalModelID(model.catalog.modelID), available))
}

function hasAvailableSuccessor(modelID: string, available: ReadonlySet<string>): boolean {
  const visited = new Set<string>([modelID])
  let successor = SUPERSEDED_BY[modelID]
  while (successor !== undefined && !visited.has(successor)) {
    if (available.has(successor)) return true
    visited.add(successor)
    successor = SUPERSEDED_BY[successor]
  }
  return false
}
