# 0004. verify 集合定义：本地 = CI − codegen drift

> 一句话：本地 verify 集合等于 CI 减 codegen drift。

- 状态：已接受（2026-10-24 拍板）
- 关联：`CI-4`；`AGENTS.md` 硬门禁表
- 分工：本文留历史取舍；现行规则以 `docs/约束索引.md` 为准。

## 背景

本地 `npm run verify` 与 CI verify.yml 曾是两套集合：CI 独有 tsc --noEmit、check-ui-tree 与 codegen drift，「本地全绿 ≠ CI 会绿」。这不是理论风险——P0-5 统一集合时实测发现 HEAD 上带着 3 处 JSDoc 注解错位（`lib/host/` 两文件），本地从未跑过 tsc 所以一直没暴露。同时 release.yml 只跑 verify 的子集，与当时约束索引 CI-4 写的「复用同一套」不符。

## 决策

2026-10-24 拍板：

1. 本地 verify 的步骤集合 = CI verify.yml 的步骤集合 − codegen drift。codegen drift 要求干净 git 树，本地工作区常不可满足，保持 CI 独有并在 `AGENTS.md` 写明。
2. 本轮补齐两侧：check-ui-tree 与 tsc --noEmit 进本地链（P0-5）；审计日志落盘冒烟 `scripts/audit-smoke.mjs` 并入本地链末尾并在 CI 加同名步骤（P1-5）。此后再往任何一边加门禁，必须两边同步加。
3. 发布门禁是 verify 全量的子集（`CI-4` 措辞法）：release.yml 跑 test + arch + 语法 + 更新通道 + release-notes，不重复整洁门禁与类型检查——tag 由过审 commit 打出，tag 前的 push 已跑过 verify 全量，重复只加时长不加保护。

## 后果

正面：本地绿约等于 CI 会绿（除 codegen drift）；「发布即全量再验」的仪式感换成 CI-4 的实况描述，文档不再说谎。

代价：verify 步数增至 14 步，时长增加约 4 秒（tsc 与 check-ui-tree 合计 3.5 秒内、audit-smoke 秒级）——它本来就不是极简的；两套集合再漂移的回归护栏（断言 npm verify 与 verify.yml 步骤集合的映射）已列为适应度函数提案，S3 优化固化时落地。

> 后续（2026-10-24，S3）：已落地为 `test/workflows.test.mjs` 的声明式映射断言（`CI-5`）；同时退役了 CI 侧两个独有 bundle 步骤让映射严格成立，取舍见 `docs/decisions/0009-门禁落地与CI集合收敛.md`。
