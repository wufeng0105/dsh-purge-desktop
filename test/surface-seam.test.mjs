/**
 * 收口契约：`isDesktop` 是唯一的 surface 判定入口。
 *
 * SURFACE-2 之前，13 处判定散落成 `adapterFor(detectSurface()) === "desktop"` 这类组合表达式。
 * 现在 `detectSurface` 会抛错，所以本文件的等价性基准从「旧表达式」改成
 * 「桌面探测成功 ⟺ isDesktop 为真」，不再依赖 adapterFor 的回退行为。
 *
 * 本文件锁两件事：
 *   1. `isDesktop()` 在**所有输入形态**下语义正确，且**永不抛错**
 *   2. 判定只从 `surface.js` / `host.js` 出去，别处不许再拼判定表达式
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectSurface, isDesktop, isDesktopSurface } from "../lib/surface.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = join(ROOT, "lib");

/** 现在的等价基准：探测成功且为 desktop。 */
function probeIsDesktop(input) {
  try {
    return detectSurface(input) === "desktop";
  } catch {
    return false;
  }
}

test("SURFACE-2：isDesktop(input) 与探测结论一致（10 种输入）", () => {
  const cases = [
    {},
    { env: { DSH_SURFACE: "desktop" } },
    { env: { DSH_SURFACE: "web" } },
    { env: { DSH_SURFACE: "gui" } },
    { env: { DSH_SURFACE: "tui" } },
    { env: {}, execPath: "C:/x/DSH Desktop.exe" },
    { env: {}, execPath: "C:/x/DeepSeek Harness.exe" },
    { env: {}, execPath: "/usr/bin/node", argv: [] },
    { env: {}, execPath: "/usr/bin/node", argv: ["/x/DeepSeek Harness/resources/app"] },
    { env: {}, execPath: "/usr/bin/node", resourcesPath: "C:/x/DeepSeek Harness/resources" },
  ];
  for (const input of cases) {
    assert.equal(
      isDesktop(input),
      probeIsDesktop(input),
      `isDesktop(${JSON.stringify(input)}) 与探测结论不一致`,
    );
  }
});

test("A1/：isDesktop(surfaceString) 只认 desktop", () => {
  assert.equal(isDesktop("desktop"), true);
  for (const other of ["web", "gui", "tui", "unknown", ""]) {
    assert.equal(isDesktop(other), false, `isDesktop("${other}") 应为 false`);
  }
});

test("SURFACE-2：isDesktop 永不抛错（判定函数不该抛）", () => {
  // 这是 SURFACE-3 的关键设计：`if (isDesktop())` 在问"是不是桌面"，
  // 答案"不是"是合法结果，不该用异常表达。
  const hostile = [
    undefined,
    null,
    {},
    { env: { DSH_SURFACE: "web" } },
    { env: {}, execPath: "/usr/bin/node", argv: [] },
    { env: null, execPath: null, argv: null },
  ];
  for (const input of hostile) {
    assert.doesNotThrow(() => isDesktop(input), `isDesktop(${JSON.stringify(input)}) 抛错了`);
  }
  assert.doesNotThrow(() => isDesktop());
});

test("SURFACE-2：isDesktop 与 isDesktopSurface 对同一输入一致", () => {
  const cases = [
    { env: { DSH_SURFACE: "desktop" } },
    { env: {}, execPath: "C:/x/DSH Desktop.exe" },
    { env: {}, execPath: "/usr/bin/node", argv: [] },
  ];
  for (const input of cases) {
    assert.equal(
      isDesktop(input),
      isDesktopSurface(input),
      `isDesktop 与 isDesktopSurface 在 ${JSON.stringify(input)} 上不一致`,
    );
  }
});

test("SURFACE-2：lib/ 里不再出现组合判定表达式（收口完成）", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      const rel = full.slice(ROOT.length + 1).replace(/\\/g, "/");
      // 定义处允许（那就是判定本身）
      if (rel === "lib/surface.js" || rel === "lib/host.js") continue;
      const code = readFileSync(full, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      // 逐行判：出现判定函数调用 + 与字符串字面量比较，即视为「自己拼判定」。
      // 不能用一个正则跨括号 —— adapterFor(detectSurface()) 是嵌套括号，
      // [^)]* 会在第一个 ) 处截断，导致漏检。
      for (const line of code.split(/\r?\n/)) {
        const callsDecision = /\b(adapterFor|detectSurface|currentSurface)\s*\(/.test(line);
        const comparesString = /[!=]==?\s*["'](desktop|web|gui|tui)["']/.test(line);
        if (callsDecision && comparesString) {
          offenders.push(rel);
          break;
        }
      }
    }
  };
  walk(LIB);
  assert.deepEqual(
    [...new Set(offenders)],
    [],
    `这些文件还在自己拼 surface 判定，应改用 isDesktop()：${[...new Set(offenders)].join(", ")}`,
  );
});

test("SURFACE-2：host.js 转发 isDesktop，调用方从一处 import", async () => {
  const host = await import("../lib/host.js");
  assert.equal(typeof host.isDesktop, "function", "host.js 必须导出 isDesktop");
  assert.equal(
    host.isDesktop({ env: { DSH_SURFACE: "desktop" } }),
    true,
    "host.js 的转发必须真的走到 surface.js 的判定",
  );
  assert.equal(host.isDesktop({ env: { DSH_SURFACE: "web" } }), false);
});
