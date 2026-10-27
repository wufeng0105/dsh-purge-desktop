/**
lib/client-src/settings/skills-tab.js — 技能页签：读取、查看、编辑、导入。

skillUiAllowed / splitListedVersion / listedVersionNewer / listedCeiling /
keepListedVersion / preferListed / versionChoiceLabel / SkillsPanel。

## 版式为什么长这样

技能是「一堆并列条目 + 选中某条才出现编辑器」，不是常驻双栏工作区。原来的实现把
列表与编辑器并排放在两栏里，编辑器在没有选中项时仍占半屏、中间写一句「选择 Skill」
—— 在设置节那点宽度里等于半屏永久空白，而且空态是居中的，和整页左对齐的行式排版对不上。

现在：条目列表本是主体；编辑器只在选中某条后**在该条目下方就地展开**，未选中时不占任何
高度。「导入」两个动作放在分节标题右侧，与其它分节的「标题 + 右侧动作」一致；空态是左
对齐的一行说明，不居中、不留白。

从「设置页里的一节」改成页签时只换了外框：分节上那个给锚点用的 id 去掉了。

## 数据从共享快照来

「技能界面出不出」与「技能目录」都读页面那一份快照；本文件只补一条
`/dsh-purge/skills` 的 status（按库几条、同名遮蔽几条只有它给）。原先这里自己也取
一次状态端点，于是同一屏两份快照 —— 而且两处对「版本够不够新」可能给不同答案。
本文件不是 ES 模块，正文逐字节内联进 client.js。
 */

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
