import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";

const execFile = promisify(execFileCb);

export const LARK_BIN = process.env.LARK_BIN ?? "lark-cli";

// ---------- lark-cli helpers ----------
export async function larkApi(method: string, path: string, body?: unknown): Promise<any> {
  const args = ["api", method, path, "--as", "bot"];
  if (body !== undefined) args.push("--data", JSON.stringify(body));
  const { stdout, stderr } = await execFile(LARK_BIN, args, {
    maxBuffer: 20 * 1024 * 1024,
  });
  if (stderr) log(`[lark-cli stderr] ${stderr.trim()}`);
  try { return JSON.parse(stdout); } catch { return { raw: stdout }; }
}

export async function replyText(messageId: string, text: string) {
  return larkApi("POST", `/open-apis/im/v1/messages/${messageId}/reply`, {
    msg_type: "text",
    content: JSON.stringify({ text }),
  });
}

export async function addReaction(messageId: string, emoji: string): Promise<string | null> {
  try {
    const r = await larkApi(
      "POST",
      `/open-apis/im/v1/messages/${messageId}/reactions`,
      { reaction_type: { emoji_type: emoji } },
    );
    return r?.data?.reaction_id ?? r?.reaction_id ?? null;
  } catch (e: any) {
    log(`react err: ${e?.message ?? e}`);
    return null;
  }
}

export async function delReaction(messageId: string, reactionId: string | null) {
  if (!reactionId) return;
  try {
    await larkApi(
      "DELETE",
      `/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`,
    );
  } catch (e: any) {
    log(`del react err: ${e?.message ?? e}`);
  }
}

