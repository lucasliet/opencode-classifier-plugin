/**
 * User blacklist for routing.
 *
 * A pattern without `/` matches a provider ID (`corp-proxy`), and a pattern
 * with `/` matches a `provider/model` reference (`zai-coding-plan/glm-5.3-flash`).
 * `*` matches any run of characters and matching ignores case, so `*-proxy` or
 * `zai-coding-plan/*-flash` work as expected.
 */

/** A compiled blacklist, safe to call per model. */
export type ExclusionMatcher = (providerID: string, modelID: string) => boolean

/**
 * Compile blacklist patterns once.
 *
 * @param patterns Patterns from `routing.models.exclude`.
 * @returns A matcher that is true when the model must never be routed.
 */
export function compileExclusions(patterns: readonly string[]): ExclusionMatcher {
  const providerRules = patterns.filter((pattern) => !pattern.includes("/")).map(globToRegExp)
  const modelRules = patterns.filter((pattern) => pattern.includes("/")).map(globToRegExp)
  return (providerID, modelID) =>
    providerRules.some((rule) => rule.test(providerID)) ||
    modelRules.some((rule) => rule.test(`${providerID}/${modelID}`))
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  return new RegExp(`^${escaped}$`, "i")
}
