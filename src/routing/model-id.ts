/**
 * Model identity, independent of the provider serving it.
 *
 * Curation describes a model, not a plan, so every host spelling of one model
 * must reach the same row: Vertex appends `@default` or a date, some catalogs
 * prefix the vendor (`xai/grok-4.6`) or suffix the serving flavour (`-maas`,
 * `-free`), and a few vendors publish one model under two names.
 */

/** Host spellings of one model, after suffixes and prefixes are stripped. */
const MODEL_ID_ALIASES: Readonly<Record<string, string>> = {
  k3: "kimi-k3",
  "gemini-3.1-pro-preview-customtools": "gemini-3.1-pro-preview",
}

/** Serving-flavour suffixes that do not change which model answers. */
const SERVING_SUFFIX = /-(maas|free)$/

/**
 * Reduce a host model ID to the model it names.
 *
 * @param modelID Model ID exactly as a provider reports it.
 * @returns Lowercase ID without version pin, vendor prefix or serving suffix,
 *   resolved through the known aliases.
 */
export function canonicalModelID(modelID: string): string {
  const unpinned = modelID.toLowerCase().trim().split("@")[0] ?? ""
  const unprefixed = unpinned.slice(unpinned.lastIndexOf("/") + 1)
  const bare = unprefixed.replace(SERVING_SUFFIX, "")
  return MODEL_ID_ALIASES[bare] ?? bare
}
