/**
 * test/drill-main-layout.test.mjs — 演练台在主区座位上的布局契约（T34，方案 B）。
 *
 * ## 为什么布局也能钉
 *
 * 「点侧栏图标进去没有布局、也不能下滑、底部编辑器被剪断」这条真机症状的**根因是选择器**：
 * 主区把面板直接渲进座位，而内嵌布局规则全挂在 `.dshp-dock-body` 祖先下。祖先不在，那一组
 * 高度链就一起失效 —— `overflow:hidden` 于是变成剪刀。
 *
 * ## 方案 B 的判据只有一句话：**整页只有一个滚动条**
 *
 * 所以断言分两半：外层 `.dshp-root--main` 自己滚（`overflow:auto`），**内层一律不许再出滚动条**
 * （`.rt-body` / `.rt-main` / `.rt-pane` 都是 `overflow:visible`）。出现「页面滚一个、内容区再滚
 * 一个」就是做错了 —— 这一条比「某条规则存在」更能抓住回退，所以单列。
 *
 * 标签栏跟着滚走是方案 B 的已知代价（不做 sticky），因此这里**不**断言标签栏固定。
 *
 * 断言对象是产物 `client.js`（用户真正加载的那一份），源片段只用来核对类名没被改回去。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CLIENT = readFileSync(join(ROOT, "client.js"), "utf8");
const FRAGMENT = readFileSync(join(ROOT, "lib", "client-src", "main", "drill-panel.js"), "utf8");

/**
 * 取出主区那一组规则的正文：从 `.dshp-root--main{` 第一次出现起，到组末尾的连续空行为止。
 *
 * 用「第一条主区选择器」当起点而不是某个注释标记：注释是给人看的，删了不该让判据失效。
 */
function mainAreaBlock() {
  const at = CLIENT.indexOf(".dshp-root--main{");
  assert.ok(at > 0, "client.js 里没有 `.dshp-root--main` 的样式块 —— 主区布局规则没了");
  const rest = CLIENT.slice(at);
  return rest.slice(0, rest.indexOf("\n\n") + 1);
}

test("wrapper 带主区类：片段与产物两侧都在（改回去就退回旧症状）", () => {
  assert.match(
    FRAGMENT,
    /className:\s*"dshp-root dshp-root--main"/,
    "主区 wrapper 没有带上 dshp-root--main：内嵌布局规则继续挂在不存在的祖先下",
  );
  assert.ok(
    (FRAGMENT.match(/dshp-root--main/g) || []).length >= 3,
    "三条渲染分支（未加载 / 未授权 / 正常）应保持同一个类名，否则两种态布局不一样",
  );
  assert.ok(CLIENT.includes("dshp-root dshp-root--main"), "产物里没有主区类：build 没跑或片段没装配进去");
});

test("外层负责滚动：整页一条滚动条，内层全部 overflow:visible", () => {
  const block = mainAreaBlock();
  assert.match(block, /\.dshp-root--main\{[^}]*overflow:auto/, "主区自己不是滚动容器：整页没法纵向滚动");
  assert.match(block, /\.dshp-root--main\{[^}]*height:100%/, "主区没有占满：滚动的会是宿主而不是这一页");
  assert.match(block, /\.dshp-root--main\{[^}]*padding:16px 20px/, "主区没有页面级内边距：内容贴着边");
  assert.match(block, /\.dshp-root--main\{[^}]*box-sizing:border-box/, "缺 box-sizing：内边距会把内容挤出视口");
  assert.match(
    block,
    /\.dshp-root--main\s+\.rt-pane\{[^}]*overflow:visible/,
    "主区的 .rt-pane 还在自己滚：会出现第二个滚动条",
  );
  assert.match(block, /\.dshp-root--main\s+\.rt-main\{[^}]*overflow:visible/, ".rt-main 仍在裁剪内容");
  /* 统计行在页脚里；页脚与 .rt-body 是兄弟节点，不跟着 1100 约束就会贴视口最左（T49）。
     这条规则在共享样式表的另一段里（设置页那组之后），所以对产物整体断言。 */
  assert.match(
    CLIENT,
    /\.rt-foot\{[^}]*max-width:1100px[^}]*margin:0 auto/,
    "页脚没有跟正文同宽的约束：统计数字会贴到视口最左",
  );
  assert.match(block, /\.dshp-root--main\s+\.rt-body\{[^}]*overflow:visible/, ".rt-body 仍在裁剪内容");
  /* 内容列的上限：WP17 定 1400，WP23 按「一屏别铺满」收到 1100。判据只要求「有上限且居中」，
     具体数值跟着设计基线走。 */
  assert.match(block, /\.dshp-root--main\s+\.rt-body\{[^}]*max-width:1100px[^}]*margin:0 auto/, "缺宽屏居中的最大宽度");
});

