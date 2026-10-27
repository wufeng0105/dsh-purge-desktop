/**
 * scripts/check-host-upgrade-dryrun.mjs — 宿主换 build 之后哪些补丁会静默失配，一条命令答完。
 *
 * 为什么需要它：`probe:clean-host` 答的是「全新安装在这版官方原文上每条补丁判什么」，
 * `probe:host` 只数 pattern 命中数。两样都答不了同一条问题：装机树的宿主换了 build 之后，
 * 补丁表里那些**声明了自己写于哪个 build** 的软失败条目，还对不对得上。
 * 补丁表自 T2 起给 37 条软失败记了 `hostBuild` 声明，但没有一处读它 —— 字段记了不用等于没记。
 *
 * ## 判据只有一条
 *
 * 声明的 build ≠ 实际 build，**且**这条补丁在当前宿主上本来就是软 miss
 * （`lib/patch/status.js` 的 `isSoftOk` 判它不必让 apply 失败）⇒ 退出码 1。
 * 其余一律 0。不许在这里另加红条件（例如「有声明就必须 applied」或者「缺失即红」）：
 * 宿主换 build 之后本来就该有一批补丁这一版不需要，把那些也判红，红灯会变成噪声。
 *
 * `MISS_STATUS` 只收 `pattern_not_found` 与 `skipped`，这是 `patchStatus` 的取值域决定的：
 * 它只会产出 applied / already 之外的 pending、unmatched、skipped、missing_file、na，
 * 而 `pattern_not_found` 是 apply 报告里的状态（引擎只在 apply 循环里自增 notFound）。
 * 两个都是「这条补丁在宿主上没落到」，差别只是走的是报告还是状态口。
 * `na` / `missing_file` 不进这个集合 —— 那是「这一版没有目标文件」，不是 miss。
 *
 * ## 为什么引擎逻辑跑在子进程里
 *
 * 仓库有一条依赖规则禁止 `scripts/` 静态 import `lib/`（脚本是仓库侧的一次性动作，
 * 运行期代码要能脱离仓库单独加载）。而这项任务同时要求「复用 `resolveHostBuild()` 与
 * `isSoftOk()`，不许另写一份取值逻辑」。两条同时成立只有一条路：父进程负责形状、
 * 分组与退出码，子进程用 `node --input-type=module -e` 去 import 真引擎，只把事实递回来。
 * 于是矩阵里的「实际 build」与落账时记的「声明 build」出自同一段代码，不会长出第二个真相。
 *
 * 只读：不写宿主、不调 apply / backup / revert；归档只落仓库内 `.tmp-repair/`（已 gitignore），
 * 且路径里的用户目录一律折成 `<home>` —— 归档要能贴进 issue，不该带出机器上的名字。
 *
 * 用法：`node scripts/check-host-upgrade-dryrun.mjs` 或加 `--json`（stdout 只有矩阵 JSON，
 * 人读的摘要走 stderr）。它不是 `npm run verify` 的一环：它读本机宿主，CI 上没有。
 * 退出码：0 = 对账通过；1 = 有失配；2 = 环境不成立（读不到宿主，或脚本被搬到仓库根以外）——
 * 2 不是通过，这三种互不替代。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const wantJson = process.argv.slice(2).includes("--json");

/** 人读输出；`--json` 时改走 stderr，保证 stdout 只有一份可解析的矩阵。 */
const say = (...args) => (wantJson ? console.error : console.log)(...args);

const EXIT_OK = 0;
const EXIT_MISMATCH = 1;
const EXIT_NO_HOST = 2;

/**
 * 子进程里的引擎取数：只做四件事 —— 定位宿主、取实际 build、取当前状态、按补丁算软 miss。
 * 所有判定函数都是 `lib/` 里导出的原件，这里不重写任何一条。
 * 无 backtick、无 `${`：这段源码整体躺在一个模板字符串里。
 */
