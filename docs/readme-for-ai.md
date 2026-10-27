# 给 AI 的日志读法（dsh-purge）

> 一句话：只读日志就能答出「谁触发的、卡在哪、下一步试什么」。

> 读者假设：你**没读过**本仓库，手上只有这台机器跑出来的日志文件。本文不要求你读源码，只要求你能按文件名、按字段名找到证据，并且知道**去哪里**找下一份证据。
> 本文只说「怎么读」。日志为什么这样设计，那一轮的设计稿已随改造轮的历史文档整组退役，需要时从 git 历史取回（提交信息里搜 `audit-log-design`）。
> 本文里出现的 `<DSH_HOME>` / `<宿主根>` / `<系统临时目录>` / `<仓库根>` 都是占位符，按实际机器替换；以 `lib` / `bin` / `test` 开头的相对路径就是仓库里的真文件。

---

## 0. 四步走到结论

1. **先判完整性**：`node bin/dsh-purge.js audit check --dir <审计目录>`，其中 `<审计目录>` 填**含 `*.jsonl` 的那层目录本身**（如 `…\dsh-purge\audit`，不是它的上一层 `…\dsh-purge`）；手上只有一份日志时改用 `--jsonl <文件>`。退出码不是 0 就先别解读内容 —— 残缺的日志看起来和完整的一模一样。参数怎么填、默认值在哪、三档退出码各是什么，见第 8 节。
2. **找一次 apply**：在 `diag.jsonl` 里找**最后一条** `"event":"apply.start"`，抄下同一行的 `runId`。用这个值把这次 apply 的**全部**行捞出来（第 4 节给了命令）。
   **为什么是最后一条而不是第一条**：同一份日志里常有好几轮 apply，最早那几轮可能是**旧口径**写的 —— 加字段之前的那一轮，`apply.end` 里根本没有 `pendingRestart` / `asarSealed`，照它往下读会把第 4 步答成「日志里没有这个信息」。取最新那组，或先按 `runId` 分组再挑最新的一组；分组之后每轮的字段齐不齐才是可判的。
3. **判这一轮收尾了没有**：不要看「最后一条是什么」—— 一轮末尾可以有任意多条像收尾的事件，每加一个这条判据就失效一次。看**有没有结束标记**：审计轨是层结论上的 `detail.runEnd`（`audit check` 会打印 `sealed=`），诊断轨是有没有一条 `apply.end`（门禁拒绝那一路是 `apply.gate.reject`）。下一节 Q1 给了完整判法。
4. **看这次改动生效了没有**：`apply.end` 的 `pendingRestart` 说明「这一轮改了文件」；再看它**之后**有没有一条 `startup.ready` 且那条的 `patchesMatch` 是 `true`。两者都有 = 新字节被宿主读进来了；有改动却没有后续 `startup.ready` = 宿主没重启过，磁盘上是新的、跑着的是旧的。第 2.2 节给了完整的两条推论。

结论先写，证据行跟在后面（第 9 节）。**日志里没有的字段一律写「日志里没有这个信息」，不许按常识补。**

---

## 0.5 十个问题：每问看哪几样、什么算例外、答不出来缺什么

**这一节是读法的正文。** 按「你要回答什么」组织，不按字段清单组织 —— 字段会加、会改名、会分世代，问题不会。每一问都按同一模板给三样：**看这几样 / 什么算例外 / 答不出来时缺什么**。字段嵌在答案里，不单独成表；字段的发射点、世代与空值形态见第 11 节（附录 C）。

### Q1 这一轮完整吗（有没有被截断）

- **看这几样**：`node bin/dsh-purge.js audit check --dir <审计目录>` 的一行 `runs: …（收尾 N / 截断 M / 不可判 K）`，以及逐轮的 `closed= sealed= judgeable=`。判据只有一条：**这一轮有没有结束标记**。审计轨的标记是层结论 `detail.runEnd`（落账方写在它这一轮**最后一条**审计行上，写侧见 `lib/audit/report.js` 的 `recordApply`）；诊断轨的标记是**结束事件上的 `runEnd` 字段**：`apply.end`（门禁拒绝那一路是 `apply.gate.reject`）上是 `"engine"`、写审计的四个入口之后补的那条 `audit.recorded` 上是 `"audit"`（写侧见 `lib/core.js` 与 `lib/audit/index.js`）。两处判的都是「**有没有**」，不是「最后一条是不是它」，也不是「`apply.end` 这个事件在不在」—— 事件只是那一档标记的载体。
- **什么算例外**：① 没有标记的那一代判成 `judgeable=false`（不可判），分两档：`v2-entry`（有 `detail.considered` / `expectedRows`、没有 `detail.runEnd`）与更早的行（连分母都没有）—— 那一代日志本来就没有标记，拿新判据判它会把它全判成中断。**不可判不是截断**，不进退出码；② 标记之后的追加行不影响结论：`install.record` 排在 `apply.end` 之后、`audit.recorded` 更后、`cli.apply.done` 不带 `runId`，三种形态都**不算中断**；③ 诊断轨按 `runId` 过滤时，`cli.apply.ensure` / `cli.apply.done` / `cli.invoke` / `cli.apply.begin` 不带 `runId`，捞不到它们是**已知边界**，不是中断。
- **答不出来时缺什么**：某一层本来就没有可落账的补丁、而这一轮正好在它之前被杀 —— 那一层没有文件行，`detail.completeness.layers` 也可能是假。没有标记的那一代只能靠诊断轨的 `apply.start` … `apply.end` 窗口判；有标记的那一代由标记兜住。

### Q2 谁触发的 / 这是哪一次运行

- **看这几样**：审计行自带的 `entry`（`cli` / `http` / `command` / `tool`，本包起逐行都写）与 `runId`；诊断轨的 `apply.start.entry` / `runId`。九个 `entry` 取值见第 5 节。
- **什么算例外**：① `cli.invoke` / `cli.apply.begin` / `cli.apply.done` / `cli.apply.ensure` / `cli.diagnose` **都不带 `runId` / `entry`** —— 要说清「哪一次运行」只能按时间相邻认领（落在同一次 `cli.apply.begin` … `cli.apply.done` 之间）。这是已知边界，不是缺陷；② **世代**：本包之前的 712 行旧审计 `actor` 全是 `host`、且没有 `entry`，而同期诊断轨是 `entry=cli` —— 拿老行回答这一问会把答案带反（老行只说「宿主进程写的」，没说「谁触发的」）。
- **答不出来时缺什么**：审计轨 0 行时只剩诊断轨；诊断轨留 8 代（`.1`–`.8`，约 58 小时），全被滚掉之后这一问才永久查不了。没有 `runId` 的那几个入口（`startup-auto` 等五个不写审计的入口）只能按时间读。

### Q3 这一轮在哪一轨（审计目录里该有什么）

- **看这几样**：审计目录 `<DSH_HOME>/dsh-purge/audit/` 里应有 `YYYY-MM-DD.jsonl`（本地日期）、`README-for-ai.md`（本文的现场副本）与 `cards/`（失败卡）。写审计轨的只有 `http` / `command` / `tool` / `cli` 四个入口；`startup-auto` / `reapply` / `reapply-cli` / `http-restart` 五个**只写诊断轨**。
- **什么算例外**：① 有些轮**本来就只在一轨**：`sealed:true` 的历史轮次里有两轮审计 0 行（那一版 CLI 还不写审计），今天四个入口都写 —— 这两件事不矛盾，区别在世代；② `cards/` 只在「有问题」的轮次才有（判据：任何一层不是 `ok`，或 `unresolved` 非空），**没有卡片不等于没事**；③ `README-for-ai.md` 缺席 = 现场是升级前写下的，或投递失败（去诊断轨看 `audit.recorded` 的 `readme` 字段）。
- **答不出来时缺什么**：诊断轨被滚过之后，「这一轮当初有没有写审计」除了 `audit.recorded` 之外没有别的正向证据。老轮只有一条 `audit.recorded` 而落账成功过 6 轮 —— 那一代只有最后一次写这条事件。

### Q4 这一轮写完审计了吗

- **看这几样**：诊断轨的 `audit.recorded`（成功侧的正向证据：`events` / `skipped` / `unresolved` / `layers` / `readme` / `cards`）与它的对称面 `apply.audit.fail`（写盘失败）。两者都没有 = 这一轮没有走到落账段。
- **什么算例外**：① **世代**：`audit.recorded` 是后加的，老轮「落账成功但没有这一行」是正常的，别读成「没写成」；② `recordApplyRun` 在报告为空时直接返回（门禁拒绝、一条补丁都没打、一台宿主都没找到）—— 那种轮没有审计行，也没有 `audit.recorded`，属设计边界。**反向对账也按这条边界跳过**：诊断轨里有 `apply.start` 与结束事件、却一条 `apply.patch` 都没有（`apply.end.total` 为 0 或空）的轮，审计 0 行只记一条「没有逐补丁判定」信息项，不进 `missingAudit`。
- **答不出来时缺什么**：审计轨 0 行 + 诊断轨也滚过 ⇒ 这一问不可判，只能写「日志里没有这个信息」。

### Q5 这份账滞后多久

- **看这几样**：`runs:` 行末尾的 `lagMs`（= 这一轮最大的 `ts − observedTs`），以及 `audit tail` 末尾的 `lagMs`。
- **什么算例外**：`observedTs` **不是**「观测起点」，实测它是**落账开始时刻**（真机上比同轮 `apply.start` 晚 11.6 秒）。所以 `lagMs` 读作「审计管道自己写了多久」，不能读成「apply 跑了多久」；apply 的耗时看诊断轨 `apply.end.ms`。旧口径行没有 `observedTs`，打印 `（无 observedTs）`。
- **答不出来时缺什么**：两边都没有 `observedTs` 时这一问不可判。

### Q6 动了哪些文件、这些证据怎么读

- **看这几样**：文件层行的 `evidence`：`file`（落到哪个文件）、`marker`（找的字面量）、`hits`（命中几次）、`bytes`（整文件字节数，不是改动字节数）、可选 `offset`（首个命中的 UTF-8 字节偏移，`hits=0` 时没有这个键）、`before` / `after`（两个摘要）。
- **什么算例外**：① `before` / `after` 的「摘要」是 `{sha256, bytes}` 两个键；`already` 那两档两者相等；任一侧为 `null` = 那一侧读不到（留了痕的缺口），**不是缺字段**；② `hits=0` 在 `patch-applied` 上表示「marker 已经在」（不必再插），在 `patch-miss` 上才是真没找到；③ 类型与空值形态不统一：`unresolved` 在审计轨是数组、在诊断轨 `audit.recorded` 里是逗号串（空 = `""`）、在 `apply-result` 里是 `[]`；`skipped` / `cards` 在诊断轨是**字符串数字**（`"1"`）。
- **答不出来时缺什么**：`before` 没采到的轮次，`detail.completeness.files` 只能是假 —— 去查那一轮是不是在「采集 before」之前就失败了。

### Q7 改动生效了吗（要不要重启 / 要不要解封）

- **看这几样**：`apply.end` 的 `pendingRestart` 与 `asarSealed`；它**之后**的 `startup.ready`（`patchesMatch` / `appliedStamp` / `version`）。两条推论：`pendingRestart=true` 且其后有 `startup.ready{patchesMatch=true}` ⇒ **生效**；有改动却没有后续 `startup.ready` ⇒ **没生效**（宿主没重启过）。`asarSealed=true` 且 `pendingRestart=true` ⇒ 连重启也不够，得先换归档（`--unseal`）。
- **什么算例外**：① `startup.ready.appliedStamp.at` 指向的那次启动，在诊断轨里可能**找不到对应行**（戳的时间是上一次启动留下的，刷新戳不写日志）—— 这是**不可判**的一档，别当成「没有启动过」；② `patchesMatch=false` 不等于「没打上」（对齐戳丢了也会是 false）；③ `cli.apply.done.pending` 与 `apply.end.pendingRestart` **不是一回事**（前者是「还有几条待清洗」，后者是「要不要重启」）。
- **答不出来时缺什么**：日志里没有「当次启动的宿主版本」（`startup.ready.version` 是**插件**版本）。宿主版本只在 apply 那一刻出现，见 Q9。

### Q8 `partial` 是什么意思

- **看这几样**：新口径直接读层结论的 `detail.partialReason`：`record` = 记录缺口（`completeness` 有假项）、`layer` = 层内部分成功（三项全真但没全改到）。
- **什么算例外**：**世代** —— `partialReason` 是刚加的字段，实测全库**没有一行**带它。老行按两条自己推：`completeness` 任一项为假 ⇒ `record`；三项全真而 `applied>0` 且 `applied+failed<total` ⇒ `layer`（正常形态，不是日志坏了）。
- **答不出来时缺什么**：老行两项都不满足却仍是 `partial`（例如 `applied=0`、计数又齐）⇒ 这一问不可判，写「日志里没有这个信息」。

### Q9 宿主版本从哪看

- **看这几样**：`apply.start.hostVersion` / `apply.gate.reject.hostVersion` 是门禁那一刻的版本对（`dshTarget` 是补丁表要求的版本）；**`apply.host` 也带 `hostVersion` 与 `dshTarget`**（不是「只在两处」）—— 多宿主时每个宿主的版本对都在这一行上。
- **什么算例外**：没有 apply 过就查不到；`startup.ready.version` 是插件版本，不是宿主版本。
- **答不出来时缺什么**：宿主升级导致补丁漂移这件事，只能拿最近一次 apply 的 `hostVersion` 与新版本比 —— 没有 apply 记录时不可判。

### Q10 去哪找这一轮（批次号的钟与文件名的钟不一样）

- **看这几样**：`runId` 形如 `apply-20261025T101548Z-10fe`，**时间戳段是 UTC**；审计文件名是**本地日期**（`2026-10-26.jsonl`）。同一次 apply 两个日期可能差一天（本地 08:00 之前跑的轮，UTC 还是前一天）。
- **什么算例外**：跨文件定位一行只能用 `recordId`；`seq` 只在文件内唯一（同一天轮转后两个文件都可能有 `seq=0`）。诊断轨没有 `seq`。
- **答不出来时缺什么**：只给了一天文件却拿着跨天的诊断轨 —— 另一天的轮次「审计缺」是假红（见第 3.1 节的三条边界）。

