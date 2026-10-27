/**
 * 更新通道契约（UPDATE-1 的可执行载体）。
 *
 * 这是本仓库唯一的安全项：`dsh-purge` 是私有库，但历史上把更新源硬编码成
 * `wufeng0105/dsh-purge` —— 一个**至今仍可匿名下载**的公网仓（实测 codeload 200）。
 * 两条独立路径都指向它：
 *
 *   路径 A  根 client.js → GET/POST /dsh-purge/update → lib/update.js
 *   路径 B  演练台面板   → POST /redteam/api op=updateCheck → lib/redteam/ui.js
 *
 * 后果不是「更新失败」，是**静默覆盖**：点一次「更新」，本机私有 fork 变成旧公网包。
 *
 * 本文件锁四件事：
 *   1. 默认状态必须是「本地版，无远端源」
 *   2. 没有远端源时，任何出网入口都不许发请求，且必须给出可读原因
 *   3. 源码里不许再出现旧的硬编码仓库名（注释除外）
 *   4. 显式配置后能正常启用（否则规则会把功能锁死，逼人绕过）
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 旧公网仓：这个字符串不许再出现在任何可执行代码里。 */
const LEGACY_REPO = "wufeng0105/dsh-purge";
/** 私有仓：当前正确目标。 */
const PRIVATE_REPO = "wufeng0105/dsh-purge-desktop";

/** 剥掉注释，只留可执行代码，避免把历史说明误判成硬编码。 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("UPDATE-1：默认状态是本地版，没有远端源", async () => {
  const update = await import("../lib/update.js");
  // 确保环境变量没有污染
  const previous = process.env.DSH_PURGE_UPDATE_REPO;
  delete process.env.DSH_PURGE_UPDATE_REPO;
  update.resetUpdateSourceCache();
  try {
    assert.equal(update.remoteEnabled(), false, "默认必须是 local 模式");
    assert.deepEqual(update.resolveUpdateSource(), { mode: "local" });
  } finally {
    if (previous !== undefined) process.env.DSH_PURGE_UPDATE_REPO = previous;
    update.resetUpdateSourceCache();
  }
});

test("UPDATE-1：本地版 checkUpdate 返回结构化结果，不发请求", async () => {
  const update = await import("../lib/update.js");
  const previous = process.env.DSH_PURGE_UPDATE_REPO;
  delete process.env.DSH_PURGE_UPDATE_REPO;
  update.resetUpdateSourceCache();
  try {
    const result = await update.checkUpdate();
    assert.equal(result.ok, true, "不该抛错 —— 面板要能正常渲染");
    assert.equal(result.updateDisabled, true, "必须显式标记更新已关闭");
    assert.equal(result.hasUpdate, false, "本地版永远没有可更新版本");
    assert.equal(result.versions.length, 0, "不许列出远端版本");
    assert.match(
      result.updateDisabledReason,
      /私有库/,
      "原因文案要让人看懂，不能是内部术语",
    );
    assert.equal(result.localVersion, update.localVersion(), "本地版本号仍要显示");
  } finally {
    if (previous !== undefined) process.env.DSH_PURGE_UPDATE_REPO = previous;
    update.resetUpdateSourceCache();
  }
});

test("UPDATE-2：源码里不再有旧公网仓的硬编码（注释除外）", () => {
  const files = ["lib/update.js", "lib/redteam/ui.js"];
  const offenders = [];
  for (const rel of files) {
    const code = codeOnly(readFileSync(join(ROOT, rel), "utf8"));
    if (code.includes(LEGACY_REPO)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `这些文件的可执行代码里仍有旧公网仓 ${LEGACY_REPO}：${offenders.join(", ")}`,
  );
});

test("UPDATE-3：package.json 的更新/安装元数据不指向旧公网仓", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const haystack = JSON.stringify({
    repository: pkg.repository,
    homepage: pkg.homepage,
    bugs: pkg.bugs,
    install: pkg.dsh?.install,
  });
  // 注意：LEGACY_REPO 是 PRIVATE_REPO 的前缀，不能直接用 includes 判断。
  // 用「后面不跟 -desktop」的负向前瞻，才能区分 dsh-purge 与 dsh-purge-desktop。
  const legacyHit = new RegExp(`${LEGACY_REPO}(?!-desktop)`).test(haystack);
  assert.equal(
    legacyHit,
    false,
    `package.json 的元数据里仍有旧公网仓：\n${haystack}`,
  );
  // 私有库不提供公网安装源
  assert.equal(
    pkg.dsh?.install?.preferred,
    "local",
    "私有库的 dsh.install.preferred 必须是 local",
  );
  assert.equal(pkg.dsh?.install?.tarball, undefined, "不许再声明公网 tarball");
  assert.equal(pkg.dsh?.install?.zip, undefined, "不许再声明公网 zip");
  assert.equal(pkg.dsh?.install?.git, undefined, "不许再声明公网 git 源");
});

test("UPDATE-2：homepage 指向私有仓，不再指向旧公网仓", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.ok(
    String(pkg.homepage || "").includes(PRIVATE_REPO),
    `homepage 应指向 ${PRIVATE_REPO}，实际是 ${pkg.homepage}`,
  );
});

test("UPDATE-2：显式配置环境变量后能启用远端（规则不许把功能锁死）", async () => {
  const update = await import("../lib/update.js");
  const previous = process.env.DSH_PURGE_UPDATE_REPO;
  process.env.DSH_PURGE_UPDATE_REPO = "someone/dsh-purge-fork";
  update.resetUpdateSourceCache();
  try {
    assert.equal(update.remoteEnabled(), true, "显式配置后必须能启用");
    assert.deepEqual(update.resolveUpdateSource(), {
      mode: "github",
      repo: "someone/dsh-purge-fork",
      via: "DSH_PURGE_UPDATE_REPO",
    });
  } finally {
    if (previous === undefined) delete process.env.DSH_PURGE_UPDATE_REPO;
    else process.env.DSH_PURGE_UPDATE_REPO = previous;
    update.resetUpdateSourceCache();
  }
});

test("UPDATE-2：非法仓库名被拒绝，退回 local 而不是拼出坏 URL", async () => {
  const update = await import("../lib/update.js");
  const previous = process.env.DSH_PURGE_UPDATE_REPO;
  const bad = ["", "no-slash", "a/b/c", "a b/c", "../../etc/passwd", "a/b?x=1"];
  update.resetUpdateSourceCache();
  try {
    for (const value of bad) {
      process.env.DSH_PURGE_UPDATE_REPO = value;
      update.resetUpdateSourceCache();
      assert.equal(
        update.remoteEnabled(),
        false,
        `非法值 ${JSON.stringify(value)} 不该被当成仓库名`,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_PURGE_UPDATE_REPO;
    else process.env.DSH_PURGE_UPDATE_REPO = previous;
    update.resetUpdateSourceCache();
  }
});
