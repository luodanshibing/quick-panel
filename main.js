'use strict';
/*
 * Quick Panel（快捷面板）— v0.1.0
 *
 * 一句话：一个快捷键在 Obsidian 窗口内呼出「图标网格面板」，格子里是你自己挑的命令 / 笔记 / 文件夹。
 *
 * 五条设计红线（改代码前先读）：
 *   1) 启动零扫描：onload 只读一次配置 + 注册一条命令 + 一个 ribbon 图标，不调 listCommands()、
 *      不扫库、不起定时器、不挂常驻监听。命令表在「打开面板」那一刻才解析。
 *   2) 配置真源是库内可见文件 <库根>/快捷面板.json；data.json 只存 UI 状态（面板位置）。
 *      配置读坏了 → 保留原文件、提示、用临时默认面板启动，绝不覆盖。
 *   3) 写操作只发生在上面那一个 JSON 里：不碰 .obsidian、不碰任何笔记、不碰任何原文件。
 *   4) 全程手动：不点不动。没有后台任务、没有自动写入、没有隐式副作用。
 *   5) 卸载后一切仍在：配置是普通 JSON，格子指向的仍是 Obsidian 自己的命令与库内文件。
 *
 * 本文件不依赖任何上游库、不需要构建步骤；纯函数统一从 module.exports 出去，供 tools/test.mjs 离线断言。
 */

const {
  Plugin,
  Modal,
  Notice,
  Menu,
  setIcon,
  getIconIds,
} = require('obsidian');

/* =====================================================================================
 * 一、常量
 * ===================================================================================== */

/** 配置文件固定名（用户已裁定：文件名可见、不做点号隐藏） */
const CONFIG_NAME = '快捷面板.json';

/** 改名前的旧文件名（2026-10-13 用户把面板名定为「快捷面板」）；首次加载时自动迁移 */
const CONFIG_NAME_LEGACY = '快接面板.json';

/** 配置文件结构版本；v2 起：默认不放搜索框、默认格子换成核验过的核心命令 */
const CONFIG_VERSION = 2;

/** 「最近用过」最多保留几条 */
const RECENT_LIMIT = 12;

/** 图标格最小宽度（px）；列数由「容器宽度 ÷ 这个值」决定 */
const CELL_MIN = 72;

/** 格子间距（px）；与 styles.css 里的 gap 必须一致 */
const CELL_GAP = 8;

/** 面板离屏幕边缘的最小留白（px）；居中布局下只用于兜底保护 */
const EDGE_GAP = 12;

/** 命令执行前的等待：面板要先销毁，焦点才能干净地回到编辑器/新窗口 */
const EXEC_DELAY_MS = 40;

/** 网格可用宽度的上限（px）—— 视口再宽也不让面板摊成一片 */
const MAX_PANEL_WIDTH = 720;

/**
 * 兜底图标候选清单。
 * 运行期优先用 Obsidian 的 getIconIds()（实测本机 1.x 是顶层导出）；
 * 这个清单只在拿不到该 API 时顶上（交接文档指出官方未承诺它有、也没有文档化的「列全部图标名」API）。
 */
const LUCIDE_CANDIDATES = [
  'activity', 'alarm-clock', 'archive', 'arrow-left-right', 'at-sign', 'award',
  'book', 'book-open', 'bookmark', 'box', 'brain', 'brush', 'bug', 'calculator',
  'calendar', 'calendar-days', 'check', 'check-square', 'circle-dot', 'clipboard',
  'clipboard-list', 'clock', 'cloud', 'code', 'coffee', 'columns', 'command',
  'compass', 'copy', 'corner-down-right', 'cpu', 'credit-card', 'database', 'download',
  'edit', 'edit-3', 'external-link', 'eye', 'file', 'file-text', 'file-plus',
  'files', 'filter', 'flame', 'folder', 'folder-open', 'frown', 'gauge', 'gift',
  'git-branch', 'globe', 'graduation-cap', 'grid', 'hammer', 'hard-drive', 'hash',
  'heart', 'help-circle', 'home', 'image', 'inbox', 'info', 'kanban', 'key',
  'languages', 'layout', 'layout-grid', 'library', 'lightbulb', 'link', 'list',
  'list-checks', 'loader', 'lock', 'map', 'message-square', 'message-square-text',
  'mic', 'minus', 'monitor', 'moon', 'more-horizontal', 'mouse-pointer', 'move',
  'music', 'navigation', 'package', 'palette', 'paperclip', 'pen-tool', 'pie-chart',
  'pin', 'plus', 'puzzle', 'quote', 'refresh-cw', 'repeat', 'rocket', 'rss',
  'save', 'scissors', 'scroll', 'search', 'settings', 'share-2', 'shield', 'shuffle',
  'slash', 'sliders-horizontal', 'sort-asc', 'sparkles', 'square', 'star', 'sun',
  'table', 'tag', 'target', 'terminal', 'text', 'trash', 'trending-up', 'type',
  'undo', 'upload', 'user', 'wand', 'wrench', 'x', 'zap',
];

/**
 * 首次运行灌入的示例格子。
 * 只放**核验过确实存在**的 Obsidian 核心命令（2026-10-13 在 obsidian.asar 里逐个查过 id），
 * 不放 context 相关、可能不可用的（例如 graph:open 在未启用关系图谱时会失败）。
 */
const DEMO_ITEMS = [
  { type: 'command', id: 'app:open-settings', label: '设置', icon: 'settings' },
  { type: 'command', id: 'global-search:open', label: '全局搜索', icon: 'search' },
  { type: 'command', id: 'switcher:open', label: '快速切换', icon: 'files' },
  { type: 'command', id: 'backlink:open', label: '反向链接', icon: 'link' },
  { type: 'command', id: 'workspace:new-tab', label: '新标签页', icon: 'plus' },
  { type: 'command', id: 'app:reload', label: '重载应用', icon: 'refresh-cw' },
];

/** 配置升级到 v2 时要用的默认格子（旧配置那 6 条里有 context 相关的，换掉） */
const V2_DEFAULT_ITEMS = DEMO_ITEMS;

/* =====================================================================================
 * 二、纯函数（离线可测，不碰 DOM / 不碰 Obsidian 运行时）
 * ===================================================================================== */

/** 取 v 的字符串形态；非字符串一律给空串，避免 undefined 混进 UI 与 JSON */
function asString(v) {
  return typeof v === 'string' ? v : '';
}

/** 折叠空白并去首尾空格（label 里出现换行会让格子排版崩掉） */
function cleanLabel(v) {
  return asString(v).replace(/\s+/g, ' ').trim();
}

