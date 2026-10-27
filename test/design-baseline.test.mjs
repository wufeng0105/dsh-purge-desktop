/**
 * test/design-baseline.test.mjs — 字体与按钮层级的设计基线（T42）。
 *
 * ## 这三条为什么算判据、不算口味
 *
 * 1. `--dshp-display` 是**衬线**栈（Songti / Palatino / Georgia），却被用在十来处标题上：
 *    在一套暗色控制台界面里，衬线标题会让人第一眼觉得「这不是同一个产品」。
 * 2. `--dshp-sans` 首位是 `Yu Gothic UI`：Windows 上中文会拿到**日文字形** —— 用户说的
 *    「字体是什么呀」就是这一条。
 * 3. `.rt-btn-primary` 直接铺 `--dsw-alias-brand-primary`：这套主题里它接近黑，于是「刷新」
 *    与「保存」两个黑块平级，主操作没有层级。
 *
 * 判据只看**变量值与规则形态**，不评价好看不好看：
 *   一、字体栈里不出现衬线族名，sans 首位不是日文族名；
 *   二、主按钮底色不是纯黑（声明文本里不许出现 `#000` / `black`，且必须与页面底色混合）；
 *   三、三层按钮各有一条规则（主 / 次 / 文字）。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CLIENT = readFileSync(join(ROOT, "client.js"), "utf8");

/**
 * 离线预览是**本机历史产物**：`/.scratch/design-preview/` 被 `.gitignore` 忽略，干净克隆里没有它。
 * 所以拿它的那几条只能在「它在」时判：缺了要跳过，而不是 ENOENT 判红 ——
 * 否则任何新克隆跑 `npm test` 都会红，一条本机设计基线反而把全仓门禁拖垮。
 * 产物侧（`client.js`）的断言永远跑，不受影响。
 */
function previewArtifact(name) {
  try {
    return readFileSync(join(ROOT, ".scratch", "design-preview", name), "utf8");
  } catch {
    return null;
  }
}

const PREVIEW_HTML = previewArtifact("drill.html");
const PREVIEW_BUILD = previewArtifact("build.mjs");
const PREVIEW_SKIP = PREVIEW_HTML ? false : "本机没有 .scratch/design-preview/drill.html（该目录不入库）";

/** 取一个 CSS 变量的声明值（产物里第一个命中）。 */
function cssVar(name) {
  const found = new RegExp(`${name}\\s*:\\s*([^;}]+)`).exec(CLIENT);
  assert.ok(found, `产物里找不到 ${name}：变量被删了或改名了`);
  return found[1].trim();
}

const SERIF = ["Songti", "Noto Serif", "Iowan", "Palatino", "Georgia", "serif"];

test("字体：标题不再用衬线，sans 不再以日文字族开头", () => {
  const sans = cssVar("--dshp-sans");
  const display = cssVar("--dshp-display");
  for (const name of SERIF) {
    const pattern = new RegExp(`(^|[^a-z-])${name}`, "i");
    assert.ok(!pattern.test(sans), `--dshp-sans 里还有衬线族名 ${name}`);
    assert.ok(!pattern.test(display), `--dshp-display 里还有衬线族名 ${name}：标题会像另一个产品`);
  }
  assert.ok(!/Yu Gothic|Hiragino|Meiryo|MS PGothic/i.test(sans), "--dshp-sans 里还有日文字族：中文会拿到日文字形");
  assert.match(sans, /^"?Microsoft YaHei UI"?|^"?PingFang SC"?|^"?Noto Sans SC"?|^"?Source Han Sans SC"?/, `--dshp-sans 第一位不是中文字族：${sans}`);
  /* 变量值里不出现 serif 这个词（族名与关键字都算）。 */
  assert.ok(!/serif/i.test(display.replace(/--dshp-display\s*:\s*/g, "")), "--dshp-display 里还有 serif");
});

test("等宽：--dshp-mono 用系统等宽，不引外部字体", () => {
  const mono = cssVar("--dshp-mono");
  assert.match(mono, /Consolas|Cascadia Mono|JetBrains Mono|Courier New/, `--dshp-mono 不是系统等宽栈：${mono}`);
  assert.ok(!/https?:|@font-face/i.test(mono), "--dshp-mono 里出现了外部字体引用");
});

