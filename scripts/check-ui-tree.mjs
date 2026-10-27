/**
 * scripts/check-ui-tree.mjs — 架构树是生成的，必须能反查出源码里每个座位与补丁。
 * architecture/ui-tree.yaml 的反查门禁。
 *
 * 存在的理由：架构树是手写判断 + 脚本生成的混合产物，最容易出的错是
 * 「树里写了、代码里没有」和「代码里有、树里没写」。四条校验都朝着同一个方向查：
 * 拿源码与补丁表当唯一事实，树的每一条都要能被它们证实。
 *
 * 四条校验（任一不过即退出码 1）：
 *   ① 源码里每处座位注册的 slot，在树里有对应节点
 *   ② 树里每个节点有代码实现，或标 status=dropped 并写理由
 *   ③ patches.yaml 每条 id 在补丁表里存在，或被列入 RETIRED；且补丁表每条都有归宿
 *   ④ 树里每个原子引用的 op，在第 4.1 步数据面清单里存在
 *
 * 不引第三方 YAML 库：这两个文件的格式由 scripts 生成，用行级解析足够，
 * 且少一个依赖就少一处与运行时脱节的地方。解析只认本文件头声明的格式。
 *
 * 用法：node scripts/check-ui-tree.mjs [--verbose]
 * 退出码：0 全过 / 1 有失败项 / 2 环境错误（文件缺失、补丁表加载失败）
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const verbose = process.argv.includes("--verbose");

const failures = [];
const notes = [];
const fail = (check, msg, hint) => failures.push({ check, msg, hint: hint ?? "" });

function readOrDie(rel) {
  const fp = join(root, rel);
  if (!existsSync(fp)) {
    console.error(`[2] 环境错误：缺少 ${rel}`);
    process.exit(2);
  }
  return readFileSync(fp, "utf8");
}

const treeText = readOrDie("architecture/ui-tree.yaml");
const patchesText = readOrDie("architecture/patches.yaml");

// ── 极简行级解析 ─────────────────────────────────────────────────────────────
const treeLines = treeText.split("\n");
const patchLines = patchesText.split("\n");

/** 取 `meta.dataplane.ops` 段里的全部 op 名。 */
function parseDataplaneOps(lines) {
  const ops = new Set();
  let inOps = false;
  for (const line of lines) {
    if (/^\s{4}ops:\s*$/.test(line)) { inOps = true; continue; }
    if (/^\s{4}routeOps:\s*$/.test(line)) { inOps = false; continue; }
    if (!inOps) continue;
    const m = /^\s{6}-\s+"(.+)"\s*$/.exec(line);
    if (m) ops.add(m[1]);
  }
  return ops;
}

/** 取 `meta.dataplane.routeOps` 里每个 route 的 ops 数组。 */
function parseRouteOps(lines) {
  const byRoute = new Map();
  let inBlock = false;
  let route = null;
  for (const line of lines) {
    if (/^\s{4}routeOps:\s*$/.test(line)) { inBlock = true; continue; }
    if (inBlock && /^\s{2}[a-z]+:\s*$/.test(line)) inBlock = false;
    if (!inBlock) continue;
    const r = /^\s{6}-\s+route:\s+"(.+)"\s*$/.exec(line);
    if (r) { route = r[1]; continue; }
    const o = /^\s{8}ops:\s*\[(.+)\]\s*$/.exec(line);
    if (o && route) {
      byRoute.set(route, [...o[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
      route = null;
    }
  }
  return byRoute;
}

/** 取座位注册节点：(slot, id, status, reason, at)。 */
function parseSlotNodes(lines) {
  const out = [];
  let inBlock = false;
  let cur = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s{2}slotRegistrations:\s*$/.test(line)) { inBlock = true; continue; }
    if (inBlock && /^\s{2}domains:\s*$/.test(line)) { inBlock = false; }
    if (!inBlock) continue;
    const s = /^\s{4}-\s+slot:\s+"(.*)"\s*$/.exec(line);
    if (s) { cur = { slot: s[1], at: `ui-tree.yaml:${i + 1}` }; out.push(cur); continue; }
    if (!cur) continue;
    const f = /^\s{6}(id|at|status|reason):\s+"?(.*?)"?\s*$/.exec(line);
    if (f) cur[f[1]] = f[2];
  }
  return out;
}

/** 取全部原子节点：(op, field, assert, at)。 */
function parseAtoms(lines) {
  const out = [];
  let cur = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const id = /^\s{10}-\s+id:\s+"(.*)"\s*$/.exec(line);
    if (id) { cur = { id: id[1], at: `ui-tree.yaml:${i + 1}` }; out.push(cur); continue; }
    if (!cur) continue;
    const f = /^\s{12}(op|field|failure|assert|status):\s+"(.*)"\s*$/.exec(line);
    if (f) cur[f[1]] = f[2];
  }
  return out;
}