/** 路径规整：统一分隔符、去掉开头的 ./ —— 与 Obsidian 的路径索引保持一致 */
function normalizeVaultPath(p) {
  return asString(p)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .trim();
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 条目类型判定；认不出来返回空串 */
function itemType(item) {
  const t = isPlainObject(item) ? item.type : '';
  if (t === 'command' || t === 'file' || t === 'folder') return t;
  return '';
}

/**
 * 校验一个配置条目的结构（只认「持久化形状」，忽略运行期附加的派生字段如 missing）。
 * 返回 { valid, reason }；label 允许留空（显示时用命令名 / 文件名兜底）。
 */
function validateItem(item) {
  if (!isPlainObject(item)) return { valid: false, reason: '条目不是对象' };
  const type = itemType(item);
  if (!type) return { valid: false, reason: 'type 必须是 command / file / folder' };

  if (type === 'command') {
    const id = asString(item.id).trim();
    if (!id) return { valid: false, reason: '命令条目缺 id' };
  } else {
    const p = asString(item.path).trim();
    if (!p) return { valid: false, reason: '文件/文件夹条目缺 path' };
    if (p.charAt(0) === '/' || /^[a-zA-Z]:[\\/]/.test(p)) {
      return { valid: false, reason: 'path 必须是库内相对路径' };
    }
  }

  if ('icon' in item && item.icon !== undefined && typeof item.icon !== 'string') {
    return { valid: false, reason: 'icon 必须是字符串' };
  }
  if ('label' in item && item.label !== undefined && typeof item.label !== 'string') {
    return { valid: false, reason: 'label 必须是字符串' };
  }
  if (type === 'command' && item.level !== undefined) {
    const lv = item.level;
    if (typeof lv !== 'number' || !Number.isInteger(lv) || lv < 2 || lv > 6) {
      return { valid: false, reason: 'level 必须是 2–6 的整数' };
    }
  }
  return { valid: true, reason: '' };
}

/** 面板设置归一化 */
function normalizePanelSettings(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const out = {
    columns: 'auto',
    showRecent: true,
    iconSize: 40,
    // v2 起默认不显示过滤框：面板本身就能直接打字过滤，多一个框只是噪音（用户反馈）
    showSearch: false,
  };
  if (Number.isInteger(src.columns) && src.columns >= 2 && src.columns <= 12) out.columns = src.columns;
  if (typeof src.showRecent === 'boolean') out.showRecent = src.showRecent;
  if (typeof src.showSearch === 'boolean') out.showSearch = src.showSearch;
  if (typeof src.iconSize === 'number' && isFinite(src.iconSize)) {
    out.iconSize = Math.min(96, Math.max(20, Math.round(src.iconSize)));
  }
  return out;
}

/**
 * 整份配置归一化 —— 任何形状的输入都返回一个可用的配置对象，绝不抛异常。
 * 返回值里 errors 记「被丢弃的坏条目」，供 UI 提示用户（不静默吞掉）。
 */
function normalizePanelConfig(raw) {
  const errors = [];
  // null / undefined 都按「没有配置」处理（首次运行时文件还不存在），不算坏文件
  if (raw === null || raw === undefined) {
    return {
      version: CONFIG_VERSION,
      panel: normalizePanelSettings(null),
      items: [],
      recent: [],
      errors: [],
    };
  }
  if (!isPlainObject(raw)) {
    return {
      version: CONFIG_VERSION,
      panel: normalizePanelSettings(null),
      items: [],
      recent: [],
      errors: ['配置文件根节点不是对象'],
    };
  }
  const panel = normalizePanelSettings(raw.panel);
  const items = [];
  const list = Array.isArray(raw.items) ? raw.items : [];
  list.forEach((it, i) => {
    const r = validateItem(it);
    if (!r.valid) {
      errors.push('第 ' + (i + 1) + ' 条被丢弃：' + r.reason);
      return;
    }
    items.push(it);
  });
  const recent = [];
  const rawRecent = Array.isArray(raw.recent) ? raw.recent : [];
  rawRecent.forEach((r) => {
    if (!isPlainObject(r)) return;
    const type = itemType(r);
    if (!type) return;
    const key = type === 'command' ? asString(r.id).trim() : asString(r.path).trim();
    if (!key) return;
    const usedAt = typeof r.usedAt === 'number' && isFinite(r.usedAt) ? r.usedAt : 0;
    recent.push({ type: type, id: r.id, path: r.path, usedAt: usedAt });
  });
  return {
    version: Number.isInteger(raw.version) ? raw.version : CONFIG_VERSION,
    panel: panel,
    items: items,
    recent: recent.slice(0, RECENT_LIMIT),
    errors: errors,
  };
}

/** 写回磁盘时的规整：字段顺序固定、丢掉 undefined，避免手改过的 JSON 越写越乱 */
function serializePanel(config) {
  const c = normalizePanelConfig(config);
  return {
    version: CONFIG_VERSION,
    panel: {
      columns: c.panel.columns,
      showRecent: c.panel.showRecent,
      iconSize: c.panel.iconSize,
      showSearch: c.panel.showSearch,
    },
    items: c.items.map(function (it) {
      const type = itemType(it);
      const out = { type: type };
      if (type === 'command') {
        out.id = asString(it.id).trim();
        const snap = cleanLabel(it.nameSnapshot);
        if (snap) out.nameSnapshot = snap;
      } else {
        out.path = normalizeVaultPath(asString(it.path).trim());
      }
      const label = cleanLabel(it.label);
      if (label) out.label = label;
      if (typeof it.icon === 'string' && it.icon.length > 0) out.icon = it.icon;
      if (type === 'command' && Number.isInteger(it.level)) out.level = it.level;
      return out;
    }),
    recent: c.recent.map(function (r) {
      const out = { type: r.type };
      if (r.type === 'command') out.id = asString(r.id).trim();
      else out.path = normalizeVaultPath(asString(r.path).trim());
      out.usedAt = typeof r.usedAt === 'number' && isFinite(r.usedAt) ? r.usedAt : 0;
      return out;
    }),
  };
}

/** 条目的唯一键：命令用 id、文件/文件夹用 path */
function itemKey(item) {
  const t = itemType(item);
  if (t === 'command') return 'command:' + asString(item.id).trim();
  if (t) return t + ':' + normalizeVaultPath(asString(item.path).trim());
  return '';
}

/** 图标来源判定：image（库内图片）/ emoji / lucide（含自定义 addIcon 注册的名字）/ none */
function iconSpecOf(value) {
  const raw = asString(value).trim();
  if (!raw) return { kind: 'none', value: '', name: '', reason: '' };

  // 网址排在扩展名判断之前：否则 https://x/a.png 会被当成库内图片
  if (/^https?:\/\//i.test(raw) || /^\/\//.test(raw)) {
    return { kind: 'none', value: raw, name: '', reason: '本版不支持网址图标（离线取不到图）' };
  }
  const lower = raw.toLowerCase();
  // 绝对路径 / 盘符路径：仍按图片处理，但要提示改成库内相对路径
  if (raw.charAt(0) === '/' || /^[a-zA-Z]:[\\/]/.test(raw)) {
    return { kind: 'image', value: normalizeVaultPath(raw), name: '', reason: '看起来是绝对路径，改用库内相对路径才能同步' };
  }
  if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(lower)) {
    return { kind: 'image', value: normalizeVaultPath(raw), name: '', reason: '' };
  }
  // emoji 判定：整串不含 ASCII 的字母数字，且在 Unicode 图形区
  if (!/[0-9A-Za-z]/.test(raw) && /[\u203C-\u2BFF\uD83C-\uDBFF\uDC00-\uDFFF\uFE0F]/u.test(raw)) {
    return { kind: 'emoji', value: raw, name: '', reason: '' };
  }
  if (/^[a-z0-9][a-z0-9-]*$/.test(lower)) {
    return { kind: 'lucide', value: lower, name: lower, reason: '' };
  }
  return { kind: 'none', value: raw, name: '', reason: '认不出的图标写法（图标名、emoji 或库内图片路径）' };
}

/** 合并图标候选：运行期 getIconIds() 优先，兜底清单补齐，去重并只留可用名字 */
function iconCandidates(runtimeIds) {
  const seen = Object.create(null);
  const out = [];
  const push = function (id) {
    const name = asString(id).trim();
    if (!name || seen[name]) return;
    seen[name] = 1;
    out.push(name);
  };
  if (Array.isArray(runtimeIds)) runtimeIds.forEach(push);
  LUCIDE_CANDIDATES.forEach(push);
  return out;
}

/**
 * 表格列数：容器宽度装得下几格就几列，最少 2 列、最多 12 列。
 * 自适应列数由这个纯函数唯一决定 —— 不散落在 CSS / 各种判断里。
 * 宽度拿不到（首次打开还没布局）时按最小列数处理，宁可先窄一点，也不在没量到宽度时乱猜。
 */
function gridColumns(containerWidth, cellMin, gap) {
  const w = typeof containerWidth === 'number' && isFinite(containerWidth) ? containerWidth : 0;
  const min = typeof cellMin === 'number' && cellMin > 0 ? cellMin : CELL_MIN;
  const g = typeof gap === 'number' && gap >= 0 ? gap : 0;
  if (w <= 0) return 2;
  const n = Math.floor((w + g) / (min + g));
  return Math.max(2, Math.min(12, n));
}

/**
 * 网格可用宽度：用视口宽度倒推，不依赖容器此刻的布局结果
 * （面板刚创建时容器宽度可能是 0；面板宽度本来就决定列数，不能自我循环）。
 */
function gridWidthFor(viewportWidth, maxContentWidth) {
  const vw = typeof viewportWidth === 'number' && isFinite(viewportWidth) ? viewportWidth : 0;
  const maxW = typeof maxContentWidth === 'number' && maxContentWidth > 0 ? maxContentWidth : 0;
  if (vw <= 0) return 0;
  return Math.max(0, Math.min(MAX_PANEL_WIDTH, vw - 88, maxW));
}

/** 把可见格子分成每行固定列数的若干行（键盘上下移动要按行算，不靠 DOM 查询） */
function splitColumnCounts(total, columns) {
  const n = typeof total === 'number' && total > 0 ? Math.floor(total) : 0;
  const c = typeof columns === 'number' && columns > 0 ? Math.floor(columns) : 1;
  const out = [];
  let left = n;
  while (left > 0) {
    const take = Math.min(c, left);
    out.push(take);
    left -= take;
  }
  return out;
}

