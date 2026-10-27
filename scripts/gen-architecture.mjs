/**
 * scripts/gen-architecture.mjs — 已退役：只读考古，不再生成架构产物。
 * 曾生成 architecture/patches.yaml 与 architecture/ui-tree.yaml；两者已于 2026-10-26 冻结。
 *
 * @deprecated 2026-10-26 起退役：两份 yaml 已冻结，输入 `.tmp-repair/clean-host.json`
 *   含宿主绝对路径、不入库，干净 clone 无法重跑。保留本脚本只为考古，不要再运行它；
 *   产物变更见 architecture/README.md 与 docs/decisions/0015-architecture生成链冻结.md。
 *
 * 为什么用脚本而不是手写：
 *   两个文件合计要写 82 条补丁 + 8 域 / 36 能力 / 240+ 原子的七字段节点。
 *   手写必然与实测漂移（条目数、id 拼写、op 名）。脚本把「机械字段」与
 *   「设计判断」分开：机械字段全部来自 .tmp-rebuild/*.json（由 scripts/measure.mjs 产出）
 *   与 .tmp-repair/clean-host.json（由 npm run probe:clean-host 产出），设计判断集中在
 *   本文件的 NATIVE / DROP / CONDITIONAL / DOMAINS 四张表里。改判断只改表，不碰生成逻辑。
 *
 *   补丁归宿只认干净副本：装机树上的 marker 命中是历史痕迹，不是本仓库打出来的，
 *   所以这里不读 f7-probe。人工对 patches.yaml 的修正必须写回本文件，否则下一次重跑就白改。
 *
 * 历史用法（已退役，勿运行）：node scripts/measure.mjs && npm run probe:clean-host && node scripts/gen-architecture.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const measure = JSON.parse(readFileSync(join(root, ".tmp-rebuild/measure.json"), "utf8"));
const patches = JSON.parse(readFileSync(join(root, ".tmp-rebuild/patches.json"), "utf8"));
const clean = JSON.parse(readFileSync(join(root, ".tmp-repair/clean-host.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const cleanById = new Map(clean.rows.map((r) => [r.id, r]));
/**
 * 干净副本的上游落点，按 id 取第一个（同一 id 多候选时取扫描顺序首个，保证可复现）。
 * 路径一律归一成 host/ 前缀：产物要能入库，不许带盘符或用户目录。
 */
const cleanFileById = new Map();
for (const f of clean.perFileAll) {
  if (!cleanFileById.has(f.id)) cleanFileById.set(f.id, f.fp);
}
function hostRel(fp) {
  const s = String(fp).replace(/\\/g, "/");
  const m = s.match(/resources\/(?:app\.asar|app)\/(.+)$/);
  return `host/${m ? m[1] : s}`;
}
/** keep / drop 的证据统一由干净副本的三态与计数拼出，不写装机树结论。 */
function cleanEvidence(status, tally, file) {
  const seg = `clean-host: status=${status}, tally=${JSON.stringify(tally)}`;
  return file ? `${seg}, file=${file}` : seg;
}

// ── 归类表：只有这两张表是判断，其余是机械字段 ──────────────────────────────
/**
 * native：宿主已有等价原生能力。evidence 必须是本次实测读到的宿主源码行号。
 * 只收「我亲手读到过那一行」的条目 —— 读不到的按 keep 处理，不猜。
 */
const NATIVE = {
  4: {
    capability: "部署 persona 前缀",
    evidence: "dsh-system-prompt/lib/index.js:217-218 (Config.personaPrefix/personaSuffix)",
    why: "宿主把 persona 前后缀做成了 SystemPrompt 的配置字段，注册时直接落进 deployment:persona-prefix / deployment:persona-suffix 两个 section（:233-242）。改预设 YAML 里的 personaPrefix 字面量是绕路。",
  },
  43: {
    capability: "预设身份句剥离",
    evidence: "dsh-system-prompt/lib/index.js:217 (Config.personaPrefix) + :253 (section())",
    why: "同一机制：预设层的 prefix 是配置，不是要替换的字符串。把 prefix 置空等价于把该 section 的 text 置空。",
  },
  8: {
    capability: "审批策略默认值",
    evidence: "dsh-user-approval/lib/index.js:74 (Config.policy) + :152-154 (effectivePolicy)",
    why: "policy 是宿主 Config 字段，取值 ask|never。改 base preset 里的 policy 表达式，与把该字段配成 never 是同一件事。",
  },
  10: {
    capability: "审批配置默认 never",
    evidence: "dsh-user-approval/lib/index.js:74 (z.union([\"ask\",\"never\"]).default(\"ask\"))",
    why: "本条补丁替换的正是宿主这一行 schema 的 default。宿主已把 policy 暴露为配置，配 never 即可，不必改 schema。",
  },
  5: {
    capability: "审批提示句（NEVER_SENTENCE）",
    evidence: "dsh-user-approval/lib/index.js:39 (NEVER_SENTENCE) + :80-88 (systemPrompt.context) + dsh-system-prompt/lib/index.js:203/274-276 (同名遮蔽)",
    why: "宿主把这句话注册成名为 approval:policy 的 runtime context；system-prompt 的 ScopedLayers 允许同一 scope 内同名 context 遮蔽全局条目。插件在自己的 scope 注册同名 context 就能替换文案，不必改宿主常量。",
  },
  9: {
    capability: "审批自动放行",
    evidence: "dsh-user-approval/lib/index.js:176 (ctx.waterfall(..., \"approval/request\", ...))",
    why: "判定走 waterfall，插件注册 approval/request 钩子返回 allowed-once 即可放行。前提：policy 必须是 ask —— :175 在 waterfall 之前就把 never 短路成 rejected，这条顺序是设计约束。",
  },
};

