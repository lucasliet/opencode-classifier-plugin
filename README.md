# opencode-classifier-plugin

Jev/System One classifier layer for **OpenCode V2 (>= 2.0)** with a
compatibility implementation for **OpenCode 1.18 (>= 1.18.29)**.

The plugin provides:

- a selectable **jev model router / Auto (Jev)** model in `/models`;
- Jev-based permission Auto Mode;
- configurable fast/normal/deep model routing;
- agent routing;
- large tool-output context filtering.

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

## How the selectable model router works on 1.18

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

When `jev-model-router/auto` is selected, OpenCode creates the user turn using that selected model. Before the turn is saved, the plugin's `chat.message` hook classifies the request with Jev and rewrites **only that turn's saved model** to the configured real execution model.

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
        +--> fast
        +--> normal
        +--> deep
        |
        v
saved user turn uses real model
        |
        v
OpenCode agent loop runs real model
```

OpenCode 1.18 has one UI limitation: after the routed user message is saved, the TUI restores its visible picker from that message and therefore displays the real routed model rather than `jev-model-router/auto`.

By default `router.sticky` is `true`. The plugin remembers that the router was activated and the last model it selected. If the next prompt arrives with exactly that routed model selected, the plugin treats it as the TUI's automatic restoration and routes again. Selecting a **different** real model disables sticky router mode.

```json
{
  "router": {
    "sticky": true
  }
}
```

Set `sticky` to `false` if you prefer one-shot behavior: selecting `jev-model-router/auto` routes one prompt, then the real model shown by the TUI is used normally on subsequent prompts until you select the router again.

Because OpenCode 1.18 does not expose a public "set selected model" API to plugins, sticky mode cannot distinguish the user deliberately re-selecting the exact same real model that the router just chose. To disable sticky routing in that edge case, select a different real model first, or configure `sticky: false`.

If you manually select a different real model, for example:

```text
opencode-go/gpt-5.6-luna
```

the next user turn disables model routing and your explicit model selection wins.

## Installation

After publishing:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-classifier-plugin",
      {
        "router": {
          "models": {
            "fast": "opencode-go/glm-5.3-flash",
            "normal": "opencode-go/gpt-5.6-luna",
            "deep": "opencode/gpt-5.6-sol"
          }
        }
      }
    ]
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
      "options": {
        "router": {
          "models": {
            "fast": "opencode-go/glm-5.3-flash",
            "normal": "opencode-go/gpt-5.6-luna",
            "deep": "opencode/gpt-5.6-sol"
          }
        }
      }
    }
  ]
}
```

A V2 example is provided in:

```text
opencode.example.jsonc
```

Plugin entries may be strings or `[package, options]` tuples. This plugin uses the tuple form because its routing/policy configuration is supplied as plugin options.

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

## Execution models

Jev only chooses a tier. The real execution models belong in your OpenCode configuration:

```json
{
  "router": {
    "enabled": true,
    "sticky": true,
    "models": {
      "fast": "opencode-go/glm-5.3-flash",
      "normal": "opencode-go/gpt-5.6-luna",
      "deep": "opencode/gpt-5.6-sol"
    },
    "efforts": {
      "fast": "low",
      "normal": "medium",
      "deep": "high"
    },
    "fallbackTier": "normal"
  }
}
```

Replace those examples with any model references that exist in your own `/models` picker.

No execution model is hardcoded in the plugin source.

`router.efforts` configures the reasoning-effort variant for each selected tier. Use the exact variant identifier shown by `/models <provider> --verbose`, such as `low`, `medium`, `high`, or `max`. The configured effort takes precedence over a `#variant` included in `router.models`; omit the tier from `efforts` to preserve that embedded variant. A model without the configured variant must not receive an effort for that tier.

Default routing thresholds:

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

- confident simple/low-risk task -> `fast`;
- strong deep-complexity, deep-reasoning, or high-risk signal -> `deep`;
- otherwise -> `normal`;
- Jev unavailable -> `fallbackTier`.

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
- bounded chunks of large tool output selected for relevance classification.

For zero external classifier traffic, point `decision.endpoint` at a local System One-compatible service.

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
      {
        "router": {
          "models": {
            "fast": "opencode-go/glm-5.3-flash",
            "normal": "opencode-go/gpt-5.6-luna",
            "deep": "opencode/gpt-5.6-sol"
          }
        }
      }
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
├── src/
│   ├── index.ts
│   ├── types.ts
│   ├── config.ts
│   ├── jev.ts
│   ├── classifier.ts
│   ├── permission.ts
│   ├── context.ts
│   └── runtime.ts
├── test/
│   ├── core.test.ts
│   └── package.test.ts
├── opencode.example.json
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
- V1 only: OpenCode 1.18 visually restores the last real routed model after a turn; `router.sticky` keeps routing active in plugin state despite that visual limitation.
- V1 only: selecting a different real model disables sticky routing. Re-selecting the exact same last-routed model cannot be distinguished from the TUI's automatic restoration by the public 1.18 plugin API.
- V1 only: provider-level retry decisions are left to OpenCode because the public 1.18 plugin API does not expose that internal hook.
- Connected `/connect` secrets are not read by the plugin; supply the System One credential through `OPENCODE_API_KEY` or `decision.apiKey`.
