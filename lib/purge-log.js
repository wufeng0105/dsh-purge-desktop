/**
 * lib/purge-log.js — 宿主内部探针日志：落 DSH 主目录，滚动与诊断轨共用一份规格。
 *
 * 为什么搬家：这份纯文本探针原先写在系统临时目录（`dsh-purge-desktop.log`），
 * 系统清理一次就什么都不剩 —— 而它记的正是提示词装配决策与 HTTP 动作结果。
 * 现在落 `<dshHome>/dsh-purge/logs/desktop.log`，与 `diag.jsonl` 同一层目录，
 * 「日志在哪」只有一个答案。
 *
 * 为什么与 diag 分开文件：两者的形状不同（这里是 `ISO 时间戳 [标签] k=v`，诊断轨是
 * JSONL）。形状不同可以，**保留行为不同不行** —— 所以滚动阈值、保留代数与检查频率
 * 都从 `./log-rolling.js` 取，不在这里另写一套常量。
 *
 * 一条硬约束沿用诊断轨：永不抛错。探针写不进去不许中断提示词装配。
 */
import fs from "node:fs";
import path from "node:path";

import { LOG_ROLLING, shouldCheckSize, rotateIfNeeded } from "./log-rolling.js";

let writeCount = 0;

/**
 * 探针日志的落点：`<dshHome>/dsh-purge/logs/desktop.log`。
 *
 * @param {string} dshHome 宿主数据目录
 * @returns {string}
 */
export function purgeLogPath(dshHome) {
  return path.join(String(dshHome || ""), "dsh-purge", "logs", "desktop.log");
}

/**
 * 写一行内部探针日志。
 *
 * 值里空格会把 `k=v` 切开，统一替换成 `_` 保证 grep 稳定；换行压成空格的理由同上。
 *
 * @param {string} tag 事件标签，形如 `assemble.entry`
 * @param {Record<string, unknown>} [kv] 附加字段
 * @param {string} dshHome 宿主数据目录，决定落点
 * @returns {string} 实际写入的路径；写失败返回空串
 */
export function purgeLog(tag, kv, dshHome) {
  try {
    const file = purgeLogPath(dshHome);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (shouldCheckSize(++writeCount, LOG_ROLLING)) rotateIfNeeded(file, LOG_ROLLING);
    let line = `${new Date().toISOString()} [${tag}]`;
    if (kv) {
      for (const key of Object.keys(kv)) {
        const raw = kv[key];
        const value = raw === undefined || raw === null ? "" : String(raw).replace(/\s+/g, "_");
        line += ` ${key}=${value}`;
      }
    }
    fs.appendFileSync(file, `${line}\n`, "utf8");
    return file;
  } catch {
    return "";
  }
}
