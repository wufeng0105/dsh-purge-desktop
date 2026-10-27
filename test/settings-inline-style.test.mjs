/**
 * test/settings-inline-style.test.mjs — 设置页的内联样式只许减少（T50）。
 *
 * ## 为什么要有这条
 *
 * WP24 为了不越界，把页内导航与摘要行的样式写成 `page.js` 里的内联 token 样式；
 * 那些样式本该和演练台共用同一份 `PURGE_CSS`。内联样式不参与样式表的作用域、不跟着
 * 主题变量走（只能手写 token）、也无法被 `check-style-tokens` 之外的眼睛看见 —— 一旦
 * 成为习惯，同一个视觉规则会在两个文件里各写一份，然后慢慢漂。
 * 页签壳沿用了同一套现成类名（横条用页内导航那条，按钮用页签按钮那两条），所以下面
 * 「收编落点」那张类名表跟着界面结构换了对象，判据本身没变。
 * 判据：`settings/page.js` 里 `style: { … }` 的对象字面量**只许降不许升**。
 * 基线写死在下面；降了就把基线改小（改小是你做的事，改大要被这条拦住）。
 *
 * 允许的例外只有布局个例（`{ flex: 1 }` 这种占位），颜色与尺寸必须走类。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const PAGE = readFileSync(join(ROOT, "lib", "client-src", "settings", "page.js"), "utf8");
/**
 * 状态页签的内容（摘要那一行）也在设置页的标记里，只是本批搬进了自己的片段。
 * 「收编落点」判的是「这几个类还在设置页的标记里」——取样点跟着内容走，判据不变。
 */
const STATUS = readFileSync(join(ROOT, "lib", "client-src", "settings", "status-tab.js"), "utf8");
const SETTINGS_MARKUP = PAGE + "\n" + STATUS;

/** 共享样式表的正文分三份片段存放，拼接入口只把三段接成一个字符串，本身没有规则。 */
const CSS = ["tokens", "components", "layout"]
  .map((name) => readFileSync(join(ROOT, "lib", "client-src", "design", `${name}.js`), "utf8"))
  .join("\n");

/**
 * 基线：0 —— WP25 收编之后设置页里已经一条内联对象字面量都不剩（2026-10-27 实测行首
 * `style: {` 计数为 0），所以基线归零：再塞一条就红。只许往下调，往下调之前先跑一遍这条
 * 测试读出实测值；留一格缓冲等于允许一条新内联样式藏在门禁下面。
 */
const BASELINE = 0;

/** 数 `style: {` 的对象字面量（注释里提到的不算：注释不以 `style:` 开头）。 */
function inlineStyleCount(source) {
  return (source.match(/^\s*style:\s*\{/gm) || []).length;
}

test("内联样式只减不增：当前数量不超过基线", () => {
  const count = inlineStyleCount(PAGE);
  assert.ok(
    count <= BASELINE,
    `page.js 里的内联 style 从 ${BASELINE} 涨到了 ${count}：新样式请写进 lib/client-src/design/** 的类，` +
      "设置页与演练台共用同一份 PURGE_CSS",
  );
});

test("剩下的内联只许是布局个例：不许出现颜色与字号", () => {
  const blocks = [...PAGE.matchAll(/style:\s*\{([^}]*)\}/g)].map((m) => m[1]);
  for (const block of blocks) {
    assert.ok(!/color\s*:/.test(block), `内联样式里还有颜色：${block.trim()}`);
    assert.ok(!/font(-size|-weight)?\s*:/.test(block), `内联样式里还有字号/字重：${block.trim()}`);
    assert.ok(!/var\(--/.test(block), `内联样式里还有 token 引用（说明这是一条视觉规则）：${block.trim()}`);
  }
});

test("收编落点：这些类在共享样式表里有定义", () => {
  for (const selector of [
    ".dshp-nav{",
    ".dshp-nav__items{",
    ".dshp-tab-chip{",
    ".dshp-tab-btn{",
    ".dshp-tab-btn.on{",
    ".dshp-summary__counts{",
    ".dshp-count__label{",
    ".dshp-count__value{",
  ]) {
    assert.ok(CSS.includes(selector), `共享样式表里没有 ${selector}：设置页的类没有对应的规则`);
  }
  /* 设置页的标记里仍然带着这些类名（收编不是删类名，而是把样式搬走）。 */
  for (const className of ["dshp-nav__items", "dshp-tab-chip", "dshp-tab-btn", "dshp-count__value"]) {
    assert.ok(SETTINGS_MARKUP.includes(className), `设置页标记里不再使用 ${className}：类名被删了，样式收编就落空了`);
  }
});
