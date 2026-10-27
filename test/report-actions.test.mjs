/**
 * test/report-actions.test.mjs — 报告页顶部动作收口（T54）。
 *
 * 报告不会自己变：复制 / 导出是「把已有报告带走」的两条路，「重新生成」价值最低（Lead 裁定砍掉）。
 * 判据钉两件事：工具栏里不再有触发 `load` 的按钮；动作总数 ≤ 2。
 * 空态里那个「先生成报告」是另一回事 —— 没有报告时它是唯一出路，不算工具栏动作。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CLIENT = readFileSync(join(ROOT, "client.js"), "utf8");

function pageSource(name) {
  const at = CLIENT.indexOf(`function ${name}(`);
  assert.ok(at > 0, `产物里没有 ${name}`);
  const rest = CLIENT.slice(at + 1);
  const next = rest.search(/\n {4}(?:function |\/\* -+)/);
  return next < 0 ? rest : rest.slice(0, next);
}

/** 取报告页工具栏那一段（`rt-toolbar` 到它后面的 `rt-body`）。 */
function toolbarOf(source) {
  const at = source.indexOf("className: 'rt-toolbar'");
  assert.ok(at > 0, "报告页没有工具栏");
  const end = source.indexOf("'rt-body'", at);
  return source.slice(at, end < 0 ? at + 1600 : end);
}

test("工具栏只剩复制 / 导出：没有触发 load 的按钮", () => {
  const bar = toolbarOf(pageSource("ReportTab"));
  const buttons = bar.match(/h\('button', \{[^}]*\}/g) || [];
  assert.ok(buttons.length <= 2, `报告工具栏有 ${buttons.length} 个按钮：只该留复制与导出`);
  const reloaders = buttons.filter((b) => /onClick: load\b/.test(b));
  assert.deepEqual(reloaders, [], "工具栏里还有一颗按钮在触发 load（那就是被砍掉的「重新生成」）");
});

test("被砍的那颗不再出现：没有第三个动作按钮、也没留下死键", () => {
  const source = pageSource("ReportTab");
  assert.ok(!/onClick: load \}, busy \? \[dt\('drill\.k30036'\)\]/.test(source), "「重新生成」按钮的处理函数还在");
  const i18n = readFileSync(join(ROOT, "lib", "client-src", "i18n.js"), "utf8");
  /* 键还在词典里可以（空态仍用「先生成报告」那条 ⇒ 用 d393），但工具栏不许再引用它。 */
  const bar = toolbarOf(source);
  assert.ok(!bar.includes("drill.d393"), "工具栏还引用着重生成那条文案键");
});

test("空态仍有一个主操作：没有报告时能生成", () => {
  const source = pageSource("ReportTab");
  assert.match(source, /h\(EmptyState, \{[^}]*action:/, "报告空态没有动作：没有报告时无路可走");
});
