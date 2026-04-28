import { readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { PID_FILE, LEGACY_LOCK_DIR } from "./config.js";

export function atomicWriteFile(path: string, content: string): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

export function acquireLock(): boolean {
  try { rmSync(LEGACY_LOCK_DIR, { recursive: true, force: true }); } catch {}

  const tryCreate = (): boolean => {
    try {
      writeFileSync(PID_FILE, String(process.pid), { flag: "wx" });
      return true;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      return false;
    }
  };

  if (tryCreate()) return true;

  let oldPid = NaN;
  try { oldPid = Number(readFileSync(PID_FILE, "utf8").trim()); } catch {}
  if (!Number.isNaN(oldPid) && oldPid > 0 && oldPid !== process.pid) {
    try {
      process.kill(oldPid, 0);
      console.error(`[lark-acp] already running (pid ${oldPid}). abort.`);
      return false;
    } catch { /* stale */ }
  }

  try { rmSync(PID_FILE, { force: true }); } catch {}
  if (tryCreate()) return true;
  console.error("[lark-acp] cannot acquire lock (race lost).");
  return false;
}

export function releaseLock() {
  try { rmSync(PID_FILE, { force: true }); } catch {}
  try { rmSync(LEGACY_LOCK_DIR, { recursive: true, force: true }); } catch {}
}