/**
 * drop：目标在桌面端不参与，或结构已变。表里只写判断，证据由干净副本的三态生成：
 * missing_file = 目标 key 在 0.2.1-rc.2 上解析不到文件
 * skipped      = 文件在，但 marker 不在（干净副本没打过补丁，结构或版本已对不上）
 */
const DROP = {
  76: { reason: "preset-unrestricted 不存在" },
  30: { reason: "hooks-claude-code 候选路径全部不存在" },
  31: { reason: "hooks-codex 候选路径全部不存在" },
  64: { reason: "hooks 四个候选全部不存在" },
  65: { reason: "hooks 四个候选全部不存在" },
  32: { reason: "WEB_SURFACE 结构已变，marker 不命中" },
  53: { reason: "同上，web-app-lib 内已无该 prohibition 文本" },
  80: { reason: "minimal 预设结构已变" },
  77: { reason: "conversation-client 内 append 路径已变" },
  88: { reason: "agent-loop 内 hung prompt 结构已变" },
};

/**
 * conditional keep：干净副本上不判失败，但这是预期而不是缺陷 —— 触发条件没满足。
 * 这两条不许当普通 keep 处理，也不许因为 skipped / missing 就降级成 drop。
 *
 * 措辞不要写死 "skipped"：补丁 40 在补上 0.2.1-rc.2 形态的匹配正则之后，
 * 干净副本上的 probeStatus 已从 skipped 变成 applied（tally 里仍 missing:1，
 * 因为第二个目标由宿主首次运行才生成）。写死状态词的注释会立刻变成错账。
 */
const CONDITIONAL = {
  40: "干净副本上 applied 但 tally 里 missing:1：目标是 system-prompt 与 system-prompt-nested 两个 key，后者由宿主首次运行生成，解出的干净副本里还没有。命中条件：宿主已跑过一次。",
  46: "干净副本上 skipped（全零）：目标是 Electron 侧桌面壳，不经过 cordis 服务层，也不在 asar 解出的包集合里；该条 onMiss 本就是 ignore。命中条件：桌面壳文件存在时可写。",
};

