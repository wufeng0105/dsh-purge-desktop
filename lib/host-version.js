/**
 * lib/host-version.js — 版本对不上时补丁会静默失效，所以先门禁再动手。
 * 宿主版本门禁（CONTRACT-4）。
 *
 * 背景：`package.json` 声明了 `dshTarget`，而补丁表里的字符串替换**不带版本条件** ——
 * 补丁对宿主版本完全无感知，失效时是静默的。这就是「架构与补丁机制不匹配」的精确表述。
 *
 * 本模块做三件事：
 *   1. 从宿主安装里读真实版本（`@deepseek-ai/dsh` 的 package.json）
 *   2. 与 dshTarget 比对（口径见下）
 *   3. 不匹配时给出**可执行的**错误，而不是静默跳过
 *
 * ## 比对口径只有两句
 *
 *   - 主次版本必须相同 —— 这是补丁目标结构的边界；
 *   - 主次版本相同时，宿主 **≥** 目标才放行。
 *
 * 比较本身走 `lib/version.js` 的全序（semver precedence），本模块不再自己拆分支。
 * 早先这里是四条互斥分支，prerelease 那条排在 patch 之前、且只比 rc 序号 —— 于是
 * `0.2.2-rc.1` 被说成「比 0.2.1-rc.2 更旧」而拒绝，`0.2.0-rc.5` 被放行。同一 minor 下
 * patch 号根本没参与比较，理由文案还是错的。**「两边都是 rc」不是一种新语义，只是全序里的
 * 一段**；把它当成一条分支，等于把判据手写成了四段。
 *
 * 方括号里的两档是按全序推出来的、需要说出口的后果：
 *   [1] 正式版高于同号预发布（`0.2.1` > `0.2.1-rc.2`）。所以「宿主 0.2.1、目标 0.2.1-rc.2」
 *       判 compatible；反过来「宿主 0.2.1-rc.1、目标 0.2.1」判 mismatch，因为宿主比目标旧。
 *   [2] 宿主比目标新不改变主次版本时一律放行（rc 序号向上漂移、patch 号更大都算这一类）。
 */

import fs from "node:fs";
import path from "node:path";

import { compareVersions, lowestDifferingField, parseVersion } from "./version.js";

// 解析的实现只有一处；这里转出是为了让门禁的调用方与用例只认一个入口。
export { parseVersion };

/**
 * 比对宿主版本与 dshTarget。
 *
 * @param {string} hostVersion 宿主实际版本，如 "0.2.1-rc.2"
 * @param {string} target 声明的目标版本，如 "0.2.1-rc.2"
 * @returns {{ok:boolean, reason:string, level:"exact"|"compatible"|"mismatch"|"unparsable"}}
 */
export function compareHostVersion(hostVersion, target) {
  const host = parseVersion(hostVersion);
  const want = parseVersion(target);
  if (!host) {
    return { ok: false, reason: `宿主版本无法解析: ${JSON.stringify(hostVersion)}`, level: "unparsable" };
  }
  if (!want) {
    return { ok: false, reason: `dshTarget 无法解析: ${JSON.stringify(target)}`, level: "unparsable" };
  }

  const order = compareVersions(host, want);
  if (order === 0) return { ok: true, reason: "", level: "exact" };

  // 主次版本必须相同 —— 这是补丁目标结构的边界，与「谁更新」无关：
  // 目标 minor 更新时也拒绝，因为补丁是按目标那一版的源码结构写的。
  if (host.major !== want.major || host.minor !== want.minor) {
    return {
      ok: false,
      level: "mismatch",
      reason:
        `宿主版本 ${hostVersion} 与 dshTarget ${target} 的主次版本不同`
        + `（${host.major}.${host.minor} vs ${want.major}.${want.minor}）。`
        + "补丁目标是按宿主源码结构写的，跨 minor 通常会错位，拒绝应用。",
    };
  }

  // 同 minor：宿主更新就放行（见头注释的 [1] [2] 两档）。
  if (order > 0) return { ok: true, level: "compatible", reason: "" };

  const field = lowestDifferingField(host, want);
  const detail = field === "patch"
    ? `patch 号更小（${host.patch} < ${want.patch}）`
    : field === "prerelease"
      ? `同 patch 但预发布更早（${host.prerelease.join(".")} < ${want.prerelease.join(".")}）`
      : `${field} 更小`;
  return {
    ok: false,
    level: "mismatch",
    reason:
      `宿主版本 ${hostVersion} 比 dshTarget ${target} 更旧：${detail}。`
      + "补丁按较新的源码写的，在旧宿主上可能匹配不到，拒绝应用。",
  };
}

/**
 * 从宿主安装根读真实版本。
 *
 * 读 `@deepseek-ai/dsh/package.json` —— 它是宿主的版本权威来源
 * （`dsh-agent-instructions` / `dsh-web-app` 等子包版本与它同步，但 dsh 本身最稳）。
 *
 * 路径用 path.join 拼（Windows 上 `/` 拼接在部分 API 下会失败）。
 *
 * @param {string} aiBase 宿主插件根（含 dsh-agent-instructions 的那层）
 * @returns {string} 版本串，读不到返回空串
 */
export function readHostVersion(aiBase) {
  if (!aiBase) return "";
  // aiBase 通常指向 `.../dsh/node_modules/@deepseek-ai`（插件根）。
  // dsh 包既可能在它的上一层，也可能在它的同级。
  const candidates = [
    path.join(aiBase, "dsh", "package.json"),
    path.join(aiBase, "..", "..", "package.json"),
    path.join(aiBase, "dsh-agent-instructions", "package.json"),
  ];
  for (const fp of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(fp, "utf8"));
      // 只认真正的 dsh 包，避免读到 dsh-agent-instructions 或别的
      if (pkg && pkg.version && (!pkg.name || /(^|\/)dsh$/.test(pkg.name))) {
        return String(pkg.version);
      }
    } catch {
      // 换下一个
    }
  }
  // 退一步：接受 dsh-agent-instructions 的版本（与 dsh 同步）
  try {
    const pkg = JSON.parse(fs.readFileSync(candidates[2], "utf8"));
    if (pkg && pkg.version) return String(pkg.version);
  } catch {
    // ignore
  }
  return "";
}

/**
 * 门禁判定：把「能不能在这个宿主上应用」变成单一结论。
 *
 * @param {object} input
 * @param {string} input.hostVersion 宿主实际版本
 * @param {string} input.dshTarget 声明的目标版本
 * @param {boolean} [input.force] 用户显式强制
 * @returns {{allowed:boolean, level:string, reason:string, hint:string}}
 */
export function gateHostVersion({ hostVersion, dshTarget, force = false } = {}) {
  const verdict = compareHostVersion(hostVersion, dshTarget);
  if (verdict.ok) {
    return {
      allowed: true,
      level: verdict.level,
      reason: verdict.level === "exact" ? "" : `宿主 ${hostVersion} 与 dshTarget ${dshTarget} 兼容（${verdict.level}）`,
      hint: "",
    };
  }
  if (force) {
    return {
      allowed: true,
      level: "forced",
      reason: verdict.reason,
      hint: "已按用户要求强制应用。补丁可能匹配不到，失效是静默的 —— 请核对清洗页的状态。",
    };
  }
  return {
    allowed: false,
    level: verdict.level,
    reason: verdict.reason,
    hint:
      "升级插件到匹配宿主的新版本，或在配置里显式设置 forceApplyOnVersionMismatch: true 强制应用（会显示警告）。",
  };
}
