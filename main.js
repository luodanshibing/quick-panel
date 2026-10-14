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
  SuggestModal,
  Setting,
  PluginSettingTab,
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
 * 运行期优先用 `getIconIds()`（本机实测为顶层导出，返回 `lucide-<规范名>` + 运行时注册名 + 内联 SVG 名）；
 * 这份清单只在拿不到该 API 时顶上。
 *
 * ⚠️ 2026-10-14 取证（`obsidian.asar`）：内置 Lucide 表 441 个键**全部是带连字符的新名**
 * （`settings-2` / `house` / `user-round`…），而 `settings` / `search` / `folder` / `link` / `plus`
 * 这类短名是**别名**；Obsidian 自己的代码里也在用这些短名（asar 里有 232 处 `lucide-*` 引用，
 * 含 `lucide-settings` 等）。所以两种写法都要留着 —— 下面的名字都取自 Obsidian 自己的引用，不用猜。
 */
const LUCIDE_CANDIDATES = [
  'settings', 'settings-2', 'search', 'search-alert', 'folder', 'folder-open', 'folder-plus',
  'folder-closed', 'link', 'link-2', 'plus', 'files', 'file', 'file-text', 'file-plus',
  'x', 'check', 'trash-2', 'edit', 'edit-3', 'undo', 'eye', 'eye-off', 'sun', 'moon',
  'star', 'house', 'zap', 'image', 'image-off', 'list', 'layers', 'pin', 'pin-off',
  'arrow-left', 'arrow-right', 'arrow-up', 'arrow-down', 'arrow-up-right', 'chevron-left',
  'chevron-right', 'chevron-down', 'chevron-up', 'chevrons-up-down', 'chevrons-down-up',
  'more-horizontal', 'more-vertical', 'refresh-cw', 'refresh-cw-off', 'alert-triangle',
  'info', 'help-circle', 'clipboard', 'clipboard-list', 'clipboard-check', 'sort-asc',
  'sort-desc', 'separator-vertical', 'separator-horizontal', 'square-dashed', 'gallery-vertical',
  'picture-in-picture', 'ghost', 'unlink', 'lock', 'unlock', 'shield', 'keyboard',
  'monitor', 'smartphone', 'printer', 'hard-drive', 'cpu', 'database', 'server', 'cloud',
  'globe', 'wifi', 'battery', 'plug', 'power', 'terminal', 'code', 'braces', 'bug',
  'wrench', 'hammer', 'puzzle', 'package', 'box', 'archive', 'inbox', 'send', 'mail',
  'message-square-text', 'bell', 'user', 'users', 'briefcase', 'graduation-cap',
  'book-open', 'library', 'lightbulb', 'target', 'trophy', 'flag', 'map-pin', 'compass',
  'navigation', 'rocket', 'calculator', 'ruler', 'pencil', 'pen-tool', 'brush', 'palette',
  'camera', 'music', 'video', 'mic', 'headphones', 'activity', 'gauge', 'trending-up',
  'table', 'layout-grid', 'columns-3', 'filter', 'tag', 'bookmark', 'heart', 'clock',
  'calendar', 'circle-check', 'circle-alert', 'minus-circle', 'plus-circle', 'external-link',
  'git-branch', 'git-merge', 'git-pull-request', 'workflow', 'recycle', 'download', 'upload',
  'share', 'trash', 'select-all-text', 'restore-file-glyph',
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

/**
 * 把"选择器选中项"整理成可写入配置的新格子；不合格返回 null（不抛异常）。
 * 命令名统一去掉观测到的"插件名: "前缀（面板里显示已经带图标，那个前缀只占宽度）。
 */
function sanitizeNewItem(entry) {
  if (!isPlainObject(entry)) return null;
  const type = itemType(entry);
  if (!type) return null;
  const out = { type: type };
  if (type === 'command') {
    const id = asString(entry.id).trim();
    if (!id) return null;
    out.id = id;
    const snapshot = cleanLabel(entry.nameSnapshot) || cleanLabel(entry.name);
    if (snapshot) out.nameSnapshot = snapshot;
  } else {
    const path = normalizeVaultPath(asString(entry.path)).trim();
    if (!path) return null;
    out.path = path;
  }
  const label = cleanLabel(entry.displayLabel || entry.label);
  if (label) out.label = label;
  if (typeof entry.icon === 'string' && entry.icon) out.icon = entry.icon;
  return out;
}

/** 把插件给命令自动加的前缀去掉："QuickAdd: 快速捕捉" → "快速捕捉" */
function stripCommandPrefix(name) {
  const full = cleanLabel(name);
  const i = full.indexOf(':');
  if (i <= 0) return full;
  const head = full.slice(0, i);
  if (/[\u4e00-\u9fa5]/.test(head)) return full; // 中文名里出现冒号多半是名称本身
  return full.slice(i + 1).trim() || full;
}

/**
 * 选择器的候选数据源：库内命令（用未过滤的完整表）+ 库内文件 + 文件夹。
 * 纯函数，便于离线断言。
 */
function buildPickerItems(input) {
  const src = isPlainObject(input) ? input : {};
  const out = [];
  const commands = Array.isArray(src.commands) ? src.commands : [];
  commands.forEach(function (c) {
    if (!c || !c.id) return;
    const name = cleanLabel(c.name);
    out.push({
      kind: 'command',
      id: c.id,
      label: stripCommandPrefix(name),
      savedLabel: name,
      name: name,
      icon: asString(c.icon),
    });
  });
  const files = Array.isArray(src.files) ? src.files : [];
  files.forEach(function (f) {
    if (!f || !f.path || f.children) return; // 有 children 的是文件夹
    const base = String(f.path).split('/').pop() || String(f.path);
    out.push({ kind: 'file', path: normalizeVaultPath(f.path), label: base.replace(/\.md$/i, ''), name: base });
  });
  files.forEach(function (f) {
    if (!f || !f.path || !f.children) return;
    out.push({ kind: 'folder', path: normalizeVaultPath(f.path), label: String(f.path).split('/').pop() || String(f.path) });
  });
  return out;
}

/** 候选过滤：前缀命中排前、子串命中排后；空查询返回前 N 条 */
function filterPickerItems(items, query, limit) {
  const list = Array.isArray(items) ? items : [];
  const max = Number.isInteger(limit) && limit > 0 ? limit : 400;
  const q = asString(query).trim().toLowerCase();
  if (!q) return list.slice(0, max);
  const starts = [];
  const contains = [];
  list.forEach(function (it) {
    const hay = [it.label, it.name, it.id, it.path].map(asString).join(' ').toLowerCase();
    if (!hay) return;
    if (hay.indexOf(q) === 0 || (it.label && String(it.label).toLowerCase().indexOf(q) === 0)) starts.push(it);
    else if (hay.indexOf(q) > 0) contains.push(it);
  });
  return starts.concat(contains).slice(0, max);
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

  /**
   * 从当前配置算出面板要显示的数据：格子条目（含失效状态）+ 最近用过。
   * `onOpen` 与 `rebuild` 都调它 —— 两边共用一份口径，避免"改了配置界面不变"。
   */
  computeState() {
    const registry = this.host.commandRegistry();
    const missing = findMissingItems(this.config.items, {
      findCommand: (id) => this.commandFor(id) || registry.find(id),
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
        // 全部显示（用户 2026-10-14 反馈："最近用过始终是空的" —— 原因是我原先只列"不在面板里"的项，
        // 而他常用的命令都在面板上）。面板里已有的项直接复用那份条目，图标/名字与面板一致。
        const inPanel = self.items.filter(function (v) { return itemKey(v.item) === rk; })[0];
        const entry = inPanel
          ? { item: inPanel.item, type: inPanel.type, missing: inPanel.missing }
          : { item: r, type: r.type, missing: '' };
        // 面板里已有的项其 missing 状态已算过；这里只补"不在面板里"的那些
        if (!inPanel && r.type === 'command' && !registry.find(asString(r.id).trim())) entry.missing = 'command';
        if (!inPanel && r.type !== 'command') {
          const f = self.app.vault.getAbstractFileByPath(normalizeVaultPath(asString(r.path).trim()));
          if (!f) entry.missing = 'file-missing';
        }
        self.recent.push(entry);
      });
    }
  }

  onOpen() {
    this.modalEl.addClass('quick-panel');
    // 弹窗/多窗口场景下，面板所在的 window 未必是主窗口 —— 视口尺寸与鼠标坐标都要取它自己的
    this.setView(this.modalEl.ownerDocument || document);

    this.computeState();

    this.buildHeader();
    if (this.config.panel.showSearch) this.buildSearch();
    this.buildGrid();
    // 「最近用过」固定显示在网格下面一行（用户问"最近命令显示在哪里"，答案就在这儿）
    if (this.config.panel.showRecent) this.buildRecent();
    this.buildFooter();

    this.render();
    // 位置交给 CSS flex 居中：这里不做任何测量、不写任何定位样式
    const win = this.getWindow();
    // 键盘走 Obsidian 的 Scope（与命令面板同一套）：弹窗里按键**先过 Scope 再到 DOM**，
    // 只挂 onKeyDown 的话方向键没人处理、Enter 会被浏览器当成"按了当前聚焦的按钮"（实测会打开 ⋯ 菜单）。
    this.registerKeys();
    win.setTimeout(() => {
      if (this.modalEl && this.modalEl.isConnected) this.modalEl.focus();
    }, 0);
    if (this.opts.autoHighlightFirst !== false) this.setHighlight(0);
    // 订阅"配置已改"：**任何**写入（改名/换图标/移动/删除/设置）都在面板里就地生效，
    // 不用逐个操作接线、更不用"关掉面板再打开"（用户 2026-10-14：移动后要重开才生效）
    this._offConfig = this.host.onConfigChanged(() => this.rebuild());
  }

  /**
   * 从当前配置算出面板要显示的数据：格子条目（含失效状态）+ 最近用过。
   *
   * ⚠️ 必须与 DOM 重建一起调用：只重建骨架不重算 `this.items`，界面就还是旧顺序
   *   —— 这正是"右键移动后要关闭面板再打开才生效"的原因（移动只换了配置，条目列表没更新）。
   */
  computeState() {
    const registry = this.host.commandRegistry();
    const missing = findMissingItems(this.config.items, {
      findCommand: (id) => this.commandFor(id) || registry.find(id),
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
        // 全部显示（用户 2026-10-14 反馈："最近用过始终是空的" —— 原因是我原先只列"不在面板里"的项，
        // 而他常用的命令都在面板上）。面板里已有的项直接复用那份条目，图标/名字与面板一致。
        const inPanel = self.items.filter(function (v) { return itemKey(v.item) === rk; })[0];
        const entry = inPanel
          ? { item: inPanel.item, type: inPanel.type, missing: inPanel.missing }
          : { item: r, type: r.type, missing: '' };
        // 面板里已有的项其 missing 状态已算过；这里只补"不在面板里"的那些
        if (!inPanel && r.type === 'command' && !registry.find(asString(r.id).trim())) entry.missing = 'command';
        if (!inPanel && r.type !== 'command') {
          const f = self.app.vault.getAbstractFileByPath(normalizeVaultPath(asString(r.path).trim()));
          if (!f) entry.missing = 'file-missing';
        }
        self.recent.push(entry);
      });
    }
  }

  /**
   * 就地重建面板内容。
   * ⚠️ 必须先清空内容区：Obsidian 的弹窗共用 DOM 容器，只追加会叠出多份头部 —— 那正是
   *   "每次改设置就多一层"的根源。这里复用同一个实例，不再 open 新弹窗。
   * ⚠️ 还要重算 `computeState()`：只重建 DOM 骨架而不重算 `this.items`，**顺序改了界面也不变**
   *   —— 那正是"右键移动后要关闭面板再打开才生效"的原因。
   */
  rebuild() {
    try {
      // 始终以 host 的配置为准（配置的唯一真相），避免读到过期的 this.config
      if (this.host && this.host.config) this.config = this.host.config;
      this.computeState();
      this.contentEl.empty();
      this.cellNodes = [];
      this.recentEl = null;
      this.gridEl = null;
      this.statusEl = null;
      this.searchEl = null;
      // 失效项要按最新配置重新判定
      const registry = this.host.commandRegistry();
      const self = this;
      const missing = findMissingItems(this.config.items, {
        findCommand: (id) => self.commandFor(id) || registry.find(id),
        getAbstractFileByPath: (p) => self.app.vault.getAbstractFileByPath(p),
        isFolder: (f) => !!f && f.children !== undefined,
      });
      this.missing = missing;
      this.buildHeader();
      if (this.config.panel.showSearch) this.buildSearch();
      this.buildGrid();
      if (this.config.panel.showRecent) this.buildRecent();
      this.buildFooter();
      this.render();
      this.setHighlight(0);
    } catch (e) {
      // 重建失败就退回"重开面板"，至少不会留下半截界面
      this.host.reopen();
    }
  }

  /** 把面板用到的键注册到 Modal 自带的 scope 上（Escape 由基类处理，这里不抢） */
  registerKeys() {
    const scope = this.scope;
    if (!scope || typeof scope.register !== 'function') return;
    this._scopeHandles = this._scopeHandles || [];
    const bind = (key, fn) => {
      const h = scope.register([], key, (evt) => {
        const handled = fn(evt);
        return handled === false ? true : false; // 返回 true = 已消费（阻止继续冒泡到 DOM）
      });
      this._scopeHandles.push(h);
    };
    ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].forEach((key) => {
      bind(key, (evt) => {
        this.onKeyDown({ key: key, target: { tagName: 'DIV' }, preventDefault() {}, stopPropagation() {} });
        void evt;
        return true;
      });
    });
  }

  onClose() {
    this.cellNodes = [];
    this.items = [];
    this.recent = [];
    if (this.contentEl && this.contentEl.children) this.contentEl.children.length = 0;
    // 退订配置变更（否则面板关掉后监听还在，重建会作用到已销毁的 DOM）
    if (typeof this._offConfig === 'function') {
      try {
        this._offConfig();
      } catch (e) {
        /* 忽略 */
      }
      this._offConfig = null;
    }
    if (this.host && this.host.modal === this) this.host.modal = null;
  }

  /* ---- 结构 ---- */

  buildHeader() {
    const header = this.contentEl.createDiv({ cls: 'qp-header' });
    const title = header.createDiv({ cls: 'qp-title' });
    title.createSpan({ cls: 'qp-title-text', text: '快捷面板' });

    // 用户 2026-10-13 要求："把所有 × 都去掉" → 这里只放「+」（面板内即时添加）
    // 关闭方式：Esc、点面板外（Obsidian 弹窗标准行为）。
    const actions = header.createDiv({ cls: 'qp-actions' });
    const addBtn = actions.createEl('button', { cls: 'qp-icon-btn', attr: { type: 'button' } });
    setIcon(addBtn, 'plus');
    addBtn.setAttribute('aria-label', '添加格子');
    addBtn.addEventListener('click', () => this.host.openPicker(this));
    const menuBtn = actions.createEl('button', { cls: 'qp-icon-btn', attr: { type: 'button' } });
    setIcon(menuBtn, 'more-horizontal');
    menuBtn.setAttribute('aria-label', '更多');
    menuBtn.addEventListener('click', (evt) => this.openMoreMenu(evt));
  }

  buildSearch() {
    const wrap = this.contentEl.createDiv({ cls: 'qp-search' });
    const input = wrap.createEl('input', {
      cls: 'qp-search-input',
      attr: { type: 'text', placeholder: '过滤' },
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
        this.recentEl.createSpan({ cls: 'qp-recent-empty', text: '用过命令后会出现在这里' });
      }
    }

    if (this.statusEl) {
      const parts = [];
      if (this.config.corrupt) parts.push('配置文件读坏了，本次用空面板启动');
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
        ? '会问你要不要重新绑定'
        : '（库内已找不到这个路径）';
      btn.setAttribute('title', name + ' ' + why);
    }
    // 触发方式：click 为主，pointerup 兜底（两者都会调用，但 400ms 内同一条只执行一次）
    this.bindActivate(btn, () => this.executeEntry(entry));
    btn.addEventListener('mouseenter', () => this.setHighlight(index));
    btn.addEventListener('contextmenu', (evt) => {
      evt.preventDefault();
      const itemIndex = this.indexOfItem(entry.item);
      this.openItemMenu(evt, entry, itemIndex);
    });
    return btn;
  }

  /** 配置数组里的下标（菜单的移动/删除要用） */
  indexOfItem(item) {
    const key = itemKey(item);
    return this.config.items.findIndex(function (it) {
      return itemKey(it) === key;
    });
  }

  /**
   * 移动一条并**立刻就地刷新**。
   * 现在 `moveItem` 写盘后会 notifyConfigChanged，面板的订阅会自动 rebuild —— 这里保留一次显式
   * rebuild 作为兜底（万一订阅尚未建立），重复重建是幂等的、不会叠 DOM。
   */
  applyMove(item, to) {
    const ok = this.host.moveItem(item, to);
    this.config = this.host.config;
    this.rebuild();
    return ok;
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
    const isPrimary = (evt) => !evt || typeof evt.button !== 'number' || evt.button === 0;
    el.addEventListener('pointerdown', (evt) => {
      armed = isPrimary(evt);
    });
    el.addEventListener('pointerup', (evt) => {
      if (!isPrimary(evt)) {
        armed = false;
        return;
      }
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
    el.addEventListener('click', (evt) => {
      // 只响应主键：右键/中键要留给菜单，否则"右键 → 改名"会先把命令执行掉
      if (!isPrimary(evt)) return;
      fire();
    });
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
    // 图标名不存在时 setIcon 会静默什么都不画 —— 这里检测一次并落到默认图标 + 说明（不静默空白）
    const drawn = box.querySelector ? box.querySelector('svg') : null;
    if (!drawn && name !== DEFAULT_ICON) {
      setIcon(box, DEFAULT_ICON);
      box.setAttribute('title', '图标名「' + name + '」在本机 Obsidian 里不存在（已用默认图标）');
    }
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
    // 用户 2026-10-13 定稿：**执行后必须把面板关掉**（面板常开会挡住命令产生的界面、造成"奇怪现象"），
    // 但执行本身要**直接、同步**（官方 executeCommand 就是同步的），不用定时器 —— 曾经的
    // "关面板 → 写最近记录 → setTimeout → 再调用"那条链有三处会吞错，还会被 Obsidian 节流。
    try {
      this.silentClose();
      this.host.logExecution('… 已关闭面板，准备执行 ' + id);
    } catch (e) {
      this.host.logExecution('✗ 关闭面板抛错：' + ((e && e.message) || e));
    }
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
    // 最近使用只更新内存 + 延后落盘，点击路径上不做文件 I/O
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
      new Notice('找不到这个文件：' + path + '它可能已被改名或删除');
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

  /* ---- 菜单 ---- */

  /**
   * 格子右键菜单：改名 / 换图标 / 移动 / 删除 / 插到这一格后面 / 重新绑定。
   * 全部操作都只改那一个 JSON（host 负责写盘），改完面板就地重绘、不关闭。
   */
  openItemMenu(evt, entry, itemIndex) {
    evt.preventDefault();
    const index = typeof itemIndex === 'number' ? itemIndex : this.indexOfItem(entry.item);
    const item = entry.item;
    const menu = new Menu();
    // 原来第一项是禁用的「这一格：<名字>」标题行 —— 用户 2026-10-14 裁定删除（纯冗余，菜单本身就是这一格）
    menu.addItem((i) =>
      i
        .setTitle('改名…')
        .setIcon('type')
        .onClick(() => this.promptRename(item, this.displayName(item)))
    );
    menu.addItem((i) =>
      i
        .setTitle('换图标…')
        .setIcon('image')
        .onClick(() => this.promptIcon(item))
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle('左移')
        .setIcon('arrow-left')
        .setDisabled(index <= 0)
        .onClick(() => this.applyMove(item, index - 1))
    );
    menu.addItem((i) =>
      i
        .setTitle('右移')
        .setIcon('arrow-right')
        .setDisabled(index < 0 || index >= this.config.items.length - 1)
        .onClick(() => this.applyMove(item, index + 2))
    );
    menu.addItem((i) =>
      i
        .setTitle('插到这一格后面…')
        .setIcon('plus')
        .onClick(() => this.host.openPicker(this, index + 1))
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle('删除这一格')
        .setIcon('trash')
        .onClick(() => {
          const self = this;
          new ConfirmLikeModal(
            this.app,
            '删除这一格？',
            [{ label: this.displayName(item) + '只从面板移除，不动任何文件' }],
            [
              {
                label: '删除',
                onClick: function () {
                  self.host.removeItem(item);
                  new Notice('已从面板移除：' + self.displayName(item));
                  self.host.reopen(); // 删除后立刻重开面板 → 图标当场消失（不再需要手动关闭再打开）
                },
              },
            ]
          ).open();
        })
    );
    if (entry.missing === 'command') {
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle('重新绑定命令')
          .setIcon('link')
          .onClick(() => {
            const snapshot = cleanLabel(item.nameSnapshot) || cleanLabel(item.label) || asString(item.id);
            const guess = this.host.commandRegistry().findByName(snapshot);
            if (!guess) {
              new Notice('没找到同名命令，没法自动重新绑定');
              return;
            }
            this.host.rebindCommand(item, guess.id, guess.name);
            new Notice('已重新绑定：' + guess.name + '（' + guess.id + '）');
            this.host.reopen();
          })
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle('打开配置文件').setIcon('file-text').onClick(() => this.host.openConfigFile())
    );
    menu.showAtMouseEvent(evt);
  }

  /** 改名：一个输入框的小弹窗（用 Promise 简化逻辑，失败则保持原样） */
  promptRename(item, current) {
    const self = this;
    const modal = new ConfirmLikeModal(this.app, '改显示名', [], [
      {
        label: '保存',
        onClick: function () {
          const value = modal.getInputValue();
          self.host.updateItem(item, { label: value });
          new Notice('已改名：' + (cleanLabel(value) || '(空，将显示命令原名)'));
          self.host.reopen();
        },
      },
    ]);
    modal.addInput({ value: current, placeholder: '显示名' });
    modal.open();
  }

  /**
   * 换图标：一个输入框 + 常用图标名提示。
   *
   * ⚠️ v0.4.3 之前这里用 `SuggestModal` 并调了 `this.setPlaceholder(...)` —— 那是 `InputSuggest`
   *   的方法，`SuggestModal` 上不存在 → 抛异常，"换图标"点了毫无反应。
   *
   * 用户 2026-10-14 反馈：「我并不知道库里有什么图标名字，最好可以模糊匹配，即时出现预览，
   * 而不是非要拼写正确」→ 改为**图标选择器**：默认就把全部图标画成网格（所见即所得，不用背名字），
   * 打字时**模糊过滤**（支持乱序/跳字命中，也支持中文别名如"设置""搜索"），方向键 + 回车选择。
   */
  promptIcon(item) {
    const self = this;
    const current = asString(item.icon).trim();
    const picker = new QuickPanelIconPickerModal(
      this.app,
      {
        names: modalIconCandidates(this.host.iconNames()),
        current: current,
        onChoose: function (value) {
          self.host.updateItem(item, { icon: value });
          new Notice(cleanLabel(value) ? '已改图标：' + value : '已清空图标，将用默认图标');
          self.host.reopen();
        },
      }
    );
    picker.open();
  }

  /** 「更多」菜单：只留必要项，说明性括号全部去掉（用户 2026-10-14：不做冗余文案） */
  openMoreMenu(evt) {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle('设置').setIcon('settings').onClick(() => {
        // 不要先关面板再开设置：Obsidian 的弹窗栈会把紧接着打开的弹窗一起收掉（实测"点了没反应"）。
        this.host.openSettings();
      })
    );
    menu.addSeparator();
    menu.addItem((i) => i.setTitle('打开配置文件').setIcon('file-text').onClick(() => this.host.openConfigFile()));
    menu.addItem((i) => i.setTitle('定位配置文件').setIcon('folder').onClick(() => this.host.revealConfigFile()));
    menu.showAtMouseEvent(evt);
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
    // 同上：共用标题容器，隐藏它（否则会改到面板自己的标题）
    if (this.titleEl && this.titleEl.parentElement) this.titleEl.parentElement.hide();
    else if (this.titleEl && this.titleEl.hide) this.titleEl.hide();
    this.contentEl.createDiv({ cls: 'qp-confirm-title', text: this.qpTitle });
    const body = this.contentEl.createDiv({ cls: 'qp-confirm-body' });
    this.lines.forEach((l) => {
      const row = body.createDiv({ cls: 'qp-confirm-line' + (l.muted ? ' is-muted' : '') });
      row.setText(l.label);
    });
    if (this.inputSpec) {
      const wrap = this.contentEl.createDiv({ cls: 'qp-confirm-input' });
      if (this.inputSpec.preview) {
        // 图标实时预览（用户 2026-10-14 要求：输入名称时想看效果）
        this.previewEl = wrap.createDiv({ cls: 'qp-icon-preview' });
        this.inputEl = wrap.createEl('input', {
          cls: 'qp-search-input',
          attr: { type: 'text', placeholder: this.inputSpec.placeholder || '', value: this.inputSpec.value || '' },
        });
        this.inputEl.value = this.inputSpec.value || '';
        this.inputEl.addEventListener('input', () => this.paintPreview(this.inputEl.value));
        this.paintPreview(this.inputEl.value);
      } else {
        this.inputEl = wrap.createEl('input', {
          cls: 'qp-search-input',
          attr: { type: 'text', placeholder: this.inputSpec.placeholder || '', value: this.inputSpec.value || '' },
        });
        this.inputEl.value = this.inputSpec.value || '';
      }
    }
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

  /** 给确认窗加一个输入框（改名用）；spec.preview=true 时同时给图标实时预览 */
  addInput(spec) {
    this.inputSpec = spec || {};
    return this;
  }

  /** 在预览框里画出当前输入对应的图标（Lucide 名 / emoji / 库内图片） */
  paintPreview(value) {
    if (!this.previewEl) return;
    this.previewEl.empty();
    const spec = iconSpecOf(asString(value));
    let labelText = '';
    if (spec.kind === 'emoji') {
      this.previewEl.createSpan({ cls: 'qp-icon-preview-emoji', text: spec.value });
      labelText = 'emoji';
    } else if (spec.kind === 'image') {
      const file = this.app && this.app.vault ? this.app.vault.getAbstractFileByPath(spec.value) : null;
      if (file) {
        const src = this.app.vault.adapter.getResourcePath(spec.value);
        this.previewEl.createEl('img', { cls: 'qp-icon-preview-img', attr: { src: src, alt: '' } });
        labelText = '库内图片';
      } else {
        labelText = '找不到这张图片';
      }
    } else {
      const box = this.previewEl.createDiv({ cls: 'qp-icon-preview-svg' });
      const name = spec.kind === 'lucide' ? spec.value : DEFAULT_ICON;
      try {
        setIcon(box, name);
      } catch (e) {
        /* 名字不合法 */
      }
      const drawn = box.querySelector ? box.querySelector('svg') : null;
      if (spec.kind === 'lucide' && !drawn) labelText = '这个图标名在本机不存在';
      else if (spec.kind === 'lucide') labelText = name;
      else if (spec.value) labelText = '认不出的写法，将用默认图标';
      else labelText = '默认图标';
    }
    this.previewEl.createSpan({ cls: 'qp-icon-preview-label', text: labelText });
  }

  getInputValue() {
    return this.inputEl ? String(this.inputEl.value || '') : '';
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * 图标建议弹窗（保留：`getSuggestions` 那条 Obsidian 会自己调，不需要额外的方法）。
 * ⚠️ 不要在这里调用 `this.setPlaceholder(...)`：那是 `InputSuggest` 的方法，`SuggestModal` 上没有，
 *    调了会抛异常 —— 这正是 v0.4.3 之前"换图标点了没反应"的原因。现在换图标走的是输入框弹窗。
 */
class IconSuggestModal extends SuggestModal {
  constructor(app, candidates, onChoose) {
    super(app);
    this.candidates = Array.isArray(candidates) ? candidates : [];
    this.onChoose = onChoose;
    this.limit(30);
  }

  getSuggestions(query) {
    const q = asString(query).trim().toLowerCase();
    const list = this.candidates;
    if (!q) return list.slice(0, 30);
    const starts = [];
    const contains = [];
    list.forEach(function (name) {
      const lower = name.toLowerCase();
      if (lower.indexOf(q) === 0) starts.push(name);
      else if (lower.indexOf(q) > 0) contains.push(name);
    });
    return starts.concat(contains).slice(0, 30);
  }

  renderSuggestion(name, el) {
    el.addClass('qp-suggest-item');
    const box = el.createDiv({ cls: 'qp-icon qp-suggest-icon' });
    try {
      setIcon(box, name);
    } catch (e) {
      /* 名字不合法就不画图标，只留文字 */
    }
    el.createSpan({ cls: 'qp-suggest-label', text: name });
  }

  onChooseSuggestion(name) {
    if (typeof this.onChoose === 'function') this.onChoose(asString(name));
  }
}

/**
 * 图标名称的中文别名（用户 2026-10-14：「我并不知道库里有什么图标名字」）。
 * 有它就能打中文找到对应图标 —— 只列常用语义，命中不到时仍可靠网格浏览。
 */
const ICON_ALIASES = {
  设置: ['settings', 'settings-2', 'sliders-horizontal', 'wrench'],
  搜索: ['search', 'search-alert', 'magnifying-glass'],
  查找: ['search', 'search-alert'],
  文件夹: ['folder', 'folder-open', 'folder-plus', 'folder-closed'],
  目录: ['folder', 'folder-open', 'list'],
  文件: ['file', 'file-text', 'files', 'file-plus'],
  文档: ['file-text', 'files', 'book-open'],
  笔记: ['file-text', 'notebook', 'book-open', 'pencil'],
  链接: ['link', 'link-2', 'external-link', 'unlink'],
  标签: ['tag', 'tags', 'bookmark'],
  收藏: ['star', 'bookmark', 'heart'],
  星标: ['star', 'bookmark'],
  首页: ['house', 'home'],
  主页: ['house', 'home'],
  日历: ['calendar', 'calendar-days', 'calendar-check'],
  日期: ['calendar', 'calendar-check'],
  时间: ['clock', 'timer', 'alarm-clock'],
  时钟: ['clock', 'timer'],
  待办: ['check', 'check-square', 'list-checks', 'clipboard-check'],
  清单: ['list', 'list-checks', 'clipboard-list'],
  任务: ['check', 'clipboard-check', 'target'],
  图片: ['image', 'image-off', 'camera', 'gallery-vertical'],
  照片: ['image', 'camera'],
  头像: ['user', 'users', 'circle-user'],
  用户: ['user', 'users'],
  刷新: ['refresh-cw', 'refresh-cw-off', 'rotate-cw'],
  同步: ['refresh-cw', 'sync', 'repeat'],
  重载: ['refresh-cw', 'rotate-cw'],
  齿轮: ['settings', 'settings-2', 'cog'],
  工具: ['wrench', 'hammer', 'settings'],
  命令: ['terminal', 'code', 'square-terminal'],
  代码: ['code', 'braces', 'terminal'],
  终端: ['terminal', 'square-terminal'],
  新增: ['plus', 'plus-circle', 'file-plus', 'folder-plus'],
  添加: ['plus', 'plus-circle'],
  删除: ['trash', 'trash-2', 'x'],
  关闭: ['x', 'x-circle', 'circle-x'],
  确认: ['check', 'circle-check', 'check-circle'],
  警告: ['alert-triangle', 'circle-alert', 'alert-circle'],
  提示: ['info', 'lightbulb', 'circle-help'],
  帮助: ['circle-help', 'help-circle', 'info'],
  下载: ['download', 'hard-drive-download'],
  上传: ['upload', 'cloud-upload'],
  分享: ['share', 'share-2', 'send'],
  发送: ['send', 'mail'],
  邮件: ['mail', 'at-sign'],
  消息: ['message-square', 'message-square-text', 'bell'],
  通知: ['bell', 'bell-ring'],
  锁: ['lock', 'lock-keyhole', 'unlock'],
  安全: ['shield', 'shield-check', 'lock'],
  眼睛: ['eye', 'eye-off'],
  显示: ['eye', 'monitor'],
  隐藏: ['eye-off', 'ghost'],
  太阳: ['sun', 'sun-medium', 'sunrise'],
  月亮: ['moon', 'moon-star'],
  亮色: ['sun', 'lightbulb'],
  暗色: ['moon', 'cloud-moon'],
  闪电: ['zap', 'zap-off', 'activity'],
  图标: ['image', 'shapes', 'star'],
  网格: ['layout-grid', 'grid-2x2', 'grid-3x3'],
  布局: ['layout-grid', 'layout-list', 'layout-dashboard'],
  列表: ['list', 'layout-list', 'list-ordered'],
  表格: ['table', 'table-2', 'grid-2x2'],
  图表: ['chart-no-axes-column', 'trending-up', 'pie-chart'],
  统计: ['chart-no-axes-column', 'trending-up', 'activity'],
  图: ['image', 'chart-no-axes-column', 'network'],
  书: ['book', 'book-open', 'bookmark', 'notebook'],
  阅读: ['book-open', 'notebook', 'glasses'],
  音乐: ['music', 'headphones', 'audio-lines'],
  视频: ['video', 'play', 'monitor-play'],
  相机: ['camera', 'video'],
  麦克风: ['mic', 'mic-off'],
  键盘: ['keyboard', 'command'],
  电脑: ['monitor', 'laptop', 'cpu'],
  手机: ['smartphone', 'tablet'],
  云: ['cloud', 'cloud-upload', 'cloud-download'],
  网络: ['globe', 'wifi', 'network'],
  地球: ['globe', 'earth'],
  地图: ['map', 'map-pin', 'navigation', 'compass'],
  位置: ['map-pin', 'navigation', 'locate'],
  导航: ['navigation', 'compass', 'route'],
  火箭: ['rocket', 'send'],
  火: ['flame', 'flame-kindling'],
  心: ['heart', 'heart-handshake'],
  奖励: ['trophy', 'award', 'medal'],
  目标: ['target', 'goal', 'crosshair'],
  旗: ['flag', 'flag-triangle-right'],
  灯泡: ['lightbulb', 'zap'],
  想法: ['lightbulb', 'brain', 'message-square-text'],
  书签: ['bookmark', 'book-marked'],
  归档: ['archive', 'package', 'box'],
  打包: ['package', 'box', 'archive'],
  收件: ['inbox', 'mail'],
  包裹: ['package', 'box'],
  拼图: ['puzzle', 'blocks'],
  插件: ['puzzle', 'blocks', 'plug'],
  电源: ['power', 'plug', 'battery'],
  电池: ['battery', 'battery-charging'],
  打印: ['printer', 'file-text'],
  计算: ['calculator', 'sigma'],
  笔: ['pencil', 'pen-tool', 'edit'],
  编辑: ['pencil', 'edit', 'file-pen'],
  画笔: ['brush', 'paintbrush', 'palette'],
  调色: ['palette', 'paintbrush'],
  复制: ['copy', 'clipboard', 'files'],
  剪贴: ['clipboard', 'clipboard-list', 'clipboard-check'],
  移动: ['move', 'arrows-up-down-left-right'],
  拖拽: ['move', 'grip-vertical'],
  放大: ['zoom-in', 'search', 'maximize'],
  缩小: ['zoom-out', 'minimize'],
  全屏: ['maximize', 'expand', 'fullscreen'],
  箭头: ['arrow-right', 'arrow-left', 'arrow-up', 'arrow-down'],
  向上: ['arrow-up', 'chevron-up', 'arrow-up-circle'],
  向下: ['arrow-down', 'chevron-down', 'arrow-down-circle'],
  向左: ['arrow-left', 'chevron-left', 'arrow-left-circle'],
  向右: ['arrow-right', 'chevron-right', 'arrow-right-circle'],
  排序: ['sort-asc', 'sort-desc', 'arrow-up-down'],
  过滤: ['filter', 'funnel', 'list-filter'],
  筛选: ['filter', 'funnel'],
  更多: ['more-horizontal', 'more-vertical', 'ellipsis'],
  菜单: ['menu', 'more-horizontal', 'align-justify'],
};

/**
 * 模糊匹配：返回匹配分（0 = 不匹配，越大越靠前）。
 * 规则（按优先级）：
 *   ① 前缀子串（`sett` → `settings`）最高分，越短越高；
 *   ② 中间子串（`text` → `file-text`）次之；
 *   ③ 跳字命中（`stg` → `settings`）：按顺序出现即可，越紧凑分越高；
 *   ④ **忽略连字符再匹配一次**（`tf` → `file-text`）—— 图标名里的 `-` 最容易把缩写绊住；
 *   ⑤ 中文别名（见 `ICON_ALIASES`）在 `filterIconNames` 里另外加分。
 */
function subsequenceScore(hay, q) {
  let i = 0;
  let span = 0;
  let last = -1;
  for (const ch of q) {
    const found = hay.indexOf(ch, i);
    if (found < 0) return 0;
    if (last >= 0) span += found - last - 1;
    last = found;
    i = found + 1;
  }
  return 400 - span * 8 - hay.length * 0.1;
}

function iconMatchScore(name, query) {
  const n = asString(name).toLowerCase();
  const q = asString(query).trim().toLowerCase();
  if (!q) return 1;
  if (!n) return 0;
  const at = n.indexOf(q);
  if (at === 0) return 1000 - n.length;
  if (at > 0) return 700 - at * 2 - n.length * 0.1;
  const direct = subsequenceScore(n, q);
  if (direct > 0) return direct;
  // 把连字符去掉再试（图标名普遍带 `-`，用户的缩写往往跨过它，如 tf → file-text）
  const flat = n.replace(/-/g, '');
  if (flat === n) return 0;
  const flatHit = flat.indexOf(q);
  if (flatHit === 0) return 620 - flat.length;
  if (flatHit > 0) return 560 - flatHit * 2 - flat.length * 0.1;
  return subsequenceScore(flat, q);
}

/** 按查询过滤 + 排序图标名（空查询 = 全部，让用户直接浏览） */
function filterIconNames(names, query, limit) {
  const list = Array.isArray(names) ? names : [];
  const q = asString(query).trim();
  if (!q) return list.slice(0, limit > 0 ? limit : list.length);
  const aliasHits = Object.create(null);
  Object.keys(ICON_ALIASES).forEach(function (word) {
    if (word.indexOf(q) >= 0) {
      ICON_ALIASES[word].forEach(function (icon, idx) {
        aliasHits[icon] = Math.max(aliasHits[icon] || 0, 900 - idx * 10 - word.length);
      });
    }
  });
  const scored = [];
  list.forEach(function (name) {
    const s = Math.max(iconMatchScore(name, q), aliasHits[name] || 0);
    if (s > 0) scored.push({ name: name, score: s });
  });
  scored.sort(function (a, b) {
    return b.score - a.score || (a.name < b.name ? -1 : 1);
  });
  return scored.map(function (s) {
    return s.name;
  }).slice(0, limit > 0 ? limit : scored.length);
}

/**
 * 图标选择器（用户 2026-10-14 要求：模糊匹配 + 即时预览，不要非得拼对名字）。
 * 默认就画出全部图标网格 → 不用背名字；打字即时过滤；方向键 + 回车选择。
 */
class QuickPanelIconPickerModal extends Modal {
  constructor(app, opts) {
    super(app);
    this.opts = opts || {};
    this.all = Array.isArray(this.opts.names) ? this.opts.names : [];
    this.current = asString(this.opts.current);
    this.preview = this.current;
    this.query = '';
    this.matches = [];
    this.highlight = 0;
    this.inputEl = null;
    this.listEl = null;
    this.previewEl = null;
  }

  onOpen() {
    this.modalEl.addClass('quick-panel');
    this.modalEl.addClass('qp-icon-picker');
    if (this.titleEl && this.titleEl.parentElement) this.titleEl.parentElement.hide();
    else if (this.titleEl && this.titleEl.hide) this.titleEl.hide();

    this.contentEl.createDiv({ cls: 'qp-confirm-title', text: '换图标' });

    // 顶部：即时预览 + 搜索框
    const top = this.contentEl.createDiv({ cls: 'qp-icon-pick-top' });
    this.previewEl = top.createDiv({ cls: 'qp-icon qp-icon-pick-preview' });
    const box = top.createDiv({ cls: 'qp-icon-pick-input' });
    this.inputEl = box.createEl('input', {
      cls: 'qp-search-input',
      attr: { type: 'text', placeholder: '打字筛选：中文也行（设置 / 搜索 / 文件夹）' },
    });
    this.inputEl.value = this.query;
    this.inputEl.addEventListener('input', () => {
      this.query = this.inputEl.value;
      this.renderList();
    });
    this.inputEl.addEventListener('keydown', (evt) => {
      if (evt.key === 'ArrowDown' || evt.key === 'ArrowRight') {
        this.move(1);
        evt.preventDefault();
      } else if (evt.key === 'ArrowUp' || evt.key === 'ArrowLeft') {
        this.move(-1);
        evt.preventDefault();
      } else if (evt.key === 'Enter') {
        const name = this.matches[this.highlight];
        if (name) this.choose(name);
        evt.preventDefault();
      }
    });

    this.listEl = this.contentEl.createDiv({ cls: 'qp-icon-pick-grid' });

    const foot = this.contentEl.createDiv({ cls: 'qp-confirm-actions' });
    const defBtn = foot.createEl('button', { cls: 'qp-btn is-ghost', attr: { type: 'button' } });
    defBtn.setText('用默认图标');
    defBtn.addEventListener('click', () => {
      this.close();
      if (typeof this.opts.onChoose === 'function') this.opts.onChoose('');
    });

    const win = (this.modalEl.ownerDocument && this.modalEl.ownerDocument.defaultView) || window;
    win.setTimeout(() => {
      if (this.inputEl && this.inputEl.focus) this.inputEl.focus();
    }, 0);
    this.renderList();
  }

  onClose() {
    this.contentEl.empty();
  }

  paintPreview() {
    if (!this.previewEl) return;
    this.previewEl.empty();
    this.previewEl.removeAttribute && this.previewEl.removeAttribute('title');
    const name = this.preview || DEFAULT_ICON;
    try {
      setIcon(this.previewEl, name);
    } catch (e) {
      /* 名字不合法 */
    }
    const drawn = this.previewEl.querySelector ? this.previewEl.querySelector('svg') : null;
    const label = this.preview ? this.preview : '默认图标';
    if (this.previewEl.setAttribute) this.previewEl.setAttribute('title', drawn ? label : label + '（本机没有这个图标）');
  }

  renderList() {
    this.matches = filterIconNames(this.all, this.query, this.query ? 240 : 600);
    if (this.highlight >= this.matches.length) this.highlight = 0;
    this.listEl.empty();
    if (!this.matches.length) {
      this.listEl.createDiv({ cls: 'qp-empty', text: '没有匹配的图标，换个词试试' });
    }
    const self = this;
    this.matches.forEach(function (name, idx) {
      const cell = self.listEl.createDiv({ cls: 'qp-icon-pick-cell' });
      const icon = cell.createDiv({ cls: 'qp-icon' });
      try {
        setIcon(icon, name);
      } catch (e) {
        /* 名字不合法就留空 */
      }
      if (!(icon.querySelector && icon.querySelector('svg'))) cell.addClass('is-no-icon');
      cell.createSpan({ cls: 'qp-icon-pick-name', text: name });
      if (idx === self.highlight) cell.addClass('is-active');
      cell.addEventListener('mouseenter', () => {
        self.highlight = idx;
        self.paintActive();
      });
      cell.addEventListener('click', () => self.choose(name));
    });
    this.paintActive();
    this.paintPreview();
  }

  paintActive() {
    if (!this.listEl) return;
    const cells = this.listEl.children || [];
    for (let i = 0; i < cells.length; i += 1) {
      if (cells[i] && cells[i].toggleClass) cells[i].toggleClass('is-active', i === this.highlight);
    }
    const active = this.matches[this.highlight];
    this.preview = active || this.current;
    this.paintPreview();
  }

  move(step) {
    if (!this.matches.length) return;
    let next = this.highlight + step;
    if (next < 0) next = this.matches.length - 1;
    if (next > this.matches.length - 1) next = 0;
    this.highlight = next;
    this.paintActive();
  }

  choose(name) {
    this.close();
    if (typeof this.opts.onChoose === 'function') this.opts.onChoose(asString(name));
  }
}

/** 图标候选：剥掉 `lucide-` 前缀（setIcon 两种都认，但显示与写入用短名）、去重、排序 */
function modalIconCandidates(runtimeNames) {
  const seen = Object.create(null);
  const out = [];
  const push = (v) => {
    const name = stripLucidePrefix(asString(v).trim());
    if (!name || seen[name]) return;
    // 只保留"像图标名"的：字母数字加连字符（emoji、含空格的名字都会落到图标缺失的回退路径，不进候选）
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) return;
    seen[name] = 1;
    out.push(name);
  };
  if (Array.isArray(runtimeNames)) runtimeNames.forEach(push);
  LUCIDE_CANDIDATES.forEach(push);
  return out.sort();
}

/**
 * 显示设置的四行 UI（设置弹窗与 Obsidian 设置页共用同一份实现，避免两处口径漂移）。
 * 每改一项：立即写盘 → 让面板生效（重开面板）。
 */
function renderPanelSettingsRows(container, plugin, onAfterChange) {
  const write = (patch) => {
    const current = plugin.config.panel;
    const next = normalizePanelConfig({
      version: CONFIG_VERSION,
      panel: Object.assign({}, current, patch),
      items: plugin.config.items,
      recent: plugin.config.recent,
    });
    plugin.config = next;
    plugin.writePanelConfig(next, { silent: true });
    try {
      plugin.notifyConfigChanged();
    } catch (e) {
      /* 通知失败不影响写入 */
    }
    if (typeof onAfterChange === 'function') onAfterChange(next.panel);
  };

  const rows = [
    ['显示「最近用过」', '面板底部一行，显示最近执行过的命令', (s) => s.addToggle((t) => t.setValue(!!panel().showRecent).onChange((v) => write({ showRecent: !!v })))],
    ['显示过滤框', '面板里本来就可以直接打字过滤，默认关掉更清爽', (s) => s.addToggle((t) => t.setValue(!!panel().showSearch).onChange((v) => write({ showSearch: !!v })))],
    ['格子大小', '图标格子的边长', (s) => s.addSlider((sl) => sl.setLimits(24, 72, 4).setValue(panel().iconSize).setDynamicTooltip().onChange((v) => write({ iconSize: v })))],
    ['每行列数', '自动 = 按窗口宽度自适应', (s) =>
      s.addDropdown((d) =>
        d
          .addOption('auto', '自动')
          .addOption('4', '4 列')
          .addOption('5', '5 列')
          .addOption('6', '6 列')
          .addOption('8', '8 列')
          .setValue(String(panel().columns))
          .onChange((v) => write({ columns: v === 'auto' ? 'auto' : Number(v) }))
      )],
  ];
  function panel() {
    return plugin.config.panel;
  }
  rows.forEach(function (row) {
    const setting = new Setting(container).setName(row[0]).setDesc(row[1]);
    row[2](setting);
  });
  return write;
}

/** 「恢复默认显示设置」（只重置显示，不动格子内容） */
function resetPanelDisplaySettings(plugin) {
  const defaults = normalizePanelSettings(null);
  const next = normalizePanelConfig({
    version: CONFIG_VERSION,
    panel: defaults,
    items: plugin.config.items,
    recent: plugin.config.recent,
  });
  plugin.config = next;
  plugin.writePanelConfig(next, { silent: true });
  return next;
}

/** Obsidian「设置 → 第三方插件 → Quick Panel」里的那一页（用户 2026-10-14 反馈"系统设置里没有"） */
class QuickPanelSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: '快捷面板' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '面板内容与顺序在面板内直接编辑：点「＋」添加，右键格子改名 / 换图标 / 移动 / 删除。',
    });
    renderPanelSettingsRows(containerEl, this.plugin);
    new Setting(containerEl)
      .setName('打开配置文件')
      .setDesc('快捷面板.json 位于库根，可手动编辑')
      .addButton((b) => b.setButtonText('打开').onClick(() => this.plugin.openConfigFile()));
    new Setting(containerEl)
      .setName('恢复默认显示设置')
      .setDesc('只重置上面的显示项，不动面板格子')
      .addButton((b) =>
        b.setButtonText('恢复').onClick(() => {
          resetPanelDisplaySettings(this.plugin);
          new Notice('显示设置已恢复默认，格子内容不动');
          this.display();
        })
      );
  }

  hide() {
    // 关闭设置页时把面板重开一次，让改动立刻可见
    try {
      this.plugin.reopen();
    } catch (e) {
      /* 忽略 */
    }
  }
}

