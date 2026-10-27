/**
 * 契约：宿主版本门禁（CONTRACT-4）。
 *
 * 背景：`dshTarget: "0.2.0-rc.2"` 此前在全仓 **0 处被读取**，299 处字符串替换里
 * **0 处带版本条件** —— 补丁对宿主版本完全无感知，失效时是静默的。
 *
 * CONTRACT-4 把这个声明接进代码：apply 之前先过门禁，不匹配就拒绝，而不是打一堆
 * 匹配不到的补丁然后静默失效。
 *
 * ## 为什么不是严格相等
 *
 * 本机宿主是 `0.2.1-rc.2`，`dshTarget` 是 `0.2.0-rc.2`。严格相等会让插件
 * 在自己开发机上就用不了。所以规则是：主次版本必须相同，rc 序号允许向上漂移。
 * 下面逐条验证这个策略，包括它**不该**放行的情形。
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  compareHostVersion,
  gateHostVersion,
  parseVersion,
  readHostVersion,
} from "../lib/host-version.js";
import { compareVersions, sameMajorMinor } from "../lib/version.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("CONTRACT-4：parseVersion 能解析常见形态", () => {
  assert.deepEqual(parseVersion("0.2.1-rc.2"), {
    major: 0, minor: 2, patch: 1, prerelease: ["rc", "2"],
  });
  assert.deepEqual(parseVersion("v1.0.0"), {
    major: 1, minor: 0, patch: 0, prerelease: [],
  });
  assert.equal(parseVersion(""), null);
  assert.equal(parseVersion("not-a-version"), null);
  assert.equal(parseVersion(null), null);
});

test("CONTRACT-4：完全一致的版本判 exact", () => {
  const v = compareHostVersion("0.2.0-rc.2", "0.2.0-rc.2");
  assert.equal(v.ok, true);
  assert.equal(v.level, "exact");
});

test("CONTRACT-4：宿主 rc 序号更高判 compatible（本机真实情形）", () => {
  // 本机：宿主 0.2.1-rc.2，dshTarget 0.2.0-rc.2
  const v = compareHostVersion("0.2.1-rc.2", "0.2.0-rc.2");
  assert.equal(v.ok, true, "同 minor 的更高 rc 应放行，否则开发机都用不了");
  assert.equal(v.level, "compatible");
});

test("CONTRACT-4：宿主 rc 序号更低判 mismatch（补丁按新版写的）", () => {
  const v = compareHostVersion("0.2.0-rc.1", "0.2.0-rc.2");
  assert.equal(v.ok, false);
  assert.equal(v.level, "mismatch");
  assert.match(v.reason, /更旧/);
});

test("CONTRACT-4：跨 minor 判 mismatch（补丁目标结构可能已变）", () => {
  for (const host of ["0.1.9", "0.3.0", "1.2.0", "0.2.99"]) {
    const v = compareHostVersion(host, "0.2.0-rc.2");
    if (host === "0.2.99") {
      // 同 minor，patch 更高 → 允许（补丁通常仍能匹配）
      assert.equal(v.ok, true, `${host} 同 minor 应放行`);
      continue;
    }
    assert.equal(v.ok, false, `${host} 跨 minor 应拒绝`);
    assert.equal(v.level, "mismatch");
  }
});

test("CONTRACT-4：无法解析的版本判 unparsable 且不放行", () => {
  for (const [host, target] of [
    ["", "0.2.0-rc.2"],
    ["garbage", "0.2.0-rc.2"],
    ["0.2.1-rc.2", ""],
    ["0.2.1-rc.2", "garbage"],
  ]) {
    const v = compareHostVersion(host, target);
    assert.equal(v.ok, false, `${host} / ${target} 不该放行`);
    assert.equal(v.level, "unparsable");
  }
});

test("CONTRACT-4：gateHostVersion 不匹配时拒绝并给出可执行提示", () => {
  const g = gateHostVersion({ hostVersion: "0.3.0", dshTarget: "0.2.0-rc.2" });
  assert.equal(g.allowed, false);
  assert.match(g.reason, /主次版本不同/);
  // 提示必须告诉人怎么办，不能只说"失败了"
  assert.match(g.hint, /升级插件|forceApplyOnVersionMismatch/);
});

test("CONTRACT-4：force 显式绕过时必须留下警告文案", () => {
  const g = gateHostVersion({ hostVersion: "0.3.0", dshTarget: "0.2.0-rc.2", force: true });
  assert.equal(g.allowed, true, "force 必须能放行，否则规则会逼人改代码");
  assert.equal(g.level, "forced");
  assert.match(g.hint, /失效是静默的/, "强制放行必须警告后果");
});

test("CONTRACT-4：readHostVersion 读不到时返回空串（不抛错）", () => {
  assert.equal(readHostVersion(""), "");
  assert.equal(readHostVersion("/nonexistent/path/xyz"), "");
  assert.doesNotThrow(() => readHostVersion(null));
  assert.doesNotThrow(() => readHostVersion(undefined));
});

test("CONTRACT-4：readHostVersion 能从真实宿主结构读到版本", () => {
  // 用本机真实安装（存在则验证，不存在则跳过 —— CI 上没有宿主）
  const aiBase =
    "C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai";
  const version = readHostVersion(aiBase);
  if (!version) {
    // CI / 无宿主环境：这条断言不适用
    return;
  }
  assert.match(version, /^\d+\.\d+\.\d+/, `读到的版本不像 semver: ${version}`);
});

test("CONTRACT-4：package.json 声明的 dshTarget 能被解析", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.dshTarget, "package.json 必须声明 dshTarget");
  assert.ok(
    parseVersion(pkg.dshTarget),
    `dshTarget ${JSON.stringify(pkg.dshTarget)} 无法解析 —— 门禁会一直判 unparsable`,
  );
});

test("CONTRACT-4：代码里真的读取了 dshTarget（不再只是装饰品）", () => {
  const coreSrc = readFileSync(join(ROOT, "lib/core.js"), "utf8");
  assert.match(
    coreSrc,
    /dshTarget/,
 "lib/core.js 必须读取 dshTarget —— 这是 CONTRACT-4 的全部意义",
  );
  assert.match(
    coreSrc,
    /checkHostVersionGate/,
    "core.js 必须调用版本门禁",
  );
  // applyPatches 必须先过门禁
  const applyIdx = coreSrc.indexOf("export async function applyPatches(");
  assert.ok(applyIdx > 0, "找不到 applyPatches");
  const body = coreSrc.slice(applyIdx, applyIdx + 600);
  assert.match(body, /checkHostVersionGate/, "applyPatches 开头必须先过版本门禁");
});

test("CONTRACT-4：gatherState 暴露版本门禁结果（UI 要显示）", async () => {
  const core = await import("../lib/core.js");
  const state = await core.gatherState();
  assert.ok("host_version" in state, "state 缺 host_version");
  assert.ok("dsh_target" in state, "state 缺 dsh_target");
  assert.ok(state.version_gate, "state 缺 version_gate");
  assert.equal(typeof state.version_gate.allowed, "boolean");
  assert.equal(typeof state.version_gate.level, "string");
  assert.equal(typeof state.plugin_version, "string");
});

test("CONTRACT-4：门禁不匹配时 applyPatches 抛明确错误", async () => {
  const core = await import("../lib/core.js");
  // 传一个明确跨 minor 的版本，并给一个不存在的 aiBase
  await assert.rejects(
    () => core.applyPatches("/nonexistent/ai-base", core.ALL_PATCHES, { hostVersion: "0.3.0" }),
    (error) => {
      assert.equal(
        error.code,
        "DSH_PURGE_HOST_VERSION_MISMATCH",
        `错误码不对：${error.code}`,
      );
      assert.match(String(error.message), /主次版本不同/);
      assert.ok(error.gate, "错误上应带 gate 详情供 UI 展示");
      return true;
    },
  );
});

/**
 * 版本门禁必须提到 `applyPatchesAllHosts` 入口。
 *
 * 收敛前：gate 只在 `applyPatches` 里，而 `applyPatchesAllHosts` 在调它之前
 * 就已经 `backupAll`（写 .bak / vault）、`restoreHookDenyForBases`（改 hooks 配置），
 * 之后还有 `silenceCmdFlash`（改 bin / supervisor / 各插件源码）。
 * 版本不匹配时这些写路径照跑 —— 「拒绝」只拒绝了补丁本身。
 *
 * 这两条断言守的是「先门禁、后写盘」这个顺序，不是某个具体实现细节：
 *   1. 全部宿主都不匹配时，一个文件都不许动（backup 目录不能出现）
 *   2. 错误上要能看出是「整体拒绝」而不是「单个宿主失败」
 */