/** 空洞名单的 reason：native 写内化到哪个服务，drop 写为什么不再适用。 */
const LEGACY_HOLES = {
  20: "历史空洞：早期版本移除",
  27: "历史空洞：早期版本移除",
  28: "历史空洞：主动移除（服务第三方插件 @linxin666/dsh-liangshen，本机未安装、恒 missing）",
  38: "历史空洞：主动移除（PERSONA_TEXT_PREFIX_ALIAS，兼容 0.1.2 persona 的 text 字段）",
  41: "历史空洞：早期版本移除",
  44: "历史空洞：早期版本移除",
  45: "历史空洞：主动移除（OFFICIAL_DESKTOP_UPDATE_HANDOFF，桌面更新交接）",
  71: "历史空洞：主动移除（同 28，第三方插件）",
  79: "历史空洞：早期版本移除",
  81: "历史空洞：早期版本移除",
};
const RETIRED_ALL = [20, 27, 28, 38, 41, 44, 45, 71, 79, 81, 4, 5, 8, 9, 10, 30, 31, 32, 43, 53, 64, 65, 76, 77, 80, 88].sort((a, b) => a - b);
const RETIRED_REASONS = {
  "4": "internalized → systemPrompt.section()：persona 前缀走后端 systemPrompt 的 section 渲染，不再改预设 YAML",
  "5": "internalized → approval.request waterfall：常驻授权句改由审批服务在请求前注入",
  "8": "internalized → approval.policy()：策略默认值由 user-approval 服务配置项承担",
  "9": "internalized → approval.request waterfall：自动放行分支改为在审批 waterfall 里放行",
  "10": "internalized → approval.policy()：默认策略 never 由服务配置项承担",
  "30": "dropped → hooks-claude-code 候选路径全部不存在（02 §7）",
  "31": "dropped → hooks-codex 候选路径全部不存在（02 §7）",
  "32": "dropped → WEB_SURFACE 结构已变，marker 不命中（02 §7）",
  "43": "internalized → systemPrompt.section()：预设身份句剥离改为把 section 文本置空",
  "53": "dropped → web-app-lib 内已无该 prohibition 文本（02 §7）",
  "64": "dropped → hooks 四个候选全部不存在（02 §7）",
  "65": "dropped → hooks 四个候选全部不存在（02 §7）",
  "76": "dropped → preset-unrestricted 不存在（02 §7）",
  "77": "dropped → conversation-client 内 append 路径已变（02 §7）",
  "80": "dropped → minimal 预设结构已变（02 §7）",
  "88": "dropped → agent-loop 内 hung prompt 结构已变（02 §7）"
};
const hostRange = "0.2.1-rc.2";
const yq = (s) => `"${String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

// ── patches.yaml ────────────────────────────────────────────────────────────
const rows = patches.rows.map((p) => {
  const cr = cleanById.get(p.id);
  const status = cr ? cr.status : "unknown";
  const tally = cr
    ? { applied: cr.applied, already: cr.already, missing: cr.missing, notFound: cr.notFound, absent: cr.absent }
    : {};
  const fp = cleanFileById.get(p.id);
  const firstFile = fp ? hostRel(fp) : "";
  let verdict;
  let evidence;
  let extra = {};
  if (NATIVE[p.id]) {
    verdict = "native";
    evidence = `${NATIVE[p.id].evidence}`;
    extra = {
      capability: NATIVE[p.id].capability,
      whyNative: NATIVE[p.id].why,
      needsApply: "no",
      needsRestart: "no",
      userVisibleCost: "none",
    };
  } else if (DROP[p.id]) {
    verdict = "drop";
    evidence = cleanEvidence(status, tally, firstFile);
    extra = { whyDrop: DROP[p.id].reason, needsApply: "no", needsRestart: "no", userVisibleCost: "none" };
  } else {
    verdict = "keep";
    evidence = cleanEvidence(status, tally, firstFile);
    extra = {
      whyKeep: keepReason(p, status),
      needsApply: "yes",
      needsRestart: "host-module-reload",
      userVisibleCost: userCost(p),
    };
  }
  return { p, status, firstFile, verdict, evidence, extra };
});

/**
 * keep 的三件事之一：宿主为何没有等价能力。
 * 按目标包分组给理由 —— 每组都指向「宿主暴露了什么、缺了什么」，
 * 而不是笼统写「宿主不支持」。
 */
function keepReason(p, status) {
  const keys = Array.isArray(p.file) ? p.file : [p.file];
  const k = keys.join("+");
  if (k.includes("user-approval")) return "宿主 approval 服务只暴露 policy 与 waterfall，放宽后的具体判定分支仍在包内，没有逐分支的配置入口";
  if (k.includes("agent-instructions")) return "宿主的 workspace instruction 渲染在包内私有函数里，systemPrompt.section 只能追加 section，不能替换包内 intro 常量";
  if (k.includes("agent-loop")) return "agent-loop 的装配与中断点没有对外钩子；systemPrompt 的 waterfall 只覆盖 assemble 阶段";
  if (k.includes("base") || k.includes("preset-")) return "预设 YAML 是宿主随包发布的数据文件，cordis.patch.yml 只能叠加，不能改写已发布的预设内容";
  if (k.includes("sandbox") || k.includes("permission-presets")) return "sandbox 策略字符串由包内模板拼装，沙箱模式本身是配置，但模式内的 allow/deny 规则没有逐条配置入口";
  if (k.includes("tool-") || k.includes("dsh-tools")) return "工具描述与参数 schema 在工具包内声明，宿主没有「覆盖已注册工具描述」的服务";
  if (k.includes("pi-ai") || k.includes("llm-")) return "协议适配层（messages/system role 的落点）在 pi-ai 与 llm 包内，没有对外改写钩子";
  if (k.includes("session") || k.includes("conversation") || k.includes("rewind")) return "会话日志事件由 session 包直接 append，conversation 的渲染分支没有对外替换点";
  if (k.includes("desktop-shell") || k.includes("app-boot")) return "桌面壳与启动流程是 Electron 侧代码，不经过 cordis 服务层";
  if (k.includes("hooks")) return "hooks 插件的判定在包内，且桌面端目标路径已变（见同组 drop 条目）";
  if (k.includes("web-app")) return "web-app 的补丁文件已随版本改结构（见同组 drop 条目）";
  return `目标 ${k} 上仍能命中 marker（干净副本实测 ${status}），宿主没有对应的公开服务或配置字段`;
}

/** keep 的三件事之三：用户可见成本。按 onMiss 与是否需要重启分开写。 */
function userCost(p) {
  if (p.onMiss === "ignore") return "安装后自动写入，失败不阻断；用户看不到成功提示，只在补丁表看到状态行";
  if (p.onMiss === "warn") return "安装后自动写入，未命中只在补丁表标黄，不阻断其它条目";
  return "安装后自动写入；未命中会让本次 apply 判失败并在补丁表标红，用户需要看那一行才能知道哪个宿主文件对不上";
}

const patchesYaml = [];
patchesYaml.push("# dsh-purge 补丁归宿表");
patchesYaml.push("#");
patchesYaml.push("# 生成：node scripts/gen-architecture.mjs（判断来自 NATIVE / DROP / CONDITIONAL 三张表，机械字段来自 clean-host.json）");
patchesYaml.push("# 归宿依据：干净副本（从 app.asar 解出、未被任何一次 apply 改动），.tmp-repair/clean-host.json");
patchesYaml.push(`# 干净宿主分布（66 条）：applied=${clean.cleanHostDistribution.applied} already=${clean.cleanHostDistribution.already} missing_file=${clean.cleanHostDistribution.missing_file ?? 0} skipped=${clean.cleanHostDistribution.skipped}`);
patchesYaml.push(`# 本机装机树（installed-rev=apply:1.0.0）只反映历史痕迹，与本仓库 ${pkg.version} 不是同一个东西，不作依据`);
patchesYaml.push("#");
patchesYaml.push("# 归宿定义：native=宿主已有等价能力；keep=仍然必要（marker 命中且文件参与加载）；drop=不适用");
patchesYaml.push("# 空洞名单永不复用 id：26 个（10 个历史空洞 + 6 条 native 内化 + 10 条 drop 删除）");
patchesYaml.push("");
patchesYaml.push("schema: 1");
patchesYaml.push(`hostRange: ${yq(hostRange)}`);
patchesYaml.push("retired: [" + RETIRED_ALL.join(", ") + "]");
patchesYaml.push("retiredHoles:");
for (const id of RETIRED_ALL) {
  patchesYaml.push(`  - id: ${id}`);
  patchesYaml.push(`    reason: ${yq(RETIRED_REASONS[id] || (LEGACY_HOLES[id] || "历史空洞：见 02 §7"))}`);
}
patchesYaml.push("totals:");
patchesYaml.push(`  total: ${rows.length}`);
patchesYaml.push(`  native: ${rows.filter((r) => r.verdict === "native").length}`);
patchesYaml.push(`  keep: ${rows.filter((r) => r.verdict === "keep").length}`);
patchesYaml.push(`  drop: ${rows.filter((r) => r.verdict === "drop").length}`);
patchesYaml.push("patches:");
for (const r of rows) {
  const p = r.p;
  patchesYaml.push(`  - id: ${p.id}`);
  patchesYaml.push(`    name: ${yq(p.name)}`);
  patchesYaml.push(`    layer: ${yq(p.layer)}`);
  patchesYaml.push(`    verdict: ${r.verdict}`);
  if (CONDITIONAL[p.id]) {
    patchesYaml.push("    conditional: true");
    patchesYaml.push(`    conditionalWhy: ${yq(CONDITIONAL[p.id])}`);
  }
  patchesYaml.push(`    hostRange: ${yq(hostRange)}`);
  patchesYaml.push(`    file: ${Array.isArray(p.file) ? "[" + p.file.map((f) => yq(f)).join(", ") + "]" : yq(p.file)}`);
  patchesYaml.push(`    onMiss: ${yq(p.onMiss)}`);
  patchesYaml.push(`    surfaces: ${p.surfaces ? "[" + p.surfaces.map((s) => yq(s)).join(", ") + "]" : yq("缺省:全宿主")}`);
  patchesYaml.push(`    strictFiles: ${p.strictFiles ? "true" : "false"}`);
  patchesYaml.push(`    marker: ${yq(p.firstMarker)}`);
  patchesYaml.push(`    markerCount: ${p.markerCount}`);
  patchesYaml.push(`    probeStatus: ${yq(r.status)}`);
  if (p.displayGroup) patchesYaml.push(`    displayGroup: ${yq(p.displayGroup)}`);
  patchesYaml.push(`    evidence: ${yq(r.evidence)}`);
  for (const [k, v] of Object.entries(r.extra)) patchesYaml.push(`    ${k}: ${yq(v)}`);
}
writeFileSync(join(root, "architecture/patches.yaml"), patchesYaml.join("\n") + "\n", "utf8");

