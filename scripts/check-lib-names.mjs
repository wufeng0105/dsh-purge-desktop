#!/usr/bin/env node
/**
 * scripts/check-lib-names.mjs — 宿主侧模块的未声明名只在真实调用链上炸，用类型检查提前拦。
 * CONTRACT-8：`lib/**` 与 `bin/**` 的「未声明标识符」静态门禁。
 *
 * ## 为什么需要它（和 CONTRACT-7 是同一个病，只是发生在宿主侧）
 *
 * 2026-10-23 在真实官方桌面端上一次性撞出 5 处 ReferenceError：
 *
 *   `keepSurfaceFile` / `pathIsUnder` / `ensureDirSync`  —— 路径层搬家时 import 漏项
 *   `atomicWriteSync` / `atomicWriteFile`               —— `export {x} from` 只转发、不建本地绑定
 *   `fs`（lib/skills.js）                                —— 只 import 了 promises，却调同步 API
 *   `dirname`（lib/redteam/ui.js）                       —— node:path 的 import 少了名字
 *
 * 这五处**node --check 全绿、196 个用例全绿、depcruise 零违规、knip 净空**。
 * 因为它们都只在特定调用链上才被求值：CLI apply、静默链路、演练台某条分支。
 * 唯一能提前发现的判据是语义检查（tsc 的 checkJs），和 CONTRACT-7 对
 * `client.js` 做的事完全一样 —— 只是对象换成了宿主侧的 ES 模块。
 *
 * ## 判据
 *
 * 只拒三个码，与 CONTRACT-7 共用同一份白名单（直接 import，不复制）：
 *   TS2304 / TS2552 / TS2451
 * 其余码一律放行。宿主侧装的是真 `@types/node`，所以 `process` / `Buffer` / `node:*`
 * 不是噪声；剩下的噪声主要是第三方包缺类型（`node:sqlite` 的老版本声明等）。
 *
 * ## 排除项（不是豁免，是「不可能的输入」）
 *
 *   `lib/client-src/**`      片段，不是 ES 模块：正文引用的是装配后闭包里的
 *                            `h` / `useState` / `AUTH_KEY`，单独做类型检查必然全是假阳性。
 *   `lib/redteam/client.js`  同上，是被 build-client 文本嵌入的 drill 片段。
 *
 * 这两处由 `test/client-bundle.test.mjs`（占位符完备性）与
 * `test/client-evaluates.test.mjs`（VM 里真的跑一次 factory）兜住。
 *
 * ## 第二趟：`@ts-nocheck` 文件的盲区
 *
 * 类型检查有一个自己造的空洞：文件头写 `// @ts-nocheck` 就不检查它。而「找不到名称」
 * 正是最容易在真实调用链上炸成 ReferenceError 的那一类 —— 真机上 `lib/desktop.js`
 * 因此把一个未定义标识符带进了宿主进程，让 host 停下，两天没人发现。
 *
 * 所以第二趟把每个带那行声明的文件复制到临时目录、**删掉声明那一行**再单独过一次 tsc，
 * 只认同一个信号码集合。import 解析不了产生的 TS2307 是噪声（单文件工程没有模块图），
 * 不影响「有没有未定义名」这条判据。临时目录跑完即删，不碰仓库里的任何文件。
 *
 * ## 用法与退出码
 *
 * ```
 * node scripts/check-lib-names.mjs                    # 扫 tsconfig.lib.json 的 include
 * node scripts/check-lib-names.mjs --project <path>    # 扫指定工程（负向用例用）
 * node scripts/check-lib-names.mjs --all               # 附带打印全部诊断（含放行噪声）
 * ```
 *
 * `--project` 模式下不跑第二趟：负向用例的工程是故意坏的，混进真实文件的检查没有意义。
 *
 * 退出码：`0` 无命中 / `1` 有命中 / `2` 工具或环境错误。**2 不是通过**。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { SIGNAL_CODES, parseDiagnostics } from "./check-artifact-names.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PROJECT = join(ROOT, "tsconfig.lib.json");

const EXIT_OK = 0;
const EXIT_HIT = 1;
const EXIT_TOOLING = 2;

const log = (msg) => process.stdout.write(`${msg}\n`);
const fail = (msg) => {
  process.stderr.write(`[check-lib-names] 无法完成检查：${msg}\n`);
  process.exit(EXIT_TOOLING);
};

function parseArgs(argv) {
  const opts = { project: null, all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--all") opts.all = true;
    else if (arg === "--project") {
      const value = argv[i + 1];
      if (!value) fail("--project 需要一个路径参数");
      opts.project = value;
      i += 1;
    } else if (arg.startsWith("--project=")) opts.project = arg.slice("--project=".length);
    else if (arg === "--help" || arg === "-h") {
      log("用法：node scripts/check-lib-names.mjs [--project <tsconfig>] [--all]");
      log(`命中码：${SIGNAL_CODES.join(" / ")}；退出码 0 无命中 / 1 有命中 / 2 环境错误。`);
      process.exit(EXIT_OK);
    } else fail(`未知参数 ${arg}（--project <path> | --all | --help）`);
  }
  return opts;
}

function resolveProject(opts) {
  if (!opts.project) return DEFAULT_PROJECT;
  return isAbsolute(opts.project) ? opts.project : resolve(ROOT, opts.project);
}

/** 与 CONTRACT-7 同样的取编译器方式：走 typescript 包自己的 bin，不用 npx。 */
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
      /* 落到 .bin 兜底 */
    }
  }
  const binDir = join(ROOT, "node_modules", ".bin");
  for (const name of process.platform === "win32" ? ["tsc.cmd", "tsc.exe", "tsc"] : ["tsc"]) {
    const candidate = join(binDir, name);
    if (!existsSync(candidate)) continue;
    if (name.endsWith(".cmd") || name.endsWith(".ps1")) return { bin: candidate, label: candidate, shell: true };
    return { bin: candidate, label: candidate, shell: false };
  }
  return null;
}