test("按钮三层：主 / 次 / 文字各一条，主按钮不是纯黑", () => {
  const primary = /\.dshp-root--main \.rt-btn\.rt-btn-primary\{([^}]*)\}/.exec(CLIENT);
  const secondary = /\.dshp-root--main \.rt-btn\{([^}]*)\}/.exec(CLIENT);
  const text = /\.dshp-root--main \.rt-btn\.rt-btn-text\{([^}]*)\}/.exec(CLIENT);
  assert.ok(secondary, "没有主区的次按钮规则（1px 边框那一层）");
  assert.ok(primary, "没有主操作规则");
  assert.ok(text, "没有文字操作那一层");

  assert.ok(!/#000|black/i.test(primary[1]), "主按钮底色是纯黑：一屏两个黑块，主操作没有层级");
  assert.match(primary[1], /color-mix\(/, "主按钮底色没有与页面底色混合：主题 accent 接近黑时会直接铺成黑块");

  assert.match(secondary[1], /border:\s*1px solid/, "次按钮没有 1px 边框：它和文字操作分不开");
  assert.match(secondary[1], /height:\s*34px/, "按钮高度不是 34px");
  assert.match(secondary[1], /border-radius:\s*8px/, "按钮圆角不是 8px");
  assert.match(
    CLIENT,
    /\.dshp-root--main \.rt-btn:focus-visible\{[^}]*outline:2px solid var\(--dsw-alias-brand-primary\)/,
    "主区按钮没有焦点环规则",
  );

  assert.match(text[1], /border-color:\s*transparent/, "文字操作还有边框");
  assert.match(text[1], /background:\s*transparent/, "文字操作有底色");
});

test("强调色收敛：智能体样例里主按钮至多一个，刷新是次操作", { skip: PREVIEW_SKIP }, () => {
  const html = PREVIEW_HTML;
  /* 只数「智能体页样例」那一段：末尾的「按钮三层」是刻意展示三层的样板，不算一屏里的主操作。 */
  const start = html.indexOf('<div class="rt-body">');
  /* 找的是标记里的标题，不是 CSS 注释里的同名文字（注释早就在样式段里出现过一次）。 */
  const end = html.indexOf(">按钮三层<");
  assert.ok(start > 0 && end > start, "预览里找不到智能体样例段落");
  const body = html.slice(start, end);
  const primaries = (body.match(/class="[^"]*rt-btn-primary[^"]*"/g) || []).length;
  assert.equal(primaries, 1, `智能体样例里出现了 ${primaries} 个主按钮：一屏只该有一个（保存）`);
  assert.ok(
    /<button class="rt-btn">刷新<\/button>/.test(html), "刷新仍是主按钮：它该降为 1px 边框的次操作",
  );
});

test("层级：分节标题 ≥16px 且加粗，正文 13.5、说明 12", () => {
  const title = /\.rt-section__title\{([^}]*)\}/.exec(CLIENT);
  assert.ok(title, "产物里没有 .rt-section__title");
  const size = Number(/font-size:\s*(\d+(?:\.\d+)?)px/.exec(title[1])?.[1]);
  assert.ok(Number.isFinite(size) && size >= 16, `分节标题只有 ${size}px：与正文 13.5 差不到 2px，整页会读成一片平`);
  assert.match(title[1], /font-weight:\s*(600|650|700)/, "分节标题没有加粗一档");
  assert.match(cssVar("--dshp-fs-body"), /13\.5px/, "正文字号不是 13.5");
  assert.match(cssVar("--dshp-fs-meta"), /12px/, "说明字号不是 12");
});

