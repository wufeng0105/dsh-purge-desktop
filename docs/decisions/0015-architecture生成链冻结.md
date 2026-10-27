# 0015. architecture 生成链冻结：输入含宿主路径，产物不再重跑

> 一句话：架构产物冻结：输入含宿主绝对路径不入库，生成器退役。

- 状态：已接受（2026-10-26，Q-CLEAN-2 拍板）
- 关联：`architecture/README.md`；`scripts/gen-architecture.mjs`；`docs/decisions/0012-color-map退役与规则留档.md`
- 分工：本文留冻结的取舍；产物变更规则以 `architecture/README.md` 为准，补丁行为以 `lib/patch/table.js` 为准。

## 背景

`architecture/patches.yaml` 与 `architecture/ui-tree.yaml` 一直由 `scripts/gen-architecture.mjs` 整份重写。生成器的输入是 `.tmp-repair/clean-host.json`（宿主安装树实测快照）与 `.tmp-rebuild/*.json`（度量产物）：前者实测 38,698 字符，含 **98 条 `C:\...` 绝对路径**；两个目录都被 `.gitignore` 忽略，干净 clone 拿不到，也无法从仓库内容重建。

Q-CLEAN-2 拍板的口径是「能快照就快照（脱敏、去绝对路径），输入过大或含宿主路径则冻结产物并退役生成链」。实测结论是**两条快照路都不成立**：

- 脱敏入库：路径是生成器定位宿主文件的一部分，抹掉后生成不出同一份产物，快照只剩形式；
- 原样入库：把宿主绝对路径写进仓库，违反「仓库不保存宿主路径」的约定。

因此选择冻结。这不是删除生成器：逻辑保留，标退役，供以后考古。

## 决策

1. `architecture/patches.yaml` 与 `architecture/ui-tree.yaml` 为**冻结产物**：不再重跑生成器，不补 `architecture/inputs/` 快照。
2. `scripts/gen-architecture.mjs` 顶部加 `@deprecated` 说明，**逻辑与输出路径一律不改**；不删除脚本。
3. 补丁行为变化只走 `lib/patch/table.js` + 新决策；`patches.yaml` 不手改来「修正结论」。
4. `ui-tree.yaml` 随宿主 UI 事实变化时，手改产物并写新决策留痕，评审看 diff。
5. `architecture/audit.schema.json` **不在冻结范围**：它不是生成物，仍随 `lib/audit/vocabulary.js` 与 `AUDIT-2` 维护，`test/audit-vocabulary.test.mjs` 锁集合相等。
6. `architecture/README.md` 记录冻结范围、原因与变更路径，作为本目录的入口说明。

## 后果

正面：仓库不再保存宿主绝对路径，也不会出现「生成器在干净 clone 上必然失败」的假可复现；两份产物有明确的唯一权威与变更路径。

代价：失去生成器的机械兜底。宿主升级导致 UI 树或补丁落点变化时，只能手改产物 + 评审 + 新决策；`AGENTS.md` 里的生成链命令由 C5 清单交给用户处理（本决定不改 `AGENTS.md`）。

## 判据与载体

- `git diff --stat -- architecture` 只允许新增 `README.md`；两份 yaml 的 sha256 与 HEAD 相同（本决定的验收判据）。
- `scripts/gen-architecture.mjs` 头部有 `@deprecated`，且文件逻辑与 HEAD 逐字相同（除说明段）。
- 仓库内不出现 `.tmp-repair/` / `.tmp-rebuild/` 的入库文件；输入只在本地草稿区。
- `architecture/README.md` 与本文互指；`docs/文档索引.md` 登记两者。
