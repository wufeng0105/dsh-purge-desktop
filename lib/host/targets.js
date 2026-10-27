/**
 * lib/host/targets.js — 补丁目标文件的 SPEC 数据与查表器，加补丁只加一条。
 * 补丁目标文件表：`targetFiles` 的 61 个 key 外置成 SPEC 数据 + 查表执行器。
 *
 * ## 为什么要外置
 *
 * 收敛前是 237 行手写的 `"key": firstExisting([...])`。加一个补丁要同时改
 * 两处（补丁表的 `file` 字段 + 这里的候选路径），两处一定漂移；而且「哪些
 * 候选路径属于哪个 key」这件事只在代码里，无法一眼对照。
 *
 * 现在：数据（SPEC）+ 一个执行器（targetFiles）。加 key 只加一条记录。
 *
 * ## SPEC 记录的字段
 *
 *   key       targetFiles() 返回对象里的键（补丁表的 `file` 字段引用它）
 *   pkg       aiBase 下的包名（`dsh-agent-instructions`）
 *   rels      包内相对路径数组；每条按「直连 → 嵌套副本」展开（nested 为真时）
 *   nested    是否也查 npm 嵌套副本 `aiBase/dsh/node_modules/@deepseek-ai/<pkg>/<rel>`
 *   rootPkg   monorepo 源码布局下的包目录段（`["context","agent-instructions"]`），
 *             拼成 `<packageRoot>/packages/<...>/<rel>`
 *   rootRels  走 root 布局的相对路径；缺省等于 rels
 *   mode      `first`（首个命中，返回字符串）| `all`（全部命中，返回数组）
 *
 * 不规则条目走 `build` 钩子（桌面壳 / 预设 / pi-ai / nested 组），它们的候选
 * 来源不在「包 + 相对路径」这个模型里。
 *
 * ## 顺序是被观测行为的一部分
 *
 * `first` 模式取首个命中，`all` 模式返回数组 —— 两者的结果都随候选顺序变化，
 * 而候选顺序又决定 backupAll / revertAll 的落盘顺序。所以 SPEC 里每条记录的
 * `rels` / `rootRels` 排列都与外置成数据表之前的手写版逐条对应，改动前先想清楚。
 *
 * ## 依赖方向
 *
 * 只依赖 `./paths.js`（宿主路径层）+ `../desktop.js`（安装树判定）
 * + `../extract-asar.js`（hostFs）。不许 import `patch/` `shim/` `prompt/`
 * `redteam/`，也不许 import `core.js`。
 */
import path from "node:path";
import * as desktop from "../desktop.js";
import { hostFs } from "../extract-asar.js";
import { isDesktop } from "../surface.js";
import {
  allowTargetForPatchFile,
  desktopDshHomeGuesses,
  findDshHome,
  isDir,
  isFile,
  keepSurfaceFile,
  withPatchTargetAiBase,
} from "./paths.js";

const fs = hostFs;

/**
 * SPEC 记录的上下文（一次 targetFiles 调用内固定）。
 * @typedef {{aiBase: string, dshHome: string, root: string|null}} SpecContext
 */

/**
 * 一条 SPEC 记录。
 *
 * 每条要么是「包 + 相对路径」模型（pkg + rels），要么给 `build` 钩子。
 * `mode` 决定返回值形态：`first` 出字符串，`all` 出数组。
 *
 * @typedef {object} SpecEntry
 * @property {string} key targetFiles() 返回对象里的键
 * @property {"first"|"all"} [mode] 取值模式（默认 first）
 * @property {string} [pkg] aiBase 下的包名
 * @property {string[][]} [rels] 包内相对路径列表
 * @property {boolean} [nested] 是否也查 npm 嵌套副本
 * @property {string[]} [rootPkg] monorepo 布局下的包目录段
 * @property {string[][]} [rootRels] 走 root 布局的相对路径（缺省 = rels）
 * @property {string} [nestedRoot] `*-nested` 组：嵌套根下的包名
 * @property {(ctx: SpecContext) => string|string[]} [build] 自定义候选构造
 */

/**
 * 首个存在的候选（只要文件，不要目录）。
 *
 * L30：目录命中会伪装成「存在但不能 patch」，所以用 isFile 而不是 existsSync。
 *
 * @param {string[]} candidates
 * @returns {string} 命中的路径，或空串
 */
