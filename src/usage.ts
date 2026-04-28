import { readFileSync } from "node:fs";
import { fmtTokens, fmtUsd } from "./streaming.js";

// Per-million-token pricing for cost estimation. Conservative table — if a
// model isn't here we report tokens but skip the dollar figure.
// Codex pricing varies by model; we leave the table empty for codex by
// default. Augment via env CODEX_PRICING_JSON if you want estimates.
const PRICING: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-4-7":   { in: 15,  out: 75,  cacheRead: 1.50, cacheWrite: 18.75 },
  "claude-opus-4-6":   { in: 15,  out: 75,  cacheRead: 1.50, cacheWrite: 18.75 },
  "claude-opus-4-5":   { in: 15,  out: 75,  cacheRead: 1.50, cacheWrite: 18.75 },
  "claude-opus-4":     { in: 15,  out: 75,  cacheRead: 1.50, cacheWrite: 18.75 },
  "claude-sonnet-4-6": { in: 3,   out: 15,  cacheRead: 0.30, cacheWrite: 3.75 },
  "claude-sonnet-4-5": { in: 3,   out: 15,  cacheRead: 0.30, cacheWrite: 3.75 },
  "claude-sonnet-4":   { in: 3,   out: 15,  cacheRead: 0.30, cacheWrite: 3.75 },
  "claude-haiku-4-5":  { in: 1,   out: 5,   cacheRead: 0.10, cacheWrite: 1.25 },
  "claude-haiku-4":    { in: 1,   out: 5,   cacheRead: 0.10, cacheWrite: 1.25 },
};

export function priceFor(model: string) {
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key)) return PRICING[key];
  }
  return undefined;
}

export type Usage = {
  inTok: number;
  outTok: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  model: string;
};

export function emptyUsage(): Usage {
  return { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, turns: 0, model: "" };
}

// Aggregates assistant-turn usage from a Claude SDK session jsonl. Codex
// sessions don't write this format; for codex /status falls back to in-memory.
export function aggregateUsageFromJsonl(file: string, into: Usage): void {
  let content: string;
  try { content = readFileSync(file, "utf8"); } catch { return; }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let evt: any;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.type !== "assistant") continue;
    const u = evt.message?.usage;
    if (!u) continue;
    into.inTok      += u.input_tokens || 0;
    into.outTok     += u.output_tokens || 0;
    into.cacheRead  += u.cache_read_input_tokens || 0;
    into.cacheWrite += u.cache_creation_input_tokens || 0;
    into.turns      += 1;
    if (evt.message?.model) into.model = evt.message.model;
  }
}

export function renderUsage(label: string, u: Usage): string {
  const p = priceFor(u.model);
  const totalIn = u.inTok + u.cacheRead + u.cacheWrite;
  const lines = [
    `**${label}**`,
    `- 模型：\`${u.model || "(未知)"}\``,
    `- 助手轮数：${u.turns}`,
    `- 纯输入：${fmtTokens(u.inTok)}（${u.inTok.toLocaleString()}）`,
    `- 输出：${fmtTokens(u.outTok)}（${u.outTok.toLocaleString()}）`,
    `- 缓存写入：${fmtTokens(u.cacheWrite)}`,
    `- 缓存读取：${fmtTokens(u.cacheRead)}`,
    `- 总输入（含缓存）：${fmtTokens(totalIn)}`,
  ];
  if (p && (u.inTok || u.outTok || u.cacheRead || u.cacheWrite)) {
    const cost = (u.inTok * p.in + u.outTok * p.out + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1_000_000;
    lines.push(`- 估算费用：**${fmtUsd(cost)}**`);
  }
  return lines.join("\n");
}

export const PROCESS_STARTED_AT = Date.now();

export function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
