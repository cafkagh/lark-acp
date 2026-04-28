import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// NOTE: this module reads the on-disk Claude SDK session format
// (~/.claude/projects/<encoded-cwd>/<sid>.jsonl). It only applies when the
// active backend is "claude" — codex doesn't store sessions in this layout.
// Used by /resume, /bind, and the per-session usage breakdown in /status.

export type SessionInfo = { sid: string; mtime: Date; firstPrompt: string };

export type GlobalSessionMatch = {
  sid: string;
  projDir: string;
  jsonlPath: string;
  cwd: string | null;
};

export function projDirFor(workdir: string): string {
  return join(homedir(), ".claude", "projects", workdir.replace(/[^a-zA-Z0-9-]/g, "-"));
}

const JSONL_HEAD_BYTES = 65_536;
export function* iterJsonlHead(
  jsonlPath: string,
  maxBytes: number = JSONL_HEAD_BYTES,
): Generator<any> {
  let fd: number;
  try { fd = openSync(jsonlPath, "r"); } catch { return; }
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    const text = buf.subarray(0, n).toString("utf8");
    const lines = text.split("\n");
    const lastComplete = n === maxBytes ? lines.length - 1 : lines.length;
    for (let i = 0; i < lastComplete; i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      try { yield JSON.parse(line); } catch { continue; }
    }
  } finally {
    try { closeSync(fd); } catch {}
  }
}

export function extractFirstPrompt(jsonlPath: string): string {
  for (const evt of iterJsonlHead(jsonlPath)) {
    if (evt.type !== "user" || !evt.message) continue;
    if (evt.userType && evt.userType !== "external") continue;

    const c = evt.message.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
      const textBlock = c.find((b: any) => b?.type === "text" && typeof b.text === "string");
      if (textBlock) text = textBlock.text;
    }
    if (!text) continue;

    text = text.replace(/^\[Feishu\b[^\]]*\]\s*\n+/, "");
    text = text.replace(/^\[用户附件:[^\n]*\]\s*\n+/, "");
    text = text.trim();
    if (!text) continue;

    const head = text.trimStart();
    if (head.startsWith("/") || head.startsWith("!")) continue;

    return text;
  }
  return "";
}

export function extractCwd(jsonlPath: string): string | null {
  for (const evt of iterJsonlHead(jsonlPath)) {
    if (typeof evt.cwd === "string" && evt.cwd) return evt.cwd;
  }
  return null;
}

export function findSessionGlobally(target: string): GlobalSessionMatch[] {
  const projectsRoot = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsRoot)) return [];
  const matches: GlobalSessionMatch[] = [];
  let roots: string[];
  try { roots = readdirSync(projectsRoot); } catch { return []; }
  for (const pd of roots) {
    const projDir = join(projectsRoot, pd);
    let files: string[];
    try { files = readdirSync(projDir).filter((f) => f.endsWith(".jsonl")); }
    catch { continue; }
    for (const f of files) {
      const sid = f.slice(0, -".jsonl".length);
      if (sid === target || sid.startsWith(target)) {
        const jsonlPath = join(projDir, f);
        matches.push({ sid, projDir, jsonlPath, cwd: extractCwd(jsonlPath) });
      }
    }
  }
  const exact = matches.filter((m) => m.sid === target);
  return exact.length > 0 ? exact : matches;
}

export function listSessions(workdir: string): SessionInfo[] {
  const projDir = projDirFor(workdir);
  if (!existsSync(projDir)) return [];
  const files = readdirSync(projDir).filter((f) => f.endsWith(".jsonl"));
  const out: SessionInfo[] = [];
  for (const f of files) {
    const sid = f.slice(0, -".jsonl".length);
    const fullPath = join(projDir, f);
    let mtime: Date;
    try { mtime = statSync(fullPath).mtime; } catch { continue; }
    const firstPrompt = extractFirstPrompt(fullPath).replace(/\s+/g, " ").trim();
    out.push({ sid, mtime, firstPrompt });
  }
  out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return out;
}

export function fmtMtime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
