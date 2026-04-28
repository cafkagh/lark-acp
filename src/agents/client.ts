import { spawn, ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  ClientSideConnection,
  ndJsonStream,
  type Agent,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type PromptResponse,
  type ContentBlock,
  type SessionInfo as AcpSessionInfo,
  type ListSessionsResponse,
  type SessionModelState,
} from "@agentclientprotocol/sdk";

import { log } from "../log.js";
import { atomicWriteFile } from "../lock.js";
import {
  BOT_HOME, AGENT_IDLE_EVICT_SECS, AGENT_CANCEL_GRACE_MS,
} from "../config.js";
import type { AgentBackend } from "./types.js";

// ACP protocol version we negotiate. The peer will downgrade if it only
// supports an earlier one. Bumping requires re-checking session/load shape.
const PROTOCOL_VERSION = 1;

// Where we cache per-(chat, agent) ACP session ids. Format:
//   $BOT_HOME/lark-acp-sessions/<chatId>/<agent>
// One id per file so it's atomic to write/read.
const SESS_ROOT = join(BOT_HOME, "lark-acp-sessions");

function sessionFile(chatId: string, agent: string): string {
  return join(SESS_ROOT, chatId, agent);
}

export function readPersistedSessionId(chatId: string, agent: string): string | null {
  const f = sessionFile(chatId, agent);
  if (!existsSync(f)) return null;
  try { return readFileSync(f, "utf8").trim() || null; } catch { return null; }
}

export function writePersistedSessionId(chatId: string, agent: string, sid: string): void {
  const f = sessionFile(chatId, agent);
  mkdirSync(dirname(f), { recursive: true });
  atomicWriteFile(f, sid);
}

export function clearPersistedSessionId(chatId: string, agent: string): void {
  try { rmSync(sessionFile(chatId, agent), { force: true }); } catch {}
}

// ---------- callbacks the bridge supplies for one prompt turn ----------
export type PromptCallbacks = {
  onUpdate(notif: SessionNotification): void;
  /**
   * Called when the agent asks for permission (e.g. running a tool). Default
   * behaviour is auto-allow; the bridge passes a function so it could later
   * surface this as a card button. Return null = cancel the turn.
   */
  onPermission?(req: RequestPermissionRequest): Promise<string | null>;
};

// ---------- a live ACP server subprocess + connection ----------
class AgentInstance {
  private proc: ChildProcess;
  private connection: ClientSideConnection;
  private readyPromise: Promise<void>;
  private sessionByChat = new Map<string, string>(); // chatId → ACP sessionId
  private idleTimer: NodeJS.Timeout | null = null;
  private inflight = 0;
  private disposed = false;
  private lastActivityAt = Date.now();
  private capabilities: { loadSession: boolean; resume: boolean; listSessions: boolean } = {
    loadSession: false,
    resume: false,
    listSessions: false,
  };
  // Per-chat model state captured from newSession / loadSession response.
  // Models aren't pushed via SessionUpdate (only modes are), so we maintain
  // it ourselves: snapshot on session creation/load, mutate on setModel.
  // Empty entry means agent doesn't expose models → /model unsupported.
  private modelsByChat = new Map<string, SessionModelState>();
  // Per-active-prompt notification handler, keyed by ACP session id. The
  // ClientSideConnection delivers ALL session/update via a single Client
  // method, so we route by sessionId here.
  private updateRouter = new Map<string, PromptCallbacks>();

