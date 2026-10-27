/**
 * 规则棘轮：断言「已登记的债务不许增加」。
 *
 * 为什么用棘轮而不是直接清零（WORKFLOW-1）：
 * 存量债务 22 处分布在 core.js 8,206 行里，一次性清零要求在一个 PR 里改 22 处
 * 宿主补丁 —— 违反 WORKFLOW-3（净删除 <= 400 行且 <= 3 文件），且没有 characterization
 * test 兜底（PATCH-6 未覆盖）。棘轮的作用是把「不许变差」变成 CI 红灯，
 * 同时允许「一个 PR 修一条」。
 *
 * 每次修掉一处，就把对应上限减 1。上限归零时把规则 severity 升为 error。
 */
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// 计数口径与 ast-grep 债务不同轴，但同住这个文件：都是「已登记债务只减不增」的棘轮。
import { cjkTargets, countCjk } from "../scripts/cjk-count.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 已登记的债务上限（2026-10-21 实测基线）。
 * 每个数字都能用 `npm run patch-guard -- --json` 复现。
 */
const CEILING = {
  // PATCH-5：裸字符串补丁。现存 2 处（core.js 的 revertCmdFlash 还原官方
  // phase-1、lib/patch/constants.js 的需计算 replace 值），行号会随补丁表
  // 演进漂移，以最新 patch-guard 输出为准，这里不写死。
  "no-bare-string-patch": 2,
 // PATCH-4：singular schema。最后 7 条已迁成 plural，上限归零 ——
 // 这条从棘轮变成硬红线：再出现 patterns 字段就是新债。
  "patch-singular-schema": 0,
 // SURFACE-2/：surface 决策行。已完成（13 → 0），这条现在锁死不许回升。
  "surface-decision-outside-host": 0,
  // SURFACE-2：裸变量比较。现存 lib/index.js:2345 一处（settle 作用域传下来的变量）。
  // 2026-10-22 起 rules/host-surface-string-compare.yml 的 files 从 lib/** 收窄成
  // lib/client-src/** + 显式 lib/index.js，命中数仍是 1，未靠调上限消化。
  "host-surface-string-compare": 1,
};

/**
 * ast-grep 可执行体。@ast-grep/cli 的 `bin` 在 Windows 下是 `ast-grep.exe`，
 * 同目录另有 unix 用的 `ast-grep` shell wrapper，两者同名同路径，
 * 这里取到的就是当前平台能直接交给 execFileSync 的那一个。
 */
const AST_GREP = join(ROOT, "node_modules", "@ast-grep", "cli", "ast-grep");

/**
 * 二进制是否可用。
 *
 * 为什么不能只靠 scan() 里的 try/catch 兜住：二进制不存在时 execFileSync 抛的是
 * **ENOENT**（环境缺件），与「扫描发现 error 级诊断、退出码 1 但 stdout 仍有完整
 * JSON」（正常路径）落进同一个 catch，且 `error.stdout` 都为空 —— 于是 counts 全 0，
 * 第二个断言会把「压根跑不起来」报成「债务已修掉，请下调 CEILING」。
 * 所以这里显式判定，缺件时由调用方 t.skip，不许把 0 当命中数用。
 */
function astGrepAvailable() {
  try {
    return existsSync(AST_GREP) && statSync(AST_GREP).isFile();
  } catch {
    return false;
  }
}

const AST_GREP_MISSING = `找不到 ${AST_GREP}：本机没装可选依赖 @ast-grep/cli，规则棘轮无法度量`;

