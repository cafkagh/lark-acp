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
   * Optional system-style hint to prepend to every user prompt. ACP has no
   * standard system-prompt slot — the agent's setup is opaque to us — so we
   * piggyback on the prompt itself. Cost is ~150 tokens per turn.
   */
  promptPreamble?: string;
  /**
   * Quick liveness check at startup so /status can show which backends are
   * usable. Default impl in registry just checks resolveSpawn returns
   * non-null; backends can override to e.g. probe API keys.
   */
  available?(): Promise<{ ok: boolean; reason?: string }>;
}