### Q11 下一步做什么（症状 → 证据 → 命令）

- **看这几样**：第 7 节那张表（症状 → 哪个文件哪个字段 → 下一步跑什么）；`audit remedy [id]` 会把同一张卡按症候打出来（字段 / 命令 / 动作 / 判定四段，卡片表在 `lib/audit/remedy.js`）。
- **什么算例外**：卡片是**数据**，不是自动修复 —— 卡里的命令能直接跑，改还是不改仍要人判。症状不在表里时，先按第 0 步判完整性，再把这次 `runId` 的全部行按时间读一遍；不要凭事件名猜。
- **答不出来时缺什么**：没有任何日志证据能回答的档，照第 9 节第 2 条写「日志里没有这个信息」。

---

## 1. 三条落点：两个 JSONL 轨 + 一个纯文本轨

| 轨 | 落点 | 文件长什么样 | 一行是什么 | 有 `seq` / `recordId` / `evidence` 吗 | 谁在写 |
| --- | --- | --- | --- | --- | --- |
| **审计轨** | `<DSH_HOME>/dsh-purge/audit/` | `YYYY-MM-DD.jsonl`（**本地日期**）；同日超过 10 MB 滚成 `YYYY-MM-DD.N.jsonl`（单日最多 24 代，顶到上限继续写最后一代并留一条 `prune.capped`）；保留 30 天，每天首次写入时清一次（删了哪些文件写在 `prune.removed`） | 一次**判定**的证据：哪个文件、哪个 marker、命中几次、多少字节 | 有 `seq`（每个文件从 0 起、步长 1）、`recordId`、`runId`、`observedTs`、`entry`、`actor`、`evidence` | 四个 apply 入口共用一段：面板 HTTP、`/purge apply` 命令、`purge_apply` 工具、CLI `--apply`（入口只声明身份，折行 / `before` / 写盘在 `lib/audit/index.js` 的 `recordApplyRun`，最终写盘仍是 `lib/audit/report.js` 的 `recordApply`） |
| **诊断轨** | `<DSH_HOME>/dsh-purge/logs/diag.jsonl`（`DSH_PURGE_LOG_FILE` 可改路径；`DSH_PURGE_LOG=0` 关掉） | 单文件；单文件超 4 MB 滚成 `diag.jsonl.1`（保留 8 代，`.1` 是最新的一代）（**留 8 代**，每 128 次写才检查一次大小） | 一次**运行期事件**：谁在什么时候对哪个文件做了什么 | **没有** `seq` / `recordId` / `evidence`；`entry` / `runId` 由环境身份在序列化前补进每一行 | 多个发射点，分布在 `lib/core.js`、`bin/dsh-purge.js`、`lib/audit/startup.js`、`lib/redteam/store-core.js`（事件名见第 2、6 节） |
| **内部轨**（`purgeLog`） | `<DSH_HOME>/dsh-purge/logs/desktop.log` | 纯文本，一行 `ISO 时间戳 [标签] k=v …`；滚动阈值与代数由 `lib/log-rolling.js` 统一给出（4 MB、留 8 代） | 宿主进程里的临时探针（提示词装配决策、HTTP 动作结果） | 都没有 | `lib/purge-log.js` |

四条硬事实，读之前先记住：

- **审计目录里应该还有两样东西**：`README-for-ai.md`（就是本文，apply 时投递到现场，内容与仓库那份逐字节相同）和 `cards/`（失败卡，形如 `cards/20261025T101548-apply-….md`）。**没有读法说明这个现场是升级前写下的，或者投递失败** —— 去诊断轨找 `audit.recorded` 的 `readme` 字段（`installed` / `kept` / `failed`）。`cards/` 里没有文件不等于没事，只表示那些轮没有命中任何已知症候。
- **内部轨已迁出系统临时目录，两条写入器都搬了**：`purgeLog` 与 `lib/desktop.js` 的 `logInternal` 都落 `<DSH_HOME>/dsh-purge/logs/desktop.log`，同一份滚动规格（4 MB、留 8 代）。`logInternal` 的行是 `ISO 时间戳 [dsh-purge] 文本`，`purgeLog` 的行是 `ISO 时间戳 [标签] k=v` —— 同一份文件里两种行格式，按行首方括号里的内容区分。它落点自己算（`DSH_HOME` 优先，否则 `~/.dsh`），不走 `findDshHome` 的便携布局分支：便携安装下两条旁路可能分叉，这是已知代价。
- **两条 JSONL 轨的时钟不一样**：诊断轨的 `ts` 是 UTC（`…Z`），审计轨的 `ts` / `observedTs` 是本地时刻带偏移（`+08:00`）。比时间先后之前先换算，否则你会把同一秒的两条记录读成一前一后差 8 小时。
- **诊断轨的所有字段值都是字符串**：`"patches":"66"` 不是数字 66。这是写入器统一 `String()` 化的结果，不是数据坏了。

---

## 2. 一次 apply 在诊断轨里长什么样（按时间顺序）

一次 apply 一定按下面的顺序出现。**同一个 `runId` 内**的顺序就是判据。

| 事件 | 什么时候发 | 关键字段（以及它回答什么） |
| --- | --- | --- |
| `apply.start` | 引擎开始一轮 apply | `patches`（补丁表总条数）/ `selected`（经 hooks-deny 过滤后真正要打的条数）/ `forApply`（是不是「应用」语义）/ `hostVersion`（第一个待打宿主的实际版本）/ `dshTarget`（补丁表要求的版本）/ `entry` + `runId`（+ 仅 CLI 会带 `sealed`）。**`hostVersion` 与 `dshTarget` 在成功那轮也在**：门禁过没过，不必再靠「没出现 reject」反推 |
| `apply.hosts` | 解析出本轮目标宿主之后 | `count`（宿主个数）/ `bases`（宿主根，多个用 `,` 拼成一串）。**`count=0` 说明是探测失败，不是补丁失败** |
| `apply.gate.reject` | 版本门禁拒绝 | `rejected`（被拒的宿主根）/ `hostVersion`（宿主实际版本）/ `dshTarget`（补丁表要求的版本）/ `error` + `code`（`DSH_PURGE_HOST_VERSION_MISMATCH`）+ `stack`。**出现它 = 一个字节都没写**，与「补丁打偏」是两件事 |
| `apply.patch` | 每条补丁一行（一个宿主一轮，多个落点也只一行） | `base` / `id`（补丁号）/ `name` / `status`。`status` 取值见下面那张表 |
| `apply.host` | 一个宿主打完之后 | `total` / `applied` / `already` / `failed`（**硬失败**条数）/ `soft`（**可接受**的条数，见下）/ `markers`（清洗标记是否落到了**引擎算出来的那个 `aiBase`** 上，见下）/ `flash`（命令框静默链是否钉住，见下）/ `ms`（这个宿主花了多久） |
| `apply.end` | 全部宿主打完，合并汇总 | `hosts` / `total` / `applied` / `already` / `failed` / `notFound` / `missingFile` / `ms`（整轮耗时）/ `pendingRestart`（这一轮改了文件要不要重启才算生效，见第 2.2 节）/ `asarSealed`（这一轮面对的官方归档是否仍密封）。**注意：这里没有 `skipped` 计数** —— 想解释 `total` 与 `applied+already` 的差，去 `apply.patch` 里数 `"status":"skipped"` |
| `install.record` | 写完安装指纹 | `ok` / `files`（记录的指纹文件数）/ `method` / `path`（指纹文件落点）。它**不以 `apply.` 开头**，很多正则（包括按 `apply.` 过滤的人）会漏掉它 |

`install.record` 的 `method` 取值表（**只有一档，不要据此判断安装方式**）：

| 取值 | 什么时候出现 |
| --- | --- |
| `unknown` | **今天恒为这一档**。它取自环境变量 `DSH_PURGE_INSTALL_METHOD`，而全仓没有任何地方设置这个变量（两处读点都在 `lib/core.js` 记安装指纹的那一段）—— 不手工导出就永远是 `unknown` |

看到 `method:"unknown"` 既不是「安装方式不明」的故障，也不是日志少记了字段：这个字段今天没有生产者。**别用它区分「装的」与「手工拷进去的」**，那件事今天查不了。

`apply.host` 的两个字段容易读错，单独说清：

- **`markers` 说的是「引擎算出来的 `aiBase`」，不是「运行中的宿主读得到的根」。** 它回答的是「补丁有没有写偏目录」。而 `apply.end` 的 `asarSealed` 回答的是另一件事：「宿主进程读的是不是还是密封归档」。真机上两者可以同时为 `true`：`aiBase` 指向解包目录 `resources\app\dsh\node_modules\@deepseek-ai`（所以 `markers=true`），而 `app.asar` 还在（所以 `asarSealed=true`），两棵树并存。**判「宿主读的根是哪一个」以 `asarSealed` 为准**，别拿 `markers` 反推。
- **`flash` 是「命令框闪一下」的静默链结果，与补丁判定无关。** 它来自 `silenceCmdFlash`：把 CLI 的隐藏窗口钉住（`entry`）、顺手处理 doctor / market / 子进程 / 官方 phase-1 / mnemon 几处黑框。`flash=true`（`cli.apply.done` 里叫 `flash_ok`）只表示这条链钉住了，不表示补丁打上了；`flash=false` 也不进 `failed`。

`apply.patch` 的 `status` 只有这几档，别混：

| `status` | 意思 | 算不算问题 |
| --- | --- | --- |
| `applied` | 这次真的改了文件 | 正常 |
| `already` | 文件里已经有这个 marker，不用动 | 正常 |
| `skipped` | 文件在，但这条补丁在这份原文里没有可做的替换 | 正常（`apply.end` 里不计数，所以会造成「总数≠已处理」） |
| `pattern_not_found` | 该打的 marker 没找到 | 看补丁的 on-miss 口径：`fail`（含 `strictFiles`）→ **三轨都算失败**；`warn` / `ignore` → **三轨都按跳过放过**（审计记 skip、设置页 idle）。判定函数三处共用 `isSoftOk` |
| `missing_file` | 目标文件不存在 | **正常**：候选路径全部不存在 = 这批补丁在当前宿主本来就不适用。不算失败，也不算读写错误 |
| `read_error` / `write_error:…` | 读写失败 | **异常**：这条补丁改没改成根本没判出来。诊断轨、审计轨、设置页三处同一口径，都算失败 |
| `na` | 这条补丁在当前宿主面上不适用 | 正常（不进统计） |

状态面板里还会出现 `off`（「被设置关掉」）：它不由 apply 产出，口径与 `missing_file` 相同 —— 不算失败、色调是「没事」那一档。

**三轨对 `pattern_not_found` 是同一个口径（本包起）**：诊断轨 `apply.end` 的 `failed` 计数、审计轨的层结论、设置页的色调都由 `lib/patch/status.js` 的 `isSoftOk` 判一次。补丁声明 `onMiss: warn / ignore` 且不带 `strictFiles` 时，三处一律按「这一版不需要」放过：诊断轨不进 `failed`、审计轨折成 `skip`、设置页是 `idle`。所以「审计轨某层 `result=skip`」与「诊断轨 `apply.end` 的 `failed=0`」现在是互证的；看到审计轨 `result=fail` 时，`detail.status` 里那条 `pattern_not_found` 一定来自硬 miss。三轨对照表见 `docs/decisions/0013-三轨失败语义同表.md`。

旧日志（本包之前写的）仍可能带着「审计轨 fail、诊断轨 0 硬失败」的组合：那一版的审计轨拿不到补丁对象，`pattern_not_found` 一律算失败。看到这种组合先看日志日期，再按上面的规则重算一次，别把旧口径当成本轮的矛盾。

`apply.host` 与 `apply.end` 里 `soft` 不是「软失败数」，而是「按判定算可接受的条数」：`applied` / `already` / `skipped` / `na` / `missing_file` / `off` 一律算 soft，`pattern_not_found` 只有在补丁声明 on-miss 不是 `fail` 时才算 soft。所以 `soft` 等于总数而 `failed=0` 是**正常形态**，不是「66 条都软失败了」。

**`apply.end` 的 `failed` 与 `apply.host` 的 `failed` 是同一个判据**（都是「按 on-miss 口径判出来的硬失败条数」），单宿主的一轮 apply 上两个数必须相等。与它并列的计数：

- `readError` / `writeError`：读失败、写失败的条数，**已经计入 `failed`**；
- `notFound`：`status` 是 `pattern_not_found` 的条数，其中被 on-miss 钉死的那部分也计入 `failed` —— 两个数有重叠，**不许相加**；
- `missingFile`：缺件条数，**不算失败**。

旧版本日志里 `apply.end` 的 `failed` 只数 `status === "failed"`，而逐条判定根本不产出那一档，所以它恒为 0：看到 `apply.host` 的 `failed=3` 而 `apply.end` 的 `failed=0`，那是旧口径，不是「没有失败」。

**读写失败（`read_error` / `write_error:…`）在三处的口径（本轮统一）**：

- **诊断轨：**不在「可接受」白名单里，`apply.host` 的 `failed` 本来就会数到它们；`apply.end` 另给 `readError` / `writeError` 两个计数，不必回去数 `apply.patch`。
- **审计轨：**折成 `fail`，落成 `{层}.patch-miss` 且 `result` 是 `fail`，真实原因仍在 `detail.status`（事件名只有 applied / miss / skipped 三种后缀，「没判出来」不许混进 skipped）。
- **设置页：**色调是 `error`。改前它落在兜底分支显示成 `idle`，看着像没事。

所以 `apply.end` 与 `apply.host` 上的 `failed=0` 已经包含读写失败，可以当结论用；审计轨的 `failed` 只覆盖有落点、有 marker 的行，读写失败要看该层结论的 `detail.status`。

### 2.1 真实样例（真机 2026-10-25 的一次 CLI apply，压缩掉重复的 66 条 `apply.patch`）

> **本节样例与第 4 节举的那个 `runId` 例子、以及盲测材料里标作「日志 A」的那份 `diag.jsonl`，是同一次 apply**（`runId` 都是 `apply-20261025T101548Z-10fe`）—— 同一份证据，别当两份独立材料互相印证。那次 apply 只写了诊断轨：审计轨里查不到它（第 4 节解释了为什么这是设计边界而不是丢日志）。

