# opencode-classifier-plugin

Jev/System One classifier layer for **OpenCode V2 (>= 2.0)** with a
compatibility implementation for **OpenCode 1.18 (>= 1.18.29)**.

The plugin provides:

- a selectable **jev model router / Auto (Jev)** model in `/models`;
- zero-config subscription model routing driven by live quota;
- Jev-based permission Auto Mode;
- agent routing;
- large tool-output context filtering;
- skill and MCP selection: only what Jev picks for the task is described to
  the model (V2).

## Supported OpenCode API

One package serves both runtimes from a single default export:

```text
V2 (>= 2.0):  id + setup()   via @opencode/plugin
V1 (>= 1.18.29): server()    via @opencode-ai/plugin
```

On V2 the plugin uses native primitives (`permission.hook("evaluate")`,
`session.hook("prompt"/"context")`, `session.switchModel`/`switchAgent`,
`provider.transform`). On V1 it uses the classic hooks (`permission.ask`,
`chat.message`, `event`, the experimental transforms) plus the SDK reply
workaround. Pure decision logic (Jev client, classifier, permission policy,
context filter) is shared.

If your installed OpenCode reports a 1.18 version, you do not need to install a different binary for this plugin:

```bash
opencode --version
```

## The selectable model router

The plugin injects a custom provider into OpenCode's merged configuration during the `config` hook.

It appears in `/models` as:

```text
jev model router
  Auto (Jev)
```

Technical reference:

```text
jev-model-router/auto
```

The provider uses an intentionally unreachable placeholder endpoint. It is never supposed to receive an inference request.

Routing is zero-config: there are no configured execution models. When `jev-model-router/auto` is selected, the plugin classifies the request with Jev, discovers the models offered by the user's subscriptions from the host catalog, checks their live quota through the `ai-usagebar` CLI, and picks one model plus a reasoning effort for the task.

On OpenCode 1.18, OpenCode creates the user turn using that selected model. Before the turn is saved, the plugin's `chat.message` hook rewrites **only that turn's saved model** to the routed model:

```text
UI/session selection
jev-model-router/auto
        |
        v
chat.message
        |
        v
Jev classification
        |
        v
subscription routing pipeline
(model + reasoning effort)
        |
        v
saved user turn uses real model
        |
        v
OpenCode agent loop runs real model
```

On V2 the same decision is applied per prompt through the native `session.switchModel`.

OpenCode 1.18 has one UI limitation: after the routed user message is saved, the TUI restores its visible picker from that message and therefore displays the real routed model rather than `jev-model-router/auto`.

Sticky routing is built in on 1.18. The plugin remembers that the router was activated and the last model it selected. If the next prompt arrives with exactly that routed model selected, the plugin treats it as the TUI's automatic restoration and routes again. Selecting a **different** real model disables sticky router mode.

Because OpenCode 1.18 does not expose a public "set selected model" API to plugins, sticky mode cannot distinguish the user deliberately re-selecting the exact same real model that the router just chose. To disable sticky routing in that edge case, select a different real model first.

If you manually select a different real model, for example:

```text
opencode-go/gpt-5.6-luna
```

the next user turn disables model routing and your explicit model selection wins.

## How Auto (Jev) picks a model

Every routed prompt runs through the same pipeline, in this order:

1. **Subscription proof.** Only models served by a provider associated with a subscription that `ai-usagebar` currently reports are candidates (see "Subscription routes" below). A provider that matches no active subscription, or that the user blacklisted, never enters the candidate set, whatever its quota or quality.
2. **Capability and quality floor.** The model must support the tools and vision the task needs, hold the estimated prompt, and its quality tier (economy/balanced/advanced, curated or derived) must meet the floor derived from the Jev signals. Required quality is never traded for spare quota.
3. **Quota, worst window.** Every inference window of the model's quota pool is checked and the worst one decides; the safety margin is held back. An exhausted pool is skipped entirely.
4. **Estimated burn.** The task's forecast cost is computed from per-token rates (host, curated or models.dev list price) and the effort gear, so two models sharing one pool are compared by the share of the window they would actually consume.
5. **Score.** Quality surplus above the floor, minus quota pressure, estimated burn, a penalty for unknown quota, a preference for preserving the tightest pool, and an extra penalty when the task is predicted to cross the safety margin. Quick mechanical tasks (the economy tier) additionally reward faster models, using throughput measured from real turns; that speed term is the smallest in the policy, so it breaks ties without ever outvoting quota or quality. The highest score wins; every rejection carries a readable reason.

