# 2.3.2

## 中文

- **「已生效」的认证单位从补丁换成文件**：一条补丁算不算打上，现在问的是「这份文件是不是这一版表的产物」——把**这一版表**重放到官方原文上，与现场逐字比对。修前问的是「单独重放这一条补丁的结果 == 现场」，而同一文件上后一条补丁会改写前一条的产物（id 84 在 id 83 插下的那段里又插两行），逐条重放必然对不上，于是一条不缺的补丁被记成待应用。
- **换宿主版本后的第一次 `--apply` 就收敛**：本轮真写过的补丁，其逐条指纹按**当前表**记，不再被账本里上一代的指纹否决。修前换表第一轮里，这条证据永远读不到——它被旧指纹挡在门外，而那正是账本还没更新的时候。
- **账本在没洗完的那一轮也记事实**：写过哪些字节、逐文件指纹、宿主版本、这一轮几个 applied / pending 都照写；只有「最后一次成功 apply 是哪一轮」（`run_id` / 审计摘要）留给干净轮。修前 CLI 的密封分支在写账本之前就退出了，整轮证据一并丢失，下一轮仍按旧世代判它们待应用。
- **官方原文的来历不再被重写抹掉**：账本写回一份已有快照时会把它的来源标记丢掉，认证只认白名单里的来历，于是「原件里本来就有这段产物」与「这份文件就是这一版表打出来的」两条判据会一起长期失效、且没有任何症状。现在每个落盘点都记来历。
- **失败轮留下的解包树不再被说成「宿主安装不完整」**：归档与解开的树同时在时，宿主读的是官方归档、补丁一处也不生效。这一档现在直说「补丁未生效」，并点明两条路——重跑一次应用接着做，确认不再应用之后才 `--unseal`（没洗完就 unseal 会让宿主读到一棵半成品树）。
- **版本号进位到 2.3.2 只为追溯**：`stampMatches` 只看 major.minor 与表指纹，所以 2.3.1 与 2.3.2 在运行期等价（不会多打也不会少打）；进位是为了让真机日志里的 `startup.ready.version` 能区分新旧包。

## English

- **"Applied" is now certified per file, not per patch**: a patch counts as applied when the file is exactly what this table produces from the official original. The old question — "does replaying this single patch match the disk?" — can never be answered yes when a later patch on the same file rewrites the earlier one's product (id 84 inserts two more lines inside what id 83 wrote), so a complete patch was recorded as pending.
- **The first `--apply` after a host version change converges**: per-patch fingerprints for what this round actually wrote are recorded against the **current** table and are no longer vetoed by the previous generation's fingerprints in the ledger. Before, that evidence was unreachable in the very round where the table changed — which is exactly when the ledger has not been updated yet.
- **The ledger records facts even in a round that did not finish**: which bytes were written, per-file fingerprints, the host version, and the round's applied / pending counts are always written; only "which round was the last successful apply" (`run_id` / audit summary) is reserved for clean rounds. The CLI's sealed branch used to exit before writing the ledger at all, losing the whole round's evidence — so the next round still judged those patches pending.
- **Snapshot provenance is no longer wiped when a snapshot is rewritten**: rewriting an existing snapshot dropped its source marker, and certification only accepts whitelisted provenance, so both "the official text already carries this product" and "this file is this table's product" silently went dead. Every write path now records provenance.
- **An extracted tree left behind by a failed round is no longer called "incomplete installation"**: while both the archive and the unpacked tree exist, the host reads the archive and no patch takes effect. That state now says "patches not in effect" and names the two ways out — re-run apply to finish, or `--unseal` only after you are done applying (unsealing a half-applied tree makes the host read it).
- **The bump to 2.3.2 is for traceability only**: `stampMatches` compares major.minor and the table fingerprint, so 2.3.1 and 2.3.2 are runtime-equivalent (no extra and no fewer writes). The bump lets `startup.ready.version` on the real machine tell the new build from the old one.

