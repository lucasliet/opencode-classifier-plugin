/**
 * Reads and narrows the Code Mode system part the OpenCode V2 host sends with
 * every model request. That part lists every MCP and plugin tool namespace
 * (called through `execute`) and every skill (`<available_skills>`), which is
 * most of the per-request instruction tokens.
 *
 * Narrowing keeps hidden capabilities reachable: a hidden namespace is left
 * out entirely and the catalog switches to the host's own "partial" wording,
 * which tells the model to find tools with `search(...)` inside `execute`; a
 * hidden skill keeps its ID in a single line the skill tool still accepts.
 */

/** One MCP or plugin tool namespace from the Code Mode catalog. */
export interface CodeModeNamespace {
  readonly name: string
  readonly count: number
  readonly description: string | undefined
  /** Header line plus every tool listing under it, verbatim. */
  readonly block: string
}

/** One entry of `<available_skills>`. */
export interface SkillListing {
  readonly id: string
  readonly description: string
  /** The `<skill>` element verbatim, including its trailing newline. */
  readonly block: string
}

/** What the Code Mode part offers the model. */
export interface CapabilityCatalog {
  readonly namespaces: readonly CodeModeNamespace[]
  readonly skills: readonly SkillListing[]
}

/** Skill IDs and namespace names to keep fully described. */
export interface CapabilitySelection {
  readonly skills: ReadonlySet<string>
  readonly namespaces: ReadonlySet<string>
}

const CODE_MODE_HEADING = "# Code Mode"
const TOOLS_HEADING = "## Available tools\n\n"
const SKILLS_OPEN = "<available_skills>\n"
const SKILLS_CLOSE = "</available_skills>"
const NO_NAMESPACES_LISTED = "No tool namespaces are listed for this task."
const NAMESPACE_HEADER = /^- (\S+) \((\d+) tools?(?:, [^)]*)?\)(?: \/\/ (.*))?$/
const SKILL_BLOCK = /  <skill>\n[\s\S]*?<\/skill>\n/g

/** Host wording for a complete catalog, and its partial counterpart. */
const COMPLETE_DIRECT_CALL = "They cannot be called directly. They only work inside code you pass to `execute`."
const PARTIAL_DIRECT_CALL =
  "They cannot be called directly, and neither can `search`. Both only work inside code you pass to `execute`."
const COMPLETE_CATALOG = "The catalog is complete. Do not guess tool names."
const PARTIAL_CATALOG = [
  "The catalog is partial. Inside `execute`, use `search(...)` to find a tool, then call it by the `path` in the result. `search` is synchronous. Call it without `await`; it does not return a Promise. Do not guess tool names.",
  "- search({ query?: string, namespace?: string, offset?: number, limit?: number }): { items: Array<{ path: string, description: string, signature: string }>, remaining: number, next: { offset: number } | null }",
].join("\n")

/**
 * Whether a system part is the host's Code Mode part.
 *
 * @param text System part text.
 * @returns True when the part starts with the Code Mode heading.
 */
export function isCodeModePart(text: string): boolean {
  return text.startsWith(CODE_MODE_HEADING)
}

/**
 * List the namespaces and skills a Code Mode part offers.
 *
 * @param text Code Mode system part text.
 * @returns Namespaces in catalog order and skills in listing order.
 */
export function readCapabilityCatalog(text: string): CapabilityCatalog {
  return {
    namespaces: readNamespaces(toolsSectionOf(text)?.body ?? ""),
    skills: readSkills(skillsSectionOf(text)?.body ?? ""),
  }
}

/**
 * Rewrite a Code Mode part so only the selected namespaces and skills are
 * described. Everything outside the tool catalog and the skills list is kept
 * verbatim.
 *
 * @param text Code Mode system part text.
 * @param selection Skill IDs and namespace names to keep described.
 * @returns The narrowed text, or the input unchanged when nothing is hidden.
 */