```
{"ts":"2026-10-25T10:15:48.943Z","event":"cli.apply.begin","sealed":"true","inject_source":"default"}
{"ts":"2026-10-25T10:15:51.772Z","event":"apply.start","patches":"66","selected":"66","forApply":"true","entry":"cli","runId":"apply-20261025T101548Z-10fe","sealed":"true"}
{"ts":"2026-10-25T10:15:54.236Z","event":"apply.hosts","count":"1","bases":"<宿主根>","entry":"cli","runId":"apply-20261025T101548Z-10fe","sealed":"true"}
{"ts":"2026-10-25T10:18:00.739Z","event":"apply.patch","base":"<宿主根>","id":"1","name":"WORKSPACE_CONTEXT_INTRO","status":"already","entry":"cli","runId":"apply-20261025T101548Z-10fe","sealed":"true"}
{"ts":"2026-10-25T10:18:00.750Z","event":"apply.patch","base":"<宿主根>","id":"46","name":"OFFICIAL_DESKTOP_UPDATE_ASCII","status":"skipped","entry":"cli","runId":"apply-20261025T101548Z-10fe","sealed":"true"}
{"ts":"2026-10-25T10:18:01.221Z","event":"apply.host","base":"<宿主根>","total":"66","applied":"54","already":"11","failed":"0","soft":"66","markers":"true","flash":"true","ms":"119436","entry":"cli","runId":"apply-20261025T101548Z-10fe","sealed":"true"}
{"ts":"2026-10-25T10:18:01.222Z","event":"apply.end","hosts":"1","total":"66","applied":"54","already":"11","failed":"0","notFound":"0","missingFile":"0","ms":"129507","entry":"cli","runId":"apply-20261025T101548Z-10fe","sealed":"true"}
{"ts":"2026-10-25T10:18:01.242Z","event":"install.record","ok":"true","files":"74","method":"unknown","path":"<DSH_HOME>\\dsh-purge\\install-state.json","entry":"cli","runId":"apply-20261025T101548Z-10fe","sealed":"true"}
{"ts":"2026-10-25T10:18:02.953Z","event":"cli.apply.done","hosts":"1","applied":"65","pending":"0","skipped":"1","total":"66","inject_source":"default","flash_ok":"true","asar_sealed":"true","log":"<DSH_HOME>\\dsh-purge\\logs\\diag.jsonl"}
```

这份样例能读出四件事，逐条都是可复核的：

1. **66 = 54 applied + 11 already + 1 skipped**。`apply.end` 里没有 `skipped` 字段，所以 54+11=65 差的那 1 条要去 `apply.patch` 里数（是 `#46`）。
2. **`apply.host.ms=119436`（119 秒），整轮 `apply.end.ms=129507`（129.5 秒）** —— 时间几乎都花在宿主上，`apply.hosts` 到第一条 `apply.patch` 之间那 126 秒是引擎在逐文件改写，不是卡死。
3. **`markers=true` 说明标记真的落到了宿主读的那个根**，不是写到解包目录而宿主看不见。
4. **`cli.apply.done` 的 `applied=65` 与 `apply.end` 的 `applied=54` 口径不同**：前者是「应用后重新体检的已清洗条数」，后者是「这一轮真改动的条数」。两个数都对，别当成矛盾。

**这份样例是加字段之前取的**：`apply.start` 里没有 `hostVersion` / `dshTarget`，`apply.end` 里没有 `pendingRestart` / `asarSealed`，整份里也没有 `startup.ready`。旧日志缺这几个键是正常的，不是少记了；它们要读新版才有的那几条行（第 2.2 节）。

### 2.2 生效判据：`pendingRestart` 与 `startup.ready`

这两个东西合起来才回答「我改了，到底生效没有」。缺任何一半，答案都只剩缺席证明。

| 字段 / 事件 | 取值 | 怎么读 |
| --- | --- | --- |
| `apply.end` 的 `pendingRestart` | `"true"` / `"false"` | **`true` = 这一轮真的改动了宿主读的那些文件，而那些字节要等宿主进程重新启动才会被加载。** 判据只看「有没有 `status` 为 `applied` 的补丁」，不看归档密不密封 |
| `apply.end` 的 `asarSealed` | `"true"` / `"false"` / 空串 | `true` = 这一轮面对的是仍密封的官方 `app.asar`。它与 `pendingRestart` 是两件事：前者说字节落在哪、后者说运行中的宿主有没有这些字节。**两个都 `true` 时更重**：连「新起的进程」也还读不到，得先把归档换掉再重启 |
| `startup.ready` | 每次宿主启动一条 | 字段 `version`（插件版本）/ `patchesMatch`（`"true"` = 引擎判定补丁已对齐）/ `appliedStamp`（`<version>@<sha>@<at>`，来自 `applied.json`；空串 = 没有对齐戳）/ **`pending`**（还没打上的补丁号，逗号串；空串 = 一条不缺，**不是** `"[]"` 也不是 `"0"`）/ **`pendingCount`** / **`alignmentReason`**（`""` 已对齐 / `"pending"` 有条没打上 / `"stamp"` 戳对不上 / `"no-ai-base"` 找不到宿主 / `"read-error:…"`）/ **`appliedRunId`**（这次启动读的是哪一次 apply 的落账；空串 = 戳里没这一项）。**它不带 `entry` 也不带 `runId`** —— 它不是 apply，按 `runId` 捞一轮时不会捞到它 |

两条推论，都是可判的：

1. **`pendingRestart="true"`，之后有一条 `startup.ready` 且它的 `patchesMatch="true"`** → 这一轮的改动被宿主读进来了：**生效**。
2. **`pendingRestart="true"`，之后再没有 `startup.ready`** → 宿主没重启过：磁盘上是新的、跑着的是旧的，**没生效**。这时候不要去找「有没有报错」，那是缺席证明；去看 `startup.ready` 的存在与否。

第三种情形要分清：**`startup.ready` 有了，但 `patchesMatch="false"`** → 启动了，但引擎判据说补丁没对齐。可能是真没打上（宿主升级换了文件、密封包把解包目录盖回去），**也可能只是对齐戳丢了而文件本身已打好**（引擎会在这次启动里补戳）。分这两种要看同一次启动之后有没有 reapply 与重启，别只凭这个布尔下结论。

`pendingRestart` 为什么按「改了文件」而不是「仅密封才要重启」：密封只决定字节写到哪里（归档还是解包目录），而运行中的宿主进程两种形态下都不会重新读一次模块或提示词。按密封判会漏掉最常见的形态 —— 未密封的桌面宿主上打完补丁不重启，字段会写成 `false`，读的人据此认定「已生效」。

**别把它和设置页角标上的「需重启」混为一谈**（同一个词，两个问题）：那个角标读的是 `/api/state` 的 `boot_full_quit`（`lib/index.js` 的模块状态），含义是「官方宿主需要**完整退出** —— 连插件级重载都不够」，只在 reapply / 官方升级 / 换归档那几条路径上置位，而且是在 apply **返回之后**才判出来的。`apply.end` 是在引擎里发的，那时还看不到它。所以两者的关系是：`boot_full_quit` 为真 ⇒ 一定要重启（更重的一档）；`pendingRestart` 为真 ⇏ 要完整退出。日志里判「这一轮生效没有」只看 `pendingRestart` 与 `startup.ready`，**`boot_full_quit` 不进日志**，只在 `/api/state` 里。

**`applied.json` 的版本账本由四个 apply 入口在成功收尾时写。** `http` / `command` / `tool` / `cli` 落完审计后都写同样两样东西：`run_id`（这一轮的 `runId`）与 `audit`（`{events, layers, unresolved}` 摘要）。失败与早退的轮不写 —— 账本记的是「最后一次**成功** apply」，不是「最后一次尝试」。**成功门槛与三档口径以 `docs/decisions/0014-版本账本成功口径.md` 为准**，本文只写读法：CLI 这一档不过时会在输出里打一行「版本账本未更新（failed=… hostWritten=…）」，看到它就说明这一轮没进账本，命令照常收尾。启动路径刷新戳（`markPatchesApplied()` 不带 `runId`）只重写 `version` / `sha` / `at` 三样事实，`run_id` 与 `audit` 摘要**沿用旧戳**：刷戳只是确认对齐还在，不该把上一次 apply 的身份与摘要抹掉。`startup.ready.appliedRunId` 读的就是这份 `run_id`。

**无改动 / 缺件轮也算成功，但要读它的自陈。** `missing_file` / `notFound` 是软档、不进 `failed`，所以 `applied=0` 的一轮同样会写账本；账本的 `layers` / `unresolved` 两个键，加上诊断轨 `apply.end` 的 `missingFile` / `applied`，一起说明它**没改东西** —— `appliedRunId` 指向这样一轮是口径，不是 bug。要回答「最近一次**改了文件**的 apply 是哪轮」，看这几样，别只看 `run_id`。口径与取舍见 `docs/decisions/0014-版本账本成功口径.md`。

**密封分支有一档已知缺口**：`ensureHostClean` 不返回 `hookDenyRestoreFailed`，`flash` 的 `ok` 也不进 CLI 的账本门槛，那一档现在靠 `cleaned` 的 `ok` 挡；要逐字同义得改 `lib/core.js`，已登记在风险地图（取舍见 `docs/decisions/0014-版本账本成功口径.md`）。

### 2.2.1 账本里的三个清单：每个字段证明什么、不证明什么

版本账本（`applied.json`）里有一堆像 sha 的字段，它们**不是同一句话**。读之前先分清，否则「有指纹」会被当成「已生效」：

| 字段 | 谁写 | 记什么 | 读侧怎么用 | 能不能证明「这一版表生效」 |
| --- | --- | --- | --- | --- |
| `tableSha` | apply 收尾 | 收尾那一刻**整张补丁表**的指纹 | 与当前表比：不等 ⇒ 不认 marker，也不认写入清单里的旧条目 | **能（表维度）**：它只回答「表还是那一版吗」，回答不了「这一条干完了吗」 |
| `patchShas` | 同上 | **逐条**补丁的指纹（id + 替换正文 + marker 规范化） | 与当前表逐条比；一条换正文，只有那一条的指纹变 | **能（逐条）**：指纹不等就等于「这一条来自另一代表」 |
| `patchesWritten` | 同上 | 这一版表**真写过文件**的补丁 id（同一份表指纹下的多轮会累积） | 认证「这一版表写过它」；它也是「把本轮 dry-run 找到的活消化掉」的那一半证据 | **能**。反过来说：不在这个清单里，marker 就不能单独当通行证 |
| `patchesSettled` | 同上 | 本轮核对「**已经在目标态**、没有可写字节」的补丁 id（同样按表累积） | 认证 already 型（文件早就在目标态） | **能**，但只对「那一刻」成立：它**盖不住新的活**，有剩余改动时仍判 pending |
| `contentSha` | 同上 | **真写过**的文件字节 sha256（自愈轮核对通过的排除文件也并进来） | 与现场字节比：不等 ⇒ 文件被外部改过，marker 是上一轮的 | **只证明「文件没变」**，不能单独证明表生效：字节没变也可能是「这一版表本来就不改这里」 |
| `evidenceExcluded` | 同上 | 核对过但**没写**的文件（client bundle 自愈轮）：补丁 id + 记录时的补丁指纹 + 文件键 + 核对时的内容 sha256 | 补丁指纹与文件内容**两样都对上**才认；任一项不符即回落 pending | **能（单文件）**：它替代不了 `patchesWritten`，只在那一个文件上等价 |

四条读法，按顺序问：

1. **表换代了吗** → 看 `tableSha` / `patchShas`。换了，旧账本里的写入清单与内容指纹都不再是这一版表的证据。
2. **这一条干完了吗** → 看 `patchesWritten`（写过）与 `patchesSettled`（核对时就在目标态）。两样都没有，只剩 marker，那不算认证。
3. **文件被动过吗** → 看 `contentSha`。它是否证材料，不是认证材料；对不上就一定 pending。
4. **自愈轮跳过的那份文件怎么算** → 只有 `evidenceExcluded` 里三条都对上才算；它记录的是「核对过」，不是「写过」。

八种输入组合各自的结论（marker / dry-run / 账本认证）钉在 `docs/状态层契约.md` 的认证矩阵一节，
逐行断言在 `test/patch-certify-matrix.test.mjs`。**改判据先改那张表**，再改代码。

### 2.3 三个相邻字段 / 两个盲区，读之前先分清

**一、`cli.apply.done.pending` 不是 `apply.end.pendingRestart`。** 两个词都有「待」的意思，回答的却是不同问题：

| 字段 | 取值 | 回答什么 |
| --- | --- | --- |
| `apply.end.pendingRestart` | `"true"` / `"false"` | 这一轮**改了文件**，那些字节要等宿主重启才被读到 |
| `cli.apply.done.pending` | 数字 | 收尾体检时**还有几条补丁的状态是「待清洗」**（`patch_status === "pending"`） |

所以真机上完全可能出现「`pending:"0"` 与 `pendingRestart:"true"` 相邻两行」：补丁都打上了（0 条待清洗），但运行中的宿主还没读新字节。**读成「不需要重启」是最常见的误判。**

**二、`appliedStamp` 指向的那次 apply 可能不在这份日志里。** 它是 `<version>@<sha>@<at>` 三段，`at` 是**启动那一刻磁盘上那个戳的时间**；那次 apply 的记录可能已经被轮转走了，或者落在别的 `dshHome`。**找不到那次 apply 不等于戳是假的** —— 戳只证明「磁盘上有一份对齐记录」，不证明「记录还在这份日志里」。

**三、`appliedStamp` 的 `at` 是上一次启动留下的。** `settleInstalledPatches` 先读戳、再用 `markPatchesApplied()` 把戳刷新成当前时间，而**这次刷新不写任何日志**，也**只重写 `version` / `sha` / `at`** —— 戳里的 `run_id` 与 `audit` 摘要按旧值沿用（空 `runId` 的分支），所以重启一次不会把上一轮 apply 的身份与摘要抹掉。所以每一条 `startup.ready` 读到的 `at` 都是**上一次启动**写入的；三次重启就有三次错位。把它当「当前戳」用会差一个启动周期。

