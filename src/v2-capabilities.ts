import { isCodeModePart, narrowCapabilityCatalog, readCapabilityCatalog } from "./capabilities/catalog.ts"
import type { CapabilityCatalog, CapabilitySelection } from "./capabilities/catalog.ts"
import type { CapabilityCandidate } from "./capabilities/judge.ts"
import type { CapabilitySelector } from "./capabilities/selection.ts"
import type { Trace } from "./trace.ts"

/** A system prompt part as the host sends it; only `text` is read. */
interface SystemTextPart {
  readonly type: "text"
  readonly text: string
}

/** The parts of the host's `session.hook("context")` event the filter rewrites. */
export interface CapabilityContextEvent {
  readonly sessionID: string
  system: SystemTextPart[]
}

/**
 * Narrow the Code Mode system part of one outgoing model request to the
 * skills and namespaces Jev selected for the session's task. The rewrite is
 * request-only: the host rebuilds the part for every call and the persisted
 * history is never touched. Without a task, or when Jev failed for it, the
 * part stays as the host built it.
 *
 * @param selector Session selection backed by Jev.
 * @param event Context hook event; its `system` array is updated in place.
 * @param task The user's request for this turn.
 * @param trace Debug tracer.
 */
export async function narrowRequestCapabilities(
  selector: CapabilitySelector,
  event: CapabilityContextEvent,
  task: string,
  trace: Trace,
): Promise<void> {
  const index = event.system.findIndex((part) => isCodeModePart(part.text))
  const part = event.system[index]
  if (part === undefined) return
  const catalog = readCapabilityCatalog(part.text)
  const candidates = candidatesOf(catalog)
  if (candidates.length === 0) return
  const selected = await selector.selectedFor(event.sessionID, task, candidates)
  if (selected === undefined) {
    trace("v2 capability selection skipped", { sessionID: event.sessionID, reason: "Jev selection failed" })
    return
  }
  const narrowed = narrowCapabilityCatalog(part.text, selectionOf(selected))
  if (narrowed === part.text) return
  event.system[index] = { ...part, text: narrowed }
  trace("v2 capabilities narrowed", {
    sessionID: event.sessionID,
    skills: describedOf(catalog.skills.map((skill) => `skill:${skill.id}`), selected),
    namespaces: describedOf(catalog.namespaces.map((namespace) => `namespace:${namespace.name}`), selected),
    chars: `${part.text.length} -> ${narrowed.length}`,
  })
}

/**
 * Candidate keys for the configured always-included skills and namespaces.
 *
 * @param alwaysInclude Skill IDs and namespace names from the options.
 * @returns Keys in the `skill:<id>` and `namespace:<name>` form.
 */
export function pinnedCapabilityKeys(alwaysInclude: {
  readonly skills: readonly string[]
  readonly namespaces: readonly string[]
}): string[] {
  return [
    ...alwaysInclude.skills.map((id) => `skill:${id}`),
    ...alwaysInclude.namespaces.map((name) => `namespace:${name}`),
  ]
}

function candidatesOf(catalog: CapabilityCatalog): CapabilityCandidate[] {
  return [
    ...catalog.skills.map((skill) => ({
      key: `skill:${skill.id}`,
      kind: "skill" as const,
      name: skill.id,
      summary: skill.description,
    })),
    ...catalog.namespaces.map((namespace) => ({
      key: `namespace:${namespace.name}`,
      kind: "namespace" as const,
      name: namespace.name,
      summary: namespace.block,
    })),
  ]
}

function selectionOf(selected: ReadonlySet<string>): CapabilitySelection {
  return {
    skills: namesWithPrefix(selected, "skill:"),
    namespaces: namesWithPrefix(selected, "namespace:"),
  }
}

function namesWithPrefix(keys: ReadonlySet<string>, prefix: string): Set<string> {
  return new Set([...keys].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)))
}

function describedOf(keys: readonly string[], selected: ReadonlySet<string>): string {
  const kept = keys.filter((key) => selected.has(key)).map((key) => key.slice(key.indexOf(":") + 1))
  return `${kept.length}/${keys.length}${kept.length > 0 ? ` (${kept.join(", ")})` : ""}`
}
