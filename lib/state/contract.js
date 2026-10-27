/**
 * lib/state/contract.js — 状态各块的字段声明与只读聚合，消费者只读它。
 *
 * 为什么需要它：同一份状态原先有三个消费者各算一遍 —— `/dsh-purge/status` 用
 * `display_* ?? patches_*` 拼计数、CLI 用 `patch_status[id] || "unknown"` 补缺、
 * 演练台把 `envAdaptStatus()` 原样透出。三处各写一份派生，改一处口径漂三处，
 * 而「漂了」没有症状：三处都自洽，只是说的不是同一件事。
 *
 * 边界（也是这份模块能当契约的原因）：
 *   · **纯聚合**：不读盘、不 import core、不 import redteam。输入一律由生产者交进来，
 *     本模块只做字段选择、计数与来源标注。
 *   · 声明即契约：每个字段写明类型、唯一生产者、派生方式（`content` 内容派生 /
 *     `trace` 痕迹派生）与副本数。改字段先改 `STATE_BLOCKS` —— 它是文档
 *     `docs/状态层契约.md` 的机器可读同一份事实。
 */

// 三层结论与分节行的实现留在各自模块：契约只声明「消费者该读哪一份」，
// 不复制它们的折算。`summarizeLayers` 走审计模块的对外出口，不在契约里再拆一条取能力的边。
import { summarizeLayers } from "../audit/index.js";
import { buildLayerRows } from "../layer-rows.js";
import { onMissKind } from "../patch/status.js";
import { summarizeCounts } from "../patch/counts.js";

/**
 * 一个字段的声明。
 *
 * `copies` 回答「同一条事实在仓库里有几份副本」：副本越多，改口径时要同步的地方越多。
 * 它不驱动运行，是给评审与下一批收编用的账 —— 副本数降不下来，就说明还有人在自算。
 *
 * @param {string} type 机器可读的类型描述
 * @param {string} producer 唯一生产者的仓库相对路径
 * @param {"content"|"trace"} derivation 内容派生 / 痕迹派生
 * @param {number} copies 副本数
 */
function field(type, producer, derivation, copies) {
  return Object.freeze({ type, producer, derivation, copies });
}

/**
 * 各块的字段声明。**同一声明处，两条响应**：
 *
 *   · `patch` / `audit` / `skills` / `env` / `preset` 由 `statusBlocks()` 合成，进 `/dsh-purge/status`；
 *   · `health` 是 `/dsh-purge/health` 的两组，由 `healthFieldReport()` 核形状。
 *
 * 键名仍是块名，字段名的 `组.字段` 只在 `health` 里出现 —— 它的响应本来就是两层的。
 */
