/**
 * lib/host.js — 宿主适配器的选择点，web 面删掉后只剩桌面一条分支。
 * 宿主适配器路由（只剩 desktop）。
 *
 * 曾经有三个 web 侧文件（`web.js` / `restart-web.js` / `uninstall-restart.js`），
 * 随 `dsh web` CLI 宿主面一起删掉了。别再往这里加回来 —— `no-web-surface-after-purge`
 * 规则会拦。
 *
 * ⚠️ 删的是 **CLI 宿主面**，不是 Web UI 层。下面这些仍在用，不许删（SURFACE-4）：
 *   - client.js（浏览器 bundle，桌面端 Electron 也加载它）
 *   - package.json 的 dsh.client.platform: "web"
 *   - webServer 注入（index.js、redteam/ui.js）
 *
 * 判定入口统一走 surface.js 的 isDesktop()，本文件只做转发。
 */
import { detectSurface, isDesktop } from "./surface.js";
import * as desktop from "./desktop.js";

const ADAPTERS = {
  desktop,
};

export function currentSurface(input) {
  return detectSurface(input);
}

/**
 * 转发 surface.js 的判定入口。
 *
 * 判定本身不在本文件实现 —— host.js 依赖 desktop.js，在 host.js 里实现判定
 * 会让 desktop 的依赖链反过来要求 host，造出新环。
 */
export { isDesktop };

/**
 * 取当前宿主适配器。
 *
 * 现在只有 desktop 一个实现。非桌面面（web / gui / tui）在 会被
 * detectSurface 的 fail-fast 拦在更早的地方；这里仍保留显式错误，
 * 避免"拿不到适配器就静默用 desktop"这种最坏的失败模式。
 */
export function hostAdapter(kind = detectSurface()) {
  const id = isDesktop(kind) ? "desktop" : String(kind || "");
  const adapter = ADAPTERS[id];
  if (!adapter) {
    throw new Error(
      `不支持的宿主面: ${JSON.stringify(kind)}。`
 + "dsh-purge 只维护官方桌面端（已移除 dsh web CLI 宿主面）。",
    );
  }
  return adapter;
}

export function scheduleRestart(request, ctx, options = {}) {
  return hostAdapter().scheduleRestart(request, ctx, options);
}

export function scheduleCleanupRestart(opts) {
  return hostAdapter().scheduleCleanupRestart(opts);
}

export function restartNote() {
  return hostAdapter().restartNote();
}
