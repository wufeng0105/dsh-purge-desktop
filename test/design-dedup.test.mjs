/**
 * test/design-dedup.test.mjs — 十二组原语的「基础定义只剩一条」与级联取值快照
 *
 * 为什么存在：清重复定义那条判据原先写成「同一个选择器不许出现两次」，正则数的是
 * 「`.名字` 后面紧跟 `{`、`,`、`:`」。这条判据机械上不可能绿，因为它把伪类、组合符与
 * at-rule 里的命中一起算成了定义：`.dshp-btn:disabled`、`.dshp-field:focus`、
 * `.dshp-row+.dshp-row`、`.dshp-summary>.dshp-row:first-child`、以及
 * `@media (prefers-reduced-motion:reduce)` 里那条本来就该有的 `.dshp-btn{transition:none}`。
 * 这些删掉就是删样式，不是清重复 —— 于是判据永远红，后面每一批都卡在同一处。
 *
 * 这个文件把「真正能判的两个形态」固定下来：
 *   一、**基础定义条数**：某条规则的选择器列表里**恰好有一项等于 `.名字`**（不带伪类、
 *       不带组合符、不带附加类）、且它**不在任何 at-rule 里**时，才算这个类的一条基础
 *       定义。十二组各必须恰好 1 条 —— 多一条就是「读代码看到的不是生效规则」回来了。
 *   二、**级联取值快照**：元素只有这一个类时（无状态 / hover / disabled / focus-visible
 *       × 首个 / 末个 / 非首末子元素 × 媒体查询关 / 开，共 12 个剖面 × 2 档），按源文件
 *       顺序做一次级联，把最终「属性 → 取值」逐行锁进
 *       `test/fixtures/design-cascade.snapshot.txt`。合并两份定义、换取值、改顺序、
 *       删掉一条没人覆盖的声明 —— 任何一处都会让某一行变红。
 *
 * 为什么第二条不能省：条数判据只看「有几条」，看不出「留下的是不是原来生效的那份」。
 * 两个同名规则里随便留一条都能让条数等于 1，而观感已经变了（例如 `.dshp-btn` 的
 * `height:28px` 与 `min-height:34px` 不是一个属性，删错一条按钮就从 34px 变 28px）。
 *
 * 快照的生成命令与算法说明写在 `.scratch/exec-WP9.md`；重生成：
 *   $env:DSH_PURGE_UPDATE_SNAPSHOT=1; node --test test/design-dedup.test.mjs
 * 重生成之后必须逐行 review：改了哪几行、对应哪次样式改动，要能对上。
 */
import { test } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SNAPSHOT = join(HERE, "fixtures", "design-cascade.snapshot.txt");

/** 三个设计片段按拼接入口的顺序读取：顺序就是级联顺序，换个顺序取值就变。 */
const DESIGN_FILES = ["components", "layout", "tokens"];

/**
 * 十二组原语。顺序即快照里的行序，改动会让 diff 整片变红，属于有意为之。
 *
 * 前八组是同族重复定义的第一批；后四组是第二批收的同类：`.dshp-area` 有三代基础定义
 * （原型、高版、与输入框对齐的那版），`.dshp-modal` 与 `.dshp-restart-mask` /
 * `.dshp-restart-card` 各两代，都是「后写的静默压过先写的那条」。新增组一律**追加在末尾**，
 * 这样既有读数行号不动，快照 diff 只剩新增的那一段。
 */
const GROUPS = [
  "dshp-row", "dshp-field", "dshp-empty", "dshp-actions",
  "dshp-btn", "dshp-modal-bg", "dshp-skel", "dshp-btn-danger",
  "dshp-area", "dshp-modal", "dshp-restart-mask", "dshp-restart-card",
];

const STATES = ["none", "hover", "disabled", "focus-visible"];
const CHILDREN = ["none", "first", "last"];
const PROFILES = STATES.flatMap((state) => CHILDREN.map((child) => ({ state, child })));

/** 媒体查询的两种读法：关掉（纯合并核验）/ 打开（含条件规则的最坏情形）。 */
const MEDIA_MODES = [false, true];

