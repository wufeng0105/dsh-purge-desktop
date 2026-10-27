/**
 * 豁免棘轮：docs/布局约定.md 的 800 行豁免表行数只减不增。
 *
 * 为什么拿 git show HEAD 对比：豁免表是账本（豁免轮次日历那篇决策），「只减不增」
 * 的方向判据只有跟**已提交状态**比才成立 —— 工作区内部比永远是平的，事后拿历史
 * 比又追不上「这一笔就该红」。减必须同步删行：拆了文件却留着行，check-file-roles
 * 的死账检查会点名；本测试管另一半——不许新增，换名swap也算新增。
 *
 * 判据两条：
 *   一、工作区豁免表里的每个文件，HEAD 的豁免表里已登记（子集）；
 *   二、工作区行数 <= HEAD 行数（重复登记也会让行数涨，一并拦住）。
 *
 * git 不可用（比如从打包产物里跑测试）时 skip 并写明原因，不把「没量」当「没涨」。
 */
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAYOUT_DOC = "docs/布局约定.md";

/** 取一段 markdown 文本里的表格数据行（跳过分隔行，表头不是数据行）。 */
function tableRows(sectionText) {
  const rows = [];
  for (const line of sectionText.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) {
      rows.pop();
      continue;
    }
    if (cells.length >= 2) rows.push(cells);
  }
  return rows;
}

/** 按二级/三级/四级标题切段，取标题含指定片段的段全文。 */
function section(text, fragment) {
  let key = "";
  const map = new Map();
  for (const line of text.split("\n")) {
    const m = line.match(/^#{2,4}\s+(.+)$/);
    if (m) {
      key = m[1].trim();
      map.set(key, []);
    } else if (key) map.get(key).push(line);
  }
  for (const [title, body] of map) {
    if (title.includes(fragment)) return body.join("\n");
  }
  return null;
}

/** 豁免表的数据行 → 被豁免的文件路径集合（第一列去反引号）。 */
function exemptFiles(markdown) {
  const body = section(markdown, "豁免表");
  assert.ok(body !== null, `${LAYOUT_DOC} 里找不到豁免表（二级标题「二、豁免表」）`);
  const rows = tableRows(body);
  return {
    count: rows.length,
    files: rows.map((cells) => cells[0].replace(/`/g, "").trim()),
  };
}

function headLayout() {
  try {
    return execFileSync("git", ["show", `HEAD:${LAYOUT_DOC}`], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    return { error };
  }
}

test("豁免棘轮：工作区豁免表不许出现 HEAD 里没有的文件（只减不增）", (t) => {
  const head = headLayout();
  if (head.error) {
    return t.skip(`读不到 HEAD:${LAYOUT_DOC}（${head.error.message.split("\n")[0]}）——不在 git 仓库里，棘轮无从比起`);
  }
  const base = exemptFiles(head);
  const work = exemptFiles(readFileSync(join(ROOT, LAYOUT_DOC), "utf8"));

  const added = work.files.filter((f) => !base.files.includes(f));
  assert.deepEqual(
    added,
    [],
    `豁免表新增了 ${added.length} 个文件（${added.join("、")}）：豁免只减不增，`
    + "新文件超 800 行要拆，拆不动先补前置（characterization 快照 / 真机验证）再谈登记。",
  );
});

test("豁免棘轮：工作区豁免表行数不许超过 HEAD", (t) => {
  const head = headLayout();
  if (head.error) {
    return t.skip(`读不到 HEAD:${LAYOUT_DOC}（${head.error.message.split("\n")[0]}）——不在 git 仓库里，棘轮无从比起`);
  }
  const base = exemptFiles(head);
  const work = exemptFiles(readFileSync(join(ROOT, LAYOUT_DOC), "utf8"));

  assert.ok(
    work.count <= base.count,
    `豁免表行数 ${work.count} 超过 HEAD 的 ${base.count}：减必须同步删行，`
    + "拆分完成后把对应行删掉，别留着让账本虚高。",
  );
});