**四、日志里没有「当次启动的宿主版本」，但宿主版本不止两处。** `startup.ready.version` 是**插件**版本（`2.0.0`），不是宿主版本。宿主版本出现在三处，都是 apply 那一刻：`apply.start.hostVersion`、`apply.gate.reject.hostVersion`，以及 **`apply.host.hostVersion`（与 `dshTarget` 成对）** —— 多宿主的一轮里，每个宿主的版本对只在这一行上。要判「宿主升级导致补丁漂移」，只能拿最近一次 apply 的 `hostVersion` 与新的比对；没有 apply 过就查不到，这一档如实记为「日志里没有这个信息」。

**五、诊断轨没有等价的机械完整性判据。** `audit check` 的四条判据（断号 / 坏行 / 末行没换行 / 轮边界）**全是审计轨的形状**：诊断轨按定义没有 `seq`、没有 `recordId`、没有层、没有 `evidence`。手上只有 `diag.jsonl` 时没有对应的 `check` 可跑 —— 这不是漏跑了一步，也不是日志坏了。诊断轨能判的只有「按 `runId` 分组后事件齐不齐」，那是人读的判据，没有命令。

---

## 3. 一次 apply 在审计轨里长什么样

审计轨按**层**组织。三层固定是 `prompt` / `code` / `tool`，每层两类事件：

**审计轨只记 apply，不记 revert。** `revert.start` / `revert.file` / `revert.end` 这一族只写诊断轨（带 `entry` / `runId`）。所以拿一个 revert 的 `runId` 去查审计轨，0 行是设计边界，不是丢日志；`audit why` 会在审计侧 0 行时直接打印这条说明。

- **文件层**：`{层}.patch-applied` / `{层}.patch-miss` / `{层}.patch-skipped` —— **一个补丁的一个目标文件一行**。同一条补丁落在三个文件上就是三行，因为证据的最小单位是「一个文件上的一个 marker」。
- **结论层**：`{层}.apply-result` —— 每层一行，`evidence.refSeq` 指向本层**最后一条**文件层事件的 `seq`，`detail` 里带 `applied` / `failed` / `skipped` / `unresolved` / `exempt` / `completeness`。

真实的一行结论层事件（真机 2026-10-24 的第三次 apply，原文未改）：

```
{"ts":"2026-10-24T17:04:55.949+08:00","seq":266,"recordId":"9222ce20-8b26-476d-bbe5-6d15a21ef893","runId":"apply-20261024T090455Z-b59e","observedTs":"2026-10-24T17:04:55.713+08:00","event":"tool.apply-result","result":"skip","layer":"tool","actor":"host","target":"tool","evidence":{"refSeq":265,"quote":"tool.patch-skipped"},"detail":{"applied":0,"failed":0,"skipped":3,"unresolved":[],"exempt":[],"completeness":{"patches":true,"files":true,"layers":true}}}
```

字段怎么念：

| 字段 | 意思 |
| --- | --- |
| `seq` | 文件内序号，从 0 起、步长 1。**跨文件不连续是对的**（每个文件各自从 0 起） |
| `recordId` | 行级 uuid。只有它能在一份日志里唯一定位一行 |
| `runId` | 本次尝试的批次号，与诊断轨同一个值（第 4 节） |
| `observedTs` | 观测起点（本次 apply 全部行共用）；与 `ts` 的差就是审计管道自身的积压 |
| `result` | `ok` / `fail` / `skip` / `partial` 四档 |
| `layer` | `prompt` / `code` / `tool` |
| `actor` | 谁写的这一行：`cli`（命令行进程自己写的）或 `host`（宿主进程里那三个入口写的）。`client` / `subagent` 是词表里的合法值，今天没有写入方 |
| `entry` | **哪个入口触发的**：`cli` / `http` / `command` / `tool`（与诊断轨同一批取值）。它是「诊断轨滚掉之后仍答得出谁触发」的唯一来源 —— 只读这一行就够，不必另一份文件 |
| `target` | 结论层写层名；文件层写补丁名 |
| `evidence` | 两种形态：**文件证据**（`file` / `marker` / `hits` / `bytes`，可选 `offset` / `before` / `after` 摘要）或**引用证据**（`refSeq` / `quote`） |
| `detail.patchId` / `detail.status` | 文件层回指补丁号与那一轮的 `status` |
| `detail.completeness` | `{patches, files, layers}`：该层的结论记全了没有。任一为假，`result` 不许是 `ok`/`skip`，会被压成 `partial`（或更差的 `fail`）。**三个布尔各自怎么算、以及能不能被复算**见下面那张表 |
| `detail.considered` | 这一层**折进来的补丁号**（不含 `exempt`）。它是 `patches` 的分母：读的人拿它逐个对「有没有文件行」，就能自己复算「有没有少一条」 |
| `detail.expectedRows` | 这些补丁声明的**落点行总数**。它是 `files` 的分母：与这一层实际的文件行数一比，就知道有没有少落 |
| `detail.partialReason` | `partial` 的来路，机器可判：`record`（记录缺口 —— `completeness` 有假项）或 `layer`（层内部分成功 —— 三项全真但没全改到）。**新口径的字段**：实测全库没有一行带它（刚上），老行按下面那张表自己推 |
| `detail.unresolved` | 写不出证据的补丁号。**类型**：审计轨是数组（没有就是 `[]`）；诊断轨 `audit.recorded.unresolved` 是逗号串（没有就是空串 `""`）。这是**缺口**，不是空值 |
| `detail.exempt` | `auditExempt`（审计不适用）的补丁号。这类补丁在干净现场本来就没有可复现的证据，实现上**单独列示、不许静默消失**，也**不进** `unresolved` —— `unresolved` 是缺口，`exempt` **不是缺口**。真机上长这样：`"exempt":[21]`（21 号是 migration-only 补丁，看到它不是问题） |
| `detail.runEnd` | **结束标记**：这一轮的最后一条审计行上为 `true`。判收尾只看它在不在，不看行排第几（第 3.1 节） |
| `detail.table` | 补丁表记账：`{total, exempt, unmapped, selected, recorded}`。`unmapped` 是补丁表里**没有层**的非豁免 id（兼容类，如 `[40,47,49]`）—— 它们永远不会出现在层结论里，不列出来就是静默消失。`selected` 是这一轮 report 里出现过的补丁号（含 `unresolved` 的），apply 带过滤时它才是分母；`total` 仍是补丁表全量。分母核对见第 3.1 节 |

`completeness` 三项各自的算法（这是判据，不是说明；`audit check` 会按同一套复算，对不上就红）：

| 布尔 | 为真的条件 | 拿什么复算 |
| --- | --- | --- |
| `patches` | `detail.unresolved` 为空，且 `detail.considered` 里每个补丁号都有文件行或落在 `unresolved` | `considered` × 本层文件行的 `detail.patchId` |
| `files` | 本层文件行数 = `detail.expectedRows`，且每行 `before` / `after` 摘要都在（不为 `null`、不为缺键） | 数文件行 + 看每行的 `evidence.before` / `evidence.after` |
| `layers` | 三层都有结论且 `considered` 非空。这是**整批**属性，所以任一层缺结论就只能是假 | 按 `runId` 分组后看三层是否各有 `apply-result` |

`partial` 有**两个来路**。新口径的行直接读 `detail.partialReason`；老口径（没有这个字段）按下面两条自己推：

1. **层内部分成功**：这一层有补丁真的改了，但没全改到 —— `detail.applied > 0` 且 `applied + failed < total`（差的那几条是 `skipped` / `already`）。这是**正常形态**，意思是「这一层这一轮只做了一部分事」，不是日志坏了。
2. **记录不完整**：`detail.completeness` 的 `patches` / `files` / `layers` 任一为假，被压成 `partial`（`fail` 不降级）。这是**日志的缺口**，要按第 7 节去查它缺在哪。

实测两种来源都在同一份真机日志里（2026-10-24 的审计轨，下面两条的 `completeness` **三项全真**）：`seq=29` 的 `prompt.apply-result` 是 `applied=13 / skipped=4`、`seq=82` 的 `code.apply-result` 是 `applied=41 / skipped=1` —— 这两条都是**来源 ①**，不是记录缺口；判来源 ② 只看 `completeness` 有没有假项，别无他法。按新口径写出来的行会直接给出 `"partialReason":"layer"`（来源 ①）或 `"partialReason":"record"`（来源 ②），不必再推。

`evidence.hits=0` 有两种含义，看事件名区分：`patch-applied` 上 `hits=0` 说明 marker 已经在（不必再插），`patch-miss` 上 `hits=0` 才是真的没找到。`offset` 只在真命中时写，`hits=0` 时没有这个字段（写 0 等于把「没命中」说成「在第 0 字节」）。

### 3.1 轮边界：这一轮是收尾了还是被截断

一轮 = 同一个 `runId` 的全部行。**收尾判据只有一条：这一轮有没有结束标记。**

| 轨 | 结束标记 | 怎么读 |
| --- | --- | --- |
| 审计轨 | 层结论上的 `detail.runEnd: true` | 落账方只在这一轮**最后一条**审计行上盖一次章（`lib/audit/report.js` 的 `recordApply`）。`audit check` 打印 `sealed=true/false` |
| 诊断轨 | **`runEnd` 字段**，取值 `"engine"` 或 `"audit"` | `"engine"` 盖在 `apply.end`（门禁拒绝那一路是 `apply.gate.reject`）上，由 `lib/core.js` 盖；`"audit"` 盖在写审计的四个入口之后补的那条 `audit.recorded` 上。**一个进程可能两条都有** —— 判收尾看的是「有没有任一 `runEnd`」，**不是「`apply.end` 这个事件在不在」**：`apply.end` 只是 `"engine"` 那一档的载体，把它当成标记本身，遇到「有 `apply.end` 但没盖章」的老行就会判错 |

**判据是「有没有」，不是「最后一条是不是它」。** 这一点是硬要求：一轮末尾可以有任意多条像收尾的事件（`install.record`、`audit.recorded`、`cli.apply.done` …），按「末行是层结论」判，每加一条就会把正常的轮判成中断一次。旧写法（末行是层结论）已经作废。

标记之外还有四条**集合**判据（判的是「记录自相矛盾」，不是轮边界；`audit check` 一起跑）：

1. **每个有文件层事件的层，都有自己的结论** —— 缺一个就是在那层之前断了。
2. **结论自带的 `detail.completeness.layers` 为真时，三层都必须在场** —— 这个布尔是落账方在动手写之前按整批补丁算的，所以「声称记全了、实际少一层」只可能是被截断。
3. **层第一次出现的顺序是 `prompt → code → tool` 的子序列。**
4. 层结论的 `applied+failed+skipped` 合计必须等于那一层出现过的不同补丁号个数（一条补丁落多个文件时，行数多于补丁数）。

**老口径不判收尾**：没有 `detail.runEnd` 的轮，`audit check` 打印 `judgeable=false`（不可判），既不算收尾也不算截断，不进退出码。分两档：`v2-entry`（有 `detail.considered` / `expectedRows`）与更早的行（连分母都没有）。拿新判据去判旧日志会把它全判成中断，而真相是判据没依据 —— **判不了收尾不等于被截断**。旧规则（末行是不是层结论）只作信息项 —— 它依赖记录的排列，不再是判据。

**判不了的一条，如实写在这里**：某一层本来就没有可落账的补丁、而这一轮正好在它之前被杀 —— 判据 1 看不见它，判据 2 的布尔也可能是假。有标记的那一代由标记兜住；没有标记的那一代只能靠诊断轨的 `apply.start` … `apply.end` 窗口判。

**完整性的分母是补丁表加上这一轮的 `selected`，不是 `detail.considered`。** 这一条与轮边界并列跑：`audit check` 直接 import `lib/patch/table.js` 的 `ALL_PATCHES` 拿全表口径的 `total` / `exempt` / `unmapped`，再拿写侧记下的 `detail.table.selected` 收窄到这一轮真选中的补丁：

- `selected` = 这一轮 report 里出现过的补丁号（含进了 `unresolved` 的；不含没选中的全表条目）；
- 该落账的 = `selected ∖ exempt ∖ unmapped`；
- 这一轮的 = 文件行的补丁号 ∪ 各层 `detail.unresolved` ∪ `detail.exempt` ∪ 盖章那条结论的 `detail.table.unmapped`；
- **缺口 = 该落账的 ∖ 这一轮的**，必须为空；不为空就点名是哪些 id。
- 没有 `selected` 的过渡日志按补丁表全量算（非 `auditExempt` 的全部 id），并记一条「无 selected，按全表判」信息项 —— 这一档判的是老写法，不是过滤 apply。

`detail.considered` 仍然在每层结论里，但它**不再当分母** —— 它是落账方「我折进来了这几条」的声明，漏算时它自己也不知道。真机上 66 条只覆盖 63 条、缺的三条既不在 `unresolved` 也不在 `exempt`，而所有判据都是绿的：那三条是兼容类补丁（`0.1.5 兼容` / `0.2.0 兼容`），压根没有层，按层组织审计结构上就记不下它们。所以新口径要求落账方在盖章那条结论的 `detail.table.unmapped` 里**逐条列出来**；不列就红并点名。`unmapped` 只许放补丁表里**真的没有层**的 id —— 把有层的补丁塞进去（等于从分母里删掉它）直接判红。

与诊断轨互证（`--diag` 给了 diag 那一份时才算）：

```
node bin/dsh-purge.js audit check --jsonl <审计目录里的某一天>.jsonl --diag <DSH_HOME>\dsh-purge\logs\diag.jsonl
```

它逐轮比**三件事**，方向写在结论里：

1. 诊断轨里必须有这一轮的 `apply.start` 与 `apply.end`（或 `apply.gate.reject`）；
2. 审计侧每个文件行的补丁号与 `detail.status` 必须在诊断轨的 `apply.patch` 里同号同状态；
3. **反过来也查**：诊断侧有一轮完整的 apply（有起点、**结束事件上有 `runEnd`**、`entry` 属于写审计的四个入口）而审计侧 0 行，同样红，并写明「方向是『诊断有、审计缺』」与那个 `entry`。没有 `runEnd` 的上一代只记「无法判定当时是否该写审计」，不判红；一条 `apply.patch` 都没有（`apply.end.total` 为 0 或空）的轮也没有可落账的判定，只记「没有逐补丁判定」，同样不判红（边界见本节末）。