### Quota reading rules

- All inference windows matter: the worst window decides. A pool at 4% on its 5-hour window but 94% on the weekly window is pressured.
- Headroom is pace-adjusted for scoring: the remaining share is divided by the share of the window's time still left, capped at 1. 51% left on a monthly window with 63% of the month to go scores 0.81, while 23% used on a weekly window that resets in two days scores 1, so windows of different lengths compare fairly. Exhaustion still uses the raw percentage.
- Some vendors meter model categories separately. Cursor's "Cursor Models" window meters only its own models (`default`/Auto and `composer-*`) and "Other Models" every third-party model, so an exhausted third-party bucket does not block Composer.
- MCP tool quotas are visible in the report but never gate model routing.
- Unknown quota is never treated as free: an unreadable pool gets neutral headroom and a scoring penalty, not a green light.
- A missing percentage (`null`) is never read as zero. Unknown means unknown.

## Subscription routes

Nothing in the plugin names a plan. Subscriptions are discovered on every
quota refresh:

1. **Which subscriptions exist** comes from `ai-usagebar usage --json`. An
   entry counts only when it is readable and reports at least one time-windowed
   quota (5-hour, weekly, monthly). Credit balances (pay-as-you-go), failed
   readings and vendors switched off in `ai-usagebar` are not subscriptions.
   Cancel a plan and switch its vendor off in `ai-usagebar`, and it stops being
   routed — no plugin change needed.
2. **Which provider spends which subscription** is matched per provider, in
   this order:
   - an explicit `routing.providerPools` entry (`{ "my-proxy": "anthropic" }`);
   - the provider ID contains the vendor ID (`zai-coding-plan` → `zai`,
     `kimi-code-plan-global` → `kimi`, `github-copilot` → `copilot`). A custom
     provider that does not carry its vendor's name is read through its
     `routing.providerAliases` entry (`{ "my-glm": "zai-coding-plan" }`), or
     placed directly with `routing.providerPools`.

   A provider that matches neither is never routed.
3. **OAuth proof.** When `ai-usagebar vendors --json` says a vendor
   authenticates by OAuth (ChatGPT/Codex, Claude, Copilot), its providers must
   show an OAuth connection: the same provider with an API key is metered and
   is excluded. An unknown kind fails closed to "requires OAuth".
4. **Blacklist.** `routing.exclude` removes providers (`corp-proxy`) or
   single models (`zai-coding-plan/glm-5.3-flash`, `*` wildcards allowed) before
   anything else runs. Use it for accounts that must never be spent, such as a
   company subscription.

Several providers matched to one vendor share that vendor's quota pool.

## Model profiles

Each candidate needs a quality tier, capability estimates, a burn rate and a
speed. They come from, in order of precedence:

1. **Curated rows** in `src/routing/profiles.ts`, kept as optional fine-tuning
   (benchmark-calibrated tiers, Go dollar allowances).
2. **Derived profiles** for every other model, built from the host catalog and
   the models.dev cache OpenCode keeps at `~/.cache/opencode/models.json`
   (`routing.referenceCatalog` overrides the path). The model's list price —
   the median across providers that sell the same model ID, then its family —
   drives capability on a log scale and the burn rate. Only a reasoning model
   priced by its own ID can be derived as `advanced`; models older than about
   18 months drop one tier. `-highspeed`/`-turbo`/`-fast` serving tiers inherit
   their base model's price.
3. **Measured speed** replaces the static speed estimate of both: on V2 the
   plugin times every `session.step.started`/`session.step.ended` pair, keeps a
   moving tokens-per-second average per model, and persists it in the plugin's
   storage. Until five turns are measured the name-based prior is blended in.

A provider listed in `routing.providerAliases` is profiled as the provider it
stands for, so `{ "my-glm": "zai-coding-plan" }` gives `my-glm/glm-5.3` the
`zai-coding-plan/glm-5.3` row; measured speed stays keyed by the real provider.

Vendors that publish no dollar allowance are compared through percentage
pressure only.

## Failover

When a model the router chose fails mid-turn, OpenCode V2 asks plugins whether
to retry (`session.hook("retry")`). The router then:

1. puts the failed provider on a 10-minute cooldown, during which no routing
   decision — failover or next prompt — picks it;
