// Copy runtime assets (not produced by tsc) into dist/.
// Source of truth: runtime-assets/ — cross-platform (Node >= 20, no shell deps).
// Exit non-zero if any source is missing, so a stale dist cannot be silently produced.
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Assets whose exact bytes must be shipped verbatim into dist/.
const ASSETS = [
  { src: "runtime-assets/orchestrator-launcher.cjs", dest: "dist/orchestrator-launcher.cjs" },
];

let failed = false;
for (const { src, dest } of ASSETS) {
  const srcPath = join(root, src);
  const destPath = join(root, dest);
  if (!existsSync(srcPath)) {
    console.error(`[copy-runtime-assets] ERROR: source missing: ${srcPath}`);
    failed = true;
    continue;
  }
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(srcPath, destPath);
  console.log(`[copy-runtime-assets] copied ${src} -> ${dest}`);
}
if (failed) {
  console.error("[copy-runtime-assets] FAILED");
  process.exit(1);
}
console.log(`[copy-runtime-assets] done: ${ASSETS.length} asset(s) copied`);