// ---------- attachment download ----------
export async function downloadMessageResource(opts: {
  messageId: string;
  fileKey: string;
  type: "image" | "file";
  outputRelative: string;
  cwd: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const { stderr } = await execFile(
      LARK_BIN,
      [
        "im", "+messages-resources-download",
        "--as", "bot",
        "--message-id", opts.messageId,
        "--file-key", opts.fileKey,
        "--type", opts.type,
        "--output", opts.outputRelative,
      ],
      { cwd: opts.cwd, maxBuffer: 50 * 1024 * 1024 },
    );
    if (stderr) log(`[download stderr] ${stderr.trim()}`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function parseMessagePayload(
  msgType: string,
  rawContent: string,
  messageId: string,
  chatId: string,
  chatWorkdir: string,
): Promise<{ text: string; attachmentsPrompt: string } | null> {
  let parsed: any = null;
  try { parsed = JSON.parse(rawContent); } catch {}

  switch (msgType) {
    case "text": {
      return { text: typeof parsed?.text === "string" ? parsed.text : "", attachmentsPrompt: "" };
    }

    case "post": {
      const title = typeof parsed?.title === "string" ? parsed.title : "";
      const rows: any[] = Array.isArray(parsed?.content) ? parsed.content : [];
      const segs: string[] = [];
      const inlineImageKeys: string[] = [];
      if (title) segs.push(title);
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const line = row.map((seg: any) => {
          if (seg?.tag === "text" && typeof seg.text === "string") return seg.text;
          if (seg?.tag === "a") {
            const label = typeof seg.text === "string" ? seg.text : (seg.href ?? "");
            return seg.href ? `[${label}](${seg.href})` : label;
          }
          if (seg?.tag === "at") return `@${seg.user_name ?? seg.user_id ?? ""}`;
          if (seg?.tag === "emotion") return `:${seg.emoji_type ?? "emoji"}:`;
          if (seg?.tag === "code_inline" && typeof seg.text === "string") return `\`${seg.text}\``;
          if (seg?.tag === "img" && typeof seg.image_key === "string") {
            inlineImageKeys.push(seg.image_key);
            return `[inline-image-${inlineImageKeys.length}]`;
          }
          return "";
        }).join("");
        if (line) segs.push(line);
      }

      let attachmentsPrompt = "";
      if (inlineImageKeys.length > 0) {
        try { mkdirSync(join(chatWorkdir, ".lark-acp-attachments"), { recursive: true }); } catch {}
        const lines: string[] = [];
        for (let i = 0; i < inlineImageKeys.length; i++) {
          const key = inlineImageKeys[i];
          const rel = join(".lark-acp-attachments", `${messageId}-img${i + 1}.png`);
          const r = await downloadMessageResource({
            messageId, fileKey: key, type: "image",
            outputRelative: rel, cwd: chatWorkdir,
          });
          if (r.ok) {
            log(`[msg=post img] saved to ${chatWorkdir}/${rel}`);
            lines.push(`[用户附件：post 内图片 #${i + 1} 已保存到 ./${rel}]`);
          } else {
            log(`[msg=post img] download failed chat=${chatId}: ${r.error}`);
            lines.push(`[用户附件：post 内图片 #${i + 1} 下载失败: ${r.error}]`);
          }
        }
        attachmentsPrompt = lines.join("\n") + "\n";
      }

      return { text: segs.join("\n"), attachmentsPrompt };
    }

    case "image": {
      const fileKey: string = parsed?.image_key ?? "";
      if (!fileKey) return { text: "", attachmentsPrompt: "" };
      const rel = join(".lark-acp-attachments", `${messageId}.png`);
      try { mkdirSync(join(chatWorkdir, ".lark-acp-attachments"), { recursive: true }); } catch {}
      const r = await downloadMessageResource({
        messageId, fileKey, type: "image",
        outputRelative: rel, cwd: chatWorkdir,
      });
      if (!r.ok) {
        log(`[msg=image] download failed chat=${chatId}: ${r.error}`);
        return { text: "", attachmentsPrompt: `[用户发了一张图片但下载失败: ${r.error}]\n` };
      }
      log(`[msg=image] saved to ${chatWorkdir}/${rel}`);
      return { text: "", attachmentsPrompt: `[用户附件：图片已保存到 ./${rel}]\n` };
    }

    case "file": {
      const fileKey: string = parsed?.file_key ?? "";
      const rawName: string = typeof parsed?.file_name === "string" ? parsed.file_name : messageId;
      if (!fileKey) return { text: "", attachmentsPrompt: "" };
      const safeName = rawName.replace(/[^\w.\-]/g, "_").slice(0, 120);
      const rel = join(".lark-acp-attachments", `${messageId}-${safeName}`);
      try { mkdirSync(join(chatWorkdir, ".lark-acp-attachments"), { recursive: true }); } catch {}
      const r = await downloadMessageResource({
        messageId, fileKey, type: "file",
        outputRelative: rel, cwd: chatWorkdir,
      });
      if (!r.ok) {
        log(`[msg=file] download failed chat=${chatId}: ${r.error}`);
        return { text: "", attachmentsPrompt: `[用户发了文件 "${rawName}" 但下载失败: ${r.error}]\n` };
      }
      log(`[msg=file] saved to ${chatWorkdir}/${rel}`);
      return { text: "", attachmentsPrompt: `[用户附件：文件 "${rawName}" 已保存到 ./${rel}]\n` };
    }

    case "audio":
    case "media":
    case "sticker":
    case "share_chat":
    case "share_user":
    case "merge_forward":
    case "system": {
      await replyText(messageId, `⚠️ 暂不支持消息类型：${msgType}\n已支持：text、post、image、file`);
      log(`[msg] rejected type=${msgType} chat=${chatId}`);
      return null;
    }

    default: {
      await replyText(messageId, `⚠️ 未知消息类型：${msgType}\n已支持：text、post、image、file`);
      log(`[msg] rejected unknown type=${msgType} chat=${chatId}`);
      return null;
    }
  }
}

// ---------- chat-name cache ----------
const chatNameCache = new Map<string, string>();
const chatNameInflight = new Set<string>();

export function rememberChatName(chatId: string): void {
  if (!chatId || chatNameCache.has(chatId) || chatNameInflight.has(chatId)) return;
  chatNameInflight.add(chatId);
  larkApi("GET", `/open-apis/im/v1/chats/${chatId}`)
    .then((r) => {
      const name = r?.data?.name ?? r?.name;
      if (typeof name === "string" && name) chatNameCache.set(chatId, name);
    })
    .catch(() => {})
    .finally(() => chatNameInflight.delete(chatId));
}

export function chatNameOf(chatId: string): string | undefined {
  return chatNameCache.get(chatId);
}
