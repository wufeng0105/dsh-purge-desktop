# log-criteria 夹具（全部合成）

`docs/log-criteria.json` 的 `fixture` 所指的这组文件**全部是合成夹具**：
时间戳、runId、摘要都是造的，不含任何真机路径、主机名或账号。

为什么补丁表那几栏写成 `total: 3`：这一组要判的是 `recorded` 的自洽关系，
不是拿真实补丁表当分母；`total` 与真实表条数不同时，`audit check` 会记一条
「分母不适用」的信息项并按自洽关系继续判 —— 夹具因此不会随补丁表增删而漂。
唯一的例外是 `closed-v3.jsonl` 的 `exempt: [21]`：`scripts/check-audit-completeness.mjs`
要求它逐层等于补丁表的 `auditExempt`（21 号是 migration-only）。

`filtered-v3.jsonl` 与 `filtered-missing.jsonl` 是**过滤 apply** 的两态：补丁表 3 条、
report 只含 2 条（`selected: [1,2]`）。前者 `recorded: 2`、自洽，`audit check` 必须 exit 0；
后者 `selected: [1,2,3]` 但 3 号既没有文件行也没进 `unresolved`，必须 exit 1 并点名补丁 3。
它们锁的是「分母是 `selected`，不是补丁表全量」—— 拿全表当分母会把前者判成静默丢失。

`aborted-v3.diag.jsonl` + `aborted-dir/2026-10-26.jsonl`（0 行的审计文件）锁的是**反向对账的
「没有逐补丁判定」边界**：诊断轨有 `apply.start` / `apply.hosts` / `apply.end`，但一条
`apply.patch` 都没有、`apply.end.total` 为 0 —— 报告为空所以不落审计（设计边界），
`audit check --dir --diag` 必须 exit 0、`missingAudit=0`，并打一条「没有逐补丁判定」信息项。
`v3-cli.diag.jsonl` 里另一个 `…-ab0d` 轮是同一形态（`selected: "0"` 的过滤后空轮），
与 `…-cccc`（有 `apply.patch`、审计 0 行）放在同一份诊断轨里：前者不判红、后者必须红。
两种轮的时间戳都落在 UTC 与 +08:00 同为那一天的区间内 —— 日期判据按本地时区取日期，
夹具不能只在某一个时区里成立。
