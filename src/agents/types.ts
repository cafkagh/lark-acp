// AgentBackend: a thin description of how to spawn an ACP server subprocess.
// Each backend type (codex / claude / future) supplies one of these.

export type SpawnSpec = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export interface AgentBackend {
  /** Stable lowercase name used in commands (`/agent codex`) and on disk. */
  name: string;
  /** Human-readable label for status / footer. */
  label: string;
  /**
   * Resolve the spawn command for this backend in the given workdir.
   * Returning null means the backend is unavailable (e.g. missing creds).
   */
  resolveSpawn(cwd: string): SpawnSpec | null;
  /**
   * If set, the bridge prepends this text to every user prompt. Use for
   * backends that don't expose a session-level system-prompt slot. Cost is
   * paid per turn (typically prompt-cached on the API side).
   */
  perTurnPreamble?: string;
  /**
   * If set, gets merged into ACP `_meta` on session/new + session/load +
   * session/resume calls. Use for backends that DO expose a session-level
   * system-prompt slot via `_meta` (e.g. claude-agent-acp:
   * `_meta.systemPrompt = { append }`). Injected once per session lifetime,
   * cheaper than per-turn prepending.
   */
  sessionMeta?: Record<string, unknown>;
  /**
   * Quick liveness check at startup so /status can show which backends are
   * usable. Default impl in registry just checks resolveSpawn returns
   * non-null; backends can override to e.g. probe API keys.
   */
  available?(): Promise<{ ok: boolean; reason?: string }>;
}
