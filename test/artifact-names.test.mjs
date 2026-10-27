/**
 * CONTRACT-7：产物未声明名静态门禁的**双向**锁定。
 *
 * 门禁脚本 `scripts/check-artifact-names.mjs` 有两种坏法，本文件两个方向都要堵：
 *
 * | 坏法 | 后果 | 谁堵住 |
 * |---|---|---|
 * | 白名单被删空 / 被改成恒绿 | 历史 defect 再次漏过（v1.0.1→v1.1.0 那三个 tag 会重演） | 用例 1（白名单深比较）+ 用例 3（`--all` 必须真的扫出诊断）+ 用例 6（抽掉声明必须报错） |
 * | 白名单被加宽到噪声码 | 门禁永远红，最后被 `\|\| true` 掉 | 用例 1 + 用例 5（噪声必须被过滤） |
 * | 找不到编译器时静默退出 0 | 在临时目录/干净 checkout 里假装通过 | 用例 7（孤立树必须退出 2 且报明原因） |
 *
 * 用例 6（把一个 `client.js` 副本里的 `let drillGrantGen = 0;` 抽掉，必须报出
 * drillGrantGen）是这套判据的核心：它锁的正是当年那三个 tag 的病。
 */
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SIGNAL_CODES, parseDiagnostics } from "../scripts/check-artifact-names.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(ROOT, "scripts", "check-artifact-names.mjs");
const TSCONFIG = join(ROOT, "tsconfig.artifact.json");
const CLIENT = join(ROOT, "client.js");
// 一律用正斜杠的相对形式：Windows 与 Linux 下 tsc 都按它回显
const FIXTURE_REL = "test/fixtures/undeclared-name.sample.js";
const FIXTURE = join(ROOT, "test", "fixtures", "undeclared-name.sample.js");

/** tsc 要读完 8,795 行产物，慢机器上给足预算。 */
const GATE_TIMEOUT = 180_000;