function firstExisting(candidates) {
  return candidates.find((fp) => fp && isFile(fp) && allowTargetForPatchFile(fp)) ?? "";
}

/**
 * 全部存在的候选（去重）。
 * @param {string[]} candidates
 * @returns {string[]}
 */
function allExisting(candidates) {
  const hit = [];
  for (const fp of candidates) {
    if (fp && fs.existsSync(fp) && allowTargetForPatchFile(fp) && !hit.includes(fp)) hit.push(fp);
  }
  return hit;
}

/**
 * 从 aiBase 反推 monorepo 版本根（`packages/bundle/base` → 版本根）。
 * @param {string} aiBase
 * @returns {string|null}
 */
function packageRootFromAiBase(aiBase) {
  try {
    const base = fs.realpathSync(path.join(aiBase, "dsh-base"));
    // packages/bundle/base 对应版本根。
    return path.resolve(base, "../../..");
  } catch {
    return null;
  }
}

/**
 * 包内预设文件（随包发布的那几份）。
 * @param {string|null} root monorepo 版本根
 * @param {string} name 预设名
 * @param {string} aiBase 插件根
 * @returns {string[]}
 */
function shippedPresetYml(root, name, aiBase) {
  const out = [];
  if (aiBase) {
    // SHIPPED_PRESET_ROOT = 包内 presets/；npm 嵌套时在 dsh/node_modules/@deepseek-ai 下。
    out.push(
      path.join(aiBase, "dsh-web-app", "presets", `${name}.patch.yml`),
      path.join(aiBase, "dsh", "node_modules", "@deepseek-ai", "dsh-web-app", "presets", `${name}.patch.yml`),
      path.join(aiBase, "dsh-agent-presets", "presets", name, "agent.cordis.yml"),
      path.join(aiBase, "dsh", "node_modules", "@deepseek-ai", "dsh-agent-presets", "presets", name, "agent.cordis.yml"),
    );
  }
  if (root) {
    out.push(
      path.join(root, "config", "agent-presets", name, "agent.cordis.yml"),
      path.join(root, "apps", "cli", "config", "agent-presets", name, "agent.cordis.yml"),
      path.join(root, "packages", "preset", "agent-presets", "presets", name, "agent.cordis.yml"),
    );
  }
  if (aiBase) {
    out.push(
      path.join(aiBase, "..", "..", "config", "agent-presets", name, "agent.cordis.yml"),
      path.join(aiBase, "dsh", "config", "agent-presets", name, "agent.cordis.yml"),
    );
  }
  return out;
}

/**
 * 用户目录下的预设文件。
 * @param {string} dshHome
 * @param {string} name
 * @returns {string[]}
 */
function userPresetYml(dshHome, name) {
  return [
    path.join(dshHome, ".agent-presets", name, "agent.cordis.yml"),
    ...desktopDshHomeGuesses().map((home) => path.join(home, ".agent-presets", name, "agent.cordis.yml")),
  ];
}

/**
 * 官方桌面壳入口（main.js）。
 * @returns {string} 命中路径，或空串
 */