/** 从当前下标出发，向上/下走一行（按几何行判断，不靠 DOM 查询） */
function moveVertical(index, rows, direction) {
  const counts = Array.isArray(rows) ? rows : [];
  // 把「行 × 列」摊成格子坐标（行号、列号、在该行内的下标）
  const cells = [];
  counts.forEach(function (count, r) {
    for (let i = 0; i < count; i += 1) cells.push({ row: r, col: i, rowIndex: i });
  });
  if (!cells.length) return 0;
  const current = typeof index === 'number' && index >= 0 && index < cells.length ? index : 0;
  const here = cells[current];
  const targetRow = here.row + (direction < 0 ? -1 : 1);
  if (targetRow < 0 || targetRow > counts.length - 1) return current;
  // 目标行里找「列号≤当前列号」的最后一个；目标行比当前短时自然落到它的最后一格
  let best = -1;
  for (let i = 0; i < cells.length; i += 1) {
    if (cells[i].row === targetRow && cells[i].col <= here.col) best = i;
  }
  if (best < 0) {
    for (let i = 0; i < cells.length; i += 1) {
      if (cells[i].row === targetRow) return i;
    }
    return current;
  }
  return best;
}

/** 「最近用过」推进一条：同项提到最前、按 id/path 去重、只留 RECENT_LIMIT 条 */
function pushRecent(list, entry, limit) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : RECENT_LIMIT;
  const clean = [];
  const entryType = itemType(entry);
  if (!entryType) return Array.isArray(list) ? list.slice(0, max) : [];
  const entryClone = { type: entryType };
  if (entryType === 'command') entryClone.id = asString(entry.id).trim();
  else entryClone.path = normalizeVaultPath(asString(entry.path).trim());
  entryClone.usedAt = typeof entry.usedAt === 'number' && isFinite(entry.usedAt) ? entry.usedAt : 0;
  clean.push(entryClone);

  const src = Array.isArray(list) ? list : [];
  const key = itemKey(entryClone);
  for (let i = 0; i < src.length && clean.length < max; i += 1) {
    const r = src[i];
    if (!isPlainObject(r) || !itemType(r)) continue;
    if (itemKey(r) === key) continue;
    clean.push(r);
  }
  return clean.slice(0, max);
}

/** 把配置里「找不到对应对象」的条目筛出来（面板里标灰，并给出重新绑定的入口） */
function findMissingItems(items, resolvers) {
  const res = isPlainObject(resolvers) ? resolvers : {};
  const out = [];
  const list = Array.isArray(items) ? items : [];
  list.forEach(function (it) {
    if (!isPlainObject(it)) return;
    const type = itemType(it);
    if (type === 'command') {
      const id = asString(it.id).trim();
      if (!id) return;
      if (typeof res.findCommand === 'function' && !res.findCommand(id)) {
        out.push({ item: it, kind: 'command', key: id });
      }
      return;
    }
    if (!type) return;
    const path = normalizeVaultPath(asString(it.path).trim());
    if (!path) return;
    if (typeof res.getAbstractFileByPath !== 'function') return;
    const file = res.getAbstractFileByPath(path);
    if (!file) {
      out.push({ item: it, kind: 'file-missing', key: path });
      return;
    }
    const isFolder = res.isFolder ? !!res.isFolder(file) : false;
    if (type === 'folder' && !isFolder) out.push({ item: it, kind: 'not-a-folder', key: path });
    if (type === 'file' && isFolder) out.push({ item: it, kind: 'not-a-file', key: path });
  });
  return out;
}

/** 过滤：按 label / 命令名 / 路径做大小写不敏感的子串匹配 */
function filterItems(items, query) {
  const q = asString(query).trim().toLowerCase();
  const list = Array.isArray(items) ? items : [];
  if (!q) return list.slice();
  return list.filter(function (it) {
    if (!isPlainObject(it)) return false;
    const hay = [it.label, it.nameSnapshot, it.id, it.path, it.name]
      .map(asString)
      .join(' ')
      .toLowerCase();
    return hay.indexOf(q) >= 0;
  });
}

/* =====================================================================================
 * 三、库内配置文件的读写（唯一被写的文件）
 * ===================================================================================== */

/** 解析配置文本；坏 JSON 只报错、不抛异常、不覆盖原文件 */
function parsePanelFile(text) {
  try {
    const config = normalizePanelConfig(JSON.parse(text));
    config.corrupt = false;
    config.parseError = '';
    return config;
  } catch (e) {
    return {
      version: CONFIG_VERSION,
      panel: normalizePanelSettings(null),
      items: [],
      recent: [],
      errors: [],
      corrupt: true,
      parseError: (e && e.message) || 'JSON 解析失败',
    };
  }
}

/** 落盘文本：2 空格缩进、末尾换行（便于手改与 Git diff） */
function serializePanelText(config) {
  return JSON.stringify(serializePanel(config), null, 2) + '\n';
}

/* =====================================================================================
 * 四、面板（Modal + CSS grid）
 * ===================================================================================== */

/** 面板本体。一次性渲染整个网格，键盘 / 搜索只改现有节点的 class 与文本。 */
class QuickPanelModal extends Modal {
  constructor(app, host, config, options) {
    super(app);
    this.host = host;
    this.config = config;
    this.opts = options || {};
    this.items = [];
    this.recent = [];
    this.visible = [];
    this.highlight = -1;
    this.query = '';
    this.columns = 6;
    this.cellNodes = [];
    this.missing = [];
    this.searchEl = null;
    this.gridEl = null;
    this.recentEl = null;
    this.statusEl = null;
  }

  onOpen() {
    this.modalEl.addClass('quick-panel');
    // 弹窗/多窗口场景下，面板所在的 window 未必是主窗口 —— 视口尺寸与鼠标坐标都要取它自己的
    this.setView(this.modalEl.ownerDocument || document);

    // 解析命令表只发生在「面板打开」这一刻（启动零扫描）
    const registry = this.host.commandRegistry();
    const missing = findMissingItems(this.config.items, {
      findCommand: registry.find,
      getAbstractFileByPath: (p) => this.app.vault.getAbstractFileByPath(p),
      isFolder: (f) => !!f && f.children !== undefined,
    });
    this.missing = missing;
    const missingKey = Object.create(null);
    missing.forEach(function (m) {
      missingKey[m.key] = m.kind;
    });
    this.items = this.config.items.map(function (it) {
      const type = itemType(it);
      const base = { item: it, type: type, missing: '' };
      if (type === 'command') base.missing = missingKey[asString(it.id).trim()] || '';
      else base.missing = missingKey[normalizeVaultPath(asString(it.path).trim())] || '';
      return base;
    });

    this.recent = [];
    if (this.config.panel.showRecent && Array.isArray(this.config.recent)) {
      const self = this;
      this.config.recent.forEach(function (r) {
        const rk = itemKey(r);
        if (!rk) return;
        // 最近用过的条目在面板里也要能执行；找不到的（命令失效 / 文件被删）不显示
        if (self.items.some(function (v) { return itemKey(v.item) === rk; })) return;
        const probe = self.config.items.filter(function (v) { return itemKey(v) === rk; })[0];
        const entry = { item: probe || r, type: r.type, missing: '' };
        if (r.type === 'command' && !registry.find(asString(r.id).trim())) entry.missing = 'command';
        if (r.type !== 'command') {
          const f = self.app.vault.getAbstractFileByPath(normalizeVaultPath(asString(r.path).trim()));
          if (!f) entry.missing = 'file-missing';
        }
        self.recent.push(entry);
      });
    }

    this.buildHeader();
    if (this.config.panel.showSearch) this.buildSearch();
    this.buildGrid();
    if (this.config.panel.showRecent && this.recent.length) this.buildRecent();
    this.buildFooter();

    this.render();
    // 位置交给 CSS flex 居中：这里不做任何测量、不写任何定位样式
    this.getWindow().setTimeout(() => {
      if (this.modalEl && this.modalEl.isConnected) this.modalEl.focus();
    }, 0);
    if (this.opts.autoHighlightFirst !== false) this.setHighlight(0);
  }

  onClose() {
    this.cellNodes = [];
    this.items = [];
    this.recent = [];
    if (this.contentEl && this.contentEl.children) this.contentEl.children.length = 0;
  }

  /* ---- 结构 ---- */

  buildHeader() {
    const header = this.contentEl.createDiv({ cls: 'qp-header' });
    const title = header.createDiv({ cls: 'qp-title' });
    title.createSpan({ cls: 'qp-title-text', text: '快捷面板' });

    // 用户 2026-10-13 要求："把所有 × 都去掉" → 这里不再放关闭按钮，
    // 自带的那个也在 CSS 里隐藏了。关闭方式：Esc、点面板外任意处（Obsidian 弹窗标准行为）。
    const actions = header.createDiv({ cls: 'qp-actions' });
    const menuBtn = actions.createEl('button', { cls: 'qp-icon-btn', attr: { type: 'button' } });
    setIcon(menuBtn, 'more-horizontal');
    menuBtn.setAttribute('aria-label', '更多');
    menuBtn.addEventListener('click', (evt) => this.openMoreMenu(evt));
  }

