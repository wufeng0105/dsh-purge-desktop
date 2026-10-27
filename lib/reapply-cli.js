/**
 * lib/reapply-cli.js — 重启脚本用的最小入口：跑一次回写，用退出码报结果。
 */
import { reapplyInstalled } from "./reapply.js";
import { newApplyRunId, withApplyRun } from "./diag-log.js";

// 子进程拿不到父进程的异步上下文（跨进程不共享），身份只能在这里重新声明；
// 声明成自己而不是 reapply，才分得清「宿主内重打」与「重启脚本重打」两种事故。
const result = await withApplyRun(
  { entry: "reapply-cli", runId: newApplyRunId() },
  () => reapplyInstalled(),
);
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.ok ? 0 : 1);
