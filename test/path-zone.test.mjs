/**
 * 路径分区契约（DELETE-3 / SURFACE-4 的地基）。
 *
 * `pathZone` + `allowTargetPath` 是「补丁到底允许写哪里」的唯一判据。
 * 删 web 面时能不能安全删掉 web 分支，取决于这两个函数的分区是否可枚举、
 * 是否与 SURFACES 对齐。它们此前没有任何测试。
 *
 * 关键不变式（必须保持）：
 *   桌面宿主 → 只允许 desktop-install / desktop-profile / shared
 *   非桌面宿主 → 只允许 shared / web-profile / web-install
 * 两者对 shared 的交集，就是删 web 面时唯一不能碰的部分。
 *
 * 注意 desktop-install 依赖安装根探测，测试里用 DSH_DESKTOP_INSTALL 注入
 * （desktop.js:290 读它），不碰真实安装目录 —— 符合 DELETE-4「不 mock fs」。
 */
import { test } from "node:test";
import assert from "node:assert";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { allowTargetPath, allowTargetPathForAiBase, pathZone } from "../lib/core.js";

/** 分区枚举必须与实现完全一致，多一个少一个都要显式改这里。 */
const ZONES = [
  "desktop-install",
  "desktop-profile",
  "web-profile",
  "web-install",
  "shared",
  "missing",
];

/**
 * 用环境变量声明一个假安装根，让 desktop-install 分区可复现。
 *
 * 这个值**必须与平台匹配**，有两个原因：
 *
 *   1. `DSH_DESKTOP_INSTALL` 按 `path.delimiter` 分隔多根，而 POSIX 的分隔符
 *      就是 `:`。写死 `C:/FakeHarness/...` 在 Linux 上会被拆成
 *      `["C", "/FakeHarness/DeepSeek Harness"]` 两段，都不是安装根 →
 *      desktop-install 分区永远命中不了。
 *   2. 反过来，`/tmp/...` 在 Windows 上会被 `path.normalize` 折成
 *      `\tmp\...`，再与断言里的 `/tmp/...` 比较就永远不等。
 *
 * 本文件此前只在 Windows 跑过，所以这两个缺陷都没暴露 —— CI 在 ubuntu 上一跑就红。
 */
const IS_WIN = process.platform === "win32";

/** 假安装根：形态与当前平台一致，才可能被 trustedInstallDir 认下。 */
const FAKE_INSTALL = IS_WIN
  ? "C:/FakeHarness/DeepSeek Harness"
  : "/tmp/FakeHarness/DeepSeek Harness";

/** 桌面树内的一个子路径（用 path.join 保证分隔符与平台一致）。 */
const FAKE_DESKTOP_TREE = join(FAKE_INSTALL, "resources", "app", "dsh");

function withFakeInstall(fn) {
  const previous = process.env.DSH_DESKTOP_INSTALL;
  process.env.DSH_DESKTOP_INSTALL = FAKE_INSTALL;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.DSH_DESKTOP_INSTALL;
    else process.env.DSH_DESKTOP_INSTALL = previous;
  }
}

test("pathZone：六种分区都能命中，且是枚举内的值", () => {
  const plain = {
    "C:/Users/a/.dsh/profiles/desktop/package.json": "desktop-profile",
    "C:/Users/a/.dsh/profiles/web/package.json": "web-profile",
    "/usr/local/lib/npm-global/lib/node_modules/x": "web-install",
    "C:/Users/a/.dsh/prompt-inject.md": "shared",
  };
  for (const [fp, expected] of Object.entries(plain)) {
    const zone = pathZone(fp);
    assert.equal(zone, expected, `pathZone(${fp})`);
    assert.ok(ZONES.includes(zone), `分区 ${zone} 不在枚举内`);
  }
  assert.equal(pathZone(""), "missing");

  // desktop-install 需要安装根可探测，用注入复现
  withFakeInstall(() => {
    const zone = pathZone(FAKE_DESKTOP_TREE);
    assert.equal(zone, "desktop-install");
    assert.ok(ZONES.includes(zone));
  });
});

test("pathZone：Windows 反斜杠与大小写不影响分区", () => {
  assert.equal(
    pathZone("C:\\Users\\a\\.dsh\\profiles\\WEB\\package.json"),
    pathZone("c:/users/a/.dsh/profiles/web/package.json"),
  );
});

test("allowTargetPath：桌面宿主拒绝 web 侧路径（SURFACE-4 的核心红线）", () => {
  const webProfile = "C:/Users/a/.dsh/profiles/web/package.json";
  const webInstall = "/usr/local/lib/npm-global/lib/node_modules/x";
  assert.equal(allowTargetPath(webProfile, "desktop"), false, "桌面宿主不许写 web profile");
  assert.equal(allowTargetPath(webInstall, "desktop"), false, "桌面宿主不许写 npm-global");
});

test("allowTargetPath：桌面宿主允许自己的树与共享区", () => {
  withFakeInstall(() => {
    assert.equal(allowTargetPath(FAKE_DESKTOP_TREE, "desktop"), true);
  });
  assert.equal(allowTargetPath("C:/Users/a/.dsh/profiles/desktop/package.json", "desktop"), true);
  assert.equal(allowTargetPath("C:/Users/a/.dsh/prompt-inject.md", "desktop"), true);
});

test("allowTargetPath：web 宿主拒绝桌面侧路径", () => {
  withFakeInstall(() => {
    assert.equal(allowTargetPath(FAKE_DESKTOP_TREE, "web"), false);
  });
  assert.equal(allowTargetPath("C:/Users/a/.dsh/profiles/desktop/package.json", "web"), false);
  assert.equal(
    allowTargetPath("C:/Users/a/.dsh/prompt-inject.md", "web"),
    true,
    "shared 两侧都允许",
  );
});

test("allowTargetPath：gui/tui 现在等价于 web（现在这条要改）", () => {
  withFakeInstall(() => {
    assert.equal(allowTargetPath(FAKE_DESKTOP_TREE, "gui"), false);
    assert.equal(allowTargetPath(FAKE_DESKTOP_TREE, "tui"), false);
  });
});

test("allowTargetPath 与 allowTargetPathForAiBase 在无 aiBase 时结论一致", () => {
  const paths = [
    "C:/Users/a/.dsh/profiles/desktop/package.json",
    "C:/Users/a/.dsh/profiles/web/package.json",
    "C:/Users/a/.dsh/prompt-inject.md",
  ];
  for (const fp of paths) {
    assert.equal(
      allowTargetPathForAiBase(fp, ""),
      allowTargetPath(fp, "web"),
      `无 aiBase 时两条判据应等价：${fp}`,
    );
  }
});

test("allowTargetPathForAiBase：aiBase 在桌面安装内时按桌面规则", () => {
  withFakeInstall(() => {
    const desktopBase = FAKE_DESKTOP_TREE;
    assert.equal(
      allowTargetPathForAiBase("C:/Users/a/.dsh/profiles/web/package.json", desktopBase),
      false,
    );
    assert.equal(
      allowTargetPathForAiBase("C:/Users/a/.dsh/profiles/desktop/package.json", desktopBase),
      true,
    );
  });
});
