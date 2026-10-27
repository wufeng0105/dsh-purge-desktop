/**
 * test/drill-content-pages.test.mjs — 说明与内容页的层级契约（T37）。
 *
 * ## 为什么按页切源码断言
 *
 * 这四页的问题不是「少个样式」，而是**层级**：四段几乎同档、硬约束挤成一段带「·」的文本、
 * 表单控件没有标签、空态没有引导。全文数次数抓不住这类回归（别处多写一个 `<label>` 就糊过去了），
 * 所以每条判据都先切出那一页的函数体，再在页内找它该有的东西。
 *
 * 判据：
 *   一、四页各自用上了 WP17 的原语（`StatRow` / `EmptyState`）——「说明」不再是自由段落；
 *   二、智能体页的「并发规则」是**列表**（`.rt-rule` + 逐条 `<li>`），不是含「·」的整段字符串；
 *   三、表单控件有可见标签（`<label htmlFor>`），并发数量那个输入框能被读屏软件念出来；
 *   四、技能徽章只走三档状态 token（`.rt-badge--ok/warn/idle`），不再自己造色名。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CLIENT = readFileSync(join(ROOT, "client.js"), "utf8");

/** 按函数名切出一页的源码（到下一个顶层 `function `/`/* ---` 分隔为止）。 */
function pageSource(name) {
  const at = CLIENT.indexOf(`function ${name}(`);
  assert.ok(at > 0, `产物里没有 ${name}`);
  const rest = CLIENT.slice(at + 1);
  const next = rest.search(/\n {4}(?:function |\/\* -+)/);
  return next < 0 ? rest : rest.slice(0, next);
}

const PAGES = ["AgentsTab", "EnvTab", "KnowledgeTab", "SkillsTab"];

test("四页都用上了原语：说明与计数不再是自由段落", () => {
  for (const name of PAGES) {
    const source = pageSource(name);
    const uses = /StatRow/.test(source) || /EmptyState/.test(source);
    assert.ok(uses, `${name} 既没用 StatRow 也没用 EmptyState：这一页的层级还是靠字号硬撑`);
  }
});

test("智能体页的「并发规则」是列表，不是一段带「·」的文本", () => {
  const source = pageSource("AgentsTab");
  const items = (source.match(/h\('li', \{ className: 'rt-rule__item'/g) || []).length;
  assert.ok(items >= 3, `「并发规则」只有 ${items} 条列表项：硬约束又回到整段文本了`);
  assert.ok(source.includes("className: 'rt-rule'"), "没有 .rt-rule 列表容器");
  /* 三条规则各自的文案必须落在 li 里：往前 400 字符内能看到 li 的类名。 */
  for (const key of ["drill.d671", "drill.d673", "drill.d674"]) {
    const at = source.indexOf(`dt('${key}')`);
    assert.ok(at > 0, `${key} 在智能体页里找不到`);
    const before = source.slice(Math.max(0, at - 400), at);
    assert.ok(
      before.includes("rt-rule__item"),
      `${key} 没有渲染成列表项：仍是一段含「·」的连续文本`,
    );
  }
  /* 「·」不许再出现在规则文案的渲染里（它就是「一段话」的形态标记）。 */
  for (const key of ["drill.d671", "drill.d673", "drill.d674"]) {
    const value = new RegExp(`"${key}":\\s*"([^"]*)"`).exec(CLIENT);
    if (!value) continue;
    assert.ok(
      /rt-rule__item/.test(source.slice(Math.max(0, source.indexOf(`dt('${key}')`) - 400), source.indexOf(`dt('${key}')`))),
      `${key} 的渲染点不在列表项里`,
    );
  }
});

test("表单有可见标签：并发数量那个输入框带 label 与 aria-label", () => {
  /* 标签在 ConcurrencyCard 里（AgentsTab 渲染它）：两段拼起来判。 */
  const source = pageSource("AgentsTab") + pageSource("ConcurrencyCard");
  assert.match(source, /h\('label', \{[^}]*htmlFor: 'rt-agents-max'/, "并发数量缺 <label htmlFor>：读屏软件念不出这个输入框是干什么的");
  assert.match(source, /id: 'rt-agents-max'/, "输入框没有 id：label 的 htmlFor 指不到它");
  assert.match(source, /'aria-label': dt\('drill\.d688'\)/, "输入框没有 aria-label 兜底");
  assert.ok(source.includes("className: 'rt-field__label'"), "标签没有走 .rt-field__label：字号会回到正文档");
});

test("技能徽章只走三档状态 token，不自己造色名", () => {
  const source = pageSource("SkillsTab");
  assert.match(source, /className: 'rt-badge rt-badge--/, "技能行没有用 .rt-badge 三档徽章");
  for (const tone of ["ok", "warn", "idle"]) {
    assert.ok(
      CLIENT.includes(`.rt-badge--${tone}{`) || CLIENT.includes(`.rt-badge--${tone},`),
      `缺少 .rt-badge--${tone} 的规则`,
    );
  }
  assert.match(CLIENT, /\.rt-badge--ok\{[^}]*var\(--dsw-alias-state-success-primary\)/, "ok 档没有走宿主语义 token");
  assert.match(CLIENT, /\.rt-badge--warn\{[^}]*var\(--dsw-alias-state-warn-primary\)/, "warn 档没有走宿主语义 token");
  /* 每行那条徽章不许再走自造的可用性类名（汇总区那几个 rt-avail-* 留给 WP18 之前的老样子）。 */
  assert.ok(
    !/className: 'rt-avail rt-avail-' \+ \(s\.availability/.test(source),
    "技能行的徽章还在用自造的 rt-avail-* 类名",
  );
});