// ── ui-tree.yaml ───────────────────────────────────────────────────────────
/**
 * 域 → 能力 → 原子op 的归属表。
 *
 * 原子不按 op 一条，而是按「op 的一个字段」切 —— 这是判据 5.1（单一数据来源）
 * 与 5.3（可独立验收）的直接结果：一个 op 的 ok / data / error 是三种数据来源，
 * 各自的失败模式也不同（超时 / 空数据 / 未授权），所以拆三个原子。
 */
const DOMAINS = [
  {
    id: "d1-cleanse", title: "清洗执行", goal: "把补丁打到宿主上，看到真实结果，能回滚",
    seats: ["settings.section"],
    capabilities: [
      { id: "c1-1-status", title: "补丁全景", source: "route", route: "/dsh-purge/status", fields: ["patch_status", "patches", "patch_names"] },
      { id: "c1-2-apply", title: "应用补丁", source: "route", route: "/dsh-purge/apply", fields: ["complete", "report", "failed_items", "restart_after_apply"] },
      { id: "c1-3-revert", title: "回滚", source: "route", route: "/dsh-purge/revert", fields: ["reverted", "errors", "shim"] },
      { id: "c1-4-verdict", title: "补丁归宿", source: "artifact", artifact: "architecture/patches.yaml", fields: ["verdict", "keep_needsApply", "keep_userVisibleCost"] },
    ],
  },
  {
    id: "d2-prompt", title: "提示词与规则", goal: "控制模型这一轮实际读到的指令内容",
    seats: ["settings.section"],
    capabilities: [
      { id: "c2-1-override", title: "注入内容", source: "route", route: "/dsh-purge/override", fields: ["content", "customized", "usingDefault", "system_field_extracted"] },
      { id: "c2-2-rules", title: "规则库", source: "op", route: "/dsh-purge/rules", ops: ["status", "read", "save", "activate", "delete", "reset"] },
      { id: "c2-3-workspace", title: "工作区指令候选", source: "op", route: "/dsh-purge/rules", ops: ["scan", "toggle-cwd", "set-policy"] },
      { id: "c2-4-skills", title: "技能库", source: "op", route: "/dsh-purge/skills", ops: ["status", "read", "save", "delete", "import"] },
    ],
  },
  {
    id: "d3-rewind", title: "会话回溯", goal: "回到某一轮之前，重来一次而不丢上下文",
    seats: ["main"],
    capabilities: [
      { id: "c3-1-options", title: "可回退点分析", source: "route", route: "/dsh-purge/rewind/options", fields: ["ok", "rounds", "candidates"] },
      { id: "c3-2-rewind", title: "执行回退", source: "route", route: "/dsh-purge/rewind", fields: ["ok", "sessionId", "mode"] },
      { id: "c3-3-draft", title: "草稿与待决", source: "route", route: "/dsh-purge/rewind", fields: ["draft", "pending"] },
      { id: "c3-4-lastuser", title: "上一条用户输入", source: "route", route: "/dsh-purge/last-user", fields: ["text"] },
    ],
  },
  {
    id: "d4-ops", title: "插件运维", goal: "知道插件现在是活的还是半死的，并能升级/卸载",
    seats: ["settings.section"],
    capabilities: [
      { id: "c4-1-layers", title: "三层状态", source: "route", route: "/dsh-purge/status", fields: ["surface", "ai_base", "asar_still_sealed", "desktop_install"] },
      { id: "c4-2-update", title: "版本与更新", source: "op", route: "/dsh-purge/update", ops: ["check", "channel", "switch", "rollback", "auto"] },
      { id: "c4-3-uninstall", title: "卸载", source: "route", route: "/dsh-purge/uninstall", fields: ["ok", "cleanup", "surface"] },
      { id: "c4-4-restart", title: "重启", source: "route", route: "/dsh-purge/restart", fields: ["restarting", "needsFullQuit", "pending", "error"] },
    ],
  },
  {
    id: "d5-engagement", title: "演练靶标", goal: "选定这一轮作业的对象与边界",
    seats: ["main"],
    capabilities: [
      { id: "c5-1-bootstrap", title: "靶标列表", source: "op", route: "/redteam/api", ops: ["bootstrap"] },
      { id: "c5-2-open", title: "创建靶标", source: "op", route: "/redteam/api", ops: ["openEngagement"] },
      { id: "c5-3-activate", title: "激活靶标", source: "op", route: "/redteam/api", ops: ["activateEngagement"] },
      { id: "c5-4-grant", title: "授权与并发", source: "route", route: "/dsh-purge/drill-grant", ops: ["agentsStatus", "setAgentsMax"], fields: ["granted", "max", "used", "free"] },
    ],
  },
  {
    id: "d6-assets", title: "演练资产", goal: "把打到的对象、漏洞、凭证、通道记成可查询的结构",
    seats: ["main"],
    capabilities: [
      { id: "c6-1-recon", title: "资产测绘", source: "op", route: "/redteam/api", ops: ["snapshot", "stats", "assets", "asset", "assetTest", "assessAsset", "graph", "attackGraph", "discoveryTimeline", "domains"] },
      { id: "c6-2-vulns", title: "漏洞", source: "op", route: "/redteam/api", ops: ["vulns", "addVuln", "updateVuln", "vulnStats"] },
      { id: "c6-3-creds", title: "凭证与访问", source: "op", route: "/redteam/api", ops: ["credentials", "addCredential", "access", "addAccess"] },
      { id: "c6-4-channels", title: "会话与通道", source: "op", route: "/redteam/api", ops: ["sessions", "webshells", "addWebshell", "updateWebshell", "tunnels", "addTunnel", "updateTunnel", "web", "httpEvidence", "addHttpEvidence"] },
    ],
  },
  {
    id: "d7-evidence", title: "演练取证与计分", goal: "把过程变成能复盘的证据与分数",
    seats: ["main"],
    capabilities: [
      { id: "c7-1-shots", title: "截图", source: "op", route: "/redteam/api", ops: ["shots", "shotAdd", "shotDelete", "shotData"] },
      { id: "c7-2-report", title: "链与报告", source: "op", route: "/redteam/api", ops: ["chain", "addChainStep", "report", "reportTargets"] },
      { id: "c7-3-score", title: "计分", source: "op", route: "/redteam/api", ops: ["scores", "saveScorePoint", "deleteScorePoint", "addScoreHit", "scoreChain", "scoreReport", "testStats", "activeTests", "consoleDigest", "stages", "saveStage"] },
      { id: "c7-4-files", title: "攻击文件", source: "op", route: "/redteam/api", ops: ["attackFiles", "addAttackFile", "readAttackFile", "import"] },
    ],
  },
  {
    id: "d8-knowledge", title: "演练知识库", goal: "复用现成的 POC、模板、技能与平台配置",
    seats: ["settings.section", "main"],
    capabilities: [
      { id: "c8-1-poc", title: "POC 库", source: "op", route: "/redteam/api", ops: ["pocSearch", "pocList", "pocGet", "pocSave", "pocUpdate", "pocDelete", "pocUse", "pocStats"] },
      { id: "c8-2-templates", title: "模板库", source: "op", route: "/redteam/api", ops: ["templateSearch", "templateStats"] },
      { id: "c8-3-skills", title: "红队技能", source: "op", route: "/redteam/api", ops: ["skillCatalog", "skillRead"] },
      { id: "c8-4-platform", title: "平台适配", source: "op", route: "/redteam/api", ops: ["platformConfigGet", "platformConfigSave", "platformAssignToolkit", "platformEnvAdaptStatus", "platformEnvAdaptSkip"] },
      { id: "c8-5-probe", title: "会话探测", source: "op", route: "/redteam/api", ops: ["probeSessions"] },
      { id: "c8-6-prompts", title: "角色提示词", source: "op", route: "/redteam/api", ops: ["prompts", "savePrompt", "resetPrompts"] },
      { id: "c8-7-version", title: "演练台版本", source: "op", route: "/redteam/api", ops: ["version", "updateCheck", "updateApply"] },
    ],
  },
];

