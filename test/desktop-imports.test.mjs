/**
 * test/desktop-imports.test.mjs — 锁住 `lib/desktop.js` 对外部符号的引用都有来源。
 *
 * 为什么存在：`lib/desktop.js` 第 2 行是 `// @ts-nocheck`，`tsc` 不检查它；
 * 而 `repairOfficialCli` 里两个从 `./host/shim-repair.js` 搬过来的函数
 * （`targetIsValid` / `writeShimInPlace`）在搬迁时漏了 import。于是
 * `ReferenceError: targetIsValid is not defined` 从 2026-10-23 那天活到真机上才炸，
 * 后果不是丢一行日志 —— 是 `dsh desktop host stopped`：整个 host 进程停掉。
 *
 * 判据是**结构性**的，不查「跑一遍」：那条路径要真解包、真改 shim 才走得到，
 * 测试里造不出来（造出来就得动真宿主树，那是另一条红线）。所以锁三件事：
 *   一、文件里调用了这两个符号；
 *   二、`./host/shim-repair.js` 的 import 里列了它们；
 *   三、那个模块**真的导出**它们（防「import 了但对方没导出」—— 那是加载期
 *       SyntaxError，比 ReferenceError 更早，但同样只有真加载才看得见）。
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 搬运过家、必须显式 import 的两个符号；再往 desktop.js 搬东西时把名字加进来。 */
const MOVED_SYMBOLS = ["targetIsValid", "writeShimInPlace"];
const SOURCE_MODULE = "./host/shim-repair.js";

function desktopSource() {
  return fs.readFileSync(path.join(ROOT, "lib", "desktop.js"), "utf8");
}

/** 从源码里取出某个模块的具名 import 列表；没有这条 import 返回 null。 */
function namedImportsOf(source, moduleSpec) {
  const escaped = moduleSpec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${escaped}["']`);
  const m = source.match(re);
  if (!m) return null;
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}

test("desktop.js 带 @ts-nocheck —— 这条前提变了就该重新审这个测试的覆盖面", () => {
  const source = desktopSource();
  assert.match(source, /^\/\/ @ts-nocheck/m, "desktop.js 不再带 @ts-nocheck：tsc 现在会检查它，可以删掉本测试或收窄范围");
});

test("搬迁来的两个符号：文件里真的在调，就必须在 import 里出现", () => {
  const source = desktopSource();
  const imported = namedImportsOf(source, SOURCE_MODULE);
  assert.ok(imported, `desktop.js 没有从 ${SOURCE_MODULE} 导入任何东西 —— 搬过来的符号会变成 ReferenceError`);
  for (const sym of MOVED_SYMBOLS) {
    assert.match(source, new RegExp(`\\b${sym}\\s*\\(`), `desktop.js 已经不再调用 ${sym}：如果它被删了，把它从 MOVED_SYMBOLS 移除`);
    assert.ok(imported.includes(sym), `${sym} 在 desktop.js 里被调用，但 ${SOURCE_MODULE} 的 import 列表里没有它`);
  }
});

test("被导入的名字在源模块里真的导出（否则是加载期 SyntaxError）", async () => {
  const imported = namedImportsOf(desktopSource(), SOURCE_MODULE);
  const mod = await import("../lib/host/shim-repair.js");
  for (const sym of imported) {
    assert.equal(typeof mod[sym] !== "undefined", true, `${SOURCE_MODULE} 没有导出 ${sym}，desktop.js 的 import 会加载失败`);
  }
});

test("shim-repair 是叶子模块：只许依赖 node: 内建，不许反向 import desktop/host", async () => {
  const source = fs.readFileSync(path.join(ROOT, "lib", "host", "shim-repair.js"), "utf8");
  const specs = [...source.matchAll(/^import\s[^\n]*from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  for (const spec of specs) {
    assert.match(spec, /^node:/, `shim-repair.js 依赖了非内建模块 ${spec} —— 它必须保持叶子，否则 desktop.js 引它会成环`);
  }
});
