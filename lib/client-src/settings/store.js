/**
lib/client-src/settings/store.js — 设置页的唯一数据入口：一份快照 + 一套只读五态。

## 为什么收成一层

重构前设置页有六个地方各自发请求：页面自己取状态快照，技能页签与诊断页签又各取一次
同一个端点，配置页签的四块各取各的。同一屏因此能出现两份时刻不同的快照，而「两个数
不一样」没有任何症状 —— 用户看到的是两个都像真的数字。

现在页面层只调 `usePurgeStatus()` 一次，五个页签从同一份快照读；写操作成功后叫
`refresh()` 重取。状态端点的字面量也只剩本文件一处：别处再写一次，就是第二个取数点，
而第二个取数点不会被任何界面症状揭发。

## useAsyncResource 的五个状态

`loading` / `ready` / `empty` / `error` 四个相位，加 `retry()` 这条动作。为什么统一：
每个页签原先各写一套「骨架 + 失败提示 + 重试按钮」，措辞与骨架高度各不相同，同一个
读取失败在页面上长得像三件事。相位只由这里给；页签只决定两件事 ——「取到了但是没有
内容」是什么意思（`emptyOf`），以及空态怎么说（`AsyncBlock` 的 `empty`）。

写操作的结果**不**进这五态：`busy` / `notice` 说的是「这次点击的结果」，五态说的是
「这一块的数据」。两者混在一起，一次保存失败就会把已经取到的内容打成读取失败。

## 两个分母

`display`（展示行）与 `raw`（按补丁号）都由服务端算好，本文件一个数都不加。页面上
凡出现计数的地方都要说出用的是哪一个：摘要与补丁页是 `display`，诊断页的「判据口径」
那一行是 `raw`。

本文件不是 ES 模块，正文逐字节内联进 client.js。
*/

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