/** 片段文件的正文就是那一整串模板字面量：取首个反引号到末个反引号之间。 */
function cssOf(text) {
  const from = text.indexOf("`");
  const to = text.lastIndexOf("`");
  // 注释先抹掉：块注释落在规则前面会被当成选择器正文，那不是选择器。
  return text.slice(from + 1, to).replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 简写会把同族长属性重置掉；级联核验不照做，就会把「已被覆盖的长属性」误判成差异。 */
const SHORTHAND_ALIAS = { font: ["line-height"] };

function applyDecl(map, prop, value) {
  if (SHORTHAND_ALIAS[prop]) for (const alias of SHORTHAND_ALIAS[prop]) map.delete(alias);
  for (const key of [...map.keys()]) {
    if (key === prop || key.startsWith(`${prop}-`)) map.delete(key);
  }
  map.set(prop, value);
}

function assemble() {
  return DESIGN_FILES
    .map((name) => cssOf(readFileSync(join(ROOT, "lib", "client-src", "design", `${name}.js`), "utf8")))
    .join("");
}

/** 极小的 CSS 分块器：返回 [{selectors, media, decls}]，顺序就是源文件顺序。 */
function parseRules(css) {
  const rules = [];
  let i = 0;
  let prelude = "";
  const stack = []; // 进入 @media / @keyframes 时的 prelude
  while (i < css.length) {
    const ch = css[i];
    if (ch === "{") {
      const head = prelude.trim();
      prelude = "";
      if (head.startsWith("@")) {
        stack.push(head);
        i += 1;
        continue;
      }
      // 收集到配对右括号为止（声明里不会出现裸花括号，函数用的是圆括号）。
      let depth = 1;
      let body = "";
      i += 1;
      while (i < css.length && depth > 0) {
        if (css[i] === "{") depth += 1;
        else if (css[i] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
        body += css[i];
        i += 1;
      }
      i += 1;
      const decls = body
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const at = d.indexOf(":");
          return at === -1 ? null : [d.slice(0, at).trim(), d.slice(at + 1).trim()];
        })
        .filter(Boolean);
      rules.push({
        selectors: head.split(",").map((s) => s.trim()).filter(Boolean),
        media: stack.length > 0 ? stack[stack.length - 1] : null,
        decls,
      });
      continue;
    }
    if (ch === "}") {
      stack.pop();
      prelude = "";
      i += 1;
      continue;
    }
    prelude += ch;
    i += 1;
  }
  return rules;
}

/** 选择器能否命中「只有类 name、带给定状态」的元素。 */
function matches(selector, name, profile) {
  if (!selector.startsWith(`.${name}`)) return false;
  let rest = selector.slice(name.length + 1);
  if (rest === "") return true;
  while (rest.length > 0) {
    if (rest.startsWith(".")) return false; // 需要附加类，孤立元素没有
    const m = /^:([a-z-]+)(?:\(([^)]*)\))?/.exec(rest);
    if (!m) return false;
    rest = rest.slice(m[0].length);
    const [, pseudo, arg] = m;
    if (pseudo === "disabled") {
      if (profile.state !== "disabled") return false;
    } else if (pseudo === "hover" || pseudo === "focus-visible") {
      if (profile.state !== pseudo) return false;
    } else if (pseudo === "first-child") {
      if (profile.child !== "first") return false;
    } else if (pseudo === "last-child") {
      if (profile.child !== "last") return false;
    } else if (pseudo === "not") {
      if (arg === ":disabled" && profile.state === "disabled") return false;
      if (arg && !arg.startsWith(":")) return false; // :not(.foo) 之类不在核验范围
    } else {
      return false;
    }
  }
  return true;
}

/** 按源文件顺序级联，得出「属性 → 取值」。 */
function cascade(rules, name, profile, withMedia) {
  const map = new Map();
  for (const rule of rules) {
    if (rule.media && !withMedia) continue;
    if (!rule.selectors.some((s) => matches(s, name, profile))) continue;
    for (const [prop, value] of rule.decls) applyDecl(map, prop, value);
  }
  return map;
}

/** 基础定义：选择器列表里恰好有一项等于 `.名字`，且这条规则不在任何 at-rule 里。 */
function baseDefs(rules, name) {
  return rules.filter((r) => r.media === null && r.selectors.some((s) => s === `.${name}`)).length;
}

const RULES = parseRules(assemble());

/** 一行一个读数：`组 | 状态/子元素 | 媒体查询 | 属性: 取值`。空剖面也留一行，覆盖数才不会漂。 */
function snapshotRows() {
  const lines = [];
  for (const name of GROUPS) {
    for (const profile of PROFILES) {
      for (const withMedia of MEDIA_MODES) {
        const head = `.${name} | ${profile.state}/${profile.child} | media=${withMedia ? "on" : "off"}`;
        const map = cascade(RULES, name, profile, withMedia);
        const props = [...map.keys()].sort();
        if (props.length === 0) {
          lines.push(`${head} | （无声明）`);
          continue;
        }
        for (const prop of props) lines.push(`${head} | ${prop}: ${map.get(prop)}`);
      }
    }
  }
  return lines;
}