export const STATE_BLOCKS = Object.freeze({
  patch: Object.freeze({
    source: field("content|marker|override", "lib/core.js", "content", 3),
    sources: field("Record<id, content|marker>", "lib/core.js", "content", 3),
    reasons: field("Record<id, string>", "lib/core.js", "trace", 3),
    status: field("Record<id, string>", "lib/core.js", "content", 3),
    counts: field("{raw:Counts, display:Counts}", "lib/patch/counts.js", "content", 3),
    layers: field("Record<prompt|code|tool|unmapped, object>", "lib/audit/layers.js", "content", 2),
    layerRows: field("Array<object>", "lib/layer-rows.js", "content", 1),
    rows: field("Array<object>", "lib/core.js", "content", 3),
    names: field("Record<id, string>", "lib/patch/table.js", "content", 3),
    pendingIds: field("string[]", "lib/core.js", "content", 3),
  }),
  audit: Object.freeze({
    dir: field("string", "lib/audit/index.js", "trace", 2),
    present: field("boolean", "lib/audit/index.js", "trace", 2),
    appliedRunId: field("string", "lib/reapply.js", "trace", 2),
    events: field("number", "lib/reapply.js", "trace", 2),
    layers: field("Record<string, string>", "lib/reapply.js", "trace", 2),
    unresolved: field("number[]", "lib/reapply.js", "trace", 2),
    recorded: field("boolean", "lib/reapply.js", "trace", 2),
  }),
  skills: Object.freeze({
    dir: field("string", "lib/skills.js", "content", 2),
    source: field("string", "lib/skills.js", "content", 2),
    items: field("Array<object>", "lib/skills.js", "content", 2),
    total: field("number", "lib/skills.js", "content", 2),
    fromPlugin: field("number", "lib/skills.js", "content", 2),
    invalid: field("number", "lib/skills.js", "content", 2),
    byLibrary: field("Record<official|redteam, number>", "lib/state/skills-catalog.js", "content", 1),
    shadowed: field("number", "lib/state/skills-catalog.js", "content", 1),
  }),
  env: Object.freeze({
    ready: field("boolean", "lib/redteam/platform-config.js", "content", 1),
    reason: field("string", "lib/redteam/platform-config.js", "content", 1),
    message: field("string", "lib/redteam/platform-config.js", "content", 1),
    kali: field("boolean", "lib/redteam/platform-config.js", "content", 1),
    skipped: field("boolean", "lib/redteam/platform-config.js", "content", 1),
    configured: field("boolean", "lib/redteam/platform-config.js", "content", 1),
    found: field("number", "lib/redteam/platform-config.js", "content", 1),
    missing: field("number", "lib/redteam/platform-config.js", "content", 1),
    total: field("number", "lib/redteam/platform-config.js", "content", 1),
  }),
  preset: Object.freeze({
    ok: field("boolean", "lib/redteam/index.js", "trace", 1),
    phase: field("string", "lib/redteam/index.js", "trace", 1),
    broken: field("string", "lib/redteam/index.js", "trace", 1),
    error: field("string", "lib/redteam/index.js", "trace", 1),
    at: field("string", "lib/redteam/index.js", "trace", 1),
  }),
  /*
   * health 块：`/dsh-purge/health` 的三组字段（设置页的「健康」与「日志」两块）。
   *
   * 为什么它在这里而不是另立一份表：状态层契约的定义是「一个状态一个声明处」。
   * 健康端点第一版把字段只写进用例（`test/settings-readonly-blocks.test.mjs` 的硬编码
   * 表），于是它成了第二个不受管的门 —— 加字段只要改测试就过，运行期没有任何东西会拒答。
   * 搬进来之后它和另外五块同一套形状：字段 / 类型 / 唯一生产者 / 派生 / 副本数。
   *
   * 它**不**由 `statusBlocks()` 合成：那是 `/dsh-purge/status` 的五块。`health` 是另一条
   * 响应，形状判据也另有一条（`healthFieldReport`），但比对逻辑与 `statusFieldReport`
   * 是同一份（`keyDiff`）——「同一份判据」指的是这件事，不是同一张表。
   *
   * `presetCopy.*` 与 status 的 `preset` 块不是一回事：那一块答「上一次注册走到哪一步」，
   * 这一组答「仓库那一份与盘上那一份的字节一不一样」。注册成功而副本漂移是可能的，
   * 两条响应各管一头，塞进同一块会让「谁说的是哪件事」重新变成猜。
   *
   * 组内字段写成 `组.字段`：判据按这个前缀把两层一起核（顶层键恰好是信封表，
   * 组内键恰好是这里声明的那些）。`logs` 的三个轨各自还有 path / present / generations，
   * 那些键不进这里的理由和第二层一致 —— 它们由同一个写侧函数产出，改动必然是整组的。
   */
  health: Object.freeze({
    "install.recorded": field("boolean", "lib/install-state.js", "trace", 1),
    "install.version": field("string", "lib/install-state.js", "trace", 1),
    "install.method": field("string", "lib/install-state.js", "trace", 1),
    "install.at": field("string", "lib/install-state.js", "trace", 1),
    "install.files": field("number", "lib/install-state.js", "trace", 1),
    "install.drifted": field("number", "lib/install-state.js", "content", 1),
    "install.missing": field("number", "lib/install-state.js", "content", 1),
    "install.added": field("number", "lib/install-state.js", "content", 1),
    "install.consistent": field("boolean", "lib/install-state.js", "content", 1),
    "presetCopy.present": field("boolean", "lib/redteam/index.js", "content", 1),
    "presetCopy.files": field("number", "lib/redteam/index.js", "content", 1),
    "presetCopy.drifted": field("number", "lib/redteam/index.js", "content", 1),
    "presetCopy.consistent": field("boolean", "lib/redteam/index.js", "content", 1),
    "logs.audit": field("Record<path|present>", "lib/audit/store.js", "content", 1),
    "logs.diag": field("Record<path|present|generations|maxBytes>", "lib/diag-log.js", "trace", 1),
    "logs.internal": field("Record<path|present|generations|maxBytes>", "lib/purge-log.js", "trace", 1),
  }),
});