/**
 * 设置面板（面板 ⋯ →「设置」）。用普通 Modal 而不是 PluginSettingTab：
 * 这样从面板里直接打开，不用去系统设置页翻；两处共用同一个 rows 渲染函数。
 */
class QuickPanelSettingsModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    this.modalEl.addClass('quick-panel');
    this.modalEl.addClass('qp-settings');
    if (this.titleEl && this.titleEl.parentElement) this.titleEl.parentElement.hide();
    else if (this.titleEl && this.titleEl.hide) this.titleEl.hide();
    this.render();
  }

  onClose() {
    this.contentEl.empty();
    // 只在关闭设置时重建一次面板（原来每改一项就 reopen，导致弹窗一层层叠起来）
    if (typeof this.onClosed === 'function') {
      try {
        this.onClosed();
      } catch (e) {
        /* 忽略 */
      }
    }
  }

  render() {
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: 'qp-confirm-title', text: '快捷面板设置' });
    renderPanelSettingsRows(this.contentEl, this.plugin);
    const foot = this.contentEl.createDiv({ cls: 'qp-settings-actions' });
    const openBtn = foot.createEl('button', { cls: 'qp-btn is-ghost', attr: { type: 'button' } });
    openBtn.setText('打开配置文件');
    openBtn.addEventListener('click', () => this.plugin.openConfigFile());
    const resetBtn = foot.createEl('button', { cls: 'qp-btn is-ghost', attr: { type: 'button' } });
    resetBtn.setText('恢复默认显示设置');
    resetBtn.addEventListener('click', () => {
      resetPanelDisplaySettings(this.plugin);
      new Notice('显示设置已恢复默认，格子内容不动');
      this.render();
    });
  }
}

