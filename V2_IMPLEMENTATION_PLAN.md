# OpenCode Plugin API V2 — Implementation Plan

> **Status: FUTURE / DO NOT IMPLEMENT YET**
>
> The production plugin currently targets **OpenCode 1.18.x** and the public
> `@opencode-ai/plugin` API. This document preserves the planned V2
> architecture for the point at which an official OpenCode binary actually
> exposes the V2 plugin API.
>
> Before starting this migration, verify the API against the **installed
> OpenCode binary and its published plugin package/types**. Do not migrate based
> only on unreleased source code or internal V2 specs.

## 1. Goal

Migrate `opencode-classifier-plugin` from the compatibility architecture needed
by OpenCode 1.18 to the native V2 plugin architecture, while preserving the
existing product behavior:

1. Jev-based Auto Mode for permissions.
2. Jev-based execution-model routing.
3. Agent routing.
4. Skill routing.
5. Context filtering/ranking.
6. Failure triage integrated with Auto Mode and loop control.
7. Agent-loop control/circuit breaking.
8. Post-action verification.

The V2 implementation should remove the workarounds that exist only because the
1.18 plugin API does not expose the necessary runtime controls.

## 2. Migration gate

Do not begin this implementation until all of the following are true:

- an official OpenCode binary installed by users exposes the V2 plugin host;
- the V2 plugin package/API is published and versioned for that binary;
- the runtime actually invokes the V2 hooks used in this plan;
- a minimal plugin can be loaded by the binary without relying on source-tree
  internals;
- model switching can be verified end-to-end in the TUI/session;
- permission evaluation can be verified end-to-end;
- tool hooks and context hooks can be verified end-to-end.

At migration time, first create a small compatibility probe plugin and prove the
actual API signatures. Treat the names in this document as the intended design,
not as a substitute for re-reading the shipped types.

## 3. Architectural rule

Jev should produce **probabilistic facts/signals**. Local plugin policy should
make the final OpenCode decision.

Do not ask Jev questions such as:

- "Should this command be allowed?"
- "Should we use GPT-5.6 Sol?"
- "Should we switch to the backend agent?"

Instead classify independent facts, for example:

```text
read_only = 0.98
destructive = 0.02
external_side_effect = 0.05
requires_deep_reasoning = 0.91
task_domain.backend = 0.94
```

Then apply deterministic local policy:

```text
Jev signals
    |
    v
Decision Engine
    |
    +--> allow / ask / deny
    +--> fast / normal / deep
    +--> agent
    +--> skills
    +--> work / retry / verify / finish
```

This keeps policy explainable, testable, provider-independent, and safer when
classifier calibration changes.

## 4. Target architecture

```text
OpenCode V2
   |
   v
opencode-classifier-plugin
   |
   +-- Decision Provider
   |      |
   |      +-- OpenCode Zen / System One
   |      +-- TypeSafe System One
   |      +-- custom System One-compatible endpoint
   |
   +-- Decision Engine
   |      |
   |      +-- permission policy
   |      +-- model policy
   |      +-- agent/skill policy
   |      +-- loop policy
   |      +-- verification policy
   |
   +-- Runtime State
   |
   +-- Audit / cache / privacy layer
   |
   +-- OpenCode V2 controls
          |
          +-- permission evaluation
          +-- model switching
          +-- agent switching
          +-- skill attachment
          +-- context transformation
          +-- tool lifecycle hooks
          +-- loop stop/interruption
```

## 5. Provider abstraction

Keep the decision-provider abstraction independent from OpenCode routing policy.

Suggested interfaces:

```ts
interface DecisionProvider {
  ask(
    request: SystemOneRequest,
    signal?: AbortSignal,
  ): Promise<SystemOneResponse>
}

interface DecisionEngine {
  check(...args: unknown[]): Promise<DecisionResult>
  classify(...args: unknown[]): Promise<ClassificationResult>
  score(...args: unknown[]): Promise<ScoreResult>
  rank(...args: unknown[]): Promise<RankResult>
}
```

Planned adapters:

