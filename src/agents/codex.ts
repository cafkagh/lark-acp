import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentBackend, SpawnSpec } from "./types.js";

// Codex ACP server. Provided by `@zed-industries/codex-acp` (binary `codex-acp`).
// Auth comes from one of: CODEX_API_KEY, OPENAI_API_KEY, or a logged-in
// ChatGPT subscription (handled internally by codex-acp). We don't attempt
// to reason about auth — if the binary fails on launch the stderr surfaces
// in the bot log and the user sees an error in the card.

const PKG = "@zed-industries/codex-acp";

function localBinary(): string | null {
  // Resolve the binary that npm dropped under our own node_modules so we
  // don't depend on global PATH or a separate `npx` round-trip.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/agents/codex.ts → ../../node_modules/.bin/codex-acp
    const candidate = `${here}/../../node_modules/.bin/codex-acp`;
    if (existsSync(candidate)) return candidate;
  } catch {}
  return null;
}

export const codexBackend: AgentBackend = {
  name: "codex",
  label: "Codex",
  resolveSpawn(cwd: string): SpawnSpec | null {
    const override = process.env.AGENT_CODEX_CMD;
    if (override) {
      const parts = override.split(/\s+/).filter(Boolean);
      return { command: parts[0], args: parts.slice(1), env: {} };
    }
    const local = localBinary();
    if (local) return { command: local, args: [], env: {} };
    // Fallback: rely on PATH / npx. This adds a one-time download cost but
    // works for users who didn't run our `npm install` yet.
    return { command: "npx", args: ["-y", PKG], env: {} };
  },
  promptPreamble: undefined, // applied by bridge
};