/** 每个 op 拆三个字段原子：ok / data / error。字段名按 op 语义给，不虚构。 */
const FIELD_ATOMS = {
  ok: { field: "ok", failure: "未授权", assert: "POST 后 body.ok === true" },
  data: { field: "items|payload", failure: "空数据", assert: "POST 后 Array.isArray(body.items) || body.payload !== undefined" },
  error: { field: "error", failure: "未命中", assert: "非法入参后 body.ok === false && typeof body.error === 'string'" },
};

const usedOps = new Set();
/**
 * 路由级 op：挂在 prefix 路由上的 op 不属于 /redteam/api 那 80 个，
 * 但同样是数据面的一部分（4.1 要求两层都列）。名称与聚合路由的 op 可能同名，
 * 反查时按「名在任一集合里」判定，但两份清单分开列，避免把 rules 的 activate
 * 当成 redteam 的 activateEngagement。
 */
const ROUTE_OPS = {
  "/dsh-purge/rules": ["status", "scan", "scan-cwd", "toggle-cwd", "set-policy", "workspace-policy", "read", "save", "activate", "delete", "reset"],
  "/dsh-purge/skills": ["status", "read", "save", "delete", "import"],
  "/dsh-purge/skill": ["status", "read", "save", "delete", "import"],
  "/dsh-purge/update": ["check", "status", "versions", "channel", "switch", "rollback", "auto"],
};
const tree = [];
tree.push("# dsh-purge 客户侧架构树");
tree.push("#");
tree.push("# 生成：node scripts/gen-architecture.mjs；反查门禁：node scripts/check-ui-tree.mjs");
tree.push(`# 数据面：${measure.http.exactCount} 条 exact + ${measure.http.prefixCount} 条 prefix + 1 条聚合路由（/redteam/api，${measure.ops.count} 个 op）`);
tree.push("#");
tree.push("# 每节点字段：id / parent / seat / data(op+field) / formRef / assert");
tree.push("# status: live | dropped（dropped 必须写 reason）");
tree.push("");
tree.push("schema: 1");
tree.push("meta:");
/**
 * 时间戳取度量快照的时刻，不取墙钟：取墙钟会让每次重跑都产生一行差异，
 * 产物就无法用 diff 判断「人工修正有没有写回生成器」。
 */