test("applyPatchesAllHosts 入口先过门禁，不匹配时一个字节都不写", async () => {
  const core = await import("../lib/core.js");
  const { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  // 造一个「像插件根」的假宿主：只要有 dsh-agent-instructions/lib 就够 isAiBase 认。
  const root = mkdtempSync(join(tmpdir(), "s4-gate-"));
  const aiBase = join(root, "node_modules", "@deepseek-ai");
  mkdirSync(join(aiBase, "dsh-agent-instructions", "lib"), { recursive: true });
  writeFileSync(join(aiBase, "dsh-agent-instructions", "lib", "index.js"), "export const x = 1;\n");
  // 让 readHostVersion 读到一个明确跨 minor 的版本（它读 dsh-agent-instructions/package.json）。
  writeFileSync(
    join(aiBase, "dsh-agent-instructions", "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-agent-instructions", version: "0.3.0" }),
  );

  const previousBase = process.env.DSH_BASE;
  const previousSurface = process.env.DSH_SURFACE;
  // 这一轮 apply 会写 diag。日志落点必须跟着临时 home 走，否则夹具路径会混进
  // 开发者真实 ~/.dsh/dsh-purge/logs/diag.jsonl，而那份文件是排障时唯一的事实源。
  const logHome = mkdtempSync(join(tmpdir(), "s4-gate-home-"));
  process.env.DSH_SURFACE = "desktop";
  process.env.DSH_BASE = aiBase;
  try {
    await assert.rejects(
      () => core.applyPatchesAllHosts(core.ALL_PATCHES, { dshHome: logHome }),
      (error) => {
        assert.equal(error.code, "DSH_PURGE_HOST_VERSION_MISMATCH");
        assert.ok(Array.isArray(error.rejected) && error.rejected.length > 0, "错误上要列出被拒的宿主");
        assert.ok(Array.isArray(error.gates), "错误上要带全部宿主的 gate 明细");
        assert.match(String(error.message), /未写入任何文件/);
        return true;
      },
    );
    // 硬证据：备份目录 / 备份文件一个都没出现（backupAll 没跑）。
    const stray = [];
    const walk = (dir) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (/\.dshpurge\.bak$/.test(ent.name)) stray.push(full);
      }
    };
    walk(root);
    assert.deepEqual(stray, [], `门禁拒绝后仍有备份文件落地：${stray.join(", ")}`);
  } finally {
    if (previousBase === undefined) delete process.env.DSH_BASE;
    else process.env.DSH_BASE = previousBase;
    if (previousSurface === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = previousSurface;
    rmSync(logHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply.host 每个宿主都带版本对：多宿主时不再只记第一个", () => {
  // `apply.start` 发得早，那时只有第一个宿主的版本读得出来，所以它天然只能带一对。
  // 其余宿主的门禁结论必须另有正面证据 —— 落在 `apply.host`，逐宿主一行。
  const source = readFileSync(join(ROOT, "lib", "core.js"), "utf8");
  assert.ok(source.includes("const gateOfHost = gates.find"), "apply.host 没有从 gates 里取本宿主的门禁结论");
  assert.match(
    source,
    /note\("apply\.host",\s*\{[\s\S]{0,600}?hostVersion: gateOfHost\.hostVersion[\s\S]{0,200}?dshTarget: gateOfHost\.dshTarget/,
    "apply.host 没带上本宿主的 hostVersion / dshTarget",
  );
  assert.ok(source.includes("...gateVersionPairForLog(options)"), "apply.start 的版本对照被移走了");
});

/**
 * 同一 minor 下的八组边界：这是「patch 号不参与比较」那个缺陷的回归口径。
 *
 * 判据不是「这四个值要放行」这件事本身，而是「宿主 ≥ 目标」这一句：
 * 逐组给期望时，改判据的人必须先解释为什么 0.2.2 反而更旧。
 */
test("CONTRACT-4：同 minor 的八组边界按全序判（patch 号必须参与比较）", () => {
  const target = "0.2.1-rc.2";
  const cases = [
    ["0.2.1-rc.2", true, "exact"],
    ["0.2.1-rc.3", true, "compatible"],
    // rc 序号是数字段：rc.10 高于 rc.2，不是字符串比较。
    ["0.2.1-rc.10", true, "compatible"],
    // 正式版高于同号预发布。
    ["0.2.1", true, "compatible"],
    ["0.2.2-rc.1", true, "compatible"],
    ["0.2.1-rc.1", false, "mismatch"],
    ["0.2.0-rc.5", false, "mismatch"],
    ["0.3.0", false, "mismatch"],
  ];
  for (const [host, ok, level] of cases) {
    const v = compareHostVersion(host, target);
    assert.equal(v.ok, ok, `${host} 对 ${target} 的放行结论错了：${v.reason}`);
    assert.equal(v.level, level, `${host} 对 ${target} 的档位错了`);
  }
  // 反向也要说得出话：被拒绝的那一条理由不许把「更新」说成「更旧」。
  const older = compareHostVersion("0.2.0-rc.5", target);
  assert.match(older.reason, /更旧/, "拒绝理由必须说清是更旧");
  assert.match(older.reason, /patch 号更小/, "拒绝理由要点名是哪一段更小");
});

test("CONTRACT-4：正式版与预发布的先后按 semver precedence", () => {
  assert.equal(compareVersions("0.2.1", "0.2.1-rc.2"), 1, "正式版高于同号预发布");
  assert.equal(compareVersions("0.2.1-rc.1", "0.2.1"), -1, "预发布低于同号正式版");
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1, "段数少的更低");
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1, "数字段按数值比");
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1, "数字段小于非数字段");
  assert.equal(compareVersions("1.0.0+build.9", "1.0.0"), 0, "构建元数据不参与比较");
  assert.equal(compareVersions("garbage", "1.0.0"), null, "不可判不是相等");
  assert.equal(sameMajorMinor("0.2.1-rc.2", "0.2.9"), true);
  assert.equal(sameMajorMinor("0.3.0", "0.2.9"), false);
  assert.equal(sameMajorMinor("", ""), true, "两侧都解析不出来时退回字符串相等");
});

test("CONTRACT-4：版本比较只有一处实现（戳判据不再自己写一份）", () => {
  // 账本层在 lib/stamp.js（reapply 只转出 API），所以戳判据要去那里核。
  const stamp = readFileSync(join(ROOT, "lib", "stamp.js"), "utf8");
  assert.match(stamp, /import \{[^}]*sameMajorMinor[^}]*\} from "\.\/version\.js"/, "账本判据必须消费 lib/version.js");
  assert.equal(/function majorMinor\(/.test(stamp), false, "戳判据不许再自己实现一份主次版本口径");
  const reapply = readFileSync(join(ROOT, "lib", "reapply.js"), "utf8");
  assert.equal(/function majorMinor\(/.test(reapply), false, "reapply 里不许再留一份主次版本口径");
  const gate = readFileSync(join(ROOT, "lib", "host-version.js"), "utf8");
  assert.match(gate, /compareVersions/, "门禁必须走全序比较");
  assert.equal(/hostPre\[0\] === wantPre\[0\]/.test(gate), false, "「两边都是 rc」不许再当成一条独立分支");
});
