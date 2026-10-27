/**
lib/client-src/dock/auth.js — 演练台授权状态（localStorage + 服务端同步）。

readDrillAuth / setDrillAuthLocal / writeDrillAuth / syncDrillGrant。
授权是否成立决定「演练台」页签能不能进 —— 这是 dock 的前置门。

本文件不是 ES 模块，正文逐字节内联进 client.js。
 */
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
