window.__ModuleLoader__.load({ id: "dsh-purge", factory: (require) => {

		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const h = react.createElement;
		const { useState, useEffect, useCallback, useRef, Component } = react;
		/*
		 * 宿主原语包：设置页的所有控件都从这里取，不自造按钮与色块。
		 *
		 * 为什么必须用宿主组件：`@deepseek-ai/dsh-client-ui-primitives` 在宿主的冻结模块表
		 * （PLATFORM_MODULES）里，与 react / react-dom / cordis / slots 同列，所以片段可以
		 * 同步 require 它。用它换来的是原生外观、原生明暗、原生键盘与无障碍行为——自造一套
		 * 必然在某个主题下错位，而且每个控件都要自己重写一遍可逆逻辑。
		 *
		 * 取不到时整体降级为 null：旧宿主若没有这个包，页面渲染空的可见提示，而不是抛错把
		 * 整个设置页打掉。
		 */
		let prim = null;
		try {
			prim = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (e) {
			try { console.warn("[dsh-purge] primitives unavailable:", e && e.message); } catch { /* ignore */ }
		}
		function primOf(name) {
			return prim && typeof prim[name] === "function" ? prim[name] : null;
		}

		const name = "dsh-purge";
		const inject = ["slots", "locale"];
		const NS = "settings.dsh-purge";
		let translate = (key) => key;
		/** 演练台与片段的取词入口：同一闭包里复用 translate。 */
		function dt(key) {
			return translate(key);
		}
		function useT() {
			return translate;
		}
		function clientGuessSurface() {
			try {
				if (typeof navigator !== "undefined" && /electron/i.test(navigator.userAgent || "")) return "desktop";
				if (typeof location !== "undefined") {
					const port = String(location.port || "");
					if (port === "43120") return "desktop";
					const host = String(location.hostname || "");
					if (host && host !== "127.0.0.1" && host !== "localhost" && /dsh desktop/i.test(String(location.href || ""))) return "desktop";
				}
			} catch { /* ignore */ }
			return "";
		}
		function hostSurfaceOf(s) {
			return (s && s.surface) || clientGuessSurface() || "web";
		}
		function hostText(t, key, surface) {
			if (surface && surface !== "web") {
				const specific = key + "." + surface;
				const hit = t(specific);
				if (hit && hit !== specific) return hit;
			}
			return t(key);
		}
		function apiUrl(p) {
			try { return new URL(p, window.location.origin).toString(); } catch { return p; }
		}
		function apiTimeoutMs(p, init) {
			const path = String(p || "");
			const method = String((init && init.method) || "GET").toUpperCase();
			if (path.indexOf("/dsh-purge/update") !== -1) return method === "POST" ? 180000 : 45000;
			if (path.indexOf("/dsh-purge/uninstall") !== -1) return 90000;
			if (path.indexOf("/dsh-purge/skill") !== -1) return method === "POST" ? 120000 : 20000;
			// status 会在"应用"期间被后端的同步落盘阻塞，默认 20s 必然被 abort，界面只会显示"读取失败: timeout"。
			// 端点字面量只在 settings/store.js 里写一次，这里引用同一个常量。
			if (path.indexOf(PURGE_STATUS_PATH) !== -1) return 60000;
			if (path.indexOf("/dsh-purge/apply") !== -1) return 240000;
			if (path.indexOf("/dsh-purge/revert") !== -1) return 120000;
			if (path.indexOf("/dsh-purge/restart") !== -1) return 60000;
			return 20000;
		}
		function isAbortError(e) {
			const msg = String((e && e.message) || e || "");
			return (e && e.name === "AbortError") || /aborted|abort/i.test(msg);
		}
		async function apiJson(p, init) {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), apiTimeoutMs(p, init));
			try {
				const r = await fetch(apiUrl(p), { cache: "no-store", credentials: "same-origin", signal: ctrl.signal, ...(init || {}) });
				const text = await r.text();
				let data;
				try { data = text ? JSON.parse(text) : null; } catch {
					throw new Error(r.status + " non-json: " + text.slice(0, 120));
				}
				if (!r.ok) throw new Error((data && (data.error || data.message)) || (r.status + " " + r.statusText));
				return data;
			} catch (e) {
				if (isAbortError(e)) throw new Error("timeout");
				const msg = String((e && e.message) || e || "");
				if (/failed to fetch|networkerror|load failed/i.test(msg)) {
					throw new Error(dt('drill.e20001'));
				}
				throw e;
			} finally { clearTimeout(timer); }
		}

		function promptBoxEmpty(text) {
			return !String(text || "").trim();
		}

		function responseNeedsPrompt(d) {
			return Boolean(d && (d.needPrompt || d.injectSource === "none"));
		}

		function warnNeedPrompt(d, tr) {
			if (!responseNeedsPrompt(d)) return false;
			window.alert(tr("need.prompt"));
			return true;
		}

		async function bothInjectEmpty(overrideText, defaultText) {
			if (!promptBoxEmpty(overrideText)) return false;
			if (!promptBoxEmpty(defaultText)) return false;
			return true;
		}

		function rulesApi(op, extra) {
			return apiJson("/dsh-purge/rules", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ op: op, ...(extra || {}) }),
			});
		}

		function skillsRouteMissing(e) {
			return /\b404\b|\b405\b|non-json/i.test(String((e && e.message) || e || ""));
		}

		function skillsApi(op, extra) {
			const init = {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ op: op, ...(extra || {}) }),
			};
			return apiJson("/dsh-purge/skills", init).catch((e) => {
				if (!skillsRouteMissing(e)) throw e;
				return apiJson("/dsh-purge/skill", init);
			});
		}

		const TARGETS = ["AGENTS.md", "CLAUDE.md"];

		const zh = {
			nav: "规则设定",
			"dock.clean": "清洗",
			"dock.drill": "演练台（实验性：记录仅供演示，不作成绩）",
			"drill.missing": "演练台组件没有随产物加载，主区暂时只能显示这条说明。",
			"dock.toggle": "dsh-purge",
			"dock.newSession": "dsh-purge",
			"dock.inSession": "dsh-purge",
			"dock.redteam": "红队模式",
			"dock.full": "全面浏览",
			"dock.close": "收起",
			"dock.unauthorized": "未授权",
			"welcome.title": "用户须知",
			"welcome.lead": "首次安装本插件时请阅读以下说明。确认后本窗不再弹出。",
			"welcome.warn": "本插件以 MIT 许可发布，可自由使用与修改。请勿将其用于未经授权的攻击行为。",
			"welcome.body": "dsh-purge 是 DeepSeek Harness 的本机网络安全红队评测与清洗插件：在受控本机环境中调整提示词与补丁、做授权范围内的演练台操作。项目免费、非营利，源码仓库：",
			"welcome.repo": "https://github.com/wufeng0105/dsh-purge-desktop",
			"welcome.ban1": "禁止将本项目用于未授权的网络攻击、入侵、窃取数据、破坏系统或任何违法犯罪。",
			"welcome.ban2": "禁止将本项目用于黑灰产牟利或其他违法活动。",
			"welcome.ban3": "使用者须自行遵守所在地法律法规与平台规范；违法后果由行为人自行承担，与作者无关。",
			"welcome.bans": "禁止事项",
			"welcome.check": "我已阅读并理解上述用户须知，同意合法合规使用。",
			"welcome.ok": "我已知晓并继续",
			"auth.title": "演练台授权确认",
			"auth.lead": "清洗不需要这一步。第一次进入演练台，或打开全面浏览，都要先完成本窗。",
			"auth.warn": "安全警告：演练台只用于你有权管理的本机、离线靶标，或已书面授权的演练环境。未经授权的渗透、攻击、窃取和破坏一律禁止。",
			"auth.hint.wait": "请阅读声明。{n} 秒后才能勾选。",
			"auth.hint.scroll": "倒计时已结束。请把声明滚到文末，再勾选。",
			"auth.hint.check": "倒计时已结束。请勾选全部三项。",
			"auth.check.read": "我已读完《安全与禁止违法声明》，并认可其中的全部条款。",
			"auth.check.scope": "我确认只用在本机已授权环境、离线靶标或合规演练中。",
			"auth.check.ban": "我确认禁止任何违法用途。未完成本授权，不得使用演练台。",
			"auth.no": "暂不进入",
			"auth.ok": "确认授权",
			"auth.ok.tab": "确认授权并进入演练台",
			"auth.ok.full": "确认授权并全面浏览",
			"auth.ok.env": "确认授权并打开环境适配",
			"envGate.title": "环境还没配好",
			"envGate.lead": "红队模式发送前需要本机工具。未检测到可用环境时，先去环境适配，或确认暂不配置。",
			"envGate.kaliHint": "检测到 Kali 时会直接用本机工具，不必填路径。没有 Kali 时，在环境适配里填写各工具路径，或选一个整包文件夹自动分配。",
			"envGate.skip": "暂不配置",
			"envGate.skipConfirm": "确认后这次可以继续对话。扫描和利用类技能仍会因为缺少工具而不可用，之后可以在 dsh-purge → 环境适配里补路径。",
			"envGate.skipNo": "返回",
			"envGate.skipYes": "确认暂不配置",
			"envGate.go": "去环境适配",
			"theme.aria": "外观",
			"theme.white": "白",
			"theme.ink": "墨",
			"purge.title": "补丁",
			"override.title": "提示词",
			"own.title": "自己的服务器",
			"own.hint": "每行一个 IP 或完整主机名。可以写成 账号@主机，账号只用来认出这种写法。主机名会连同它当时解析出的地址一起放行。不要写密钥、密码、网段。",
			"own.save": "保存名单",
			"saved.own": "已保存自己的服务器",
			"saved.own.dropped": "已保存。有 {n} 行不是单个 IP 或主机名，已丢掉",
			"metric.purged": "已写入",
			"metric.purged.skip": "已写入。跳过 {n} 项，本机没有这些文件",
			"metric.pendingShort": "待处理 {n}",
			"metric.unmatchedShort": "没对上 {n}",
			"metric.skipShort": "跳过 {n}",
			"metric.unlocated.count": "—",
			"metric.shim": "shim",
			"metric.shim.na": "本端不需要",
			"metric.bak.yes": "有备份",
			"metric.bak.no": "无备份",
			"metric.bak.hint": "备份",
			"table.patch": "项目",
			"table.status": "状态",
			"status.applied": "已应用",
			"status.off": "已关闭",
			"status.pending": "待应用",
			"status.unmatched": "没对上",
			"status.skipped": "跳过",
			"warn.noRoot": "未定位到当前宿主的 @deepseek-ai，清洗不会生效。请完全退出后再打开本宿主；保存即自动应用，需要宿主重载的项会提示重启。桌面端安装目录可以是任意盘符；目录名带 DeepseekHarness / DeepSeek Harness 均可。",
			"warn.noRoot.desktop": "官方客户端的代码在 app.asar 里。保存即自动应用；解开与写回都由插件完成，不用另跑脚本。若一直显示还没定位，先完全退出客户端再开。第三方 DSH Desktop 直接保存即可。",
			"unpack.restarting": "补丁已写入。点「重启」后客户端会自己重新打开。",
			"restart.fullQuit": "正在重启，客户端会自己重新打开。",
			"warn.noInject": "官方始终用默认提示词。红队开了规则集就只用规则集；没开时用去掉 CTF 的默认提示词，再接红队操作。两边都空会提示必须添加。",
			"need.prompt": "提示词和规则集都是空的，必须先添加提示词，或启用一条有内容的规则集。",
			"btn.restoreInject": "恢复默认",
			"saved.restoreInject": "已恢复默认提示词",
			"skip": "跳过",
			"unknown": "未知",
			"delete": "删除",
			"btn.revert": "还原",
			"btn.uninstall": "卸载",
			"btn.uninstall.busy": "卸载中…",
			"uninstall.title": "卸载 dsh-purge",
			"uninstall.body": "是否卸载？卸载将还原回原版，并清除本插件的全部文件与补丁。",
			"uninstall.confirm": "确认卸载",
			"uninstall.cancel": "取消",
			"uninstall.applying": "正在卸载并还原…",
			"uninstall.done": "已卸载并还原，正在重启…",
			"uninstall.done.desktop": "已卸载并还原，正在重启桌面应用…",
			"uninstall.fail": "卸载失败: {error}",
			"btn.checkUpdate": "检测更新",
			"btn.checkUpdate.busy": "检测中…",
			"btn.doUpdate": "更新",
			"btn.doUpdate.busy": "更新中…",
			"channel.title": "通道",
			"channel.stable": "正式版",
			"channel.beta": "测试版",
			"channel.useStable": "切换到正式版",
			"channel.useBeta": "切换到测试版",
			"channel.local": "本机",
			"update.checking": "正在检测更新…",
			"update.applying": "正在更新…",
			"update.switching": "正在切换版本…",
			"update.latest": "已是最新（{version}）",
			"update.available": "有新版本 {remote}，当前 {local}",
			"update.pinned": "已固定在 {version}，通道最新是 {remote}",
			"update.done": "已更新到 {version}",
			"update.restarting": "已还原并写入新补丁，正在重启…",
			"update.fullQuit": "补丁已写入。点「重启」后客户端会自己重新打开。",
			"restart.official.title": "需要重启",
			"restart.official.body": "补丁已写入。点重启后客户端会自己重新打开。",
			"update.switched": "已切换到 {version}",
			"update.autoDone": "已自动更新到 {version}",
			"update.reloading": "正在刷新设置页…",
			"update.dirty": "有新版本，本地有改动未自动覆盖",
			"update.fail": "更新失败: {error}",
			"update.timeout": "检测超时，请再点一次检测更新",
			"update.needRestart": "检测接口未加载，请先重启 dsh 再点检测更新",
			"update.noBeta": "还没有测试版",
			"update.switch": "切换到此版本",
			"update.pick": "选择版本",
			"update.tip": "最新",
			"update.current": "当前",
			"update.confirmSwitch": "切换到 {version}？之后可再切回另一通道或其它版本。本地未提交的插件改动不会保留。",
			"update.confirmChannel": "切换到{version}？会按该通道重新安装插件，本地未提交的插件改动不会保留。",
			"metric.version": "版本",
			"action.apply": "应用",
			"action.revert": "还原",
			"action.uninstall": "卸载",
			"ok.done": "已完成",
			"err.action": "失败: {error}",
			"err.status": "读取失败: {error}",
			"err.override": "读取失败: {error}",
			"err.rules": "读取失败: {error}",
			"err.read": "读取失败: {error}",
			"err.save": "保存失败: {error}",
			"btn.saveInject": "保存",
			"saved.override": "已保存",
			"rules.title": "规则集",
			"rules.none": "无",
			"rules.reset": "还原",
			"rules.reset.confirm": "还原全局指令文件？规则库会保留。",
			"rules.empty": "暂无规则",
			"rules.pick": "选择规则",
			"policy.title": "工作区策略",
			"policy.strict": "严格",
			"policy.fallback": "空位兜底",
			"policy.always": "总是允许",
			"policy.hint": "严格：永远剥 AGENTS.md / CLAUDE.md；空位兜底：提示词框为空时才用；总是允许：保留 DSH 原生行为",
			"cwd.title": "本地规则（当前目录）",
			"cwd.empty": "当前目录没有 AGENTS.md / CLAUDE.md",
			"cwd.rescan": "重新扫描",
			"cwd.hint": "只有提示词框为空时，被勾选的本地文件才作为兜底注入；提示词框一旦非空就不会用这些文件。",
			"cwd.scope.cwd": "当前目录",
			"cwd.scope.ancestor": "上级",
			"cwd.scope.root": "项目根",
			"cwd.no.workspace": "DSH 尚未选过工作目录，请先在 DSH 里开始一次任务再回来。",
			"pill.current": "当前",
			"btn.use": "启用",
			"btn.inUse": "当前",
			"confirm.delete": "删除 {id}？",
			"ph.id": "id",
			"ph.alias": "名称",
			"ph.alias.short": "名称",
			"btn.create": "新建",
			"need.id": "需要 id",
			"ph.content": "",
			"btn.saveRule": "保存",
			"skills.title": "Skill",
			"skills.hint": "导入到官方目录后，由 DSH 调用：聊天输入 /名称 立即加载；任务对上 description 或 whenToUse 时模型会调 skill 工具。正文写「激活」不会触发。",
			"skills.hint.desktop": "当前桌面宿主的官方 Skill 目录。聊天输入 /名称 立即加载；任务对上 description 时模型会调 skill 工具。",
			"skills.empty": "暂无用户 Skill",
			"btn.importZip": "导入压缩包",
			"btn.importFolder": "导入文件夹",
			"skills.importing": "正在导入…",
			"saved.import": "已导入 {count} 个 Skill",
			"need.import": "请选择压缩包或文件夹",
			"err.import.folder": "没读到文件夹里的文件，请直接选 Skill 目录（里面要有 SKILL.md）",
			"skills.pick": "选择 Skill",
			"skills.invalid": "官方会忽略：格式不对",
			"skills.call.slash": "聊天输入 {cmd}",
			"skills.call.model": "模型可调",
			"skills.call.modelOff": "模型不可调",
			"skills.call.userOff": "不可 /名称",
			"ph.skill.desc": "description（何时用）",
			"btn.saveSkill": "保存",
			"need.skill.id": "id 必须是 kebab-case，例如 code-review",
			"confirm.delete.skill": "从官方 $DSH_HOME/skills 删除 {id}？宿主会自动从目录拿掉。",
			"err.skills": "读取失败: {error}",
			"err.skills.needRestart": "Skill 接口未加载，请先重启当前宿主",
			"btn.restart": "重启",
			"btn.restart.busy": "重启中…",
			"restarting": "重启中…",
			"restarting.desktop": "正在重启桌面应用…",
			"restart.timeout": "超时，请刷新",
			"restart.fail": "失败: {error}",
			"restart.notStarted": "重启没有开始，客户端还在。不会自动再试。",
			"restart.already": "这一次重启已经开始，不会再重启一次。",
			"restart.confirm": "清洗已完成，重启后生效。",
			"restart.confirm.desktop": "清洗已完成，重启桌面应用后生效。",
			"restart.ask.title": "要现在重启吗",
			"restart.ask.body": "已经写入。重启后才会在当前客户端里生效。",
			"restart.now": "现在重启",
			"restart.notNow": "稍后",
			"restart.asarSwap": "补丁已写入磁盘。正在结束桌面进程并挪开 app.asar，完成后会自动重新打开；若仍无效，请先完全退出 Harness（托盘也关），再点一次应用。",
			"surface.web": "Web",
			"surface.desktop": "桌面端",
			"surface.gui": "GUI",
			"surface.tui": "TUI",
			"restart.incomplete": "提示词已写入。{detail}",
			"restart.incomplete.patches": "还有 {failed} 项代码补丁没对上当前版本（#{ids}），不影响这段提示词",
			"restart.incomplete.flash": "CMD 无感未钉入（{entry}）",
			"restart.later": "以后",
			"group.prompt": "提示词",
			"group.code": "代码",
			"group.engine": "引擎",
			"group.tools": "工具",
			"group.compat": "0.1.5 兼容",
			"group.dsh20": "0.2.0",
			"patch.1": "全局免责 → 强指令",
			"patch.2": "替换式免责 → 强指令",
			"patch.3": "作用域免责 → 强指令",
			"patch.4": "persona 会话强指令",
			"patch.5": "审批提示句 → 全权限",
			"patch.6": "沙箱 deny → allow 写",
			"patch.7": "沙箱默认全权限",
			"patch.8": "审批默认 never",
			"patch.9": "审批门自动放行",
			"patch.10": "审批配置默认 never",
			"patch.11": "never 提示句 → 自动放行",
			"patch.12": "ask 提示句 → 自动放行",
			"patch.13": "豁免升级阶梯",
			"patch.14": "升级无条件授信",
			"patch.15": "沙箱 confine 直通",
			"patch.16": "文件系统围栏取消",
			"patch.17": "观察策略读写放行",
			"patch.18": "重复调用守卫禁用",
			"patch.19": "工具结果修剪禁用",
			"patch.21": "恢复插件延长的 bash 等待",
			"patch.22": "read 上限放宽",
			"patch.23": "子代理深度 3 → 10",
			"patch.24": "preset fetch 启用",
			"patch.25": "去掉官方默认身份（功能提示词不动）",
			"patch.26": "minimal：去掉默认身份并打开 inject",
			"patch.70": "极简模式终端不再禁止网络",
			"patch.29": "dsh-tool-web：外部 untrusted 拦截→可执行",
			"patch.30": "dsh-hooks-claude-code：deny→allow",
			"patch.31": "dsh-hooks-codex：deny→allow",
			"patch.32": "Web 表面身份中性化",
			"patch.33": "Shell 拒绝提示 → 可执行",
			"patch.34": "沙箱提示中性化",
			"patch.35": "升级 never 不拒",
			"patch.36": "文件系统升级 schema 放行",
			"patch.37": "子代理 scope lock 中性化",
			"patch.39": "会话 v0 plugin summary（mnemon）",
			"patch.40": "complete 预设仍保留注入",
			"patch.42": "设置页旧接口",
			"patch.43": "网页预设去掉默认身份",
			"patch.46": "官方更新脚本只用英文",
			"patch.47": "OAuth 不再插入 Claude 身份",
			"patch.48": "shell 去掉删除前的额外确认",
			"patch.49": "OAuth 不再伪装 claude-cli",
			"patch.50": "跨会话引用不再标不可信",
			"patch.51": "新会话保持完全权限",
			"patch.52": "会话日志默认不上传",
			"patch.53": "网页提示去掉禁止另开服务器",
			"patch.54": "交付物提示去掉多余禁止",
			"patch.55": "每一步替换第一条系统提示",
			"patch.56": "回退只藏被撤掉的那一轮",
			"patch.57": "developer role 仅限 openai/azure，第三方代理回退 system",
			"patch.58": "回退空标记不进模型请求",
			"patch.59": "官方 Auto Review 不再拦工具",
			"patch.60": "官方 run_code 去掉审批教学",
			"patch.61": "官方沙箱策略不再教拒绝",
			"patch.62": "无审批通道时放行（用户拒绝仍有效）",
			"patch.63": "计划模式不再软拦执行",
			"patch.64": "Stop hook 不再注入假用户话",
			"patch.65": "UserPromptSubmit deny 不再整轮 reject",
			"patch.66": "空的系统段不再把这一轮打成内部错误",
			"patch.67": "缺 messages 时这一轮不中断",
			"patch.68": "回退后缺 content 不中断",
			"patch.69": "deepseek-flash 保持官方 in-history",
			"patch.72": "Messages 的 system 用当前系统提示",
			"patch.73": "极简 bash 去掉误留的镜像说明",
			"patch.74": "启动/应用把默认提示词写入 prompt-inject.md",
			"patch.75": "回退把已完成任务收回成未开始",
			"patch.76": "unrestricted 预设去掉身份句",
			"patch.77": "回退标记到达时丢弃已发送消息",
			"patch.78": "补丁文件缺失时从 .bak 恢复",
			"patch.80": "恢复官方极简工具表",
			"patch.82": "主进程兜底 DSH_PROFILE=desktop",
			"patch.83": "host 信号杀时不报错不弹对话框",
			"patch.84": "host code=0 正常退出不报错 (消除 stopped 对话框)",
			"patch.85": "prompt() 的 steer 仍走插话，不压成 followup",
			"patch.86": "队列插话走 steer；公共 steer() 保持下一步",
			"patch.87": "首次 assemble 用 prepare 返回的当前模式 systemPrompt",
			"patch.88": "去掉 renderPrompt 后的挂针，注入只走 assemble",
			"status.unlocated": "未定位",
			"status.na": "本端不需要",
			"metric.unlocated": "还没定位到本机 Harness",
			"metric.sealed": "已找到官方客户端，保存即自动应用（asar 会解开）",
			"metric.sealed.count": "待解开",
			"metric.lost": "补丁已丢失，请重新应用",
			"metric.lost.count": "已丢失",
			"rewind.label": "回退",
			"rewind.aria": "回退",
			"rewind.busy": "回退中…",
			"rewind.empty": "没有可回退的上一句",
			"rewind.fail": "回退失败: {error}",
			"rewind.once": "回退上一步",
					"rewind.once.hint": "撤回最后一步已进行的对话，新会话接上之前的上下文；那句回到输入框再发送",
			"rewind.round": "回退上一轮",
					"rewind.round.hint": "撤回上一整轮（含子代理）已进行的对话，新会话接上之前的上下文；那句回到输入框再发送",
			"hooksDeny.title": "Hooks 拦截",
			"hooksDeny.bypass": "放行 hooks 的 deny / ask（补丁 30 / 31 / 64 / 65）",
			"hooksDeny.hint": "关掉后，用户自己的 PreToolUse / UserPromptSubmit / Stop hook 的 deny 会按官方逻辑生效。官方 ask 分支本身是空操作，关开关不会弹出审批框。改动会自动应用；需要宿主重载的项会提示重启。",
			"saved.hooksDeny": "已保存",
			"continue.title": "失败重试 / 继续",
			"continue.hint": "请求失败会自动重试；异常停止或中断可点「继续」或自动续跑。自己点停止不会自动继续。次数用完后需新开一轮。",
			"continue.autoRetry": "失败自动重试",
			"continue.retryMax": "重试次数",
			"continue.autoContinue": "中断后自动继续",
			"continue.continueMax": "继续次数",
			"continue.text": "继续用语",
			"saved.continue": "已保存",
			"continue.label": "继续",
			"continue.aria": "异常停止后继续",
			"continue.busy": "继续中…",
			"continue.ready": "继续（还可 {left} 次）",
			"continue.limit": "已达继续上限",
			"continue.fail": "继续失败: {error}",
			"drill.d1": "扁",
			"drill.d2": "属于上面那个头",
			"drill.d3": "远程命令执行",
			"drill.d4": "反序列化",
			"drill.d5": "文件上传 getshell",
			"drill.d6": "SQL 注入",
			"drill.d7": "未授权访问",
			"drill.d8": "认证绕过 / 越权",
			"drill.d9": "弱口令 / 爆破",
			"drill.d10": "目录穿越 / 任意文件读",
			"drill.d11": "信息泄露",
			"drill.d12": "提权 / 横向",
			"drill.d13": "隧道 / 代理",
			"drill.d14": "其它",
			"drill.d15": "主会话（指挥）",
			"drill.d16": "信息收集",
			"drill.d17": "资产梳理",
			"drill.d18": "漏洞发现",
			"drill.d19": "漏洞利用",
			"drill.d20": "内网渗透",
			"drill.d21": "现场截图",
			"drill.d22": "记录生成的证据摘录",
			"drill.d23": "载入中…",
			"drill.d24": "证据 ",
			"drill.d25": "由当日记录生成的证据摘录，不是现场截图 —— 报告里同样会标注",
			"drill.d26": "证据",
			"drill.d27": "　·　点击任意处关闭",
			"drill.d28": "证据截图",
			"drill.d29": "显示 ",
			"drill.d30": " 张",
			"drill.d31": "（该得分点共 ",
			"drill.d32": "未知",
			"drill.d33": "已复制：",
			"drill.d34": "复制失败（浏览器未授权剪贴板）—— 请手动选中文本复制",
			"drill.d35": "未测试",
			"drill.d36": "测试中",
			"drill.d37": "已测试",
			"drill.d38": "被封禁",
			"drill.d39": "已放弃",
			"drill.d40": "无攻击面",
			"drill.d41": "高",
			"drill.d42": "中",
			"drill.d43": "低",
			"drill.d44": "未评",
			"drill.d45": "查询失败",
			"drill.d46": "全部 C 段",
			"drill.d47": " 个网段",
			"drill.d48": "正在跑的扫描 / 探测与进度（5 秒自动刷新）",
			"drill.d49": "当前测试",
			"drill.d50": "当前测试（既非内网也非外网）",
			"drill.d51": "测",
			"drill.d52": "正在跑的扫描与探测",
			"drill.d53": "展开本组",
			"drill.d54": "（并切回资产列表）",
			"drill.d55": "外网",
			"drill.d56": " 个 C 段",
			"drill.d57": " 资产",
			"drill.d58": "未知归属",
			"drill.d59": " · 存活 ",
			"drill.d60": " 台",
			"drill.d61": "筛选 C 段 ",
			"drill.d62": "外",
			"drill.d63": "外网资产",
			"drill.d64": "内网资产",
			"drill.d65": "搜索 IP / 域名 / 指纹（回车）",
			"drill.d66": "搜索",
			"drill.d67": "服务",
			"drill.d68": "端口",
			"drill.d69": "内外网不限",
			"drill.d70": "仅外网资产",
			"drill.d71": "仅内网资产",
			"drill.d72": "按端口来源过滤（列表已不再单列显示，详情里可见）",
			"drill.d73": "来源不限",
			"drill.d74": "仅被动",
			"drill.d75": "仅主动",
			"drill.d76": "易打性不限",
			"drill.d77": "易打（高）",
			"drill.d78": "一般（中）",
			"drill.d79": "难打（低）",
			"drill.d80": "测试状态不限",
			"drill.d81": "重新拉取快照与当前视图数据",
			"drill.d82": "刷新",
			"drill.d83": "列表",
			"drill.d84": "按发现时间看资产（什么时候发现、哪天收了多少）",
			"drill.d85": "发现时间",
			"drill.d86": "域名",
			"drill.d87": "点击筛选 / 再点取消",
			"drill.d88": "按「",
			"drill.d89": "」筛选（",
			"drill.d90": "台资产",
			"drill.d91": "存活",
			"drill.d92": "待测",
			"drill.d93": "已测",
			"drill.d94": "放弃",
			"drill.d95": "列表排序方式",
			"drill.d96": "排序：易打性优先",
			"drill.d97": "排序：待测优先",
			"drill.d98": "排序：最近发现优先",
			"drill.d99": "排序：端口多优先",
			"drill.d100": "排序：按 IP",
			"drill.d101": "易打",
			"drill.d102": "测试状态",
			"drill.d103": "开放端口 / 服务",
			"drill.d104": "指纹",
			"drill.d105": "展开资产 ",
			"drill.d106": "发现时间：",
			"drill.d107": "未记录",
			"drill.d108": "\\n最近采集：",
			"drill.d109": "发现时间未知",
			"drill.d110": "封",
			"drill.d111": "未知服务",
			"drill.d112": "未知工具",
			"drill.d113": "测试",
			"drill.d114": "被封 ",
			"drill.d115": " 次",
			"drill.d116": "未测过",
			"drill.d117": "易打性",
			"drill.d118": "未评估",
			"drill.d119": "攻击面",
			"drill.d120": "无开放端口",
			"drill.d121": "展开资产详情",
			"drill.d122": "展开全部（端口 · 指纹 · 采集溯源 · 测试记录）▼",
			"drill.d123": "主机名",
			"drill.d124": "本条资产第一次进入资产库的时刻（重复采集只刷新\"最近采集\"）",
			"drill.d125": "最近采集",
			"drill.d126": "数据源首见",
			"drill.d127": "C 段",
			"drill.d128": " · 预期：",
			"drill.d129": " · 依据：",
			"drill.d130": "来源",
			"drill.d131": "被动端口 ",
			"drill.d132": " · 主动端口 ",
			"drill.d133": "测试记录（",
			"drill.d134": " 条）",
			"drill.d135": "采集溯源（最近 8 条）",
			"drill.d136": "加载中…",
			"drill.d137": "没有匹配的资产",
			"drill.d138": " 个资产",
			"drill.d139": "暂无域名数据（信息收集阶段会写入域名）",
			"drill.d140": "URL（可点击）",
			"drill.d141": "标题",
			"drill.d142": "资产",
			"drill.d143": "暂无 Web 资产（HTTP 探测后会写入 URL 与标题）",
			"drill.d144": "加载失败",
			"drill.d145": "资产发现时间线",
			"drill.d146": "共 ",
			"drill.d147": " 台 · 最早 ",
			"drill.d148": " · 最近 ",
			"drill.d149": "（发现时间 = 第一次进入资产库的时刻；重复采集只刷新\"最近采集\"）",
			"drill.d150": "还没有资产。",
			"drill.d151": "按天统计",
			"drill.d152": "清除按天筛选：",
			"drill.d153": "清除筛选：",
			"drill.d154": "：新增 ",
			"drill.d155": " 台（内网 ",
			"drill.d156": " / 外网 ",
			"drill.d157": "筛选 ",
			"drill.d158": " 发现的资产",
			"drill.d159": " 台 · 内 ",
			"drill.d160": " / 外 ",
			"drill.d161": " 发现的资产（",
			"drill.d162": "最近发现的资产（",
			"drill.d163": "这一天没有新增资产。",
			"drill.d164": "时间未知",
			"drill.d165": "读取失败",
			"drill.d166": "当前为内置默认提示词（创建靶标后可按靶标保存修改）",
			"drill.d167": "请先创建靶标，再保存提示词",
			"drill.d168": "保存失败",
			"drill.d169": "已保存",
			"drill.d170": "请先创建靶标，再恢复默认提示词",
			"drill.d171": "恢复失败",
			"drill.d172": "已恢复内置默认：",
			"drill.d173": "查看「",
			"drill.d174": "」提示词",
			"drill.d175": "（空）",
			"drill.d176": "提示词",
			"drill.d177": "更新 ",
			"drill.d178": "把当前角色恢复成内置最新版提示词",
			"drill.d179": "恢复默认为当前",
			"drill.d180": "四个角色全部恢复成内置最新版提示词",
			"drill.d181": "全部恢复默认",
			"drill.d182": "保存",
			"drill.d183": "该角色的系统提示词（Markdown）",
			"drill.d184": "保存后写入 agents/",
			"drill.d185": ".md。子会话任务第一行写 redteamRole: recon、assess、vuln-scan、exploit 或 internal 后，对应文件进入系统提示词。",
			"drill.d186": "查看技能 ",
			"drill.d187": "仅人工",
			"drill.d188": "官方技能目录，不按红队工具路径检查",
			"drill.d189": "官方",
			"drill.d190": "可用：技能正文可以加载。缺的外部工具或密钥记在详情里，不阻止调用。",
			"drill.d191": "（无描述）",
			"drill.d192": "来源 ",
			"drill.d193": "红队技能",
			"drill.d194": "官方技能",
			"drill.d195": "过滤技能",
			"drill.d196": "只看本插件自带（",
			"drill.d197": " 个）",
			"drill.d198": "只看有明确缺口（缺 key / 缺本机路径 / 基础设施还是占位符）或判不了可用性的技能",
			"drill.d199": "只看不可用/未知（",
			"drill.d200": "可用 ",
			"drill.d201": "不可用 ",
			"drill.d202": "未知 ",
			"drill.d203": "技能正文或环境变量刚改过？点这里跳过 30 秒缓存重查",
			"drill.d204": "重新检查技能可用性",
			"drill.d205": "重查可用性",
			"drill.d206": "红队 ",
			"drill.d207": " · 官方 ",
			"drill.d208": "（技能多来自其它插件注册的根或你自己的技能目录；本插件只自带 ",
			"drill.d209": "技能目录（DSH 原生）",
			"drill.d210": "该模块的宿主代码已更新，需重启一次当前宿主（官方 exe / 社区版 / dsh web）后生效",
			"drill.d211": "描述",
			"drill.d212": "何时使用",
			"drill.d213": "类型",
			"drill.d214": "官方技能。由宿主按任务调用，不按红队工具路径检查。",
			"drill.d215": "可用性",
			"drill.d216": "未知（正文读不到）",
			"drill.d217": "缺口",
			"drill.d218": "需要你提供",
			"drill.d219": "文件",
			"drill.d220": "技能由 DSH 原生 skill 体系管理，红队智能体通过 skill 工具调用。",
			"drill.d221": "检查于 ",
			"drill.d222": "现在跑不起来的技能：",
			"drill.d223": " 个 · ",
			"drill.d224": "…另有 ",
			"drill.d225": " 个目录（共 ",
			"drill.d226": " 个技能）",
			"drill.d227": "左侧选择技能查看内容",
			"drill.d228": "严重",
			"drill.d229": "高危",
			"drill.d230": "中危",
			"drill.d231": "低危",
			"drill.d232": "信息",
			"drill.d233": "待验证",
			"drill.d234": "已确认",
			"drill.d235": "误报",
			"drill.d236": "已利用",
			"drill.d237": "已修复",
			"drill.d238": "(未指定目标)",
			"drill.d239": "证据摘要",
			"drill.d240": "文本",
			"drill.d241": "复制",
			"drill.d242": "HTTP 证据",
			"drill.d243": "▸ 请求（可直接粘进 Burp Repeater）",
			"drill.d244": "▸ 响应",
			"drill.d245": "缺失 —— 未验证/无证据的漏洞不计入报告，请补 redteam_http_evidence_add",
			"drill.d246": "更新失败",
			"drill.d247": "已更新为「",
			"drill.d248": "拿到权限",
			"drill.d249": "默认按目标聚合 · 共 ",
			"drill.d250": " 个目标",
			"drill.d251": "等级",
			"drill.d252": "漏洞 / 编号",
			"drill.d253": "目标",
			"drill.d254": "拿到什么",
			"drill.d255": "状态",
			"drill.d256": "置信",
			"drill.d257": "未记录 —— 拿到权限/成果后请用 redteam_vuln_update 补 gained（例：服务器权限、内网隧道、后台管理员账号）",
			"drill.d258": "攻击文件",
			"drill.d259": "(未命名)",
			"drill.d260": "（无）用 redteam_attack_file_add 把这条漏洞打通的脚本/马/EXP 归档，并带上 vuln_id",
			"drill.d261": "确认",
			"drill.d262": " 个漏洞",
			"drill.d263": "已利用 ",
			"drill.d264": "资产 ",
			"drill.d265": "未记录权限",
			"drill.d266": "暂无漏洞记录",
			"drill.d267": "搜索标题 / CVE / 目标（回车）",
			"drill.d268": "全部等级",
			"drill.d269": "全部状态",
			"drill.d270": "凭据 · ",
			"drill.d271": "点击可全选",
			"drill.d272": "未记明文 —— 请用 redteam_credential_add 的 secret_value 补上，面板才能直显",
			"drill.d273": "工具 ",
			"drill.d274": "备注：",
			"drill.d275": "暂无凭据（拿到口令/密钥/Hash 后用 redteam_credential_add 落库，秒级可复用）",
			"drill.d276": "已获得访问会话 · ",
			"drill.d277": "暂无",
			"drill.d278": "漏洞",
			"drill.d279": "凭据",
			"drill.d280": "访问会话",
			"drill.d281": "展开所有目标",
			"drill.d282": "全部展开",
			"drill.d283": "收起所有目标",
			"drill.d284": "全部收起",
			"drill.d285": "当前：平铺每条漏洞",
			"drill.d286": "平铺列表",
			"drill.d287": "攻击文件按靶标目录组织（原「攻击文件」页签）；每条漏洞的关联文件也能在该漏洞详情里直接看到。",
			"drill.d288": " 目前有 ",
			"drill.d289": "获得权限",
			"drill.d290": "内网突破",
			"drill.d291": "敏感数据",
			"drill.d292": "其他",
			"drill.d293": "利用漏洞",
			"drill.d294": "次数",
			"drill.d295": "同类第 ",
			"drill.d296": " 次 · +",
			"drill.d297": " 分",
			"drill.d298": "记录",
			"drill.d299": "结果与证据",
			"drill.d300": "同一资产同一端口只算分值最高的一条",
			"drill.d301": "服务已拿满 · 不计分",
			"drill.d302": "第 ",
			"drill.d303": "动作：",
			"drill.d304": "（未命名步骤）",
			"drill.d305": "端口 ",
			"drill.d306": "漏洞 ",
			"drill.d307": "易打 ",
			"drill.d308": "拿到分数的资产 · ",
			"drill.d309": "还没有产生得分的资产",
			"drill.d310": "本阶段命中 ",
			"drill.d311": "本阶段还没有得分",
			"drill.d312": "跨越靶标边界的通道 · ",
			"drill.d313": " 条",
			"drill.d314": "（另有 ",
			"drill.d315": "注意：现有的通道都在自己的服务器上，没有碰到目标 —— 不计边界突破。需要目标侧发起的通道（反弹 shell 到我这 / 目标上跑 frp 客户端 / 经目标 WebShell 的 suo5）。",
			"drill.d316": "可达 ",
			"drill.d317": "还没有建立隧道（建好后用 redteam_tunnel_add 登记）",
			"drill.d318": "涉及资产 · ",
			"drill.d319": "累计 ",
			"drill.d320": "阶段目标",
			"drill.d321": "合计 ",
			"drill.d322": "隧道 ",
			"drill.d323": "台资产拿到分",
			"drill.d324": "外 ",
			"drill.d325": " 次命中",
			"drill.d326": "涉及 ",
			"drill.d327": " 台资产",
			"drill.d328": "攻击链",
			"drill.d329": "信息收集 → 互联网资产权限 → 边界突破 → 内网资产权限 → 靶标权限",
			"drill.d330": "总分 ",
			"drill.d331": "竖向攻击链：逐阶段向下看细节",
			"drill.d332": "链路 A",
			"drill.d333": "横向攻击链：一屏看完五个阶段",
			"drill.d334": "链路 B",
			"drill.d335": "还没有得分记录。拿到成果后用 redteam_score_hit 记分，这条链才会长出来。",
			"drill.d336": "其他得分",
			"drill.d337": "生成失败",
			"drill.d338": "还没有可交付的成果",
			"drill.d339": "已下载：",
			"drill.d340": "下载失败：",
			"drill.d341": " 项请求",
			"drill.d342": "复制请求",
			"drill.d343": "目标 ",
			"drill.d344": "拿到 ",
			"drill.d345": "利用漏洞 ",
			"drill.d346": "结果 ",
			"drill.d347": "取得时间 ",
			"drill.d348": "复现步骤（点击展开）",
			"drill.d349": " 个动作",
			"drill.d350": " 条凭据",
			"drill.d351": " 条隧道",
			"drill.d352": "复现材料待补",
			"drill.d353": "可复现",
			"drill.d354": "注意：没有关联的攻击步骤：说不清这一步是怎么做的。请用 redteam_chain_add 补上动作（title / detail / tool / result），记分时也可以带 point_code + evidence 一次完成。",
			"drill.d355": "(未命名动作)",
			"drill.d356": "按同资产推断",
			"drill.d357": "执行 ",
			"drill.d358": "未记录实际命令（redteam_chain_add 的 tool）",
			"drill.d359": " 步命令",
			"drill.d360": "复制命令",
			"drill.d361": "拿到的凭据（来源可追溯）",
			"drill.d362": "(无用户名)",
			"drill.d363": " · 权限 ",
			"drill.d364": " · 来源 ",
			"drill.d365": "未标注",
			"drill.d366": " · 取得方式 ",
			"drill.d367": "用到的隧道 / 通道",
			"drill.d368": "入口 ",
			"drill.d369": "未登记",
			"drill.d370": " · 可达 ",
			"drill.d371": " · 目标侧 ",
			"drill.d372": "未声明",
			"drill.d373": " · 命令 ",
			"drill.d374": "用到的 WebShell",
			"drill.d375": " · 口令/密钥 ",
			"drill.d376": "注意：复现缺口：",
			"drill.d377": "注意：这一项没有原始请求记录，无法直接复现 —— 请用 redteam_http_evidence_add 补上",
			"drill.d378": "复现请求 ",
			"drill.d379": "请求 ",
			"drill.d380": "复制到 Yakit",
			"drill.d381": "响应摘要",
			"drill.d382": "备注 ",
			"drill.d383": "攻击得分链路复现报告",
			"drill.d384": " 项得分",
			"drill.d385": " 项带原始请求",
			"drill.d386": "复现链是否完整：有攻击步骤、写了实际命令、关联了漏洞/凭据/隧道",
			"drill.d387": "可复现 ",
			"drill.d388": "同一资产同一端口的重复账号/数据库权限命中：服务已拿满，不计分、不进报告",
			"drill.d389": "同服务已拿满不计分 ",
			"drill.d390": "整份报告",
			"drill.d391": "复制全文",
			"drill.d392": "下载 .md",
			"drill.d393": "重新生成",
			"drill.d394": "全部折叠",
			"drill.d395": " 项",
			"drill.d396": "还没有可交付的成果。",
			"drill.d397": "本报告只收录\"拿到了分\"的成果；没有得分的漏洞不进报告。拿到成果后用 redteam_score_hit 记分（目标资产 + 拿到的东西），并补 redteam_http_evidence_add 以便复现。",
			"drill.d398": "口径：只收录得分成果，每条附带可粘进 Yakit Repeater 的原始请求",
			"drill.d399": "脚本",
			"drill.d400": "字典",
			"drill.d401": "效果",
			"drill.d402": "路径",
			"drill.d403": " 个文件",
			"drill.d404": " 个目标 / ",
			"drill.d405": "暂无攻击文件（打通的脚本/POC/EXP 会按目标文件夹出现在这里）",
			"drill.d406": "目录：attack-files/<IP|URL主机|C段>/ ｜ 只收录实际生效的文件",
			"drill.d407": "模板",
			"drill.d408": "载荷",
			"drill.d409": "互联网",
			"drill.d410": "手搓",
			"drill.d411": "人工",
			"drill.d412": "nuclei 模板",
			"drill.d413": "知识库",
			"drill.d414": "演练台手动标记",
			"drill.d415": "已记一次复用：",
			"drill.d416": "已验证",
			"drill.d417": "未验证",
			"drill.d418": "复用 ",
			"drill.d419": "归类 ",
			"drill.d420": "影响版本 ",
			"drill.d421": "建立时间 ",
			"drill.d422": "来源靶标 ",
			"drill.d423": "发现资产 ",
			"drill.d424": "发现角色 ",
			"drill.d425": "读取中…",
			"drill.d426": "用法",
			"drill.d427": "说明",
			"drill.d428": "验证证据",
			"drill.d429": "最近使用",
			"drill.d430": "落盘",
			"drill.d431": "POC 正文",
			"drill.d432": "复制正文",
			"drill.d433": "记一次复用",
			"drill.d434": "来源链接",
			"drill.d435": "复制来源",
			"drill.d436": "这条只有元数据，没有正文 —— 拿到正文后用 redteam_poc_update 补上",
			"drill.d437": "知识库 · POC / EXP",
			"drill.d438": "已验证 ",
			"drill.d439": "累计复用 ",
			"drill.d440": "这些条目还没归类：智能体回填时用 redteam_poc_add 的 category 参数标一下",
			"drill.d441": "未归类 ",
			"drill.d442": "本机模板 ",
			"drill.d443": "按归类分组显示 / 平铺显示",
			"drill.d444": "平铺显示",
			"drill.d445": " · 本机模板 ",
			"drill.d446": " · 知识库 ",
			"drill.d447": "（已验证 ",
			"drill.d448": "搜 CVE / 组件 / 关键字（正文也会搜）",
			"drill.d449": "全部归类",
			"drill.d450": "全部来源靶标",
			"drill.d451": "发现资产筛选",
			"drill.d452": "全部类型",
			"drill.d453": "只看已验证",
			"drill.d454": "检索",
			"drill.d455": "知识库接口由 host 侧提供，当前宿主还是旧进程 —— 请完全退出后重新打开（官方 exe / 社区版 / dsh web 任一），再刷新页面。",
			"drill.d456": "知识库：",
			"drill.d457": "（根目录 ",
			"drill.d458": "最近建立 ",
			"drill.d459": "本机 nuclei 模板 · ",
			"drill.d460": "（直接 `nuclei -t <模板路径>`）",
			"drill.d461": " -u <目标>",
			"drill.d462": "模板命令",
			"drill.d463": "上一页",
			"drill.d464": "下一页",
			"drill.d465": "模板目录：",
			"drill.d466": "没有命中：换个关键字再试，或去互联网找 / 自己手搓后回填。",
			"drill.d467": "POC/EXP 库还是空的；本机已有 ",
			"drill.d468": " 个 nuclei 模板，但这一页没有列出来。请完全退出后重新打开客户端。",
			"drill.d469": "知识库还是空的（本机模板目录存在但没有 yaml，请跑 nuclei -update-templates）。",
			"drill.d470": "知识库还是空的。本机也还没有 nuclei 模板库 —— 在演练机上跑 setup.sh 或 `nuclei -update-templates`，装好后这里会出现「本机模板 N」。",
			"drill.d471": "打 Nday/1day 的标准顺序：① redteam_poc_search 先查这里（顺带搜本机 nuclei 模板库）→ ② 都没有就互联网搜索（web_search / GitHub / ExploitDB / 厂商公告）或自己手搓 → ③ 在真实目标上验证有效后 redteam_poc_add 回填，后面的靶标直接就能用。",
			"drill.d472": "知识库文件：",
			"drill.d473": "全局共享（跨靶标）｜ 落盘：pocs/<code>/ ｜ 只收录通用可复用的 POC/EXP，靶标专用脚本走「攻击文件」",
			"drill.d474": "已保存到 ",
			"drill.d475": "请先填写工具所在文件夹路径",
			"drill.d476": "自动分配失败",
			"drill.d477": "已从文件夹分配 ",
			"drill.d478": " 个工具",
			"drill.d479": "环境适配",
			"drill.d480": "就绪 · ",
			"drill.d481": "待配置",
			"drill.d482": "均可选填：留空则用默认路径/自动查找。填了的覆盖默认。密钥类只在需要测绘/反弹时才填。",
			"drill.d483": "整包文件夹 → 自动分配工具",
			"drill.d484": "工具都在同一个文件夹（含子目录）时，填路径后点「自动分配」：会写入 toolkitDir，并按文件名匹配 nmap / nuclei / fscan 等填到下方。",
			"drill.d485": "例如 D:\\\\pentest-tools 或 /opt/toolkit",
			"drill.d486": "自动分配",
			"drill.d487": "出网状态（借鉴 Z3r0 egress，只读）",
			"drill.d488": "(空)",
			"drill.d489": "平台与目录",
			"drill.d490": "平台模式",
			"drill.d491": "auto（跟随本机，默认）",
			"drill.d492": "工具箱目录 toolkitDir（留空＝默认）",
			"drill.d493": "默认：",
			"drill.d494": "nuclei 模板目录（留空＝自动：toolkit/nuclei-templates）",
			"drill.d495": "工具搜索目录 binDirs（留空＝只搜 toolkit + PATH；每行一个）",
			"drill.d496": "可选。例如：",
			"drill.d497": "密钥与 VPS（留空＝不覆盖；进程环境变量优先）",
			"drill.d498": "（可选）",
			"drill.d499": "留空；测绘时再填",
			"drill.d500": "工具可执行文件（留空＝自动查找）",
			"drill.d501": "解析顺序：本表绝对路径 → toolkitDir → binDirs → PATH。留空即走默认查找。",
			"drill.d502": " · 已找到",
			"drill.d503": "未找到（可留空等装好）",
			"drill.d504": "留空自动找：",
			"drill.d505": "备注",
			"drill.d506": "可选。例如：工具来自某某绿色包",
			"drill.d507": "配置文件：",
			"drill.d508": " | 留空字段全部走默认",
			"drill.d509": "名称不能为空",
			"drill.d510": "已保存「启用/停用」。分值未改动：这是随《得分规则》分发的内置得分点，",
			"drill.d511": "分值 / 上限 / 计分口径由规则锁定（同一条规则的上限按组内所有得分点累计，",
			"drill.d512": "单独改分值会让一条命中吃掉整组上限）。要自定义分值时请「+ 新增得分点」。",
			"drill.d513": "删除失败",
			"drill.d514": "已删除",
			"drill.d515": " · 各项上限合计 ",
			"drill.d516": "分",
			"drill.d517": "已计入 ",
			"drill.d518": " 次，另有 ",
			"drill.d519": " 条因「",
			"drill.d520": "计分口径",
			"drill.d521": "」或已达上限不计分",
			"drill.d522": "未命中",
			"drill.d523": "　上限 ",
			"drill.d524": "未指定资产",
			"drill.d525": "自己注册/自建的账号不算得分权限，只作过程记录",
			"drill.d526": "自建 · 不计分",
			"drill.d527": "同一资产同一端口只算分值最高的一条，这条不计分",
			"drill.d528": "这条命中有证据截图（展开得分点即可看到代表图）",
			"drill.d529": "图 ",
			"drill.d530": "复制这一条",
			"drill.d531": "未填账号密码/结果",
			"drill.d532": "得分条件",
			"drill.d533": "停用",
			"drill.d534": " 分/次 · 命中 ",
			"drill.d535": " 次 = ",
			"drill.d536": "服务封顶",
			"drill.d537": "；账号权限与数据库权限按「同资产同端口」只算一次，拿到最高权限账号即该服务拿满",
			"drill.d538": "证据截图 · ",
			"drill.d539": "命中记录 · ",
			"drill.d540": "（只记资产与账号密码，详细复现见报告）",
			"drill.d541": "命中记录",
			"drill.d542": "还没有 —— 拿下成果后用 redteam_score_hit 记分：写明目标资产 + 拿到的账号密码/权限",
			"drill.d543": "编辑",
			"drill.d544": "得分目标",
			"drill.d545": "总分",
			"drill.d546": " 个得分点",
			"drill.d547": "命中 ",
			"drill.d548": "自己注册/自己创建的账号不算得分权限，只作过程记录（不计分、不占上限、不进报告）",
			"drill.d549": "自建不计分 ",
			"drill.d550": "账号权限与数据库权限按「同资产同端口」只算一次：该服务已拿满，这些重复命中不计分（只作留痕）",
			"drill.d551": "服务已拿满不计分 ",
			"drill.d552": "+ 新增得分点",
			"drill.d553": "内置得分点（来自《突破入侵类得分规则（合并版）》）",
			"drill.d554": "分值、上限、计分口径与名称由规则锁定 —— 同一条规则的上限按组内所有得分点累计，",
			"drill.d555": "单独改分值会让一条命中吃掉整组上限。这里可以改「启用 / 停用」；",
			"drill.d556": "要自定义分值时请返回上一屏点「+ 新增得分点」。",
			"drill.d557": "规则原文序号 ",
			"drill.d558": "　·　上限分组 rule=",
			"drill.d559": "　·　上限 ",
			"drill.d560": "　·　不设上限",
			"drill.d561": "名称（必填）",
			"drill.d562": "分类，如 账号权限",
			"drill.d563": "单次分值",
			"drill.d564": "内置得分点的分值由《得分规则》锁定，不能在这里改",
			"drill.d565": "这一类的单次分值；每命中一次就按这个分值累加（受该条规则上限约束）",
			"drill.d566": "启用",
			"drill.d567": "得分条件说明",
			"drill.d568": "内置得分点不能删除：删掉会让面板缺一条规则、报告少一类成果（下次启动还会自动补回来）。要让它不参与计分请改用「停用」。",
			"drill.d569": "删除（内置项不可删）",
			"drill.d570": "删除",
			"drill.d571": "取消",
			"drill.d572": "分值",
			"drill.d573": "得分点（按分值从低到高）",
			"drill.d574": "命中 / 上限",
			"drill.d575": "已得分",
			"drill.d576": "暂无得分点，点右上角「新增得分点」",
			"drill.d577": "展开",
			"drill.d578": "开放 ",
			"drill.d579": " 端口",
			"drill.d580": "已确认漏洞 ",
			"drill.d581": "测试面：",
			"drill.d582": "预期得分：",
			"drill.d583": "测试记录",
			"drill.d584": "更新于 ",
			"drill.d585": "展开最近动过与待测队列",
			"drill.d586": "只留正在测",
			"drill.d587": "每 5 秒自动刷新",
			"drill.d588": "已暂停",
			"drill.d589": "正在测",
			"drill.d590": "agent 开始测某台资产后会实时出现在这里",
			"drill.d591": "当前没有资产处于「测试中」",
			"drill.d592": "最近动过",
			"drill.d593": "已测过的资产",
			"drill.d594": "待测队列",
			"drill.d595": "按易打性与端口数排出先打哪几台",
			"drill.d596": "完整清单（含筛选与排序）见「资产测绘」页",
			"drill.d597": "没有待测资产",
			"drill.d598": "检测失败",
			"drill.d599": "检测完成：WebShell 在线 ",
			"drill.d600": "，隧道可用 ",
			"drill.d601": "界面手动标记",
			"drill.d602": "怎么做（点击展开）",
			"drill.d603": "有 ",
			"drill.d604": " 个入口不是冰蝎马/哥斯拉马（用户连不上，不算可交付入口）",
			"drill.d605": "用技能 webshell-toolkit 重新上传冰蝎马（behinder）或哥斯拉马（godzilla），",
			"drill.d606": "并把 shell_type + pass_key 写进 redteam_webshell_add。只作临时中转的可在备注里写明。",
			"drill.d607": "现有 ",
			"drill.d608": " 条通道都不算\"跨越靶标边界\"（不算边界/内网突破）",
			"drill.d609": "自己的 VPS / 自建服务器上开的 socks5、frp、代理不算隧道。必须是目标侧发起的通道：",
			"drill.d610": "目标反弹 shell 到我方、目标上跑 frp/Stowaway 客户端、或经目标 WebShell 建的 suo5/HTTP 隧道；登记时用 entry_kind 说明。",
			"drill.d611": "还没有可用的 suo5 隧道（打进内网的标准通道）",
			"drill.d612": "用技能 suo5-tunnel 通过上面的 WebShell 建 socks5 隧道，再 redteam_tunnel_add",
			"drill.d613": "（kind=suo5、listen=127.0.0.1:1080、entry=WebShell URL、reach=可达网段）登记，",
			"drill.d614": "最后点「检测连通性」确认 status=active。",
			"drill.d615": "用户连不上",
			"drill.d616": "已复制",
			"drill.d617": "复制 URL",
			"drill.d618": "标记失效",
			"drill.d619": "非加密马 —— 用户连不上，仅可作临时中转",
			"drill.d620": "连接口令",
			"drill.d621": "所在资产",
			"drill.d622": "权限",
			"drill.d623": "凭据引用",
			"drill.d624": "最后检测",
			"drill.d625": "未检测",
			"drill.d626": "检测说明",
			"drill.d627": "./gogo -i <内网CIDR> -m ss --ping -p top2,win,db --proxy ",
			"drill.d628": "./fscan -h <内网CIDR> -np -nobr -nopoc -socks5 ",
			"drill.d629": "(未填监听地址)",
			"drill.d630": "非 suo5 标准通道",
			"drill.d631": "目标侧通道",
			"drill.d632": "只在自己 VPS/自建服务器上开的通道，没有碰到目标 —— 不算边界突破/内网突破",
			"drill.d633": "不算突破",
			"drill.d634": "未声明 entry_kind：请说明目标侧的那一端是什么（target-outbound / target-http / target-agent）",
			"drill.d635": "待确认",
			"drill.d636": "复制地址",
			"drill.d637": "标记可用",
			"drill.d638": "目标侧入口",
			"drill.d639": "跨越边界",
			"drill.d640": "已确认目标侧",
			"drill.d641": "不算突破（只在自己 VPS 上开代理）",
			"drill.d642": "未声明 entry_kind，待确认",
			"drill.d643": "可达网段",
			"drill.d644": "建立命令（点击展开 / 复制）",
			"drill.d645": "点击复制",
			"drill.d646": "走这条隧道扫描（gogo / fscan 命令）",
			"drill.d647": "复制 gogo 命令",
			"drill.d648": "复制 fscan 命令",
			"drill.d649": "会话与入口",
			"drill.d650": " 在线",
			"drill.d651": " 可用",
			"drill.d652": "凭据 ",
			"drill.d653": "访问会话 ",
			"drill.d654": "检测连通性",
			"drill.d655": "还没有登记任何 WebShell 或隧道。",
			"drill.d656": "拿到 WebShell 用 redteam_webshell_add；建好隧道用 redteam_tunnel_add（suo5 / socks5 / ssh -R）；之后智能体用 redteam_sessions 就能看到。",
			"drill.d657": "已上线的可控入口",
			"drill.d658": "暂无（拿到 WebShell 后用 redteam_webshell_add 登记）",
			"drill.d659": "内网隧道",
			"drill.d660": "可直接给扫描器当代理用",
			"drill.d661": "暂无（建好隧道后用 redteam_tunnel_add 登记）",
			"drill.d662": "[redteam-ui] 页面渲染出错:",
			"drill.d663": "该页面渲染出错：",
			"drill.d664": "回到资产测绘",
			"drill.d665": "作战智能体",
			"drill.d666": "并发上限 ",
			"drill.d667": "占用未知",
			"drill.d668": "在跑 ",
			"drill.d669": " / 剩余 ",
			"drill.d670": "并发规则（硬约束）",
			"drill.d671": "· 同一靶标**同时最多 ",
			"drill.d672": " 个执行智能体**；主会话派活前用 `redteam_agent_slot` 占位，满了直接拒绝。",
			"drill.d673": "· **默认一个一个派、按顺序推进**；只有确实互不依赖的活才并行。",
			"drill.d674": "· 每个会话有**自己的靶标绑定**：多会话并行不会把报告写串（子智能体继承父会话的靶标）。",
			"drill.d675": "六个角色",
			"drill.d676": "① 信息收集 `recon` —— 只收集资产，把单位资产收集完整（含边缘与未备案资产）",
			"drill.d677": "② 资产梳理 `assess` —— 一条一条过，评易打性并全部落库",
			"drill.d678": "③ 漏洞发现 `vuln-scan` —— 先查库去重 → Nday/1day 优先 → 接口未授权探测",
			"drill.d679": "④ 漏洞利用 `exploit` —— 先拿服务器权限（冰蝎/哥斯拉马）+ 建 suo5 隧道，再打其它得分项",
			"drill.d680": "⑤ 内网渗透 `internal` —— 走隧道，依次拉起 ①②③④ 做内网",
			"drill.d681": "⑥ 主会话 `plan` —— 只做计划、派活、汇总、汇报，不动手",
			"drill.d682": "角色提示词（按靶标存，可在这里编辑）",
			"drill.d683": "「智能体提示词」已并入本页；下面是完整编辑器（改完点保存，只影响当前靶标）。",
			"drill.d684": "面板中设置",
			"drill.d685": "默认值",
			"drill.d686": "已保存：并发上限 ",
			"drill.d687": "（立即生效，不用重启）",
			"drill.d688": "并发数量",
			"drill.d689": "同一靶标**同时最多几个执行智能体**。当前生效：**",
			"drill.d690": "（在跑 ",
			"drill.d691": "，剩余 ",
			"drill.d692": "，来源：",
			"drill.d693": "。改完**立即生效**，不用重启。",
			"drill.d694": "范围 1 – ",
			"drill.d695": "注意：调大不等于更快：**同一个模型 API Key 的并发/速率上限是共享的**，同时派太多会互相挤占，",
			"drill.d696": "表现为排队等待、超时、返回被截断甚至限流报错 —— 反而让测试结果不稳定（漏测、半途而废）。",
			"drill.d697": "建议从 2–3 开始，只有在确认 Key 的额度足够、任务之间确实互不依赖时才调大。",
			"drill.d698": "检查更新失败",
			"drill.d699": "已安装 ",
			"drill.d700": "，正在重启当前宿主…",
			"drill.d701": "当前版本 ",
			"drill.d702": "\\n最新版本 ",
			"drill.d703": "\\n检查失败：",
			"drill.d704": "发现新版本 ",
			"drill.d705": "：点击查看并一键更新（会重启当前宿主）",
			"drill.d706": "有新版本 v",
			"drill.d707": "重新检查 npm 上的最新版本",
			"drill.d708": "检查更新",
			"drill.d709": "更新 RedTeam 模式",
			"drill.d710": "当前版本",
			"drill.d711": "最新版本",
			"drill.d712": "安装方式",
			"drill.d713": "包安装（",
			"drill.d714": "安装位置",
			"drill.d715": "现在不能更新：",
			"drill.d716": "更新过程：安装新版本 → 自动重启当前宿主（官方 exe / 社区版 / dsh web；当前页面会断开，约 5–10 秒后自动刷新）。",
			"drill.d717": "重启前会检查有没有智能体在跑，有就拦住不动。",
			"drill.d718": "宿主正在重启，",
			"drill.d719": " 秒后自动刷新页面…",
			"drill.d720": "关闭",
			"drill.d721": "安装并重启",
			"drill.d722": "一键更新并重启",
			"drill.d723": "无法连接资产库",
			"drill.d724": "创建失败",
			"drill.d725": "无法打开新窗口：",
			"drill.d726": "还没有靶标",
			"drill.d727": "输入攻防演练靶标单位名称，创建演练并开始资产测绘。",
			"drill.d728": "例如：示例科技有限公司",
			"drill.d729": "创建靶标",
			"drill.d730": "未知页签",
			"drill.d731": "拖动调整宽度",
			"drill.d732": "拖动调整高度",
			"drill.d733": "拖动调整大小",
			"drill.d734": "按住拖动面板",
			"drill.d735": "演练台",
			"drill.d736": "独立窗口",
			"drill.d737": "暂无靶标",
			"drill.d738": "未命名",
			"drill.d739": "回到带侧栏的普通界面（或按 Esc）",
			"drill.d740": "退出全面浏览",
			"drill.d741": "刷新名册、快照与当前页面数据",
			"drill.d742": "在新浏览器窗口打开完整演练台",
			"drill.d743": "全面浏览",
			"drill.d744": "收起面板",
			"drill.d745": "收起",
			"drill.d746": "有新内容",
			"drill.d747": "C 段 ",
			"drill.d748": "（存活 ",
			"drill.d749": "指纹 ",
			"drill.d750": "被动/主动 ",
			"drill.d751": "按 Esc 或点右上角「退出全面浏览」回到带侧栏的界面",
			"drill.d752": "演练台（常驻右侧栏）",
			"drill.d753": "全面浏览：在新窗口打开完整演练台（当前窗口不受影响；新窗口内按 Esc 退出）",
			"drill.d754": "<h3>严正法律免责与合规使用声明</h3>\\r\\n    <p>本声明在进入演练台前必须全文阅读。本项目是非营利开源项目，遵守国家法律法规及所在平台的规范，仅供学习与研究、技术参考。严禁任何主体把本项目用于商业售卖、付费倒卖或黑灰产牟利。</p>\\r\\n    <p>开发者坚决反对并严禁任何形式的违法犯罪，绝不支持、不鼓励、不协助未授权网络攻击、漏洞利用、数据窃取、非法侵入计算机信息系统，或生成违法违禁内容。任何将本项目用于违法犯罪的行为，均与开发者无关，由行为人依法独立承担全部法律责任。不得以科研、教学、测试、演示或内部学习为由规避下列条款。</p>\\r\\n    <h3>1. 本仓库不含违法内容</h3>\\r\\n    <p>dsh-purge 发布的代码、文档、补丁与默认提示词不是木马、后门、未授权渗透工具、勒索软件、撞库脚本，也不是针对公网或第三方系统的攻击载荷。项目不提供违法内容，也不教唆、组织、协助实施违法犯罪。</p>\\r\\n    <h3>2. 本机操作不构成对外授权</h3>\\r\\n    <p>应用补丁、写入、回滚、卸载，都在本机文件和本机进程内完成。这些操作不对任何公网主机或未授权系统进行扫描、探测、入侵或攻击发包，也不得把本机当作跳板。</p>\\r\\n    <p>插件若开启检测更新，仅可能访问本插件自己的 GitHub 仓库以核对版本。该访问与对第三方系统的网络攻击无关，不能被解释为对外渗透的授权。</p>\\r\\n    <h3>3. 允许使用的范围</h3>\\r\\n    <p>只允许用在你能证明有权处理的环境：本人有权管理的本机官方 Harness；离线的本地合成靶标；所有者已经出具合法书面授权的网络安全演练靶场；合规实验室里的受控环境。书面授权要能对应具体目标、时间和范围。只填写一个单位名称，或只有口头说法，不构成授权。</p>\\r\\n    <p>未经所有者合法书面授权的目标、公网在线系统、生产业务，以及能源、交通、水利、金融、公共服务、电子政务等关键信息基础设施，都不得作为演练对象。</p>\\r\\n    <h3>4. 必须遵守的法律，按条、款</h3>\\r\\n    <p>《中华人民共和国刑法》第二百八十五条第一款：禁止违反国家规定，侵入国家事务、国防建设、尖端科学技术领域的计算机信息系统。</p>\\r\\n    <p>同条第二款：禁止侵入前款规定以外的计算机信息系统，或者用其他技术手段，获取该系统中存储、处理或者传输的数据，或者对该系统实施非法控制。</p>\\r\\n    <p>同条第三款：禁止提供专门用于侵入、非法控制计算机信息系统的程序、工具；明知他人实施侵入、非法控制而为其提供程序、工具，同样禁止。</p>\\r\\n    <p>第二百八十六条第一款：禁止对计算机信息系统功能进行删除、修改、增加、干扰，造成系统不能正常运行。</p>\\r\\n    <p>同条第二款：禁止对系统中存储、处理或者传输的数据和应用程序进行删除、修改、增加。</p>\\r\\n    <p>同条第三款：禁止故意制作、传播计算机病毒等破坏性程序，影响计算机系统正常运行。</p>\\r\\n    <p>第二百八十七条：禁止利用计算机实施金融诈骗、盗窃、贪污、挪用公款、窃取国家秘密或者其他犯罪。</p>\\r\\n    <p>第二百八十七条之一第一款第（一）项：禁止设立用于实施诈骗、传授犯罪方法、制作或者销售违禁物品、管制物品等违法犯罪活动的网站、通讯群组。</p>\\r\\n    <p>同款第（二）项：禁止发布有关制作或者销售毒品、枪支、淫秽物品等违禁物品、管制物品或者其他违法犯罪的信息。</p>\\r\\n    <p>同款第（三）项：禁止为实施诈骗等违法犯罪活动发布信息。</p>\\r\\n    <p>第二百八十七条之二：禁止明知他人利用信息网络实施犯罪，仍为其提供技术支持，或者提供广告推广、支付结算等帮助。</p>\\r\\n    <p>第二百五十三条之一第一款、第三款：禁止向他人出售或者提供公民个人信息；禁止窃取或者以其他方法非法获取公民个人信息。</p>\\r\\n    <p>《中华人民共和国网络安全法》第十三条第二款：使用网络不得危害网络安全，不得利用网络从事危害国家安全、荣誉和利益，煽动颠覆国家政权、推翻社会主义制度，煽动分裂国家、破坏国家统一，宣扬恐怖主义、极端主义，宣扬民族仇恨、民族歧视，传播暴力、淫秽色情信息，编造、传播虚假信息扰乱经济秩序和社会秩序，以及侵害他人名誉、隐私、知识产权和其他合法权益等活动。</p>\\r\\n    <p>第十四条：禁止利用网络从事危害未成年人身心健康的活动。</p>\\r\\n    <p>第二十九条：禁止非法侵入他人网络、干扰他人网络正常功能、窃取网络数据；禁止提供专门用于侵入网络、干扰网络正常功能及防护措施、窃取网络数据的程序、工具；明知他人从事危害网络安全的活动，禁止为其提供技术支持、广告推广、支付结算等帮助。</p>\\r\\n    <p>第三十三条：公共通信和信息服务、能源、交通、水利、金融、公共服务、电子政务等关键信息基础设施实行重点保护。未获合法授权，不得侵入、干扰或破坏。</p>\\r\\n    <p>第四十六条：禁止窃取或者以其他非法方式获取个人信息，禁止非法出售或者非法向他人提供个人信息。</p>\\r\\n    <p>第四十八条：禁止设立用于实施诈骗，传授犯罪方法，制作或者销售违禁物品、管制物品等违法犯罪活动的网站、通讯群组；禁止利用网络发布涉及上述违法犯罪活动的信息。</p>\\r\\n    <p>第五十条：发送的电子信息、提供的应用软件不得设置恶意程序，不得含有法律、行政法规禁止发布或者传输的信息。</p>\\r\\n    <p>《中华人民共和国数据安全法》第八条：开展数据处理活动，不得危害国家安全、公共利益，不得损害个人、组织的合法权益。</p>\\r\\n    <p>第三十二条第一款：收集数据应当采取合法、正当的方式，不得窃取或者以其他非法方式获取数据。</p>\\r\\n    <p>同条第二款：法律、行政法规对收集、使用数据的目的和范围有规定的，只能在该目的和范围内收集、使用。</p>\\r\\n    <p>第五十一条：窃取或者以其他非法方式获取数据，或者因此损害个人、组织合法权益的，依照有关法律、行政法规处罚。</p>\\r\\n    <p>《中华人民共和国个人信息保护法》第五条：处理个人信息应当合法、正当、必要、诚信，不得通过误导、欺诈、胁迫等方式处理。</p>\\r\\n    <p>第六条第一款、第二款：处理个人信息应当具有明确、合理的目的，并与该目的直接相关，采取对个人权益影响最小的方式；收集限于实现处理目的的最小范围，不得过度收集。</p>\\r\\n    <p>第十条：禁止非法收集、使用、加工、传输他人个人信息，禁止非法买卖、提供或者公开他人个人信息；禁止从事危害国家安全、公共利益的个人信息处理活动。</p>\\r\\n    <p>第十三条：没有取得个人同意，也不属于订立履行合同所必需、履行法定职责、应对突发、公共利益新闻舆论、处理本人已经合法公开的信息，以及法律行政法规规定的其他情形之一的，不得处理个人信息。</p>\\r\\n    <p>第二十八条、第二十九条：生物识别、医疗健康、金融账户、行踪轨迹，以及不满十四周岁未成年人的个人信息，属于敏感个人信息。没有特定目的、充分必要性和严格保护措施，并且没有取得个人单独同意的，不得处理。</p>\\r\\n    <p>此外还须遵守其他现行有效的法律、行政法规、监管规定，以及所使用模型的服务条款与滥用政策。</p>\\r\\n    <h3>5. 据此禁止的方向</h3>\\r\\n    <p>未授权进入。禁止把没有书面授权的单位、域名、地址、公网系统、生产业务或关键信息基础设施登记为靶标，禁止对其扫描、探测、侵入、控制或发包。对应刑法第二百八十五条第一款、第二款，网络安全法第二十九条、第三十三条。</p>\\r\\n    <p>破坏与恶意程序。禁止删除、修改、增加、干扰他人系统功能或其中的数据、应用程序；禁止制作、传播病毒、勒索程序或其他破坏性程序；禁止在信息或软件中设置恶意程序。对应刑法第二百八十六条第一款至第三款，网络安全法第五十条。</p>\\r\\n    <p>工具与帮助。禁止把本项目或本机提供给他人，用于侵入、非法控制或窃取数据；禁止明知对方在实施网络犯罪，仍提供程序、工具、技术支持、广告推广或支付结算。对应刑法第二百八十五条第三款、第二百八十七条之二，网络安全法第二十九条。</p>\\r\\n    <p>数据。禁止窃取、非法收集、超范围使用、泄露、出售或向他人提供业务数据、账号、口令和其他受保护数据。对应数据安全法第八条、第三十二条、第五十一条。</p>\\r\\n    <p>个人信息。禁止非法收集、使用、加工、传输、买卖、提供或公开他人个人信息；禁止过度收集；禁止以误导、欺诈、胁迫方式处理；禁止擅自处理生物识别、医疗健康、金融账户、行踪轨迹和儿童个人信息。对应刑法第二百五十三条之一第一款、第三款，网络安全法第四十六条，个人信息保护法第五条、第六条、第十条、第十三条、第二十八条、第二十九条。</p>\\r\\n    <p>诈骗与违法信息。禁止设立或利用网站、群组实施诈骗、传授犯罪方法、制作或销售违禁物品、管制物品；禁止发布此类信息；禁止利用计算机实施诈骗、盗窃、贪污、挪用公款、窃取国家秘密。对应刑法第二百八十七条、第二百八十七条之一第一款第（一）项至第（三）项，网络安全法第四十八条。</p>\\r\\n    <p>内容。禁止生成或传播危害国家安全、荣誉和利益的内容，禁止煽动颠覆、分裂，禁止恐怖主义、极端主义、民族仇恨，禁止暴力、淫秽色情、赌博，禁止编造虚假信息扰乱经济秩序和社会秩序，禁止侵害名誉、隐私、知识产权，禁止危害未成年人身心健康的内容。对应网络安全法第十三条第二款、第十四条。</p>\\r\\n    <p>结果扩散。演练中形成的记录、资产信息和文件，只留在书面授权写明的目标和期限里，不得交给无权获知的人，也不得改作授权以外的用途。</p>\\r\\n    <h3>6. 责任由使用者承担</h3>\\r\\n    <p>本项目依据 MIT 协议按现状提供。开发者不就完整性、安全性与适用性作保证。使用者对自己的下载、部署、运行、修改、传播，以及全部输入与输出，承担独立、完全的民事、行政及刑事法律责任。作者与贡献者不承担因滥用产生的直接、间接或连带责任。</p>\\r\\n    <p>勾选确认的是操作者本人，不能代替没有阅读本声明的人，也不能把别人的系统说成已经授权。</p>\\r\\n    <h3>7. 违约即终止授权</h3>\\r\\n    <p>一旦用于非法攻击、恶意活动或上述任一禁止方向，使用许可自该行为发生之日起自动终止，且不可撤销。必须立即停止使用，并销毁本项目的代码、脚本与衍生数据，依法承担责任。授权终止后，演练台不得继续打开或继续使用。</p>\\r\\n    <h3>8. 与 DeepSeek 官方的关系</h3>\\r\\n    <p>本项目是独立的开源项目，与 DeepSeek 官方或其关联主体没有隶属、商业合作、授权或官方背书。文中的「官方」只表示评测对象是使用者本机安装的官方 DeepSeek Harness 软件包，不代表 DeepSeek 官方开发、认可或担保本插件。</p>\\r\\n    <p>文末。倒计时结束、滚到这里并勾选全部三项，才表示你以本人身份认可本声明，并完成本次演练台授权。</p>",
			"drill.d756": "无法打开回退后的会话",
			"drill.d757": "回退后的会话没有打开",
			"drill.d758": "回退上一步",
			"drill.d759": "撤回最后一步已进行的对话，新会话接上之前的上下文；那句回到输入框再发送",
			"drill.d760": "回退上一轮",
			"drill.d761": "撤回上一整轮（含子代理）已进行的对话，新会话接上之前的上下文；那句回到输入框再发送",
			"drill.d762": "没有清掉之前发送的内容",
			"drill.d763": "回退失败: ",
			"drill.d764": "回退",
			"drill.d765": "回退失败: {error}",
			"drill.d766": "回退中…",
			"drill.e20001": "连不上接口，请确认 dsh 还在跑后 Ctrl+F5",
			"drill.k30001": "　·　由当日记录生成（非现场截图）",
			"drill.k30002": " 张，取代表图）",
			"drill.k30003": "被动",
			"drill.k30004": "主动",
			"drill.k30005": "收起本组",
			"drill.k30006": "内网",
			"drill.k30007": "内",
			"drill.k30008": "存活",
			"drill.k30009": "未记录（开放端口见下）",
			"drill.k30010": "内网资产",
			"drill.k30011": "收起资产详情",
			"drill.k30012": "收起全部 ▲",
			"drill.k30013": "该 C 段下暂无域名（切换到「全部 C 段」看全量）",
			"drill.k30014": "该 C 段下暂无 Web 资产",
			"drill.k30015": " 端口",
			"drill.k30016": "保存中…",
			"drill.k30017": "可用",
			"drill.k30018": "不可用",
			"drill.k30019": "本插件自带",
			"drill.k30020": "刷新中…",
			"drill.k30021": "不可用（有明确缺口）",
			"drill.k30022": "未装上的外部工具",
			"drill.k30023": "缓存于 ",
			"drill.k30024": "原始报文",
			"drill.k30025": "（明文直显，注意屏幕分享/录屏）",
			"drill.k30026": "当前：按目标聚合（先看哪台被打下什么）",
			"drill.k30027": "按目标聚合",
			"drill.k30028": " 个文件没挂 vuln_id，建议补上以便与漏洞对应。",
			"drill.k30029": "（推断）",
			"drill.k30030": " 分",
			"drill.k30031": " 条只在自己 VPS/自建服务器上，不算突破）",
			"drill.k30032": "内 ",
			"drill.k30033": "加载中…",
			"drill.k30034": " · 注意：不算跨越靶标边界",
			"drill.k30035": "（按目标路径自动匹配，请核对）",
			"drill.k30036": "生成中…",
			"drill.k30037": "\\n…（已截断，完整内容见落盘文件）",
			"drill.k30038": "按归类分组",
			"drill.k30039": "检索中…",
			"drill.k30040": "，并识别 nuclei-templates",
			"drill.k30041": "读取中…",
			"drill.k30042": "扫描中…",
			"drill.k30043": "留空；需要时填私钥绝对路径",
			"drill.k30044": "留空；需要时填 user@host",
			"drill.k30045": " 分（各项独立，不跨项累加）",
			"drill.k30046": " 次命中",
			"drill.k30047": "启用",
			"drill.k30048": " 次自建不计分）",
			"drill.k30049": " 次同服务重复命中不计分）",
			"drill.k30050": "内置得分点的名称由规则锁定",
			"drill.k30051": "内置得分点的分类由规则锁定（决定它属于面板哪一组）",
			"drill.k30052": "内置得分点的条款正文由规则锁定",
			"drill.k30053": "收起",
			"drill.k30054": "实时 · 5s",
			"drill.k30055": "agent 正在打这些资产",
			"drill.k30056": "加密马（冰蝎/哥斯拉，用户可直连）",
			"drill.k30057": "已复制",
			"drill.k30058": "检测中…",
			"drill.k30059": "环境变量 REDTEAM_MAX_AGENTS",
			"drill.k30060": "\\n安装方式：开发态（源码软链）",
			"drill.k30061": "\\n安装方式：包安装",
			"drill.k30062": "检查中…",
			"drill.k30063": "开发态（源码软链）",
			"drill.k30064": "开发态安装请用仓库流程升级",
			"drill.k30065": "先解决上面的阻塞项",
			"drill.k30066": "更新中…",
			"drill.k30067": "资产测绘",
			"drill.k30068": "环境适配",
			"drill.k30069": "智能体",
			"drill.k30070": "会话隧道",
			"drill.k30071": "漏洞战果",
			"drill.k30072": "攻击链",
			"drill.k30073": "得分目标",
			"drill.k30074": "报告",
			"drill.k30075": "知识库",
			"drill.k30076": "技能库",
			"drill.k30077": "创建中…",
			"drill.k30078": "演练台 · 全面浏览",
			"drill.k30079": "选择靶标",
			"drill.k30080": "：有新内容，点开看过红点就会消失",
			"drill.k30081": "回退中…",
			"drill.k30082": "提示词",
			"drill.k30083": "代码",
			"drill.k30084": "工具",
			"drill.k30085": "0.1.5 兼容",
			"drill.k30086": "0.2.0 兼容",
			"status.active": "已生效",
			"status.needRestart": "需重载",
			"status.partial": "部分跳过",
			"status.waiting": "有待应用",
			/* 四种数：整页只在摘要出现一次（顶栏只说状态词，分节标题不挂数）。 */
			"counts.applied": "已生效",
			"counts.pending": "待应用",
			"counts.skipped": "按设计跳过",
			"counts.na": "不适用",
			"counts.failed": "失败",
			"counts.na.hint": "{n} 条不适用：本机宿主没有这些落点，分节里不展开",
			"counts.denominator.display": "共 {n} 个展示行（display 口径）",
			"counts.denominator.raw.label": "判据口径",
			"counts.denominator.raw": "按补丁号（raw）：不适用 {na} 条不进展示行",
			"btn.retry": "重试",
			"load.empty": "还没有可显示的内容",
			/* 结论句四档：失败 > 待应用 > 待重启 > 全部生效，参数都是数出来的。 */
			"conclusion.ok": "全部生效：{applied} 条已生效，{skipped} 条按设计跳过，{na} 条不适用",
			"conclusion.pending": "{pending} 条待应用 —— 已生效 {applied} · 按设计跳过 {skipped} · 不适用 {na}",
			"conclusion.restart": "改动已写入，重启宿主后生效 —— 已生效 {applied} · 按设计跳过 {skipped} · 不适用 {na}",
			"conclusion.failed": "{failed} 条失败 —— 已生效 {applied} · 待应用 {pending} · 按设计跳过 {skipped} · 不适用 {na}",
			/* 工程字段改人话：三处各一句，别把内部取值印给用户看。 */
			"plain.shim.label": "命令入口",
			"plain.shim.patched": "{patched} / {present} 个已接管，终端里的 dsh 走本插件",
			"plain.shim.original": "{present} 个文件还是原版，本插件没有接管 dsh 命令",
			"plain.shim.none": "没有找到 dsh 命令文件：这一版没装命令行入口",
			"plain.backup.label": "原始文件备份",
			"plain.backup.yes": "有，出问题能退回原版",
			"plain.backup.no": "还没有 —— 这一版还没应用过补丁",
			"plain.preset.registered": "已注册到宿主，重启后可用",
			"plain.preset.broken": "注册成功，但有一项被宿主忽略（{broken}）",
			"plain.preset.running": "正在注册…",
			"plain.preset.failed": "注册没成功，重启宿主会再试一次",
			"plain.preset.timeout": "等宿主超时，重启后会自动再试",
			"plain.preset.none": "还没有注册声明，重启宿主后会自动注册一次",
			/* 页签：左栏是宿主导航，加不了目录，所以目录只能长在页内 —— 一次只露一块内容。 */
			"tab.list.label": "设置页视图",
			"tab.status": "状态",
			"tab.patches": "补丁",
			"tab.config": "配置",
			"tab.skills": "技能",
			"tab.diagnostics": "诊断",
			"head.checkUpdate": "检测更新",
			"head.restart": "重启宿主",
			"overview.patches": "补丁",
			"overview.skipped": "跳过",
			"overview.backup": "备份",
			"overview.backup.yes": "有",
			"overview.backup.no": "无",
			"overview.lastApplied": "上次应用",
			"overview.never": "从未",
			"conclusion.ok": "全部生效，{n} 条按设计跳过",
			"conclusion.restart": "有改动待重启",
			"conclusion.failed": "{n} 条失败，展开补丁分节看原因",
			"foot.logs": "日志目录",
			"foot.config": "配置文件",
			"foot.runtime": "运行态：{rev} · {asar}",
			"foot.asar.sealed": "asar 未解包",
			"foot.asar.unpacked": "已解包",
			"skill.empty": "未加载到技能",
			"skill.empty.hint": "目录不存在或没有读权限",
			"policy.foot": "改动会自动应用；需要宿主重载的项会提示重启。",
			"section.patches": "补丁",
			"section.hooks": "Hooks 拦截",
			"section.policy": "审批策略与免责声明",
			"section.update": "版本与更新",
			"section.danger": "危险操作",
			"overview.asar": "宿主形态",
			"overview.backup.hint": "可回滚的原始文件",
			"overview.pending": "待写入 {n}",
			"patch.empty": "没有可显示的补丁",
			"patch.empty.hint": "未定位到宿主代码目录，或补丁表为空",
			"update.off": "更新已关闭：{reason}",
			"action.revert": "还原补丁",
			"action.revert.hint": "把宿主文件回滚到安装前的备份，插件本身保留。",
			"action.uninstall": "卸载插件",
			"action.uninstall.hint": "还原宿主并删除本插件的全部文件，不可撤销。",
			"uninstall.ack": "我了解这会还原宿主并删除本插件",
			"section.audit": "审计轨",
			"audit.hint": "只读：最近一轮的落点、结果与完整性对账。",
			"audit.lastRun": "最近一轮",
			"audit.lastRun.none": "还没有记录过 apply 轮次",
			"audit.events": "事件",
			"audit.layers": "层结论",
			"audit.check": "完整性",
			"audit.check.ok": "通过（{files} 份文件，断号 0、坏行 0）",
			"audit.check.bad": "有问题：断号 {gaps}、坏行 {badLines}",
			"audit.check.unavailable": "还没有可判的审计文件",
			"audit.files": "落点",
			"audit.run.ph": "runId，例如 apply-20261025T101548Z-10fe",
			"audit.run.btn": "查这一轮",
			"audit.refresh": "刷新",
			"audit.run.rows": "这一轮",
			"audit.run.counts": "审计 {audit} 行 · 诊断 {diag} 行",
			"audit.run.cross": "两轨对账",
			"audit.run.cross.value": "对上 {matched} / 共 {checked} 轮",
			"audit.run.cross.none": "无可对账的轮",
			"audit.cards": "失败卡",
			"audit.cards.none": "这一轮没有卡",
			"audit.run.missing": "没有这一轮：{runId}",
			"audit.tail.empty": "这台机器还没有审计记录",
			"audit.tail.empty.hint": "跑一次 /purge apply 之后会出现在这里",
			"audit.err": "读取失败：{error}",
			"section.health": "健康",
			"health.hint": "只读：安装指纹、副本一致性与预设注册。",
			"health.install": "安装指纹",
			"health.install.missing": "这台机器还没有安装指纹记录",
			"health.install.counts": "漂移 {drifted} · 缺失 {missing} · 新增 {added}",
			"health.copy": "副本指纹",
			"health.copy.same": "一致",
			"health.copy.unknown": "不可判：没有安装记录",
			"health.copy.diff": "不一致（{n} 处）",
			"health.preset": "预设注册",
			"health.preset.none": "没有注册声明",
			"section.logs": "日志",
			"logs.hint": "只读：三条轨的落点与保留代数。",
			"logs.track.audit": "审计轨",
			"logs.track.diag": "诊断轨",
			"logs.track.internal": "内部轨",
			"logs.rule.daily": "按天归档",
			"logs.rule.roll": "保留 {generations} 代 · 单文件 {size}",
			"logs.absent": "还没有落盘",
			"skills.library.official": "用户目录",
			"skills.library.redteam": "随包",
			"skills.shadowed": "同名遮蔽 {n}",
			"skills.readonly": "只读",
			"skills.filter.all": "全部",
			"skills.filter.empty": "这一库里没有技能",
			"drill.note": "注意",
			"drill.t40open": "打开知识库目录",
			"drill.t40skillsEmpty": "这个库里还没有技能。把技能目录放进知识库目录，刷新后就会出现在这里。",
			"drill.t40skillsFiltered": "当前筛选下没有技能：清掉筛选再看看。",
			"drill.t40clearFilter": "清除筛选",
		};

		const en = {
			nav: "Rules",
			"dock.clean": "Clean",
			"dock.drill": "Drill (experimental: records are demo-only, not results)",
			"drill.missing": "The drill panel did not load with the bundle; this note is all the main area can show for now.",
			"dock.toggle": "dsh-purge",
			"dock.newSession": "dsh-purge",
			"dock.inSession": "dsh-purge",
			"dock.redteam": "Red team",
			"dock.full": "Full view",
			"dock.close": "Collapse",
			"dock.unauthorized": "Unauthorized",
			"welcome.title": "User notice",
			"welcome.lead": "Please read this on first install. After you confirm, it will not appear again.",
			"welcome.warn": "This plugin is released under the MIT license and is free to use and modify. Do not use it for unauthorized attacks.",
			"welcome.body": "dsh-purge is a local DeepSeek Harness plugin for security evaluation and cleaning: adjust prompts and patches on a machine you control, and use the drill console only within authorized scope. It is free and non-profit. Repository:",
			"welcome.repo": "https://github.com/wufeng0105/dsh-purge-desktop",
			"welcome.ban1": "Do not use this project for unauthorized attacks, intrusion, data theft, sabotage, or any illegal activity.",
			"welcome.ban2": "Do not use this project for gray-market profit or any illegal activity.",
			"welcome.ban3": "You must follow local law and platform rules; illegal use is solely your responsibility.",
			"welcome.bans": "Prohibitions",
			"welcome.check": "I have read and understand this notice and will use the plugin lawfully.",
			"welcome.ok": "I understand — continue",
			"auth.title": "Drill console authorization",
			"auth.lead": "Cleaning does not need this step. Opening Drill or Full view the first time requires this dialog.",
			"auth.warn": "Warning: the drill console is only for hosts you manage, offline targets, or written authorized exercises. Unauthorized intrusion, attack, theft, or sabotage is forbidden.",
			"auth.hint.wait": "Read the notice. You can check the boxes in {n}s.",
			"auth.hint.scroll": "Countdown finished. Scroll to the end, then check the boxes.",
			"auth.hint.check": "Countdown finished. Check all three boxes.",
			"auth.check.read": "I have read the Safety and Anti-Abuse Notice and accept every clause.",
			"auth.check.scope": "I will only use authorized local hosts, offline targets, or compliant exercises.",
			"auth.check.ban": "I will not use this for any illegal purpose. Without this authorization the drill console stays closed.",
			"auth.no": "Not now",
			"auth.ok": "Authorize",
			"auth.ok.tab": "Authorize and open Drill",
			"auth.ok.full": "Authorize and open Full view",
			"auth.ok.env": "Authorize and open Env adapt",
			"envGate.title": "Environment is not ready",
			"envGate.lead": "Red team mode needs local tools before you send. If none are available, open Env adapt or confirm you will continue without them.",
			"envGate.kaliHint": "When Kali is detected, local tools are used directly and paths are optional. Otherwise set each tool path in Env adapt, or pick one toolkit folder to assign them.",
			"envGate.skip": "Skip for now",
			"envGate.skipConfirm": "You can keep chatting after this. Scan and exploit skills stay unavailable until the tools are installed. You can add paths later under dsh-purge → Env adapt.",
			"envGate.skipNo": "Back",
			"envGate.skipYes": "Continue without tools",
			"envGate.go": "Open Env adapt",
			"theme.aria": "Appearance",
			"theme.white": "Light",
			"theme.ink": "Ink",
			"purge.title": "Patches",
			"override.title": "Prompt",
			"own.title": "Own servers",
			"own.hint": "One IP or exact hostname per line. account@host is accepted; the account only identifies that host. A hostname also allows the addresses it resolves to. Do not enter a key, a password, or a range.",
			"own.save": "Save list",
			"saved.own": "Own servers saved",
			"saved.own.dropped": "Saved. {n} lines were not a single IP or hostname and were dropped",
			"metric.purged": "Written",
			"metric.purged.skip": "Written. Skipped {n}; those files are not on this install",
			"metric.pendingShort": "Pending {n}",
			"metric.unmatchedShort": "No match {n}",
			"metric.skipShort": "Skipped {n}",
			"metric.unlocated.count": "—",
			"metric.shim": "shim",
			"metric.shim.na": "Not needed here",
			"metric.bak.yes": "Backup",
			"metric.bak.no": "No backup",
			"metric.bak.hint": "Backup",
			"table.patch": "Item",
			"table.status": "Status",
			"status.applied": "Applied",
			"status.off": "Off",
			"status.pending": "Pending",
			"status.unmatched": "No match",
			"status.skipped": "Skipped",
			"warn.noRoot": "Could not find this host’s @deepseek-ai tree, so Apply will not patch anything. Fully quit and reopen this host, then Apply here. Desktop may live on any drive; folder names like DeepseekHarnessDesktop or DeepSeek Harness are fine.",
			"warn.noRoot.desktop": "Official Harness keeps its code in app.asar. Apply unpacks it and restarts the app. If this page stays “not found”, fully quit the client, reopen it, then Apply again. Third-party DSH Desktop: just Apply.",
			"unpack.restarting": "Patches are written. Click Restart and the client opens again by itself.",
			"restart.fullQuit": "Restarting. The client will open again by itself.",
			"warn.noInject": "Official mode always uses the default prompt. Red team uses only the active rule set; otherwise it uses the default prompt without the CTF section, then the red team steps. If both are empty you will be asked to add a prompt.",
			"need.prompt": "Both the prompt and the rule set are empty. Add a prompt, or enable a rule that has content.",
			"btn.restoreInject": "Reset default",
			"saved.restoreInject": "Default prompt restored",
			"skip": "Skipped",
			"unknown": "Unknown",
			"delete": "Delete",
			"btn.revert": "Restore",
			"btn.uninstall": "Uninstall",
			"btn.uninstall.busy": "Uninstalling…",
			"uninstall.title": "Uninstall dsh-purge",
			"uninstall.body": "Uninstall? This restores the original Harness and removes this plugin completely.",
			"uninstall.confirm": "Uninstall",
			"uninstall.cancel": "Cancel",
			"uninstall.applying": "Uninstalling and restoring…",
			"uninstall.done": "Uninstalled and restored. Restarting…",
			"uninstall.done.desktop": "Uninstalled and restored. Restarting the desktop app…",
			"uninstall.fail": "Uninstall failed: {error}",
			"btn.checkUpdate": "Check update",
			"btn.checkUpdate.busy": "Checking…",
			"btn.doUpdate": "Update",
			"btn.doUpdate.busy": "Updating…",
			"channel.title": "Channel",
			"channel.stable": "Stable",
			"channel.beta": "Beta",
			"channel.useStable": "Switch to stable",
			"channel.useBeta": "Switch to beta",
			"channel.local": "This copy",
			"update.checking": "Checking for updates…",
			"update.applying": "Updating…",
			"update.switching": "Switching version…",
			"update.latest": "Up to date ({version})",
			"update.available": "Update {remote} available (now {local})",
			"update.pinned": "Pinned at {version}; channel latest is {remote}",
			"update.done": "Updated to {version}.",
			"update.restarting": "Restored the old patches, wrote the new ones, and restarting…",
			"update.fullQuit": "Patches are written. Click Restart and the client opens again by itself.",
			"restart.official.title": "Restart required",
			"restart.official.body": "Patches are written. Click Restart and the client opens again by itself.",
			"update.switched": "Switched to {version}.",
			"update.autoDone": "Auto-updated to {version}.",
			"update.reloading": "Refreshing settings…",
			"update.dirty": "Update available; local edits were not overwritten.",
			"update.fail": "Update failed: {error}",
			"update.timeout": "Check timed out. Click Check update again.",
			"update.needRestart": "Update API is not loaded. Restart dsh, then check again.",
			"update.noBeta": "No beta build yet",
			"update.switch": "Switch to this version",
			"update.pick": "Select version",
			"update.tip": "latest",
			"update.current": "current",
			"update.confirmSwitch": "Switch to {version}? You can switch back later. Uncommitted plugin edits will not be kept.",
			"update.confirmChannel": "Switch to {version}? The plugin will be reinstalled from that channel. Uncommitted plugin edits will not be kept.",
			"metric.version": "Version",
			"action.apply": "Apply",
			"action.revert": "Restore",
			"action.uninstall": "Uninstall",
			"ok.done": "Done",
			"err.action": "Failed: {error}",
			"err.status": "Read failed: {error}",
			"err.override": "Read failed: {error}",
			"err.rules": "Read failed: {error}",
			"err.read": "Read failed: {error}",
			"err.save": "Save failed: {error}",
			"btn.saveInject": "Save",
			"saved.override": "Saved",
			"rules.title": "Rule sets",
			"rules.none": "None",
			"rules.reset": "Restore",
			"rules.reset.confirm": "Restore global instruction files? The rule library is kept.",
			"rules.empty": "No rules",
			"rules.pick": "Select a rule",
			"policy.title": "Workspace policy",
			"policy.strict": "Strict",
			"policy.fallback": "Fallback",
			"policy.always": "Always on",
			"policy.hint": "Strict: always strip AGENTS.md / CLAUDE.md. Fallback: use workspace files only when the prompt box is empty. Always on: keep DSH default behavior.",
			"cwd.title": "Local rules (current folder)",
			"cwd.empty": "No AGENTS.md / CLAUDE.md in this folder",
			"cwd.rescan": "Rescan",
			"cwd.hint": "Checked files are injected only when the prompt box is empty. A non-empty prompt box always wins.",
			"cwd.scope.cwd": "cwd",
			"cwd.scope.ancestor": "ancestor",
			"cwd.scope.root": "project root",
			"cwd.no.workspace": "DSH has not opened a workspace yet. Start a task in DSH first, then come back.",
			"pill.current": "On",
			"btn.use": "Enable",
			"btn.inUse": "On",
			"confirm.delete": "Delete {id}?",
			"ph.id": "id",
			"ph.alias": "Name",
			"ph.alias.short": "Name",
			"btn.create": "New",
			"need.id": "id required",
			"ph.content": "",
			"btn.saveRule": "Save",
			"skills.title": "Skills",
			"skills.hint": "After import, DSH calls it: type /name in chat to load now; the model calls the skill tool when the task matches description or whenToUse. Writing「激活」in the body does nothing.",
			"skills.hint.desktop": "This desktop host’s official skill catalog. Type /name in chat to load; the model calls the skill tool when the task matches the description.",
			"skills.empty": "No user skills",
			"btn.importZip": "Import zip",
			"btn.importFolder": "Import folder",
			"skills.importing": "Importing…",
			"saved.import": "Imported {count} skill(s)",
			"need.import": "Choose a zip or folder",
			"err.import.folder": "No files were read. Select the skill folder itself (it must contain SKILL.md).",
			"skills.pick": "Select a skill",
			"skills.invalid": "Official catalog will ignore this: invalid format",
			"skills.call.slash": "Type {cmd} in chat",
			"skills.call.model": "Model can load",
			"skills.call.modelOff": "Hidden from model",
			"skills.call.userOff": "/name disabled",
			"ph.skill.desc": "description (when to use)",
			"btn.saveSkill": "Save",
			"need.skill.id": "id must be kebab-case, e.g. code-review",
			"confirm.delete.skill": "Delete {id} from official $DSH_HOME/skills? The host will drop it from the catalog.",
			"err.skills": "Read failed: {error}",
			"err.skills.needRestart": "Skill API is not loaded. Restart this host first.",
			"btn.restart": "Restart",
			"btn.restart.busy": "Restarting…",
			"restarting": "Restarting…",
			"restarting.desktop": "Restarting the desktop app…",
			"restart.timeout": "Timed out; refresh",
			"restart.fail": "Failed: {error}",
			"restart.notStarted": "Restart did not start. This client is still open, and it will not try again by itself.",
			"restart.already": "This restart already started. It will not restart again.",
			"restart.confirm": "Apply finished. Restart to take effect.",
			"restart.confirm.desktop": "Apply finished. Restart the desktop app to take effect.",
			"restart.ask.title": "Restart now?",
			"restart.ask.body": "It is written. It takes effect in this client after a restart.",
			"restart.now": "Restart now",
			"restart.notNow": "Later",
			"restart.asarSwap": "Patches are on disk. Quitting the desktop app and moving app.asar aside; it will reopen when done. If behavior is unchanged, fully quit Harness (including tray) and Apply again.",
			"surface.web": "Web",
			"surface.desktop": "Desktop",
			"surface.gui": "GUI",
			"surface.tui": "TUI",
			"restart.incomplete": "The prompt is in. {detail}",
			"restart.incomplete.patches": "{failed} code patch(es) did not match this host (#{ids}). The prompt is unaffected",
			"restart.incomplete.flash": "CMD silence not pinned ({entry})",
			"restart.later": "Later",
			"group.prompt": "Prompt",
			"group.code": "Code",
			"group.engine": "Engine",
			"group.tools": "Tools",
			"group.compat": "0.1.5 compat",
			"group.dsh20": "0.2.0",
			"patch.1": "Global disclaimer → mandate",
			"patch.2": "Replacement disclaimer → mandate",
			"patch.3": "Scope disclaimer → mandate",
			"patch.4": "Persona session mandate",
			"patch.5": "Approval copy → full access",
			"patch.6": "Sandbox deny → allow write",
			"patch.7": "Sandbox default full access",
			"patch.8": "Approval default never",
			"patch.9": "Approval gate auto-grant",
			"patch.10": "Approval config default never",
			"patch.11": "never copy → auto-grant",
			"patch.12": "ask copy → auto-grant",
			"patch.13": "Escalation ladder exempt",
			"patch.14": "Escalation unconditional grant",
			"patch.15": "Sandbox confine passthrough",
			"patch.16": "Filesystem fence off",
			"patch.17": "Observation policy allow R/W",
			"patch.18": "Repeat-call guard off",
			"patch.19": "Tool-result pruner off",
			"patch.21": "Restore plugin-raised bash wait",
			"patch.22": "read cap raised",
			"patch.23": "subagent depth 3 → 10",
			"patch.24": "preset fetch on",
			"patch.25": "Strip official default identity (keep feature prompts)",
			"patch.26": "minimal: strip identity, open inject",
			"patch.70": "Minimal shell drops the no-network line",
			"patch.29": "dsh-tool-web: untrusted framing → usable data",
			"patch.30": "dsh-hooks-claude-code: deny→allow",
			"patch.31": "dsh-hooks-codex: deny→allow",
			"patch.32": "Web surface identity neutral",
			"patch.33": "Shell denial prompt → executable",
			"patch.34": "Sandbox hint neutralized",
			"patch.35": "Escalation never-reject",
			"patch.36": "FS escalation schema opened",
			"patch.37": "Subagent scope lock neutralized",
			"patch.39": "session v0 plugin summary (mnemon)",
			"patch.40": "Keep inject when a complete prompt is set",
			"patch.42": "Settings legacy API",
			"patch.43": "Strip identity from web presets",
			"patch.46": "Official update script stays ASCII",
			"patch.47": "OAuth no longer inserts Claude identity",
			"patch.48": "Shell drops extra delete caution",
			"patch.49": "OAuth no longer mimics claude-cli",
			"patch.50": "Session references are not marked untrusted",
			"patch.51": "Fresh session stays on full access",
			"patch.52": "Session log upload off by default",
			"patch.53": "Web prompt drops do-not-start",
			"patch.54": "Deliverable prompt drops extra prohibition",
			"patch.55": "Replace the first system prompt every step",
			"patch.56": "Rewind hides only the cut range",
			"patch.57": "developer role for openai/azure only, third-party gateways use system",
			"patch.58": "Rewind markers stay off the model request",
			"patch.59": "Official Auto Review no longer denies tools",
			"patch.60": "Official run_code drops approval teaching",
			"patch.61": "Official sandbox policy no longer teaches refusal",
			"patch.62": "Fail-open without approval channel (user reject kept)",
			"patch.63": "Plan mode no longer soft-blocks execution",
			"patch.64": "Stop hook no longer steers fake user text",
			"patch.65": "UserPromptSubmit deny no longer rejects turn",
			"patch.66": "Empty system section no longer ends the turn as an internal error",
			"patch.67": "A missing messages list no longer ends the turn",
			"patch.68": "Missing content after rewind no longer ends the turn",
			"patch.69": "deepseek-flash keeps the official in-history flag",
			"patch.72": "Messages system field uses the current system prompt",
			"patch.73": "Minimal preset drops stray mirror sentence",
			"patch.74": "Start/apply writes the default prompt to prompt-inject.md",
			"patch.75": "Rewind resets completed todos to pending",
			"patch.76": "Unrestricted preset: strip identity sentence",
			"patch.77": "Rewind marker drops already-sent messages",
			"patch.78": "Restore missing overlay from .bak backup",
			"patch.80": "Restore official minimal tool plugins",
			"patch.82": "Fallback DSH_PROFILE=desktop in main process",
			"patch.83": "Don't fail on signal kill (no crash dialog)",
			"patch.84": "Don't fail on code=0 clean exit (no stopped dialog)",
			"patch.85": "prompt() steer stays interrupt, not followup",
			"patch.86": "Queue steer stays steer; public steer() stays next-step",
			"patch.87": "First assemble uses the systemPrompt prepare returned",
			"patch.88": "Drop the hang after renderPrompt; inject is assemble only",
			"status.na": "Not for this host",
			"metric.sealed": "Official client found. Apply to unpack",
			"metric.sealed.count": "Sealed",
			"metric.lost": "Patches lost — Apply again",
			"metric.lost.count": "Lost",
			"status.unlocated": "Not located",
			"metric.unlocated": "This install was not found yet",
			"rewind.label": "Undo",
			"rewind.aria": "Undo",
			"rewind.busy": "Undoing…",
			"rewind.empty": "Nothing to undo",
			"rewind.fail": "Undo failed: {error}",
			"rewind.once": "Undo last step",
					"rewind.once.hint": "Withdraw the last step into a new session that keeps earlier context; the line returns to the box",
			"rewind.round": "Undo last turn",
					"rewind.round.hint": "Withdraw the last turn (and its subagents) into a new session that keeps earlier context; the line returns to the box",
			"hooksDeny.title": "Hook interception",
			"hooksDeny.bypass": "Bypass hook deny / ask (patches 30 / 31 / 64 / 65)",
			"hooksDeny.hint": "When off, your own PreToolUse / UserPromptSubmit / Stop hook deny runs as the official host wrote it. The official ask branch is a no-op; turning this off will not show an approval dialog. Click Apply and restart to write the host files.",
			"saved.hooksDeny": "Saved",
			"continue.title": "Retry / Continue",
			"continue.hint": "Failed requests auto-retry. After an abnormal stop or interrupt, use Continue or auto-resume. A manual stop never auto-continues. Counts reset after a completed turn.",
			"continue.autoRetry": "Auto-retry on failure",
			"continue.retryMax": "Retry count",
			"continue.autoContinue": "Auto-continue after interrupt",
			"continue.continueMax": "Continue count",
			"continue.text": "Continue text",
			"saved.continue": "Saved",
			"continue.label": "Continue",
			"continue.aria": "Continue after an abnormal stop",
			"continue.busy": "Continuing…",
			"continue.ready": "Continue ({left} left)",
			"continue.limit": "Continue limit reached",
			"continue.fail": "Continue failed: {error}",
			"drill.d1": "扁",
			"drill.d2": "属于上面那个头",
			"drill.d3": "远程命令执行",
			"drill.d4": "反序列化",
			"drill.d5": "文件上传 getshell",
			"drill.d6": "SQL 注入",
			"drill.d7": "未授权访问",
			"drill.d8": "认证绕过 / 越权",
			"drill.d9": "弱口令 / 爆破",
			"drill.d10": "目录穿越 / 任意文件读",
			"drill.d11": "信息泄露",
			"drill.d12": "提权 / 横向",
			"drill.d13": "隧道 / 代理",
			"drill.d14": "其它",
			"drill.d15": "主会话（指挥）",
			"drill.d16": "信息收集",
			"drill.d17": "资产梳理",
			"drill.d18": "漏洞发现",
			"drill.d19": "漏洞利用",
			"drill.d20": "内网渗透",
			"drill.d21": "现场截图",
			"drill.d22": "记录生成的证据摘录",
			"drill.d23": "载入中…",
			"drill.d24": "证据 ",
			"drill.d25": "由当日记录生成的证据摘录，不是现场截图 —— 报告里同样会标注",
			"drill.d26": "证据",
			"drill.d27": "　·　点击任意处关闭",
			"drill.d28": "证据截图",
			"drill.d29": "显示 ",
			"drill.d30": " 张",
			"drill.d31": "（该得分点共 ",
			"drill.d32": "未知",
			"drill.d33": "已复制：",
			"drill.d34": "复制失败（浏览器未授权剪贴板）—— 请手动选中文本复制",
			"drill.d35": "未测试",
			"drill.d36": "测试中",
			"drill.d37": "已测试",
			"drill.d38": "被封禁",
			"drill.d39": "已放弃",
			"drill.d40": "无攻击面",
			"drill.d41": "高",
			"drill.d42": "中",
			"drill.d43": "低",
			"drill.d44": "未评",
			"drill.d45": "查询失败",
			"drill.d46": "全部 C 段",
			"drill.d47": " 个网段",
			"drill.d48": "正在跑的扫描 / 探测与进度（5 秒自动刷新）",
			"drill.d49": "当前测试",
			"drill.d50": "当前测试（既非内网也非外网）",
			"drill.d51": "测",
			"drill.d52": "正在跑的扫描与探测",
			"drill.d53": "展开本组",
			"drill.d54": "（并切回资产列表）",
			"drill.d55": "外网",
			"drill.d56": " 个 C 段",
			"drill.d57": " 资产",
			"drill.d58": "未知归属",
			"drill.d59": " · 存活 ",
			"drill.d60": " 台",
			"drill.d61": "筛选 C 段 ",
			"drill.d62": "外",
			"drill.d63": "外网资产",
			"drill.d64": "内网资产",
			"drill.d65": "搜索 IP / 域名 / 指纹（回车）",
			"drill.d66": "搜索",
			"drill.d67": "服务",
			"drill.d68": "端口",
			"drill.d69": "内外网不限",
			"drill.d70": "仅外网资产",
			"drill.d71": "仅内网资产",
			"drill.d72": "按端口来源过滤（列表已不再单列显示，详情里可见）",
			"drill.d73": "来源不限",
			"drill.d74": "仅被动",
			"drill.d75": "仅主动",
			"drill.d76": "易打性不限",
			"drill.d77": "易打（高）",
			"drill.d78": "一般（中）",
			"drill.d79": "难打（低）",
			"drill.d80": "测试状态不限",
			"drill.d81": "重新拉取快照与当前视图数据",
			"drill.d82": "刷新",
			"drill.d83": "列表",
			"drill.d84": "按发现时间看资产（什么时候发现、哪天收了多少）",
			"drill.d85": "发现时间",
			"drill.d86": "域名",
			"drill.d87": "点击筛选 / 再点取消",
			"drill.d88": "按「",
			"drill.d89": "」筛选（",
			"drill.d90": "台资产",
			"drill.d91": "存活",
			"drill.d92": "待测",
			"drill.d93": "已测",
			"drill.d94": "放弃",
			"drill.d95": "列表排序方式",
			"drill.d96": "排序：易打性优先",
			"drill.d97": "排序：待测优先",
			"drill.d98": "排序：最近发现优先",
			"drill.d99": "排序：端口多优先",
			"drill.d100": "排序：按 IP",
			"drill.d101": "易打",
			"drill.d102": "测试状态",
			"drill.d103": "开放端口 / 服务",
			"drill.d104": "指纹",
			"drill.d105": "展开资产 ",
			"drill.d106": "发现时间：",
			"drill.d107": "未记录",
			"drill.d108": "\\n最近采集：",
			"drill.d109": "发现时间未知",
			"drill.d110": "封",
			"drill.d111": "未知服务",
			"drill.d112": "未知工具",
			"drill.d113": "测试",
			"drill.d114": "被封 ",
			"drill.d115": " 次",
			"drill.d116": "未测过",
			"drill.d117": "易打性",
			"drill.d118": "未评估",
			"drill.d119": "攻击面",
			"drill.d120": "无开放端口",
			"drill.d121": "展开资产详情",
			"drill.d122": "展开全部（端口 · 指纹 · 采集溯源 · 测试记录）▼",
			"drill.d123": "主机名",
			"drill.d124": "本条资产第一次进入资产库的时刻（重复采集只刷新\"最近采集\"）",
			"drill.d125": "最近采集",
			"drill.d126": "数据源首见",
			"drill.d127": "C 段",
			"drill.d128": " · 预期：",
			"drill.d129": " · 依据：",
			"drill.d130": "来源",
			"drill.d131": "被动端口 ",
			"drill.d132": " · 主动端口 ",
			"drill.d133": "测试记录（",
			"drill.d134": " 条）",
			"drill.d135": "采集溯源（最近 8 条）",
			"drill.d136": "加载中…",
			"drill.d137": "没有匹配的资产",
			"drill.d138": " 个资产",
			"drill.d139": "暂无域名数据（信息收集阶段会写入域名）",
			"drill.d140": "URL（可点击）",
			"drill.d141": "标题",
			"drill.d142": "资产",
			"drill.d143": "暂无 Web 资产（HTTP 探测后会写入 URL 与标题）",
			"drill.d144": "加载失败",
			"drill.d145": "资产发现时间线",
			"drill.d146": "共 ",
			"drill.d147": " 台 · 最早 ",
			"drill.d148": " · 最近 ",
			"drill.d149": "（发现时间 = 第一次进入资产库的时刻；重复采集只刷新\"最近采集\"）",
			"drill.d150": "还没有资产。",
			"drill.d151": "按天统计",
			"drill.d152": "清除按天筛选：",
			"drill.d153": "清除筛选：",
			"drill.d154": "：新增 ",
			"drill.d155": " 台（内网 ",
			"drill.d156": " / 外网 ",
			"drill.d157": "筛选 ",
			"drill.d158": " 发现的资产",
			"drill.d159": " 台 · 内 ",
			"drill.d160": " / 外 ",
			"drill.d161": " 发现的资产（",
			"drill.d162": "最近发现的资产（",
			"drill.d163": "这一天没有新增资产。",
			"drill.d164": "时间未知",
			"drill.d165": "读取失败",
			"drill.d166": "当前为内置默认提示词（创建靶标后可按靶标保存修改）",
			"drill.d167": "请先创建靶标，再保存提示词",
			"drill.d168": "保存失败",
			"drill.d169": "已保存",
			"drill.d170": "请先创建靶标，再恢复默认提示词",
			"drill.d171": "恢复失败",
			"drill.d172": "已恢复内置默认：",
			"drill.d173": "查看「",
			"drill.d174": "」提示词",
			"drill.d175": "（空）",
			"drill.d176": "提示词",
			"drill.d177": "更新 ",
			"drill.d178": "把当前角色恢复成内置最新版提示词",
			"drill.d179": "恢复默认为当前",
			"drill.d180": "四个角色全部恢复成内置最新版提示词",
			"drill.d181": "全部恢复默认",
			"drill.d182": "保存",
			"drill.d183": "该角色的系统提示词（Markdown）",
			"drill.d184": "保存后写入 agents/",
			"drill.d185": ".md。子会话任务第一行写 redteamRole: recon、assess、vuln-scan、exploit 或 internal 后，对应文件进入系统提示词。",
			"drill.d186": "查看技能 ",
			"drill.d187": "仅人工",
			"drill.d188": "官方技能目录，不按红队工具路径检查",
			"drill.d189": "官方",
			"drill.d190": "可用：技能正文可以加载。缺的外部工具或密钥记在详情里，不阻止调用。",
			"drill.d191": "（无描述）",
			"drill.d192": "来源 ",
			"drill.d193": "红队技能",
			"drill.d194": "官方技能",
			"drill.d195": "过滤技能",
			"drill.d196": "只看本插件自带（",
			"drill.d197": " 个）",
			"drill.d198": "只看有明确缺口（缺 key / 缺本机路径 / 基础设施还是占位符）或判不了可用性的技能",
			"drill.d199": "只看不可用/未知（",
			"drill.d200": "可用 ",
			"drill.d201": "不可用 ",
			"drill.d202": "未知 ",
			"drill.d203": "技能正文或环境变量刚改过？点这里跳过 30 秒缓存重查",
			"drill.d204": "重新检查技能可用性",
			"drill.d205": "重查可用性",
			"drill.d206": "红队 ",
			"drill.d207": " · 官方 ",
			"drill.d208": "（技能多来自其它插件注册的根或你自己的技能目录；本插件只自带 ",
			"drill.d209": "技能目录（DSH 原生）",
			"drill.d210": "该模块的宿主代码已更新，需重启一次当前宿主（官方 exe / 社区版 / dsh web）后生效",
			"drill.d211": "描述",
			"drill.d212": "何时使用",
			"drill.d213": "类型",
			"drill.d214": "官方技能。由宿主按任务调用，不按红队工具路径检查。",
			"drill.d215": "可用性",
			"drill.d216": "未知（正文读不到）",
			"drill.d217": "缺口",
			"drill.d218": "需要你提供",
			"drill.d219": "文件",
			"drill.d220": "技能由 DSH 原生 skill 体系管理，红队智能体通过 skill 工具调用。",
			"drill.d221": "检查于 ",
			"drill.d222": "现在跑不起来的技能：",
			"drill.d223": " 个 · ",
			"drill.d224": "…另有 ",
			"drill.d225": " 个目录（共 ",
			"drill.d226": " 个技能）",
			"drill.d227": "左侧选择技能查看内容",
			"drill.d228": "严重",
			"drill.d229": "高危",
			"drill.d230": "中危",
			"drill.d231": "低危",
			"drill.d232": "信息",
			"drill.d233": "待验证",
			"drill.d234": "已确认",
			"drill.d235": "误报",
			"drill.d236": "已利用",
			"drill.d237": "已修复",
			"drill.d238": "(未指定目标)",
			"drill.d239": "证据摘要",
			"drill.d240": "文本",
			"drill.d241": "复制",
			"drill.d242": "HTTP 证据",
			"drill.d243": "▸ 请求（可直接粘进 Burp Repeater）",
			"drill.d244": "▸ 响应",
			"drill.d245": "缺失 —— 未验证/无证据的漏洞不计入报告，请补 redteam_http_evidence_add",
			"drill.d246": "更新失败",
			"drill.d247": "已更新为「",
			"drill.d248": "拿到权限",
			"drill.d249": "默认按目标聚合 · 共 ",
			"drill.d250": " 个目标",
			"drill.d251": "等级",
			"drill.d252": "漏洞 / 编号",
			"drill.d253": "目标",
			"drill.d254": "拿到什么",
			"drill.d255": "状态",
			"drill.d256": "置信",
			"drill.d257": "未记录 —— 拿到权限/成果后请用 redteam_vuln_update 补 gained（例：服务器权限、内网隧道、后台管理员账号）",
			"drill.d258": "攻击文件",
			"drill.d259": "(未命名)",
			"drill.d260": "（无）用 redteam_attack_file_add 把这条漏洞打通的脚本/马/EXP 归档，并带上 vuln_id",
			"drill.d261": "确认",
			"drill.d262": " 个漏洞",
			"drill.d263": "已利用 ",
			"drill.d264": "资产 ",
			"drill.d265": "未记录权限",
			"drill.d266": "暂无漏洞记录",
			"drill.d267": "搜索标题 / CVE / 目标（回车）",
			"drill.d268": "全部等级",
			"drill.d269": "全部状态",
			"drill.d270": "凭据 · ",
			"drill.d271": "点击可全选",
			"drill.d272": "未记明文 —— 请用 redteam_credential_add 的 secret_value 补上，面板才能直显",
			"drill.d273": "工具 ",
			"drill.d274": "备注：",
			"drill.d275": "暂无凭据（拿到口令/密钥/Hash 后用 redteam_credential_add 落库，秒级可复用）",
			"drill.d276": "已获得访问会话 · ",
			"drill.d277": "暂无",
			"drill.d278": "漏洞",
			"drill.d279": "凭据",
			"drill.d280": "访问会话",
			"drill.d281": "展开所有目标",
			"drill.d282": "全部展开",
			"drill.d283": "收起所有目标",
			"drill.d284": "全部收起",
			"drill.d285": "当前：平铺每条漏洞",
			"drill.d286": "平铺列表",
			"drill.d287": "攻击文件按靶标目录组织（原「攻击文件」页签）；每条漏洞的关联文件也能在该漏洞详情里直接看到。",
			"drill.d288": " 目前有 ",
			"drill.d289": "获得权限",
			"drill.d290": "内网突破",
			"drill.d291": "敏感数据",
			"drill.d292": "其他",
			"drill.d293": "利用漏洞",
			"drill.d294": "次数",
			"drill.d295": "同类第 ",
			"drill.d296": " 次 · +",
			"drill.d297": " 分",
			"drill.d298": "记录",
			"drill.d299": "结果与证据",
			"drill.d300": "同一资产同一端口只算分值最高的一条",
			"drill.d301": "服务已拿满 · 不计分",
			"drill.d302": "第 ",
			"drill.d303": "动作：",
			"drill.d304": "（未命名步骤）",
			"drill.d305": "端口 ",
			"drill.d306": "漏洞 ",
			"drill.d307": "易打 ",
			"drill.d308": "拿到分数的资产 · ",
			"drill.d309": "还没有产生得分的资产",
			"drill.d310": "本阶段命中 ",
			"drill.d311": "本阶段还没有得分",
			"drill.d312": "跨越靶标边界的通道 · ",
			"drill.d313": " 条",
			"drill.d314": "（另有 ",
			"drill.d315": "注意：现有的通道都在自己的服务器上，没有碰到目标 —— 不计边界突破。需要目标侧发起的通道（反弹 shell 到我这 / 目标上跑 frp 客户端 / 经目标 WebShell 的 suo5）。",
			"drill.d316": "可达 ",
			"drill.d317": "还没有建立隧道（建好后用 redteam_tunnel_add 登记）",
			"drill.d318": "涉及资产 · ",
			"drill.d319": "累计 ",
			"drill.d320": "阶段目标",
			"drill.d321": "合计 ",
			"drill.d322": "隧道 ",
			"drill.d323": "台资产拿到分",
			"drill.d324": "外 ",
			"drill.d325": " 次命中",
			"drill.d326": "涉及 ",
			"drill.d327": " 台资产",
			"drill.d328": "攻击链",
			"drill.d329": "信息收集 → 互联网资产权限 → 边界突破 → 内网资产权限 → 靶标权限",
			"drill.d330": "总分 ",
			"drill.d331": "竖向攻击链：逐阶段向下看细节",
			"drill.d332": "链路 A",
			"drill.d333": "横向攻击链：一屏看完五个阶段",
			"drill.d334": "链路 B",
			"drill.d335": "还没有得分记录。拿到成果后用 redteam_score_hit 记分，这条链才会长出来。",
			"drill.d336": "其他得分",
			"drill.d337": "生成失败",
			"drill.d338": "还没有可交付的成果",
			"drill.d339": "已下载：",
			"drill.d340": "下载失败：",
			"drill.d341": " 项请求",
			"drill.d342": "复制请求",
			"drill.d343": "目标 ",
			"drill.d344": "拿到 ",
			"drill.d345": "利用漏洞 ",
			"drill.d346": "结果 ",
			"drill.d347": "取得时间 ",
			"drill.d348": "复现步骤（点击展开）",
			"drill.d349": " 个动作",
			"drill.d350": " 条凭据",
			"drill.d351": " 条隧道",
			"drill.d352": "复现材料待补",
			"drill.d353": "可复现",
			"drill.d354": "注意：没有关联的攻击步骤：说不清这一步是怎么做的。请用 redteam_chain_add 补上动作（title / detail / tool / result），记分时也可以带 point_code + evidence 一次完成。",
			"drill.d355": "(未命名动作)",
			"drill.d356": "按同资产推断",
			"drill.d357": "执行 ",
			"drill.d358": "未记录实际命令（redteam_chain_add 的 tool）",
			"drill.d359": " 步命令",
			"drill.d360": "复制命令",
			"drill.d361": "拿到的凭据（来源可追溯）",
			"drill.d362": "(无用户名)",
			"drill.d363": " · 权限 ",
			"drill.d364": " · 来源 ",
			"drill.d365": "未标注",
			"drill.d366": " · 取得方式 ",
			"drill.d367": "用到的隧道 / 通道",
			"drill.d368": "入口 ",
			"drill.d369": "未登记",
			"drill.d370": " · 可达 ",
			"drill.d371": " · 目标侧 ",
			"drill.d372": "未声明",
			"drill.d373": " · 命令 ",
			"drill.d374": "用到的 WebShell",
			"drill.d375": " · 口令/密钥 ",
			"drill.d376": "注意：复现缺口：",
			"drill.d377": "注意：这一项没有原始请求记录，无法直接复现 —— 请用 redteam_http_evidence_add 补上",
			"drill.d378": "复现请求 ",
			"drill.d379": "请求 ",
			"drill.d380": "复制到 Yakit",
			"drill.d381": "响应摘要",
			"drill.d382": "备注 ",
			"drill.d383": "攻击得分链路复现报告",
			"drill.d384": " 项得分",
			"drill.d385": " 项带原始请求",
			"drill.d386": "复现链是否完整：有攻击步骤、写了实际命令、关联了漏洞/凭据/隧道",
			"drill.d387": "可复现 ",
			"drill.d388": "同一资产同一端口的重复账号/数据库权限命中：服务已拿满，不计分、不进报告",
			"drill.d389": "同服务已拿满不计分 ",
			"drill.d390": "整份报告",
			"drill.d391": "复制全文",
			"drill.d392": "下载 .md",
			"drill.d393": "重新生成",
			"drill.d394": "全部折叠",
			"drill.d395": " 项",
			"drill.d396": "还没有可交付的成果。",
			"drill.d397": "本报告只收录\"拿到了分\"的成果；没有得分的漏洞不进报告。拿到成果后用 redteam_score_hit 记分（目标资产 + 拿到的东西），并补 redteam_http_evidence_add 以便复现。",
			"drill.d398": "口径：只收录得分成果，每条附带可粘进 Yakit Repeater 的原始请求",
			"drill.d399": "脚本",
			"drill.d400": "字典",
			"drill.d401": "效果",
			"drill.d402": "路径",
			"drill.d403": " 个文件",
			"drill.d404": " 个目标 / ",
			"drill.d405": "暂无攻击文件（打通的脚本/POC/EXP 会按目标文件夹出现在这里）",
			"drill.d406": "目录：attack-files/<IP|URL主机|C段>/ ｜ 只收录实际生效的文件",
			"drill.d407": "模板",
			"drill.d408": "载荷",
			"drill.d409": "互联网",
			"drill.d410": "手搓",
			"drill.d411": "人工",
			"drill.d412": "nuclei 模板",
			"drill.d413": "知识库",
			"drill.d414": "演练台手动标记",
			"drill.d415": "已记一次复用：",
			"drill.d416": "已验证",
			"drill.d417": "未验证",
			"drill.d418": "复用 ",
			"drill.d419": "归类 ",
			"drill.d420": "影响版本 ",
			"drill.d421": "建立时间 ",
			"drill.d422": "来源靶标 ",
			"drill.d423": "发现资产 ",
			"drill.d424": "发现角色 ",
			"drill.d425": "读取中…",
			"drill.d426": "用法",
			"drill.d427": "说明",
			"drill.d428": "验证证据",
			"drill.d429": "最近使用",
			"drill.d430": "落盘",
			"drill.d431": "POC 正文",
			"drill.d432": "复制正文",
			"drill.d433": "记一次复用",
			"drill.d434": "来源链接",
			"drill.d435": "复制来源",
			"drill.d436": "这条只有元数据，没有正文 —— 拿到正文后用 redteam_poc_update 补上",
			"drill.d437": "知识库 · POC / EXP",
			"drill.d438": "已验证 ",
			"drill.d439": "累计复用 ",
			"drill.d440": "这些条目还没归类：智能体回填时用 redteam_poc_add 的 category 参数标一下",
			"drill.d441": "未归类 ",
			"drill.d442": "本机模板 ",
			"drill.d443": "按归类分组显示 / 平铺显示",
			"drill.d444": "平铺显示",
			"drill.d445": " · 本机模板 ",
			"drill.d446": " · 知识库 ",
			"drill.d447": "（已验证 ",
			"drill.d448": "搜 CVE / 组件 / 关键字（正文也会搜）",
			"drill.d449": "全部归类",
			"drill.d450": "全部来源靶标",
			"drill.d451": "发现资产筛选",
			"drill.d452": "全部类型",
			"drill.d453": "只看已验证",
			"drill.d454": "检索",
			"drill.d455": "知识库接口由 host 侧提供，当前宿主还是旧进程 —— 请完全退出后重新打开（官方 exe / 社区版 / dsh web 任一），再刷新页面。",
			"drill.d456": "知识库：",
			"drill.d457": "（根目录 ",
			"drill.d458": "最近建立 ",
			"drill.d459": "本机 nuclei 模板 · ",
			"drill.d460": "（直接 `nuclei -t <模板路径>`）",
			"drill.d461": " -u <目标>",
			"drill.d462": "模板命令",
			"drill.d463": "上一页",
			"drill.d464": "下一页",
			"drill.d465": "模板目录：",
			"drill.d466": "没有命中：换个关键字再试，或去互联网找 / 自己手搓后回填。",
			"drill.d467": "POC/EXP 库还是空的；本机已有 ",
			"drill.d468": " 个 nuclei 模板，但这一页没有列出来。请完全退出后重新打开客户端。",
			"drill.d469": "知识库还是空的（本机模板目录存在但没有 yaml，请跑 nuclei -update-templates）。",
			"drill.d470": "知识库还是空的。本机也还没有 nuclei 模板库 —— 在演练机上跑 setup.sh 或 `nuclei -update-templates`，装好后这里会出现「本机模板 N」。",
			"drill.d471": "打 Nday/1day 的标准顺序：① redteam_poc_search 先查这里（顺带搜本机 nuclei 模板库）→ ② 都没有就互联网搜索（web_search / GitHub / ExploitDB / 厂商公告）或自己手搓 → ③ 在真实目标上验证有效后 redteam_poc_add 回填，后面的靶标直接就能用。",
			"drill.d472": "知识库文件：",
			"drill.d473": "全局共享（跨靶标）｜ 落盘：pocs/<code>/ ｜ 只收录通用可复用的 POC/EXP，靶标专用脚本走「攻击文件」",
			"drill.d474": "已保存到 ",
			"drill.d475": "请先填写工具所在文件夹路径",
			"drill.d476": "自动分配失败",
			"drill.d477": "已从文件夹分配 ",
			"drill.d478": " 个工具",
			"drill.d479": "环境适配",
			"drill.d480": "就绪 · ",
			"drill.d481": "待配置",
			"drill.d482": "均可选填：留空则用默认路径/自动查找。填了的覆盖默认。密钥类只在需要测绘/反弹时才填。",
			"drill.d483": "整包文件夹 → 自动分配工具",
			"drill.d484": "工具都在同一个文件夹（含子目录）时，填路径后点「自动分配」：会写入 toolkitDir，并按文件名匹配 nmap / nuclei / fscan 等填到下方。",
			"drill.d485": "例如 D:\\\\pentest-tools 或 /opt/toolkit",
			"drill.d486": "自动分配",
			"drill.d487": "出网状态（借鉴 Z3r0 egress，只读）",
			"drill.d488": "(空)",
			"drill.d489": "平台与目录",
			"drill.d490": "平台模式",
			"drill.d491": "auto（跟随本机，默认）",
			"drill.d492": "工具箱目录 toolkitDir（留空＝默认）",
			"drill.d493": "默认：",
			"drill.d494": "nuclei 模板目录（留空＝自动：toolkit/nuclei-templates）",
			"drill.d495": "工具搜索目录 binDirs（留空＝只搜 toolkit + PATH；每行一个）",
			"drill.d496": "可选。例如：",
			"drill.d497": "密钥与 VPS（留空＝不覆盖；进程环境变量优先）",
			"drill.d498": "（可选）",
			"drill.d499": "留空；测绘时再填",
			"drill.d500": "工具可执行文件（留空＝自动查找）",
			"drill.d501": "解析顺序：本表绝对路径 → toolkitDir → binDirs → PATH。留空即走默认查找。",
			"drill.d502": " · 已找到",
			"drill.d503": "未找到（可留空等装好）",
			"drill.d504": "留空自动找：",
			"drill.d505": "备注",
			"drill.d506": "可选。例如：工具来自某某绿色包",
			"drill.d507": "配置文件：",
			"drill.d508": " | 留空字段全部走默认",
			"drill.d509": "名称不能为空",
			"drill.d510": "已保存「启用/停用」。分值未改动：这是随《得分规则》分发的内置得分点，",
			"drill.d511": "分值 / 上限 / 计分口径由规则锁定（同一条规则的上限按组内所有得分点累计，",
			"drill.d512": "单独改分值会让一条命中吃掉整组上限）。要自定义分值时请「+ 新增得分点」。",
			"drill.d513": "删除失败",
			"drill.d514": "已删除",
			"drill.d515": " · 各项上限合计 ",
			"drill.d516": "分",
			"drill.d517": "已计入 ",
			"drill.d518": " 次，另有 ",
			"drill.d519": " 条因「",
			"drill.d520": "计分口径",
			"drill.d521": "」或已达上限不计分",
			"drill.d522": "未命中",
			"drill.d523": "　上限 ",
			"drill.d524": "未指定资产",
			"drill.d525": "自己注册/自建的账号不算得分权限，只作过程记录",
			"drill.d526": "自建 · 不计分",
			"drill.d527": "同一资产同一端口只算分值最高的一条，这条不计分",
			"drill.d528": "这条命中有证据截图（展开得分点即可看到代表图）",
			"drill.d529": "图 ",
			"drill.d530": "复制这一条",
			"drill.d531": "未填账号密码/结果",
			"drill.d532": "得分条件",
			"drill.d533": "停用",
			"drill.d534": " 分/次 · 命中 ",
			"drill.d535": " 次 = ",
			"drill.d536": "服务封顶",
			"drill.d537": "；账号权限与数据库权限按「同资产同端口」只算一次，拿到最高权限账号即该服务拿满",
			"drill.d538": "证据截图 · ",
			"drill.d539": "命中记录 · ",
			"drill.d540": "（只记资产与账号密码，详细复现见报告）",
			"drill.d541": "命中记录",
			"drill.d542": "还没有 —— 拿下成果后用 redteam_score_hit 记分：写明目标资产 + 拿到的账号密码/权限",
			"drill.d543": "编辑",
			"drill.d544": "得分目标",
			"drill.d545": "总分",
			"drill.d546": " 个得分点",
			"drill.d547": "命中 ",
			"drill.d548": "自己注册/自己创建的账号不算得分权限，只作过程记录（不计分、不占上限、不进报告）",
			"drill.d549": "自建不计分 ",
			"drill.d550": "账号权限与数据库权限按「同资产同端口」只算一次：该服务已拿满，这些重复命中不计分（只作留痕）",
			"drill.d551": "服务已拿满不计分 ",
			"drill.d552": "+ 新增得分点",
			"drill.d553": "内置得分点（来自《突破入侵类得分规则（合并版）》）",
			"drill.d554": "分值、上限、计分口径与名称由规则锁定 —— 同一条规则的上限按组内所有得分点累计，",
			"drill.d555": "单独改分值会让一条命中吃掉整组上限。这里可以改「启用 / 停用」；",
			"drill.d556": "要自定义分值时请返回上一屏点「+ 新增得分点」。",
			"drill.d557": "规则原文序号 ",
			"drill.d558": "　·　上限分组 rule=",
			"drill.d559": "　·　上限 ",
			"drill.d560": "　·　不设上限",
			"drill.d561": "名称（必填）",
			"drill.d562": "分类，如 账号权限",
			"drill.d563": "单次分值",
			"drill.d564": "内置得分点的分值由《得分规则》锁定，不能在这里改",
			"drill.d565": "这一类的单次分值；每命中一次就按这个分值累加（受该条规则上限约束）",
			"drill.d566": "启用",
			"drill.d567": "得分条件说明",
			"drill.d568": "内置得分点不能删除：删掉会让面板缺一条规则、报告少一类成果（下次启动还会自动补回来）。要让它不参与计分请改用「停用」。",
			"drill.d569": "删除（内置项不可删）",
			"drill.d570": "删除",
			"drill.d571": "取消",
			"drill.d572": "分值",
			"drill.d573": "得分点（按分值从低到高）",
			"drill.d574": "命中 / 上限",
			"drill.d575": "已得分",
			"drill.d576": "暂无得分点，点右上角「新增得分点」",
			"drill.d577": "展开",
			"drill.d578": "开放 ",
			"drill.d579": " 端口",
			"drill.d580": "已确认漏洞 ",
			"drill.d581": "测试面：",
			"drill.d582": "预期得分：",
			"drill.d583": "测试记录",
			"drill.d584": "更新于 ",
			"drill.d585": "展开最近动过与待测队列",
			"drill.d586": "只留正在测",
			"drill.d587": "每 5 秒自动刷新",
			"drill.d588": "已暂停",
			"drill.d589": "正在测",
			"drill.d590": "agent 开始测某台资产后会实时出现在这里",
			"drill.d591": "当前没有资产处于「测试中」",
			"drill.d592": "最近动过",
			"drill.d593": "已测过的资产",
			"drill.d594": "待测队列",
			"drill.d595": "按易打性与端口数排出先打哪几台",
			"drill.d596": "完整清单（含筛选与排序）见「资产测绘」页",
			"drill.d597": "没有待测资产",
			"drill.d598": "检测失败",
			"drill.d599": "检测完成：WebShell 在线 ",
			"drill.d600": "，隧道可用 ",
			"drill.d601": "界面手动标记",
			"drill.d602": "怎么做（点击展开）",
			"drill.d603": "有 ",
			"drill.d604": " 个入口不是冰蝎马/哥斯拉马（用户连不上，不算可交付入口）",
			"drill.d605": "用技能 webshell-toolkit 重新上传冰蝎马（behinder）或哥斯拉马（godzilla），",
			"drill.d606": "并把 shell_type + pass_key 写进 redteam_webshell_add。只作临时中转的可在备注里写明。",
			"drill.d607": "现有 ",
			"drill.d608": " 条通道都不算\"跨越靶标边界\"（不算边界/内网突破）",
			"drill.d609": "自己的 VPS / 自建服务器上开的 socks5、frp、代理不算隧道。必须是目标侧发起的通道：",
			"drill.d610": "目标反弹 shell 到我方、目标上跑 frp/Stowaway 客户端、或经目标 WebShell 建的 suo5/HTTP 隧道；登记时用 entry_kind 说明。",
			"drill.d611": "还没有可用的 suo5 隧道（打进内网的标准通道）",
			"drill.d612": "用技能 suo5-tunnel 通过上面的 WebShell 建 socks5 隧道，再 redteam_tunnel_add",
			"drill.d613": "（kind=suo5、listen=127.0.0.1:1080、entry=WebShell URL、reach=可达网段）登记，",
			"drill.d614": "最后点「检测连通性」确认 status=active。",
			"drill.d615": "用户连不上",
			"drill.d616": "已复制",
			"drill.d617": "复制 URL",
			"drill.d618": "标记失效",
			"drill.d619": "非加密马 —— 用户连不上，仅可作临时中转",
			"drill.d620": "连接口令",
			"drill.d621": "所在资产",
			"drill.d622": "权限",
			"drill.d623": "凭据引用",
			"drill.d624": "最后检测",
			"drill.d625": "未检测",
			"drill.d626": "检测说明",
			"drill.d627": "./gogo -i <内网CIDR> -m ss --ping -p top2,win,db --proxy ",
			"drill.d628": "./fscan -h <内网CIDR> -np -nobr -nopoc -socks5 ",
			"drill.d629": "(未填监听地址)",
			"drill.d630": "非 suo5 标准通道",
			"drill.d631": "目标侧通道",
			"drill.d632": "只在自己 VPS/自建服务器上开的通道，没有碰到目标 —— 不算边界突破/内网突破",
			"drill.d633": "不算突破",
			"drill.d634": "未声明 entry_kind：请说明目标侧的那一端是什么（target-outbound / target-http / target-agent）",
			"drill.d635": "待确认",
			"drill.d636": "复制地址",
			"drill.d637": "标记可用",
			"drill.d638": "目标侧入口",
			"drill.d639": "跨越边界",
			"drill.d640": "已确认目标侧",
			"drill.d641": "不算突破（只在自己 VPS 上开代理）",
			"drill.d642": "未声明 entry_kind，待确认",
			"drill.d643": "可达网段",
			"drill.d644": "建立命令（点击展开 / 复制）",
			"drill.d645": "点击复制",
			"drill.d646": "走这条隧道扫描（gogo / fscan 命令）",
			"drill.d647": "复制 gogo 命令",
			"drill.d648": "复制 fscan 命令",
			"drill.d649": "会话与入口",
			"drill.d650": " 在线",
			"drill.d651": " 可用",
			"drill.d652": "凭据 ",
			"drill.d653": "访问会话 ",
			"drill.d654": "检测连通性",
			"drill.d655": "还没有登记任何 WebShell 或隧道。",
			"drill.d656": "拿到 WebShell 用 redteam_webshell_add；建好隧道用 redteam_tunnel_add（suo5 / socks5 / ssh -R）；之后智能体用 redteam_sessions 就能看到。",
			"drill.d657": "已上线的可控入口",
			"drill.d658": "暂无（拿到 WebShell 后用 redteam_webshell_add 登记）",
			"drill.d659": "内网隧道",
			"drill.d660": "可直接给扫描器当代理用",
			"drill.d661": "暂无（建好隧道后用 redteam_tunnel_add 登记）",
			"drill.d662": "[redteam-ui] 页面渲染出错:",
			"drill.d663": "该页面渲染出错：",
			"drill.d664": "回到资产测绘",
			"drill.d665": "作战智能体",
			"drill.d666": "并发上限 ",
			"drill.d667": "占用未知",
			"drill.d668": "在跑 ",
			"drill.d669": " / 剩余 ",
			"drill.d670": "并发规则（硬约束）",
			"drill.d671": "· 同一靶标**同时最多 ",
			"drill.d672": " 个执行智能体**；主会话派活前用 `redteam_agent_slot` 占位，满了直接拒绝。",
			"drill.d673": "· **默认一个一个派、按顺序推进**；只有确实互不依赖的活才并行。",
			"drill.d674": "· 每个会话有**自己的靶标绑定**：多会话并行不会把报告写串（子智能体继承父会话的靶标）。",
			"drill.d675": "六个角色",
			"drill.d676": "① 信息收集 `recon` —— 只收集资产，把单位资产收集完整（含边缘与未备案资产）",
			"drill.d677": "② 资产梳理 `assess` —— 一条一条过，评易打性并全部落库",
			"drill.d678": "③ 漏洞发现 `vuln-scan` —— 先查库去重 → Nday/1day 优先 → 接口未授权探测",
			"drill.d679": "④ 漏洞利用 `exploit` —— 先拿服务器权限（冰蝎/哥斯拉马）+ 建 suo5 隧道，再打其它得分项",
			"drill.d680": "⑤ 内网渗透 `internal` —— 走隧道，依次拉起 ①②③④ 做内网",
			"drill.d681": "⑥ 主会话 `plan` —— 只做计划、派活、汇总、汇报，不动手",
			"drill.d682": "角色提示词（按靶标存，可在这里编辑）",
			"drill.d683": "「智能体提示词」已并入本页；下面是完整编辑器（改完点保存，只影响当前靶标）。",
			"drill.d684": "面板中设置",
			"drill.d685": "默认值",
			"drill.d686": "已保存：并发上限 ",
			"drill.d687": "（立即生效，不用重启）",
			"drill.d688": "并发数量",
			"drill.d689": "同一靶标**同时最多几个执行智能体**。当前生效：**",
			"drill.d690": "（在跑 ",
			"drill.d691": "，剩余 ",
			"drill.d692": "，来源：",
			"drill.d693": "。改完**立即生效**，不用重启。",
			"drill.d694": "范围 1 – ",
			"drill.d695": "注意：调大不等于更快：**同一个模型 API Key 的并发/速率上限是共享的**，同时派太多会互相挤占，",
			"drill.d696": "表现为排队等待、超时、返回被截断甚至限流报错 —— 反而让测试结果不稳定（漏测、半途而废）。",
			"drill.d697": "建议从 2–3 开始，只有在确认 Key 的额度足够、任务之间确实互不依赖时才调大。",
			"drill.d698": "检查更新失败",
			"drill.d699": "已安装 ",
			"drill.d700": "，正在重启当前宿主…",
			"drill.d701": "当前版本 ",
			"drill.d702": "\\n最新版本 ",
			"drill.d703": "\\n检查失败：",
			"drill.d704": "发现新版本 ",
			"drill.d705": "：点击查看并一键更新（会重启当前宿主）",
			"drill.d706": "有新版本 v",
			"drill.d707": "重新检查 npm 上的最新版本",
			"drill.d708": "检查更新",
			"drill.d709": "更新 RedTeam 模式",
			"drill.d710": "当前版本",
			"drill.d711": "最新版本",
			"drill.d712": "安装方式",
			"drill.d713": "包安装（",
			"drill.d714": "安装位置",
			"drill.d715": "现在不能更新：",
			"drill.d716": "更新过程：安装新版本 → 自动重启当前宿主（官方 exe / 社区版 / dsh web；当前页面会断开，约 5–10 秒后自动刷新）。",
			"drill.d717": "重启前会检查有没有智能体在跑，有就拦住不动。",
			"drill.d718": "宿主正在重启，",
			"drill.d719": " 秒后自动刷新页面…",
			"drill.d720": "关闭",
			"drill.d721": "安装并重启",
			"drill.d722": "一键更新并重启",
			"drill.d723": "无法连接资产库",
			"drill.d724": "创建失败",
			"drill.d725": "无法打开新窗口：",
			"drill.d726": "还没有靶标",
			"drill.d727": "输入攻防演练靶标单位名称，创建演练并开始资产测绘。",
			"drill.d728": "例如：示例科技有限公司",
			"drill.d729": "创建靶标",
			"drill.d730": "未知页签",
			"drill.d731": "拖动调整宽度",
			"drill.d732": "拖动调整高度",
			"drill.d733": "拖动调整大小",
			"drill.d734": "按住拖动面板",
			"drill.d735": "演练台",
			"drill.d736": "独立窗口",
			"drill.d737": "暂无靶标",
			"drill.d738": "未命名",
			"drill.d739": "回到带侧栏的普通界面（或按 Esc）",
			"drill.d740": "退出全面浏览",
			"drill.d741": "刷新名册、快照与当前页面数据",
			"drill.d742": "在新浏览器窗口打开完整演练台",
			"drill.d743": "全面浏览",
			"drill.d744": "收起面板",
			"drill.d745": "收起",
			"drill.d746": "有新内容",
			"drill.d747": "C 段 ",
			"drill.d748": "（存活 ",
			"drill.d749": "指纹 ",
			"drill.d750": "被动/主动 ",
			"drill.d751": "按 Esc 或点右上角「退出全面浏览」回到带侧栏的界面",
			"drill.d752": "演练台（常驻右侧栏）",
			"drill.d753": "全面浏览：在新窗口打开完整演练台（当前窗口不受影响；新窗口内按 Esc 退出）",
			"drill.d754": "<h3>严正法律免责与合规使用声明</h3>\\r\\n    <p>本声明在进入演练台前必须全文阅读。本项目是非营利开源项目，遵守国家法律法规及所在平台的规范，仅供学习与研究、技术参考。严禁任何主体把本项目用于商业售卖、付费倒卖或黑灰产牟利。</p>\\r\\n    <p>开发者坚决反对并严禁任何形式的违法犯罪，绝不支持、不鼓励、不协助未授权网络攻击、漏洞利用、数据窃取、非法侵入计算机信息系统，或生成违法违禁内容。任何将本项目用于违法犯罪的行为，均与开发者无关，由行为人依法独立承担全部法律责任。不得以科研、教学、测试、演示或内部学习为由规避下列条款。</p>\\r\\n    <h3>1. 本仓库不含违法内容</h3>\\r\\n    <p>dsh-purge 发布的代码、文档、补丁与默认提示词不是木马、后门、未授权渗透工具、勒索软件、撞库脚本，也不是针对公网或第三方系统的攻击载荷。项目不提供违法内容，也不教唆、组织、协助实施违法犯罪。</p>\\r\\n    <h3>2. 本机操作不构成对外授权</h3>\\r\\n    <p>应用补丁、写入、回滚、卸载，都在本机文件和本机进程内完成。这些操作不对任何公网主机或未授权系统进行扫描、探测、入侵或攻击发包，也不得把本机当作跳板。</p>\\r\\n    <p>插件若开启检测更新，仅可能访问本插件自己的 GitHub 仓库以核对版本。该访问与对第三方系统的网络攻击无关，不能被解释为对外渗透的授权。</p>\\r\\n    <h3>3. 允许使用的范围</h3>\\r\\n    <p>只允许用在你能证明有权处理的环境：本人有权管理的本机官方 Harness；离线的本地合成靶标；所有者已经出具合法书面授权的网络安全演练靶场；合规实验室里的受控环境。书面授权要能对应具体目标、时间和范围。只填写一个单位名称，或只有口头说法，不构成授权。</p>\\r\\n    <p>未经所有者合法书面授权的目标、公网在线系统、生产业务，以及能源、交通、水利、金融、公共服务、电子政务等关键信息基础设施，都不得作为演练对象。</p>\\r\\n    <h3>4. 必须遵守的法律，按条、款</h3>\\r\\n    <p>《中华人民共和国刑法》第二百八十五条第一款：禁止违反国家规定，侵入国家事务、国防建设、尖端科学技术领域的计算机信息系统。</p>\\r\\n    <p>同条第二款：禁止侵入前款规定以外的计算机信息系统，或者用其他技术手段，获取该系统中存储、处理或者传输的数据，或者对该系统实施非法控制。</p>\\r\\n    <p>同条第三款：禁止提供专门用于侵入、非法控制计算机信息系统的程序、工具；明知他人实施侵入、非法控制而为其提供程序、工具，同样禁止。</p>\\r\\n    <p>第二百八十六条第一款：禁止对计算机信息系统功能进行删除、修改、增加、干扰，造成系统不能正常运行。</p>\\r\\n    <p>同条第二款：禁止对系统中存储、处理或者传输的数据和应用程序进行删除、修改、增加。</p>\\r\\n    <p>同条第三款：禁止故意制作、传播计算机病毒等破坏性程序，影响计算机系统正常运行。</p>\\r\\n    <p>第二百八十七条：禁止利用计算机实施金融诈骗、盗窃、贪污、挪用公款、窃取国家秘密或者其他犯罪。</p>\\r\\n    <p>第二百八十七条之一第一款第（一）项：禁止设立用于实施诈骗、传授犯罪方法、制作或者销售违禁物品、管制物品等违法犯罪活动的网站、通讯群组。</p>\\r\\n    <p>同款第（二）项：禁止发布有关制作或者销售毒品、枪支、淫秽物品等违禁物品、管制物品或者其他违法犯罪的信息。</p>\\r\\n    <p>同款第（三）项：禁止为实施诈骗等违法犯罪活动发布信息。</p>\\r\\n    <p>第二百八十七条之二：禁止明知他人利用信息网络实施犯罪，仍为其提供技术支持，或者提供广告推广、支付结算等帮助。</p>\\r\\n    <p>第二百五十三条之一第一款、第三款：禁止向他人出售或者提供公民个人信息；禁止窃取或者以其他方法非法获取公民个人信息。</p>\\r\\n    <p>《中华人民共和国网络安全法》第十三条第二款：使用网络不得危害网络安全，不得利用网络从事危害国家安全、荣誉和利益，煽动颠覆国家政权、推翻社会主义制度，煽动分裂国家、破坏国家统一，宣扬恐怖主义、极端主义，宣扬民族仇恨、民族歧视，传播暴力、淫秽色情信息，编造、传播虚假信息扰乱经济秩序和社会秩序，以及侵害他人名誉、隐私、知识产权和其他合法权益等活动。</p>\\r\\n    <p>第十四条：禁止利用网络从事危害未成年人身心健康的活动。</p>\\r\\n    <p>第二十九条：禁止非法侵入他人网络、干扰他人网络正常功能、窃取网络数据；禁止提供专门用于侵入网络、干扰网络正常功能及防护措施、窃取网络数据的程序、工具；明知他人从事危害网络安全的活动，禁止为其提供技术支持、广告推广、支付结算等帮助。</p>\\r\\n    <p>第三十三条：公共通信和信息服务、能源、交通、水利、金融、公共服务、电子政务等关键信息基础设施实行重点保护。未获合法授权，不得侵入、干扰或破坏。</p>\\r\\n    <p>第四十六条：禁止窃取或者以其他非法方式获取个人信息，禁止非法出售或者非法向他人提供个人信息。</p>\\r\\n    <p>第四十八条：禁止设立用于实施诈骗，传授犯罪方法，制作或者销售违禁物品、管制物品等违法犯罪活动的网站、通讯群组；禁止利用网络发布涉及上述违法犯罪活动的信息。</p>\\r\\n    <p>第五十条：发送的电子信息、提供的应用软件不得设置恶意程序，不得含有法律、行政法规禁止发布或者传输的信息。</p>\\r\\n    <p>《中华人民共和国数据安全法》第八条：开展数据处理活动，不得危害国家安全、公共利益，不得损害个人、组织的合法权益。</p>\\r\\n    <p>第三十二条第一款：收集数据应当采取合法、正当的方式，不得窃取或者以其他非法方式获取数据。</p>\\r\\n    <p>同条第二款：法律、行政法规对收集、使用数据的目的和范围有规定的，只能在该目的和范围内收集、使用。</p>\\r\\n    <p>第五十一条：窃取或者以其他非法方式获取数据，或者因此损害个人、组织合法权益的，依照有关法律、行政法规处罚。</p>\\r\\n    <p>《中华人民共和国个人信息保护法》第五条：处理个人信息应当合法、正当、必要、诚信，不得通过误导、欺诈、胁迫等方式处理。</p>\\r\\n    <p>第六条第一款、第二款：处理个人信息应当具有明确、合理的目的，并与该目的直接相关，采取对个人权益影响最小的方式；收集限于实现处理目的的最小范围，不得过度收集。</p>\\r\\n    <p>第十条：禁止非法收集、使用、加工、传输他人个人信息，禁止非法买卖、提供或者公开他人个人信息；禁止从事危害国家安全、公共利益的个人信息处理活动。</p>\\r\\n    <p>第十三条：没有取得个人同意，也不属于订立履行合同所必需、履行法定职责、应对突发、公共利益新闻舆论、处理本人已经合法公开的信息，以及法律行政法规规定的其他情形之一的，不得处理个人信息。</p>\\r\\n    <p>第二十八条、第二十九条：生物识别、医疗健康、金融账户、行踪轨迹，以及不满十四周岁未成年人的个人信息，属于敏感个人信息。没有特定目的、充分必要性和严格保护措施，并且没有取得个人单独同意的，不得处理。</p>\\r\\n    <p>此外还须遵守其他现行有效的法律、行政法规、监管规定，以及所使用模型的服务条款与滥用政策。</p>\\r\\n    <h3>5. 据此禁止的方向</h3>\\r\\n    <p>未授权进入。禁止把没有书面授权的单位、域名、地址、公网系统、生产业务或关键信息基础设施登记为靶标，禁止对其扫描、探测、侵入、控制或发包。对应刑法第二百八十五条第一款、第二款，网络安全法第二十九条、第三十三条。</p>\\r\\n    <p>破坏与恶意程序。禁止删除、修改、增加、干扰他人系统功能或其中的数据、应用程序；禁止制作、传播病毒、勒索程序或其他破坏性程序；禁止在信息或软件中设置恶意程序。对应刑法第二百八十六条第一款至第三款，网络安全法第五十条。</p>\\r\\n    <p>工具与帮助。禁止把本项目或本机提供给他人，用于侵入、非法控制或窃取数据；禁止明知对方在实施网络犯罪，仍提供程序、工具、技术支持、广告推广或支付结算。对应刑法第二百八十五条第三款、第二百八十七条之二，网络安全法第二十九条。</p>\\r\\n    <p>数据。禁止窃取、非法收集、超范围使用、泄露、出售或向他人提供业务数据、账号、口令和其他受保护数据。对应数据安全法第八条、第三十二条、第五十一条。</p>\\r\\n    <p>个人信息。禁止非法收集、使用、加工、传输、买卖、提供或公开他人个人信息；禁止过度收集；禁止以误导、欺诈、胁迫方式处理；禁止擅自处理生物识别、医疗健康、金融账户、行踪轨迹和儿童个人信息。对应刑法第二百五十三条之一第一款、第三款，网络安全法第四十六条，个人信息保护法第五条、第六条、第十条、第十三条、第二十八条、第二十九条。</p>\\r\\n    <p>诈骗与违法信息。禁止设立或利用网站、群组实施诈骗、传授犯罪方法、制作或销售违禁物品、管制物品；禁止发布此类信息；禁止利用计算机实施诈骗、盗窃、贪污、挪用公款、窃取国家秘密。对应刑法第二百八十七条、第二百八十七条之一第一款第（一）项至第（三）项，网络安全法第四十八条。</p>\\r\\n    <p>内容。禁止生成或传播危害国家安全、荣誉和利益的内容，禁止煽动颠覆、分裂，禁止恐怖主义、极端主义、民族仇恨，禁止暴力、淫秽色情、赌博，禁止编造虚假信息扰乱经济秩序和社会秩序，禁止侵害名誉、隐私、知识产权，禁止危害未成年人身心健康的内容。对应网络安全法第十三条第二款、第十四条。</p>\\r\\n    <p>结果扩散。演练中形成的记录、资产信息和文件，只留在书面授权写明的目标和期限里，不得交给无权获知的人，也不得改作授权以外的用途。</p>\\r\\n    <h3>6. 责任由使用者承担</h3>\\r\\n    <p>本项目依据 MIT 协议按现状提供。开发者不就完整性、安全性与适用性作保证。使用者对自己的下载、部署、运行、修改、传播，以及全部输入与输出，承担独立、完全的民事、行政及刑事法律责任。作者与贡献者不承担因滥用产生的直接、间接或连带责任。</p>\\r\\n    <p>勾选确认的是操作者本人，不能代替没有阅读本声明的人，也不能把别人的系统说成已经授权。</p>\\r\\n    <h3>7. 违约即终止授权</h3>\\r\\n    <p>一旦用于非法攻击、恶意活动或上述任一禁止方向，使用许可自该行为发生之日起自动终止，且不可撤销。必须立即停止使用，并销毁本项目的代码、脚本与衍生数据，依法承担责任。授权终止后，演练台不得继续打开或继续使用。</p>\\r\\n    <h3>8. 与 DeepSeek 官方的关系</h3>\\r\\n    <p>本项目是独立的开源项目，与 DeepSeek 官方或其关联主体没有隶属、商业合作、授权或官方背书。文中的「官方」只表示评测对象是使用者本机安装的官方 DeepSeek Harness 软件包，不代表 DeepSeek 官方开发、认可或担保本插件。</p>\\r\\n    <p>文末。倒计时结束、滚到这里并勾选全部三项，才表示你以本人身份认可本声明，并完成本次演练台授权。</p>",
			"drill.d756": "无法打开回退后的会话",
			"drill.d757": "回退后的会话没有打开",
			"drill.d758": "回退上一步",
			"drill.d759": "撤回最后一步已进行的对话，新会话接上之前的上下文；那句回到输入框再发送",
			"drill.d760": "回退上一轮",
			"drill.d761": "撤回上一整轮（含子代理）已进行的对话，新会话接上之前的上下文；那句回到输入框再发送",
			"drill.d762": "没有清掉之前发送的内容",
			"drill.d763": "回退失败: ",
			"drill.d764": "回退",
			"drill.d765": "回退失败: {error}",
			"drill.d766": "回退中…",
			"drill.e20001": "连不上接口，请确认 dsh 还在跑后 Ctrl+F5",
			"drill.k30001": "　·　由当日记录生成（非现场截图）",
			"drill.k30002": " 张，取代表图）",
			"drill.k30003": "被动",
			"drill.k30004": "主动",
			"drill.k30005": "收起本组",
			"drill.k30006": "内网",
			"drill.k30007": "内",
			"drill.k30008": "存活",
			"drill.k30009": "未记录（开放端口见下）",
			"drill.k30010": "内网资产",
			"drill.k30011": "收起资产详情",
			"drill.k30012": "收起全部 ▲",
			"drill.k30013": "该 C 段下暂无域名（切换到「全部 C 段」看全量）",
			"drill.k30014": "该 C 段下暂无 Web 资产",
			"drill.k30015": " 端口",
			"drill.k30016": "保存中…",
			"drill.k30017": "可用",
			"drill.k30018": "不可用",
			"drill.k30019": "本插件自带",
			"drill.k30020": "刷新中…",
			"drill.k30021": "不可用（有明确缺口）",
			"drill.k30022": "未装上的外部工具",
			"drill.k30023": "缓存于 ",
			"drill.k30024": "原始报文",
			"drill.k30025": "（明文直显，注意屏幕分享/录屏）",
			"drill.k30026": "当前：按目标聚合（先看哪台被打下什么）",
			"drill.k30027": "按目标聚合",
			"drill.k30028": " 个文件没挂 vuln_id，建议补上以便与漏洞对应。",
			"drill.k30029": "（推断）",
			"drill.k30030": " 分",
			"drill.k30031": " 条只在自己 VPS/自建服务器上，不算突破）",
			"drill.k30032": "内 ",
			"drill.k30033": "加载中…",
			"drill.k30034": " · 注意：不算跨越靶标边界",
			"drill.k30035": "（按目标路径自动匹配，请核对）",
			"drill.k30036": "生成中…",
			"drill.k30037": "\\n…（已截断，完整内容见落盘文件）",
			"drill.k30038": "按归类分组",
			"drill.k30039": "检索中…",
			"drill.k30040": "，并识别 nuclei-templates",
			"drill.k30041": "读取中…",
			"drill.k30042": "扫描中…",
			"drill.k30043": "留空；需要时填私钥绝对路径",
			"drill.k30044": "留空；需要时填 user@host",
			"drill.k30045": " 分（各项独立，不跨项累加）",
			"drill.k30046": " 次命中",
			"drill.k30047": "启用",
			"drill.k30048": " 次自建不计分）",
			"drill.k30049": " 次同服务重复命中不计分）",
			"drill.k30050": "内置得分点的名称由规则锁定",
			"drill.k30051": "内置得分点的分类由规则锁定（决定它属于面板哪一组）",
			"drill.k30052": "内置得分点的条款正文由规则锁定",
			"drill.k30053": "收起",
			"drill.k30054": "实时 · 5s",
			"drill.k30055": "agent 正在打这些资产",
			"drill.k30056": "加密马（冰蝎/哥斯拉，用户可直连）",
			"drill.k30057": "已复制",
			"drill.k30058": "检测中…",
			"drill.k30059": "环境变量 REDTEAM_MAX_AGENTS",
			"drill.k30060": "\\n安装方式：开发态（源码软链）",
			"drill.k30061": "\\n安装方式：包安装",
			"drill.k30062": "检查中…",
			"drill.k30063": "开发态（源码软链）",
			"drill.k30064": "开发态安装请用仓库流程升级",
			"drill.k30065": "先解决上面的阻塞项",
			"drill.k30066": "更新中…",
			"drill.k30067": "资产测绘",
			"drill.k30068": "环境适配",
			"drill.k30069": "智能体",
			"drill.k30070": "会话隧道",
			"drill.k30071": "漏洞战果",
			"drill.k30072": "攻击链",
			"drill.k30073": "得分目标",
			"drill.k30074": "报告",
			"drill.k30075": "知识库",
			"drill.k30076": "技能库",
			"drill.k30077": "创建中…",
			"drill.k30078": "演练台 · 全面浏览",
			"drill.k30079": "选择靶标",
			"drill.k30080": "：有新内容，点开看过红点就会消失",
			"drill.k30081": "回退中…",
			"drill.k30082": "提示词",
			"drill.k30083": "代码",
			"drill.k30084": "工具",
			"drill.k30085": "0.1.5 兼容",
			"drill.k30086": "0.2.0 兼容",
			"status.active": "Active",
			"status.needRestart": "Reload needed",
			"status.partial": "Partially skipped",
			"status.waiting": "Items pending",
			"counts.applied": "Live",
			"counts.pending": "Pending",
			"counts.skipped": "Skipped by design",
			"counts.na": "Not applicable",
			"counts.failed": "Failed",
			"counts.na.hint": "{n} not applicable — this host has no such target, so they are not listed below",
			"counts.denominator.display": "{n} display rows (display basis)",
			"counts.denominator.raw.label": "Basis",
			"counts.denominator.raw": "By patch id (raw): {na} not-applicable items excluded from display rows",
			"btn.retry": "Retry",
			"load.empty": "Nothing to show yet",
			"conclusion.ok": "All live: {applied} live, {skipped} skipped by design, {na} not applicable",
			"conclusion.pending": "{pending} pending — {applied} live · {skipped} skipped by design · {na} not applicable",
			"conclusion.restart": "Written to disk; restart the host to load it — {applied} live · {skipped} skipped by design · {na} not applicable",
			"conclusion.failed": "{failed} failed — {applied} live · {pending} pending · {skipped} skipped by design · {na} not applicable",
			"plain.shim.label": "Command entry",
			"plain.shim.patched": "{patched} of {present} taken over; `dsh` runs through this plugin",
			"plain.shim.original": "{present} file(s) still original; this plugin does not own the `dsh` command",
			"plain.shim.none": "No `dsh` command file found: this install has no CLI entry",
			"plain.backup.label": "Original files backup",
			"plain.backup.yes": "present — you can roll back",
			"plain.backup.no": "none yet — nothing has been applied on this install",
			"plain.preset.registered": "Registered with the host; available after a restart",
			"plain.preset.broken": "Registered, but the host ignored one field ({broken})",
			"plain.preset.running": "Registering…",
			"plain.preset.failed": "Registration did not succeed; a host restart will retry",
			"plain.preset.timeout": "Timed out waiting for the host; it retries after a restart",
			"plain.preset.none": "No declaration yet; it is written once after a host restart",
			"tab.list.label": "Settings views",
			"tab.status": "Status",
			"tab.patches": "Patches",
			"tab.config": "Configuration",
			"tab.skills": "Skills",
			"tab.diagnostics": "Diagnostics",
			"head.checkUpdate": "Check for updates",
			"head.restart": "Restart host",
			"overview.patches": "Patches",
			"overview.skipped": "skipped",
			"overview.backup": "Backup",
			"overview.backup.yes": "yes",
			"overview.backup.no": "no",
			"overview.lastApplied": "Last apply",
			"overview.never": "never",
			"conclusion.ok": "{n} skipped by design; the rest is live",
			"conclusion.restart": "Changes pending a host restart",
			"conclusion.failed": "{n} failed — expand the patch section",
			"foot.logs": "Logs",
			"foot.config": "Config",
			"foot.runtime": "Runtime: {rev} · {asar}",
			"foot.asar.sealed": "asar sealed",
			"foot.asar.unpacked": "unpacked",
			"skill.empty": "No skills loaded",
			"skill.empty.hint": "directory missing or not readable",
			"policy.foot": "Changes apply automatically; items that need a host reload will prompt a restart.",
			"section.patches": "Patches",
			"section.hooks": "Hook guards",
			"section.policy": "Approval policy & disclaimer",
			"section.update": "Version & updates",
			"section.danger": "Danger zone",
			"overview.asar": "Host form",
			"overview.backup.hint": "Original files kept for rollback",
			"overview.pending": "{n} pending",
			"patch.empty": "No patches to show",
			"patch.empty.hint": "The host code directory was not located, or the patch table is empty",
			"update.off": "Updates are off: {reason}",
			"action.revert": "Revert patches",
			"action.revert.hint": "Roll the host files back to the pre-install backups; the plugin itself stays.",
			"action.uninstall": "Uninstall plugin",
			"action.uninstall.hint": "Restore the host and delete every plugin file. This cannot be undone.",
			"uninstall.ack": "I understand this restores the host and deletes this plugin",
			"section.audit": "Audit trail",
			"audit.hint": "Read-only: last run, its result, and the integrity check.",
			"audit.lastRun": "Last run",
			"audit.lastRun.none": "No apply run recorded yet",
			"audit.events": "Events",
			"audit.layers": "Layer results",
			"audit.check": "Integrity",
			"audit.check.ok": "Passed ({files} files; no gaps, no bad lines)",
			"audit.check.bad": "Problems: {gaps} missing seqs, {badLines} bad lines",
			"audit.check.unavailable": "No audit file to check yet",
			"audit.files": "Landing",
			"audit.run.ph": "runId, e.g. apply-20261025T101548Z-10fe",
			"audit.run.btn": "Inspect run",
			"audit.refresh": "Refresh",
			"audit.run.rows": "This run",
			"audit.run.counts": "{audit} audit rows · {diag} diagnostic rows",
			"audit.run.cross": "Track agreement",
			"audit.run.cross.value": "{matched} of {checked} runs matched",
			"audit.run.cross.none": "No comparable run",
			"audit.cards": "Run cards",
			"audit.cards.none": "No card for this run",
			"audit.run.missing": "No such run: {runId}",
			"audit.tail.empty": "No audit record on this machine yet",
			"audit.tail.empty.hint": "It shows up here after one /purge apply",
			"audit.err": "Read failed: {error}",
			"section.health": "Health",
			"health.hint": "Read-only: install fingerprint, copy consistency, preset registration.",
			"health.install": "Install fingerprint",
			"health.install.missing": "No install fingerprint on this machine",
			"health.install.counts": "{drifted} drifted · {missing} missing · {added} added",
			"health.copy": "Copy fingerprint",
			"health.copy.same": "Consistent",
			"health.copy.unknown": "Undeterminable: no install record",
			"health.copy.diff": "Mismatch ({n})",
			"health.preset": "Preset registration",
			"health.preset.none": "No declaration",
			"section.logs": "Logs",
			"logs.hint": "Read-only: where each track lands and how many generations it keeps.",
			"logs.track.audit": "Audit track",
			"logs.track.diag": "Diagnostic track",
			"logs.track.internal": "Internal track",
			"logs.rule.daily": "archived by day",
			"logs.rule.roll": "keeps {generations} generations · {size} each",
			"logs.absent": "not on disk yet",
			"skills.library.official": "user dir",
			"skills.library.redteam": "bundled",
			"skills.shadowed": "{n} shadowed",
			"skills.readonly": "read-only",
			"skills.filter.all": "All",
			"skills.filter.empty": "Nothing in this library",
			"drill.note": "Note",
			"drill.t40open": "Open knowledge directory",
			"drill.t40skillsEmpty": "No skills in this library yet. Drop a skill directory into the knowledge folder and refresh.",
			"drill.t40skillsFiltered": "No skills match the current filter. Clear it and look again.",
			"drill.t40clearFilter": "Clear filters",
		};

		/* 样式三层：令牌 → 原语 → 布局，装配顺序就是级联顺序，最后由 purge-css 拼成 PURGE_CSS。 */
		const PURGE_CSS_TOKENS = `/* 全文档作用域的一只桶：字号与间距刻度 + 语义色。
   刻度（四档字号、六档间距）收编前挂在 .dshp-root--main,.rt-full 那个桶里，只有演练台
   的主区与全面浏览两棵根看得到；设置页的面板不在这两棵根里，取不到刻度就只能写裸值
   （面板容器的 gap 与 padding 就是这么来的），裸值基线因此降不下去。提到 :root 之后
   全文档可见，取值一个未改 —— 可见范围是这一批唯一变化的东西。
   两类声明同在这一条 :root 里而不是各开一条：这条就是「全文档作用域」那只桶，进了它
   就全文档可见。层级令牌另起一块，只因为它们带着一段解释取值来源的长注释。 */
:root{--dshp-fs-page:20px;--dshp-fs-section:16px;--dshp-fs-body:13.5px;--dshp-fs-meta:12px;--dshp-sp-1:4px;--dshp-sp-2:8px;--dshp-sp-3:12px;--dshp-sp-4:16px;--dshp-sp-5:20px;--dshp-sp-6:32px;--dshp-c-text:var(--dsw-alias-label-primary, #1a1916);--dshp-c-text-muted:var(--dsw-alias-label-secondary, #64748b);--dshp-c-bg-page:var(--dsw-alias-bg-layer-1, #1a1a1a);--dshp-c-bg-card:var(--dsw-alias-bg-layer-2, #f4f1ea);--dshp-c-scrim:color-mix(in srgb,var(--dsw-alias-label-primary,#1a1916) 62%,transparent);--dshp-c-border:var(--dsw-alias-border-l1, #c9c3b6);--dshp-c-warn:var(--dsw-alias-state-warn-primary, #f59e0b);--dshp-c-danger:var(--dsw-alias-state-error-primary, #ef4444);--dshp-c-info:var(--dsw-alias-label-brand, #0ea5e9);--dshp-c-brand:var(--dsw-alias-brand-primary, #3f6b52);--dshp-c-accent:var(--dsw-alias-label-brand, #8b5cf6)}
.dshp-root{--dshp-sans:"Microsoft YaHei UI","PingFang SC","Noto Sans SC","Source Han Sans SC",system-ui,sans-serif;--dshp-display:var(--dshp-sans);--dshp-mono:"Cascadia Mono","JetBrains Mono",Consolas,"Courier New",monospace;--dshp-ease:cubic-bezier(.16,1,.3,1);--dshp-ok:var(--dshp-c-text-muted);--dshp-warn:var(--dshp-c-text-muted);--dshp-bad:var(--dshp-c-text-muted)}
.dshp-root{--dshp-bg:transparent;--dshp-paper:color-mix(in srgb,var(--dsw-alias-bg-layer-1,var(--dshp-c-text-muted)) 74%,transparent);--dshp-ink:var(--dsw-alias-label-primary,var(--dshp-c-text));--dshp-mute:color-mix(in srgb,var(--dsw-alias-label-primary,var(--dshp-c-text)) 74%,var(--dsw-alias-label-secondary,var(--dshp-c-text)));--dshp-line:color-mix(in srgb,var(--dsw-alias-border-l1,var(--dshp-c-text-muted)) 78%,transparent);--dshp-fill:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dshp-c-text)) 14%,transparent);--dshp-accent:var(--dsw-alias-brand-primary,var(--dshp-c-text));--dshp-accent-soft:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dshp-c-text)) 18%,transparent);--dshp-ok:var(--dshp-c-text);--dshp-warn:var(--dshp-c-text);--dshp-bad:var(--dshp-c-text)}
@keyframes dshp-pulse{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* 层级令牌：数字只表达插件内部的先后，不跨层比较。
   页面根（.dshp-root / .dshp-page）与浮层根（.dshp-modal-bg / .dshp-restart-mask /
   .dshp-auth-mask / .dshp-rewind-menu）各自 isolation:isolate 建隔离的层叠
   上下文，层内 z-index 只与同一层里的其他值互比，大小不再有全局含义。
   跨到宿主那一侧的只有一个数：--dshp-z-boundary 只挂在 rewind 菜单上 —— 它是唯一直接
   portal 到 document.body 的插件节点，兄弟就是宿主 DOM。取值 2147483000 是收编前那处
   z-index 的实测值：换写法不改取值，外观才逐像素不变；它比 CSS 层级上限 2147483647 低
   647，宿主要再压一层仍有整数余量。其余八个令牌同样保留收编前的数值，理由一样。
   声明挂在 :root 而不是 .dshp-root 上：rewind 菜单在 .dshp-root 之外，拿不到那份继承。 */
:root{--dshp-z-boundary:2147483000;--dshp-z-restart:12000;--dshp-z-gate:10200;--dshp-z-auth:10100;--dshp-z-launch:10040;--dshp-z-modal:80;--dshp-z-resize:60;--dshp-z-head:3;--dshp-z-tabs:2}
`;
		const PURGE_CSS_COMPONENTS = `.dshp-switch{display:inline-flex;border:1px solid var(--dshp-line);border-radius:999px;overflow:hidden;background:var(--dshp-paper)}
.dshp-switch button{appearance:none;border:0;background:transparent;color:var(--dshp-mute);font:12px/1 var(--dshp-sans);padding:6px 14px;cursor:pointer}
.dshp-switch button.is-on{background:var(--dshp-accent-soft);color:var(--dshp-ink)}
.dshp-switch button:focus-visible{outline:2px solid var(--dshp-accent);outline-offset:-2px}
.dshp-panel{border:1px solid var(--dshp-line);background:var(--dshp-paper);border-radius:10px;padding:18px 18px 16px}
.dshp-kicker{font-family:var(--dshp-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dshp-mute);margin:0 0 4px}
.dshp-group{border:1px solid var(--dshp-line);margin:0 0 8px;background:var(--dshp-bg);border-radius:8px;overflow:hidden}
.dshp-count{font-family:var(--dshp-mono);font-size:12px;color:var(--dshp-mute)}
.dshp-table{width:100%;border-collapse:collapse;font-size:12.5px}
.dshp-table th{text-align:left;font-weight:500;font-size:11px;letter-spacing:.06em;color:var(--dshp-mute);padding:7px 12px;border-bottom:1px solid var(--dshp-line)}
.dshp-table td{padding:8px 12px;border-bottom:1px solid var(--dshp-line);vertical-align:middle}
.dshp-table tr:last-child td{border-bottom:0}
.dshp-table tr.is-on td{background:var(--dshp-accent-soft)}
.dshp-id{font-family:var(--dshp-mono);opacity:.75;width:42px}
.dshp-field:focus,.dshp-area:focus{outline:none;border-color:var(--dshp-accent);box-shadow:0 0 0 3px var(--dshp-accent-soft)}
.dshp-field:disabled,.dshp-area:disabled{opacity:.5}
.dshp-restart-card .dshp-modal-ops{display:flex;justify-content:flex-end;gap:10px}
.dshp-restart-card .dshp-btn{min-height:38px;padding:0 16px;font-size:15px;font-weight:650;color:var(--dsw-alias-label-primary,var(--dshp-c-text));background:var(--dsw-alias-bg-layer-2,var(--dshp-c-bg-card));border:1px solid var(--dsw-alias-border-l1,var(--dshp-c-border))}
.dshp-cwd-badge{font-family:var(--dshp-mono);font-size:10px;letter-spacing:.04em;text-transform:uppercase;padding:1px 7px;border-radius:99px;border:1px solid var(--dshp-line);color:var(--dshp-mute);line-height:1.6}
.dshp-auth-mask{position:fixed;inset:0;z-index:var(--dshp-z-auth);isolation:isolate;background:color-mix(in srgb, var(--dshp-c-scrim) 62%, transparent);display:flex;align-items:center;justify-content:center;padding:20px;pointer-events:auto}
.dshp-env-gate{z-index:var(--dshp-z-gate)}
.dshp-auth-modal{width:min(680px,100%);max-height:min(88vh,820px);display:flex;flex-direction:column;gap:10px;padding:16px;border:1px solid var(--dsw-alias-border-l1,var(--dshp-c-border));border-radius:12px;background:var(--dsw-alias-bg-layer-1,var(--dshp-c-bg-page));color:var(--dsw-alias-label-primary,var(--dshp-c-text-muted))}
.dshp-auth-modal h2{margin:0;font-size:16px;font-weight:600}
.dshp-auth-warn{padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--dshp-c-warn) 16%,transparent);border:1px solid color-mix(in srgb,var(--dshp-c-warn) 42%,transparent);color:var(--dsw-alias-label-primary,var(--dshp-c-text));font-size:13px;line-height:1.55}
.dshp-auth-legal{overflow:auto;height:300px;margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,var(--dshp-c-border));border-radius:8px;background:var(--dshp-c-bg-page);font-size:13px;line-height:1.55}
.dshp-auth-legal h3{margin:14px 0 4px;font-size:13px}
.dshp-auth-legal h3:first-child{margin-top:0}
.dshp-auth-legal p{margin:0 0 8px}
.dshp-auth-checks{display:flex;flex-direction:column;gap:8px;font-size:13px}
.dshp-auth-checks label{display:flex;gap:8px;align-items:flex-start}
.dshp-auth-checks label.locked{opacity:.45}
.dshp-auth-ops{display:flex;justify-content:flex-end;gap:8px}
.dshp-auth-ops button{appearance:none;border:1px solid var(--dsw-alias-border-l1,var(--dshp-c-border));background:transparent;color:inherit;border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit}
.dshp-auth-ops button.primary{background:var(--dshp-c-bg-page);border-color:var(--dshp-c-border)}
.dshp-auth-ops button:disabled{opacity:.45;cursor:default}
.dshp-icon-btn{appearance:none;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dshp-c-border)) 45%,transparent);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;font:13px/1 inherit;white-space:nowrap;flex:0 0 auto}
.dshp-icon-btn:hover{border-color:var(--dsw-alias-brand-primary,var(--dshp-c-border));background:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dshp-c-bg-page)) 12%,transparent);color:var(--dsw-alias-label-primary,currentColor)}
.dshp-icon-btn.on{border-color:var(--dsw-alias-brand-primary,var(--dshp-c-border));color:var(--dsw-alias-brand-primary,var(--dshp-c-text-muted));background:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dshp-c-bg-page)) 16%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dshp-c-bg-page)) 28%,transparent)}
.dshp-hbtn{appearance:none;display:inline-flex;flex:0 0 auto;align-items:center;gap:6px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dshp-c-border)) 55%,transparent);background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;font:12px/1 inherit;padding:5px 10px;border-radius:8px;white-space:nowrap}
.dshp-hbtn:hover{border-color:var(--dsw-alias-brand-primary,var(--dshp-c-border));background:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dshp-c-bg-page)) 12%,transparent);color:var(--dsw-alias-label-primary,currentColor)}
.dshp-hbtn.on{border-color:var(--dsw-alias-brand-primary,var(--dshp-c-border));color:var(--dsw-alias-brand-primary,var(--dshp-c-text-muted));background:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dshp-c-bg-page)) 18%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dshp-c-bg-page)) 32%,transparent)}
.dshp-tab-chip{display:inline-flex;align-items:flex-end;flex:0 0 auto}
.dshp-tab-btn{appearance:none;position:relative;border:none;background:transparent;cursor:pointer;padding:0 0 9px;font:500 13px/16px inherit;color:var(--dsw-alias-label-tertiary,currentColor);white-space:nowrap}
.dshp-tab-btn:hover{color:var(--dsw-alias-label-primary,currentColor)}
.dshp-tab-btn.on{color:var(--dsw-alias-brand-primary,var(--dshp-c-text-muted))}
.dshp-tab-btn.on:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary,var(--dshp-c-bg-page))}
.dshp-badge{display:inline-flex;align-items:center;padding:1px 7px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#f4f1ea));color:var(--dsw-alias-label-secondary,var(--dshp-c-text-muted));font-size:11px;line-height:1.6;white-space:nowrap;font-variant-numeric:tabular-nums}
/* 字段：标签 + 控件 + 说明。wide 时控件换到下一行占满。 */
.dshp-field{box-sizing:border-box;font:13px/1.55 var(--dshp-mono);background:var(--dshp-bg);color:var(--dshp-ink);border:1px solid var(--dshp-line);border-radius:8px;width:auto;min-width:140px;display:flex;flex-direction:column;gap:6px;padding:12px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,var(--dshp-c-border))}
.dshp-field:last-child{border-bottom:0}
.dshp-field__head{display:flex;align-items:center;justify-content:space-between;gap:16px;min-width:0}
.dshp-field__label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary,var(--dshp-c-text))}
.dshp-field__hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,var(--dshp-c-text-muted))}
.dshp-field__ops{display:flex;align-items:center;gap:8px;margin-top:2px}
/* 空态：左对齐的一行，不居中、不占固定高度。 */
.dshp-empty{padding:28px 12px;text-align:center;margin:8px 0 0;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary,var(--dshp-c-text-muted))}
.dshp-empty__hint{color:var(--dsw-alias-label-tertiary,var(--dshp-c-text-muted))}

/* 说明与结果提示 */
.dshp-hint{margin:6px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,var(--dshp-c-text-muted))}
.dshp-note{display:block;margin:8px 0 0;font-size:12px;line-height:1.5}
.dshp-note.is-ok{color:var(--dsw-alias-label-secondary,var(--dshp-c-text-muted))}
.dshp-note.is-error{color:var(--dsw-alias-state-error-primary,var(--dshp-c-danger))}
.dshp-conclusion{margin:12px 0 0;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,var(--dshp-c-text-muted))}
.dshp-btn-danger{background:transparent;border-color:color-mix(in srgb,var(--dshp-bad) 40%,var(--dshp-line));color:var(--dsw-alias-state-error-primary,var(--dshp-c-danger))!important}
.dshp-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;height:28px;min-height:34px;padding:0 10px;border-radius:var(--dsw-radius-sm,6px);border:.5px solid var(--dsw-alias-border-l3,var(--dshp-c-border));background:transparent;color:var(--dsw-alias-label-primary,var(--dshp-c-text));font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:background .15s var(--dshp-ease),opacity .15s var(--dshp-ease)}
.dshp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dshp-fill))}
.dshp-btn:disabled{opacity:.4;cursor:not-allowed}
.dshp-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dshp-accent));outline-offset:1px}
.dshp-btn.is-primary{background:var(--dsw-alias-button-primary-fill,var(--dshp-accent-soft));color:var(--dsw-alias-label-primary-foreground,var(--dshp-c-text));border-color:transparent}
.dshp-btn.is-danger{color:var(--dsw-alias-state-error-primary,var(--dshp-c-danger));border-color:var(--dsw-alias-border-l3,var(--dshp-c-border))}

/* 输入：与宿主 SettingsValueField 的输入同尺寸。 */
.dshp-input{box-sizing:border-box;width:100%;height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm,6px);border:.5px solid var(--dsw-alias-border-l3,var(--dshp-c-border));background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,transparent));color:var(--dsw-alias-label-primary,var(--dshp-c-text));font:inherit;font-size:12px;line-height:1.5}
.dshp-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,var(--dshp-accent))}
.dshp-area{box-sizing:border-box;width:100%;min-height:120px;padding:8px 10px;resize:vertical;border-radius:var(--dsw-radius-sm,6px);border:.5px solid var(--dsw-alias-border-l3,var(--dshp-c-border));background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,transparent));color:var(--dsw-alias-label-primary,var(--dshp-c-text));font:12.5px/1.6 var(--dshp-mono)}
.dshp-area:focus{outline:none;border-color:var(--dsw-alias-brand-primary,var(--dshp-accent))}

/* 骨架屏 */
.dshp-skel{height:12px;background-size:200% 100%;border-radius:var(--dsw-radius-sm,6px);background:var(--dshp-fill);animation:dshp-pulse 1.2s ease-in-out infinite}
.dshp-link{appearance:none;padding:0;border:0;background:none;color:var(--dsw-alias-label-primary,var(--dshp-c-text));font:inherit;font-size:12px;line-height:1.5;cursor:pointer;text-decoration:underline;text-underline-offset:2px;text-decoration-color:var(--dsw-alias-border-l2,var(--dshp-c-border))}
.dshp-link:hover{text-decoration-color:var(--dsw-alias-label-secondary,var(--dshp-c-text-muted))}
.dshp-link:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dshp-accent));outline-offset:2px;border-radius:2px}
.dshp-dot{display:inline-block;flex:0 0 auto;border-radius:50%}
/* 模态：宿主之外唯一需要自带容器的场景。 */
.dshp-modal-bg{position:fixed;inset:0;z-index:var(--dshp-z-modal);isolation:isolate;display:flex;align-items:center;justify-content:center;padding:20px;background:var(--dshp-c-scrim)}
.dshp-modal{width:min(420px,100%);display:flex;flex-direction:column;gap:12px;padding:20px;border:1px solid var(--dshp-line);border-radius:var(--dsw-radius-panel,12px);background:var(--dsw-alias-bg-layer-2,var(--dshp-c-bg-card));color:var(--dsw-alias-label-primary,var(--dshp-c-text));box-shadow:var(--dsw-elevation-prominent)}
.dshp-modal h4{margin:0;font-family:var(--dshp-display);font-size:15px;font-weight:600;line-height:1.5}
.dshp-modal p{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary,var(--dshp-c-text-muted))}
.dshp-modal-ops{display:flex;justify-content:flex-end;gap:8px}
.dshp-restart-mask{position:fixed;inset:0;z-index:var(--dshp-z-restart);isolation:isolate;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dshp-c-scrim);font-family:"Yu Gothic UI","Hiragino Sans GB","Source Han Sans SC","Microsoft YaHei UI",system-ui,sans-serif}
.dshp-restart-card{width:min(420px,100%);box-sizing:border-box;display:flex;flex-direction:column;gap:14px;padding:22px;border:1px solid var(--dsw-alias-border-l1,var(--dshp-c-border));border-radius:var(--dsw-radius-panel,12px);background:var(--dsw-alias-bg-layer-2,var(--dshp-c-bg-card));color:var(--dsw-alias-label-primary,var(--dshp-c-text));box-shadow:var(--dsw-elevation-prominent)}
.dshp-restart-card h4{margin:0;font-family:inherit;font-size:16px;font-weight:600;line-height:1.5;color:inherit}
.dshp-restart-card p{margin:0;font-size:13px;font-weight:500;line-height:1.6;color:var(--dsw-alias-label-secondary,var(--dshp-c-text-muted))}

/* 空态：左对齐、限宽（一行说明别拉满 1400px）、最多一个动作。路径不进正文。 */
.dshp-root--main .rt-empty,.rt-full .rt-empty{text-align:left;max-width:68ch;margin:0;padding:var(--dshp-sp-4) 0;font-size:var(--dshp-fs-body);line-height:1.7;color:var(--dsw-alias-label-secondary)}
.rt-empty__action{margin-top:var(--dshp-sp-3)}
.rt-empty__path{margin-top:var(--dshp-sp-2);font-family:var(--dshp-mono);font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
/* 「注意」块：替代原先的警告符号文案。带边框是为了和正文分开，不用彩色底。 */
.rt-caution{display:flex;gap:var(--dshp-sp-2);align-items:baseline;padding:var(--dshp-sp-3) var(--dshp-sp-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-size:var(--dshp-fs-meta);line-height:1.7;color:var(--dsw-alias-label-secondary)}
.rt-caution__label{flex:none;font-weight:600;color:var(--dsw-alias-state-warn-primary)}
/* 数据密集页的表格原语：发丝线分隔、不套卡片；列宽由 tableColumns 生成（表头/行/展开行同一份）。 */
.rt-grid{display:flex;flex-direction:column;min-width:0}
.rt-grid__head,.rt-grid__row{display:grid;gap:8px;align-items:center;height:32px;padding:0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.rt-grid__head{height:36px;border-bottom-color:var(--dsw-alias-border-l1)}
/* 数字列靠右对齐到单元格末端（列宽由列定义给，末列不吃剩余空间） */
.rt-grid__row .rt-grid__cell--num,.rt-grid__head .rt-grid__cell--num{justify-self:end}
.rt-grid__row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rt-grid__row.is-clickable{cursor:pointer}
.rt-grid__row:last-child{border-bottom:0}
.rt-grid__cell{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px}
.rt-grid__cell--head{font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary)}
.rt-grid__cell--num{font-family:var(--dshp-mono);font-variant-numeric:tabular-nums;text-align:right}
.rt-grid__extra{grid-column:1/-1;min-width:0;padding:2px 0 10px}
.rt-prose{max-width:68ch;line-height:1.65}
.rt-prose p,.rt-prose li{line-height:1.65}
.rt-prose code,.rt-prose pre{font-family:var(--dshp-mono);font-size:.92em}
.rt-prose pre,.rt-prose .rt-code{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:8px 10px;overflow:auto}
/* 选中态用强调色左边线，不用色块 */
.rt-seg.on,.rt-item.on,.rt-sess.on{border-left:2px solid var(--dsw-alias-brand-primary)}
/* 字段：标签在上，控件与提示同一条基线 */
.rt-field{display:flex;flex-direction:column;gap:var(--dshp-sp-2);min-width:0}
.rt-field__label{font-size:var(--dshp-fs-meta);font-weight:600;color:var(--dsw-alias-label-secondary)}
.rt-field__row{display:flex;align-items:center;gap:var(--dshp-sp-2);flex-wrap:wrap;min-width:0}
.rt-field__hint{font-size:var(--dshp-fs-meta);color:var(--dsw-alias-label-tertiary)}
.rt-field__err{font-size:var(--dshp-fs-meta);color:var(--dsw-alias-state-error-primary)}
/* 状态行：状态点 + 名称 + 现状 + 右侧动作 */
.rt-status{display:flex;flex-direction:column}
.rt-status__row{display:flex;align-items:center;gap:var(--dshp-sp-2);padding:var(--dshp-sp-2) 0;border-bottom:1px solid var(--dsw-alias-border-l2);min-width:0}
.rt-status__row:last-child{border-bottom:0}
.rt-status__dot{flex:none;width:8px;height:8px;border-radius:50%}
.rt-status__dot--ok{background:var(--dsw-alias-state-success-primary)}
.rt-status__dot--warn{background:var(--dsw-alias-state-warn-primary)}
.rt-status__dot--idle{background:var(--dsw-alias-state-idle-primary)}
.rt-status__name{flex:none;font-size:var(--dshp-fs-body);font-weight:600;color:var(--dsw-alias-label-primary)}
.rt-status__detail{flex:1 1 auto;min-width:0;font-size:var(--dshp-fs-meta);color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-status__action{flex:none}
/* 徽章三档：只用宿主语义状态 token，不自己造色名 */
.rt-badge{display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;font-size:11px;line-height:1.6;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.rt-badge--ok{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);color:var(--dsw-alias-state-success-primary)}
.rt-badge--warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);color:var(--dsw-alias-state-warn-primary)}
.rt-badge--idle{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
/* ── 按钮三层（主区）─────────────────────────────────────────────────
   一屏只该有一个主操作；底色取自 accent token 与页面底色混合 —— 主题的 accent 接近黑，
   直接铺就是两个黑块（刷新 + 保存）平级。这里把它压到「有颜色但不是纯黑」，层级靠
   底色/边框/无边框三层区分，而不是靠谁更黑。 */
.dshp-root--main .rt-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;
  height:34px;padding:0 14px;border-radius:8px;font-size:var(--dshp-fs-body);font-weight:500;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.dshp-root--main .rt-btn:hover{border-color:var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}
.dshp-root--main .rt-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshp-root--main .rt-btn:disabled{opacity:.45;cursor:default;background:transparent}
.dshp-root--main .rt-btn.rt-btn-primary{border-color:transparent;font-weight:600;
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 72%,var(--dsw-alias-bg-layer-1));
  color:var(--dsw-alias-bg-layer-1)}
.dshp-root--main .rt-btn.rt-btn-primary:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 84%,var(--dsw-alias-bg-layer-1))}
/* 文字操作：无边框、无底色，hover 才有一层很浅的底 */
.dshp-root--main .rt-btn.rt-btn-text{border-color:transparent;background:transparent;padding:0 8px;color:var(--dsw-alias-label-secondary)}
.dshp-root--main .rt-btn.rt-btn-text:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);color:var(--dsw-alias-label-primary)}
`;
		const PURGE_CSS_LAYOUT = `/* 页面根自成层叠上下文：页内层级（吸顶页头 / 页签、页内模态、缩放手柄）只在本页内
   互比，不与宿主页面同台；根自己不带数字，它跟着所在座位走。 */
.dshp-root{max-width:920px;display:flex;flex-direction:column;gap:18px;padding:16px;border-radius:12px;background:var(--dshp-bg);color:var(--dshp-ink);font-family:var(--dshp-sans);color-scheme:light;isolation:isolate}
.dshp-toolbar{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dshp-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.dshp-row+.dshp-row{margin-top:10px}
.dshp-ask{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;padding:10px 12px;border:1px solid var(--dshp-line);border-radius:8px;background:var(--dshp-bg);font-size:13px}
.dshp-active{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;margin-bottom:12px;border:1px solid var(--dshp-line);background:var(--dshp-bg);border-radius:8px}
.dshp-active b{font-family:var(--dshp-display);font-weight:500}
.dshp-split{display:flex;flex-direction:column;gap:12px}
.dshp-policy-row{display:flex;align-items:center;gap:10px}
.dshp-policy-row>label{font-size:12px;color:var(--dshp-mute);flex:0 0 auto}
.dshp-cwd-sub{margin-top:3px;font-family:var(--dshp-mono);font-size:11px;color:var(--dshp-mute);word-break:break-all}
@media (prefers-reduced-motion:reduce){.dshp-btn{transition:none}.dshp-skel{animation:none}}

/* ── 设置页设计系统 ──────────────────────────────────────────────────────
   依据宿主自己的设置面板：内容区宽约 560px，宿主用「发丝线分隔的行」而不是卡片，
   行标签 13px/500、说明 12px 三级色、动作在标题行右侧、空态左对齐内联。
   这一组 class 是整页唯一的排版语言；任何分节都不许自带容器、圆角或阴影。 */
.dshp-page{display:flex;flex-direction:column;gap:28px;width:100%;min-width:0;color:var(--dsw-alias-label-primary,var(--dshp-c-text));font-size:13px;line-height:1.5;isolation:isolate}

/* 页签面板的容器：页签内容不是页面根，所以它借不到 .dshp-page 那套「整页自成层叠上下文」
   的语义（那一条会凭空给每块面板建一层隔离，面板里又没有需要层内比先后的东西）。
   它只回答两件事 —— 面板自己的一圈纵向内边距，以及内容列的上限；字号与颜色从页面壳继承，
   不再写第二份。上限 760px 是设置内容区的口径，宽屏时居中、窄屏时铺满。
   宽度落在本层的自定义属性上：这个量只对面板成立，不进全局令牌层。
   纵向节奏与内边距改走刻度：分组间距取 sp-6（设置内容区的口径就是 760 列 + sp-6），
   内边距取 sp-4。面板容器写在这里时用的是 28px 与 16px —— 28px 是那两族刻度还关在
   演练台两棵根里、设置页取不到时的临时值，提到 :root 之后按刻度归位，分节间距因此
   从 28px 变成 32px。页面壳自己的 gap 仍是 28px，两者相差 4px 属于同一处待归位的取值。 */
.dshp-panel-body{--dshp-content-max:760px;display:flex;flex-direction:column;gap:var(--dshp-sp-6);width:100%;max-width:var(--dshp-content-max);min-width:0;margin:0 auto;padding:var(--dshp-sp-4) 0;box-sizing:border-box}

/* 页头：产品名 + 版本 + 状态 + 右侧动作，一行读完。 */
.dshp-page__head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.dshp-page__id{display:flex;align-items:baseline;gap:8px;min-width:0}
.dshp-product{margin:0;font-size:18px;font-weight:600;line-height:1.4;letter-spacing:-.01em;color:var(--dsw-alias-label-primary,var(--dshp-c-text))}
.dshp-page__status{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,var(--dshp-c-text-muted))}

/* 摘要：一行一项。四项并排的卡片在 560px 里必然折行，且与下方补丁表重复。 */
.dshp-summary{display:flex;flex-direction:column}
.dshp-summary>.dshp-row:first-child{padding-top:0}

/* 行：左标签、右取值，行间发丝线。整页唯一的「键值」形态。 */
.dshp-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:16px;min-width:0;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,var(--dshp-c-border))}
.dshp-row:last-child{border-bottom:0}
.dshp-row__label{flex:0 0 auto;min-width:76px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,var(--dshp-c-text-muted))}
.dshp-row__value{flex:1 1 auto;min-width:0;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary,var(--dshp-c-text));word-break:break-word;font-variant-numeric:tabular-nums}

/* 分节：标题行（标题 + 计数 + 右侧动作）、可选说明、内容。全页唯一的分节形态。 */
.dshp-section{display:flex;flex-direction:column;min-width:0}
.dshp-section__head{display:flex;align-items:center;gap:8px;min-height:32px}
.dshp-section__title{margin:0;font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary,var(--dshp-c-text))}
.dshp-section__count{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,var(--dshp-c-text-muted));font-variant-numeric:tabular-nums}
.dshp-section__gap{flex:1 1 auto}
.dshp-section__hint{margin:2px 0 8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,var(--dshp-c-text-muted))}


/* 展开行：补丁分节的「一层一行」。 */
.dshp-disc__head{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:8px 0;border:0;border-bottom:.5px solid var(--dsw-alias-border-l2,var(--dshp-c-border));background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dshp-disc__head:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dshp-accent));outline-offset:-2px;border-radius:var(--dsw-radius-sm,6px)}
.dshp-disc__title{flex:0 0 auto;font-size:13px;font-weight:500;line-height:1.5}
.dshp-disc__meta{flex:0 0 auto;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary,var(--dshp-c-text-muted));font-variant-numeric:tabular-nums}
.dshp-disc__gap{flex:1 1 auto}
.dshp-disc__chev{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,var(--dshp-c-text-muted));transition:transform .15s ease}
.dshp-disc__chev.is-open{transform:rotate(180deg)}
.dshp-disc__body{display:flex;flex-direction:column;padding:2px 0 10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2,var(--dshp-c-border))}
.dshp-disc__item{display:flex;align-items:baseline;gap:8px;padding:5px 0;font-size:12.5px;line-height:1.5;min-width:0;flex-wrap:wrap}
.dshp-disc__item-name{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary,var(--dshp-c-text))}
.dshp-disc__item-note{flex:1 1 100%;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary,var(--dshp-c-text-muted))}

/* 列表：并列条目（技能目录）。条目是一行，点开就地展开编辑器。 */
.dshp-list{display:flex;flex-direction:column}
.dshp-list__item{border-bottom:.5px solid var(--dsw-alias-border-l2,var(--dshp-c-border))}
.dshp-list__item:last-child{border-bottom:0}
.dshp-list__head{display:flex;align-items:baseline;gap:12px;width:100%;min-height:40px;padding:8px 0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;flex-wrap:wrap}
.dshp-list__head:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dshp-accent));outline-offset:-2px;border-radius:var(--dsw-radius-sm,6px)}
.dshp-list__name{flex:0 0 auto;font-size:13px;font-weight:500}
.dshp-list__meta{flex:1 1 auto;min-width:0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary,var(--dshp-c-text-muted));word-break:break-word}
.dshp-list__ops{flex:0 0 auto;display:flex;align-items:center;gap:12px}
.dshp-list__editor{display:flex;flex-direction:column;gap:8px;padding:2px 0 12px}


/* 动作条：右对齐，与分节标题的动作同侧。 */
.dshp-actions{text-align:right;white-space:nowrap;display:flex;align-items:center;gap:8px;flex-wrap:wrap}

/* 页脚：两个可点项 + 目录路径。 */
.dshp-page__foot{display:flex;flex-direction:column;gap:6px;padding-top:14px;border-top:.5px solid var(--dsw-alias-border-l2,var(--dshp-c-border))}
.dshp-foot__links{display:flex;align-items:center;gap:16px;flex-wrap:wrap}

/* 危险区：与上方内容隔开，但不另造容器。 */
.dshp-section--danger{padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l2,var(--dshp-c-border))}

@media (prefers-reduced-motion:reduce){.dshp-disc__chev{transition:none}.dshp-skel{animation:none}}

/* ── 演练台主区（侧栏图标 → 宿主 main 座位）──────────────────────────────
   方案 B：整页自然滚动，**整页只有一个滚动条**。
   主区没有浮窗祖先：那批内嵌布局覆盖选择器全挂在 .dshp-dock-body 下面（那个祖先零引用，
   覆盖层从未生效，已随零引用类名清理整块删掉）—— 主区更够不到它们，于是
   rt-dock.rt-embedded 的 height:100% 对 auto 高的父级等于 auto、rt-main 的 overflow:hidden
   把超出部分剪掉、rt-pane 的 overflow:auto 永远轮不到滚动 —— 真机症状就是「没有布局、
   也不能下滑、底部编辑器被切断」。
   这一组只对主区生效（dshp-root--main），不借用浮窗语义：浮窗是浮起来的卡片，主区是
   占满座位的一页，高度来源与滚动容器都不是一件事。内层一律不出滚动条，否则会出现
   「页面一个滚、内容一个滚」。标签栏跟着滚走是方案的已知代价，不做 sticky。 */
.dshp-root--main{height:100%;overflow:auto;box-sizing:border-box;padding:16px 20px;display:block;max-width:none;border-radius:0;background:transparent}
/* 比 rt-dock.rt-embedded（0,2,0）高一档：那份规则在演练台自己的 style 里、排在后面，
   打平会按顺序输给它，height:100% 又回到 auto。 */
/* 主区不是浮窗：基础规则里的 position:fixed + top/right + z-index 必须在主区被显式重置，
   否则它就是一个贴视口右上、按内容撑宽的固定层 —— 不参与页面流（没布局）、溢出（不能滚）、盖住宿主 UI。 */
.dshp-root.dshp-root--main>.rt-dock{position:relative;inset:auto;z-index:auto;height:auto;min-height:0;flex:none;width:100%;display:flex;flex-direction:column}
.dshp-root--main .rt-body{min-height:0;flex:none;display:flex;flex-direction:column;overflow:visible;max-width:1100px;width:100%;margin:0 auto}
.dshp-root--main .rt-main{min-height:0;overflow:visible}
.dshp-root--main .rt-pane{min-height:0;overflow:visible;padding:14px 16px}
.dshp-root--main .rt-table,.dshp-root--main .rt-chain{flex:none;max-height:none;overflow:visible}

/* ── 演练台设计语言（主区与「全面浏览」共用）──────────────────────────
   四档字号 + 六档间距 + 一个强调色。数字一律等宽（tabular-nums），密集列走等宽栈；
   颜色只取宿主语义 token，本层不新增任何字面色（check-style-tokens 扫的就是这一点）。
   强调色（brand primary）只给三处：主操作、当前页签、焦点环；其余全是中性层次。 */
/* 页头：标题 + 靶标选择 + 右侧动作。三段（页头 / 标签 / 内容）共用同一条左边缘 ——
   内边距只在最外层给一次，内层一律 0，否则「标签栏比内容右缩 12px」这种错位没人说得清。 */
/* 页头 / 标签栏 / 内容三段共用一条 1100 列：谁都不单独贴边，错位就没有来源。 */
.dshp-root--main .rt-head,.rt-full .rt-head{padding:0 0 var(--dshp-sp-3);gap:var(--dshp-sp-3);border-bottom:0;flex-wrap:wrap;max-width:1100px;width:100%;margin:0 auto}
.dshp-root--main .rt-title,.rt-full .rt-title{font-size:var(--dshp-fs-page);font-weight:600;letter-spacing:-.01em;line-height:1.3}
.dshp-root--main .rt-tabs,.rt-full .rt-tabs{padding:0;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap;max-width:1100px;width:100%;margin:0 auto}
.dshp-root--main .rt-tab,.rt-full .rt-tab{font-size:var(--dshp-fs-body);padding:var(--dshp-sp-2) 10px 9px;border-radius:0;background:transparent;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary)}
/* 焦点环用强调色 2px：浏览器默认那圈方框在深色标签栏上像故障 */
.dshp-root--main .rt-tab:focus-visible,.rt-full .rt-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,var(--dshp-accent));outline-offset:-2px;border-radius:4px}
.dshp-root--main .rt-tab.on,.rt-full .rt-tab.on{color:var(--dsw-alias-label-primary);font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary,var(--dshp-accent))}
.dshp-root--main .rt-body,.rt-full .rt-body{padding-top:var(--dshp-sp-4)}
/* 统计行：分组、数字大标签小、等宽数字。原来是一长串「C 段 0 资产 0（存活 0）端口 0」挤成一行。 */
.rt-stats{display:flex;flex-wrap:wrap;gap:var(--dshp-sp-6);padding:var(--dshp-sp-4) 0 0;border-top:1px solid var(--dsw-alias-border-l2)}
.rt-stat-group{display:flex;flex-wrap:wrap;gap:var(--dshp-sp-5)}
.rt-stat{display:flex;flex-direction:column;gap:2px;min-width:64px}
.rt-stat__num{font-size:20px;font-weight:600;line-height:1.15;font-variant-numeric:tabular-nums;font-family:var(--dshp-mono)}
.rt-stat__label{font-size:var(--dshp-fs-meta);color:var(--dsw-alias-label-tertiary);white-space:nowrap}
/* 页头与标签栏吸在视口顶：方案 B 整页滚动下唯一的吸面。
   表格头**不吸** —— 再叠一层就会三层互压；要固定表头得把表格自身限高内滚（改回方案 A），留到确有需要的批再评估。 */
.dshp-root--main{--rt-head-h:56px}
.dshp-root--main .rt-head{position:sticky;top:0;z-index:var(--dshp-z-head);background:var(--dsw-alias-bg-layer-1)}
.dshp-root--main .rt-tabs{position:sticky;top:var(--rt-head-h);z-index:var(--dshp-z-tabs);background:var(--dsw-alias-bg-layer-1)}
/* 说明与内容页（WP19）：section 层级、规则列表、角色网格、字段与状态行、三档徽章。
   区块之间 20px，标题 15 / 说明 12 / 正文 13.5 —— 与 WP17 的四档字号同一套刻度。 */
.rt-section--stack{display:flex;flex-direction:column;gap:var(--dshp-sp-3);padding:var(--dshp-sp-6) 0;border-top:1px solid var(--dsw-alias-border-l2)}
.rt-section--stack:first-child{border-top:0;padding-top:0}
.rt-section__title{margin:0;font-size:16px;font-weight:600;line-height:1.4;letter-spacing:-.005em}
.rt-section__hint{margin:0;font-size:var(--dshp-fs-meta);line-height:1.7;color:var(--dsw-alias-label-tertiary);max-width:70ch}
/* 硬约束用列表：一行一条，行首一个小标记 */
.rt-rule{display:flex;flex-direction:column;gap:var(--dshp-sp-2);margin:0;padding:0;list-style:none}
.rt-rule__item{position:relative;padding-left:16px;font-size:var(--dshp-fs-body);line-height:1.7;color:var(--dsw-alias-label-secondary)}
.rt-rule__item::before{content:"";position:absolute;left:4px;top:.65em;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
/* 六个角色：两列网格，窄屏一列 */
.rt-roles{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:var(--dshp-sp-2) var(--dshp-sp-5);max-width:960px}
.rt-roles__item{font-size:var(--dshp-fs-body);line-height:1.7;color:var(--dsw-alias-label-secondary);min-width:0}
/* 设置页的页签横条与摘要行：原先是 page.js 里的内联 token 样式（为了不越界写在片段里）。
   收编到这里 —— 设置页与演练台共用同一份 PURGE_CSS，同一视觉规则只留一处定义。
   横条只剩「横条」与「条内一组」两条：页内锚点导航删掉之后，它承载的是页签按钮，
   按钮自身的形状在 components.js，这里不再有标题与链接的样式。 */
.dshp-nav{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 10px;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dshp-nav__items{display:flex;flex-wrap:wrap;gap:4px 8px}
.dshp-summary__counts{display:flex;flex-wrap:wrap;gap:4px 16px;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dshp-count__label{font-size:12px;color:var(--dsw-alias-text-secondary)}
.dshp-count__value{font-size:15px;font-weight:600;margin-left:6px;font-variant-numeric:tabular-nums}
/* 统计行跟正文同一条左边缘：页脚与 .rt-body 是兄弟节点，不跟着它的 1100 约束就会贴视口最左。 */
.rt-foot{max-width:1100px;width:100%;margin:0 auto}
/* ── 流程页（WP28）──────────────────────────────────────────────────
   时间线：左侧一条 1px 竖线 + 每个节点一个小圆点，节点间距 12px。
   定义列表：term / description 两列，窄屏一行；长文限宽 68ch。
   报告阅读面：68ch、行高 1.65、代码块等宽浅底。 */
.rt-timeline{position:relative;padding-left:18px;display:flex;flex-direction:column;gap:var(--dshp-sp-3)}
.rt-timeline::before{content:"";position:absolute;left:5px;top:4px;bottom:4px;width:1px;background:var(--dsw-alias-border-l2)}
.rt-timeline>*{position:relative}
.rt-timeline>*::before{content:"";position:absolute;left:-17px;top:6px;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-border-l1)}
.rt-timeline>*:first-child::before{background:var(--dsw-alias-brand-primary)}
.rt-def{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:var(--dshp-sp-1) var(--dshp-sp-3)}
.rt-def>div{display:contents}
.rt-def b,.rt-def dt{color:var(--dsw-alias-label-secondary);font-weight:600;font-size:var(--dshp-fs-meta);white-space:nowrap}
.rt-def dd,.rt-def span{min-width:0;max-width:68ch;word-break:break-word}
@media (max-width:900px){.rt-def{grid-template-columns:1fr}.rt-def b,.rt-def dt{white-space:normal}}
/* 智能体页两栏：主栏 minmax(0,2fr)（规则 / 角色）+ 辅栏 minmax(240px,1fr)（并发占用 / 数量 / 注意块）。
   整宽单列时每节等权，读起来像一张清单；分栏之后「主体 / 辅体」一眼可分。 */
.rt-cols{display:grid;grid-template-columns:minmax(0,2fr) minmax(240px,1fr);gap:var(--dshp-sp-6);align-items:start}
.rt-cols__main,.rt-cols__aside{display:flex;flex-direction:column;min-width:0}
.rt-cols__aside{position:sticky;top:var(--rt-head-h);align-self:start}
@media (max-width:900px){.rt-cols{grid-template-columns:1fr}.rt-cols__aside{position:static}}
@media (max-width:900px){.rt-roles{grid-template-columns:1fr}}
`;

		const PURGE_CSS = PURGE_CSS_TOKENS + PURGE_CSS_COMPONENTS + PURGE_CSS_LAYOUT;

		function formatSize(bytes) {
			if (typeof bytes !== "number" || !isFinite(bytes) || bytes < 0) return "0 B";
			if (bytes < 1024) return bytes + " B";
			const kb = bytes / 1024;
			return (kb >= 100 ? Math.round(kb) : kb.toFixed(1)) + " KB";
		}
		/** 状态端点的字面量：lib/client-src 里只许出现这一次，装卸两端都从这里取。 */
		const PURGE_STATUS_PATH = "/dsh-purge/status";

		/**
		 * 取一次状态快照。
		 *
		 * 写成函数声明而不是内联箭头：`usePurgeStatus()` 与 `host.js` 的重启探活要共用
		 * 同一份引用，两处各写一个箭头就是两处「取数」。
		 */
		function fetchPurgeStatus() {
			return apiJson(PURGE_STATUS_PATH);
		}

		/**
		 * 只读取数：挂载时取一次，`retry()` / `refresh()` 再取一次。
		 *
		 * @param {Function} fetcher 取数函数；每轮从 ref 里读最新那个，所以它是不是
		 *   稳定引用不影响取数时机 —— 取数时机只由 `round` 与 `enabled` 决定。
		 * @param {{enabled?:boolean, emptyOf?:Function}} [options]
		 *   `enabled: false` 时先不取（技能页签要等共享快照给出网关结论再决定取不取）；
		 *   `emptyOf(data)` 为真时进 `empty` 相位，缺省表示「取到就算 ready」。
		 * @returns {{phase:string, data:any, error:string, refresh:Function, retry:Function}}
		 */
		function useAsyncResource(fetcher, options) {
			const opts = options || {};
			const enabled = opts.enabled !== false;
			const fetchRef = useRef(fetcher);
			fetchRef.current = fetcher;
			const emptyRef = useRef(opts.emptyOf || null);
			emptyRef.current = opts.emptyOf || null;
			const [phase, setPhase] = useState("loading");
			const [data, setData] = useState(null);
			const [error, setError] = useState("");
			const [round, setRound] = useState(0);
			const refresh = useCallback(() => setRound((n) => n + 1), []);

			useEffect(() => {
				if (!enabled) return undefined;
				/* 卸载后迟到的回包不许再 setState：切页签时面板留在树上，但页面本身会卸。 */
				let live = true;
				setPhase("loading");
				setError("");
				Promise.resolve()
					.then(() => (typeof fetchRef.current === "function" ? fetchRef.current() : null))
					.then((d) => {
						if (!live) return;
						const empty = emptyRef.current;
						setData(d === undefined ? null : d);
						setPhase(empty && empty(d) ? "empty" : "ready");
					})
					.catch((e) => {
						if (!live) return;
						setData(null);
						setError(String((e && e.message) || e));
						setPhase("error");
					});
				return () => { live = false; };
			}, [enabled, round]);

			return { phase: phase, data: data, error: error, refresh: refresh, retry: refresh };
		}

		/**
		 * 设置页的状态快照：整页一次，五页签共享。
		 *
		 * 页面壳拿它，页签只拿它当属性传下来 —— 页签里再调一次就是第二个快照，
		 * 同一屏两个时刻，而没有任何症状。
		 */
		function usePurgeStatus() {
			return useAsyncResource(fetchPurgeStatus);
		}

		/**
		 * 把一次只读结果灌进可编辑的本地状态（种子），只在第一次 `ready` 时灌一次。
		 *
		 * 配置页签的文本域是「读回来 → 用户在里面改 → POST」。刷新不该把用户正在编辑
		 * 的内容覆盖掉，所以灌值只做一次；之后的 `retry()` 只更新数据源。
		 *
		 * @param {string} phase 数据源相位
		 * @param {any} data 数据源内容
		 * @param {Function} seed 把内容折成本地状态初值
		 * @returns {[any, Function]} 与 `useState` 同形
		 */
		function useSeededValue(phase, data, seed) {
			const [value, setValue] = useState(null);
			const done = useRef(false);
			useEffect(() => {
				if (done.current || phase !== "ready" || data === null || data === undefined) return;
				done.current = true;
				setValue(seed(data));
			}, [phase, data]);
			return [value, setValue];
		}
		/** 取宿主原语；宿主没这个包或没这个导出时返回 null。 */
		function nativeP(name) {
			return primOf(name);
		}

		/**
		 * 分节：标题行（标题 + 计数 + 右侧动作）+ 内容。
		 *
		 * 所有分节都必须经由它，这样「标题在哪、动作在哪、内容从哪开始」全页只有一个答案。
		 */
		function Section(props) {
			return h("section", { className: "dshp-section", id: props.id, "aria-labelledby": props.id ? props.id + "-title" : undefined },
				h("div", { className: "dshp-section__head" },
					h("h3", { className: "dshp-section__title", id: props.id ? props.id + "-title" : undefined }, props.title),
					props.count != null ? h("span", { className: "dshp-section__count" }, props.count) : null,
					h("span", { className: "dshp-section__gap" }),
					props.action || null,
				),
				props.hint ? h("p", { className: "dshp-section__hint" }, props.hint) : null,
				props.children,
			);
		}

		/** 行：左标签、右取值。行间由 CSS 画发丝线，行自己不带边框。 */
		function Row(props) {
			return h("div", { className: "dshp-row" },
				h("span", { className: "dshp-row__label" }, props.label),
				h("span", { className: "dshp-row__value" }, props.value),
			);
		}

		/**
		 * 字段：标签 + 控件 + 说明。控件放右侧还是换行由 `wide` 决定。
		 *
		 * `wide` 用于文本域、开关这类需要整行的控件；默认是「标签左、控件右」的一行。
		 */
		function Field(props) {
			return h("div", { className: "dshp-field" + (props.wide ? " is-wide" : "") },
				h("div", { className: "dshp-field__head" },
					h("span", { className: "dshp-field__label" }, props.label),
					props.wide ? null : (props.action || null),
				),
				props.wide ? props.children : null,
				props.hint ? h("p", { className: "dshp-field__hint" }, props.hint) : null,
				props.wide ? (props.action ? h("div", { className: "dshp-field__ops" }, props.action) : null) : null,
			);
		}

		/**
		 * 空态：左对齐的一行说明，不居中、不占固定高度。
		 *
		 * 居中空态在有内容的页面里会与行式排版打架：整页左对齐，中间突然冒出一块居中文字，
		 * 读起来像报错。空态就是「这一节现在没有条目」这一句话，跟其它行一样从左边起。
		 */
		function Empty(props) {
			return h("p", { className: "dshp-empty" },
				props.text,
				props.hint ? h("span", { className: "dshp-empty__hint" }, " · " + props.hint) : null,
			);
		}

		/** 说明行：正文级提示，三级色。 */
		function Hint(props) {
			return h("p", { className: "dshp-hint" }, props.children);
		}

		/** 行内结果提示：kind=idle 时不占位。 */
		function Note(props) {
			const notice = props.notice;
			if (!notice || notice.kind === "idle" || !notice.text) return null;
			return h("p", { className: "dshp-note " + (notice.kind === "error" ? "is-error" : "is-ok") }, notice.text);
		}

		/**
		 * 骨架高度只留三档：一档按几行键值、一档按一个分节、一档按两块叠起来的面。
		 *
		 * 原先五个页签各自写死 48 / 56 / 64 / 72 / 96 / 120 六个数值：相差十几像素肉眼
		 * 分不出来，但改一次「读取中」的长相要翻五个文件，而且没人能说清 64 与 72 为什么不同。
		 * 三档里的 56 / 96 / 120 是原先就有的取值（分别来自诊断尾部、状态与补丁页、健康块），
		 * 48 / 64 / 72 就近归到 56 与 96 —— 骨架只是占位，不承担「内容多高」的承诺。
		 */
		const SKEL_SM = 56;
		const SKEL_MD = 96;
		const SKEL_LG = 120;

		/**
		 * 读取失败的措辞表：键是端点名，值是这个端点失败时该说哪一句。
		 *
		 * 为什么收成一张表：同一个「读取失败」原先在四个文件里各写一份内联小函数
		 * （`err.status` 两份、`err.override` 一份、`audit.err` 两份、技能端点那份带
		 * 404 判定的），改一句措辞要翻四处，抄漏一处也没有症状 —— 页面上只是两条读起来
		 * 略不一样的失败提示。措辞的唯一出处是这张表，`AsyncBlock` 按 key 取。
		 *
		 * `miss` 只有技能端点有：老宿主的 `/dsh-purge/skills` 回 404 / 405（接口还没加载），
		 * 那不是「读坏了」而是「重启后可用」，措辞要换一句。这条判定落在表里，调用点不再各判。
		 */
		const ASYNC_ERROR_TEXT = {
			status: { key: "err.status" },
			override: { key: "err.override" },
			audit: { key: "audit.err" },
			skills: { key: "err.skills", miss: "err.skills.needRestart" },
		};

		/**
		 * 按端点名取失败文案。
		 *
		 * 缺省走 `status`：没写 `errorKey` 的调用点拿到的就是 `err.status` 那一句，
		 * 与收表之前 `AsyncBlock` 的默认行为一致。
		 */
		function asyncErrorText(t, errorKey, message) {
			const entry = ASYNC_ERROR_TEXT[errorKey] || ASYNC_ERROR_TEXT.status;
			const msg = String(message || "");
			if (entry.miss && skillsRouteMissing({ message: msg })) return t(entry.miss);
			return t(entry.key, { error: msg });
		}

		/**
		 * 只读取数的五态外壳：loading / ready / empty / error + retry。
		 *
		 * 为什么要有它：每个页签原先各写一套「骨架 + 失败提示 + 重试按钮」，三处措辞与
		 * 三个骨架高度都不一样，同一个读取失败在页面上长得像三件事。现在五种状态只在
		 * 这里各画一次，页签只回答三件事 —— 空态说什么（`empty`）、读到了画什么
		 * （children）、读失败时用哪一句（`errorKey`，见 `ASYNC_ERROR_TEXT`）。
		 *
		 * 只有读取走这五态：写入的结果归各自的 `busy` / `notice`，混进来一次保存失败就会
		 * 把已经取到的内容打成读取失败。
		 */
		function AsyncBlock(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const resource = props.resource || {};
			const phase = resource.phase || "loading";
			if (phase === "error") {
				const word = asyncErrorText(t, props.errorKey, String(resource.error || ""));
				return h("div", { className: "dshp-actions", style: { justifyContent: "flex-start" } },
					h("p", { className: "dshp-note is-error" }, word),
					h(ActionButton, { tiny: true, onClick: () => { if (resource.retry) resource.retry(); } }, t("btn.retry")),
				);
			}
			if (phase === "loading") {
				return h("div", { className: "dshp-skel", style: { height: props.height || SKEL_MD } });
			}
			if (phase === "empty") return props.empty || h(Empty, { text: t("load.empty") });
			return props.children;
		}

		/**
		 * 状态点：tone ∈ ok | idle | bad。
		 *
		 * 宿主 StateDot 的状态词只有 done / warning / error / idle / ongoing；传别的词不报错，
		 * 只会让圆点失去颜色，所以必须映射。
		 */
		function StatusDot(props) {
			const Dot = nativeP("StateDot");
			if (Dot) {
				const state = props.tone === "ok" ? "done" : props.tone === "bad" ? "error" : "idle";
				return h(Dot, { state: state, size: 8 });
			}
			const color = props.tone === "ok"
				? "var(--dsw-alias-state-success-primary, #3f9a63)"
				: props.tone === "bad"
					? "var(--dsw-alias-state-error-primary, #ef4444)"
					: "var(--dsw-alias-state-idle-primary, #94a3b8)";
			return h("i", {
				className: "dshp-dot",
				"aria-hidden": "true",
				style: { background: color, width: 8, height: 8, borderRadius: "50%", flex: "0 0 auto" },
			});
		}

		/**
		 * 动作按钮：转调宿主 Button（原生 variant / size / 焦点环）。
		 *
		 * 宿主 variant 只有 ghost / primary / outline / toolbar，没有 danger；
		 * 销毁类动作靠 className 交给本插件样式补 —— 宿主不给危险动作用专门的配色。
		 */
		function ActionButton(props) {
			const Button = nativeP("Button");
			if (Button) {
				return h(Button, {
					variant: props.primary ? "primary" : "outline",
					size: props.tiny ? "sm" : "md",
					className: props.danger ? "dshp-btn-danger" : undefined,
					disabled: props.disabled,
					onClick: props.onClick,
					title: props.title,
				}, props.children);
			}
			return h("button", {
				type: "button",
				className: "dshp-btn" + (props.primary ? " is-primary" : "") + (props.danger ? " is-danger" : "") + (props.tiny ? " is-tiny" : ""),
				disabled: props.disabled,
				onClick: props.onClick,
				title: props.title,
			}, props.children);
		}

		/** 可选展开的行头：一行一节，点开看明细。 */
		function DisclosureHead(props) {
			const Chevron = nativeP("IconChevronDownOutlineRegular");
			return h("button", {
				type: "button",
				className: "dshp-disc__head",
				"aria-expanded": props.open ? "true" : "false",
				"aria-controls": props.bodyId,
				onClick: props.onToggle,
			},
				props.leading || null,
				h("span", { className: "dshp-disc__title" }, props.title),
				props.meta ? h("span", { className: "dshp-disc__meta" }, props.meta) : null,
				h("span", { className: "dshp-disc__gap" }),
				Chevron
					? h(Chevron, { size: 14, className: "dshp-disc__chev" + (props.open ? " is-open" : "") })
					: h("span", { className: "dshp-disc__chev" + (props.open ? " is-open" : "") }, props.open ? "▾" : "▸"),
			);
		}
		/* ── 页签壳：清单、id、焦点 ───────────────────────────────────────────── */

		/**
		 * 页签清单：键 → 文案键。顺序即渲染顺序，条目数就是页签数。
		 *
		 * 为什么要一个纯函数而不是散在渲染里：判据要在不渲染的前提下取到这份清单，页签按钮
		 * 与面板两处都从它派生 —— 清单是唯一来源，「多一个页签少一块面板」就不可能发生。
		 */
		function settingsTabItems() {
			return [
				{ key: "status", label: "tab.status" },
				{ key: "patches", label: "tab.patches" },
				{ key: "config", label: "tab.config" },
				{ key: "skills", label: "tab.skills" },
				{ key: "diagnostics", label: "tab.diagnostics" },
			];
		}

		/** 页签按钮的 id。两处各拼一次必然漂，所以只在这里拼。 */
		function settingsTabId(key) {
			return "dshp-tab-" + key;
		}

		/** 面板的 id：与 `settingsTabId` 成对，`aria-controls` 与 `aria-labelledby` 互相指。 */
		function settingsPanelId(key) {
			return "dshp-panel-" + key;
		}

		/**
		 * 页签按钮与面板的版式。
		 *
		 * 为什么用这几条现成的类名：页签栏用 `.dshp-nav` 这条横条（它本来就在
		 * `design/layout.js` 里，带下边线），页签按钮用 `.dshp-tab-btn` +
		 * 选中态 `.on`（`design/components.js`）；面板容器用 `.dshp-panel-body`
		 * —— 它承担面板的内边距与 760 内容上限，且不建层叠上下文，面板因此不再
		 * 借页面壳的 `.dshp-page`（借来的是整页语义，不是面板需要的）。片段里不写
		 * 字面尺寸与颜色 —— 那条纪律由 `test/settings-inline-style.test.mjs` 守着。
		 */
		function SettingsPage(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			translate = t;
			const [openErr, setOpenErr] = useState("");
			const [tab, setTab] = useState("status");
			/* 页签节点的引用：方向键切页签时焦点必须同移，否则连按方向键只在同一个按钮上来回。 */
			const tabNodes = useRef({});
			/* 整页唯一的数据入口：五个页签共用这一份快照，写成功后叫 refresh() 重取。 */
			const resource = usePurgeStatus();
			const s = resource.data;

			const openLocal = useCallback((kind) => {
				setOpenErr("");
				apiJson("/dsh-purge/open", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ kind: kind }),
				}).catch((e) => setOpenErr(String((e && e.message) || e)));
			}, []);

			const head = settingsHeadStatus(s || {});
			const statusText = t(head.key);
			const updateInfo = (s && s.update) || null;
			const version = (s && s.plugin_version) || (updateInfo && updateInfo.localVersion) || "";

			/* 点选与键盘切换走同一条路：先换选中态，再把焦点搬到新页签上。 */
			const pickTab = useCallback((key) => {
				setTab(key);
				const node = tabNodes.current[key];
				if (node && typeof node.focus === "function") node.focus();
			}, []);

			/* 方向键在页签之间循环，Home / End 跳首尾；其余键放行给宿主。 */
			const onTabKey = useCallback((event) => {
				const keys = settingsTabItems().map((item) => item.key);
				const last = keys.length - 1;
				const at = keys.indexOf(tab);
				let to = -1;
				if (event.key === "ArrowRight") to = at >= last ? 0 : at + 1;
				if (event.key === "ArrowLeft") to = at <= 0 ? last : at - 1;
				if (event.key === "Home") to = 0;
				if (event.key === "End") to = last;
				if (to < 0) return;
				event.preventDefault();
				pickTab(keys[to]);
			}, [tab, pickTab]);

			/* 一块页签一块内容：按 key 分派，五块都从同一份快照读。 */
			const panelBody = (key) => {
				if (key === "status") return h(StatusPanel, { t: t, resource: resource });
				if (key === "patches") return h(PatchesPanel, { t: t, resource: resource });
				if (key === "config") return h(ConfigPanel, { t: t, resource: resource, onChanged: resource.refresh });
				if (key === "skills") return h(SkillsPanel, { t: t, resource: resource });
				return h(DiagnosticsPanel, { t: t, resource: resource });
			};

			return h("div", { className: "dshp-page" },
				h("header", { className: "dshp-page__head" },
					h("div", { className: "dshp-page__id" },
						h("h2", { className: "dshp-product" }, "dsh-purge"),
						version ? h("span", { className: "dshp-badge" }, "v" + version) : null,
					),
					h("span", { className: "dshp-page__status" },
						h(StatusDot, { tone: head.tone, title: statusText }),
						h("span", null, statusText),
					),
					h("span", { style: { flex: 1 } }),
				),

				/* 页签栏：宿主左栏加不了目录，所以目录长在页内 —— 但一次只露一块内容。
				   横条与按钮都用现成类名（`design/layout.js` 与 `design/components.js` 里已有）。 */
				h("div", {
					className: "dshp-nav",
					role: "tablist",
					"aria-label": t("tab.list.label"),
					onKeyDown: onTabKey,
				},
					h("span", { className: "dshp-nav__items", role: "presentation" },
						settingsTabItems().map((item) => {
							const on = tab === item.key;
							return h("span", { className: "dshp-tab-chip", role: "presentation", key: item.key },
								h("button", {
									type: "button",
									role: "tab",
									id: settingsTabId(item.key),
									className: "dshp-tab-btn" + (on ? " on" : ""),
									"aria-selected": on ? "true" : "false",
									"aria-controls": settingsPanelId(item.key),
									tabIndex: on ? 0 : -1,
									ref: (node) => { tabNodes.current[item.key] = node; },
									onClick: () => pickTab(item.key),
								}, t(item.label)),
							);
						}),
					),
				),

				/* 五块面板：都挂出来、只露当前那块。挂出来是为了切回来时不必重新取数 ——
				   诊断页签的审计与健康各自只在挂载时取一次。容器是面板自己的类，不是页面壳的。 */
				settingsTabItems().map((item) => h("div", {
					key: item.key,
					id: settingsPanelId(item.key),
					className: "dshp-panel-body",
					role: "tabpanel",
					"aria-labelledby": settingsTabId(item.key),
					tabIndex: 0,
					hidden: tab !== item.key,
				}, panelBody(item.key))),

				h("footer", { className: "dshp-page__foot" },
					h("div", { className: "dshp-foot__links" },
						h("button", { type: "button", className: "dshp-link", onClick: () => openLocal("logs") }, t("foot.logs")),
						h("button", { type: "button", className: "dshp-link", onClick: () => openLocal("config") }, t("foot.config")),
					),
					openErr ? h("div", { className: "dshp-note is-bad" }, openErr) : null,
					s && s.dsh_home ? h("div", { className: "dshp-hint" }, s.dsh_home) : null,
				),
			);
		}
		/** 取一个整数字段；缺省与脏值都按 0 —— 页面不替服务端猜。 */
		function settingsInt(value) {
			const n = Number(value);
			return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
		}

		/**
		 * 四种数（外加失败）：键给文案、数给模板。
		 *
		 * 「不适用」单列是因为它本来就从界面的分节里被过滤掉了（展示行不返回 `na` 行），
		 * 不给它一个数，用户就只会看到「62」而不知道剩下几条去哪了。
		 */
		function settingsCountItems(s) {
			const state = s || {};
			const items = [
				{ key: "counts.applied", n: settingsInt(state.patches_applied) },
				{ key: "counts.pending", n: settingsInt(state.patches_pending) },
				{ key: "counts.skipped", n: settingsInt(state.patches_skipped) },
				{ key: "counts.na", n: settingsInt(state.patches_na) },
			];
			const failed = settingsInt(state.patches_failed);
			if (failed > 0) items.push({ key: "counts.failed", n: failed });
			return items;
		}

		/**
		 * 结论句：返回 `{ key, params }`，不返回成品字符串。
		 *
		 * 为什么不让它自己拼句子：文案要两份词典、要能在用例里逐分支断言。返回键与参数
		 * 之后，「pending 存在时不许说全部生效」可以在不渲染的前提下判 —— 那就是
		 * `test/settings-conclusion.test.mjs` 的判据。
		 */
		function settingsConclusion(s) {
			const state = s || {};
			const applied = settingsInt(state.patches_applied);
			const pending = settingsInt(state.patches_pending);
			const skipped = settingsInt(state.patches_skipped);
			const na = settingsInt(state.patches_na);
			const failed = settingsInt(state.patches_failed);
			const rest = {
				applied: String(applied),
				pending: String(pending),
				skipped: String(skipped),
				na: String(na),
			};
			// 次序即口径：失败 > 待应用 > 待重启 > 全部生效。前三条都不成立时才可能是「全部生效」。
			if (failed > 0) return { key: "conclusion.failed", params: { ...rest, failed: String(failed) } };
			if (pending > 0) return { key: "conclusion.pending", params: rest };
			if (state.boot_full_quit) return { key: "conclusion.restart", params: rest };
			return { key: "conclusion.ok", params: rest };
		}

		/**
		 * 页头那一处状态词：只说状态词、不报数。
		 *
		 * 数字在摘要那一行出现一次，别处不再复述 —— 同一组数字说三遍的后果不是啰嗦，
		 * 是任何一处漏改都会让三处互相矛盾，而用户无从判断该信哪个。
		 *
		 * @returns {{tone:string, key:string, needsRestart:boolean}}
		 */
		function settingsHeadStatus(s) {
			const state = s || {};
			const pending = settingsInt(state.patches_pending);
			const failed = settingsInt(state.patches_failed);
			const needsRestart = Boolean(state.boot_full_quit);
			const tone = failed > 0 ? "bad" : (needsRestart || pending > 0 ? "idle" : "ok");
			const key = failed > 0
				? "status.partial"
				: pending > 0
					? "status.waiting"
					: needsRestart ? "status.needRestart" : "status.active";
			return { tone: tone, key: key, needsRestart: needsRestart };
		}

		/**
		 * 命令入口（`shim_*` 三项）折算成人话。
		 *
		 * 取值域来自 `core.shimFileStatus`：`patched` / `original` / `missing` / `binary`。
		 * 用户不需要知道是哪三个文件、也不需要看见这些词 —— 他只需要知道「dsh 命令
		 * 现在是谁在管」。
		 *
		 * 这里的计数是**三个固定字段**（cmd / ps1 / bin），不是服务端给的集合：端点没有
		 * 「几个已接管」这个字段，而这句人话必须说出个数。所以按字段逐个判，不写
		 * `filter(...).length` —— 那种写法在页面上一旦成为习惯，补丁计数也会这么长回来。
		 */
		function settingsShimWord(s) {
			const state = s || {};
			const values = [state.shim_cmd, state.shim_ps1, state.shim_bin];
			let patched = 0;
			let present = 0;
			for (const value of values) {
				if (value === "patched") patched += 1;
				if (typeof value === "string" && value !== "" && value !== "missing") present += 1;
			}
			if (patched > 0) {
				return { tone: "ok", key: "plain.shim.patched", params: { patched: String(patched), present: String(present) } };
			}
			if (present > 0) return { tone: "idle", key: "plain.shim.original", params: { present: String(present) } };
			return { tone: "idle", key: "plain.shim.none", params: {} };
		}

		/** 原始文件备份：有 / 没有，各自一句人话。没有备份不是错误，只是「这一版还没动过」。 */
		function settingsBackupWord(s) {
			const state = s || {};
			return state.has_backup
				? { tone: "ok", key: "plain.backup.yes", params: {} }
				: { tone: "idle", key: "plain.backup.no", params: {} };
		}

		/**
		 * 预设注册状态折算成人话。
		 *
		 * `phase` 的取值域来自 `lib/redteam/index.js`（apply-start / registering /
		 * registered / registered-broken / register-failed / read-failed /
		 * waiting-registry / timeout-waiting-registry）。原来页面直接把 `phase` 与
		 * `broken` 拼上屏，用户看到的是 `registered-broken · tool-subagent: …`。
		 */
		function settingsPresetWord(preset) {
			const p = preset || {};
			const phase = typeof p.phase === "string" ? p.phase : "";
			const broken = typeof p.broken === "string" ? p.broken : "";
			const detail = broken ? { broken: broken } : {};
			if (phase === "registered") return { tone: "ok", key: "plain.preset.registered", params: detail };
			if (phase === "registered-broken") return { tone: "idle", key: "plain.preset.broken", params: detail };
			if (phase === "registering" || phase === "waiting-registry") {
				return { tone: "idle", key: "plain.preset.running", params: detail };
			}
			if (phase === "apply-start" || phase === "register-failed" || phase === "read-failed") {
				return { tone: "error", key: "plain.preset.failed", params: detail };
			}
			if (phase === "timeout-waiting-registry") {
				return { tone: "idle", key: "plain.preset.timeout", params: detail };
			}
			return { tone: "idle", key: "plain.preset.none", params: detail };
		}

		/**
		 * 状态页签的内容：数据来自 `usePurgeStatus()` 的那一份快照，自己不取数。
		 *
		 * 五态外壳（骨架 / 失败 + 重试 / 空态）由 `AsyncBlock` 一次画好；这里只给内容。
		 */
		function StatusPanel(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const resource = props.resource || null;
			const s = resource && resource.data ? resource.data : {};
			const head = settingsHeadStatus(s);
			const counts = settingsCountItems(s);
			const conclusionSpec = settingsConclusion(s);
			const shimWord = settingsShimWord(s);
			const backupWord = settingsBackupWord(s);
			const total = settingsInt(s.patches_total);
			const na = settingsInt(s.patches_na);

			return h(AsyncBlock, { t: t, resource: resource, height: SKEL_MD },
				h("div", { className: "dshp-summary" },
					h("div", { className: "dshp-summary__counts" },
						counts.map((item) => h("span", { className: "dshp-count", key: item.key },
							h("span", { className: "dshp-count__label" }, t(item.key)),
							h("span", { className: "dshp-count__value" }, String(item.n)),
						)),
					),
					h("p", { className: "dshp-conclusion" }, t(conclusionSpec.key, conclusionSpec.params)),
					/* 分母标名：这一行数的是展示行，不是补丁号。 */
					h("p", { className: "dshp-hint" }, t("counts.denominator.display", { n: String(total) })),
					h(Row, {
						label: t("plain.shim.label"),
						value: h(react.Fragment, null,
							h(StatusDot, { tone: shimWord.tone }),
							h("span", null, " " + t(shimWord.key, shimWord.params)),
						),
					}),
					h(Row, {
						label: t("plain.backup.label"),
						value: h(react.Fragment, null,
							h(StatusDot, { tone: backupWord.tone }),
							h("span", null, " " + t(backupWord.key, backupWord.params)),
						),
					}),
					na > 0
						? h("p", { className: "dshp-hint" }, t("counts.na.hint", { n: String(na) }))
						: null,
					head.needsRestart
						? h("div", { className: "dshp-actions", style: { justifyContent: "flex-start" } },
							h(ActionButton, {
								primary: true,
								onClick: () => restartDsh(() => {}, () => {}, t, s.surface),
							}, t("head.restart")),
						)
						: null,
				),
			);
		}
		function PatchesPanel(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const resource = props.resource || null;
			const state = resource && resource.data ? resource.data : null;
			const [open, setOpen] = useState({});
			const rows = state && Array.isArray(state.layerRows) ? state.layerRows : [];
			const total = state ? settingsInt(state.patches_total) : 0;

			return h(Section, {
				title: t("section.patches"),
				hint: state ? t("counts.denominator.display", { n: String(total) }) : null,
			},
				h(AsyncBlock, { t: t, resource: resource, height: SKEL_MD },
					rows.length === 0
						? h(Empty, { text: t("patch.empty"), hint: t("patch.empty.hint") })
						: h("div", { className: "dshp-list" },
							rows.map((row) => {
								const expanded = open[row.layer] === true;
								const bodyId = "dshp-layer-" + row.slug;
								/* 一层的 meta 只说这一层自己的数：已生效 / 总数，另加该层里「待应用」与
								   「按设计跳过」的条数。两个数分开列 —— 早先只有一个「跳过」，
								   而服务端把待应用也算进了跳过那一档（按色调判），同一屏于是两个跳过。 */
								const parts = [row.hit + " / " + row.total];
								if (row.pending > 0) parts.push(t("counts.pending") + " " + row.pending);
								if (row.skipped > 0) parts.push(t("counts.skipped") + " " + row.skipped);
								const meta = parts.join(" · ");
								return h("div", { className: "dshp-list__item", key: row.layer },
									h(DisclosureHead, {
										open: expanded,
										bodyId: bodyId,
										title: row.title,
										meta: meta,
										leading: h(StatusDot, { tone: row.tone }),
										onToggle: () => setOpen((prev) => ({ ...prev, [row.layer]: prev[row.layer] !== true })),
									}),
									expanded
										? h("div", { id: bodyId, className: "dshp-disc__body" },
											row.items.map((item) => h("div", { className: "dshp-disc__item", key: String(item.id) },
												h(StatusDot, { tone: item.tone }),
												h("span", { className: "dshp-disc__item-name" }, item.name),
												item.desc ? h("span", { className: "dshp-disc__item-note" }, item.desc) : null,
												item.reason ? h("span", { className: "dshp-disc__item-note" }, item.reason) : null,
												item.error ? h("span", { className: "dshp-disc__item-note" }, item.error) : null,
											)),
										)
										: null,
								);
							}),
						),
				),
			);
		}
		function RestartAsk(props) {
			// 确认窗留在页面里渲染，不走 portal：用户正看着这块区域点「重启」，
			// 把窗搬到 body 会丢掉上下文。深浅色一律吃宿主变量。
			return h("div", {
				className: "dshp-restart-mask",
				role: "dialog",
				"aria-modal": "true",
				"aria-labelledby": "dshp-restart-title",
				onClick: (e) => { if (e.target === e.currentTarget && props.onLater) props.onLater(); },
			},
				h("div", { className: "dshp-restart-card" },
					h("h4", { id: "dshp-restart-title" }, props.t("restart.ask.title")),
					h("p", null, props.t("restart.ask.body")),
					h("div", { className: "dshp-modal-ops" },
						h(ActionButton, { onClick: props.onLater }, props.t("restart.notNow")),
						h(ActionButton, { primary: true, onClick: props.onRestart }, props.t("restart.now")),
					),
				),
			);
		}

		/** 读一次更新能力：服务端明确说了 `updateDisabled` 就一个按钮都不画。 */
		function fetchUpdateInfo() {
			return apiJson("/dsh-purge/update").then((d) => {
				if (!d || typeof d !== "object") throw new Error("bad response");
				return d;
			});
		}

		/**
		 * 更新与版本：先读一次 `/dsh-purge/update` 拿真实能力，再决定渲不渲染按钮。
		 *
		 * 不能只看状态快照里的更新结果：它来自 `updater.lastUpdateResult()`，只有用户主动
		 * 检测过更新才有值；本页从未检测过时它为空，于是「更新已关闭」的判断失效，
		 * 界面上就会出现一个点了必然失败的「检测更新」按钮 —— 实际部署确实如此。
		 * 这里自己取一次，服务端明确说了 `updateDisabled` 就一个按钮都不画。
		 */
		function UpdateSection(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const res = useAsyncResource(fetchUpdateInfo);
			const [fresh, setFresh] = useState(null);
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });
			/* 用户点过「检测更新」之后以那一次的结果为准；没点过就用读到的能力与快照。 */
			const info = fresh || res.data || props.updateInfo || null;

			const check = useCallback(() => {
				setBusy(true);
				setNotice({ kind: "ok", text: t("update.checking") });
				apiJson("/dsh-purge/update")
					.then((d) => {
						if (!d) throw new Error("empty response");
						setFresh(d);
						setNotice({
							kind: d.error ? "error" : "ok",
							text: d.error || (d.hasUpdate
								? t("update.available").replace("{remote}", d.remoteVersion || "—").replace("{local}", d.localVersion || "—")
								: t("update.latest").replace("{version}", d.localVersion || "—")),
						});
						if (typeof props.onChanged === "function") props.onChanged();
					})
					.catch((e) => setNotice({ kind: "error", text: t("update.fail").replace("{error}", (e && e.message) || e) }))
					.finally(() => setBusy(false));
			}, [t, props.onChanged]);

			const off = Boolean(info && info.updateDisabled);
			const version = (info && info.localVersion) || "";
			const channel = (info && info.channel) || "stable";
			const channelText = t("channel." + channel);

			return h(Section, { title: t("section.update") },
				h(AsyncBlock, { t: t, resource: res, height: SKEL_SM },
					h(Field, {
						label: t("metric.version"),
						hint: off
							? t("update.off").replace("{reason}", (info && info.updateDisabledReason) || "")
							: channelText + (info && info.channelLabel && info.channelLabel !== channelText ? " · " + info.channelLabel : ""),
						action: off
							? null
							: h(ActionButton, { primary: true, tiny: true, disabled: busy, onClick: check }, t("btn.checkUpdate")),
						children: h("span", { className: "dshp-row__value" }, version ? "v" + version : "—"),
					}),
				),
				h(Note, { notice: notice }),
			);
		}

		/** 读注入提示词；`ok: false` 要能看见，所以抛出去交给五态。 */
		function fetchOverride() {
			return apiJson("/dsh-purge/override").then((d) => {
				if (!d || !d.ok) throw new Error(String((d && d.error) || "bad response"));
				return d;
			});
		}

		/** 注入提示词：读写 `/dsh-purge/override`，保存失败保留用户输入。 */
		function OverrideSection(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const res = useAsyncResource(fetchOverride);
			const [override, setOverride] = useSeededValue(res.phase, res.data, (d) => {
				const packed = typeof d.defaultContent === "string" ? d.defaultContent : "";
				const shown = typeof d.content === "string" ? d.content : "";
				return shown || packed;
			});
			const [defaultOverride] = useSeededValue(res.phase, res.data, (d) => (
				typeof d.defaultContent === "string" ? d.defaultContent : ""
			));
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });
			const text = override === null ? "" : override;
			const def = defaultOverride === null ? "" : defaultOverride;
			const empty = promptBoxEmpty(text) && promptBoxEmpty(def);

			const post = useCallback((content) => {
				setBusy(true);
				setNotice({ kind: "idle", text: "" });
				apiJson("/dsh-purge/override", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ content: content }),
				})
					.then((d) => {
						if (!d || !d.ok) {
							/* 失败时不动 textarea：内容留在编辑框里，用户不必重打。 */
							setNotice({ kind: "error", text: t("err.save").replace("{error}", (d && d.error) || "") });
							return;
						}
						if (typeof d.content === "string") setOverride(d.content);
						setNotice({ kind: "ok", text: t("saved.override") });
					})
					.catch((e) => setNotice({ kind: "error", text: t("err.save").replace("{error}", (e && e.message) || e) }))
					.finally(() => setBusy(false));
			}, [t]);

			return h(Section, {
				title: t("override.title"),
				action: h("div", { className: "dshp-actions" },
					h(ActionButton, { primary: true, tiny: true, disabled: busy || override === null || empty, onClick: () => post(text) }, t("btn.saveInject")),
					h(ActionButton, { tiny: true, disabled: busy || override === null || !def, onClick: () => post(def) }, t("btn.restoreInject")),
				),
			},
				h(AsyncBlock, { t: t, resource: res, height: SKEL_LG, errorKey: "override" },
					h("textarea", {
						className: "dshp-area",
						value: text,
						onChange: (e) => setOverride(e.target.value),
						spellCheck: false,
						rows: 10,
					}),
				),
				empty ? h("p", { className: "dshp-hint" }, t("need.prompt")) : null,
				h(Note, { notice: notice }),
			);
		}

		/** 读自己的服务器名单。 */
		function fetchOwnServers() {
			return apiJson("/dsh-purge/own-servers").then((d) => {
				if (!d || !d.ok) throw new Error(String((d && d.error) || "bad response"));
				return d;
			});
		}

		/** 自己的服务器名单：读写 `/dsh-purge/own-servers`。 */
		function OwnServersSection(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const res = useAsyncResource(fetchOwnServers);
			const [text, setText] = useSeededValue(res.phase, res.data, (d) => (
				typeof d.content === "string" ? d.content : ""
			));
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });
			const body = text === null ? "" : text;

			const save = useCallback(() => {
				setBusy(true);
				setNotice({ kind: "idle", text: "" });
				apiJson("/dsh-purge/own-servers", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ content: body }),
				})
					.then((d) => {
						if (!d || !d.ok) {
							setNotice({ kind: "error", text: t("err.save").replace("{error}", (d && d.error) || "") });
							return;
						}
						if (typeof d.content === "string") setText(d.content);
						setNotice({
							kind: "ok",
							text: d.dropped > 0
								? t("saved.own.dropped").replace("{n}", String(d.dropped))
								: t("saved.own"),
						});
					})
					.catch((e) => setNotice({ kind: "error", text: t("err.save").replace("{error}", (e && e.message) || e) }))
					.finally(() => setBusy(false));
			}, [t, body, setText]);

			return h(Section, {
				title: t("own.title"),
				action: h(ActionButton, { primary: true, tiny: true, disabled: busy || text === null, onClick: save }, t("own.save")),
			},
				h(AsyncBlock, { t: t, resource: res, height: SKEL_MD, errorKey: "status" },
					h("textarea", {
						className: "dshp-area",
						value: body,
						onChange: (e) => setText(e.target.value),
						spellCheck: false,
						rows: 4,
						style: { minHeight: 96 },
					}),
				),
				h("p", { className: "dshp-field__hint" }, t("own.hint")),
				h(Note, { notice: notice }),
			);
		}

		/** 读 Hooks 拦截开关的现状。 */
		function fetchHooksDeny() {
			return apiJson("/dsh-purge/hooks-deny").then((d) => {
				if (!d || !d.ok) throw new Error(String((d && d.error) || "bad response"));
				return d;
			});
		}

		/** Hooks 拦截开关：读一次、写一次，失败就把服务端的 error 原样显示。 */
		function HooksDenySection(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const res = useAsyncResource(fetchHooksDeny);
			/* 用户拨过开关之后以本地那一次为准；没拨过就读服务端这一次的现状。 */
			const [overrideCfg, setOverrideCfg] = useState(null);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });
			const [busy, setBusy] = useState(false);
			const cfg = overrideCfg || (res.data ? { hooksDenyBypass: res.data.hooksDenyBypass !== false } : null);

			const save = (hooksDenyBypass) => {
				if (!cfg || busy) return;
				setOverrideCfg({ hooksDenyBypass: hooksDenyBypass });
				setBusy(true);
				apiJson("/dsh-purge/hooks-deny", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ hooksDenyBypass }),
				})
					.then((d) => {
						if (d && d.ok) {
							setOverrideCfg({ hooksDenyBypass: d.hooksDenyBypass === true });
							setNotice({ kind: "ok", text: t("saved.hooksDeny") });
							if (typeof props.onSaved === "function") props.onSaved();
						} else {
							setNotice({ kind: "error", text: t("err.save").replace("{error}", (d && d.error) || "") });
						}
					})
					.catch((e) => setNotice({ kind: "error", text: t("err.save").replace("{error}", (e && e.message) || e) }))
					.finally(() => setBusy(false));
			};

			const Switch = primOf("Switch");
			const checked = !!(cfg && cfg.hooksDenyBypass === true);
			const control = h("div", { className: "dshp-field__head" },
				h("span", { className: "dshp-field__label" }, t("hooksDeny.bypass")),
				Switch
					? h(Switch, { checked: checked, disabled: busy || !cfg, label: t("hooksDeny.bypass"), onChange: save })
					: h("input", { type: "checkbox", checked: checked, disabled: busy || !cfg, onChange: (e) => save(e.target.checked) }),
			);

			return h(Section, { title: t("section.hooks") },
				h(AsyncBlock, { t: t, resource: res, height: SKEL_SM, errorKey: "status" },
					h("div", { className: "dshp-field" },
						control,
						h("p", { className: "dshp-field__hint" }, t("hooksDeny.hint")),
					),
				),
				h(Note, { notice: notice }),
			);
		}

		/**
		 * 危险区：还原与卸载。两者都有真实后端、都不可撤销，所以放最后、与上方隔开。
		 */
		function DangerZoneSection(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });
			const [askUninstall, setAskUninstall] = useState(false);
			const state = props.state;

			const doRevert = useCallback(() => {
				setBusy(true);
				setNotice({ kind: "idle", text: "" });
				fetch("/dsh-purge/revert", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
					.then((r) => r.json())
					.then((d) => {
						if (!d || !d.ok) {
							setNotice({ kind: "error", text: t("err.action").replace("{error}", (d && d.error) || "") });
							return;
						}
						setNotice({ kind: "ok", text: t("ok.done") });
						if (typeof props.onChanged === "function") props.onChanged();
					})
					.catch((e) => setNotice({ kind: "error", text: t("err.action").replace("{error}", (e && e.message) || e) }))
					.finally(() => setBusy(false));
			}, [t, props.onChanged]);

			const doUninstall = useCallback(() => {
				setAskUninstall(false);
				setBusy(true);
				setNotice({ kind: "ok", text: t("uninstall.applying") });
				const surface = hostSurfaceOf(state);
				apiJson("/dsh-purge/uninstall", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
					.then((d) => {
						if (!d || !d.ok) throw new Error((d && d.error) || "uninstall failed");
						setNotice({ kind: "ok", text: hostText(t, "uninstall.done", d.surface || surface) });
					})
					.catch((e) => {
						const msg = String((e && e.message) || e || "");
						/* 卸载会切断宿主自己的连接，fetch 失败是预期结果，不是故障。 */
						if (/failed to fetch|networkerror|load failed/i.test(msg)) {
							setNotice({ kind: "ok", text: hostText(t, "uninstall.done", surface) });
							return;
						}
						setNotice({ kind: "error", text: t("uninstall.fail").replace("{error}", msg) });
						setBusy(false);
					});
			}, [t, state]);

			const surface = hostSurfaceOf(state);
			const noRoot = state && !state.ai_base;

			return h("section", { className: "dshp-section dshp-section--danger" },
				h(Section, { title: t("section.danger") },
					noRoot ? h("p", { className: "dshp-hint" }, hostText(t, "warn.noRoot", surface)) : null,
					h(Field, {
						label: t("action.revert"),
						hint: t("action.revert.hint"),
						action: h(ActionButton, { danger: true, disabled: busy, onClick: doRevert }, t("btn.revert")),
					}),
					h(Field, {
						label: t("action.uninstall"),
						hint: t("action.uninstall.hint"),
						action: h(ActionButton, { danger: true, disabled: busy, onClick: () => setAskUninstall(true) }, t("btn.uninstall")),
					}),
					h(Note, { notice: notice }),
				),
				askUninstall
					? h("div", {
						className: "dshp-modal-bg",
						role: "dialog",
						"aria-modal": "true",
						onClick: (e) => { if (e.target === e.currentTarget) setAskUninstall(false); },
					},
						h("div", { className: "dshp-modal" },
							h("h4", null, t("uninstall.title")),
							h("p", null, t("uninstall.body")),
							h("div", { className: "dshp-modal-ops" },
								h(ActionButton, { onClick: () => setAskUninstall(false) }, t("uninstall.cancel")),
								h(ActionButton, { danger: true, onClick: doUninstall }, t("uninstall.confirm")),
							),
						),
					)
					: null,
			);
		}

		/**
		 * 配置页签的容器：五块共享同一份快照的五态，各自再取自己的只读端点；危险区按设计
		 * 排在最后（它要读快照里的宿主面，所以快照没读到时整块不挂载）。
		 */
		function ConfigPanel(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const resource = props.resource || null;
			const state = resource && resource.data ? resource.data : null;
			const updateInfo = (state && state.update) || null;
			return h(AsyncBlock, { t: t, resource: resource, height: SKEL_MD },
				h(react.Fragment, null,
					h(UpdateSection, { t: t, updateInfo: updateInfo, onChanged: props.onChanged }),
					h(OverrideSection, { t: t }),
					h(OwnServersSection, { t: t }),
					h(HooksDenySection, null),
					h(DangerZoneSection, { t: t, state: state, onChanged: props.onChanged }),
				),
			);
		}
		function skillUiAllowed(d) {
			if (!d) return false;
			const ver = String(d.plugin_version || d.localVersion || "").replace(/^v/i, "");
			if (/^1\.1\.11(?:-|$)/.test(ver)) return false;
			const parts = ver.match(/^(\d+)\.(\d+)\.(\d+)/);
			if (!parts) return false;
			if (+parts[1] !== 1) return +parts[1] > 1;
			if (+parts[2] !== 1) return +parts[2] > 1;
			return +parts[3] >= 12;
		}

		function splitListedVersion(raw) {
			const text = String(raw || "").trim().replace(/^v/i, "");
			const cut = text.split("-");
			const core = String(cut[0] || "").split(".").map((n) => parseInt(n, 10) || 0);
			return { core: [core[0] || 0, core[1] || 0, core[2] || 0], pre: cut.slice(1).join("-") };
		}

		function listedVersionNewer(remote, local) {
			if (!remote || !local || String(remote) === String(local)) return false;
			const a = splitListedVersion(remote);
			const b = splitListedVersion(local);
			for (let i = 0; i < 3; i += 1) {
				if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
			}
			if (a.pre && !b.pre) return false;
			if (!a.pre && b.pre) return true;
			return a.pre > b.pre;
		}

		function listedCeiling(versions, localVer) {
			let best = String(localVer || "");
			for (const item of versions || []) {
				const v = item && (item.version || item.label);
				if (v && listedVersionNewer(v, best)) best = v;
			}
			return best;
		}

		function keepListedVersion(item, ceiling) {
			const v = item && (item.version || item.label);
			if (!v) return true;
			if (!ceiling) return true;
			return !listedVersionNewer(v, ceiling);
		}

		function preferListed(list, localVer, pin) {
			const items = Array.isArray(list) ? list : [];
			if (pin) {
				const pinned = items.find((item) => item && (item.ref === pin || item.version === pin));
				if (pinned) return pinned;
			}
			const current = items.find((item) => item && item.current);
			if (current) return current;
			return items[0] || null;
		}

		function versionChoiceLabel(item, t) {
			const base = (item && (item.label || item.version || item.ref)) || "—";
			if (item && item.current) return base + " · " + t("update.current");
			if (item && item.latest) return base + " · " + t("update.tip");
			return base;
		}

		/** 「按库几条、同名遮蔽几条」只在 `/dsh-purge/skills` 的 status 里，这里只取这一项。 */
		function fetchSkillsMeta() {
			return skillsApi("status");
		}

		function SkillsPanel(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const resource = props.resource || null;
			const snapshot = resource && resource.data ? resource.data : null;
			/* 界面只在契约给的版本够新时才出现：这个结论来自共享快照，页签不自己再取一次端点。 */
			const onBeta = skillUiAllowed(snapshot);
			const metaRes = useAsyncResource(fetchSkillsMeta, { enabled: onBeta });
			const [editId, setEditId] = useState(null);
			const [editDesc, setEditDesc] = useState("");
			const [content, setContent] = useState("");
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });
			const [filter, setFilter] = useState("all");
			const zipRef = useRef(null);
			const folderRef = useRef(null);

			/* 写操作之后重取一次元数据：改完技能，按库条数与遮蔽数会跟着变。 */
			const reload = metaRes.retry;

			const doPost = useCallback((action, payload, after) => {
				setBusy(true);
				setNotice({ kind: "idle", text: "" });
				skillsApi(action, payload)
					.then((d) => {
						if (d && d.ok) {
							setNotice({ kind: "ok", text: t("ok.done") });
							reload();
							if (after) after(d);
						} else {
							setNotice({ kind: "error", text: t("err.action", { error: (d && d.error) || "" }) });
						}
					})
					.catch((e) => setNotice({
						kind: "error",
						text: skillsRouteMissing(e) ? t("err.skills.needRestart") : t("err.action", { error: e.message }),
					}))
					.finally(() => setBusy(false));
			}, [reload, t]);

			const openSkill = useCallback((id) => {
				if (editId === id) {
					setEditId(null);
					setEditDesc("");
					setContent("");
					return;
				}
				setBusy(true);
				skillsApi("read", { id: id })
					.then((d) => {
						if (d.ok) {
							setEditId(id);
							setEditDesc(d.description || "");
							setContent(typeof d.content === "string" ? d.content : "");
						} else setNotice({ kind: "error", text: t("err.read", { error: d.error || "" }) });
					})
					.catch((e) => setNotice({ kind: "error", text: t("err.read", { error: e.message }) }))
					.finally(() => setBusy(false));
			}, [t, editId]);

			const clearEditor = () => {
				setEditId(null);
				setEditDesc("");
				setContent("");
			};

			const readAsBase64 = (file) => new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => {
					const text = String(reader.result || "");
					const at = text.indexOf(",");
					resolve(at >= 0 ? text.slice(at + 1) : text);
				};
				reader.onerror = () => reject(new Error(t("need.import")));
				reader.readAsDataURL(file);
			});

			const importZip = (file) => {
				if (!file) {
					setNotice({ kind: "error", text: t("need.import") });
					return;
				}
				setBusy(true);
				setNotice({ kind: "ok", text: t("skills.importing") });
				readAsBase64(file)
					.then((data) => skillsApi("import", { data, name: file.name }))
					.then((d) => {
						if (!d || !d.ok) throw new Error((d && d.error) || "");
						setNotice({ kind: "ok", text: t("saved.import", { count: (d.imported || []).length || 1 }) });
						reload();
					})
					.catch((e) => setNotice({
						kind: "error",
						text: skillsRouteMissing(e) ? t("err.skills.needRestart") : t("err.action", { error: e.message }),
					}))
					.finally(() => setBusy(false));
			};

			const keepFolderFile = (file) => {
				const rel = String(file.webkitRelativePath || file.name || "").replace(/\\/g, "/");
				if (!rel || rel.includes("..")) return false;
				if (/(^|\/)(node_modules|\.git|__MACOSX|\.system)(\/|$)/i.test(rel)) return false;
				if (/(^|\/)\._/.test(rel) || /\/\.DS_Store$/i.test(rel)) return false;
				return true;
			};

			const importFolder = (list) => {
				const files = Array.from(list || []).filter(keepFolderFile);
				if (!files.length) {
					setNotice({ kind: "error", text: t("err.import.folder") });
					return;
				}
				setBusy(true);
				setNotice({ kind: "ok", text: t("skills.importing") });
				Promise.all(files.map((file) => readAsBase64(file).then((content) => ({
					path: file.webkitRelativePath || file.name,
					content,
					encoding: "base64",
				}))))
					.then((payload) => skillsApi("import", {
						files: payload,
						name: String(payload[0] && payload[0].path || "").split("/")[0],
					}))
					.then((d) => {
						if (!d || !d.ok) throw new Error((d && d.error) || "");
						setNotice({ kind: "ok", text: t("saved.import", { count: (d.imported || []).length || 1 }) });
						reload();
					})
					.catch((e) => setNotice({
						kind: "error",
						text: skillsRouteMissing(e) ? t("err.skills.needRestart") : t("err.action", { error: e.message }),
					}))
					.finally(() => setBusy(false));
			};

			if (!onBeta) return null;

			const hiddenInputs = h(react.Fragment, null,
				h("input", {
					ref: zipRef,
					type: "file",
					accept: ".zip,.tgz,.tar.gz,.tar,.skill",
					style: { display: "none" },
					onChange: (e) => {
						const file = e.target.files && e.target.files[0];
						e.target.value = "";
						importZip(file);
					},
				}),
				h("input", {
					ref: (el) => {
						folderRef.current = el;
						if (!el) return;
						el.setAttribute("webkitdirectory", "");
						el.setAttribute("directory", "");
						el.multiple = true;
					},
					type: "file",
					multiple: true,
					style: { display: "none" },
					onChange: (e) => {
						const files = Array.from((e.target && e.target.files) || []);
						e.target.value = "";
						importFolder(files);
					},
				}),
			);

			const metaData = metaRes.phase === "ready" ? metaRes.data : null;
			const metaSkills = metaData && Array.isArray(metaData.skills) ? metaData.skills : null;
			const fromSnapshot = snapshot && Array.isArray(snapshot.skills) ? snapshot.skills : [];
			/* 元数据端点没回来（老宿主 404 / 405）时用手上这份快照顶上：不把一次元数据缺失
			   渲染成空目录，也不把它说成「一个技能都没有」。 */
			const degraded = metaRes.phase === "error" && fromSnapshot.length > 0;
			const skills = metaSkills || fromSnapshot;
			const shadowed = metaData && Array.isArray(metaData.shadowed) ? metaData.shadowed : [];
			/* 条数只认服务端给的 `total`：这里再数一遍数组就成了第二份口径。 */
			const total = metaData && typeof metaData.total === "number" ? metaData.total : null;
			const byLibrary = metaData && metaData.byLibrary ? metaData.byLibrary : null;
			const visible = filter === "all"
				? skills
				: skills.filter((item) => String(item && item.library || "official") === filter);
			const countText = total === null
				? null
				: String(total) + (shadowed.length > 0 ? " · " + t("skills.shadowed", { n: String(shadowed.length) }) : "");
			/* 库筛选只筛「服务端给的那一份」，不重新枚举：筛选前后必须是同一个集合。 */
			const filters = [
				{ id: "all", label: t("skills.filter.all") },
				{ id: "official", label: t("skills.library.official") },
				{ id: "redteam", label: t("skills.library.redteam") },
			];
			const filterRow = total !== null && total > 0
				? h("div", { className: "dshp-actions", style: { justifyContent: "flex-start", marginTop: 6 } },
					filters.map((entry) => {
						/* 每个库几条由服务端给（`byLibrary`）：这里再数一遍就成了第二份口径。 */
						const per = byLibrary && typeof byLibrary[entry.id] === "number"
							? " " + String(byLibrary[entry.id])
							: "";
						return h(ActionButton, {
							key: entry.id,
							tiny: true,
							primary: filter === entry.id,
							disabled: busy,
							onClick: () => setFilter(entry.id),
						}, entry.label + per);
					}),
				)
				: null;
			const editor = editId
				? h("div", { className: "dshp-list__editor" },
					h("input", {
						className: "dshp-input",
						placeholder: t("ph.skill.desc"),
						value: editDesc,
						onChange: (e) => setEditDesc(e.target.value),
					}),
					h("textarea", {
						className: "dshp-area",
						value: content,
						onChange: (e) => setContent(e.target.value),
						spellCheck: false,
						rows: 12,
					}),
					h("div", { className: "dshp-actions" },
						h(ActionButton, { primary: true, tiny: true, disabled: busy, onClick: () => doPost("save", { id: editId, content: content, description: editDesc }) }, t("btn.saveSkill")),
						h(ActionButton, { tiny: true, disabled: busy, onClick: clearEditor }, t("uninstall.cancel")),
					),
				)
				: null;

			return h(Section, {
				title: t("skills.title"),
				count: countText,
				hint: hostText(t, "skills.hint", hostSurfaceOf()),
				action: h("div", { className: "dshp-actions" },
					h(ActionButton, { primary: true, tiny: true, disabled: busy, onClick: () => zipRef.current && zipRef.current.click() }, t("btn.importZip")),
					h(ActionButton, { tiny: true, disabled: busy, onClick: () => folderRef.current && folderRef.current.click() }, t("btn.importFolder")),
				),
			},
				hiddenInputs,
				filterRow,
				h(AsyncBlock, {
					t: t,
					/* 降级时把相位当成 ready：手上这份快照就是这一屏的内容，失败在下面那行说清楚。 */
					resource: degraded ? { phase: "ready", data: metaRes.data, retry: metaRes.retry } : metaRes,
					height: SKEL_SM,
					empty: h(Empty, { text: t("skill.empty"), hint: t("skill.empty.hint") }),
					errorKey: "skills",
				},
					skills.length === 0
						? h(Empty, { text: t("skill.empty"), hint: t("skill.empty.hint") })
						: visible.length === 0
							? h(Empty, { text: t("skills.filter.empty") })
							: h("div", { className: "dshp-list" },
							visible.map((item) => {
								const isEdit = item.id === editId;
								/* 随包副本是同步产物：改了会被下次同步盖回去，所以只给看、不给编辑。 */
								const editable = item.editable !== false;
								const meta = (item.valid ? item.description : t("skills.invalid")) + " · " + formatSize(item.size);
								const head = editable
									? h("button", {
										type: "button",
										className: "dshp-list__head",
										"aria-expanded": isEdit ? "true" : "false",
										onClick: () => openSkill(item.id),
									},
										h("span", { className: "dshp-list__name" }, item.id),
										h("span", { className: "dshp-list__meta" }, meta),
										h("span", { className: "dshp-list__ops" },
											h("span", {
												className: "dshp-link",
												role: "button",
												tabIndex: 0,
												onClick: (e) => {
													e.stopPropagation();
													if (!window.confirm(t("confirm.delete.skill", { id: item.id }))) return;
													if (isEdit) clearEditor();
													doPost("delete", { id: item.id });
												},
												onKeyDown: (e) => {
													if (e.key !== "Enter" && e.key !== " ") return;
													e.preventDefault();
													e.stopPropagation();
													if (!window.confirm(t("confirm.delete.skill", { id: item.id }))) return;
													if (isEdit) clearEditor();
													doPost("delete", { id: item.id });
												},
											}, t("delete")),
										),
									)
									: h("div", { className: "dshp-list__head" },
										h("span", { className: "dshp-list__name" }, item.id),
										h("span", { className: "dshp-list__meta" }, meta),
										h("span", { className: "dshp-list__ops" },
											h("span", { className: "dshp-cwd-badge" }, t("skills.readonly")),
										),
									);
								return h("div", { key: item.id, className: "dshp-list__item" },
									head,
									isEdit ? editor : null,
								);
							}),
						),
				),
				/* 降级：列表是共享快照给的，元数据没回来 —— 说清楚缺的是哪一半，别让「·」少了也不吭声。 */
				degraded ? h(Note, { notice: { kind: "error", text: asyncErrorText(t, "skills", metaRes.error) } }) : null,
				h(Note, { notice: notice }),
			);
		}
		/** 最近 N 条事件：`ok: false` 是服务端说「读不到」，按失败处理而不是空态。 */
		function fetchAuditTail() {
			return apiJson("/dsh-purge/audit?tail=20").then((d) => {
				if (!d || !d.ok) throw new Error(String((d && d.error) || "bad response"));
				return d;
			});
		}

		/**
		 * 完整性对账。
		 *
		 * 取不到不是错：审计目录还不存在时端点会失败，那只是「还没有可判的对象」。
		 * 所以这里吞掉失败并返回 null，由文案说「还没有可判的审计文件」。
		 */
		function fetchAuditCheck() {
			return apiJson("/dsh-purge/audit?check").catch(() => null);
		}

		/** 健康与三条日志轨：一次 `GET` 拿全，失败要能看见（它与审计的「没有对象」不同）。 */
		function fetchHealth() {
			return apiJson("/dsh-purge/health").then((d) => {
				if (!d || !d.ok) throw new Error(String((d && d.error) || "bad response"));
				return d;
			});
		}

		function AuditSection(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const state = props.state || null;
			const [runId, setRunId] = useState("");
			const [runResult, setRunResult] = useState(null);
			const [runBusy, setRunBusy] = useState(false);

			const tail = useAsyncResource(fetchAuditTail, {
				emptyOf: (d) => !d || !Array.isArray(d.events) || d.events.length === 0,
			});
			const checkRes = useAsyncResource(fetchAuditCheck);
			const events = tail.phase === "ready" && tail.data && Array.isArray(tail.data.events) ? tail.data.events : null;
			const check = checkRes.phase === "ready" ? checkRes.data : null;

			const runWhy = () => {
				const wanted = String(runId || "").trim();
				if (!wanted) return;
				setRunBusy(true);
				setRunResult(null);
				apiJson("/dsh-purge/audit?run=" + encodeURIComponent(wanted))
					.then((d) => setRunResult(d && typeof d === "object" ? d : { ok: false, error: "bad response" }))
					.catch((e) => setRunResult({ ok: false, error: String((e && e.message) || e) }))
					.finally(() => setRunBusy(false));
			};

			const auditOf = state && state.audit ? state.audit : null;
			const lastRun = auditOf && auditOf.appliedRunId ? auditOf.appliedRunId : "";
			const layerNames = auditOf && auditOf.layers ? Object.keys(auditOf.layers) : [];
			const layerText = layerNames.length === 0
				? "—"
				: layerNames.map((name) => name + ":" + String((auditOf.layers[name] && auditOf.layers[name].result) || "?")).join(" · ");

			/* `?check` 的三种回包：取到且通过 / 取到但有判据不过 / 取不到（目录还不存在时端点是 5xx）。
			   第三种只是「还没有可判的对象」，不是错——别把「没跑过」渲染成「坏了」。 */
			const checkText = !check
				? t("audit.check.unavailable")
				: check.ok
					? t("audit.check.ok", { files: String(Array.isArray(check.files) ? check.files.length : 0) })
					: t("audit.check.bad", { gaps: String(check.gaps || 0), badLines: String(check.badLines || 0) });

			const runBlock = (() => {
				if (!runResult) return null;
				if (runResult.ok === false && runResult.found !== false) {
					return h(Note, { notice: { kind: "error", text: t("audit.err", { error: String(runResult.error || "") }) } });
				}
				if (runResult.found === false) {
					return h(Empty, { text: t("audit.run.missing", { runId: String(runResult.runId || runId) }) });
				}
				const auditRows = Array.isArray(runResult.audit) ? runResult.audit.length : 0;
				const diagRows = runResult.diag && typeof runResult.diag.rows === "number" ? runResult.diag.rows : 0;
				const cards = Array.isArray(runResult.cards) ? runResult.cards : [];
				const cross = runResult.cross || null;
				return h("div", { className: "dshp-disc__body" },
					h(Row, { label: t("audit.run.rows"), value: t("audit.run.counts", { audit: String(auditRows), diag: String(diagRows) }) }),
					h(Row, {
						label: t("audit.run.cross"),
						value: cross && cross.comparable
							? t("audit.run.cross.value", { matched: String(cross.matched || 0), checked: String(cross.checked || 0) })
							: t("audit.run.cross.none"),
					}),
					h(Row, { label: t("audit.cards"), value: cards.length === 0 ? t("audit.cards.none") : String(cards.length) }),
					cards.map((card) => h("p", { className: "dshp-cwd-sub", key: card }, String(card))),
				);
			})();

			return h(Section, {
				title: t("section.audit"),
				count: lastRun ? lastRun : null,
				hint: t("audit.hint"),
			},
				h(Row, { label: t("audit.lastRun"), value: lastRun || t("audit.lastRun.none") }),
				h(Row, { label: t("audit.events"), value: auditOf && auditOf.recorded ? String(auditOf.events || 0) : "—" }),
				h(Row, { label: t("audit.layers"), value: layerText }),
				h(Row, { label: t("audit.check"), value: checkText }),
				h(Row, {
					label: t("audit.files"),
					value: auditOf && auditOf.dir ? String(auditOf.dir) : "—",
				}),
				/* 判据口径：这一行数的是补丁号（raw），与摘要 / 补丁页的展示行不是一个分母。 */
				h(Row, {
					label: t("counts.denominator.raw.label"),
					value: t("counts.denominator.raw", { na: String(settingsInt(state && state.patches_na)) }),
				}),
				h("div", { className: "dshp-actions", style: { justifyContent: "flex-start" } },
					h("input", {
						className: "dshp-input",
						style: { maxWidth: 320 },
						placeholder: t("audit.run.ph"),
						value: runId,
						onChange: (e) => setRunId(e.target.value),
						onKeyDown: (e) => { if (e.key === "Enter") runWhy(); },
					}),
					h(ActionButton, { tiny: true, disabled: runBusy || String(runId).trim() === "", onClick: runWhy }, t("audit.run.btn")),
					h(ActionButton, {
						tiny: true,
						disabled: runBusy,
						onClick: () => { tail.retry(); checkRes.retry(); },
					}, t("audit.refresh")),
				),
				runBlock,
				events === null
					? h(AsyncBlock, {
						t: t,
						resource: tail,
						height: SKEL_SM,
						empty: h(Empty, { text: t("audit.tail.empty"), hint: t("audit.tail.empty.hint") }),
						errorKey: "audit",
					})
					: h("div", { className: "dshp-list", style: { marginTop: 6 } },
						events.map((row, index) => h("div", { className: "dshp-list__item", key: String((row && row.recordId) || index) },
							h("div", { className: "dshp-list__head" },
								h("span", { className: "dshp-list__name" }, String((row && row.event) || "—")),
								h("span", { className: "dshp-list__meta" },
									[String((row && row.layer) || ""), String((row && row.result) || ""), String((row && row.ts) || "")]
										.filter((part) => part !== "").join(" · ")),
							),
						)),
					),
			);
		}

		function HealthSection(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const state = props.state || null;
			const healthRes = useAsyncResource(fetchHealth);
			const health = healthRes.phase === "ready" ? healthRes.data : null;

			const preset = (state && state.preset) || null;
			const install = health && health.install ? health.install : null;
			const presetCopy = health && health.presetCopy ? health.presetCopy : null;
			const logs = health && health.logs ? health.logs : null;

			const driftValue = (() => {
				if (!health) return null;
				if (!install || install.recorded !== true) return t("health.install.missing");
				return t("health.install.counts", {
					drifted: String(install.drifted || 0),
					missing: String(install.missing || 0),
					added: String(install.added || 0),
				});
			})();

			/* 「没有记录」既不是一致也不是不一致：那是不可判，用 idle 点，别拿红点冒充问题。 */
			const copyTone = !install || install.recorded !== true ? "idle" : install.consistent === true ? "ok" : "bad";
			const copyValue = !health || !install
				? null
				: install.recorded !== true
					? t("health.copy.unknown")
					: install.consistent === true
						? t("health.copy.same")
						: t("health.copy.diff", { n: String((install.drifted || 0) + (install.missing || 0) + (install.added || 0)) });

			/* 预设那行有两个事实：注册走到哪一步（共享快照的预设块）、仓库与已装副本一不一样
			   （health 的 presetCopy 组）。后者没读到时只印前者 —— 拿「没读到」冒充「一致」，
			   和拿「没有记录」冒充「一致」是同一种谎。
			   注册状态本身走 `settingsPresetWord`：`phase` / `broken` 是内部取值，上屏要说人话
			   （判据见 `test/settings-plain-words.test.mjs`）。 */
			const driftNote = !presetCopy || presetCopy.present !== true
				? ""
				: presetCopy.consistent === true
					? " · " + t("health.copy.same")
					: " · " + t("health.copy.diff", { n: String(presetCopy.drifted || 0) });
			const presetWord = settingsPresetWord(preset || {});
			const presetValue = h(react.Fragment, null,
				h(StatusDot, { tone: presetWord.tone }),
				h("span", null, " " + t(presetWord.key, presetWord.params) + driftNote),
			);

			const trackRow = (label, track, rule) => {
				if (!track) return h(Row, { label: label, value: "—" });
				const tail = track.present ? rule : t("logs.absent");
				return h(Row, { label: label, value: String(track.path || "—") + " · " + tail });
			};

			const rollRule = (track) => {
				if (!track) return "—";
				return t("logs.rule.roll", {
					generations: String(track.generations || 0),
					size: formatSize(track.maxBytes || 0),
				});
			};

			/* 两块共用一次取数与一处失败：一个读不到的健康端点，不该在页面上裂成两个失败。 */
			return h(AsyncBlock, { t: t, resource: healthRes, height: SKEL_LG, errorKey: "audit" },
				h(react.Fragment, null,
					h(Section, { title: t("section.health"), hint: t("health.hint") },
						driftValue === null
							? null
							: h(Row, {
								label: t("health.install"),
								value: h(react.Fragment, null,
									h(StatusDot, { tone: install && install.recorded === true && (install.drifted || install.missing || install.added) === 0 ? "ok" : "idle" }),
									h("span", null, " " + driftValue),
								),
							}),
						driftValue === null ? null : h(Row, {
							label: t("health.copy"),
							value: copyValue === null
								? "—"
								: h(react.Fragment, null, h(StatusDot, { tone: copyTone }), h("span", null, " " + copyValue)),
						}),
						h(Row, { label: t("health.preset"), value: presetValue }),
					),
					h(Section, { title: t("section.logs"), hint: t("logs.hint") },
						!logs
							? null
							: h(react.Fragment, null,
								trackRow(t("logs.track.audit"), logs.audit, t("logs.rule.daily")),
								trackRow(t("logs.track.diag"), logs.diag, rollRule(logs.diag)),
								trackRow(t("logs.track.internal"), logs.internal, rollRule(logs.internal)),
							),
					),
				),
			);
		}

		/**
		 * 诊断页签的容器：先把共享快照的五态摆在最外层，两块再各自取自己的只读端点。
		 *
		 * 两块都依赖共享快照（预设注册、判据口径），所以快照没读到时它们不挂载 —— 也就
		 * 不会带着「空」去各取一遍。
		 */
		function DiagnosticsPanel(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			const resource = props.resource || null;
			const state = resource && resource.data ? resource.data : null;
			return h(AsyncBlock, { t: t, resource: resource, height: SKEL_MD },
				h(react.Fragment, null,
					h(AuditSection, { t: t, state: state }),
					h(HealthSection, { t: t, state: state }),
				),
			);
		}
		function reopenAfterRestart() {
			window.location.reload();
		}

		/* 重启轮询链最长活 90 秒，且它的自然终点是 reload（成功）或超时。
			热替换装载新闭包后，旧闭包的链没有组件卸载点可挂 —— 与 dock/auth.js
			同理，用 window epoch 让旧闭包的 timer 与迟到回包自停。 */
		const RESTART_EPOCH = (window.__dshPurgeRestartEpoch = (window.__dshPurgeRestartEpoch || 0) + 1);
		const restartChainStale = () => RESTART_EPOCH !== window.__dshPurgeRestartEpoch;

		function waitForRestart(setNotice, setBusy, t) {
			const started = Date.now();
			// 必须先看到旧进程掉线，再等新进程就绪；否则同进程立刻 200 会被当成「重启成功」又弹重启。
			let sawDown = false;
			const ping = () => {
				if (restartChainStale()) return;
				fetch(apiUrl(PURGE_STATUS_PATH), { cache: "no-store", credentials: "same-origin" })
					.then((r) => (r.ok ? r.json() : Promise.reject()))
					.then((d) => {
						if (restartChainStale()) return;
						if (!sawDown) {
							retry();
							return;
						}
						if (d && d.ok && d.ready !== false) reopenAfterRestart();
						else retry();
					})
					.catch(() => {
						if (restartChainStale()) return;
						sawDown = true;
						retry();
					});
			};
			const retry = () => {
				if (restartChainStale()) return;
				if (Date.now() - started > 90000) {
					setNotice({ kind: "error", text: t("restart.timeout") });
					setBusy(false);
					return;
				}
				setTimeout(ping, 500);
			};
			setTimeout(ping, 800);
		}

		let restartOnce = false;

		function restartDsh(setNotice, setBusy, t, surface) {
			if (restartOnce) return;
			const surf = surface || clientGuessSurface() || "desktop";
			const desktop = surf === "desktop" || clientGuessSurface() === "desktop";
			restartOnce = true;
			setBusy(true);
			setNotice({ kind: "ok", text: hostText(t, "restarting", surf) });
			const stop = (error) => {
				restartOnce = false;
				setNotice({ kind: "error", text: error ? t("restart.fail", { error }) : t("restart.notStarted") });
				setBusy(false);
			};
			let sawDrop = false;
			const watch = setTimeout(() => {
				if (sawDrop) return;
				stop("");
			}, 25000);
			fetch("/dsh-purge/restart", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
				.then((r) => r.json())
				.then((d) => {
					if (!d.ok) throw new Error(d.error || "restart failed");
					const next = (d && d.surface) || surf;
					const full = next === "desktop" || (d && d.fullApp) || desktop;
					if (full && d.already) {
						setNotice({ kind: "ok", text: hostText(t, "restarting", next) });
						return;
					}
					if (full && d.restarting === false) {
						clearTimeout(watch);
						stop(d.error || "not started");
						return;
					}
					setNotice({ kind: "ok", text: hostText(t, "restarting", next) });
					if (full) return;
					clearTimeout(watch);
					restartOnce = false;
					waitForRestart(setNotice, setBusy, t);
				})
				.catch((e) => {
					const msg = String((e && e.message) || e || "");
					const dropped = /failed to fetch|networkerror|load failed/i.test(msg) || e.name === "TypeError";
					if (dropped && desktop) {
						sawDrop = true;
						clearTimeout(watch);
						return;
					}
					clearTimeout(watch);
					stop(msg || "restart failed");
				});
		}

		/* 回溯菜单是唯一直接 portal 到 document.body 的插件节点（兄弟就是宿主 DOM），所以它自己
		   站在边界上：z 走 --dshp-z-boundary，取值等于收编前写死的 2147483000，外观不变。它不参与
		   插件内部的比大小，层内先后由 design/ 那几份片段里的令牌决定。 */
		const REWIND_CSS = `
.dshp-rewind-wrap{position:relative;display:inline-flex}
.dshp-rewind{appearance:none;display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);font:12px/1 var(--ds-font-sans,system-ui,sans-serif);cursor:pointer}
.dshp-rewind:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb, var(--dshp-c-scrim) 12%, transparent));color:var(--dsw-alias-label-primary,currentColor)}
.dshp-rewind:disabled{opacity:.4;cursor:default}
.dshp-rewind svg{display:block}
.dshp-rewind-menu{position:fixed;z-index:var(--dshp-z-boundary);isolation:isolate;box-sizing:border-box;min-width:220px;padding:4px;border:0;border-radius:12px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2,var(--dshp-c-bg-card)));color:var(--dsw-alias-label-primary,var(--dshp-c-text));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1,var(--dshp-c-text));box-shadow:var(--dsw-elevation-prominent,0 8px 24px color-mix(in srgb, var(--dshp-c-scrim) 16%, transparent));transform:translateY(-100%)}
.dshp-rewind-item{display:flex;flex-direction:column;gap:2px;width:100%;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:12px/1.3 var(--ds-font-sans,system-ui,sans-serif)}
.dshp-rewind-item:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb, var(--dshp-c-scrim) 12%, transparent))}
.dshp-rewind-item b{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
.dshp-rewind-item span{color:var(--dsw-alias-label-tertiary,var(--dshp-c-text-muted));font-size:11px}
.dshp-continue{appearance:none;display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);font:12px/1 var(--ds-font-sans,system-ui,sans-serif);cursor:pointer}
.dshp-continue:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb, var(--dshp-c-scrim) 12%, transparent));color:var(--dsw-alias-label-primary,currentColor)}
.dshp-continue:disabled{opacity:.4;cursor:default}
.dshp-continue.is-ready{color:var(--dsw-alias-label-primary,currentColor)}
.dshp-continue svg{display:block}
`;
		const DRAFT_KEY = "dshp-rewind-draft:";
		const ARM_KEY = "dshp-rewind-arm:";
		const FILL_DELAYS = [0, 50, 180, 400, 800];
		const ARM_TTL_MS = 45 * 1000;
		let rewindSeenAt = 0;
		let rewindSessions = null;
		let rewindHost = null;
		let rewindWorkspace = null;
		let rewindConversation = null;
		let pendingComposer = { sessionId: "", text: "", at: 0 };
		let armedFill = { sessionId: "", text: "", at: 0 };

		function rewindText(t, key, fallback) {
			try {
				if (typeof t === "function") {
					const value = t(key);
					if (value && value !== key) return value;
				}
			} catch { /* ignore */ }
			return fallback;
		}

		function currentSessionId(sessions) {
			try {
				const selected = rewindWorkspace?.selection?.getSnapshot?.()?.sessionId;
				if (typeof selected === "string" && selected) return selected;
			} catch { /* ignore */ }
			try {
				const snap = sessions?.list?.getSnapshot?.();
				if (typeof snap?.current === "string" && snap.current) return snap.current;
			} catch { /* ignore */ }
			return "";
		}

		function sessionKnown(sessions, sessionId) {
			try {
				const snap = sessions?.list?.getSnapshot?.();
				if (!snap || !sessionId) return false;
				if (snap.byId && Object.prototype.hasOwnProperty.call(snap.byId, sessionId)) return true;
				if (Array.isArray(snap.ids) && snap.ids.includes(sessionId)) return true;
			} catch { /* ignore */ }
			return false;
		}

		function waitMs(ms) {
			return new Promise((resolve) => window.setTimeout(resolve, ms));
		}

		function isPluginDraft(text) {
			const value = String(text || "").trim();
			if (!value) return false;
			return /^\[MNEMON\]/i.test(value)
				|| /MNEMON RUNTIME MEMORY SNAPSHOT/i.test(value)
				|| /^MNEMON VIEW TOOLS/im.test(value);
		}

		function writeDraft(sessionId, text) {
			if (!sessionId) return;
			const value = isPluginDraft(text) ? "" : (text || "");
			pendingComposer = { sessionId, text: value, at: Date.now() };
			try { sessionStorage.setItem(DRAFT_KEY + sessionId, value); } catch { /* ignore */ }
		}

		function peekDraft(sessionId) {
			if (!sessionId) return "";
			if (pendingComposer.sessionId === sessionId && pendingComposer.text) return pendingComposer.text;
			try { return sessionStorage.getItem(DRAFT_KEY + sessionId) || ""; } catch { return ""; }
		}

		function clearStoredDraft(sessionId) {
			if (!sessionId) return;
			if (pendingComposer.sessionId === sessionId) pendingComposer = { sessionId: "", text: "", at: 0 };
			try { sessionStorage.removeItem(DRAFT_KEY + sessionId); } catch { /* ignore */ }
			try { sessionStorage.removeItem(ARM_KEY + sessionId); } catch { /* ignore */ }
		}

		function armComposerFill(sessionId, text) {
			if (!sessionId || !text || isPluginDraft(text)) return;
			const at = Date.now();
			armedFill = { sessionId, text, at };
			writeDraft(sessionId, text);
			try { sessionStorage.setItem(ARM_KEY + sessionId, String(at)); } catch { /* ignore */ }
		}

		function takeArmedFill(sessionId) {
			if (!sessionId) return "";
			let text = "";
			let at = 0;
			if (armedFill.sessionId === sessionId && armedFill.text) {
				text = armedFill.text;
				at = armedFill.at;
			} else {
				text = peekDraft(sessionId);
				try { at = Number(sessionStorage.getItem(ARM_KEY + sessionId) || 0); } catch { at = 0; }
			}
			if (!text || !at || Date.now() - at > ARM_TTL_MS) {
				if (text && (!at || Date.now() - at > ARM_TTL_MS)) clearStoredDraft(sessionId);
				return "";
			}
			clearStoredDraft(sessionId);
			armedFill = { sessionId: "", text: "", at: 0 };
			return text;
		}

		function conversationFace() {
			if (rewindConversation) return rewindConversation;
			const host = rewindHost;
			if (host?.conversation) return host.conversation;
			if (typeof host?.get === "function") {
				try { return host.get("conversation"); } catch { return undefined; }
			}
			return undefined;
		}

		function conversationInput(sessionId) {
			try {
				const input = conversationFace()?.input;
				if (!input || !sessionId) return null;
				if (typeof input.shell === "function") {
					try { return input.shell(sessionId); } catch { /* session not retained yet */ }
				}
				const sessions = rewindHost?.sessions || rewindSessions;
				const actx = typeof sessions?.scope === "function" ? sessions.scope(sessionId) : undefined;
				if (typeof input.for === "function" && actx) return input.for(actx);
				return null;
			} catch {
				return null;
			}
		}

		function liveDraft(sessionId, inputActions) {
			try {
				const fromActions = inputActions?.state?.getSnapshot?.()?.draft;
				if (typeof fromActions === "string") return fromActions;
			} catch { /* ignore */ }
			try {
				const draft = conversationInput(sessionId)?.state?.getSnapshot?.()?.draft;
				if (typeof draft === "string") return draft;
			} catch { /* ignore */ }
			return "";
		}

		function hostSetDraft(sessionId, text) {
			if (!sessionId) return false;
			try {
				const input = conversationInput(sessionId);
				if (input && typeof input.setDraft === "function") {
					input.setDraft(text || "");
					return true;
				}
			} catch { /* ignore */ }
			return false;
		}

		function fillComposer(inputActions, text) {
			if (inputActions && typeof inputActions.setDraft === "function") {
				try { inputActions.setDraft(text || ""); } catch { /* ignore */ }
			}
		}

		function scheduleComposerFill(sessionId, text, inputActions) {
			if (!sessionId || !text || isPluginDraft(text)) return () => {};
			let stopped = false;
			let filled = false;
			const timers = [];
			const tryFill = () => {
				if (stopped) return;
				const current = liveDraft(sessionId, inputActions);
				if (filled && current !== text) {
					stopped = true;
					return;
				}
				if (current && current !== text) {
					stopped = true;
					return;
				}
				fillComposer(inputActions, text);
				hostSetDraft(sessionId, text);
				filled = true;
			};
			for (const ms of FILL_DELAYS) timers.push(window.setTimeout(tryFill, ms));
			return () => {
				stopped = true;
				for (const t of timers) { try { window.clearTimeout(t); } catch { /* ignore */ } }
			};
		}

		function scheduleEchoClear(sessionId, inputActions) {
			if (!sessionId) return () => {};
			let last = "";
			let stopped = false;
			const timers = [];
			const tryClear = () => {
				if (stopped || !last) return;
				const current = String(liveDraft(sessionId, inputActions) || "").trim();
				if (!current) {
					stopped = true;
					return;
				}
				if (current !== last) return;
				fillComposer(inputActions, "");
				hostSetDraft(sessionId, "");
				clearStoredDraft(sessionId);
				stopped = true;
			};
			apiJson("/dsh-purge/last-user?sessionId=" + encodeURIComponent(sessionId)).then((data) => {
				if (stopped) return;
				last = String(data?.text || "").trim();
				if (!last || isPluginDraft(last)) return;
				tryClear();
				for (const ms of [0, 50, 180, 400]) timers.push(window.setTimeout(tryClear, ms));
			}).catch(() => {});
			return () => {
				stopped = true;
				for (const t of timers) { try { window.clearTimeout(t); } catch { /* ignore */ } }
			};
		}

		async function dropInheritedQueue(sessions, sessionId) {
			if (!sessions || !sessionId) return;
			const drop = async () => {
				try {
					const actx = typeof sessions.scope === "function" ? sessions.scope(sessionId) : undefined;
					const face = typeof sessions.sessionOf === "function" ? sessions.sessionOf(actx) : undefined;
					const queue = face?.getSnapshot?.()?.queue || [];
					for (const item of queue) {
						const id = item?.id || item?.itemId;
						if (!id) continue;
						try { await face.updateQueue?.(id, { kind: "remove" }); } catch { /* ignore */ }
					}
				} catch { /* ignore */ }
			};
			await drop();
			window.setTimeout(() => { drop(); }, 80);
		}

		async function openRewoundSession(sessions, sessionId) {
			if (!sessionId) return;
			const workspace = rewindWorkspace;
			let lastError = null;
			for (let attempt = 0; attempt < 25; attempt += 1) {
				if (sessions && typeof sessions.refresh === "function" && !sessionKnown(sessions, sessionId)) {
					try { await sessions.refresh(); } catch (error) { lastError = error; }
				}
				const known = sessionKnown(sessions, sessionId);
				if (known || typeof sessions?.open === "function") {
					try {
						if (workspace && typeof workspace.openSession === "function") {
							workspace.openSession(sessionId);
						} else if (typeof sessions?.open === "function") {
							sessions.open(sessionId);
						} else {
							throw new Error(dt('drill.d756'));
						}
						const selected = workspace?.selection?.getSnapshot?.()?.sessionId;
						if (!workspace || selected === sessionId) {
							await dropInheritedQueue(sessions, sessionId);
							window.setTimeout(() => { dropInheritedQueue(sessions, sessionId); }, 250);
							return;
						}
					} catch (error) {
						lastError = error;
					}
				}
				await waitMs(120);
			}
			throw new Error((lastError && lastError.message) || dt('drill.d757'));
		}

		class RewindSafe extends Component {
			constructor(p) { super(p); this.state = { failed: false }; }
			static getDerivedStateFromError() { return { failed: true }; }
			componentDidCatch(error) { try { console.error("[dsh-purge] rewind slot:", error); } catch { /* ignore */ } }
			render() {
				if (this.state.failed) return h(RewindFallback, this.props);
				return h(RewindButton, this.props);
			}
		}

		function rewindMenuNode(t, menuPos, menuRef, runRewind) {
			const menu = h("div", {
				className: "dshp-rewind-menu",
				role: "menu",
				ref: menuRef,
				style: menuPos ? { left: menuPos.left + "px", top: menuPos.top + "px" } : { left: "8px", bottom: "48px", transform: "none" },
			},
				h("button", {
					type: "button",
					className: "dshp-rewind-item",
					onMouseDown: (e) => { e.preventDefault(); e.stopPropagation(); },
					onClick: (e) => { e.preventDefault(); e.stopPropagation(); runRewind("once"); },
				},
					h("b", null, rewindText(t, "rewind.once", dt('drill.d758'))),
					h("span", null, rewindText(t, "rewind.once.hint", dt('drill.d759'))),
				),
				h("button", {
					type: "button",
					className: "dshp-rewind-item",
					onMouseDown: (e) => { e.preventDefault(); e.stopPropagation(); },
					onClick: (e) => { e.preventDefault(); e.stopPropagation(); runRewind("round"); },
				},
					h("b", null, rewindText(t, "rewind.round", dt('drill.d760'))),
					h("span", null, rewindText(t, "rewind.round.hint", dt('drill.d761'))),
				),
			);
			try {
				const rd = require("react-dom");
				if (rd && typeof rd.createPortal === "function" && typeof document !== "undefined") {
					return rd.createPortal(menu, document.body);
				}
			} catch { /* 没有 portal 时菜单仍挂在按钮旁 */ }
			return menu;
		}

		class RewindFallback extends Component {
			constructor(p) {
				super(p);
				this.state = { menu: false, busy: false, notice: "", menuPos: null };
				this.wrap = null;
				this.menuEl = null;
				this.onDoc = (event) => {
					if (this.wrap && this.wrap.contains(event.target)) return;
					if (this.menuEl && this.menuEl.contains(event.target)) return;
					this.setState({ menu: false });
				};
			}
			componentDidMount() {
				document.addEventListener("mousedown", this.onDoc);
			}
			componentWillUnmount() {
				document.removeEventListener("mousedown", this.onDoc);
			}
			run(mode) {
				const sessionId = this.props.sessionId || currentSessionId(rewindSessions);
				if (!sessionId || this.state.busy) return;
				this.setState({ busy: true, menu: false, notice: "" });
				apiJson("/dsh-purge/rewind", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId, mode }),
				}).then(async (data) => {
					if (!data || !data.ok || !data.sessionId || data.cleared === false) {
						throw new Error((data && data.error) || dt('drill.d762'));
					}
					if (data.at) rewindSeenAt = data.at;
					const text = isPluginDraft(data.text) ? "" : (data.text || "");
					armComposerFill(data.sessionId, text);
					await openRewoundSession(rewindSessions, data.sessionId);
					scheduleComposerFill(data.sessionId, text);
					this.setState({ busy: false });
				}).catch((e) => {
					this.setState({
						busy: false,
						notice: dt('drill.d763') + String((e && e.message) || e),
					});
				});
			}
			openMenu() {
				const rect = this.wrap && this.wrap.getBoundingClientRect ? this.wrap.getBoundingClientRect() : null;
				this.setState({
					menu: !this.state.menu,
					notice: "",
					menuPos: rect ? { left: Math.max(8, rect.right - 228), top: Math.max(8, rect.top - 8) } : null,
				});
			}
			render() {
				const sessionId = this.props.sessionId || currentSessionId(rewindSessions);
				const t = this.props.t || translate;
				const label = this.state.busy ? [dt('drill.k30081')] : (this.state.notice ? this.state.notice.slice(0, 18) : dt('drill.d764'));
				return h("div", { className: "dshp-rewind-wrap", ref: (node) => { this.wrap = node; } },
					h("style", null, REWIND_CSS),
					h("button", {
						type: "button",
						className: "dshp-rewind",
						disabled: this.state.busy || !sessionId,
						onMouseDown: (e) => e.preventDefault(),
						onClick: (e) => { e.preventDefault(); this.openMenu(); },
					}, label),
					this.state.menu ? rewindMenuNode(t, this.state.menuPos, (node) => { this.menuEl = node; }, (mode) => this.run(mode)) : null,
				);
			}
		}

		function RewindButton(props) {
			const t = props.t || translate;
			const sessions = rewindSessions;
			const inputActions = props.inputActions;
			const sessionId = props.sessionId || currentSessionId(sessions);
			const wrapRef = useRef(null);
			const menuRef = useRef(null);
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState("");
			const [menu, setMenu] = useState(false);
			const [menuPos, setMenuPos] = useState(null);

		useEffect(() => {
			if (!sessionId) return;
			const armed = takeArmedFill(sessionId);
			/* 两个调度器都自带取消函数（清掉各自的 timer 并置 stopped）；
				经 effect 清理返回后，「组件先卸载」与调度器 800ms 自然到期走同一条
				回收路径，不需要为取消另设状态。 */
			if (armed) return scheduleComposerFill(sessionId, armed, inputActions);
			return scheduleEchoClear(sessionId, inputActions);
		}, [sessionId, inputActions]);

			useEffect(() => {
				if (!menu) return;
				const onDoc = (event) => {
					if (wrapRef.current && wrapRef.current.contains(event.target)) return;
					if (menuRef.current && menuRef.current.contains(event.target)) return;
					setMenu(false);
				};
				document.addEventListener("mousedown", onDoc);
				return () => document.removeEventListener("mousedown", onDoc);
			}, [menu]);

			const runRewind = async (mode) => {
				if (!sessionId || busy) return;
				setBusy(true);
				setMenu(false);
				setNotice("");
				try {
					const data = await apiJson("/dsh-purge/rewind", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId, mode }),
					});
					if (!data || !data.ok || !data.sessionId || data.cleared === false) {
						throw new Error((data && data.error) || dt('drill.d762'));
					}
					if (data.at) rewindSeenAt = data.at;
					const text = isPluginDraft(data.text) ? "" : (data.text || "");
					armComposerFill(data.sessionId, text);
					await openRewoundSession(sessions, data.sessionId);
					scheduleComposerFill(data.sessionId, text);
				} catch (e) {
					const message = rewindText(t, "rewind.fail", dt('drill.d765')).replace("{error}", String((e && e.message) || e));
					setNotice(message);
				} finally {
					setBusy(false);
				}
			};

			const onClick = (event) => {
				event?.preventDefault?.();
				event?.stopPropagation?.();
				if (!sessionId || busy) return;
				if (menu) {
					setMenu(false);
					return;
				}
				const rect = wrapRef.current?.getBoundingClientRect?.();
				if (rect) {
					setMenuPos({
						left: Math.max(8, rect.right - 228),
						top: Math.max(8, rect.top - 8),
					});
				}
				setNotice("");
				setMenu(true);
			};

			const failLabel = notice
				? (notice.length > 18 ? notice.slice(0, 18) + "…" : notice)
				: "";
			const label = busy
				? rewindText(t, "rewind.busy", dt('drill.d766'))
				: (failLabel || rewindText(t, "rewind.label", dt('drill.d764')));
			const title = notice || rewindText(t, "rewind.aria", dt('drill.d764'));
			return h("div", { className: "dshp-rewind-wrap", ref: wrapRef },
				h("style", null, REWIND_CSS),
				h("button", {
					type: "button",
					className: "dshp-rewind",
					title,
					"aria-label": rewindText(t, "rewind.aria", dt('drill.d764')),
					"aria-expanded": menu ? "true" : "false",
					disabled: busy || !sessionId,
					onMouseDown: (e) => e.preventDefault(),
					onClick,
				},
					h("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": true },
						h("path", {
							fill: "currentColor",
							d: "M7.2 3.2 3.4 7l3.8 3.8V8.6c2.8 0 4.7.7 5.9 2.3-.2-2.8-1.9-5.2-5.9-5.6V3.2z",
						}),
					),
					label,
				),
				menu ? rewindMenuNode(t, menuPos, menuRef, runRewind) : null,
			);
		}

		function installRewindWatch(ctx) {
			const sessions = ctx.sessions;
			if (!sessions) return () => {};
			const tick = async () => {
				try {
					const data = await apiJson("/dsh-purge/rewind");
					if (!data || !data.sessionId || !data.at || data.at <= rewindSeenAt) return;
					rewindSeenAt = data.at;
					const current = currentSessionId(sessions);
					if (current && current !== data.parentId) return;
					const text = isPluginDraft(data.text) ? "" : (data.text || "");
					armComposerFill(data.sessionId, text);
					scheduleComposerFill(data.sessionId, text);
					await openRewoundSession(sessions, data.sessionId);
					scheduleComposerFill(data.sessionId, text);
				} catch { /* ignore */ }
			};
			const timer = window.setInterval(tick, 1200);
			return () => window.clearInterval(timer);
		}

		/* __DSH_PURGE_DRILL_BEGIN__ */
		// 内嵌演练台（源码在 lib/redteam，已并进本插件）
		const __dshPurgeDrill = (() => {
			var module = { exports: {} };
			var exports = module.exports;

    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /*
     * 演练台自己是一块浮动窗：position:fixed，用 left/top/width/height 放。
     * 不给官方 frame 加 padding，不改官方输入框的宽度。嵌在清洗面板里时走 .rt-embedded。
     */
    const CSS = `
.rt-dock{position:fixed;top:12px;right:12px;z-index:20;display:flex;flex-direction:column;box-sizing:border-box;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,var(--dshp-c-bg-page)) 52%,transparent);
  backdrop-filter:blur(20px) saturate(1.3);-webkit-backdrop-filter:blur(20px) saturate(1.3);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,var(--dshp-c-border)) 70%,transparent);
  border-radius:12px;
  box-shadow:0 18px 48px color-mix(in srgb,var(--dshp-c-bg-page) 28%,transparent);pointer-events:auto;color:var(--dsw-alias-label-primary);
  font-size:13px;line-height:1.5}
.rt-dock.rt-embedded{position:relative;inset:auto;width:100%;height:100%;max-width:none;border:0;border-radius:0;box-shadow:none;background:transparent!important;backdrop-filter:none;-webkit-backdrop-filter:none}
.rt-grip,.rt-resize-r,.rt-resize-b,.rt-resize-c{position:absolute;z-index:3;touch-action:none}
.rt-grip{left:-3px;top:0;bottom:0;width:8px;cursor:ew-resize;background:transparent}
.rt-resize-r{right:-3px;top:0;bottom:14px;width:8px;cursor:ew-resize}
.rt-resize-b{left:8px;right:14px;bottom:-3px;height:8px;cursor:ns-resize}
.rt-resize-c{right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize}
.rt-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-title{font-weight:600;font-size:14px;display:flex;align-items:center;gap:6px;white-space:nowrap}
.rt-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
.rt-spacer{flex:1}
.rt-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:inherit;
  border-radius:6px;padding:3px 9px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}
.rt-btn:hover{border-color:var(--dsw-alias-border-l2)}
.rt-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dshp-c-text-muted)}
.rt-btn-primary:hover{opacity:.9}
.rt-btn:disabled{opacity:.5;cursor:default}
.rt-tabs{display:flex;flex-wrap:wrap;gap:2px;padding:6px 12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-tab{padding:8px 10px 7px;border-radius:0;cursor:pointer;font-size:12.5px;color:var(--dsw-alias-label-secondary);
  display:inline-flex;align-items:center;gap:5px;border-bottom:2px solid transparent;margin-bottom:-1px;background:transparent}
.rt-tab:hover{color:var(--dsw-alias-label-primary)}
.rt-tab.on{color:var(--dsw-alias-label-primary);background:transparent;font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary,var(--dshp-c-border))}
/* 未读红点：该页签有新内容（新资产/新漏洞/新得分/新步骤…），点开看过就消失 */
.rt-tab-dot{width:7px;height:7px;border-radius:50%;background:var(--dshp-c-bg-card);flex:none;
  box-shadow:0 0 0 2px color-mix(in srgb, var(--dshp-c-bg-card) 22%, transparent)}
.rt-body{flex:1;min-height:0;display:flex;flex-direction:column}
.rt-split{flex:1;min-height:0;display:flex}
.rt-side{width:200px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:8px}
.rt-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.rt-seg{padding:7px 8px;border-radius:6px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}
.rt-seg:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-seg.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}
.rt-seg-cidr{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
.rt-seg-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.rt-toolbar{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;align-items:center}
.rt-input{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:inherit;
  border-radius:6px;padding:4px 8px;font-size:12px;font-family:inherit;outline:none;min-width:0}
.rt-input:focus{border-color:var(--dsw-alias-brand-primary)}
.rt-input option,.rt-eng-select option{background:var(--dsw-alias-bg-layer-1,var(--dshp-c-bg-page));color:var(--dsw-alias-label-primary,var(--dshp-c-text-muted))}
.rt-eng-select{color:var(--dsw-alias-label-primary,var(--dshp-c-text-muted));background:var(--dsw-alias-bg-layer-2,var(--dshp-c-bg-page))}
.rt-table{flex:1;overflow:auto}
.rt-row{display:grid;grid-template-columns:150px 74px 104px 1.15fr 1fr;gap:8px;padding:6px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;cursor:pointer;font-size:12.5px}
.rt-row:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-row.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;position:sticky;top:0;
  background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-row.head:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-mono{font-family:ui-monospace,Menlo,monospace}
.rt-tag{display:inline-block;padding:0 5px;border-radius:4px;font-size:11px;margin-right:4px;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-tag-passive{color:var(--dshp-c-accent);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-accent) 10%, transparent)}
.rt-tag-active{color:var(--dshp-c-warn);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-warn) 10%, transparent)}
.rt-tag-live{color:var(--dshp-c-brand);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-brand) 10%, transparent)}
.rt-tag-warn{color:var(--dshp-c-danger);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-danger) 10%, transparent)}
/* 纪律提示条：不满足交付要求（非冰蝎/哥斯拉马、没有 suo5 隧道）时顶在区块最上方 */
.rt-hint{border-radius:6px;padding:7px 9px;margin-bottom:8px;font-size:11.5px;line-height:1.6;
  border:1px dashed color-mix(in srgb, var(--dshp-c-border) 53%, transparent);background:color-mix(in srgb, var(--dshp-c-scrim) 6%, transparent);color:var(--dsw-alias-label-primary)}
.rt-hint b{color:var(--dshp-c-text-muted)}
.rt-tag-dead{color:var(--dsw-alias-label-secondary)}
.rt-expand{grid-column:1/-1;padding:8px 4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-kv{display:flex;gap:8px;margin-bottom:3px;align-items:baseline}
.rt-kv b{color:var(--dsw-alias-label-primary);font-weight:600;min-width:64px;flex:none}
/* 图谱视图已移除（见 AssetsTab：资产关系由「域名维度」与 redteam_attack_path 工具承担） */
.rt-pane{flex:1;min-height:0;overflow:auto;padding:12px}
.rt-card{border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,var(--dshp-c-border)) 75%,transparent);border-radius:8px;padding:10px;margin-bottom:10px;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,var(--dshp-c-bg-page)) 48%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.rt-card h4{margin:0 0 6px;font-size:13px}
.rt-textarea{width:100%;min-height:260px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);
  color:inherit;border-radius:6px;padding:8px;font-size:12.5px;font-family:ui-monospace,Menlo,monospace;
  line-height:1.6;resize:vertical;outline:none;box-sizing:border-box}
.rt-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.rt-list{width:210px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:8px}
.rt-item{padding:7px 8px;border-radius:6px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}
.rt-item:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-item.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}
.rt-item-name{font-weight:600;font-size:12.5px}
.rt-item-desc{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rt-empty{padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.rt-err{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:6px 10px}
.rt-foot{padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;
  color:var(--dsw-alias-label-secondary);display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.rt-icon-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;border:1px solid var(--dsw-alias-border-l1);
  background:transparent;color:inherit;border-radius:6px;padding:6px 8px;cursor:pointer;font-family:inherit;font-size:12.5px}
.rt-icon-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-icon-btn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.rt-hbtn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;border-radius:6px;
  padding:2px 8px;font-size:12px;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:5px}
.rt-hbtn:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-hbtn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.rt-test{display:inline-block;padding:0 5px;border-radius:4px;font-size:11px;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.rt-test-testing{color:var(--dshp-c-text);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-scrim) 10%, transparent)}
.rt-test-tested{color:var(--dshp-c-text);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-scrim) 10%, transparent)}
.rt-test-blocked{color:var(--dshp-c-text-muted);background:var(--dshp-c-bg-card);border-color:var(--dshp-c-border)}
.rt-test-abandoned{color:var(--dshp-c-text-muted);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-scrim) 10%, transparent)}
.rt-test-no_surface{color:var(--dshp-c-text-muted);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-scrim) 10%, transparent)}
.rt-scope-testing{color:var(--dshp-c-text);background:var(--dshp-c-bg-card)}
.rt-pri{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap}
.rt-pri-high{color:var(--dshp-c-text-muted);background:var(--dshp-c-bg-card)}
.rt-pri-medium{color:var(--dshp-c-text-muted);background:var(--dshp-c-bg-page)}
.rt-pri-low{color:var(--dshp-c-text-muted);background:var(--dshp-c-bg-card)}
.rt-score-row{display:grid;grid-template-columns:16px 62px minmax(0,1fr) 116px 66px;gap:8px;padding:7px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;font-size:12.5px;cursor:pointer}
.rt-score-row:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-score-row.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;
  position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-score-detail{grid-column:1/-1;padding:8px 4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
/* 得分目标按合并版的 8 个类别分组：类别头 + 组内按分值升序 */
.rt-score-group{display:flex;align-items:center;gap:8px;padding:7px 10px 5px;margin-top:2px;
  font-size:12px;font-weight:600;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.rt-score-group:first-child{border-top:none}
.rt-score-group .rt-sg-sub{font-weight:400;font-size:11px;color:var(--dsw-alias-label-secondary)}
/* ── 会话与入口：每张卡片分「标题行 / 关键事实 / 可用命令 / 备注」四段，避免一行糊在一起 ── */
.rt-sess-facts{display:flex;flex-direction:column;gap:2px;margin-top:5px}
.rt-sess-fact{display:flex;gap:6px;font-size:11.5px;line-height:1.5}
.rt-sess-fact>b{flex:none;min-width:62px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.rt-sess-fact>span{min-width:0;overflow-wrap:anywhere}
.rt-sess-cmd{margin-top:6px}
.rt-sess-cmd>b{display:block;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:3px;font-weight:600}
.rt-sess-fold{margin-top:6px;font-size:11.5px}
.rt-sess-fold>summary{cursor:pointer;color:var(--dsw-alias-label-secondary);user-select:none}
.rt-sess-fold>summary:hover{color:var(--dsw-alias-label-primary)}
.rt-score-row .rt-scope{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.rt-score-form{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px}
.rt-score-form input,.rt-score-form select{width:100%;box-sizing:border-box}
.rt-vrow{display:grid;grid-template-columns:62px minmax(0,1fr) 132px 108px 74px 52px;gap:8px;padding:6px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;font-size:12.5px;cursor:pointer}
.rt-vrow:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-vrow.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;
  position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-vdetail{grid-column:1/-1;padding:8px 4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-vdetail .rt-kv{margin-bottom:4px}
.rt-actions{display:flex;gap:6px;margin-top:6px}
.rt-section{padding:8px 10px 2px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.rt-link{color:var(--dsw-alias-brand-primary);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-link:hover{text-decoration:underline}
.rt-full{position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;
  border-top:3px solid var(--dsw-alias-brand-primary)}
.rt-full .rt-head{padding:12px 18px}
.rt-full .rt-tabs{padding:10px 18px 0;gap:6px;flex-wrap:wrap}
.rt-full .rt-side{width:260px}
.rt-full .rt-list{width:280px}
.rt-full .rt-row{grid-template-columns:190px 90px 130px 1.4fr 1.2fr}
.rt-full .rt-vrow{grid-template-columns:80px minmax(0,1.6fr) 200px 150px 90px 64px}
.rt-full .rt-pane{padding:18px}
.rt-full .rt-textarea{min-height:60vh}
.rt-full .rt-foot{padding:10px 18px;font-size:12px}
.rt-full .rt-body{max-width:1400px;width:100%;margin:0 auto;flex:1;min-height:0;display:flex;flex-direction:column}
.rt-chain{flex:1;overflow:auto;padding:10px 12px}
.rt-step{display:flex;gap:10px;padding:8px 6px;border-left:2px solid var(--dsw-alias-border-l1);margin-left:6px}
.rt-step:last-child{border-left-color:transparent}
.rt-step-dot{width:22px;height:22px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:700;color:var(--dshp-c-text-muted);background:var(--dshp-c-bg-page);margin-left:-13px}
.rt-step-body{min-width:0}
.rt-step-title{font-weight:600;font-size:13px}
.rt-step-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:2px;word-break:break-word}
.rt-stage-recon{background:var(--dshp-c-info)}
.rt-stage-vuln{background:var(--dshp-c-warn)}
.rt-stage-exploit{background:var(--dshp-c-danger)}
.rt-stage-access{background:var(--dshp-c-brand)}
.rt-stage-pivot{background:var(--dshp-c-accent)}
.rt-stage-data{background:var(--dshp-c-info)}
.rt-stage-other{background:var(--dshp-c-bg-page)}
.rt-step-head{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.rt-step-time{font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:auto;white-space:nowrap}
.rt-step-detail{font-size:12px;margin-top:5px;white-space:pre-wrap;word-break:break-word;
  border-left:2px solid var(--dsw-alias-border-l1);padding:2px 0 2px 9px;line-height:1.6}
.rt-chip{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;padding:1px 7px;border-radius:5px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);margin:4px 5px 0 0;max-width:100%}
.rt-chip>i{font-style:normal;color:var(--dsw-alias-label-secondary);font-size:10.5px}
.rt-chip>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
.rt-stage-tag{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;color:var(--dshp-c-text-muted);font-weight:600}
.rt-st-recon{background:var(--dshp-c-bg-card)}.rt-st-vuln{background:var(--dshp-c-bg-page)}.rt-st-exploit{background:var(--dshp-c-bg-card)}
.rt-st-access{background:var(--dshp-c-bg-page)}.rt-st-pivot{background:var(--dshp-c-bg-card)}.rt-st-data{background:var(--dshp-c-bg-page)}.rt-st-other{background:var(--dshp-c-bg-page)}
.rt-sev{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;font-weight:600;border:1px solid transparent}
.rt-sev-critical{color:var(--dshp-c-text-muted);background:var(--dshp-c-bg-page)}.rt-sev-high{color:var(--dshp-c-text-muted);background:var(--dshp-c-bg-card)}
.rt-sev-medium{color:var(--dshp-c-text);background:var(--dshp-c-bg-card)}.rt-sev-low{color:var(--dshp-c-text);background:var(--dshp-c-bg-card)}
.rt-sev-info{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.rt-dot-on{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dshp-c-bg-page);box-shadow:0 0 0 3px color-mix(in srgb, var(--dshp-c-scrim) 20%, transparent)}
.rt-dot-off{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dshp-c-bg-card);box-shadow:0 0 0 3px color-mix(in srgb, var(--dshp-c-scrim) 20%, transparent)}
.rt-dot-unk{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dshp-c-bg-card);box-shadow:0 0 0 3px color-mix(in srgb, var(--dshp-c-scrim) 20%, transparent)}
.rt-sess-grid{display:grid;grid-template-columns:1fr;gap:8px;padding:10px 12px}
.rt-sess{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px 10px;background:var(--dsw-alias-bg-layer-2)}
.rt-sess-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-sess-title{font-weight:600;font-size:12.5px;font-family:ui-monospace,Menlo,monospace;word-break:break-all}
.rt-sess-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:3px;word-break:break-word}
.rt-code{font-family:ui-monospace,Menlo,monospace;font-size:11px;background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:1px 5px;cursor:pointer;word-break:break-all}
.rt-code:hover{border-color:var(--dsw-alias-brand-primary)}
.rt-evi{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;margin-top:8px}
.rt-evi-head{display:flex;align-items:center;gap:8px;padding:5px 9px;background:var(--dsw-alias-bg-layer-2);
  font-size:11.5px;font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-evi-body{margin:0;padding:9px 11px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.6;
  white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;background:var(--dsw-alias-bg-base)}
.rt-evi-body.req{max-height:220px}
.rt-hl-req{color:var(--dshp-c-text);font-weight:600}
.rt-hl-res{color:var(--dshp-c-text);font-weight:600}
.rt-gain{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:12px;
  color:var(--dshp-c-text);background:var(--dshp-c-bg-card);border:1px solid color-mix(in srgb, var(--dshp-c-border) 33%, transparent)}
.rt-total{font-size:20px;font-weight:700;font-family:ui-monospace,Menlo,monospace}
.rt-sidehead{padding:7px 8px 2px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);
  display:flex;align-items:center;gap:5px}
.rt-sidehead-btn{cursor:pointer;outline:none;padding:6px 6px 5px;border-radius:5px;user-select:none}
.rt-sidehead-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.rt-sidehead-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-scope{display:inline-block;padding:0 4px;border-radius:3px;font-size:10px;font-weight:700;line-height:15px;flex:none}
.rt-scope-internal{color:var(--dshp-c-text);background:var(--dshp-c-bg-card)}
.rt-scope-external{color:var(--dshp-c-text);background:var(--dshp-c-bg-card)}
.rt-hits{display:flex;flex-direction:column;gap:6px;margin-top:7px}
.rt-hit{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dshp-c-border);border-radius:6px;
  padding:7px 9px;background:var(--dsw-alias-bg-layer-2)}
.rt-hit-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-hit-idx{width:16px;height:16px;border-radius:50%;background:var(--dshp-c-bg-page);color:var(--dshp-c-text-muted);font-size:10.5px;font-weight:700;
  display:inline-flex;align-items:center;justify-content:center;flex:none}
.rt-hit-target{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12px;word-break:break-all}
.rt-hit-time{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-hit-evi{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;
  background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:6px 8px;margin-top:5px}
.rt-hit-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:4px}
.rt-cred{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dshp-c-border);border-radius:6px;
  padding:8px 10px;background:var(--dsw-alias-bg-layer-2);margin-bottom:7px}
.rt-cred-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-cred-host{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12.5px;word-break:break-all}
.rt-secret{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.6;background:var(--dshp-c-bg-card);color:var(--dshp-c-text);
  border:1px solid color-mix(in srgb, var(--dshp-c-border) 40%, transparent);border-radius:5px;padding:6px 9px;margin-top:6px;white-space:pre-wrap;word-break:break-all;
  user-select:all;cursor:text}
.rt-secret-none{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-state-error-primary);
  border:1px dashed var(--dsw-alias-state-error-primary);border-radius:5px;padding:5px 9px;margin-top:6px}
.rt-cred-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:5px;word-break:break-word}
.rt-stage-score{background:var(--dshp-c-brand)}
.rt-counted{font-family:ui-monospace,Menlo,monospace;font-size:12px;font-weight:700;color:var(--dshp-c-text);background:var(--dshp-c-bg-card);border:1px solid color-mix(in srgb, var(--dshp-c-border) 33%, transparent);border-radius:9px;padding:0 7px}
.rt-scorepts{font-size:11.5px;font-weight:700;color:var(--dshp-c-brand);background:var(--dshp-c-brand);border:1px solid color-mix(in srgb, var(--dshp-c-border) 33%, transparent);
  border-radius:10px;padding:0 7px;white-space:nowrap}
.rt-livebar{display:flex;align-items:center;gap:7px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);flex-wrap:wrap}
.rt-live-dot{width:8px;height:8px;border-radius:50%;background:var(--dshp-c-bg-page);flex:none;animation:rt-pulse 1.6s ease-in-out infinite}
.rt-live-dot.idle{background:var(--dshp-c-bg-card);animation:none}
@keyframes rt-pulse{{0%,100%opacity:1;box-shadow:0 0 0 0 color-mix(in srgb, var(--dshp-c-scrim) 40%, transparent)}{50%opacity:.5;box-shadow:0 0 0 5px color-mix(in srgb, var(--dshp-c-scrim) 0%, transparent)}}
.rt-live-body{padding:8px 12px 2px;max-height:44vh;overflow:auto}
.rt-atest{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dshp-c-border);border-radius:6px;
  padding:7px 10px;background:var(--dsw-alias-bg-layer-2);margin-bottom:6px}
.rt-atest.past{border-left-color:var(--dshp-c-border);opacity:.85}
.rt-atest-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-atest-ip{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12.5px;word-break:break-all}
.rt-atest-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:3px;word-break:break-word}
.rt-atest-notes{font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;
  word-break:break-word;background:var(--dsw-alias-bg-base);border-radius:4px;padding:5px 7px;margin-top:4px;max-height:76px;overflow:auto}
.rt-concl{display:flex;align-items:center;gap:4px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);flex-wrap:wrap}
.rt-concl-i{display:inline-flex;align-items:baseline;gap:4px;padding:2px 8px;border-radius:6px;cursor:pointer;
  border:1px solid transparent}
.rt-concl-i:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.rt-concl-i.on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}
.rt-concl-i b{font-family:ui-monospace,Menlo,monospace;font-size:14px;font-weight:700}
.rt-concl-i>span{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.rt-more{color:var(--dsw-alias-brand-primary);font-size:11.5px;cursor:pointer;user-select:none;margin-top:4px;display:inline-block}
.rt-more:hover{text-decoration:underline}
.rt-subtabs{display:flex;gap:4px;padding:6px 10px 0;border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center}
.rt-subtab{padding:4px 10px;border-radius:6px 6px 0 0;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-subtab.on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);font-weight:600}
.rt-sevbar{width:3px;border-radius:2px;align-self:stretch;flex:none;margin-right:2px}
/* ── 折叠层次体系 ─────────────────────────────────────────────────────────────
   L1 折叠头 .rt-sec   ：通栏、无圆角无边框、左色条、深底 —— 永远是dt('drill.d1')的
   L2 内容卡 .rt-atest/.rt-hit/.rt-cred/.rt-evi：内缩、有边框、圆角 —— 立起来
   L3 详情/长文本 .rt-clip-body / .rt-evi-body ：无边框、最浅、等宽
   L4 子项容器 .rt-sec-body：左缩进 + 竖引导线，表明dt('drill.d2')
   ──────────────────────────────────────────────────────────────────────────── */
.rt-sec-wrap{margin:0}
.rt-sec{display:flex;align-items:center;gap:8px;padding:7px 12px 7px 9px;cursor:pointer;
  background:var(--dsw-alias-bg-layer-2);border-left:3px solid var(--dsw-alias-border-l2);
  border-top:1px solid var(--dsw-alias-border-l1);user-select:none;outline:none}
.rt-sec:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-sec:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-sec.flat{cursor:default}
.rt-sec.flat:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-sec-caret{flex:none;width:11px;font-size:10px;color:var(--dsw-alias-label-secondary);text-align:center}
.rt-sec-title{font-weight:600;font-size:13px;white-space:nowrap}
.rt-sec-count{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-sec-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-sec-right{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}
.rt-sec.t-stage{border-left-color:var(--dshp-c-border)}
.rt-sec.t-target{border-left-color:var(--dshp-c-border)}
.rt-sec.t-folder{border-left-color:var(--dshp-c-border)}
.rt-sec.t-test{border-left-color:var(--dshp-c-border)}
.rt-sec.t-queue{border-left-color:var(--dshp-c-border)}
.rt-sec.t-past{border-left-color:var(--dshp-c-border)}
.rt-sec-body{margin-left:12px;border-left:1px solid var(--dsw-alias-border-l1);padding:7px 0 3px 10px}
.rt-sec-body>.rt-atest:last-child,.rt-sec-body>.rt-hit:last-child{margin-bottom:2px}
/* 长文本折叠（L3）：默认预览 2 行并渐隐，展开后限高滚动 */
.rt-clip{margin-top:6px}
.rt-clip-head{display:flex;align-items:center;gap:6px}
.rt-clip-label{font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:600}
.rt-clip-body{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.65;white-space:pre-wrap;
  word-break:break-word;background:var(--dsw-alias-bg-base);border-radius:5px;padding:6px 8px;margin-top:3px}
.rt-clip:not(.open) .rt-clip-body{max-height:46px;overflow:hidden;
  -webkit-mask-image:linear-gradient(180deg,var(--dshp-c-text) 55%,transparent);mask-image:linear-gradient(180deg,var(--dshp-c-text) 55%,transparent)}
.rt-clip.open .rt-clip-body{max-height:340px;overflow:auto}
.rt-flow{padding:10px 12px 16px}
.rt-flow-start,.rt-flow-end{font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:4px 0}
.rt-flow-end{font-weight:600;color:var(--dsw-alias-label-primary)}
.rt-flow-link{display:flex;align-items:center;gap:8px;padding:3px 0 3px 10px}
.rt-flow-arrow{color:var(--dsw-alias-border-l2);font-size:11px;flex:none}
.rt-flow-action{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-flow-action.inferred{opacity:.7;font-style:italic}
.rt-flow-node{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dshp-c-border);border-radius:8px;
  padding:8px 11px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;outline:none}
.rt-flow-node:hover{border-color:var(--dsw-alias-border-l2)}
.rt-flow-node:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-flow-node.overflow{border-left-color:var(--dshp-c-border);opacity:.75}
.rt-flow-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rt-flow-idx{width:18px;height:18px;border-radius:50%;background:var(--dshp-c-bg-page);color:var(--dshp-c-text-muted);font-size:11px;font-weight:700;
  display:inline-flex;align-items:center;justify-content:center;flex:none}
.rt-flow-node.overflow .rt-flow-idx{background:var(--dshp-c-bg-card)}
.rt-flow-name{font-weight:600;font-size:13px}
.rt-flow-pts{margin-left:auto;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;font-weight:700;color:var(--dshp-c-text);
  background:var(--dshp-c-bg-card);border:1px solid color-mix(in srgb, var(--dshp-c-border) 33%, transparent);border-radius:10px;padding:0 8px;white-space:nowrap}
.rt-flow-pts.off{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.rt-flow-times{font-size:11px;color:var(--dsw-alias-label-secondary)}
.rt-flow-target{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;margin-top:4px;word-break:break-all;
  color:var(--dsw-alias-label-secondary)}
.rt-flow-gain{font-size:12px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-flow-detail{margin-top:7px;padding-top:7px;border-top:1px dashed var(--dsw-alias-border-l1)}
.rt-hflow-wrap{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto}
.rt-hflow{display:flex;align-items:center;gap:0;padding:16px 12px;overflow-x:auto;flex-wrap:nowrap}
.rt-hflow-item{display:flex;align-items:center;flex:none}
.rt-hflow-start,.rt-hflow-end{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;padding:0 4px}
.rt-hflow-end{font-weight:600;color:var(--dsw-alias-label-primary)}
.rt-hflow-arrow{color:var(--dsw-alias-border-l2);padding:0 5px;font-size:13px;flex:none}
.rt-hflow-node{display:flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);
  border-left:3px solid var(--dshp-c-border);border-radius:7px;padding:5px 8px;background:var(--dsw-alias-bg-layer-2);
  cursor:pointer;white-space:nowrap;outline:none}
.rt-hflow-node:hover{border-color:var(--dsw-alias-border-l2)}
.rt-hflow-node:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-hflow-node.overflow{border-left-color:var(--dshp-c-border);opacity:.72}
.rt-hflow-node.open{border-color:var(--dsw-alias-brand-primary)}
.rt-hflow-pts{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;font-weight:700;color:var(--dshp-c-text);background:var(--dshp-c-bg-card);
  border-radius:8px;padding:0 6px}
.rt-hflow-node.overflow .rt-hflow-pts{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.rt-hflow-name{font-size:11.5px}
.rt-hflow-n{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.rt-rep-list{padding:10px 12px 14px}
.rt-rep-tools{display:flex;gap:6px;justify-content:flex-end;margin-bottom:8px}
.rt-rep{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dshp-c-border);border-radius:8px;
  padding:9px 11px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-2)}
.rt-rep-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rt-rep-idx{font-size:15px;color:var(--dshp-c-text);font-weight:700;flex:none}
.rt-rep-name{font-weight:600;font-size:13px}
.rt-rep-meta{font-size:12px;margin-top:4px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.rt-rep-meta b{color:var(--dsw-alias-label-primary);font-weight:600;margin-right:2px}
.rt-rep-missing{font-size:11.5px;color:var(--dsw-alias-state-error-primary);margin-top:6px;
  border:1px dashed var(--dsw-alias-state-error-primary);border-radius:5px;padding:5px 8px}
.rt-rep-req{margin-top:7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;overflow:hidden}
.rt-rep-req-head{display:flex;align-items:center;gap:7px;padding:4px 8px;font-size:11.5px;font-weight:600;
  background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-rep-http{margin:0;padding:8px 10px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;background:var(--dsw-alias-bg-base)}
/* ── 报告里的「这一步怎么来的」：动作步骤 / 命令 / 凭据 / 隧道 ───────────── */
.rt-rep-trace{margin-top:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:8px 10px;
  background:var(--dsw-alias-bg-base)}
.rt-rep-trace-head{display:flex;align-items:center;gap:7px;margin-bottom:5px}
.rt-rep-trace-title{font-weight:600;font-size:12.5px}
.rt-rep-trace-how{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:6px}
.rt-rep-step{border-left:2px solid var(--dsw-alias-border-l1);padding:2px 0 6px 9px;margin-bottom:6px}
.rt-rep-step-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.rt-rep-step-no{width:17px;height:17px;border-radius:50%;background:var(--dsw-alias-brand-primary);color:var(--dshp-c-text-muted);
  font-size:10.5px;display:flex;align-items:center;justify-content:center;flex:none}
.rt-rep-step-title{font-weight:600;font-size:12.5px}
.rt-rep-step-detail{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.rt-rep-step-cmd{font-size:11.5px;margin-top:4px;display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap}
.rt-rep-step-cmd .rt-mono{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);
  border-radius:5px;padding:2px 6px;word-break:break-all}
.rt-rep-step-result{font-size:11.5px;margin-top:3px;word-break:break-word}
.rt-rep-src{margin-top:6px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l1)}
.rt-rep-src-title{font-weight:600;font-size:12px;margin-bottom:3px}
/* ── 全链路攻击路径图 ─────────────────────────────────────────────── */
.rt-ap{padding:10px 12px 18px;overflow:auto}
.rt-ap-stage{margin-bottom:2px}
.rt-ap-head{display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--dsw-alias-bg-layer-2);
  border-left:4px solid var(--dshp-c-border);border-top:1px solid var(--dsw-alias-border-l1);border-radius:6px 6px 0 0}
.rt-ap-no{width:20px;height:20px;border-radius:5px;color:var(--dshp-c-text-muted);font-size:11px;font-weight:700;flex:none;
  display:inline-flex;align-items:center;justify-content:center}
.rt-ap-name{font-weight:700;font-size:13.5px}
.rt-ap-en{font-size:10px;color:var(--dsw-alias-label-secondary);letter-spacing:.3px}
.rt-ap-phase{font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ap-goal{display:flex;align-items:baseline;gap:8px;padding:6px 10px 6px 9px;font-size:12px;
  border-left:4px solid var(--dshp-c-border);background:var(--dsw-alias-bg-layer-1)}
.rt-ap-goal-tag{font-size:10.5px;font-weight:700;border:1px solid;border-radius:4px;padding:0 5px;white-space:nowrap;flex:none}
.rt-ap-result{padding:7px 10px 3px;border-left:4px solid transparent}
.rt-ap-result-head{display:flex;align-items:center;gap:8px;margin-bottom:5px;flex-wrap:wrap}
.rt-ap-pts{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;font-weight:700;color:var(--dshp-c-text);background:var(--dshp-c-bg-card);
  border:1px solid color-mix(in srgb, var(--dshp-c-border) 33%, transparent);border-radius:10px;padding:0 7px;white-space:nowrap}
.rt-ap-pts.off{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
/* 按服务封顶/自建而不计分的命中：分值标灰（+0），避免看着像又加了分 */
.rt-ap-pts.uncounted{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.rt-ap-nth{font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ap-hit{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dshp-c-border);border-radius:6px;
  padding:6px 9px;margin-bottom:5px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;outline:none}
.rt-ap-hit:hover{border-color:var(--dsw-alias-border-l2)}
.rt-ap-hit:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-ap-hit.overflow{border-left-color:var(--dshp-c-border);opacity:.75}
.rt-ap-hit-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-ap-hit-name{font-weight:600;font-size:12.5px}
.rt-ap-hit-target{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);
  margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46%}
.rt-ap-act{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:3px}
.rt-ap-act.inferred{font-style:italic;opacity:.75}
.rt-ap-none{font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:2px 0 4px}
.rt-ap-trans{display:flex;align-items:center;gap:7px;padding:2px 0 2px 14px}
.rt-ap-trans-t{font-size:11px;color:var(--dsw-alias-label-secondary)}
/* 横向路径图 */
.rt-ap-h{display:flex;align-items:stretch;padding:10px 12px 14px;overflow-x:auto;flex:1;min-height:0}
.rt-ap-col{display:flex;align-items:stretch;flex:none}
.rt-ap-col-arrow{align-self:center;color:var(--dsw-alias-border-l2);padding:0 6px;font-size:12px;flex:none}
.rt-hcol{width:228px;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);
  border-top:3px solid var(--dshp-c-border);border-radius:7px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.rt-hcol-goal{font-size:11px;color:var(--dsw-alias-label-secondary);padding:5px 8px;line-height:1.45;
  border-bottom:1px solid var(--dsw-alias-border-l1);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rt-hcol-body{padding:6px 8px;flex:1;min-height:0;overflow:auto}
.rt-hcol-hit{display:flex;align-items:center;gap:5px;font-size:11px;margin-bottom:3px}
.rt-hcol-hit.off{opacity:.6}
.rt-hcol-pts{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;font-weight:700;color:var(--dshp-c-text);background:var(--dshp-c-bg-card);
  border-radius:7px;padding:0 5px;flex:none}
.rt-hcol-hit.off .rt-hcol-pts{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.rt-hcol-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-hcol-none{font-size:11px;color:var(--dsw-alias-label-secondary)}
.rt-hcol-secs{display:flex;flex-wrap:wrap;gap:3px;margin-top:6px}
.rt-hcol-sec{font-size:10px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);
  border-radius:4px;padding:0 4px}
.rt-hcol-attck{font-family:ui-monospace,Menlo,monospace;font-size:9.5px;color:var(--dsw-alias-label-secondary);
  padding:4px 8px;border-top:1px solid var(--dsw-alias-border-l1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-ap-cum{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ap-sub{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:6px 0 3px}
.rt-ap-assets,.rt-ap-tunnels{display:flex;flex-direction:column;gap:3px}
.rt-ap-asset{display:flex;align-items:center;gap:6px;font-size:11.5px;padding:3px 6px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.rt-ap-tunnel{display:flex;align-items:center;gap:6px;font-size:11.5px;padding:4px 7px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dshp-c-border)}
.rt-hcol-sub{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-bottom:2px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;gap:5px;align-items:center}
.rt-hcol-sub.off{opacity:.6}
.rt-hit-row{display:flex;flex-wrap:wrap;align-items:center;gap:2px 7px;font-size:11.5px;padding:4px 7px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);margin-bottom:3px}
/* 资产与内容都自适应换行：长域名/长口令/长结果一律换行显示，不截断成省略号 */
.rt-hit-asset{font-family:ui-monospace,Menlo,monospace;font-weight:600;flex:0 1 auto;max-width:100%;
  overflow-wrap:anywhere;word-break:break-word}
.rt-hit-txt{flex:1 1 100%;color:var(--dsw-alias-label-primary);line-height:1.55;
  white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.rt-hit-txt.none{color:var(--dsw-alias-state-error-primary)}
.rt-hit-row .rt-hit-time{flex:none;margin-left:auto}
/* 自己注册/自建的账号：留痕但不计分，整行压暗 */
.rt-hit-row.self-created{opacity:.72;border-left:3px solid color-mix(in srgb, var(--dshp-c-border) 53%, transparent)}
/* 同一资产同一端口的重复账号/库权限：服务已拿满，不计分（只作留痕） */
.rt-hit-row.service-capped{opacity:.72;border-left:3px solid color-mix(in srgb, var(--dshp-c-border) 53%, transparent)}
.rt-hit-row.service-capped .rt-hit-idx{background:var(--dshp-c-bg-page)}
.rt-rep-group{margin-bottom:14px}
.rt-rep-stage{display:flex;align-items:center;gap:8px;padding:7px 10px;margin-bottom:7px;
  background:var(--dsw-alias-bg-layer-2);border-left:4px solid var(--dshp-c-border);border-radius:6px;
  cursor:pointer;outline:none;user-select:none}
.rt-rep-stage:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-rep-stage:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-rep-no{width:20px;height:20px;border-radius:5px;color:var(--dshp-c-text-muted);font-size:11px;font-weight:700;flex:none;
  display:inline-flex;align-items:center;justify-content:center}
.rt-rep-stage-name{font-weight:700;font-size:13px}
.rt-rep-stage-n{font-size:11px;color:var(--dsw-alias-label-secondary)}
/* 折叠后仍要能一眼看到"这一阶段拿了多少分"，所以分数留在头上 */
.rt-rep-pts{font-size:11px;font-weight:600;padding:1px 6px;border-radius:5px;border:1px solid transparent;flex:none}
.rt-rep-body{padding-left:6px}
/* ── 知识库（POC/EXP） ──────────────────────────────────────────── */
.rt-kb-filter{display:flex;align-items:center;gap:7px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
/* 知识库归类总览：一行标签，点一下按该类筛选 */
.rt-kb-cats{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
/* 知识库分组标题（按归类分组时每组一条） */
.rt-kb-cat{display:flex;align-items:center;gap:7px;padding:7px 10px;background:var(--dsw-alias-bg-layer-2);
  border-bottom:1px solid var(--dsw-alias-border-l1);position:sticky;top:0;z-index:1}
.rt-kb-cat-name{font-weight:600;font-size:12.5px}
/* 技能可用性徽章（技能库页签） */
.rt-avail{display:inline-block;padding:0 5px;border-radius:4px;font-size:10.5px;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.rt-avail-available{color:var(--dshp-c-text);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-scrim) 10%, transparent)}
.rt-avail-broken{color:var(--dshp-c-text-muted);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-scrim) 10%, transparent)}
.rt-avail-unknown{color:var(--dshp-c-text-muted);border-color:color-mix(in srgb, var(--dshp-c-border) 33%, transparent);background:color-mix(in srgb, var(--dshp-c-scrim) 10%, transparent)}
/* 版本 / 更新弹窗 */
.rt-modal{position:fixed;inset:0;z-index:200;background:color-mix(in srgb, var(--dshp-c-scrim) 45%, transparent);display:flex;align-items:center;justify-content:center}
.rt-modal-box{width:min(560px,92vw);max-height:80vh;overflow:auto;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px;font-size:12.5px;line-height:1.7;
  box-shadow:0 18px 48px color-mix(in srgb, var(--dshp-c-scrim) 35%, transparent);color:var(--dsw-alias-label-primary)}
.rt-modal-box .rt-kv b{min-width:76px}
.rt-kb-check{display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer}
.rt-kb{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;margin:0 0 8px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2)}
.rt-kb.open{border-color:var(--dsw-alias-brand-primary)}
.rt-kb-head{display:flex;align-items:center;gap:7px;padding:7px 9px;cursor:pointer;outline:none;flex-wrap:wrap}
.rt-kb-head:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-kb-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-kb-title{font-weight:600;font-size:12.5px;overflow-wrap:anywhere}
.rt-kb-kind{font-size:10px;font-weight:700;letter-spacing:.4px;padding:1px 5px;border-radius:4px;
  color:var(--dshp-c-text-muted);background:var(--dshp-c-bg-page);flex:none}
.rt-kb-kind.k-exp{background:var(--dshp-c-bg-card)}
.rt-kb-kind.k-poc{background:var(--dshp-c-bg-page)}
.rt-kb-kind.k-template{background:var(--dshp-c-bg-card)}
.rt-kb-kind.k-script{background:var(--dshp-c-bg-page)}
.rt-kb-kind.k-payload{background:var(--dshp-c-bg-page)}
.rt-kb-sub{font-size:11px;color:var(--dsw-alias-label-secondary);padding:0 9px 7px;overflow-wrap:anywhere}
.rt-kb-body{padding:0 9px 9px}
.rt-kb-actions{display:flex;gap:6px;margin:7px 0}
.rt-kb-body .rt-kv span{overflow-wrap:anywhere;word-break:break-word}
/* 本机 nuclei 模板命中：路径要能完整看到（复制成命令直接跑） */
.rt-kb-tpl{margin-top:12px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:8px}
.rt-kb-tpl-row{display:flex;align-items:center;gap:7px;font-size:11.5px;padding:3px 7px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);margin-bottom:3px}
.rt-kb-tpl-path{flex:0 1 auto;font-weight:600;overflow-wrap:anywhere}
.rt-kb-tpl-name{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rt-md{flex:1;overflow:auto;margin:0;padding:14px 16px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;
  line-height:1.65;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-base)}
.rt-weblink{display:block;font-size:11.5px;margin-top:1px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-shots{margin:8px 0 4px;padding:7px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;
  background:var(--dsw-alias-bg-layer-1)}
.rt-shots-head{display:flex;align-items:baseline;gap:8px;font-size:11.5px;margin-bottom:6px}
.rt-shots-n{color:var(--dsw-alias-label-secondary)}
.rt-shot-row{display:flex;gap:8px;flex-wrap:wrap}
.rt-shot{display:flex;flex-direction:column;gap:3px;max-width:220px}
.rt-shot-thumb{border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:var(--dshp-c-bg-page);
  object-fit:contain;display:block;width:auto;max-width:216px}
.rt-shot-loading{display:flex;align-items:center;justify-content:center;width:150px;font-size:11px;
  color:var(--dsw-alias-label-secondary)}
.rt-shot-cap{display:flex;align-items:center;gap:5px;font-size:10.5px;overflow-wrap:anywhere}
.rt-shot-label{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}
.rt-shot-zoom{position:fixed;inset:0;z-index:9999;background:color-mix(in srgb, var(--dshp-c-scrim) 82%, transparent);display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:10px;cursor:zoom-out;padding:18px}
.rt-shot-zoom img{max-width:96vw;max-height:86vh;border-radius:6px;box-shadow:0 18px 48px color-mix(in srgb, var(--dshp-c-scrim) 50%, transparent)}
.rt-shot-zoom-cap{color:var(--dshp-c-text-muted);font-size:12px;text-align:center;max-width:90vw;overflow-wrap:anywhere}`    /* ---------------------------------------------------------- 桥接与状态 */
    /** 是否在「全面浏览」独立窗口里（URL hash 标记，复用同一套界面代码）。 */
    const isFullWindow = () => {
      try { return String(window.location.hash || '') === '#redteam-full' } catch { return false }
    }

    /* 非 2xx / 非 JSON 响应（宿主 502、网关错误页、代理拦截）必须变成结构化失败，
       不能靠 res.json() 直接抛 SyntaxError —— 那让调用方的 catch 只拿到
       "Unexpected token <"，看不出状态码。这里把状态码与正文前 120 字带出来。 */
    /* 打开本地目录：只传语义 kind，路径由服务端算（白名单在 /dsh-purge/open）。 */
    const openDir = (kind) => fetch('/dsh-purge/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind }),
    }).then((res) => res.json()).catch(() => ({ ok: false }))

    const api = (req) => fetch('/redteam/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    }).then(async (res) => {
      const text = await res.text().catch(() => '')
      let data = null
      try { data = text ? JSON.parse(text) : null } catch {
        return { ok: false, error: res.status + ' non-json: ' + String(text).slice(0, 120) }
      }
      if (!res.ok) {
        return Object.assign({}, data || {}, {
          ok: false,
          error: (data && (data.error || data.message)) || (res.status + ' ' + res.statusText),
        })
      }
      return data
    })

    let ui = { open: true, tab: 'assets' }
    const subs = new Set()
    const setUI = (patch) => {
      ui = Object.assign({}, ui, patch)
      const snap = Object.assign({}, ui)
      for (const f of Array.from(subs)) {
        try { f(snap) } catch { /* ignore subscriber errors */ }
      }
    }
    /* 保留导出。面板尺寸只写在自己的元素上，不再改官方 frame 的宽度。 */
    let dockWidthTag = null
    const setDockWidth = () => {}
    const useUI = () => {
      const [st, setSt] = React.useState(() => Object.assign({}, ui))
      React.useEffect(() => {
        const f = (snap) => setSt(Object.assign({}, snap || ui))
        subs.add(f)
        setSt(Object.assign({}, ui))
        return () => { subs.delete(f) }
      }, [])
      return st
    }

    /* 知识库归类（与 core.js 的 POC_CATEGORIES 一致；面板按它分组） */
    const POC_CAT_NAME = {
      rce: dt('drill.d3'), deserialization: dt('drill.d4'), 'file-upload': dt('drill.d5'),
      sqli: dt('drill.d6'), unauthorized: dt('drill.d7'), 'auth-bypass': dt('drill.d8'),
      'weak-password': dt('drill.d9'), ssrf: 'SSRF', xxe: 'XXE',
      'path-traversal': dt('drill.d10'), 'info-leak': dt('drill.d11'),
      privesc: dt('drill.d12'), tunnel: dt('drill.d13'), other: dt('drill.d14'),
    }
    const POC_CAT_ORDER = Object.keys(POC_CAT_NAME)
    /* 角色 code → 中文（报告/知识库都要标"谁发现的"） */
    const ROLE_LABEL = {
      plan: dt('drill.d15'), recon: dt('drill.d16'), assess: dt('drill.d17'),
      'vuln-scan': dt('drill.d18'), exploit: dt('drill.d19'), internal: dt('drill.d20'),
    }

    const fmt = (s) => (s ? String(s).replace('T', ' ').slice(0, 16) : '—')
    const shotCache = new Map()
    const shotLoading = new Map()
    const shotSrc = (eng, id) => shotCache.get(eng + ':' + id) || null
    const loadShot = (eng, id) => {
      const key = eng + ':' + id
      if (shotCache.has(key) || shotLoading.has(key)) return
      const p = api({ op: 'shotData', engagement: eng, id: id }).then((r) => {
        shotCache.set(key, r && r.base64 ? 'data:' + (r.mime || 'image/png') + ';base64,' + r.base64 : '')
        shotLoading.delete(key)
        const snap = Object.assign({}, ui)
        for (const f of Array.from(subs)) {
          try { f(snap) } catch { /* ignore subscriber errors */ }
        }
      }).catch(() => { shotLoading.delete(key) })
      shotLoading.set(key, p)
    }
    const SHOT_KIND = { screenshot: dt('drill.d21'), card: dt('drill.d22') }
    const ShotImage = ({ eng, shot, height }) => {
      const [zoom, setZoom] = React.useState(false)
      const src = shotSrc(eng, shot.id)
      if (src === null) { loadShot(eng, shot.id); }
      const card = shot.kind === 'card'
      return h('div', { className: 'rt-shot' },
        src === null
          ? h('div', { className: 'rt-shot-thumb rt-shot-loading', style: { height: (height || 96) + 'px' } }, dt('drill.d23'))
          : h('img', {
              className: 'rt-shot-thumb', src: src, alt: shot.label || (dt('drill.d24') + shot.id),
              style: { height: (height || 96) + 'px', cursor: 'zoom-in' },
              onClick: () => setZoom(true),
            }),
        h('div', { className: 'rt-shot-cap' },
          h('span', { className: 'rt-tag ' + (card ? 'rt-tag-warn' : 'rt-tag-live'), title: card
            ? dt('drill.d25')
            : dt('drill.d21') }, SHOT_KIND[shot.kind] || shot.kind || dt('drill.d26')),
          h('span', { className: 'rt-shot-label', title: shot.label || shot.note || '' },
            shot.label || shot.target || ('#' + shot.id))),
        zoom
          ? h('div', { className: 'rt-shot-zoom', onClick: () => setZoom(false) },
              h('img', { src: src, alt: shot.label || '' }),
              h('div', { className: 'rt-shot-zoom-cap' }, (shot.label || shot.target || '')
                + (card ? [dt('drill.k30001')] : '')
                + (shot.captured_at ? '　·　' + fmt(shot.captured_at) : '')
                + dt('drill.d27')))
          : null)
    }
    const ShotStrip = ({ eng, shots, total, title }) => {
      const list = shots || []
      if (list.length === 0) return null
      return h('div', { className: 'rt-shots' },
        h('div', { className: 'rt-shots-head' },
          h('b', null, title || dt('drill.d28')),
          h('span', { className: 'rt-shots-n' }, dt('drill.d29') + list.length + dt('drill.d30')
            + (total && total > list.length ? dt('drill.d31') + total + [dt('drill.k30002')] : ''))),
        h('div', { className: 'rt-shot-row' }, list.map((sh) => h(ShotImage, { key: 'sh' + sh.id, eng: eng, shot: sh }))))
    }
    /** 发现时间在列表里只留「月-日 时:分」：整行宽度紧张，完整时间进悬浮提示 */
    const fmtShort = (s) => {
      const t = String(s || '').replace('T', ' ')
      return t.length >= 16 ? t.slice(5, 16) : (t || '—')
    }
    const provLabel = (p) => (p === 'passive' ? [dt('drill.k30003')] : p === 'active' ? [dt('drill.k30004')] : dt('drill.d32'))

    /**
     * 给「可点击但不是 <button>」的元素补上键盘可达性，返回可直接展开进 props 的对象。
     *
     * 为什么需要：面板里大量用 div/span 当按钮（表格行、页签、结论条、C 段条目…），
     * 它们鼠标能点、键盘完全够不着 —— 而这类元素此前有 16 处是各写各的，
     * 写法还不一致（有的只有 role、有的漏了 Space 键）。
     * 统一到一个工厂后，新增可点击元素只要 `...clickable(fn, { label })` 就有完整语义。
     *
     * 注意：**不要**用它包真正的 `<button>`（原生按钮自带全部语义）。
     * @param onActivate - 激活回调（鼠标点击 / Enter / Space 都走它）。
     * @param options - `{ label?, expanded? }`：label 进 aria-label，expanded 进 aria-expanded。
     * @returns props 片段：role / tabIndex / onClick / onKeyDown / aria-*
     */
    const clickable = (onActivate, options = {}) => {
      const props = {
        role: 'button',
        tabIndex: 0,
        onClick: onActivate,
        onKeyDown: (e) => {
          /* Enter 与 Space 是按钮的标准激活键；Space 还要阻止页面滚动 */
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onActivate(e)
          }
        },
      }
      if (options.label !== undefined) props['aria-label'] = String(options.label)
      if (options.expanded !== undefined) props['aria-expanded'] = options.expanded ? 'true' : 'false'
      return props
    }

    /**
     * 复制文本到剪贴板，**返回真实的成功与否**。
     *
     * clipboard API 在非安全上下文（http + 非 localhost）、页面失焦、权限被拒时都会
     * 返回被拒绝的 Promise —— 同步 try/catch 抓不到，于是界面会显示"已复制"而剪贴板是空的。
     * 这里 await 真实结果，并在不可用时退回 execCommand('copy')（老浏览器/非安全上下文仍可用）。
     * @param text - 要复制的文本。
     * @returns Promise<boolean>
     */
    const copyText = async (text) => {
      const value = text === undefined || text === null ? '' : String(text)
      if (value === '') return false
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(value)
          return true
        }
      } catch (e) { /* 落到下面的兜底方案 */ }
      /* 兜底：临时 textarea + execCommand —— 非安全上下文里唯一还能用的办法 */
      try {
        const ta = document.createElement('textarea')
        ta.value = value
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        document.body.appendChild(ta)
        ta.select()
        const okFlag = document.execCommand('copy')
        document.body.removeChild(ta)
        return okFlag === true
      } catch (e) { return false }
    }

    /**
     * 复制并给出**如实**的界面反馈（成功/失败文案统一）。
     * @param text - 要复制的文本。
     * @param label - 成功时提示里显示的名字。
     * @param onResult - 可选回调：`(ok, message) => void`；不传时返回 Promise<boolean>。
     */
    const copyWithFeedback = async (text, label, onResult) => {
      const okFlag = await copyText(text)
      const message = okFlag ? dt('drill.d33') + label : dt('drill.d34')
      if (typeof onResult === 'function') onResult(okFlag, message)
      return okFlag
    }

    function ProvTag(props) {
      if (!props.p) return h('span', { className: 'rt-tag' }, dt('drill.d32'))
      return h('span', { className: 'rt-tag rt-tag-' + props.p }, provLabel(props.p))
    }

    const TEST_LABEL = { untested: dt('drill.d35'), testing: dt('drill.d36'), tested: dt('drill.d37'), blocked: dt('drill.d38'), abandoned: dt('drill.d39'), no_surface: dt('drill.d40') }
    const PRI_LABEL = { high: dt('drill.d41'), medium: dt('drill.d42'), low: dt('drill.d43') }

    /** 资产易打性徽章。 */
    function PriTag(props) {
      if (!props.p) return h('span', { className: 'rt-tag' }, dt('drill.d44'))
      return h('span', { className: 'rt-pri rt-pri-' + props.p, title: props.title || '' }, PRI_LABEL[props.p] || props.p)
    }

    /** 资产测试状态徽章。 */
    function TestTag(props) {
      const st = props.s || 'untested'
      return h('span', { className: 'rt-test rt-test-' + st }, TEST_LABEL[st] || st)
    }

    /* ---------------------------------------------------------- 资产测绘 */
    function AssetsTab(props) {
      const eng = props.engagement
      const snapshot = props.snapshot
      const refreshKey = props.refreshKey || 0
      const onRefresh = props.onRefresh
      const [view, setView] = React.useState('list')
      const [cidr, setCidr] = React.useState(null)
      const [q, setQ] = React.useState('')
      const [qApplied, setQApplied] = React.useState('')
      const [service, setService] = React.useState('')
      const [port, setPort] = React.useState('')
      const [prov, setProv] = React.useState('')
      const [testStatus, setTestStatus] = React.useState('')
      const [priority, setPriority] = React.useState('')
      const [scope, setScope] = React.useState('')
      const [assetState, setAssetState] = React.useState('')
      const [sort, setSort] = React.useState('priority')
      const [showAll, setShowAll] = React.useState(null)
      const [state, setState] = React.useState({ loading: false, error: null, total: 0, items: [] })
      const [domains, setDomains] = React.useState(null)
      const [web, setWeb] = React.useState(null)
      const [openId, setOpenId] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      /* 左侧「外网 C 段 / 内网 C 段」两组各自折叠，状态按靶标记住 */
      const sideCollapse = useCollapse('assets-side:' + eng)
      const seq = React.useRef(0)
      const onData = props.onData

      React.useEffect(() => {
        if (!eng) return
        const my = ++seq.current
        setState((s) => Object.assign({}, s, { loading: true, error: null }))
        api({
          op: 'assets', engagement: eng, cidr: cidr || undefined, q: qApplied || undefined,
          service: service || undefined, port: port || undefined,
          provenance: prov || undefined, test_status: testStatus || undefined,
          priority: priority || undefined, scope: scope || undefined,
          state: assetState || undefined, sort: sort, limit: 400,
        }).then((r) => {
          if (my !== seq.current) return
          if (!r || r.ok === false) {
            setState({ loading: false, error: (r && r.error) || dt('drill.d45'), total: 0, items: [] })
            return
          }
          setState({ loading: false, error: null, total: r.total, items: r.items || [] })
          /* C 段/统计可能因本轮采集新增：让外层重新拉一次快照，左侧分类立即更新 */
          if (onData) onData()
        }, (e) => {
          if (my === seq.current) setState({ loading: false, error: String((e && e.message) || e), total: 0, items: [] })
        })
      }, [eng, cidr, qApplied, service, port, prov, testStatus, priority, scope, assetState, sort, refreshKey])

      React.useEffect(() => {
        if (!eng || view !== 'domain') return
        setDomains(null)
        api({ op: 'domains', engagement: eng, cidr: cidr || undefined })
          .then((r) => setDomains((r && r.items) || []), () => setDomains([]))
      }, [eng, view, cidr, refreshKey])

      React.useEffect(() => {
        if (!eng || view !== 'web') return
        setWeb(null)
        api({ op: 'web', engagement: eng, cidr: cidr || undefined })
          .then((r) => setWeb((r && r.items) || []), () => setWeb([]))
      }, [eng, view, cidr, refreshKey])


      const toggleRow = (id) => {
        if (openId === id) { setOpenId(null); setDetail(null); return }
        setOpenId(id)
        setDetail(null)
        api({ op: 'asset', engagement: eng, id: id }).then((r) => {
          if (r && r.ok && r.asset) setDetail(r.asset)
        }, () => {})
      }

      const segs = (snapshot && snapshot.segments) || []

      const sideChildren = []
      sideChildren.push(h('div', Object.assign({
        key: 'all', className: 'rt-seg' + (cidr === null && view !== 'testing' ? ' on' : ''),
      }, clickable(() => { setView('list'); setCidr(null) }, { label: dt('drill.d46'), expanded: cidr === null && view !== 'testing' })),
        h('div', { className: 'rt-seg-cidr' }, dt('drill.d46')),
        h('div', { className: 'rt-seg-meta' }, segs.length + dt('drill.d47'))))
      sideChildren.push(h('div', Object.assign({
        key: 'testing', className: 'rt-seg' + (view === 'testing' ? ' on' : ''),
        title: dt('drill.d48'),
      }, clickable(() => { setView('testing'); setCidr(null) }, { label: dt('drill.d49'), expanded: view === 'testing' })),
        h('div', { className: 'rt-seg-cidr', style: { display: 'flex', alignItems: 'baseline', gap: 5 } },
          h('span', { className: 'rt-scope rt-scope-testing', title: dt('drill.d50') }, dt('drill.d51')),
          h('span', { style: { flex: 1 } }, dt('drill.d49'))),
        h('div', { className: 'rt-seg-meta' }, dt('drill.d52'))))
      /* C 段按内外网分组：先外网（互联网可达，通常是入口）再内网（打进去之后才看得到） */
      const segBlock = (title, list, kind) => {
        /* 外网 / 内网两组各自可折叠（状态按靶标记住），默认展开 */
        const open = sideCollapse.isOpen('scope:' + kind, true)
        const toggle = sideCollapse.toggle('scope:' + kind, true)
        const out = [h('div', {
          key: 'h' + kind, className: 'rt-sidehead rt-sidehead-btn',
          role: 'button', tabIndex: 0, 'aria-expanded': open ? 'true' : 'false',
          title: (open ? [dt('drill.k30005')] : dt('drill.d53')) + dt('drill.d54'),
          onClick: () => { setView('list'); toggle() },
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView('list'); toggle(e) } },
        },
          h('span', { className: 'rt-sec-caret' }, open ? '▾' : '▸'),
          h('span', { className: 'rt-scope rt-scope-' + kind }, kind === 'internal' ? [dt('drill.k30006')] : dt('drill.d55')),
          h('span', null, title + ' · ' + list.length + dt('drill.d56')),
          h('span', { className: 'rt-spacer' }),
          h('span', { style: { fontWeight: 400 } }, list.reduce((n, x) => n + (x.assets || 0), 0) + dt('drill.d57')))]
        if (!open) return out
        for (const s of list) {
          /* 一段一行：只给 C 段 + 资产数（端口数不再占位，归属与存活放进悬浮提示） */
          out.push(h('div', Object.assign({
            key: s.cidr, className: 'rt-seg' + (cidr === s.cidr ? ' on' : ''),
            title: (s.org || dt('drill.d58')) + dt('drill.d59') + (s.live || 0) + '/' + (s.assets || 0) + dt('drill.d60'),
          }, clickable(() => { setView('list'); setCidr(s.cidr) },
            { label: dt('drill.d61') + s.cidr, expanded: cidr === s.cidr && view !== 'testing' })),
            h('div', { className: 'rt-seg-cidr', style: { display: 'flex', alignItems: 'baseline', gap: 5 } },
              h('span', { className: 'rt-scope rt-scope-' + kind }, kind === 'internal' ? [dt('drill.k30007')] : dt('drill.d62')),
              h('span', { style: { flex: 1 } }, s.cidr),
              h('span', { className: 'rt-seg-meta', style: { margin: 0, whiteSpace: 'nowrap' } },
                s.assets + dt('drill.d60')))))
        }
        return out
      }
      const segExternal = segs.filter((x) => x.scope !== 'internal')
      const segInternal = segs.filter((x) => x.scope === 'internal')
      if (segExternal.length) sideChildren.push(...segBlock(dt('drill.d63'), segExternal, 'external'))
      if (segInternal.length) sideChildren.push(...segBlock(dt('drill.d64'), segInternal, 'internal'))
      const side = h('div', { className: 'rt-side' }, sideChildren)

      const toolbar = h('div', { className: 'rt-toolbar' },
        h('input', {
          className: 'rt-input', style: { flex: '1 1 150px' }, placeholder: dt('drill.d65'),
          value: q, onChange: (e) => setQ(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') setQApplied(q) },
        }),
        h('button', { className: 'rt-btn', onClick: () => setQApplied(q) }, dt('drill.d66')),
        h('input', {
          className: 'rt-input', style: { width: '78px' }, placeholder: dt('drill.d67'),
          value: service, onChange: (e) => setService(e.target.value),
        }),
        h('input', {
          className: 'rt-input', style: { width: '60px' }, placeholder: dt('drill.d68'),
          value: port, onChange: (e) => setPort(e.target.value),
        }),
        h('select', { className: 'rt-input', value: scope, onChange: (e) => setScope(e.target.value) },
          h('option', { value: '' }, dt('drill.d69')),
          h('option', { value: 'external' }, dt('drill.d70')),
          h('option', { value: 'internal' }, dt('drill.d71'))),
        h('select', { className: 'rt-input', value: prov, onChange: (e) => setProv(e.target.value), title: dt('drill.d72') },
          h('option', { value: '' }, dt('drill.d73')),
          h('option', { value: 'passive' }, dt('drill.d74')),
          h('option', { value: 'active' }, dt('drill.d75'))),
        h('select', { className: 'rt-input', value: priority, onChange: (e) => setPriority(e.target.value) },
          h('option', { value: '' }, dt('drill.d76')),
          h('option', { value: 'high' }, dt('drill.d77')),
          h('option', { value: 'medium' }, dt('drill.d78')),
          h('option', { value: 'low' }, dt('drill.d79'))),
        h('select', { className: 'rt-input', value: testStatus, onChange: (e) => setTestStatus(e.target.value) },
          h('option', { value: '' }, dt('drill.d80')),
          h('option', { value: 'untested' }, dt('drill.d35')),
          h('option', { value: 'testing' }, dt('drill.d36')),
          h('option', { value: 'tested' }, dt('drill.d37')),
          h('option', { value: 'blocked' }, dt('drill.d38')),
          h('option', { value: 'abandoned' }, dt('drill.d39')),
          h('option', { value: 'no_surface' }, dt('drill.d40'))),
        h('div', { className: 'rt-spacer' }),
        h('button', { className: 'rt-btn', title: dt('drill.d81'), onClick: () => { if (onRefresh) onRefresh() } }, dt('drill.d82')),
        h('button', { className: 'rt-btn' + (view === 'list' ? ' rt-btn-primary' : ''), onClick: () => setView('list') }, dt('drill.d83')),
        h('button', { className: 'rt-btn' + (view === 'timeline' ? ' rt-btn-primary' : ''), title: dt('drill.d84'), onClick: () => setView('timeline') }, dt('drill.d85')),
        h('button', { className: 'rt-btn' + (view === 'domain' ? ' rt-btn-primary' : ''), onClick: () => setView('domain') }, dt('drill.d86')),
        h('button', { className: 'rt-btn' + (view === 'web' ? ' rt-btn-primary' : ''), onClick: () => setView('web') }, 'Web'))

      /* ── 结论行：一屏看清家底，数字点一下就是筛选 ───────────────────── */
      const tests = (snapshot && snapshot.tests) || {}
      const snapStats = (snapshot && snapshot.stats) || {}
      const noFilter = !testStatus && !priority && !scope && !prov && !assetState && !cidr
      const conclItem = (key, label, value, active, onClick) => h('span', Object.assign({
        key: key, className: 'rt-concl-i' + (active ? ' on' : ''), title: dt('drill.d87'),
      }, clickable(onClick, { label: dt('drill.d88') + label + dt('drill.d89') + (value || 0) + '）', expanded: active })),
        h('b', null, String(value || 0)), h('span', null, label))
      const toggleTest = (v) => { setTestStatus((cur) => (cur === v ? '' : v)); setAssetState('') }
      const conclusion = h('div', { className: 'rt-concl' },
        conclItem('all', dt('drill.d90'), snapStats.assets, noFilter, () => {
          setTestStatus(''); setPriority(''); setScope(''); setProv(''); setAssetState(''); setCidr(null)
        }),
        conclItem('live', dt('drill.d91'), snapStats.liveAssets, assetState === 'live', () => { setAssetState((v) => (v === 'live' ? '' : 'live')); setTestStatus('') }),
        conclItem('untested', dt('drill.d92'), tests.untested, testStatus === 'untested', () => toggleTest('untested')),
        conclItem('testing', dt('drill.d36'), tests.testing, testStatus === 'testing', () => toggleTest('testing')),
        conclItem('tested', dt('drill.d93'), tests.tested, testStatus === 'tested', () => toggleTest('tested')),
        conclItem('giveup', dt('drill.d94'), (tests.abandoned || 0) + (tests.blocked || 0), testStatus === 'abandoned,blocked', () => toggleTest('abandoned,blocked')),
        h('div', { className: 'rt-spacer' }),
        h('select', {
          className: 'rt-input', value: sort, onChange: (e) => setSort(e.target.value),
          title: dt('drill.d95'),
        },
          h('option', { value: 'priority' }, dt('drill.d96')),
          h('option', { value: 'todo' }, dt('drill.d97')),
          h('option', { value: 'discovered' }, dt('drill.d98')),
          h('option', { value: 'ports' }, dt('drill.d99')),
          h('option', { value: 'ip' }, dt('drill.d100'))))

      const head = h('div', { className: 'rt-row head' },
        h('span', null, 'IP'), h('span', null, dt('drill.d101')), h('span', null, dt('drill.d102')),
        h('span', null, dt('drill.d103')), h('span', null, dt('drill.d104')))

      const rowNodes = []
      for (const it of state.items) {
        const openPorts = it.ports.filter((p) => p.state === 'open')
        const portText = openPorts.map((p) => p.port + (p.service ? '/' + p.service : '')).join(', ') || '—'
        const fpText = it.fingerprints.map((f) => [f.vendor, f.product, f.version].filter(Boolean).join(' ')).join(' / ') || '—'
        /* 端口最多列 3 个，其余用 +N；主被动来源不再占列，进详情 */
        const shownPorts = openPorts.slice(0, 3).map((p) => p.port + (p.service ? '/' + p.service : '')).join(', ')
        const morePorts = openPorts.length > 3 ? ' +' + (openPorts.length - 3) : ''
        rowNodes.push(h('div', Object.assign({
          key: 'r' + it.id, className: 'rt-row',
        }, clickable(() => toggleRow(it.id), { label: dt('drill.d105') + it.ip, expanded: openId === it.id })),
          h('span', { className: 'rt-mono', style: { display: 'flex', alignItems: 'baseline', gap: 4, flexWrap: 'wrap' } },
            h('span', {
              className: 'rt-scope rt-scope-' + (it.scope === 'internal' ? 'internal' : 'external'),
            }, it.scope === 'internal' ? [dt('drill.k30007')] : dt('drill.d62')),
            h('span', {
              title: it.state === 'live' ? [dt('drill.k30008')] : String(it.state),
              style: {
                width: 7, height: 7, borderRadius: '50%', flex: 'none', marginTop: 4,
                background: it.state === 'live' ? 'var(--dsw-alias-state-success-primary, #10b981)' : 'var(--dsw-alias-state-idle-primary, #94a3b8)',
              },
            }),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, it.ip),
            /* 发现时间挂在 IP 下面一行：IP 列宽度有限，不另开列（列宽一改整表要跟着调） */
            h('span', {
              style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
              title: dt('drill.d106') + (it.discovered_at ? fmt(it.discovered_at) : dt('drill.d107'))
                + (it.last_seen ? dt('drill.d108') + fmt(it.last_seen) : ''),
            }, it.discovered_at ? fmtShort(it.discovered_at) : dt('drill.d109'))),
          h('span', null, h(PriTag, { p: it.priority, title: it.potential || '' })),
          h('span', null, h(TestTag, { s: it.test_status }),
            it.blocked_count ? h('span', { className: 'rt-tag', style: { color: 'var(--dsw-alias-state-error-primary, #ef4444)', borderColor: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 33%, transparent)', marginLeft: 4 } }, dt('drill.d110') + it.blocked_count) : null),
          h('span', { title: portText }, (shownPorts || '—') + morePorts),
          h('span', { title: fpText }, fpText.length > 30 ? fpText.slice(0, 30) + '…' : fpText)))

        if (openId !== it.id) continue
        const d = detail && detail.id === it.id ? detail : null
        const portRows = []
        const fpRows = []
        const obsRows = []
        if (d) {
          for (const p of (d.ports || [])) {
            if (p.state !== 'open') continue
            portRows.push(h('div', { key: 'p' + p.port, className: 'rt-kv' },
              h('b', { className: 'rt-mono' }, p.port + '/' + p.proto),
              h('span', null, [p.service, p.product, p.version].filter(Boolean).join(' ') || dt('drill.d111')),
              p.url ? h('a', { className: 'rt-link', href: p.url, target: '_blank', rel: 'noreferrer', title: p.url }, p.title ? p.title : p.url) : null,
              h(ProvTag, { p: p.provenance })))
          }
          for (const f of (d.fingerprints || [])) {
            fpRows.push(h('div', { key: 'f' + (f.product || '') + (f.version || '') + (f.evidence || ''), className: 'rt-kv' },
              h('b', null, f.category || '—'),
              h('span', null, [f.vendor, f.product, f.version].filter(Boolean).join(' ') + (f.evidence ? '（' + f.evidence + '）' : '')),
              h(ProvTag, { p: f.provenance })))
          }
          for (const o of (d.observations || []).slice(0, 8)) {
            obsRows.push(h('div', { key: 'o' + (o.attr || '') + (o.value || '') + (o.collected_at || ''), className: 'rt-kv' },
              h('b', null, o.attr || '—'),
              h('span', null, (o.value || '') + ' · ' + (o.tool || dt('drill.d112')) + ' · ' + fmt(o.collected_at)),
              h(ProvTag, { p: o.provenance })))
          }
        }
        /* 详情分三层：3 行必读 → 「展开全部」后才是溯源、原始记录与备注全文 */
        const all = showAll === it.id
        const noteLines = d && d.test_notes ? d.test_notes.split('\n').filter(Boolean) : []
        const inner = d
          ? h('div', null,
              /* 必读三行 */
              h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d113')), h('span', null,
                h(TestTag, { s: d.test_status }),
                d.blocked_count ? h('span', { className: 'rt-tag', style: { marginLeft: 6, color: 'var(--dsw-alias-state-error-primary, #ef4444)', borderColor: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 33%, transparent)' } }, dt('drill.d114') + d.blocked_count + dt('drill.d115')) : null,
                h('span', { style: { marginLeft: 8, color: 'var(--dsw-alias-label-secondary)' } },
                  (d.test_updated_at ? fmt(d.test_updated_at) : dt('drill.d116')) + (d.test_updated_by ? ' · ' + d.test_updated_by : '')))),
              h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d117')), h('span', null,
                h(PriTag, { p: d.priority }),
                h('span', { style: { marginLeft: 8 } }, d.potential || dt('drill.d118')),
                d.assess_reason ? h('span', { style: { marginLeft: 8, color: 'var(--dsw-alias-label-secondary)' } }, d.assess_reason) : null)),
              h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d119')), h('span', null,
                d.test_surface || (portRows.length ? [dt('drill.k30009')] : dt('drill.d120')),
                d.scope ? h('span', { className: 'rt-scope rt-scope-' + (d.scope === 'internal' ? 'internal' : 'external'), style: { marginLeft: 8 } },
                  d.scope === 'internal' ? [dt('drill.k30010')] : dt('drill.d63')) : null)),
              h('span', Object.assign({ className: 'rt-more' },
                clickable(() => setShowAll(all ? null : it.id), { label: all ? [dt('drill.k30011')] : dt('drill.d121'), expanded: all })),
                all ? [dt('drill.k30012')] : dt('drill.d122')),
              all ? h('div', null,
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d123')), h('span', null, (d.names || []).map((n) => n.name).join(', ') || '—')),
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d85')),
                  h('span', { title: dt('drill.d124') }, fmt(d.discovered_at)),
                  h('b', { style: { minWidth: 0, marginLeft: 8 } }, dt('drill.d125')), h('span', null, fmt(d.last_seen)),
                  h('b', { style: { minWidth: 0, marginLeft: 8 } }, dt('drill.d126')), h('span', null, fmt(d.first_seen))),
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d127')), h('span', null, d.segment_cidr)),
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d117')), h('span', null,
                  (d.priority || dt('drill.d118')) + (d.potential ? dt('drill.d128') + d.potential : '')
                  + (d.assess_reason ? dt('drill.d129') + d.assess_reason : '')
                  + (d.assessed_at ? '（' + fmt(d.assessed_at) + '）' : ''))),
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d130')), h('span', null,
                  dt('drill.d131') + (d.passive || 0) + dt('drill.d132') + (d.active || 0))),
                h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, dt('drill.d103')),
                h('div', null, portRows.length ? portRows : '—'),
                h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, dt('drill.d104')),
                h('div', null, fpRows.length ? fpRows : '—'),
                noteLines.length
                  ? h(Clip, { key: 'notes', label: dt('drill.d133') + noteLines.length + dt('drill.d134'), text: noteLines.join('\n') })
                  : null,
                h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, dt('drill.d135')),
                h('div', null, obsRows.length ? obsRows : '—'))
                : null)
          : h('div', null, dt('drill.d136'))
        rowNodes.push(h('div', {
          key: 'd' + it.id, className: 'rt-row',
          style: { cursor: 'default', gridTemplateColumns: tableColumns([{ key: 'full' }]) },
        }, h('div', { className: 'rt-expand' }, inner)))
      }

      const listPane = h('div', { className: 'rt-table' }, head, rowNodes,
        !state.loading && !state.items.length ? h('div', { className: 'rt-empty' }, dt('drill.d137')) : null)

      /* 域名维度：域名 → 关联资产 */
      const domainPane = h('div', { className: 'rt-table' },
        domains === null ? h('div', { className: 'rt-empty' }, dt('drill.d136'))
          : domains.length
          ? domains.map((g) => h('div', { key: g.domain },
              h('div', { className: 'rt-section', style: { padding: '8px 10px 4px' } },
                h('a', { className: 'rt-link', href: 'http://' + g.domain, target: '_blank', rel: 'noreferrer' }, g.domain),
                h('span', { className: 'rt-tag', style: { marginLeft: 8 } }, g.count + dt('drill.d138'))),
              g.assets.map((a) => h('div', {
                key: String(g.domain) + '\u0000' + a.id + '\u0000' + a.ip, className: 'rt-row',
                style: { gridTemplateColumns: tableColumns([{ key: 'ip', width: 150 }, { key: 'segment', width: 130 }, { key: 'state', width: 70 }, { key: 'names' }]), cursor: 'pointer' },
                onClick: () => { setView('list'); setQ(''); setQApplied(a.ip) },
              },
                h('span', { className: 'rt-mono' }, a.ip),
                h('span', { className: 'rt-mono' }, a.segment),
                h('span', null, h('span', { className: 'rt-tag rt-tag-' + (a.state === 'live' ? 'live' : 'dead') }, a.state === 'live' ? [dt('drill.k30008')] : a.state)),
                h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, (a.names || []).join(', '))))))
          : h('div', { className: 'rt-empty' }, cidr ? [dt('drill.k30013')] : dt('drill.d139')))

      /* Web 资产：标题 + 可直接点击的 URL */
      const webPane = h('div', null,
        h(TableGrid, {
          columns: [
            { key: 'url', label: dt('drill.d140'), width: '1.6fr' },
            { key: 'title', label: dt('drill.d141'), width: '1.2fr' },
            { key: 'endpoint', label: dt('drill.d142'), width: 130 },
            { key: 'service', label: dt('drill.d67'), width: 110 },
          ],
          rows: (web || []).map((w) => {
            const url = w.url || ('http' + (w.port === 443 || w.port === 8443 || w.port === 9443 ? 's' : '') + '://' + w.ip + (w.port === 80 || w.port === 443 ? '' : ':' + w.port))
            return {
              key: 'w' + w.port_id,
              cells: [
                h('a', { className: 'rt-link rt-mono', href: url, target: '_blank', rel: 'noreferrer', title: url }, url),
                h('span', { title: w.title || '' }, w.title || '—'),
                h('span', { className: 'rt-mono' }, w.ip + ' · ' + w.segment_cidr),
                h('span', { style: { fontSize: 11 } }, [w.service, w.product, w.version].filter(Boolean).join(' ')),
              ],
            }
          }),
        }),
        web === null ? h('div', { className: 'rt-empty' }, dt('drill.d136'))
          : (!web.length ? h('div', { className: 'rt-empty' }, cidr ? [dt('drill.k30014')] : dt('drill.d143')) : null))


      let pane = listPane
      if (view === 'testing') pane = h(TestingTab, { engagement: eng, refreshKey: refreshKey })
      else if (view === 'domain') pane = domainPane
      else if (view === 'web') pane = webPane
      /* 发现时间视图自带滚动容器，直接放进 rt-main 的 flex 里 */
      else if (view === 'timeline') pane = h(DiscoveryView, { engagement: eng, refreshKey: refreshKey })

      return h('div', { className: 'rt-split' }, side,
        h('div', { className: 'rt-main' }, view === 'testing' ? null : toolbar,
          conclusion,
          state.error ? h('div', { className: 'rt-err' }, state.error) : null,
          pane))
    }

    /* ---------------------------------------------------------- 资产发现时间线 */
    /**
     * 资产发现时间线：什么时候发现了什么、哪天收了多少。
     * 注意：这个组件曾在"移除图谱视图"时被连带删掉 —— 删除区间的结束标记选得太宽
     *    （图谱画布的收尾与它挨着），bundle 自检的 "client.js 有资产「发现时间」视图"
     *    因此变红。恢复时把插入点固定成"资产测绘注释块之前"，避免再被别的删除波及。
     */
    function DiscoveryView(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [day, setDay] = React.useState('')
      React.useEffect(() => {
        if (!eng) return
        setData(null)
        api({ op: 'discoveryTimeline', engagement: eng, limit: 200 })
          .then((r) => { if (!r || r.ok === false) setErr((r && r.error) || dt('drill.d144')); else { setErr(null); setData(r) } },
            (e) => setErr(String((e && e.message) || e)))
      }, [eng, refreshKey])
      if (err) return h('div', { className: 'rt-pane' }, h('div', { className: 'rt-err' }, err))
      if (!data) return h('div', { className: 'rt-empty' }, dt('drill.d136'))
      const recent = (data.recent || []).filter((a) => day === '' || String(a.discovered_at || '').slice(0, 10) === day)
      return h('div', { className: 'rt-pane', style: { flex: 1, minHeight: 0 } },
        h('div', { className: 'rt-card' },
          h('h4', null, dt('drill.d145')),
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            dt('drill.d146') + ((data.span && data.span.total) || 0) + dt('drill.d147')
            + (data.span && data.span.first ? fmt(data.span.first) : '—')
            + dt('drill.d148') + (data.span && data.span.last ? fmt(data.span.last) : '—')
            + dt('drill.d149'))),
        (data.days || []).length === 0 ? h('div', { className: 'rt-empty' }, dt('drill.d150')) : null,
        h('div', { className: 'rt-card' },
          h('h4', null, dt('drill.d151'), day
            ? h('span', Object.assign({ className: 'rt-tag', style: { marginLeft: 6, cursor: 'pointer' } },
                clickable(() => setDay(''), { label: dt('drill.d152') + day })), dt('drill.d153') + day)
            : null),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            (data.days || []).map((d) => h('div', Object.assign({
              key: d.day, className: 'rt-seg' + (day === d.day ? ' on' : ''), style: { marginBottom: 0, cursor: 'pointer' },
              title: d.day + dt('drill.d154') + d.assets + dt('drill.d155') + d.internal + dt('drill.d156') + d.external + '）',
            }, clickable(() => setDay(day === d.day ? '' : d.day),
              { label: dt('drill.d157') + d.day + dt('drill.d158'), expanded: day === d.day })),
              h('div', { className: 'rt-seg-cidr' }, d.day),
              h('div', { className: 'rt-seg-meta' }, d.assets + dt('drill.d159') + d.internal + dt('drill.d160') + d.external))))),
        h('div', { className: 'rt-card' },
          h('h4', null, day ? day + dt('drill.d161') + recent.length + '）' : dt('drill.d162') + recent.length + '）'),
          recent.length === 0 ? h('div', { className: 'rt-empty' }, dt('drill.d163')) : null,
          recent.map((a) => h('div', { key: a.id, className: 'rt-kv' },
            h('b', { className: 'rt-mono', style: { minWidth: 110 } },
              h('span', { className: 'rt-scope rt-scope-' + (a.scope === 'internal' ? 'internal' : 'external'), style: { marginRight: 4 } },
                a.scope === 'internal' ? [dt('drill.k30007')] : dt('drill.d62')),
              a.ip),
            h('span', { style: { minWidth: 132, fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } },
              a.discovered_at ? fmt(a.discovered_at) : dt('drill.d164')),
            h('span', { style: { flex: 1 } }, (a.primary_name || '—') + (a.open_ports ? ' · ' + a.open_ports + [dt('drill.k30015')] : '')),
            h(PriTag, { p: a.priority })))))
    }

    /* ---------------------------------------------------------- 智能体提示词 */
    function PromptsTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [roles, setRoles] = React.useState([])
      const [active, setActive] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        /* 无靶标也允许：服务端回内置默认，不再报 engagement required */
        api(eng ? { op: 'prompts', engagement: eng } : { op: 'prompts' }).then((r) => {
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d165') }); return }
          setRoles(r.roles || [])
          if (r.roles && r.roles.length) setActive((cur) => cur || r.roles[0].role)
          if (r.builtin) setMsg({ ok: dt('drill.d166') })
        }, (e) => setMsg({ err: String((e && e.message) || e) }))
      }, [eng, refreshKey])

      React.useEffect(() => {
        const r = roles.find((x) => x.role === active)
        if (r) setDraft(r.content || '')
      }, [active, roles])

      const save = () => {
        if (!eng) { setMsg({ err: dt('drill.d167') }); return }
        setBusy(true)
        setMsg(null)
        api({ op: 'savePrompt', engagement: eng, role: active, content: draft }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d168') }); return }
          setRoles((list) => list.map((x) => (x.role === active
            ? Object.assign({}, x, { content: draft, updated_at: new Date().toISOString() })
            : x)))
          setMsg({ ok: dt('drill.d169') })
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      /* 老靶标的提示词是旧版模板；这里可以把当前角色（或全部）恢复成内置最新版 */
      const reset = (all) => {
        if (!eng) { setMsg({ err: dt('drill.d170') }); return }
        setBusy(true); setMsg(null)
        api({ op: 'resetPrompts', engagement: eng, role: all ? undefined : active }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d171') }); return }
          setMsg({ ok: dt('drill.d172') + (r.reset || []).join('、') })
          api({ op: 'prompts', engagement: eng }).then((rr) => {
            if (rr && rr.ok) {
              setRoles(rr.roles || [])
              const cur2 = (rr.roles || []).find((x) => x.role === active)
              if (cur2) setDraft(cur2.content || '')
            }
          }, () => {})
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const cur = roles.find((x) => x.role === active)
      const items = roles.map((r) => h('div', Object.assign({
        key: r.role, className: 'rt-item' + (active === r.role ? ' on' : ''),
      }, clickable(() => { setActive(r.role); setMsg(null) },
        { label: dt('drill.d173') + r.title + dt('drill.d174'), expanded: active === r.role })),
        h('div', { className: 'rt-item-name' }, r.title),
        h('div', { className: 'rt-item-desc' }, (r.content || '').replace(/[#*`]/g, '').slice(0, 60) || dt('drill.d175'))))

      return h('div', { className: 'rt-split' },
        h('div', { className: 'rt-list' }, items),
        h('div', { className: 'rt-main' },
          h('div', { className: 'rt-toolbar' },
            h('span', { style: { fontWeight: 600 } }, cur ? cur.title : dt('drill.d176')),
            h('span', { className: 'rt-tag' }, dt('drill.d177') + fmt(cur && cur.updated_at)),
            h('div', { className: 'rt-spacer' }),
            h('button', {
              className: 'rt-btn', disabled: busy || !active, title: dt('drill.d178'),
              onClick: () => reset(false),
            }, dt('drill.d179')),
            h('button', {
              className: 'rt-btn', disabled: busy, title: dt('drill.d180'),
              onClick: () => reset(true),
            }, dt('drill.d181')),
            h('button', { className: 'rt-btn rt-btn-primary', disabled: busy || !active, onClick: save }, busy ? [dt('drill.k30016')] : dt('drill.d182'))),
          msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
          h('div', { className: 'rt-pane' },
            h('textarea', {
              className: 'rt-textarea', value: draft, spellCheck: false,
              onChange: (e) => setDraft(e.target.value),
              placeholder: dt('drill.d183'),
            }),
            h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 6 } },
              dt('drill.d184') + (active || 'role') + dt('drill.d185')))))
    }

    /* ---------------------------------------------------------- 技能库（DSH 原生） */
    function SkillsTab(props) {
      const refreshKey = props.refreshKey || 0
      const [items, setItems] = React.useState([])
      const [meta, setMeta] = React.useState({})
      const [err, setErr] = React.useState(null)
      const [q, setQ] = React.useState('')
      const [srcOnly, setSrcOnly] = React.useState(false)
      const [active, setActive] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [brokenOnly, setBrokenOnly] = React.useState(false)

      /* refresh=true 跳过后端 30 秒可用性缓存（技能正文/环境变量可能刚改过） */
      const load = (force) => {
        setBusy(true)
        api({ op: 'skillCatalog', refresh: force === true }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d165')); return }
          setErr(null)
          setMeta(r || {})
          setItems(r.items || [])
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [refreshKey])

      const open = (skill) => {
        const name = skill && skill.name
        const key = (skill && skill.library ? skill.library : 'redteam') + ':' + name
        if (active === key) { setActive(null); setDetail(null); return }
        setActive(key)
        setDetail(null)
        api({ op: 'skillRead', name: name, library: skill.library || 'redteam' }).then((r) => {
          if (r && r.ok) setDetail(r)
          else setErr((r && r.error) || dt('drill.d165'))
        }, (e) => setErr(String((e && e.message) || e)))
      }

      const needle = q.trim().toLowerCase()
      let filtered = needle
        ? items.filter((s) => (s.name + ' ' + s.description + ' ' + s.whenToUse).toLowerCase().indexOf(needle) >= 0)
        : items
      if (srcOnly) filtered = filtered.filter((s) => s.library !== 'official' && s.fromPlugin === true)
      if (brokenOnly) filtered = filtered.filter((s) => s.library !== 'official' && (s.availability === 'broken' || s.availability === 'unknown'))
      /* 目录聚合：一眼看出"这么多技能是哪来的"（本项目/别的插件/自带根…） */
      const dirs = (meta.byDir || []).filter((d) => d.n > 0).slice(0, 6)
      const availSummary = meta.availability ? meta.availability.summary : null
      const needRestart = err !== null && String(err).indexOf('unknown op') >= 0

      const renderSkill = (s) => h('div', Object.assign({
        key: (s.library || 'redteam') + ':' + s.name, className: 'rt-item' + (active === ((s.library || 'redteam') + ':' + s.name) ? ' on' : ''),
      }, clickable(() => open(s), { label: dt('drill.d186') + s.name, expanded: active === ((s.library || 'redteam') + ':' + s.name) })),
        h('div', { className: 'rt-item-name' }, s.name,
          s.modelInvocable === false ? h('span', { className: 'rt-tag', style: { marginLeft: 6 } }, dt('drill.d187')) : null,
          s.library === 'official'
            ? h('span', { className: 'rt-tag', style: { marginLeft: 6 }, title: dt('drill.d188') }, dt('drill.d189'))
            : h('span', {
              className: 'rt-badge rt-badge--' + (s.availability === 'available' ? 'ok' : s.availability === 'broken' ? 'warn' : 'idle'),
              style: { marginLeft: 6 },
              title: (s.availability === 'available'
                ? dt('drill.d190')
                : (s.problems || []).join('\n') || dt('drill.d32')),
            }, s.availability === 'available' ? [dt('drill.k30017')] : s.availability === 'broken' ? [dt('drill.k30018')] : dt('drill.d32')),
        h('div', { className: 'rt-item-desc' }, s.description || dt('drill.d191')),
        h('div', { className: 'rt-kb-sub' },
          [s.source ? dt('drill.d192') + s.source : null,
            s.fromPlugin ? [dt('drill.k30019')] : null,
            s.provider ? s.provider : null,
            s.dir ? s.dir : null].filter(Boolean).join(' · ')),
        (s.problems || []).length > 0 && s.availability !== 'available' && s.library !== 'official'
          ? h('div', { className: 'rt-caution' },
              h('span', { className: 'rt-caution__label' }, dt('drill.note')),
              h('span', null, String(s.problems[0]).slice(0, 60)))
          : null))
      const redteamRows = filtered.filter((s) => s.library !== 'official').map(renderSkill)
      const officialRows = filtered.filter((s) => s.library === 'official').map(renderSkill)
      const listItems = []
      if (redteamRows.length > 0) {
        listItems.push(h('div', { key: 'head-redteam', className: 'rt-kb-sub', style: { margin: '8px 0 4px', fontWeight: 600 } }, dt('drill.d193')))
        listItems.push.apply(listItems, redteamRows)
      }
      if (officialRows.length > 0) {
        listItems.push(h('div', { key: 'head-official', className: 'rt-kb-sub', style: { margin: '8px 0 4px', fontWeight: 600 } }, dt('drill.d194')))
        listItems.push.apply(listItems, officialRows)
      }

      return h('div', { className: 'rt-split' },
        h('div', { className: 'rt-list' },
          h('input', {
            className: 'rt-input', style: { width: '100%', marginBottom: 8, boxSizing: 'border-box' },
            placeholder: dt('drill.d195'), value: q, onChange: (e) => setQ(e.target.value),
          }),
          h('label', { className: 'rt-kb-check', style: { display: 'flex', margin: '0 0 6px' } },
            h('input', { type: 'checkbox', checked: srcOnly, onChange: (e) => setSrcOnly(e.target.checked) }),
            dt('drill.d196') + (meta.fromPlugin || 0) + dt('drill.d197')),
          availSummary && (availSummary.broken > 0 || availSummary.unknown > 0)
            ? h('label', {
                className: 'rt-kb-check', style: { display: 'flex', margin: '0 0 8px' },
                title: dt('drill.d198'),
              },
                h('input', { type: 'checkbox', checked: brokenOnly, onChange: (e) => setBrokenOnly(e.target.checked) }),
                dt('drill.d199') + ((availSummary.broken || 0) + (availSummary.unknown || 0)) + dt('drill.d197'))
            : null,
          availSummary
            ? h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 } },
                h('span', { className: 'rt-avail rt-avail-available' }, dt('drill.d200') + (availSummary.available || 0)),
                availSummary.broken > 0 ? h('span', { className: 'rt-avail rt-avail-broken' }, dt('drill.d201') + availSummary.broken) : null,
                availSummary.unknown > 0 ? h('span', { className: 'rt-avail rt-avail-unknown' }, dt('drill.d202') + availSummary.unknown) : null,
                h('span', Object.assign({
                  className: 'rt-tag', style: { cursor: 'pointer' },
                  title: dt('drill.d203'),
                }, clickable(() => load(true), { label: dt('drill.d204') })), dt('drill.d205')))
            : null,
          /* 库归属与可用性计数：数字大、标签小（原来是一段「红队 N 个 · 官方 M 个」的说明句） */
          h(StatRow, {
            groups: [
              {
                key: 'libraries',
                items: [
                  { key: 'redteam', label: dt('drill.d193'), value: (meta.libraries && meta.libraries.redteam) || 0 },
                  { key: 'official', label: dt('drill.d189'), value: (meta.libraries && meta.libraries.official) || 0 },
                  { key: 'broken', label: dt('drill.k30018'), value: availSummary ? (availSummary.broken || 0) : 0 },
                ],
              },
            ],
          }),
          items.length > 100 ? h('div', { style: { marginTop: 3 } },
            dt('drill.d208') + (meta.fromPlugin || 0) + dt('drill.d197')) : null,
          listItems),
        h('div', { className: 'rt-main' },
          h('div', { className: 'rt-toolbar' },
            h('span', { style: { fontWeight: 600 } }, detail ? detail.name : dt('drill.d209')),
            h('div', { className: 'rt-spacer' }),
            h('button', { className: 'rt-btn', disabled: busy, onClick: () => load(true) }, busy ? [dt('drill.k30020')] : dt('drill.d82'))),
          err
            ? (needRestart
                ? h('div', { className: 'rt-empty' }, dt('drill.d210'))
                : h('div', { className: 'rt-err' }, err))
            : null,
          detail
            ? h('div', { className: 'rt-pane' },
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d211')), h('span', null, detail.description || '—')),
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d212')), h('span', null, detail.whenToUse || '—')),
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d130')), h('span', null, (detail.provider || '—') + ' / ' + (detail.source || '—'))),
                (() => {
                  const s2 = items.find((x) => ((x.library || 'redteam') + ':' + x.name) === active)
                  if (!s2) return null
                  if (s2.library === 'official') {
                    return h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d213')), h('span', null, dt('drill.d214')))
                  }
                  const avail = s2.availability || 'unknown'
                  return h('div', null,
                    h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d215')),
                      h('span', { className: 'rt-avail rt-avail-' + avail },
                        avail === 'available' ? [dt('drill.k30017')] : avail === 'broken' ? [dt('drill.k30021')] : dt('drill.d216'))),
                    (s2.problems || []).length > 0
                      ? h('div', { className: 'rt-kv' }, h('b', null, avail === 'available' ? [dt('drill.k30022')] : dt('drill.d217')),
                          h('span', null, s2.problems.map((x, i) => h('div', { key: 'p' + i }, '· ' + x))))
                      : null,
                    (s2.needs_user || []).length > 0
                      ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d218')),
                          h('span', { style: { color: 'var(--dsw-alias-state-warn-primary, #f59e0b)' } },
                            s2.needs_user.map((x, i) => h('div', { key: 'n' + i }, '· ' + x))))
                      : null)
                })(),
                detail.path ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d219')), h('span', { className: 'rt-mono', style: { wordBreak: 'break-all' } }, detail.path)) : null,
                h('pre', { className: 'rt-md', style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, maxHeight: '52vh' } }, detail.content || dt('drill.d175')))
            : h('div', { className: 'rt-pane' },
                h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
                  meta.note || dt('drill.d220')),
                availSummary
                  ? h('div', { style: { fontSize: 12, marginBottom: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
                      h('span', { className: 'rt-avail rt-avail-available' }, dt('drill.d200') + (availSummary.available || 0)),
                      availSummary.broken > 0 ? h('span', { className: 'rt-avail rt-avail-broken' }, dt('drill.d201') + availSummary.broken) : null,
                      availSummary.unknown > 0 ? h('span', { className: 'rt-avail rt-avail-unknown' }, dt('drill.d202') + availSummary.unknown) : null,
                      h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                        '（' + (meta.availability && meta.availability.cached ? [dt('drill.k30023')] : dt('drill.d221'))
                        + (meta.availability && meta.availability.checked_at ? fmt(meta.availability.checked_at) : '—') + '）'))
                  : null,
                meta.availability && (meta.availability.broken || []).length > 0
                  ? h('div', { className: 'rt-hint' },
                      h('div', { style: { fontWeight: 600, marginBottom: 4 } }, dt('drill.d222')),
                      meta.availability.broken.slice(0, 12).map((b) => h('div', { key: b.name },
                        '· ' + b.name + (b.problems && b.problems.length ? ' — ' + b.problems[0] : ''))))
                  : null,
                (meta.byDir || []).slice(0, 6).map((d) => h('div', { key: d.key, className: 'rt-mono', style: { fontSize: 11, marginBottom: 2, overflowWrap: 'anywhere' } },
                  d.n + dt('drill.d223') + d.key)),
                (meta.byDir || []).length > 6
                  ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                      dt('drill.d224') + ((meta.byDir || []).length - 6) + dt('drill.d225') + items.length + dt('drill.d226'))
                  : null,
                h(EmptyState, {
                  text: filtered.length ? dt('drill.t40skillsFiltered') : dt('drill.t40skillsEmpty'),
                  path: filtered.length ? null : ((meta.byDir || [])[0] || {}).key || null,
                  action: filtered.length
                    ? h('button', {
                        className: 'rt-btn',
                        onClick: () => { setQ(''); setSrcOnly(false); setBrokenOnly(false) },
                      }, dt('drill.t40clearFilter'))
                    : null,
                })))
      )
    }

    /* ---------------------------------------------------------- 漏洞战果 */
    const SEV_LABEL = { critical: dt('drill.d228'), high: dt('drill.d229'), medium: dt('drill.d230'), low: dt('drill.d231'), info: dt('drill.d232') }
    const STATUS_LABEL = { candidate: dt('drill.d233'), confirmed: dt('drill.d234'), 'false-positive': dt('drill.d235'), exploited: dt('drill.d236'), fixed: dt('drill.d237') }
    const sevClass = (s) => 'rt-sev rt-sev-' + (SEV_LABEL[s] ? s : 'info')


    /** 目标归并：按「scheme://host:port」聚合，避免带路径的 URL 把分组打散。 */
    function targetKeyOf(v) {
      const t = String(v.target || '').trim()
      if (t !== '') {
        const url = /^([a-z][a-z0-9+.-]*:\/\/[^/?#\s]+)/i.exec(t)
        if (url) return url[1]
        const head = /^([^\s/?#]+)/.exec(t)
        if (head) return head[1]
        return t
      }
      return v.asset_ip || dt('drill.d238')
    }

    /* ---------------------------------------------------------- 证据渲染 */
    /** 把一段原始 HTTP 报文按「请求行/状态行 + 头 + 体」着色，便于人眼扫读。 */
    function HttpBlock(props) {
      const text = String(props.text || '')
      if (!text) return null
      const lines = text.split(/\r?\n/)
      const nodes = lines.map((ln, i) => {
        let cls = null
        if (i === 0 && /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|TRACE)\s/.test(ln)) cls = 'rt-hl-req'
        else if (i === 0 && /^HTTP\//.test(ln)) cls = 'rt-hl-res'
        else if (/^[A-Za-z0-9-]+:/.test(ln)) {
          const name = ln.split(':')[0].toLowerCase()
          if (name === 'host' || name === 'cookie' || name === 'authorization' || name === 'content-type') cls = 'rt-hl-req'
        }
        return h('div', { key: 'l' + i, className: cls || undefined }, ln === '' ? '\u00a0' : ln)
      })
      return h('pre', { className: 'rt-evi-body' + (props.compact ? ' req' : '') }, nodes)
    }

    /** 漏洞详情里的证据区：结构化证据文本 + 该漏洞的原始 HTTP 请求/响应记录。 */
    function detailEvidence(v) {
      const evi = String(v.evidence || '').trim()
      const looksHttp = /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|HTTP\/)/m.test(evi) || /\n[A-Za-z-]+: /.test(evi)
      const blocks = []
      if (evi) {
        blocks.push(h('div', { key: 'ev', className: 'rt-evi' },
          h('div', { className: 'rt-evi-head' }, dt('drill.d239'),
            h('span', { className: 'rt-tag' }, looksHttp ? [dt('drill.k30024')] : dt('drill.d240')),
            h('div', { className: 'rt-spacer' }),
            h('button', {
              className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
              onClick: (e) => { e.stopPropagation(); copyText(evi) },
            }, dt('drill.d241'))),
          looksHttp ? h(HttpBlock, { text: evi }) : h('pre', { className: 'rt-evi-body' }, evi)))
      }
      const http = v.http_evidence || []
      for (const e of http) {
        blocks.push(h('div', { key: 'h' + e.id, className: 'rt-evi' },
          h('div', { className: 'rt-evi-head' },
            e.label || dt('drill.d242'),
            h('span', { className: 'rt-tag' }, (e.method || '') + ' ' + (e.status === null || e.status === undefined ? '' : e.status)),
            h('div', { className: 'rt-spacer' }),
            h('span', { style: { fontWeight: 400, color: 'var(--dsw-alias-label-secondary)' } }, fmt(e.captured_at || e.created_at))),
          e.request ? h('div', null,
            h('div', { className: 'rt-evi-head', style: { borderTop: 'none' } }, dt('drill.d243')),
            h(HttpBlock, { text: e.request, compact: true })) : null,
          e.response ? h('div', null,
            h('div', { className: 'rt-evi-head' }, dt('drill.d244')),
            h(HttpBlock, { text: e.response })) : null,
          e.note ? h('pre', { className: 'rt-evi-body', style: { maxHeight: 80 } }, e.note) : null))
      }
      if (blocks.length === 0) {
        blocks.push(h('div', { key: 'none', className: 'rt-kv' }, h('b', null, dt('drill.d26')),
          h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, dt('drill.d245'))))
      }
      return h('div', { key: 'eviwrap' }, blocks)
    }

    function FindingsTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [sev, setSev] = React.useState('')
      const [status, setStatus] = React.useState('')
      const [q, setQ] = React.useState('')
      const [qApplied, setQApplied] = React.useState('')
      const [state, setState] = React.useState({ loading: false, error: null, total: 0, items: [], stats: null })
      const [creds, setCreds] = React.useState([])
      const [accesses, setAccesses] = React.useState([])
      const [files, setFiles] = React.useState([])
      const [openId, setOpenId] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      /* 子页签：漏洞 / 凭据 / 访问会话（凭据不再铺在漏洞页底部） */
      const [subTab, setSubTab] = React.useState('vulns')
      /* 默认按目标聚合：322 条平铺没法读，先看"哪台被打下什么" */
      const [grouped, setGrouped] = React.useState(true)
      const collapse = useCollapse('findings:' + eng)

      const load = () => {
        if (!eng) return
        api({
          op: 'vulns', engagement: eng, severity: sev || undefined,
          status: status || undefined, q: qApplied || undefined, limit: 200,
        }).then((r) => {
          if (!r || r.ok === false) {
            setState({ loading: false, error: (r && r.error) || dt('drill.d45'), total: 0, items: [], stats: null })
            return
          }
          setState({ loading: false, error: null, total: r.total, items: r.items || [], stats: r.stats || null })
        }, (e) => setState({ loading: false, error: String((e && e.message) || e), total: 0, items: [], stats: null }))
        api({ op: 'credentials', engagement: eng }).then((r) => setCreds((r && r.items) || []), () => {})
        api({ op: 'access', engagement: eng }).then((r) => setAccesses((r && r.items) || []), () => {})
        api({ op: 'attackFiles', engagement: eng }).then((r) => setFiles((r && r.items) || []), () => {})
      }
      React.useEffect(load, [eng, sev, status, qApplied, refreshKey])

      const setVulnStatus = (id, next) => {
        setMsg(null)
        api({ op: 'updateVuln', engagement: eng, id: id, patch: { status: next } }).then((r) => {
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d246') }); return }
          setMsg({ ok: dt('drill.d247') + (STATUS_LABEL[next] || next) + '」' })
          load()
        }, (e) => setMsg({ err: String((e && e.message) || e) }))
      }

      const stats = (state.stats && state.stats.bySeverity) ? state.stats : { bySeverity: {}, byStatus: {} }
      const needRestart = state.error !== null && String(state.error).indexOf('unknown op') >= 0

      const allFiles = (files || []).flatMap((g) => (g.files || []).map((f) => Object.assign({ target: g.target }, f)))
      const filesByVuln = new Map()
      const orphanFiles = []
      for (const f of allFiles) {
        const vid = f.vuln_id === null || f.vuln_id === undefined ? null : Number(f.vuln_id)
        if (vid === null) { orphanFiles.push(f); continue }
        if (!filesByVuln.has(vid)) filesByVuln.set(vid, [])
        filesByVuln.get(vid).push(f)
      }

      /* ── 结论行：只给结论，数字点一下就是筛选 ─────────────────────── */
      const concl = (key, label, value, active, onClick) => h('span', Object.assign({
        key: key, className: 'rt-concl-i' + (active ? ' on' : ''), title: dt('drill.d87'),
      }, clickable(onClick, { label: dt('drill.d88') + label + dt('drill.d89') + (value || 0) + '）', expanded: active })),
        h('b', null, String(value || 0)), h('span', null, label))
      const conclusion = h('div', { className: 'rt-concl' },
        concl('conf', dt('drill.d234'), (stats.byStatus.confirmed || 0), status === 'confirmed', () => setStatus((v) => (v === 'confirmed' ? '' : 'confirmed'))),
        concl('exp', dt('drill.d236'), (stats.byStatus.exploited || 0), status === 'exploited', () => setStatus((v) => (v === 'exploited' ? '' : 'exploited'))),
        concl('crit', dt('drill.d228'), (stats.bySeverity.critical || 0), sev === 'critical', () => setSev((v) => (v === 'critical' ? '' : 'critical'))),
        concl('high', dt('drill.d229'), (stats.bySeverity.high || 0), sev === 'high', () => setSev((v) => (v === 'high' ? '' : 'high'))),
        concl('med', dt('drill.d230'), (stats.bySeverity.medium || 0), sev === 'medium', () => setSev((v) => (v === 'medium' ? '' : 'medium'))),
        concl('gain', dt('drill.d248'), (stats.withGained || 0), false, () => {}),
        h('div', { className: 'rt-spacer' }),
        h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
          dt('drill.d249') + (stats.targetGroups || 0) + dt('drill.d250')))

      const head = h('div', { className: 'rt-vrow head' },
        h('span', null, dt('drill.d251')), h('span', null, dt('drill.d252')), h('span', null, dt('drill.d253')),
        h('span', null, dt('drill.d254')), h('span', null, dt('drill.d255')), h('span', null, dt('drill.d256')))

      /* 单条漏洞（行 + 展开详情），聚合视图与平铺视图共用 */
      const vulnRows = (v, compact) => {
        const out = []
        const gainedList = String(v.gained || '').split(/[、,;，；]/).map((x) => x.trim()).filter(Boolean)
        const open = openId === v.id
        out.push(h('div', {
          key: 'v' + v.id, className: 'rt-vrow', role: 'button', tabIndex: 0,
          style: compact
            ? { cursor: 'pointer', gridTemplateColumns: tableColumns([{ key: 'sev', width: 58 }, { key: 'title' }, { key: 'gained', width: 104 }, { key: 'conf', width: 68 }]) }
            : { cursor: 'pointer' },
          onClick: () => setOpenId(open ? null : v.id),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(open ? null : v.id) } },
        },
          h('span', null, h('span', { className: sevClass(v.severity) }, SEV_LABEL[v.severity] || v.severity)),
          h('span', { title: v.title || '' }, h('span', { className: 'rt-sec-caret' }, open ? '▾' : '▸'), (v.cve ? v.cve + ' ' : '') + (v.title || '')),
          compact ? null : h('span', { className: 'rt-mono', title: v.target || '' }, v.target || v.asset_ip || '—'),
          h('span', { title: v.gained || '' },
            gainedList.length
              ? h('span', { className: 'rt-gain', style: { maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' } }, gainedList[0] + (gainedList.length > 1 ? ' +' + (gainedList.length - 1) : ''))
              : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '—')),
          h('span', null, h('span', { className: 'rt-tag' }, STATUS_LABEL[v.status] || v.status)),
          compact ? null : h('span', null, v.confidence === null || v.confidence === undefined ? '—' : Math.round(v.confidence * 100) + '%')))
        if (openId !== v.id) return out
        out.push(h('div', {
          key: 'vd' + v.id, className: 'rt-vrow',
          style: { cursor: 'default', gridTemplateColumns: tableColumns([{ key: 'full' }]) },
        }, h('div', { className: 'rt-vdetail' },
          h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d254')),
            gainedList.length
              ? h('span', null, gainedList.map((g, gi) => h('span', { key: 'g' + gi, className: 'rt-gain', style: { marginRight: 6 } }, g)))
              : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                  dt('drill.d257'))),
          h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d253')), h('span', { className: 'rt-mono', style: { wordBreak: 'break-all' } }, v.target || '—')),
          h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d142')), h('span', null, (v.asset_ip || '—') + ' · ' + (v.segment_cidr || ''))),
          h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d130')), h('span', null, (v.source || '—') + ' · ' + (v.found_by_agent || '—') + ' · ' + fmt(v.found_at))),
          detailEvidence(v),
          (() => {
            const mine = filesByVuln.get(Number(v.id)) || []
            return h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d258')),
              mine.length
                ? h('span', null, mine.map((f, fi) => h('div', { key: 'af' + fi, style: { marginBottom: 3 } },
                    '· ' + (f.kind ? '[' + f.kind + '] ' : '') + (f.name || dt('drill.d259'))
                    + (f.description ? ' — ' + f.description : ''),
                    h('div', { className: 'rt-mono', style: { fontSize: 11, marginLeft: 12, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' } }, f.path || ''))))
                : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                    dt('drill.d260')))
          })(),
          h('div', { className: 'rt-actions' },
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'confirmed') } }, dt('drill.d261')),
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'exploited') } }, dt('drill.d236')),
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'false-positive') } }, dt('drill.d235')),
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'fixed') } }, dt('drill.d237'))))))
        return out
      }

      const rows = []
      if (grouped) {
        /* 按目标聚合成组：先看"哪台被打下什么"，再点进去看具体漏洞 */
        const groups = new Map()
        for (const v of state.items) {
          const key = targetKeyOf(v)
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key).push(v)
        }
        const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
        const list = Array.from(groups.entries()).map(([key, vs]) => ({
          key,
          vulns: vs,
          top: vs.slice().sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9))[0],
          gained: Array.from(new Set(vs.flatMap((v) => String(v.gained || '').split(/[、,;，；]/).map((x) => x.trim()).filter(Boolean)))),
          exploited: vs.filter((v) => v.status === 'exploited').length,
        })).sort((a, b) => (SEV_RANK[a.top.severity] ?? 9) - (SEV_RANK[b.top.severity] ?? 9) || b.vulns.length - a.vulns.length)
        for (const g of list) {
          const key = 'target:' + g.key
          const defOpen = false
          rows.push(h(Section, {
            key: 'sec:' + g.key, tone: 'target',
            title: g.key,
            count: g.vulns.length + dt('drill.d262'),
            sub: [
              SEV_LABEL[g.top.severity] || g.top.severity,
              g.exploited ? dt('drill.d263') + g.exploited : null,
              g.top.asset_ip && g.top.asset_ip !== g.key ? dt('drill.d264') + g.top.asset_ip : null,
            ].filter(Boolean).join(' · '),
            right: g.gained.length
              ? g.gained.slice(0, 2).join(' / ') + (g.gained.length > 2 ? ' +' + (g.gained.length - 2) : '')
              : dt('drill.d265'),
            open: collapse.isOpen(key, defOpen),
            onToggle: collapse.toggle(key, defOpen),
          }, g.vulns.map((v) => vulnRows(v, true))))
        }
        if (!list.length && !state.loading && !state.error) {
          rows.push(h('div', { key: 'none', className: 'rt-empty' }, dt('drill.d266')))
        }
      } else {
        for (const v of state.items) rows.push(...vulnRows(v))
      }

      const toolbar = h('div', { className: 'rt-toolbar' },
        h('input', {
          className: 'rt-input', style: { flex: '1 1 140px' }, placeholder: dt('drill.d267'),
          value: q, onChange: (e) => setQ(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') setQApplied(q) },
        }),
        h('button', { className: 'rt-btn', onClick: () => setQApplied(q) }, dt('drill.d66')),
        h('select', { className: 'rt-input', value: sev, onChange: (e) => setSev(e.target.value) },
          h('option', { value: '' }, dt('drill.d268')),
          h('option', { value: 'critical' }, dt('drill.d228')),
          h('option', { value: 'high' }, dt('drill.d229')),
          h('option', { value: 'medium' }, dt('drill.d230')),
          h('option', { value: 'low' }, dt('drill.d231')),
          h('option', { value: 'info' }, dt('drill.d232'))),
        h('select', { className: 'rt-input', value: status, onChange: (e) => setStatus(e.target.value) },
          h('option', { value: '' }, dt('drill.d269')),
          h('option', { value: 'candidate' }, dt('drill.d233')),
          h('option', { value: 'confirmed' }, dt('drill.d234')),
          h('option', { value: 'exploited' }, dt('drill.d236')),
          h('option', { value: 'false-positive' }, dt('drill.d235')),
          h('option', { value: 'fixed' }, dt('drill.d237'))))

      const credSection = h('div', null,
        h('div', { className: 'rt-section' }, dt('drill.d270') + creds.length + (creds.length ? [dt('drill.k30025')] : '')),
        creds.length
          ? h('div', { style: { padding: '4px 10px 0' } }, creds.map((c) => h('div', { key: 'c' + c.id, className: 'rt-cred' },
              h('div', { className: 'rt-cred-head' },
                h('span', { className: 'rt-cred-host' }, c.host),
                c.username ? h('span', { className: 'rt-tag' }, c.username) : null,
                h('span', { className: 'rt-tag rt-tag-passive' }, c.secret_type || 'password'),
                c.privilege ? h('span', { className: 'rt-tag rt-tag-active' }, c.privilege) : null,
                h('div', { className: 'rt-spacer' }),
                h('button', {
                  className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
                  onClick: (e) => { e.stopPropagation(); copyText(String(c.secret_value || '')) },
                }, dt('drill.d241'))),
              c.secret_value
                ? h('div', { className: 'rt-secret', title: dt('drill.d271') }, c.secret_value)
                : h('div', { className: 'rt-secret-none' }, dt('drill.d272')),
              h('div', { className: 'rt-cred-meta' },
                [c.source ? dt('drill.d192') + c.source : null,
                  c.tool ? dt('drill.d273') + c.tool : null,
                  c.secret_ref ? dt('drill.d24') + c.secret_ref : null,
                  c.found_by_agent ? 'by ' + c.found_by_agent : null,
                  c.found_at ? fmt(c.found_at) : null].filter(Boolean).join(' · ')),
              c.note ? h('div', { className: 'rt-cred-meta' }, dt('drill.d274') + c.note) : null)))
          : h('div', { className: 'rt-empty' }, dt('drill.d275')))

      const accessSection = h('div', null,
        h('div', { className: 'rt-section' }, dt('drill.d276') + accesses.length),
        accesses.length
          ? accesses.map((a) => h('div', { key: 'a' + a.id, className: 'rt-vrow', style: { cursor: 'default', gridTemplateColumns: tableColumns([{ key: 'host' }, { key: 'user', width: 110 }, { key: 'method', width: 80 }, { key: 'priv', width: 80 }, { key: 'note' }]) } },
              h('span', { className: 'rt-mono' }, a.host),
              h('span', null, a.username || '—'),
              h('span', null, h('span', { className: 'rt-tag rt-tag-active' }, a.method || '—')),
              h('span', null, a.privilege || '—'),
              h('span', { className: 'rt-mono', title: a.session_ref || '' }, a.session_ref || '—')))
          : h('div', { className: 'rt-empty' }, dt('drill.d277')))

      const subTabBtn = (key, label, n) => h('span', Object.assign({
        className: 'rt-subtab' + (subTab === key ? ' on' : ''),
      }, clickable(() => setSubTab(key), { label: label + '（' + n + '）', expanded: subTab === key })),
      label + ' ' + n)

      return h('div', { className: 'rt-main' }, toolbar, conclusion,
        h('div', { className: 'rt-subtabs' },
          subTabBtn('vulns', dt('drill.d278'), state.total || 0),
          subTabBtn('files', dt('drill.d258'), allFiles.length),
          subTabBtn('creds', dt('drill.d279'), creds.length),
          subTabBtn('access', dt('drill.d280'), accesses.length),
          h('div', { className: 'rt-spacer' }),
          grouped ? h('button', {
            className: 'rt-btn', title: dt('drill.d281'),
            onClick: () => collapse.setAll((state.items || []).map((v) => 'target:' + targetKeyOf(v)), true),
          }, dt('drill.d282')) : null,
          grouped ? h('button', {
            className: 'rt-btn', title: dt('drill.d283'),
            onClick: () => collapse.setAll((state.items || []).map((v) => 'target:' + targetKeyOf(v)), false),
          }, dt('drill.d284')) : null,
          h('button', {
            className: 'rt-btn' + (grouped ? ' rt-btn-primary' : ''),
            title: grouped ? [dt('drill.k30026')] : dt('drill.d285'),
            onClick: () => setGrouped((g) => !g),
          }, grouped ? [dt('drill.k30027')] : dt('drill.d286'))),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        needRestart ? h('div', { className: 'rt-empty' }, dt('drill.d210')) : null,
        state.error && !needRestart ? h('div', { className: 'rt-err' }, state.error) : null,
        subTab === 'files'
          ? h('div', { className: 'rt-body', style: { overflow: 'auto' } },
              h('div', { className: 'rt-hint', style: { marginBottom: 8 } },
                dt('drill.d287')
                + (orphanFiles.length ? dt('drill.d288') + orphanFiles.length + [dt('drill.k30028')] : '')),
              h(AttackFilesTab, { engagement: eng, refreshKey: refreshKey }))
          : subTab === 'creds'
          ? h('div', { className: 'rt-body', style: { overflow: 'auto' } }, credSection)
          : subTab === 'access'
            ? h('div', { className: 'rt-body', style: { overflow: 'auto' } }, accessSection)
            : h('div', null, grouped ? null : head,
                h(TableGrid, {
                  /* 整行托管：漏洞行是可展开的 `.rt-vrow` 网格（自带列宽与详情行），
                     这里只把「一堆行 + 空态」交给原语，列模板仍是同一个生成器给的。 */
                  head: false,
                  columns: [{ key: 'row' }],
                  rows: rows.map((node, index) => ({ key: 'fv' + index, cells: [node] })),
                  empty: !state.loading && !state.items.length && !state.error
                    ? h(EmptyState, { text: dt('drill.d266') })
                    : null,
                })))
    }

    /* ---------------------------------------------------------- 攻击链 */
    const STAGE_LABEL = { recon: dt('drill.d16'), vuln: dt('drill.d18'), exploit: dt('drill.d19'), access: dt('drill.d289'), pivot: dt('drill.d290'), data: dt('drill.d291'), other: dt('drill.d292') }

    /* ---------------------------------------------------------- 攻击链（五阶段） */
    /**
     * 按攻击面位置串成一条链：
     * ① 信息收集 → ② 互联网资产权限 → ③ 边界突破 → ④ 内网资产权限 → ⑤ 靶标权限。
     * 每阶段只讲两件事：这一步拿到多少分（累计多少）、涉及的资产/隧道是哪些。
     * A = 竖向链（详细）；B = 横向链（一屏看完）。
     */
    function ChainTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [view, setView] = React.useState('A')
      const [openId, setOpenId] = React.useState(null)

      const load = () => {
        if (!eng) return
        setLoading(true)
        api({ op: 'scoreChain', engagement: eng }).then((r) => {
          setLoading(false)
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d165')); return }
          setErr(null); setData(r)
        }, (e) => { setLoading(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      const stages = (data && data.stages) || []
      const summary = (data && data.summary) || null
      const toggle = (id) => setOpenId((cur) => (cur === id ? null : id))
      const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥']

      /* 单次得分的详情 */
      const hitDetail = (x) => h('div', { className: 'rt-flow-detail' },
        h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d253')), h('span', { className: 'rt-mono', style: { wordBreak: 'break-all' } }, x.target || '—')),
        x.asset_ip ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d142')), h('span', { className: 'rt-mono' }, x.asset_ip)) : null,
        x.vuln_title ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d293')), h('span', null, [x.vuln_cve, x.vuln_title].filter(Boolean).join(' '))) : null,
        h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d294')), h('span', null,
          dt('drill.d295') + x.nth_of_point + dt('drill.d296') + (x.points || 0) + dt('drill.d297'))),
        h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d298')), h('span', null, fmt(x.recorded_at) + (x.recorded_by ? ' · ' + x.recorded_by : ''))),
        x.evidence ? h(Clip, { label: dt('drill.d299'), text: x.evidence }) : null)

      const hitRow = (x) => h('div', {
        key: 'h' + x.id,
        className: 'rt-ap-hit' + (openId === x.id ? ' open' : ''),
        role: 'button', tabIndex: 0,
        onClick: () => toggle(x.id),
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(x.id) } },
      },
        h('div', { className: 'rt-ap-hit-head' },
          h('span', { className: 'rt-ap-pts' + (x.counted ? '' : ' uncounted'), title: x.capped_reason || undefined },
            '+' + (x.counted ? (x.points || 0) : 0)),
          h('span', { className: 'rt-ap-hit-name' }, x.point_name),
          x.capped ? h('span', { className: 'rt-tag rt-tag-warn', title: x.capped_reason || dt('drill.d300') }, dt('drill.d301')) : null,
          x.nth_of_point > 1 ? h('span', { className: 'rt-ap-nth' }, dt('drill.d302') + x.nth_of_point + dt('drill.d115')) : null,
          h('span', { className: 'rt-ap-hit-target' }, x.target || x.asset_ip || '—')),
        x.action
          ? h('div', { className: 'rt-ap-act' + (x.action_inferred ? ' inferred' : '') },
              dt('drill.d303') + (x.action.title || dt('drill.d304')) + (x.action_inferred ? [dt('drill.k30029')] : ''))
          : null,
        openId === x.id ? hitDetail(x) : null)

      /* 资产行（信息收集阶段 / 各阶段涉及资产） */
      const assetRow = (a) => h('div', { key: 'a' + a.id, className: 'rt-ap-asset' },
        h('span', { className: 'rt-scope rt-scope-' + (a.scope === 'internal' ? 'internal' : 'external') },
          a.scope === 'internal' ? [dt('drill.k30007')] : dt('drill.d62')),
        h('span', { className: 'rt-mono', style: { fontWeight: 600 } }, a.ip),
        a.segment_cidr ? h('span', { className: 'rt-ap-nth' }, a.segment_cidr) : null,
        h('span', { className: 'rt-ap-nth' }, dt('drill.d305') + (a.open_ports || 0)),
        a.vulns ? h('span', { className: 'rt-ap-nth' }, dt('drill.d306') + a.vulns) : null,
        a.priority ? h('span', { className: 'rt-tag' }, dt('drill.d307') + a.priority) : null,
        h('div', { className: 'rt-spacer' }),
        h('span', { className: 'rt-ap-pts' }, '+' + (a.points || 0) + dt('drill.d297')),
        h('span', { className: 'rt-ap-nth' }, (a.hits || 0) + dt('drill.d115')))

      /* 攻击链只讲"打到哪了、拿了多少分"：不展示打法要点与工具清单，
         那些是执行细节，混在链路里会淹没得分与资产信息。 */

      /* ── A：竖向攻击链 ─────────────────────────────────────────── */
      const stageA = (st, i) => {
        const isRecon = st.code === 'recon'
        const body = []
        if (isRecon) {
          body.push(h('div', { key: 'at', className: 'rt-ap-sub' }, dt('drill.d308') + st.assetCount + dt('drill.d60')))
          body.push(h('div', { key: 'al', className: 'rt-ap-assets' },
            st.assets.length ? st.assets.map(assetRow) : h('div', { className: 'rt-ap-none' }, dt('drill.d309'))))
        } else {
          body.push(h('div', { key: 'ht', className: 'rt-ap-sub' },
            dt('drill.d310') + st.hits + dt('drill.d115') + (st.points ? ' · +' + st.points + [dt('drill.k30030')] : '')))
          body.push(h('div', { key: 'hl', className: 'rt-ap-hits rt-timeline' },
            st.items.length ? st.items.map(hitRow) : h('div', { className: 'rt-ap-none' }, dt('drill.d311'))))
          if (st.code === 'boundary') {
            const selfOnly = (st.tunnels_self_only || []).length
            body.push(h('div', { key: 'tt', className: 'rt-ap-sub' },
              dt('drill.d312') + st.tunnels.length + dt('drill.d313') + (selfOnly ? dt('drill.d314') + selfOnly + [dt('drill.k30031')] : '')))
            if (selfOnly && st.tunnels.length === 0) {
              body.push(h('div', { key: 'tw', className: 'rt-ap-none' },
                dt('drill.d315')))
            }
            body.push(h('div', { key: 'tl', className: 'rt-ap-tunnels' },
              st.tunnels.length
                ? st.tunnels.map((t) => h('div', { key: 't' + t.id, className: 'rt-ap-tunnel' },
                    h('span', { className: 'rt-tag rt-tag-passive' }, t.kind || 'tunnel'),
                    h('span', { className: 'rt-mono', style: { fontWeight: 600 } }, t.listen || '—'),
                    h('span', {
                      className: 'rt-tag ' + (t.status === 'active' ? 'rt-tag-live' : ''),
                      style: t.status === 'active' ? {} : { opacity: .7 },
                    }, t.status === 'active' ? [dt('drill.k30017')] : (t.status || dt('drill.d32'))),
                    h('span', { className: 'rt-ap-nth', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } },
                      dt('drill.d316') + (t.reach || '—'))))
                : h('div', { className: 'rt-ap-none' }, dt('drill.d317'))))
          }
          if (st.assets.length && st.code !== 'boundary') {
            body.push(h('div', { key: 'at', className: 'rt-ap-sub' }, dt('drill.d318') + st.assetCount + dt('drill.d60')))
            body.push(h('div', { key: 'al', className: 'rt-ap-assets rt-timeline' }, st.assets.map(assetRow)))
          }
        }

        return h('div', { key: 'st' + st.code, className: 'rt-ap-stage' },
          h('div', { className: 'rt-ap-head', style: { borderLeftColor: st.color } },
            h('span', { className: 'rt-ap-no', style: { background: st.color } }, CIRCLED[i] || ('0' + (i + 1))),
            h('span', { className: 'rt-ap-name' }, st.name),
            st.subtitle ? h('span', { className: 'rt-ap-en' }, st.subtitle) : null,
            h('div', { className: 'rt-spacer' }),
            st.points > 0 ? h('span', { className: 'rt-ap-pts', style: { background: st.color + '22', color: st.color, borderColor: st.color + '66' } }, '+' + st.points) : null,
            h('span', { className: 'rt-ap-cum' }, dt('drill.d319') + st.cumulative + dt('drill.d297'))),
          h('div', { className: 'rt-ap-goal', style: { borderLeftColor: st.color } },
            h('span', { className: 'rt-ap-goal-tag', style: { color: st.color, borderColor: st.color + '66' } }, dt('drill.d320')),
            h('span', null, st.goal)),
          h('div', { className: 'rt-ap-result', style: { borderLeftColor: st.color } }, body),
          i < stages.length - 1
            ? h('div', { className: 'rt-ap-trans' },
                h('span', { className: 'rt-flow-arrow' }, '▼'),
                st.transition ? h('span', { className: 'rt-ap-trans-t' }, st.transition) : null,
                h('span', { className: 'rt-ap-trans-t', style: { marginLeft: 'auto' } }, dt('drill.d319') + st.cumulative + dt('drill.d297')))
            : h('div', { className: 'rt-ap-trans' },
                h('span', { className: 'rt-flow-arrow' }, '▼'),
                h('span', { className: 'rt-ap-trans-t' }, dt('drill.d321') + ((summary && summary.points) || 0) + dt('drill.d297'))))
      }

      /* ── B：横向攻击链（一屏看完） ─────────────────────────────── */
      const stageB = (st, i) => h('div', { key: 'c' + st.code, className: 'rt-ap-col' },
        i > 0 ? h('span', { className: 'rt-ap-col-arrow' }, '▶') : null,
        h('div', { className: 'rt-hcol', style: { borderTopColor: st.color } },
          h('div', { className: 'rt-ap-head', style: { borderLeftColor: st.color, padding: '5px 8px' } },
            h('span', { className: 'rt-ap-no', style: { background: st.color, width: 16, height: 16, fontSize: 10 } }, String(i + 1)),
            h('span', { className: 'rt-ap-name', style: { fontSize: 12 } }, st.name),
            h('div', { className: 'rt-spacer' }),
            h('span', { className: 'rt-ap-cum', style: { fontWeight: 700 } }, st.cumulative)),
          h('div', { className: 'rt-hcol-goal', title: st.goal }, st.goal),
          h('div', { className: 'rt-hcol-body' },
            st.code === 'boundary'
              ? h('div', null,
                  h('div', { className: 'rt-hcol-hit' }, h('span', { className: 'rt-hcol-pts' }, '+' + st.points), h('span', { className: 'rt-hcol-name' }, dt('drill.d322') + st.tunnels.length + dt('drill.d313'))),
                  st.tunnels.slice(0, 3).map((t) => h('div', { key: 't' + t.id, className: 'rt-hcol-sub' }, '▸ ' + (t.kind || '') + ' ' + (t.listen || ''))))
              : st.code === 'recon'
                ? h('div', null,
                    h('div', { className: 'rt-hcol-hit' }, h('span', { className: 'rt-hcol-pts' }, st.assetCount), h('span', { className: 'rt-hcol-name' }, dt('drill.d323'))),
                    st.assets.slice(0, 6).map((a) => h('div', { key: 'a' + a.id, className: 'rt-hcol-sub', title: a.ip + '  +' + a.points + dt('drill.d297') },
                      (a.scope === 'internal' ? [dt('drill.k30032')] : dt('drill.d324')) + a.ip + '  +' + a.points)))
                : h('div', null,
                    h('div', { className: 'rt-hcol-hit' }, h('span', { className: 'rt-hcol-pts' }, '+' + st.points), h('span', { className: 'rt-hcol-name' }, st.hits + dt('drill.d325'))),
                    st.items.slice(0, 6).map((x) => h('div', { key: 'c' + x.id, className: 'rt-hcol-sub', title: x.point_name + '  ' + (x.target || '') },
                      h('span', { className: 'rt-hcol-pts' }, '+' + x.points), h('span', { className: 'rt-hcol-name' }, x.point_name))),
                    st.items.length > 6 ? h('div', { className: 'rt-hcol-none' }, dt('drill.d224') + (st.items.length - 6) + dt('drill.d115')) : null,
                    st.assetCount ? h('div', { className: 'rt-hcol-none' }, dt('drill.d326') + st.assetCount + dt('drill.d327')) : null))))

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, dt('drill.d328')),
          h('span', { className: 'rt-tag', style: { fontSize: 10.5 } }, dt('drill.d329')),
          summary ? h('span', { className: 'rt-tag rt-tag-live' }, dt('drill.d330') + summary.points + dt('drill.d297')) : null,
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn' + (view === 'A' ? ' rt-btn-primary' : ''), title: dt('drill.d331'), onClick: () => setView('A') }, dt('drill.d332')),
          h('button', { className: 'rt-btn' + (view === 'B' ? ' rt-btn-primary' : ''), title: dt('drill.d333'), onClick: () => setView('B') }, dt('drill.d334')),
          h('button', { className: 'rt-btn', disabled: loading, onClick: load }, loading ? [dt('drill.k30033')] : dt('drill.d82'))),
        err ? h('div', { className: 'rt-err' }, err) : null,
        !stages.length && !err && data !== null
          ? h(EmptyState, { text: dt('drill.d335'), action: h('button', { className: 'rt-btn', onClick: load }, dt('drill.d82')) })
          : view === 'A'
            ? h('div', { className: 'rt-ap' }, stages.map(stageA))
            : h('div', { className: 'rt-ap-h' }, stages.map(stageB)))
    }

    /* ---------------------------------------------------------- 得分复现报告 */
    /**
     * 报告分组兜底：host 只给平铺条目时，用 scoreChain 的阶段信息把条目按攻击链顺序分组。
     * 依据是两边共同的 score_hit id —— scoreChain 的每条 item 都带 stage_code，
     * scoreReport 的每条 item 带同样的 id。这样即使 host 侧版本较旧或阶段行缺失，
     * 报告页也能正常显示，而不是误报"还没有可交付的成果"。
     */
    function groupByStage(reportItems, chain) {
      const byId = new Map((reportItems || []).map((x) => [x.id, x]))
      const groups = []
      const stageList = (chain && chain.stages) || []
      stageList.forEach((st, si) => {
        const items = (st.items || []).map((x) => byId.get(x.id)).filter(Boolean)
        if (items.length === 0) return
        groups.push({ code: st.code, name: st.name, color: st.color || 'var(--dsw-alias-label-secondary, #64748b)',
          ordinal: st.ordinal || si + 1, points: st.points || 0, cumulative: st.cumulative || 0, items })
      })
      /* scoreChain 完全没有阶段信息时，至少把得分归到「其他」，不要让条目凭空消失 */
      const grouped = new Set(groups.reduce((acc, g) => acc.concat(g.items.map((x) => x.id)), []))
      const rest = (reportItems || []).filter((x) => !grouped.has(x.id))
      if (rest.length > 0) {
        groups.push({ code: 'other', name: dt('drill.d336'), color: 'var(--dsw-alias-label-secondary, #64748b)', ordinal: groups.length + 1,
          points: rest.reduce((n, x) => n + (x.counted ? x.points : 0), 0),
          cumulative: 0, items: rest })
      }
      return groups
    }

    function ReportTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      /* 报告按阶段折叠：默认全开，折叠状态按靶标记住（阶段多时便于逐段交付） */
      const collapse = useCollapse('report:' + eng)

      const load = () => {
        if (!eng) return
        setBusy(true); setMsg(null)
        api({ op: 'scoreReport', engagement: eng }).then((r) => {
          if (!r || r.ok === false) { setBusy(false); setErr((r && r.error) || dt('drill.d337')); return }
          /* 老 host 只给平铺条目、不给阶段分组（或阶段行缺失）：自己按攻击链分组，
             否则报告页会误报dt('drill.d338')。分组数据取自 scoreChain。 */
          if ((!r.stages || r.stages.length === 0) && (r.items || []).length > 0) {
            api({ op: 'scoreChain', engagement: eng }).then((c) => {
              setBusy(false); setErr(null); setData(Object.assign({}, r, { stages: groupByStage(r.items, c) }))
            }, () => { setBusy(false); setErr(null); setData(r) })
            return
          }
          setBusy(false); setErr(null); setData(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      /* 复制结果必须是真实的：clipboard API 失败时（非安全上下文/失焦/被拒）要如实提示，
         否则用户以为复制成功、粘到 Yakit 里是空的。 */
      const copy = (text, label) => copyWithFeedback(text, label, (okFlag, message) => {
        setMsg(okFlag ? { ok: message } : { err: message })
      })
      const download = (text, label) => {
        try {
          const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = 'report-' + String(label || 'score').replace(/[^\w.\-]/g, '_') + '.md'
          a.click()
          /* 立刻 revoke 会在部分浏览器里让 click 启动的下载断流，延后一拍 */
          setTimeout(() => { try { URL.revokeObjectURL(url) } catch { /* ignore */ } }, 1000)
          setMsg({ ok: dt('drill.d339') + label })
        } catch (e) { setMsg({ err: dt('drill.d340') + ((e && e.message) || e) }) }
      }

      const items = (data && data.items) || []
      const stages = (data && data.stages) || []
      const summary = (data && data.summary) || null
      const mdText = (data && data.markdown) || ''
      const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳']

      /* 每项一条，平铺不折叠：目标 → 拿到什么 → 复现请求（可直接粘进 Yakit）→ 响应 */
      const card = (x) => h('div', { key: 'r' + x.id, className: 'rt-rep' },
        h('div', { className: 'rt-rep-head' },
          h('span', { className: 'rt-rep-idx' }, String(x.seq)),
          h('span', { className: 'rt-rep-name' }, x.point_name),
          h('span', { className: 'rt-flow-pts' }, '+' + x.points + dt('drill.d297')),
          x.nth_of_point > 1 ? h('span', { className: 'rt-tag' }, dt('drill.d295') + x.nth_of_point + dt('drill.d115')) : null,
          h('div', { className: 'rt-spacer' }),
          h('button', {
            className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
            onClick: () => copy((x.requests || []).map((v) => v.request || '').filter(Boolean).join('\n\n'), dt('drill.d302') + x.seq + dt('drill.d341')),
          }, dt('drill.d342'))),
        h('div', { className: 'rt-rep-meta' },
          h('span', null, h('b', null, dt('drill.d343'))), h('span', { className: 'rt-mono' }, x.target || x.asset_ip || '—')),
        x.gained ? h('div', { className: 'rt-rep-meta' }, h('b', null, dt('drill.d344')), h('span', null, x.gained)) : null,
        x.vuln ? h('div', { className: 'rt-rep-meta' }, h('b', null, dt('drill.d345')),
          h('span', null, [x.vuln.cve, x.vuln.title].filter(Boolean).join(' '))) : null,
        x.evidence ? h('div', { className: 'rt-rep-meta' }, h('b', null, dt('drill.d346')),
          h('span', null, String(x.evidence).replace(/\n+/g, ' '))) : null,
        x.recorded_at ? h('div', { className: 'rt-rep-meta' }, h('b', null, dt('drill.d347')),
          h('span', null, fmt(x.recorded_at) + (x.recorded_by ? '（' + (ROLE_LABEL[x.recorded_by] || x.recorded_by) + '）' : ''))) : null,
        h(ShotStrip, { eng: eng, shots: x.shots, total: x.shot_total, title: dt('drill.d28') }),
        /* ── 复现步骤：动作记录（含实际命令与回显）+ 凭据 + 隧道 + WebShell ─────
           报告的交付价值全在这块：账号密码怎么来的、隧道怎么搭的，用户照着就能复现。 */
        h('details', { className: 'rt-rep-trace', open: x.incomplete === true || (x.steps || []).length === 0 },
          h('summary', { className: 'rt-rep-trace-head', style: { cursor: 'pointer' } },
            h('span', { className: 'rt-rep-trace-title' }, dt('drill.d348')),
            (x.steps || []).length ? h('span', { className: 'rt-tag' }, (x.steps || []).length + dt('drill.d349')) : null,
            (x.credentials || []).length ? h('span', { className: 'rt-tag' }, (x.credentials || []).length + dt('drill.d350')) : null,
            (x.tunnels || []).length ? h('span', { className: 'rt-tag' }, (x.tunnels || []).length + dt('drill.d351')) : null,
            x.incomplete ? h('span', { className: 'rt-tag rt-tag-warn' }, dt('drill.d352')) : h('span', { className: 'rt-tag rt-tag-live' }, dt('drill.d353'))),
          h('div', { style: { paddingTop: 6 } },
          x.how ? h('div', { className: 'rt-rep-trace-how' }, x.how) : null,
          (x.steps || []).length === 0
            ? h('div', { className: 'rt-rep-missing' },
                dt('drill.d354'))
            : (x.steps || []).map((s, si) => h('div', { key: 's' + s.id, className: 'rt-rep-step' },
                h('div', { className: 'rt-rep-step-head' },
                  h('span', { className: 'rt-rep-step-no' }, String(si + 1)),
                  h('span', { className: 'rt-rep-step-title' }, s.title || dt('drill.d355')),
                  s.agent ? h('span', { className: 'rt-tag' }, ROLE_LABEL[s.agent] || s.agent) : null,
                  s.stage_code ? h('span', { className: 'rt-tag' }, s.stage_code) : null,
                  s.inferred ? h('span', { className: 'rt-tag' }, dt('drill.d356')) : null,
                  h('div', { className: 'rt-spacer' }),
                  s.recorded_at ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, fmt(s.recorded_at)) : null),
                s.detail ? h('div', { className: 'rt-rep-step-detail' }, s.detail) : null,
                h('div', { className: 'rt-rep-step-cmd' },
                  h('b', null, dt('drill.d357')),
                  s.tool
                    ? h('span', { className: 'rt-mono' }, s.tool)
                    : h('span', { style: { color: 'var(--dsw-alias-state-warn-primary, #f59e0b)' } }, dt('drill.d358'))),
                s.tool ? h('div', { style: { marginTop: 3 } },
                  h('button', {
                    className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
                    onClick: () => copy(String(s.tool), dt('drill.d302') + (si + 1) + dt('drill.d359')),
                  }, dt('drill.d360'))) : null,
                s.result ? h('div', { className: 'rt-rep-step-result' }, h('b', null, dt('drill.d346')), String(s.result).replace(/\n+/g, ' ')) : null,
                s.evidence_ref ? h('div', { className: 'rt-rep-step-result' }, h('b', null, dt('drill.d24')), h('span', { className: 'rt-mono' }, s.evidence_ref)) : null)),
          /* 账号密码怎么来的：凭据的来源 + 取得方式 */
          (x.credentials || []).length
            ? h('div', { className: 'rt-rep-src' },
                h('div', { className: 'rt-rep-src-title' }, dt('drill.d361')),
                (x.credentials || []).map((c) => h('div', { key: 'c' + c.id, className: 'rt-kv' },
                  h('b', { className: 'rt-mono', style: { minWidth: 120 } }, c.host || '—'),
                  h('span', null, (c.username || dt('drill.d362')) + ' / ' + (c.secret_type || 'password')
                    + (c.privilege ? dt('drill.d363') + c.privilege : '')
                    + dt('drill.d364') + (c.source || dt('drill.d365'))
                    + (c.tool ? dt('drill.d366') + String(c.tool).replace(/\n+/g, ' ').slice(0, 160) : '')))))
            : null,
          /* 隧道怎么搭的 */
          (x.tunnels || []).length
            ? h('div', { className: 'rt-rep-src' },
                h('div', { className: 'rt-rep-src-title' }, dt('drill.d367')),
                (x.tunnels || []).map((t) => h('div', { key: 't' + t.id, className: 'rt-kv' },
                  h('b', { className: 'rt-mono', style: { minWidth: 120 } }, (t.kind || 'socks5') + ' ' + (t.listen || '')),
                  h('span', null, dt('drill.d368') + (t.entry || dt('drill.d369'))
                    + (t.reach ? dt('drill.d370') + t.reach : '')
                    + dt('drill.d371') + (t.entry_kind || dt('drill.d372'))
                    + (t.legit === false ? [dt('drill.k30034')] : '')
                    + (t.status ? ' · ' + t.status : '')
                    + (t.command ? dt('drill.d373') + String(t.command).replace(/\n+/g, ' ').slice(0, 160) : '')))))
            : null,
          (x.webshells || []).length
            ? h('div', { className: 'rt-rep-src' },
                h('div', { className: 'rt-rep-src-title' }, dt('drill.d374')),
                (x.webshells || []).map((w) => h('div', { key: 'w' + w.id, className: 'rt-kv' },
                  h('b', { className: 'rt-mono', style: { minWidth: 120 } }, w.shell_type || 'shell'),
                  h('span', null, (w.url || '') + (w.pass_key ? dt('drill.d375') + w.pass_key : '')
                    + (w.privilege ? dt('drill.d363') + w.privilege : '') + (w.status ? ' · ' + w.status : '')))))
            : null,
          (x.gaps || []).length ? h('div', { className: 'rt-rep-missing' }, dt('drill.d376') + x.gaps.join('；')) : null),
        (x.requests || []).length === 0
          ? h('div', { className: 'rt-rep-missing' }, dt('drill.d377'))
          : (x.requests || []).map((r, ri) => h('div', { key: 'q' + ri, className: 'rt-rep-req' },
              h('div', { className: 'rt-rep-req-head' },
                h('span', null, dt('drill.d378') + (ri + 1) + (r.source === 'auto' ? [dt('drill.k30035')] : '')),
                h('span', { className: 'rt-tag' }, (r.method || 'GET') + ' ' + (r.status === null || r.status === undefined ? '' : r.status)),
                h('div', { className: 'rt-spacer' }),
                h('button', {
                  className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
                  onClick: () => copy(String(r.request || ''), dt('drill.d379') + (ri + 1)),
                }, dt('drill.d380'))),
              h('pre', { className: 'rt-rep-http' }, r.request || ((r.method || 'GET') + ' ' + (r.url || '') + ' HTTP/1.1')),
              r.response ? h('div', null,
                h('div', { className: 'rt-rep-req-head' }, h('span', null, dt('drill.d381'))),
                h('pre', { className: 'rt-rep-http', style: { maxHeight: 160 } }, String(r.response).slice(0, 1600))) : null)),
        x.note ? h('div', { className: 'rt-rep-meta' }, h('b', null, dt('drill.d382')), h('span', null, x.note)) : null))

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, dt('drill.d383')),
          summary ? h('span', { className: 'rt-tag rt-tag-live' }, dt('drill.d321') + summary.points + dt('drill.d297')) : null,
          summary ? h('span', { className: 'rt-tag' }, summary.count + dt('drill.d384')) : null,
          summary ? h('span', { className: 'rt-tag' + (summary.missingRequests ? '' : ' rt-tag-live') },
            summary.withRequests + '/' + summary.count + dt('drill.d385')) : null,
          summary ? h('span', {
            className: 'rt-tag' + (summary.incomplete ? ' rt-tag-warn' : ' rt-tag-live'),
            title: dt('drill.d386'),
          }, dt('drill.d387') + (summary.count - (summary.incomplete || 0)) + '/' + summary.count) : null,
          summary && summary.serviceCappedExcluded
            ? h('span', {
                className: 'rt-tag rt-tag-warn',
                title: (summary.serviceCapped || []).map((x) => (x.service || '') + '｜' + (x.point_name || '')).join('\n')
                  || dt('drill.d388'),
              }, dt('drill.d389') + summary.serviceCappedExcluded)
            : null,
          h('div', { className: 'rt-spacer' }),
          /* 报告只有两个动作：复制 / 导出。报告不会自己变，「重新生成」价值最低（Lead 裁定砍掉）；
             空态里仍保留一个「先生成报告」的主操作，那是没有报告时唯一的出路。 */
          h('button', { className: 'rt-btn', disabled: busy || !mdText, onClick: () => copy(mdText, dt('drill.d390')) }, dt('drill.d391')),
          h('button', { className: 'rt-btn', disabled: busy || !mdText, onClick: () => download(mdText, (data && data.target) || eng) }, dt('drill.d392'))),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' }, err) : null,
        h('div', { className: 'rt-body', style: { overflow: 'auto' } },
          stages.length
            ? h('div', { className: 'rt-rep-list rt-prose' },
                h('div', { className: 'rt-rep-tools' },
                  h('button', { className: 'rt-btn', onClick: () => collapse.setAll(stages.map((s) => 'st:' + s.code), true) }, dt('drill.d282')),
                  h('button', { className: 'rt-btn', onClick: () => collapse.setAll(stages.map((s) => 'st:' + s.code), false) }, dt('drill.d394'))),
                stages.map((st) => {
                  const open = collapse.isOpen('st:' + st.code, true)
                  const toggle = collapse.toggle('st:' + st.code, true)
                  return h('div', { key: 'g' + st.code, className: 'rt-rep-group' },
                    h('div', {
                      className: 'rt-rep-stage', role: 'button', tabIndex: 0,
                      style: { borderLeftColor: st.color },
                      'aria-expanded': open ? 'true' : 'false',
                      onClick: toggle,
                      onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e) } },
                    },
                      h('span', { className: 'rt-sec-caret' }, open ? '▾' : '▸'),
                      h('span', { className: 'rt-rep-no', style: { background: st.color } }, CIRCLED[st.ordinal - 1] || st.ordinal),
                      h('span', { className: 'rt-rep-stage-name' }, st.name),
                      h('span', { className: 'rt-rep-stage-n' }, st.items.length + dt('drill.d395')),
                      h('div', { className: 'rt-spacer' }),
                      /* 阶段色可能是宿主数据里的 hex，也可能是上面的 token 兜底串——十六进制拼透明度（+'22'）
                         对后者无效，统一走 color-mix，两种输入都成立 */
                      h('span', { className: 'rt-rep-pts', style: { background: 'color-mix(in srgb, ' + st.color + ' 13%, transparent)', color: st.color, borderColor: 'color-mix(in srgb, ' + st.color + ' 40%, transparent)' } },
                        '+' + st.points + dt('drill.d297')),
                      h('span', { className: 'rt-ap-cum' }, dt('drill.d319') + st.cumulative + dt('drill.d297'))),
                    open ? h('div', { className: 'rt-rep-body' }, st.items.map(card)) : null)
                }))
            : (data === null ? h(EmptyState, { text: dt('drill.d136') })
                : h(EmptyState, {
                    text: dt('drill.d396'),
                    action: h('button', { className: 'rt-btn rt-btn-primary', disabled: busy, onClick: load }, dt('drill.d393')),
                  }))),
        h('div', { className: 'rt-foot' },
          h('span', null, dt('drill.d398'))))
    }

    /* ---------------------------------------------------------- 攻击文件 */
    const FILE_KIND = { poc: 'POC', exp: 'EXP', script: dt('drill.d399'), wordlist: dt('drill.d400'), other: dt('drill.d292') }

    function AttackFilesTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [folders, setFolders] = React.useState([])
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const collapse = useCollapse('files:' + eng)
      const [detail, setDetail] = React.useState(null)

      const load = () => {
        if (!eng) return
        setBusy(true)
        api({ op: 'attackFiles', engagement: eng }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d165')); return }
          setErr(null)
          setFolders(r.items || [])
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      const openFile = (f) => {
        if (detail && detail.id === f.id) { setDetail(null); return }
        setDetail(null)
        api({ op: 'readAttackFile', engagement: eng, id: f.id }).then((r) => {
          if (r && r.ok) setDetail(r)
          else setErr((r && r.error) || dt('drill.d165'))
        }, (e) => setErr(String((e && e.message) || e)))
      }

      const rows = []
      for (const folder of folders) {
        const fKey = 'folder:' + folder.folder
        const fileNodes = []
        for (const f of folder.files) {
          fileNodes.push(h('div', {
            key: 'a' + f.id, className: 'rt-vrow', style: { gridTemplateColumns: '18px 1.2fr 60px 1.6fr', cursor: 'pointer' },
            role: 'button', tabIndex: 0,
            onClick: () => openFile(f),
            onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFile(f) } },
          },
            h('span', { className: 'rt-sec-caret' }, detail && detail.id === f.id ? '▾' : '▸'),
            h('span', { className: 'rt-mono' }, f.name),
            h('span', null, h('span', { className: 'rt-tag rt-tag-active' }, FILE_KIND[f.kind] || f.kind || '—')),
            h('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' }, title: f.description || '' }, f.description || '—')))
          if (!detail || detail.id !== f.id) continue
          fileNodes.push(h('div', {
            key: 'ad' + f.id, className: 'rt-vrow', style: { cursor: 'default', gridTemplateColumns: '1fr' },
          }, h('div', { className: 'rt-vdetail' },
            h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d401')), h('span', null, detail.evidence || '—')),
            h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d402')), h('span', { className: 'rt-mono', style: { wordBreak: 'break-all' } }, detail.path)),
            h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d298')), h('span', null, fmt(detail.created_at) + (detail.created_by ? ' · ' + detail.created_by : ''))),
            h('pre', { className: 'rt-md', style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, maxHeight: '40vh', padding: '10px 12px' } }, detail.content || dt('drill.d175')))))
        }
        rows.push(h(Section, {
          key: 'sec:' + folder.folder, tone: 'folder', title: folder.folder + '/',
          count: folder.count + dt('drill.d403'),
          open: collapse.isOpen(fKey, true), onToggle: collapse.toggle(fKey, true),
        }, fileNodes.length ? fileNodes : h('div', { className: 'rt-atest-meta' }, dt('drill.d175'))))
      }

      const total = folders.reduce((n, f) => n + f.count, 0)
      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, dt('drill.d258')),
          h('span', { className: 'rt-tag' }, folders.length + dt('drill.d404') + total + dt('drill.d403')),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? [dt('drill.k30020')] : dt('drill.d82'))),
        err ? h('div', { className: 'rt-err' }, err) : null,
        h('div', { className: 'rt-table' },
          rows,
          !folders.length ? h('div', { className: 'rt-empty' }, dt('drill.d405')) : null),
        h('div', { className: 'rt-foot' }, h('span', null, dt('drill.d406'))))
    }

    /* ---------------------------------------------------------- 知识库（POC/EXP，全局共享） */
    /**
     * 知识库页：打 Nday/1day 之前先在这里搜。检索框支持 CVE / 组件 / 关键字 / 正文关键词；
     * 命中就展开拿全文（可直接复制去用），没有就说明要去互联网找或自己搓，验证后回填。
     * 这里是**全局**的：不随靶标切换，一个靶标沉淀的通用 POC 后面所有靶标都能用。
     */
    const POC_KIND_LABEL = { poc: 'POC', exp: 'EXP', script: dt('drill.d399'), template: dt('drill.d407'), payload: dt('drill.d408') }
    const POC_SOURCE_LABEL = { web: dt('drill.d409'), self: dt('drill.d410'), manual: dt('drill.d411'), 'nuclei-template': dt('drill.d412'), kb: dt('drill.d413') }

    function KnowledgeTab(props) {
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [q, setQ] = React.useState('')
      const [kind, setKind] = React.useState('')
      const [category, setCategory] = React.useState('')
      const [engagement, setEngagement] = React.useState('')
      const [assetTarget, setAssetTarget] = React.useState('')
      const [grouped, setGrouped] = React.useState(true)
      const [verifiedOnly, setVerifiedOnly] = React.useState(false)
      const [openId, setOpenId] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [detailBusy, setDetailBusy] = React.useState(false)
      const [tplOffset, setTplOffset] = React.useState(0)
      const tplPageSize = 40

      const query = (over) => {
        const extra = over || {}
        const offset = Object.prototype.hasOwnProperty.call(extra, 'templateOffset') ? extra.templateOffset : 0
        setTplOffset(offset)
        const params = Object.assign({
          q: q.trim() || undefined,
          kind: kind || undefined,
          category: category || undefined,
          engagement: engagement || undefined,
          asset_target: assetTarget.trim() || undefined,
          verified: verifiedOnly || undefined,
          templateOffset: offset || 0,
          templateLimit: tplPageSize,
        }, extra)
        setBusy(true); setMsg(null)
        api(Object.assign({ op: 'pocSearch' }, params)).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d165')); return }
          setErr(null); setData(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      /* 首次进入与刷新键变化时拉全量（检索是显式动作，避免边打字边打接口） */
      React.useEffect(() => { query({ q: undefined, kind: undefined, category: undefined, engagement: undefined, asset_target: undefined, verified: undefined }) }, [refreshKey])

      const open = (id) => {
        if (openId === id) { setOpenId(null); setDetail(null); return }
        setOpenId(id); setDetail(null); setDetailBusy(true)
        api({ op: 'pocGet', id: id }).then((r) => {
          setDetailBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d165') }); return }
          setDetail(r)
        }, (e) => { setDetailBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      /* 同报告页：await 真实结果再提示 */
      const copy = (text, label) => copyWithFeedback(text, label, (okFlag, message) => {
        setMsg(okFlag ? { ok: message } : { err: message })
      })
      const useIt = (row) => {
        api({ op: 'pocUse', id: row.id, used_on: dt('drill.d414') }).then(() => {
          setMsg({ ok: dt('drill.d415') + row.title })
          query()
        }, (e) => setMsg({ err: String((e && e.message) || e) }))
      }

      const stats = (data && data.stats) || { total: 0, verified: 0, reused: 0, byKind: [], bySource: [] }
      const items = (data && data.items) || []
      const tpl = (data && data.templates) || { dir: null, total: 0, matched: 0, offset: 0, items: [], byCategory: [] }
      const tplByCat = new Map((tpl.byCategory || []).map((c) => [c.code, c.n || 0]))
      const catShown = (c) => (c.n || 0) + (tplByCat.get(c.code) || 0)
      const tplItems = tpl.items || []
      const tplMatched = tpl.matched != null ? tpl.matched : tpl.total
      const tplStart = Number(tpl.offset) || 0
      const turnTpl = (next) => {
        const offset = Math.max(0, next)
        setTplOffset(offset)
        query({ templateOffset: offset })
      }

      const card = (x) => {
        const isOpen = openId === x.id
        const d = isOpen && detail && detail.id === x.id ? detail : null
        return h('div', { key: 'p' + x.id, className: 'rt-kb' + (isOpen ? ' open' : '') },
          h('div', {
            className: 'rt-kb-head', role: 'button', tabIndex: 0, 'aria-expanded': isOpen ? 'true' : 'false',
            onClick: () => open(x.id),
            onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(x.id) } },
          },
            h('span', { className: 'rt-sec-caret' }, isOpen ? '▾' : '▸'),
            h('span', { className: 'rt-kb-kind k-' + (x.kind || 'poc') }, POC_KIND_LABEL[x.kind] || x.kind || 'POC'),
            h('span', { className: 'rt-kb-title' }, x.title),
            x.cve ? h('span', { className: 'rt-tag rt-tag-passive' }, x.cve) : null,
            x.component ? h('span', { className: 'rt-tag' }, x.component) : null,
            x.verified === 1
              ? h('span', { className: 'rt-tag rt-tag-live' }, dt('drill.d416'))
              : h('span', { className: 'rt-tag rt-tag-warn' }, dt('drill.d417')),
            h('div', { className: 'rt-spacer' }),
            h('span', { className: 'rt-tag' }, POC_SOURCE_LABEL[x.source] || x.source || '—'),
            x.hit_count ? h('span', { className: 'rt-tag' }, dt('drill.d418') + x.hit_count) : null),
          /* 来源行：归类 · 影响版本 · 建立时间 · 来源靶标 · 发现资产 —— 一条知识"什么时候、
             在哪个单位的哪台资产上发现的"一眼可见 */
          h('div', { className: 'rt-kb-sub' },
            [x.category ? dt('drill.d419') + (POC_CAT_NAME[x.category] || x.category) : null,
              x.versions ? dt('drill.d420') + x.versions : null,
              x.language || null,
              x.tags || null,
              dt('drill.d421') + fmt(x.created_at),
              (x.engagement_name || x.engagement_id) ? dt('drill.d422') + (x.engagement_name || x.engagement_id) : null,
              x.asset_target ? dt('drill.d423') + x.asset_target : null,
              x.found_by_agent ? dt('drill.d424') + (ROLE_LABEL[x.found_by_agent] || x.found_by_agent) : null,
              x.source_url ? dt('drill.d192') + x.source_url : null].filter(Boolean).join(' · ')),
          isOpen
            ? h('div', { className: 'rt-kb-body' },
                detailBusy && !d ? h('div', { className: 'rt-empty' }, dt('drill.d425')) : null,
                d ? h('div', null,
                  d.usage ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d426')), h('span', { className: 'rt-mono' }, d.usage)) : null,
                  d.description ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d427')), h('span', null, d.description)) : null,
                  d.verified_note ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d428')), h('span', null, d.verified_note)) : null,
                  d.used_on ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d429')), h('span', null, d.used_on)) : null,
                  d.path ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d430')), h('span', { className: 'rt-mono' }, d.path)) : null,
                  h('div', { className: 'rt-kb-actions' },
                    h('button', { className: 'rt-btn', disabled: !d.content, onClick: () => copy(d.content || '', dt('drill.d431')) }, dt('drill.d432')),
                    h('button', { className: 'rt-btn', onClick: () => useIt(x) }, dt('drill.d433')),
                    d.source_url ? h('button', { className: 'rt-btn', onClick: () => copy(d.source_url, dt('drill.d434')) }, dt('drill.d435')) : null),
                  d.content
                    ? h('pre', { className: 'rt-rep-http' }, d.content.length > 12000 ? d.content.slice(0, 12000) + [dt('drill.k30037')] : d.content)
                    : h('div', { className: 'rt-empty' }, dt('drill.d436')))
                : null)
            : null)
      }

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', null, dt('drill.d437')),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn' + (grouped ? ' rt-btn-primary' : ''), title: dt('drill.d443'), onClick: () => setGrouped(!grouped) }, grouped ? [dt('drill.k30038')] : dt('drill.d444')),
          h('button', { className: 'rt-btn', disabled: busy, onClick: () => query() }, busy ? [dt('drill.k30039')] : dt('drill.d82'))),
        /* 计数行：数字大、标签小（原来是一排 tag，读不出「哪个数是主指标」） */
        h('div', { style: { padding: '0 0 5px' } },
          h(StatRow, {
            groups: [{
              key: 'kb',
              items: [
                { key: 'total', label: dt('drill.d313').trim(), value: stats.total },
                { key: 'verified', label: dt('drill.d438').trim(), value: stats.verified },
                { key: 'reused', label: dt('drill.d439').trim(), value: stats.reused || 0 },
                { key: 'templates', label: dt('drill.d442').trim(), value: tpl.total || 0 },
              ],
            }],
          })),
        /* 归类总览：点一下就是按该类筛选，一眼看清"哪类武器攒了多少、哪类还是空的" */
        h('div', { className: 'rt-kb-cats' },
          (stats.byCategory || []).filter((c) => catShown(c) > 0 || POC_CAT_ORDER.includes(c.code)).map((c) => h('span', {
            key: c.code,
            className: 'rt-concl-i' + (category === c.code ? ' on' : ''),
            title: (c.hint || POC_CAT_NAME[c.code] || c.code)
              + dt('drill.d445') + (tplByCat.get(c.code) || 0)
              + dt('drill.d446') + (c.n || 0)
              + (c.verified ? dt('drill.d447') + c.verified + '）' : ''),
            onClick: () => {
              const next = category === c.code ? '' : c.code
              setCategory(next)
              query({ category: next || undefined })
            },
          },
            h('b', null, String(catShown(c))),
            h('span', null, (POC_CAT_NAME[c.code] || c.code) + (c.verified ? dt('drill.d447') + c.verified + '）' : ''))))),
        h('div', { className: 'rt-kb-filter' },
          h('input', {
            className: 'rt-input', style: { flex: 1, minWidth: 140 }, placeholder: dt('drill.d448'),
            value: q, onChange: (e) => setQ(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') query() },
          }),
          h('select', { className: 'rt-input', style: { maxWidth: 120 }, value: category, onChange: (e) => { setCategory(e.target.value); query({ category: e.target.value || undefined }) } },
            h('option', { value: '' }, dt('drill.d449')),
            POC_CAT_ORDER.map((k) => h('option', { key: k, value: k }, POC_CAT_NAME[k]))),
          h('select', { className: 'rt-input', style: { maxWidth: 120 }, value: engagement, onChange: (e) => { setEngagement(e.target.value); query({ engagement: e.target.value || undefined }) } },
            h('option', { value: '' }, dt('drill.d450')),
            (stats.byEngagement || []).map((e) => h('option', { key: e.engagement, value: e.engagement }, e.engagement + '（' + e.n + '）'))),
          h('input', {
            className: 'rt-input', style: { width: 120 }, placeholder: dt('drill.d451'),
            value: assetTarget, onChange: (e) => setAssetTarget(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') query() },
          }),
          h('select', { className: 'rt-input', style: { maxWidth: 110 }, value: kind, onChange: (e) => { setKind(e.target.value); query({ kind: e.target.value || undefined }) } },
            h('option', { value: '' }, dt('drill.d452')),
            Object.keys(POC_KIND_LABEL).map((k) => h('option', { key: k, value: k }, POC_KIND_LABEL[k]))),
          h('label', { className: 'rt-kb-check' },
            h('input', { type: 'checkbox', checked: verifiedOnly, onChange: (e) => { setVerifiedOnly(e.target.checked); query({ verified: e.target.checked || undefined }) } }),
            dt('drill.d453')),
          h('button', { className: 'rt-btn rt-btn-primary', onClick: () => query() }, dt('drill.d454'))),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' },
          /engagement required|unknown op/i.test(err)
            /* 老 host 还没有知识库接口：讲清怎么恢复，别让人对着 "engagement required" 发懵 */
            ? dt('drill.d455')
            : err) : null,
        !err && data && data.dbPath
          ? h('div', { className: 'rt-foot', style: { marginBottom: 6, fontSize: 11 } },
              dt('drill.d456') + data.dbPath
              + (data.root ? dt('drill.d457') + data.root + '）' : ''))
          : null,
        h('div', { className: 'rt-table' },
          (() => {
            if (!grouped) return items.map(card)
            /* 分组渲染：按内置归类顺序，未知归类挂到末尾的「其它」 */
            const buckets = new Map()
            for (const x of items) {
              const code = POC_CAT_NAME[x.category] ? x.category : 'other'
              if (!buckets.has(code)) buckets.set(code, [])
              buckets.get(code).push(x)
            }
            const order = POC_CAT_ORDER.filter((c) => buckets.has(c))
            for (const code of buckets.keys()) if (!order.includes(code)) order.push(code)
            const out = []
            for (const code of order) {
              const list = buckets.get(code)
              out.push(h('div', { key: 'g' + code, className: 'rt-kb-cat' },
                h('span', { className: 'rt-kb-cat-name' }, POC_CAT_NAME[code] || code),
                h('span', { className: 'rt-tag' }, list.length + dt('drill.d313')),
                h('span', { className: 'rt-tag rt-tag-live' }, dt('drill.d438') + list.filter((x) => x.verified === 1).length),
                h('span', { className: 'rt-spacer' }),
                h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                  dt('drill.d458') + fmt(list.map((x) => x.created_at).filter(Boolean).sort().pop()))))
              for (const x of list) out.push(card(x))
            }
            return out
          })(),
          tplItems.length
            ? h('div', { className: 'rt-kb-tpl' },
                h('div', { className: 'rt-ap-sub' },
                  dt('drill.d459') + (tplStart + 1) + '–' + (tplStart + tplItems.length) + ' / ' + tplMatched
                  + dt('drill.d460')),
                tplItems.map((t, i) => h('div', { key: 't' + tplStart + '-' + i, className: 'rt-kb-tpl-row' },
                  h('span', { className: 'rt-tag' }, t.severity || '—'),
                  t.category ? h('span', { className: 'rt-tag' }, POC_CAT_NAME[t.category] || t.category) : null,
                  h('span', { className: 'rt-mono rt-kb-tpl-path', title: t.path }, t.path),
                  h('span', { className: 'rt-kb-tpl-name', title: t.name }, t.name || ''),
                  h('button', {
                    className: 'rt-btn', style: { padding: '0 6px', fontSize: 10.5 },
                    onClick: () => copy('nuclei -t ' + t.path + dt('drill.d461'), dt('drill.d462')),
                  }, dt('drill.d360')))),
                h('div', { className: 'rt-kb-actions' },
                  h('button', {
                    className: 'rt-btn', disabled: busy || tplStart <= 0,
                    onClick: () => turnTpl(tplStart - tplPageSize),
                  }, dt('drill.d463')),
                  h('button', {
                    className: 'rt-btn', disabled: busy || tplStart + tplItems.length >= tplMatched,
                    onClick: () => turnTpl(tplStart + tplPageSize),
                  }, dt('drill.d464'))),
                tpl.dir ? h('div', { className: 'rt-foot' }, h('span', null, dt('drill.d465') + tpl.dir)) : null)
            : null,
          data === null ? h('div', { className: 'rt-empty' }, dt('drill.d136')) : null,
          data !== null && !items.length && !tplItems.length
            ? h(EmptyState, {
                text: q || kind || verifiedOnly
                  ? dt('drill.d466')
                  : (tpl.total
                    ? (dt('drill.d467') + tpl.total + dt('drill.d468'))
                    : (tpl.dir ? dt('drill.d469') : dt('drill.d470'))),
                path: data.dbPath || tpl.dir || null,
                action: h('button', { className: 'rt-btn', onClick: () => openDir('knowledge') }, dt('drill.t40open')),
              })
            : null),
        h('div', { className: 'rt-foot' },
          h('span', null, dt('drill.d473'))))
    }

    /* ---------------------------------------------------------- 环境适配（Windows / 非 Kali） */
    /**
     * 借鉴 Z3r0 的「系统配置」思路：路径与密钥进集中配置，不靠 bash/ps1。
     * 落盘 $DSH_HOME/redteam/config.json —— 用户填工具绝对路径或整包搜索目录。
     */
    function EnvTab(props) {
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [folderPath, setFolderPath] = React.useState('')

      const applyDraftFrom = (r) => {
        const c = (r && r.config) || {}
        setDraft({
          platform: c.platform || 'auto',
          toolkitDir: c.toolkitDir || '',
          nucleiTemplatesDir: c.nucleiTemplatesDir || '',
          binDirsText: (c.binDirs || []).join('\n'),
          tools: Object.assign({}, c.tools || {}),
          env: Object.assign({ FOFA_KEY: '', REDTEAM_VPS_HOST: '', REDTEAM_VPS_KEY: '' }, c.env || {}),
          notes: c.notes || '',
        })
        if (c.toolkitDir) setFolderPath(c.toolkitDir)
      }

      const load = () => {
        setBusy(true); setMsg(null)
        api({ op: 'platformConfigGet' }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d165')); return }
          setErr(null); setData(r)
          applyDraftFrom(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [refreshKey])

      const save = () => {
        if (!draft) return
        setBusy(true); setMsg(null)
        const config = {
          platform: draft.platform,
          toolkitDir: draft.toolkitDir,
          nucleiTemplatesDir: draft.nucleiTemplatesDir,
          binDirs: String(draft.binDirsText || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
          tools: draft.tools,
          env: draft.env,
          notes: draft.notes,
          envAdaptConfigured: true,
          envAdaptSkip: false,
        }
        api({ op: 'platformConfigSave', config }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d168') }); return }
          setData(r)
          setMsg({ ok: dt('drill.d474') + ((r.config && r.config.path) || '$DSH_HOME/redteam/config.json') })
          applyDraftFrom(r)
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const assignFolder = () => {
        const dir = String(folderPath || (draft && draft.toolkitDir) || '').trim()
        if (!dir) { setMsg({ err: dt('drill.d475') }); return }
        setBusy(true); setMsg(null)
        api({ op: 'platformAssignToolkit', dir }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d476') }); return }
          setData(r)
          applyDraftFrom(r)
          setMsg({
            ok: dt('drill.d477') + (r.assignedCount || 0) + dt('drill.d478')
              + (r.nucleiTemplatesDir ? [dt('drill.k30040')] : ''),
          })
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const setTool = (id, value) => setDraft((d) => d ? Object.assign({}, d, { tools: Object.assign({}, d.tools, { [id]: value }) }) : d)
      const setEnv = (key, value) => setDraft((d) => d ? Object.assign({}, d, { env: Object.assign({}, d.env, { [key]: value }) }) : d)

      const runtime = (data && data.runtime) || {}
      const adapt = (data && data.adapt) || {}
      const tools = (data && data.tools && data.tools.items) || []
      const found = tools.filter((t) => t.path).length
      const defaultToolkit = (data && data.toolkitDir) || '$DSH_HOME/redteam/toolkit'
      const defaultNuclei = (data && data.nucleiTemplatesDir) || (defaultToolkit + '/nuclei-templates')

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', null, dt('drill.d479')),
          h('span', { className: 'rt-badge rt-badge--idle' }, runtime.effective === 'windows' ? 'Windows' : 'Linux/Kali'),
          adapt.kali ? h('span', { className: 'rt-badge rt-badge--ok' }, 'Kali') : null,
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? [dt('drill.k30041')] : dt('drill.d82')),
          h('button', { className: 'rt-btn rt-btn-primary', disabled: busy || !draft, onClick: save }, dt('drill.d182'))),
        h('div', { className: 'rt-pane', style: { minHeight: 0 } },
        err ? h('div', { className: 'rt-err' }, err) : null,
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        /* 就绪度：三个数字（工具 / 环境 / 占位），不再是三个彩色 tag */
        h(StatRow, {
          groups: [{
            key: 'env',
            items: [
              { key: 'ready', label: dt('drill.d480').trim(), value: adapt.ready ? dt('drill.k30017') : dt('drill.d481') },
              { key: 'tools', label: dt('drill.d273').trim(), value: found + '/' + tools.length },
              { key: 'kali', label: 'Kali', value: adapt.kali ? dt('drill.k30017') : '—' },
            ],
          }],
        }),
        /* 三条状态各一行：状态点 + 名称 + 一句现状 + 右侧动作 */
        h('div', { className: 'rt-status' },
          h(StatusLine, {
            tone: found && found === tools.length ? 'ok' : 'warn',
            name: dt('drill.d273').trim(),
            detail: found + ' / ' + tools.length,
            action: h('button', { className: 'rt-btn', disabled: busy, onClick: load }, dt('drill.d82')),
          }),
          h(StatusLine, {
            tone: adapt.ready ? 'ok' : 'idle',
            name: dt('drill.d480').trim(),
            detail: adapt.reason || (adapt.ready ? dt('drill.k30017') : dt('drill.d481')),
          }),
          h(StatusLine, {
            tone: adapt.configured ? 'ok' : 'idle',
            name: dt('drill.d483'),
            detail: adapt.message || dt('drill.d482'),
          })),
        /* 未就绪只给一个主操作：保存并重新检测（四个并列按钮会把「该点哪个」推给人） */
        adapt.ready ? null : h('div', { className: 'rt-actions', style: { marginTop: 8 } },
          h('button', { className: 'rt-btn rt-btn-primary', disabled: busy || !draft, onClick: save }, dt('drill.d182'))),
        h('div', { className: 'rt-card', style: { margin: '0 0 8px', fontSize: 12, lineHeight: 1.6 } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, dt('drill.d483')),
          h('div', { style: { marginBottom: 8, opacity: 0.9 } },
            dt('drill.d484')),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('input', {
              className: 'rt-input', style: { flex: 1 },
              placeholder: dt('drill.d485'),
              value: folderPath,
              onChange: (e) => setFolderPath(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') assignFolder() },
            }),
            h('button', {
              className: 'rt-btn rt-btn-primary', disabled: busy,
              onClick: assignFolder,
            }, busy ? [dt('drill.k30042')] : dt('drill.d486')))),
        data && data.hint ? h('div', { className: 'rt-card', style: { margin: '0 0 8px', fontSize: 12, lineHeight: 1.6 } }, data.hint) : null,
        data && data.egress ? h('div', { className: 'rt-card', style: { margin: '0 0 8px', fontSize: 12, lineHeight: 1.55 } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, dt('drill.d487')),
          h('div', { className: 'rt-mono', style: { fontSize: 11 } }, 'HTTP_PROXY=' + (data.egress.http_proxy || dt('drill.d488'))),
          h('div', { className: 'rt-mono', style: { fontSize: 11 } }, 'HTTPS_PROXY=' + (data.egress.https_proxy || dt('drill.d488'))),
          h('div', { className: 'rt-mono', style: { fontSize: 11 } }, 'ALL_PROXY=' + (data.egress.all_proxy || dt('drill.d488'))),
          h('div', { className: 'rt-mono', style: { fontSize: 11 } }, 'NO_PROXY=' + (data.egress.no_proxy || dt('drill.d488'))),
          h('div', { style: { marginTop: 6, opacity: 0.85 } }, data.egress.note || '')) : null,
        !draft ? h('div', { className: 'rt-empty' }, dt('drill.d136')) : h('div', null,
          h('div', { className: 'rt-card' },
            h('h4', null, dt('drill.d489')),
            h('div', { style: { display: 'grid', gap: 8 } },
              h('label', { style: { fontSize: 12 } }, dt('drill.d490'),
                h('select', {
                  className: 'rt-input', style: { display: 'block', width: '100%', marginTop: 4 },
                  value: draft.platform,
                  onChange: (e) => setDraft(Object.assign({}, draft, { platform: e.target.value })),
                },
                  h('option', { value: 'auto' }, dt('drill.d491')),
                  h('option', { value: 'windows' }, 'windows'),
                  h('option', { value: 'linux' }, 'linux'))),
              h('label', { style: { fontSize: 12 } }, dt('drill.d492'),
                h('input', {
                  className: 'rt-input', style: { display: 'block', width: '100%', marginTop: 4 },
                  placeholder: dt('drill.d493') + defaultToolkit,
                  value: draft.toolkitDir,
                  onChange: (e) => setDraft(Object.assign({}, draft, { toolkitDir: e.target.value })),
                })),
              h('label', { style: { fontSize: 12 } }, dt('drill.d494'),
                h('input', {
                  className: 'rt-input', style: { display: 'block', width: '100%', marginTop: 4 },
                  placeholder: dt('drill.d493') + defaultNuclei,
                  value: draft.nucleiTemplatesDir,
                  onChange: (e) => setDraft(Object.assign({}, draft, { nucleiTemplatesDir: e.target.value })),
                })),
              h('label', { style: { fontSize: 12 } }, dt('drill.d495'),
                h('textarea', {
                  className: 'rt-input', rows: 4, style: { display: 'block', width: '100%', marginTop: 4, fontFamily: 'var(--dsw-font-mono, monospace)' },
                  placeholder: dt('drill.d496') + String.fromCharCode(10) + 'D:\\tools' + String.fromCharCode(10) + 'D:\\pentest-bin',
                  value: draft.binDirsText,
                  onChange: (e) => setDraft(Object.assign({}, draft, { binDirsText: e.target.value })),
                })))),
          h('div', { className: 'rt-card' },
            h('h4', null, dt('drill.d497')),
            h('div', { style: { display: 'grid', gap: 8 } },
              ['FOFA_KEY', 'REDTEAM_VPS_HOST', 'REDTEAM_VPS_KEY'].map((k) => h('label', { key: k, style: { fontSize: 12 } }, k + dt('drill.d498'),
                h('input', {
                  className: 'rt-input', style: { display: 'block', width: '100%', marginTop: 4 },
                  type: k === 'FOFA_KEY' ? 'password' : 'text',
                  placeholder: k === 'REDTEAM_VPS_KEY' ? [dt('drill.k30043')] : (k === 'REDTEAM_VPS_HOST' ? [dt('drill.k30044')] : dt('drill.d499')),
                  value: (draft.env && draft.env[k]) || '',
                  onChange: (e) => setEnv(k, e.target.value),
                }))))),
          h('div', { className: 'rt-card' },
            h('h4', null, dt('drill.d500')),
            h('div', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
              dt('drill.d501')),
            tools.map((t) => h('div', { key: t.id, style: { marginBottom: 8 } },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
                h('span', { style: { fontWeight: 600, minWidth: 88 } }, t.label || t.id),
                t.path
                  ? h('span', { className: 'rt-tag rt-tag-live', title: t.path }, t.source + dt('drill.d502'))
                  : h('span', { className: 'rt-tag rt-tag-warn' }, dt('drill.d503'))),
              h('input', {
                className: 'rt-input', style: { width: '100%' },
                placeholder: dt('drill.d504') + (t.names || []).slice(0, 3).join(' / '),
                value: (draft.tools && draft.tools[t.id]) || '',
                onChange: (e) => setTool(t.id, e.target.value),
              }),
              t.path ? h('div', { className: 'rt-mono', style: { fontSize: 10.5, marginTop: 2, opacity: 0.8 } }, t.path) : null))),
          h('div', { className: 'rt-card' },
            h('h4', null, dt('drill.d505')),
            h('textarea', {
              className: 'rt-input', rows: 3, style: { width: '100%' },
              placeholder: dt('drill.d506'),
              value: draft.notes,
              onChange: (e) => setDraft(Object.assign({}, draft, { notes: e.target.value })),
            })),
          h('div', { className: 'rt-foot' },
            h('span', null,
              dt('drill.d507') + ((data && data.config && data.config.path) || '$DSH_HOME/redteam/config.json')
              + dt('drill.d508'))))))
    }

    /* ---------------------------------------------------------- 得分目标 */
    function ScoreTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [openId, setOpenId] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [msg, setMsg] = React.useState(null)

      const load = () => {
        if (!eng) return
        setBusy(true)
        api({ op: 'scores', engagement: eng }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d165')); return }
          setErr(null)
          setData(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      /* builtin 要一路带到表单：内置得分点的分值/名称/口径由《得分规则》锁定，
         界面必须把输入框置灰并说明原因 —— 以前是「能改、提示已保存、刷新后变回去」，
         用户以为是 bug。 */
      const startEdit = (p) => setForm({
        id: p.id, name: p.name, category: p.category || '', points: p.points,
        description: p.description || '', enabled: p.enabled, builtin: p.builtin === true,
        src: p.src, cap: p.cap, rule: p.rule,
      })
      const startNew = () => { setForm({ name: '', category: '', points: 10, description: '', enabled: true, builtin: false }); setMsg(null) }
      const setField = (k, v) => setForm((f) => Object.assign({}, f, { [k]: v }))

      const save = () => {
        if (!form || !form.name) { setMsg({ err: dt('drill.d509') }); return }
        setBusy(true)
        setMsg(null)
        api({ op: 'saveScorePoint', engagement: eng, point: form }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d168') }); return }
          /* overridden === false 表示后端**没有采纳**提交的分值（内置点由规则锁定）。
             这时不能笼统说「已保存」 —— 那句话会让用户以为分值改成功了。 */
          if (r.overridden === false) {
            setMsg({ err: dt('drill.d510')
              + dt('drill.d511')
              + dt('drill.d512') })
          } else {
            setMsg({ ok: r.note || dt('drill.d169') })
          }
          setForm(null)
          load()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }
      const remove = () => {
        if (!form || !form.id) { setForm(null); return }
        setBusy(true)
        setMsg(null)
        api({ op: 'deleteScorePoint', engagement: eng, id: form.id }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d513') }); return }
          setMsg({ ok: dt('drill.d514') })
          setForm(null)
          setOpenId(null)
          load()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const summary = (data && data.summary) || { achievedPoints: 0, pointCount: 0, hitPointCount: 0, hitCount: 0, selfCreatedHits: 0, serviceCappedHits: 0 }
      const items = (data && data.items) || []

      /* 按合并版的 8 个类别分组渲染（后端 ruleGroups 已排好序、组内按分值升序）。
         兼容：后端没给 ruleGroups（老 host）时退回平铺。 */
      const groups = (data && data.ruleGroups && data.ruleGroups.length)
        ? data.ruleGroups
        : [{ key: 'all', name: '', capSum: 0, points: 0, counted: 0, tiers: items }]
      const rows = []
      for (const g of groups) {
        if (g.name) {
          rows.push(h('div', { key: 'g-' + g.key, className: 'rt-score-group' },
            h('span', null, g.name),
            h('span', { className: 'rt-sg-sub' },
              g.tiers.length + dt('drill.d395')
              + (g.capSum > 0 ? dt('drill.d515') + g.capSum + [dt('drill.k30045')] : '')),
            h('div', { className: 'rt-spacer' }),
            g.points > 0
              ? h('span', { className: 'rt-tag rt-tag-active' }, '+' + g.points + dt('drill.d297'))
              : null))
        }
        for (const p of g.tiers) {
        const achieved = p.hits.length > 0
        const open = openId === p.id
        rows.push(h('div', {
          key: 'sp' + p.id, className: 'rt-score-row', role: 'button', tabIndex: 0,
          onClick: () => setOpenId(open ? null : p.id),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(open ? null : p.id) } },
        },
          h('span', { className: 'rt-sec-caret' }, open ? '▾' : '▸'),
          h('span', null, h('span', {
            className: achieved ? 'rt-pri rt-pri-high' : 'rt-pri rt-pri-low',
            style: achieved ? {} : { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' },
          }, p.points + dt('drill.d516'))),
          h('span', { title: p.description || '' },
            p.name,
            p.tier ? h('span', { className: 'rt-scope' }, '　' + p.tier) : null),
          /* 命中与上限：这一条计入几次、上限用了多少（G3 各项上限独立，到顶就不再累计） */
          h('span', { title: p.capped > 0
            ? dt('drill.d517') + p.counted + dt('drill.d518') + p.capped + dt('drill.d519') + (p.scope_label || dt('drill.d520')) + dt('drill.d521')
            : (p.scope_label || '') },
            h('span', { className: 'rt-sec-count' }, p.hits.length > 0 ? p.counted + [dt('drill.k30046')] : dt('drill.d522')),
            p.cap > 0
              ? h('span', { className: 'rt-scope' }, dt('drill.d523') + (p.cap_used === null ? 0 : p.cap_used) + '/' + p.cap)
              : null),
          h('span', { style: { textAlign: 'right' } }, p.earned > 0
            ? h('span', { className: 'rt-tag rt-tag-active' }, '+' + p.earned + dt('drill.d297'))
            : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '—'))))
        if (!open) continue
        /* 命中记录：一行一条 —— 第一行给"序号 + 资产 + 时间 + 复制"，内容另起一行自适应换行 */
        const hitNodes = p.hits.map((hh, hi) => h('div', {
          key: 'h' + hh.id,
          className: 'rt-hit-row' + (hh.self_created ? ' self-created' : '') + (hh.capped ? ' service-capped' : ''),
        },
          h('span', { className: 'rt-hit-idx' }, String(hi + 1)),
          h('span', { className: 'rt-hit-asset', title: hh.target || hh.asset_ip || '' },
            hh.asset_ip || hh.target || dt('drill.d524')),
          hh.self_created ? h('span', { className: 'rt-tag rt-tag-warn', title: dt('drill.d525') }, dt('drill.d526')) : null,
          hh.capped ? h('span', {
            className: 'rt-tag rt-tag-warn',
            title: hh.capped_reason || dt('drill.d527'),
          }, dt('drill.d301') + (hh.service ? '（' + hh.service + '）' : '')) : null,
          hh.shot_count ? h('span', { className: 'rt-tag', title: dt('drill.d528') },
            dt('drill.d529') + hh.shot_count) : null,
          h('span', { className: 'rt-hit-time' }, fmt(hh.recorded_at)),
          h('button', {
            className: 'rt-btn', style: { padding: '0 5px', fontSize: 10.5 },
            title: dt('drill.d530'),
            onClick: (e) => {
              e.stopPropagation()
              copyText((hh.asset_ip || hh.target || '') + '  ' + (hh.evidence || ''))
            },
          }, dt('drill.d241')),
          hh.evidence
            ? h('span', { className: 'rt-hit-txt', title: hh.evidence }, String(hh.evidence).replace(/\n+/g, ' '))
            : h('span', { className: 'rt-hit-txt none' }, dt('drill.d531'))))
        rows.push(h('div', {
          key: 'spd' + p.id, className: 'rt-score-row',
          style: { cursor: 'default', gridTemplateColumns: tableColumns([{ key: 'full' }]) },
        }, h('div', { className: 'rt-score-detail' },
          p.description ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d532')), h('span', null, p.description)) : null,
          h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d255')),
            h('span', null, (p.enabled ? [dt('drill.k30047')] : dt('drill.d533')) + ' · ' + p.points + dt('drill.d534') + p.hits.length +
              dt('drill.d535') + p.earned + dt('drill.d297') + (p.self_created ? dt('drill.d314') + p.self_created + [dt('drill.k30048')] : '') +
              (p.capped ? dt('drill.d314') + p.capped + [dt('drill.k30049')] : ''))),
          p.capped
            ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d536')),
                h('span', null, p.service_summary + dt('drill.d537')))
            : null,
          p.hits.length
            ? h('div', null,
                h(ShotStrip, { eng: eng, shots: p.shots, total: p.shot_total,
                  title: dt('drill.d538') + (p.shot_total || (p.shots || []).length) + dt('drill.d30') }),
                h('div', { className: 'rt-section', style: { padding: '6px 0 0' } },
                  dt('drill.d539') + p.hits.length + dt('drill.d540')),
                h('div', { className: 'rt-hits' }, hitNodes))
            : h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d541')),
                h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                  dt('drill.d542'))),
          h('div', { className: 'rt-actions' },
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); startEdit(p) } }, dt('drill.d543'))))))
        }
      }

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, dt('drill.d544')),
          /* 只显示已拿下的总分，不显示目标分数、不显示进度条 */
          h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', marginLeft: 4 } }, dt('drill.d545')),
          h('span', { className: 'rt-total' }, String(summary.achievedPoints)),
          h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, dt('drill.d516')),
          h('span', { className: 'rt-tag' }, summary.pointCount + dt('drill.d546')),
          h('span', { className: 'rt-tag' }, dt('drill.d547') + summary.countedHits + dt('drill.d115')),
          summary.selfCreatedHits
            ? h('span', {
                className: 'rt-tag rt-tag-warn',
                title: dt('drill.d548'),
              }, dt('drill.d549') + summary.selfCreatedHits)
            : null,
          summary.serviceCappedHits
            ? h('span', {
                className: 'rt-tag rt-tag-warn',
                title: dt('drill.d550'),
              }, dt('drill.d551') + summary.serviceCappedHits)
            : null,
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', onClick: startNew }, dt('drill.d552')),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? [dt('drill.k30020')] : dt('drill.d82'))),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' }, err) : null,
        form ? h('div', { className: 'rt-pane', style: { flex: 'none', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
          /* 内置得分点（builtin）：分值 / 名称 / 分类由《得分规则》锁定，输入框置灰。
             可改的只有「启用 / 停用」。这样界面上就不会再出现「改完提示已保存、刷新变回去」的困惑。 */
          form.builtin
            ? h('div', { className: 'rt-hint', style: { marginBottom: 8 } },
                h('b', null, dt('drill.d553')),
                h('div', { style: { marginTop: 3 } },
                  dt('drill.d554')
                  + dt('drill.d555')
                  + dt('drill.d556')),
                form.src !== null && form.src !== undefined
                  ? h('div', { style: { marginTop: 3, color: 'var(--dsw-alias-label-secondary)' } },
                      dt('drill.d557') + form.src + (form.rule ? dt('drill.d558') + form.rule : '')
                      + (form.cap > 0 ? dt('drill.d559') + form.cap + [dt('drill.k30030')] : dt('drill.d560')))
                  : null)
            : null,
          h('div', { className: 'rt-score-form' },
            h('input', {
              className: 'rt-input', placeholder: dt('drill.d561'), value: form.name,
              readOnly: form.builtin === true,
              title: form.builtin ? [dt('drill.k30050')] : '',
              onChange: (e) => setField('name', e.target.value),
            }),
            h('input', {
              className: 'rt-input', placeholder: dt('drill.d562'), value: form.category,
              readOnly: form.builtin === true,
              title: form.builtin ? [dt('drill.k30051')] : '',
              onChange: (e) => setField('category', e.target.value),
            }),
            h('input', {
              className: 'rt-input', type: 'number', placeholder: dt('drill.d563'),
              readOnly: form.builtin === true,
              title: form.builtin
                ? dt('drill.d564')
                : dt('drill.d565'),
              value: form.points, onChange: (e) => setField('points', Number(e.target.value)),
            }),
            h('select', { className: 'rt-input', value: form.enabled ? '1' : '0', onChange: (e) => setField('enabled', e.target.value === '1') },
              h('option', { value: '1' }, dt('drill.d566')),
              h('option', { value: '0' }, dt('drill.d533')))),
          h('input', {
            className: 'rt-input', style: { width: '100%', marginBottom: 6, boxSizing: 'border-box' },
            placeholder: dt('drill.d567'), value: form.description,
            readOnly: form.builtin === true,
            title: form.builtin ? [dt('drill.k30052')] : '',
            onChange: (e) => setField('description', e.target.value),
          }),
          h('div', { className: 'rt-actions' },
            h('button', { className: 'rt-btn rt-btn-primary', disabled: busy, onClick: save }, dt('drill.d182')),
          form.id
            ? (form.builtin
                ? h('button', {
                    className: 'rt-btn', disabled: true,
                    title: dt('drill.d568'),
                  }, dt('drill.d569'))
                : h('button', { className: 'rt-btn', disabled: busy, onClick: remove }, dt('drill.d570')))
            : null,
            h('button', { className: 'rt-btn', onClick: () => setForm(null) }, dt('drill.d571')))) : null,
        h('div', null,
          h('div', { className: 'rt-score-row head' },
            h('span', null, ''), h('span', null, dt('drill.d572')), h('span', null, dt('drill.d573')),
            h('span', null, dt('drill.d574')), h('span', { style: { textAlign: 'right' } }, dt('drill.d575'))),
          h(TableGrid, {
            /* 整行托管：得分行同样是自带的 `.rt-score-row` 网格（可展开、带命中详情）。 */
            head: false,
            columns: [{ key: 'row' }],
            rows: rows.map((node, index) => ({ key: 'sr' + index, cells: [node] })),
            empty: !items.length ? h(EmptyState, { text: dt('drill.d576') }) : null,
          })))
    }

    /* ---------------------------------------------------------- 折叠底座 */
    /**
     * 折叠状态按「页签 + 靶标」持久化到 localStorage，切页签/刷新后保持不变。
     * 只记录用户显式点过的键；没点过的用调用方给的默认值。
     */
    const COLLAPSE_KEY = 'rt-collapse:'
    const collapseLoad = (prefix) => {
      try {
        const raw = window.localStorage.getItem(COLLAPSE_KEY + prefix)
        const parsed = raw ? JSON.parse(raw) : null
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch (e) { return {} }
    }
    const collapseSave = (prefix, value) => {
      try { window.localStorage.setItem(COLLAPSE_KEY + prefix, JSON.stringify(value)) } catch (e) { /* 隐私模式等 */ }
    }

    /** 一个页签一个 hook：isOpen(key, defaultOpen) / toggle(key, defaultOpen) / setAll(keys, open) */
    function useCollapse(prefix) {
      const [state, setState] = React.useState(() => collapseLoad(prefix))
      React.useEffect(() => { setState(collapseLoad(prefix)) }, [prefix])
      const write = (next) => { collapseSave(prefix, next); setState(next) }
      const isOpen = (key, defaultOpen) => {
        const v = state[key]
        return v === undefined ? defaultOpen !== false : v === true
      }
      const toggle = (key, defaultOpen) => (e) => {
        if (e && e.stopPropagation) e.stopPropagation()
        write(Object.assign({}, state, { [key]: !isOpen(key, defaultOpen) }))
      }
      const setAll = (keys, open) => {
        const next = Object.assign({}, state)
        for (const k of keys) next[k] = open
        write(next)
      }
      return { isOpen: isOpen, toggle: toggle, setAll: setAll }
    }

    /**
     * 统一折叠头（L1）：▾ 固定在最左、标题加粗、计数紧跟、右侧放时间或操作，
     * 内容缩进 12px 并带一条竖引导线。always=true 表示"常显"（不可折叠）。
     */
    function Section(props) {
      const always = props.always === true
      const open = always || props.open === true
      const head = h('div', {
        className: 'rt-sec t-' + (props.tone || 'target') + (always ? ' flat' : ''),
        role: always ? undefined : 'button',
        tabIndex: always ? undefined : 0,
        'aria-expanded': always ? undefined : (open ? 'true' : 'false'),
        onClick: always ? undefined : props.onToggle,
        onKeyDown: always ? undefined : (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (props.onToggle) props.onToggle(e) }
        },
      },
        h('span', { className: 'rt-sec-caret' }, always ? '▍' : (open ? '▾' : '▸')),
        props.title ? h('span', { className: 'rt-sec-title' }, props.title) : null,
        props.count !== undefined && props.count !== null ? h('span', { className: 'rt-sec-count' }, String(props.count)) : null,
        props.sub ? h('span', { className: 'rt-sec-sub' }, props.sub) : null,
        props.right ? h('span', { className: 'rt-sec-right' }, props.right) : null)
      return h('div', { className: 'rt-sec-wrap' }, head,
        open && props.children ? h('div', { className: 'rt-sec-body' }, props.children) : null)
    }

    /** 长文本折叠（L3）：固定预览高度 + 渐隐 + 展开/复制。 */
    function Clip(props) {
      const [open, setOpen] = React.useState(false)
      const text = String(props.text === undefined || props.text === null ? '' : props.text)
      if (text.trim() === '') return null
      return h('div', { className: 'rt-clip' + (open ? ' open' : '') },
        h('div', { className: 'rt-clip-head' },
          props.label ? h('span', { className: 'rt-clip-label' }, props.label) : null,
          h('div', { className: 'rt-spacer' }),
          h('button', {
            className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
            onClick: (e) => { e.stopPropagation(); copyText(text) },
          }, dt('drill.d241')),
          h('button', {
            className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
            onClick: (e) => { e.stopPropagation(); setOpen((v) => !v) },
          }, open ? [dt('drill.k30053')] : dt('drill.d577'))),
        h('div', { className: 'rt-clip-body' }, text))
    }

    /* ---------------------------------------------------------- 当前测试（实时） */
    const TEST_STATUS_LABEL = {
      untested: dt('drill.d35'), testing: dt('drill.d36'), tested: dt('drill.d37'),
      blocked: dt('drill.d38'), abandoned: dt('drill.d39'), no_surface: dt('drill.d40'),
    }

    /**
     * 当前测试页：agent 正在打哪台、打到哪一步、还有什么在排队。
     * 5 秒轮询自动刷新；三个区块可折叠，其中「正在测」始终完整展开。
     */
    function TestingTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [at, setAt] = React.useState(null)
      const [auto, setAuto] = React.useState(true)
      /* 折叠状态按「页签 + 靶标」记忆；正在测永远常显，不参与折叠 */
      const collapse = useCollapse('testing:' + eng)

      /* 5 秒轮询要有在途守卫：网络慢或后端卡住时，请求会越堆越多、
         而且旧响应回来会覆盖新状态（界面上表现为数字来回跳）。 */
      const inflight = React.useRef(false)
      const seq = React.useRef(0)
      const load = () => {
        if (!eng || inflight.current) return
        inflight.current = true
        const my = ++seq.current
        api({ op: 'activeTests', engagement: eng, limit: 20 }).then((r) => {
          if (my !== seq.current) return          /* 切了靶标：这条已经过期，丢掉 */
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d165')); return }
          setErr(null); setData(r); setAt(new Date())
        }, (e) => { if (my === seq.current) setErr(String((e && e.message) || e)) })
          .finally(() => { if (my === seq.current) inflight.current = false })
      }
      React.useEffect(() => { seq.current += 1; load() }, [eng, refreshKey])
      React.useEffect(() => {
        if (!eng || !auto) return undefined
        const timer = setInterval(load, 5000)
        return () => clearInterval(timer)
      }, [eng, auto, refreshKey])

      const testing = (data && data.testing) || []
      const recent = (data && data.recent) || []
      const queue = (data && data.queue) || []
      const stats = (data && data.stats) || {}

      /* 一台资产一张卡：一眼看清"打的是谁、打到哪、拿到什么" */
      const card = (a, past) => {
        const chips = []
        chips.push(h('span', { key: 'sc', className: 'rt-scope rt-scope-' + (a.scope === 'internal' ? 'internal' : 'external') },
          a.scope === 'internal' ? [dt('drill.k30006')] : dt('drill.d55')))
        if (a.segment_cidr) chips.push(h('span', { key: 'seg', className: 'rt-tag' }, a.segment_cidr))
        if (a.open_ports) chips.push(h('span', { key: 'p', className: 'rt-tag rt-tag-active' }, dt('drill.d578') + a.open_ports + dt('drill.d579')))
        if (a.vulns) chips.push(h('span', { key: 'v', className: 'rt-tag rt-tag-live' }, dt('drill.d580') + a.vulns))
        if (a.webshells) chips.push(h('span', { key: 'w', className: 'rt-tag rt-tag-passive' }, 'WebShell ' + a.webshells))
        if (a.tunnels) chips.push(h('span', { key: 't', className: 'rt-tag rt-tag-passive' }, dt('drill.d322') + a.tunnels))
        if (a.priority) chips.push(h('span', { key: 'pr', className: 'rt-tag' }, dt('drill.d307') + a.priority))
        if (a.blocked_count) chips.push(h('span', { key: 'b', className: 'rt-tag', style: { color: 'var(--dsw-alias-state-error-primary, #ef4444)', borderColor: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 33%, transparent)' } }, dt('drill.d114') + a.blocked_count + dt('drill.d115')))
        const noteLines = a.test_notes
          ? String(a.test_notes).split('\n').slice(-3).map((l) => (l.length > 240 ? l.slice(0, 240) + ' …' : l))
          : []
        return h('div', { key: 'at' + a.id, className: 'rt-atest' + (past ? ' past' : '') },
          h('div', { className: 'rt-atest-head' },
            past ? null : h('span', { className: 'rt-live-dot' }),
            h('span', { className: 'rt-atest-ip' }, a.ip),
            h('span', { className: 'rt-tag ' + (a.test_status === 'testing' ? 'rt-tag-live' : '') }, TEST_STATUS_LABEL[a.test_status] || a.test_status),
            h('div', { className: 'rt-spacer' }),
            h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
              fmt(a.test_updated_at) + (a.test_updated_by ? ' · ' + a.test_updated_by : ''))),
          chips.length ? h('div', null, chips) : null,
          a.test_surface ? h('div', { className: 'rt-atest-meta' }, dt('drill.d581') + a.test_surface) : null,
          a.potential ? h('div', { className: 'rt-atest-meta' }, dt('drill.d582') + a.potential) : null,
          noteLines.length ? h(Clip, { label: dt('drill.d583'), text: noteLines.join('\n') }) : null)
      }


      const concl = (label, value, tone) => h('span', { key: label, className: 'rt-concl-i', style: { cursor: 'default' } },
        h('b', null, String(value || 0)), h('span', null, label))
      const conclusion = h('div', { className: 'rt-concl' },
        concl(dt('drill.d36'), stats.testing, 'live'),
        concl(dt('drill.d92'), stats.untested, ''),
        concl(dt('drill.d93'), stats.tested, ''),
        concl(dt('drill.d94'), (stats.abandoned || 0) + (stats.blocked || 0), ''),
        concl(dt('drill.d40'), stats.no_surface, ''),
        h('div', { className: 'rt-spacer' }),
        at ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
          dt('drill.d584') + at.toLocaleTimeString('zh-CN', { hour12: false })) : null,
        h('button', {
          className: 'rt-btn', style: { padding: '0 7px', fontSize: 11 }, title: dt('drill.d585'),
          onClick: () => collapse.setAll(['testing:' + eng, 'recent:' + eng, 'queue:' + eng], true),
        }, dt('drill.d282')),
        h('button', {
          className: 'rt-btn', style: { padding: '0 7px', fontSize: 11 }, title: dt('drill.d586'),
          onClick: () => collapse.setAll(['testing:' + eng, 'recent:' + eng, 'queue:' + eng], false),
        }, dt('drill.d284')),
        h('button', {
          className: 'rt-btn' + (auto ? ' rt-btn-primary' : ''), style: { padding: '0 7px', fontSize: 11 },
          title: dt('drill.d587'), onClick: () => setAuto((x) => !x),
        }, auto ? [dt('drill.k30054')] : dt('drill.d588')),
        h('button', { className: 'rt-btn', style: { padding: '0 7px', fontSize: 11 }, onClick: load }, dt('drill.d82')))

      const body = []
      /* 正在测：常显，完整展开（不可折叠） */
      body.push(h(Section, {
        key: 'testing', tone: 'test', title: dt('drill.d589'),
        count: testing.length + dt('drill.d60'),
        sub: testing.length ? [dt('drill.k30055')] : dt('drill.d590'),
        open: collapse.isOpen('testing:' + eng, true),
        onToggle: collapse.toggle('testing:' + eng, true),
      }, testing.length
        ? testing.map((a) => card(a, false))
        : h('div', { className: 'rt-atest-meta', style: { paddingBottom: 4 } }, dt('drill.d591'))))

      /* 最近动过（默认折叠，可记忆） */
      body.push(h(Section, {
        key: 'recent', tone: 'past', title: dt('drill.d592'), count: recent.length + dt('drill.d60'),
        sub: dt('drill.d593'),
        open: collapse.isOpen('recent:' + eng, false),
        onToggle: collapse.toggle('recent:' + eng, false),
      }, recent.length ? recent.map((a) => card(a, true)) : h('div', { className: 'rt-atest-meta' }, dt('drill.d277'))))

      /* 待测队列（默认折叠，可记忆） */
      body.push(h(Section, {
        key: 'queue', tone: 'queue', title: dt('drill.d594'),
        count: (data ? (data.untested || 0) : 0) + dt('drill.d60'),
        sub: dt('drill.d595'),
        open: collapse.isOpen('queue:' + eng, false),
        onToggle: collapse.toggle('queue:' + eng, false),
      }, queue.length
        ? queue.map((a) => card(a, true)).concat([
            h('div', { key: 'queueHint', className: 'rt-atest-meta', style: { paddingTop: 4 } },
              dt('drill.d596'))])
        : h('div', { className: 'rt-atest-meta' }, dt('drill.d597'))))

      return h('div', { className: 'rt-main' },
        conclusion,
        err ? h('div', { className: 'rt-err' }, err) : null,
        data === null && !err ? h('div', { className: 'rt-empty' }, dt('drill.d136')) : null,
        h('div', { className: 'rt-body', style: { overflow: 'auto' } },
          h('div', { style: { padding: '6px 12px 14px' } }, body)))
    }

    /* ---------------------------------------------------------- 会话与入口（WebShell / 隧道） */
    /**
     * 打内网最容易出的问题：拿到 WebShell 或隧道之后忘了登记，过一会儿就"忘了还有入口可用"。
     * 这个页签把事实库里的 WebShell 与隧道集中展示，带连通状态，并可一键让 host 侧实测。
     */
    function SessionTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [copied, setCopied] = React.useState(null)

      const load = () => {
        if (!eng) return
        api({ op: 'sessions', engagement: eng }).then((r) => {
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d165')); return }
          setErr(null)
          setData(r)
        }, (e) => setErr(String((e && e.message) || e)))
      }
      React.useEffect(load, [eng, refreshKey])

      const probe = () => {
        setBusy(true); setMsg(null)
        api({ op: 'probeSessions', engagement: eng, timeoutMs: 6000 }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d598') }); load(); return }
          const on = (r.webshells || []).filter((x) => x.status === 'online').length
          const act = (r.tunnels || []).filter((x) => x.status === 'active').length
          setMsg({ ok: dt('drill.d599') + on + '/' + (r.webshells || []).length + dt('drill.d600') + act + '/' + (r.tunnels || []).length })
          load()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      /* 只有真的写进剪贴板才把按钮点亮成「已复制」；失败时如实报错 */
      const copy = (key, text) => copyWithFeedback(text, text, (okFlag, message) => {
        if (!okFlag) { setMsg({ err: message }); return }
        setCopied(key)
        /*
         * characterization：这里的 1500 是**被允许的**，不要去改它。
         *
         * 它和浮层那条被删的周期轮询（每 1.5 秒一次的 sync 定时器，载体 purge-dock.js）
         * 没有关系：这里是「已复制」提示亮 1.5 秒后自己熄灭的一次性定时器，不是周期轮询。
         * 删浮层那一轮的验收判据因此只认形态 —— 产物里不许出现「周期定时器 + 该常量」的组合，
         * 不认字符串里有没有这个数字；否则下一个为过门禁把常量改小的人，就是在改行为迎合断言。
         */
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500)
      })

      const markTunnel = (t, status) => {
        setMsg(null)
        api({ op: 'updateTunnel', engagement: eng, id: t.id, patch: { status: status, check_note: dt('drill.d601') } })
          .then(() => load(), (e) => setMsg({ err: String((e && e.message) || e) }))
      }
      const markShell = (w, status) => {
        setMsg(null)
        api({ op: 'updateWebshell', engagement: eng, id: w.id, patch: { status: status, check_note: dt('drill.d601') } })
          .then(() => load(), (e) => setMsg({ err: String((e && e.message) || e) }))
      }

      const sessCollapse = useCollapse('sessions:' + eng)
      const totals = (data && data.totals) || {}
      const shells = (data && data.webshells) || []
      const tunnels = (data && data.tunnels) || []
      const statusDot = (s) => h('span', { className: s === 'online' || s === 'active' ? 'rt-dot-on' : (s === 'unknown' || !s ? 'rt-dot-unk' : 'rt-dot-off') })
      /* 卡片里统一用「标签 + 值」两列，长文本自动换行 —— 比一行点分隔好扫读 */
      const fact = (label, value) => h('div', { className: 'rt-sess-fact' }, h('b', null, label), h('span', null, value))
      /* 交付要求：马必须是冰蝎/哥斯拉加密马（用户才连得上），内网必须走 suo5 隧道 */
      const isEncryptedShell = (t) => /behinder|godzilla|冰蝎|哥斯拉/i.test(String(t || ''))
      const isSuo5 = (t) => /suo5/i.test(String(t || ''))
      /* 提示条：只留一句结论 + 可展开的做法（原来是把三段长解释平铺，正文全被淹掉） */
      const hint = (key, title, detail) => h('div', { key, className: 'rt-hint' },
        h('b', null, title),
        h('details', { className: 'rt-sess-fold', style: { marginTop: 3 } },
          h('summary', null, dt('drill.d602')),
          h('div', { style: { marginTop: 4 } }, detail)))
      const hints = []
      const badShells = shells.filter((w) => !isEncryptedShell(w.shell_type))
      const legitTunnels = tunnels.filter((t) => t.legit === true)
      if (badShells.length > 0) {
        hints.push(hint('h1', dt('drill.d603') + badShells.length + dt('drill.d604'),
          dt('drill.d605')
          + dt('drill.d606')))
      }
      if (tunnels.length > 0 && legitTunnels.length === 0) {
        hints.push(hint('h3', dt('drill.d607') + tunnels.length + dt('drill.d608'),
          dt('drill.d609')
          + dt('drill.d610')))
      }
      const activeSuo5 = tunnels.filter((t) => isSuo5(t.kind) && t.status === 'active')
      if (shells.length > 0 && activeSuo5.length === 0) {
        hints.push(hint('h2', dt('drill.d611'),
          dt('drill.d612')
          + dt('drill.d613')
          + dt('drill.d614')))
      }

      const shellCards = shells.map((w) => h('div', { key: 'w' + w.id, className: 'rt-sess' },
        h('div', { className: 'rt-sess-head' },
          statusDot(w.status),
          h('span', { className: 'rt-sess-title' }, w.url),
          h('span', { className: 'rt-tag rt-tag-active' }, w.shell_type || 'webshell'),
          isEncryptedShell(w.shell_type) ? null : h('span', { className: 'rt-tag rt-tag-warn' }, dt('drill.d615')),
          w.privilege ? h('span', { className: 'rt-tag' }, w.privilege) : null,
          h('div', { className: 'rt-spacer' }),
          copied === 'cmd' + w.id
            ? h('span', { className: 'rt-tag', style: { color: 'var(--dsw-alias-state-success-primary, #10b981)' } }, dt('drill.d616'))
            : h('button', {
                className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
                onClick: () => copy('cmd' + w.id, 'curl -s "' + w.url + '"'),
              }, dt('drill.d617')),
          h('button', {
            className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
            onClick: () => markShell(w, 'offline'),
          }, dt('drill.d618'))),
        h('div', { className: 'rt-sess-facts' },
          fact(dt('drill.d213'), (isEncryptedShell(w.shell_type) ? [dt('drill.k30056')] : dt('drill.d619'))),
          w.pass_key ? fact(dt('drill.d620'), h('span', { className: 'rt-mono' }, w.pass_key)) : null,
          w.asset_ip ? fact(dt('drill.d621'), w.asset_ip) : null,
          w.privilege ? fact(dt('drill.d622'), w.privilege) : null,
          w.secret_ref ? fact(dt('drill.d623'), h('span', { className: 'rt-mono' }, w.secret_ref)) : null,
          fact(dt('drill.d624'), (w.last_check ? fmt(w.last_check) : dt('drill.d625'))
            + (w.latency_ms !== null && w.latency_ms !== undefined ? '（' + w.latency_ms + 'ms）' : '')),
          w.check_note ? fact(dt('drill.d626'), w.check_note) : null,
          w.note ? fact(dt('drill.d505'), w.note) : null)))

      const tunnelCards = tunnels.map((t) => {
        const proxy = t.listen ? 'socks5://' + t.listen : ''
        const gogoCmd = t.listen ? dt('drill.d627') + proxy : ''
        const fscanCmd = t.listen ? dt('drill.d628') + t.listen + ' -o intranet.txt' : ''
        return h('div', { key: 't' + t.id, className: 'rt-sess' },
          h('div', { className: 'rt-sess-head' },
            statusDot(t.status),
            h('span', { className: 'rt-sess-title' }, t.listen || dt('drill.d629')),
            h('span', { className: 'rt-tag rt-tag-passive' }, t.kind || 'tunnel'),
            isSuo5(t.kind) ? null : h('span', { className: 'rt-tag rt-tag-warn' }, dt('drill.d630')),
            /* 只有跨越靶标边界的通道才算突破凭证（自己 VPS/自建服务器上开的不算） */
            t.legit === true
              ? h('span', { className: 'rt-tag rt-tag-live', title: t.entry_kind_label || '' }, dt('drill.d631'))
              : (t.legit === false
                  ? h('span', { className: 'rt-tag rt-tag-warn', title: dt('drill.d632') }, dt('drill.d633'))
                  : h('span', { className: 'rt-tag', title: dt('drill.d634') }, dt('drill.d635'))),
            t.reach ? h('span', { className: 'rt-tag' }, dt('drill.d316') + t.reach) : null,
            h('div', { className: 'rt-spacer' }),
            h('button', {
              className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
              onClick: () => copy('sock' + t.id, t.listen || ''),
            }, copied === 'sock' + t.id ? [dt('drill.k30057')] : dt('drill.d636')),
            t.status === 'active'
              ? h('button', { className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 }, onClick: () => markTunnel(t, 'down') }, dt('drill.d618'))
              : h('button', { className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 }, onClick: () => markTunnel(t, 'active') }, dt('drill.d637'))),
          h('div', { className: 'rt-sess-facts rt-def' },
            fact(dt('drill.d638'), t.entry || dt('drill.d369')),
            fact(dt('drill.d639'), t.legit === true
              ? h('span', { className: 'rt-tag rt-tag-live' }, t.entry_kind_label || t.entry_kind || dt('drill.d640'))
              : (t.legit === false
                  ? h('span', { className: 'rt-tag rt-tag-warn' }, dt('drill.d641'))
                  : h('span', { className: 'rt-tag' }, dt('drill.d642')))),
            t.reach ? fact(dt('drill.d643'), t.reach) : null,
            t.asset_ip ? fact(dt('drill.d621'), t.asset_ip) : null,
            fact(dt('drill.d624'), (t.last_check ? fmt(t.last_check) : dt('drill.d625'))
              + (t.latency_ms !== null && t.latency_ms !== undefined ? '（' + t.latency_ms + 'ms）' : '')),
            t.check_note ? fact(dt('drill.d626'), t.check_note) : null,
            t.note ? fact(dt('drill.d505'), t.note) : null),
          /* 命令默认折叠：卡片首要信息是"这条通道能不能用、通向哪"，命令按需展开 */
          t.command ? h('details', { className: 'rt-sess-fold' },
            h('summary', null, dt('drill.d644')),
            h('div', Object.assign({ className: 'rt-code', title: dt('drill.d645') }, clickable(() => copy('c' + t.id, t.command), { label: dt('drill.d360') })),
              copied === 'c' + t.id ? [dt('drill.k30057')] : t.command)) : null,
          t.status === 'active' && t.listen
            ? h('details', { className: 'rt-sess-fold' },
                h('summary', null, dt('drill.d646')),
                h('div', { className: 'rt-sess-cmd' },
                  h('div', Object.assign({ className: 'rt-code', title: dt('drill.d645') }, clickable(() => copy('g' + t.id, gogoCmd), { label: dt('drill.d647') })),
                    copied === 'g' + t.id ? [dt('drill.k30057')] : gogoCmd),
                  h('div', Object.assign({ className: 'rt-code', style: { display: 'block', marginTop: 3 }, title: dt('drill.d645') }, clickable(() => copy('f' + t.id, fscanCmd), { label: dt('drill.d648') })),
                    copied === 'f' + t.id ? [dt('drill.k30057')] : fscanCmd)))
            : null)
      })

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, dt('drill.d649')),
          h('span', { className: 'rt-tag' }, 'WebShell ' + (totals.webshellsOnline || 0) + '/' + (totals.webshells || 0) + dt('drill.d650')),
          h('span', { className: 'rt-tag' }, dt('drill.d322') + (totals.tunnelsActive || 0) + '/' + (totals.tunnels || 0) + dt('drill.d651')),
          h('span', { className: 'rt-tag' }, dt('drill.d652') + (totals.credentials || 0)),
          h('span', { className: 'rt-tag' }, dt('drill.d653') + (totals.access || 0)),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn rt-btn-primary', disabled: busy, onClick: probe }, busy ? [dt('drill.k30058')] : dt('drill.d654')),
          h('button', { className: 'rt-btn', onClick: load }, dt('drill.d82'))),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' }, err) : null,
        h('div', { className: 'rt-body', style: { overflow: 'auto' } },
          !shells.length && !tunnels.length
            ? h(EmptyState, {
                text: dt('drill.d655'),
                action: h('button', { className: 'rt-btn', onClick: probe }, dt('drill.d654')),
              })
            : null,
          hints.length ? h('div', { style: { padding: '8px 10px 0' } }, hints) : null,
          h(Section, {
            key: 'webshells', tone: 'queue', title: 'WebShell',
            count: (totals.webshellsOnline || 0) + '/' + (totals.webshells || 0) + dt('drill.d650'),
            sub: dt('drill.d657'),
            open: sessCollapse.isOpen('shells', true), onToggle: sessCollapse.toggle('shells', true),
          }, shells.length
            ? h('div', { className: 'rt-sess-grid', style: { padding: 0 } }, shellCards)
            : h('div', { className: 'rt-atest-meta' }, dt('drill.d658'))),
          h(Section, {
            key: 'tunnels', tone: 'test', title: dt('drill.d659'),
            count: (totals.tunnelsActive || 0) + '/' + (totals.tunnels || 0) + dt('drill.d651'),
            sub: dt('drill.d660'),
            open: sessCollapse.isOpen('tunnels', true), onToggle: sessCollapse.toggle('tunnels', true),
          }, tunnels.length
            ? h('div', { className: 'rt-sess-grid', style: { padding: 0 } }, tunnelCards)
            : h('div', { className: 'rt-atest-meta' }, dt('drill.d661')))))

    }

    /* ---------------------------------------------------------- 错误边界 */
    /**
     * 单个页签渲染出错时只降级该页签，不拖垮整个面板：面板与侧栏按钮保持可用，
     * 用户可一键回到资产测绘。（此前面板整块消失、按钮点不开就是缺了这层保护。）
     */
    class RtBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: error }
      }
      componentDidCatch(error) {
        try { console.error(dt('drill.d662'), error) } catch (e) { /* ignore */ }
      }
      render() {
        if (this.state.error) {
          const msg = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error)
          return h('div', { className: 'rt-pane' },
            h('div', { className: 'rt-err' }, dt('drill.d663') + msg),
            h('button', {
              className: 'rt-btn',
              onClick: () => { this.setState({ error: null }); setUI({ tab: 'assets' }) },
            }, dt('drill.d664')))
        }
        return this.props.children
      }
    }

    /**
     * 智能体页签：并发名额（最多 3 个）+ 六个角色与它们的提示词。
     * 主会话派活前先看这里的名额，用户也能一眼看到"现在还能拉起几个智能体"。
     */
    function AgentsTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [roles, setRoles] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [concurrency, setConcurrency] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const load = () => {
        setBusy(true)
        api({ op: eng ? 'prompts' : 'bootstrap', engagement: eng || undefined }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d165')); return }
          setErr(null)
          if (r.roles) setRoles(r.roles)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
        /* 并发名额按"当前跑着的子智能体"算；host 侧读 subagents 注册表 */
        api({ op: 'agentsStatus' }).then((r) => {
          if (r && r.ok !== false) setConcurrency(r)
        }, () => {})
      }
      React.useEffect(load, [eng, refreshKey])

      const used = concurrency ? concurrency.used : null
      const max = concurrency ? concurrency.max : 3
      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', null, dt('drill.d665')),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? [dt('drill.k30041')] : dt('drill.d82'))),
        h('div', { className: 'rt-pane' },
          err ? h('div', { className: 'rt-err' }, err) : null,
          /* 两栏：左边「规则 / 角色」是主体，右边「设置 / 提醒」是辅体。
             整宽单列时每一节权重相同，读起来像一张清单；分栏之后页面才有主次。 */
          h('div', { className: 'rt-cols' },
            h('div', { className: 'rt-cols__main' },
              /* 并发规则：一条规则一行（列表），不再是一段带「·」的连续文本 */
              h('section', { className: 'rt-section rt-section--stack' },
                h('h3', { className: 'rt-section__title' }, dt('drill.d670')),
                h('ul', { className: 'rt-rule' },
                  h('li', { className: 'rt-rule__item', key: 'r1' }, h(RichCopy, { text: dt('drill.d671') + max + dt('drill.d672') })),
                  h('li', { className: 'rt-rule__item', key: 'r2' }, h(RichCopy, { text: dt('drill.d673') })),
                  h('li', { className: 'rt-rule__item', key: 'r3' }, h(RichCopy, { text: dt('drill.d674') })))),
              /* 六个角色：auto-fill 网格（窄屏一列） */
              h('section', { className: 'rt-section rt-section--stack' },
                h('h3', { className: 'rt-section__title' }, dt('drill.d675')),
                h('div', { className: 'rt-roles' },
                  ['drill.d676', 'drill.d677', 'drill.d678', 'drill.d679', 'drill.d680', 'drill.d681'].map((key) =>
                    h('div', { className: 'rt-roles__item', key: key }, h(RichCopy, { text: dt(key) })))))),
            h('div', { className: 'rt-cols__aside' },
              /* 并发占用：数字大、标签小，一眼看出还剩几个名额 */
              h('section', { className: 'rt-section rt-section--stack' },
                h('h3', { className: 'rt-section__title' }, dt('drill.d665')),
                h(StatRow, {
                  groups: [{
                    key: 'agents',
                    items: [
                      { key: 'max', label: dt('drill.d666').trim(), value: max },
                      { key: 'used', label: dt('drill.d668').trim(), value: used === null ? '—' : used },
                      { key: 'free', label: dt('drill.d669').replace(/^\s*\/\s*/, '').trim(), value: used === null ? '—' : Math.max(max - used, 0) },
                    ],
                  }],
                })),
              h(ConcurrencyCard, { concurrency, onSaved: load }))),
          /* 角色提示词编辑器：整宽（长表单，挤进辅栏会把两栏比例撑坏） */
          h('section', { className: 'rt-section rt-section--stack' },
            h('h3', { className: 'rt-section__title' }, dt('drill.d682')),
            h('p', { className: 'rt-section__hint' }, dt('drill.d683')),
            h(PromptsTab, { engagement: eng, refreshKey: refreshKey }))))
    }

    function ConcurrencyCard(props) {
      const info = props.concurrency || {}
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      React.useEffect(() => { if (info.max) setDraft(String(info.max)) }, [info.max])

      const limit = info.limit || 10
      const used = typeof info.used === 'number' ? info.used : null
      const source = info.source === 'settings' ? dt('drill.d684')
        : info.source === 'env' ? [dt('drill.k30059')] : dt('drill.d685')
      const n = Number(draft)
      const invalid = !Number.isFinite(n) || Math.floor(n) !== n || n < 1 || n > limit
      const save = () => {
        if (invalid) return
        setBusy(true); setMsg(null)
        api({ op: 'setAgentsMax', max: n }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d168') }); return }
          setMsg({ ok: dt('drill.d686') + r.max + dt('drill.d687') })
          if (props.onSaved) props.onSaved()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }
      return h('section', { className: 'rt-section rt-section--stack' },
        h('h3', { className: 'rt-section__title' }, dt('drill.d688')),
        h('p', { className: 'rt-section__hint' },
          h(RichCopy, {
            text: dt('drill.d689') + (info.max || '?') + '**'
              + (used === null ? '' : dt('drill.d690') + used + dt('drill.d691') + Math.max((info.max || 0) - used, 0) + '）')
              + dt('drill.d692') + source + dt('drill.d693'),
          })),
        /* 一行设置：标签在上，输入 + 范围提示 + 保存同一条基线 */
        h('div', { className: 'rt-field' },
          /* 标签与分节标题不重复：标题已经是「并发数量」，这里只标这一行的字段名 */
          h('label', { className: 'rt-field__label', htmlFor: 'rt-agents-max' }, dt('drill.d666').trim()),
          h('div', { className: 'rt-field__row' },
            h('input', {
              id: 'rt-agents-max', 'aria-label': dt('drill.d688'),
              className: 'rt-input', style: { width: 90 }, type: 'number', min: 1, max: limit,
              value: draft, onChange: (e) => setDraft(e.target.value),
            }),
            h('span', { className: 'rt-field__hint' }, dt('drill.d694') + limit),
            h('button', { className: 'rt-btn rt-btn-primary', disabled: busy || invalid, onClick: save },
              busy ? [dt('drill.k30016')] : dt('drill.d182')),
            msg && msg.err ? h('span', { className: 'rt-field__err' }, msg.err) : null,
            msg && msg.ok ? h('span', { className: 'rt-field__hint' }, msg.ok) : null)),
        h('div', { className: 'rt-caution', style: { marginTop: 12 } },
          h('span', { className: 'rt-caution__label' }, dt('drill.note')),
          h(RichCopy, { text: dt('drill.d695') + dt('drill.d696') + dt('drill.d697') })))
    }

    /**
     * 版本显示 + 自动更新按钮。
     *
     * 行为：挂载时静默查一次最新版本（npm registry），有新版本就把按钮点亮成
     * 「有新版本 vX」；点击弹出确认框（当前版本 / 最新版本 / 安装位置 / 阻塞项），
     * 确认后由 host 侧执行 安装 → 重启 dsh web（页面会断开，重启后刷新即可）。
     */
    function VersionBar(props) {
      const [info, setInfo] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [countdown, setCountdown] = React.useState(0)
      /* 倒计时 interval 必须能被打断：弹窗被关闭、组件卸载、重复点「立即更新」
         都会留下孤儿 interval，它会在组件已卸载后调 window.location.reload()。 */
      const countdownRef = React.useRef(null)
      const clearCountdown = React.useCallback(() => {
        if (countdownRef.current) { try { clearInterval(countdownRef.current) } catch { /* ignore */ } }
        countdownRef.current = null
      }, [])
      React.useEffect(() => () => clearCountdown(), [clearCountdown])
      const closeModal = React.useCallback(() => {
        clearCountdown()
        setCountdown(0)
        setOpen(false)
      }, [clearCountdown])

      const check = (silent) => {
        if (!silent) setBusy(true)
        api({ op: 'updateCheck' }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) {
            /* 开发态或查不到 registry：只显示当前版本，不报错打扰用户 */
            if (!silent) setErr((r && r.error) || dt('drill.d698'))
            api({ op: 'version' }).then((v) => { if (v && v.ok !== false) setInfo(v) }, () => {})
            return
          }
          setErr(null)
          setInfo(r)
        }, (e) => {
          setBusy(false)
          if (!silent) setErr(String((e && e.message) || e))
          api({ op: 'version' }).then((v) => { if (v && v.ok !== false) setInfo(v) }, () => {})
        })
      }
      React.useEffect(() => { check(true) }, [])

      const apply = () => {
        setBusy(true)
        setMsg(null)
        api({ op: 'updateApply', target: (info && info.latest) || undefined }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || dt('drill.d246') }); return }
          setMsg({ ok: dt('drill.d699') + (r.installed || '') + dt('drill.d700') })
          /* 重启会断开这个页面：倒计时提示用户稍后刷新 */
          setCountdown(6)
          clearCountdown()
          countdownRef.current = setInterval(() => {
            setCountdown((n) => {
              if (n <= 1) { clearCountdown(); window.location.reload(); return 0 }
              return n - 1
            })
          }, 1000)
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const current = info && info.current ? info.current : (info && info.plugin ? info.plugin.version : null)
      const latest = info && info.latest ? info.latest : null
      const hasNew = !!(info && info.updateAvailable)
      const blockers = (info && info.blockers) || []
      const notes = (info && info.notes) || []
      const mode = info && info.install ? info.install.mode : null

      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('span', {
          className: 'rt-tag' + (hasNew ? ' rt-tag-warn' : ''),
          title: (dt('drill.d701') + (current || dt('drill.d32')) + (latest ? dt('drill.d702') + latest : '')
            + (mode === 'dev' ? [dt('drill.k30060')] : mode === 'package' ? [dt('drill.k30061')] : '')
            + (info && info.check_error ? dt('drill.d703') + info.check_error : '')),
        }, 'v' + (current || '?')),
        hasNew
          ? h('button', {
              className: 'rt-btn rt-btn-primary', disabled: busy,
              onClick: () => { setOpen(true); setMsg(null) },
              title: dt('drill.d704') + latest + dt('drill.d705'),
            }, busy ? [dt('drill.k30062')] : dt('drill.d706') + latest)
          : h('button', {
              className: 'rt-btn', disabled: busy, onClick: () => check(false),
              title: dt('drill.d707'),
            }, busy ? [dt('drill.k30062')] : dt('drill.d708')),
        open
          ? h('div', { className: 'rt-modal', 'aria-hidden': 'true', onClick: closeModal },
              h('div', { className: 'rt-modal-box', onClick: (e) => e.stopPropagation() },
                h('h4', { style: { marginTop: 0 } }, dt('drill.d709')),
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d710')), h('span', null, current || dt('drill.d32'))),
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d711')), h('span', null, latest || dt('drill.d32'))),
                h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d712')),
                  h('span', null, mode === 'dev' ? [dt('drill.k30063')] : mode === 'package' ? dt('drill.d713') + ((info.install && info.install.packageManager) || 'npm') + '）' : dt('drill.d32'))),
                info && info.install && info.install.dir
                  ? h('div', { className: 'rt-kv' }, h('b', null, dt('drill.d714')), h('span', { className: 'rt-mono' }, info.install.dir))
                  : null,
                blockers.length
                  ? h('div', { className: 'rt-hint' },
                      h('div', { style: { fontWeight: 600, marginBottom: 4 } }, dt('drill.d715')),
                      blockers.map((b, i) => h('div', { key: 'b' + i }, '· ' + b)))
                  : null,
                notes.length
                  ? h('div', { className: 'rt-foot', style: { padding: '4px 0' } }, notes.map((n, i) => h('div', { key: 'n' + i }, n)))
                  : null,
                h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '8px 0' } },
                  dt('drill.d716')
                  + dt('drill.d717')),
                msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
                countdown > 0
                  ? h('div', { className: 'rt-foot' }, dt('drill.d718') + countdown + dt('drill.d719'))
                  : null,
                h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 } },
                  h('button', { className: 'rt-btn', onClick: closeModal }, dt('drill.d720')),
                  h('button', {
                    className: 'rt-btn rt-btn-primary',
                    disabled: busy || blockers.length > 0 || mode === 'dev',
                    title: mode === 'dev' ? [dt('drill.k30064')] : blockers.length ? [dt('drill.k30065')] : dt('drill.d721'),
                    onClick: apply,
                  }, busy ? [dt('drill.k30066')] : dt('drill.d722')))))
          : null)
    }

    /* ---------------------------------------------------------- 常驻面板主体 */
    /**
     * 「未读」状态：按靶标记在 localStorage 里，每 25 秒问一次 host 的 consoleDigest
     * （每个页签的条数 + 最近更新时间）。比本地记住的快照新 → 该页签点红点；
     * 用户点开那个页签就把当前值记成已读，红点消失。
     */
    const UNREAD_KEY = 'rt-unread:'
    const loadUnread = (eng) => {
      try {
        const raw = window.localStorage.getItem(UNREAD_KEY + eng)
        const parsed = raw ? JSON.parse(raw) : null
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch (e) { return null }
    }
    const saveUnread = (eng, value) => {
      try { window.localStorage.setItem(UNREAD_KEY + eng, JSON.stringify(value)) } catch (e) { /* 隐私模式等：不持久化也能用 */ }
    }
    /** 这个页签相对上次查看有没有新内容（条数变多，或最新一条比上次查看还新）。 */
    const digestHasNew = (prev, cur) => {
      if (!cur) return false
      if (!prev) return true
      const pc = Number(prev.count || 0)
      const cc = Number(cur.count || 0)
      if (cc > pc) return true
      const pa = prev.at || ''
      const ca = cur.at || ''
      return ca !== '' && ca !== pa && ca > pa
    }

    const RT_GEOM_KEY = 'rt-dock-geom-v1'
    function clampRtGeom(g) {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
      const w = Math.min(Math.max(320, Number(g && g.w) || 620), Math.max(320, vw))
      const h = Math.min(Math.max(240, Number(g && g.h) || 520), Math.max(240, vh))
      const x = Math.min(Math.max(0, Number(g && g.x) || 0), Math.max(0, vw - w))
      const y = Math.min(Math.max(0, Number(g && g.y) || 0), Math.max(0, vh - h))
      return { x: x, y: y, w: w, h: h }
    }
    function defaultRtGeom() {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
      let w = 620
      try {
        const saved = Number(window.localStorage.getItem('rt-dock-width'))
        if (Number.isFinite(saved) && saved >= 320 && saved <= 1200) w = saved
      } catch (e) { /* 隐私模式 */ }
      const h = Math.max(240, Math.min(640, vh - 24))
      return clampRtGeom({ x: Math.max(0, vw - w - 12), y: 12, w: w, h: h })
    }
    function loadRtGeom() {
      try {
        const raw = JSON.parse(window.localStorage.getItem(RT_GEOM_KEY) || 'null')
        if (raw && typeof raw === 'object') return clampRtGeom(raw)
      } catch (e) { /* 隐私模式或坏数据 */ }
      return defaultRtGeom()
    }

    /**
     * 列定义 → grid-template-columns 字符串的**唯一**生成点。
     *
     * 三个数据密集页原先各自写死「150px 74px 104px 1.15fr 1fr」这种字面量，
     * 改一列要同时改表头、行、展开行三处，而且各页的列宽口径根本对不齐。
     *
     * @param {Array<{key:string, width?:number|string}>} list 列定义；width 缺省或 'grow' 表示占满剩余
     * @returns {string} 可直接给 grid-template-columns 的字符串
     */
    function tableColumns(list) {
      return (Array.isArray(list) ? list : []).map((col) => {
        const width = col && col.width
        if (width === undefined || width === null || width === '' || width === 'grow') return 'minmax(0,1fr)'
        return typeof width === 'number' ? width + 'px' : String(width)
      }).join(' ')
    }

    /**
     * 表格原语：一个表头 + 若干行，列宽由 tableColumns 生成。
     *
     * 行的单元格由调用方按列顺序给成节点数组（沿用各页原来的单元格渲染，只换外壳）；
     * `extra` 是就地展开的详情（也占满整行）。表格只用发丝线分隔，不套卡片。
     */
    function TableGrid(props) {
      const columns = Array.isArray(props && props.columns) ? props.columns : []
      const rows = Array.isArray(props && props.rows) ? props.rows : []
      const template = tableColumns(columns)
      const cellClass = (col) => 'rt-grid__cell' + (col && col.align === 'right' ? ' rt-grid__cell--num' : '')
      return h('div', { className: 'rt-grid' + (props && props.className ? ' ' + props.className : '') },
        props && props.head === false ? null : h('div', { className: 'rt-grid__head', style: { gridTemplateColumns: template } },
          columns.map((col) => h('span', { className: cellClass(col) + ' rt-grid__cell--head', key: 'h-' + String(col.key) }, col.label || ''))),
        rows.map((row) => h('div', {
          className: 'rt-grid__row' + (row.onClick ? ' is-clickable' : ''),
          key: row.key,
          style: { gridTemplateColumns: template },
          onClick: row.onClick,
        },
          (row.cells || []).map((cell, index) => h('span', { className: cellClass(columns[index]), key: 'c' + index }, cell)),
          row.extra ? h('div', { className: 'rt-grid__extra' }, row.extra) : null)),
        props && props.empty ? props.empty : null)
    }

    /**
     * 状态行原语：状态点 + 名称 + 一句现状 + 可选右侧动作。
     *
     * 环境适配那三条（工具路径 / 环境变量 / 占位符）原先各是一段话，读者要在三段文字里
     * 自己找「哪个还没就绪」。一行一件事，右侧只放该行自己的动作。
     */
    function StatusLine(props) {
      const tone = props && props.tone === 'ok' ? 'ok' : props && props.tone === 'warn' ? 'warn' : 'idle'
      return h('div', { className: 'rt-status__row' },
        h('span', { className: 'rt-status__dot rt-status__dot--' + tone, 'aria-hidden': 'true' }),
        h('span', { className: 'rt-status__name' }, props.name || ''),
        h('span', { className: 'rt-status__detail' }, props.detail || ''),
        props.action ? h('span', { className: 'rt-status__action' }, props.action) : null)
    }

    /**
     * 统计行原语：分组展示计数，数字大、标签小、数字等宽。
     *
     * 之前页脚是一长串「C 段 0 资产 0（存活 0）端口 0 指纹 0 漏洞 0 被动/主动 0/0」，
     * 读者没法一眼分出「这几项是资产维度、那几项是战果维度」。
     */
    function StatRow(props) {
      const groups = Array.isArray(props && props.groups) ? props.groups : []
      return h('div', { className: 'rt-stats' }, groups.map((group) => h('div', {
        className: 'rt-stat-group',
        key: String(group.key || ''),
      }, (group.items || []).map((item) => h('div', { className: 'rt-stat', key: String(item.key) },
        h('span', { className: 'rt-stat__num' }, String(item.value === undefined || item.value === null ? '—' : item.value)),
        h('span', { className: 'rt-stat__label' }, item.label))))))
    }

    /**
     * 空态原语：左对齐、限宽、一句说明 + 最多一个动作；路径单独一行小号等宽。
     *
     * 原来的空态是整段居中、有时把本机路径塞在正文里 —— 一屏里只有它居中，读起来像报错。
     */
    function EmptyState(props) {
      return h('div', { className: 'rt-empty' },
        h('div', null, props.text || ''),
        props.path ? h('div', { className: 'rt-empty__path' }, props.path) : null,
        props.action ? h('div', { className: 'rt-empty__action' }, props.action) : null)
    }

    function Panel(props) {
      /* embedded：嵌在 dsh-purge 外层 dock 里时，不再自带收起/全面浏览/拖拽条，避免与外层按钮重叠 */
      const embedded = !!(props && props.embedded)
      const st = useUI()
      const [engagements, setEngagements] = React.useState([])
      const [eng, setEng] = React.useState(null)
      const [snapshot, setSnapshot] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [newName, setNewName] = React.useState('')
      const [geom, setGeom] = React.useState(loadRtGeom)
      const [creating, setCreating] = React.useState(false)
      const [refreshKey, setRefreshKey] = React.useState(0)
      const [digest, setDigest] = React.useState(null)
      const [seen, setSeen] = React.useState(null)

      React.useEffect(() => {
        if (embedded) return undefined
        try { window.localStorage.setItem(RT_GEOM_KEY, JSON.stringify(geom)) } catch (e) { /* 隐私模式 */ }
      }, [geom, embedded])
      React.useEffect(() => {
        if (embedded) return undefined
        const onResize = () => setGeom((g) => clampRtGeom(g))
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [embedded])

      const loadSnapshot = (id) => {
        if (!id) { setSnapshot(null); return }
        api({ op: 'snapshot', engagement: id }).then((r) => {
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d144')); return }
          setErr(null)
          setSnapshot(r)
        }, (e) => setErr(String((e && e.message) || e)))
      }

      const refreshList = (selectId) => {
        api({ op: 'bootstrap' }).then((b) => {
          setEngagements((b && b.engagements) || [])
          if (selectId) { setEng(selectId); loadSnapshot(selectId) }
        }, () => {})
      }

      React.useEffect(() => {
        api({ op: 'bootstrap' }).then((r) => {
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d723')); return }
          setEngagements(r.engagements || [])
          const id = r.current || (r.engagements && r.engagements[0] && r.engagements[0].id) || null
          if (id) { setEng(id); loadSnapshot(id) }
        }, (e) => setErr(String((e && e.message) || e)))
      }, [])

      const openEngagement = (nameArg) => {
        const name = String(nameArg || newName).trim()
        if (!name) return
        setCreating(true)
        api({ op: 'openEngagement', name: name }).then((r) => {
          setCreating(false)
          if (!r || r.ok === false) { setErr((r && r.error) || dt('drill.d724')); return }
          setNewName('')
          refreshList(r.engagement && r.engagement.id)
        }, (e) => { setCreating(false); setErr(String((e && e.message) || e)) })
      }

      /** 刷新：重新拉取名册/快照，并让当前页签重新取数。 */
      const refreshAll = () => {
        setRefreshKey((k) => k + 1)
        api({ op: 'bootstrap' }).then((b) => {
          setEngagements((b && b.engagements) || [])
          if (eng) loadSnapshot(eng)
        }, () => { if (eng) loadSnapshot(eng) })
      }

      const trackPointer = (e, move) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }
      const startDrag = (e) => {
        if (e.target && e.target.closest && e.target.closest('button,a,input,select,textarea,label')) return
        const sx = e.clientX
        const sy = e.clientY
        const ox = geom.x
        const oy = geom.y
        trackPointer(e, (ev) => setGeom((g) => clampRtGeom({ x: ox + (ev.clientX - sx), y: oy + (ev.clientY - sy), w: g.w, h: g.h })))
      }
      const startResizeLeft = (e) => {
        const sx = e.clientX
        const ox = geom.x
        const ow = geom.w
        trackPointer(e, (ev) => {
          const dx = ev.clientX - sx
          setGeom((g) => clampRtGeom({ x: ox + dx, y: g.y, w: ow - dx, h: g.h }))
        })
      }
      const startResizeRight = (e) => {
        const sx = e.clientX
        const ow = geom.w
        trackPointer(e, (ev) => setGeom((g) => clampRtGeom({ x: g.x, y: g.y, w: ow + (ev.clientX - sx), h: g.h })))
      }
      const startResizeBottom = (e) => {
        const sy = e.clientY
        const oh = geom.h
        trackPointer(e, (ev) => setGeom((g) => clampRtGeom({ x: g.x, y: g.y, w: g.w, h: oh + (ev.clientY - sy) })))
      }
      const startResizeCorner = (e) => {
        const sx = e.clientX
        const sy = e.clientY
        const ow = geom.w
        const oh = geom.h
        trackPointer(e, (ev) => setGeom((g) => clampRtGeom({ x: g.x, y: g.y, w: ow + (ev.clientX - sx), h: oh + (ev.clientY - sy) })))
      }

      /* 切靶标：重新读该靶标的未读快照，并立刻取一次摘要 */
      React.useEffect(() => {
        if (!eng) { setDigest(null); setSeen(null); return undefined }
        setSeen(loadUnread(eng))
        let alive = true
        let digestInflight = false
        const tick = () => {
          if (digestInflight) return        /* 上一轮还没回来，跳过这一轮，别把请求堆起来 */
          digestInflight = true
          api({ op: 'consoleDigest', engagement: eng }).then((r) => {
            if (alive && r && r.ok !== false && r.sections) setDigest(r.sections)
          }, () => { /* 网络异常：不打断，等下一轮 */ })
            .finally(() => { digestInflight = false })
        }
        tick()
        const timer = window.setInterval(tick, 25000)
        return () => { alive = false; window.clearInterval(timer) }
      }, [eng, refreshKey])

      /**
       * 打开某个页签 = 看过这个页签的内容：把当前摘要记成已读。
       * 没读过（第一次打开面板）不算新内容 —— 否则一进来满屏红点，反而看不出"哪里有新东西"。
       */
      const markTabSeen = React.useCallback((tab) => {
        if (!eng) return
        setSeen((prev) => {
          const base = prev || (() => {
            const fresh = {}
            for (const [k, v] of Object.entries((digest || {}))) fresh[k] = { count: Number(v.count || 0), at: v.at || null }
            return fresh
          })()
          const next = Object.assign({}, base)
          const cur = digest && digest[tab]
          if (cur) next[tab] = { count: Number(cur.count || 0), at: cur.at || null }
          saveUnread(eng, next)
          return next
        })
      }, [eng, digest])

      const unreadOf = (tab) => {
        if (!eng || !digest) return false
        if (!seen) return false
        return digestHasNew(seen[tab], digest[tab])
      }

      const stats = (snapshot && snapshot.stats) || {}
      const tabs = [
        ['assets', dt('drill.k30067')], ['env', dt('drill.k30068')], ['agents', dt('drill.k30069')], ['sessions', dt('drill.k30070')],
        ['findings', dt('drill.k30071')],
        ['chain', dt('drill.k30072')], ['scores', dt('drill.k30073')], ['report', dt('drill.k30074')],
        ['knowledge', dt('drill.k30075')],
        ['skills', dt('drill.k30076')],
      ]
      const full = isFullWindow()
      const openFull = () => {
        try { window.open(window.location.href.split('#')[0] + '#redteam-full', '_blank', 'noopener') } catch (e) { setErr(dt('drill.d725') + ((e && e.message) || e)) }
      }
      const exitFull = () => {
        /* 优先关掉脚本打开的窗口；关不掉就退回带侧栏的普通界面 */
        try { window.close() } catch (e) { /* 非脚本打开的窗口无法关闭 */ }
        try {
          if (window.location.hash) {
            window.location.hash = ''
            window.location.reload()
          }
        } catch (e) { /* ignore */ }
      }
      React.useEffect(() => {
        if (!full) return undefined
        const onKey = (e) => { if (e.key === 'Escape') exitFull() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [full])

      let body
      if (err) body = h('div', { className: 'rt-err' }, err)
      /* 全局页：没有靶标也能看（知识库 / 环境适配 / 技能库 / 智能体概览） */
      else if (st.tab === 'knowledge') body = h(KnowledgeTab, { refreshKey: refreshKey })
      else if (st.tab === 'env') body = h(EnvTab, { refreshKey: refreshKey })
      else if (st.tab === 'skills') body = h(SkillsTab, { refreshKey: refreshKey })
      else if (st.tab === 'agents') body = h(AgentsTab, { engagement: eng, refreshKey: refreshKey })
      else if (!eng) {
        body = h('div', { className: 'rt-pane' },
          h('div', { className: 'rt-card' },
            h('h4', null, dt('drill.d726')),
            h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
              dt('drill.d727')),
            h('div', { style: { display: 'flex', gap: 8 } },
              h('input', {
                className: 'rt-input', style: { flex: 1 }, placeholder: dt('drill.d728'),
                value: newName, onChange: (e) => setNewName(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') openEngagement() },
              }),
              h('button', { className: 'rt-btn rt-btn-primary', disabled: creating, onClick: () => openEngagement() },
                creating ? [dt('drill.k30077')] : dt('drill.d729')))))
      } else if (st.tab === 'assets') body = h(AssetsTab, { engagement: eng, snapshot: snapshot, refreshKey: refreshKey, onRefresh: refreshAll, onData: () => loadSnapshot(eng) })
      else if (st.tab === 'sessions') body = h(SessionTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'findings') body = h(FindingsTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'chain') body = h(ChainTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'report') body = h(ReportTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'scores') body = h(ScoreTab, { engagement: eng, refreshKey: refreshKey })
      else body = h('div', { className: 'rt-empty' }, dt('drill.d730'))

      const shellProps = full
        ? { className: 'rt-full', style: { display: 'flex' } }
        : embedded
          ? { className: 'rt-dock rt-embedded', 'data-open': '1', style: { width: '100%', display: 'flex' } }
          : {
              className: 'rt-dock',
              'data-open': st.open ? '1' : '0',
              style: {
                left: geom.x + 'px',
                top: geom.y + 'px',
                right: 'auto',
                bottom: 'auto',
                width: geom.w + 'px',
                height: geom.h + 'px',
                display: st.open ? 'flex' : 'none',
              },
            }

      return h('div', shellProps,
        (full || embedded) ? null : h('div', { className: 'rt-grip', title: dt('drill.d731'), onMouseDown: startResizeLeft }),
        (full || embedded) ? null : h('div', { className: 'rt-resize-r', title: dt('drill.d731'), onMouseDown: startResizeRight }),
        (full || embedded) ? null : h('div', { className: 'rt-resize-b', title: dt('drill.d732'), onMouseDown: startResizeBottom }),
        (full || embedded) ? null : h('div', { className: 'rt-resize-c', title: dt('drill.d733'), onMouseDown: startResizeCorner }),
        h('div', { className: 'rt-head', onMouseDown: (full || embedded) ? undefined : startDrag, title: (full || embedded) ? undefined : dt('drill.d734') },
          /* 页头在三处形态里都成立：主区（embedded）也要有标题与靶标选择，否则进来第一眼就是标签栏。 */
          h('div', { className: 'rt-title' },
            /* 状态点只在真有状态时出现：正常 / 警告（err） / 无靶标（不显示）。
               静态页挂一个永远绿的小圆点等于装饰，读的人会以为它在报什么。 */
            err ? h('span', { className: 'rt-dot rt-dot--warn', title: String(err) })
              : (eng && snapshot ? h('span', { className: 'rt-dot rt-dot--ok' }) : null),
            full ? [dt('drill.k30078')] : dt('drill.d735'),
            full ? h('span', { className: 'rt-tag', style: { marginLeft: 6 } }, dt('drill.d736')) : null),
          h('select', {
            className: 'rt-input rt-eng-select',
            style: { maxWidth: embedded ? '100%' : '170px', minWidth: embedded ? '160px' : undefined, flex: embedded ? '1 1 200px' : undefined },
            value: eng || '',
            onChange: (e) => {
              setEng(e.target.value)
              loadSnapshot(e.target.value)
              /* 同步「当前靶标」：原生 skill 目录按它解析技能根 */
              api({ op: 'activateEngagement', engagement: e.target.value }).catch(() => {})
            },
          },
            h('option', { value: '', disabled: true }, engagements.length ? [dt('drill.k30079')] : dt('drill.d737')),
            engagements.map((x) => h('option', { key: x.id, value: x.id }, x.name || x.id || dt('drill.d738'))),
          ),
          h('div', { className: 'rt-spacer' }),
          embedded ? null : h(VersionBar, null),
          full ? h('button', { className: 'rt-btn', title: dt('drill.d739'), onClick: exitFull }, dt('drill.d740')) : null,
          /* 刷新是这一页的主操作：强调色只给它（页签用下划线，不用色块）。 */
          h('button', { className: 'rt-btn', title: dt('drill.d741'), onClick: refreshAll }, dt('drill.d82')),
          (full || embedded) ? null : h('button', { className: 'rt-btn', title: dt('drill.d742'), onClick: openFull }, dt('drill.d743')),
          (full || embedded) ? null : h('button', { className: 'rt-btn', title: dt('drill.d744'), onClick: () => setUI({ open: false }) }, dt('drill.d745'))),
        /* 页签栏用标准 tablist/tab 角色：读屏软件据此播报「第几个页签、是否选中」。
           键盘用户 Tab 进来后可用 Enter/Space 切换（由 clickable 提供）。 */
        h('div', { className: 'rt-tabs', role: 'tablist' }, tabs.map((t) => {
          const activate = () => {
            markTabSeen(t[0])
            setUI({ tab: t[0] })
            /* 强制当前页重新取数，避免切页后仍显示上一页缓存视觉 */
            setRefreshKey((k) => k + 1)
          }
          return h('div', Object.assign({}, clickable(activate, { label: t[1] }), {
            key: t[0], className: 'rt-tab' + (st.tab === t[0] ? ' on' : ''),
            role: 'tab',
            'aria-selected': st.tab === t[0] ? 'true' : 'false',
            title: unreadOf(t[0]) ? t[1] + [dt('drill.k30080')] : t[1],
          }), t[1], unreadOf(t[0])
            /* 红点是纯视觉信息，给读屏软件一个文字替代 */
            ? h('span', { className: 'rt-tab-dot', 'aria-label': dt('drill.d746') })
            : null)
        })),
        h('div', { className: 'rt-body', key: 'body-' + st.tab }, h(RtBoundary, { key: st.tab }, body)),
        h('div', { className: 'rt-foot' },
          h(StatRow, {
            groups: [
              {
                key: 'assets',
                items: [
                  { key: 'segments', label: dt('drill.d747').trim(), value: stats.segments || 0 },
                  { key: 'assets', label: dt('drill.d264').trim(), value: stats.assets || 0 },
                  { key: 'live', label: dt('drill.d748').replace(/[（）()]/g, '').trim(), value: stats.liveAssets || 0 },
                  { key: 'ports', label: dt('drill.d305').trim(), value: stats.openPorts || 0 },
                  { key: 'fingerprints', label: dt('drill.d749').trim(), value: stats.fingerprints || 0 },
                ],
              },
              { key: 'vulns', items: [{ key: 'vulns', label: dt('drill.d306').trim(), value: stats.vulns || 0 }] },
              {
                key: 'signals',
                items: [{
                  key: 'signals',
                  label: dt('drill.d750').trim(),
                  value: (stats.passiveSignals || 0) + '/' + (stats.activeSignals || 0),
                }],
              },
            ],
          }),
          h('div', { className: 'rt-spacer' }),
          full ? h('span', null, dt('drill.d751')) : null,
          h('span', null, 'SQLite · ' + (snapshot && snapshot.engagement ? snapshot.engagement.name : ''))))
    }

    /* ---------------------------------------------------------- 入口按钮 */
    function SidebarButton(props) {
      const st = useUI()
      return h('button', {
        className: 'rt-icon-btn' + (st.open ? ' on' : ''),
        title: dt('drill.d752'),
        onClick: () => setUI({ open: !st.open }),
      }, h('span', { style: { fontSize: 14 } }, '⛨'), props.wide ? h('span', null, 'RedTeam') : null)
    }

    function HeaderButton() {
      const st = useUI()
      return h('button', {
        className: 'rt-hbtn' + (st.open ? ' on' : ''),
        title: dt('drill.d752'),
        onClick: () => setUI({ open: !st.open }),
      }, '⛨ RedTeam')
    }

    /** 侧栏「全面浏览」：在新浏览器窗口打开完整演练台（当前窗口不受影响）。 */
    function FullButton(props) {
      const open = () => {
        try { window.open(window.location.href.split('#')[0] + '#redteam-full', '_blank', 'noopener') } catch { /* 被浏览器拦截 */ }
      }
      return h('button', {
        className: 'rt-icon-btn',
        title: dt('drill.d753'),
        onClick: open,
      }, h('span', { style: { fontSize: 14 } }, '⛶'), props.wide ? h('span', null, dt('drill.d743')) : null)
    }

    /* ---------------------------------------------------------- 插件入口 */
    /** 唯一硬依赖：座位注册表。 */
    const inject = ['slots']

    /**
     * 注入样式 + 三处座位。样式标签与宽度变量随 fiber 卸载一起移除。
     * @param ctx - 客户端根上下文。
     */
    /**
     * 构建期锚点：本函数体在装配时被整段换成 applyDrillParts()（见 scripts/build-client.mjs），
     * 因为它不再自己注册座位 —— 演练台的座位由 shell.js 统一注册，这里只负责导出 CSS / Panel。
     * 原来挂在这里的三处注册（浮层演练台、侧栏两个按钮、会话头按钮）在产物里从未生效，属死代码。
     */
    function applyDrillParts() {
      return { CSS: CSS, Panel: Panel, setUI: setUI, useUI: useUI, isFullWindow: isFullWindow, setDockWidth: setDockWidth };
    }

    exports.inject = inject
			return applyDrillParts();
		})();
/* __DSH_PURGE_DRILL_END__ */

		const AUTH_KEY = "dsh-purge-drill-auth";
		/* __DSHP_SRC:welcome-helpers:BEGIN__ */
		const WELCOME_KEY = "dsh-purge-user-notice-v1";
		function readWelcomeAck() {
			try { return window.localStorage.getItem(WELCOME_KEY) === "1"; } catch { return false; }
		}
		function writeWelcomeAck() {
			try { window.localStorage.setItem(WELCOME_KEY, "1"); } catch { /* ignore */ }
		}
		/* __DSHP_SRC:welcome-helpers:END__ */

		/* 授权状态的三件套：本地乐观值 / 在途请求计数 / 代号防串。
		   都靠才 writeDrillAuth 与 syncDrillGrant 的乱序回包竞争才需要 ——
		   它们不是 UI 状态，别塞进 dockBus。 */
		let drillGrantGen = 0;
		let drillGrantPosting = 0;
		let drillGrantState = { ready: false, granted: false };
		let drillSyncRetryTimer = null;
		/* 片段世界的「卸载」就是热替换装载新闭包：旧闭包的 timer 与迟到回包摸不到
		   新闭包的变量，跨闭包唯一的共同锚是 window。装载时推进一次 epoch，
		   旧闭包的回调见到 epoch 不一致即自停 —— 这是 drillSyncRetryTimer
		   只能清同闭包 timer 的兜底。 */
		const AUTH_EPOCH = (window.__dshPurgeAuthEpoch = (window.__dshPurgeAuthEpoch || 0) + 1);

		function readDrillAuth() {
			if (drillGrantState.ready) return drillGrantState.granted;
			try { return window.localStorage.getItem(AUTH_KEY) === "1"; } catch { return false; }
		}
		function setDrillAuthLocal(ok) {
			try {
				if (ok) window.localStorage.setItem(AUTH_KEY, "1");
				else window.localStorage.removeItem(AUTH_KEY);
			} catch { /* ignore */ }
			drillGrantState = { ready: true, granted: !!ok };
		}
		function writeDrillAuth(ok) {
			drillGrantGen += 1;
			const gen = drillGrantGen;
			setDrillAuthLocal(ok);
			if (!ok) return;
			drillGrantPosting += 1;
			fetch("/dsh-purge/drill-grant", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}).then((r) => r.json()).then((saved) => {
				if (gen !== drillGrantGen) return;
				setDrillAuthLocal(!!(saved && saved.granted));
			}).catch(() => { /* 页面先记住，下次同步再写入当前安装目录 */ })
				.finally(() => { drillGrantPosting = Math.max(0, drillGrantPosting - 1); });
		}
		function syncDrillGrant(attempt) {
			const n = attempt || 0;
			const gen = drillGrantGen;
			/* 复位上一次调度的重试 timer,避免多次 writeDrillAuth 叠加链条 */
			if (drillSyncRetryTimer) { try { clearTimeout(drillSyncRetryTimer); } catch { /* ignore */ } drillSyncRetryTimer = null; }
			fetch("/dsh-purge/drill-grant", { method: "GET" })
				.then((r) => r.json())
				.then((r) => {
					if (AUTH_EPOCH !== window.__dshPurgeAuthEpoch) return;
					if (gen !== drillGrantGen) return;
					if (!r || r.ok === false) throw new Error("grant");
					if (r.granted) {
						setDrillAuthLocal(true);
						if (dockBus.authOpen) setDock({ authOpen: false });
						return;
					}
					if (drillGrantPosting > 0) return;
					setDrillAuthLocal(false);
					if (dockBus.authOpen || dockBus.tab === "drill") {
						setDock({ open: true, tab: "drill", authOpen: true, pending: dockBus.pending || "tab" });
					}
				})
				.catch(() => {
					if (AUTH_EPOCH !== window.__dshPurgeAuthEpoch) return;
					if (gen !== drillGrantGen) return;
					if (n < 5) {
						drillSyncRetryTimer = window.setTimeout(() => {
							drillSyncRetryTimer = null;
							if (AUTH_EPOCH !== window.__dshPurgeAuthEpoch) return;
							syncDrillGrant(n + 1);
						}, 400);
					}
				});
		}

		let dockBus = { open: false, tab: "clean", authOpen: false, pending: "tab", listeners: new Set() };
		function getDock() { return dockBus; }
		function setDock(patch) {
			dockBus = { ...dockBus, ...patch };
			dockBus.listeners.forEach((fn) => { try { fn(dockBus); } catch { /* ignore */ } });
		}
		function useDock() {
			const [st, setSt] = useState(dockBus);
			useEffect(() => {
				const fn = (next) => setSt(next);
				dockBus.listeners.add(fn);
				return () => { dockBus.listeners.delete(fn); };
			}, []);
			return st;
		}

		function requestDrill(kind) {
			const pending = kind || "tab";
			const openEnv = () => {
				try {
					if (__dshPurgeDrill && __dshPurgeDrill.setUI) {
						__dshPurgeDrill.setUI({ open: true, tab: "env" });
					}
				} catch { /* ignore */ }
			};
			if (readDrillAuth()) {
				setDock({ open: true, tab: "drill", authOpen: false, pending: "tab" });
				try { if (__dshPurgeDrill && __dshPurgeDrill.setUI) __dshPurgeDrill.setUI({ open: true }); } catch { /* ignore */ }
				if (pending === "env") openEnv();
				if (pending === "full") {
					try { window.open(window.location.href.split("#")[0] + "#redteam-full", "_blank", "noopener"); } catch { /* ignore */ }
				}
				return;
			}
			/* 未授权：直接切到演练台页签并弹出授权窗（不再停在清洗页，避免像「没触发」） */
			setDock({ open: true, tab: "drill", authOpen: true, pending: pending });
		}

		function requestDrillEnv() {
			requestDrill("env");
		}

		function openDockClean() {
			setDock({ open: true, tab: "clean", authOpen: false, pending: "tab" });
		}
		function toggleDock() {
			if (dockBus.open) setDock({ open: false, authOpen: false, pending: "tab" });
			else openDockClean();
		}
		syncDrillGrant();

		/* __DSHP_SRC:welcome-notice:BEGIN__ */
		function WelcomeNotice() {
			const t = useT();
			const [open, setOpen] = useState(() => !readWelcomeAck());
			const [checked, setChecked] = useState(false);
			if (!open) return null;
			const repo = t("welcome.repo");
			const node = h("div", { className: "dshp-auth-mask", role: "dialog", "aria-modal": "true" },
				h("div", { className: "dshp-auth-modal", style: { width: "min(560px,100%)" } },
					h("h2", null, t("welcome.title")),
					h("div", { className: "muted", style: { color: "var(--dsw-alias-label-secondary,#999)", fontSize: 12 } }, t("welcome.lead")),
					h("div", { className: "dshp-auth-warn" }, t("welcome.warn")),
					h("div", { className: "dshp-auth-legal", style: { height: "auto", maxHeight: 280 } },
						h("p", null, t("welcome.body")),
						h("p", null,
							h("a", {
								href: repo,
								target: "_blank",
								rel: "noopener noreferrer",
								style: { color: "var(--dsw-alias-label-brand, #8fbf9a)", wordBreak: "break-all" },
							}, repo),
						),
						h("h3", null, t("welcome.bans")),
						h("p", null, t("welcome.ban1")),
						h("p", null, t("welcome.ban2")),
						h("p", null, t("welcome.ban3")),
					),
					h("div", { className: "dshp-auth-checks" },
						h("label", null,
							h("input", {
								type: "checkbox",
								checked: checked,
								onChange: (e) => setChecked(!!(e && e.target && e.target.checked)),
							}),
							h("span", null, t("welcome.check")),
						),
					),
					h("div", { className: "dshp-auth-ops" },
						h("button", {
							type: "button",
							className: "primary",
							disabled: !checked,
							onClick: () => {
								if (!checked) return;
								writeWelcomeAck();
								setOpen(false);
							},
						}, t("welcome.ok")),
					),
				),
			);
			// 不再走 portal：本组件注册在宿主的 shell.overlay 座位上，
			// 那个座位本身就是盖在整页之上的浮层容器，再 portal 一次只是把同一个节点
			// 从浮层里搬出来，反而让「谁盖谁」取决于插入顺序。
			return node;
		}
		/* __DSHP_SRC:welcome-notice:END__ */

		/* 授权确认窗的声明正文（docs/drill-auth-legal.html 的逐字节副本）。 */
		const AUTH_LEGAL_HTML = "<h3>严正法律免责与合规使用声明</h3>\r\n    <p>本声明在进入演练台前必须全文阅读。本项目是非营利开源项目，遵守国家法律法规及所在平台的规范，仅供学习与研究、技术参考。严禁任何主体把本项目用于商业售卖、付费倒卖或黑灰产牟利。</p>\r\n    <p>开发者坚决反对并严禁任何形式的违法犯罪，绝不支持、不鼓励、不协助未授权网络攻击、漏洞利用、数据窃取、非法侵入计算机信息系统，或生成违法违禁内容。任何将本项目用于违法犯罪的行为，均与开发者无关，由行为人依法独立承担全部法律责任。不得以科研、教学、测试、演示或内部学习为由规避下列条款。</p>\r\n    <h3>1. 本仓库不含违法内容</h3>\r\n    <p>dsh-purge 发布的代码、文档、补丁与默认提示词不是木马、后门、未授权渗透工具、勒索软件、撞库脚本，也不是针对公网或第三方系统的攻击载荷。项目不提供违法内容，也不教唆、组织、协助实施违法犯罪。</p>\r\n    <h3>2. 本机操作不构成对外授权</h3>\r\n    <p>应用补丁、写入、回滚、卸载，都在本机文件和本机进程内完成。这些操作不对任何公网主机或未授权系统进行扫描、探测、入侵或攻击发包，也不得把本机当作跳板。</p>\r\n    <p>插件若开启检测更新，仅可能访问本插件自己的 GitHub 仓库以核对版本。该访问与对第三方系统的网络攻击无关，不能被解释为对外渗透的授权。</p>\r\n    <h3>3. 允许使用的范围</h3>\r\n    <p>只允许用在你能证明有权处理的环境：本人有权管理的本机官方 Harness；离线的本地合成靶标；所有者已经出具合法书面授权的网络安全演练靶场；合规实验室里的受控环境。书面授权要能对应具体目标、时间和范围。只填写一个单位名称，或只有口头说法，不构成授权。</p>\r\n    <p>未经所有者合法书面授权的目标、公网在线系统、生产业务，以及能源、交通、水利、金融、公共服务、电子政务等关键信息基础设施，都不得作为演练对象。</p>\r\n    <h3>4. 必须遵守的法律，按条、款</h3>\r\n    <p>《中华人民共和国刑法》第二百八十五条第一款：禁止违反国家规定，侵入国家事务、国防建设、尖端科学技术领域的计算机信息系统。</p>\r\n    <p>同条第二款：禁止侵入前款规定以外的计算机信息系统，或者用其他技术手段，获取该系统中存储、处理或者传输的数据，或者对该系统实施非法控制。</p>\r\n    <p>同条第三款：禁止提供专门用于侵入、非法控制计算机信息系统的程序、工具；明知他人实施侵入、非法控制而为其提供程序、工具，同样禁止。</p>\r\n    <p>第二百八十六条第一款：禁止对计算机信息系统功能进行删除、修改、增加、干扰，造成系统不能正常运行。</p>\r\n    <p>同条第二款：禁止对系统中存储、处理或者传输的数据和应用程序进行删除、修改、增加。</p>\r\n    <p>同条第三款：禁止故意制作、传播计算机病毒等破坏性程序，影响计算机系统正常运行。</p>\r\n    <p>第二百八十七条：禁止利用计算机实施金融诈骗、盗窃、贪污、挪用公款、窃取国家秘密或者其他犯罪。</p>\r\n    <p>第二百八十七条之一第一款第（一）项：禁止设立用于实施诈骗、传授犯罪方法、制作或者销售违禁物品、管制物品等违法犯罪活动的网站、通讯群组。</p>\r\n    <p>同款第（二）项：禁止发布有关制作或者销售毒品、枪支、淫秽物品等违禁物品、管制物品或者其他违法犯罪的信息。</p>\r\n    <p>同款第（三）项：禁止为实施诈骗等违法犯罪活动发布信息。</p>\r\n    <p>第二百八十七条之二：禁止明知他人利用信息网络实施犯罪，仍为其提供技术支持，或者提供广告推广、支付结算等帮助。</p>\r\n    <p>第二百五十三条之一第一款、第三款：禁止向他人出售或者提供公民个人信息；禁止窃取或者以其他方法非法获取公民个人信息。</p>\r\n    <p>《中华人民共和国网络安全法》第十三条第二款：使用网络不得危害网络安全，不得利用网络从事危害国家安全、荣誉和利益，煽动颠覆国家政权、推翻社会主义制度，煽动分裂国家、破坏国家统一，宣扬恐怖主义、极端主义，宣扬民族仇恨、民族歧视，传播暴力、淫秽色情信息，编造、传播虚假信息扰乱经济秩序和社会秩序，以及侵害他人名誉、隐私、知识产权和其他合法权益等活动。</p>\r\n    <p>第十四条：禁止利用网络从事危害未成年人身心健康的活动。</p>\r\n    <p>第二十九条：禁止非法侵入他人网络、干扰他人网络正常功能、窃取网络数据；禁止提供专门用于侵入网络、干扰网络正常功能及防护措施、窃取网络数据的程序、工具；明知他人从事危害网络安全的活动，禁止为其提供技术支持、广告推广、支付结算等帮助。</p>\r\n    <p>第三十三条：公共通信和信息服务、能源、交通、水利、金融、公共服务、电子政务等关键信息基础设施实行重点保护。未获合法授权，不得侵入、干扰或破坏。</p>\r\n    <p>第四十六条：禁止窃取或者以其他非法方式获取个人信息，禁止非法出售或者非法向他人提供个人信息。</p>\r\n    <p>第四十八条：禁止设立用于实施诈骗，传授犯罪方法，制作或者销售违禁物品、管制物品等违法犯罪活动的网站、通讯群组；禁止利用网络发布涉及上述违法犯罪活动的信息。</p>\r\n    <p>第五十条：发送的电子信息、提供的应用软件不得设置恶意程序，不得含有法律、行政法规禁止发布或者传输的信息。</p>\r\n    <p>《中华人民共和国数据安全法》第八条：开展数据处理活动，不得危害国家安全、公共利益，不得损害个人、组织的合法权益。</p>\r\n    <p>第三十二条第一款：收集数据应当采取合法、正当的方式，不得窃取或者以其他非法方式获取数据。</p>\r\n    <p>同条第二款：法律、行政法规对收集、使用数据的目的和范围有规定的，只能在该目的和范围内收集、使用。</p>\r\n    <p>第五十一条：窃取或者以其他非法方式获取数据，或者因此损害个人、组织合法权益的，依照有关法律、行政法规处罚。</p>\r\n    <p>《中华人民共和国个人信息保护法》第五条：处理个人信息应当合法、正当、必要、诚信，不得通过误导、欺诈、胁迫等方式处理。</p>\r\n    <p>第六条第一款、第二款：处理个人信息应当具有明确、合理的目的，并与该目的直接相关，采取对个人权益影响最小的方式；收集限于实现处理目的的最小范围，不得过度收集。</p>\r\n    <p>第十条：禁止非法收集、使用、加工、传输他人个人信息，禁止非法买卖、提供或者公开他人个人信息；禁止从事危害国家安全、公共利益的个人信息处理活动。</p>\r\n    <p>第十三条：没有取得个人同意，也不属于订立履行合同所必需、履行法定职责、应对突发、公共利益新闻舆论、处理本人已经合法公开的信息，以及法律行政法规规定的其他情形之一的，不得处理个人信息。</p>\r\n    <p>第二十八条、第二十九条：生物识别、医疗健康、金融账户、行踪轨迹，以及不满十四周岁未成年人的个人信息，属于敏感个人信息。没有特定目的、充分必要性和严格保护措施，并且没有取得个人单独同意的，不得处理。</p>\r\n    <p>此外还须遵守其他现行有效的法律、行政法规、监管规定，以及所使用模型的服务条款与滥用政策。</p>\r\n    <h3>5. 据此禁止的方向</h3>\r\n    <p>未授权进入。禁止把没有书面授权的单位、域名、地址、公网系统、生产业务或关键信息基础设施登记为靶标，禁止对其扫描、探测、侵入、控制或发包。对应刑法第二百八十五条第一款、第二款，网络安全法第二十九条、第三十三条。</p>\r\n    <p>破坏与恶意程序。禁止删除、修改、增加、干扰他人系统功能或其中的数据、应用程序；禁止制作、传播病毒、勒索程序或其他破坏性程序；禁止在信息或软件中设置恶意程序。对应刑法第二百八十六条第一款至第三款，网络安全法第五十条。</p>\r\n    <p>工具与帮助。禁止把本项目或本机提供给他人，用于侵入、非法控制或窃取数据；禁止明知对方在实施网络犯罪，仍提供程序、工具、技术支持、广告推广或支付结算。对应刑法第二百八十五条第三款、第二百八十七条之二，网络安全法第二十九条。</p>\r\n    <p>数据。禁止窃取、非法收集、超范围使用、泄露、出售或向他人提供业务数据、账号、口令和其他受保护数据。对应数据安全法第八条、第三十二条、第五十一条。</p>\r\n    <p>个人信息。禁止非法收集、使用、加工、传输、买卖、提供或公开他人个人信息；禁止过度收集；禁止以误导、欺诈、胁迫方式处理；禁止擅自处理生物识别、医疗健康、金融账户、行踪轨迹和儿童个人信息。对应刑法第二百五十三条之一第一款、第三款，网络安全法第四十六条，个人信息保护法第五条、第六条、第十条、第十三条、第二十八条、第二十九条。</p>\r\n    <p>诈骗与违法信息。禁止设立或利用网站、群组实施诈骗、传授犯罪方法、制作或销售违禁物品、管制物品；禁止发布此类信息；禁止利用计算机实施诈骗、盗窃、贪污、挪用公款、窃取国家秘密。对应刑法第二百八十七条、第二百八十七条之一第一款第（一）项至第（三）项，网络安全法第四十八条。</p>\r\n    <p>内容。禁止生成或传播危害国家安全、荣誉和利益的内容，禁止煽动颠覆、分裂，禁止恐怖主义、极端主义、民族仇恨，禁止暴力、淫秽色情、赌博，禁止编造虚假信息扰乱经济秩序和社会秩序，禁止侵害名誉、隐私、知识产权，禁止危害未成年人身心健康的内容。对应网络安全法第十三条第二款、第十四条。</p>\r\n    <p>结果扩散。演练中形成的记录、资产信息和文件，只留在书面授权写明的目标和期限里，不得交给无权获知的人，也不得改作授权以外的用途。</p>\r\n    <h3>6. 责任由使用者承担</h3>\r\n    <p>本项目依据 MIT 协议按现状提供。开发者不就完整性、安全性与适用性作保证。使用者对自己的下载、部署、运行、修改、传播，以及全部输入与输出，承担独立、完全的民事、行政及刑事法律责任。作者与贡献者不承担因滥用产生的直接、间接或连带责任。</p>\r\n    <p>勾选确认的是操作者本人，不能代替没有阅读本声明的人，也不能把别人的系统说成已经授权。</p>\r\n    <h3>7. 违约即终止授权</h3>\r\n    <p>一旦用于非法攻击、恶意活动或上述任一禁止方向，使用许可自该行为发生之日起自动终止，且不可撤销。必须立即停止使用，并销毁本项目的代码、脚本与衍生数据，依法承担责任。授权终止后，演练台不得继续打开或继续使用。</p>\r\n    <h3>8. 与 DeepSeek 官方的关系</h3>\r\n    <p>本项目是独立的开源项目，与 DeepSeek 官方或其关联主体没有隶属、商业合作、授权或官方背书。文中的「官方」只表示评测对象是使用者本机安装的官方 DeepSeek Harness 软件包，不代表 DeepSeek 官方开发、认可或担保本插件。</p>\r\n    <p>文末。倒计时结束、滚到这里并勾选全部三项，才表示你以本人身份认可本声明，并完成本次演练台授权。</p>";

		function AuthGate(props) {
			const t = useT();
			const [left, setLeft] = useState(10);
			const [readEnd, setReadEnd] = useState(false);
			const [checks, setChecks] = useState({ read: false, scope: false, ban: false });
			const legalRef = useRef(null);
			useEffect(() => {
				const id = window.setInterval(() => {
					setLeft((n) => {
						if (n <= 1) { window.clearInterval(id); return 0; }
						return n - 1;
					});
				}, 1000);
				return () => window.clearInterval(id);
			}, []);
			useEffect(() => {
				const el = legalRef.current;
				if (!el) return;
				if (el.scrollHeight <= el.clientHeight + 4) setReadEnd(true);
			}, []);
			const locked = left > 0 || !readEnd;
			const ready = !locked && checks.read && checks.scope && checks.ban;
			const hint = left > 0
				? t("auth.hint.wait").replace("{n}", String(left))
				: (readEnd ? t("auth.hint.check") : t("auth.hint.scroll"));
			const onScroll = () => {
				const el = legalRef.current;
				if (!el) return;
				if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) setReadEnd(true);
			};
			const toggle = (id) => {
				if (locked) return;
				setChecks((prev) => ({ ...prev, [id]: !prev[id] }));
			};
			const okLabel = !ready
				? t("auth.ok")
				: (props.pending === "full"
					? t("auth.ok.full")
					: (props.pending === "env" ? t("auth.ok.env") : t("auth.ok.tab")));
			return h("div", { className: "dshp-auth-mask", role: "dialog", "aria-modal": "true" },
				h("div", { className: "dshp-auth-modal" },
					h("h2", null, t("auth.title")),
					h("div", { className: "muted", style: { color: "var(--dsw-alias-label-secondary,#999)", fontSize: 12 } }, t("auth.lead")),
					h("div", { className: "dshp-auth-warn" }, t("auth.warn")),
					h("div", {
						className: "dshp-auth-legal",
						ref: legalRef,
						onScroll,
						dangerouslySetInnerHTML: { __html: AUTH_LEGAL_HTML },
					}),
					h("div", { style: { color: "var(--dsw-alias-label-secondary,#999)", fontSize: 12 } }, hint),
					h("div", { className: "dshp-auth-checks" },
						[["read", "auth.check.read"], ["scope", "auth.check.scope"], ["ban", "auth.check.ban"]].map((row) =>
							h("label", { key: row[0], className: locked ? "locked" : "" },
								h("input", {
									type: "checkbox",
									checked: !!checks[row[0]],
									disabled: locked,
									onChange: () => toggle(row[0]),
								}),
								h("span", null, t(row[1])),
							),
						),
					),
					h("div", { className: "dshp-auth-ops" },
						h("button", { type: "button", onClick: () => setDock({ authOpen: false, tab: "clean", pending: "tab" }) }, t("auth.no")),
						h("button", {
							type: "button",
							className: "primary",
							disabled: !ready,
							onClick: () => {
								if (!ready) return;
								writeDrillAuth(true);
								const kind = props.pending || "tab";
								setDock({ authOpen: false, open: true, tab: "drill", pending: "tab" });
								try { if (__dshPurgeDrill && __dshPurgeDrill.setUI) __dshPurgeDrill.setUI({ open: true }); } catch { /* ignore */ }
								if (kind === "env") {
									try { if (__dshPurgeDrill && __dshPurgeDrill.setUI) __dshPurgeDrill.setUI({ open: true, tab: "env" }); } catch { /* ignore */ }
								}
								if (kind === "full") {
									try { window.open(window.location.href.split("#")[0] + "#redteam-full", "_blank", "noopener"); } catch { /* ignore */ }
								}
							},
						}, okLabel),
					),
				),
			);
		}

		/* CSS 选择器是 DOM 契约不是文案：它跟着 env-gate 的探测逻辑走，与语言无关，
		 * 不许塞进 i18n 词典（词典里出现选择器等于把宿主 DOM 假设藏进翻译层）。
		 * 串里的「红队」写作 \u 转义：中文字面量门禁按源文本判用户可见文案，
		 * 这里是查询条件不是文案，注释里保留原词方便检索。 */
		const REDTEAM_PRESET_LABEL_SELECTOR = "[class*='label' i][class*='preset' i], [class*='presetLabel' i], [title*='\u7ea2\u961f'], [title*='RedTeam']";

		function isRedteamPresetId(value) {
			const text = String(value || "").trim();
			if (!text) return false;
			if (text === "redteam") return true;
			if (/^red[\s_-]*team$/i.test(text)) return true;
			const label = text.replace(/不是红队/g, "").replace(/非红队/g, "");
			if (/红队/.test(label)) return true;
			return false;
		}

		function readSessionAgentPreset(sess) {
			if (!sess || typeof sess !== "object") return "";
			try {
				const pv = sess.projectionValues;
				if (pv && typeof pv.agentPreset === "string") return pv.agentPreset;
			} catch { /* ignore */ }
			try {
				if (typeof sess.agentPreset === "string") return sess.agentPreset;
			} catch { /* ignore */ }
			try {
				const header = sess.header;
				if (header && typeof header.agentPreset === "string") return header.agentPreset;
			} catch { /* ignore */ }
			return "";
		}

		function readSessionCwd(sess) {
			if (!sess || typeof sess !== "object") return "";
			try {
				const pv = sess.projectionValues;
				if (pv && typeof pv.cwd === "string" && pv.cwd.trim()) return pv.cwd.trim();
			} catch { /* ignore */ }
			try {
				if (typeof sess.cwd === "string" && sess.cwd.trim()) return sess.cwd.trim();
			} catch { /* ignore */ }
			try {
				const header = sess.header;
				if (header && typeof header.cwd === "string" && header.cwd.trim()) return header.cwd.trim();
			} catch { /* ignore */ }
			return "";
		}

		function clientCurrentCwd() {
			try {
				const sessions = rewindSessions || (rewindHost && rewindHost.sessions);
				if (!sessions) return "";
				const sid = currentSessionId(sessions);
				if (!sid) return "";
				try {
					const snap = typeof sessions.list?.getSnapshot === "function" ? sessions.list.getSnapshot() : null;
					const sess = snap && snap.byId ? snap.byId[sid] : null;
					const found = readSessionCwd(sess);
					if (found) return found;
				} catch { /* ignore */ }
				try {
					const actx = typeof sessions.scope === "function" ? sessions.scope(sid) : undefined;
					const face = typeof sessions.sessionOf === "function" ? sessions.sessionOf(actx) : undefined;
					const faceSnap = face && typeof face.getSnapshot === "function" ? face.getSnapshot() : face;
					const found = readSessionCwd(faceSnap);
					if (found) return found;
				} catch { /* ignore */ }
			} catch { /* ignore */ }
			return "";
		}

		function isRedteamModeActive() {
			try {
				const sessions = rewindSessions || (rewindHost && rewindHost.sessions);
				const sid = currentSessionId(sessions);
				if (sid && sessions) {
					try {
						const snap = typeof sessions.list?.getSnapshot === "function" ? sessions.list.getSnapshot() : null;
						const sess = snap && snap.byId ? snap.byId[sid] : null;
						if (isRedteamPresetId(readSessionAgentPreset(sess))) return true;
					} catch { /* ignore */ }
					try {
						const actx = typeof sessions.scope === "function" ? sessions.scope(sid) : undefined;
						const face = typeof sessions.sessionOf === "function" ? sessions.sessionOf(actx) : undefined;
						const faceSnap = face && typeof face.getSnapshot === "function" ? face.getSnapshot() : face;
						if (isRedteamPresetId(readSessionAgentPreset(faceSnap))) return true;
					} catch { /* ignore */ }
				}
			} catch { /* ignore */ }
			/* 新会话：模式下拉里的「红队模式」chip（选好但还没写入 session）
			 * 优先走语义化 data-* 挂点,其次 class 子串模糊匹配 + 文本兜底;
			 * 不写死 CSS Module 哈希(HKgFRW_seat 这种每次构建都会变)。 */
			try {
				const semantic = document.querySelector(
					"[data-agent-preset='redteam'], [data-preset-id='redteam'], [data-mode='redteam']"
				);
				if (semantic) return true;
				const nodes = document.querySelectorAll(
					"[class*='seat' i][class*='label' i], [class*='seatLabel' i], button[class*='seat' i], [role='button'][class*='seat' i]"
				);
				for (const el of nodes) {
					const text = String(el.textContent || "").replace(/\s+/g, " ").trim();
					if (/红队模式/.test(text) || /^RedTeam\b/i.test(text)) return true;
				}
			} catch { /* ignore */ }
			try {
				const labels = document.querySelectorAll(REDTEAM_PRESET_LABEL_SELECTOR);
				for (const el of labels) {
					const text = String(el.textContent || "").trim();
					if (/红队模式/.test(text) || /^RedTeam\b/i.test(text)) return true;
					if (isRedteamPresetId(text)) return true;
				}
			} catch { /* ignore */ }
			return false;
		}

		function looksLikeSendControl(el) {
			if (!el || el.nodeType !== 1) return false;
			const btn = el.closest("button, [role='button']");
			if (!btn) return false;
			if (btn.closest(".dshp-dock, .dshp-auth-mask, .rt-dock, .dshp-env-gate")) return false;
			const label = [
				btn.getAttribute("aria-label"),
				btn.getAttribute("title"),
				btn.getAttribute("data-testid"),
				btn.textContent,
			].filter(Boolean).join(" ");
			if (/停止|Stop/i.test(label) && !/发送|Send/i.test(label)) return false;
			if (/发送|Submit|Send(?!\s*feedback)/i.test(label)) return true;
			/* composer 主按钮：data-composer-card 内的 primary */
			try {
				const card = btn.closest("[data-composer-card], [data-composer-seat]");
				if (card) {
					const cls = String(btn.className || "");
					if (/primary/i.test(cls) && btn.querySelector("svg")) return true;
				}
			} catch { /* ignore */ }
			if (btn.type === "submit") {
				const form = btn.closest("form");
				if (form && form.querySelector("textarea, [contenteditable='true']")) return true;
			}
			return false;
		}

		function fetchEnvAdaptStatus() {
			return fetch("/redteam/api", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ op: "platformEnvAdaptStatus" }),
			}).then((r) => r.json()).catch(() => null);
		}

		/** 同步探测的占位：不再做同步 XHR（会卡 UI 主线程、Chrome 已逐步弃用）。
		 * 调用方 mustBlockSubmit 在 cache 过期/缺失时按"未知→保守 block"处理,
		 * 同时 EnvAdaptSendGate 的 useEffect 轮询会异步 refresh,下次调用即可放行。 */
		function fetchEnvAdaptStatusSync() { return null; }

		/** 红队发送前门禁：未就绪 → 授权并打开环境适配；可确认跳过。 */
		function EnvAdaptSendGate() {
			const t = useT();
			const [open, setOpen] = useState(false);
			const [confirmSkip, setConfirmSkip] = useState(false);
			const [status, setStatus] = useState(null);
			const [busy, setBusy] = useState(false);
			const cacheRef = useRef({ at: 0, ready: false });
			const openRef = useRef(false);
			openRef.current = open;

			const refresh = useCallback(async () => {
				const r = await fetchEnvAdaptStatus();
				const ready = !!(r && r.ready);
				cacheRef.current = { at: Date.now(), ready: ready, skipped: !!(r && r.skipped) };
				setStatus(r);
				return r;
			}, []);

			const blockAndOpen = useCallback(() => {
				setConfirmSkip(false);
				refresh();
				/* 第一次：只走完整授权窗 → 授权后进环境适配页 */
				if (!readDrillAuth()) {
					setOpen(false);
					requestDrillEnv();
					return true;
				}
				/* 已授权过：只弹精简环境适配窗，不再自动拉开整块演练台 */
				setOpen(true);
				return true;
			}, [refresh]);

			const mustBlockSubmit = useCallback(() => {
				if (!isRedteamModeActive()) return false;
				const cached = cacheRef.current;
				/* cache 过期时触发异步刷新;本次调用按最后一次 cache 判断,未知保守 block */
				if (!cached.at || Date.now() - cached.at > 2500) {
					refresh().catch(() => {});
				}
				if (cached.ready) return false;
				blockAndOpen();
				return true;
			}, [blockAndOpen, refresh]);

			/* 挂住宿主 SessionInputShell.submit —— 比点按钮启发式可靠。
			 * patch 必须可逆:存 origSubmit 到 WeakMap,unmount / 依赖变更时恢复,
			 * 否则插件禁用后 shell.submit 还是我们的 wrapper,持死 mustBlockSubmit 闭包。 */
			useEffect(() => {
				const patched = new WeakMap();
				const patchedShells = [];
				const patchShell = (shell) => {
					if (!shell || patched.has(shell)) return;
					if (typeof shell.submit !== "function") return;
					const origSubmit = shell.submit;
					patched.set(shell, { origSubmit });
					patchedShells.push(shell);
					const bound = origSubmit.bind(shell);
					shell.submit = function gatedSubmit(mode) {
						try {
							if (mustBlockSubmit()) return;
						} catch { /* 门禁异常时不吞掉发送 */ }
						return bound(mode);
					};
				};
				const tick = () => {
					try {
						const sessions = rewindSessions || (rewindHost && rewindHost.sessions);
						const sid = currentSessionId(sessions);
						if (!sid) return;
						patchShell(conversationInput(sid));
					} catch { /* ignore */ }
				};
				tick();
				const iv = window.setInterval(tick, 400);
				return () => {
					window.clearInterval(iv);
					for (const shell of patchedShells) {
						const info = patched.get(shell);
						if (!info) continue;
						try { shell.submit = info.origSubmit; } catch { /* ignore */ }
					}
					patchedShells.length = 0;
				};
			}, [mustBlockSubmit]);

			useEffect(() => {
				let alive = true;
				const tick = () => {
					if (!alive) return;
					if (!isRedteamModeActive()) return;
					refresh();
				};
				tick();
				const iv = window.setInterval(tick, 5000);
				return () => { alive = false; window.clearInterval(iv); };
			}, [refresh]);

			useEffect(() => {
				const onPointer = (e) => {
					if (!looksLikeSendControl(e.target)) return;
					if (!mustBlockSubmit()) return;
					e.preventDefault();
					e.stopPropagation();
					if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
				};
				const onKey = (e) => {
					if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
					const inComposer = e.target && e.target.closest
						&& e.target.closest("[data-composer-card], [data-composer-seat], [contenteditable='true'], textarea");
					if (!inComposer) return;
					if (e.target.closest && e.target.closest(".dshp-dock, .dshp-auth-mask, .rt-dock, .dshp-env-gate")) return;
					if (!mustBlockSubmit()) return;
					e.preventDefault();
					e.stopPropagation();
					if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
				};
				document.addEventListener("pointerdown", onPointer, true);
				document.addEventListener("click", onPointer, true);
				document.addEventListener("keydown", onKey, true);
				return () => {
					document.removeEventListener("pointerdown", onPointer, true);
					document.removeEventListener("click", onPointer, true);
					document.removeEventListener("keydown", onKey, true);
				};
			}, [mustBlockSubmit]);

			/* 门禁浮层必须永远留一条退出的路。
			 * 真机症状：`确认暂不配置` 的 fetch 不 settle（宿主同步探测把事件循环占住时回包可以迟迟不来），
			 * busy 一直为 true → 该按钮 disabled；浮层是全屏遮罩、没有 Esc、没有点遮罩关闭，
			 * 于是整页点不动，只能强退宿主。判据是「任何时刻都能把这一层收掉」：
			 * Esc 关闭、点遮罩关闭、busy 超时自动复位，三者任一成立即可退出。 */
			useEffect(() => {
				if (!open) return;
				const onKey = (e) => {
					if (e.key !== "Escape") return;
					e.preventDefault();
					e.stopPropagation();
					setOpen(false);
					setConfirmSkip(false);
				};
				document.addEventListener("keydown", onKey, true);
				return () => document.removeEventListener("keydown", onKey, true);
			}, [open]);

			/* busy 兜底：请求 6 秒未回包就复位，让按钮重新可点。
			   不在失败时假装写成功 —— 只是把控制权还给用户，服务端状态仍按下次轮询为准。 */
			useEffect(() => {
				if (!busy) return;
				const id = window.setTimeout(() => setBusy(false), 6000);
				return () => window.clearTimeout(id);
			}, [busy]);

			if (!open) return null;

			const message = (status && status.message) || t("envGate.lead");
			return h("div", {
				className: "dshp-auth-mask dshp-env-gate",
				role: "dialog",
				"aria-modal": "true",
				/* 点遮罩本身（不是卡片内部）收起这一层：全屏遮罩没有退出口时会把整页锁死。 */
				onClick: (e) => {
					if (e.target !== e.currentTarget) return;
					setOpen(false);
					setConfirmSkip(false);
				},
			},
				h("div", { className: "dshp-auth-modal", style: { width: "min(480px,100%)" } },
					h("h2", null, t("envGate.title")),
					h("div", { style: { fontSize: 13, lineHeight: 1.55 } }, message),
					h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary,#999)", lineHeight: 1.5 } }, t("envGate.kaliHint")),
					confirmSkip
						? h("div", { className: "dshp-auth-warn" }, t("envGate.skipConfirm"))
						: null,
					h("div", { className: "dshp-auth-ops" },
						confirmSkip
							? [
								h("button", {
									key: "no",
									type: "button",
									onClick: () => setConfirmSkip(false),
								}, t("envGate.skipNo")),
								h("button", {
									key: "yes",
									type: "button",
									className: "primary",
									disabled: busy,
									onClick: () => {
										setBusy(true);
										fetch("/redteam/api", {
											method: "POST",
											headers: { "content-type": "application/json" },
											body: JSON.stringify({ op: "platformEnvAdaptSkip", skip: true }),
										}).then((r) => r.json()).then((r) => {
											setBusy(false);
											cacheRef.current = { at: Date.now(), ready: true, skipped: true };
											setStatus(r);
											setOpen(false);
											setConfirmSkip(false);
										}).catch(() => {
											setBusy(false);
											cacheRef.current = { at: Date.now(), ready: true, skipped: true };
											setOpen(false);
										});
									},
								}, t("envGate.skipYes")),
							]
							: [
								h("button", {
									key: "skip",
									type: "button",
									onClick: () => setConfirmSkip(true),
								}, t("envGate.skip")),
								h("button", {
									key: "go",
									type: "button",
									className: "primary",
									onClick: () => {
										setOpen(false);
										requestDrillEnv();
									},
								}, t("envGate.go")),
							],
					),
				),
			);
		}

		function installRewindUi(ctx) {
			rewindHost = ctx;
			rewindSessions = ctx.sessions;
			rewindWorkspace = ctx.uiWorkspace || null;
			rewindConversation = ctx.conversation || null;
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "dsh-purge-rewind",
				order: 20,
				inject: (sessionId) => ({
					sessionId,
					t: ctx.locale.bind(NS),
				}),
			}, RewindSafe));
			ctx.effect(() => installRewindWatch(ctx), "dsh-purge: rewind watch");
		}

		function PurgeSettingsSection(props) {
			const t = typeof props.t === "function" ? props.t : useT();
			translate = t;
			return h(SettingsPage, { t });
		}

		/** 文案 → HTML 字符串：先转义，再把 `代码` 与 **粗体** 换成标签。 */
		function copyToHtml(text) {
			const escaped = String(text === undefined || text === null ? "" : text)
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;");
			return escaped
				.replace(/`([^`]+)`/g, (match, code) => "<code>" + code + "</code>")
				.replace(/\*\*([^*]+)\*\*/g, (match, bold) => "<strong>" + bold + "</strong>");
		}

		/**
		 * 一行带轻标记的文案。
		 *
		 * `className` 用来挂版式（例如注意块、说明行），渲染器本身不管样式。
		 */
		function RichCopy(props) {
			const cls = props && props.className ? props.className : "";
			return h("span", {
				className: cls === "" ? "rt-copy" : "rt-copy " + cls,
				dangerouslySetInnerHTML: { __html: copyToHtml(props && props.text) },
			});
		}

		function PurgeDrillPanel() {
			const t = useT();
			if (!__dshPurgeDrill || typeof __dshPurgeDrill.Panel !== "function") {
				return h("div", { className: "dshp-root dshp-root--main" },
					h("div", { className: "dshp-drill-note" }, t("drill.missing")),
				);
			}
			if (!readDrillAuth()) {
				return h("div", { className: "dshp-root dshp-root--main" },
					h("style", null, __dshPurgeDrill.CSS),
					h(AuthGate, { pending: "tab" }),
				);
			}
			return h("div", { className: "dshp-root dshp-root--main" },
				h("style", null, __dshPurgeDrill.CSS),
				h(__dshPurgeDrill.Panel, { embedded: true }),
			);
		}

		function PurgeDrillIcon() {
			const t = useT();
			const label = t("dock.drill");
			return h("span", { className: "dshp-panellist", title: label, "aria-label": label }, "\u25e7");
		}

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-purge: dictionaries");
			const t = ctx.locale.bind(NS);
			translate = t;
			/*
			 * 样式必须挂在文档级，不能挂在某个页面组件里。
			 *
			 * 教训（真机复现）：删浮层之前，PURGE_CSS 是浮层组件挂上去的；浮层一删，
			 * 首次安装弹出的用户须知就成了「无样式 DOM」——`.dshp-auth-mask` 的
			 * `position:fixed` 没生效，弹窗按普通文档流堆着，勾选框与「同意」被压在别的元素下面，
			 * 用户看到窗口、却点不动按钮。页面组件（设置页 / 主区面板）各自还有一份，
			 * 但它们只在用户主动进去时才挂载，救不了首屏。
			 *
			 * 所以这里注入唯一的一份：谁先出现都吃得到样式，页面组件不再各自带 style。
			 */
			ctx.effect(() => {
				if (typeof document === "undefined" || !document.head) return () => {};
				const tag = document.createElement("style");
				tag.setAttribute("data-dsh-purge-ui", "1");
				tag.textContent = PURGE_CSS;
				document.head.append(tag);
				return () => {
					try { tag.remove(); } catch { /* ignore */ }
				};
			}, "dsh-purge: styles");
			// 一次性须知与环境适配门仍走浮层：前者是首次安装必须盖住整页的知己声明，
			// 后者要在**任意页面**拦下红队模式的发送（它不属于某一个页面，放进主区就只在主区生效）。
			// 原来的双页签面板、全面浏览第二窗口、hero chip、页签栏挂件与 DOM 兜底全部随浮层删除：
			// 清洗进了设置页，演练台进了主区，入口在侧栏。
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-purge-welcome",
				order: 50,
			}, () => h(react.Fragment, null, h(WelcomeNotice), h(EnvAdaptSendGate))));
			// P1 清洗页：与宿主设置页插件同一套形态 —— 先 inject 再 register，
			// 内容组件是 register 的第二实参；对象里的 inject 字段不收服务数组。
			// 座位注册形状只到「一个 section、一个内容组件」为止：设置页内部的页签由页面自己渲染，
			// 早先那行 `children` 声明的页签座位全仓无消费方，已删。
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-purge",
				order: 16,
				label: () => translate("nav"),
				locale: NS,
			}, PurgeSettingsSection));
			// P2 演练台：主区一整页 + 侧栏常驻入口，key 与侧栏 id 对齐，
			// 点图标才切得到这一页。主区用 generator 注入形态（宿主插件管理器同构）。
			ctx.slots.inject("main", function* () {
				yield ctx.slots.register({ name: "main", key: "dsh-purge-drill", locale: NS }, PurgeDrillPanel);
			});
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: "dsh-purge-drill", order: 10, label: () => translate("dock.drill"), locale: NS }, PurgeDrillIcon));
			try {
				if (typeof ctx.inject === "function") {
					ctx.inject(["sessions", "uiWorkspace", "workspaces", "conversation"], (host) => installRewindUi(host));
				} else if (ctx.sessions) {
					installRewindUi(ctx);
				}
			} catch (e) {
				try {
					if (typeof ctx.inject === "function") {
						ctx.inject(["sessions", "uiWorkspace", "conversation"], (host) => installRewindUi(host));
					}
				} catch (e2) {
					try { console.warn("[dsh-purge] rewind ui skipped:", e2 || e); } catch { /* ignore */ }
				}
			}
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
