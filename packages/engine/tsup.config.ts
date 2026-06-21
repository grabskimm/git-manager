import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Native and node deps stay external; only our source is bundled.
  skipNodeModulesBundle: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