  constructor(
    public readonly backend: AgentBackend,
    public readonly cwd: string,
    private readonly onSelfEvict: () => void,
  ) {
    const spawnSpec = backend.resolveSpawn(cwd);
    if (!spawnSpec) {
      throw new Error(`backend ${backend.name} unavailable in this environment`);
    }
    log(`[acp/${backend.name}] spawn ${spawnSpec.command} ${spawnSpec.args.join(" ")} cwd=${cwd}`);
    this.proc = spawn(spawnSpec.command, spawnSpec.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(spawnSpec.env ?? {}) },
    });

    this.proc.stderr?.on("data", (d) => {
      // ACP servers send everything diagnostic to stderr (stdout is reserved
      // for JSON-RPC frames). Surface it in our log so misconfigs (missing
      // API key, bad auth) are visible without strace.
      const s = String(d).trim();
      if (s) log(`[acp/${backend.name} stderr] ${s}`);
    });

    this.proc.on("exit", (code, sig) => {
      log(`[acp/${backend.name}] subprocess exit code=${code} sig=${sig}`);
      // If we exited unexpectedly while turns were in-flight, the
      // connection.closed promise will reject those — we just need to
      // mark ourselves disposed so the manager re-spawns next request.
      this.markDisposed();
    });

    if (!this.proc.stdin || !this.proc.stdout) {
      throw new Error("subprocess missing stdio");
    }
    const stream = ndJsonStream(
      Writable.toWeb(this.proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.proc.stdout) as ReadableStream<Uint8Array>,
    );

    // The SDK constructs the connection in "client" mode by giving us a
    // factory that builds the Client implementation our agent will call back
    // into. `agent` here is the proxy through which we make outgoing requests.
    this.connection = new ClientSideConnection(
      (_agent: Agent): Client => this.buildClientHandler(),
      stream,
    );

    this.readyPromise = this.handshake().catch((e) => {
      log(`[acp/${backend.name}] handshake failed: ${e?.message ?? e}`);
      this.markDisposed();
      throw e;
    });
  }

  private async handshake(): Promise<void> {
    const init = await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "lark-acp", version: "0.1.0" },
      clientCapabilities: {
        // We let the agent run its own filesystem and terminal — same
        // posture as the original bot's bypassPermissions. Advertising
        // false here means the agent shouldn't call back to fs/terminal
        // methods on us; if it does we'll error out.
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    const caps = init.agentCapabilities ?? {};
    const sc = caps.sessionCapabilities ?? {};
    this.capabilities = {
      loadSession: !!caps.loadSession,
      // resume + list nest under sessionCapabilities per current schema.
      // Capabilities use object presence (not boolean) — `{}` means "supported".
      resume: !!sc.resume,
      listSessions: !!sc.list,
    };
    log(
      `[acp/${this.backend.name}] init ok proto=${init.protocolVersion} ` +
      `loadSession=${this.capabilities.loadSession} ` +
      `resume=${this.capabilities.resume} ` +
      `listSessions=${this.capabilities.listSessions}`,
    );
  }

  private buildClientHandler(): Client {
    return {
      sessionUpdate: async (params: SessionNotification) => {
        this.lastActivityAt = Date.now();
        const cb = this.updateRouter.get(params.sessionId);
        if (cb) {
          try { cb.onUpdate(params); } catch (e: any) {
            log(`[acp/${this.backend.name}] onUpdate handler threw: ${e?.message ?? e}`);
          }
        } else {
          // No active prompt for this session; could be a late-arriving
          // tool_call_update after our prompt resolved. Drop silently.
        }
      },
      requestPermission: async (req: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        this.lastActivityAt = Date.now();
        const cb = this.updateRouter.get(req.sessionId);
        let chosenOptionId: string | null = null;
        if (cb?.onPermission) {
          try {
            chosenOptionId = await cb.onPermission(req);
          } catch (e: any) {
            log(`[acp/${this.backend.name}] permission handler threw: ${e?.message ?? e}`);
          }
        }
        if (chosenOptionId === null) {
          // No bridge override → auto-allow. Pick the first option that
          // looks like an "allow" (kind starts with allow_); fall back to
          // option[0]. If the agent supplied no options at all we cancel.
          const opts = req.options ?? [];
          if (opts.length === 0) {
            return { outcome: { outcome: "cancelled" } };
          }
          const allow = opts.find((o) => /^allow/i.test(o.kind)) ?? opts[0];
          chosenOptionId = allow.optionId;
        }
        return { outcome: { outcome: "selected", optionId: chosenOptionId } };
      },
      // We deliberately don't implement fs/terminal — we advertised false.
    };
  }

  isDisposed(): boolean { return this.disposed; }

  private markDisposed() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    // Reject any handlers still waiting via aborting their callbacks.
    this.updateRouter.clear();
  }

  private touchIdleTimer() {
    if (AGENT_IDLE_EVICT_SECS <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.disposed || this.inflight > 0) return;
      log(`[acp/${this.backend.name}] idle evict (${AGENT_IDLE_EVICT_SECS}s no activity) cwd=${this.cwd}`);
      this.dispose("idle").catch(() => {});
      this.onSelfEvict();
    }, AGENT_IDLE_EVICT_SECS * 1000);
    this.idleTimer.unref();
  }

  /**
   * Make sure we have an ACP session id for this chat. Tries (in order):
   *   1. previously persisted id + session/load   (if loadSession capable)
   *   2. previously persisted id + session/resume (if resume capable)
   *   3. session/new                              (always works)
   * Returns the session id we end up using.
   */
  async ensureSession(chatId: string): Promise<string> {
    await this.readyPromise;
    if (this.disposed) throw new Error("agent subprocess gone");
    const cached = this.sessionByChat.get(chatId);
    if (cached) return cached;

    const persisted = readPersistedSessionId(chatId, this.backend.name);
    if (persisted) {
      // Reattaching to an existing session avoids losing prior context.
      // load > resume > new in preference: load replays history (chunky
      // but accurate); resume just continues without replay.
      if (this.capabilities.loadSession) {
        try {
          const loaded = await this.connection.loadSession({
            sessionId: persisted,
            cwd: this.cwd,
            mcpServers: [],
          });
          this.sessionByChat.set(chatId, persisted);
          if (loaded.models) this.modelsByChat.set(chatId, loaded.models);
          log(
            `[acp/${this.backend.name}] loadSession ok sid=${persisted} chat=${chatId}` +
            (loaded.models ? ` model=${loaded.models.currentModelId}` : ""),
          );
          return persisted;
        } catch (e: any) {
          log(`[acp/${this.backend.name}] loadSession failed: ${e?.message ?? e} — falling back to new`);
        }
      } else if (this.capabilities.resume) {
        try {
          const resumed = await this.connection.resumeSession({
            sessionId: persisted,
            cwd: this.cwd,
            mcpServers: [],
          });
          this.sessionByChat.set(chatId, persisted);
          if (resumed.models) this.modelsByChat.set(chatId, resumed.models);
          log(
            `[acp/${this.backend.name}] resumeSession ok sid=${persisted} chat=${chatId}` +
            (resumed.models ? ` model=${resumed.models.currentModelId}` : ""),
          );
          return persisted;
        } catch (e: any) {
          log(`[acp/${this.backend.name}] resumeSession failed: ${e?.message ?? e} — falling back to new`);
        }
      }
      // Persisted id no longer valid for this backend — drop it.
      clearPersistedSessionId(chatId, this.backend.name);
    }

    const created = await this.connection.newSession({
      cwd: this.cwd,
      mcpServers: [],
    });
    this.sessionByChat.set(chatId, created.sessionId);
    writePersistedSessionId(chatId, this.backend.name, created.sessionId);
    if (created.models) {
      this.modelsByChat.set(chatId, created.models);
      log(
        `[acp/${this.backend.name}] newSession sid=${created.sessionId} ` +
        `chat=${chatId} model=${created.models.currentModelId} ` +
        `available=${created.models.availableModels.length}`,
      );
    } else {
      log(`[acp/${this.backend.name}] newSession sid=${created.sessionId} chat=${chatId}`);
    }
    return created.sessionId;
  }

  /**
   * Drop the in-memory chatId → sessionId binding only. The persisted file
   * is left alone — callers that want it gone (e.g. /new) must call
   * clearPersistedSessionId() themselves.
   *
   * Why split: /resume and /bind first writePersistedSessionId(new sid),
   * then need to invalidate the in-memory cache so the next prompt re-reads
   * from disk and triggers session/load. If this method also deleted the
   * persisted file, it would wipe the sid the caller just wrote.
   */
  forgetSession(chatId: string): void {
    this.sessionByChat.delete(chatId);
  }

  /** Capability shorthand for command-layer dispatch. */
  supports(cap: "loadSession" | "resume" | "listSessions"): boolean {
    return this.capabilities[cap];
  }

  /**
   * Whether this agent exposed a models block on session creation/load.
   * Used by /model to decide between "list models" and "agent doesn't
   * support model selection". The check is per-chat because the model
   * block only appears once we've spawned a session.
   */
  hasModelSupport(chatId: string): boolean {
    return this.modelsByChat.has(chatId);
  }

  /** Snapshot of available + current model for a chat (or null). */
  getModelState(chatId: string): SessionModelState | null {
    return this.modelsByChat.get(chatId) ?? null;
  }

  /**
   * Switch the active model for an existing session. Uses ACP's experimental
   * `unstable_setSessionModel`. If the agent doesn't implement it, throws
   * with a clear message; otherwise updates the cached current model on
   * success.
   */
  async setModel(chatId: string, modelId: string): Promise<void> {
    await this.readyPromise;
    if (this.disposed) throw new Error("agent subprocess gone");
    const sessionId = this.sessionByChat.get(chatId);
    if (!sessionId) throw new Error("no session bound — send a message first");
    const state = this.modelsByChat.get(chatId);
    if (!state) throw new Error(`agent ${this.backend.name} did not advertise model selection for this session`);
    const known = state.availableModels.find((m) => m.modelId === modelId);
    if (!known) {
      const opts = state.availableModels.map((m) => m.modelId).join(", ");
      throw new Error(`unknown model "${modelId}" for ${this.backend.name}. options: ${opts}`);
    }
    try {
      await this.connection.unstable_setSessionModel({ sessionId, modelId });
    } catch (e: any) {
      // Some agents may simply not implement the method even if they
      // returned a models block — surface clearly.
      throw new Error(`setSessionModel rejected: ${e?.message ?? e}`);
    }
    // Update local snapshot. Don't rely on a notification; ACP doesn't
    // currently push current_model_update.
    this.modelsByChat.set(chatId, { ...state, currentModelId: modelId });
    log(`[acp/${this.backend.name}] setSessionModel ok sid=${sessionId} chat=${chatId} model=${modelId}`);
  }

  /**
   * List sessions known to this agent. Pages internally up to MAX_PAGES so
   * the caller gets a flat array. Optional cwd filter scopes to that workdir
   * (most agents return only sessions matching cwd; agents that don't will
   * just ignore the filter).
   */
  async listAllSessions(opts?: { cwd?: string; maxPages?: number }): Promise<AcpSessionInfo[]> {
    await this.readyPromise;
    if (this.disposed) throw new Error("agent subprocess gone");
    if (!this.capabilities.listSessions) {
      throw new Error(`agent ${this.backend.name} does not advertise listSessions capability`);
    }
    const out: AcpSessionInfo[] = [];
    let cursor: string | null | undefined = undefined;
    const maxPages = opts?.maxPages ?? 10;
    for (let p = 0; p < maxPages; p++) {
      const resp: ListSessionsResponse = await this.connection.listSessions({
        cwd: opts?.cwd ?? null,
        cursor: cursor ?? null,
      });
      for (const s of resp.sessions) out.push(s);
      cursor = resp.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  /**
   * Manually bind this chat to a known session id. Used by /resume and /bind
   * after the user has picked a session — we mark it in-memory and on disk
   * but DON'T do load/resume yet; the next user message will trigger that
   * via ensureSession's normal path.
   */
  bindSession(chatId: string, sid: string): void {
    this.sessionByChat.set(chatId, sid);
    writePersistedSessionId(chatId, this.backend.name, sid);
  }

  /**
   * Send a prompt and stream updates through `cbs` until the agent returns
   * its PromptResponse. The returned `cancel` function fires session/cancel
   * — agent should respond with stopReason="cancelled" shortly after.
   */
  async prompt(
    chatId: string,
    sessionId: string,
    blocks: ContentBlock[],
    cbs: PromptCallbacks,
    abort: AbortSignal,
  ): Promise<PromptResponse> {
    await this.readyPromise;
    if (this.disposed) throw new Error("agent subprocess gone");
    this.inflight++;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.lastActivityAt = Date.now();
    this.updateRouter.set(sessionId, cbs);

    let cancelSent = false;
    const onAbort = () => {
      if (cancelSent || this.disposed) return;
      cancelSent = true;
      log(`[acp/${this.backend.name}] session/cancel sid=${sessionId} reason=${abort.reason ?? "?"}`);
      // Per spec: send cancel notification. Agent may still emit final
      // updates and then resolve the prompt with stopReason="cancelled".
      this.connection.cancel({ sessionId }).catch((e) => {
        log(`[acp/${this.backend.name}] cancel notif failed: ${e?.message ?? e}`);
      });
      // Fallback: if the agent doesn't respond within the grace window we
      // assume it's wedged and kill the subprocess. Better lose its memory
      // than block the chat indefinitely.
      setTimeout(() => {
        if (this.disposed || !this.inflight) return;
        log(`[acp/${this.backend.name}] cancel grace expired, killing subprocess`);
        this.dispose("cancel-stuck").catch(() => {});
      }, AGENT_CANCEL_GRACE_MS).unref();
    };
    if (abort.aborted) onAbort();
    else abort.addEventListener("abort", onAbort, { once: true });

    try {
      // No client-side timeout — the user explicitly wants ACP requests to
      // live as long as the agent needs. Cancellation is the only path out.
      const resp = await this.connection.prompt({
        sessionId,
        prompt: blocks,
      });
      return resp;
    } finally {
      this.inflight = Math.max(0, this.inflight - 1);
      this.updateRouter.delete(sessionId);
      abort.removeEventListener("abort", onAbort);
      if (!this.disposed) this.touchIdleTimer();
    }
  }

  async dispose(reason: string): Promise<void> {
    if (this.disposed) return;
    log(`[acp/${this.backend.name}] dispose reason=${reason} cwd=${this.cwd}`);
    this.markDisposed();
    try { this.proc.stdin?.end(); } catch {}
    // Give the subprocess a beat to exit cleanly on EOF, then SIGTERM, then
    // SIGKILL — same shape as the lark-cli subprocess kill ladder.
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      this.proc.once("exit", finish);
      setTimeout(() => { try { this.proc.kill("SIGTERM"); } catch {} }, 1_000);
      setTimeout(() => { try { this.proc.kill("SIGKILL"); } catch {} finish(); }, 3_000);
    });
  }
}

