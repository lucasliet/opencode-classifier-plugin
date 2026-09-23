import { Plugin } from "@opencode/plugin"
import { OpenCodeClassifierPlugin } from "./src/v1.ts"
import { setupV2 } from "./src/v2.ts"

export { OpenCodeClassifierPlugin }

/**
 * Dual OpenCode entrypoint.
 *
 * - V2 (>= 2.0) reads `id` + `setup()` and ignores `server()`.
 * - V1 (>= 1.18.29) calls `server()` and ignores `id`/`setup()`.
 */
export default {
  ...Plugin.define({
    id: "opencode-classifier-plugin",
    setup: setupV2,
  }),
  server: OpenCodeClassifierPlugin,
}