```text
src/providers/provider.ts
src/providers/opencode-zen.ts
src/providers/typesafe.ts
src/providers/systemone.ts
```

A generic generative-LLM adapter should **not** be part of the initial V2
migration. System One/Jev outputs are probability-oriented and should not be
silently replaced with free-form generative semantics.

## 6. Configuration

Preserve the current conceptual configuration even if the exact OpenCode V2
plugin-registration syntax changes.

Example logical configuration:

```jsonc
{
  "decision": {
    "provider": "opencode-zen",
    "model": "jev-1.13-free",
    "timeoutMs": 1500,
    "retries": 1
  },

  "autoMode": {
    "enabled": true,
    "onError": "ask",
    "thresholds": {
      "autoAllow": 0.92,
      "review": 0.70,
      "danger": 0.80
    }
  },

  "routing": {
    "enabled": true,
    "models": {
      "fast": "provider/model-fast",
      "normal": "provider/model-normal",
      "deep": "provider/model-deep"
    },
    "stickyPerPrompt": true
  },

  "agents": {
    "enabled": true,
    "minimumConfidence": 0.85
  },

  "skills": {
    "enabled": true,
    "minimumProbability": 0.70,
    "maxCandidates": 32,
    "maxSelected": 1
  },

  "context": {
    "enabled": true,
    "minimumCandidates": 20,
    "topK": 12,
    "relevantAt": 0.55
  },

  "loop": {
    "enabled": true,
    "maxRounds": 20,
    "maxSameFailure": 2
  },

  "verification": {
    "enabled": true,
    "requiredAfterMutation": true
  },

  "privacy": {
    "includeConversationHistory": false,
    "includeFullFiles": false,
    "maxItemChars": 4000
  },

  "audit": {
    "enabled": true,
    "storePayloads": false
  }
}
```

Execution-model references must remain configurable. Never hardcode OpenCode
Zen/Go model names into routing policy.

## 7. V2 capability map

The exact names/signatures must be revalidated against the shipped V2 API.
The previous V2 design expected primitives equivalent to the following.

### 7.1 Permission evaluation

Intended primitive:

```text
ctx.permission.hook("evaluate", ...)
```

V2 objective:

- evaluate a permission **before** OpenCode presents or resolves it;
- directly return/modify `allow | ask | deny`;
- remove the 1.18 workaround that waits for `permission.asked` and replies
  asynchronously through the SDK.

### 7.2 Model switching

Intended primitives:

```text
ctx.session.switchModel(...)
ctx.session.switchAgent(...)
```

V2 objective:

- keep the virtual `Auto (Jev)` router selected in the UI/session;
- switch only the execution model used for the active task/turn;
- remove the 1.18 `router.sticky` workaround;
- eliminate ambiguity between TUI restoration and an explicit user model
  selection.

### 7.3 Tool lifecycle

Intended primitives:

```text
ctx.tool.hook("execute.before", ...)
ctx.tool.hook("execute.after", ...)
```

V2 objective:

- receive normalized success/failure lifecycle data;
- avoid reconstructing failures from legacy `message.part.updated` events;
- attach permission/mutation/failure evidence directly to the tool call state.

### 7.4 Context

Intended primitive:

```text
session.hook("context", ...)
```

V2 objective:

- change only the context supplied to the active model request;
- never rewrite persisted conversation history;
- rank/filter tool/search/LSP/MCP candidates before context reaches the main
  model.

### 7.5 Credentials/integrations

The previous V2 design expected an integration credential API equivalent to:

```text
ctx.integration.connection.active()
ctx.integration.connection.resolve()
```

If the shipped V2 API provides this safely, use the OpenCode-configured
credential for OpenCode Zen/System One instead of requiring a duplicated
`OPENCODE_API_KEY`.

If it does not, retain the current explicit environment/config credential path.

### 7.6 Skills

Prefer a native V2 skill attachment/resolution API when available.

The 1.18 implementation currently injects a system instruction asking the model
to call the built-in `skill` tool. In V2 this workaround should be replaced
with actual skill attachment if the shipped API supports it.