任何一条对不上就退出码 1，并点名是哪一轮、哪条补丁、哪个方向。**「诊断有、审计缺」这一档原先不存在** —— 真机上两个完整的 CLI apply 在审计轨 0 行时，所有判据都是绿的。

**五个不该判红的边界，各自单列成 `·` 信息项**：

- `entry` 属于不写审计轨的五个入口（`startup-auto` / `reapply` / `reapply-cli` / `http-restart`）：那不是缺记录，是设计边界。
- 这一轮早于诊断轨现存的**第一行**：诊断轨留 8 代（`.1`–`.8`），那一刻之前的轮次在诊断轨侧**不可判**。这类行会写成「不可判 —— 不是日志残缺」。**`--dir --diag` 在健康机器上也曾经因此 exit 1**，那是假红。
- 诊断轨里那一轮的**本地日期不在你给的审计文件里**：只判 `2026-10-24.jsonl` 却拿着一份跨到 10-25 的诊断轨，10-25 的轮次报「审计缺」是假红，真相是那一天的文件根本没给。
- 诊断轨的结束事件上**没有 `runEnd`**（上一代）：那一代还没有「一轮结束就该落审计」这个约定（CLI 落审计比第一个章早了几个小时）。只记「上一代（无 runEnd）：无法判定当时是否该写审计」，**不进 `missingAudit`**。
- 诊断轨里那一轮**一条 `apply.patch` 都没有**（`apply.end.total` 为 0 或空：门禁拒绝、一台宿主都没找到、过滤后 0 条）：报告为空 → 不落审计是设计边界，**没有可落账的判定，审计 0 行不是缺记录**。只记「没有逐补丁判定」，不进 `missingAudit`。

**补丁号的次序不比。** 审计轨按「层分组 + 层内补丁号升序」写（prompt / code / tool 各一组），诊断轨按补丁表顺序写（表里 70、73 紧跟 1、2、3）—— 两套排序规则本来就不同。把次序当判据，会让每一轮都报「对不上」：真机上三个 CLI apply 全中过这一条。次序差异只作为信息项打印（`audit check --diag` 的 `·` 行、`audit why` 的 `·` 行），**那不是在说日志坏了**。

`--diag` 报「诊断轨里没有这个 runId」时，先别当成日志丢了：诊断轨留 8 代（约 58 小时）、而审计轨留 30 天，两边保留期不同 —— 审计轨有、诊断轨没有，最常见的原因就是诊断轨被滚掉（第 4 节也记着这条边界）。`audit why` 已经把 `.1` 一起读，所以「刚被滚掉的那一轮」它能看见；`audit check --diag` 给的是单个文件，滚过的那一轮按上面那条记为「不可判」。

---

## 4. `runId` 怎么把两条轨串起来（以及今天的边界）

`runId` 的形状是 `apply-<UTC 时间戳到秒>-<4 位十六进制>`，例如 `apply-20261025T101548Z-10fe`。**两条轨用的是同一个生成器**（`lib/diag-log.js` 的 `newApplyRunId`，审计侧 `lib/audit/report.js` 在调用方没给 `runId` 时生成同形状的值），所以可以直接当同一个键 join。

join 的做法：

```
# 诊断轨：这次 apply 的全部行（把 <runId> 换成第 0 步抄到的值）
Select-String -Path <DSH_HOME>\dsh-purge\logs\diag.jsonl -SimpleMatch '"runId":"<runId>"'

# 审计轨：同一次 apply 的全部行
Select-String -Path <DSH_HOME>\dsh-purge\audit\*.jsonl -SimpleMatch '"runId":"<runId>"'
```

**写入面：四个 apply 入口都写审计（本包起）**

- `http` / `command` / `tool` / `cli` 四个 `entry` 两轨都有，且 `runId` 相同 —— 这四条能真 join。
- `startup-auto` / `reapply` / `reapply-cli` / `http-restart` 五个入口**只有诊断轨**。它们各自要么是宿主内部重打（拿不到「一次用户 apply」的边界），要么是二级路径，审计轨里找不到它们的 `runId` 不是丢日志。
- 所以：**审计轨有、诊断轨没有**，先怀疑诊断轨被滚动覆盖（留 8 代（`.1`–`.8`））或被搬走；**诊断轨有、审计轨没有**，先看 `entry` 是不是上面那 5 个之一 —— 是的话这不是缺陷，是设计边界。旧样本里这一条曾被写成「审计轨里永远找不到它们的」，那是本包之前的形态；现在只剩这 5 个入口。这一轮如果**一条 `apply.patch` 都没有**（aborted / 0 补丁，`apply.end.total` 为 0 或空），审计 0 行同样不是缺记录 —— 报告为空就不落账（读法边界见第 3.1 节末）。剩下的才是真的缺。
- 审计轨的 `runId` 与诊断轨的 `runId` 都是「**一次尝试**」的粒度，不是「一次成功」。一次失败重试会有两个不同的 `runId`。
- **审计行自己带 `entry`（本包起）**：只读审计轨就能答出「这一轮是谁触发的」，不必再去诊断轨。这一条在诊断轨被滚掉之后是唯一的答案来源 —— 那是时间不可逆的损失，所以不许再把来源只留在诊断轨上。
- **`session` 字段已退役（本包起正式记账）**：审计行不再有 `session`，也不再打算有。理由有两条：① 落账方拿不到会话上下文（四个入口各自能握手的东西不同，硬造一个字段只会在四个入口上写出四种含义）；② 同一会话里的多次 apply 已经能用 `entry` + 时间 + `runId` 串起来，而 `session` 会给出一个**看起来更权威**的键，读者会以为它是可靠的。**旧日志里残留的 `session` 照样读得回来**（读侧不查白名单），但它今天不产生、以后也不会产生新的。schema 里也**已经把它删掉**（`architecture/audit.schema.json` 没有这个键，写侧白名单也没有）—— 留着空位只会让读的人以为它可靠。
- **`startup.ready` 不在这个 join 里**：它不带 `runId`（也不带 `entry`），按 `runId` 捞一轮时不会捞到它。它是「宿主这次启动」的锚点，要按时间读，不要按 `runId` 捞（第 2.2 节）。
- **`cli.apply.ensure` / `cli.apply.done` 也不在这个 join 里**：这两条既不带 `runId` 也不带 `entry`，而它们恰是 CLI 侧「这一轮有没有收尾」最直接的阳性证据。按 `runId` 捞一轮**永远**捞不到它们；只能用时间相邻（落在同一次 `cli.apply.begin` … `cli.apply.done` 之间）把它们认领回来。任何日志里都没有这个标记，这是已知缺口，不是执行错了。

---

## 5. 入口（`entry`）九个值：谁点的 apply / revert

`entry` 回答「这次是谁触发的」。它由入口自己声明、由 `lib/diag-log.js` 的环境身份层补进每一行，引擎本身不认识它。**九个值是全部**，没有第十个；apply 与 revert 共用这九个取值（revert 只用到 `http` / `command` / `tool` / `cli` 四个）。

| `entry` | 谁点的 | 入口位置 |
| --- | --- | --- |
| `command` | 宿主里的 `/purge apply` 斜杠命令 | `lib/index.js`（命令注册名 `purge`） |
| `tool` | 宿主工具 `purge_apply` | `lib/index.js`（工具注册名 `purge_apply`） |
| `http` | 面板「应用」按钮 → `POST /dsh-purge/apply` | `lib/index.js` |
| `cli` | 命令行 `dsh-purge --apply` | `bin/dsh-purge.js`（两条分支各一处，见 `sealed`） |
| `startup-auto` | 宿主启动后 settle 阶段的自动 apply（配置项 `autoApplyOnStart`，默认开） | `lib/index.js` |
| `reapply` | 宿主进程内重打（升级后回写） | `lib/reapply.js` |
| `reapply-cli` | 重启脚本的**子进程**重打（跨进程拿不到父进程身份，子进程自己声明） | `lib/reapply-cli.js` |
| `http-restart` | 面板「重启」→ `POST /dsh-purge/restart`（二级间接路径：先清洗再重启） | `lib/index.js` |

`sealed` 是**独立布尔，不是入口**：它只出现在 `cli` 入口的行上，意思是「这次 apply 面对的是密封的 `app.asar`」（`true` = 走「先解开归档再打」那条分支）。`sealed` 缺失 = 这个入口不关心密封状态，**不等于 `false`**。

`startup.ready` **不带 `entry`**：它不是 apply，所以上表里没有它，也不该有。硬塞一个入口值会让「按入口筛一次 apply」筛出与那轮无关的启动记录。

**`revert` 家族也带身份（本包起）**：`revert.start` / `revert.file` / `revert.file.fail` / `revert.fail` / `revert.end` 五条由 `lib/core.js` 的 `revertAllHostsFor(entry, options)` 统一声明一次身份，四个入口（面板 / `/purge revert` 命令 / `purge_revert` 工具 / CLI `--revert`）都从这里进；同一次还原的五条 `runId` 相同。`runId` 仍由 `newApplyRunId` 生成（形状还是 `apply-<时间戳>-<4 位>`），按值检索不必区分 apply 与 revert。

**★ 看到没有 `entry` / `runId` 的 `revert.*`，先认世代，别一律归因卸载路径。** 两种可能：
1. **本包之前的老行** —— 那一版 CLI `--revert` 与卸载路径**都不带身份**，所以 `10:13`、`13:07` 那种紧跟 `cli.invoke mode="--revert"` 却无身份的 `revert.start`，是**旧版 CLI**，不是卸载；
2. **卸载路径**（`lib/uninstall.js` 仍直调 `revertAllHosts`）—— 这一种到现在都没接线。

判法是看**同一次还原前面有没有 `cli.invoke --revert`**：有就是旧版 CLI，没有才可能是卸载。**把「无身份」整体归因于卸载路径，会把旧版 CLI 的轮次讲错因果。**

---

## 6. 两个事件名的权威

两条轨各有一份「合法名字」的清单，互相不通用：审计轨查词表，诊断轨只看代码里有没有这个发射点。

### 6.1 审计轨的事件名

审计轨以 `lib/audit/vocabulary.js` 的 `EVENT_NAMES` 为唯一权威，共 16 个。不在表里的名字**写不进审计轨**（写侧会抛错）；读旧日志时不查词表，所以旧名字照样能读回来。

| `event` | 什么时候出现 |
| --- | --- |
| `prompt.patch-applied` | 提示词层：一个目标文件上真的插入了 marker |
| `prompt.patch-miss` | 提示词层：该文件上没找到 marker |
| `prompt.patch-skipped` | 提示词层：这个落点这一轮不需要动 |
| `prompt.apply-result` | 提示词层的结论（每层一行） |
| `code.patch-applied` | 代码层：一个目标文件上真的改写了 |
| `code.patch-miss` | 代码层：marker 没命中 |
| `code.patch-skipped` | 代码层：这个落点这一轮不需要动 |
| `code.apply-result` | 代码层的结论 |
| `tool.patch-applied` | 工具层：一个目标文件上真的改写了 |
| `tool.patch-miss` | 工具层：marker 没命中 |
| `tool.patch-skipped` | 工具层：这个落点这一轮不需要动 |
| `tool.apply-result` | 工具层的结论 |
| `cli.invoke` | 事件层：一次 CLI 调用（**今天审计轨没有写入方**，只出现在诊断轨） |
| `route.reject` | 事件层：一个路由拒绝（今天没有写入方，属预留） |
| `code.probe` | 测试与冒烟脚本构造的探针事件（不是生产写入方） |
| `tool.loaded` | 同上，工具装载事件 |

词表里有名字**不等于**有写入方：`cli.invoke` / `route.reject` 今天在审计轨上是 0 行。名字出现只说明「这个词合法」。

### 6.2 诊断轨的事件名

诊断轨没有词表，合法名字的判据是「代码里有一个发射点」，今天共 29 个。第 2 节覆盖 `apply.*` 与 `install.record`；下面补齐其余 22 个。