/** 取能力节点与域节点：(id, parent, seat, atomCount)。 */
function parseStructure(lines) {
  const domains = [];
  const capabilities = [];
  let curDomain = null;
  let curCap = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const d = /^\s{2}-\s+id:\s+"?(.*?)"?\s*$/.exec(line);
    if (d) { curDomain = { id: d[1], at: `ui-tree.yaml:${i + 1}` }; domains.push(curDomain); curCap = null; continue; }
    const c = /^\s{6}-\s+id:\s+"?(.*?)"?\s*$/.exec(line);
    if (c) { curCap = { id: c[1], at: `ui-tree.yaml:${i + 1}`, atoms: 0 }; capabilities.push(curCap); continue; }
    if (curCap) {
      const f = /^\s{8}(parent|seat|source|formRef):\s+"?(.*?)"?\s*$/.exec(line);
      if (f) curCap[f[1]] = f[2];
      if (/^\s{10}-\s+id:/.test(line)) curCap.atoms += 1;
    }
  }
  return { domains, capabilities };
}

/** 取某个顶格键的段范围 [start, end)；找不到就是空段。 */
function sectionRange(lines, key) {
  const start = lines.findIndex((l) => new RegExp("^" + key + ":\\s*$").test(l));
  if (start < 0) return { start: -1, end: -1 };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z_][\w-]*:/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

/** 向后兼容：没有 patches: 段时按整份文件解析。 */
function patchesRange(lines) {
  const r = sectionRange(lines, "patches");
  return r.start < 0 ? { start: 0, end: lines.length } : r;
}

