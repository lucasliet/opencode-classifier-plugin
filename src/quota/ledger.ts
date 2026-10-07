/**
 * Quota ledger: the cached, TTL guarded view of every subscription pool.
 *
 * The ledger never throws and never blocks. A failed or slow `ai-usagebar` run
 * leaves the pools in `unknown`, which the router reads as "no pressure signal"
 * and never as "free quota".
 */
import type {
  ActiveSubscription,
  PoolPressure,
  QuotaLedger,
  QuotaPoolID,
  QuotaPoolState,
} from "../routing/contracts.ts"
import {
  describeUsageFailure,
  discoverPoolBindings,
  fetchJsonDocument,
  fetchUsageDocument,
  isSubscriptionReading,
  parseUsageDocument,
  parseVendorKinds,
  poolPressureFor,
  scopePoolToModel,
  unknownPoolStates,
} from "./usagebar.ts"
import type {
  QuotaPoolBinding,
  UsageBarInvocation,
  UsageDocumentFetcher,
} from "./usagebar.ts"

export interface QuotaLedgerOptions {
  readonly binary: string
  readonly args: readonly string[]
  readonly timeoutMs: number
  readonly refreshSeconds: number
  /**
   * Fixed pool id to `ai-usagebar` entry id bindings. When omitted, the ledger
   * discovers one pool per entry each reading reports, which is how the router
   * follows subscriptions as they are added or cancelled.
   */
  readonly pools?: readonly QuotaPoolBinding[]
  /**
   * Arguments that make the binary list vendors and how they authenticate.
   * An empty list skips the lookup, and every subscription then requires an
   * OAuth proof.
   */
  readonly vendorArgs?: readonly string[]
  /** Clock source, injected so the refresh TTL is testable. */
  readonly now?: () => number
  /** Replaces the binary runner. Tests inject a fake, production uses the CLI. */
  readonly fetchDocument?: UsageDocumentFetcher
  /** Replaces the vendors runner. Tests inject a fake, production uses the CLI. */
  readonly fetchVendors?: UsageDocumentFetcher
}

/** Vendor authentication kind whose quota belongs to an OAuth login. */
const OAUTH_KIND = "oauth"

/**
 * Creates a quota ledger over the `ai-usagebar` CLI.
 *
 * @param options Binary invocation, cache TTL and the pool to entry mapping.
 * @returns A ledger that starts empty, resolves refreshes within `timeoutMs`,
 * and reports safe `unknown` records for unknown pools.
 */
export function createUsageBarLedger(options: QuotaLedgerOptions): QuotaLedger {
  return new UsageBarLedger(options)
}

class UsageBarLedger implements QuotaLedger {
  private readonly now: () => number
  private readonly fetchDocument: UsageDocumentFetcher
  private readonly fetchVendors: UsageDocumentFetcher
  private readonly invocation: UsageBarInvocation
  private readonly vendorInvocation: UsageBarInvocation | undefined
  private readonly fixedPools: readonly QuotaPoolBinding[] | undefined
  private readonly ttlMs: number
  private bindings: readonly QuotaPoolBinding[]
  private states: readonly QuotaPoolState[]
  private vendorKinds: ReadonlyMap<string, string> = new Map()
  private verified: readonly ActiveSubscription[] = []
  private lastAttemptAt: number | null = null
  private inFlight: Promise<void> | null = null
  private running: AbortController | null = null
  private disposed = false

  constructor(private readonly options: QuotaLedgerOptions) {
    this.now = options.now ?? Date.now
    this.fetchDocument = options.fetchDocument ?? fetchUsageDocument
    this.fetchVendors = options.fetchVendors ?? fetchJsonDocument
    this.invocation = {
      binary: options.binary,
      args: options.args,
      timeoutMs: options.timeoutMs,
    }
    const vendorArgs = options.vendorArgs ?? []
    this.vendorInvocation =
      vendorArgs.length === 0 ? undefined : { ...this.invocation, args: vendorArgs }
    this.fixedPools = options.pools
    this.ttlMs = Math.max(0, options.refreshSeconds) * 1000
    this.bindings = options.pools ?? []
    this.states = unknownPoolStates(this.bindings)
  }

  subscriptions(): readonly ActiveSubscription[] {
    return this.verified
  }

  pools(): readonly QuotaPoolState[] {
    return this.states
  }

  pool(poolID: QuotaPoolID, modelID?: string): QuotaPoolState | undefined {
    const state = this.states.find((candidate) => candidate.poolID === poolID)
    if (state === undefined || modelID === undefined) return state
    return scopePoolToModel(state, modelID)
  }

  pressure(poolID: QuotaPoolID, modelID?: string): PoolPressure {
    return poolPressureFor(poolID, this.pool(poolID, modelID))
  }

  async refresh(force = false): Promise<void> {
    if (this.disposed) return
    if (!force && this.isFresh()) return
    this.inFlight ??= this.load().finally(() => {
      this.inFlight = null
    })
    await this.inFlight
  }

  dispose(): void {
    this.disposed = true
    this.running?.abort(new Error("ai-usagebar run cancelled by ledger dispose()"))
    this.running = null
  }

  /**
   * Vendor kinds are a local lookup; a failed one keeps the last known kinds,
   * because an unknown kind already fails closed to "requires OAuth".
   */
  private async loadVendorKinds(signal: AbortSignal): Promise<void> {
    if (this.vendorInvocation === undefined) return
    try {
      const kinds = parseVendorKinds(await this.fetchVendors(this.vendorInvocation, signal))
      if (kinds.size > 0) this.vendorKinds = kinds
    } catch {
      return
    }
  }

  private verifiedSubscriptions(): readonly ActiveSubscription[] {
    return this.states.filter(isSubscriptionReading).map((state) => ({
      id: state.poolID,
      label: state.label,
      requireOAuth: isOAuthKind(this.vendorKinds.get(state.poolID)),
    }))
  }

  private isFresh(): boolean {
    if (this.lastAttemptAt === null) return false
    return this.now() - this.lastAttemptAt < this.ttlMs
  }

  private async load(): Promise<void> {
    const controller = new AbortController()
    const startedAt = this.now()
    this.running = controller
    const timer = setTimeout(
      () => controller.abort(timeoutReason(this.invocation)),
      this.invocation.timeoutMs,
    )
    try {
      const [document] = await Promise.race([
        Promise.all([
          this.fetchDocument(this.invocation, controller.signal),
          this.loadVendorKinds(controller.signal),
        ]),
        cancelledRequest(controller.signal),
      ])
      this.bindings = this.fixedPools ?? discoverPoolBindings(document)
      this.states = parseUsageDocument(document, { pools: this.bindings })
      this.verified = this.verifiedSubscriptions()
    } catch (error) {
      this.states = unknownPoolStates(this.bindings, describeUsageFailure(error))
    } finally {
      clearTimeout(timer)
      this.running = null
      this.lastAttemptAt = startedAt
    }
  }
}

function isOAuthKind(kind: string | undefined): boolean {
  return kind === undefined || kind === OAUTH_KIND
}

function timeoutReason(invocation: UsageBarInvocation): Error {
  const command = [invocation.binary, ...invocation.args].join(" ")
  return new Error(
    `ai-usagebar timed out after ${invocation.timeoutMs}ms (command: ${command})`,
  )
}

/**
 * Rejects as soon as the run is aborted, so a hung binary cannot hold the
 * caller past the timeout even when the runner ignores the signal.
 */
function cancelledRequest(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal))
      return
    }
    signal.addEventListener("abort", () => reject(abortReason(signal)), {
      once: true,
    })
  })
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error(String(reason))
}