const DEFAULT_ICON = 'file-text';

/**
 * 「添加格子」选择器：命令 + 库内文件 + 文件夹，可打字过滤，方向键选择，Enter 加入。
 * 自绘列表（InputSuggest 在部分版本里对"回车选中"的处理不一致，这里走自己的输入框 + 列表）。
 * 选中即回调 → 写入 JSON → 面板就地重绘（面板不关，这就是"顺手就加"的核心体验）。
 */
class QuickPanelPickerModal extends Modal {
  constructor(app, opts) {
    super(app);
    this.opts = opts || {};
    this.all = buildPickerItems({
      commands: this.opts.commands,
      files: this.opts.files,
    });
    this.query = asString(this.opts.query);
    this.items = [];
    this.highlight = 0;
    this.inputEl = null;
    this.listEl = null;
  }

  onOpen() {
    this.modalEl.addClass('quick-panel');
    this.modalEl.addClass('qp-picker');
    // 关键：Obsidian 的 Modal 共用同一个 `.modal-title-container` DOM，写标题会**同时改到面板的标题**，
    // 表现为"选择器一开，面板变两行"。这里把标题容器直接藏掉。
    if (this.titleEl && this.titleEl.parentElement) this.titleEl.parentElement.hide();
    else if (this.titleEl && this.titleEl.hide) this.titleEl.hide();
    const wrap = this.contentEl.createDiv({ cls: 'qp-picker-search' });
    this.inputEl = wrap.createEl('input', {
      cls: 'qp-search-input',
      attr: { type: 'text', placeholder: '打字过滤：命令 / 笔记 / 文件夹' },
    });
    this.inputEl.value = this.query;
    this.listEl = this.contentEl.createDiv({ cls: 'qp-picker-list' });
    this.inputEl.addEventListener('input', () => {
      this.query = this.inputEl.value;
      this.renderList();
    });
    this.inputEl.addEventListener('keydown', (evt) => {
      if (evt.key === 'ArrowDown' || evt.key === 'ArrowUp') {
        this.moveHighlight(evt.key === 'ArrowDown' ? 1 : -1);
        evt.preventDefault();
      } else if (evt.key === 'Enter') {
        const it = this.items[this.highlight];
        if (it) this.choose(it);
        evt.preventDefault();
      }
    });
    const win = (this.modalEl.ownerDocument && this.modalEl.ownerDocument.defaultView) || window;
    win.setTimeout(() => {
      if (this.inputEl && this.inputEl.focus) this.inputEl.focus();
    }, 0);
    this.renderList();
  }