function officialShellMain() {
  try {
    if (!isDesktop()) return "";
    const exe = desktop.findDesktopAppExecutable();
    if (!exe || !desktop.isOfficialHarnessExecutable(exe)) return "";
    const appDir = desktop.appDirForExecutable(exe);
    // 官方桌面壳入口布局换过：早期是 lib/main.js，0.1.3 起直接是 main.js。
    // 只认 lib/ 会让 desktop-shell 永远未定位，#45/#46 被误报成"文件缺失"。
    for (const rel of [["lib", "main.js"], ["main.js"]]) {
      const main = path.join(appDir, ...rel);
      if (fs.existsSync(main)) return main;
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * pi-ai 的 api 文件（npm 嵌套 + profiles 目录树）。
 * @param {string} dshHome
 * @param {string} aiBase
 * @param {string} filename
 * @returns {string[]}
 */
function listPiAiApiFiles(dshHome, aiBase, filename) {
  const out = [];
  const seen = new Set();
  const push = (fp) => {
    if (!keepSurfaceFile(fp)) return;
    let key = fp;
    try { key = fs.realpathSync(fp); } catch { /* keep fp */ }
    key = String(key).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(fp);
  };
  const rel = ["@earendil-works", "pi-ai", "dist", "api", filename];
  if (aiBase) {
    push(path.join(aiBase, "..", ...rel));
    push(path.join(aiBase, "dsh", "node_modules", ...rel));
    push(path.join(aiBase, "..", "@deepseek-ai", "dsh", "node_modules", ...rel));
  }
  for (const home of [dshHome, ...desktopDshHomeGuesses()].filter(Boolean)) {
    push(path.join(home, "profiles", "node_modules", ...rel));
    push(path.join(home, "profiles", "node_modules", "@deepseek-ai", "dsh", "node_modules", ...rel));
    const profilesRoot = path.join(home, "profiles");
    if (!isDir(profilesRoot)) continue;
    let names = [];
    try {
      names = fs.readdirSync(profilesRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      names = [];
    }
    for (const ent of names) {
      const base = path.join(profilesRoot, ent.name, "node_modules");
      push(path.join(base, ...rel));
      push(path.join(base, "@deepseek-ai", "dsh", "node_modules", ...rel));
    }
  }
  return out;
}

/**
 * 把一条「包 + 相对路径」记录展开成候选绝对路径。
 *
 * 展开顺序（补丁表搬家前的手写版逐条对应）：
 *   对 rels 里的每条 rel：直连 → 嵌套副本（nested 为真时）
 *   再对 rootRels（缺省 = rels）里的每条：<root>/packages/<rootPkg>/<rel>
 *
 * @param {SpecEntry} spec SPEC 记录
 * @param {{aiBase: string, root: string|null}} ctx
 * @returns {string[]}
 */
function candidatesOf(spec, ctx) {
  const { aiBase, root } = ctx;
  const rels = spec.rels || [];
  const out = [];
  for (const rel of rels) {
    out.push(path.join(aiBase, spec.pkg, ...rel));
    if (spec.nested) out.push(path.join(aiBase, "dsh", "node_modules", "@deepseek-ai", spec.pkg, ...rel));
  }
  if (spec.rootPkg && root) {
    for (const rel of spec.rootRels || rels) out.push(path.join(root, "packages", ...spec.rootPkg, ...rel));
  }
  return out;
}

/**
 * 目标文件表。
 *
 * ⚠️ 加新 key 之前先确认补丁表里真的有补丁引用它 —— 没有引用的 key 只会让
 * 状态面板多一行空探测（已有 3 个这种 key 被删）。
 *
 * @type {SpecEntry[]}
 */
const SPEC = [
  { key: "agent-instructions", pkg: "dsh-agent-instructions", rels: [["lib", "index.js"]], rootPkg: ["context", "agent-instructions"], mode: "first" },
  { key: "web-app", pkg: "dsh-web-app", rels: [["cordis.patch.yml"]], rootPkg: ["bundle", "web-app"], mode: "first" },
  // npm 嵌套安装时 WEB_SURFACE 在 dsh/lib/index.js。
  { key: "web-app-lib", pkg: "dsh-web-app", rels: [["lib", "index.js"]], nested: true, rootPkg: ["bundle", "web-app"], mode: "first" },
  { key: "headless", pkg: "dsh-headless", rels: [["cordis.patch.yml"]], rootPkg: ["bundle", "headless"], mode: "first" },
  { key: "desktop-shell", mode: "first", build: () => officialShellMain() },
  // 注意：不要把 profiles/<name>/cordis.patch.yml 放进 targetFiles。
  // 那是官方文档支持的「用户 patch 层」，本插件没有任何补丁写入它；
  // 一旦进 backupAll/revertAll，版本升级自愈会把用户后来追加的 insert 盖掉（#43）。
  { key: "agent-preset", mode: "first", build: ({ aiBase, dshHome, root }) => [
    ...userPresetYml(dshHome, "unrestricted"),
    ...shippedPresetYml(root, "standard", aiBase),
  ] },
  { key: "user-approval", pkg: "dsh-user-approval", rels: [["lib", "types", "index.js"]], nested: true, rootPkg: ["interaction", "user-approval"], mode: "first" },
  // decide / Config 实现文件
  { key: "user-approval-code", pkg: "dsh-user-approval", rels: [["lib", "index.js"]], nested: true, rootPkg: ["interaction", "user-approval"], mode: "first" },
  // ⚠️ 这条 key 的两个方向都别动，各有实测依据：
  //
  // ① 别往这条 rel 里补 `["lib", "types", "invariant.js"]`。补上之后这个 key
  //    会解析到编译残留文件，而引它的补丁 9（APPROVAL_AUTO_GRANT，strictFiles）
  //    在那份文件里 pattern 与 marker 都不命中 → notFound 自增 → 干净安装上
  //    整条判 pattern_not_found。也就是说「修好路径」反而给一条必中补丁造出失败。
  //
  // ② 也别删掉这条 key（连同补丁 5/9/12 的 file 数组一起摘）。已评估并否决：
  //    落空只累加 missing、不动 notFound，patch 9 仍判 applied、5/12 仍判
  //    already，判定层零差异；而按 UPDATE-4 进位 minor 会触发全量重打。
  //    且 core.js 的还原候选清单里躺着裸 lib/invariant.js —— 这是历史布局化石，
  //    不是死键。当前 rel 落空、key 被 filterTargetFiles 删掉，是唯一安全态。
  { key: "user-approval-invariant", pkg: "dsh-user-approval", rels: [["lib", "invariant.js"]], nested: true, rootPkg: ["interaction", "user-approval"], mode: "first" },
  // 运行时加载的是包入口 lib/index.js（escalation 实现已被 bundle 内联进它）；
  // lib/types/escalation.js 只是编译残留，补丁打在那里对运行行为零影响。
  // 两者都覆盖，且入口排前，保证 markers 命中真正被执行的文件。
  { key: "escalation", pkg: "dsh-sandbox", rels: [["lib", "index.js"], ["lib", "types", "escalation.js"]], nested: true, rootPkg: ["sandbox", "sandbox"], mode: "all" },
  { key: "fs-sandbox", pkg: "dsh-fs-sandbox", rels: [["lib", "index.js"]], rootPkg: ["fs", "fs-sandbox"], mode: "first" },
  { key: "sandbox-local", pkg: "dsh-sandbox-local", rels: [["lib", "index.js"]], rootPkg: ["sandbox", "sandbox-local"], mode: "first" },
  { key: "base", pkg: "dsh-base", rels: [["cordis.patch.yml"]], rootPkg: ["bundle", "base"], mode: "first" },
  { key: "settings", pkg: "dsh-settings", rels: [["lib", "index.js"]], nested: true, rootPkg: ["settings", "settings"], mode: "first" },
  { key: "fs-observation-policy", pkg: "dsh-fs-observation-policy", rels: [["lib", "index.js"]], rootPkg: ["fs", "fs-observation-policy"], mode: "first" },
  { key: "repeat-tool-reminder", pkg: "dsh-repeat-tool-reminder", rels: [["lib", "index.js"]], rootPkg: ["guard", "repeat-tool-reminder"], mode: "first" },
  { key: "compaction-tool-result-pruner", pkg: "dsh-compaction-tool-result-pruner", rels: [["lib", "index.js"]], rootPkg: ["compaction", "compaction-tool-result-pruner"], mode: "first" },
  { key: "tool-fs", pkg: "dsh-tool-fs", rels: [["lib", "index.js"]], nested: true, rootPkg: ["fs", "tool-fs"], mode: "all" },
  { key: "tool-subagent", pkg: "dsh-tool-subagent", rels: [["lib", "index.js"]], rootPkg: ["subagent", "tool-subagent"], mode: "first" },
  { key: "subagent", pkg: "dsh-subagent", rels: [["lib", "index.js"]], nested: true, rootPkg: ["subagent", "subagent"], mode: "all" },
  { key: "subagent-types", pkg: "dsh-subagent", rels: [["lib", "types", "child-agent.js"]], nested: true, mode: "all" },
  { key: "preset-unrestricted", mode: "first", build: ({ dshHome }) => userPresetYml(dshHome, "unrestricted") },
  { key: "preset-standard", mode: "all", build: ({ aiBase, root }) => shippedPresetYml(root, "standard", aiBase) },
  { key: "preset-cordis", mode: "all", build: ({ aiBase, root }) => shippedPresetYml(root, "cordis", aiBase) },
  { key: "preset-minimal", mode: "all", build: ({ aiBase, root }) => shippedPresetYml(root, "minimal", aiBase) },
  { key: "preset-ptc", mode: "all", build: ({ aiBase, root }) => shippedPresetYml(root, "ptc", aiBase) },
  { key: "preset-acp-app", pkg: "dsh-acp-app", rels: [["cordis.patch.yml"]], rootPkg: ["bundle", "acp-app"], mode: "first" },
  { key: "preset-sdk-app", pkg: "dsh-sdk-app", rels: [["cordis.patch.yml"]], rootPkg: ["bundle", "sdk-app"], mode: "first" },
  { key: "preset-sdk-minimal", pkg: "dsh-sdk-minimal", rels: [["cordis.patch.yml"]], rootPkg: ["bundle", "sdk-minimal"], mode: "first" },
  { key: "tool-bash", pkg: "dsh-tool-bash", rels: [["lib", "index.js"]], nested: true, rootPkg: ["bash", "tool-bash"], mode: "all" },
  { key: "tool-pwsh", pkg: "dsh-tool-pwsh", rels: [["lib", "index.js"]], nested: true, rootPkg: ["pwsh", "tool-pwsh"], mode: "all" },
  // 删掉 "persona"：它此前只服务 38 PERSONA_TEXT_PREFIX_ALIAS（兼容
  // 0.1.2 的 text 字段）；38 删除后这条 SPEC 记录再无补丁引用，
  // test/target-spec.test.mjs 的「不许有无补丁引用的死 key」断言会红。
  { key: "session-format-v0", pkg: "dsh-session-format-v0-to-v1", rels: [["lib", "index.js"]], nested: true, rootPkg: ["session", "session-format-v0-to-v1"], mode: "all" },
  { key: "system-prompt", pkg: "dsh-system-prompt", rels: [["lib", "index.js"]], rootPkg: ["core", "system-prompt"], mode: "first" },
  { key: "tool-web", pkg: "dsh-tool-web", rels: [["lib", "index.js"]], rootPkg: ["tools", "tool-web"], mode: "first" },
  { key: "hooks-claude-code", pkg: "dsh-hooks-claude-code", rels: [["lib", "index.js"]], rootPkg: ["hooks", "hooks-claude-code"], mode: "first" },
  { key: "hooks-codex", pkg: "dsh-hooks-codex", rels: [["lib", "index.js"]], rootPkg: ["hooks", "hooks-codex"], mode: "first" },
  { key: "api-session-controller", pkg: "dsh-api-session-controller", rels: [["lib", "index.js"]], rootPkg: ["api", "api-session-controller"], mode: "first" },
  // npm 嵌套布局下的重复副本：@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>。
  // 桌面解包布局没有这一层（@deepseek-ai/dsh 存在但不带自己的 node_modules）。
  // 整组键按需登记：嵌套根不存在就不登记，免得状态面板长期挂 4 个 ✗。
  { key: "system-prompt-nested", mode: "first", nestedRoot: "dsh-system-prompt" },
  { key: "tool-web-nested", mode: "first", nestedRoot: "dsh-tool-web" },
  { key: "hooks-claude-code-nested", mode: "first", nestedRoot: "dsh-hooks-claude-code" },
  { key: "hooks-codex-nested", mode: "first", nestedRoot: "dsh-hooks-codex" },
  { key: "pi-ai-completions", mode: "all", build: ({ dshHome, aiBase }) => listPiAiApiFiles(dshHome, aiBase, "openai-completions.js") },
  { key: "pi-ai-responses-shared", mode: "all", build: ({ dshHome, aiBase }) => listPiAiApiFiles(dshHome, aiBase, "openai-responses-shared.js") },
  { key: "pi-ai-anthropic-messages", mode: "all", build: ({ dshHome, aiBase }) => listPiAiApiFiles(dshHome, aiBase, "anthropic-messages.js") },
  { key: "session-reference", pkg: "dsh-session-reference", rels: [["lib", "index.js"], ["lib", "types", "index.js"], ["lib", "types", "spill.js"]], nested: true, rootPkg: ["session", "session-reference"], rootRels: [["lib", "index.js"]], mode: "all" },
  { key: "permission-presets", pkg: "dsh-permission-presets", rels: [["lib", "index.js"]], nested: true, rootPkg: ["sandbox", "permission-presets"], mode: "all" },
  { key: "permission-presets-types", pkg: "dsh-permission-presets", rels: [["lib", "types", "index.js"]], nested: true, mode: "all" },
  { key: "session-log-deepseek", pkg: "dsh-session-log-deepseek", rels: [["lib", "index.js"]], nested: true, mode: "all" },
  { key: "session-log-deepseek-types", pkg: "dsh-session-log-deepseek", rels: [["lib", "types", "index.js"]], nested: true, mode: "all" },
  { key: "deliverables-prompt", pkg: "dsh-client-ui-deliverables", rels: [["lib", "index.js"]], nested: true, mode: "all" },
  { key: "llm-deepseek", pkg: "dsh-llm-deepseek", rels: [["lib", "index.js"]], nested: true, mode: "all" },
  { key: "session", pkg: "dsh-session", rels: [["lib", "index.js"]], nested: true, mode: "all" },
  { key: "agent-loop", pkg: "dsh-agent-loop", rels: [["lib", "index.js"]], nested: true, mode: "all" },
  { key: "app-boot", pkg: "dsh-app-boot", rels: [["lib", "index.js"]], nested: true, mode: "all" },
  { key: "conversation-client", pkg: "dsh-client-ui-conversation", rels: [["lib", "client.js"]], nested: true, mode: "all" },
  { key: "tool-todo", pkg: "dsh-tool-todo", rels: [["lib", "index.js"]], nested: true, mode: "all" },
  { key: "auto-review", pkg: "dsh-experimental-auto-review", rels: [["lib", "index.js"]], nested: true, mode: "all" },
  { key: "dsh-tools", pkg: "dsh-tools", rels: [["lib", "index.js"]], nested: true, mode: "all" },
  { key: "dsh-tools-types", pkg: "dsh-tools", rels: [["lib", "types", "index.js"]], nested: true, mode: "all" },
  { key: "dsh-tools-ptc", pkg: "dsh-tools", rels: [["lib", "types", "ptc.js"]], nested: true, mode: "all" },
  { key: "sandbox-policy", pkg: "dsh-sandbox-policy", rels: [["lib", "index.js"]], nested: true, mode: "all" },
];

/** SPEC 里登记的全部 key（导出给测试与诊断对照补丁表用）。 */
export const TARGET_KEYS = Object.freeze(SPEC.map((spec) => spec.key));

/**
 * 过滤候选表：去掉宿主面门禁拒绝的路径，删掉落空的键。
 *
 * 落空的键直接不登记。状态面板上那些 ✗ 行看起来像「有东西没清洗到位」，
 * 实际是这套布局本来就没有那个文件（preset-unrestricted、*-nested 等）。
 * 下游 pathsOf() 对缺键返回 []，与登记成 "" 的行为完全一致。
 *
 * @param {Record<string, string|string[]>} files
 * @returns {Record<string, string|string[]>}
 */
function filterTargetFiles(files) {
  const out = {};
  for (const [key, val] of Object.entries(files)) {
    if (Array.isArray(val)) {
      const kept = val.filter((fp) => !fp || !fs.existsSync(fp) || allowTargetForPatchFile(fp));
      const existing = kept.filter((fp) => fp && fs.existsSync(fp) && allowTargetForPatchFile(fp));
      out[key] = existing.length ? existing : [];
    } else if (val && fs.existsSync(val) && !allowTargetForPatchFile(val)) {
      out[key] = "";
    } else {
      out[key] = val;
    }
  }
  for (const key of Object.keys(out)) {
    const val = out[key];
    if (val === "" || (Array.isArray(val) && val.length === 0)) delete out[key];
  }
  return out;
}

/**
 * 补丁目标文件表。
 *
 * @param {string} aiBase 插件根
 * @param {string} [dshHome] dsh 主目录（默认现场探测）
 * @returns {Record<string, string|string[]>} key → 路径（或路径数组）；落空的键不出现
 */
export function targetFiles(aiBase, dshHome = findDshHome()) {
  return withPatchTargetAiBase(aiBase, () => {
    const root = packageRootFromAiBase(aiBase);
    const ctx = { aiBase, dshHome, root };
    const files = {};
    for (const spec of SPEC) {
      if (spec.nestedRoot) {
        const nestedRoot = path.join(aiBase, "dsh", "node_modules", "@deepseek-ai");
        if (!isDir(nestedRoot)) {
          files[spec.key] = "";
          continue;
        }
        files[spec.key] = firstExisting([path.join(nestedRoot, spec.nestedRoot, "lib", "index.js")]);
        continue;
      }
      const cands = spec.build ? spec.build(ctx) : candidatesOf(spec, ctx);
      if (Array.isArray(cands)) {
        files[spec.key] = spec.mode === "all" ? allExisting(cands) : firstExisting(cands);
      } else {
        // build 直接给出结论（例如 officialShellMain 已经判过存在性）。
        files[spec.key] = cands ?? "";
      }
    }
    return filterTargetFiles(files);
  });
}
