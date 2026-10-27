/**
 * lib/install-state.js — 记下这棵树是怎么装进来的，好认出包管理器不知道的手工改动。
 * 安装状态：记录「这棵插件树是怎么装进来的、装完之后有没有被手工改过」。
 *
 * ## 为什么需要
 *
 * 2026-10-23 在测试机上出现过一次**包管理器不知道的改动**：`--unseal` 把 `app.asar`
 * 挪走之后 `dsh` CLI 失效，插件装不进去，于是用 `Copy-Item` 直接覆盖了
 * `node_modules/dsh-purge` 里的三个文件。结果：
 *
 *   · 现场能用，但没有任何记录说明「这棵树比 pnpm store 里的新」；
 *   · 下一次 `pnpm install` / `dsh plugin add` 会把它们**静默盖回旧版**；
 *   · 事后排查只能靠人回忆，而回忆不可靠（这正是 diag-log 存在的理由）。
 *
 * 这里把「版本 + 安装方式 + 每个文件的 sha256」落一份到 `<DSH_HOME>/dsh-purge/install-state.json`，
 * 让 `--diagnose` / `--status` 能直接回答「当前这棵树和记录是否一致」。
 *
 * ## 边界
 *
 * 只统计**插件自己的**文件（`package.json` / `lib/**` / `bin/**`），不碰宿主。
 * 必须零内部依赖（只 import 自 node 内置模块），否则会和 core 形成环。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 参与指纹的文件：安装方式的差异一定体现在这几个位置。 */
const WATCHED = ["package.json", "bin/dsh-purge.js"];

function sha256File(fp) {
  try {
    return createHash("sha256").update(fs.readFileSync(fp)).digest("hex");
  } catch {
    return "";
  }
}

/** 递归收集 lib/ 下的 .js（不含 client-src：那是被装配进 client.js 的片段，改了也不影响宿主侧）。 */
function listLibFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "client-src" || entry.name === "node_modules") continue;
        walk(fp, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        out.push(path.relative(root, fp).replace(/\\/g, "/"));
      }
    }
  };
  walk(path.join(root, "lib"), 0);
  return out;
}

/**
 * 状态文件的固定位置。
 *
 * @param {string} dshHome 宿主数据目录
 * @returns {string} `install-state.json` 的绝对路径
 */
export function installStatePath(dshHome) {
  return path.join(String(dshHome || ""), "dsh-purge", "install-state.json");
}

/**
 * 计算当前插件树的指纹。
 *
 * @param {string} root 插件包根（含 package.json 的那一层）
 * @returns {Record<string, string>} 相对路径 → sha256
 */
export function fingerprintPluginTree(root) {
  const files = {};
  for (const rel of [...WATCHED, ...listLibFiles(root)]) {
    const fp = path.join(root, rel);
    if (!fs.existsSync(fp)) continue;
    const digest = sha256File(fp);
    if (digest) files[rel] = digest;
  }
  return files;
}

/**
 * 写入安装状态。任何异常都吞掉 —— 记录失败不该影响补丁流程。
 *
 * @param {string} dshHome 宿主数据目录
 * @param {object} input
 * @param {string} input.root 插件包根
 * @param {string} [input.version] 插件版本
 * @param {string} [input.method] 安装方式（pnpm / manual-copy / unknown）
 * @returns {{ok:boolean, path:string, files:number}}
 */
export function recordInstallState(dshHome, input = {}) {
  const file = installStatePath(dshHome);
  try {
    const files = fingerprintPluginTree(input.root);
    const payload = {
      version: String(input.version || ""),
      method: String(input.method || "unknown"),
      at: new Date().toISOString(),
      root: String(input.root || ""),
      files,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return { ok: true, path: file, files: Object.keys(files).length };
  } catch {
    return { ok: false, path: file, files: 0 };
  }
}

/**
 * 读取安装状态。
 *
 * @param {string} dshHome 宿主数据目录
 * @returns {object|null} 解析后的状态；文件不存在或损坏时返回 null
 */
export function readInstallState(dshHome) {
  try {
    return JSON.parse(fs.readFileSync(installStatePath(dshHome), "utf8"));
  } catch {
    return null;
  }
}

/**
 * 把记录与磁盘现状对一遍。
 *
 * `drifted` = 同路径但哈希不同（被手工改过或被重新安装成别的版本）；
 * `missing` = 记录里有、磁盘上没有；`added` = 磁盘上有、记录里没有。
 *
 * @param {string} dshHome 宿主数据目录
 * @param {string} root 插件包根
 * @returns {{state:object|null, drifted:string[], missing:string[], added:string[], ok:boolean}}
 */
export function checkInstallState(dshHome, root) {
  const state = readInstallState(dshHome);
  if (!state || !state.files) return { state: null, drifted: [], missing: [], added: [], ok: false };
  const actual = fingerprintPluginTree(root);
  const drifted = [];
  const missing = [];
  const added = [];
  for (const [rel, digest] of Object.entries(state.files)) {
    if (!(rel in actual)) missing.push(rel);
    else if (actual[rel] !== digest) drifted.push(rel);
  }
  for (const rel of Object.keys(actual)) if (!(rel in state.files)) added.push(rel);
  return { state, drifted, missing, added, ok: drifted.length === 0 && missing.length === 0 && added.length === 0 };
}
