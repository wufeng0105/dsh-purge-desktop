/**
 * 补丁表结构契约（PATCH-4 / PATCH-2 / PATCH-1 / PATCH-3 的可执行载体）。
 *
 * 这是整本里最值钱的一个测试文件：补丁表全量是插件的全部行为，
 * 它们此前没有任何结构约束 —— id 可以重复、marker 可以没有、schema 可以混用。
 *
 * 断言分四类：
 *   1. 不变式（永远为真）：id 唯一、name 唯一、必填字段齐全
 *   2. 棘轮（只许变好）：singular schema 7 -> 0、无 marker 1 -> 0
 *   3. 冻结（只许追加）：id 集合是基线的超集，空洞永久保留
 *   4. 例外账（软失败必须带对象与期限）：onMiss 非 fail 的每条都要有
 *      reason / hostBuild / reviewBy，缺一即红
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { ALL_PATCHES, PATCH_DISPLAY_GROUPS } from "../lib/core.js";

/** 空洞名单只认 architecture/patches.yaml 的 retired 段（生成物），不在测试里再抄一份。 */
const HOLE_IDS = (() => {
  const yaml = readFileSync(new URL("../architecture/patches.yaml", import.meta.url), "utf8");
  const m = /^retired: \[([^\]]*)\]/m.exec(yaml);
  return m ? m[1].split(",").map((s) => Number(s.trim())).filter(Boolean) : [];
})();

/**
 * 2026-10-23 基线：**92 个 id 守恒** —— 活跃补丁 66 + 空洞 26。
 * 元素可以在两个集合之间迁移（内化 / 删除 → 进空洞），但不得新增、不得消失、不得重编号。
 * 空洞名单的 reason 在 architecture/patches.yaml 的 retiredHoles 段。
 */
const BASELINE_IDS = Array.from({ length: 92 }, (_, i) => i + 1);

/**
 * 软失败的账：onMiss 非 fail 的 37 条必须各自写清三件事 ——
 * 为什么可以软失败（reason）、按哪个宿主 build 写/验（hostBuild）、什么时候复查（reviewBy）。
 *
 * 没有这三项，日志里的 skipped 与「写错了」同形；有 hostBuild，补丁表的声明
 * 才能与 apply-result 的 detail.hostBuild 对账。reason 长度下限与唯一性都在下面锁着，
 * 防的是 37 条填同一句废话。
 */
const SOFT_REASON_MIN = 24;

function softPatches() {
  return ALL_PATCHES.filter((p) => p.onMiss === "ignore" || p.onMiss === "warn");
}

function softLedgerViolations(patches) {
  const violations = [];
  for (const p of patches) {
    if (p.onMiss !== "ignore" && p.onMiss !== "warn") continue;
    const label = `id ${p.id}/${p.name}`;
    if (typeof p.reason !== "string" || p.reason.trim().length < SOFT_REASON_MIN) {
      violations.push(`${label}: reason 缺失或短于 ${SOFT_REASON_MIN} 字`);
    }
    if (typeof p.hostBuild !== "string" || !/^[0-9a-f]{40}$/.test(p.hostBuild)) {
      violations.push(`${label}: hostBuild 不是 40 位宿主 build 标识`);
    }
    if (typeof p.reviewBy !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.reviewBy)) {
      violations.push(`${label}: reviewBy 不是 YYYY-MM-DD`);
    }
  }
  return violations;
}

/**
 * 已登记的空洞：PATCH-1 规定永久保留，不许回收给新补丁。
 *
 * 28 / 71 是主动删掉的（服务第三方插件 @linxin666/dsh-liangshen，本机未安装，
 * 恒 missing）。它们不是「漏了」而是「移除」—— 所以进空洞表，不留给新补丁复用。
 *
 * 38 / 45 是主动删掉的：
 *   · 38 PERSONA_TEXT_PREFIX_ALIAS —— 兼容 0.1.2 的 text 字段（file: persona）
 *   · 45 OFFICIAL_DESKTOP_UPDATE_HANDOFF —— layer "0.2.0 兼容" 的桌面更新交接
 *   保留的是 42 SETTINGS_LEGACY_API（给旧插件留活路）。
 */
const PERMANENT_GAPS = [20, 27, 28, 38, 41, 44, 45, 71, 79, 81];

test("不变式：id 唯一、name 唯一、id 为正整数", () => {
  const ids = ALL_PATCHES.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "id 有重复");
  const names = ALL_PATCHES.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, "name 有重复");
  for (const p of ALL_PATCHES) {
    assert.equal(Number.isInteger(p.id) && p.id > 0, true, `id 非法：${p.id}`);
    assert.equal(typeof p.name, "string", `id ${p.id} 缺 name`);
    assert.ok(p.name.length > 0, `id ${p.id} 的 name 为空`);
  }
});

test("不变式：每条补丁都有 file 与 desc", () => {
  const missing = ALL_PATCHES.filter((p) => !p.file || !p.desc).map((p) => `${p.id}/${p.name}`);
  assert.deepEqual(missing, [], `缺 file 或 desc：${missing.join(", ")}`);
});

