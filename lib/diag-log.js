/**
 * lib/diag-log.js — 无人值守跑一次也要能事后回溯，所以结论落成 JSONL。
 * 诊断日志：把「谁在什么时候、对哪个文件做了什么」写成可回溯的单行 JSONL。
 *
 * 为什么单独一层：宿主侧的 purgeLog 写在系统临时目录，只覆盖提示词装配与 HTTP 动作；
 * 而 `dsh-purge --apply` / `--revert` 这条 CLI 路径此前完全静默 —— 远程机器上无人值守跑
 * 一次，进程结束就什么都不剩。补丁打偏、版本门禁拒绝、备份缺失这些结论只能靠人回忆
 * 终端输出。日志落盘后，事后定位只需要读文件。
 *
 * 三条硬约束：
 *  1. **永不抛错**。日志失败不许中断补丁流程 —— 宿主文件写一半比没有日志更糟。
 *  2. **路径可覆盖**。`DSH_PURGE_LOG_FILE` 优先，其次 `<DSH_HOME>/dsh-purge/logs/`，
 *     宿主目录不可写时退回系统临时目录，保证任何环境都留得下记录。
 *  3. **单行 JSONL**。便于 grep 与 jq，也能整段贴进问题报告。
 *
 * 落点按**每次调用**的 `dshHome` 重算，不缓存首个路径。同一进程里先跑测试再跑真实
 * 安装（或反过来）是常态，锁死首路径会把事件写进上一个 home，让两边都失真。
 *
 * 关闭方式：`DSH_PURGE_LOG=0`（或 off / false）。默认开启。
 * 本文件只依赖一个叶子模块（./log-rolling.js，仅 node:fs），不把日志层拖进依赖环。
 *
 * 身份从哪来：引擎（`lib/core.js`）自己的发射点里没有「谁触发的」。
 * 若让 10 个入口各写一条自己的事件，引擎字段（selected / patches / bases / hostVersion）
 * 就留在了另一条记录上，读日志的人只能按时间邻近手工配对 —— 那正是「分得开、连不上」。
 * 所以身份做成**环境**：入口只声明自己是谁（`withApplyRun`），本层在每条 row 序列化前
 * 补进去。并发靠 AsyncLocalStorage 的异步链隔离，嵌套天然穿透，引擎一个字节不用改。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import { LOG_ROLLING, shouldCheckSize, rotateIfNeeded } from "./log-rolling.js";

/** 当前 apply 的身份上下文。缺失即「这次写入没有入口归属」，不是错误。 */
const applyRun = new AsyncLocalStorage();

/**
 * 关键事件的镜像出口：宿主日志面板那一侧由 ./host-logger.js 安装。
 *
 * 镜像只拿已序列化好的行，不参与落盘判定：镜像失败不影响日志，日志失败也不影响镜像。
 * 这里保留一个可替换的函数而不是直接 import 宿主层，是为了不让日志层认识 Cordis。
 */
let diagMirror = null;

/**
 * 安装/摘除镜像。传非函数即摘除。
 *
 * @param {((event:string, row:object) => void)|null} fn
 */
export function setDiagMirror(fn) {
  diagMirror = typeof fn === "function" ? fn : null;
}

/**
 * 开一个新的一次性标识：一次 apply 一个值，diag 与 audit 两侧靠它互相指回。
 *
 * 形状与审计落账那边自生成的完全一致（时间戳 + 短随机段），所以两轨的 runId
 * 可以并排读、也可以直接当同一个键 join。生成器只此一处，免得十个入口各写一遍
 * 而某一天只有九个跟着改了格式。
 *
 * @param {Date} [start] 观测起点，缺省取当前时刻
 * @returns {string}
 */
export function newApplyRunId(start) {
  const at = start instanceof Date ? start : new Date();
  return `apply-${at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomUUID().slice(0, 4)}`;
}

/**
 * 在一段身份里执行 fn：入口只声明「我是谁」，不再往下传参。
 *
 * 必须把 fn 的返回值**原样 return、原样 await**：漏掉 return 或 await，异步上下文会在
 * fn 的第一个 await 处提前退出，后续事件就没有身份了。测试的红灯判据正对着这一条。
 *
 * @template T
 * @param {object} identity 身份字段，形如 `{entry:"http", runId:"apply-…", sealed:true}`
 * @param {() => T} fn 真正的 apply 调用
 * @returns {T}
 */
export function withApplyRun(identity, fn) {
  return applyRun.run(Object.freeze({ ...identity }), fn);
}

