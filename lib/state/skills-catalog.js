/**
 * lib/state/skills-catalog.js — 技能目录的唯一枚举实现：目录清单、优先级、库归属。
 *
 * 为什么需要它：同一份磁盘技能集原先被三处按不同规则枚举 —— 设置页只扫
 * `$DSH_HOME/skills`；演练台合并「官方目录 + 红队库」再按名去重；preset 的
 * `skill-filesystem` 又用两根 `customSkillDirs`。三处各自自洽，只是给出的集合可以不
 * 一样，而「不一样」没有任何症状：两个页面都像是完整的。收编之后谁都不再自己拼目录。
 *
 * ## 两根目录就是 preset 的两行
 *
 * `presets/redteam/agent.cordis.yml` 的 `customSkillDirs` 写了顺序，这里抄的是**事实**
 * 而不是偏好：
 *
 *   1. `$DSH_HOME/skills`        用户自己的（宿主原生技能的落点）；
 *   2. `$DSH_HOME/redteam/skills` 随包同步的副本（插件启动时从包内 `skills/redteam` 同步）。
 *
 * 顺序即优先级：**同名取先出现者**，落选的不是「重复项」而是「被遮蔽的那一份」。这条
 * 顺序不是审美选择 —— 用户的 `$DSH_HOME/skills` 里写的是自己的 VPS 地址与密钥，随包
 * 模板里是 `<你的VPS_IP>` 这类占位符；顺序反了，用户配好的那份会被模板盖住，而两个
 * 页面都还是「看起来完整」。`test/skills-single-source.test.mjs` 拿 preset 原文核对这条顺序。
 *
 * ## 边界
 *
 * 这一层只认「目录里有哪些技能」：枚举、按名去重、库归属、按库筛选。可用性检查
 * （缺工具 / 缺密钥 / 占位符没换）留在 `lib/redteam/skill-availability.js`，正文编辑与
 * 落盘留在 `lib/skills.js` —— 那些都需要各自的现场，混进来就会让「目录是什么」这件事
 * 又要读三种现场才回答得了。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 两个库。`official` 是宿主 / 用户的目录，`redteam` 是随包同步副本。 */
export const SKILL_LIBRARIES = Object.freeze({ official: "official", redteam: "redteam" });

/**
 * 根的优先级顺序，逐项对应 preset 的 `customSkillDirs`。
 *
 * 改这一行等于改「同名技能谁可见」，所以它只有一份，且被用例拿 preset 原文核对。
 */
export const SKILL_ROOT_ORDER = Object.freeze([SKILL_LIBRARIES.official, SKILL_LIBRARIES.redteam]);

/** 随包技能在仓库里的位置（同步副本还不存在时的兜底源）。 */
const PACKAGE_REDTEAM_DIR = fileURLToPath(new URL("../../skills/redteam", import.meta.url));

/** 与宿主 `@deepseek-ai/dsh-skill` 一致：技能名是 kebab-case。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * frontmatter 里宿主认的两行：`name` 与 `description`。
 *
 * 只认这两行、只做单行取值，是因为目录层只需要一个显示名与一句说明；真正的合法性判定
 * （frontmatter 必填、布尔字段、正文）留在 `lib/skills.js` 的 `parseSkillDocument` ——
 * 那里要报「缺什么」，这里只要「叫什么」。
 *
 * @param {string} text 技能文件正文
 * @returns {{name:string, description:string}}
 */
function frontmatterOf(text) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ""));
  if (!block) return { name: "", description: "" };
  const line = (key) => {
    const hit = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(block[1]);
    if (!hit) return "";
    const value = hit[1].trim();
    const comment = value.indexOf(" #");
    const bare = (comment >= 0 ? value.slice(0, comment) : value).trim().replace(/^["']|["']$/g, "");
    return bare;
  };
  return { name: line("name"), description: line("description") };
}

/** 一个目录是不是存在（存在判定只影响「列出 0 条」还是「换个目录看」，不改任何判据）。 */
function isDir(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 随包技能的落点：优先同步副本，没有就退回包内目录。
 *
 * 两条路都指向「同一份技能」：同步副本是启动时从包内拷出来的。之所以先认副本，
 * 是因为宿主侧读的是 `$DSH_HOME` 那棵运行态树，而包内路径在 profile 符号链接下可能
 * 指向不存在的位置（空格路径、未解析的 junction 都踩过）。
 *
 * @param {string} dshHome 宿主数据目录
 * @param {string} [override] 测试或调用方显式指定的目录
 * @returns {string}
 */
export function redteamSkillsDir(dshHome, override) {
  if (typeof override === "string" && override.trim() !== "") return path.resolve(override);
  const synced = path.join(String(dshHome || ""), "redteam", "skills");
  return isDir(synced) ? synced : PACKAGE_REDTEAM_DIR;
}

/**
 * 目录清单：顺序、库归属、绝对路径一次给全。
 *
 * @param {string} dshHome 宿主数据目录
 * @param {{redteamDir?:string}} [options]
 * @returns {Array<{library:string, dir:string, rank:number}>} 按优先级排列
 */
export function skillRootsFor(dshHome, options = {}) {
  const home = String(dshHome || "");
  const dirs = {
    [SKILL_LIBRARIES.official]: path.join(home, "skills"),
    [SKILL_LIBRARIES.redteam]: redteamSkillsDir(home, options && options.redteamDir),
  };
  return SKILL_ROOT_ORDER.map((library, rank) => ({ library, dir: dirs[library], rank }));
}

/**
 * 列一个目录里的条目：只认「`<name>/SKILL.md` 或 `<name>.md`」，不解析正文。
 *
 * 解析留给读者：设置页要 `valid` / `size`，演练台要可用性判定，两边解析的目的不同，
 * 但「目录里有哪些文件」这一件事必须只有一份答案。
 *
 * @param {string} dir 目录
 * @returns {Array<{id:string, path:string, kind:string, size:number}>}
 */
export function listSkillFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".system") continue;
    if (entry.isDirectory()) {
      const file = path.join(dir, entry.name, "SKILL.md");
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      out.push({ id: entry.name, path: file, kind: "bundle", size: stat.size });
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "SKILL.md") continue;
    const file = path.join(dir, entry.name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    out.push({ id: entry.name.slice(0, -3), path: file, kind: "flat", size: stat.size });
  }
  return out;
}

