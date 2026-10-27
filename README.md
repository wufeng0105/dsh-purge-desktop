<p align="center">
  <img src="docs/banner.svg" alt="dsh-purge" width="720">
</p>

<h1 align="center">DeepSeek Harness 网络安全红队工具</h1>

<p align="center">
  <strong>v2.3.2</strong> &nbsp;·&nbsp;
  让所有模型都能破甲，不同模型可换不同提示词
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?logo=node.js&logoColor=fff" alt="Node.js">
  <img src="https://img.shields.io/badge/dsh-0.2.1--rc.2-blue" alt="DSH">
</p>

<p align="center">
  <a href="README.md"><strong>中文</strong></a> · <a href="README.en.md">English</a>
</p>

---

装一次，之后不用再点任何按钮：补丁在宿主启动时自己应用，界面是宿主设置里新增的一节，加主区一个演练台。

这一页只回答三件事：**怎么装、装完在哪看、怎么退回去**。要改这个仓库，读 [AGENTS.md](AGENTS.md) 与 [文档索引](docs/文档索引.md)。

## 这是什么

装在官方 [DeepSeek Harness](https://www.deepseek.com/harness/) 桌面端上的插件，用于网络安全红队评测。

Harness 不只是把问题交给模型：它还会在运行时改提示词、审批门、沙箱和会话格式。只看「模型答不答」，会把**宿主拦截**误当成**模型拒绝**。这个插件把两层分开——补丁把宿主那侧的拦截挪开或改写成可继续，模型那侧的回答才反映模型本身。用于受控评测，也用来看默认策略该不该收紧。

三块界面：

| 位置 | 是什么 |
| --- | --- |
| 设置页里的 `dsh-purge` 一节 | 五个页签，见下表 |
| 主区演练台 | 点侧栏图标后占满主区：授权后看资产、技能与本机环境 |
| 侧栏图标 | 入口本身；未授权时先给授权窗，不给空壳 |

设置页的五个页签：

| 页签 | 内容 |
| --- | --- |
| 状态 | 结论句、补丁计数、运行环境、需要时的「重启宿主」 |
| 补丁 | 按层展开的每一条及其状态与原因 |
| 配置 | 更新、提示词注入、服务器名单、Hooks 拦截、危险操作（还原 / 卸载） |
| 技能 | 随包技能与本地技能，就地编辑 |
| 诊断 | 审计轨、安装健康、三条日志轨的落点与保留代数 |

补丁 66 条，另有 26 个永久保留的 `id` 空洞（共 92 个 `id` 守恒）。插件只动**本机已装好的**官方 `@deepseek-ai` 包与本机配置：它不是公网扫描器，也不是打别人站点的套件，仓库里没有木马、没有对外攻击载荷。

## 怎么装

```sh
dsh plugin --profile desktop add .        # 在本仓库根目录执行
```

然后**完全退出桌面端**（含托盘），再打开。补丁在启动时自动应用。

给别的机器装，先打 tarball 再拷过去：

```sh
npm pack                                  # 产出 dsh-purge-<版本>.tgz
dsh plugin --profile desktop add ./dsh-purge-<版本>.tgz
```

环境要求：Node.js ≥22.13、dsh 0.2.1-rc.2。npm 上没有这个包，不要 `pnpm add dsh-purge`；也不要用 `dsh://` 或任何公网一键安装链接。

## 装完在哪看

1. 设置左栏多出 `dsh-purge` 一节，页头「已生效」，页脚「上次应用」不是「从未」。
2. 侧栏出现演练台图标。
3. 聊天里 `/purge status` 打出的 `DSH_HOME` 是**你正在跑的那一份**。

页头显示「需重载」或「部分跳过」时，那一节里会写清是哪一条、为什么。显示「部分跳过」不影响其余补丁生效。

## 常用命令

```sh
dsh-purge --status | --apply | --revert | --unseal | --uninstall | --diagnose | --edit
```

```
/purge status | apply | revert | uninstall | edit | help
/rules list | use <id> | create <id> | delete <id> | reset | help
/skills list | import <压缩包或文件夹> | create <id> [说明] | delete <id> | help
/rewind
```

界面里没有「应用」按钮（2.0.0 起就没有）：装完自动应用，要重来时用上面的命令。输入框旁的「回退一次 / 回退上一轮」走官方 `session.fork({ atSeq })`：撤回那一轮，新会话接上之前的上下文，旧会话归档，那句话回到输入框。

极简 / PTC 与标准不一致时，通常是 preset 里的拦截句没洗净：`/purge revert` → `/purge apply` → 完全退出宿主再打开 → 新开一轮对话。只换 preset 不重应用，旧进程里的补丁不会更新。

## 还原、卸载、更新

- **还原**：`dsh-purge --revert`。每个目标文件在应用前备份为 `<文件>.dshpurge.bak`，还原用备份覆盖回去并删除备份；`prompt-inject.md` 是你的文件，还原时保留。
- **卸载**：设置节 → 页脚 →「卸载」，或 `/purge uninstall`。会先还原已应用的补丁，再删注入文件、规则库与插件本身，然后重启宿主。
- **更新**：换掉本机副本 → `dsh-purge --revert` → `dsh-purge --apply` → 完全退出宿主再打开。重复应用是幂等的。

**在线更新默认关闭**：设置页的「检测更新」显示「本地版：不检查更新」，不发出任何网络请求，代码里没有硬编码远端仓库。要启用得显式给 `DSH_PURGE_UPDATE_REPO=owner/name` 或 `package.json` 的 `dsh.updateSource`。

## 适配范围

只支持**官方桌面端**，只支持 **dsh 0.2.1-rc.2**（`package.json` 的 `dshTarget`）。插件启动时读宿主 `@deepseek-ai/dsh` 的版本并比对：主次版本不同即**拒绝应用**，同 minor 内允许 rc 序号向上漂移；版本不对时显示原因，不会乱改文件。

`dsh web` CLI 宿主面自 1.0.0 起不再维护，那个 profile 不再更新——迁移到桌面端即可，数据留在原处。

找不到安装树时按这个顺序找：`DSH_HOME` / `DSH_BASE` → dsh 启动器旁的 `.dsh` → `npm prefix -g` / `npm root -g` → 嵌套的 `@deepseek-ai/dsh/node_modules/@deepseek-ai` → `~/.dsh`。都找不到就提示设置 `DSH_BASE`，不改文件。

运行时文件在 `$DSH_HOME`：`prompt-inject.md`、`rules/`、`skills/`、`net-scope-allow.txt`、`redteam/`、`audit/`。

## 自己的服务器

中国大陆、香港、澳门的地址默认禁止，只有事先登记的那一台可以例外——在对话里说「这是我的服务器」不会放行，密钥和密码也不会。

登记在**配置**页签的服务器名单里，每行一台：`203.0.113.10`（一个 IP）、`my-vps.example.com`（主机名，保存时它的解析结果也会放行）、`alice@my-vps.example.com`（账号只用来认出这种写法，不能证明机器属于你）。保存后写入 `$DSH_HOME/net-scope-allow.txt`；密钥、密码、网段与通配符会在保存时丢掉。

## 手动安装

命令行装不上、或 `dsh` 不在 PATH 时用这个。只改**正在用的那个宿主**对应的 profile。

<details>
<summary><strong>四步，逐条照做</strong></summary>

**1. 找到真正在用的 `$DSH_HOME`**：目录名是 `.dsh`（偶见 `dsh-home`），里面有 `profiles/`，且 `profiles/desktop/package.json` 的 `"name"` 是 `dsh-profile-desktop`。本机常有两份 `.dsh`，要认**你实际启动**的那一份。

**2. 把插件放到 `$DSH_HOME/plugins/dsh-purge`**（目录名与包名都必须是 `dsh-purge`，复制整个目录，不要只拷几个 `.js`）。

**3. 只改 `$DSH_HOME/profiles/desktop/package.json` 两处**（先备份）：`dependencies` 加 `"dsh-purge": "file:../../plugins/dsh-purge"`；`dsh.profile.bundles` 末尾追加 `"dsh-purge"`。原有依赖与 bundle 一个都不要删，`"dsh-purge"` 不要写两次。

**4. 在 `$DSH_HOME/profiles/desktop` 里 `pnpm install`**，成功标志是出现 `node_modules/dsh-purge/package.json`。然后完全退出桌面端再打开。

</details>

<details>
<summary><strong>交给 AI 助手（只安装）</strong></summary>

<!-- AI-AGENT-START -->

安装 DeepSeek Harness 插件 `dsh-purge`，只装到官方桌面端的 profile。不要全盘搜索，不要读或改其它文件，也不要重启应用。

`dsh` 不在 PATH 就告诉用户后停止。当前目录已是本仓库时用 `.`。profile 不存在就告诉用户先启动一次桌面端。npm 上没有这个包，不要 `pnpm add dsh-purge`。

```sh
dsh plugin --profile desktop add .
```

命令结束后提醒用户：完全退出桌面端再打开，补丁会在启动时自动应用；打开宿主设置里的 `dsh-purge` 一节确认状态。然后停止。

<!-- AI-AGENT-END -->

</details>

---

第三方材料：`lib/redteam`、`presets/redteam`、`skills/redteam` 的原始版本来自 Jueze-2019/dsh-redteam-mode，按 MIT 许可保留版权声明，见 [docs/redteam-upstream-LICENSE](docs/redteam-upstream-LICENSE)。仓库其余部分为 MIT。