  onClose() {
    this.contentEl.empty();
  }

  renderList() {
    this.items = filterPickerItems(this.all, this.query, 400);
    if (this.highlight >= this.items.length) this.highlight = 0;
    this.listEl.empty();
    if (!this.items.length) {
      this.listEl.createDiv({ cls: 'qp-empty', text: '没有匹配项' });
      return;
    }
    const self = this;
    this.items.forEach(function (it, idx) {
      const row = self.listEl.createDiv({ cls: 'qp-picker-item' });
      const box = row.createDiv({ cls: 'qp-icon qp-picker-icon' });
      const iconName = it.icon ? stripLucidePrefix(it.icon) : it.kind === 'file' || it.kind === 'folder' ? 'file-text' : DEFAULT_ICON;
      try {
        setIcon(box, iconName);
      } catch (e) {
        /* 图标名不合法就留空 */
      }
      // 名字在本机不存在时 setIcon 什么都不画：标出来，免得用户选了一个不会显示的名字
      if (box.querySelector && !box.querySelector('svg')) {
        row.addClass('is-no-icon');
        row.setAttribute('title', '这一项的图标名「' + iconName + '」在本机不存在（不影响添加）');
      }
      const text = row.createDiv({ cls: 'qp-picker-text' });
      text.createSpan({ cls: 'qp-picker-label', text: it.label || it.id || it.path });
      const sub = it.kind === 'command' ? it.id : it.path;
      if (sub) text.createSpan({ cls: 'qp-picker-sub', text: sub });
      if (idx === self.highlight) row.addClass('is-active');
      row.addEventListener('mouseenter', () => {
        self.highlight = idx;
        self.paintHighlight();
      });
      row.addEventListener('click', () => self.choose(it));
    });
  }