# 2.3.1

## 中文

- **版本门禁按 semver 全序比较**：同一 minor 下 patch 号现在参与比较 —— 修前 `0.2.2-rc.1` 会被说成「比 0.2.1-rc.2 更旧」而拒绝，`0.2.0-rc.5` 反而放行。正式版高于同号预发布（`0.2.1` > `0.2.1-rc.2`），两条都写进了注释与用例。
- **跨代升级单次收敛**：新增第三种证据「官方原文 + 当前表 == 现场字节」，它不读账本，所以补丁表换代的那一轮就能成立；账本改为**每轮记事实、只有干净轮记「最后一次成功 apply」**。修前跨代要先 `--revert` 再跑**两次** `--apply` 才收敛。
- **两种分母一起说出口**：摘要行现在给「补丁号 58/66（62 个展示行，其中 55），3 待清洗」；`--diagnose` 的 counts 分开给 raw / display；启动事件同时写补丁号口径与展示口径的待清洗数。没有可判的补丁时说「未评估」，不再打印 `0/0 已清洗`。
- **归因能分清「官方升级」与「有人改文件」**：账本记下宿主版本，未对齐原因收成枚举（`host-updated` / `stamp` / `markers-missing` / `no-ai-base` / `read-error`），`--status` 顶部直接给「宿主已升级 X → Y，补丁树已被官方更新覆盖，请重新 --apply」。
- **安装树体检与官方更新器痕迹**：新增 `--diagnose` 的 `install_health` 与 `updater` 两段 —— 归档 / 补丁树 / runtime 三者的关系、runtime 缺哪一项、以及「用缓存里的安装包原地修好」那条可执行命令。解封时记下 `resources/dsh-purge-unsealed.json`；盘上有待装官方更新包时，**在交换归档之前**就把包路径与恢复命令写进诊断轨（解封是稳态，两者相撞会把 runtime 清空，实测应用起不来）。
- **设计基线不再依赖本机草稿产物**：`test/design-baseline.test.mjs` 原先直接读 `.scratch/` 里那份不入库的预览，干净克隆必然 ENOENT 判红；现在产物侧断言照跑，引用预览的两条缺文件时跳过并说明原因。

## English

- **Host gate now compares semver in one total order**: under the same minor, the patch number takes part in the comparison. Before, `0.2.2-rc.1` was rejected as "older than 0.2.1-rc.2" while `0.2.0-rc.5` was allowed. A release outranks its own prereleases (`0.2.1` > `0.2.1-rc.2`); both rules are documented and covered.
- **Cross-generation upgrades converge in a single apply**: a third kind of evidence — `apply(current table, official snapshot) == bytes on disk` — is produced without reading the ledger, so it exists in the very round where the table generation changes. The ledger now records **facts every round** and reserves "last successful apply" for clean rounds. Before, a cross-generation upgrade needed `--revert` plus **two** `--apply` runs.
- **Both denominators are stated**: the summary reads "patches 58/66 (62 display rows, 55 applied), 3 pending"; `--diagnose` splits raw and display counts; the startup event carries both. When nothing could be evaluated it says "not evaluated" instead of `0/0 applied`.
- **Attribution distinguishes an official upgrade from edits**: the ledger stores the host version and the misalignment reason is an enum (`host-updated` / `stamp` / `markers-missing` / `no-ai-base` / `read-error`), with `--status` printing "host upgraded X → Y: the patch tree was overwritten by the official update, re-run --apply".
- **Install-tree health and updater traces**: `--diagnose` gains `install_health` and `updater` — the relationship between the archive, the patch tree and `runtime`, which runtime entry is missing, and the exact command that repairs it from the cached installer. Unsealing records `resources/dsh-purge-unsealed.json`; when a staged official update exists the package path and recovery command are written to the diagnostic track **before** the archive is swapped aside.
- **Design baseline no longer depends on a local draft artifact**: `test/design-baseline.test.mjs` read a preview under the git-ignored `.scratch/`, so a clean clone failed with ENOENT; artifact-side assertions still run, and the two preview-backed ones now skip with a stated reason.