const ENGINE_SOURCE = `
import fs from "node:fs";

process.env.DSH_SURFACE = process.env.DSH_SURFACE || "desktop";
const trace = [];
const out = (payload) => process.stdout.write(JSON.stringify(payload));

try {
  const core = await import("./lib/core.js");
  const { ALL_PATCHES } = await import("./lib/patch/table.js");
  const { targetFiles } = await import("./lib/host/targets.js");
  const { isSoftOk } = await import("./lib/patch/status.js");
  const { resolveHostBuild } = await import("./lib/audit/report.js");

  const attempt = async (name) => {
    const fn = core[name];
    if (typeof fn !== "function") return null;
    try {
      let v = fn();
      if (v && typeof v.then === "function") v = await v;
      if (v && typeof v === "object" && typeof v.aiBase === "string" && v.aiBase) {
        trace.push(name + "() → 对象，aiBase=" + v.aiBase);
        return v.aiBase;
      }
      trace.push(name + "() → " + (typeof v === "string" && v ? v : JSON.stringify(v)));
      return typeof v === "string" && v ? v : null;
    } catch (e) {
      trace.push(name + "() 抛错 " + e.message);
      return null;
    }
  };

  let aiBase = null;
  for (const name of ["resolveOfficialAiBase", "findAiBase", "findDshBinRoot"]) {
    if (aiBase) break;
    aiBase = await attempt(name);
  }
  if (!aiBase && typeof core.enumeratePatchAiBases === "function") {
    try {
      let list = core.enumeratePatchAiBases();
      if (list && typeof list.then === "function") list = await list;
      const arr = Array.isArray(list) ? list : [list];
      trace.push("enumeratePatchAiBases() → " + arr.length + " 个");
      if (arr[0]) aiBase = arr[0];
    } catch (e) {
      trace.push("enumeratePatchAiBases() 抛错 " + e.message);
    }
  }
  if (!aiBase) {
    out({ ok: false, stage: "aiBase", trace });
    process.exit(0);
  }

  const targets = targetFiles(aiBase);
  const landing = Object.values(targets)
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((p) => typeof p === "string" && p !== "" && fs.existsSync(p));

  const built = resolveHostBuild(landing);
  const status = await core.patchStatus(aiBase);
  const rows = ALL_PATCHES.map((p) => {
    const s = status[p.id] || "unknown";
    return {
      id: p.id,
      name: p.name,
      layer: p.layer,
      onMiss: core.onMissOf(p),
      declared: typeof p.hostBuild === "string" ? p.hostBuild.trim() : "",
      status: s,
      softOk: isSoftOk({ status: s, patch_id: p.id }, p, core.onMissOf),
    };
  });
  out({
    ok: true,
    aiBase,
    landing: landing.length,
    trace,
    hostBuild: built.hostBuild,
    hostBuildSource: built.hostBuildSource,
    rows,
  });
} catch (e) {
  out({ ok: false, stage: "engine", trace, error: e && e.message ? e.message : String(e) });
}
`;

const HOME = os.homedir();
/** 归档会进仓库归档区（虽然被 ignore），机器上的用户名不该跟着走。 */
const scrub = (text) => (typeof text === "string" && HOME ? text.split(HOME).join("<home>") : text);

function sha256Of(rel) {
  // 取指纹失败只有一种现实原因：脚本被搬到仓库根以外跑。它与「读不到宿主」同属
  // 环境不成立，给同一个退出码 2，别让一个栈回溯冒充「矩阵为空所以通过」。
  let buf;
  try {
    buf = fs.readFileSync(path.join(repoRoot, rel));
  } catch (e) {
    say(`读不到仓库文件 ${rel}（脚本要在仓库根内运行）：${scrub(e.message)}`);
    process.exit(EXIT_NO_HOST);
  }
  return createHash("sha256").update(buf).digest("hex");
}
function gitHead() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

const sourceFingerprint = {
  head: gitHead(),
  files: {
    "lib/patch/table.js": sha256Of("lib/patch/table.js"),
    "lib/patch/status.js": sha256Of("lib/patch/status.js"),
    "lib/audit/report.js": sha256Of("lib/audit/report.js"),
  },
};

