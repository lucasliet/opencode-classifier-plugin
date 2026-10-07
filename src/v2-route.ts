import type { Plugin } from "@opencode/plugin"
import type { CandidateSources } from "./routing/assemble.ts"
import type {
  CapabilityTier,
  QuotaLedger,
  RoutingDecision,
  TaskRequirements,
} from "./routing/contracts.ts"
import { TIER_ORDER } from "./routing/contracts.ts"
import { explainDecision, selectModel } from "./routing/select.ts"
import type { RoutingInput, SelectOptionOverrides } from "./routing/select.ts"
import type { Trace } from "./trace.ts"
import type { ModelRef } from "./types.ts"
import { discoverRoutableModels } from "./v2-discovery.ts"

type V2Context = Plugin.Context

/** Everything one routing decision reads. */
export interface RouteRequest {
  readonly ctx: V2Context
  readonly sources: CandidateSources
  readonly ledger: QuotaLedger
  readonly requirements: TaskRequirements
  readonly overrides: SelectOptionOverrides
  readonly trace: Trace
}

/** A model to switch to, or why there is none. */
export type RouteOutcome =
  | {
      readonly kind: "routed"
      readonly target: ModelRef
      readonly decision: RoutingDecision
      readonly directive: string
      readonly relaxedNote: string | undefined
    }
  | {
      readonly kind: "unroutable"
      readonly directive: string
      readonly details: Record<string, unknown>
    }

/** A retry that succeeded after dropping the quality floor one band. */
interface RelaxedSelection {
  readonly decision: RoutingDecision
  readonly from: CapabilityTier
  readonly to: CapabilityTier
}

/**
 * Discover candidates and pick one, relaxing the quality floor one band
 * before giving up. Quota gates and the subscription-only rule never relax.
 *
 * @param request Context, candidate sources, ledger and task requirements.
 * @returns The target model with its user-facing directive, or the reason
 *   nothing could take the task.
 */
export async function routeTask(request: RouteRequest): Promise<RouteOutcome> {
  const discovery = await discoverRoutableModels(request.ctx, request.sources, request.trace)
  if (discovery.models.length === 0) {
    return {
      kind: "unroutable",
      directive: noSubscriptionDirective(discovery.exclusions, discovery.error),
      details: { error: discovery.error, exclusions: discovery.exclusions },
    }
  }
  const input: RoutingInput = {
    requirements: request.requirements,
    models: discovery.models,
    ledger: request.ledger,
  }
  const required = selectModel(input, request.overrides)
  const relaxed = required.selected === undefined ? selectWithRelaxedFloor(input, request.overrides) : undefined
  const decision = relaxed?.decision ?? required
  const selected = decision.selected
  if (selected === undefined) {
    return {
      kind: "unroutable",
      directive: `Auto (Jev) could not route this task; select a model manually. ${required.reason}`,
      details: { reason: required.reason, considered: required.considered, excluded: discovery.exclusions },
    }
  }
  const relaxedNote =
    relaxed === undefined
      ? undefined
      : `Quality floor relaxed from ${relaxed.from} to ${relaxed.to} after ${relaxed.from} rejected everything: ${required.reason}.`
  return {
    kind: "routed",
    target: {
      providerID: selected.catalog.providerID,
      id: selected.catalog.modelID,
      ...(decision.variant !== undefined && decision.variant !== "" ? { variant: decision.variant } : {}),
    },
    decision,
    directive: `${relaxedNote === undefined ? "" : `${relaxedNote} `}${explainDecision(decision)}`,
    relaxedNote,
  }
}

/** One step down the quality ladder; `economy` has nothing below it. */
function relaxedTierOf(tier: CapabilityTier): CapabilityTier | undefined {
  const rank = TIER_ORDER.indexOf(tier)
  if (rank <= 0) return undefined
  return TIER_ORDER[rank - 1]
}

/**
 * Second and last selection pass: the same requirements with the quality floor
 * one band lower. Quota gates are untouched — a relaxed floor never licenses
 * an exhausted pool — and the retry is discarded when it still finds nothing,
 * so the reported reason stays the one from the required floor.
 */
function selectWithRelaxedFloor(
  input: RoutingInput,
  overrides: SelectOptionOverrides,
): RelaxedSelection | undefined {
  const to = relaxedTierOf(input.requirements.tier)
  if (to === undefined) return undefined
  const requirements: TaskRequirements = {
    ...input.requirements,
    tier: to,
    needsReasoning: to !== "economy",
  }
  const decision = selectModel({ ...input, requirements }, overrides)
  if (decision.selected === undefined) return undefined
  return { decision, from: input.requirements.tier, to }
}

function noSubscriptionDirective(
  exclusions: readonly string[],
  error: string | undefined,
): string {
  const parts = ["Auto (Jev) found no subscription models to route to; select a model manually."]
  if (error !== undefined) parts.push(`Model discovery failed: ${error}`)
  if (exclusions.length > 0) parts.push(exclusions.join("; "))
  return parts.join(" ")
}
