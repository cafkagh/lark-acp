import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { BOT_HOME } from "./config.js";

export const LOG = join(BOT_HOME, "lark-acp.log");

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function log(line: string) {
  appendFileSync(LOG, `[${ts()}] ${line}\n`);
}
