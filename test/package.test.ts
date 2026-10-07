import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"

import { resolveOptions } from "../src/config.ts"

/**
 * The entrypoint is verified structurally, not by importing it: `index.ts`
 * pulls in the V1 and V2 adapters, whose runtime linkage is covered by the
 * adapter test suites. Reading the source keeps this package-level suite
 * independent of adapter work in progress.
 */
test("published entrypoint declares a dual V1/V2 export", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8")

  assert.match(source, /from "\.\/src\/v1\.ts"/)
  assert.match(source, /from "\.\/src\/v2\.ts"/)
  assert.match(source, /export \{ OpenCodeClassifierPlugin \}/)
  assert.match(source, /export default/)
  assert.match(source, /id:\s*"opencode-classifier-plugin"/)
  assert.match(source, /setup:\s*setupV2/)
  assert.match(source, /server:\s*OpenCodeClassifierPlugin/)
})

test("package manifest targets the classic OpenCode plugin API", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  )

  assert.equal(manifest.name, "opencode-classifier-plugin")
  assert.equal(manifest.type, "module")
  assert.equal(manifest.exports["."], "./index.ts")
  assert.equal(manifest.dependencies["@opencode/plugin"], "^2.0.15")
  assert.equal(manifest.devDependencies["@opencode-ai/plugin"], "1.18.32")
  assert.equal(manifest.prepublishOnly, undefined)
  assert.equal(
    manifest.scripts.prepublishOnly,
    "npm run check && npm run pack:check",
  )
  assert.ok(manifest.files.includes("index.ts"))
  assert.ok(manifest.files.includes("src"))
  assert.ok(manifest.files.includes("README.md"))
  assert.ok(manifest.files.includes("opencode.example.json"))
  assert.ok(manifest.files.includes("opencode.example.jsonc"))
})

test("resolveOptions works with zero routing configuration", () => {
  const resolved = resolveOptions({}).routing.models

  assert.equal(resolved.enabled, true)
  assert.equal(resolved.safetyMargin, 0.1)
  assert.deepEqual(resolved.exclude, [])
  assert.deepEqual(resolved.providerPools, {})
  assert.match(resolved.referenceCatalog, /opencode\/models\.json$/)
  assert.equal(resolved.quota.enabled, true)
  assert.equal(resolved.quota.binary, "ai-usagebar")
  assert.deepEqual(resolved.quota.args, ["usage", "--json"])
  assert.deepEqual(resolved.quota.vendorArgs, ["vendors", "--json"])
  assert.equal(resolved.quota.timeoutMs, 8000)
  assert.equal(resolved.quota.refreshSeconds, 120)
  assert.deepEqual(resolved.thresholds, {
    fastChoice: 0.72,
    deepChoice: 0.58,
    deepReasoning: 0.72,
    highRisk: 0.72,
  })
})

test("routing options parse and clamp out-of-range values", () => {
  const resolved = resolveOptions({
    routing: {
      models: {
        enabled: false,
        safetyMargin: 5,
        exclude: ["corp-proxy", " ", 3],
        providerPools: { "my-proxy": "anthropic", bad: 1 },
        referenceCatalog: "/tmp/models.json",
        quota: {
          binary: "usagebar-mock",
          args: ["--json"],
          timeoutMs: 10,
          refreshSeconds: 999_999,
        },
        thresholds: { fastChoice: 4 },
      },
    },
  }).routing.models

  assert.equal(resolved.enabled, false)
  assert.deepEqual(resolved.exclude, ["corp-proxy"])
  assert.deepEqual(resolved.providerPools, { "my-proxy": "anthropic" })
  assert.equal(resolved.referenceCatalog, "/tmp/models.json")
  assert.equal(
    resolveOptions({ routing: { models: { referenceCatalog: "~/models.json" } } }).routing.models.referenceCatalog,
    `${homedir()}/models.json`,
  )
  assert.equal(resolved.safetyMargin, 0.9)
  assert.equal(resolved.quota.binary, "usagebar-mock")
  assert.deepEqual(resolved.quota.args, ["--json"])
  assert.equal(resolved.quota.timeoutMs, 500)
  assert.equal(resolved.quota.refreshSeconds, 3600)
  assert.equal(resolved.thresholds.fastChoice, 1)
})