// ---------- pool: one AgentInstance per (chatId, agentName, cwd) ----------
class AgentPool {
  private pool = new Map<string, AgentInstance>();

  private key(chatId: string, agent: string, cwd: string): string {
    return `${chatId} ${agent} ${cwd}`;
  }

  /** Get or spawn the instance for this triple. */
  get(backend: AgentBackend, chatId: string, cwd: string): AgentInstance {
    const k = this.key(chatId, backend.name, cwd);
    const cur = this.pool.get(k);
    if (cur && !cur.isDisposed()) return cur;
    const inst = new AgentInstance(backend, cwd, () => {
      // self-evict callback
      if (this.pool.get(k) === inst) this.pool.delete(k);
    });
    this.pool.set(k, inst);
    return inst;
  }

  /** Find an instance without spawning, used for /new to forget sessions. */
  find(backend: AgentBackend, chatId: string, cwd: string): AgentInstance | null {
    const k = this.key(chatId, backend.name, cwd);
    const inst = this.pool.get(k);
    if (inst && !inst.isDisposed()) return inst;
    return null;
  }

  async disposeAll(reason: string): Promise<void> {
    const all = [...this.pool.values()];
    this.pool.clear();
    await Promise.allSettled(all.map((i) => i.dispose(reason)));
  }
}

export const agentPool = new AgentPool();

// ---------- per-chat AbortControllers (mirror of claudeAborts) ----------
// Looked up by /cancel and the Cancel button to interrupt an in-flight prompt.
export const promptAborts = new Map<string, AbortController>();