/**
 * `/dsh-purge/status` 的顶层字段：三张表加起来就是响应形状的全部。
 *
 * 为什么需要它：契约声明的是**五块**（`patch` / `audit` / `skills` / `env` / `preset`），
 * 而这个端点把五块摊平进一个响应信封，另外还带着一批不在任何一块里的状态 ——
 * `shim_cmd` / `has_backup` / `dsh_home` 之类。那些字段既没声明、也没有任何表格收录过，
 * 于是「端点多返回一个字段」这件事没有症状：消费者照旧只读自己认识的，新字段没人认领。
 *
 * 三张表的分工：
 *   · `STATUS_BLOCK_FIELDS` —— 五块的镜像（值来自 `statusBlocks()` 的那一块）；
 *   · `STATUS_ENVELOPE_FIELDS` —— 响应信封（这次查询本身与更新通道的事实，不属任何一块）；
 *   · `STATUS_LEGACY_FIELDS` —— **契约外的状态**：今天确实在返回，但还不在契约里。
 *     每条都写明「下一轮收编」的理由 —— 不收编就要说得出口，不能只是没人管。
 *
 * 判据在 `test/state-contract.test.mjs`：把端点那个对象字面量的顶层键抽出来，必须
 * **恰好**等于这三张表；新增字段而不登记会红。运行期另有同一份判据（`statusFieldReport`），
 * 端点自己会拒答一个未登记的字段 —— 规则的落点是「不许进响应」，不只是「记得改文档」。
 */
export const STATUS_BLOCK_FIELDS = Object.freeze({
  patches_applied: "patch",
  patches_pending: "patch",
  patches_skipped: "patch",
  patches_failed: "patch",
  patches_ready: "patch",
  patches_na: "patch",
  patches_total: "patch",
  patch_status: "patch",
  patch_source: "patch",
  patch_sources: "patch",
  patch_reasons: "patch",
  layers: "patch",
  layerRows: "patch",
  patches: "patch",
  patch_names: "patch",
  audit: "audit",
  preset: "preset",
  env: "env",
  skills: "skills",
  skills_dir: "skills",
});

/** 响应信封：端点与更新通道自己给的事实，不属任何一块状态。 */
export const STATUS_ENVELOPE_FIELDS = Object.freeze({
  ok: "这次查询是否成功",
  ready: "web 树是否就绪（未就绪时端点只回 ok=false）",
  surface: "宿主面（当前只有 desktop）",
  ai_base: "宿主安装树入口",
  desktop_install: "桌面端安装目录",
  desktop_exe: "桌面端可执行文件",
  asar_still_sealed: "官方包是否仍密封",
  missing_ai_base: "宿主未定位时的说明",
  plugin_version: "本插件版本",
  update: "上一次更新尝试的结果",
  channel: "更新通道（stable / beta）",
  channelLabel: "通道的显示名",
  pin: "通道上钉住的版本或 ref",
});

/**
 * 契约外的状态：今天在响应里，但不在五块里。
 *
 * 「下一轮收编」不是拖延写法，是范围声明：收编它们要动 `lib/core.js` 的判据段与
 * `lib/shim/*` 的写回，那属于另一条轴；本轮只做「登记 + 拒答未登记字段」。
 * `docs/状态层契约.md` 的「契约外状态」一节逐项写了生产者、读者与为什么不收编。
 */
