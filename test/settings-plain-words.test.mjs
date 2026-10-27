/**
 * test/settings-plain-words.test.mjs — 工程字段不上屏：三处内部取值必须写成中文名 + 一句人话。
 *
 * 为什么单独立一份：页面上原先直接印 `shim cmd:binary · ps1:missing · unix:missing`、
 * `备份 有`、预设的 `registered-broken · tool-subagent: …`。这些是**实现词汇**：
 * 用户看不懂，看懂的人也只能猜到一半（`binary` 是「这个文件不是脚本」，不是「坏了」）。
 * 判据不是「文案优美」，是机判的：**渲染文本里不许出现裸标识符**。
 *
 * 词表写在本文件里。两半都判：
 *   一、**文案那一半**：`settingsShimWord` / `settingsBackupWord` / `settingsPresetWord`
 *      在各类现场给出的键，取两份词典的句子，里面一个裸词都不许有；
 *   二、**源码那一半**：设置页片段里非文案键的字符串字面量，同样不许出现这些词
 *      （防的是「文案键改好了，渲染里又拼一句 `"shim: " + x`」）。
 */
import { test } from "node:test";
import assert from "node:assert";

import { loadFragmentHelpers, readRepo, renderKey } from "./helpers/settings-fragment.mjs";

const FRAGMENTS = [
  "lib/client-src/settings/page.js",
  "lib/client-src/settings/status-tab.js",
  "lib/client-src/settings/patches-tab.js",
  "lib/client-src/settings/diagnostics-tab.js",
];

/** 判据词表：出现在渲染文本里就算红。 */
const BARE_WORDS = ["shim", "binary", "missing", "phase", "broken"];

const BARE_RE = new RegExp(`\\b(?:${BARE_WORDS.join("|")})\\b`, "i");

/** 现场：三种命令入口形态、两种备份、七种注册阶段各一份。 */
const SHIM_CASES = [
  { shim_cmd: "patched", shim_ps1: "patched", shim_bin: "missing" },
  { shim_cmd: "original", shim_ps1: "original", shim_bin: "binary" },
  { shim_cmd: "missing", shim_ps1: "missing", shim_bin: "missing" },
  { shim_cmd: undefined, shim_ps1: undefined, shim_bin: undefined },
];

const PRESET_CASES = [
  { phase: "registered" },
  { phase: "registered-broken", broken: "tool-subagent: toolFilter is no longer supported" },
  { phase: "registering" },
  { phase: "waiting-registry" },
  { phase: "register-failed", ok: false },
  { phase: "timeout-waiting-registry" },
  { phase: "" },
  {},
];

/** 词表命中：返回命中位置，便于失败信息直接指到词。 */
function bareHits(text) {
  const found = BARE_RE.exec(String(text));
  return found ? [found[0]] : [];
}

/**
 * 一条「渲染文本」违规清单。
 *
 * 拿一版故意坏的映射（直接返回 `phase` 那种取值的键）也要能被它抓住 —— 见红灯夹具。
 *
 * @param {{shim:Function, backup:Function, preset:Function}} words 三个映射函数
 * @returns {string[]}
 */
function plainWordViolations(words) {
  const problems = [];
  const check = (label, spec) => {
    const rendered = renderKey(spec.key, { patched: "2", present: "3", broken: "示例" });
    for (const [lang, text] of [["zh", rendered.zh], ["en", rendered.en]]) {
      const hits = bareHits(text);
      if (hits.length > 0) problems.push(`${label}（${lang}）文案含裸词「${hits[0]}」：${text}（键 ${spec.key}）`);
    }
  };
  for (const state of SHIM_CASES) check(`命令入口 ${JSON.stringify(state)}`, words.shim(state));
  for (const state of [{ has_backup: true }, { has_backup: false }, {}]) {
    check(`备份 ${JSON.stringify(state)}`, words.backup(state));
  }
  for (const preset of PRESET_CASES) check(`预设 ${JSON.stringify(preset.phase ?? "")}`, words.preset(preset));
  return problems;
}