2. routes the same task again without it;
3. switches the session to the new model and answers `retry: true` with no
   delay. The host reloads the session model before retrying, so the retry runs
   on the new model and the user's message is not duplicated.

Failures on a model the user picked by hand, user aborts, and failures with no
alternative left keep the host's own retry decision. V1 has no retry hook, so
failover is V2 only.

## Quality floor and reasoning effort

The quality floor (economy/balanced/advanced) is derived from the Jev signals.
The floor is relaxed one band before routing ever fails, but the
subscription-only invariant is never relaxed: when no subscription model can
serve the task, the plugin refuses to pick a pay-as-you-go model and says so
instead of falling through to one.

The reasoning effort is picked as a variant the model actually exposes — the
ladder walks down from the allowed effort, never up, and no variant ID is ever
synthesized. When a model's only exposed gear is more expensive than the task
allows, the host runs its own default gear, which is invisible to the plugin;
in that case cost estimation is conservative and the task is priced at the
model's most expensive published gear.

The fast/normal/deep tier names of the previous fixed-model router survive only
as Jev complexity signals; they no longer name model slots.

## Routing configuration

Routing needs no configuration at all. Every field below is optional, and an
empty `routing` block is a valid, working configuration:

```jsonc
{
  "routing": {
    "enabled": true,              // default true
    "safetyMargin": 0.10,         // 0..0.9, share of a quota window the router refuses to spend
    "exclude": ["corp-proxy"],    // providers or provider/model patterns never routed
    "providerPools": {},          // provider ID -> ai-usagebar vendor ID, when matching needs help
    "providerAliases": {},        // provider ID -> provider ID it stands for (matching and profiles)
    "referenceCatalog": "~/.cache/opencode/models.json", // models.dev cache for derived profiles
    "quota": {
      "enabled": true,            // default true
      "binary": "ai-usagebar",    // quota reporter CLI
      "args": ["usage", "--json"],
      "vendorArgs": ["vendors", "--json"],
      "timeoutMs": 8000,
      "refreshSeconds": 120
    },
    "thresholds": { "fastChoice": 0.72, "deepChoice": 0.58, "deepReasoning": 0.72, "highRisk": 0.72 }
  }
}
```

Out-of-range numbers are clamped instead of rejected.

The previous `router` block (`models`, `efforts`, `fallbackTier`, `sticky`) no
longer exists. Remove it from existing configs: `resolveOptions` does not read
it, and a leftover block is silently ignored.

Default thresholds:

```json
{
  "thresholds": {
    "fastChoice": 0.72,
    "deepChoice": 0.58,
    "deepReasoning": 0.72,
    "highRisk": 0.72
  }
}
```

Policy:

- confident simple/low-risk task -> `economy` floor;
- strong deep-complexity, deep-reasoning, or high-risk signal -> `advanced` floor;
- otherwise -> `balanced` floor;
- Jev unavailable -> `balanced` floor.

The same signals set the reasoning-effort ceiling for the task.

Routing requires the `ai-usagebar` CLI on `PATH`: it is the source of truth
for which subscriptions exist. Without it no subscription is known and the
plugin asks for a manual model pick instead of guessing. After the first
successful reading, a failed refresh keeps the last known subscriptions with
unknown quota, which is penalized in scoring but never blocks routing.

OpenCode 1.x publishes no connections to plugins, so on V1 OAuth-bound
subscriptions are excluded.

## Installation

After publishing:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["opencode-classifier-plugin", {}]
  ]
}
```

OpenCode 1.18 uses the **singular** `plugin` field. OpenCode V2 uses the
**plural** `plugins` field with `{ "package", "options" }` objects:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-classifier-plugin",
      "options": {}
    }
  ]
}
```

No routing configuration is required; supply options only to tune the router or
the other features.

A V2 example is provided in:

```text
opencode.example.jsonc
```

Plugin entries may be strings or `[package, options]` tuples. This plugin uses the tuple form because its policy configuration is supplied as plugin options.

A full example is provided in:

```text
opencode.example.json
```

Restart OpenCode after changing the plugin configuration.

## Jev / System One authentication

Default decision endpoint:

```text
https://opencode.ai/zen/v1/systemone
```

Default classifier:

```text
jev-1.13-free
```

The OpenCode 1.18 public plugin API does not expose a supported method for reading provider secrets that were stored by `/connect`.

Therefore the classifier credential is resolved in this order:

1. `decision.apiKey`;
2. environment variable configured by `decision.apiKeyEnv`.