/**
 * 按优先级合并：同名取先出现者，落选的那份进 `shadowed`。
 *
 * 纯函数：条目由调用方交进来，本函数只做排序、去重与计数。两个读者因此不可能
 * 「各自合并出不同结果」——它们交进来的是同一份条目，拿走的是同一次合并。
 *
 * 判重的键是 `id`（缺省退回 `name`）：同一个技能在两个根里可能一个写成目录
 * `dup/SKILL.md`、一个写成 `dup.md`，它们的 id 都是 `dup` —— 正是要遮掉的那种情况。
 *
 * @param {{roots:Array<{library:string,dir:string,rank:number}>, entries:Array<object>}} input
 * @returns {{roots:Array<object>, items:Array<object>, total:number,
 *   byLibrary:Record<string,number>, shadowed:Array<object>}}
 */
export function buildSkillsCatalog(input = {}) {
  const roots = Array.isArray(input.roots) ? input.roots : [];
  const entries = Array.isArray(input.entries) ? input.entries : [];
  const rankOf = new Map(roots.map((root) => [root.library, root.rank]));
  const keyOf = (entry) => String((entry && (entry.id || entry.name)) || "");
  const ordered = [...entries].sort((a, b) => {
    const ra = rankOf.has(a && a.library) ? rankOf.get(a.library) : roots.length;
    const rb = rankOf.has(b && b.library) ? rankOf.get(b.library) : roots.length;
    if (ra !== rb) return ra - rb;
    return keyOf(a).localeCompare(keyOf(b));
  });
  const kept = new Map();
  const shadowed = [];
  for (const entry of ordered) {
    const id = keyOf(entry);
    if (!id) continue;
    const hit = kept.get(id);
    if (hit) {
      shadowed.push({
        id,
        keptLibrary: hit.library || "",
        keptPath: hit.path || "",
        droppedLibrary: (entry && entry.library) || "",
        droppedPath: (entry && entry.path) || "",
      });
      continue;
    }
    kept.set(id, entry);
  }
  const items = [...kept.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const byLibrary = {};
  for (const library of SKILL_ROOT_ORDER) byLibrary[library] = 0;
  for (const item of items) {
    const library = String((item && item.library) || "");
    if (!(library in byLibrary)) byLibrary[library] = 0;
    byLibrary[library] += 1;
  }
  return { roots, items, total: items.length, byLibrary, shadowed };
}

/**
 * 按库筛出一个子集。
 *
 * 筛的是**同一个集合**里的条目，不是再枚举一次：UI 上的「只看随包」与列表本身必须
 * 出自同一次合并，否则筛选前后能出现两种计数。
 *
 * @param {{items?:Array<object>}} catalog 目录
 * @param {string} library 库名（`official` / `redteam`）
 * @returns {Array<object>}
 */
export function filterByLibrary(catalog, library) {
  const want = String(library || "");
  const items = Array.isArray(catalog && catalog.items) ? catalog.items : [];
  if (want === "") return [...items];
  return items.filter((item) => String((item && item.library) || "") === want);
}

/**
 * 读盘版：目录清单 + 文件清单 + 合并，一次给全。
 *
 * 条目带的是目录层事实：显示名（frontmatter 的 `name`，不合法才退回文件名）、一句说明、
 * 种类、路径、字节数、库归属。**不**带 `valid` / `error` / 可用性判定 —— 那三样各自
 * 有各自的现场（设置页要报「缺什么」才能编辑，演练台要报「缺哪个工具」），而且它们
 * 都不改变「目录里有哪些技能」。两边要的显示名与说明必须是同一次读出来的，否则同一份
 * 技能在两个页面上会挂着两句话。
 *
 * @param {string} dshHome 宿主数据目录
 * @param {{redteamDir?:string}} [options]
 * @returns {{roots:Array<object>, items:Array<object>, total:number,
 *   byLibrary:Record<string,number>, shadowed:Array<object>}}
 */
export function readSkillCatalog(dshHome, options = {}) {
  const roots = skillRootsFor(dshHome, options);
  const entries = [];
  for (const root of roots) {
    for (const file of listSkillFiles(root.dir)) {
      let text = "";
      try {
        text = fs.readFileSync(file.path, "utf8");
      } catch {
        text = "";
      }
      const meta = frontmatterOf(text);
      const name = SKILL_NAME_RE.test(meta.name) ? meta.name : file.id;
      entries.push({
        ...file,
        id: name,
        name,
        description: meta.description,
        library: root.library,
        dir: root.dir,
        // `editable` 只对用户目录为真：随包副本是同步产物，改了会被下次同步盖回去。
        editable: root.library === SKILL_LIBRARIES.official,
      });
    }
  }
  return buildSkillsCatalog({ roots, entries });
}