function summarizeNoise(diagnostics) {
  const counts = new Map();
  for (const d of diagnostics) counts.set(d.code, (counts.get(d.code) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, n]) => `${code} x${n}`)
    .join(", ");
}

/** 文件头写着「不检查」的那一行；去掉它才能让 tsc 真的检查这个文件。 */
const NOCHECK_LINE = /^[ \t]*\/\/[ \t]*@ts-nocheck\b[^\n]*\n?/m;

/**
 * 去掉文件头的 `@ts-nocheck` 声明，其余逐字不动。
 *
 * 只删这一行：删多了就不是同一份代码，判据也就不再指向真实文件。
 *
 * @param {string} text 源文件内容
 * @returns {string}
 */
export function stripNoCheck(text) {
  return String(text).replace(NOCHECK_LINE, "");
}

/** `@ts-nocheck` 文件清单：只扫 `lib/` 与 `bin/` 下的 `.js`，与第一趟同一范围。 */
function listNoCheckFiles() {
  const found = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        // 与 tsconfig.lib.json 的排除项保持一致：片段不是模块，检查它们只会造假阳性。
        if (abs.includes(`${sep}client-src`) || abs.includes(`${sep}node_modules`)) continue;
        walk(abs);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      if (abs.endsWith(`redteam${sep}client.js`)) continue;
      const head = readFileSync(abs, "utf8").slice(0, 400);
      if (head.includes("@ts-nocheck")) found.push(abs);
    }
  };
  for (const scope of ["lib", "bin"]) walk(join(ROOT, scope));
  return found.sort();
}

/**
 * 第二趟：把带 `@ts-nocheck` 的文件去掉声明后单独过一次 tsc。
 *
 * 输入是「文件名 → 内容」而不是路径，测试可以直接喂一段人造源码验证红灯，
 * 不必在仓库里留一个坏文件。
 *
 * @param {Array<{name: string, text: string}>} sources 待检查的源码
 * @param {{bin: string, shell?: boolean}} tsc 编译器
 * @returns {{files: number, diagnostics: Array<object>, signal: Array<object>, noise: Array<object>}}
 */
