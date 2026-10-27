# 0007. audit 完备性口径三轮迭代与探针固化

> 一句话：装机完备性判据经三轮口径迭代定稿，手工断言固化为可重复脚本。

- 状态：已接受（2026-10-24）
- 关联：`AUDIT-1`、`PATCH-9`；`scripts/check-audit-completeness.mjs`
- 分工：本文留历史取舍；现行规则以 `docs/约束索引.md` 为准。

## 背景

roadmap 的装机探针判据从提案到远程真机验证通过，口径迭代三轮：

1. 原始三项——JSONL 行数 = 响应 `audit.rows`、三层各有 `apply-result`、`detail.completeness` 三项全真。
2. 第一轮复跑差 3 行 → 0005：id21 migration-only 判「不适用」，exempt 不计分母但 `detail.exempt` 单独列示（判据从三项扩为四项）。
3. 第二轮复跑安装实为 "Already up to date"——pnpm 同版本号复用 store 旧副本，新 tgz 没被消费（运维教训，非口径问题），remove→add 重来。
4. 第三轮复跑仍差 3 行 → 0006：兼容类行两边同判据不落账，口径闭环。
5. 第四轮四条全过（86 = 86、三层结论齐、completeness 全真、exempt=[21] 仅 code 层）。

## 决策

1. 判据定稿为：文件事件数 = `audit.rows`、三层各有且仅有一条 `apply-result`、completeness 三项全真、`detail.exempt` 与补丁表逐层一致且 exempt 补丁不落事件、v2 三字段齐全、`audit.unresolved` 为空。
2. 固化为 `scripts/check-audit-completeness.mjs`：远程部分（部署、apply、取回产物）留作半自动，断言部分可重复——仓库里跑脱敏夹具（`test/audit-completeness.test.mjs`，含六种篡改红灯），装机树上跑真产物。脚本从自身位置解析补丁表，仓库与装机树（`~/.dsh/dsh-purge` 同布局）都能跑。
3. 运维教训入档：同版本号重复 add 会复用旧副本（必须 remove→add）；shipped 验证的 grep pattern 必须函数级唯一（本轮撞过同形语句误判）。

## 后果

正面：一次性手工断言变成判据载体（AUDIT-1）；CI 里夹具保证判据不腐坏，远程半自动只需「装、apply、取回、跑脚本」。

代价：夹具与补丁表有一处硬耦合——code 层 `exempt=[21]` 必须等于表里 `auditExempt` 的现行集合，表侧改标记时测试会红，逼着同步改夹具。这是有意的：豁免变更必须留一次显式动作。
