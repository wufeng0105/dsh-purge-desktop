# AGENTS.md

本文件只写两样：**读仓库读不出来的事实**，和**不写就会做错的动作**。目录里有什么、命令怎么拼、数字是多少，翻一遍都能查到或算出来 —— 那些交给指针与门禁。

加一行前先问两句：模型翻一遍仓库能不能自己得出？能就删。这行会不会改变下一次动作？不会就删。通用纪律（语言应答、执行与确认、诚实校准、信息检索、本机代理）沿用个人默认指令，此处不重复。

| 想知道 | 去哪 |
| --- | --- |
| 每个目录放什么、哪几个文件允许超 800 行、名字怎么起 | `docs/布局约定.md` |
| 每条约束的编号、一句话内容、判定载体与未覆盖缺口 | `docs/约束索引.md` |
| 仓库有哪几份文档、各回答什么问题 | `docs/文档索引.md` |
| 全组共用的名字与主线（改名字先改这里） | `docs/术语账本.md` |

## 三个不同的东西

同一台机器上同时存在三份，混了就错：

| 东西 | 位置 | 身份 |
| --- | --- | --- |
| 本仓库源码 | 仓库根 | 唯一改造对象，以 `package.json` 版本与 git HEAD 为准 |
| 机器上装的插件 | `<DSH_HOME>/dsh-purge`（默认 `~/.dsh`；运行期状态，目录内容会变，审计目录首次写入才创建） | 某次装机留下的运行期状态，**不能用来描述本仓库** |
| 宿主 Harness | `<Harness>/resources/app.asar` 或解包后的 `resources/app` | 兼容目标，只取「有哪些原生能力」 |

- 补丁归宿以干净副本 `npm run probe:clean-host` 为准；`npm run probe:host` 测的是装机树，不作依据。
- 探针只读：跑完 `readonly.changed` 与 `readonly.mtimeChanged` 必须为空。
- 不许写「半生效」这类运行期结论，判据是一次完整退出重启前后的 marker 与加载记录。

## 远程验证服务器

- 真机验证不在本机做：构建后部署到那台远程测试机（Windows Server 2022 + DSH 桌面端 + 已装本插件）。它是**纯测试机——不备份、不保留状态，以最快测试为原则**：直接装新版，失败卸载重来。

## 大文件：先符号、后片段

改代码前先查图，别 grep 满仓、别整读大文件。`codegraph` 在 PATH：`query <词根> -l 20` 定位 → `node <symbol>` 看源码与调用链 → `node -f <文件> --offset <起始行> --limit <行数>` 取片段 → `impact <symbol> -j` 看波及面 → `affected <改过的文件…>` 拿要跑的测试；参数细节用 `codegraph --help`。

几条反直觉的：

- `client.js` 是构建产物：由 `npm run build:client` 整份重写，**勿手改**。
- `lib/patch/table.js` 是补丁数据，受 `REPO-1` 行尾冻结，只 edit 精确匹配改写。
- `lib/redteam/client.js` 是装配进 `client.js` 的界面片段，本身不是 ES 模块。
- `desktop` 是**文件** `lib/desktop.js`，不是目录；**`lib/hostfs/` 不存在**，别照任何提到它的东西建目录（`tsconfig.json` 的 `include` 只许列真实存在的目录，`test/workflows.test.mjs` 会拦）。

## test/ 的发现规则

`npm test` **递归执行 `test/` 下每个 `.js` / `.mjs`**，没有 fixtures 豁免：

- `test/` 下的辅助文件必须顶层零副作用。故意坏掉的负向夹具只能坏在**类型层**，不能坏在加载期（顶层 `throw`、重复 `let`、解析不到的 `import`），那会让整轮崩。
- 别把 `npm test` 改成 `node --test "test/*.test.mjs"`，那会静默收窄发现范围。

## 生成链：产物只写不读

- 生成物 `client.js`、`lib/asset-table.js` **入库提交**（与「不提交构建产物」的通用做法相反），只由 `npm run build:client` / `npm run embed-prompt` 产出；两条链都要求连跑幂等，判据是两次 sha256 逐字节相同。
- `architecture/patches.yaml` / `architecture/ui-tree.yaml` 是**冻结产物**（`docs/decisions/0015-architecture生成链冻结.md`）：输入含宿主绝对路径、不入库。`scripts/gen-architecture.mjs` 已退役，**不要重跑**；改 yaml 要先推翻 0015，并解决输入脱敏与可复现。
- 客户端不是独立前端：片段是被文本装配进 `client.js` 的正文，里面没有 import。改 `lib/client-src/**` 后一律跑 `npm run build:client`，**别手改 `client.js`**，下次 build 会整段覆盖。
- 新增片段四步缺一不可：文件头块注释说明为什么存在、正文两个 tab 缩进、`shell.js` 加整行占位符、`SLOT_FILES` 登记。缺了 build 直接报错（这是故意的）。
- **`node --check client.js` 通过什么都不代表**：语法全绿的产物照样能一加载就 `ReferenceError`。验产物跑 `node --test test/client-evaluates.test.mjs`。