export function narrowCapabilityCatalog(text: string, selection: CapabilitySelection): string {
  return narrowSkills(narrowNamespaces(text, selection.namespaces), selection.skills)
}

interface Section {
  readonly start: number
  readonly end: number
  readonly body: string
}

function toolsSectionOf(text: string): Section | undefined {
  const heading = text.indexOf(TOOLS_HEADING)
  if (heading < 0) return undefined
  const start = heading + TOOLS_HEADING.length
  const blank = text.indexOf("\n\n", start)
  const end = blank < 0 ? text.length : blank
  return { start, end, body: text.slice(start, end) }
}

function skillsSectionOf(text: string): Section | undefined {
  const open = text.indexOf(SKILLS_OPEN)
  if (open < 0) return undefined
  const start = open + SKILLS_OPEN.length
  const end = text.indexOf(SKILLS_CLOSE, start)
  if (end < 0) return undefined
  return { start, end, body: text.slice(start, end) }
}

function readNamespaces(body: string): CodeModeNamespace[] {
  const namespaces: CodeModeNamespace[] = []
  let current: { name: string; count: number; description: string | undefined; lines: string[] } | undefined
  const flush = (): void => {
    if (current === undefined) return
    namespaces.push({
      name: current.name,
      count: current.count,
      description: current.description,
      block: current.lines.join("\n"),
    })
  }
  for (const line of body.split("\n")) {
    const header = NAMESPACE_HEADER.exec(line)
    if (header === null) {
      current?.lines.push(line)
      continue
    }
    flush()
    current = {
      name: header[1] ?? "",
      count: Number(header[2]),
      description: header[3],
      lines: [line],
    }
  }
  flush()
  return namespaces
}

function readSkills(body: string): SkillListing[] {
  return [...body.matchAll(SKILL_BLOCK)].map((match) => {
    const block = match[0]
    return {
      id: /<id>([^<]*)<\/id>/.exec(block)?.[1]?.trim() ?? "",
      description: /<description>([\s\S]*?)<\/description>/.exec(block)?.[1]?.trim() ?? "",
      block,
    }
  })
}

function narrowNamespaces(text: string, keep: ReadonlySet<string>): string {
  const section = toolsSectionOf(text)
  if (section === undefined) return text
  const namespaces = readNamespaces(section.body)
  if (namespaces.every((namespace) => keep.has(namespace.name))) return text
  const listed = namespaces.filter((namespace) => keep.has(namespace.name))
  const body = listed.length === 0 ? NO_NAMESPACES_LISTED : listed.map((namespace) => namespace.block).join("\n")
  const intro = toPartialCatalogIntro(text.slice(0, section.start))
  return `${intro}${body}${text.slice(section.end)}`
}

function toPartialCatalogIntro(intro: string): string {
  return intro.replace(COMPLETE_DIRECT_CALL, PARTIAL_DIRECT_CALL).replace(COMPLETE_CATALOG, PARTIAL_CATALOG)
}

function narrowSkills(text: string, keep: ReadonlySet<string>): string {
  const section = skillsSectionOf(text)
  if (section === undefined) return text
  const skills = readSkills(section.body)
  const hidden = skills.filter((skill) => !keep.has(skill.id))
  if (hidden.length === 0) return text
  const body = skills
    .filter((skill) => keep.has(skill.id))
    .map((skill) => skill.block)
    .join("")
  const closeEnd = section.end + SKILLS_CLOSE.length
  return `${text.slice(0, section.start)}${body}${SKILLS_CLOSE}\n${hiddenSkillsLine(hidden)}${text.slice(closeEnd)}`
}

function hiddenSkillsLine(hidden: readonly SkillListing[]): string {
  const ids = hidden.map((skill) => skill.id).join(", ")
  return `Other skills are available but not described here: ${ids}. Load one with the skill tool by its ID when the task clearly needs it.`
}
