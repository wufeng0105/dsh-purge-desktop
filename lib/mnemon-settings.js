/**
 * lib/mnemon-settings.js — mnemon 的手工逃生口：只读用户手改的文件，从不写回。
 */
import fs from "node:fs";
import path from "node:path";

/**
 * `mnemon.json` 的**读侧**：只解析，不写。
 *
 * 这是手工覆盖项，不是设置页的持久层 —— 全仓没有程序写入方（写侧函数此前已删，
 * 且它从未被调用过），文件只可能由用户自己手改。因此这里不提供 save /
 * migrate / 建目录之类的动作：文件不存在就是「没表态」，不是需要补一份默认值。
 *
 * 取值优先级（高 → 低）：`mnemon.json` 的 keepMnemon > 调用方传入的 configValue >
 * DEFAULT_SETTINGS。三层都只认**真布尔值**：字符串、null、缺项一律跳过，
 * 坏 JSON 也整份丢弃（catch 里置空对象），坏文件绝不让读侧抛错。
 *
 * 语义边界：本文件只能表达「强制保留 mnemon」，不能表达「强制剥离」。
 * 真正的主开关是插件配置 `stripMnemon`（`lib/index.js` 的 `DEFAULTS` 表，默认 true）；
 * 文件只是它之上的手工逃生口。两侧的合并发生在 `lib/identity.js` 的
 * `normalizeRewriteOptions`，那里也是 keepMnemon:false 被解释成「不表态」的地方。
 */
const DEFAULT_SETTINGS = Object.freeze({ keepMnemon: false });
const SETTINGS_FILE = "mnemon.json";

function mnemonSettingsPath(dshHome) {
  return path.join(dshHome, "dsh-purge", SETTINGS_FILE);
}

export function loadMnemonSettings(dshHome, configValue) {
  let file = {};
  try {
    const fp = mnemonSettingsPath(dshHome);
    if (fs.existsSync(fp)) {
      const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
      if (parsed && typeof parsed === "object") file = parsed;
    }
  } catch {
    file = {};
  }
  const pick = [file.keepMnemon, configValue, DEFAULT_SETTINGS.keepMnemon];
  const value = pick.find((v) => typeof v === "boolean");
  return { keepMnemon: value === undefined ? false : value };
}
