# architecture 冻结说明

> 一句话：架构产物冻结，生成器退役；输入含宿主绝对路径，不入库、不可复跑。

本目录有三份文件，来源不同，冻结范围也不同：

| 文件 | 来源 | 现状 | 变更路径 |
| --- | --- | --- | --- |
| `patches.yaml` | `scripts/gen-architecture.mjs` 整份重写 | **冻结** | 补丁行为以 `lib/patch/table.js` 为准，产物不手改 |
| `ui-tree.yaml` | 同上 | **冻结** | 只随宿主 UI 事实变更，且要新决策留痕 |
| `audit.schema.json` | 手写契约 | 未冻结 | 随 `lib/audit/vocabulary.js` 词表与 `AUDIT-2` 维护 |

## 为什么冻结

生成器要读 `.tmp-repair/clean-host.json` 与 `.tmp-rebuild/*.json`。前者是宿主安装树的实测快照：38,698 字符里有 98 条 `C:\...` 绝对路径；两个输入目录都被 `.gitignore` 忽略，干净 clone 拿不到。把输入脱敏后入库也换不来「可复跑」——路径是宿主定位的一部分，抹掉就生成不出同一份产物；原样入库则违反「仓库不保存宿主路径」的约定。两条路都不成立，于是按 Q-CLEAN-2 选择**冻结产物、不补输入快照**。

## 冻结后的规则

- **不重跑** `node scripts/gen-architecture.mjs`。脚本保留但已标退役（`@deprecated`），只作考古，不再产出。
- **不手改**两份 yaml 来「修正结论」。`patches.yaml` 的补丁行为以 `lib/patch/table.js` 为唯一权威；要改补丁先改表，再走新决策。
- `ui-tree.yaml` 对应宿主 UI 事实；宿主升级导致树变化时，手改产物并写一篇新决策留痕，评审看 diff。
- `audit.schema.json` 不是生成物，仍随审计词表维护；`test/audit-vocabulary.test.mjs` 锁它与 `EVENT_NAMES` 集合相等。
- 冻结的判据是 git：任何对两份 yaml 的改动都必须是一次显式提交，不再有「重跑生成器」这条后门。

决策正文见 `docs/decisions/0015-architecture生成链冻结.md`。