function scan() {
  let raw;
  try {
    raw = execFileSync(
      process.execPath,
      [
        AST_GREP,
        "scan",
        "--config",
        join(ROOT, "sgconfig.yml"),
        "--json=stream",
      ],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    // scan 在发现 error 级诊断时退出码为 1，但 stdout 仍有完整 JSON。
    raw = error.stdout || "";
  }
  const counts = {};
  for (const line of String(raw).split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    let hit;
    try {
      hit = JSON.parse(text);
    } catch {
      continue;
    }
    if (!hit || typeof hit.ruleId !== "string") continue;
    counts[hit.ruleId] = (counts[hit.ruleId] || 0) + 1;
  }
  return counts;
}

test("规则棘轮：已登记债务不得增加", (t) => {
  if (!astGrepAvailable()) return t.skip(AST_GREP_MISSING);
  const counts = scan();
  const drift = [];
  for (const [ruleId, ceiling] of Object.entries(CEILING)) {
    const actual = counts[ruleId] || 0;
    if (actual > ceiling) {
      drift.push(`${ruleId}: ${actual} > 上限 ${ceiling}`);
    }
  }
  assert.deepEqual(
    drift,
    [],
    `债务增加，先修再提交（修完记得把 CEILING 里的数字减 1）：\n  ${drift.join("\n  ")}`,
  );
});

test("规则棘轮：修掉的债务要把上限降下来", (t) => {
  if (!astGrepAvailable()) return t.skip(AST_GREP_MISSING);
  const counts = scan();
  const stale = [];
  for (const [ruleId, ceiling] of Object.entries(CEILING)) {
    const actual = counts[ruleId] || 0;
    if (actual < ceiling) {
      stale.push(`${ruleId}: 实际 ${actual} < 上限 ${ceiling}，请把 CEILING 减到 ${actual}`);
    }
  }
  assert.deepEqual(
    stale,
    [],
    `上限过时会让棘轮失效（下次涨回去也不会红）：\n  ${stale.join("\n  ")}`,
  );
});

// ── 模板串中文棘轮 ────────────────────────────────────────────────────────────
//
// ast-grep 的 no-cjk 规则只锁 string 字面量，不锁模板串（三段 CSS 本身就是模板串，
// 里面的中文是样式注释不是文案）。模板串里的用户可见文案由这条棘轮兜 —— 口径与
// scripts/measure.mjs 的 measureCjk 同一实现（scripts/cjk-count.mjs），
// cjkCombinedMatches 只减不增。
/**
 * cjkCombinedMatches 的上限，2026-10-24 实测基线。
 * 现存唯一一处命中是 lib/client-src/dock/auth-gate.js:12 的 AUTH_LEGAL_HTML ——
 * CONTRACT-6 要求它与 docs/drill-auth-legal.html 逐字节相同，是规则里唯一豁免。
 * 提案里写的 145 是 i18n 迁移轮的中间值（db6938e 迁移收尾时已降到 1），上限按
 * 实测登记：上限过时等于棘轮失效，方向与 ast-grep 债务一样是双向的。
 */
const CJK_CEILING = 1;

/** 全量扫描文件的字面量命中数（matchTotal 口径）。 */
function cjkMatches() {
  return cjkTargets().reduce((n, rel) => n + countCjk(rel).matchTotal, 0);
}

test("模板串中文棘轮：命中数不许超过上限", () => {
  const actual = cjkMatches();
  assert.ok(
    actual <= CJK_CEILING,
    `cjkCombinedMatches 实测 ${actual}，超过上限 ${CJK_CEILING}：文案硬编码从 string 溜进模板串了。`
    + "改法：在 lib/client-src/i18n.js 加键，再用 dt(\"键\") / t(\"键\") 取值；"
    + "确有理由（如 CONTRACT-6 的法律文本）先改口径再改上限，并在本注释写明依据。",
  );
});

test("模板串中文棘轮：修掉的命中要把上限降下来", () => {
  const actual = cjkMatches();
  assert.ok(
    actual >= CJK_CEILING,
    `cjkCombinedMatches 实测 ${actual}，低于上限 ${CJK_CEILING}：请把 CJK_CEILING 减到 ${actual}。`
    + "上限过时会让下次涨回去也不红。",
  );
});
