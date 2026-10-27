/**
 * test/drill-main-position.test.mjs — 主区的演练台不是浮窗（T41）。
 *
 * ## 为什么这条判据要单独存在
 *
 * 前五批的结构性用例全绿，用户看到的却是「内容压住宿主 UI、顶部穿透、整页不能滚」。
 * 根因是一条**没人断言过**的 CSS：演练台的基础规则是 `position:fixed;top:12px;right:12px;z-index:20`，
 * 而 WP16 的主区覆盖只改了 `height/min-height/flex/width`，没碰 `position` 与 `inset`。
 * 于是主区里那个「页面」其实是贴在视口右上的固定层：不参与页面流（所以没布局）、
 * 内容溢出（所以滚不动）、盖住宿主（所以顶部穿透）。
 *
 * 判据因此写成三条：
 *   一、主区规则必须显式给出 `position:relative`（覆盖基础规则的 fixed）；
 *   二、必须 `inset:auto`（否则 top/right 还把它顶到视口右上）；
 *   三、主区规则里**不许**出现 `position:fixed`（那等于没修）。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CLIENT = readFileSync(join(ROOT, "client.js"), "utf8");

/** 取主区那条 `.rt-dock` 规则的正文（选择器写死了两次，任一处都要满足）。 */
function mainDockRules() {
  const rules = [...CLIENT.matchAll(/\.dshp-root\.dshp-root--main>\s*\.rt-dock\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(rules.length > 0, "产物里没有「主区 .rt-dock」规则：定位覆盖根本没写");
  return rules;
}

test("主区 dock 必须是相对定位：position:relative 且 inset:auto", () => {
  for (const body of mainDockRules()) {
    assert.match(body, /position:\s*relative/, "主区 .rt-dock 没有 position:relative：它会退回基础规则的 fixed");
    assert.match(body, /inset:\s*auto/, "主区 .rt-dock 没有 inset:auto：top/right:12px 仍会把它顶到视口右上");
  }
});

test("主区 dock 不许是 fixed，也不许保留视口偏移", () => {
  for (const body of mainDockRules()) {
    assert.ok(!/position:\s*fixed/.test(body), "主区 .rt-dock 仍是 position:fixed：这就是用户看到的「没有布局」");
    assert.ok(!/\btop:\s*\d/.test(body), "主区 .rt-dock 还写着 top:<数值>：它仍会被顶离页面流");
    assert.ok(!/\bright:\s*\d/.test(body), "主区 .rt-dock 还写着 right:<数值>");
  }
});

test("高度链与宽度仍归主区规则管（修定位不许顺手删掉 WP16 的声明）", () => {
  for (const body of mainDockRules()) {
    assert.match(body, /height:\s*auto/, "主区 dock 丢了 height:auto");
    assert.match(body, /width:\s*100%/, "主区 dock 丢了 width:100%");
    assert.match(body, /display:\s*flex/, "主区 dock 丢了 display:flex");
  }
});

test("基础规则仍然是浮窗语义（只在主区被覆盖，不把浮窗一起改坏）", () => {
  const base = /\.rt-dock\{([^}]*position:fixed[^}]*)\}/.exec(CLIENT);
  assert.ok(base, "产物里没有 .rt-dock 的基础规则");
  assert.match(base[1], /position:\s*fixed/, "基础规则不再是 fixed：浮窗形态被连坐改了 —— 那不是本批的范围");
});
