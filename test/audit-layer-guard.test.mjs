/**
 * test/audit-layer-guard.test.mjs — 「未映射的层名」这道门禁必须真的守得住，包括数字开头的。
 *
 * 来路：审计轨对 #40 / #47 / #49（layer 是 `0.1.5 兼容` / `0.2.0 兼容`）一条行都不落，
 * 卡片分母因此是 62 而补丁表是 66。两条成因叠加，其中一条是门禁自己放的水：
 *
 *   `scripts/check-audit-completeness.mjs` 原先把未映射的层名写成
 *   `if (!/^\d/.test(layerCn)) fail(...)` —— 凡数字开头就静默跳过。兼容层确实以数字
 *   开头，但「新加了一个没人映射的层」也常以数字开头（版本号习惯正是这样），
 *   于是这条门禁对**最该拦的那一形态**完全失效，而它声称守的正是这件事。
 *
 * 现在的判据分两半，缺一不可：
 *   一、**声明**：不参与三档结论的层名（兼容层）点名列在 `layers.js` 的
 *       `NON_CONCLUSION_LAYERS`，不是靠「像数字」猜；
 *   二、**红灯**：补丁表里出现没登记的层名 —— 不管开头是什么字符 —— 退出码必须是 1。
 *
 * 两份层映射（`lib/audit/layers.js` 与脚本里那份）必须逐名一致：脚本不许 import `lib/`，
 * 抄一份是规则所迫，但抄错了没有任何症状，所以在这里钉住。脚本的 `--table` 就是为这条
 * 红灯开的：判据自己不测一遍，等于没写过。
 */
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LAYER_BY_NAME, NON_CONCLUSION_LAYERS } from "../lib/audit/layers.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "check-audit-completeness.mjs");
const SCRIPT_TEXT = fs.readFileSync(SCRIPT, "utf8");

/** 跑一次门禁脚本，只给补丁表（其余走夹具默认值）。 */
function runWithTable(tablePath) {
  return spawnSync(process.execPath, [SCRIPT, "--table", tablePath], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60000,
  });
}

/** 写一份只有一条补丁的最小补丁表；`layer` 由调用方给。 */
function tableWithLayer(layerCn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp38-layer-"));
  const file = path.join(dir, "table.js");
  // 形态必须与 lib/patch/table.js 一致：`id:` 与 `layer:` 各自**独占一行**。
  // 挤在一行（`{ id: 1, name: "x", layer: "y" }`）会被解析器整段跳过，
  // 于是这条红灯什么都点不到 —— 夹具与真实表的形状对齐本身就是判据的一部分。
  fs.writeFileSync(file, [
    "export const PATCHES = [",
    "  {",
    "    id: 900,",
    '    name: "LAYER_GUARD_FIXTURE",',
    `    layer: "${layerCn}",`,
    '    file: "agent-loop",',
    "  },",
    "];",
    "",
  ].join("\n"), "utf8");
  return { dir, file };
}

test("两份层映射同源：脚本里抄的那份与 lib/audit/layers.js 逐名一致", () => {
  for (const [cn, slug] of Object.entries(LAYER_BY_NAME)) {
    assert.ok(
      SCRIPT_TEXT.includes(`"${cn}": "${slug}"`),
      `脚本里没有 ${cn} → ${slug}：脚本抄的那份与 layers.js 漂了`,
    );
  }
  for (const cn of NON_CONCLUSION_LAYERS) {
    assert.ok(
      SCRIPT_TEXT.includes(`"${cn}"`),
      `脚本里没有声明非结论层「${cn}」：它会被当成未映射层判红，而它是设计使然`,
    );
  }
});

test("闸门放行：已声明的兼容层不算未映射（真表跑得过）", () => {
  const result = runWithTable(path.join(ROOT, "lib", "patch", "table.js"));
  assert.notEqual(result.status, 2, `环境错误，不是判据结论：\n${result.stderr}`);
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /未映射的层名/,
    "真表里的兼容层被当成未映射层判红了 —— 声明没生效",
  );
});

test("红灯：未登记的层名以数字开头，退出码必须是 1（旧写法这里静默放过）", () => {
  const { dir, file } = tableWithLayer("0.9.9 遗留");
  try {
    const result = runWithTable(file);
    assert.equal(
      result.status,
      1,
      `数字开头的未映射层名没有被拦下（退出码 ${result.status}）—— \`!/^\\d/\` 那个后门又回来了`,
    );
    assert.match(
      `${result.stdout}${result.stderr}`,
      /未映射的层名「0\.9\.9 遗留」/,
      "判红但没有点名是哪个层名：读者无从修",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("红灯：未登记的层名与数字无关时同样判红（不是只拦数字开头）", () => {
  const { dir, file } = tableWithLayer("实验层");
  try {
    const result = runWithTable(file);
    assert.equal(result.status, 1, `非数字开头的未映射层名没被拦下（退出码 ${result.status}）`);
    assert.match(`${result.stdout}${result.stderr}`, /未映射的层名「实验层」/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("已声明的兼容层名写在补丁表里不算未映射（声明与门禁同一口径）", () => {
  for (const cn of NON_CONCLUSION_LAYERS) {
    const { dir, file } = tableWithLayer(cn);
    try {
      const result = runWithTable(file);
      assert.notEqual(result.status, 2, `环境错误：\n${result.stderr}`);
      assert.doesNotMatch(
        `${result.stdout}${result.stderr}`,
        /未映射的层名/,
        `已声明的非结论层「${cn}」被判成未映射：声明与门禁不同口径`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