  buildSearch() {
    const wrap = this.contentEl.createDiv({ cls: 'qp-search' });
    const input = wrap.createEl('input', {
      cls: 'qp-search-input',
      attr: { type: 'text', placeholder: '过滤（可选，面板里直接打字也一样）' },
    });
    this.searchEl = input;
    input.addEventListener('input', () => {
      this.query = input.value;
      this.render();
      this.setHighlight(0);
    });
  }

  buildGrid() {
    this.gridEl = this.contentEl.createDiv({ cls: 'qp-grid' });
  }

  buildRecent() {
    const wrap = this.contentEl.createDiv({ cls: 'qp-recent' });
    wrap.createDiv({ cls: 'qp-recent-label', text: '最近用过' });
    this.recentEl = wrap.createDiv({ cls: 'qp-recent-row' });
  }

  /** 底部只留"有问题时才出现"的一行状态；操作提示与计数都已删掉（用户反馈多余） */
  buildFooter() {
    const foot = this.contentEl.createDiv({ cls: 'qp-footer' });
    this.statusEl = foot.createDiv({ cls: 'qp-status' });
  }

  /* ---- 渲染 ---- */

  /** 一次性把网格建好；之后键盘高亮 / 过滤只改现有节点的 class 与文本 */
  render() {
    const self = this;
    const keyOf = (it) => itemKey(it);
    this.visible = filterItems(
      this.items.map((v) => v.item),
      this.query
    )
      .map((it) => this.items.filter((v) => keyOf(v.item) === keyOf(it))[0])
      .filter(Boolean);

    this.rows = splitColumnCounts(this.visible.length, this.columns);

    this.gridEl.empty();
    this.cellNodes = [];
    if (!this.visible.length) {
      this.gridEl.createDiv({
        cls: 'qp-empty',
        text: this.items.length
          ? '没有匹配的格子'
          : '面板还是空的：编辑 快捷面板.json 加条目，或用下一批的「面板内即时添加」',
      });
    } else {
      this.visible.forEach(function (entry, index) {
        self.cellNodes.push(self.buildCell(entry, index, self.gridEl));
      });
    }

    if (this.recentEl) {
      this.recentEl.empty();
      this.recent.forEach(function (entry) {
        const btn = self.recentEl.createEl('button', { cls: 'qp-chip', attr: { type: 'button' } });
        self.paintIcon(btn, entry.item);
        btn.createSpan({ cls: 'qp-chip-label', text: self.displayName(entry.item) });
        if (entry.missing) btn.addClass('is-missing');
        btn.addEventListener('click', () => self.executeEntry(entry));
      });
      if (!this.recent.length) {
        this.recentEl.createSpan({ cls: 'qp-recent-empty', text: '还没有记录' });
      }
    }

    if (this.statusEl) {
      const parts = [];
      if (this.config.corrupt) parts.push('配置文件读坏了，本次用临时空面板启动（原文件未改动）');
      if (this.config.errors && this.config.errors.length) parts.push(this.config.errors.length + ' 条配置格式不对，已忽略');
      if (this.missing.length) parts.push(this.missing.length + ' 项命令/文件已找不到');
      this.statusEl.setText(parts.join(' · '));
      this.statusEl.toggleClass('is-empty', parts.length === 0);
    }
    this.applyColumnCount();
  }

  /** 列数只在这里改：CSS 变量 + 面板宽度，避免"宽度决定列数、列数又决定宽度"的自我循环 */
  applyColumnCount() {
    const columns = this.config.panel.columns === 'auto' ? gridColumns(gridWidthFor((this.view || window).innerWidth, MAX_PANEL_WIDTH), CELL_MIN, CELL_GAP) : this.config.panel.columns;
    this.columns = columns;
    if (!this.gridEl) return;
    this.gridEl.style.setProperty('--qp-cols', String(columns));
    this.gridEl.style.setProperty('--qp-cell', this.config.panel.iconSize + 'px');
    if (this.modalEl && this.modalEl.style) {
      this.modalEl.style.setProperty('--qp-width', columns * CELL_MIN + (columns - 1) * CELL_GAP + 28 + 'px');
    }
    this.rows = splitColumnCounts(this.visible.length, columns);
  }

  buildCell(entry, index, parent) {
    const btn = parent.createEl('button', { cls: 'qp-cell', attr: { type: 'button', 'data-index': String(index) } });
    this.paintIcon(btn, entry.item);
    const name = this.displayName(entry.item);
    btn.createSpan({ cls: 'qp-cell-label', text: name });
    const iconValue = asString(entry.item.icon);
    const spec = iconSpecOf(iconValue);
    if (spec.reason) btn.setAttribute('title', spec.reason);
    else btn.setAttribute('title', name);
    if (entry.missing) {
      btn.addClass('is-missing');
      btn.setAttribute('aria-disabled', 'true');
      const why = entry.missing === 'command'
        ? '（按了没关系：会问你要不要重新绑定）'
        : '（库内已找不到这个路径）';
      btn.setAttribute('title', name + ' ' + why);
    }
    // 触发方式：click 为主，pointerup 兜底（两者都会调用，但 400ms 内同一条只执行一次）
    this.bindActivate(btn, () => this.executeEntry(entry));
    btn.addEventListener('mouseenter', () => this.setHighlight(index));
    btn.addEventListener('contextmenu', (evt) => this.openItemMenu(evt, entry));
    return btn;
  }

  /**
   * 给一个格子绑定激活。**按下 + 松开**即执行（不依赖 click）。
   *
   * 为什么不用 click（真机三次反馈"点了没反应"，而离线复现证明 click 处理器完全正常）：
   *   click 只有在 mousedown 与 mouseup 落在同一元素上、且元素没被重绘/重挂时才补发；
   *   弹窗里一旦有别的插件/主题在 mousedown 阶段动了 DOM，click 就丢了。
   *   → 改为「pointerdown 记下按在哪个元素、pointerup 若还在同一元素就执行」，另外仍保留 click
   *     作为键盘/程序化触发的兜底，用 600ms 去重避免重复执行。
   */
  bindActivate(el, run) {
    let armed = false;
    const fire = () => {
      const now = Date.now();
      if (this._lastActivate && now - this._lastActivate < 600) return;
      this._lastActivate = now;
      run();
    };
    el.addEventListener('pointerdown', () => {
      armed = true;
    });
    el.addEventListener('pointerup', () => {
      if (!armed) return;
      armed = false;
      fire();
    });
    el.addEventListener('pointercancel', () => {
      armed = false;
    });
    el.addEventListener('pointerleave', () => {
      armed = false;
    });
    el.addEventListener('click', fire);
    return el;
  }

