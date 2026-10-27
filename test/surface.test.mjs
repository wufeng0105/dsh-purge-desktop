/**
 * surface 判定（现在的契约）。
 *
 * SURFACE-3 把 `detectSurface` 从「探测失败 = web」改成 fail-fast 抛错，
 * 并把 SURFACES 从 4 个收缩到 1 个（只剩 desktop）。
 *
 * 本文件是 现在的权威行为记录。SURFACE-3 之前的版本见 git 历史 ——
 * 那些「错误行为」断言（`adapterFor("gui") === "web"`、`detectSurface({}) === "web"`）
 * 已被删除，删除本身就是 SURFACE-3 完成的证据（SURFACE-1 / PATCH-6）。
 */
import { test } from "node:test";
import assert from "node:assert";
import {
  SURFACES,
  SURFACE_UNSUPPORTED,
  adapterFor,
  detectSurface,
  isDesktopSurface,
  pathLooksDesktop,
} from "../lib/surface.js";

/** 现在唯一支持的宿主面。 */
const ONLY = "desktop";

test("SURFACE-3：SURFACES 收缩到只剩 desktop（SURFACE-1 已转绿）", () => {
  assert.deepEqual([...SURFACES], [ONLY], "SURFACES 只应包含 desktop");
});

test("SURFACE-3：adapterFor 对 desktop 返回 desktop，其余一律抛错", () => {
  assert.equal(adapterFor("desktop"), "desktop");
  for (const bad of ["web", "gui", "tui", "unknown", "", null, undefined]) {
    assert.throws(
      () => adapterFor(bad),
      (error) => {
        assert.equal(error.code, SURFACE_UNSUPPORTED, `adapterFor(${JSON.stringify(bad)}) 的错误码不对`);
        assert.match(String(error.message), /不支持的宿主面/);
        return true;
      },
      `adapterFor(${JSON.stringify(bad)}) 应抛错，不许静默回退`,
    );
  }
});

test("SURFACE-3：detectSurface 强制 desktop 生效", () => {
  assert.equal(detectSurface({ env: { DSH_SURFACE: "desktop" } }), "desktop");
  // 大小写与空白归一
  assert.equal(detectSurface({ env: { DSH_SURFACE: "  DESKTOP  " } }), "desktop");
});

test("SURFACE-3：detectSurface 探测失败抛错（不再静默回退 web）", () => {
  const cases = [
    { env: {}, execPath: "/usr/bin/node", argv: [] },
    { env: { DSH_SURFACE: "web" }, execPath: "/usr/bin/node" },
    { env: { DSH_SURFACE: "gui" }, execPath: "/usr/bin/node" },
    { env: { DSH_SURFACE: "tui" }, execPath: "/usr/bin/node" },
    { env: { DSH_SURFACE: "bogus" }, execPath: "/usr/bin/node" },
  ];
  for (const input of cases) {
    assert.throws(
      () => detectSurface(input),
      (error) => {
        assert.equal(
          error.code,
          SURFACE_UNSUPPORTED,
          `detectSurface(${JSON.stringify(input)}) 的错误码不对`,
        );
        // 错误信息要能让人看懂发生了什么
        assert.match(String(error.message), /只支持官方桌面端/);
        assert.match(String(error.message), /CLI 宿主面已在 1\.0\.0 移除/);
        return true;
      },
      `detectSurface(${JSON.stringify(input)}) 应抛错`,
    );
  }
});

test("SURFACE-3：exe 名命中仍判桌面", () => {
  const byExe = (execPath) => detectSurface({ env: {}, execPath, argv: [] });
  assert.equal(byExe("C:/x/DSH Desktop.exe"), "desktop");
  assert.equal(byExe("C:/x/DeepSeek Harness.exe"), "desktop");
  assert.equal(byExe("C:/x/deepseek-harness.exe"), "desktop");
  assert.equal(
    byExe("/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"),
    "desktop",
  );
});

test("SURFACE-3：argv 里出现桌面安装路径仍判桌面", () => {
  assert.equal(
    detectSurface({
      env: {},
      execPath: "/usr/bin/node",
      argv: ["/usr/bin/node", "/x/DeepSeek Harness/resources/app"],
    }),
    "desktop",
  );
  // 普通路径不再回退 web，而是抛错
  assert.throws(
    () => detectSurface({ env: {}, execPath: "/usr/bin/node", argv: ["/usr/bin/node", "/home/u/project"] }),
    /只支持官方桌面端/,
  );
});

test("pathLooksDesktop：只认安装形态，不认项目名", () => {
  assert.equal(pathLooksDesktop("C:/x/DeepSeek Harness/resources/app.asar"), true);
  assert.equal(pathLooksDesktop("C:/x/DSH Desktop/resources"), true);
  assert.equal(pathLooksDesktop("/Applications/DeepSeek Harness.app/Contents/Resources"), true);
  assert.equal(pathLooksDesktop("/x/host-process-entry.js"), true);
  // 源码仓库常带同名目录，不能误判
  assert.equal(pathLooksDesktop("C:/Users/a/project/deepseek-harness"), false);
  assert.equal(pathLooksDesktop("/usr/lib/node"), false);
  assert.equal(pathLooksDesktop(""), false);
});

test("isDesktopSurface 与 detectSurface 对同一输入给出一致结论", () => {
  // 三列对齐：detectSurface 返回 desktop ⟺ isDesktopSurface 为真。
  // 探测失败时 detectSurface 抛错、isDesktopSurface 为假 —— 两者仍然一致。
  const cases = [
    { input: { env: { DSH_SURFACE: "desktop" } }, desktop: true },
    { input: { env: {}, execPath: "C:/x/DSH Desktop.exe" }, desktop: true },
    { input: { env: {}, execPath: "/usr/bin/node", argv: [] }, desktop: false },
    {
      input: { env: {}, execPath: "/usr/bin/node", resourcesPath: "C:/x/DeepSeek Harness/resources" },
      desktop: true,
    },
  ];
  for (const { input, desktop } of cases) {
    assert.equal(isDesktopSurface(input), desktop, `isDesktopSurface(${JSON.stringify(input)})`);
    if (desktop) {
      assert.equal(detectSurface(input), "desktop");
    } else {
      assert.throws(() => detectSurface(input), /只支持官方桌面端/);
    }
  }
});