  paintHighlight() {
    if (!this.listEl) return;
    const rows = this.listEl.children || [];
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i] && rows[i].toggleClass) rows[i].toggleClass('is-active', i === this.highlight);
    }
  }

  moveHighlight(step) {
    if (!this.items.length) return;
    let next = this.highlight + step;
    if (next < 0) next = 0;
    if (next > this.items.length - 1) next = this.items.length - 1;
    this.highlight = next;
    this.paintHighlight();
  }

  choose(it) {
    let entry = null;
    if (it.kind === 'command') {
      entry = { type: 'command', id: it.id, nameSnapshot: it.name, icon: '' };
    } else if (it.kind === 'file') {
      entry = { type: 'file', path: it.path, icon: '' };
    } else if (it.kind === 'folder') {
      entry = { type: 'folder', path: it.path, icon: '' };
    }
    if (!entry) return;
    this.close();
    if (typeof this.opts.onChoose === 'function') this.opts.onChoose(entry);
  }
}

/** 去掉 `lucide-` 前缀（setIcon 两种写法都认，写进配置时用短名更好读） */
function stripLucidePrefix(name) {
  const v = asString(name).trim();
  return v.indexOf('lucide-') === 0 ? v.slice(7) : v;
}

/* =====================================================================================
 * 五、插件本体
 * ===================================================================================== */