Default:

```text
OPENCODE_API_KEY
```

Recommended:

```bash
export OPENCODE_API_KEY="your-opencode-zen-key"
opencode
```

Do not commit an API key into `opencode.json`.

If you use a local or otherwise unauthenticated System One-compatible endpoint:

```json
{
  "decision": {
    "endpoint": "http://127.0.0.1:8000/v1/systemone",
    "model": "jev-local",
    "requireAuth": false
  }
}
```

## Decision provider configuration

```json
{
  "decision": {
    "endpoint": "https://opencode.ai/zen/v1/systemone",
    "model": "jev-1.13-free",
    "apiKeyEnv": "OPENCODE_API_KEY",
    "requireAuth": true,
    "timeoutMs": 8000,
    "retries": 1
  }
}
```

The System One client:

- supports `noul`, `choice`, and score responses used by the plugin;
- validates that every requested answer exists;
- creates a fresh timeout/AbortController for each attempt;
- retries network errors, timeouts, HTTP 408, HTTP 429, and HTTP 5xx;
- does not automatically retry definitive HTTP 4xx responses.

## Permission Auto Mode

OpenCode 1.18 emits real pending requests as `permission.asked` events. The
plugin observes that host event and replies through the matching server endpoint
before the user responds.

The plugin classifies each request and then:

- Jev/local policy says **allow** -> sends `once`;
- Jev classifies a request as high-risk -> does not reply, so a human can approve or reject it;
- policy says **ask** -> does not reply, so the normal OpenCode permission UI remains in control;
- classifier unavailable -> does not reply, so the user is asked.

An OpenCode permission configured as `allow` or `deny` is final. Auto Mode is
only invoked for requests that resolve to `ask`; explicit effects are preserved
without contacting Jev. Before Jev evaluates an unresolved shell request, Auto
Mode applies command boundaries. This mirrors Claude Code's documented
precedence for explicit rules: a matching `deny` rule escalates to human
approval, a matching `ask` rule keeps the host permission prompt, and Jev
classifies only requests that remain. Commands that attempt critical system
destruction, such as `rm -rf /`, filesystem formatting, power control, or
writing directly to `/dev`, always require human approval. Auto Mode never
denies: it either approves or leaves the request for the user to approve.

`commandRules` accepts exact command strings or a single trailing `*` prefix. For example, `git push *` matches both `git push` and `git push origin main`; it does not match `git -C repo push`. Use specific rules rather than broad shell wildcards. Only `commandRules.deny` is a final rejection; a Jev high-risk classification never prevents a human from approving the pending request.

Do not enable OpenCode's separate blanket auto-accept mode if you want Jev to make these decisions; blanket auto-accept can answer the request before the classifier.

`autoMode.onError: "ask"` changes the legacy hook fallback to `ask`. With the
real 1.18 event flow, both `ask` and `preserve` leave the pending host request
unanswered: the event contains no prior policy result to preserve, and replying
would be fail-open. Use `ask` in OpenCode 1.18 configurations.

Signals include:

- read-only;
- modifies project;
- outside workspace;
- destructive;
- reversible;
- changes VCS history;
- executes downloaded code;
- external side effect;
- sensitive data;
- privilege escalation.

Example:

```json
{
  "autoMode": {
    "enabled": true,
    "onError": "ask",
    "commandRules": {
      "ask": [
        "git push *",
        "npm publish"
      ],
      "deny": [
        "git push --force *"
      ]
    },
    "allowReversibleProjectChanges": true,
    "denyHighRisk": false,
    "thresholds": {
      "autoAllow": 0.8,
      "projectChange": 0.6,
      "reversibleAllow": 0.88,
      "riskAsk": 0.45,
      "deny": 0.65
    }
  }
}
```

The external Claude Code classifier is not public, so exact model-level parity is not possible. This plugin implements its documented, observable contract through deterministic rule precedence, protected destructive commands, Jev classification, and fail-closed fallback to the normal OpenCode prompt.

Configure potentially sensitive actions as `ask` if you want Jev Auto Mode to
evaluate them. Explicit OpenCode `allow` and `deny` effects are never converted
to another effect.

## Agent routing

Agent routing is independent of model routing.

```json
{
  "agents": {
    "enabled": true,
    "minimumProbability": 0.85,
    "byDomain": {
      "frontend": "frontend",
      "backend": "backend",
      "database": "database",
      "security": "security"
    }
  }
}
```