## 8. Initial prompt classification

Use one batched Jev/System One request per user task when possible.

Suggested signals:

```text
task_complexity:
  fast
  normal
  deep

requires_deep_reasoning
requires_large_context
requires_code_generation
requires_architecture
requires_research
risk_level

task_domain:
  frontend
  backend
  database
  devops
  security
  testing
  research
  documentation
  general
```

The same classification result should feed:

- model routing;
- agent routing;
- skill routing;
- initial risk context.

Do not make three independent classifier calls for the same prompt when one
batch can provide all signals.

## 9. Use case 1 — Auto Mode permissions

### Inputs to Jev

Classify independent facts:

```text
is_read_only
modifies_project_files
modifies_files_outside_workspace
destructive
reversible
changes_vcs_history
external_side_effect
executes_downloaded_code
reads_secrets
transmits_data
requires_privilege_escalation
```

### Local policy

Suggested policy behavior:

```text
obviously safe + high confidence
    -> allow

ambiguous
    -> ask

dangerous + high confidence
    -> ask or deny according to local policy

classifier unavailable
    -> never blanket allow
```

Fail-safe default:

- read-only requests can preserve OpenCode's original result;
- mutating requests fall back to `ask`;
- destructive/external-side-effect requests fall back to `ask`.

Keep `denyHighRisk` configurable. Default behavior should favor user review
over silent hard-denial unless policy explicitly asks for denial.

## 10. Use case 2 — Model router

Route once per user task/prompt, not after every tool call.

Suggested tier decision:

```text
simple + low risk + high confidence
    -> fast

complex/deep reasoning/high risk above threshold
    -> deep

otherwise
    -> normal
```

Requirements:

- execution models configured by user;
- no model names exposed to Jev;
- classifier sees abstract task properties only;
- routing result sticky for the active prompt/task;
- manual user model selection must take precedence when Auto routing is not
  selected;
- avoid model oscillation during a single task.

### V2 improvement over 1.18

Remove:

```text
router.sticky
lastRoutedModel
TUI restoration inference
virtual provider fake inference endpoint
```

Prefer a first-class selectable router mode plus a native execution-model switch.

## 11. Use case 3 — Agent and Jev-gated skill routing

Agent routing may reuse the initial task/domain classification.

Skill routing has a stricter requirement: **the execution model must not receive
the native catalog of all available skills or their descriptions**.

The intended pipeline is:

```text
OpenCode skill registry
        |
        v
compact candidate catalog
(name + description only)
        |
        v
Jev relevance classification
        |
        v
selected skill(s)
        |
        +--> native V2 skill attachment/load, if supported
        |
        +--> exact selected skill name(s) only
             visible to execution model
```

The execution model must never be given the full skill catalog just so it can
decide which skill to use. Jev performs that discovery/routing step.

Requirements:

- remove/suppress OpenCode's ambient available-skill guidance before the
  execution-model request;
- send only bounded skill name + description candidates to Jev;
- never send skill locations or bodies merely for routing;
- expose only selected skill name(s) to the execution model;
- load skill bodies lazily only after selection;
- default to no skill when confidence is below threshold;
- bound candidate count and selected count;
- do not use a static `domain -> skill` map as the primary selector.

Example logical configuration:

```jsonc
{
  "agents": {
    "byDomain": {
      "frontend": "frontend",
      "backend": "backend",
      "database": "database",
      "security": "security"
    }
  },
  "skills": {
    "minimumProbability": 0.70,
    "maxCandidates": 32,
    "maxSelected": 1
  }
}
```

In V2, prefer a native skill attachment/load API after Jev selection. Native
attachment must not re-introduce the full catalog into the model context.

## 12. Use case 4 — Context filtering/ranking

Activate only when there is enough candidate context to justify classifier cost.

Good targets:

- grep results;
- LSP results;
- semantic search candidates;
- MCP result lists;
- large tool outputs;
- code-navigation candidate sets.

Do **not** blindly rank or discard arbitrary conversation history.

Pipeline:

