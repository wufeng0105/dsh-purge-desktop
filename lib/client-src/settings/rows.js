/**
lib/client-src/settings/rows.js — 设置页共用的字节数格式化。

## 为什么只剩这一个

本文件此前带两层东西：补丁分组表（`LAYER_GROUP` / `patchRowsOf` / `patchTitle` /
`tallyPatches` / `PatchGroups`）与「状态词 → 展示语义」的翻译（`statusKind` /
`statusLabel` / `shimKind` / `noticeNode` / `Pill`）。两层现在都换了主人，于是整层
失去调用方：

- 分组与 tone 由服务端的 `layerRows` 算好。客户端再算一遍没有意义：同一个「提示词 /
  代码 / 工具 / 兼容」四分类，服务端算一遍、客户端再算一遍，两边的桶名与空层规则
  稍有出入就会让同一屏出现两个不同的计数。
- 状态胶囊与动作按钮改走宿主原语（`ui.js` 的 `ActionButton`、宿主 `Tag`）。自造包装
  拿不到原生明暗、键盘与无障碍行为，而它在重构后已无任何引用。

留下的 `formatSize` 不依赖展示语义：技能分节要用它把字节数写成可读值。

本文件不是 ES 模块，正文逐字节内联进 client.js。
*/

		function formatSize(bytes) {
			if (typeof bytes !== "number" || !isFinite(bytes) || bytes < 0) return "0 B";
			if (bytes < 1024) return bytes + " B";
			const kb = bytes / 1024;
			return (kb >= 100 ? Math.round(kb) : kb.toFixed(1)) + " KB";
		}
