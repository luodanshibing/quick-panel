/*
 * 真视觉验证：用插件自己的 styles.css 拼一份等价 DOM，用无头 Edge 截图，再量卡片中心。
 * 用法：node tools/visual-check.mjs
 * 产出：tools/preview/panel-preview.html + tools/preview/panel-preview.png（都在仓库里，方便复核）
 *
 * 为什么需要它：Obsidian 里的弹窗几何被主题与核心 CSS 共同决定，纯读 CSS 会漏掉"被父级 flex 二次偏移"
 * 这类问题（v0.1.0–v0.1.4 就是这么栽的）。截图能量出真实像素。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
// 产出目录：默认系统临时目录（在受限沙盒里也能跑），需要归档时传第一个参数
const OUT = process.argv[2] || join(tmpdir(), 'quick-panel-preview');
const VW = 1200;
const VH = 800;

const css = readFileSync(join(ROOT, 'styles.css'), 'utf8');

// 只保留本插件的规则（`.modal-container.quick-panel` / `.quick-panel ...` / `.qp-...`），
// 其余（`.modal-container.qp-confirm ...`）原样保留：预览页里没有对应元素，不影响。
const CELLS = [
  ['settings', '设置'],
  ['refresh-cw', '重载应用'],
  ['search', '全局搜索'],
  ['git-branch', '关系图谱'],
  ['arrow-left-right', '后退'],
  ['arrow-left-right', '前进'],
];

const grid = CELLS.map(
  ([, label]) => `
      <button class="qp-cell" type="button" title="${label}">
        <div class="qp-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg></div>
        <span class="qp-cell-label">${label}</span>
      </button>`
).join('');

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>quick-panel layout preview</title>
<style>
  /* 模拟 Obsidian 的默认变量与"用户主题覆盖弹窗几何"的场景 */
  :root {
    --background-primary: #ffffff;
    --background-secondary: #f5f5f5;
    --background-modifier-border: #dddddd;
    --background-modifier-hover: #eeeeee;
    --background-modifier-form-field: #ffffff;
    --background-modifier-cover: rgba(0, 0, 0, 0.45);
    --text-normal: #222222;
    --text-muted: #666666;
    --text-faint: #999999;
    --interactive-accent: #7c5cff;
    --text-on-accent: #ffffff;
    --layer-modal: 100;
    --modal-background: var(--background-primary);
    --modal-border-color: var(--background-modifier-border);
    --modal-border-width: 1px;
    --modal-radius: 8px;
    --size-4-4: 16px;
  }
  html, body { margin: 0; height: 100%; background: #e9e9ee; font-family: system-ui, "Microsoft YaHei", sans-serif; }
  /* 模拟 Obsidian 的核心弹窗规则（我们要覆盖的就是这几条） */
  .modal-container {
    display: flex; align-items: center; justify-content: center;
    position: absolute; top: 0; bottom: 0; inset-inline-start: 0; width: 100%;
    z-index: var(--layer-modal);
  }
  .modal-container .modal { position: relative; }
  .modal {
    background-color: var(--modal-background);
    border-radius: var(--modal-radius);
    border: var(--modal-border-width) solid var(--modal-border-color);
    padding: var(--size-4-4);
    min-height: 100px;
    width: var(--dialog-width, 100vw);
    max-width: var(--dialog-max-width, 100vw);
    max-height: var(--dialog-max-height, 100vh);
    display: flex; flex-direction: column; overflow: auto;
  }
  .modal-bg { position: absolute; top: 0; inset-inline-start: 0; width: 100%; height: 100%; background-color: var(--background-modifier-cover); }
  .modal-close-button { position: absolute; top: 6px; right: 6px; display: flex; }
  .modal-content { padding: 0; }
  button { font: inherit; }
  ${css}
</style></head>
<body>
  <div class="modal-container quick-panel" style="--qp-width: 500px">
    <div class="modal-bg"></div>
    <div class="modal">
      <div class="modal-close-button">×</div>
      <div class="modal-content">
        <div class="qp-header">
          <div class="qp-title"><span class="qp-title-text">快捷面板</span><span class="qp-count">6 格 · 1 项待处理</span></div>
          <div class="qp-actions">
            <button class="qp-icon-btn" type="button">+</button>
            <button class="qp-icon-btn" type="button">⋯</button>
            <button class="qp-icon-btn" type="button">×</button>
          </div>
        </div>
        <div class="qp-search"><input class="qp-search-input" placeholder="过滤面板（Enter 执行第一格 · Esc 清空）"></div>
        <div class="qp-grid" style="--qp-cols: 6; --qp-cell: 40px">${grid}
        </div>
        <div class="qp-footer">
          <div class="qp-status">1 项命令/文件已找不到</div>
          <div class="qp-hint">方向键选择 · Enter 执行 · 直接打字过滤 · Esc 关闭</div>
        </div>
      </div>
    </div>
  </div>
</body></html>`;

mkdirSync(OUT, { recursive: true });
const htmlPath = join(OUT, 'panel-preview.html');
writeFileSync(htmlPath, html, 'utf8');
console.log('wrote ' + htmlPath);

const edge = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (!edge) {
  console.log('未找到 Edge，跳过截图（HTML 已生成，可手动打开）');
  process.exit(0);
}
const pngPath = join(OUT, 'panel-preview.png');
execFileSync(
  edge,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    // 独立配置目录：避免与用户正在运行的 Edge 抢 profile（会直接崩）
    '--user-data-dir=' + join(OUT, 'edge-profile'),
    `--window-size=${VW},${VH}`,
    `--screenshot=${pngPath}`,
    'file:///' + htmlPath.replace(/\\/g, '/'),
  ],
  { stdio: 'ignore', timeout: 60000 }
);
console.log('wrote ' + pngPath + ' (' + VW + 'x' + VH + ')');
