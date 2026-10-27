#!/usr/bin/env node
/**
 * scripts/check-artifact-names.mjs — 语法合法的产物仍会因未声明名在加载时炸，先静态拦一遍。
 * CONTRACT-7：产物「未声明名」静态门禁。
 *
 * ## 为什么需要它
 *
 * v1.0.1-codegen → v1.1.0-semantics 三个 tag 的 `client.js` 在当时的**所有**门禁下
 * 全绿：`node --check` 过（语法合法）、`npm test` 152 绿（没人真的跑 factory）、
 * CI 绿、字节 drift 绿（缺的那五行在基线里就缺）。可它一被加载就
 * `ReferenceError: drillGrantGen is not defined` —— 整个面板打不开。
 *
 * 执行级判据（`test/client-evaluates.test.mjs`，在 VM 里跑 factory）是事后补上的；
 * 这道门禁补的是**构建期**的那一半：产物里出现未声明/重复声明的标识符时，
 * 在提交之前就报错。
 *
 * ## 为什么只拒三个码
 *
 * `client.js` 是浏览器 bundle，没有 react 类型，也没有 node 类型（`types: []`）。
 * 所以 tsc 在它身上会喷大量**预期噪声**：TS2339（属性不存在）、TS2554（参数个数）、
 * TS2307（找不到 react）、TS2322（类型不兼容）—— 实测 147 条，全都是噪声。
 * 唯一能区分「历史缺陷」的信号只有三类：
 *
 * | 码 | 含义 | 与历史缺陷的关系 |
 * |---|---|---|
 * | TS2304 | Cannot find name 'X' | 直接同形（drillGrantGen 就是 TS2304） |
 * | TS2552 | Cannot find name 'X'. Did you mean 'Y'? | 同上，只是恰好有近形名候选 |
 * | TS2451 | Cannot redeclare block-scoped variable 'X' | 占位符替换把声明复制成两份时的形态 |
 *
 * 其余噪声一律放行 —— 把它们当命中会让这道门禁变成永远红的摆设。
 *
 * ## 用法
 *
 * ```
 * node scripts/check-artifact-names.mjs                     # 扫 client.js（取 tsconfig.artifact.json 的 files[0]）
 * node scripts/check-artifact-names.mjs --file <path>        # 扫指定文件（负向用例指向 fixture）
 * node scripts/check-artifact-names.mjs --all                # 附带打印全部诊断（含被放行的噪声）
 * ```
 *
 * 退出码：`0` 无命中 / `1` 有命中 / `2` 工具或环境错误（缺编译器、配置读不到、tsconfig 本身报错）。
 * **2 不是「通过」**：MUST NOT 静默降级成 0。
 *
 * ## 关于 tsc 的解析
 *
 * 走 `typescript` 包自己的 `bin/tsc`（用 `createRequire` 解析包位置，再交给
 * `process.execPath` 执行），**不用 `npx tsc`** —— npx 在非仓库目录会去 npm 上取
 * 同名桩包，打印 "This is not the tsc command you are looking for" 后退出 0，
 * 那会让门禁在最需要它的场景（临时目录 / 干净 checkout）里假装通过。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSCONFIG = join(ROOT, "tsconfig.artifact.json");

/** 命中集合：只有这三个码算信号，其余诊断一律放行（理由见文件头）。 */
export const SIGNAL_CODES = Object.freeze(["TS2304", "TS2552", "TS2451"]);
const SIGNAL = new Set(SIGNAL_CODES);

const EXIT_OK = 0;
const EXIT_HIT = 1;
const EXIT_TOOLING = 2;

const log = (msg) => process.stdout.write(`${msg}\n`);
const fail = (msg) => {
  process.stderr.write(`[check-artifact-names] 无法完成检查：${msg}\n`);
  process.exit(EXIT_TOOLING);
};