const HEADER = [
  "# dsh-purge 设计原语级联快照",
  "#",
  "# 列：组 | 状态/子元素位置 | 媒体查询 | 属性: 取值",
  "# 口径：元素只有这一个类，按三个设计片段的源文件顺序级联后的最终取值。",
  "#      状态 none/hover/disabled/focus-visible × 子元素 none/first/last × media off/on。",
  "# 生成：test/design-dedup.test.mjs",
  "# 更新：$env:DSH_PURGE_UPDATE_SNAPSHOT=1; node --test test/design-dedup.test.mjs",
  "#",
  "# 任何一个取值变了，都说明这次的样式改动改了观感：要么修回去，要么在这里认下。",
].join("\n") + "\n\n";

/**
 * 归一到 LF 再比较。
 *
 * 必须做这一步：仓库 `core.autocrlf=true`，快照在 Windows 检出时是 CRLF、在 CI 是 LF。
 * 原样逐字符串比较会让这条测试变成「只在写它那台机器上绿」。
 */
function normalize(text) {
  return String(text).replace(/\r\n/g, "\n");
}

/** 快照头三列（组 / 剖面 / 媒体）的去重清单，用来判「快照有没有被悄悄裁小」。 */
function profileKeys(rows) {
  return [...new Set(rows.map((row) => row.split(" | ").slice(0, 3).join(" | ")))];
}

test("十二组原语的基础定义各恰好 1 条（选择器恰好等于 .名字、且不在 at-rule 里）", () => {
  assert.ok(RULES.length > 0, "设计片段里一条规则都没解析出来：判据没有被测物，会恒绿");
  const counts = GROUPS.map((name) => baseDefs(RULES, name));
  const table = GROUPS.map((name, i) => `  .${name}: ${counts[i]} 条`).join("\n");
  assert.deepEqual(
    counts,
    GROUPS.map(() => 1),
    `基础定义条数不是各 1 条：\n${table}\n`
    + "多一条就是同族定义又写了两遍（后代与伪类不算基础定义：`.dshp-btn:disabled`、"
    + "`.dshp-summary>.dshp-row:first-child` 这类本来就只有一条，别把它们当重复删掉）；"
    + "0 条说明这个类名已经没人定义，先看是不是改错了名字",
  );
});

test("级联快照：十二组 × 12 剖面 × 媒体查询关/开 与基线逐行相同", () => {
  const actual = normalize(HEADER + snapshotRows().join("\n") + "\n");
  if (process.env.DSH_PURGE_UPDATE_SNAPSHOT === "1") {
    writeFileSync(SNAPSHOT, actual, "utf8");
    console.log(`[snapshot] 写回 ${SNAPSHOT}`);
    return;
  }
  assert.ok(
    existsSync(SNAPSHOT),
    `快照文件不存在：${SNAPSHOT}。先生成：$env:DSH_PURGE_UPDATE_SNAPSHOT=1; node --test test/design-dedup.test.mjs`,
  );
  const expected = normalize(readFileSync(SNAPSHOT, "utf8"));
  if (actual === expected) return;

  // 逐行 diff：只报真正不同的行，不甩上千行全文。
  const a = actual.split("\n");
  const e = expected.split("\n");
  const diffs = [];
  const max = Math.max(a.length, e.length);
  for (let i = 0; i < max; i += 1) {
    if ((a[i] ?? "") === (e[i] ?? "")) continue;
    diffs.push(`  L${i + 1}\n    快照: ${e[i] ?? "（缺行）"}\n    实际: ${a[i] ?? "（缺行）"}`);
    if (diffs.length >= 40) break;
  }
  assert.fail(
    `级联取值与快照基线不同（共 ${diffs.length} 处，最多列 40 行）。\n`
    + `这不是格式问题：级联取值一变，观感就变了。\n${diffs.join("\n")}\n\n`
    + "如果这次改动本来就该改观感，用 DSH_PURGE_UPDATE_SNAPSHOT=1 重生成并逐行 review；"
    + "否则按快照把取值改回去。",
  );
});

test("快照覆盖十二组 × 12 剖面 × 媒体查询关/开，一个剖面都不许少", () => {
  // 防「快照被裁成手挑的子集」：少了某个剖面，那条路径再改也不会红。
  const rows = snapshotRows();
  const keys = profileKeys(rows);
  const expect = GROUPS.length * PROFILES.length * MEDIA_MODES.length;
  assert.equal(keys.length, expect, `剖面条数 ${keys.length}，应为 ${expect}`);
  const covered = new Set(keys.map((key) => key.split(" | ")[0].slice(1)));
  assert.deepEqual([...covered].sort(), [...GROUPS].sort(), "快照没覆盖全部十二组");
  const orphan = rows.filter((row) => !row.split(" | ")[3]);
  assert.deepEqual(orphan, [], "有行的第四列是空的：拆列口径被改过");
});