test("内层不再抢滚动：主区下没有任何 overflow:auto 的 .rt-* 规则（双滚动条就是做错了）", () => {
  const block = mainAreaBlock();
  const inner = [...block.matchAll(/\.dshp-root--main[^{]*\.rt-[a-z-]+[^{]*\{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(inner.length >= 3, `从主区块里只取到 ${inner.length} 条 .rt-* 规则，取样点变了`);
  const scrollers = inner.filter((rule) => /overflow:\s*auto/.test(rule));
  assert.deepEqual(
    scrollers,
    [],
    `主区内部又出现了滚动容器：整页会变成两个滚动条（${scrollers.join(" / ")}）`,
  );
  assert.match(
    block,
    /\.rt-dock\{[^}]*height:auto/,
    "内层 dock 没有退回 auto 高度：高度链会把内容挤在一个固定高度里",
  );
});

test("作用域：这一组只对主区生效，且不靠 !important 硬拧", () => {
  const block = mainAreaBlock();
  const selectors = [...block.matchAll(/(^|\n)\s*(\.[^{}\n]+)\{/g)]
    .map((m) => m[2].trim())
    .filter((sel) => sel.startsWith("."));
  assert.ok(selectors.length >= 5, `从主区块里只取到 ${selectors.length} 条选择器，取样点变了`);
  /* 每条选择器都必须**带上主区类**：少了它就是一条会命中设置页或浮窗的全局规则。
     `>` 组合子那条写成 `.dshp-root.dshp-root--main>.rt-dock`（为了在具体度上压过演练台自己的
     `.rt-dock.rt-embedded`），它同样只匹配主区。 */
  const leaked = selectors.filter((sel) => !sel.includes(".dshp-root--main"));
  assert.deepEqual(leaked, [], `主区规则里出现非主区选择器：会污染设置页或浮窗（${leaked.join("、")}）`);
  assert.ok(
    !block.includes("!important"),
    "主区规则里出现了 !important：几个页签把 overflow 写在行内样式上，靠 !important 去拧它们正是要避免的堆砌",
  );
  // 浮窗语义不许被借过来：主区规则里出现 .dshp-dock-body 说明两套高度来源混在一起了。
  assert.ok(
    !block.includes(".dshp-dock-body"),
    "主区规则里引用了 .dshp-dock-body：那是浮窗的高度来源，主区没有这个祖先",
  );
});

/* ══════════════════════════════════════════════════════════════════════════════
   设计系统与页面壳（WP17 / T35）
   ══════════════════════════════════════════════════════════════════════════════ */

test("设计语言：四档字号 + 六档间距刻度 + 等宽数字", () => {
  const tokens = [
    ["--dshp-fs-page:20px", "页标题 20"],
    ["--dshp-fs-section:16px", "分节标题 16"],
    ["--dshp-fs-body:13.5px", "正文 13.5"],
    ["--dshp-fs-meta:12px", "元信息 12"],
    ["--dshp-sp-1:4px", "间距 4"],
    ["--dshp-sp-2:8px", "间距 8"],
    ["--dshp-sp-3:12px", "间距 12"],
    ["--dshp-sp-4:16px", "间距 16"],
    ["--dshp-sp-5:20px", "间距 20"],
    ["--dshp-sp-6:32px", "间距 32"],
  ];
  for (const [needle, label] of tokens) {
    assert.ok(CLIENT.includes(needle), `设计语言缺 ${label}（${needle}）：刻度散了，版式就回到各页各写一套`);
  }
  assert.match(CLIENT, /\.rt-stat__num\{[^}]*font-variant-numeric:tabular-nums/, "统计数字没用等高数字：一列数字会跳");
  assert.match(CLIENT, /\.rt-stat__num\{[^}]*font-family:var\(--dshp-mono\)/, "密集数字没有等宽栈");
  // 一个强调色只给主操作 / 当前页签 / 焦点环：这三处之外出现 brand-primary 就是第二强调色。
  const accent = [...CLIENT.matchAll(/[^{}]*\{[^}]*var\(--dsw-alias-brand-primary[^}]*\}/g)]
    .map((m) => m[0].split("{")[0].trim())
    .filter((sel) => sel.includes(".rt-"));
  assert.ok(accent.length > 0, "产物里找不到任何用强调色的 .rt- 规则：主操作没有强调");
});

test("页面壳：页头在、标签栏与内容同左边缘、焦点环用强调色而不是 UA 方框", () => {
  /* 页头：主区（embedded）也要有标题 —— 原来 `embedded ? null : ...` 把标题藏了，进来第一眼就是标签栏。 */
  assert.ok(
    !/embedded \? null : h\('div', \{ className: 'rt-title' \}/.test(CLIENT),
    "主区仍把页头标题藏起来：进演练台看不到「演练台」这一行",
  );
  assert.match(CLIENT, /h\('div', \{ className: 'rt-title' \}/, "产物里没有页头标题");
  /* 标签栏与内容同左边缘：三段内边距只能在外层给一次，内层一律 0。 */
  assert.match(CLIENT, /\.dshp-root--main \.rt-head[^{]*\{[^}]*padding:0 0 var\(--dshp-sp-3\)/, "页头还带着自己的左右内边距：与内容左边缘对不齐");
  assert.match(CLIENT, /\.dshp-root--main \.rt-tabs[^{]*\{[^}]*padding:0/, "标签栏还带着自己的左右内边距：与内容左边缘对不齐");
  /* 焦点环：强调色 2px，去掉浏览器默认方框。 */
  assert.match(
    CLIENT,
    /\.rt-tab:focus-visible\{[^}]*outline:2px solid var\(--dsw-alias-brand-primary/,
    "标签栏没有自己的焦点环：用户键盘走到「技能库」时会看到浏览器默认方框",
  );
  /* 当前页签用下划线 + 字重，不用色块。 */
  assert.match(CLIENT, /\.rt-tab\.on\{[^}]*border-bottom-color:var\(--dsw-alias-brand-primary/, "当前页签没有下划线");
});

test("两个原语与注意块：空态左对齐限宽、统计行分组、注意块替代警告符号", () => {
  /* 原语函数在产物里（演练台内部通用）。 */
  assert.match(CLIENT, /function StatRow\(props\) \{/, "产物里没有统计行原语 StatRow");
  assert.match(CLIENT, /function EmptyState\(props\) \{/, "产物里没有空态原语 EmptyState");
  /* 空态：左对齐 + 限宽 + 路径单独一行。 */
  assert.match(CLIENT, /\.rt-empty\{[^}]*text-align:left/, "空态还在居中：整页只有它居中，看起来像报错");
  assert.match(CLIENT, /\.rt-empty\{[^}]*max-width:68ch/, "空态没有限宽：一句说明会拉满整屏");
  assert.match(CLIENT, /\.rt-empty__path\{[^}]*font-family:var\(--dshp-mono\)/, "空态里的路径没有单独的等宽行");
  /* 统计行：分组 + 数字大 + 标签小。 */
  assert.match(CLIENT, /\.rt-stats\{[^}]*gap:var\(--dshp-sp-6\)/, "统计行没有分组间距");
  assert.match(CLIENT, /\.rt-stat__label\{[^}]*font-size:var\(--dshp-fs-meta\)/, "统计行标签没有用小一号的字");
  /* 注意块：替代警告符号，且文案前缀是语义化的「注意 / Note」。 */
  assert.match(CLIENT, /\.rt-caution\{[^}]*border:1px solid/, "注意块没有边框：和正文分不开");
  const i18n = readFileSync(join(ROOT, "lib", "client-src", "i18n.js"), "utf8");
  assert.match(i18n, /"drill\.note": "注意"/, "词典里没有「注意」前缀键");
});