test("a group switch turns off every feature in the group", () => {
  // Given
  const allOn = {
    routing: { models: { enabled: true }, agents: { enabled: true } },
    context: { toolOutput: { enabled: true }, capabilities: { enabled: true } },
  }

  // When
  const groupsOff = resolveOptions({
    routing: { ...allOn.routing, enabled: false },
    context: { ...allOn.context, enabled: false },
  })
  const oneFeatureOff = resolveOptions({
    routing: { ...allOn.routing, agents: { enabled: false } },
    context: { ...allOn.context, capabilities: { enabled: false } },
  })

  // Then
  assert.equal(groupsOff.routing.models.enabled, false)
  assert.equal(groupsOff.routing.agents.enabled, false)
  assert.equal(groupsOff.context.toolOutput.enabled, false)
  assert.equal(groupsOff.context.capabilities.enabled, false)
  assert.equal(oneFeatureOff.routing.models.enabled, true)
  assert.equal(oneFeatureOff.routing.agents.enabled, false)
  assert.equal(oneFeatureOff.context.toolOutput.enabled, true)
  assert.equal(oneFeatureOff.context.capabilities.enabled, false)
})

test("top-level agents and capabilities blocks are not read", () => {
  // When
  const resolved = resolveOptions({
    agents: { enabled: true },
    capabilities: { enabled: false },
  })

  // Then
  assert.equal(resolved.routing.agents.enabled, false)
  assert.equal(resolved.context.capabilities.enabled, true)
})

test("a legacy router block is ignored", () => {
  const resolved = resolveOptions({
    router: {
      enabled: false,
      models: { fast: "opencode/gpt-5.6-sol" },
    },
  })

  assert.equal(resolved.routing.models.enabled, true)
  assert.equal("router" in resolved, false)
})

test("opencode.example.json uses the 1.18 plugin tuple shape", async () => {
  const config = JSON.parse(
    await readFile(new URL("../opencode.example.json", import.meta.url), "utf8"),
  )

  assert.ok(Array.isArray(config.plugin))
  assert.equal(config.plugin.length, 1)
  assert.ok(Array.isArray(config.plugin[0]))
  assert.equal(config.plugin[0][0], "opencode-classifier-plugin")

  const options = config.plugin[0][1] as Record<string, unknown>
  assert.equal("router" in options, false)
  assert.deepEqual(Object.keys(options.routing as object), ["enabled", "models", "agents"])
  assert.deepEqual(Object.keys(options.context as object), ["enabled", "toolOutput", "capabilities"])

  const resolved = resolveOptions(options)
  assert.equal(resolved.routing.models.enabled, true)
  assert.deepEqual(resolved.autoMode.commandRules, {
    ask: ["git push *", "npm publish"],
    deny: ["git push --force *"],
  })
  assert.equal(resolved.context.toolOutput.maxBatches, 4)
  assert.equal(resolved.decision.model, "jev-1.13-free")
  assert.equal("integrationID" in resolved.decision, false)
})

/**
 * Removes full-line `//` comments so a JSONC document parses as JSON.
 * The example file only uses whole-line comments, so string contents
 * such as URLs survive unchanged.
 */
function stripJsoncLineComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
}

test("opencode.example.jsonc uses the V2 plugins object shape", async () => {
  const raw = await readFile(
    new URL("../opencode.example.jsonc", import.meta.url),
    "utf8",
  )
  const config = JSON.parse(stripJsoncLineComments(raw))

  assert.ok(Array.isArray(config.plugins))
  assert.equal(config.plugins.length, 1)
  assert.equal(config.plugins[0].package, "opencode-classifier-plugin")

  const options = config.plugins[0].options as Record<string, unknown>
  assert.equal("router" in options, false)
  assert.equal((options.routing as Record<string, unknown>).enabled, true)

  const resolved = resolveOptions(options)
  assert.equal(resolved.routing.models.enabled, true)
  assert.equal(resolved.autoMode.enabled, true)
  assert.equal(resolved.decision.model, "jev-1.13-free")
})
