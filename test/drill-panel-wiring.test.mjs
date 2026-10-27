/**
 * test/drill-panel-wiring.test.mjs — 演练台到底有没有挂上去（T56）。
 *
 * ## 为什么这条用例比人工门更早生效
 *
 * 发版人工门里「点面板」的两种失败形态是：空白页，或「演练台组件没有随产物加载」那条说明。
 * 后半句其实是**可判的**：产物里有没有把面板注册进 `main` 座、有没有往 `sidebar.panellist`
 * 注入图标、三条渲染分支在不在 —— 都能用断言钉住。钉住之后，人工门剩下的只是「看起来对不对」。
 *
 * 断言读的是**产物 `client.js`**（用户真正加载的那一份），不是片段：片段对、产物漏装，
 * 正是这条用例要抓的那种错。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CLIENT = readFileSync(join(ROOT, "client.js"), "utf8");

/** 取一段源码（从某处起，按字符数截）；找不到直接红。 */
function sliceFrom(needle, length) {
  const at = CLIENT.indexOf(needle);
  assert.ok(at > 0, `产物里找不到 ${needle}`);
  return CLIENT.slice(at, at + length);
}

test("main 座注册存在，且第二个参数是函数标识符（不是 null / 空函数）", () => {
  const call = /slots\.register\(\{[^}]*name:\s*"main"[^}]*key:\s*"dsh-purge-drill"[^}]*\},\s*([^)]*)\)/s.exec(CLIENT);
  assert.ok(call, "产物里没有往 main 座注册演练台：点侧栏图标会是空白页");
  const second = call[1].trim();
  assert.match(second, /^[A-Za-z_$][\w$]*$/, `main 座的第二个参数不是函数标识符：<${second.slice(0, 40)}>`);
  assert.equal(second, "PurgeDrillPanel", `main 座注册的不是面板组件，而是 ${second}`);
  assert.ok(!/\bnull\b/.test(second), "main 座的第二个参数是 null：面板挂不上去");
});

test("sidebar.panellist 注入存在，且注入的是 PurgeDrillIcon", () => {
  const call = /slots\.inject\(\s*"sidebar\.panellist"[\s\S]{0,600}?slots\.register\(\{[^}]*name:\s*"sidebar\.panellist"[^}]*\},\s*([^)]*)\)/.exec(CLIENT);
  assert.ok(call, "产物里没有往侧栏注入面板图标：用户找不到入口");
  assert.equal(call[1].trim(), "PurgeDrillIcon", `侧栏注入的不是图标组件，而是 ${call[1].trim()}`);
  assert.match(CLIENT, /function PurgeDrillIcon\(\)/, "产物里没有 PurgeDrillIcon 的定义");
});

test("面板三条分支都在：缺组件说明 / 授权门 / 正常包裹", () => {
  const panel = sliceFrom("function PurgeDrillPanel()", 1400);
  assert.match(panel, /!__dshPurgeDrill\s*\|\|\s*typeof __dshPurgeDrill\.Panel !== "function"/, "缺「组件没有随产物加载」那条判断");
  assert.match(panel, /t\("drill\.missing"\)/, "缺「组件没有随产物加载」那条说明文案");
  assert.match(panel, /readDrillAuth\(\)/, "缺授权门判断：未授权时会把数据接口直接暴露");
  assert.match(panel, /h\(AuthGate,/, "缺授权门组件");
  assert.match(panel, /h\(__dshPurgeDrill\.Panel, \{ embedded: true \}\)/, "正常分支没有把面板按 embedded 渲染");
  const roots = (panel.match(/className: "dshp-root dshp-root--main"/g) || []).length;
  assert.ok(roots >= 3, `三条分支里有 ${roots} 条用了主区包裹类：应当三条都在 .dshp-root--main 里`);
});