/** 当前身份（没有上下文时返回 null）。给「同一次 apply 在 audit 侧也要用同一个 runId」取用。 */
export function currentApplyRun() {
  return applyRun.getStore() || null;
}

/** 单个日志文件的滚动规格与动作只在 ./log-rolling.js 一处定义。 */
let writeCount = 0;

function disabled() {
  const raw = String(process.env.DSH_PURGE_LOG ?? "").trim().toLowerCase();
  return raw === "0" || raw === "off" || raw === "false" || raw === "no";
}

/** 日志目录：环境变量给的路径优先，其次 DSH_HOME，其次临时目录。 */
function logDir(dshHome) {
  const forced = String(process.env.DSH_PURGE_LOG_FILE ?? "").trim();
  if (forced) return { file: forced, dir: path.dirname(forced) };
  const home = String(dshHome || process.env.DSH_HOME || "").trim()
    || path.join(os.homedir(), ".dsh");
  return { file: path.join(home, "dsh-purge", "logs", "diag.jsonl"), dir: path.join(home, "dsh-purge", "logs") };
}

/**
 * 当前日志文件路径（不创建目录，纯计算）。
 * 给 CLI 打印「日志写到哪」用，也让使用者在报告问题时能一次给对文件。
 *
 * @param {string} [dshHome] 宿主数据目录；省略时按环境变量与用户目录推断
 * @returns {string}
 */
export function diagLogPath(dshHome) {
  return logDir(dshHome).file;
}

/**
 * 写一条诊断事件。
 *
 * 值一律转成字符串，换行压成空格：日志是给人 grep 的，多行会把一条事件切成几条。
 *
 * @param {string} event 事件名，形如 `apply.start` / `apply.patch`
 * @param {object} [fields] 附加字段
 * @param {string} [dshHome] 宿主数据目录，决定日志落点
 * @returns {string} 实际写入的路径；被关闭或写失败时返回空串
 */
export function diagLog(event, fields = {}, dshHome) {
  if (disabled()) return "";
  try {
    const { file, dir } = logDir(dshHome);
    fs.mkdirSync(dir, { recursive: true });
    // 每 128 次写才 stat 一次大小；阈值与保留代数由 ./log-rolling.js 统一给出。
    if (shouldCheckSize(++writeCount, LOG_ROLLING)) rotateIfNeeded(file, LOG_ROLLING);
    const row = { ts: new Date().toISOString(), event: String(event || "") };
    for (const key of Object.keys(fields || {})) {
      const value = fields[key];
      if (value === undefined || value === null) continue;
      row[key] = typeof value === "string" ? value : String(value);
    }
    // 身份在 fields 之后合并：调用方显式给的字段优先，上下文只补空缺，
    // 免得同一行里出现两个互相矛盾的 entry。序列化之前补，JSONL 形状不变。
    const amb = applyRun.getStore();
    if (amb) {
      for (const key of Object.keys(amb)) {
        if (row[key] === undefined) row[key] = String(amb[key]);
      }
    }
    // 镜像拿的是补完身份的行；它自己吞掉所有异常，不会影响下面这次落盘。
    if (diagMirror) {
      try {
        diagMirror(row.event, row);
      } catch {
        // 宿主日志面板不可用时只丢镜像。
      }
    }
    const line = `${JSON.stringify(row)}\n`;
    fs.appendFileSync(file, line, "utf8");
    return file;
  } catch {
    return "";
  }
}

/**
 * 写一条错误事件，附带 message / code / stack。
 *
 * 单独一个入口是为了保证三样东西不会漏：错误码（区分「版本门禁拒绝」与「代码 bug」）、
 * 消息、以及栈的前若干行 —— 少任何一样，远程就只能靠猜。
 *
 * @param {string} event 事件名，形如 `apply.fail`
 * @param {unknown} error 任意抛出物（Error / 字符串 / 对象）
 * @param {object} [fields] 附加字段
 * @param {string} [dshHome] 宿主数据目录
 * @returns {string} 实际写入的路径；被关闭或写失败时返回空串
 */
export function diagError(event, error, fields = {}, dshHome) {
  const err = error && typeof error === "object" ? error : { message: String(error ?? "") };
  const stack = String(err.stack || "").split("\n").slice(0, 8).join(" | ");
  return diagLog(event, {
    ...fields,
    error: String(err.message || err || ""),
    code: String(err.code || ""),
    stack,
  }, dshHome);
}