| 事件 | 什么时候出现 | 关键字段 |
| --- | --- | --- |
| `cli.invoke` | 每次 CLI 启动（`audit` 子命令除外：它在写这条之前就分流了） | `mode` / `args` / `node` / `surface` / `dsh_home` / `ai_base` / `plugin_version` |
| `cli.diagnose` | `--diagnose` | `counts`（已清洗/总数）/ `asar_sealed` / `gate` |
| `cli.apply.begin` | `--apply` 开始 | `sealed` / `inject_source` |
| `cli.apply.abort` | `--apply` 早退 | `reason`（`empty_inject` / `no_ai_base`）+ `detail` |
| `cli.apply.ensure` | 密封包路径的清洗结果 | `ok` / `error` / `pending` / `failed` / `hosts` |
| `cli.apply.done` | `--apply` 收尾体检 | `hosts` / `applied` / `pending` / `skipped` / `total` / `flash_ok` / `asar_sealed` / `audit_events`（这一轮审计轨落了几行，0 表示没有逐补丁报告）/ `log` |
| `cli.unseal` | `--unseal` | `asar` / `renamed` / `pending` / `busy` / `update_pending`（盘上待装包的路径；空串表示没有） |
| `host.update.pending` | 盘上有待装的官方更新包，且这一轮动过（或安排动）归档（解封是稳态，两者相撞会把 `runtime` 清空） | `installer` / `recovery`（可直接执行的修复命令）/ `channel` / `asar` / `outcome`（`done` / `scheduled` / `skipped`，写结果不写意图） |
| `host.unsealed.update-pending` | 启动时**已经**解封且有待装包 —— 那一刻宿主还能起来，是最后一次能留下证据的机会 | `installer` / `recovery` / `channel` / `archive_bak` |
| `cli.revert.done` | `--revert` 收尾 | `files` / `errors` / `detail` |
| `cli.fail` | CLI 顶层异常 | `error` / `code` / `stack` |
| `revert.start` | 开始还原 | `discover`；带 `entry` / `runId`（本包起） |
| `revert.file` | 一个文件被还原 | `base` / `path`；带 `entry` / `runId` |
| `revert.file.fail` | 一个文件还原失败 | `base` / `path` / `error`；带 `entry` / `runId` |
| `revert.fail` | 一个宿主整体失败 | `base` / `error` / `code` / `stack`；带 `entry` / `runId` |
| `revert.end` | 还原收尾 | `files` / `errors` / `ms`；带 `entry` / `runId` |
| `apply.audit.fail` | 审计落账写盘失败 | 与那次 apply 同一个 `runId`；`error` / `code` / `stack`。出现它说明这一轮没有审计证据，不是「审计说没事」 |
| `audit.recorded` | 审计落账**成功**（与上一条对称的正向证据） | `runId` / `entry` / `actor` / `events`（落了几行）/ `skipped` / `unresolved` / `layers`（`prompt:ok,code:partial,…`）/ `readme`（读法投递结果 `installed` / `kept` / `failed`）/ `cards`（写了几张失败卡）/ `cardPath`。**没有它就只能靠「没看到 apply.audit.fail」反推** —— 那是缺席证明 |
| `prune.removed` | 按保留期删掉了审计文件（每天首次写入时才有机会触发一次） | `removed` / `names` / `retainDays`。它是「日志为什么变短了」的唯一答案 |
| `prune.capped` | 单日代数顶到上限（24 代），之后继续写最后一代 | `day` / `generations` / `file`。看到它说明那一天的日志量已经不是一个文件能装下的 |
| `vuln.record` | 演练台事实库写入一条漏洞记录 | `engagement`（靶标 id）/ `vuln`（记录号）/ `asset` / `severity` / `status` / `updated`。只带定位标识，不含标题与证据正文 |
| `report.generate` | 演练台生成一份成果报告 | `engagement` / `results` / `accesses` / `credentials` / `chain_steps` / `include_all` / `bytes`。不含报告正文 |
| `startup.ready` | **每次宿主启动**（无条件的，补丁已对齐、跳过重打时也记；同一进程只记一条） | `version`（插件版本）/ `patchesMatch`（引擎判「补丁已对齐」）/ `appliedStamp`（`<version>@<sha>@<at>`，来自 `applied.json`；空串 = 没有对齐戳）/ `pending`（没打上的补丁号，逗号串；空串 = 一条不缺）/ `pendingCount` / `alignmentReason`（`""` / `"pending"` / `"stamp"` / `"no-ai-base"` / `"read-error:…"`）/ `appliedRunId`（这次启动读的是哪一次 apply）。**它不带 `entry` / `runId`**：它不是 apply，是启动 |
| `preset.migrated` | 启动时把已装预设副本迁到当前形状（宿主不再接受的字段被删掉） | `file`（被改的副本文件名）/ `fields`（删掉的字段名，逗号串；同一个字段出现几次就列几次）。一条运行最多一条 —— 迁完就没有可迁的 |
| `preset.drift` | 预设落地后「仓库源 vs 已装副本」逐文件比对不一致，**一个文件一条** | `file` / `repoSha` / `installedSha`。任一侧为空串 = 那一侧没有这个文件，与「两侧一样」不是一回事。副本没被强制刷新时它会在每次启动重现：那是「副本不是随包那一版」，不是每轮都在新坏一个文件 |
| `preset.refreshed` | 副本被**确认是旧格式**（删过宿主不收的字段或旧转义重复行）且修完仍漂移 → 按仓库模板整份重渲染，**一次刷新一条** | `file` / `backup`（旧副本的备份目录，覆盖前先存的那一份）/ `before` / `after`（刷新前后的漂移文件数）。`after` 为 `0` 才算收敛；备份目录为空说明没动手（宁可不收敛也不覆盖用户的路径） |
| `host.logger` | 插件装载时装「镜像到宿主日志面板」那层 | `installed`（`"true"` / `"false"`）/ `reason`（没装成的原因）/ `events`（会镜像的事件名个数）。**它是这一档唯一的自证**：`installed="true"` 却在宿主日志里找不到 `[dsh-purge]` 行 ⇒ 是宿主不落盘，不是插件没接线 |

三个字段的取值语义（只看名字读不懂的那几个）：

- **`cli.unseal` 的 `renamed` / `pending` / `busy`** 说明「这次有没有真的把 `app.asar` 挪开」：

  | 组合 | 意思 | 之后靠什么继续 |
  | --- | --- | --- |
  | `renamed="true"` | `app.asar` 已被改名挪走，宿主下次启动读解包目录 | 直接重启 |
  | `renamed="false" busy="true"` | 改名被占用（宿主进程锁着文件），这次**没挪成** | 先完整退出宿主，再跑一次 `--unseal` |
  | `renamed="false" pending="true"` | 这次不挪，已安排「下次启动时换归档」 | 重启一次，看下一条 `cli.unseal` / `apply.end` 的 `asarSealed` 是否转 `false` |

  三者不是互斥的进度条，是三种不同结局：`busy` 是真失败，`pending` 是延后，`renamed` 是完成。

- **`install.record.files`** 是「这次写进指纹文件的目标文件数」。它会随宿主版本与补丁表的落点数变化（真机见过 `74` → `79`），**不是**补丁条数，也不是「应该有多少个文件」的判据；只要同一轮 `ok="true"`，这个数字变大变小都不算异常。

- **`appliedStamp` 的 `<sha>` 段不是文件内容哈希**：真机上长成 `apply:2.0.0`（`apply:` + 版本号）。整串 `<version>@<sha>@<at>` 里，`version` 是插件版本，`<sha>` 是**对齐戳的来源标记**（今天恒为 `apply:<版本>`），`at` 是写戳时刻。**只把它当时间锚用**，不要当文件摘要用。

---

## 7. 判「卡住」的清单：症状 → 去哪个文件哪个字段 → 下一步跑什么

每一条都按「先给结论、再给证据行、再给下一步」写。**症状不在表里时，先按第 0 步判完整性，再把这次 `runId` 的全部行按时间读一遍 —— 不要凭事件名猜。**

| 症状 | 在哪个文件哪个字段确认 | 下一步具体跑什么 |
| --- | --- | --- |
| **版本门禁拒绝** | `diag.jsonl`：`apply.start` 之后紧跟 `apply.gate.reject`，同一 `runId` 没有 `apply.patch` / `apply.end`；字段 `hostVersion`（宿主实际）与 `dshTarget`（补丁表要求）不相等，`rejected` 是被拒的宿主根 | `node bin/dsh-purge.js --diagnose`（输出里的 `version_gate` 会给出同样的判定；它会往 diag 追加一条 `cli.invoke`/`cli.diagnose`，这本身也是证据）。判「该改谁」时比 `hostVersion` 与 `dshTarget`：**不是把门禁放宽，是换匹配的宿主版本或补丁表** |
| **补丁 miss / 读写失败** | 诊断轨：`apply.patch` 里 `status` 是 `pattern_not_found` / `read_error` / `write_error:…` 才是问题（`applied` / `already` / `skipped` / `na` 正常，`missing_file` 与 `off` 是「这一版不需要」不算失败）。汇总看 `apply.end` 的 `failed`（含读写错误）、`readError` / `writeError`，以及 `apply.host` 的 `failed`（硬失败）与 `soft`（可接受）。审计轨对应 `{层}.patch-miss`，命中数看 `evidence.hits`；`{层}.patch-skipped` 是这一轮不需要动的落点 | 拿 `id` 与 `name` 去查这条补丁声明的目标文件与 marker：`node bin/dsh-purge.js --diagnose` 会给出每个目标文件「存在 / 有无 marker / 有无备份」。**`skipped` 不是失败**，只是 `apply.end` 不统计它，造成 `total` 与 `applied+already` 差几条 |
| **某条补丁 `missing_file`（缺件）** | 诊断轨：`apply.patch` 的 `status` 是 `missing_file`，`apply.end` 的 `missingFile` 计数，**不在 `failed` 里**。含义是这条补丁的全部候选路径在当前宿主都不存在 —— 这批补丁本来就不适用（真机干净宿主上的 5 条就是 `preset-unrestricted` 与 hooks 四个 key 全缺） | 确认它确实不该生效：`node bin/dsh-purge.js --diagnose` 会列出每个目标文件的「存在 / 有无 marker / 有无备份」。**别把它当失败去修** —— 要追的是同一轮里有没有 `read_error` / `write_error:` |
| **apply 中途没有收尾标记** | 诊断轨：同一 `runId` 的行里**结束事件上有没有 `runEnd` 字段**（`apply.end` 是 `"engine"`、`audit.recorded` 是 `"audit"`；门禁拒绝那一路的载体是 `apply.gate.reject`）。判据是「有没有」，**不是「最后一条是不是它」** —— `install.record` / `audit.recorded` 排在它之后都不算中断；`cli.apply.ensure` / `cli.apply.done` 不带 `runId`（实测），按 `runId` 过滤捞不到它们也不算中断，按文件顺序读到的 `cli.apply.done` 同理。审计轨一侧看盖章：`audit check` 的 `sealed=false` 且 `judgeable=true` 才是真截断（第 3.1 节） | `node bin/dsh-purge.js audit check --dir <审计目录>`（判审计轨有没有盖章）；然后原样再跑一次 `dsh-purge --apply` 看是否复现。中断点之前最后一条事件就是现场 |
| **审计轨有 `partial`** | 审计轨：`{层}.apply-result` 的 `result` 是 `partial`。**先读 `detail.partialReason`**（新口径直接给值）：`layer` = 层内部分成功（正常形态，不是缺口）；`record` = 记录不完整（这才是缺口）。老口径没有那个字段时按第 3 节那张表自己推。`unresolved` 里的编号是「写不出证据」的补丁 | `node bin/dsh-purge.js audit why <runId>`（或 `GET /dsh-purge/audit?seq=<该行 seq>`）顺 `evidence.refSeq` 找到本层最后一条文件事件。若 `completeness.files=false`，去查那一层的 `before` 摘要是不是没采到 |
| **日志断号 / 坏行 / 末行截断** | `audit check` 输出的 `gaps`（序号缺哪几个）/ `badLines`（第几行解析不了，1-based）/ `lastLineTerminated`（末字节是不是换行）。**坏行只丢那一行，其余照判**；末行没换行 = 写入被打断 | `node bin/dsh-purge.js audit check --jsonl <某个 .jsonl>`；退出码 1 就是有判据不过（三档见第 8 节）。有 `gaps` 时先看是不是轮转（跨文件从 0 重新计数是正常的） |
| **某个入口根本没出现** | 诊断轨：按 `entry` 过滤 0 命中。先分清三种：① 这个入口**已随死代码删除**（`startup-inject`，删了就别再找它）；② 这次没走这条路径（`http-restart` 只在面板点重启时出现；`reapply-cli` 只在重启脚本子进程里出现；`startup-auto` 只在启动 settle 阶段且补丁未清洗时出现）；③ 被更早的分支挡掉了（`cli.apply.abort` 的 `reason`） | `Select-String -Path <DSH_HOME>\dsh-purge\logs\diag.jsonl -SimpleMatch '"entry":"<值>"'`；0 命中时改查该入口的早退事件：`Select-String -Path <DSH_HOME>\dsh-purge\logs\diag.jsonl -SimpleMatch 'cli.apply.abort'` |
| **两轨对不上** | 审计轨有 `runId`、诊断轨 0 命中 → 诊断轨滚过或搬过（留 8 代（`.1`–`.8`））；诊断轨有 `runId`、审计轨 0 命中 → 先看 `entry` 是不是那 5 个不写审计的入口（第 4 节） | 两侧同一个值各搜一次，或直接 `node bin/dsh-purge.js audit why <runId>`（它会把两轨并排打出来并判一致）：`Select-String -Path <DSH_HOME>\dsh-purge\audit\*.jsonl -SimpleMatch '"runId":"<值>"'` 与诊断轨同样的命令。两侧都 0 命中才算真丢 |
| **还原（revert）有没有做成** | 诊断轨：`revert.start` → 每个文件 `revert.file`（或 `revert.file.fail`）→ `revert.end` 的 `files` / `errors`。五条都带 `entry` / `runId`（卸载路径除外），可以按入口筛 | `Select-String -Path <DSH_HOME>\dsh-purge\logs\diag.jsonl -SimpleMatch 'revert.end'`；`files` 与 `errors` 都在这一行上，不必数明细行 |
| **补丁写在解包目录，宿主仍读密封归档** | `cli.apply.done` 的 `asar_sealed` 与 `apply.end` 的 `asarSealed` 都是 `"true"`；`apply.host` 的 `markers` 也可能是 `true`（那只说明写到了引擎算的 `aiBase`） | `node bin/dsh-purge.js --unseal`（先完整退出宿主，再挪归档；`cli.unseal` 的 `renamed` / `busy` / `pending` 三档见第 6.2 节说明这次挪成没挪成） |
| **补丁是 `skipped` 而不是 `pattern_not_found`** | 审计轨：`{层}.patch-skipped` 的 `detail.status`。`already` = 文件里已经有 marker（不必再插）；`skipped` = 这一轮不需要动；`na` / `off` = 当前面不适用 / 被设置关掉 | `node bin/dsh-purge.js audit tail --n 50 --layer code --event code.patch- --status applied,skipped,pattern_not_found,read_error,missing_file`；要看**这一轮没打上的**就带 `--status`（不带就是全量，`already` 也在里面）；**`skipped` 不是失败**，`apply.end` 不统计它，所以「总数 = applied + already」会差几条 |
| **改了补丁、重启过，却看不出生效** | 诊断轨：那一轮 `apply.end` 的 `pendingRestart`；**它之后**有没有 `startup.ready`，那条的 `patchesMatch` 与 `appliedStamp`。`pendingRestart="true"` 且其后没有 `startup.ready` = 宿主没重启过；有 `startup.ready` 但 `patchesMatch="false"` = 启动了、补丁没对齐（第 2.2 节给了三种推论） | `Select-String -Path <DSH_HOME>\dsh-purge\logs\diag.jsonl -SimpleMatch 'startup.ready'`；再按 `runId` 捞那一轮，看 `apply.end` 的 `pendingRestart` 与 `asarSealed` |
| **审计轨看不出这一轮收尾没有** | `audit check` 的 `runs:` 那几行：`（收尾 N / 截断 M）` 里的 `M` 不是 0 就说明有轮被截断，逐行的 `closed=false` 后面跟着理由（第 3.1 节）。**别拿「三层都有结论」当收尾证据** —— 层层之间被切断时也长这样 | `node bin/dsh-purge.js audit check --jsonl <某一天的审计文件>`；另给 `--diag <诊断轨>` 可再判两轨对不对得上 |