export const STATUS_LEGACY_FIELDS = Object.freeze({
  patches_lost: "下一轮收编：宿主重置后丢掉的补丁清单，属 patch 块的派生量",
  cliRepair: "下一轮收编：shim 待修标记，`lib/pending-status.js` 的现场判定",
  autoApplied: "下一轮收编：启动自动 apply 的记录，属 trace 派生",
  shim_cmd: "下一轮收编：shim 三个写回文件的内容判据（见契约外状态·shim）",
  shim_ps1: "下一轮收编：同上",
  shim_bin: "下一轮收编：同上",
  has_backup: "下一轮收编：`host-backups/` 是否存在（见契约外状态·host-backups）",
  override_status: "下一轮收编：`prompt-inject.md` 覆盖状态",
  override_path: "下一轮收编：同上，路径副本",
  dsh_home: "下一轮收编：`$DSH_HOME` 解析结果（见契约外状态·install-state）",
  boot_full_quit: "下一轮收编：启动时是否走「完全退出」路径的现场标记",
  hooks_deny_bypass: "下一轮收编：hooks-deny 的旁路设置，读的是设置不是状态",
  system_field_extracted: "下一轮收编：宿主系统字段是否已抽取（patch 判据的派生量）",
});

/** 三张表合起来的字段全集（顺序即响应里的顺序）。 */
export function statusDeclaredFields() {
  return [
    ...Object.keys(STATUS_BLOCK_FIELDS),
    ...Object.keys(STATUS_ENVELOPE_FIELDS),
    ...Object.keys(STATUS_LEGACY_FIELDS),
  ];
}

/**
 * `/redteam/api` 的**只读 op**：与状态层有重叠的那几个，字段从契约块取。
 *
 * 为什么这几条单列：它们回答的是同一个问题（环境就绪度、技能目录、版本），
 * 而 `/dsh-purge/status` 也在回。两份各算一次时，「同一个状态两个端点」会出现两个答案，
 * 而两边都自洽 —— 这类不一致没有症状。收编之后取值只有一次派生（块），op 只负责把它
 * 摊成自己的信封。
 *
 * `block` 指明字段来自哪一块；`envelope` 是这条 op 自己的非状态字段（`ok`、可用性摘要、
 * 配置面载荷……），逐条写明理由。判据是 `redteamOpReport`：顶层键必须落在
 * 「块字段 ∪ 信封字段」里，多一个就报。
 */
export const READONLY_OPS = Object.freeze({
  platformEnvAdaptStatus: Object.freeze({
    block: "env",
    envelope: { ok: "这次查询是否成功" },
  }),
  skillCatalog: Object.freeze({
    block: "skills",
    envelope: {
      ok: "这次查询是否成功",
      availability: "可用性自检摘要（工具路径 / 密钥 / 占位符），不是状态块字段",
      bySource: "按来源计数，面板分组用；来源是条目自己的属性",
      byDir: "按目录计数，面板分组用",
      libraries: "按库计数（与块的 byLibrary 同值，面板字段名不同）",
      note: "给人看的一句说明",
    },
  }),
  skillRead: Object.freeze({
    block: null,
    envelope: {
      ok: "这次查询是否成功",
      name: "技能名",
      description: "一句说明",
      whenToUse: "何时使用",
      provider: "来源提供方",
      source: "来源类型",
      path: "文件落点",
      content: "技能正文",
      library: "库归属",
    },
  }),
  platformConfigGet: Object.freeze({
    block: null,
    envelope: {
      ok: "这次查询是否成功",
      config: "平台配置原文（config.json）",
      runtime: "本机平台事实（windows / linux、分隔符）",
      toolkitDir: "工具集目录",
      toolkitExists: "工具集目录是否存在",
      nucleiTemplatesDir: "nuclei 模板目录",
      tools: "工具清单与三档计数",
      // 出网代理快照：`platformSummary` 一直在给这个字段，信封里却没有它 —— 于是这条
      // 只读 op 的每一次回包都被自己的契约门判成「未登记 [egress]」，而面板只能读到
      // 一句 ok:false。声明补上，回包才与生产者同形。
      egress: "出网代理快照（只读进程环境，改系统/终端代理后需重启宿主）",
      adapt: "环境就绪度 —— 这一段是契约 env 块（见 withEnvBlock）",
      hint: "给人看的一句说明",
    },
  }),
});

