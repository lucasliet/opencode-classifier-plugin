/**
 * Reference facts about models, read from the models.dev catalog OpenCode
 * caches locally.
 *
 * Subscription providers publish no price, but the same model ID is usually
 * sold elsewhere with one. That list price is the router's proxy for how
 * capable a model is and how much quota a turn burns, so a model nobody
 * curated still gets a sensible profile.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/** Published list price, USD per million tokens. */
export interface ReferencePrice {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
}

/** What models.dev says about one model ID across every provider selling it. */
export interface ReferenceModel {
  readonly price: ReferencePrice | undefined
  readonly reasoning: boolean
  /** Earliest release time in epoch milliseconds, when published. */
  readonly releasedAt: number | undefined
}

/** Reference facts indexed for lookup by model ID and by family. */
export interface ReferenceIndex {
  readonly byModel: ReadonlyMap<string, ReferenceModel>
  readonly byFamily: ReadonlyMap<string, ReferencePrice>
}

/** An index with no facts, used when the catalog cannot be read. */
export const EMPTY_REFERENCE_INDEX: ReferenceIndex = {
  byModel: new Map(),
  byFamily: new Map(),
}

interface PriceSample {
  readonly modelID: string
  readonly family: string | undefined
  readonly price: ReferencePrice | undefined
  readonly reasoning: boolean
  readonly releasedAt: number | undefined
}

/**
 * Default location of the models.dev cache written by OpenCode.
 *
 * @param env Environment to read `XDG_CACHE_HOME` from.
 * @returns Absolute path of `opencode/models.json` under the cache directory.
 */
export function defaultReferencePath(env: NodeJS.ProcessEnv = process.env): string {
  const cacheHome = env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache")
  return join(cacheHome, "opencode", "models.json")
}

/**
 * Expand a leading `~/` to the home directory, so config paths can be written
 * the way users type them.
 *
 * @param path Path from the config.
 * @returns The path with `~/` expanded; any other path is returned unchanged.
 */
export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path
}

/**
 * Read and index the models.dev cache.
 *
 * @param path File to read.
 * @returns The index, or {@link EMPTY_REFERENCE_INDEX} when the file is
 *   missing or unreadable, because derived profiles must degrade, not fail.
 */
export async function loadReferenceIndex(path: string): Promise<ReferenceIndex> {
  try {
    return buildReferenceIndex(JSON.parse(await readFile(path, "utf8")) as unknown)
  } catch {
    return EMPTY_REFERENCE_INDEX
  }
}

/**
 * Index a models.dev payload (`{ [providerID]: { models: { [id]: model } } }`).
 *
 * Prices are the median of every provider that publishes a non-zero output
 * price, so one reseller's markup or discount does not decide the estimate.
 *
 * @param raw Decoded models.dev payload.
 * @returns Facts per lowercase model ID and median prices per family.
 */
export function buildReferenceIndex(raw: unknown): ReferenceIndex {
  const samples = collectSamples(raw)
  const byModel = new Map<string, ReferenceModel>()
  for (const [modelID, group] of groupBy(samples, (sample) => sample.modelID)) {
    byModel.set(modelID, {
      price: medianPrice(group),
      reasoning: group.some((sample) => sample.reasoning),
      releasedAt: earliest(group.map((sample) => sample.releasedAt)),
    })
  }
  const byFamily = new Map<string, ReferencePrice>()
  for (const [family, group] of groupBy(samples, (sample) => sample.family)) {
    const price = medianPrice(group)
    if (family !== undefined && price !== undefined) byFamily.set(family, price)
  }
  return { byModel, byFamily }
}

function collectSamples(raw: unknown): PriceSample[] {
  const samples: PriceSample[] = []
  for (const provider of Object.values(asRecord(raw) ?? {})) {
    const models = asRecord(asRecord(provider)?.models) ?? {}
    for (const [modelID, model] of Object.entries(models)) {
      const record = asRecord(model)
      if (record === undefined) continue
      samples.push({
        modelID: modelID.trim().toLowerCase(),
        family: readText(record.family)?.toLowerCase(),
        price: readPrice(record.cost),
        reasoning: record.reasoning === true,
        releasedAt: readDate(record.release_date),
      })
    }
  }
  return samples
}

function readPrice(value: unknown): ReferencePrice | undefined {
  const cost = asRecord(value)
  const output = positive(cost?.output)
  if (cost === undefined || output === 0) return undefined
  const input = positive(cost.input) || output
  return { input, output, cacheRead: positive(cost.cache_read) || input }
}

function medianPrice(samples: readonly PriceSample[]): ReferencePrice | undefined {
  const prices = samples
    .map((sample) => sample.price)
    .filter((price): price is ReferencePrice => price !== undefined)
    .sort((left, right) => left.output - right.output)
  return prices[Math.floor(prices.length / 2)]
}

function groupBy<K>(samples: readonly PriceSample[], keyOf: (sample: PriceSample) => K): Map<K, PriceSample[]> {
  const groups = new Map<K, PriceSample[]>()
  for (const sample of samples) {
    const key = keyOf(sample)
    const group = groups.get(key) ?? []
    group.push(sample)
    groups.set(key, group)
  }
  return groups
}

function earliest(values: readonly (number | undefined)[]): number | undefined {
  const known = values.filter((value): value is number => value !== undefined)
  return known.length === 0 ? undefined : Math.min(...known)
}

function readDate(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * Memoize the catalog read: models.dev changes rarely and the file is large,
 * so one read per process is enough.
 *
 * @param path File to read on first use.
 * @returns A loader that resolves to the same index on every call.
 */
export function createReferenceLoader(path: string): () => Promise<ReferenceIndex> {
  let pending: Promise<ReferenceIndex> | undefined
  return () => {
    pending ??= loadReferenceIndex(path)
    return pending
  }
}