class QuickPanelPlugin extends Plugin {
  async onload() {
    this.configPath = CONFIG_NAME;
    this.config = null;
    this.configNotice = '';
    this.registry = null;
    // 配置变更监听：设置里每改一项就让面板就地生效，不重开弹窗（否则每改一次叠一层）
    this._configListeners = [];

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

    // Obsidian 系统设置里的插件页（用户 2026-10-14 反馈"系统设置里没有这个插件的设置页面"）
    this.addSettingTab(new QuickPanelSettingTab(this.app, this));

    this.addCommand({
      id: 'open',
      name: '打开快捷面板',
      hotkeys: [{ modifiers: ['Mod', 'Alt'], key: ' ' }],
      callback: () => this.openPanel(),
    });
    this.addCommand({
      id: 'open-config',
      name: '打开配置文件',
      callback: () => this.openConfigFile(),
    });
    // 故障排查用：打开面板后跑这条，把真实几何写进库根 .quick-panel-diag.txt（可随时删）
    this.addCommand({
      id: 'diagnose',
      name: '导出面板诊断',
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
    /*
     * ⚠️ 这里**曾经**有一句"随加载把 showSearch 改回 false"的迁移（当初用户说面板里不要过滤框）。
     * 现在过滤框是设置里的正式开关（默认 false），任何加载期强制改写都会让用户的设置"看起来没生效"。
     * 结论：默认值只写在 `normalizePanelSettings` 里，**加载路径不得再改写用户已保存的显示项**。
     */
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
    // 同步通知（写盘前）：所有增删改最终都走这里，面板订阅它就地刷新。
    // 写盘是异步的，放在 await 之后会让"移动后面板顺序"慢一拍甚至丢事件。
    this.notifyConfigChanged();
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
      new Notice('这条命令已经不在注册表里了：' + id + '可右键此格重新绑定', 8000);
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

  /* ---- 增 / 删 / 排序（都只改那一个 JSON，改完立刻落盘并重绘面板） ---- */

  /** 在 index 处插入一条新格子；带 nameSnapshot 便于以后失效时重新绑定 */
  addItem(entry, index) {
    const clean = sanitizeNewItem(entry);
    if (!clean) {
      new Notice('这条没法加进面板');
      return false;
    }
    const list = this.config.items.slice();
    const at = typeof index === 'number' && index >= 0 && index <= list.length ? index : list.length;
    // 已经在面板里就不重复加
    const key = itemKey(clean);
    if (list.some((it) => itemKey(it) === key)) {
      new Notice('这条已经在面板里了：' + (cleanLabel(clean.label) || key));
      return false;
    }
    list.splice(at, 0, clean);
    this.config = normalizePanelConfig({
      version: CONFIG_VERSION,
      panel: this.config.panel,
      items: list,
      recent: this.config.recent,
    });
    this.savePanelConfig(this.config);
    return true;
  }

  /** 改一条格子的显示名/图标（部分更新） */
  updateItem(item, patch) {
    const key = itemKey(item);
    const target = this.config.items.filter((it) => itemKey(it) === key)[0];
    if (!target) return false;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'label')) {
      const label = cleanLabel(patch.label);
      if (label) target.label = label;
      else delete target.label;
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'icon')) {
      const icon = asString(patch.icon).trim();
      if (icon) target.icon = icon;
      else delete target.icon;
    }
    this.savePanelConfig(this.config);
    return true;
  }

