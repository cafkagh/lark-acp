import type { AgentBackend } from "./types.js";
import { codexBackend } from "./codex.js";
import { claudeBackend } from "./claude.js";
import { AGENT_DEFAULT } from "../config.js";

const REGISTRY = new Map<string, AgentBackend>();

function register(b: AgentBackend) {
  REGISTRY.set(b.name, b);
}

// Order = display order in /agent listing.
register(codexBackend);
register(claudeBackend);

export function listBackends(): AgentBackend[] {
  return [...REGISTRY.values()];
}

export function getBackend(name: string): AgentBackend | undefined {
  return REGISTRY.get(name.toLowerCase());
}

export function getDefaultBackend(): AgentBackend {
  return REGISTRY.get(AGENT_DEFAULT) ?? codexBackend;
}

export function isKnownBackend(name: string): boolean {
  return REGISTRY.has(name.toLowerCase());
}