  paintIcon(parent, item) {
    const spec = iconSpecOf(asString(item.icon));
    if (spec.kind === 'image') {
      const path = spec.value;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file) {
        const src = this.app.vault.adapter.getResourcePath(path);
        const img = parent.createEl('img', { cls: 'qp-icon qp-icon-img', attr: { src: src, alt: '' } });
        img.setAttribute('loading', 'lazy');
        return;
      }
      // 图片找不到 → 落到占位图标，并在 title 里说明（不静默空白）
      const ph = parent.createDiv({ cls: 'qp-icon qp-icon-ph' });
      setIcon(ph, 'image-off');
      ph.setAttribute('title', '图标图片找不到：' + path);
      return;
    }
    if (spec.kind === 'emoji') {
      parent.createSpan({ cls: 'qp-icon qp-icon-emoji', text: spec.value });
      return;
    }
    const box = parent.createDiv({ cls: 'qp-icon' });
    const name = spec.kind === 'lucide' ? spec.value : DEFAULT_ICON;
    setIcon(box, name);
    if (spec.kind === 'none' && spec.reason) box.setAttribute('title', spec.reason);
  }

  displayName(item) {
    const label = cleanLabel(item.label);
    if (label) return label;
    const snap = cleanLabel(item.nameSnapshot);
    if (snap) return snap;
    if (itemType(item) === 'command') {
      const cmd = this.host.commandRegistry().find(asString(item.id).trim());
      if (cmd && cleanLabel(cmd.name)) return cleanLabel(cmd.name);
      return asString(item.id).trim() || '(未命名命令)';
    }
    const path = asString(item.path).trim();
    const base = path.split('/').pop() || path;
    return base.replace(/\.md$/i, '') || '(未命名)';
  }

  /* ---- 高亮与键盘 ---- */

  setHighlight(index) {
    if (index === this.highlight) return;
    this.highlight = index;
    const self = this;
    this.cellNodes.forEach(function (node, i) {
      node.toggleClass('is-active', i === index);
    });
    const node = this.cellNodes[index];
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    void self;
  }

  onKeyDown(evt) {
    const key = evt.key;
    if (key === 'Escape') {
      if (this.searchEl && this.searchEl.value) {
        this.searchEl.value = '';
        this.query = '';
        this.render();
        this.setHighlight(0);
        evt.preventDefault();
        return;
      }
      this.close();
      return;
    }
    const target = evt.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
    if (key === 'ArrowRight' || key === 'ArrowLeft' || key === 'ArrowDown' || key === 'ArrowUp') {
      if (key === 'ArrowRight' || key === 'ArrowLeft') {
        this.moveHighlight(key === 'ArrowRight' ? 1 : -1);
      } else {
        // 上下按「行」走，不是按列数硬加 —— 最后一行可能不满
        const next = moveVertical(this.highlight, this.rows, key === 'ArrowDown' ? 1 : -1);
        this.setHighlight(next);
      }
      evt.preventDefault();
      return;
    }
    if (key === 'Home') {
      this.setHighlight(0);
      evt.preventDefault();
      return;
    }
    if (key === 'End') {
      this.setHighlight(this.visible.length - 1);
      evt.preventDefault();
      return;
    }
    if (key === 'Enter') {
      const entry = this.visible[this.highlight];
      if (entry) this.executeEntry(entry);
      evt.preventDefault();
      return;
    }
    if (typing) return;
    // 面板上直接打字 = 过滤（不必先点搜索框）
    if (key.length === 1 && !evt.ctrlKey && !evt.metaKey && !evt.altKey && this.searchEl) {
      this.searchEl.value = this.searchEl.value + key;
      this.query = this.searchEl.value;
      this.searchEl.focus();
      this.render();
      this.setHighlight(0);
      evt.preventDefault();
    }
  }

  moveHighlight(step) {
    if (!this.visible.length) return;
    let next = this.highlight + step;
    if (next < 0) next = 0;
    if (next > this.visible.length - 1) next = this.visible.length - 1;
    this.setHighlight(next);
  }

  /* ---- 执行 ---- */

  /**
   * 取命令对象：**优先直接问 app**（`app.commands.findCommand`，完整的命令表），
   * 面板自己那份注册表只作兜底。
   *
   * ⚠️ 这是"点了没反应"的根因（2026-10-13 真机复现）：面板的注册表来自 `app.commands.listCommands()`，
   *   而官方源码里 `listCommands()` 是**按 checkCallback 过滤过的**：
   *     `Object.values(this.commands).filter(c => !c.checkCallback || c.checkCallback(!0))`
   *   —— 上下文不满足的命令（例如需要活动编辑器、需要特定视图）不会出现在里面。
   *   于是"格子有命令、但 find 不到" → 走进"命令找不到了"分支 → 表现为点了完全没反应。
   */
  commandFor(id) {
    const key = asString(id).trim();
    if (!key) return undefined;
    const direct = this.app && this.app.commands && typeof this.app.commands.findCommand === 'function'
      ? this.app.commands.findCommand(key)
      : undefined;
    if (direct) return direct;
    return this.host.commandRegistry().find(key);
  }

  async executeEntry(entry) {
    if (!entry) return;
    // 点击日志：进诊断文件。若"点了没反应"，这条能立刻区分"点击根本没到"与"命令没跑"
    this.host.logClick(
      '点击 ' + this.displayName(entry.item) + '（type=' + entry.type + (entry.missing ? ', 失效=' + entry.missing : '') + '）'
    );
    if (entry.type === 'command') return this.runCommand(entry.item);
    if (entry.type === 'file') return this.openFile(entry.item);
    if (entry.type === 'folder') return this.revealFolder(entry.item);
    return undefined;
  }

  /** 执行命令：先取到命令对象（问 app，不靠过滤过的列表）→ 需要编辑器的先聚焦 → 直接调用 */
  async runCommand(item) {
    const id = asString(item.id).trim();
    const registry = this.host.commandRegistry();
    const cmd = this.commandFor(id);
    if (!cmd) {
      const snapshot = cleanLabel(item.nameSnapshot) || cleanLabel(item.label) || id;
      const guess = registry.findByName(snapshot);
      const self = this;
      new ConfirmLikeModal(this.app, '这条命令已经找不到了', [
        { label: '原记录：' + id, muted: true },
        guess
          ? { label: '发现同名命令：' + guess.name + '（' + guess.id + '）' }
          : { label: '面板里没有同名的命令可以替代' },
      ], [
        guess
          ? {
              label: '重新绑定到 ' + guess.name,
              onClick: function () {
                self.host.rebindCommand(item, guess.id, guess.name);
                new Notice('已重新绑定：' + guess.name + '（' + guess.id + '）');
                self.host.reopen();
                self.silentClose();
              },
            }
          : null,
        {
          label: '仍要执行（若命令只是暂时不可用）',
          onClick: function () {
            self.silentClose();
            self.host.runCommandById(id, null);
          },
        },
      ]).open();
      return;
    }

    const needsEditor = typeof cmd.editorCallback === 'function' || typeof cmd.editorCheckCallback === 'function';
    const editor = this.app.workspace.activeEditor;
    // 用户 2026-10-13 定的方向：**不关面板、不用定时器，直接调用**。
    // 原先"关面板 → 写最近记录 → setTimeout → 再调用"这条链上任何一步出错都会停在调用之前
    // （Obsidian 里 setTimeout 还可能被节流），这与 Ctrl+P 的做法也不一致 —— 命令面板就是直接调。
    if (needsEditor && editor && typeof editor.focus === 'function') {
      try {
        editor.focus();
      } catch (e) {
        this.host.logExecution('! 聚焦失败：' + ((e && e.message) || e));
      }
    }
    try {
      this.host.runCommandById(id, cmd);
    } catch (e) {
      this.host.logExecution('✗ 调用命令时抛错：' + ((e && e.message) || e));
      new Notice('执行「' + id + '」时出错：' + ((e && e.message) || e), 10000);
    }
    // 最近使用改成"只更新内存里的顺序、面板重绘时顺带写盘"，不再在点击路径上写文件
    try {
      this.host.touchRecent(item);
    } catch (e) {
      /* 最近使用失败不影响执行 */
    }
    return undefined;
  }

  async openFile(item) {
    const path = normalizeVaultPath(asString(item.path).trim());
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      new Notice('找不到这个文件：' + path + '（它可能被改名或删除，面板里这条已标灰）');
      return undefined;
    }
    this.silentClose();
    this.host.touchRecent(item);
    await this.app.workspace.getLeaf(false).openFile(file);
    return undefined;
  }

  async revealFolder(item) {
    const path = normalizeVaultPath(asString(item.path).trim());
    const folder = this.app.vault.getAbstractFileByPath(path);
    if (!folder) {
      new Notice('找不到这个文件夹：' + path);
      return undefined;
    }
    this.silentClose();
    this.host.touchRecent(item);
    // 核心插件里取「已启用」的文件浏览器实例（实测 obsidian.asar 里：internalPlugins.getEnabledPluginById）
    const ip = this.app.internalPlugins;
    const explorer = ip && typeof ip.getEnabledPluginById === 'function'
      ? ip.getEnabledPluginById('file-explorer')
      : (ip && typeof ip.getPluginById === 'function' ? ip.getPluginById('file-explorer') : null);
    if (explorer && typeof explorer.revealInFolder === 'function') {
      explorer.revealInFolder(folder);
      return undefined;
    }
    new Notice('文件浏览器没有启用，无法定位：' + path);
    return undefined;
  }

  /** 关闭面板（执行前先关，焦点才能回到编辑器 / 新窗口） */
  silentClose() {
    this.close();
  }

  /* ---- 菜单（本批只有「更多」；格子右键下一批） ---- */

  openItemMenu(evt, entry) {
    evt.preventDefault();
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle('这一格：' + this.displayName(entry.item)).setIcon('info').setDisabled(true)
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle('打开配置文件（快捷面板.json）')
        .setIcon('file-text')
        .onClick(() => this.host.openConfigFile())
    );
    menu.addItem((i) =>
      i
        .setTitle(entry.missing === 'command' ? '这条命令已失效 —— 重新绑定' : '重新绑定到同名命令')
        .setIcon('link')
        .onClick(() => {
          const snapshot = cleanLabel(entry.item.nameSnapshot) || cleanLabel(entry.item.label) || asString(entry.item.id);
          const guess = this.host.commandRegistry().findByName(snapshot);
          if (!guess) {
            new Notice('没找到同名命令，没法自动重新绑定');
            return;
          }
          this.host.rebindCommand(entry.item, guess.id, guess.name);
          new Notice('已重新绑定：' + guess.name + '（' + guess.id + '）');
          this.host.reopen();
          this.silentClose();
        })
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle('编辑/添加格子 —— 下一批做')
        .setIcon('edit')
        .setDisabled(true)
    );
    menu.showAtMouseEvent(evt);
  }

  openMoreMenu(evt) {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle('打开配置文件（快捷面板.json）').setIcon('file-text').onClick(() => this.host.openConfigFile())
    );
    menu.addItem((i) =>
      i.setTitle('在文件浏览器中定位配置文件').setIcon('folder').onClick(() => this.host.revealConfigFile())
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle('重新加载面板').setIcon('refresh-cw').onClick(() => this.host.reopen())
    );
    menu.addItem((i) =>
      i
        .setTitle(this.config.panel.showRecent ? '关闭「最近用过」（直接改 JSON 生效）' : '开启「最近用过」（直接改 JSON 生效）')
        .setIcon('clock')
        .onClick(() => {
          this.config.panel.showRecent = !this.config.panel.showRecent;
          this.host.savePanelConfig(this.config);
          this.host.reopen();
          this.silentClose();
        })
    );
    if (evt && evt.clientX !== undefined) menu.showAtMouseEvent(evt);
    else menu.showAtPosition({ x: (this.view || window).innerWidth / 2, y: 80 });
  }

  /* ---- 视图 ---- */

  /** 面板所在窗口（主窗口或弹窗）。this.view 存的就是 window，不是 document。 */
  getWindow() {
    return this.view || (this.modalEl && this.modalEl.ownerDocument && this.modalEl.ownerDocument.defaultView) || window;
  }

  /**
   * 绑定"面板所在的窗口"（主窗口与 popout 是不同 window）。
   *
   * 位置**不需要**它：居中完全由 CSS flex 负责（见 styles.css），这里只用于诊断时读视口尺寸。
   * 这条是三轮真机教训换来的：JS 参与定位就会在不同 DPI / 窗口布局下飘。
   */
  setView(doc) {
    const given = doc || document;
    this.view = (given && given.defaultView) || window;
  }
}

