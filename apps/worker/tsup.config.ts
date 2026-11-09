import { defineConfig } from "tsup";

// Workspace packages ship TypeScript source, so they are bundled in; npm dependencies stay external.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  external: ["@prisma/client", "@livekit/rtc-node"],
  noExternal: ["@zuum/shared", "@zuum/db"],
});