/**
 * 事实库读类 op 的信封：这些键由 store 原样给出，形状随域。
 *
 * 为什么不成块：`assets` / `stats` / `report` 之类返回的是领域数据（资产表、计分板、
 * 报告），不是「状态层」——给它们逐个字段立声明，等于把整个事实库 schema 搬进契约。
 * 这里只声明**信封键**（列表 / 计数 / 单对象 / 分页 / 说明），让「多返回了一个顶层字段」
 * 仍然可判。表里的每一个键都是从现场的只读 op 回包上取下来的，不是猜的：新增一个 op
 * 只要它复用这些信封键，就不用动这张表。
 */
export const REDTEAM_STORE_ENVELOPE = Object.freeze({
  ok: "这次查询是否成功",
  items: "列表载荷（顺序与形状由各自领域决定）",
  rows: "行载荷（与 items 二选一，按领域习惯）",
  total: "列表总数（分页用）",
  sort: "回显这次用的排序口径（面板要显示「按什么排的」）",
  stats: "领域计数摘要",
  summary: "领域汇总（计分板 / 图谱的顶层结论）",
  asset: "单个实体（按 id 取）",
  engagement: "靶标",
  current: "当前靶标指针（bootstrap）",
  root: "事实库数据根（bootstrap / 知识库）",
  roles: "角色提示词列表",
  segments: "网段",
  stages: "阶段",
  nodes: "图谱节点",
  edges: "图谱边",
  tests: "资产测试记录",
  queue: "待测队列",
  recent: "最近记录",
  testing: "正在测的条目",
  untested: "尚未测的条目",
  totals: "多域合计（会话页签）",
  tunnels: "隧道聚合",
  webshells: "WebShell 聚合",
  sections: "页签未读指针",
  groups: "分组视图（报告目标）",
  targets: "报告目标列表",
  days: "按天聚合（发现时间线）",
  span: "时间跨度",
  achieved: "已达到的得分项",
  missing: "未达成的得分项",
  ruleGroups: "按规则分组",
  markdown: "渲染好的报告正文",
  generated_at: "报告生成时刻",
  target: "目标标识（报告口径）",
  at: "这次查询的时刻",
  dir: "目录落点（知识库模板）",
  dbPath: "知识库文件落点",
  templates: "nuclei 模板统计",
  poc: "知识库单条",
  cards: "症候卡",
  note: "给人看的一句说明",
});

/**
 * 只读 op 的顶层键判据：落在「块字段 ∪ 该 op 的信封」里，或落在事实库信封里。
 *
 * @param {string} op op 名
 * @param {object} payload 回包
 * @returns {{op:string, undeclared:string[]}} 未登记的顶层键
 */
export function redteamOpReport(op, payload) {
  const name = String(op || "");
  const spec = READONLY_OPS[name];
  const raw = recordOf(payload);
  const allowed = new Set(Object.keys(REDTEAM_STORE_ENVELOPE));
  if (spec) {
    for (const key of Object.keys(spec.envelope)) allowed.add(key);
    if (spec.block && STATE_BLOCKS[spec.block]) {
      for (const key of Object.keys(STATE_BLOCKS[spec.block])) allowed.add(key);
    }
  }
  return {
    op: name,
    undeclared: Object.keys(raw).filter((key) => !allowed.has(key)),
  };
}

/**
 * 一次响应形状的判据：两份键表逐项比，两个方向都报。
 *
 * 多出来的（未登记）与少掉的（登记了却没返回）。只报一个方向的话，「声明表过时」与
 * 「响应被裁剪」两种毛病会各漏一半。状态端点与健康端点共用这一份 —— 「同一份判据」
 * 指的是这个函数，不是同一张表：两条响应的字段表各是各的。
 *
 * @param {string[]} declared 声明的字段
 * @param {string[]} actual 实际返回的字段
 * @returns {{undeclared:string[], missing:string[]}}
 */