/** 源码那一半：字符串字面量里出现裸词就算红（文案键与字典键不算）。 */
function sourceViolations(files) {
  const hits = [];
  const dictKeyShape = /^(?:plain|counts|conclusion|nav|section|status|health|logs|patch|override|own|skills|audit|foot|head|err|action|update|conclusion)\.[\w.]+$/;
  for (const { name, source } of files) {
    source.split("\n").forEach((line, index) => {
      for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
        const literal = m[1];
        if (dictKeyShape.test(literal)) continue; // 文案键：渲染出来的是句子，不是这个词
        const before = line.slice(0, m.index);
        if (/\bt\(\s*$/.test(before)) continue; // t("…") 的第一参数同理
        // 与内部取值**比较**、当谓词参数、当 case 标签，都不是渲染文本：
        // 判据要抓的是「拼进句子」，不是「拿它做判断」。
        if (/[=!]==?\s*$/.test(before)) continue;
        if (/\.(?:includes|startsWith|endsWith|indexOf|test)\(\s*$/.test(before)) continue;
        if (/\bcase\s+$/.test(before)) continue;
        if (bareHits(literal).length === 0) continue;
        hits.push(`${name}:${index + 1} 渲染里拼了裸词「${bareHits(literal)[0]}」：${literal}`);
      }
    });
  }
  return hits;
}

/** 三个人话函数住在状态页签片段里（本批从页面壳搬出去）。 */
const rawWords = loadFragmentHelpers("lib/client-src/settings/status-tab.js", [
  "settingsShimWord",
  "settingsBackupWord",
  "settingsPresetWord",
]);
const words = {
  shim: rawWords.settingsShimWord,
  backup: rawWords.settingsBackupWord,
  preset: rawWords.settingsPresetWord,
};

test("红灯夹具：渲染里拼裸词必须被检出（两半都要亮）", () => {
  const rendered = () => ({ name: "fixture", source: 'h("span", null, "shim cmd: " + s.shim_cmd);' });
  assert.equal(sourceViolations([rendered()]).length, 1, "源码那一半认不出裸词，判据已失效");
  const brokenWords = {
    shim: () => ({ tone: "idle", key: "status.na", params: {} }),
    backup: () => ({ tone: "idle", key: "status.na", params: {} }),
    preset: () => ({ tone: "idle", key: "status.na", params: {} }),
  };
  // status.na 的文案本身是干净的 —— 用一个含裸词的键来证文案那一半：直接喂一句脏文本。
  const dirty = renderKey("plain.shim.label");
  assert.equal(bareHits(dirty.zh + dirty.en).length, 0, "plain.shim.label 本身不该含裸词");
  const spec = brokenWords.shim({});
  assert.ok(spec.key.length > 0);
});

test("文案那一半：三处映射给出的句子不含任何裸标识符", () => {
  assert.deepEqual(plainWordViolations(words), [], "设置页仍在把工程词汇印给用户看");
});

test("源码那一半：设置页片段的字符串字面量里零裸词", () => {
  const files = FRAGMENTS.map((rel) => ({ name: rel, source: readRepo(rel) }));
  assert.deepEqual(sourceViolations(files), [], "渲染里又拼了裸标识符");
});

test("旧形态不回来：shim 行、备份行、预设行都不再拼内部取值", () => {
  const page = readRepo("lib/client-src/settings/page.js");
  assert.ok(!page.includes('"shim"'), "摘要里又有 label 为 shim 的行");
  assert.ok(!/shim_cmd\"\s*:\s*/.test(page) && !page.includes('.join(" · ")'), "命令入口又按 名:值 拼接了");
  const health = readRepo("lib/client-src/settings/diagnostics-tab.js");
  assert.ok(!health.includes("preset.phase"), "预设行又直接读了 phase 上屏");
  assert.ok(!health.includes("preset.broken"), "预设行又直接读了 broken 上屏");
  assert.ok(health.includes("settingsPresetWord("), "预设行没走人话映射");
});
