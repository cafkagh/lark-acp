import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentBackend, SpawnSpec } from "./types.js";
import { BOT_RELAY_PREAMBLE } from "../preamble.js";

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

// Encode a string as a TOML basic-string literal (double-quoted, with
// JSON-style escapes). codex-acp's `-c key=value` parses the value side as
// TOML, so multi-line content needs `\n` escapes; embedded quotes need `\"`.
// Reference: codex-rs/utils/cli/src/config_override.rs.
function tomlBasicString(s: string): string {
  return '"' + s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    + '"';
}

// Build the `-c developer_instructions=...` override that pre-loads our
// bot-relay preamble as a developer-role message at codex process startup
// (codex-rs/core/src/config/mod.rs:2614,2838). It applies to every session
// this process serves, so per-(chatId, cwd) pooling makes it effectively
// per-chat. Lets us skip per-turn prompt prefixing entirely.
const PREAMBLE_OVERRIDE = `developer_instructions=${tomlBasicString(BOT_RELAY_PREAMBLE)}`;

export const codexBackend: AgentBackend = {
  name: "codex",
  label: "Codex",
  resolveSpawn(cwd: string): SpawnSpec | null {
    const override = process.env.AGENT_CODEX_CMD;
    if (override) {
      const parts = override.split(/\s+/).filter(Boolean);
      return { command: parts[0], args: [...parts.slice(1), "-c", PREAMBLE_OVERRIDE], env: {} };
    }
    const local = localBinary();
    if (local) return { command: local, args: ["-c", PREAMBLE_OVERRIDE], env: {} };
    // Fallback: rely on PATH / npx. This adds a one-time download cost but
    // works for users who didn't run our `npm install` yet.
    return { command: "npx", args: ["-y", PKG, "-c", PREAMBLE_OVERRIDE], env: {} };
  },
  // No perTurnPreamble — preamble is injected via the spawn-time
  // `-c developer_instructions=...` override above.
};
