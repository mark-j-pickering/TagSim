import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";

// Baked in at build time so a saved trail (see buildSaveData in tag-steering-simulator.jsx) can be
// traced back to the exact code that produced it — useful whenever a trail's behaviour is being
// compared across edits to the steering/autopilot logic. "-dirty" flags a build made from a working
// tree with uncommitted changes, so a save taken mid-edit doesn't silently claim a clean match to a
// commit it doesn't actually reflect. Falls back to "unknown" outside a git checkout (e.g. a source
// archive with no .git directory) rather than failing the build over a non-essential label.
function readGitCommit() {
  try {
    const hash = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const dirty = execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().length > 0;
    return dirty ? `${hash}-dirty` : hash;
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? "/TagSim/" : "/",
  define: {
    __APP_COMMIT__: JSON.stringify(readGitCommit()),
  },
  plugins: [react()],
  server: {
    // 5173 is Vite's own default and collides with other projects on this
    // machine (Windows dual-stack binding can then route "localhost" to the
    // wrong app instead of erroring). Use a less common port, and fail
    // loudly on conflict rather than silently retrying elsewhere.
    port: process.env.PORT ? Number(process.env.PORT) : 5183,
    strictPort: true,
  },
});