The classifier mutates the current user turn's `agent` before OpenCode saves it. The configured values must match real OpenCode agent names.

This continues to work when a normal real model is manually selected.

## Context filtering

OpenCode 1.18 calls `experimental.chat.messages.transform` before converting persisted messages into the provider request.

The plugin:

1. makes a structural copy of the request messages;
2. finds large completed tool outputs in `ToolPart.state.output`;
3. divides them into bounded chunks;
4. asks Jev which chunks are relevant;
5. removes low-relevance processed chunks only from the copied request;
6. assigns the copied request back to the hook output.

Persisted session history is not modified.

```json
{
  "context": {
    "enabled": true,
    "minChars": 12000,
    "chunkChars": 2500,
    "minimumCandidates": 6,
    "maxCandidates": 24,
    "maxBatches": 4,
    "relevantAt": 0.52
  }
}
```

Any unprocessed tail beyond the configured batch cap is preserved.

Filtering failure preserves the original request context.

A bounded in-memory cache avoids sending the same task/output combination to Jev repeatedly during the same OpenCode process.

## Skill and MCP selection

OpenCode V2 describes every skill (`<available_skills>`) and every MCP or
plugin tool namespace (the Code Mode catalog behind `execute`) in the system
prompt of every model request. With dozens of skills that is most of the
instruction tokens. Harness tools (`read`, `edit`, `shell`, `skill`,
`execute`, ...) are not touched.

In `session.hook("context")` the plugin:

1. reads the skills and namespaces from the Code Mode system part;
2. asks Jev, once per user prompt, which of them the task needs (one
   relevance question each, in parallel batches bounded by
   `privacy.maxStateChars`);
3. rewrites that part for the outgoing request only.

What Jev does not select stays reachable:

- a hidden namespace is left out entirely, and the catalog switches to the
  host's own "partial" wording, so the model can still find its tools with
  `search(...)` inside `execute`;
- hidden skills collapse into one line of IDs, which the skill tool still
  loads.

Selections accumulate for the session: a skill picked once stays described,
so the system prompt only changes when something new is needed and the
provider's prompt cache stays warm. A Jev failure keeps the full catalog for
that prompt. The rewrite never touches persisted history.

```json
{
  "capabilities": {
    "enabled": true,
    "relevantAt": 0.4,
    "alwaysInclude": {
      "skills": [],
      "namespaces": ["opencode"]
    }
  }
}
```

`alwaysInclude` entries are never sent to Jev and are always described. The
`opencode` namespace holds harness tools (sessions, models, MCP resources),
so it is pinned by default. Mid-session catalog changes the host sends as
messages (`The available skills have changed...`) are not narrowed.

## Failure triage, loop controller, and post-action verification

These features were removed. The plugin no longer observes tool results, classifies failures, maintains a per-task loop state machine, blocks tool execution, or gates mutations behind verification. It provides routing, permission Auto Mode, and context filtering only.

## Privacy

Default:

```json
{
  "privacy": {
    "maxStateChars": 24000,
    "maxPromptChars": 8000,
    "maxEvidenceChars": 12000,
    "maxResourceChars": 4000,
    "includePermissionMetadata": false
  }
}
```

The plugin does not proactively send the entire repository or entire conversation to Jev.

Potentially transmitted data:

- bounded current prompt for routing;
- permission action and patterns;
- permission metadata only when explicitly enabled;
- bounded failure evidence;
- bounded validation evidence;
- bounded chunks of large tool output selected for relevance classification;
- skill descriptions and Code Mode namespace listings, for skill and MCP
  selection.

For zero external classifier traffic, point `decision.endpoint` at a local System One-compatible service.

## Debug log

Trace lines (routing decisions, capability narrowing, failover) are written
only when a log file is enabled, in this order:

1. `logFile` in the plugin options (`~/` is expanded);
2. the `OPENCODE_CLASSIFIER_LOG` environment variable;
3. `$XDG_STATE_HOME/opencode/opencode-classifier-plugin.log` (default
   `~/.local/state/...`) while `debug` is `true`.

The file and its directory are created private to the user. `debug: true` also
mirrors trace lines to stderr.

```json
{
  "debug": false,
  "logFile": "~/.local/state/opencode/opencode-classifier-plugin.log"
}
```

## Complete configuration

See:

```text
opencode.example.json    (V1 tuple form)
opencode.example.jsonc   (V2 object form)
```

The examples leave agent routing disabled because agent names are project-specific.