/** 取宿主事实。任何一步失败都返回 null，由调用方给退出码 2 并说清缺哪一半。 */
function readHost() {
  let raw;
  try {
    raw = execFileSync(process.execPath, ["--input-type=module", "-e", ENGINE_SOURCE], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (e) {
    const stderr = e.stderr ? String(e.stderr).trim() : "";
    say(`读不到宿主：引擎子进程退出码 ${e.status ?? "(无)"}${stderr ? `，stderr：${scrub(stderr)}` : ""}`);
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    say(`读不到宿主：子进程输出不是 JSON（前 200 字：${scrub(raw.slice(0, 200))}）`);
    return null;
  }
}

const data = readHost();
if (!data) process.exit(EXIT_NO_HOST);

if (!data.ok) {
  const detail = data.stage === "aiBase"
    ? `定位不到宿主 aiBase（${(data.trace || []).map(scrub).join("；")}）`
    : `引擎抛错：${scrub(data.error)}（回溯：${(data.trace || []).map(scrub).join("；")}）`;
  say(`读不到宿主，无法对账：${detail}`);
  process.exit(EXIT_NO_HOST);
}

if (!data.hostBuild) {
  say("读不到宿主 build，无法对账 —— 矩阵缺「实际」这一半：");
  say(`  ${scrub(data.hostBuildSource)}`);
  say("  需要的是宿主 resources/app/package.json 的 dshBuildCommit 字段。");
  process.exit(EXIT_NO_HOST);
}

const aiBase = scrub(data.aiBase);
const hostBuild = data.hostBuild;
const hostBuildSource = scrub(data.hostBuildSource);

/** 「这条补丁在宿主上没落到」的两个状态；取值域见文件头。 */
const MISS_STATUS = new Set(["pattern_not_found", "skipped"]);

const matrix = data.rows.map((row) => {
  const declaredHostBuild = row.declared;
  const buildChanged = declaredHostBuild !== "" && declaredHostBuild !== hostBuild;
  const isMiss = MISS_STATUS.has(row.status);
  const mismatch = buildChanged && isMiss && row.softOk;
  let reason;
  if (declaredHostBuild === "") reason = "无声明（不是软失败条目，判据不适用）";
  else if (!buildChanged) reason = "声明的 build 与实际一致";
  else if (!isMiss) reason = `build 变了，但这条在当前宿主上是 ${row.status}，不是 miss`;
  else if (!row.softOk) reason = "build 变了且没落到，但这条会判失败（不是软失败）";
  else reason = "build 变了且没落到，而 onMiss 让它不报错";
  return {
    id: row.id,
    name: row.name,
    layer: row.layer,
    onMiss: row.onMiss,
    declaredHostBuild,
    actualHostBuild: hostBuild,
    actualStatus: row.status,
    softOk: row.softOk,
    isMiss,
    verdict: mismatch ? "mismatch" : "ok",
    reason,
  };
});

const mismatches = matrix.filter((r) => r.verdict === "mismatch");
const declared = matrix.filter((r) => r.declaredHostBuild !== "").length;
const exitCode = mismatches.length > 0 ? EXIT_MISMATCH : EXIT_OK;

const archive = {
  generatedAt: new Date().toISOString(),
  sourceFingerprint,
  host: {
    build: hostBuild,
    source: hostBuildSource,
    aiBase,
    landingFiles: data.landing,
  },
  counts: {
    patches: matrix.length,
    declared,
    softMiss: matrix.filter((r) => r.isMiss && r.softOk).length,
    mismatches: mismatches.length,
  },
  /** 这份矩阵里实际出现的 status 取值 —— 文件头那条「取值域」的说法要能被当场核对。 */
  statusesSeen: [...new Set(matrix.map((r) => r.actualStatus))].sort(),
  exitCode,
  matrix,
};

say(`宿主 build = ${hostBuild}`);
say(`  来源：${hostBuildSource}`);
say(`  aiBase：${aiBase}（落点文件 ${data.landing} 个）`);
say(`矩阵：${matrix.length} 条活跃补丁，其中带 hostBuild 声明的 ${declared} 条`);
const softMissRows = matrix.filter((r) => r.isMiss && r.softOk);
say(`软 miss（这条没落到、且 onMiss 让它不报错）：${softMissRows.length} 条${softMissRows.length ? `（id ${softMissRows.map((r) => r.id).join(", ")}）` : ""}`);
say();

/**
 * 按层分组：同层里「声明 + 状态 + 判定」都相同的行合并成一行，只列 id。
 * 37 条同值时平铺 37 行，读的人只会看到一片重复；合并后一眼能看出「这一层整批一致」。
 */
const layers = [...new Set(matrix.map((r) => r.layer))];
for (const layer of layers) {
  const rows = matrix.filter((r) => r.layer === layer);
  say(`【${layer}】${rows.length} 条`);
  const groups = new Map();
  for (const row of rows) {
    const key = `声明 ${row.declaredHostBuild || "(无)"} · 状态 ${row.actualStatus} · 判定 ${row.verdict}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.id);
  }
  for (const [key, ids] of groups) {
    say(`  ${key} → ${ids.length} 条：${ids.join(", ")}`);
  }
}

if (mismatches.length > 0) {
  say();
  say(`失配 ${mismatches.length} 条（声明 ≠ 实际，且这条在宿主上是软 miss）：`);
  for (const r of mismatches) {
    say(`  id=${r.id} ${r.name}（${r.layer}，onMiss=${r.onMiss}）声明=${r.declaredHostBuild} 实际=${r.actualHostBuild} 状态=${r.actualStatus}`);
  }
}

say();
say(`结论：矩阵 ${matrix.length} 条，失配 ${mismatches.length} 条 → exit ${exitCode}`);
if (exitCode === EXIT_MISMATCH) {
  say("宿主换过 build，而上面这些补丁已经落不到、又不会让 apply 失败 —— 它们现在是静默失效。");
}

const outDir = path.join(repoRoot, ".tmp-repair");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "host-upgrade-dryrun.json");
fs.writeFileSync(outPath, JSON.stringify(archive, null, 1), "utf8");
say(`JSON → ${path.relative(repoRoot, outPath)}`);

if (wantJson) process.stdout.write(`${JSON.stringify(archive, null, 1)}\n`);
process.exit(exitCode);