```text
candidate extraction
    |
    v
bounded normalization
    |
    v
Jev rank / relevance score
    |
    v
top K + threshold
    |
    v
V2 context hook
```

Preserve unconditionally:

- latest user prompt;
- system instructions;
- current error;
- current diff/mutation evidence;
- permission decisions;
- latest critical tool result;
- verification evidence needed to determine completion.

Suggested defaults:

```text
minimumCandidates = 20
topK = 12
relevantAt = 0.55
```

The exact batch/candidate limit must be matched to the System One endpoint
available at migration time.

Context filtering is the last major feature to migrate because accidental
information loss has the highest correctness risk.

## 13. Use cases 5 and 6 — Loop controller and failure triage

Failure triage is not a standalone user-visible subsystem. It feeds the loop
controller and permission/Auto Mode decisions.

The loop controller is **not satisfied by a round counter plus circuit breaker**.
It must be an explicit state machine whose decisions affect which actions the
agent may take next.

Required states:

```text
WORK
RETRY
VERIFY
FINISH
HUMAN
```

Required transition shape:

```text
WORK
  ├─ safe transient failure ──> RETRY
  ├─ mutation completed ──────> VERIFY
  ├─ sufficient evidence ─────> FINISH
  └─ user input/auth needed ──> HUMAN

RETRY
  ├─ successful retry ────────> WORK / next classified state
  └─ repeated failure ────────> HUMAN

VERIFY
  ├─ sufficient validation ───> FINISH
  ├─ failing validation ──────> WORK
  └─ weak validation ─────────> VERIFY

FINISH / HUMAN
  └─ further agent tool work is blocked
```

Jev provides probabilistic evidence for ambiguous transitions. Local policy
owns hard constraints such as mutation -> VERIFY, max-round termination, and
blocking tools in FINISH/HUMAN.

### Runtime state

Suggested V2 state:

```ts
interface SessionTaskState {
  taskId: string
  route?: {
    modelTier?: "fast" | "normal" | "deep"
    agent?: string
    skills?: string[]
  }

  round: number
  toolCalls: number
  failures: FailureRecord[]
  mutations: MutationRecord[]
  verificationEvidence: VerificationRecord[]

  lastDecision?: LoopDecision

  status:
    | "working"
    | "verify"
    | "retry"
    | "finish"
    | "human"
}
```

### Failure classes

```text
transient
environment
permission
invalid_input
dependency
test_failure
code_bug
tool_bug
unknown
```

Additional signals:

```text
retry_same_action
retry_modified_action
requires_code_change
requires_user
```

Examples:

```text
429 / temporary transport failure
    -> retry when safe

assertion/test failure
    -> fix code, then verify

permission/root/credential failure
    -> human/permission path

same failure repeatedly
    -> circuit breaker
```

### Circuit breakers

At minimum:

- max loop rounds;
- repeated identical failure;
- repeated identical action without progress;
- budget exceeded;
- runaway agent/tool loop.

When V2 exposes a proper loop-completion/stop primitive, use it rather than the
1.18 pattern of system instructions + `session.abort()`.

## 14. Use case 9 — Post-action verification

Every meaningful mutation should create a verification requirement.

Examples:

```text
source edit
    -> syntax/type validation
    -> relevant tests
    -> task-intent check

dependency/config change
    -> install/build/config validation

deployment/external action
    -> inspect resulting state where possible
```

State transition:

```text
mutation
    |
    v
verification pending
    |
    +-- failed evidence --> working/retry
    |
    +-- weak evidence ---> verify
    |
    +-- sufficient ------> finish
```

Jev should classify evidence, not replace objective checks.

Useful signals:

```text
diff_consistent_with_request
output_contains_failure
modified_path_covered_by_validation
requested_behavior_exercised
verification_sufficient
```

Deterministic evidence must dominate classifier opinion:

- process exit status;
- test result;
- compiler/typechecker result;
- lint/build result;
- actual diff/path coverage.

## 15. Privacy

Data minimization remains a core requirement.

Default behavior:

