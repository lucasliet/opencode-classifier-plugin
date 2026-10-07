/**
 * Discovery: turn the host model list into routable candidates.
 *
 * Two pure steps, deliberately separated:
 *
 * 1. {@link toCatalogModels} reads whatever `ctx.model.list()` returns and
 *    narrows it into the {@link CatalogModel} contract. It is the only place
 *    that knows the host payload shape, is defensive to the point of never
 *    throwing, and invents no price: a subscription provider reports an EMPTY
 *    `cost` array and the curated profile supplies the burn rates later.
 * 2. {@link buildRoutableModels} joins each catalog model to the route the
 *    subscription association produced and to its profile. A model with no
 *    route is dropped, because only a subscription is a spend we are allowed
 *    to make from a flat monthly plan.
 *
 * Candidate identity is `"<providerID>/<modelID>"`. Two providers serving the
 * same model ID stay two candidates: they draw from different plans, and the
 * router is exactly what decides between them.
 */

import type {
  CatalogModel,
  ModelProfile,
  RoutableModel,
  SubscriptionRoute,
} from "./contracts.ts"
import type { ExclusionMatcher } from "./exclude.ts"

/** Timestamps below this are epoch seconds rather than milliseconds. */
const EPOCH_MS_THRESHOLD = 1e12

/** Read-only view of an `unknown` payload field. */
type UnknownRecord = Readonly<Record<string, unknown>>

/** How catalog models become routable candidates. */
export interface RoutableBuildOptions {
  /** Routes produced by the subscription association. */
  readonly routes: readonly SubscriptionRoute[]
  /** Profile for one model: curated when available, derived otherwise. */
  readonly profileOf: (model: CatalogModel) => ModelProfile
  /** User blacklist; an excluded model is never a candidate. */
  readonly isExcluded?: ExclusionMatcher
}

/**
 * Map a host model list into catalog models.
 *
 * Accepts the `location`/`data` envelope the host returns or a bare array of
 * entries. An entry is skipped, never thrown on, when it is disabled, reports
 * no tool support, has no context limit, or has a non-positive context limit:
 * each of those makes a model unroutable rather than broken. Prices come from
 * the FIRST `cost` entry, because that is the base tier and later entries are
 * long-context surcharges; an empty `cost` array yields all zeros, which later
 * stages read as "this plan publishes no price".
 *
 * @param models Raw list from `ctx.model.list()`, envelope or array.
 * @returns Every entry that is routable, in host order.
 */
export function toCatalogModels(models: readonly unknown[]): CatalogModel[] {
  const catalog: CatalogModel[] = []
  for (const entry of unwrapEntries(models)) {
    const mapped = mapModelEntry(entry)
    if (mapped !== undefined) {
      catalog.push(mapped)
    }
  }
  return catalog
}

/**
 * Join catalog models to their subscription route and profile.
 *
 * @param catalog Models produced by {@link toCatalogModels}.
 * @param options Routes, profile source and blacklist.
 * @returns One candidate per model whose provider has a route and that the
 *   blacklist allows, keyed by `"<providerID>/<modelID>"`.
 */
export function buildRoutableModels(
  catalog: readonly CatalogModel[],
  options: RoutableBuildOptions,
): RoutableModel[] {
  const routable: RoutableModel[] = []
  const seen = new Set<string>()
  for (const model of catalog) {
    const route = options.routes.find((candidate) => candidate.providerIDs.includes(model.providerID))
    if (route === undefined || options.isExcluded?.(model.providerID, model.modelID) === true) {
      continue
    }
    const ref = modelRef(model)
    if (seen.has(ref)) {
      continue
    }
    seen.add(ref)
    routable.push({ key: ref, ref, catalog: model, route, profile: options.profileOf(model) })
  }
  return routable
}

/**
 * Distinct providers of the catalog, for the subscription association.
 *
 * @param catalog Models produced by {@link toCatalogModels}.
 * @param isExcluded Blacklist; a provider whose every model is excluded is left out.
 * @returns Provider IDs in host order.
 */
export function providerIDsOf(
  catalog: readonly CatalogModel[],
  isExcluded?: ExclusionMatcher,
): string[] {
  const providerIDs = new Set<string>()
  for (const model of catalog) {
    if (isExcluded?.(model.providerID, model.modelID) === true) continue
    providerIDs.add(model.providerID)
  }
  return [...providerIDs]
}