function keyDiff(declared, actual) {
  const known = new Set(declared);
  const seen = new Set(Array.isArray(actual) ? actual.map((key) => String(key)) : []);
  return {
    undeclared: [...seen].filter((key) => !known.has(key)),
    missing: declared.filter((key) => !seen.has(key)),
  };
}

/**
 * 运行期的同一份判据：状态端点返回的顶层字段与三张表对不上的部分。
 *
 * @param {string[]} keys 实际返回的顶层字段
 * @returns {{undeclared:string[], missing:string[]}} 两侧的差额
 */
export function statusFieldReport(keys) {
  return keyDiff(statusDeclaredFields(), Array.isArray(keys) ? keys : []);
}

/**
 * `/dsh-purge/health` 的顶层字段。
 *
 * 与状态端点的信封表同一个角色：`ok` 是这次查询本身，`dsh_home` 是落点，
 * `install` / `logs` 是两块的两组。**组名在这里登记，组内字段在 `STATE_BLOCKS.health`** ——
 * 顶层一张表、组内一张表，加起来才是这条响应的全部形状。
 *
 * `dsh_home` 与状态端点那个同名：同一台机器同一份解析结果，两处各写一份就会漂。
 */
export const HEALTH_RESPONSE_FIELDS = Object.freeze({
  ok: "本次查询是否成功",
  dsh_home: "`$DSH_HOME` 的解析结果（与 status 的 dsh_home 同一份）",
  install: "安装指纹与现场对账（组，字段见 STATE_BLOCKS.health 的 install.*）",
  presetCopy: "仓库源与已装副本的逐文件比对（组，字段见 STATE_BLOCKS.health 的 presetCopy.*）",
  logs: "三条日志轨的落点与保留代数（组，字段见 STATE_BLOCKS.health 的 logs.*）",
});

/** 健康端点的顶层字段全集（顺序即响应里的顺序）。 */
export function healthDeclaredFields() {
  return Object.keys(HEALTH_RESPONSE_FIELDS);
}

/**
 * 健康响应的同一份判据：顶层键恰好是信封表，组内键恰好是 `STATE_BLOCKS.health` 声明过的那些。
 *
 * 为什么按载荷判而不是按顶层键判：这条响应是两层的。只核顶层的话，
 * `install` 里多一个字段照样过关 —— 而设置页读的正是组内字段，那才是「多返回了什么」
 * 真正会出事的地方。组内按 `<组>.<字段>` 的前缀把声明切开比对，两层的差额合成一张表，
 * 路径带上组名（`install.drifted`），拒答时说得出缺的是哪一个。
 *
 * 不做第三层：`logs.audit` 这类轨对象由各自的写侧函数整组产出，改一个键必然整组一起改；
 * 往下一层再拆，判据的维护成本会超过它拦得住的东西。
 *
 * @param {object} payload 健康端点的响应对象
 * @returns {{undeclared:string[], missing:string[]}} 两层的差额合成一张表
 */
export function healthFieldReport(payload) {
  const raw = recordOf(payload);
  const top = keyDiff(healthDeclaredFields(), Object.keys(raw));
  const undeclared = [...top.undeclared.map((key) => String(key))];
  const missing = [...top.missing.map((key) => String(key))];
  const groups = {};
  for (const key of Object.keys(STATE_BLOCKS.health)) {
    const at = key.indexOf(".");
    if (at < 0) continue;
    const group = key.slice(0, at);
    if (!groups[group]) groups[group] = [];
    groups[group].push(key.slice(at + 1));
  }
  for (const [group, declared] of Object.entries(groups)) {
    const actual = raw[group] && typeof raw[group] === "object" && !Array.isArray(raw[group])
      ? Object.keys(raw[group])
      : [];
    const diff = keyDiff(declared, actual);
    undeclared.push(...diff.undeclared.map((key) => `${group}.${key}`));
    missing.push(...diff.missing.map((key) => `${group}.${key}`));
  }
  return { undeclared, missing };
}

