import { spawn } from "node:child_process";
import { SHELL_TIMEOUT_MS } from "./config.js";

export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n…(truncated ${s.length - n} bytes)`;
}

export type ShellResult = {
  stdout: string;
  stderr: string;
  newCwd: string;
  exitCode: number;
  timedOut: boolean;
};

export async function execShellWithCwd(cmd: string, cwd: string): Promise<ShellResult> {
  const SENTINEL = "<<<__LACP_CWD__>>>";
  const wrapped = `cd ${shellSingleQuote(cwd)} 2>/dev/null
${cmd}
_lacp_rc=$?
printf '\\n${SENTINEL}%s\\n' "$(pwd)"
exit $_lacp_rc`;
  return new Promise<ShellResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn("bash", ["-c", wrapped], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, SHELL_TIMEOUT_MS);
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("close", (code) => {
      clearTimeout(killer);
      let newCwd = cwd;
      const idx = stdout.lastIndexOf(SENTINEL);
      if (idx >= 0) {
        const after = stdout.slice(idx + SENTINEL.length);
        const nl = after.indexOf("\n");
        newCwd = (nl >= 0 ? after.slice(0, nl) : after).trim() || cwd;
        stdout = stdout.slice(0, idx).replace(/\n$/, "");
      }
      resolve({ stdout, stderr, newCwd, exitCode: code ?? 1, timedOut });
    });
  });
}
