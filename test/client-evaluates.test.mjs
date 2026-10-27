/**
 * CONTRACT-5：产物必须能**求值**，不只是能解析。
 *
 * ## 为什么这条测试必须存在
 *
 * `node --check client.js` 只验语法。当年把 `WELCOME_KEY` 挪到 welcome 助手
 * 旁边时，顺手把 `AUTH_KEY` 与 welcome 助手之间的五行声明（`let drillGrantGen/
 * Posting/State/SyncRetryTimer` 与 `const AUTH_LEGAL_HTML`）一起圈进了占位符
 * 替换区，正文被换成「源文件里的 welcome 助手」—— 那五行就此消失。
 *
 * 后果不是「某个功能不好用」，而是**整个 bundle 打不开**：闭包一进顶层就会执行
 * `syncDrillGrant();`，它读 `drillGrantGen` → `ReferenceError`。而当时：
 *   - `node --check` 绿（语法合法）
 *   - `npm test` 152 绿（没人真的跑过 factory）
 *   - CI 全绿（verify.yml 的 client 检查也只有 --check + marker + 字节 drift）
 *   - 字节 drift 也绿（因为产物本身就是基线，缺的五行在基线里就缺）
 *
 * 这五行一直缺到抽源那轮，**实测跨了 3 个 tag**
 * （v1.0.1-codegen / v1.0.2-split / v1.1.0-semantics 的产物都加载不了；
 * v1.0.0-baseline 与 v1.2.0-clientsrc 健康 —— 复现方式：
 * `node scripts/verify-rollback-point.mjs <tag>` 的三项矩阵）。
 * 发现它靠的是「抽源时顺手用 tsc 扫了一遍未声明标识符」，不是任何门禁；
 * 现在两半都补上了：静态半边是 `scripts/check-artifact-names.mjs`，
 * 执行半边就是本文件。
 *
 * 所以这里补的是**执行级**判据：在最小 VM 里把 ModuleLoader 的 factory 真的
 * 跑一次。它抓的是「能解析但不能求值」，这正是语法检查与该死的字符串断言
 * 中间的盲区。
 *
 * 桩与加载器已抽到 `test/helpers/client-factory.mjs`：
 * `scripts/verify-rollback-point.mjs` 要在**解包出来的临时副本**上跑同一套桩，
 * 两条路径共用一份实现才不会漂移。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { DEFAULT_CLIENT, loadFactory, resolveModuleStub } from "./helpers/client-factory.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT = DEFAULT_CLIENT;

test("CONTRACT-5：client.js 的 ModuleLoader factory 能真的求值（不是只有语法合法）", () => {
  const factory = loadFactory();
  // 上传回 factory 本身就是判据：闭包的顶层求值（含 `syncDrillGrant();`）
  // 有任何未声明的自由变量都会在这里抛 ReferenceError。
  assert.doesNotThrow(() => {
    factory(resolveModuleStub);
  }, "factory 求值抛错 —— 产物语法合法但一进闭包就炸，插件面板打不开");
});

test("CONTRACT-5：factory 的 exports 面完整（name / inject / apply）", () => {
  const factory = loadFactory();
  const mod = factory(resolveModuleStub);
  for (const key of ["name", "inject", "apply"]) {
    assert.ok(key in mod, `exports 缺 ${key} —— 宿主按这三个名字装载插件`);
  }
  assert.equal(mod.name, "dsh-purge");
  assert.ok(Array.isArray(mod.inject), "inject 必须是数组（宿主按它排座位依赖）");
  assert.equal(typeof mod.apply, "function", "apply 必须是函数");
});

test("CONTRACT-5：授权窗的声明正文内联在产物里，不依赖任何请求", () => {
  // 授权窗必须在接口挂掉 / 断网时也能显示。所以 AUTH_LEGAL_HTML 得是产物里的
  // 字面量，不能改成运行时 fetch —— 那会让用户对着空白弹窗永远进不去演练台。
  const text = readFileSync(CLIENT, "utf8");
  const m = /const AUTH_LEGAL_HTML = ("(?:[^"\\]|\\.)*");/.exec(text);
  assert.ok(m, "AUTH_LEGAL_HTML 不是产物里的内联字面量（可能被改成运行时取值了）");
  const html = JSON.parse(m[1]);
  assert.ok(html.length > 2000, `声明正文只有 ${html.length} 字符，疑似被截断`);
  assert.match(html, /<h3>/, "声明正文缺标题");
  // 正文与 docs/ 里那份同源：取首行做锚点比对（逐字节比对留给专门的测试）
  const doc = readFileSync(join(ROOT, "docs", "drill-auth-legal.html"), "utf8").replace(/\r\n/g, "\n").trim();
  assert.equal(html.replace(/\r\n/g, "\n"), doc, "内联的声明正文与 docs/drill-auth-legal.html 不一致");
});