function textOf(value) {
  return typeof value === "string" ? value : "";
}function intOf(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function recordOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * patch 块。
 *
 * `source` 是块级的主判据，`sources` 是逐条来源 —— 两者都要，因为「主判据是内容」
 * 不代表每一条都走内容层：旧账本没有指纹时，个别补丁只能按痕迹判，读者要能从
 * `sources` 与 `reasons` 看出是哪一条、为什么。
 *
 * `counts` 是**两种口径的同一次聚合**：`raw` 按补丁号数（66），`display` 按展示行数（62，
 * 同一清洗的升级链并成一行、`na` 不出现）。两个分母都真实存在，见 `lib/patch/counts.js`；
 * 消费者必须说出自己用的是哪一个，不许只报数字。
 *
 * @param {object} state `core.gatherState()` 的返回
 * @param {Array<object>} patches 补丁表
 * @returns {{source:string, sources:Record<string,string>, reasons:Record<string,string>,
 *   status:Record<string,string>, counts:object, layers:object, layerRows:Array<object>,
 *   rows:Array<object>, names:Record<string,string>, pendingIds:string[]}}
 */
export function patchBlock(state = {}, patches = []) {
  const snapshot = state && typeof state === "object" ? state : {};
  const table = Array.isArray(patches) ? patches : [];
  const hasHost = Boolean(snapshot.ai_base);
  const rawStatus = recordOf(snapshot.patch_status);
  const rawSources = recordOf(snapshot.patch_sources);

  const status = {};
  const sources = {};
  for (const patch of table) {
    const id = String(patch && patch.id);
    if (!id) continue;
    const value = rawStatus[id];
    status[id] = typeof value === "string" && value !== "" ? value : (hasHost ? "unknown" : "na");
    sources[id] = rawSources[id] === "content" ? "content" : "marker";
  }

  const rows = (Array.isArray(snapshot.display_patches) ? snapshot.display_patches : []).map((row) => ({
    id: row && row.id,
    ids: Array.isArray(row && row.ids) ? row.ids : [row && row.id],
    layer: textOf(row && row.layer),
    status: textOf(row && row.status),
    title: textOf(row && row.title),
  }));

  // 两种口径一起算，见 lib/patch/counts.js：`raw` 是补丁号口径（判据与启动对齐用它），
  // `display` 是展示行口径（分节行用它）。同屏出现两个分母不是错，不标注才是错。
  const counts = summarizeCounts({
    status,
    patches: table,
    displayRows: rows,
    resolveOnMiss: onMissKind,
  });

  const names = {};
  for (const patch of table) {
    const id = String(patch && patch.id);
    if (id) names[id] = textOf(patch.name);
  }

  const values = Object.values(sources);
  return {
    source: !hasHost ? "override" : (values.includes("content") ? "content" : "marker"),
    sources,
    reasons: { ...recordOf(snapshot.patch_reasons) },
    status,
    counts,
    layers: summarizeLayers(table, rawStatus),
    layerRows: buildLayerRows({
      patches: rows.map((row) => ({
        id: row.id,
        layer: row.layer,
        status: row.status,
        title: row.title,
      })),
    }),
    rows,
    names,
    pendingIds: Object.keys(status).filter((id) => status[id] === "pending"),
  };
}

/**
 * audit 块：审计轨落点与最近一轮的摘要（`applied.json` 的 `audit` 子块）。
 *
 * 只做字段选择：`stamp` 由 `lib/reapply.js` 交进来，`dir` / `present` 由调用方解析。
 * 本模块不读盘 —— 一旦它开始读盘，状态查询就不再是只读的了。
 *
 * @param {{dir?:string, present?:boolean, stamp?:object}} [input]
 * @returns {{dir:string, present:boolean, appliedRunId:string, events:number,
 *   layers:Record<string,string>, unresolved:number[], recorded:boolean}}
 */
export function auditBlock(input = {}) {
  const raw = recordOf(input);
  const stamp = recordOf(raw.stamp);
  const audit = recordOf(stamp.audit);
  const recorded = Object.keys(audit).length > 0;
  return {
    dir: textOf(raw.dir),
    present: raw.present === true,
    appliedRunId: textOf(stamp.run_id),
    events: intOf(audit.events),
    layers: { ...recordOf(audit.layers) },
    unresolved: Array.isArray(audit.unresolved) ? audit.unresolved.map((id) => Number(id)) : [],
    recorded,
  };
}

/**
 * skills 块：技能目录的只读视图。
 *
 * `items` 原样保留：条目的形状由唯一枚举处（`lib/state/skills-catalog.js`）决定 ——
 * 显示名、一句说明、库归属、能不能编辑都在里面。块只负责声明总条数与三个可数派生，
 * 因为「这一屏该显示几条」只许有这一个答案。`fromPlugin` 只认显式为真的条目（随包同步
 * 副本），缺字段按「不是本包」算；`byLibrary` 数的是同一个 `items` 数组，不是另一次枚举；
 * `shadowed` 是「同名被优先级遮掉」的条数 —— 遮蔽不是重复，它得在界面上说得出口。
 *
 * @param {{dir?:string, source?:string, items?:Array<object>, shadowed?:Array<object>}} [input]
 * @returns {{dir:string, source:string, items:Array<object>, total:number,
 *   fromPlugin:number, invalid:number, byLibrary:Record<string,number>, shadowed:number}}
 */
export function skillsBlock(input = {}) {
  const raw = recordOf(input);
  const items = Array.isArray(raw.items) ? raw.items : [];
  const byLibrary = {};
  for (const item of items) {
    const library = textOf(item && item.library) || "unknown";
    byLibrary[library] = intOf(byLibrary[library]) + 1;
  }
  return {
    dir: textOf(raw.dir),
    source: textOf(raw.source),
    items,
    total: items.length,
    fromPlugin: items.filter((item) => item && item.fromPlugin === true).length,
    invalid: items.filter((item) => item && item.valid === false).length,
    byLibrary,
    shadowed: Array.isArray(raw.shadowed) ? raw.shadowed.length : 0,
  };
}

/**
 * env 块：演练台发送闸门读的环境状态。
 *
 * 只有声明过的九个字段出得去；生产者对象里的其它字段（工具明细、代理等）不转述 ——
 * 消费者要什么就往契约里加一条声明，别在这里「顺手全给」。
 *
 * @param {object|null} [input] `envAdaptStatus()` 的返回
 * @returns {{ready:boolean, reason:string, message:string, kali:boolean, skipped:boolean,
 *   configured:boolean, found:number, missing:number, total:number}}
 */
export function envBlock(input = null) {
  const raw = recordOf(input);
  return {
    ready: raw.ready === true,
    reason: textOf(raw.reason),
    message: textOf(raw.message),
    kali: raw.kali === true,
    skipped: raw.skipped === true,
    configured: raw.configured === true,
    found: intOf(raw.found),
    missing: intOf(raw.missing),
    total: intOf(raw.total),
  };
}

/**
 * preset 块：预设注册声明的只读视图（`$DSH_HOME/redteam/preset-declare.json`）。
 *
 * 这份声明是痕迹派生：它记的是「上一次注册尝试走到哪一步」，不是宿主注册表现场。
 * 读法要带着这一点看 —— `phase:"registered"` 说明上一次写声明时注册成功了。
 *
 * @param {object} [input] 声明文件解析出来的对象
 * @returns {{ok:boolean, phase:string, broken:string, error:string, at:string}}
 */
export function presetBlock(input = {}) {
  const raw = recordOf(input);
  return {
    ok: raw.ok === true,
    phase: textOf(raw.phase),
    broken: textOf(raw.broken),
    error: textOf(raw.error),
    at: textOf(raw.at),
  };
}

/**
 * 五块的同一次聚合。状态端点的唯一入口。
 *
 * @param {{state?:object, patches?:Array<object>, skills?:object, audit?:object,
 *   env?:object|null, preset?:object}} [input]
 * @returns {{patch:object, audit:object, skills:object, env:object, preset:object}}
 */
export function statusBlocks(input = {}) {
  const raw = recordOf(input);
  return {
    patch: patchBlock(raw.state || {}, raw.patches || []),
    audit: auditBlock(raw.audit || {}),
    skills: skillsBlock(raw.skills || {}),
    env: envBlock(raw.env || null),
    preset: presetBlock(raw.preset || {}),
  };
}