function runGate(args, { cwd = ROOT, script = GATE } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    status: result.status,
    stdout,
    stderr,
    all: `${stdout}\n${stderr}`,
    report: () => `退出码=${result.status}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
  };
}

/** 从默认输出里抽出命中行：`<file>:<line>:<col>  <code>  <symbol>  —— <message>` */
function hitLines(stdout) {
  return [...stdout.matchAll(/^(.+?):(\d+):(\d+)\s+(TS\d+)\s+(\S+)\s+——/gm)].map((m) => ({
    file: m[1],
    line: Number(m[2]),
    column: Number(m[3]),
    code: m[4],
    symbol: m[5],
  }));
}

/** `--all` 块里 tsc 的原始诊断行。 */
function rawDiagnostics(stdout) {
  return [...stdout.matchAll(/^\s{2}(\S+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):/gm)].map((m) => ({
    file: m[1],
    line: Number(m[2]),
    code: m[4],
  }));
}

// ── 1 白名单 + 配置文件 ─────────────────────────────────────────────────────

test("CONTRACT-7：命中白名单就是 TS2304 / TS2552 / TS2451 三个，不能多也不能少", () => {
  assert.deepEqual(
    [...SIGNAL_CODES],
    ["TS2304", "TS2552", "TS2451"],
    "白名单被改了。收窄会漏掉历史 defect（TS2304 是主形，TS2552 是它的近名形，TS2451 是声明被复制成两份时的形）；" +
      "加宽到噪声码（TS2339/TS2554/TS2307/TS2322）会让门禁永远红。要改这里，必须同步改 test/fixtures/undeclared-name.sample.js。",
  );
});

test("CONTRACT-7：tsconfig.artifact.json 的判据开关没有被关掉", () => {
  const config = JSON.parse(readFileSync(TSCONFIG, "utf8"));
  assert.deepEqual(config.files, ["client.js"], "门禁的默认目标必须还是仓库根的产物 client.js");
  assert.equal(config.compilerOptions.allowJs, true, "allowJs 关掉 = 不检查 JS 产物");
  assert.equal(config.compilerOptions.checkJs, true, "checkJs 关掉 = 只做语法分析，TS2304 不会报（门禁变恒绿）");
  assert.equal(config.compilerOptions.noEmit, true, "检查不许产出文件");
  assert.deepEqual(config.compilerOptions.types, [], "types 必须为空：不拉 @types，噪声面才稳定");
  assert.ok(
    config.compilerOptions.lib?.includes("es2022") && config.compilerOptions.lib?.includes("dom"),
    "lib 必须含 es2022 与 dom：产物是浏览器 bundle，两者缺一都会引进无关噪声",
  );
});

// ── 2 纯解析：三个信号码进、噪声码出 ────────────────────────────────────────

test("CONTRACT-7：诊断解析只留三个信号码，并把符号名从消息里取出来", () => {
  const stdout = [
    "client.js(7749,4): error TS2304: Cannot find name 'drillGrantGen'.",
    "client.js(1,8): error TS2339: Property '__ModuleLoader__' does not exist on type 'Window & typeof globalThis'.",
    "client.js(35,5): error TS2451: Cannot redeclare block-scoped variable 'artifactSlot'.",
    "client.js(1173,60): error TS2554: Expected 0-1 arguments, but got 2.",
    "client.js(6,23): error TS2307: Cannot find module 'react' or its corresponding type declarations.",
    "client.js(10,5): error TS2552: Cannot find name 'declaredArtifactNam'. Did you mean 'declaredArtifactName'?",
  ].join("\n");

  const { diagnostics, global } = parseDiagnostics(stdout);
  assert.equal(global.length, 0, "这些都是带文件定位的诊断，不该进 global");
  assert.equal(diagnostics.length, 6, "六行诊断都该被解析出来（过滤是调用方的事）");

  const signal = diagnostics.filter((d) => SIGNAL_CODES.includes(d.code));
  assert.deepEqual(
    signal.map((d) => `${d.code} ${d.symbol}@${d.line}:${d.column}`),
    ["TS2304 drillGrantGen@7749:4", "TS2451 artifactSlot@35:5", "TS2552 declaredArtifactNam@10:5"],
    "信号码集合不对：要么漏了码，要么把噪声码当成了信号",
  );
  assert.equal(
    signal[2].symbol,
    "declaredArtifactNam",
    "TS2552 的消息里有两个引号名（找不到的那个 + Did you mean 的那个），必须取第一个",
  );
  assert.deepEqual(
    diagnostics.filter((d) => SIGNAL_CODES.includes(d.code)).map((d) => d.code).sort(),
    ["TS2304", "TS2451", "TS2552"],
    "三个信号码都必须能被解析出来 —— 只留 TS2304 不够，另外两个是同一个病的变体",
  );
});

test("CONTRACT-7：没有文件位置的诊断算工具错误，不能被当通过", () => {
  const { diagnostics, global } = parseDiagnostics("error TS18003: No inputs were found in config file.\n");
  assert.equal(diagnostics.length, 0, "没有文件定位的行不进 diagnostics");
  assert.equal(global.length, 1, "没有文件定位的错误必须被单独收集（调用方据此退出 2，而不是 0）");
});

// ── 3 真实产物：必须干净，但确实是「扫过一大片噪声之后的干净」 ───────────────

test("CONTRACT-7：真实 client.js 退出码 0", { timeout: GATE_TIMEOUT }, () => {
  const run = runGate([]);
  assert.equal(run.status, 0, `门禁对当前产物报错，产物里有未声明名：\n${run.report()}`);
  assert.equal(hitLines(run.stdout).length, 0, `默认输出里不该有命中行：\n${run.report()}`);
});

test("CONTRACT-7：退出码 0 是「过滤掉大量噪声」的结果，不是「什么都没扫」", { timeout: GATE_TIMEOUT }, () => {
  assert.ok(existsSync(CLIENT), `找不到产物 ${CLIENT}`);
  const run = runGate(["--all"]);
  assert.equal(run.status, 0, `产物不干净：\n${run.report()}`);

  const raw = rawDiagnostics(run.stdout);
  assert.ok(
    raw.length >= 1,
    `--all 一条诊断都没有 —— 编译器没真的跑起来（或者被换成 npx 桩包），这种"绿"没有意义：\n${run.report()}`,
  );
  const signal = raw.filter((d) => SIGNAL_CODES.includes(d.code));
  assert.deepEqual(
    signal,
    [],
    `产物里出现未声明名了（这正是 v1.0.1→v1.1.0 那三个 tag 的病）：\n${run.report()}`,
  );
  assert.match(run.stdout, /命中 0 条/, `摘要行没报 0 命中：\n${run.report()}`);
});

// ── 4/5 负向 fixture：必须报错，且只报信号码 ────────────────────────────────

test("CONTRACT-7：负向 fixture 退出码非 0，并逐条打印未声明符号名", { timeout: GATE_TIMEOUT }, () => {
  const run = runGate(["--file", FIXTURE_REL]);
  assert.equal(run.status, 1, `fixture 没被拦下 —— 门禁有负向用例的洞：\n${run.report()}`);

  const hits = hitLines(run.stdout);
  assert.ok(hits.length >= 3, `命中行太少（${hits.length} 条）：\n${run.report()}`);
  assert.ok(
    hits.every((h) => h.file.endsWith(FIXTURE_REL)),
    `命中行指向了别的文件：${JSON.stringify(hits.map((h) => h.file))}`,
  );

  const bySymbol = new Map(hits.map((h) => [h.symbol, h]));
  for (const [symbol, code] of [
    ["readUndeclaredArtifactFlag", "TS2304"],
    ["declaredArtifactNam", "TS2552"],
    ["undeclaredArtifactName", "TS2552"],
  ]) {
    const hit = bySymbol.get(symbol);
    assert.ok(hit, `没报出符号 ${symbol}：\n${run.report()}`);
    assert.equal(hit.code, code, `${symbol} 报成了 ${hit.code}（期望 ${code}）`);
    assert.ok(hit.line > 0 && hit.column > 0, `${symbol} 缺少行列定位：${JSON.stringify(hit)}`);
  }

  assert.deepEqual(
    [...new Set(hits.map((h) => h.code))].filter((code) => !SIGNAL_CODES.includes(code)),
    [],
    `默认输出里混进了噪声码：\n${run.report()}`,
  );
});

test("CONTRACT-7：噪声码确实被 tsc 报出来，但被放行了（不是「没扫到」）", { timeout: GATE_TIMEOUT }, () => {
  const run = runGate(["--file", FIXTURE_REL, "--all"]);
  assert.equal(run.status, 1, `fixture 应当被拦下：\n${run.report()}`);

  const raw = rawDiagnostics(run.stdout);
  const noiseCodes = [...new Set(raw.map((d) => d.code))].filter((code) => !SIGNAL_CODES.includes(code));
  assert.ok(
    noiseCodes.length > 0,
    `fixture 里那条 TS2554 噪声没被 tsc 报出来，过滤规则等于没被测到：\n${run.report()}`,
  );
  for (const code of noiseCodes) {
    assert.ok(
      !hitLines(run.stdout).some((h) => h.code === code),
      `噪声码 ${code} 出现在命中行里 —— 白名单被加宽了，门禁会变成永远红：\n${run.report()}`,
    );
  }
});

// ── 6 历史 defect 复现：抽掉声明必须报出来 ──────────────────────────────────

test("CONTRACT-7：抽掉 client.js 里的 `let drillGrantGen = 0;` 后门禁必须报出 drillGrantGen", { timeout: GATE_TIMEOUT }, () => {
  assert.ok(existsSync(CLIENT), `找不到产物 ${CLIENT}`);
  const source = readFileSync(CLIENT, "utf8");
  const DECL = "let drillGrantGen = 0;";
  assert.ok(
    source.includes(DECL),
    `产物里找不到 \`${DECL}\` —— 历史 defect 的靶点没了。` +
      `如果确实改了名，请同步这个用例（它是唯一能证明门禁拦得住当年那个病的判据）。`,
  );

  const workDir = mkdtempSync(join(tmpdir(), "dsh-artifact-names-historical-"));
  try {
    const broken = join(workDir, "client.js");
    writeFileSync(broken, source.replace(DECL, ""), "utf8");
    const run = runGate(["--file", broken]);
    assert.equal(run.status, 1, `抽掉声明后门禁竟然通过了 —— 这就是那三个 tag 漏网的原因：\n${run.report()}`);
    const hits = hitLines(run.stdout);
    const grantHits = hits.filter((h) => h.symbol === "drillGrantGen" && h.code === "TS2304");
    assert.ok(
      grantHits.length >= 1,
      `没报出 drillGrantGen（命中：${JSON.stringify(hits.map((h) => h.symbol))}）：\n${run.report()}`,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

// ── 7 工具缺失：必须显式失败，不许静默当通过 ────────────────────────────────

test("CONTRACT-7：没有 TypeScript 编译器时退出码 2 并说明原因", { timeout: 60_000 }, () => {
  // 把脚本与配置复制到一棵没有 node_modules 的孤立树里，模拟「临时目录 / 干净 checkout」。
  const tree = mkdtempSync(join(tmpdir(), "dsh-artifact-names-nodeps-"));
  try {
    mkdirSync(join(tree, "scripts"));
    copyFileSync(GATE, join(tree, "scripts", "check-artifact-names.mjs"));
    copyFileSync(TSCONFIG, join(tree, "tsconfig.artifact.json"));
    writeFileSync(join(tree, "client.js"), "const placeholder = 1;\n", "utf8");

    const run = runGate([], { cwd: tree, script: join(tree, "scripts", "check-artifact-names.mjs") });
    assert.equal(
      run.status,
      2,
      `没有编译器时必须显式失败（退出码 2），不能当通过 —— 否则干净 checkout 里的门禁是绿的假的：\n${run.report()}`,
    );
    assert.match(
      run.stderr,
      /找不到 TypeScript 编译器/,
      `失败原因没有说清（要提醒 npm install、并劝退 npx tsc 的同名桩包）：\n${run.report()}`,
    );
    assert.match(run.stderr, /npx/, "提示里要点明 npx tsc 会取 npm 上的同名桩包");
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});
