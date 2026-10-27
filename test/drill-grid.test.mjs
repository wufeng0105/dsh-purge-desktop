/**
 * test/drill-grid.test.mjs — 数据密集页共用一套表格外壳（T36）。
 *
 * ## 为什么这条能抓真回归
 *
 * 三个页签原先各写各的：表头一遍 `gridTemplateColumns`、数据行再一遍、展开行第三遍（有的写 `1fr`）。
 * 改一列要同时改三处，而「改漏了」不会报错 —— 表头与行错开半列也没人负责。所以判据不是
 * 「函数名出现过」，而是：
 *
 *   一、三个页签里**不再出现**列宽字面量（出现即说明有人又把列宽写死了）；
 *   二、列宽只从 `tableColumns` 出（唯一生成点）；
 *   三、`TableGrid` 被三处以上调用，且 `.rt-grid*` 那几条规则在产物里；
 *   四、表格只用发丝线、不套卡片（`.rt-grid` 规则里不许出现 `border-radius` / `box-shadow`）。
 *
 * 断言对象是产物 `client.js`：源片段改了没重建，这里会红。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CLIENT = readFileSync(join(ROOT, "client.js"), "utf8");

/** 按函数名切出一个页签组件的源码（到下一个顶层 `function`/注释分隔为止）。 */
function tabSource(name) {
  const at = CLIENT.indexOf(`function ${name}(`);
  assert.ok(at > 0, `产物里没有 ${name}`);
  const rest = CLIENT.slice(at + 1);
  const next = rest.search(/\n {4}(?:function |\/\* -+)/);
  return next < 0 ? rest : rest.slice(0, next);
}

test("三页的列宽字面量清零：不再有 grid-template-columns 写死的字符串", () => {
  for (const name of ["AssetsTab", "FindingsTab", "ScoreTab"]) {
    const source = tabSource(name);
    const literals = [...source.matchAll(/gridTemplateColumns:\s*(['"`])([^'"`]*)\1/g)].map((m) => m[2]);
    assert.deepEqual(literals, [], `${name} 里还有写死的列宽：${literals.join(" / ")} —— 列宽只能由 tableColumns 生成`);
    /* 反引号模板里拼列宽的写法同样算写死。 */
    assert.ok(
      !/gridTemplateColumns:\s*`/.test(source),
      `${name} 用模板串拼列宽：那也是第二份列宽口径`,
    );
  }
});

test("列宽只有一个生成点：tableColumns 在产物里，且三个页签都经过它或 TableGrid", () => {
  assert.match(CLIENT, /function tableColumns\(list\) \{/, "产物里没有 tableColumns：列宽生成点没了");
  assert.match(CLIENT, /function TableGrid\(props\) \{/, "产物里没有 TableGrid：表格原语没装配进来");
  const calls = (CLIENT.match(/h\(TableGrid, \{/g) || []).length;
  assert.ok(calls >= 3, `TableGrid 只有 ${calls} 处调用，三个数据密集页没有共用同一套外壳`);
  /* 写死列宽的页签必须已经把列宽交给生成器：三个页签里各至少一处 tableColumns。 */
  for (const name of ["AssetsTab", "FindingsTab", "ScoreTab"]) {
    const source = tabSource(name);
    const used = /tableColumns\(/.test(source) || /h\(TableGrid, \{/.test(source);
    assert.ok(used, `${name} 既没用 tableColumns 也没用 TableGrid：这一页的列宽仍无处可改`);
  }
});

test("表格外观：发丝线分隔，不套卡片（没有圆角与阴影）", () => {
  const styles = CLIENT.slice(CLIENT.indexOf(".rt-grid{"), CLIENT.indexOf(".rt-grid__extra"));
  assert.ok(styles.length > 0, "产物里没有 .rt-grid 的样式块");
  assert.ok(styles.includes("border-bottom:1px solid"), "表格行没有发丝线分隔：高密度页会用回卡片");
  assert.ok(!/border-radius/.test(styles), "表格外壳用了圆角：那是卡片的语义，不是表格的");
  assert.ok(!/box-shadow/.test(styles), "表格外壳用了阴影：高密度页应当只有发丝线");
  for (const selector of [".rt-grid__head", ".rt-grid__row", ".rt-grid__cell", ".rt-grid__extra"]) {
    assert.ok(CLIENT.includes(selector + "{") || CLIENT.includes(selector + ","), `缺少 ${selector} 的规则`);
  }
  /* 数字列等宽：端口/计数这类列要能上下对齐。 */
  assert.match(CLIENT, /\.rt-grid__cell--num\{[^}]*font-variant-numeric:tabular-nums/, "数字列没有等宽数字");
});

test("吸顶只到页头与标签栏：表格头不吸（方案 B 只有一个吸面）", () => {
  assert.match(CLIENT, /\.dshp-root--main \.rt-head\{[^}]*position:sticky/, "页头没有吸顶");
  assert.match(CLIENT, /\.dshp-root--main \.rt-tabs\{[^}]*position:sticky/, "标签栏没有吸顶");
  assert.match(CLIENT, /\.dshp-root--main\{[^}]*--rt-head-h:56px/, "标签栏的吸顶偏移量没有定义（会落到兜底值）");
  assert.ok(
    !/\.rt-grid__head\{[^}]*position:sticky/.test(CLIENT),
    "表格头也吸顶了：整页滚动下会与页头/标签栏三层互压（本期明确不做）",
  );
});