---

## 8. 可用的命令

### 8.1 `audit check`：断号 / 坏行 / 末行 / 轮边界 / 复算完备性

```
$ node bin/dsh-purge.js audit check --jsonl test/fixtures/audit-f6.jsonl
file: <仓库根>\test\fixtures\audit-f6.jsonl
lines: 7（非空行）  events=7 seq=0..6 gaps=[] badLines=[] terminated=true
gaps: []
badLines: []
lastLineTerminated: true
runs: 1（收尾 1 / 截断 0）无 runId 行 0
  apply-20261024T090450Z-test  rows=7 seq=0..6 layers=prompt→code→tool closed=true sealed=true judgeable=true lagMs=7 ms
  · apply-20261024T090450Z-test：老口径（没有 detail.table）：按补丁表复算，3,70,73,6,7,11,12,13 …（共 61 条）：补丁表里有、这一轮既没有文件行也没有 unresolved，也没有在 detail.table.unmapped 里交代 —— 旧规则不判红，但缺口是真的
ok: true
```

这份输出读三处就够：`closed=true` / `sealed=true`（这一轮盖了结束标记）、`judgeable=true`（判据有依据）、以及那条 `·` 信息项 —— 这是一份**只含 4 条补丁的手工夹具**，拿它对本机 66 条的补丁表，缺口当然是 61 条；`·` 说明「旧规则不判红」，真机整轮不会出现这一条。

参数：

- `--dir <目录>`：判这个目录**这一层**下的全部 `.jsonl`（不往子目录里找）。填**含 `*.jsonl` 的那层目录本身** —— 审计落点若是 `…\dsh-purge\audit`，就给它 `…\dsh-purge\audit`；给上一层的 `…\dsh-purge` 判不到文件（目录里没有 `.jsonl` 按环境错误退 `2`，不会假绿）。
- `--jsonl <文件>`：只判一个文件。**手上只有一份日志时用它**，不要拿 `--dir` 指它的父目录。
- `--run <runId>`：只判这一轮。审计轨缺它而诊断轨有它时**照样红**，并写明方向 —— 「我知道这一轮跑过，为什么日志里没有」正是这条参数要回答的问题。
- `--diag <文件>`：另给一份 `diag.jsonl`，逐轮做两轨对账（第 3.1 节）。不给就不判跨轨，`cross:` 那一行也不会出现。
- 两个判法参数只能给一个（`--jsonl` 与 `--dir` 同时给按用法错误退 `2`）；都不给时判 `~/.dsh/dsh-purge/audit`。
- **默认值与 `DSH_HOME` 无关**：审计日志的**写入**落点跟着 `DSH_HOME` 走（`<DSH_HOME>/dsh-purge/audit`），而这条命令的**默认值**写死 `~/.dsh/dsh-purge/audit`，**不读 `DSH_HOME`**。你的审计目录在别处（设过 `DSH_HOME`、或日志是从别的机器取回来的）时必须显式给 `--dir`，否则它判的是另一个目录 —— 那个目录可能根本不存在（退 `2`），也可能是几十天前的旧日志（判绿了更误导）。
- `--json`：输出结构化结果（逐轮结论在 `runs` 里，跨轨对账在 `cross` 里）。

输出里两个容易读漏的东西：

- **`lagMs`**：那一轮的最大写入积压（`ts − observedTs`）。它说的是「审计管道本身滞后多久」，不是「apply 跑了多久」。`（无 observedTs）` = 旧口径的行，判不出来。
- **`·` 开头的行是信息项，不参与退出码**：老口径无法复算、诊断轨滚过导致这一轮不可判。它们不是「日志坏了」，但它们必须可见。

五件判据，任一不过就退出码 `1`：文件内序号断号、坏行、末行没换行、**有轮被截断**（第 3.1 节的四条规则）、**层结论的 completeness 与它自己的 `detail` 对不上**。给了 `--diag` 时再加一条：两轨对账**两个方向**都必须对上（补丁号与状态逐条比，次序不比）。

**手上只有日志文本、跑不了命令时的手算步骤**（判据与 `audit check` 同口径，只是用眼睛跑）：

1. **断号**：把这份文件里的 `seq` 全抄出来排序，从 0 开始看有没有缺。缺的那个号就是断号；**每个文件各自从 0 起，跨文件不连续是正常的**（换文件时重新从 0 开始）。
2. **坏行**：逐行看行首能不能对上 `{"ts":`；对不上的那一行就是坏行（1-based 行号即 `badLines` 的值），它只损失自己。
3. **末行**：文件的最后一个字节是不是换行。没有换行 = 写入被打断，最后那条记录可能是半条。
4. **轮边界**：按 `runId` 分组，每组**必须有一条带结束标记的行** —— 审计轨看层结论上有没有 `detail.runEnd: true`，诊断轨看有没有 `runEnd` 字段。**不要看「最后一行是不是 `{层}.apply-result`」**：那是旧写法，已作废（见第 3.1 节）。再加三条集合判据：每个出现过 `{层}.patch-*` 的层都要有自己的结论；`detail.completeness.layers` 为真时三层都要在场；层结论的 `applied+failed+skipped` 合计等于该层出现过的不同补丁号个数。
5. **复算完备性**：拿那层结论的 `detail.considered` 逐个对「有没有它的文件行」、拿 `detail.expectedRows` 对文件行数、看每行有没有 `before` / `after`。对不上就是这条结论在夸大自己；缺这几个字段的老行只能记一句「无法复算」。
6. **补丁表分母**：有 `detail.table.selected` 时，这一轮该落账的 = `selected` 去掉 `exempt` / `unmapped` 的 id；没有 `selected` 的过渡日志才是补丁表里非 `auditExempt` 的全部 id。与「文件行里出现的 id ∪ `unresolved` ∪ `exempt` ∪ `detail.table.unmapped`」做差。差集非空就是缺口，**点得出是哪几个 id** —— 这是唯一一条不依赖落账方自述的判据。

这六步只对**审计轨**成立。诊断轨没有 `seq`，手算不了断号；它的轮边界同样看**有没有 `runEnd` 字段**（`"engine"` 或 `"audit"`），不看末行是哪个事件 —— 一轮末尾可以有 `apply.end` → `install.record` → `audit.recorded` → `cli.apply.done` 任意多条，按「末行是什么」判每加一条就失效一次。

退出码三档：`0` = 全过；`1` = 有判据不过；`2` = 用法或环境错误（目录不存在、目录里没有 `.jsonl`、参数写错）。**`2` 不是通过** —— 它只证明你没判到东西。

### 8.2 `tail` / `why` / `check` / `remedy`：CLI 与 HTTP 两条路

**同一个词只有一种含义**：CLI 的 `why` 只收 `runId`；HTTP 侧不再有 `why` 这个参数 —— 按序号回溯证据链是 `?seq=`，按轮看全景是 `?run=`。

| 想要 | 怎么拿 |
| --- | --- |
| 最近 N 条（可按 `layer` / `event` 前缀 / `runId` / `detail.status` 过滤），末尾附 `lagMs` | `node bin/dsh-purge.js audit tail --n 20 [--runId <值>] [--layer code] [--event code.] [--status applied,skipped]`；HTTP 同义：`GET /dsh-purge/audit?tail=20&layer=code&event=code.&runId=<值>`（`n` 取 0～1000，缺省 50；HTTP 侧没有 `status` 过滤） |
| 一轮的全部审计行 + 诊断轨的 `apply.start` / `apply.end`，并判两轨一致，末尾附「下一步」 | `node bin/dsh-purge.js audit why <runId>`；HTTP 同义：`GET /dsh-purge/audit?run=<runId>`（同一个实现，输出同构） |
| 一条证据链（某一行 → 它引用的前一行 → … → 文件证据） | `GET /dsh-purge/audit?seq=<seq>`（`seq` 只在文件内唯一，见第 10 节那条歧义） |
| 完整性与双向对账，一条命令自证 | `node bin/dsh-purge.js audit check --dir <审计目录>`；HTTP 判本机默认审计目录：`GET /dsh-purge/audit?check`（返回体里 `ok` 就是 CLI 退出码是否为 0；`exitCode` 是 `2` 表示**没判到东西**，例如审计目录还不存在 —— 那不是「日志坏了」） |
| 症候卡（字段 / 命令 / 动作 / 判定四段） | `node bin/dsh-purge.js audit remedy [<症候 id>] [--json]`；HTTP：`GET /dsh-purge/audit?remedy[=<id>]`。不带 id 打全部十二张 |
| 原始行 | 直接读文件：`Select-String -Path <DSH_HOME>\dsh-purge\audit\*.jsonl -SimpleMatch '"runId":"<值>"'` |

两条命令的退出码三档一致：**0 有结果 / 1 查无此 runId（或一条都没有）/ 2 用法或环境错误**。`2` 不是通过。`--json` 两份都支持。`audit check --run <runId>` 用的是同一套退出码：这一轮在审计轨里且判据全过才是 `0`。

`audit tail --status` 筛的是文件层行的 `detail.status`（`{层}.patch-applied` / `{层}.patch-miss` / `{层}.patch-skipped`）。**层结论行（`{层}.apply-result`）没有 `status` 字段** —— 它的 `detail` 里是 `applied` / `failed` / `skipped` **计数**，所以带 `--status` 时结论行一律不出现：那是过滤生效，不是丢行；要连三层结论一起看就别带。取值逗号分隔、逐字匹配，`write_error:<底层错误文本>` 这一档按 `write_error` 前缀命中。**`--n` 数的是筛后的条数**（先筛后截）：`--n 50 --status skipped` 是「最近 50 条 `skipped`」，不是「最近 50 条里的 `skipped`」。**筛完一条不剩仍退 `1`**，与「一条都没有」同档；值拼错也走这一档 —— 别把「筛空了」读成「命令成功」。

`audit why <runId>` 的输出分三段：审计轨逐行（`seq` / `event` / `result` / `layer` / `detail.status`）、诊断轨的起点与收尾（`apply.start` / `apply.end`，门禁拒绝时是 `apply.gate.reject`）、以及 `cross:` 一行给「对上几轮 / 共几轮、一致 true/false」。它对账用的是 `audit check --diag` 同一套实现（`lib/audit/runs.js`），所以两边结论不会互相打架。

库函数在 `lib/audit/store.js`（`tail` / `why`）与 `lib/audit/query.js`（`runAuditQuery`）；`dsh-purge audit` 除 `check` 外还认 `tail` / `why`，别的子命令按用法错误退 2。`why`（HTTP 形态）的返回值里 `chain` 是链、`complete=false` 时 `brokenAt` 说明断在哪一环，`reason` 是自然语言。

---

## 9. 读法纪律

1. **先结论、后证据行**。每条断言后面跟「哪个文件、哪个字段、什么值」，或者跟一行原文。没有原文的断言，别人复核不了。
2. **不确定就写「日志里没有这个信息」**。不许用常识补字段、不许把「没找到」写成「没有发生」、不许把另一台机器或另一轮的日志当成本次现场。
3. **时间是两个钟**：诊断轨 `ts` 是 UTC（`Z`），审计轨 `ts` / `observedTs` 是本地带偏移。跨轨比时间先换算。
4. **诊断轨的值都是字符串**（`"count":"1"`），比较数字先转；审计轨的 `seq` 是数字。
5. **序号只在文件内有效**：审计轨每个文件从 0 起，跨文件从 0 重来是正常的，不是断号。诊断轨没有 `seq`，只有 `ts` 顺序。
6. **「没有报错」不是判据**：判成功要看 `apply.end` / `install.record` / `cli.apply.done` 这些**正向**事件，以及 `failed=0`。判「生效」同理 —— 看 `pendingRestart` 与 `startup.ready`，不要用「没出现失败」反推。
7. **字段缺席要分三档**：① 旧版本日志本来没有这个字段（如加字段之前的 `pendingRestart`）；② 这一档不适用（如 `sealed` 只出现在 `cli` 入口的行上）；③ 这次真没发生（如 `apply.end` 缺席）。**三者不许混写成「没有」** —— 说清是哪一档，别人才知道该不该继续找。
8. **两轨的写入面不等**：`http` / `command` / `tool` / `cli` 四个 apply 入口写审计轨；`startup-auto` / `reapply` / `http-restart` 等宿主内部路径只写诊断轨。找不到审计行之前，先确认这个入口本来就该写。

---

## 10. 这份读法没覆盖到什么（诚实边界）

