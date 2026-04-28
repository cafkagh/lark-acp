import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentBackend, SpawnSpec } from "./types.js";

// Claude ACP server. Provided by `@agentclientprotocol/claude-agent-acp`
// (binary `claude-agent-acp`). Wraps the Claude Agent SDK so it speaks ACP.

const PKG = "@agentclientprotocol/claude-agent-acp";

function localBinary(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidate = `${here}/../../node_modules/.bin/claude-agent-acp`;
    if (existsSync(candidate)) return candidate;
  } catch {}
  return null;
}

export const claudeBackend: AgentBackend = {
  name: "claude",
  label: "Claude Code",
  resolveSpawn(cwd: string): SpawnSpec | null {
    const override = process.env.AGENT_CLAUDE_CMD;
    if (override) {
      const parts = override.split(/\s+/).filter(Boolean);
      return { command: parts[0], args: parts.slice(1), env: {} };
    }
    const local = localBinary();
    if (local) return { command: local, args: [], env: {} };
    return { command: "npx", args: ["-y", PKG], env: {} };
  },
  promptPreamble: undefined,
};
