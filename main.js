'use strict';
/*
 * Quick Panel（快接面板）— v0.1.0
 *
 * 一句话：一个快捷键在 Obsidian 窗口内呼出「图标网格面板」，格子里是你自己挑的命令 / 笔记 / 文件夹。
 *
 * 五条设计红线（改代码前先读）：
 *   1) 启动零扫描：onload 只读一次配置 + 注册一条命令 + 一个 ribbon 图标，不调 listCommands()、
 *      不扫库、不起定时器、不挂常驻监听。命令表在「打开面板」那一刻才解析。
 *   2) 配置真源是库内可见文件 <库根>/快接面板.json；data.json 只存 UI 状态（面板位置）。
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
const CONFIG_NAME = '快接面板.json';

/** 配置文件结构版本；将来结构变了用它做迁移判断 */
const CONFIG_VERSION = 1;

/** 「最近用过」最多保留几条 */
const RECENT_LIMIT = 12;

/** 图标格最小宽度（px）；列数由「容器宽度 ÷ 这个值」决定 */
const CELL_MIN = 72;

/** 格子间距（px）；与 styles.css 里的 gap 必须一致 */
const CELL_GAP = 8;

/** 面板离屏幕边缘的最小留白（px） */
const EDGE_GAP = 12;

/** 命令执行前的等待：面板要先销毁，焦点才能干净地回到编辑器/新窗口 */
const EXEC_DELAY_MS = 40;

/** 网格可用宽度的上限（px）—— 视口再宽也不让面板摊成一片 */
const MAX_PANEL_WIDTH = 860;

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