/** Candidate reference, the identity the host and the profiles table share. */
function modelRef(model: CatalogModel): string {
  return `${model.providerID}/${model.modelID}`
}

/**
 * Accept both payload shapes.
 *
 * @returns The entry array of a `data`/`models` envelope, or the input itself.
 */
function unwrapEntries(payload: readonly unknown[]): unknown[] {
  const envelope = payload.length === 1 ? asRecord(payload[0]) : undefined
  if (envelope !== undefined) {
    const nested = entryList(envelope)
    if (nested !== undefined) {
      return nested
    }
  }
  return [...payload]
}

function entryList(record: UnknownRecord): unknown[] | undefined {
  const value = record["data"] ?? record["models"]
  return Array.isArray(value) ? value : undefined
}

/** Narrow one host entry, or return `undefined` when it is not routable. */
function mapModelEntry(entry: unknown): CatalogModel | undefined {
  const record = asRecord(entry)
  if (record === undefined || record["enabled"] === false) {
    return undefined
  }
  const providerID = readString(record["providerID"])
  const modelID = readString(record["modelID"]) ?? readString(record["id"])
  if (providerID === undefined || modelID === undefined) {
    return undefined
  }
  const context = readNumber(asRecord(record["limit"])?.["context"])
  if (context === undefined || context <= 0) {
    return undefined
  }
  const capabilities = asRecord(record["capabilities"])
  if (capabilities?.["tools"] !== true) {
    return undefined
  }
  const variants = readVariants(record["variants"])
  const family = readString(record["family"])
  const releasedAt = readEpochMs(asRecord(record["time"])?.["released"])
  return {
    providerID,
    modelID,
    name: readString(record["name"]) ?? modelID,
    context,
    output: readNumber(asRecord(record["limit"])?.["output"]) ?? 0,
    inputModalities: readStringList(capabilities?.["input"]),
    tools: true,
    variantIDs: variants.variantIDs,
    variantSettings: variants.variantSettings,
    costPerMTok: readBaseCost(record["cost"]),
    ...(family === undefined ? {} : { family }),
    ...(releasedAt === undefined ? {} : { releasedAt }),
  }
}

/** Published variants plus their settings, kept so reasoning knobs stay readable. */
function readVariants(value: unknown): {
  readonly variantIDs: string[]
  readonly variantSettings: Readonly<Record<string, Readonly<Record<string, unknown>>>>
} {
  const variantIDs: string[] = []
  const variantSettings: Record<string, Readonly<Record<string, unknown>>> = {}
  if (!Array.isArray(value)) {
    return { variantIDs, variantSettings }
  }
  for (const entry of value) {
    const record = asRecord(entry)
    const id = record === undefined ? undefined : readString(record["id"])
    if (id === undefined || Object.hasOwn(variantSettings, id)) {
      continue
    }
    variantIDs.push(id)
    variantSettings[id] = asRecord(record?.["settings"]) ?? {}
  }
  return { variantIDs, variantSettings }
}

/**
 * Base-tier price of a model.
 *
 * Only the first entry counts: later entries are tiered surcharges for long
 * context, not the price the router should forecast with.
 */
function readBaseCost(value: unknown): CatalogModel["costPerMTok"] {
  const first = Array.isArray(value) ? asRecord(value[0]) : undefined
  const cache = asRecord(first?.["cache"])
  return {
    input: readPrice(first?.["input"]),
    output: readPrice(first?.["output"]),
    cacheRead: readPrice(cache?.["read"]),
    cacheWrite: readPrice(cache?.["write"]),
  }
}

/** Accept only a finite positive number; anything else reads as unpublished. */
function readPrice(value: unknown): number {
  const price = readNumber(value)
  return price !== undefined && price > 0 ? price : 0
}

/** Epoch seconds are widened to milliseconds; a non-positive time is unknown. */
function readEpochMs(value: unknown): number | undefined {
  const time = readNumber(value)
  if (time === undefined || time <= 0) return undefined
  return time < EPOCH_MS_THRESHOLD ? time * 1000 : time
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const items: string[] = []
  for (const entry of value) {
    const item = readString(entry)
    if (item !== undefined) {
      items.push(item)
    }
  }
  return items
}

function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined
  }
  return value as UnknownRecord
}
