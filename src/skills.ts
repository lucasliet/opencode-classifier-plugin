import type { SkillCandidate } from "./types.ts"

const SKILL_GUIDANCE_PREFIX =
  "Skills provide specialized instructions and workflows for specific tasks."

export function extractNativeSkillCatalog(system: readonly string[]): SkillCandidate[] {
  const out: SkillCandidate[] = []
  const seen = new Set<string>()

  for (const entry of system) {
    if (!entry.includes("<available_skills>")) continue

    const skillPattern = /<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>[\s\S]*?<\/skill>/g
    for (const match of entry.matchAll(skillPattern)) {
      const name = decodeXml(match[1] ?? "").trim()
      const description = decodeXml(match[2] ?? "").trim()
      if (!name || !description || seen.has(name)) continue
      seen.add(name)
      out.push({ name, description })
    }
  }

  return out
}

export function stripNativeSkillCatalog(system: string[]): void {
  for (let index = system.length - 1; index >= 0; index -= 1) {
    const entry = system[index] ?? ""
    if (
      entry.startsWith(SKILL_GUIDANCE_PREFIX) ||
      entry.includes("<available_skills>")
    ) {
      system.splice(index, 1)
    }
  }
}

export function sanitizeSkillToolDefinition(output: {
  description: string
  parameters: any
  jsonSchema?: any
}): void {
  output.description =
    "Load a specialized skill by exact name only when the classifier/system instruction explicitly selects that skill for the current task. Do not enumerate, infer, or guess skill names."

  sanitizeNameProperty(output.parameters)
  sanitizeNameProperty(output.jsonSchema)
}

function sanitizeNameProperty(schema: unknown): void {
  if (!schema || typeof schema !== "object") return
  const properties = (schema as Record<string, unknown>).properties
  if (!properties || typeof properties !== "object") return

  const name = (properties as Record<string, unknown>).name
  if (!name || typeof name !== "object") return

  ;(name as Record<string, unknown>).description =
    "Exact skill name selected by the classifier for the current task."
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
}
