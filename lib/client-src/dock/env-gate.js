/**
lib/client-src/dock/env-gate.js — 红队模式判定 + 环境适配发送闸门。

isRedteamPresetId / readSessionAgentPreset / readSessionCwd / clientCurrentCwd /
isRedteamModeActive / looksLikeSendControl / fetchEnvAdaptStatus / EnvAdaptSendGate。

本文件不是 ES 模块，正文逐字节内联进 client.js。
 */

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
