/**
 * CONTRACT-8：`lib/**` / `bin/**` 未声明标识符门禁的**双向**锁定。
 *
 * 门禁有两种坏法，本文件两个方向都堵：
 *
 * | 坏法 | 后果 | 谁堵住 |
 * |---|---|---|
 * | 白名单被改宽到噪声码 | 门禁永远红，最后被 `\|\| true` 掉 | 用例 1（与 CONTRACT-7 同一个数组引用） |
 * | 判据开关被关掉（checkJs / allowJs / exclude 被改） | 门禁变恒绿，等于没有 | 用例 2 |
 * | 真的出现未声明名却不报 | 2026-10-23 那 5 处 ReferenceError 会重演 | 用例 4（负向工程必报） |
 * | 找不到编译器/配置时静默退出 0 | 干净 checkout 里假装通过 | 用例 5（必须退出 2） |
 *
 * 用例 4 是这套判据的核心：它构造一个只含 `const bad = undefinedSymbol;` 的临时工程，
 * 断言门禁以退出码 1 拦下并打印符号名 —— 这正是 `keepSurfaceFile` / `fs` / `dirname`
 * 当初的形态。
 */
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SIGNAL_CODES as LIB_CODES } from "../scripts/check-lib-names.mjs";
import { SIGNAL_CODES as ARTIFACT_CODES } from "../scripts/check-artifact-names.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(ROOT, "scripts", "check-lib-names.mjs");
const PROJECT = join(ROOT, "tsconfig.lib.json");

/** tsc 要读完 lib + bin 全量，慢机器（2 GB 服务器）上给足预算。 */
const GATE_TIMEOUT = 240_000;

function runGate(args) {
  const result = spawnSync(process.execPath, [GATE, ...args], {
    cwd: ROOT,
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
    report: () => `退出码=${result.status}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
  };
}

// ── 1 白名单同源 ────────────────────────────────────────────────────────────

test("CONTRACT-8：命中白名单与 CONTRACT-7 是同一个数组（不是复制一份）", () => {
  assert.equal(
    LIB_CODES,
    ARTIFACT_CODES,
    "两侧白名单必须是同一个数组引用。一旦各自复制，改一边就会漂另一边，" +
      "宿主侧与产物侧会出现「一个红一个绿」的分裂。",
  );
  assert.deepEqual([...LIB_CODES], ["TS2304", "TS2552", "TS2451"], "白名单被改了");
});

// ── 2 判据开关与排除项 ──────────────────────────────────────────────────────

test("CONTRACT-8：tsconfig.lib.json 的开关没被关掉，排除项就是那两个片段", () => {
  const config = JSON.parse(readFileSync(PROJECT, "utf8"));
  const opts = config.compilerOptions ?? {};
  assert.equal(opts.allowJs, true, "allowJs 关掉 = 不检查 .js");
  assert.equal(opts.checkJs, true, "checkJs 关掉 = 只做语法分析，TS2304 根本不会报（门禁恒绿）");
  assert.equal(opts.noEmit, true, "检查不许产出文件");
  assert.deepEqual(opts.types, ["node"], "宿主侧必须装 node 类型，否则 process/Buffer 会变成假阳性");

  const exclude = (config.exclude ?? []).join("|");
  for (const must of ["client-src", "redteam/client.js"]) {
    assert.ok(
      exclude.includes(must),
      `排除项必须包含 ${must}：它是被文本装配的片段，正文引用闭包变量，单独类型检查必然全假阳性`,
    );
  }
  assert.ok(
    (config.include ?? []).some((p) => p.startsWith("lib/")) &&
      (config.include ?? []).some((p) => p.startsWith("bin/")),
    "include 必须同时覆盖 lib/** 与 bin/**：CLI 那侧同样会 ReferenceError",
  );
});

// ── 3 正向：当前树必须干净 ──────────────────────────────────────────────────

test("CONTRACT-8：当前 lib/ 与 bin/ 零命中（退出码 0）", { timeout: GATE_TIMEOUT }, () => {
  const run = runGate([]);
  assert.equal(
    run.status,
    0,
    `门禁对当前树报错 —— 这正是 2026-10-23 那 5 处未声明标识符的形态：\n${run.report()}`,
  );
  assert.match(run.stdout, /命中 0 条/, `摘要行没报 0 命中：\n${run.report()}`);
});

// ── 4 负向：临时工程里有未声明名必须被拦 ────────────────────────────────────

test("CONTRACT-8：含未声明名的临时工程必须退出 1 并打印符号名", { timeout: GATE_TIMEOUT }, () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-lib-names-"));
  try {
    const victim = join(dir, "victim.js");
    writeFileSync(
      victim,
      [
        "// 与 lib/core.js 当初缺 import 时的形态一致：用了没导入。",
        "export function probe() {",
        "  return undefinedSymbolFromMove + anotherMissingName;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const project = join(dir, "tsconfig.json");
    // types 置空：临时目录解析不到 @types/node，避免把「缺类型」误判成命中。
    writeFileSync(
      project,
      JSON.stringify(
        {
          compilerOptions: { allowJs: true, checkJs: true, noEmit: true, target: "es2022", module: "esnext", moduleResolution: "bundler", types: [], skipLibCheck: true },
          include: ["victim.js"],
        },
        null,
        2,
      ),
      "utf8",
    );

    const run = runGate(["--project", project]);
    assert.equal(run.status, 1, `未声明名没被拦下 —— 门禁有洞：\n${run.report()}`);
    assert.match(run.stdout, /TS2304/, `没报出 TS2304：\n${run.report()}`);
    for (const symbol of ["undefinedSymbolFromMove", "anotherMissingName"]) {
      assert.ok(run.stdout.includes(symbol), `没打印符号名 ${symbol}：\n${run.report()}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 5 环境错误：不许当通过 ──────────────────────────────────────────────────

test("CONTRACT-8：工程配置不存在时退出 2（环境错误不算通过）", { timeout: 60_000 }, () => {
  const missing = join(ROOT, "tsconfig.does-not-exist.json");
  const run = runGate(["--project", missing]);
  assert.equal(
    run.status,
    2,
    `配置读不到时必须显式失败（退出码 2），不能静默退出 0 —— 否则干净 checkout 里的绿是假的：\n${run.report()}`,
  );
  assert.match(run.stderr, /找不到工程配置/, `失败原因没说清：\n${run.report()}`);
});
