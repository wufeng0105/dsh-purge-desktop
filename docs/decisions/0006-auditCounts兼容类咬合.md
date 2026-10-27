# 0006. auditCounts 与 recordApply 兼容类咬合：rows 与实落对齐

> 一句话：同一判据两边同用，兼容类行两边都不落账。

- 状态：已接受（2026-10-24，WP3 续轮 commit 7f038ff）
- 关联：`PATCH-9`；`lib/audit/report.js`
- 分工：本文留历史取舍；现行规则以 `docs/约束索引.md` 为准。

## 背景

0005 落地后远程复跑仍差 3 行。定位到兼容类补丁（id 40/47/49，层名折成空串、折不进 prompt / code / tool 三档）：`recordApply` 的既有判据（`LAYER_ORDER.includes(row.layer)`）本来就不落它们的事件，而 `auditCounts` 原先照数其行。这是 0005 裁决未列名的同域遗漏——裁决意图「rows 与实落对齐」在兼容类行上还有洞。

## 决策

执行中发现的同域洞，按裁决意图处置而非开新方向：`auditCounts` 增加同一判据——`LAYER_ORDER` 之外的行不计 rows / files / represented。两处用同一个表达式咬合，不是两套逻辑各自维护。roadmap 注记已说明此为非方向变更的遗漏细节。

## 后果

正面：F-6① 彻底闭合（远程终轮 86 = 86）；「口径写死：一行 = 一条补丁的一个目标文件」在三个消费点（recordApply / auditCounts / index.js 注释）一致。

代价：兼容类补丁现在完全不进审计——与 recordApply 既有行为一致，但意味着兼容层的打没打、打没打成，审计里查不到。若将来要给兼容类落「事件层事件」（无 layer 的 compat.* 词表），属新裁决，不在本轮。