export function lintNoCheckSources(sources, tsc) {
  const list = Array.isArray(sources) ? sources : [];
  if (list.length === 0) return { files: 0, diagnostics: [], signal: [], noise: [] };
  const dir = mkdtempSync(join(tmpdir(), "dsh-purge-nocheck-"));
  try {
    for (const source of list) {
      writeFileSync(join(dir, source.name), stripNoCheck(source.text), "utf8");
    }
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: true,
        noEmit: true,
        target: "es2022",
        module: "nodenext",
        moduleResolution: "nodenext",
        types: ["node"],
        // 临时目录里没有 node_modules：类型根指回仓库，否则连 `process` 都成了未定义。
        typeRoots: [join(ROOT, "node_modules", "@types")],
        skipLibCheck: true,
        noImplicitAny: false,
      },
      include: list.map((source) => source.name),
    }), "utf8");
    const run = spawnSync(process.execPath, [tsc.bin, "-p", dir, "--pretty", "false"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      shell: Boolean(tsc.shell),
    });
    if (run.error) throw run.error;
    const { diagnostics, global } = parseDiagnostics(`${run.stdout ?? ""}${run.stderr ?? ""}`);
    // 没有文件位置的诊断说明临时工程本身没配对（找不到输入、类型根错了）：
    // 那时「零命中」不代表代码是好的，必须按环境错误报出去。
    if (global.length > 0) throw new Error(`tsc 报了 ${global.length} 条无文件位置的诊断：${global.join("；")}`);
    const signal = diagnostics.filter((d) => SIGNAL_CODES.includes(d.code));
    const noise = diagnostics.filter((d) => !SIGNAL_CODES.includes(d.code));
    return { files: list.length, diagnostics, signal, noise };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const project = resolveProject(opts);
  if (!existsSync(project)) fail(`找不到工程配置：${project}`);

  const tsc = locateTsc();
  if (!tsc) {
    fail(
      "找不到 TypeScript 编译器。先跑 npm install；不要改用 npx tsc —— " +
        "npx 会取 npm 上的同名桩包并静默退出 0，门禁会假装通过。",
    );
  }
  log(`[check-lib-names] tsc: ${tsc.label}`);
  log(`[check-lib-names] 工程：${project.replace(ROOT, ".")}`);

  const result = spawnSync(process.execPath, [tsc.bin, "-p", project, "--pretty", "false"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    shell: Boolean(tsc.shell),
  });

  if (result.error) fail(`启动编译器失败：${result.error.message}`);
  const stdout = result.stdout ?? "";
  if (/not the tsc command you are looking for/.test(`${stdout}${result.stderr ?? ""}`)) {
    fail(`拿到的是 npm 上的同名桩包，不是真编译器：${tsc.label}`);
  }
  // 配置层面报错（找不到输入、非法 include/exclude）时 tsc 会以非 0 退出且没有文件定位。
  // 这种情况「零命中」不代表代码是好的，必须按环境错误处理。
  if (result.status === null) fail(`编译器异常退出（无状态码）：${result.stderr || stdout}`);

  const { diagnostics, global } = parseDiagnostics(stdout);
  if (global.length > 0) {
    fail(`tsc 报了 ${global.length} 条无文件位置的诊断（配置或输入有问题）：\n  ${global.join("\n  ")}`);
  }

  const signal = diagnostics.filter((d) => SIGNAL_CODES.includes(d.code));
  const noise = diagnostics.filter((d) => !SIGNAL_CODES.includes(d.code));

  if (opts.all) {
    log(`[check-lib-names] --all：全部 ${diagnostics.length} 条诊断`);
    for (const d of diagnostics) log(`  ${d.raw}`);
  }

  log(
    `[check-lib-names] 诊断 ${diagnostics.length} 条 → 命中 ${signal.length} 条，放行噪声 ${noise.length} 条` +
      (noise.length > 0 ? `（${summarizeNoise(noise)}）` : ""),
  );

  if (signal.length > 0) {
    for (const d of signal) log(`${d.file}:${d.line}:${d.column}  ${d.code}  ${d.symbol}  —— ${d.message}`);
    log(
      `[check-lib-names] 失败：${signal.length} 处未声明/重复声明的标识符。` +
        "这类错误 node --check 看不出来，只会在真实调用链上抛 ReferenceError。",
    );
    process.exit(EXIT_HIT);
  }

  // 第二趟：带 `@ts-nocheck` 的文件第一趟看不见（tsc 自己略过整份文件）。
  // 只在默认工程上跑 —— `--project` 的负向用例不掺真实文件。
  let nocheck = { files: 0, signal: [], noise: [] };
  if (!opts.project) {
    const sources = listNoCheckFiles().map((abs) => ({
      name: basename(abs),
      text: readFileSync(abs, "utf8"),
    }));
    try {
      nocheck = lintNoCheckSources(sources, tsc);
    } catch (error) {
      fail(`第二趟（@ts-nocheck 文件）没跑成：${error.message}`);
    }
    log(
      `[check-lib-names] 第二趟：${nocheck.files} 个 @ts-nocheck 文件，诊断 ${nocheck.diagnostics.length} 条` +
        ` → 命中 ${nocheck.signal.length} 条，放行噪声 ${nocheck.noise.length} 条` +
        (nocheck.noise.length > 0 ? `（${summarizeNoise(nocheck.noise)}）` : ""),
    );
    if (opts.all) {
      for (const d of nocheck.diagnostics) log(`  nocheck ${d.raw}`);
    }
    if (nocheck.signal.length > 0) {
      for (const d of nocheck.signal) {
        log(`nocheck ${basename(d.file)}:${d.line}:${d.column}  ${d.code}  ${d.symbol}  —— ${d.message}`);
      }
      log(
        `[check-lib-names] 失败：${nocheck.signal.length} 处未声明标识符落在 @ts-nocheck 文件里。` +
          "第一趟看不见这些文件，正是这个盲区让 ReferenceError 活到了真机。",
      );
      process.exit(EXIT_HIT);
    }
  }

  const exemptions = ["client-src", "redteam/client.js"];
  log(
    `[check-lib-names] OK：无 ${SIGNAL_CODES.join("/")} 命中` +
      `（排除项固定为 ${exemptions.join(" / ")}，它们由 client-bundle / client-evaluates 两条用例兜住）` +
      (opts.project ? "" : `；@ts-nocheck 文件 ${nocheck.files} 个已单独检查`),
  );
  process.exit(EXIT_OK);
}

const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (invoked && invoked === fileURLToPath(import.meta.url).toLowerCase()) main();

export { SIGNAL_CODES };