# 2.3.0

## 中文

- **补丁判据改成内容派生**：一条补丁「已生效」不再只看 marker 在不在，而是看**字节**——账本记下这一版表的逐条指纹与真写过的文件字节，读侧拿现场再比一次。可感知的后果：**替换正文换代的补丁会真的重打**（旧版会把「marker 还在」当成「已生效」，宿主文件停在旧内容上，而面板是绿的）。首次升级会因为账本换口径重打一轮，之后同表重启不再重打。
- **版本账本记下四份清单**：整表指纹、逐条指纹、这一版表真写过的补丁与真写过的文件字节，另有一份「核对时已在目标态」的清单。「这条为什么算已生效」从此能对着账本逐项回答。
- **设置页一句话说清四种数**：顶栏不再用「全部生效」盖住待应用 —— 现在按「已生效 / 待应用 / 按设计跳过 / 不适用」四种数给结论，有待应用就直说几条。同一组数字全页只出现一次（顶栏只说状态词，补丁分节标题不再挂一遍比值）。
- **「跳过」拆词**：「按设计跳过」与「待应用」现在是两个数，分节里每一层也分开列。此前两者混在同一个「跳过」里，用户会以为「没打上的」都算「不需要」。
- **工程字段改人话**：命令入口（原来显示 `shim cmd:binary · ps1:missing …`）、原始文件备份、预设注册状态（原来显示 `registered-broken · …`）都改成中文名 + 状态点 + 一句人话。
- **页内导航**：设置页顶部加一条锚点导航，每个块都能直接跳过去；左栏是宿主导航，本插件不往里加目录。
- **红队预设能在真机注册**：宿主硬拒的字段（`toolFilter`）与宿主没有的键（`backgroundMode`）已删除，注册声明落成「已注册」；已装机器上的旧副本会按字段迁移，不再显示「加载失败」。
- **审计 / 健康 / 日志三块只读分节**：审计（最近事件 / 按轮对账 / 完整性一句话）、健康（安装指纹与副本比对、预设注册）、日志（三条轨的落点与保留代数）。三块都只读，没有数据时有空态说明。
- **演练台补了行为用例**：计分、存取、工具参数校验三类各补了行为断言（此前只有形状快照）。
- **演练台整页重排**：页头（演练台 · 靶标 · 刷新）、标签栏与正文现在共用同一条内容列，左边缘齐平；整页只有一条滚动条，底部编辑器不再被切掉半截；正文分两栏（主栏放规则与角色，辅栏放设置与提醒）。
- **演练台不再显示裸标记**：以前句子里的 `**强调**` 与反引号会原样露出来，现在渲染成加粗与等宽小块；原先的 ⚠️ 换成一枚带边框的「注意」块，演练台界面里不再出现表情符号。
- **表格统一成一套外壳**：资产、漏洞、得分三页的行高与列宽走同一套规则，行间只有一条发丝线，数字列右对齐等宽；设置页的样式也收进共享样式表，页内只剩骨架高度、隐藏位这类布局个例。
- **重启不再每次全量重打**：以前在 rc.3 宿主上，三条明明「已生效」的补丁会在重启时被判成待应用，于是每次开机都重打一轮；现在按「官方原文本来就带着这段内容」认证，重启后状态稳定，不再重复写盘。
- **知识库空态能直接打开目录**：知识库那一页没有内容时，空态里的「打开知识库目录」现在真的会打开目录。
- **技能库两种空态分开**：「这个库里还没有技能」（连同把技能放进去的办法）与「当前筛选下没有技能」（提示清掉筛选）现在是两句话，不再共用一句。
- **报告页只留两个动作**：复制与导出；「重新生成」已移除，报告为空时仍提示先生成一次。
- **锚点不变**：宿主兼容范围不变 —— `dshTarget` 仍是 `0.2.1-rc.2`，同 minor 内的宿主版本照旧放行。自带技能目录、审计轨与旧日志格式都向后兼容，无需手工清理。

