/**
 * test/drill-flow-pages.test.mjs — 三个流程页的结构契约（T38）。
 *
 * ## 判据为什么这么写
 *
 * 会话隧道 / 攻击链 / 报告三页的共同问题是「一页里什么都有，但没有形状」：卡片堆、平铺列表、
 * 大段文本。本批给它们三种形状：**分栏 + 定义列表**、**时间线**、**阅读面**。这里钉的就是
 * 「形状还在不在」——
 *
 *   一、三页各自的空态走 `EmptyState`（左对齐限宽 + 至多一个动作）；
 *   二、时间线与定义列表用新类（`.rt-timeline` / `.rt-def`），且**没有内联写死的 border 颜色**
 *      （写死色在暗色主题下会露馅，也不跟宿主 token 走）；
 *   三、报告阅读面限宽 60–70ch、行高 1.65。
 *
 * 一条用例抓一类回归：把时间线改回平铺 → ② 红；删掉限宽 → ③ 红。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CLIENT = readFileSync(join(ROOT, "client.js"), "utf8");

/** 按函数名切一页的源码。 */
function pageSource(name) {
  const at = CLIENT.indexOf(`function ${name}(`);
  assert.ok(at > 0, `产物里没有 ${name}`);
  const rest = CLIENT.slice(at + 1);
  const next = rest.search(/\n {4}(?:function |\/\* -+)/);
  return next < 0 ? rest : rest.slice(0, next);
}

test("三页的空态都走 EmptyState（不是裸文本）", () => {
  for (const [name, label] of [["SessionTab", "会话隧道"], ["ChainTab", "攻击链"], ["ReportTab", "报告"]]) {
    const source = pageSource(name);
    assert.match(source, /h\(EmptyState, \{/, `${label}的空态还是裸文本：没有左对齐限宽，也没有动作`);
  }
});

test("攻击链是时间线：`.rt-timeline` 容器 + 1px 竖线 + 圆点", () => {
  assert.match(CLIENT, /\.rt-timeline\{[^}]*padding-left/, "没有 .rt-timeline 容器规则");
  assert.match(CLIENT, /\.rt-timeline::before\{[^}]*width:1px/, "时间线没有 1px 竖线");
  assert.match(CLIENT, /\.rt-timeline>\*::before\{[^}]*border-radius:50%/, "时间线节点没有小圆点");
  const chain = pageSource("ChainTab");
  /* 判的是「节点列表那个容器」（`.rt-ap-hits`）也在时间线里，不是别处有个同名类就过。 */
  assert.ok(chain.includes("rt-ap-hits rt-timeline"), "攻击链的节点列表没有放进时间线容器：改回平铺就会红");
});

test("会话隧道：详情字段走定义列表，长文限宽", () => {
  assert.match(CLIENT, /\.rt-def\{[^}]*grid-template-columns:max-content/, "没有 .rt-def 两列定义");
  assert.match(CLIENT, /@media \(max-width:900px\)\{\.rt-def\{grid-template-columns:1fr\}/, "定义列表窄屏没有折成一列");
  const session = pageSource("SessionTab");
  assert.ok(session.includes("rt-def"), "会话详情没有用定义列表");
  assert.match(CLIENT, /\.rt-def dd,\.rt-def span\{[^}]*max-width:68ch/, "详情长文没有限宽 68ch");
});

test("报告是阅读面：68ch、行高 1.65、代码块等宽浅底", () => {
  assert.match(CLIENT, /\.rt-prose\{[^}]*max-width:(6\d|70)ch/, "报告正文没有 60–70ch 的限宽");
  assert.match(CLIENT, /\.rt-prose\{[^}]*line-height:1\.65/, "报告行高不是 1.65");
  assert.match(CLIENT, /\.rt-prose pre[^{]*\{[^}]*font-family:var\(--dshp-mono\)/, "报告代码块不是等宽");
  assert.match(CLIENT, /\.rt-prose pre[^{]*\{[^}]*background:var\(--dsw-alias-bg-layer-2\)/, "报告代码块没有浅底");
  assert.ok(pageSource("ReportTab").includes("rt-prose"), "报告页没有挂上阅读面类");
});

test("三页里没有内联写死的边线颜色（状态色只能来自 token）", () => {
  for (const name of ["SessionTab", "ChainTab", "ReportTab"]) {
    const source = pageSource(name);
    const hardcoded = [...source.matchAll(/border(?:Left|Right|Top|Bottom)?(?:Color)?:\s*['"]#[0-9a-f]{3,8}['"]/gi)].map((m) => m[0]);
    assert.deepEqual(hardcoded, [], `${name} 里有内联写死的边线颜色：${hardcoded.join("、")}`);
  }
});