## 硬门禁

全量是 `npm run verify`。本地没有可运行入口 —— 插件由宿主加载，验证只靠门禁与装机探针。verify 链与 `.github/workflows/verify.yml` 逐条对齐：**本地 = CI − codegen drift，codegen drift 是唯一的 CI 独有项**（它要干净 git 树，本地常不可满足）。往任何一边加门禁必须两边同步加，`test/workflows.test.mjs` 拿声明式全表断言这条。对齐是**步骤级**的：同名步骤里 CI 还能多几条命令（`Syntax check` 就多查一个 `lib/reapply.js`），本地全绿不等于 CI 全绿。

- `dead` 与 `patch-guard` 是硬门禁，不带 `|| true`：knip 输出必须为空；ast-grep 只许有已登记的债务 warning，上限在 `test/rules-ratchet.test.mjs` 的 `CEILING`。
- `npm run check:artifact` 与 `npm run check:lib-names` 的退出码是 **0 通过 / 1 命中 / 2 环境错误 —— 2 不算通过**。
- 文档里的手抄数字（版本徽章、`dshTarget` 徽章、约束编号上限）由 `test/docs.test.mjs` 守着：**改数字先改实测**。**行数、字节数、文件数一律不进文档**，也不设断言 —— 那些交给 `scripts/check-file-roles.mjs`（超 800 行）与 CI 的 codegen drift（产物是否漂移）。

## 发版前人工门

桌面链路没有自动化：`verify` 只覆盖仓库里的文件与契约，管不到「宿主加载插件之后」；`.github/workflows/release.yml` 里也没有 Electron 步骤。发版前把下面五项逐项点完，任一项的「应看到」没出现就不发。

**五项都在远端测试机上做，不在开发机做。** 那台是纯测试机：不备份、不保留状态，装坏了就卸载重装（下载目录里留着官方安装包，能还原到干净宿主）；开发机被点坏，损失的是正在用的环境。

- [ ] **启动** —— 双击桌面端。应看到：主界面正常打开；设置左栏多出 `dsh-purge` 一节，页头状态是「已生效」，页脚「上次应用」不是「从未」。
- [ ] **点面板** —— 点侧栏 `dsh-purge` 图标。应看到：未授权时先弹授权窗，确认后主区铺开演练台（资产 / 技能 / 环境等页签）；不是空白页，也不是「演练台组件没有随产物加载」那条说明。
- [ ] **应用** —— 对话里发 `/purge apply`（界面里没有「应用」按钮，补丁在启动时已经自动应用过一次，这一步是把那条路径手动重放）。应看到：回复是应用结果而不是报错；回到设置节，页头仍是「已生效」，「补丁」分节里没有失败或「没对上」的条目。
- [ ] **重启** —— 点页脚「重启宿主」，或完全退出（含托盘）再打开。应看到：桌面端自己重新打开；设置节状态直接是「已生效」，不再挂「需重载」。
- [ ] **卸载** —— 设置节 → 危险操作 →「卸载插件」→「确认卸载」。应看到：先出现「已卸载并还原，正在重启桌面应用…」；重启后设置里没有 `dsh-purge` 一节、侧栏图标消失，宿主文件回到原版。

五项全勾才算过；更新后又改过代码，就整条链重跑一遍，不做局部复验。

## 工具协作

- **版本库事实**：提交只显式 `git add` 本包碰过的文件，**不用 `git add -A` / `git commit -a`**（工作区里的未跟踪目录会被整棵提交进去；`.codegraph/` 自带忽略规则无需处理）。生成物入库规则见上一节。

## 注释规范

范围是 `lib/**`、`scripts/**`、`test/**`、`bin/**`。门禁判据 `A`–`E` 由 `node scripts/check-comments.mjs` 守着；脚本覆盖不到的靠下面几条：

- 术语以 `docs/术语账本.md` 为准：一个东西一个名字，禁用的同物异名在那张表里。
- 结论要自包含，禁止坐标式引用（「见某文档 §几.几」）与无定义来源的黑话编号（`S4-2`、`D3` 这类）：展开成一句话，或换成 `docs/约束索引.md` 的现行编号。
- 块注释写「为什么存在」，不写「这行在干嘛」；不复述代码；不用碎裂的空 `//` 拼块。

例外：`lib/patch/table.js` 的补丁数据保持现状（那是数据不是注释），只能 edit 精确匹配改写 —— 别跑 `git add --renormalize` 这类归一动作。
