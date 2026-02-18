import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

const candidates = [
  "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
  "node_modules/node-pty/prebuilds/darwin-x64/spawn-helper"
];

for (const rel of candidates) {
  const target = join(process.cwd(), rel);
  if (!existsSync(target)) {
    continue;
  }

  try {
    chmodSync(target, 0o755);
    console.log(`[postinstall] ensured executable: ${rel}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[postinstall] failed to chmod ${rel}: ${message}`);
  }
}
