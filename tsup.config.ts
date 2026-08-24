import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/tui.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "es2022",
  external: ["@opencode-ai/plugin", "@opentui/core", "@opentui/solid", "@opentui/keymap"],
})