tree.push(`  generatedAt: ${yq(measure.generatedAt)}`);
tree.push(`  hostRange: ${yq(hostRange)}`);
tree.push("  dataplane:");
tree.push("    routes:");
for (const r of measure.http.exact) tree.push(`      - { kind: exact, path: ${yq(r.path)}, at: ${yq("lib/index.js:" + r.line)} }`);
for (const r of measure.http.prefix) tree.push(`      - { kind: prefix, path: ${yq(r.path)}, at: ${yq("lib/index.js:" + r.line)} }`);
tree.push(`      - { kind: exact, path: ${yq("/redteam/api")}, at: ${yq("lib/redteam/ui.js:1132")} }`);
tree.push("    ops:");
for (const op of measure.ops.ops) tree.push(`      - ${yq(op)}`);
tree.push("    routeOps:");
for (const [route, ops] of Object.entries(ROUTE_OPS)) {
  tree.push(`      - route: ${yq(route)}`);
  tree.push(`        ops: [${ops.map((o) => yq(o)).join(", ")}]`);
}
tree.push("  seats:");
tree.push(`    - { name: ${yq("settings.section")}, kind: list, evidence: ${yq("dsh-client-ui-settings-plugins/lib/client.js:201-212")} }`);
tree.push(`    - { name: ${yq("settings.plugins.tab")}, kind: list, evidence: ${yq("dsh-client-ui-settings-plugins/lib/client.js:208-211")} }`);
tree.push(`    - { name: ${yq("main")}, kind: keyed, evidence: ${yq("dsh-client-ui-plugin-manager/lib/client.js:4411-4461")} }`);
tree.push(`    - { name: ${yq("sidebar.panellist")}, kind: list, evidence: ${yq("dsh-client-ui-plugin-manager/lib/client.js:4477-4483")} }`);
tree.push(`    - { name: ${yq("plugins.item")}, kind: list, evidence: ${yq("dsh-client-ui-settings-shell/lib/client.js:182-189")} }`);
tree.push(`    - { name: ${yq("shell.overlay")}, kind: list, evidence: ${yq("dsh-client-ui-plugin-manager/lib/client.js:4402-4410")} }`);
tree.push("  formBaselines:");
tree.push(`    - { page: ${yq("设置页")}, pkg: ${yq("dsh-client-ui-settings-shell")}, at: ${yq("lib/client.js:66-110")}, marks: ${yq("SettingsForm + SettingsValueField；view=summary|form 双形态")} }`);
tree.push(`    - { page: ${yq("设置容器")}, pkg: ${yq("dsh-client-ui-settings-plugins")}, at: ${yq("lib/client.js:37-52,201-212")}, marks: ${yq("section + tabs + renderSlot")} }`);
tree.push(`    - { page: ${yq("管理列表")}, pkg: ${yq("dsh-client-ui-plugin-manager")}, at: ${yq("lib/client.js:4411-4461")}, marks: ${yq("main 座位 + children 子槽声明 + 导航 store")} }`);
/**
 * 座位注册节点：源码里每一处 slots.register / slots.inject 都要在树里有对应节点。
 * status=live 表示新设计继续用它；dropped 表示这次重构把它删掉，必须写理由。
 */