## English

- **Patch verdict is now content-derived**: "applied" no longer means "the marker is present". The ledger records this table's per-patch fingerprints and the bytes of every file the table actually wrote, and the reader compares them against what is on disk. Visible consequence: **a patch whose replacement body changed will be re-applied** (the old behaviour treated a surviving marker as "applied" and left the host file at the previous content while the panel stayed green). The first upgrade re-applies once because the ledger switches format; after that, restarts on the same table do not re-apply.
- **The version ledger keeps four lists**: the table fingerprint, per-patch fingerprints, the patches this table really wrote and the bytes it wrote, plus a second list for patches verified to be already in the target state. "Why is this one considered applied" can now be answered item by item.
- **One sentence, four counts**: the header no longer hides pending items behind "all live". The verdict now covers **live / pending / skipped by design / not applicable**, and pending is stated explicitly. The same numbers appear exactly once — the header shows a status word, and the patch section no longer repeats the ratio.
- **"Skipped" is split**: "skipped by design" and "pending" are now two different numbers, per layer as well. They used to share one counter, which made users read "not applied" as "not needed".
- **Engineering fields in plain words**: the command entry (`shim cmd:binary · ps1:missing …` before), the original-files backup, and the preset registration state (`registered-broken · …` before) are now a Chinese label, a status dot and one plain sentence.
- **In-page navigation**: an anchor bar at the top of the settings page; every block is one click away. The left column is the host's own navigation and does not gain a directory from this plugin.
- **The red-team preset registers on real hosts**: the field the host hard-rejects (`toolFilter`) and the key it does not know (`backgroundMode`) are gone, so the declaration now says "registered"; an already-installed copy is migrated field by field and no longer shows "failed to load".
- **Three read-only sections**: audit (recent events / per-run reconciliation / a one-line integrity verdict), health (install fingerprints, copy comparison, preset registration) and logs (three tracks, locations, retention). All read-only, each with an empty state.
- **The drill panel gained behavioural tests**: scoring, storage and tool-argument validation each now have behavioural assertions (previously only shape snapshots).
- **The drill panel got a full re-layout**: the header (Drill · Target · Refresh), the tab bar and the body now share one content column with a common left edge; the page scrolls once, and the bottom editor is no longer cut off; the body is two columns (rules and roles on the left, settings and reminders on the right).
- **The drill panel no longer shows raw markup**: `**emphasis**` and backticks used to appear verbatim; they now render as bold text and inline code chips, and the old ⚠️ became a bordered "Note" block — no emoji left in the drill interface.
- **Tables share one shell**: assets, findings and scores use the same row height and column rules, separated by hairline borders, with numeric columns right-aligned and tabular. Settings styles moved into the shared stylesheet, leaving only layout one-offs (skeleton heights, hidden slots) inline.
- **Restart no longer re-applies everything**: on rc.3 hosts, three patches that were already live used to be judged pending at restart, so every boot re-applied a round. They are now certified against the official text that already carries the content, so restarts are stable and stop rewriting disk.
- **The knowledge base can open its folder**: when that tab has no content, the empty state's "Open knowledge directory" button now actually opens the folder.
- **Two different empty states in the skills library**: "no skills in this library yet" (with how to add one) and "no skills match this filter" (clear it) are now two separate messages instead of one shared one.
- **The report page keeps two actions only**: copy and export; "Regenerate" is gone, and an empty report still tells you to generate one first.
- **Anchors unchanged**: host compatibility is unchanged — `dshTarget` stays `0.2.1-rc.2` and hosts within the same minor keep working. Bundled skills, the audit track and the old log format stay backward compatible; no manual cleanup is needed.
