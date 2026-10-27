/**
 * lib/host-logger.js — 把关键诊断事件镜像进宿主日志面板的适配层。
 *
 * 接口取自宿主 Cordis 的 `ctx.logger`：它是可调用服务，`ctx.logger(name)` 返回具名
 * logger，带 `info` / `warn` / `error` / `debug` 四个方法（宿主 `src/logger.ts` 的实现）。
 * 拿不到这个服务时什么都不做 —— 适配层只转发已有事实，不另造一条记录通道。
 *
 * 只镜像**关键事件**：一轮 apply 的起止与门禁拒绝、还原的起止、审计写盘失败、启动就绪。
 * 逐条 `apply.patch` 不镜像：那是几十行噪声，诊断轨才是它的归宿。镜像失败不影响落盘，
 * 所以这里每个调用点都自带 try。
 */
import { diagLog, setDiagMirror } from "./diag-log.js";

/** 值得出现在宿主日志面板里的事件。 */
const MIRROR_EVENTS = new Set([
  "apply.start",
  "apply.end",
  "apply.gate.reject",
  "apply.audit.fail",
  "revert.start",
  "revert.end",
  "startup.ready",
]);

/** 失败档走 warn：宿主日志面板按级别分色，全用 info 等于看不出出了事。 */
const WARN_EVENTS = new Set(["apply.gate.reject", "apply.audit.fail"]);

/** 摘要里值得带出的字段：定位一轮足够，不搬路径与证据正文。 */
const SUMMARY_FIELDS = [
  "entry", "runId", "patches", "selected", "hosts", "total", "applied", "already",
  "failed", "notFound", "missingFile", "pendingRestart", "asarSealed", "files", "errors",
  "pending", "version", "patchesMatch", "appliedStamp", "rejected",
];

function summaryOf(row) {
  const parts = [];
  for (const key of SUMMARY_FIELDS) {
    const value = row?.[key];
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${key}=${String(value)}`);
  }
  return parts.join(" ");
}

/**
 * 取宿主 logger。
 *
 * 先按 Cordis 的具名形态取（`ctx.logger("dsh-purge")`），再兼容「ctx.logger 本身就是
 * 一个 logger」的旧形态。两种都不是时返回 null —— 调用方据此保持原行为。
 *
 * @param {object|null|undefined} ctx 插件上下文
 * @returns {{info?:Function, warn?:Function, error?:Function}|null}
 */
export function hostLoggerOf(ctx) {
  try {
    const service = ctx?.logger;
    if (typeof service === "function") {
      const named = service("dsh-purge");
      if (named && typeof named.info === "function") return named;
    }
    if (service && typeof service.info === "function") return service;
  } catch {
    // 宿主 logger 服务不可用/未就绪：不镜像，行为与加这一层之前相同。
  }
  return null;
}

/**
 * 安装镜像。返回是否装成，调用方可以把它记进启动日志（不装也合法）。
 *
 * **装没装成必须留一条自己的记录**：宿主日志面板里有没有 `[dsh-purge]` 行，一半取决于
 * 镜像装没装上，另一半取决于宿主自己落不落盘。没有这条记录时，两种情形在真机上长得
 * 一模一样 —— 查的人只会得到「找不到」，而找不到不知道是「没装」还是「装了但宿主不写」。
 *
 * @param {object|null|undefined} ctx 插件上下文
 * @param {{dshHome?:string}} [options] 诊断轨落点（不给就走默认主目录）
 * @returns {{installed:boolean}}
 */
export function installHostLogger(ctx, options = {}) {
  const dshHome = String(options.dshHome || "").trim() || undefined;
  const logger = hostLoggerOf(ctx);
  if (!logger) {
    try {
      diagLog("host.logger", { installed: false, reason: "ctx.logger 不可用" }, dshHome);
    } catch { /* 记录本身失败不许影响启动 */ }
    return { installed: false };
  }
  setDiagMirror((event, row) => {
    if (!MIRROR_EVENTS.has(event)) return;
    try {
      const level = WARN_EVENTS.has(event) ? "warn" : "info";
      const method = logger[level];
      if (typeof method !== "function") return;
      const line = `[dsh-purge] ${event} ${summaryOf(row)}`.trim();
      // 格式串与参数分开传：事件字段里可能出现 %，当格式串会吞字符。
      method.call(logger, "%s", line);
    } catch {
      // 宿主日志面板失败不许影响插件；诊断轨那一份已经写下去了。
    }
  });
  try {
    // 装成了也要记：真机上「有这条且 installed=true，却没有 [dsh-purge] 行」才说明
    // 是宿主不落盘（而不是插件没接线）—— 这正是那一档最常见的误判。
    diagLog("host.logger", { installed: true, events: MIRROR_EVENTS.size }, dshHome);
  } catch { /* 同上 */ }
  return { installed: true };
}

/** 摘掉镜像（插件卸载 / 测试收尾用）。 */
export function clearHostLogger() {
  setDiagMirror(null);
}