- do not send complete conversation history;
- do not send the entire repository;
- do not send full files unless explicitly required;
- do not store raw classifier payloads in audit logs.

Suggested payload scopes:

### Permission

Send only:

- action/tool type;
- command or normalized arguments;
- path/resource scope;
- minimal metadata needed for risk classification.

### Routing

Send:

- bounded current user prompt;
- minimal project/language metadata if needed.

### Context ranking

Send only:

- candidates being ranked.

### Verification/failure triage

Send:

- bounded error/output evidence;
- task statement;
- minimal mutation metadata.

### Audit record

Store:

```text
timestamp
decision kind
classifier model
latency
probabilities
local-policy outcome
payload hash
```

Do not store the raw payload by default.

## 16. Cache

Suggested cache key:

```text
classifier version
+ policy version
+ decision kind
+ normalized state hash
```

Suggested lifetimes:

- permission classification: 30–60 seconds;
- task routing: lifetime of the task/prompt;
- context ranking: keyed by task + result hash;
- verification/failure evidence: keyed by normalized evidence hash.

Never reuse context-sensitive decisions across unrelated projects.

## 17. Explainability / admin UX

If the shipped V2 API supports custom commands, add:

```text
/autopilot status
/autopilot on
/autopilot off
/autopilot safe
/autopilot balanced
/autopilot aggressive
/autopilot explain
/autopilot stats
```

`/autopilot explain` should show, without exposing hidden model reasoning:

- last decision type;
- Jev signals/probabilities;
- local threshold/policy applied;
- selected model tier/model;
- selected agent/skills;
- permission result;
- latency;
- verification state.

Do not claim support for these commands until the shipped V2 command-extension
API has been verified.

## 18. Proposed source layout

Refactor toward:

```text
src/
├── index.ts
├── config/
│   ├── schema.ts
│   └── defaults.ts
├── providers/
│   ├── provider.ts
│   ├── opencode-zen.ts
│   ├── typesafe.ts
│   └── systemone.ts
├── decision/
│   ├── engine.ts
│   ├── request-builder.ts
│   └── thresholds.ts
├── permissions/
│   ├── evaluator.ts
│   ├── policy.ts
│   └── evidence.ts
├── routing/
│   ├── classifier.ts
│   ├── model.ts
│   ├── agent.ts
│   └── skill.ts
├── context/
│   ├── candidates.ts
│   ├── ranker.ts
│   └── filter.ts
├── loop/
│   ├── controller.ts
│   ├── state.ts
│   └── circuit-breaker.ts
├── failures/
│   └── classifier.ts
├── verification/
│   ├── tracker.ts
│   └── verifier.ts
└── audit/
    └── decisions.ts
```

The current pure logic in `classifier.ts`, `permission.ts`,
`verification.ts`, `context.ts`, and the System One client should be reused
where possible instead of rewritten.

## 19. Migration from the current 1.18 implementation

### Remove when equivalent V2 primitives are proven

#### 1.18 model-router workaround

Remove:

- fake OpenAI-compatible virtual inference endpoint;
- message-model rewriting in `chat.message`;
- `router.sticky`;
- `routerActive`;
- `lastRoutedModel`;
- inference based on the TUI restoring the last routed model.

Replace with native V2 model-selection/runtime switching.

#### Permission workaround

Remove:

- asynchronous permission-event interception;
- duplicated support for legacy/current permission envelopes if V2 has a single
  normalized permission hook;
- SDK `permission.reply` as the main classifier control path.

Replace with synchronous/native permission evaluation.

#### Skill workaround

Remove the system prompt:

```text
Classifier-selected skills for this task...
```

when V2 can attach skills directly.

#### Failure reconstruction

Remove dependency on:

```text
message.part.updated
part.state.status === "error"
```

when the V2 tool lifecycle gives failure state directly.

#### Hard-stop workaround

Remove the combination of:

- injected "do not call tools" instruction;
- `client.session.abort()`;
- throwing from `tool.execute.before`;

when a first-class loop stop/finalize primitive is available.

#### Credential duplication