test("不变式：每条补丁至少有 replacements 或 patterns 之一", () => {
  const bad = ALL_PATCHES.filter(
    (p) => !Array.isArray(p.replacements) && !Array.isArray(p.patterns),
  ).map((p) => `${p.id}/${p.name}`);
  assert.deepEqual(bad, [], `没有替换规则：${bad.join(", ")}`);
});

test("不变式：layer 只能是已登记的五个值", () => {
  const allowed = new Set(["提示词", "代码", "工具", "0.1.5 兼容", "0.2.0 兼容"]);
  const bad = ALL_PATCHES.filter((p) => !allowed.has(p.layer)).map((p) => `${p.id}=${p.layer}`);
  assert.deepEqual(bad, [], `layer 越界（新增 layer 要先改本测试）：${bad.join(", ")}`);
});

test("冻结：92 个 id 守恒（活跃 + 空洞），不新增、不消失、不重编号（PATCH-1）", () => {
  // 元素允许在「活跃」与「空洞」之间迁移（内化 / 删除都进空洞），但并集必须恒等于基线。
  const live = new Set(ALL_PATCHES.map((p) => p.id));
  const holes = new Set(HOLE_IDS);
  const both = [...BASELINE_IDS].filter((id) => live.has(id) && holes.has(id));
  assert.deepEqual(both, [], `同一个 id 既活跃又空洞：${both.join(", ")}`);
  const union = [...live, ...holes].sort((a, b) => a - b);
  assert.deepEqual(union, [...BASELINE_IDS].sort((a, b) => a - b),
    `活跃 ${live.size} + 空洞 ${holes.size} = ${union.length}，应恒等于基线 ${BASELINE_IDS.length}`);
  assert.equal(new Set(union).size, union.length, "id 有重复");
});

test("冻结：空洞 id 永久保留，不许分配给新补丁（PATCH-1）", () => {
  const current = new Set(ALL_PATCHES.map((p) => p.id));
  const reclaimed = PERMANENT_GAPS.filter((id) => current.has(id));
  assert.deepEqual(
    reclaimed,
    [],
    `这些 id 是历史空洞，复用会让用户机器上的旧状态错位：${reclaimed.join(", ")}`,
  );
});

test("冻结：新增补丁的 id 必须大于当前最大值（只许追加）", () => {
  const max = Math.max(...BASELINE_IDS);
  const suspicious = ALL_PATCHES.filter(
    (p) => !BASELINE_IDS.includes(p.id) && p.id <= max,
  ).map((p) => `${p.id}/${p.name}`);
  assert.deepEqual(
    suspicious,
    [],
    `新补丁占用了中间 id，应改为 ${max + 1} 起：${suspicious.join(", ")}`,
  );
});

test("棘轮：singular schema 已清零，不许回升（PATCH-4，7 -> 0）", () => {
  const singular = ALL_PATCHES.filter((p) => Array.isArray(p.patterns)).map((p) => p.id);
  // 最后 7 条（5,6,7,8,10,15,16）迁成了 plural。此后再出现 patterns 字段
  // 就是新债 —— 断言从「精确列出存量」改成「必须为空」。
  assert.deepEqual(
    singular,
    [],
    "又出现 singular schema 的补丁了。新补丁一律 replacements:[{pattern,replace}] + markers[]",
  );
});

test("棘轮：无 marker 的补丁只许减少（PATCH-2，1 -> 0）", () => {
  const noMarker = ALL_PATCHES.filter(
    (p) => !Array.isArray(p.markers) && !p.marker,
  ).map((p) => p.id);
  assert.deepEqual(
    noMarker,
    [21],
    "id 21（BASH_TIMEOUT_RESTORE）是唯一没 marker 的补丁（靠 onMiss 的 warn 兜底）。补上 marker 后把这里改成 []",
  );
});

test("棘轮：有 surfaces 声明的补丁数只许增加（PATCH-3，5 -> 全部）", () => {
  const withSurfaces = ALL_PATCHES.filter((p) => Array.isArray(p.surfaces)).map((p) => p.id);
  // 45（OFFICIAL_DESKTOP_UPDATE_HANDOFF）已删，这里少一个。
  assert.deepEqual(withSurfaces.sort((a, b) => a - b), [46, 82, 83, 84]);
  assert.ok(withSurfaces.length >= 4, "surfaces 声明数减少了");
 // 缺省语义：没有 surfaces 的补丁 = 全宿主适用（PATCH-3 明文登记）
  const without = ALL_PATCHES.length - withSurfaces.length;
 assert.equal(without, 62, `缺省 surfaces 的补丁从 78 变成 ${without}，请在 PATCH-3 同步`);
});