- **失败卡是数据，不是自动修复**：`lib/audit/remedy.js` 有十二张「症候 → 字段 → 命令 → 动作」卡片，`audit why <runId>` 末尾的「下一步」段与 `audit remedy [id]` 都由它出。卡里的命令能直接跑，但**跑完之后改还是不改、改成什么，仍要人判** —— 没有任何一张卡会自己动手。
- **失败卡已落盘，但只在「有问题」的轮次**：落账那一刻写 `<审计目录>/cards/<戳>-<runId>.md`（五行固定表头 + 「下一步」段）。判据是「任何一层不是 `ok`」或「`unresolved` 非空」；**`cards/` 里没有文件不等于没事**，只表示那些轮没有命中任何已知症候。
- **读法已投递到现场**：`apply` 时把本文拷成 `<审计目录>/README-for-ai.md`（内容与仓库那份逐字节相同，不另写摘要）。投递失败不阻断 apply，留痕在诊断轨 `audit.recorded` 的 `readme` / `readmeError` 两个字段上 —— 所以**看到 `readme="failed"` 而现场没有本文时，去看那一行**，别去猜是不是打包时漏了 `docs/`。
- **十个宿主 logger 直调点（`ctx` 上的 `logger` 服务）没有逐个加 `hostSinkAttempted`，理由逐条写在下面**。这十处都在演练台的 preset / 模式注册路径上，**不参与任何 apply 轮**，所以没有 `runId` 可挂、也没有镜像事件要对称；它们自己 `?.` 兜底，宿主 logger 缺失不会崩。宿主日志这条路通不通，由 `host.logger{installed}` 那一行统一自证（装了镜像 = 宿主 logger 可用），不必每处再记一遍：
  1. `lib/redteam/index.js` 的 `installPreset` 日志回调（`'redteam-mode: ' + msg`）：消息体由安装器逐条给，包一层只会把同一件事记两遍。
  2. `'redteam-mode: 预设安装失败：%s'`：安装失败的事实另有一份落盘状态（`preset-declare.json` 的 `phase`），面板消息不是唯一证据。
  3. `'redteam-mode: 环境安装脚本已就位 %s（%s）'`：`installSetupScript()` 的返回值就是证据，路径与动作都在里面。
  4. `'redteam-mode: undeclare failed: %s'`：给面板看的告警；对应的声明状态文件里已经写着上一次成功值。
  5. `'redteam-mode: read preset failed: %s'`：读预设失败只在注册阶段发生，那时的现场就是这个函数的局部变量。
  6. `'redteam-mode: declared but broken: %s'`：与第 7、8 条同属「声明结果」，三选一出现，记成三份反而分不清哪一份是最终结论。
  7. `'redteam-mode: declared for mode dropdown: %s'`：同上，成功侧的一条，`preset-declare.json` 是权威。
  8. `'redteam-mode: register failed: %s'`：同上，失败侧的一条。
  9. `'redteam-mode: 就绪（数据目录默认 $DSH_HOME/redteam；预设 %s；技能目录 %s）'`：插件装载完成的提示，`startup.ready` 与 `host.logger` 已经覆盖「这次启动装上了什么」。
  10. `lib/redteam/tools.js` 的 `'redteam-tools: host ctx.redteam unavailable — tools will report store_missing'`：工具一次装载只说一次，且工具调用本身会以 `store_missing` 现形 —— 那比一条面板消息更接近事实。
- **`session` 已退役**（理由写在第 4 节）：新行不再有它，旧行照样读得回来。
- **审计写入面是四个 apply 入口**（`http` / `command` / `tool` / `cli`）。`startup-auto` / `reapply` / `reapply-cli` / `http-restart` 仍只写诊断轨，所以「两轨按 `runId` join」在这 4 个入口上不成立。
- **审计轨只记 apply，不记 revert**：revert 的 `runId` 在审计轨查不到，去诊断轨按 `runId` 筛 `revert.*`。
- **`pattern_not_found` 三轨同一口径**：软硬由补丁声明的 `onMiss` / `strictFiles` 定，三处共用 `isSoftOk`。旧日志里的「审计 fail、诊断 0 硬失败」是历史口径，不是本轮矛盾。
- **`revert` 家族带身份**（四个入口），但两种无身份的行要分清：**本包之前的老行**（那版 CLI `--revert` 也不带）与**卸载路径**（`lib/uninstall.js` 直调 `revertAllHosts`，至今没接线）。判法见第 5 节 —— 看同一次还原前面有没有 `cli.invoke --revert`。
- **`entry: "startup-inject"` 已随死代码删除**（2026-10-26）：它那套注入从没接上消费方，模块与四条测试一并删掉；日志里不会再出现，见到就说明有人把它加回来了。
- **两条内部探针都落 `<DSH_HOME>/dsh-purge/logs/desktop.log`**：`purgeLog` 与 `lib/desktop.js` 的 `logInternal` 共用一个文件、一份滚动规格（4 MB、留 8 代），行格式不同（`[标签] k=v` 与 `[dsh-purge] 文本`）。`logInternal` 自己算目录（`DSH_HOME` 优先，否则 `~/.dsh`），**便携安装下可能与 `findDshHome` 的结果分叉** —— 那条路上它写到的目录未必是插件主目录。
- **`audit tail` / `audit why <runId>` / `audit remedy` / `audit check --run` 都在 CLI 里**；HTTP 侧按序号回溯是 `?seq=`、按轮看全景是 `?run=`、自证是 `?check` —— **没有 `why` 这个参数**，`why` 只属于 CLI 且只收 `runId`。
- **`seq` 的跨文件歧义只报不消**：`seq` 只在文件内唯一，同一天轮转后两个文件都可能有 `seq=0`。库函数返回 `ambiguous` 与 `candidates`（新文件在前），但 CLI 的 `why` 收的是 `runId`，所以这条歧义只在 HTTP 的 `?seq=` 上看得到。
- 完整性只到「断号 / 坏行 / 末行 / 轮边界」这一层：**没有哈希链、没有链外锚**，所以「日志没被人改过」这件事今天判不了，不要写成结论。
- **轮级结束标记有了，但它是一个字段，不是一对新事件**：`detail.runEnd` 盖在盖章那条层结论上（诊断轨那边是 `apply.end` / `apply.gate.reject` 上的 `runEnd`）。没有新事件名，是因为审计事件名有一份词表、`architecture/audit.schema.json` 里还有一份逐字镜像的枚举，加名字要同时改两处；而「有没有一个字段」本来就够机器判。带来的后果：**老口径的轮判不了收尾**（`judgeable=false`，不判红也不判绿），因为那一代日志里没有这个字段 —— 拿新判据判它会把它全判成中断。
- **轮边界有一条判不了的**：某一层本来就没有可落账的补丁、而这一轮正好在它之前被杀 —— 那一层没有文件行，结论里的 `detail.completeness.layers` 也是假，规则看不见它。有结束标记的那一代由标记兜住；没有标记的那一代只能靠诊断轨的 `apply.start` … `apply.end` 判。
- **反向只对 v3 判红**：诊断轨的结束事件上没有 `runEnd` 的那一代，无法判定当时是否该写审计（CLI 落审计比第一个章早了几个小时）—— 只记「上一代（无 runEnd）」信息项，不进 `missingAudit`、不进退出码；一轮里**一条 `apply.patch` 都没有**（aborted / 0 补丁：`apply.end.total` 为 0 或空）时没有可落账的判定，审计 0 行同样不判缺、只记「没有逐补丁判定」。审计轨一侧同理：`v2-entry` 及更早的完整轮判不了收尾，记「不可判」，不算截断。
- **`pendingRestart` 只覆盖「真的改动了文件」这一档**：`read_error` / `write_error:…` 是「没判出来」，不算改动；门禁拒绝与中断那两档根本没有 `apply.end`，字段缺席，按缺席处置。
- **`asarSealed="true"` 时 `pendingRestart="true"` 还不等于「重启就能生效」**：密封归档要先把 `app.asar` 换掉（或解开），否则新起的进程读到的还是归档里的旧字节。这一层线索只看得到形态，看不到换归档有没有做成。

### 10.1 四个会让人**答错**的边界（不是"没覆盖"，是"照字面读会读反"）

1. **审计轨「有 `detail.considered` 却没有 `detail.runEnd`」这一档，判不了收尾，但不能算截断。** 第 3.1 节给了两端：有 `runEnd` = 收尾；两样都无 = `judgeable=false`。**中间这一档（`v2-entry`）同样是 `judgeable=false`** —— 它客观可能完整，按判据却既不能算收尾、也不能算中断；`audit check` 打印 `sealed=false judgeable=false`，不进截断计数。判它只能跨轨：**如果诊断轨里同一个 `runId` 的结束事件上有 `runEnd`，`audit check --diag` 会打一行 `·` 说「以诊断轨为准，这一轮算收尾」，并注明「审计轨缺章」** —— 看那行 `·` 就够了；`closed` 仍是审计轨自己的字段（这一档仍是 `false`），别把 `·` 行读成 `closed=true`。诊断轨也没有，就是真的判不了。
2. **`pendingRestart="false"` 时「生效了吗」的答法**：不要去找「有没有后续 `startup.ready`」——那一档根本没有待加载的字节。正确答法是「**这一轮没有改动**（`applied=0`），所以这一问在它身上不成立」；要答「此前的改动生效了吗」，得往回找**最近一次 `pendingRestart="true"` 的轮**，再看它之后有没有 `patchesMatch="true"`。**把两个问题混成一个，就会把"没改动"读成"没生效"。**
3. **`detail.table.recorded` 是「这一轮有文件行的补丁号个数」**（不含 `unresolved`）：它的定义以 `docs/log-generations.json` 的 recorded 一行为准。**分母是这一轮真正选中的补丁，不是补丁表全量**：写侧在 `detail.table.selected` 里记下这一轮 report 出现过的补丁号（含进了 `unresolved` 的），判据是 `recorded + unresolved = |selected ∖ exempt ∖ unmapped|`，缺口只判 `selected` 里的 id。apply 可以带过滤（引擎的 `pick` 之后 report 只含选中的补丁），所以**合法过滤轮的 `recorded` 小于补丁表全量是正常的，不是漏算**。没有 `selected` 的过渡日志才退回 `total − exempt − unmapped` 的全表口径，并在输出里记一条「无 selected，按全表判」信息项。它**不是文件行数**（一条补丁可落多个文件，行数会更多），也**不是**「该落账的减 `unmapped`」（那样会把写不出证据的那几条也算成落了账）。三者对不上时要分别报：`recorded` 少了 = 漏算；文件行多了 = 一补丁多文件，正常。
4. **最后一条 `apply.start` 之后如果发生过 `revert`，第 0 节「取最后一条 `apply.start`」会把一轮已被还原的 apply 当成「这次」。** 判法：取最后一条 `apply.start` 之后，**再看它后面有没有 `runId` 更大（时间更晚）的 `revert.start`**；有就说明那轮 apply 已被还原，「改动生效了吗」要改成「这一轮被还原了，磁盘已回到 apply 之前」。

### 10.2 一条只看得到形态、看不到结论的

- **`host.logger` 与 `startup.ready` 不对等**：`startup.ready` 每次启动一条，`host.logger` 只在**装载镜像那一刻**发一条。所以「有 8 条 `startup.ready` 却只有 2 条 `host.logger`」不是缺陷 —— 它说明镜像层是**中途**装上的。判世代时看**最早那条 `host.logger` 出现的位置**，之前那些启动记录属于「还没有镜像层」的那一代。
- **`startup.ready` 的 `patchesMatch="false"` 不能单独当成「补丁没打上」**：对齐戳丢了而文件本身已打好时也是 `false`（引擎会在那次启动里补戳）。要分这两种，得看同一次启动之后有没有 reapply 与重启。
- **日志里没有「当次启动的宿主版本」**：`startup.ready.version` 是插件版本。宿主版本只在 apply 那一刻的 `hostVersion` 里；没 apply 过就查不到，按「日志里没有这个信息」写。
- **诊断轨没有等价的机械完整性判据**：`audit check` 的四条判据全是审计轨的形状。手上只有 `diag.jsonl` 时不要去找一个不存在的 `check`，也不要把它判红当成日志坏了。
- **`appliedStamp` 有两个坑，都不是矛盾**：它的 `at` 是上一次启动留下的（刷新戳不写日志），它指向的那次 apply 也可能已经被轮转走。戳证明「磁盘上有对齐记录」，不证明「记录还在这份日志里」。
- **`apply.end` 可能是「什么都没打」的那一轮**：`reason="no_patches_given"` / `"all_patches_filtered"` 时 `total=0`，这一轮没有备份、没有安装指纹，也没有 `apply.patch`。别把「没有逐条判定」读成日志缺失。
- **「正常 apply 后不许出现 `partial`」只在夹具上自动判**：`scripts/check-audit-completeness.mjs` 断言夹具的 `completeness` 三项全真，「有假项必须落 partial/fail」由用例锁着；真机那一步没有自动判据（本机没有可运行入口）。

---

## 11. 附录 C：字段、世代与空值形态（机器可读：`docs/log-generations.json`）

这张表登记的是**顶层字段**：它属于哪一轨、从哪一代开始有、空值长什么样。**嵌套组按「组」登记，成员见下面「组说明」** —— `evidence`（文件证据与引用证据两种形状）、`detail.completeness`、`detail.table` 这三组的成员不逐条混进顶层表，否则「一条日志行的形状」会被拆成一堆同名键（`patches` / `files` / `total` 在三处出现的含义并不相同）。**这份表是判据的一部分**：`test/log-generations.test.mjs` 双向锁住它 —— 代码里发射的字段必须在这张表里，表里的字段必须在本文里；组说明另有判据：三组必须同时出现在表的 `$comment` 与本节的组说明里，且成员逐条列出。加字段的人先改表、再改写法正文；只改一处就红。

世代的判据在表里的 `generations`：`v1`（没有 `recordId` / `observedTs`，`actor` 恒 `host`）、`v2`（三字段 + `detail.considered` / `expectedRows`）、`v2-entry`（审计行带 `entry`）、`v3`（本包：`detail.runEnd` 结束标记 + `detail.table` 补丁表记账）。**读老日志前先认世代** —— D4/D5/D8 那三类「老行把答案带反」都是没认世代造成的。

三条最容易读错类型的地方，从表里单拎出来：

| 位置 | 类型 | 空值形态 |
| --- | --- | --- |
| 审计轨 `detail.unresolved` | 数组 | `[]` |
| 诊断轨 `audit.recorded.unresolved` | 逗号串 | `""` |
| 诊断轨的 `skipped` / `cards` / `count` / `total` 等 | 字符串数字 | `"0"` |

### 组说明（顶层表之外的三个嵌套组）

三组的成员不进顶层字段表（同名键在不同组里含义不同），但**成员本身必须在这份读法里出现** —— `test/log-generations.test.mjs` 逐条核。`docs/log-generations.json` 的 `$comment` 同样点名这三组。

| 组 | 成员 | 什么时候才看它 |
| --- | --- | --- |
| `evidence`（二选一：文件证据 / 引用证据） | 文件证据：`file` / `marker` / `hits` / `bytes` / `offset`；引用证据：`refSeq` / `quote` | 想知道「这一条判据落在哪个文件的哪个字面量上」看文件证据；想顺着链回到上一条看引用证据 |
| `detail.completeness` | `patches` / `files` / `layers` | 判断这一层是不是「三项全真」；任何一项为假，层结论必须是 partial 或 fail |
| `detail.table` | `total` / `exempt` / `unmapped` / `selected` / `recorded` | 对账这一轮该落几条、实际落了几条；`selected` 是过滤过的那一轮的分母 |