Remove `OPENCODE_API_KEY` requirement for Zen if the shipped V2 integration API
can safely resolve the already configured OpenCode credential.

## 20. Migration phases

### Phase 0 — API verification

Before editing production code:

1. install the first OpenCode binary that claims V2 plugin support;
2. identify its exact plugin package/version;
3. build a probe plugin;
4. verify every required hook/control with runtime tests;
5. record actual signatures in this file.

No production migration before Phase 0 passes.

### Phase 1 — V2 compatibility shell

Implement:

- V2 plugin entrypoint;
- configuration parsing;
- provider/credential adapter;
- Decision Engine;
- compatibility tests.

Do not add advanced routing yet.

### Phase 2 — Auto Mode

Implement:

- native permission evaluation hook;
- signal classifier;
- local policy;
- fail-safe behavior;
- audit record.

This should be the first feature migrated because it benefits most directly from
a native permission hook.

### Phase 3 — Model router

Implement:

- selectable Auto/Jev mode;
- native per-task model switching;
- fast/normal/deep mapping;
- task-sticky route;
- manual override behavior.

Delete the 1.18 sticky-router workaround after acceptance tests pass.

### Phase 4 — Agent and skill routing

Implement:

- prompt-level model/domain/agent classification;
- native skill-catalog interception;
- compact skill-candidate extraction;
- separate Jev skill relevance selection;
- removal of the native catalog from execution-model context;
- lazy loading/attachment of only the selected skill(s).

Do not expose every skill description to the execution model.

### Phase 5 — Loop intelligence

Implement:

- explicit `WORK | RETRY | VERIFY | FINISH | HUMAN` task state machine;
- normalized tool lifecycle;
- Jev progress classification after relevant successful tool outcomes;
- failure triage;
- retry-state transitions;
- verification-state enforcement;
- repeated-failure -> HUMAN transition;
- max-round -> FINISH transition;
- native loop stop/finalize control;
- tool enforcement so FINISH/HUMAN are not merely advisory.

### Phase 6 — Verification

Implement:

- mutation tracking;
- VerificationRequirement;
- deterministic evidence collection;
- Jev evidence classification;
- completion gate.

### Phase 7 — Context filtering

Implement last:

- candidate extraction;
- ranking;
- top-K threshold;
- V2 context hook;
- protected evidence set;
- cache.

This stays late because an incorrect filter can silently degrade correctness.

### Phase 8 — UX and observability

Implement if the API supports it:

- status;
- explain;
- stats;
- policy profile selection;
- audit summaries.

### Phase 9 — Hardening

Add:

- provider outage tests;
- malformed response tests;
- permission fuzzing;
- shell/action risk corpus;
- model-router benchmark;
- latency benchmark;
- context-loss regression corpus;
- tool-loop simulations;
- credential failure tests;
- multi-session isolation tests.

## 21. Acceptance scenarios

The V2 migration is not complete until these pass against a real V2-enabled
OpenCode binary.

### Permissions

- read-only command -> auto allow when policy permits;
- reversible project mutation -> allow according to configured policy;
- destructive shell -> ask;
- external side effect -> ask/deny according to policy;
- sensitive-data transmission -> ask/deny;
- classifier unavailable -> safe fallback, never blanket allow;
- ambiguous probability -> ask.

### Model routing

- simple prompt -> configured fast model;
- ordinary prompt -> configured normal model;
- architecture/deep reasoning -> configured deep model;
- classifier unavailable -> configured fallback tier;
- router remains selected without a 1.18-style sticky workaround;
- explicit user override is respected;
- no model oscillation during one task.

### Agent/skills

- high-confidence backend task -> configured backend agent;
- medium-confidence backend task -> relevant skill without forced agent switch;
- low-confidence/general task -> no intervention.

### Context

- large candidate set -> ranked/filtered;
- persisted conversation unchanged;
- latest user prompt preserved;
- critical error/diff/verification evidence preserved;
- classifier failure -> original context preserved.

### Loop/failures

- transient failure -> bounded retry;
- test/code failure -> code-fix path;
- permission/credential failure -> human path;
- same failure repeatedly -> circuit breaker;
- max loop rounds -> native stop/finalize behavior.

