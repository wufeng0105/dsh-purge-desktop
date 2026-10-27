/**
 * scripts/embed-default-prompt.mjs — 默认提示词要随包发布，就不能靠运行时读文件。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sealSlot } from "../lib/table-key.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, "lib", "default-prompt-inject.md");
const dest = path.join(root, "lib", "asset-table.js");

if (!fs.existsSync(src)) {
  throw new Error(`missing local source: ${src}`);
}

const text = fs.readFileSync(src, "utf8");
if (!text.trim()) throw new Error("local source is empty");

const packed = sealSlot(text);
const chunk = (s, n = 96) => {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
};

// 产物自带的头注释也在这里生成：asset-table.js 是整份重写的，头必须由生成器写，
// 否则下一次 embed-prompt 会把它抹掉，而「一个文件一件事」的门禁会立刻红。
const out = `/**
 * lib/asset-table.js — 生成的密封槽：默认提示词不落明文，改它要改生成器。
 */
const SLOT_ROWS = ${JSON.stringify(chunk(packed.SLOT), null, 2)};

export const SLOT = SLOT_ROWS.join("");
export const MASK = ${JSON.stringify(packed.MASK)};
export const TAG = ${JSON.stringify(packed.TAG)};
export const IV = ${JSON.stringify(packed.IV)};
`;

fs.writeFileSync(dest, out, "utf8");
process.stdout.write(`wrote ${path.relative(root, dest)} bytes=${text.length}\n`);