  /** 从面板移除一条（只改 JSON，不动任何文件） */
  removeItem(item) {
    const key = itemKey(item);
    const list = this.config.items.filter((it) => itemKey(it) !== key);
    if (list.length === this.config.items.length) return false;
    this.config = normalizePanelConfig({
      version: CONFIG_VERSION,
      panel: this.config.panel,
      items: list,
      recent: this.config.recent,
    });
    this.savePanelConfig(this.config);
    return true;
  }

  /** 把一条移到新下标（to 为元素移除后的插入位置） */
  moveItem(item, to) {
    const key = itemKey(item);
    const list = this.config.items.slice();
    const from = list.findIndex((it) => itemKey(it) === key);
    if (from < 0) return false;
    const moved = list.splice(from, 1)[0];
    const at = Math.max(0, Math.min(typeof to === 'number' ? to : list.length, list.length));
    list.splice(at, 0, moved);
    this.config = normalizePanelConfig({
      version: CONFIG_VERSION,
      panel: this.config.panel,
      items: list,
      recent: this.config.recent,
    });
    this.savePanelConfig(this.config);
    return true;
  }

  /** 面板里所有格子的显示名（给"最近用过"取名字用） */
  itemDisplayName(item) {
    const label = cleanLabel(item.label);
    if (label) return label;
    const snap = cleanLabel(item.nameSnapshot);
    if (snap) return snap;
    if (itemType(item) === 'command') {
      const cmd = this.commandFor(asString(item.id));
      if (cmd && cleanLabel(cmd.name)) return cleanLabel(cmd.name);
      return asString(item.id);
    }
    const path = normalizeVaultPath(asString(item.path));
    return path.split('/').pop() || path;
  }

