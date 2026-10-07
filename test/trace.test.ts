import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveOptions } from "../src/config.ts"
import { createTracer, defaultTracePath, tracePathOf } from "../src/trace.ts"

test("tracing is off unless a log file, the env variable or debug enables it", () => {
  // Given
  const env = { XDG_STATE_HOME: "/state" }

  // When
  const off = tracePathOf({ debug: false, logFile: "" }, env)
  const fromEnv = tracePathOf({ debug: false, logFile: "" }, { ...env, OPENCODE_CLASSIFIER_LOG: "/env.log" })
  const configured = tracePathOf({ debug: false, logFile: "/config.log" }, { ...env, OPENCODE_CLASSIFIER_LOG: "/env.log" })
  const debugDefault = tracePathOf({ debug: true, logFile: "" }, env)

  // Then
  assert.equal(off, undefined)
  assert.equal(fromEnv, "/env.log")
  assert.equal(configured, "/config.log")
  assert.equal(debugDefault, "/state/opencode/opencode-classifier-plugin.log")
  assert.equal(defaultTracePath(env), debugDefault)
})

test("the configured log file is created with its directory and kept private", () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "trace-test-"))
  const logFile = join(root, "nested", "plugin.log")
  const trace = createTracer({ debug: false, logFile })

  try {
    // When
    trace("v2 setup", { version: "test" })

    // Then
    assert.match(readFileSync(logFile, "utf8"), /v2 setup \{"version":"test"\}\n$/)
    assert.equal(statSync(logFile).mode & 0o777, 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("logFile resolves from the config with the home directory expanded", () => {
  // When
  const unset = resolveOptions({}).logFile
  const homeRelative = resolveOptions({ logFile: "~/logs/plugin.log" }).logFile

  // Then
  assert.equal(unset, "")
  assert.ok(homeRelative.endsWith("/logs/plugin.log"))
  assert.ok(!homeRelative.startsWith("~"))
})