/** 极简确认窗（避免为一个确认动作引入一套 UI 依赖） */
class ConfirmLikeModal extends Modal {
  constructor(app, title, lines, actions) {
    super(app);
    this.qpTitle = title;
    this.lines = lines || [];
    this.actions = (actions || []).filter(Boolean);
  }

  onOpen() {
    this.modalEl.addClass('quick-panel');
    this.modalEl.addClass('qp-confirm');
    this.contentEl.createDiv({ cls: 'qp-confirm-title', text: this.qpTitle });
    const body = this.contentEl.createDiv({ cls: 'qp-confirm-body' });
    this.lines.forEach((l) => {
      const row = body.createDiv({ cls: 'qp-confirm-line' + (l.muted ? ' is-muted' : '') });
      row.setText(l.label);
    });
    const foot = this.contentEl.createDiv({ cls: 'qp-confirm-actions' });
    this.actions.forEach((a) => {
      const btn = foot.createEl('button', { cls: 'qp-btn', attr: { type: 'button' } });
      btn.setText(a.label);
      btn.addEventListener('click', () => {
        this.close();
        a.onClick();
      });
    });
    const cancel = foot.createEl('button', { cls: 'qp-btn is-ghost', attr: { type: 'button' } });
    cancel.setText('取消');
    cancel.addEventListener('click', () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

const DEFAULT_ICON = 'circle-dot';

/* =====================================================================================
 * 五、插件本体
 * ===================================================================================== */

class QuickPanelPlugin extends Plugin {
  async onload() {
    this.configPath = CONFIG_NAME;
    this.config = null;
    this.configNotice = '';
    this.registry = null;

    /*
     * 启动阶段零监听：面板居中，不需要跟踪鼠标，也不注册任何常驻事件。
     * （曾有一版为了"呼出在鼠标位置"挂过 mousemove；用户 2026-10-13 裁定改居中后已移除。）
     */

    // 只读一次配置：读坏不覆盖，用空面板起步并提示
    const loaded = await this.readPanelConfig();
    this.config = loaded.config;
    this.configNotice = loaded.notice;
    this.loadedFromDisk = loaded.fromDisk;

    this.addRibbonIcon('layout-grid', '快捷面板', () => this.openPanel());

    this.addCommand({
      id: 'open',
      name: '打开快捷面板',
      hotkeys: [{ modifiers: ['Mod', 'Alt'], key: ' ' }],
      callback: () => this.openPanel(),
    });
    this.addCommand({
      id: 'open-config',
      name: '打开配置文件（快捷面板.json）',
      callback: () => this.openConfigFile(),
    });
    // 故障排查用：打开面板后跑这条，把真实几何写进库根 .quick-panel-diag.txt（可随时删）
    this.addCommand({
      id: 'diagnose',
      name: '导出面板诊断（排查显示问题用）',
      callback: () => this.dumpPanelDiagnostics(),
    });

    if (this.configNotice) new Notice(this.configNotice, 8000);
  }

  onunload() {
    // 无定时器、无常驻监听需要手动清 —— 保持「卸载即干净」
  }

  /* ---- 配置读写（唯一被写的文件） ---- */

  async readPanelConfig() {
    const adapter = this.app.vault.adapter;
    let exists = false;
    let renameNotice = '';
    try {
      exists = await adapter.exists(this.configPath);
    } catch (e) {
      exists = false;
    }
    // 旧文件名迁移（面板改名那次留下的）：新名不存在、旧名存在 → 搬过去，内容一字不改
    if (!exists) {
      try {
        const legacyExists = await adapter.exists(CONFIG_NAME_LEGACY);
        if (legacyExists) {
          const oldText = await adapter.read(CONFIG_NAME_LEGACY);
          await adapter.write(this.configPath, oldText);
          try {
            await adapter.remove(CONFIG_NAME_LEGACY);
          } catch (e) {
            /* 删不掉旧的也无所谓：下次启动新名已存在，不会再迁 */
          }
          exists = true;
          renameNotice = '已把 ' + CONFIG_NAME_LEGACY + ' 改名为 ' + CONFIG_NAME + '（内容未改动，格子都在）。';
        }
      } catch (e) {
        /* 迁移失败就按"没有配置"走，不阻塞使用 */
      }
    }
    if (!exists) {
      const fresh = normalizePanelConfig({ version: CONFIG_VERSION, panel: null, items: DEMO_ITEMS, recent: [] });
      try {
        await this.writePanelConfig(fresh, { silent: true });
        return {
          config: fresh,
          fromDisk: false,
          notice: '已创建 ' + CONFIG_NAME + '（库根），并放了几个示例格子；随时可编辑或删掉。',
        };
      } catch (e) {
        return {
          config: fresh,
          fromDisk: false,
          notice: '没能创建 ' + CONFIG_NAME + '：' + ((e && e.message) || e) + '（本次用临时面板，不影响使用）',
        };
      }
    }
    let text = '';
    try {
      text = await adapter.read(this.configPath);
    } catch (e) {
      return {
        config: normalizePanelConfig(null),
        fromDisk: false,
        notice: '读 ' + CONFIG_NAME + ' 失败：' + ((e && e.message) || e) + '（原文件没有改动）',
      };
    }
    const parsed = parsePanelFile(text);
    if (parsed.corrupt) {
      return {
        config: normalizePanelConfig(null),
        fromDisk: false,
        notice: CONFIG_NAME + ' 不是合法的 JSON（' + parsed.parseError + '）。已保留原文件、本次用空面板启动，改好后再打开面板即可。',
      };
    }
    if (parsed.errors.length) {
      return {
        config: parsed,
        fromDisk: true,
        notice: '配置里有 ' + parsed.errors.length + ' 条格式不对，已忽略：' + parsed.errors.slice(0, 3).join('；'),
      };
    }
    // 结构升级 v1 → v2：把示例格换成核验过的核心命令（旧那 6 条里有 context 相关的，点了会没反应）
    if (parsed.version < CONFIG_VERSION) {
      const upgraded = await this.upgradeConfig(parsed);
      return {
        config: upgraded,
        fromDisk: true,
        notice:
          renameNotice +
          '已把面板升级到 v' + CONFIG_VERSION + '：默认格子换成核验过的核心命令（旧示例里的"关系图谱/后退/前进"依赖上下文，点了不一定会执行）。',
      };
    }
    // v2 之后又追加过一条口径（用户反馈"面板里不该有搜索框"）：随加载就地改掉，不用等下次升级
    if (parsed.panel && parsed.panel.showSearch === true) {
      const trimmed = normalizePanelConfig({
        version: CONFIG_VERSION,
        panel: Object.assign({}, parsed.panel, { showSearch: false }),
        items: parsed.items,
        recent: parsed.recent,
      });
      this.config = trimmed;
      try {
        await this.writePanelConfig(trimmed, { silent: true });
      } catch (e) {
        /* 写不进去也不影响本次使用 */
      }
      return { config: trimmed, fromDisk: true, notice: renameNotice };
    }
    return { config: parsed, fromDisk: true, notice: renameNotice };
  }

  /** 结构升级：只换掉"还是默认示例"的那些格子，用户自己加的条目一律保留 */
  async upgradeConfig(config) {
    const defaultIds = ['app:open-settings', 'app:reload', 'global-search', 'graph:open', 'app:go-back', 'app:go-forward'];
    const items = config.items || [];
    const isStock =
      items.length > 0 &&
      items.every(function (it) {
        return itemType(it) === 'command' && defaultIds.indexOf(asString(it.id).trim()) >= 0;
      });
    const next = normalizePanelConfig({
      version: CONFIG_VERSION,
      panel: Object.assign({}, config.panel, { showSearch: false }),
      items: isStock ? V2_DEFAULT_ITEMS : items,
      recent: config.recent,
    });
    this.config = next;
    try {
      await this.writePanelConfig(next, { silent: true });
    } catch (e) {
      /* 写不进去也不影响本次使用 */
    }
    return next;
  }

  async writePanelConfig(config, opts) {
    const options = opts || {};
    const text = serializePanelText(config);
    await this.app.vault.adapter.write(this.configPath, text);
    if (!options.silent) new Notice('已保存 ' + CONFIG_NAME);
  }

  async savePanelConfig(config) {
    this.config = config;
    try {
      await this.writePanelConfig(config);
    } catch (e) {
      new Notice('保存 ' + CONFIG_NAME + ' 失败：' + ((e && e.message) || e));
    }
  }

  openConfigFile() {
    const adapter = this.app.vault.adapter;
    if (adapter && typeof adapter.getFullPath === 'function') {
      const abs = adapter.getFullPath(this.configPath);
      // 走系统默认程序打开（JSON 用记事本 / VS Code 都行）
      const electron = require('electron');
      if (electron && electron.shell && typeof electron.shell.openPath === 'function') {
        electron.shell.openPath(abs);
        return;
      }
      new Notice('配置文件完整路径：' + abs);
      return;
    }
    new Notice('拿不到库的绝对路径，请手动打开库根的 ' + CONFIG_NAME);
  }

  revealConfigFile() {
    const f = this.app.vault.getAbstractFileByPath(this.configPath);
    if (!f) {
      new Notice('配置文件不在库里：' + this.configPath);
      return;
    }
    const ip = this.app.internalPlugins;
    const explorer = ip && typeof ip.getEnabledPluginById === 'function'
      ? ip.getEnabledPluginById('file-explorer')
      : (ip && typeof ip.getPluginById === 'function' ? ip.getPluginById('file-explorer') : null);
    if (explorer && typeof explorer.revealInFolder === 'function') {
      explorer.revealInFolder(f);
      return;
    }
    new Notice('文件浏览器没有启用，无法定位');
  }

  /* ---- 命令表（只在打开面板 / 需要时解析，启动不碰） ---- */

  commandRegistry() {
    if (this.registry) return this.registry;
    const commands = this.app.commands.listCommands() || [];
    const byId = Object.create(null);
    const byName = Object.create(null);
    commands.forEach(function (c) {
      if (!c || !c.id) return;
      byId[c.id] = c;
      const name = cleanLabel(c.name);
      if (name && !byName[name]) byName[name] = c;
    });
    this.registry = {
      all: commands,
      find: (id) => (id ? byId[id] : undefined),
      findByName: (name) => (name ? byName[cleanLabel(name)] : undefined),
      invalidate: () => {
        this.registry = null;
      },
    };
    return this.registry;
  }

  /**
   * 执行命令并把结果说出来（失败绝不静默）。
   *
   * ⚠️ 关键事实（2026-10-13 从 obsidian.asar 读出来的）：
   *   `executeCommandById(id, evt)` 内部 = `findCommand` + `executeCommand`；
   *   而 `executeCommand` 会调用内部 `o5(cmd)` —— 它在 cmd 自带 callback / checkCallback /
   *   editorCallback / editorCheckCallback 时**同步调用**并返回结果，但**没有 `return` 那一层的值**，
   *   所以官方 API 的返回值对这类命令**不可靠**（拿到的可能是 undefined 或一个 Promise）；
   *   并且命令内部抛异常时是 `console.error` 吞掉、**不往外抛**。
   *   → 所以这里要三件事：① 执行前后都校验命令是否还在注册表里；② await 掉返回值（Promise 的拒绝
   *   也要落成可见提示）；③ 自己给"什么都没发生"兜一层提示，不假装成功。连点两次会被我们判定为
   *   "这条命令没法在面板里直接执行"（例如它需要一个活动编辑器），并告诉用户去命令面板跑。
   */
  runCommandById(id, cmd) {
    const registry = this.commandRegistry();
    const target = cmd || registry.find(id);
    const label = target && cleanLabel(target.name) ? cleanLabel(target.name) : id;
    if (!target) {
      new Notice('这条命令已经不在注册表里了：' + id + '（右键这个格子可以重新绑定）', 8000);
      return false;
    }
    const needsEditor = typeof target.editorCallback === 'function' || typeof target.editorCheckCallback === 'function';
    if (needsEditor && !this.app.workspace.activeEditor) {
      new Notice('「' + label + '」需要先打开一个笔记才能执行', 8000);
      return false;
    }
    // 记录"命令真的被调用了"（诊断文件里用它区分"点击没到面板""命令没跑""命令跑了但无可见反馈"）
    this.logExecution('→ 调用命令 ' + id + '（' + label + '）');
    let result;
    try {
      result = this.app.commands.executeCommandById(id);
    } catch (e) {
      this.logExecution('✗ 抛出异常 ' + id + '：' + ((e && e.message) || e));
      new Notice('执行「' + label + '」出错：' + ((e && e.message) || e), 10000);
      return false;
    }
    this.logExecution('← 返回 ' + (result && typeof result.then === 'function' ? 'Promise' : String(result)) + '（' + id + '）');
    // 异步类命令：把 Promise 的拒绝也变成可见提示（否则就是一个静默的 unhandled rejection）
    if (result && typeof result.then === 'function') {
      result.then(
        () => {},
        (e) => new Notice('执行「' + label + '」时出错：' + ((e && e.message) || e), 10000)
      );
    }
    // 命令可能内部把自己注销（例如打开设置面板后重载），执行后再核一次
    if (!registry.find(id)) {
      new Notice('「' + label + '」执行后已不在注册表里（原命令 id：' + id + '）', 8000);
    }
    this.logExecution(label);
    return true;
  }

  /**
   * 诊断：把「面板到底被渲染成什么样」写进库根 .quick-panel-diag.txt。
   * 用它替代"让用户截图/复制控制台"—— agent 直接读文件就能定性。
   */
  async dumpPanelDiagnostics() {
    const box = (el) => {
      if (!el) return '缺失';
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!r) return '无 rect';
      return (
        'x=' + Math.round(r.left) + ' y=' + Math.round(r.top) +
        ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height)
      );
    };
    const styleOf = (el, props) => {
      if (!el) return '缺失';
      const cs = this.getWindow().getComputedStyle(el);
      return props.map((p) => p + '=' + cs.getPropertyValue(p)).join(' ');
    };
    const lines = [];
    lines.push('quick-panel 诊断 · ' + new Date().toISOString() + '（本文件可随时删除）');
    const diagWin = this.modal ? this.modal.getWindow() : window;
    lines.push('viewport ' + diagWin.innerWidth + 'x' + diagWin.innerHeight + ' dpr=' + diagWin.devicePixelRatio);
    lines.push('布局：窗口居中（不跟随鼠标）');
    const modal = this.modal;
    if (!modal) {
      const el = document.querySelector('.modal-container.quick-panel');
      lines.push('当前没有活动面板实例；dom 里' + (el ? '有' : '没有') + ' .modal-container.quick-panel');
      if (el) {
        lines.push('  container ' + box(el) + ' | ' + styleOf(el, ['position', 'width', 'height', 'display', 'transform']));
        const card = el.querySelector('.modal');
        lines.push('  card ' + box(card) + ' | ' + styleOf(card, ['position', 'width', 'max-width', 'padding']));
      }
      new Notice('没有活动的面板实例；已导出 DOM 现状到库根 .quick-panel-diag.txt');
    } else {
      const container = modal.containerEl || (modal.modalEl && modal.modalEl.closest ? modal.modalEl.closest('.modal-container') : null);
      const card = modal.modalEl;
      lines.push('配置：' + this.configPath + '（来自磁盘=' + this.loadedFromDisk + '） corrupt=' + !!modal.config.corrupt);
      lines.push('解析到的命令条目数=' + (this.registry ? this.registry.all.length : '未解析') +
        '；面板条目=' + modal.items.length + '；可见=' + modal.visible.length + '；缺失=' + modal.missing.length);
      lines.push('columns=' + modal.columns + ' rows=' + JSON.stringify(modal.rows) + ' query=' + JSON.stringify(modal.query));
      lines.push('container ' + box(container) + ' | ' + styleOf(container, ['position', 'width', 'height', 'display', 'transform', 'opacity']));
      lines.push('  container id/class: ' + (container ? container.id + ' / ' + container.className : ''));
      lines.push('card ' + box(card) + ' | ' + styleOf(card, ['position', 'left', 'top', 'width', 'max-width', 'padding', 'min-height']));
      lines.push('  modalEl 内联 left=' + (card ? card.style.left : '') + ' top=' + (card ? card.style.top : '') +
        ' --qp-width=' + (card && card.style.getPropertyValue ? card.style.getPropertyValue('--qp-width') : ''));
      const bg = container && container.querySelector ? container.querySelector('.modal-bg') : null;
      lines.push('bg ' + box(bg) + ' | ' + styleOf(bg, ['position', 'width', 'height', 'background-color', 'opacity']));
      const content = modal.contentEl;
      lines.push('content ' + box(content) + ' | ' + styleOf(content, ['display', 'max-height', 'overflow']));
      const grid = modal.gridEl;
      lines.push('grid ' + box(grid) + ' | ' + styleOf(grid, ['display', 'grid-template-columns', 'gap', 'width']));
      const cells = content && content.querySelectorAll ? content.querySelectorAll('.qp-cell') : [];
      lines.push('cells=' + cells.length + '；首格 ' + (cells[0] ? box(cells[0]) + ' | ' + styleOf(cells[0], ['display', 'width', 'height', 'background-color', 'opacity']) : '（无）'));
      if (cells[0] && cells[0].querySelector) {
        const lbl = cells[0].querySelector('.qp-cell-label');
        lines.push('  首格 label="' + (lbl ? lbl.textContent : '') + '" title="' + (cells[0].getAttribute('title') || '') + '"');
      }
      lines.push('最近用过=' + modal.recent.length + '；状态栏="' + (modal.statusEl ? modal.statusEl.textContent : '') + '"');
      if (modal.searchEl) lines.push('搜索框 ' + box(modal.searchEl));
      lines.push('最近 5 次执行：' + (this.execLog.slice(-5).map((e) => e.name).join(' / ') || '（无）'));
      lines.push('--- 最近 14 条点击/执行（▸ = 点击到了面板，无 ▸ 说明点击根本没到面板）---');
      const tail = this.execLog.slice(-14);
      if (!tail.length) lines.push('（空：还没点过任何格子）');
      tail.forEach((e) => lines.push('  ' + e.at + '  ' + e.name));
      new Notice('已导出诊断到库根 .quick-panel-diag.txt（' + lines.length + ' 行）');
    }
    const text = lines.join('\n') + '\n';
    // 三重落盘：adapter → vault.create/modify → 直接 fs 写库根绝对路径。
    // （用户反馈"诊断命令也无效、不生成文件"：单靠 adapter 有时会静默失败）
    const rel = '.quick-panel-diag.txt';
    let written = '';
    try {
      await this.app.vault.adapter.write(rel, text);
      written = 'vault.adapter';
    } catch (e) {
      written = '';
    }
    if (!written) {
      try {
        const existing = this.app.vault.getAbstractFileByPath(rel);
        if (existing) await this.app.vault.modify(existing, text);
        else await this.app.vault.create(rel, text);
        written = 'vault.create/modify';
      } catch (e) {
        written = '';
      }
    }
    if (!written) {
      try {
        const adapter = this.app.vault.adapter;
        const base = typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : adapter.basePath;
        if (!base) throw new Error('拿不到库的绝对路径');
        const fs = require('fs');
        const path = require('path');
        fs.writeFileSync(path.join(base, rel), text, 'utf8');
        written = 'fs.writeFileSync';
      } catch (e) {
        written = '';
      }
    }
    if (written) {
      new Notice('已导出诊断：库根 ' + rel + '（' + lines.length + ' 行，写入方式 ' + written + '）', 8000);
    } else {
      // 三条路全失败：把内容塞进控制台并留下可见提示，不静默
      console.log('==== quick-panel 诊断 ====\n' + text);
      new Notice('诊断文件写不进去（已打印到控制台）。请按 Ctrl+Shift+I 打开控制台复制。', 12000);
    }
  }

  /** 记一笔「最近用过」：只写配置文件，且失败也不打扰用户（不影响主流程） */
  touchRecent(item) {
    try {
      const now = Date.now();
      const entry = { type: itemType(item), usedAt: now };
      if (entry.type === 'command') entry.id = asString(item.id).trim();
      else entry.path = normalizeVaultPath(asString(item.path).trim());
      this.config.recent = pushRecent(this.config.recent, entry, RECENT_LIMIT);
      // 落盘延后 1 秒：点击路径上不做文件 I/O（同步盘锁文件时写入会拖慢甚至失败）
      if (this._recentTimer) clearTimeout(this._recentTimer);
      this._recentTimer = setTimeout(() => {
        this._recentTimer = null;
        try {
          this.writePanelConfig(this.config, { silent: true });
        } catch (e) {
          /* 最近记录失败不影响使用 */
        }
      }, 1000);
    } catch (e) {
      /* 最近记录失败不影响使用 */
    }
  }

  /** 失效命令重新绑定：改 id、留新快照、立刻写盘 */
  rebindCommand(item, newId, newName) {
    const target = this.config.items.filter(function (it) {
      return itemType(it) === 'command' && asString(it.id).trim() === asString(item.id).trim();
    })[0];
    if (!target) return;
    target.id = newId;
    target.nameSnapshot = cleanLabel(newName);
    this.savePanelConfig(this.config);
  }

  /** 记一笔执行历史（进诊断文件用；面板最多留 50 条） */
  logExecution(label) {
    this.execLog = this.execLog || [];
    this.execLog.push({ at: new Date().toISOString(), name: label });
    if (this.execLog.length > 50) this.execLog.splice(0, this.execLog.length - 50);
  }

  /** 记一次点击（与 logExecution 同一个日志，前缀区分）—— 排查"点了没反应"用 */
  logClick(label) {
    this.logExecution('▸ ' + label);
  }

  /* ---- 面板 ---- */

  openPanel() {
    // 每次打开都重读配置：用户可能在编辑器里刚改过 JSON
    this.readPanelConfig().then((loaded) => {
      this.config = loaded.config;
      if (loaded.notice) new Notice(loaded.notice, 8000);
      this.openPanelWith(this.config);
    });
  }

  openPanelWith(config) {
    this.commandRegistry().invalidate(); // 插件启用/停用会改命令表，每次打开重新解析
    const modal = new QuickPanelModal(this.app, this, config, {});
    this.modal = modal;
    modal.open();
  }

  reopen() {
    this.openPanel();
  }
}

module.exports = QuickPanelPlugin;
module.exports.QuickPanelPlugin = QuickPanelPlugin;
module.exports.QuickPanelModal = QuickPanelModal;
// 纯函数（tools/test.mjs 离线断言用）
module.exports.CONFIG_NAME = CONFIG_NAME;
module.exports.CONFIG_NAME_LEGACY = CONFIG_NAME_LEGACY;
module.exports.CONFIG_VERSION = CONFIG_VERSION;
module.exports.RECENT_LIMIT = RECENT_LIMIT;
module.exports.CELL_MIN = CELL_MIN;
module.exports.LUCIDE_CANDIDATES = LUCIDE_CANDIDATES;
module.exports.DEMO_ITEMS = DEMO_ITEMS;
module.exports.asString = asString;
module.exports.cleanLabel = cleanLabel;
module.exports.itemType = itemType;
module.exports.validateItem = validateItem;
module.exports.normalizePanelSettings = normalizePanelSettings;
module.exports.normalizePanelConfig = normalizePanelConfig;
module.exports.serializePanel = serializePanel;
module.exports.itemKey = itemKey;
module.exports.iconSpecOf = iconSpecOf;
module.exports.iconCandidates = iconCandidates;
module.exports.gridColumns = gridColumns;
module.exports.gridWidthFor = gridWidthFor;
module.exports.MAX_PANEL_WIDTH = MAX_PANEL_WIDTH;
module.exports.pushRecent = pushRecent;
module.exports.splitColumnCounts = splitColumnCounts;
module.exports.moveVertical = moveVertical;
module.exports.findMissingItems = findMissingItems;
module.exports.filterItems = filterItems;
module.exports.parsePanelFile = parsePanelFile;
module.exports.serializePanelText = serializePanelText;
