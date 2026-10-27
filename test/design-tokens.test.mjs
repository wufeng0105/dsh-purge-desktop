/**
 * 设计令牌门禁（scripts/check-design-tokens.mjs）的判据测试。
 *
 * 为什么存在：这条门禁今天带基线 —— 零引用类名与裸值都有一批存量，所以「能拦」必须
 * 分别证明三件事：一是三条子判据真的能拦住违规（不是恒绿的空判据）；二是棘轮的两个
 * 方向都红（涨了红、基线过时也红，否则基线会烂在原地）；三是当轮读数与脚本里的基线
 * 常量一致（设计片段改了一批、基线没跟着下调，这里先红）。
 *
 * 判据体在脚本里，这里只喂合成文本与当轮实测值 —— 注入到真实设计片段的那几次红灯
 * 走的是门禁日志，不进测试：`npm test` 不许改产品代码。
 *
 * 层级那条与另两条不同源：它零容忍、不设基线，判的是「z-index 有没有写成数字」。页面根与
 * 浮层根各自隔离层叠上下文之后，层内只与插件内部的值比大小，旧判据（令牌必须大于某个
 * 魔数）连被测物都不成立，所以那条用例连同断言整条换掉，不留旧口径的残句。
 */
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASELINE,
  analyze,
  bareValueHits,
  isReferenced,
  ratchet,
  valueReasons,
  zIndexHits,
} from "../scripts/check-design-tokens.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "check-design-tokens.mjs");

test("裸值判据：白名单内的取值放行", () => {
  const allowed = [
    "0",
    "0 auto",
    "var(--dshp-sp-2)",
    "var(--dshp-sp-2) var(--dshp-sp-3)",
    "transparent",
    "currentColor",
    "inherit",
    "none",
    "100%",
    "calc(var(--dshp-sp-1) + var(--dshp-sp-2))",
    "minmax(var(--dshp-sp-1), var(--dshp-sp-3))",
  ];
  for (const value of allowed) {
    assert.deepEqual(valueReasons(value), [], `白名单取值被误判：${value}`);
  }
  const css = ".dshp-probe{margin:0;padding:var(--dshp-sp-2) auto;background:transparent}";
  assert.deepEqual(bareValueHits("design/probe.js", css), []);
});

test("裸值判据：裸数值、裸色、calc 里塞裸数都命中", () => {
  const flagged = [
    "7px",
    "10px",
    "500",
    "1.55",
    "999px",
    "0 14px",
    "#123456",
    "#fff",
    "80",
    "width .4s var(--dshp-ease)",
    "calc(var(--dshp-sp-1) + 4px)",
    "calc(var(--dshp-sp-1) * 2)",
    "minmax(4px, var(--dshp-sp-3))",
  ];
  for (const value of flagged) {
    assert.ok(valueReasons(value).length > 0, `违规取值漏判：${value}`);
  }
});

test("裸值判据：注释里的取值不算命中，命中位置带行号", () => {
  const css = "/* .dshp-probe{margin:7px} */\n.dshp-a{margin:0}\n.dshp-b{gap:7px}";
  const hits = bareValueHits("design/probe.js", css);
  assert.equal(hits.length, 1);
  assert.match(hits[0], /design\/probe\.js:3\b/);
  assert.match(hits[0], /gap: 7px/);
});

test("零引用类名判据：整名引用与拼接前缀都算被引用", () => {
  const body = 'const tone = `rt-badge--${level}`; const cls = "rt-note" + suffix;';
  assert.equal(isReferenced("rt-badge--on", body), true);
  assert.equal(isReferenced("rt-note", body), true);
  assert.equal(isReferenced("rt-badge", body), true);
  assert.equal(isReferenced("dshp-never-used-probe", body), false);
});

test("层级判据：z-index 写成数字即命中，令牌与 auto 放行", () => {
  const css = [
    ".dshp-a{z-index:var(--dshp-z-modal)}",
    ".dshp-b{z-index:5}",
    ".dshp-c{z-index:auto}",
    ".dshp-d{z-index:calc(var(--dshp-z-modal) + 1)}",
    ".dshp-e{z-index:2147483000}",
    "/* .dshp-f{z-index:7} */",
  ].join("\n");
  const hits = zIndexHits("design/probe.js", css);
  assert.equal(hits.length, 3, `命中数应为 3，实际 ${hits.length}：${hits.join(" / ")}`);
  assert.ok(hits.some((hit) => hit.includes("design/probe.js:2")), "裸数字 z-index 没命中");
  assert.ok(hits.some((hit) => hit.includes("z-index: calc(")), "calc 包一层就绕过去了");
  assert.ok(!hits.some((hit) => hit.includes("z-index: auto")), "auto 被误判：它表示这一层不参与分层");
  assert.ok(!hits.some((hit) => hit.includes("design/probe.js:1 ")), "令牌写法被误判");
});

test("棘轮：高于基线要红，且提示先修再下调", () => {
  const result = ratchet("裸值", "bareValues", BASELINE.bareValues + 1, BASELINE.bareValues);
  assert.equal(result.ok, false);
  assert.match(result.message, /新命中/);
  assert.match(result.message, /BASELINE\.bareValues/);
});

test("棘轮：低于基线也要红，并提示基线过时、要求下调", () => {
  const result = ratchet("零引用类名", "deadClasses", BASELINE.deadClasses - 1, BASELINE.deadClasses);
  assert.equal(result.ok, false);
  assert.match(result.message, /基线过时/);
  assert.match(result.message, /降到/);
});

test("棘轮：与基线相等才绿", () => {
  assert.equal(ratchet("裸值", "bareValues", BASELINE.bareValues, BASELINE.bareValues).ok, true);
});

test("当轮实测与脚本里的基线常量一致（设计片段动了就要同步基线）", () => {
  const report = analyze();
  assert.deepEqual(report.missing, [], `扫描目标缺失：${report.missing.join("、")}`);
  assert.ok(report.universeCount > 0, "类名全集为空：判据会恒绿");
  assert.equal(
    report.deadHits.length,
    BASELINE.deadClasses,
    `零引用类名实测 ${report.deadHits.length}，基线 ${BASELINE.deadClasses}：`
    + "删掉死类就把 BASELINE.deadClasses 下调，新增就把命中修掉",
  );
  assert.equal(
    report.bareHits.length,
    BASELINE.bareValues,
    `裸值实测 ${report.bareHits.length}，基线 ${BASELINE.bareValues}：`
    + "改走令牌就把 BASELINE.bareValues 下调，新增裸值就改回令牌",
  );
  assert.ok(
    report.zTokens >= 3,
    `--dshp-z-* 令牌只有 ${report.zTokens} 个：层级判据没有被测物，零命中会变成恒绿`,
  );
  assert.deepEqual(report.zHits, [], "层内还有裸 z-index：层级要写令牌，不能写成数字");
});

test("命令行：退出码 0，且输出两条基线读数与层级令牌数", () => {
  const out = execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  assert.match(out, /基线读数：零引用类名 \d+（基线 \d+）｜裸值 \d+（基线 \d+）/);
  assert.match(out, /--dshp-z-\* 令牌 \d+ 个；裸 z-index 命中 0/);
  assert.match(out, /OK：三项子判据与基线一致/);
});
