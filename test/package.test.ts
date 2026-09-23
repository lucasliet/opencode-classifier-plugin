import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import plugin from "../src/index.ts"
import { resolveOptions } from "../src/config.ts"

test("published entrypoint exports an OpenCode 1.18 plugin function", () => {
  assert.equal(typeof plugin, "function")
})

test("package manifest targets the classic OpenCode plugin API", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  )

  assert.equal(manifest.name, "opencode-classifier-plugin")
  assert.equal(manifest.type, "module")
  assert.equal(manifest.exports["."], "./index.ts")
  assert.equal(manifest.dependencies, undefined)
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
})

test("opencode.example.json uses the 1.18 plugin tuple shape", async () => {
  const config = JSON.parse(
    await readFile(new URL("../opencode.example.json", import.meta.url), "utf8"),
  )

  assert.ok(Array.isArray(config.plugin))
  assert.equal(config.plugin.length, 1)
  assert.ok(Array.isArray(config.plugin[0]))
  assert.equal(config.plugin[0][0], "opencode-classifier-plugin")

  const resolved = resolveOptions(config.plugin[0][1])
  assert.equal(resolved.router.enabled, true)
  assert.deepEqual(resolved.router.efforts, {
    fast: "low",
    normal: "medium",
    deep: "high",
  })
  assert.deepEqual(resolved.autoMode.commandRules, {
    ask: ["git push *", "npm publish"],
    deny: ["git push --force *"],
  })
  assert.equal(resolved.context.maxBatches, 4)
  assert.equal(resolved.decision.model, "jev-1.13-free")
  assert.equal("integrationID" in resolved.decision, false)
})