function parsePatches(lines) {
  const rows = [];
  let cur = null;
  const range = patchesRange(lines);
  for (let i = range.start; i < range.end; i += 1) {
    const line = lines[i];
    const id = /^\s{2}-\s+id:\s+(\d+)\s*$/.exec(line);
    if (id) { cur = { id: Number(id[1]), at: `patches.yaml:${i + 1}` }; rows.push(cur); continue; }
    if (!cur) continue;
    const f = /^\s{4}(verdict|evidence|name|onMiss|probeStatus):\s+"?(.*?)"?\s*$/.exec(line);
    if (f) cur[f[1]] = f[2];
  }
  const retiredLine = lines.find((l) => /^retired:\s*\[/.test(l));
  const retired = retiredLine ? [...retiredLine.matchAll(/\d+/g)].map((m) => Number(m[0])) : [];
  return { rows, retired };
}

/** 只解析 retiredHoles: 段：每条空洞的 id 与 reason。 */
function parseHoles(lines) {
  const range = sectionRange(lines, "retiredHoles");
  if (range.start < 0) return [];
  const out = [];
  let cur = null;
  for (let i = range.start + 1; i < range.end; i += 1) {
    const line = lines[i];
    const id = /^\s{2}-\s+id:\s+(\d+)\s*$/.exec(line);
    if (id) { cur = { id: Number(id[1]), reason: "", at: `patches.yaml:${i + 1}` }; out.push(cur); continue; }
    if (!cur) continue;
    const r = /^\s{4}reason:\s*"?(.*?)"?\s*$/.exec(line);
    if (r) cur.reason = r[1];
  }
  return out;
}

/** 扫源码里的座位注册：`slots.register({ name: "x"` 与 `slots.inject("x"`。 */
function scanSourceSlots() {
  const files = [
    "lib/client-src/shell.js", "lib/redteam/client.js", "lib/client-src/rewind/install.js",
    "lib/client-src/dock/mounts.js", "lib/client-src/dock/purge-dock.js",
  ];
  const out = [];
  for (const rel of files) {
    const fp = join(root, rel);
    if (!existsSync(fp)) continue;
    readFileSync(fp, "utf8").split("\n").forEach((line, i) => {
      const inj = /slots\.inject\(\s*["']([^"']+)["']/.exec(line);
      if (inj) out.push({ slot: inj[1], at: `${rel}:${i + 1}`, kind: "inject" });
      const reg = /name:\s*["']([a-z][a-z0-9.-]*)["']/.exec(line);
      if (reg && /slots\.register|register\(\{/.test(line)) out.push({ slot: reg[1], at: `${rel}:${i + 1}`, kind: "register" });
    });
  }
  return out;
}

// ── ① 座位注册必须在树里有节点 ───────────────────────────────────────────────
const srcSlots = scanSourceSlots();
const slotNodes = parseSlotNodes(treeLines);
const treeSlotNames = new Set(slotNodes.map((s) => s.slot));
for (const s of srcSlots) {
  if (!treeSlotNames.has(s.slot)) {
    fail("① 座位反查", `源码注册了 ${s.slot}（${s.at}），ui-tree.yaml 的 slotRegistrations 里没有对应节点`,
      "在 meta.slotRegistrations 补一条：slot / id / at / status / reason");
  }
}
notes.push(`① 源码座位注册 ${srcSlots.length} 处 / 树内座位节点 ${slotNodes.length} 个 / 去重座位 ${treeSlotNames.size} 个`);

// ── ② 每个节点有实现，或 dropped 且有理由 ───────────────────────────────────
const atoms = parseAtoms(treeLines);
const { domains, capabilities } = parseStructure(treeLines);
for (const d of domains) {
  if (!capabilities.some((c) => c.parent === d.id)) fail("② 节点实现", `域 ${d.id}（${d.at}）没有任何能力节点`, "补 capability 节点或把该域标 dropped");
}
for (const c of capabilities) {
  if (c.atoms === 0) fail("② 节点实现", `能力 ${c.id}（${c.at}）没有原子节点`, "至少挂一个原子，或标 status=dropped 写理由");
  if (!c.seat) fail("② 节点实现", `能力 ${c.id}（${c.at}）缺 seat`, "补实测确认过的座位名");
  if (!c.parent) fail("② 节点实现", `能力 ${c.id}（${c.at}）缺 parent`, "补所属域 id");
}
for (const a of atoms) {
  if (!a.op) fail("② 节点实现", `原子 ${a.id}（${a.at}）缺 op`, "补数据来源 op 或 route");
  if (!a.field) fail("② 节点实现", `原子 ${a.id}（${a.at}）缺 field`, "补字段名（5.1 要求单一字段）");
  if (!a.assert) fail("② 节点实现", `原子 ${a.id}（${a.at}）缺 assert`, "补可执行断言（5.3）");
  if (a.assert && /显示正常|正常工作|没问题|看起来/.test(a.assert)) {
    fail("② 节点实现", `原子 ${a.id}（${a.at}）的 assert 不可执行：${a.assert}`, "换成命令、字节检查或 seq 查询");
  }
}
for (const s of slotNodes) {
  if (s.status !== "live" && s.status !== "dropped") {
    fail("② 节点实现", `座位节点 ${s.slot}（${s.at}）status 非法：${s.status ?? "(空)"}`, "只能是 live 或 dropped");
  }
  if (s.status === "dropped" && !s.reason) {
    fail("② 节点实现", `座位节点 ${s.slot}（${s.at}）标了 dropped 但没写理由`, "补 reason，说明删了之后用户失去什么");
  }
}
notes.push(`② 域 ${domains.length} / 能力 ${capabilities.length} / 原子 ${atoms.length} / 座位节点 ${slotNodes.length}`);

// ── ③ 补丁归宿表与补丁表互相覆盖 ─────────────────────────────────────────────
let tableIds = null;
try {
  const mod = await import("../lib/patch/table.js");
  tableIds = new Set(mod.ALL_PATCHES.map((p) => p.id));
} catch (e) {
  console.error(`[2] 环境错误：无法加载 lib/patch/table.js：${e && e.message ? e.message : e}`);
  process.exit(2);
}
const { rows: patchRows, retired } = parsePatches(patchLines);
const holes = parseHoles(patchLines);
const retiredSet = new Set(retired);
if (patchRows.length === 0) fail("③ 补丁覆盖", "patches.yaml 里解析出 0 条补丁", "检查生成脚本输出格式");
for (const r of patchRows) {
  if (retiredSet.has(r.id)) {
    fail("③ 补丁覆盖", `patches.yaml 的 id=${r.id}（${r.at}）在 RETIRED 名单里`, "RETIRED 永不复用 id，换新 id");
  } else if (!tableIds.has(r.id)) {
    fail("③ 补丁覆盖", `patches.yaml 的 id=${r.id}（${r.at}）在 lib/patch/table.js 里不存在`, "删掉这条，或先把补丁加进补丁表");
  }
  if (!r.verdict) fail("③ 补丁覆盖", `id=${r.id}（${r.at}）缺 verdict`, "只能是 native / keep / drop，不接受「暂不确定」");
  if (r.verdict && !["native", "keep", "drop"].includes(r.verdict)) {
    fail("③ 补丁覆盖", `id=${r.id}（${r.at}）verdict 非法：${r.verdict}`, "只能是 native / keep / drop");
  }
  if (!r.evidence) fail("③ 补丁覆盖", `id=${r.id}（${r.at}）缺 evidence`, "native 给宿主源码行号；keep/drop 给 probe 结论");
}
const covered = new Set(patchRows.map((r) => r.id));
const missingInYaml = [...tableIds].filter((id) => !covered.has(id) && !retiredSet.has(id));
if (missingInYaml.length) {
  fail("③ 补丁覆盖", `补丁表有 ${missingInYaml.length} 条没进 patches.yaml：${missingInYaml.join(", ")}`, "补丁归宿表必须覆盖全部补丁");
}
// ③ 的三条不变量：活跃 + 空洞 = 92、两集合不交、每条空洞都有 reason
const holeIds = new Set(holes.map((h) => h.id));
if (patchRows.length + holes.length !== 92) {
  fail("③ 补丁覆盖", `活跃 ${patchRows.length} + 空洞 ${holes.length} = ${patchRows.length + holes.length}，应恒等于 92`, "id 守恒：元素可在两集合间迁移，但总数不变");
}
const bothSides = patchRows.filter((r) => holeIds.has(r.id)).map((r) => r.id);
if (bothSides.length) fail("③ 补丁覆盖", `这些 id 既活跃又空洞：${bothSides.join(", ")}`, "一个 id 只能待在一侧");
const noReason = holes.filter((h) => !h.reason || !h.reason.trim()).map((h) => h.id);
if (noReason.length) fail("③ 补丁覆盖", `空洞缺 reason：${noReason.join(", ")}`, "每条空洞都要写 internalized → 服务.method() 或 dropped → 原因");

notes.push(`③ 补丁表 ${tableIds.size} 条 / patches.yaml ${patchRows.length} 条 / 空洞 92-${patchRows.length}=${holes.length} 条 / 漏覆盖 ${missingInYaml.length}`);

// ── ④ 原子引用的 op 必须在数据面清单里 ──────────────────────────────────────
const dataOps = parseDataplaneOps(treeLines);
const routeOps = parseRouteOps(treeLines);
const routeOpNames = new Set([...routeOps.values()].flat());
const routePaths = new Set(routeOps.keys());
const routePrefixes = new Set(["route:/dsh-purge/status", "route:/dsh-purge/hooks-deny", "route:/dsh-purge/last-user",
  "route:/dsh-purge/rewind", "route:/dsh-purge/rewind/options", "route:/dsh-purge/update",
  "route:/dsh-purge/apply", "route:/dsh-purge/revert", "route:/dsh-purge/uninstall",
  "route:/dsh-purge/drill-grant", "route:/dsh-purge/override", "route:/dsh-purge/own-servers",
  "route:/dsh-purge/restart", "route:/dsh-purge/skills", "route:/dsh-purge/skill", "route:/dsh-purge/rules",
  "route:/redteam/api"]);
for (const a of atoms) {
  const op = a.op ?? "";
  if (op.startsWith("route:")) {
    if (!routePrefixes.has(op)) fail("④ op 反查", `原子 ${a.id}（${a.at}）引用的路由不在数据面清单：${op}`, "把该路由加进 meta.dataplane.routes");
    continue;
  }
  if (op.startsWith("artifact:")) continue;
  if (!dataOps.has(op) && !routeOpNames.has(op)) {
    fail("④ op 反查", `原子 ${a.id}（${a.at}）引用的 op 不在数据面清单：${op}`, "把该 op 加进 meta.dataplane.ops 或对应 routeOps");
  }
}
if (dataOps.size === 0) fail("④ op 反查", "meta.dataplane.ops 解析出 0 个 op", "数据面清单缺失");
notes.push(`④ 数据面 op ${dataOps.size} 个 / 路由级 op ${routeOpNames.size} 个 / 原子 ${atoms.length} 个`);

// ── 结果 ────────────────────────────────────────────────────────────────────
for (const n of notes) console.log(n);
if (verbose) {
  console.log("\n-- 座位节点 --");
  for (const s of slotNodes) console.log(`  ${s.status.padEnd(8)} ${s.slot}  (${s.at})`);
}
if (failures.length === 0) {
  console.log("\nOK：四条反向校验全过。");
  process.exit(0);
}
console.error(`\nFAIL：${failures.length} 项未过。`);
for (const f of failures) {
  console.error(`  [${f.check}] ${f.msg}`);
  if (f.hint) console.error(`      → ${f.hint}`);
}
process.exit(1);