// ── 参数 ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { file: null, all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--all") opts.all = true;
    else if (arg === "--file") {
      const value = argv[i + 1];
      if (!value) fail("--file 需要一个路径参数");
      opts.file = value;
      i += 1;
    } else if (arg.startsWith("--file=")) opts.file = arg.slice("--file=".length);
    else if (arg === "--help" || arg === "-h") {
      log("用法：node scripts/check-artifact-names.mjs [--file <path>] [--all]");
      log(`命中码：${SIGNAL_CODES.join(" / ")}；退出码 0 无命中 / 1 有命中 / 2 环境错误。`);
      process.exit(EXIT_OK);
    } else fail(`未知参数 ${arg}（--file <path> | --all | --help）`);
  }
  return opts;
}

// ── 读配置（产物的默认目标是它的单一真源） ───────────────────────────────────
function readConfig() {
  if (!existsSync(TSCONFIG)) fail(`找不到 ${TSCONFIG}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(TSCONFIG, "utf8"));
  } catch (error) {
    fail(`${TSCONFIG} 不是合法 JSON：${error.message}`);
  }
  if (!parsed.compilerOptions || !Array.isArray(parsed.files) || parsed.files.length === 0) {
    fail(`${TSCONFIG} 需要同时有 compilerOptions 与非空 files[]`);
  }
  for (const key of ["allowJs", "checkJs"]) {
    if (parsed.compilerOptions[key] !== true) fail(`${TSCONFIG} 的 compilerOptions.${key} 必须为 true，否则 JS 产物不会被检查`);
  }
  return parsed;
}

// ── 找编译器 ────────────────────────────────────────────────────────────────
function locateTsc() {
  const require = createRequire(import.meta.url);
  let pkgPath = null;
  try {
    pkgPath = require.resolve("typescript/package.json", { paths: [ROOT] });
  } catch {
    pkgPath = null;
  }
  if (pkgPath) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.tsc;
      if (rel) {
        const bin = resolve(dirname(pkgPath), rel);
        if (existsSync(bin)) return { bin, label: `typescript@${pkg.version} ${bin}` };
      }
    } catch {
      /* 落到下面的 .bin 兜底 */
    }
  }
  // 兜底：node_modules/.bin（Windows 是 .cmd，Linux 是无扩展名的 sh 包装）
  const binDir = join(ROOT, "node_modules", ".bin");
  for (const name of process.platform === "win32" ? ["tsc.cmd", "tsc.exe", "tsc"] : ["tsc"]) {
    const candidate = join(binDir, name);
    if (!existsSync(candidate)) continue;
    // .cmd/.ps1 是 shell 包装，得交给 shell；无扩展名的是 POSIX sh 包装
    if (name.endsWith(".cmd") || name.endsWith(".ps1")) return { bin: candidate, label: candidate, shell: true };
    return { bin: candidate, label: candidate, shell: false };
  }
  return null;
}

// ── 解析诊断行 ──────────────────────────────────────────────────────────────
const DIAGNOSTIC = /^(.*?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;

/**
 * 把 tsc 的 `--pretty false` 输出拆成两类：
 *   - `diagnostics`：带 `文件(行,列)` 定位的错误（信号与噪声都在这里）
 *   - `global`：没有文件位置的错误（配置/输入层面的问题，调用方必须当致命处理）
 *
 * 导出给 `test/artifact-names.test.mjs` 做纯解析单测：那条用例不依赖 tsc 版本，
 * 只锁「哪些码进、哪些码出」。
 */
export function parseDiagnostics(stdout) {  const hits = [];
  const global = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    const match = DIAGNOSTIC.exec(line);
    if (!match) {
      if (/error TS\d+/.test(line)) global.push(line);
      continue;
    }
    const [, file, row, col, code, message] = match;
    const quoted = /'([^']+)'/.exec(message);
    hits.push({
      file,
      line: Number(row),
      column: Number(col),
      code,
      symbol: quoted ? quoted[1] : "(无法从消息里取出符号名)",
      message,
      raw: line,
    });
  }
  return { diagnostics: hits, global };
}

function summarizeNoise(diagnostics) {
  const counts = new Map();
  for (const d of diagnostics) counts.set(d.code, (counts.get(d.code) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, n]) => `${code} x${n}`)
    .join(", ");
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const config = readConfig();

  const targetArg = opts.file ?? config.files[0];
  const target = isAbsolute(targetArg) ? targetArg : resolve(ROOT, targetArg);
  if (!existsSync(target)) fail(`目标文件不存在：${target}`);

  const tsc = locateTsc();
  if (!tsc) {
    fail(
      `找不到 TypeScript 编译器。已尝试：typescript 包内的 bin/tsc 与 ${join(ROOT, "node_modules", ".bin")}。\n` +
        `  先跑 npm install；不要改用 npx tsc —— npx 会取 npm 上的同名桩包并静默退出 0，门禁会假装通过。`,
    );
  }
  log(`[check-artifact-names] tsc: ${tsc.label}`);

  // 临时 tsconfig 放在系统临时目录：不往仓库里写文件，编译选项直接从
  // tsconfig.artifact.json 抄，保证 --file 负向路径与默认路径用的是同一套选项。
  const workDir = mkdtempSync(join(tmpdir(), "dsh-artifact-names-"));
  const configPath = join(workDir, "tsconfig.json");
  const staged = { compilerOptions: config.compilerOptions, files: [target] };
  writeFileSync(configPath, `${JSON.stringify(staged, null, 2)}\n`, "utf8");

  let result;
  try {
    result = spawnSync(process.execPath, [tsc.bin, "-p", configPath, "--pretty", "false"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      shell: Boolean(tsc.shell),
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  if (result.error) fail(`启动编译器失败：${result.error.message}`);
  const stdout = result.stdout ?? "";
  if (/not the tsc command you are looking for/.test(stdout) || /not the tsc command you are looking for/.test(result.stderr ?? "")) {
    fail(`拿到的是 npm 上的同名桩包，不是真编译器：${tsc.label}`);
  }
  if (result.status === null) fail(`编译器异常退出（无状态码）：${result.stderr || stdout}`);

  const { diagnostics, global } = parseDiagnostics(stdout);
  if (global.length > 0) {
    // 无文件位置的诊断 = 配置/输入层面的错误（例如 No inputs were found）。
    // 这时「没有命中」并不代表产物是好的，MUST NOT 当通过。
    fail(`tsc 报了 ${global.length} 条无文件位置的诊断（配置或输入有问题）：\n  ${global.join("\n  ")}`);
  }

  const signal = diagnostics.filter((d) => SIGNAL.has(d.code));
  const noise = diagnostics.filter((d) => !SIGNAL.has(d.code));

  if (opts.all) {
    log(`[check-artifact-names] --all：全部 ${diagnostics.length} 条诊断`);
    for (const d of diagnostics) log(`  ${d.raw}`);
  }

  const shown = opts.file ? targetArg.replace(/\\/g, "/") : targetArg;
  log(`[check-artifact-names] 目标：${shown}`);
  log(
    `[check-artifact-names] 诊断 ${diagnostics.length} 条 → 命中 ${signal.length} 条，放行噪声 ${noise.length} 条` +
      (noise.length > 0 ? `（${summarizeNoise(noise)}）` : ""),
  );

  if (signal.length > 0) {
    for (const d of signal) log(`${d.file}:${d.line}:${d.column}  ${d.code}  ${d.symbol}  —— ${d.message}`);
    log(
      `[check-artifact-names] 失败：产物里有 ${signal.length} 处未声明/重复声明的标识符。` +
        `这正是 v1.0.1→v1.1.0 那三个 tag 的形态（语法绿、一加载就 ReferenceError）。`,
    );
    process.exit(EXIT_HIT);
  }

  log(
    `[check-artifact-names] OK：${shown} 无 ${SIGNAL_CODES.join("/")} 命中` +
      `（放行的 ${noise.length} 条噪声是没装 react 类型的预期结果）`,
  );
  process.exit(EXIT_OK);
}

// 只在被当 CLI 调用时执行；被 import 时（test/artifact-names.test.mjs 取白名单与
// 解析函数）不产生副作用 —— 否则单元测试会顺带把 tsc 跑一遍。
const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (invoked && invoked === fileURLToPath(import.meta.url).toLowerCase()) main();