tree.push("  slotRegistrations:");
const SLOT_NODES = [
  { slot: "shell.overlay", id: "dsh-purge-dock", at: "lib/client-src/shell.js:191-195（已删，原 dock 注册）", status: "dropped", reason: "浮层容器。新设计把清洗放进 settings.section、把演练台放进 main+sidebar.panellist，浮层的三类合法用途都不成立（见 02 文档 6.3）；这一轮的删浮层已把它从源码移除" },
  { slot: "shell.overlay", id: "dsh-purge-welcome", at: "lib/client-src/shell.js:195-198", status: "live", reason: "浮层删掉之后仍留在 shell.overlay 的两件事：一次性用户须知（首次安装必须盖住整页）与环境适配门（要在任意页面拦下红队模式发送，放进某一个页面就只在那个页面生效）" },
  { slot: "shell.overlay", id: "redteam-console", at: "lib/redteam/client.js:4227-4230", status: "dropped", reason: "同上一行的容器，且该注册块在 build 期整段剥离（产物中 sidebar.footer.action 与 conversation.session.header.utilities 命中 0 次），源与产物本就不一致" },
  { slot: "sidebar.footer.action", id: "(演练台侧栏按钮)", at: "lib/redteam/client.js:4231-4238", status: "dropped", reason: "构件期剥离：build-client.mjs 把 apply(ctx) 换成 applyDrillParts()，该注册不进产物（实测产物命中 0 次）" },
  { slot: "conversation.session.header.utilities", id: "(演练台会话头按钮)", at: "lib/redteam/client.js:4239-4244", status: "dropped", reason: "同上，构建期剥离，产物命中 0 次" },
  { slot: "conversation.input.right", id: "(回溯输入框按钮)", at: "lib/client-src/rewind/install.js:12-20", status: "live", reason: "回溯入口与输入框强绑定（要拿到当前会话的 draft 与最后一条用户输入），换座位会让 c3-3 的数据来源断开" },
  { slot: "conversation.input.right", id: "(回溯输入框按钮·第二挂载)", at: "lib/client-src/rewind/install.js:21-29", status: "dropped", reason: "该注册块在源里已被注释（install.js:21-29 整体注释），从未生效，属死代码" },
  { slot: "settings.section", id: "dsh-purge", at: "lib/client-src/shell.js:210-218", status: "live", reason: "清洗页的新座位：设置页一个 section，与宿主设置页插件同构（先 inject 再 register，内容组件走第二实参）。浮层删掉之后它就是清洗的唯一入口" },
  { slot: "main", id: "dsh-purge-drill", at: "lib/client-src/shell.js:220-222", status: "live", reason: "演练台的新座位：主区一整页，用 generator 注入形态占位。它替掉的是浮层里的第二个页签与「全面浏览」那个第二窗口" },
  { slot: "sidebar.panellist", id: "dsh-purge-drill", at: "lib/client-src/shell.js:223-223", status: "live", reason: "演练台的侧栏常驻入口：id 与 main 的 key 对齐，点图标切到主区那一页。它替掉的是 hero chip 与页签栏两个 DOM 挂件" },
];
for (const s of SLOT_NODES) {
  tree.push(`    - slot: ${yq(s.slot)}`);
  tree.push(`      id: ${yq(s.id)}`);
  tree.push(`      at: ${yq(s.at)}`);
  tree.push(`      status: ${s.status}`);
  tree.push(`      reason: ${yq(s.reason)}`);
}
tree.push("domains:");
for (const d of DOMAINS) {
  tree.push(`  - id: ${yq(d.id)}`);
  tree.push(`    title: ${yq(d.title)}`);
  tree.push(`    goal: ${yq(d.goal)}`);
  tree.push(`    seats: [${d.seats.map((s) => yq(s)).join(", ")}]`);
  tree.push("    capabilities:");
  for (const c of d.capabilities) {
    tree.push(`      - id: ${yq(c.id)}`);
    tree.push(`        title: ${yq(c.title)}`);
    tree.push(`        parent: ${yq(d.id)}`);
    tree.push(`        seat: ${yq(d.seats[0])}`);
    tree.push(`        source: ${yq(c.source === "op" ? `op:${c.route}` : c.source === "route" ? `route:${c.route}` : c.artifact)}`);
    tree.push(`        formRef: ${yq(c.source === "op" ? "dsh-client-ui-plugin-manager/lib/client.js:4411-4461" : "dsh-client-ui-settings-shell/lib/client.js:66-110")}`);
    tree.push("        atoms:");
    if (c.ops) {
      for (const op of c.ops) {
        usedOps.add(op);
        for (const kind of ["ok", "data", "error"]) {
          const fa = FIELD_ATOMS[kind];
          tree.push(`          - id: ${yq(`${c.id}-${op}-${kind}`)}`);
          tree.push(`            op: ${yq(op)}`);
          tree.push(`            field: ${yq(fa.field)}`);
          tree.push(`            failure: ${yq(fa.failure)}`);
          tree.push(`            assert: ${yq(`POST /redteam/api {"op":"${op}"} → ${fa.assert}`)}`);
          tree.push(`            status: live`);
        }
      }
    } else if (c.route && c.fields) {
      for (const f of c.fields) {
        tree.push(`          - id: ${yq(`${c.id}-${f}`)}`);
        tree.push(`            op: ${yq(`route:${c.route}`)}`);
        tree.push(`            field: ${yq(f)}`);
        tree.push(`            failure: ${yq("超时")}`);
        tree.push(`            assert: ${yq(`GET/POST ${c.route} → body.${f} !== undefined`)}`);
        tree.push(`            status: live`);
      }
    } else if (c.artifact) {
      for (const f of c.fields) {
        tree.push(`          - id: ${yq(`${c.id}-${f}`)}`);
        tree.push(`            op: ${yq(`artifact:${c.artifact}`)}`);
        tree.push(`            field: ${yq(f)}`);
        tree.push(`            failure: ${yq("未命中")}`);
        tree.push(`            assert: ${yq(`node -e "require('fs').existsSync('${c.artifact}')" → true 且每条有 ${f} 字段`)}`);
        tree.push(`            status: live`);
      }
    }
  }
}
const missingOps = measure.ops.ops.filter((o) => !usedOps.has(o));
tree.push("unmappedOps:");
for (const op of missingOps) tree.push(`  - ${yq(op)}`);
writeFileSync(join(root, "architecture/ui-tree.yaml"), tree.join("\n") + "\n", "utf8");

const atomTotal = DOMAINS.reduce((n, d) => n + d.capabilities.reduce((m, c) => m + (c.ops ? c.ops.length * 3 : c.fields.length), 0), 0);
console.log(JSON.stringify({
  patches: { total: rows.length, native: rows.filter((r) => r.verdict === "native").length, keep: rows.filter((r) => r.verdict === "keep").length, drop: rows.filter((r) => r.verdict === "drop").length },
  domains: DOMAINS.length,
  capabilities: DOMAINS.reduce((n, d) => n + d.capabilities.length, 0),
  atoms: atomTotal,
  routeOpsTotal: Object.values(ROUTE_OPS).reduce((n, v) => n + v.length, 0),
  unmappedOps: missingOps,
}, null, 2));
