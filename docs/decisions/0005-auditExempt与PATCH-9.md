# 0005. auditExempt 标记与 PATCH-9：migration-only 是「不适用」不是「缺失」

> 一句话：审计不适用要在表侧显式标记、不计分母、单独列示，不许静默消失。

- 状态：已接受（2026-10-24 指挥会话裁决，WP3 落地）
- 关联：`PATCH-9`；`docs/约束索引.md`
- 分工：本文留历史取舍；现行规则以 `docs/约束索引.md` 为准。

## 背景

audit v2 的完备性判据（roadmap 适应度函数的装机探针项）要求「正常 apply 后记全」。WP3 第一次远程复跑时对账差 3 行：响应 `audit.rows=89`，JSONL 里实落 86 条文件事件。定位到 id 21 `BASH_TIMEOUT_RESTORE`——它是 migration-only 补丁，pattern 只匹配本插件旧版留下的痕迹，干净现场没有可复现证据。这类补丁不落事件是设计使然，但 `auditCounts` 照数它的行，「行数 = rows」的对账永远差它一笔。

## 决策

2026-10-24 裁决：id21 的无证据属**审计不适用**，不是记录缺失。落地四件事：

1. 表侧加机器可读标记 `auditExempt: true`（REPO-1 字节精确编辑，diff 3+/0−），适用条件仅一种——pattern 只匹配本插件旧版痕迹的 migration-only 补丁；全表现仅 id21（id 6/7/15/16 的 marker 在 replacement 级内联，不属此类）。
2. 带标记补丁不产生审计事件、不进 `completeness.patches` 分母与 `unresolved`、不计入 `auditCounts` 的 rows / files / represented。
3. 豁免必须可见：`apply-result` 的 `detail.exempt` 按层单独列示（恒写数组），不许静默消失。
4. 登记 `PATCH-9` 写死适用条件与「新增适用对象须先改写本条」——防滥用靠成文条件，不靠自觉。

## 后果

正面：F-6① 行数对账闭合；「不适用」与「缺失」在数据形态上可区分，评审时不用再逐条猜。schema 的 detail 描述与测试同步。

代价：表侧多一个字段、report.js 多一处传播与列示逻辑；滥用风险（把普通补丁标成 exempt 逃分母）由 PATCH-9 的适用条件兜底——条件本身要人守，这是显式登记的代价。