test("栅格：角色网格按 280px 自动填充并限宽，资产表末列不吃 1fr", () => {
  assert.match(
    CLIENT,
    /\.rt-roles\{[^}]*repeat\(auto-fill,\s*minmax\(280px,\s*1fr\)\)/,
    "角色网格不是 repeat(auto-fill,minmax(280px,1fr))：两列会被拉到整屏宽，中间空出一条走道",
  );
  assert.match(CLIENT, /\.rt-roles\{[^}]*max-width:960px/, "角色网格没有限宽 960px");
  // 预览缺失时只跑产物侧：那两条断言与预览无关，不该跟着一起被跳过。
  if (!PREVIEW_HTML) return;
  const html = PREVIEW_HTML;
  const table = /<div class="rt-grid"[^>]*grid-template-columns:([^"]+)"/.exec(html);
  assert.ok(table, "预览里的资产表没有列宽定义");
  const last = table[1].trim().split(/\s+/).pop();
  assert.ok(!/^1fr$|^minmax\(0,\s*1fr\)$/.test(last), `资产表末列是 ${last}：数字会被推到页边`);
});

test("内容列与对齐：1100 列，页头/标签/内容同一条左边缘", () => {
  assert.match(CLIENT, /\.dshp-root--main \.rt-body\{[^}]*max-width:1100px/, "内容列不是 1100：整页会铺到 1400，右侧留一大片空");
  for (const [selector, label] of [[".rt-head", "页头"], [".rt-tabs", "标签栏"], [".rt-body", "内容"]]) {
    const rule = new RegExp(`\\.dshp-root--main \\${selector}[^{]*\\{[^}]*max-width:1100px`);
    assert.match(CLIENT, rule, `${label}没有跟内容同宽：三段左边缘会错位`);
  }
});

test("两栏：智能体页有主栏 / 辅栏容器，窄屏折一列", () => {
  assert.match(CLIENT, /\.rt-cols\{[^}]*grid-template-columns:minmax\(0,2fr\) minmax\(240px,1fr\)/, "没有两栏栅格（主 2fr / 辅 minmax(240px,1fr)）");
  const at = CLIENT.indexOf("function AgentsTab(");
  const page = CLIENT.slice(at, CLIENT.indexOf("function ConcurrencyCard(", at));
  assert.ok(page.includes("rt-cols__main"), "智能体页没有主栏容器");
  assert.ok(page.includes("rt-cols__aside"), "智能体页没有辅栏容器");
  assert.match(CLIENT, /@media \(max-width:900px\)\{\.rt-cols\{grid-template-columns:1fr\}/, "窄屏没有折成一列");
});

test("表格按比例填满容器，行高 32 / 表头 36", () => {
  if (PREVIEW_HTML) {
    const table = /<div class="rt-grid"[^>]*grid-template-columns:([^"]+)"/.exec(PREVIEW_HTML);
    assert.ok(table, "预览里的资产表没有列宽定义");
    assert.match(table[1], /fr/, `资产表列宽里没有 fr 比例：${table[1]} —— 容器宽了列不跟着宽`);
  }
  assert.match(CLIENT, /\.rt-grid__head,\.rt-grid__row\{[^}]*height:32px/, "表格行高不是 32");
  assert.match(CLIENT, /\.rt-grid__head\{[^}]*height:36px/, "表头行高不是 36");
});

test("状态点有条件渲染：三态 + 无靶标时不挂圆点", () => {
  assert.match(CLIENT, /rt-dot--ok/, "没有「正常」态的状态点");
  assert.match(CLIENT, /rt-dot--warn/, "没有「警告/未就绪」态的状态点");
  const at = CLIENT.indexOf("className: 'rt-title'");
  const block = CLIENT.slice(at, at + 420);
  assert.ok(!/h\('span', \{ className: 'rt-dot' \}\)/.test(block), "状态点仍是无条件渲染：静态页上会挂一个没有含义的圆点");
  assert.match(block, /eng && snapshot/, "状态点没有按条件判定");
});

test("离线预览：存在、内含真规则，且生成脚本读的是产物 client.js", { skip: PREVIEW_SKIP }, () => {
  const html = PREVIEW_HTML;
  for (const needle of [".dshp-root--main", ".rt-dock{", ".rt-grid{", ".rt-btn.rt-btn-primary", ".rt-btn.rt-btn-text"]) {
    assert.ok(html.includes(needle), `预览里没有 ${needle}：它没抽到真 CSS，或者规则被删了`);
  }
  /* 预览里的 CSS 必须能在产物里找到同一条 —— 手抄的 CSS 会在这里露馅。 */
  const primaryRule = /\.dshp-root--main \.rt-btn\.rt-btn-primary\{[^}]*\}/.exec(html);
  assert.ok(primaryRule, "预览里没有主按钮规则");
  assert.ok(CLIENT.includes(primaryRule[0]), "预览里的主按钮规则与产物对不上：这不是从 client.js 抽出来的");
  assert.ok(PREVIEW_BUILD, "预览在但生成脚本 build.mjs 不在：预览就成了不可复现的孤本");
  assert.match(PREVIEW_BUILD, /client\.js/, "生成脚本没有读 client.js：预览会与真产物漂");
  assert.match(PREVIEW_BUILD, /const PURGE_CSS = `|const CSS = `/, "生成脚本没有按产物里的模板字面量切片");
});