## Local development

```bash
npm install
npm run typecheck
npm test
npm run check
npm run pack:check
```

For local OpenCode testing, use a file plugin reference:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///absolute/path/to/opencode-classifier-plugin",
      {}
    ]
  ]
}
```

Then start OpenCode with the classifier credential available:

```bash
export OPENCODE_API_KEY="..."
opencode
```

Run:

```text
/models
```

and select:

```text
jev model router / Auto (Jev)
```

## Publishing to npm

The package is not yet ready for public publication. Complete the remaining real-host smoke tests for model tiers/sticky override and agent routing before publishing.

```bash
npm login
npm run check
npm run pack:check
npm publish --access public
```

`prepublishOnly` runs both `npm run check` and `npm run pack:check`.

## Package layout

```text
opencode-classifier-plugin/
├── index.ts
├── src/
│   ├── v1.ts
│   ├── v2.ts
│   ├── v2-discovery.ts
│   ├── v2-route.ts
│   ├── v2-failover.ts
│   ├── v2-speed.ts
│   ├── v2-capabilities.ts
│   ├── types.ts
│   ├── config.ts
│   ├── jev.ts
│   ├── classifier.ts
│   ├── permission.ts
│   ├── context.ts
│   ├── runtime.ts
│   ├── trace.ts
│   ├── capabilities/
│   │   ├── catalog.ts
│   │   ├── judge.ts
│   │   └── selection.ts
│   ├── routing/
│   │   ├── contracts.ts
│   │   ├── subscriptions.ts
│   │   ├── exclude.ts
│   │   ├── assemble.ts
│   │   ├── catalog.ts
│   │   ├── reference.ts
│   │   ├── derive.ts
│   │   ├── profiles.ts
│   │   ├── profile-source.ts
│   │   ├── speed.ts
│   │   ├── health.ts
│   │   ├── pace.ts
│   │   ├── estimate.ts
│   │   └── select.ts
│   └── quota/
│       ├── usagebar.ts
│       └── ledger.ts
├── test/
│   ├── capabilities.test.ts
│   ├── core.test.ts
│   ├── failover.test.ts
│   ├── profiles.test.ts
│   ├── quota.test.ts
│   ├── subscriptions.test.ts
│   ├── trace.test.ts
│   ├── routing.test.ts
│   ├── v2.test.ts
│   └── package.test.ts
├── opencode.example.json
├── opencode.example.jsonc
├── package.json
├── tsconfig.json
├── LICENSE
└── README.md
```

## Compatibility notes

- Target runtimes: OpenCode **V2 (>= 2.0.15, verified)** and OpenCode
  **V1 (>= 1.18.29)**. Older V1 releases expect function exports instead of
  the `{ id, setup(), server() }` object form.
- Plugin APIs: `@opencode/plugin` (V2) and `@opencode-ai/plugin` (V1 types).
- On V2, permission evaluation runs **before** any prompt is published, so an
  allowed action never flashes a permission dialog first.
- On V2, routing is per prompt through native `switchModel`; there is no
  sticky workaround. A manually selected model is respected: the router only
  engages for the virtual `Auto (Jev)` model (or the global default when it
  is the virtual model and no dispatch has been observed yet).
- Permission decisions are cached for 45 seconds per exact action+resources
  after an unresolved `ask` is classified.
- The model router is selectable in the normal `/models` UI.
- V1 only: the model inventory is read from the merged configuration, because
  the public 1.18 plugin API exposes no host model catalog.
- V1 only: ChatGPT/Codex routes are excluded, because OAuth connections cannot
  be verified on 1.18. The false negative is safe: excluding a real
  subscription loses one candidate, while routing on an API key would spend
  pay-as-you-go money.
- V1 only: OpenCode 1.18 visually restores the last real routed model after a
  turn; sticky routing keeps routing active in plugin state despite that
  visual limitation, with the router's own last selection as the dynamic
  sticky target.
- V1 only: selecting a different real model disables sticky routing. Re-selecting the exact same last-routed model cannot be distinguished from the TUI's automatic restoration by the public 1.18 plugin API.
- V1 only: provider-level retry decisions are left to OpenCode because the public 1.18 plugin API does not expose that internal hook.
- Connected `/connect` secrets are not read by the plugin; supply the System One credential through the environment variable named by `decision.apiKeyEnv` (default `OPENCODE_API_KEY`) or directly with `decision.apiKey`.
