import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import * as readline from "node:readline";
import { log } from "./log.js";
import { LARK_BIN } from "./lark.js";
import { RESTART_EXIT_CODE } from "./config.js";
import { releaseLock } from "./lock.js";

const RETRY_STATE_FILE = "/tmp/lark-acp-pipeline-retry.json";
const ALREADY_RUNNING_MAX_RETRIES = 5;
const SUB_ALREADY_RUNNING_RE = /another event \+subscribe instance is already running/i;

function loadRetryState(): { count: number } {
  try {
    const d = JSON.parse(readFileSync(RETRY_STATE_FILE, "utf8"));
    if (!d || typeof d.at !== "number" || Date.now() - d.at > 30_000) return { count: 0 };
    return { count: typeof d.count === "number" ? d.count : 0 };
  } catch { return { count: 0 }; }
}

function saveRetryState(count: number): void {
  try { writeFileSync(RETRY_STATE_FILE, JSON.stringify({ count, at: Date.now() })); } catch {}
}

export function resetRetryState(): void {
  try { rmSync(RETRY_STATE_FILE, { force: true }); } catch {}
}

export function sweepOrphanLarkCli(): void {
  try {
    const out = execFileSync("pgrep", ["-f", "lark-cli.*event.*\\+subscribe"], {
      encoding: "utf8",
    }).trim();
    if (!out) return;
    const pids = out.split("\n").map((s) => Number(s.trim())).filter((n) => n > 0 && n !== process.pid);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
        log(`sweep: killed orphan lark-cli pid=${pid}`);
      } catch (e: any) {
        log(`sweep: kill ${pid} failed: ${e?.message ?? e}`);
      }
    }
    if (pids.length > 0) {
      try { execFileSync("sleep", ["0.5"]); } catch {}
    }
  } catch {
    // pgrep exits 1 when no match — normal.
  }
}

export interface SubscribeHandle {
  pid: number | undefined;
  startedAt: number;
  hasExited(): boolean;
  killGroup(signal: NodeJS.Signals): void;
  closeRl(): void;
  waitForExit(graceMs: number, hardCapMs: number): Promise<void>;
}

export function startSubscribe(opts: {
  onLine: (line: string) => void;
  isShuttingDown: () => boolean;
}): SubscribeHandle {
  sweepOrphanLarkCli();

  const retryStateAtStart = loadRetryState();
  const subArgs = ["event", "+subscribe",
    "--event-types", "im.message.receive_v1,card.action.trigger",
    "--quiet", "--as", "bot"];
  if (retryStateAtStart.count > 0) {
    subArgs.push("--force");
    log(`sub: retrying with --force (retry ${retryStateAtStart.count}/${ALREADY_RUNNING_MAX_RETRIES})`);
  }
  const sub = spawn(LARK_BIN, subArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const startedAt = Date.now();
  let exited = false;

  function killGroup(signal: NodeJS.Signals) {
    if (!sub.pid) return;
    try {
      process.kill(-sub.pid, signal);
    } catch {
      try { sub.kill(signal); } catch {}
    }
  }

  let subOutput = "";
  function onSubOutput(s: string) {
    subOutput += s;
    if (subOutput.length > 64_000) subOutput = subOutput.slice(-32_000);
  }
  function sawAlreadyRunning(): boolean {
    return SUB_ALREADY_RUNNING_RE.test(subOutput);
  }
  function handleAlreadyRunningFailure(): never {
    const state = loadRetryState();
    if (state.count >= ALREADY_RUNNING_MAX_RETRIES) {
      const msg = `subscribe: gave up after ${state.count} 'already running' retries — another bot instance is genuinely running somewhere. Kill it first, then re-launch.`;
      log(msg);
      console.error(`[lark-acp] ${msg}`);
      resetRetryState();
      releaseLock();
      process.exit(2);
    }
    saveRetryState(state.count + 1);
    log(`subscribe failed (already-running), retry ${state.count + 1}/${ALREADY_RUNNING_MAX_RETRIES}`);
    releaseLock();
    process.exit(RESTART_EXIT_CODE);
  }

  sub.stderr.on("data", (d) => {
    const s = String(d);
    onSubOutput(s);
    log(`[subscribe stderr] ${s.trim()}`);
  });

  sub.on("exit", (code) => {
    exited = true;
    log(`subscribe exited code=${code}`);
    if (opts.isShuttingDown()) return;
    if (Date.now() - startedAt < 10_000 && sawAlreadyRunning()) {
      handleAlreadyRunningFailure();
    }
    releaseLock();
    process.exit(code ?? 1);
  });

  setTimeout(() => { resetRetryState(); }, 30_000).unref();

  const rl = readline.createInterface({ input: sub.stdout });

  rl.on("line", (line) => {
    if (opts.isShuttingDown()) return;
    onSubOutput(line + "\n");
    if (Date.now() - startedAt < 5_000 && sawAlreadyRunning()) {
      handleAlreadyRunningFailure();
    }
    opts.onLine(line);
  });

  return {
    get pid() { return sub.pid; },
    startedAt,
    hasExited: () => exited,
    killGroup,
    closeRl: () => { try { rl.close(); } catch {} },
    waitForExit: (graceMs, hardCapMs) => new Promise<void>((resolve) => {
      if (exited) return resolve();
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      sub.once("exit", finish);
      setTimeout(() => {
        if (!exited) {
          log("sub still alive after SIGTERM grace; sending SIGKILL to group");
          killGroup("SIGKILL");
        }
      }, graceMs);
      setTimeout(finish, hardCapMs);
    }),
  };
}