### Verification

- mutation -> verification pending;
- validation failure -> not allowed to finish;
- weak validation -> request better evidence;
- successful relevant validation -> completion allowed;
- objective test result overrides classifier optimism.

### Privacy

- no whole-repo upload by default;
- no whole-conversation upload by default;
- permission metadata minimized;
- raw classifier payloads absent from audit logs by default.

## 22. Test strategy

Maintain three levels.

### Unit

Pure policy and classifier-response parsing:

- thresholds;
- permission policy;
- route selection;
- failure classification;
- verification policy;
- candidate ranking;
- cache keys;
- privacy truncation.

### Plugin integration

Use the shipped V2 plugin package/types to test:

- hook registration;
- model switching;
- agent switching;
- skill attachment;
- permission evaluation;
- tool state;
- context hook behavior;
- loop stop/finalize behavior.

### Real-binary smoke

Run against the actual V2-enabled OpenCode binary:

```text
/models
permission flow
simple/normal/deep routing
agent routing
skill routing
tool failure
mutation + verification
context-heavy task
circuit breaker
manual model override
```

Do not declare the V2 implementation ready using mocks alone.

## 23. Compatibility/versioning strategy

Do not silently break users on OpenCode 1.18.

At migration time choose one of these based on the ecosystem:

### Preferred

Keep separate package major versions:

```text
opencode-classifier-plugin 0.x/1.x -> OpenCode 1.18 classic API
opencode-classifier-plugin next major -> OpenCode V2 API
```

Document the OpenCode compatibility matrix prominently.

### Alternative

If the package can reliably detect the host API without importing incompatible
modules, ship separate entrypoints/adapters behind one package.

Do not attempt runtime duck-typing if simply importing the V2 package causes the
1.18 host to fail.

## 24. Documentation changes at V2 release

When migration happens:

- update README target runtime;
- remove 1.18 picker/sticky limitation;
- document native model switching;
- document native permission evaluation;
- document direct skill attachment if available;
- document reuse of OpenCode credentials if available;
- add compatibility matrix;
- retain this file as migration history or convert it into a completed design
  record.

## 25. Definition of done

The V2 migration is complete only when:

- the official installed OpenCode binary loads the plugin;
- all required V2 hooks are exercised in runtime, not merely present in types;
- `npm run typecheck` passes;
- unit/integration tests pass;
- real-binary smoke tests pass;
- Auto Mode fails safely;
- model routing does not require the 1.18 sticky workaround;
- manual model override works;
- skill routing uses the best native mechanism available;
- context filtering cannot mutate persisted history;
- mutation verification gates completion;
- loop control has a reliable V2 stop path;
- privacy defaults remain restrictive;
- README and compatibility matrix match the shipped behavior.

---

## V2 migration checklist

```text
[ ] Official V2-enabled OpenCode binary released
[ ] Exact V2 plugin package/version identified
[ ] Probe plugin passes against real binary
[ ] Permission evaluation hook verified
[ ] Model switching verified
[ ] Agent switching verified
[ ] Skill API verified
[ ] Tool success/failure lifecycle verified
[ ] Context hook verified
[ ] Credential/integration API verified
[ ] Loop stop/finalize primitive verified

[ ] V2 entrypoint implemented
[ ] Decision provider ported
[ ] Auto Mode ported
[ ] Model router ported
[ ] 1.18 sticky workaround removed
[ ] Agent router ported
[ ] Skill router ported
[ ] Native skill catalog hidden from execution-model context
[ ] Jev selects skills from bounded name+description candidates
[ ] Failure triage ported
[ ] WORK/RETRY/VERIFY/FINISH/HUMAN loop state machine ported
[ ] Verification ported
[ ] Context filtering ported
[ ] Audit/cache/privacy ported

[ ] Unit tests pass
[ ] V2 integration tests pass
[ ] Real-binary smoke tests pass
[ ] Compatibility/versioning strategy finalized
[ ] README updated
[ ] Release package dry-run verified
```