/**
 * 已登记的 strictFiles 集合。
 *
 * 43 / 70 是原有就有的（WEB_PRESET_IDENTITY_STRIP / PRESET_SHELL_NETWORK）。
 * 其余 13 条是刻意转必中的：打的是审批 / 沙箱 / 提权 / fs-fence 这类安全策略，
 * **静默失效 = 清洗没做但面板显示成功**，所以全部改成必中：
 *   6 SANDBOX_DENY_FILE_WRITE      7 SANDBOX_MODE_DEFAULT
 *   8 APPROVAL_POLICY_DEFAULT      9 APPROVAL_AUTO_GRANT
 *  10 APPROVAL_CONFIG_DEFAULT_NEVER 13 ESCALATION_WIDENING_EXEMPT
 *  14 ESCALATION_GRANT_UNCONDITIONAL 15 SANDBOX_CONFINE_PASSTHROUGH
 *  16 FS_FENCE_DISABLED           17 FS_OBSERVATION_INTENT_FREE
 *  35 ESCALATION_NEVER_REJECT     51 FRESH_SESSION_FULL_ACCESS
 *  92 SUBAGENT_SAME_INJECT_PATH
 */
const STRICT_IDS = [6, 7, 13, 14, 15, 16, 17, 35, 51, 70, 92].sort((a, b) => a - b);

test("strictFiles 只允许出现在已登记的补丁上（13 条安全策略 + 原有 43/70）", () => {
  const strict = ALL_PATCHES.filter((p) => p.strictFiles === true).map((p) => p.id);
  assert.deepEqual(strict.sort((a, b) => a - b), STRICT_IDS);
  // 这 15 条必须同时是 onMiss:"fail" —— strictFiles 挂在软补丁上等于没挂
  // （isPatchResultSoftOk 的 strictFiles 分支只管 pattern_not_found，
  //   而 onMiss:"warn" 会让 filePatchSettled 把对不上的文件判成 applied，
  //   根本走不到 pattern_not_found。两者必须成套出现。）
  const softButStrict = ALL_PATCHES.filter((p) => p.strictFiles && p.onMiss && p.onMiss !== "fail");
  assert.deepEqual(
    softButStrict.map((p) => p.id),
    [],
    "strictFiles 只能挂在 onMiss:fail 的补丁上，否则必中是假的",
  );
});

test("显示分组引用的 id 必须都真实存在", () => {
  const ids = new Set(ALL_PATCHES.map((p) => p.id));
  const dangling = [];
  for (const [group, list] of Object.entries(PATCH_DISPLAY_GROUPS)) {
    for (const id of list) {
      if (!ids.has(id)) dangling.push(`${group} -> ${id}`);
    }
  }
  assert.deepEqual(dangling, [], `显示分组引用了不存在的补丁：${dangling.join(", ")}`);
});

test("例外账：37 条软失败各自带 reason / hostBuild / reviewBy，缺一即红", () => {
  const soft = softPatches();
  assert.equal(soft.length, 37, "软失败条数变了：应仍是 31 条 ignore + 6 条 warn");
  const violations = softLedgerViolations(soft);
  assert.deepEqual(
    violations,
    [],
    `软失败缺记账字段（补上 reason / hostBuild / reviewBy 再来）：${violations.join("；")}`,
  );
});

test("例外账：hostBuild 是同一个宿主 build 声明，不是 37 种写法或 version 冒充", () => {
  const builds = [...new Set(softPatches().map((p) => p.hostBuild))];
  assert.equal(builds.length, 1, `hostBuild 应只有一个值，实际：${builds.join(", ")}`);
  assert.match(
    builds[0],
    /^[0-9a-f]{40}$/,
    "hostBuild 必须是宿主 package.json 的 dshBuildCommit（40 位），不是 version、通配符或 any",
  );
});

test("例外账：37 条 reason 不许互相重复（同一句废话等于没写）", () => {
  const reasons = softPatches().map((p) => String(p.reason ?? "").trim());
  assert.equal(new Set(reasons).size, reasons.length, "有两条以上软失败用了同一句 reason");
});

test("例外账反向：缺字段、空串、短理由、通配 hostBuild、坏日期都必须被抓到", () => {
  const base = {
    id: 9102,
    name: "SOFT_LEDGER_TEST",
    onMiss: "ignore",
    reason: "对象与依据都写清楚的一句理由，长度必须超过二十四个字的下限",
    hostBuild: "332895e0f7c9d4dbfb29729f5eb367fa263ff986",
    reviewBy: "2026-12-31",
  };
  assert.deepEqual(softLedgerViolations([base]), [], "齐全的一条不该被判违规");

  const cases = [
    [{ reason: undefined }, /reason/],
    [{ reason: "太短" }, /reason/],
    [{ hostBuild: "" }, /hostBuild/],
    [{ hostBuild: "*" }, /hostBuild/],
    [{ hostBuild: "0.2.1-rc.2" }, /hostBuild/],
    [{ reviewBy: "" }, /reviewBy/],
    [{ reviewBy: "2026/12/31" }, /reviewBy/],
  ];
  for (const [override, pattern] of cases) {
    const hits = softLedgerViolations([{ ...base, ...override }]);
    assert.equal(hits.length, 1, `${JSON.stringify(override)} 应恰好被抓到一条`);
    assert.match(hits[0], pattern);
  }

  // 缺省 fail 的补丁不属于这本账：删掉 onMiss 不许被误伤。
  assert.deepEqual(softLedgerViolations([{ ...base, onMiss: undefined }]), []);
  assert.deepEqual(softLedgerViolations([{ ...base, onMiss: "fail" }]), []);
});