  /* ---- 面板内即时添加 ---- */

  /** 打开"添加"选择器：命令 + 库内文件 + 文件夹；选中即写入，然后**关闭面板再重开** */
  openPicker(modal, insertAt) {
    const self = this;
    const picker = new QuickPanelPickerModal(this.app, {
      commands: this.commandRegistry().all,
      files: this.app.vault.getFiles(),
      query: modal ? modal.query : '',
      onChoose: function (entry) {
        const ok = self.addItem(entry, insertAt);
        if (ok) {
          new Notice('已添加：' + (cleanLabel(entry.label) || itemKey(entry)));
          // 统一用"关闭再重开面板"来刷新：图标、失效状态、最近用过会一起更新
          // （在旧实例上重新 onOpen 会叠加头部 DOM，这是之前"面板变两行"的同类问题）
          self.reopen();
        }
      },
    });
    picker.open();
  }

  /** 打开设置面板（从面板的 ⋯ → 设置进入）。设置改动就地生效，不重开弹窗 */
  openSettings() {
    // 防重复打开：菜单项若被触发两次，会出现两个设置弹窗（实测截图里就是"叠一层"）
    if (this._settingsOpen) return;
    this._settingsOpen = true;
    const modal = this.modal;
    const off = this.onConfigChanged(() => {
      // 立即同步内存配置，并让面板就地重建（不新开弹窗）
      if (modal) modal.config = this.config;
      if (modal && modal.rebuild) modal.rebuild();
    });
    const settings = new QuickPanelSettingsModal(this.app, this);
    settings.onClosed = () => {
      this._settingsOpen = false;
      off();
      // 关闭设置时只重建一次面板
      if (modal && modal.rebuild) modal.rebuild();
    };
    settings.open();
  }

  /** 图标候选（运行期全量优先） */
  iconNames() {
    try {
      if (typeof getIconIds === 'function') return getIconIds() || [];
    } catch (e) {
      /* 拿不到就用兜底清单 */
    }
    return [];
  }

  /** 注册"配置已改"监听（设置弹窗用；返回取消函数） */
  onConfigChanged(fn) {
    if (typeof fn !== 'function') return function () {};
    this._configListeners = this._configListeners || [];
    this._configListeners.push(fn);
    return () => {
      this._configListeners = (this._configListeners || []).filter((f) => f !== fn);
    };
  }

  /** 通知所有监听者：配置刚被改写 */
  notifyConfigChanged() {
    (this._configListeners || []).forEach(function (fn) {
      try {
        fn();
      } catch (e) {
        /* 单个监听出错不影响其它 */
      }
    });
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
    // 防重复：同一时刻只允许一个面板。已经开着就先关掉再开（否则快捷键连按会叠出多个面板）
    if (this.modal) {
      try {
        const old = this.modal;
        this.modal = null;
        old.close();
      } catch (e) {
        /* 关旧的失败也继续 */
      }
    }
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
module.exports.sanitizeNewItem = sanitizeNewItem;
module.exports.stripCommandPrefix = stripCommandPrefix;
module.exports.stripLucidePrefix = stripLucidePrefix;
module.exports.buildPickerItems = buildPickerItems;
module.exports.filterPickerItems = filterPickerItems;
module.exports.modalIconCandidates = modalIconCandidates;
module.exports.iconMatchScore = iconMatchScore;
module.exports.filterIconNames = filterIconNames;
module.exports.ICON_ALIASES = ICON_ALIASES;
module.exports.QuickPanelIconPickerModal = QuickPanelIconPickerModal;
module.exports.QuickPanelPickerModal = QuickPanelPickerModal;
module.exports.IconSuggestModal = IconSuggestModal;
module.exports.QuickPanelSettingsModal = QuickPanelSettingsModal;
module.exports.ConfirmLikeModal = ConfirmLikeModal;