/** 首次运行灌入的示例格子：都是 Obsidian 自己的命令，随时可删 */
const DEMO_ITEMS = [
  { type: 'command', id: 'app:open-settings', label: '设置', icon: 'settings' },
  { type: 'command', id: 'app:reload', label: '重载应用', icon: 'refresh-cw' },
  { type: 'command', id: 'global-search', label: '全局搜索', icon: 'search' },
  { type: 'command', id: 'graph:open', label: '关系图谱', icon: 'git-branch' },
  { type: 'command', id: 'app:go-back', label: '后退', icon: 'arrow-left-right' },
  { type: 'command', id: 'app:go-forward', label: '前进', icon: 'arrow-left-right' },
];

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
    showSearch: true,
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
    this.mouse = this.opts.mouse || null;
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
    this.placeAtMouse();
    this.registerDomEvent(window, 'resize', () => this.placeAtMouse());
    window.setTimeout(() => {
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
    title.createSpan({ cls: 'qp-title-text', text: '快接面板' });
    title.createSpan({
      cls: 'qp-count',
      text: this.items.length + ' 格' + (this.missing.length ? ' · ' + this.missing.length + ' 项待处理' : ''),
    });

    const actions = header.createDiv({ cls: 'qp-actions' });
    const addBtn = actions.createEl('button', { cls: 'qp-icon-btn', attr: { type: 'button' } });
    setIcon(addBtn, 'plus');
    addBtn.setAttribute('aria-label', '添加（下一批实现）');
    addBtn.addEventListener('click', () => {
      new Notice('「即时添加」在下一批实现：先用文本编辑器打开 快接面板.json 手写一条');
    });
    const menuBtn = actions.createEl('button', { cls: 'qp-icon-btn', attr: { type: 'button' } });
    setIcon(menuBtn, 'more-horizontal');
    menuBtn.setAttribute('aria-label', '更多');
    menuBtn.addEventListener('click', (evt) => this.openMoreMenu(evt));
    const closeBtn = actions.createEl('button', { cls: 'qp-icon-btn', attr: { type: 'button' } });
    setIcon(closeBtn, 'x');
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.addEventListener('click', () => this.close());

    this.makeDraggable(header);
  }

  buildSearch() {
    const wrap = this.contentEl.createDiv({ cls: 'qp-search' });
    const input = wrap.createEl('input', {
      cls: 'qp-search-input',
      attr: { type: 'text', placeholder: '过滤面板（Enter 执行第一格 · Esc 清空）' },
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

  buildFooter() {
    const foot = this.contentEl.createDiv({ cls: 'qp-footer' });
    this.statusEl = foot.createDiv({ cls: 'qp-status' });
    const hint = foot.createDiv({ cls: 'qp-hint' });
    hint.setText('方向键选择 · Enter 执行 · 直接打字过滤 · Esc 关闭');
  }

  makeDraggable(handle) {
    let dragX = 0;
    let dragY = 0;
    let startX = 0;
    let startY = 0;
    let dragging = false;
    const onMove = (evt) => {
      if (!dragging) return;
      this.moveTo(startX + (evt.clientX - dragX), startY + (evt.clientY - dragY));
      evt.preventDefault();
    };
    const onUp = () => {
      dragging = false;
      document.body.removeClass('qp-dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    handle.addEventListener('mousedown', (evt) => {
      if (evt.button !== 0) return;
      const t = evt.target;
      if (t && t.closest && t.closest('button')) return;
      dragging = true;
      dragX = evt.clientX;
      dragY = evt.clientY;
      const rect = this.modalEl.getBoundingClientRect();
      startX = rect.left;
      startY = rect.top;
      document.body.addClass('qp-dragging');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      evt.preventDefault();
    });
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
          : '面板还是空的：编辑 快接面板.json 加条目，或用下一批的「面板内即时添加」',
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
    this.placeAtMouse();
  }

  /** 列数只在这里改：CSS 变量 + 面板宽度，避免"宽度决定列数、列数又决定宽度"的自我循环 */
  applyColumnCount() {
    const columns = this.config.panel.columns === 'auto' ? gridColumns(gridWidthFor(window.innerWidth, MAX_PANEL_WIDTH), CELL_MIN, CELL_GAP) : this.config.panel.columns;
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
    btn.addEventListener('click', () => this.executeEntry(entry));
    btn.addEventListener('mouseenter', () => this.setHighlight(index));
    btn.addEventListener('contextmenu', (evt) => this.openItemMenu(evt, entry));
    return btn;
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

  async executeEntry(entry) {
    if (!entry) return;
    if (entry.type === 'command') return this.runCommand(entry.item);
    if (entry.type === 'file') return this.openFile(entry.item);
    if (entry.type === 'folder') return this.revealFolder(entry.item);
    return undefined;
  }

  /** 执行命令：先查在不在 → 面板先关 → 需要编辑器的先聚焦 → 执行 → 失败一律出声 */
  async runCommand(item) {
    const id = asString(item.id).trim();
    const registry = this.host.commandRegistry();
    const cmd = registry.find(id);
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
            self.host.runCommandById(id, null, true);
          },
        },
      ]).open();
      return;
    }

    const needsEditor = typeof cmd.editorCallback === 'function' || typeof cmd.editorCheckCallback === 'function';
    const editor = this.app.workspace.activeEditor;
    this.silentClose();
    this.host.touchRecent(item);
    window.setTimeout(function () {
      if (needsEditor && editor && typeof editor.focus === 'function') {
        try {
          editor.focus();
        } catch (e) {
          /* 聚焦失败不致命，继续执行，失败提示由 executeCommandById 给 */
        }
      }
      this.host.runCommandById(id, cmd, false);
    }.bind(this), needsEditor ? EXEC_DELAY_MS : 0);
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
        .setTitle('打开配置文件（快接面板.json）')
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
      i.setTitle('打开配置文件（快接面板.json）').setIcon('file-text').onClick(() => this.host.openConfigFile())
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
    else menu.showAtPosition({ x: window.innerWidth / 2, y: 80 });
  }

  /* ---- 定位 ---- */

  /**
   * 把面板放在鼠标位置（右下偏移一点），并保证整块面板都在视口内。
   *
   * ⚠️ 上一版踩过的坑：把钳位写进 top、再让卡片自己算高度 → 卡片比预算高时底边露到屏幕外
   * （用户实测症状：整屏变暗 + 右下角一块白条）。现在改成：
   *   · left/top 固定为 0，位置一律用 translate 给（transform 不参与 layout，量出来的 rect 才准）；
   *   · 先写宽度、再量一次 rect，用**量到的真实宽高**做钳位；
   *   · 卡片本身 width/height 都是 fit-content + max-height（见 styles.css），不会比视口高。
   */
  placeAtMouse() {
    if (!this.modalEl) return;
    // left/top 固定为 0：位置只用 translate 给（这样量到的 rect 不含定位偏移，宽度才是真宽度）
    if (this.modalEl.style.left !== '0px') this.modalEl.style.left = '0px';
    if (this.modalEl.style.top !== '0px') this.modalEl.style.top = '0px';
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = EDGE_GAP;
    let m = this.mouse || { x: Math.round(vw / 2), y: Math.round(vh * 0.28) };
    if (this.dragX !== undefined && this.dragY !== undefined) m = { x: this.dragX, y: this.dragY };

    const rect = this.modalEl.getBoundingClientRect();
    const w = rect.width || 320;
    const h = rect.height || 200;
    const maxX = Math.max(gap, vw - w - gap);
    const maxY = Math.max(gap, vh - h - gap);
    const x = Math.min(Math.max(gap, m.x + CELL_GAP), maxX);
    const y = Math.min(Math.max(gap, m.y + CELL_GAP), maxY);
    this.modalEl.style.transform = 'translate(' + Math.round(x) + 'px, ' + Math.round(y) + 'px)';
  }

  moveTo(x, y) {
    this.dragX = x;
    this.dragY = y;
    this.placeAtMouse();
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
    this.lastMouse = { x: 0, y: 0 };

    // 鼠标位置：只记两个数字，不碰 DOM 结构（面板定位用）
    this.registerDomEvent(document, 'mousemove', (evt) => {
      this.lastMouse.x = evt.clientX;
      this.lastMouse.y = evt.clientY;
    });
    this.registerDomEvent(document, 'contextmenu', (evt) => {
      this.lastMouse.x = evt.clientX;
      this.lastMouse.y = evt.clientY;
    });

    // 只读一次配置：读坏不覆盖，用空面板起步并提示
    const loaded = await this.readPanelConfig();
    this.config = loaded.config;
    this.configNotice = loaded.notice;
    this.loadedFromDisk = loaded.fromDisk;

    this.addRibbonIcon('layout-grid', '快接面板', () => this.openPanel());

    this.addCommand({
      id: 'open',
      name: '打开快接面板',
      hotkeys: [{ modifiers: ['Mod', 'Alt'], key: ' ' }],
      callback: () => this.openPanel(),
    });
    this.addCommand({
      id: 'open-config',
      name: '打开配置文件（快接面板.json）',
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
    try {
      exists = await adapter.exists(this.configPath);
    } catch (e) {
      exists = false;
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
    return { config: parsed, fromDisk: true, notice: '' };
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

  /** 执行命令并把结果说出来（失败绝不静默） */
  runCommandById(id, cmd, quietOnSuccess) {
    const registry = this.commandRegistry();
    const target = cmd || registry.find(id);
    const label = target && cleanLabel(target.name) ? cleanLabel(target.name) : id;
    let ok = false;
    try {
      ok = this.app.commands.executeCommandById(id);
    } catch (e) {
      new Notice('执行「' + label + '」出错：' + ((e && e.message) || e), 8000);
      return false;
    }
    if (!ok) {
      new Notice('「' + label + '」没有执行 —— 它当前不可用（可能需要先打开一个笔记，或该命令依赖的插件没启用）', 8000);
      return false;
    }
    if (!quietOnSuccess) this.logExecution(label);
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
      const cs = window.getComputedStyle(el);
      return props.map((p) => p + '=' + cs.getPropertyValue(p)).join(' ');
    };
    const lines = [];
    lines.push('quick-panel 诊断 · ' + new Date().toISOString() + '（本文件可随时删除）');
    lines.push('viewport ' + window.innerWidth + 'x' + window.innerHeight + ' dpr=' + window.devicePixelRatio);
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
      new Notice('已导出诊断到库根 .quick-panel-diag.txt（' + lines.length + ' 行）');
    }
    const text = lines.join('\n') + '\n';
    try {
      await this.app.vault.adapter.write('.quick-panel-diag.txt', text);
    } catch (e) {
      console.log(lines.join('\n'));
      new Notice('写诊断文件失败：' + ((e && e.message) || e));
    }
  }

  /** 记一笔「最近用过」：只写配置文件，且失败也不打扰用户（不影响主流程） */  touchRecent(item) {
    try {
      const now = Date.now();
      const entry = { type: itemType(item), usedAt: now };
      if (entry.type === 'command') entry.id = asString(item.id).trim();
      else entry.path = normalizeVaultPath(asString(item.path).trim());
      this.config.recent = pushRecent(this.config.recent, entry, RECENT_LIMIT);
      this.savePanelConfig(this.config);
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

  logExecution(label) {
    this.execLog = this.execLog || [];
    this.execLog.push({ at: new Date().toISOString(), name: label });
    if (this.execLog.length > 50) this.execLog.splice(0, this.execLog.length - 50);
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
    const modal = new QuickPanelModal(this.app, this, config, {
      mouse: { x: this.lastMouse.x, y: this.lastMouse.y },
    });
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
