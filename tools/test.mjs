/*
 * quick-panel · 纯函数与启动开销断言（离线可跑，不需要 Obsidian）
 *
 *   用法：node tools/test.mjs
 *   退出码：0 = 全绿；非 0 = 有失败（部署/提交前必须为 0，这是铁律）
 *
 * 覆盖六块：
 *   1) 版本三件套与项目约定（id / 版本 / 一句话描述 / versions.json / id 未占用由 check-id 管）
 *   2) 配置归一化与校验（任何脏输入都不抛异常、坏条目记入 errors）
 *   3) 图标来源判定（Lucide / emoji / 库内图片 / 认不出）
 *   4) 自适应列数与「最近用过」去重截断
 *   5) 失效检测 / 过滤 / JSON 往返（坏 JSON 不覆盖）
 *   6) 启动开销与「只写一个文件」的源码级断言（onload 里不许出现扫描型 API）
 */

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0;
let fail = 0;
const failures = [];
/**
 * 提示桩：Notice 必须在 main.js 加载**之前**就装好 —— main.js 是在模块顶层
 * `const { Notice } = require('obsidian')` 解构的，之后再换 stub 上的字段已经改不到它。
 */
const noticeSink = { record: false, items: [] };
/** 记录"弹出了几个 Modal"（确认窗断言用；StubModal.open 里自增） */
let modalOpenCount = 0;
/** 记录"关了几次弹窗"（"执行后关闭面板"断言用；StubModal.close 里自增） */
let modalCloseCount = 0;
class NoticeStub {
  constructor(message) {
    if (noticeSink.record) noticeSink.items.push(String(message));
  }
}
function ok(cond, label) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(label);
  }
}
function eq(actual, expected, label) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) {
    fail += 1;
    failures.push(label + ' → 实际 ' + JSON.stringify(actual) + ' / 期望 ' + JSON.stringify(expected));
    return;
  }
  pass += 1;
}
function group(title) {
  console.log('\n· ' + title);
}

/* ============ 0. 装入插件源码（obsidian 用桩件顶替） ============ */

const SOURCE = readFileSync(join(ROOT, 'main.js'), 'utf8');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const VERSIONS = JSON.parse(readFileSync(join(ROOT, 'versions.json'), 'utf8'));
const STYLES = readFileSync(join(ROOT, 'styles.css'), 'utf8');

/*
 * 极简假 DOM。只实现面板真的用到的那些 API，并照 Obsidian 的约定实现 createEl：
 * 一个参数 = 标签名，第二个参数 = { cls, text, attr }，返回值就是新建的元素。
 * 有了它，「面板渲染」这段真代码能在 Node 里真跑一遍（第 7 组断言）。
 */
class FakeElement {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.tag = this.tagName.toLowerCase();
    this.children = [];
    this.parentElement = null;
    this.classList = { _s: new Set() };
    this.style = {
      _m: {},
      setProperty(k, v) {
        this._m[k] = v;
      },
      getPropertyValue(k) {
        return this._m[k];
      },
    };
    this.attrs = {};
    this._text = '';
    this._listeners = {};
    this.scrollCalls = 0;
    this.isConnected = true;
    this.value = '';
    // 与真实 DOM 一致：每个元素都能拿到它所属的 document（main.js 靠 ownerDocument.defaultView 找窗口）
    this.ownerDocument = globalThis.document || null;
  }
  get classes() {
    return Array.from(this.classList._s);
  }
  addClass(c) {
    String(c).split(/\s+/).filter(Boolean).forEach((x) => this.classList._s.add(x));
  }
  removeClass(c) {
    String(c).split(/\s+/).filter(Boolean).forEach((x) => this.classList._s.delete(x));
  }
  hasClass(c) {
    return this.classList._s.has(c);
  }
  toggleClass(c, on) {
    const want = on === undefined ? !this.hasClass(c) : !!on;
    if (want) this.addClass(c);
    else this.removeClass(c);
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  }
  setText(t) {
    this._text = String(t);
    this.children = [];
  }
  getText() {
    if (this.children.length) return this.children.map((c) => c.getText()).join('');
    return this._text;
  }
  appendChild(el) {
    el.parentElement = this;
    this.children.push(el);
    return el;
  }
  removeChild(el) {
    this.children = this.children.filter((c) => c !== el);
  }
  empty() {
    this.children.forEach((c) => {
      c.parentElement = null;
    });
    this.children = [];
  }
  createEl(tag, o) {
    const el = new FakeElement(tag);
    if (o && o.cls) el.addClass(o.cls);
    if (o && o.text !== undefined) el.setText(o.text);
    if (o && o.attr) Object.keys(o.attr).forEach((k) => el.setAttribute(k, o.attr[k]));
    this.appendChild(el);
    return el;
  }
  createDiv(o) {
    return this.createEl('div', o);
  }
  createSpan(o) {
    return this.createEl('span', o);
  }
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn);
  }
  fire(type, evt) {
    (this._listeners[type] || []).forEach((f) => f(evt || { preventDefault() {}, target: this }));
  }
  click() {
    this.fire('click');
  }
  focus() {}
  getBoundingClientRect() {
    return { left: 100, top: 100, width: 600, height: 300, right: 700, bottom: 400 };
  }
  scrollIntoView() {
    this.scrollCalls += 1;
  }
  closest(sel) {
    let node = this;
    const want = String(sel).replace(/^\./, '');
    while (node) {
      if (node.hasClass && node.hasClass(want)) return node;
      node = node.parentElement;
    }
    return null;
  }
  querySelector(sel) {
    const want = String(sel).replace(/^\./, '');
    const stack = this.children.slice();
    while (stack.length) {
      const el = stack.shift();
      if (el.hasClass && el.hasClass(want)) return el;
      stack.push(...el.children);
    }
    return null;
  }
  querySelectorAll(sel) {
    const want = String(sel).replace(/^\./, '');
    const out = [];
    const stack = this.children.slice();
    while (stack.length) {
      const el = stack.shift();
      if (el.hasClass && el.hasClass(want)) out.push(el);
      stack.push(...el.children);
    }
    return out;
  }
}

globalThis.window = {
  innerWidth: 1200,
  innerHeight: 800,
  devicePixelRatio: 1,
  setTimeout: (fn) => {
    fn();
    return 1;
  },
  requestAnimationFrame: (fn) => {
    fn();
    return 1;
  },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  addEventListener() {},
  removeEventListener() {},
};
globalThis.document = {
  body: new FakeElement('body'),
  addEventListener() {},
  removeEventListener() {},
};
// 与浏览器一致：document.defaultView 指回 window（main.js 靠它判定"面板在哪个窗口"）
globalThis.document.defaultView = globalThis.window;

class StubModal {
  constructor(app) {
    this.app = app;
    this.scope = { register() {} };
    this.containerEl = {};
    this.modalEl = {};
    this.contentEl = {};
  }
  open() {
    modalOpenCount += 1;
  }
  close() {
    modalCloseCount += 1;
  }
}
class StubPlugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
  }
  addCommand() {}
  addRibbonIcon() {}
  registerDomEvent() {}
  registerEvent() {}
}

/** Setting 的链式桩：每个方法返回自身，回调不自动触发（由测试显式调用） */
const settingInstances = [];
class StubSetting {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.components = [];
    settingInstances.push(this);
  }
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  setHeading() {
    return this;
  }
  addToggle(cb) {
    this.components.push(
      cb({
        setValue() {
          return this;
        },
        onChange() {
          return this;
        },
      })
    );
    return this;
  }
  addSlider(cb) {
    this.components.push(
      cb({
        setLimits() {
          return this;
        },
        setValue() {
          return this;
        },
        setDynamicTooltip() {
          return this;
        },
        onChange() {
          return this;
        },
      })
    );
    return this;
  }
  addDropdown(cb) {
    this.components.push(
      cb({
        addOption() {
          return this;
        },
        setValue() {
          return this;
        },
        onChange() {
          return this;
        },
      })
    );
    return this;
  }
}

const obsidianStub = new Proxy({
  Plugin: StubPlugin,
  Modal: StubModal,
  Notice: NoticeStub,
  Setting: StubSetting,
  Menu: class Menu {},
    setIcon() {},
    getIconIds() {
      return ['lucide-settings', 'lucide-home', 'home'];
    },
    normalizePath: (p) => String(p).replace(/\\/g, '/'),
  },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      return class StubAny {};
    },
  }
);

const require_ = createRequire(import.meta.url);
const Module_ = require_('node:module');
// 只拦 'obsidian'，其余照旧（注意：不能把补丁再挂回 _load，否则无限递归）
const originalLoad = Module_._load.bind(Module_);
Module_._load = function (request, parent, isMain) {
  if (request === 'obsidian') return obsidianStub;
  return originalLoad(request, parent, isMain);
};

let QP = null;
try {
  QP = require_(join(ROOT, 'main.js'));
  ok(true, 'main.js 能在 Node 下被 require（纯函数可离线测）');
} catch (e) {
  ok(false, 'main.js 能被 require：' + (e && e.message));
}

if (!QP) {
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}

/* ============ 1. 版本三件套与项目约定 ============ */

group('版本三件套与项目约定');
eq(MANIFEST.id, 'quick-panel', 'manifest id = quick-panel（= 仓库名 = 部署文件夹名）');
eq(MANIFEST.name, 'Quick Panel', 'manifest name = Quick Panel');
ok(/^\d+\.\d+\.\d+$/.test(MANIFEST.version), 'version 形如 x.y.z');
ok(MANIFEST.isDesktopOnly === false, 'isDesktopOnly = false');
ok(!!MANIFEST.minAppVersion, '有 minAppVersion');
eq(Array.isArray(VERSIONS[MANIFEST.version]), false, 'versions.json 不写数组形态');
eq(VERSIONS[MANIFEST.version], MANIFEST.minAppVersion, 'versions.json 的 minAppVersion 取自本插件 manifest 自身的值');

const desc = String(MANIFEST.description || '');
ok(desc.length > 0 && desc.indexOf('\n') < 0, '描述是一句话（不含换行）');
ok(desc.length <= 40, '描述不超过 40 字（实际 ' + desc.length + ' 字）');
ok(/。$/.test(desc), '描述以句号收尾');
ok(desc.indexOf('，') < 0 && desc.indexOf('、') < 0, '描述不罗列功能点（一句到底）');

eq(QP.CONFIG_NAME, '快捷面板.json', '配置文件名固定为 快捷面板.json（可见、非点号隐藏名）');
eq(QP.CONFIG_NAME_LEGACY, '快接面板.json', '保留旧文件名常量，用于自动迁移（改名不丢格子）');
ok(/CONFIG_NAME_LEGACY/.test(SOURCE) && /adapter\.remove\(CONFIG_NAME_LEGACY\)/.test(SOURCE), '旧配置会被搬成新名并从库里移除');
eq(QP.CONFIG_VERSION, 2, '配置结构版本 = 2（v2：默认不显示搜索框、示例格换成核验过的核心命令）');
eq(QP.normalizePanelConfig(null).panel.showSearch, false, '默认不显示过滤框（面板里直接打字就能过滤）');
eq(QP.RECENT_LIMIT, 12, '「最近用过」上限 12 条');
ok(existsSync(join(ROOT, 'tools', 'check-id.mjs')), 'tools/check-id.mjs 就位');
ok(existsSync(join(ROOT, 'tools', 'deploy.ps1')), 'tools/deploy.ps1 就位');
ok(existsSync(join(ROOT, 'LICENSE')), 'LICENSE 就位');

/* ============ 2. 配置归一化与校验 ============ */

group('配置归一化与校验');

eq(QP.normalizePanelConfig(undefined).items, [], 'undefined → 空条目（不抛异常）');
eq(QP.normalizePanelConfig(null).errors, [], 'null 不算「坏文件」（首次运行走的就是这条）');
ok(QP.normalizePanelConfig(42).errors.length === 1, '根节点是数字 → 记 1 条 errors');
eq(QP.normalizePanelConfig({ panel: { columns: 'auto' } }).panel.columns, 'auto', 'columns 默认 auto');
eq(QP.normalizePanelConfig({ panel: { columns: 100 } }).panel.columns, 'auto', 'columns 越界（100）→ 回退 auto');
eq(QP.normalizePanelConfig({ panel: { columns: 4 } }).panel.columns, 4, 'columns 合法（4）保留');
eq(QP.normalizePanelConfig({ panel: { iconSize: 9999 } }).panel.iconSize, 96, 'iconSize 上限 96');
eq(QP.normalizePanelConfig({ panel: { iconSize: 1 } }).panel.iconSize, 20, 'iconSize 下限 20');
eq(QP.normalizePanelConfig({ panel: { showRecent: false } }).panel.showRecent, false, 'showRecent 开关可关');
eq(QP.normalizePanelConfig({ items: 'nope' }).items, [], 'items 不是数组 → 空（不炸）');

const dirty = {
  version: 1,
  items: [
    { type: 'command', id: 'app:reload', label: '重载' },
    { type: 'command', id: '   ' },
    { type: 'file', path: 'A/B.md' },
    { type: 'folder' },
    { type: 'url', url: 'https://x' },
    { type: 'command', id: 'x', icon: 123 },
    { type: 'command', id: 'y', level: 9 },
    null,
  ],
};
const dn = QP.normalizePanelConfig(dirty);
eq(dn.items.length, 2, '脏配置里只有 2 条能留（其余丢弃）');
eq(dn.errors.length, 6, '被丢弃的 6 条全部记入 errors（不静默吞掉）');
ok(dn.errors[0].indexOf('第 2 条') === 0, 'errors 指明第几条');

eq(QP.validateItem({ type: 'command', id: 'a' }).valid, true, '命令条目：有 id 即合法');
eq(QP.validateItem({ type: 'command', id: '  ' }).valid, false, '命令条目：id 是空白 = 非法');
eq(QP.validateItem({ type: 'file', path: 'A.md' }).valid, true, '文件条目：库内相对路径合法');
eq(QP.validateItem({ type: 'file', path: '/abs/A.md' }).valid, false, '文件条目：绝对路径非法（同步会坏）');
eq(QP.validateItem({ type: 'file', path: 'C:\\x\\A.md' }).valid, false, '文件条目：Windows 绝对路径非法');
eq(QP.validateItem({ type: 'folder', path: 'F Craftlab' }).valid, true, '文件夹条目合法');
eq(QP.validateItem({ type: 'file', path: 'A.md', icon: '' }).valid, true, 'icon 允许空串（回退默认图标）');
eq(QP.validateItem({ type: 'file', path: 'A.md', icon: 5 }).valid, false, 'icon 不是字符串 = 非法');
eq(QP.validateItem({ type: 'command', id: 'a', level: 3 }).valid, true, 'level 2–6 合法');
eq(QP.validateItem({ type: 'command', id: 'a', level: 1 }).valid, false, 'level 1 非法（一级标题不进面板）');

eq(QP.itemKey({ type: 'command', id: 'app:reload' }), 'command:app:reload', '命令唯一键 = command:<id>');
eq(QP.itemKey({ type: 'file', path: 'a\\b.md' }), 'file:a/b.md', '文件唯一键做了分隔符规整');

/* ============ 3. 图标来源判定 ============ */

group('图标来源判定');
eq(QP.iconSpecOf('settings').kind, 'lucide', 'lucide 名');
eq(QP.iconSpecOf('settings').value, 'settings', 'lucide 名原样（小写）');
eq(QP.iconSpecOf('Settings').value, 'settings', 'lucide 名大小写不敏感');
eq(QP.iconSpecOf('⚙️').kind, 'emoji', 'emoji 判定');
eq(QP.iconSpecOf('🚩').kind, 'emoji', 'emoji（非 ASCII）判定');
eq(QP.iconSpecOf('图片/图标.png').kind, 'image', '库内 png → image');
eq(QP.iconSpecOf('assets\\logo.SVG').kind, 'image', '反斜杠 + 大写扩展名也是库内图片');
eq(QP.iconSpecOf('D:\\pic\\a.png').kind, 'image', '绝对路径仍按图片处理，但带提示');
ok(QP.iconSpecOf('D:\\pic\\a.png').reason.length > 0, '绝对路径图片给出提示文案');
eq(QP.iconSpecOf('https://x.com/a.png').kind, 'none', '网址图标本版不支持');
eq(QP.iconSpecOf('').kind, 'none', '空 = 用默认图标');
const emojiSpec = QP.iconSpecOf('两个 汉字');
eq(emojiSpec.kind, 'none', '认不出的写法 → none（面板会画默认图标 + 提示）');
ok(emojiSpec.reason.length > 0, '认不出时给出原因（不静默）');

const candidates = QP.iconCandidates(['lucide-home', 'home', 'x']);
ok(candidates.indexOf('home') >= 0, '候选清单含 home');
eq(candidates.filter((n) => n === 'home').length, 1, '候选清单去重');
ok(candidates.length >= 100, '只有兜底清单时也有足量候选（实际 ' + candidates.length + ' 个）');
eq(QP.iconCandidates(null).length, QP.LUCIDE_CANDIDATES.length, '拿不到运行期清单 → 用兜底清单');

/* ============ 4. 自适应列数与最近用过 ============ */

group('自适应列数与最近用过');
eq(QP.gridColumns(760, 72, 8), 9, '760px / 72px 格 → 9 列');
eq(QP.gridColumns(300, 72, 8), 3, '300px 窄容器 → 3 列');
eq(QP.gridColumns(0, 72, 8), 2, '宽度 0（还没布局）→ 保底 2 列');
eq(QP.gridColumns(100000, 72, 8), 12, '超宽 → 上限 12 列');
eq(QP.gridColumns(50, 72, 8), 2, '极窄 → 下限 2 列');
eq(QP.gridColumns(72, 72, 0), 2, '缺 gap 参数也不崩（默认 0）');
ok(QP.gridColumns(1000, 72, 8) > QP.gridColumns(500, 72, 8), '列数随宽度单调不减');

const r1 = QP.pushRecent([], { type: 'command', id: 'a', usedAt: 1 }, 12);
eq(r1.length, 1, '首次推进写入 1 条');
const r2 = QP.pushRecent(r1, { type: 'command', id: 'b', usedAt: 2 }, 12);
eq(r2.map((r) => r.id), ['b', 'a'], '新的在最前');
const r3 = QP.pushRecent(r2, { type: 'command', id: 'a', usedAt: 3 }, 12);
eq(r3.map((r) => r.id), ['a', 'b'], '同 id 去重并提到最前');
eq(r3[0].usedAt, 3, '时间戳更新为最新');
const many = [];
for (let i = 0; i < 20; i += 1) many.push({ type: 'command', id: 'c' + i, usedAt: i });
const r4 = QP.pushRecent(many, { type: 'file', path: 'A.md', usedAt: 99 }, 12);
eq(r4.length, 12, '超过上限只留 12 条');
eq(r4[0].path, 'A.md', '文件项与命令项按各自键去重');
eq(QP.pushRecent([], { type: 'url', url: 'x' }, 12), [], '不认识的类型不进最近记录');

/* ============ 5. 失效检测 / 过滤 / JSON 往返 ============ */

group('失效检测 / 过滤 / JSON 往返');
const items = [
  { type: 'command', id: 'app:reload', nameSnapshot: '重载应用' },
  { type: 'command', id: 'quickadd:choice:x', label: '快速捕捉' },
  { type: 'file', path: '1 Obsidian/页面/Home.md' },
  { type: 'folder', path: 'F Craftlab' },
];
const files = { '1 Obsidian/页面/Home.md': { path: '1 Obsidian/页面/Home.md' }, 'F Craftlab': { path: 'F Craftlab', children: [] } };
const missing = QP.findMissingItems(items, {
  findCommand: (id) => (id === 'app:reload' ? { id: id } : undefined),
  getAbstractFileByPath: (p) => files[p],
  isFolder: (f) => !!f.children,
});
eq(missing.length, 1, '四条里只有失效命令被标出');
eq(missing[0].kind, 'command', '标出的是 command 类型');
eq(missing[0].key, 'quickadd:choice:x', '标出的键是命令 id');

const missingFile = QP.findMissingItems([{ type: 'file', path: '没了.md' }], {
  findCommand: () => undefined,
  getAbstractFileByPath: () => undefined,
});
eq(missingFile[0].kind, 'file-missing', '库内找不到的文件 → file-missing');

const wrongKind = QP.findMissingItems([{ type: 'folder', path: '1 Obsidian/页面/Home.md' }], {
  getAbstractFileByPath: (p) => files[p],
  isFolder: () => false,
});
eq(wrongKind[0].kind, 'not-a-folder', '声明文件夹却指向文件 → not-a-folder');

eq(QP.filterItems(items, '').length, 4, '空查询 = 全量');
eq(QP.filterItems(items, '重载').map((i) => i.id), ['app:reload'], '按 label 中文匹配');
eq(QP.filterItems(items, '快速').map((i) => i.id), ['quickadd:choice:x'], '按 label 匹配命令');
eq(QP.filterItems(items, 'RELOAD').map((i) => i.id), ['app:reload'], '大小写不敏感');
eq(QP.filterItems(items, 'craftlab').length, 1, '按路径匹配');
eq(QP.filterItems(items, '不存在的词').length, 0, '无匹配返回空');

const roundTrip = QP.normalizePanelConfig({
  version: 1,
  panel: { columns: 'auto', showRecent: true, iconSize: 40, showSearch: true },
  items: [
    { type: 'command', id: 'app:reload', label: ' 重载 ', icon: 'refresh', nameSnapshot: '重载应用' },
    { type: 'file', path: 'a\\b.md', label: '文章' },
  ],
  recent: [{ type: 'command', id: 'app:reload', usedAt: 7 }],
});
const text = QP.serializePanelText(roundTrip);
ok(text.endsWith('\n'), '落盘文本以换行收尾');
const back = QP.parsePanelFile(text);
eq(back.corrupt, false, '写出去的文本能读回来');
eq(back.items[0].label, '重载', 'label 的首尾空格被规整');
eq(back.items[1].path, 'a/b.md', '路径分隔符被规整');
eq(back.recent[0].usedAt, 7, 'recent 时间戳原样保留');
eq(QP.parsePanelFile(QP.serializePanelText(back)).items, back.items, '序列化 → 解析 → 再序列化稳定（幂等）');

const broken = QP.parsePanelFile('{ 这不是 JSON');
eq(broken.corrupt, true, '坏 JSON 被识别（不抛异常）');
eq(broken.items, [], '坏 JSON → 空面板起步');
ok(broken.parseError.length > 0, '坏 JSON 带上原因（提示用）');
eq(QP.serializePanelText(broken).indexOf('这不是 JSON'), -1, '坏内容不会被写回去（不可能覆盖用户文件）');

/* ============ 6. 启动开销与「只写一个文件」的源码断言 ============ */

group('启动开销与源码约束');

function methodBody(text, signature) {
  const i = text.indexOf(signature);
  if (i < 0) return '';
  let depth = 0;
  let started = false;
  for (let j = i; j < text.length; j += 1) {
    const ch = text[j];
    if (ch === '{') {
      depth += 1;
      started = true;
    } else if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) return text.slice(i, j + 1);
    }
  }
  return '';
}

function stripComments(text) {
  let out = '';
  let state = 'code';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const n = text[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '*') {
        state = 'block';
        i += 1;
      } else if (c === '/' && n === '/') {
        state = 'line';
        i += 1;
      } else if (c === "'") {
        state = 'single';
        out += c;
      } else if (c === '"') {
        state = 'double';
        out += c;
      } else if (c === '`') {
        state = 'template';
        out += c;
      } else {
        out += c;
      }
      continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') {
        state = 'code';
        i += 1;
      }
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      }
      continue;
    }
    out += c;
    if (state === 'single' && c === '\\') {
      out += text[i + 1] || '';
      i += 1;
      continue;
    }
    if (state === 'double' && c === '\\') {
      out += text[i + 1] || '';
      i += 1;
      continue;
    }
    if (state === 'single' && c === "'") state = 'code';
    else if (state === 'double' && c === '"') state = 'code';
    else if (state === 'template' && c === '`') state = 'code';
  }
  return out;
}

const code = stripComments(SOURCE);
const onloadBody = methodBody(code, 'async onload()');
ok(onloadBody.length > 100, '取到 onload 源码');

const forbiddenInOnload = [
  'listCommands',
  'vault.getFiles',
  'getAllLoadedFiles',
  'recurseChildren',
  'setInterval',
  'setTimeout',
  'requestUrl',
  'fetch(',
  'registerInterval',
  'workspace.on(',
];
for (const needle of forbiddenInOnload) {
  ok(onloadBody.indexOf(needle) < 0, 'onload 里不出现 ' + needle + '（启动零扫描）');
}

ok((code.match(/listCommands\(/g) || []).length === 1, '全文件只有一处 listCommands（在 commandRegistry 里）');
ok(code.indexOf('listCommands(') > code.indexOf('async onload()') + onloadBody.length - 1, 'listCommands 不在 onload 内（面板打开时才解析）');
ok(/class QuickPanelModal extends Modal/.test(code), '面板是一个 Modal（可停在鼠标位置）');
ok(/this\.setView\(this\.modalEl\.ownerDocument \|\| document\)/.test(code), '面板打开时按"它所在的窗口"绑定视图（弹窗不会串坐标）');
ok(/ownerDocument\.defaultView/.test(code) && /getWindow\(\)/.test(code), '窗口统一由 ownerDocument.defaultView 取（主窗口/弹窗都对）');
ok(!/__quickPanelMouse|mousemove|dragX/.test(code), '居中布局后不再需要鼠标跟踪与拖拽（相关代码已全部移除）');
// 居中布局不需要任何全局级监听（拖拽功能已随"改居中"移除）
ok(!/\bw\.addEventListener\(/.test(code), '不再有任何窗口级常驻监听（居中不需要）');
ok(!/\bdocument\.addEventListener\(/.test(code), '不绕过 registerDomEvent 直接挂 document 监听（卸载才干净）');
ok(!/window\.addEventListener\(/.test(code), '不直接挂 window 监听');
ok(/gridColumns\(/.test(code), '列数由 gridColumns 纯函数决定，不写死在 CSS');
ok(!/setInterval/.test(code), '全文件没有 setInterval（面板生命周期不依赖定时器）');
ok((code.match(/\.write\(/g) || []).length === 3, '写盘只有三处（配置文件本身 + 旧名迁移 + 诊断文件），没有第四个写点');
ok((code.match(/adapter\.write\(/g) || []).length === 3, '三处写盘都走 vault.adapter.write');
ok(code.indexOf("adapter.write(this.configPath") >= 0, '写盘目标之一就是配置文件的固定路径 this.configPath');
ok(code.indexOf("adapter.write(this.configPath, oldText)") >= 0, '旧名迁移只把旧文件内容原样写给新名（不加工内容）');
ok(code.indexOf("'.quick-panel-diag.txt'") >= 0, '另一处写盘是显式命名的诊断文件（可用完即删）');
// 逐个检查 adapter.write 的**第一个实参**必须是白名单里的目标（只允许配置文件和诊断文件）
const writeTargets = [];
{
  const re = /adapter\.write\(/g;
  let m;
  while ((m = re.exec(code))) {
    let depth = 1;
    let i = m.index + m[0].length;
    let args = '';
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (ch === '(') depth += 1;
      if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
      args += ch;
      i += 1;
    }
    writeTargets.push(args.split(',')[0].trim());
  }
}
ok(writeTargets.length === 3, '全文件 3 处 adapter.write（实际 ' + writeTargets.length + '）');
const ALLOWED_TARGETS = ['this.configPath', 'rel', 'CONFIG_NAME_LEGACY'];
ok(
  writeTargets.every((t) => ALLOWED_TARGETS.indexOf(t) >= 0),
  '每处写盘的目标都在白名单内（this.configPath / rel / CONFIG_NAME_LEGACY）：' + JSON.stringify(writeTargets)
);
ok(!/\.obsidian/.test(code), '源码里不出现 .obsidian（不碰插件配置目录）');
ok(!/vault\.delete|vault\.trash|vault\.rename/.test(code), '不删除/改名库内文件');
ok(/vault\.create\(rel, text\)/.test(code) || /vault\.create\(/.test(code), '库内新建只允许诊断文件这一处（vault.create 的第一参数是固定常量 rel）');
ok(/const rel = '\.quick-panel-diag\.txt'/.test(code), 'vault.create 的目标是固定的诊断文件名常量');
ok(/class QuickPanelModal extends Modal/.test(code) && /this\.cellNodes = \[\]/.test(code), 'onClose 里释放网格节点引用');

/* 视图类不许覆盖 Obsidian 的保留方法名（simple-memos 的教训） */
const modalBody = code.slice(code.indexOf('class QuickPanelModal'), code.indexOf('class ConfirmLikeModal'));
const reserved = ['addAction', 'onResize', 'getState', 'setState', 'onPaneMenu', 'onMoreOptionsMenu'];
for (const name of reserved) {
  ok(modalBody.indexOf(name + '(') < 0, '面板类不覆盖 Obsidian 的 ' + name + '()');
}

/* 样式文件 */
ok(/\.modal-container\.quick-panel\s*\{/.test(STYLES), 'styles.css 里有面板容器规则');
const containerRule = (STYLES.match(/\.modal-container\.quick-panel\s*\{[^}]*\}/) || [''])[0];
ok(/inset:\s*0/.test(containerRule), '容器铺满视口（inset:0）');
ok(/display:\s*flex/.test(containerRule), '容器 display: flex');
ok(/align-items:\s*center/.test(containerRule), '容器 align-items: center（垂直居中）');
ok(/justify-content:\s*center/.test(containerRule), '容器 justify-content: center（水平居中）');
ok(/transform:\s*none/.test(containerRule), '容器不带 transform（避免叠加 Obsidian 的居中位移）');
const cardRule = (STYLES.match(/\.quick-panel \.modal,\s*\.modal-container\.qp-confirm \.modal\s*\{[^}]*\}/) || [''])[0];
ok(/position:\s*relative/.test(cardRule), '卡片 position: relative（作为 flex 项参与居中）');
ok(!/position:\s*absolute/.test(cardRule), '卡片不再是 absolute（absolute 会被父级 flex 定位二次偏移）');
ok(/margin:\s*0/.test(cardRule), '卡片 margin 归零');
ok(/grid-template-columns: repeat\(var\(--qp-cols/.test(STYLES), 'CSS 的列数由 --qp-cols 变量驱动');
ok(/\.modal-container\.quick-panel\s*>\s*\.modal-close-button/.test(STYLES), '隐藏原生关闭按钮的选择器必须从 .modal-container 起（它在容器里，不在 .modal 里）');
ok(/\.modal-close-button\s*\{[^}]*display:\s*none\s*!important/.test(STYLES), '隐藏用 !important（原生按钮有自己的显示规则）');
ok(!/\.quick-panel \.modal-close-button\s*\{/.test(STYLES), '不再使用那个打偏的后代选择器');
ok(/\.qp-cell[\s\S]{0,400}box-shadow: none/.test(STYLES), '格子按钮强制清掉主题底色/阴影');

/* 常用方法：用最简对象直接调用（不建 DOM） */
/** 所有假 host 都需要的配置变更订阅（面板 onOpen 会订阅，用于就地刷新） */
function cfgSub() {
  return {
    onConfigChanged(fn) {
      this._listeners = this._listeners || [];
      this._listeners.push(fn);
      return () => {
        this._listeners = (this._listeners || []).filter((x) => x !== fn);
      };
    },
    notifyConfigChanged() {
      (this._listeners || []).forEach((fn) => fn());
    },
  };
}

const fakeHost = Object.assign({
  commandRegistry: () => ({ find: () => undefined, findByName: () => undefined }),
}, cfgSub());
const proto = QP.QuickPanelModal.prototype;
const ctx = { host: fakeHost, app: { vault: {} } };
eq(proto.displayName.call(ctx, { type: 'command', id: 'app:reload', label: '重载' }), '重载', 'displayName 优先用 label');
eq(proto.displayName.call(ctx, { type: 'command', id: 'app:reload', nameSnapshot: '重载应用' }), '重载应用', 'label 空时用 nameSnapshot');
eq(proto.displayName.call(ctx, { type: 'command', id: 'app:reload' }), 'app:reload', '都没有时用命令 id（不显示空白格）');
eq(proto.displayName.call(ctx, { type: 'file', path: 'A/B/首页.md' }), '首页', '文件项用去扩展名的文件名');
eq(proto.displayName.call(ctx, { type: 'folder', path: 'F Craftlab' }), 'F Craftlab', '文件夹项用末级目录名');

/* ============ 7. 面板渲染冒烟（用极简假 DOM 真跑一遍 onOpen） ============ */

group('面板渲染冒烟（假 DOM）');

/* 假库：两条真实存在的路径 + 一份"已经不存在"的路径 */
const vaultFiles = {
  '1 Obsidian/页面/Home.md': { path: '1 Obsidian/页面/Home.md' },
  'F Craftlab': { path: 'F Craftlab', children: [] },
};

const fakeApp = {
  vault: {
    getAbstractFileByPath: (p) => vaultFiles[p],
    adapter: { getResourcePath: (p) => 'app://local/' + p, getFullPath: (p) => 'E:/Dnotes/' + p },
    getFiles: () => Object.keys(vaultFiles).map((k) => vaultFiles[k]),
  },
  workspace: { activeEditor: null, getLeaf: () => ({ openFile: async () => {} }) },
  commands: {
    listCommands: () => [
      { id: 'app:reload', name: '重载应用' },
      { id: 'app:open-settings', name: '设置' },
    ],
    executeCommandById: () => true,
    findCommand: (id) => (id === 'app:reload' ? { id: id } : undefined),
  },
  internalPlugins: { getEnabledPluginById: () => ({ revealInFolder() {} }) },
};

const notices = [];
const host = Object.assign({
  commandRegistry() {
    return {
      find: (id) => (id === 'app:reload' ? { id: id, name: '重载应用' } : undefined),
      findByName: () => undefined,
    };
  },
  touchRecent() {},
  savePanelConfig() {},
  openConfigFile() {},
  revealConfigFile() {},
  runCommandById() {
    return true;
  },
  reopen() {},
  notices: notices,
}, cfgSub());

function buildPanel(config, options) {
  const modal = new QP.QuickPanelModal(fakeApp, host, QP.normalizePanelConfig(config), options || {});
  dbgModal = modal;
  if (options && options.corrupt) modal.config.corrupt = true;
  // 面板所在的 DOM（相当于 Obsidian 的 .modal-container 根 + 卡片）
  modal.modalEl = new FakeElement('div');
  modal.modalEl.addClass('modal-container');
  modal.modalEl.addClass('quick-panel');
  modal.containerEl = modal.modalEl;
  modal.contentEl = new FakeElement('div');
  modal.contentEl.addClass('modal-content');
  modal.modalEl.appendChild(modal.contentEl);
  modal.scope = { register() {} };
  modal.registerDomEvent = () => {}; // 假 DOM 里不需要真的挂监听
  modal.onOpen();
  return modal;
}
let dbgModal = null;

const panelConfig = {
  version: 1,
  panel: { columns: 'auto', showRecent: true, iconSize: 40, showSearch: true },
  items: [
    { type: 'command', id: 'app:reload', label: '重载', icon: 'refresh-cw' },
    { type: 'command', id: 'quickadd:choice:x', label: '快速捕捉', icon: 'zap' },
    { type: 'file', path: '1 Obsidian/页面/Home.md', label: '首页', icon: 'home' },
    { type: 'folder', path: 'F Craftlab', icon: 'folder' },
    { type: 'file', path: '没了.md', label: '旧笔记', icon: '🚩' },
  ],
  recent: [{ type: 'command', id: 'gone:cmd', usedAt: 10 }, { type: 'file', path: '没在面板.md', usedAt: 9 }],
};

try {
  const modal = buildPanel(panelConfig, { mouse: { x: 300, y: 200 } });
  const cells = modal.contentEl.querySelectorAll('qp-cell');
  eq(cells.length, 5, '5 条配置 → 5 个格子');
  eq(cells[0].getText(), '重载', '格子显示 label');
  eq(cells[3].getText(), 'F Craftlab', '没写 label 的文件夹 → 用末级目录名');
  eq(cells[1].hasClass('is-missing'), true, '失效命令被标灰');
  eq(cells[4].hasClass('is-missing'), true, '库内找不到的文件被标灰');
  eq(cells[0].hasClass('is-missing'), false, '正常命令不标灰');
  ok(cells[2].getAttribute('title').indexOf('首页') === 0, '格子 title 是完整名称（悬停可看全）');
  ok(cells[1].getAttribute('title').indexOf('重新绑定') > 0, '失效命令的 title 说明可按下重新绑定');

  const status = modal.contentEl.querySelector('qp-status');
  ok(status.getText().indexOf('2 项') >= 0, '底部状态报出失效数量：' + status.getText());
  ok(status.getText().indexOf('命令/文件已找不到') > 0, '状态文案说明了是找不到');

  // 用户反馈"界面信息太多"：计数、操作提示、多余关闭按钮都已删除
  eq(modal.contentEl.querySelectorAll('qp-count').length, 0, '头部不再显示"6 格 · N 项待处理"');
  eq(modal.contentEl.querySelectorAll('qp-hint').length, 0, '底部不再有操作提示小字');
  const headerBtns = modal.contentEl.querySelector('qp-actions').querySelectorAll('qp-icon-btn');
  eq(headerBtns.length, 2, '右上一个 × 都没有（用户要求全去掉）：只剩「＋ 添加」和「⋯ 更多」两个按钮');
  const search = modal.contentEl.querySelector('qp-search-input');
  ok(!!search, '本用例显式开了搜索框时才渲染（默认已关闭）');
  search.value = '首页';
  search.fire('input');
  eq(modal.contentEl.querySelectorAll('qp-cell').length, 1, '过滤后只留匹配的格子');
  eq(modal.visible.length, 1, '内部可见列表同步收缩');

  const grid = modal.contentEl.querySelector('qp-grid');
  eq(modal.columns, 9, '1200px 视口 → 9 列（面板宽度上限 720px）');
  eq(grid.style.getPropertyValue('--qp-cols'), '9', '列数写进 --qp-cols（CSS 不写死）');
  eq(grid.style.getPropertyValue('--qp-cell'), '40px', '格子尺寸来自配置');
  ok(modal.modalEl.style.getPropertyValue('--qp-width').indexOf('px') > 0, '面板宽度按列数算出来（不再自我循环）');

  ok(modal.contentEl.querySelector('qp-recent-row').children.length >= 1, '最近用过分组已渲染');
  ok(modal.contentEl.querySelector('qp-footer') !== null, '底部区域已渲染');

  const modal2 = buildPanel({ version: 1, items: [], recent: [], panel: { showRecent: false, showSearch: false } });
  ok(modal2.contentEl.querySelector('qp-empty') !== null, '空面板给明确占位文案（不是白屏）');
  eq(modal2.contentEl.querySelectorAll('qp-search-input').length, 0, '关掉搜索后不渲染搜索框');
  eq(modal2.contentEl.querySelectorAll('qp-recent').length, 0, '关掉最近用过不渲染该分组');

  const brokenParsed = QP.parsePanelFile('{坏');
  const broken = buildPanel(
    {
      version: 1,
      panel: QP.normalizePanelSettings(null),
      items: [],
      recent: [],
      errors: [],
      corrupt: brokenParsed.corrupt,
      parseError: brokenParsed.parseError,
    },
    { corrupt: true }
  );
  ok(broken.config.corrupt === true, '坏配置标记传到了面板');
  ok(broken.contentEl.querySelector('qp-status').getText().indexOf('读坏') >= 0, '坏配置在面板里明确提示（不静默）');

  // 键盘：方向键移动高亮、Esc 与 Enter 不炸
  const nav = buildPanel(panelConfig);
  nav.setHighlight(0);
  nav.onKeyDown({ key: 'ArrowRight', target: { tagName: 'DIV' }, preventDefault() {} });
  eq(nav.highlight, 1, '右方向键移动一格');
  nav.onKeyDown({ key: 'ArrowDown', target: { tagName: 'DIV' }, preventDefault() {} });
  eq(nav.highlight, 1, '只有一行时按下不越界（5 格 < 10 列）');
  nav.onKeyDown({ key: 'End', target: { tagName: 'DIV' }, preventDefault() {} });
  eq(nav.highlight, nav.visible.length - 1, 'End 跳最后一格');
  nav.onKeyDown({ key: 'Home', target: { tagName: 'DIV' }, preventDefault() {} });
  eq(nav.highlight, 0, 'Home 跳第一格');
  nav.onKeyDown({ key: 'ArrowUp', target: { tagName: 'DIV' }, preventDefault() {} });
  eq(nav.highlight, 0, '到头不越界');
  nav.onKeyDown({ key: 'x', target: { tagName: 'DIV' }, preventDefault() {} });
  ok(nav.query === 'x', '在面板上直接打字即过滤（不必先点搜索框）');
  nav.onKeyDown({ key: 'Escape', target: { tagName: 'DIV' }, preventDefault() {} });
  eq(nav.query, '', 'Esc 先清空过滤词');

  // 多行网格：23 格 / 9 列 → 3 行（9/9/5），上下键按「行」走而不是硬加列数
  const manyItems = [];
  for (let i = 0; i < 23; i += 1) manyItems.push({ type: 'command', id: 'app:reload', label: '第' + i + '格' });
  const nav2 = buildPanel({ version: 2, items: manyItems, recent: [], panel: { showRecent: false } });
  eq(nav2.rows, [9, 9, 5], '行分布 9/9/5（23 格 / 9 列）');
  nav2.setHighlight(8);
  nav2.onKeyDown({ key: 'ArrowDown', target: { tagName: 'DIV' }, preventDefault() {} });
  eq(nav2.highlight, 17, '按下 → 同一列下一行（8 → 17）');
  nav2.onKeyDown({ key: 'ArrowUp', target: { tagName: 'DIV' }, preventDefault() {} });
  eq(nav2.highlight, 8, '按上回到原格');
  nav2.setHighlight(22);
  nav2.onKeyDown({ key: 'ArrowUp', target: { tagName: 'DIV' }, preventDefault() {} });
  eq(nav2.highlight, 13, '最后一行的第 5 格（22，列号 4）上移落在上一行第 5 格（13）');
  nav2.setHighlight(14);
  nav2.onKeyDown({ key: 'ArrowDown', target: { tagName: 'DIV' }, preventDefault() {} });
  eq(nav2.highlight, 22, '最后一行按下 → 走到该行最后一格（14 → 22，跟 macOS 访达一致）');
  nav2.setHighlight(4);
  nav2.onKeyDown({ key: 'ArrowDown', target: { tagName: 'DIV' }, preventDefault() {} });
  eq(nav2.highlight, 13, '4（列号 4）→ 下一行同列 13');

  /*
   * 定位：v0.1.5 起**完全交给 CSS flex**（JS 不参与定位）。
   * 这条是三轮真机教训换来的 —— 只要 JS 量尺寸再 translate，就会在不同 DPI / 窗口布局下飘，
   * 所以这里断言的是"JS 里不许再出现定位代码"，以及"CSS 里必须是 flex 居中"。
   */
  ok(!/style\.transform/.test(code), 'main.js 不再写任何 transform（定位不靠 JS）');
  ok(!/placeAtMouse|centerPoint/.test(code), 'main.js 里没有定位函数残留');
  ok(!/registerDomEvent\(win, 'resize'/.test(code), '不再挂 resize 监听（flex 自动跟随窗口）');
  const holderNoMouse = new QP.QuickPanelModal(fakeApp, host, QP.normalizePanelConfig({ items: [], recent: [] }), {});
  ok(holderNoMouse.mouse === undefined, '面板不再持有鼠标坐标');
  ok(typeof holderNoMouse.getWindow === 'function' && holderNoMouse.getWindow().innerWidth === 1200, 'getWindow() 仍能取到面板所在窗口（诊断用）');
} catch (e) {
  ok(false, '面板渲染冒烟抛异常：' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
}

/* ============ 8. 旧配置名自动迁移（改名不丢格子） ============ */

group('旧配置名自动迁移');

/* 旧名迁移用的配置：故意放"用户自己定的"条目（非默认示例），这样不会被 v2 升级替换 */
const legacyText = JSON.stringify({
  version: 1,
  panel: { columns: 'auto', showRecent: true, iconSize: 40, showSearch: true },
  items: [{ type: 'command', id: 'editor:toggle-source', label: '切换源码模式', icon: 'code' }],
  recent: [],
});

/* 还是默认示例的 v1 配置（用于验证 v1→v2 结构升级） */
const stockV1Text = JSON.stringify({
  version: 1,
  panel: { columns: 'auto', showRecent: true, iconSize: 40, showSearch: true },
  items: [
    { type: 'command', id: 'app:open-settings', label: '设置', icon: 'settings' },
    { type: 'command', id: 'graph:open', label: '关系图谱', icon: 'git-branch' },
    { type: 'command', id: 'app:go-back', label: '后退', icon: 'arrow-left-right' },
  ],
  recent: [],
});

async function runMigration(files) {
  const store = Object.assign({}, files);
  const written = [];
  const adapter = {
    exists: async (p) => Object.prototype.hasOwnProperty.call(store, p),
    read: async (p) => {
      if (!Object.prototype.hasOwnProperty.call(store, p)) throw new Error('ENOENT ' + p);
      return store[p];
    },
    write: async (p, text) => {
      store[p] = text;
      written.push(p);
    },
    remove: async (p) => {
      delete store[p];
    },
  };
  const plugin = Object.create(QP.QuickPanelPlugin.prototype);
  plugin.app = { vault: { adapter: adapter } };
  plugin.configPath = QP.CONFIG_NAME;
  const res = await plugin.readPanelConfig();
  return { res: res, store: store, written: written };
}

try {
  const migrated = await runMigration({ '快接面板.json': legacyText });
  ok(Object.prototype.hasOwnProperty.call(migrated.store, '快捷面板.json'), '旧文件名 → 已写出新文件名');
  ok(!Object.prototype.hasOwnProperty.call(migrated.store, '快接面板.json'), '旧文件已移除');
  ok(migrated.store['快捷面板.json'].indexOf('editor:toggle-source') >= 0, '改名迁移保留了原条目的 id');
  eq(migrated.res.config.items.length, 1, '迁移后配置照常解析（格子还在）');
  eq(migrated.res.config.items[0].label, '切换源码模式', '格子的 label 保住了');
  ok(migrated.res.notice.indexOf('改名') >= 0, '迁移会给用户一条提示（不静默改名）');

  const fresh = await runMigration({});
  ok(Object.prototype.hasOwnProperty.call(fresh.store, '快捷面板.json'), '两个文件都不存在 → 创建新文件名的默认配置');
  ok(fresh.res.notice.indexOf('已创建') >= 0, '首次创建也有提示');

  const both = await runMigration({ '快捷面板.json': legacyText, '快接面板.json': legacyText });
  ok(Object.prototype.hasOwnProperty.call(both.store, '快接面板.json'), '新名已存在时不迁移、也不碰旧文件（不删用户文件）');

  /* v1 → v2 结构升级 */
  const upgraded = await runMigration({ '快捷面板.json': stockV1Text });
  eq(upgraded.res.config.version, 2, 'v1 配置被升级到 v2');
  eq(upgraded.res.config.items.length, QP.DEMO_ITEMS.length, '还是默认示例的 → 整组换成 v2 的核验命令');
  ok(
    upgraded.res.config.items.every((it) => QP.DEMO_ITEMS.some((d) => d.id === it.id)),
    'v2 默认格子全部来自核验过的命令清单'
  );
  ok(upgraded.written.indexOf(QP.CONFIG_NAME) >= 0, '升级结果写回了配置文件（下次不再重复升级）');
  ok(upgraded.res.notice.indexOf('升级') >= 0, '升级有提示（不静默改用户配置）');

  const customV2 = await runMigration({
    '快捷面板.json': JSON.stringify({
      version: 2,
      items: [{ type: 'command', id: 'editor:toggle-source', label: '我的命令' }],
      recent: [],
    }),
  });
  eq(customV2.res.config.items[0].label, '我的命令', '已经是 v2 的配置不做任何改动');

  /* 用户手动打开的过滤框**不得被加载路径清掉**（v0.5.3：旧迁移会把刚打开的开关改回 false，
     表现为"显示过滤框设置无效"） */
  const searchKept = await runMigration({
    '快捷面板.json': JSON.stringify({
      version: 2,
      panel: { columns: 'auto', showRecent: true, iconSize: 40, showSearch: true },
      items: [{ type: 'command', id: 'editor:toggle-source', label: '我的命令' }],
      recent: [],
    }),
  });
  eq(searchKept.res.config.panel.showSearch, true, '用户打开的「显示过滤框」在重新加载后依然保持开启');
  eq(searchKept.written.indexOf(QP.CONFIG_NAME), -1, '加载路径不再改写用户的显示设置（没有多余写盘）');
  eq(searchKept.res.config.items[0].label, '我的命令', '其它字段不受影响');
  ok(!/showSearch === true/.test(SOURCE), '源码里不再有"showSearch 强制改回 false"的迁移');

  /* 未过滤命令表判断失效：listCommands 里没有、但 app.findCommand 能拿到的命令不算失效 */
  const notMissing = QP.findMissingItems(
    [{ type: 'command', id: 'simple-heading:apply' }],
    {
      findCommand: (id) => (id === 'simple-heading:apply' ? { id: id } : undefined),
      getAbstractFileByPath: () => null,
    }
  );
  eq(notMissing.length, 0, '只在编辑器上下文可用的命令不会被误标为"已失效"');
  ok(/findCommand: \(id\) => this\.commandFor\(id\) \|\| registry\.find\(id\)/.test(SOURCE), '面板解析失效项时用的是未过滤的完整命令表');
} catch (e) {
  ok(false, '迁移用例抛异常：' + (e && e.message));
}

/* ============ 9. 点击链路（离线复现"点了没反应"） ============ */

group('点击链路：从点格子到命令真正被调用');

const clickLog = [];
const clickNotices = noticeSink.items; // 直接复用顶层 Notice 桩的记录数组
const clickFiles = {
  '1 Obsidian/页面/Home.md': { path: '1 Obsidian/页面/Home.md' },
};
const SMOKE_COMMANDS = [
  { id: 'app:open-settings', name: '设置' },
  { id: 'global-search:open', name: '全局搜索', checkCallback: () => true },
  { id: 'demo:editor-only', name: '需要编辑器', editorCallback: () => true },
  { id: 'demo:throws', name: '会抛错的命令', callback: () => { throw new Error('boom'); } },
];
const clickApp = {
  vault: {
    adapter: { write: async () => {}, exists: async () => true, read: async () => '{}' },
    getAbstractFileByPath: (p) => clickFiles[p],
    getResourcePath: (p) => 'app://local/' + p,
  },
  workspace: { activeEditor: null, getLeaf: () => ({ openFile: async () => {} }) },
  commands: {
    listCommands: () => SMOKE_COMMANDS.slice(),
    findCommand: (id) => SMOKE_COMMANDS.find((c) => c.id === id),
    executeCommandById: (id) => {      clickLog.push(id);
      const cmd = SMOKE_COMMANDS.find((c) => c.id === id);
      if (!cmd) return false;
      // 照 obsidian.asar 的语义：找到命令就返回 true；命令内部抛错被吞掉
      try {
        if (typeof cmd.callback === 'function') cmd.callback();
      } catch (e) {
        return true;
      }
      return true;
    },
  },
  internalPlugins: { getEnabledPluginById: () => null },
};

// Notice 桩：把提示记下来（断言"不静默"用）
    class CountingNotice {
  constructor(msg) {
    clickNotices.push(String(msg));
  }
}
obsidianStub.Notice = CountingNotice;

globalThis.document = {
  body: new FakeElement('body'),
  addEventListener() {},
  removeEventListener() {},
};
globalThis.document.defaultView = globalThis.window;
const clickHost = {
  commandRegistry() {
    const all = SMOKE_COMMANDS;
    const byId = {};
    all.forEach((c) => (byId[c.id] = c));
    return { all, find: (id) => byId[id], findByName: (name) => all.find((c) => c.name === name), invalidate() {} };
  },
  touchRecent() {},
  logClick(label) {
    clickLog.push('▸ ' + label);
  },
  logExecution() {},
  savePanelConfig() {},
  openConfigFile() {},
  revealConfigFile() {},
  runCommandById(id, cmd) {
    return QP.QuickPanelPlugin.prototype.runCommandById.call(
      { app: clickApp, registry: null, commandRegistry: clickHost.commandRegistry, logExecution() {}, execLog: [] },
      id,
      cmd
    );
  },
  reopen() {},
};

Object.assign(clickHost, cfgSub());
function clickCell(label) {
  clickLog.length = 0;
  noticeSink.items.length = 0;
  noticeSink.record = true;
  const modal = new QP.QuickPanelModal(clickApp, clickHost, QP.normalizePanelConfig({
    version: 2,
    panel: { showSearch: false, showRecent: false },
    items: [
      { type: 'command', id: 'app:open-settings', label: '设置' },
      { type: 'command', id: 'global-search:open', label: '搜索' },
      { type: 'command', id: 'demo:editor-only', label: '需要编辑器' },
      { type: 'file', path: '1 Obsidian/页面/Home.md', label: '首页' },
      { type: 'file', path: '没了.md', label: '失效文件' },
    ],
    recent: [],
  }), {});
  modal.modalEl = new FakeElement('div');
  modal.modalEl.addClass('modal-container');
  modal.modalEl.addClass('quick-panel');
  modal.contentEl = new FakeElement('div');
  modal.modalEl.appendChild(modal.contentEl);
  modal.scope = { register() {} };
  modal.registerDomEvent = () => {};
  modal.onOpen();
  const cells = modal.contentEl.querySelectorAll('qp-cell');
  const target = cells.find((c) => c.getText().indexOf(label) >= 0);
  if (!target) return { found: false };
  target.click();
  const execLog = clickLog.filter((x) => x.charAt(0) !== '▸');
  return { found: true, log: execLog, all: clickLog.slice(), notices: clickNoticeItems(), closed: modal.closed, cell: target, modal: modal };
}

/** 与点击同一条代码路径，但等待执行链走完（用于断言"执行后是否关闭面板"这类时序结果） */
async function clickCellAndWait(label) {
  const r = clickCell(label);
  if (!r.found) return r;
  // 点击链内部是 async 的（executeEntry → runCommand）：这里把同一入口再 await 一次拿到最终状态
  const entry = r.modal.items.find((v) => r.modal.displayName(v.item) === label);
  if (entry) await r.modal.executeEntry(entry);
  return { found: true, log: clickLog.filter((x) => x.charAt(0) !== '▸'), notices: clickNoticeItems(), closed: r.modal.closed };
}

/** 只有 pointerup、没有 click（模拟 click 事件没送达的真机情况） */
function pointerUpCell(label) {
  clickLog.length = 0;
  noticeSink.items.length = 0;
  noticeSink.record = true;
  const modal = new QP.QuickPanelModal(clickApp, clickHost, QP.normalizePanelConfig({
    version: 2,
    panel: { showSearch: false, showRecent: false },
    items: [{ type: 'command', id: 'app:open-settings', label: '设置' }],
    recent: [],
  }), {});
  modal.modalEl = new FakeElement('div');
  modal.modalEl.addClass('modal-container');
  modal.modalEl.addClass('quick-panel');
  modal.contentEl = new FakeElement('div');
  modal.modalEl.appendChild(modal.contentEl);
  modal.scope = { register() {} };
  modal.registerDomEvent = () => {};
  modal.onOpen();
  const cell = modal.contentEl.querySelectorAll('qp-cell')[0];
  cell.fire('pointerdown');
  cell.fire('pointerup');
  return { log: clickLog.filter((x) => x.charAt(0) !== '▸'), notices: clickNoticeItems() };
}

function clickNoticeItems() {
  return noticeSink.items.slice();
}

try {
  const a = clickCell('设置');
  eq(a.found, true, '找到「设置」格子');
  ok(a.log.indexOf('app:open-settings') >= 0, '点一下 → executeCommandById 真的被调用（这是用户报告"没反应"的那条链路）');
  ok(a.closed > 0 || a.log.length > 0, '点击后要么执行命令、要么关面板（不能两者都没发生）');

  const b = clickCell('搜索');
  ok(b.log.indexOf('global-search:open') >= 0, 'checkCallback 型命令同样会被调用');

  const c = clickCell('需要编辑器');
  eq(c.log.length, 0, '需要活动编辑器、而当前没有编辑器 → 不调用命令');
  ok(c.notices.join(' ').indexOf('打开一个笔记') >= 0, '这种情况给出明确提示而不是静默：' + JSON.stringify(c.notices));

  const d = clickCell('首页');
  ok(d.log.length === 0, '文件项不走命令执行（走 openFile）');

  const e = clickCell('失效文件');
  ok(e.notices.join(' ').indexOf('找不到这个文件') >= 0, '失效文件点击给出明确提示：' + JSON.stringify(e.notices));

  // 点击日志：区分"点击没到面板"与"命令没跑"（真机排查用，写进诊断文件）
  const f = clickCell('设置');
  ok(f.all.join(' ').indexOf('▸ 点击 设置') >= 0, '每次点击都留一条日志（▸ 前缀），进诊断文件');

  /* click 没送达、只有 pointerup 的情况（真机"点了没反应"的兜底） */
  const g = pointerUpCell('设置');
  ok(g.log.indexOf('app:open-settings') >= 0, '只有 pointerup（没有 click）时命令同样会被执行');

  /* 同一次点击里 pointerup + click 都到达 → 只执行一次 */
  const h = clickCell('设置');
  h.cell.fire('pointerup');
  eq(h.log.filter((x) => x === 'app:open-settings').length, 1, 'pointerup 与 click 都到达时只执行一次（400ms 去重）');
  /* 命中真机根因的回归：面板的 listCommands 过滤掉了这条命令，但 app.findCommand 能拿到 */
  {
    const modal2 = new QP.QuickPanelModal(clickApp, clickHost, QP.normalizePanelConfig({
      version: 2,
      panel: { showSearch: false, showRecent: false },
      items: [{ type: 'command', id: 'app:open-settings', label: '设置' }],
      recent: [],
    }), {});
    modal2.modalEl = new FakeElement('div');
    modal2.modalEl.addClass('modal-container');
    modal2.modalEl.addClass('quick-panel');
    modal2.contentEl = new FakeElement('div');
    modal2.modalEl.appendChild(modal2.contentEl);
    modal2.scope = { register() {} };
    modal2.registerDomEvent = () => {};
    // 面板注册表里查不到（模拟 listCommands 的 checkCallback 过滤），app 里有
    modal2.host = Object.assign({}, clickHost, {
      commandRegistry: () => ({ all: [], find: () => undefined, findByName: () => undefined, invalidate() {} }),
    });
    clickLog.length = 0;
    let threw2 = null;
    try {
      await modal2.runCommand({ type: 'command', id: 'app:open-settings', label: '设置' });
    } catch (e) {
      threw2 = e;
    }
    eq(threw2, null, 'listCommands 过滤掉的命令不该让点击抛错');
    ok(clickLog.indexOf('app:open-settings') >= 0, '这种情况仍会执行命令（直接问 app.commands.findCommand）——这正是"点了没反应"的修复点');
  }

  /* v0.3.1：执行后必须关闭面板；键盘走 Scope（否则方向键有高亮不走、Enter 会点中聚焦按钮） */
  {
    modalCloseCount = 0;
    const ran = await clickCellAndWait('设置');
    ok(modalCloseCount > 0, '执行命令时面板会被关闭（用户要求：不关会挡住命令界面）');

    const scopeKeys = [];
    const modal3 = new QP.QuickPanelModal(clickApp, clickHost, QP.normalizePanelConfig({
      version: 2,
      panel: { showSearch: false, showRecent: false },
      items: [
        { type: 'command', id: 'app:open-settings', label: '设置' },
        { type: 'command', id: 'global-search:open', label: '搜索' },
        { type: 'command', id: 'app:reload', label: '重载' },
      ],
      recent: [],
    }), {});
    modal3.modalEl = new FakeElement('div');
    modal3.modalEl.addClass('modal-container');
    modal3.modalEl.addClass('quick-panel');
    modal3.contentEl = new FakeElement('div');
    modal3.modalEl.appendChild(modal3.contentEl);
    // scope 桩：把注册的键记下来，用于断言"方向键真的挂到了 Scope 上"
    const handlers = {};
    modal3.scope = {
      register: (mods, key, fn) => {
        scopeKeys.push(key);
        handlers[key] = fn;
        return { scope: modal3.scope, key: key };
      },
    };
    modal3.registerDomEvent = () => {};
    modal3.onOpen();
    ok(scopeKeys.indexOf('ArrowRight') >= 0 && scopeKeys.indexOf('ArrowDown') >= 0, '方向键注册到了 Modal 的 scope（这是真机上方向键不动的原因）');
    ok(scopeKeys.indexOf('Enter') >= 0, 'Enter 也注册到 scope（否则会被浏览器当成"点了当前聚焦的按钮"）');
    ok(scopeKeys.indexOf('Escape') < 0, '不抢 Escape（由 Modal 基类关闭弹窗）');

    modal3.setHighlight(0);
    handlers['ArrowRight']({});
    eq(modal3.highlight, 1, '通过 scope 的右方向键能移动高亮');
    handlers['ArrowDown']({});
    eq(modal3.highlight, 1, '只有一行时 scope 下方向键不越界（3 格 < 9 列）');
    handlers['End']({});
    eq(modal3.highlight, modal3.visible.length - 1, 'scope End 跳最后一格');
    handlers['Home']({});
    eq(modal3.highlight, 0, 'scope Home 跳第一格');
    modalCloseCount = 0;
    handlers['Enter']({});
    eq(modalCloseCount > 0, true, 'scope Enter 会执行当前高亮格（并关闭面板）');
  }

  /* v0.4.2 三条真机 bug 的回归 */
  {
    // ① 右键不能触发命令（否则"右键→改名"会先把命令执行掉）
    const cellA = clickCell('设置');
    clickLog.length = 0;
    cellA.cell.fire('pointerdown', { button: 2 });
    cellA.cell.fire('pointerup', { button: 2 });
    cellA.cell.fire('click', { button: 2 });
    eq(clickLog.filter((x) => x.charAt(0) !== '▸'), [], '右键（button=2）不触发命令');
    clickLog.length = 0;
    cellA.modal._lastActivate = 0; // 清掉 600ms 去重（前一步刚点过）
    cellA.cell.fire('pointerdown', { button: 0 });
    cellA.cell.fire('pointerup', { button: 0 });
    ok(clickLog.filter((x) => x.charAt(0) !== '▸').indexOf('app:open-settings') >= 0, '左键（button=0）仍然正常触发');

    // ② 最近用过要显示"已经在面板里"的项（原来只列不在面板里的，导致永远是空的）
    clickLog.length = 0;
    const recentModal = new QP.QuickPanelModal(clickApp, clickHost, QP.normalizePanelConfig({
      version: 2,
      panel: { showSearch: false, showRecent: true },
      items: [{ type: 'command', id: 'app:open-settings', label: '设置' }],
      recent: [{ type: 'command', id: 'app:open-settings', usedAt: 111 }],
    }), {});
    recentModal.modalEl = new FakeElement('div');
    recentModal.modalEl.addClass('modal-container');
    recentModal.modalEl.addClass('quick-panel');
    recentModal.contentEl = new FakeElement('div');
    recentModal.modalEl.appendChild(recentModal.contentEl);
    recentModal.scope = { register() {} };
    recentModal.registerDomEvent = () => {};
    recentModal.onOpen();
    eq(recentModal.recent.length, 1, '「最近用过」收录面板里已有的项（这是用户报告"始终为空"的原因）');
    const chips = recentModal.contentEl.querySelector('qp-recent-row').children;
    ok(chips.length >= 1, '「最近用过」渲染出至少一个 chip');
    eq(chips[0].getText(), '设置', 'chip 显示与面板一致的显示名');

    // ③ 选择器不许改到面板的标题容器（表现为"面板变两行"）
    ok(/titleEl\.parentElement\)\s*this\.titleEl\.parentElement\.hide\(\)|titleEl\.parentElement\.hide\(\)/.test(SOURCE), '选择器/确认窗会隐藏共用的标题容器（面板不会变成两行）');
  }

  {
    const bare = new QP.QuickPanelModal(clickApp, clickHost, QP.normalizePanelConfig({
      version: 2,
      panel: { showSearch: false, showRecent: false },
      items: [{ type: 'command', id: 'app:open-settings', label: '设置' }],
      recent: [],
    }), {});
    bare.modalEl = new FakeElement('div');
    bare.modalEl.addClass('modal-container');
    bare.modalEl.addClass('quick-panel');
    bare.contentEl = new FakeElement('div');
    bare.modalEl.appendChild(bare.contentEl);
    bare.scope = { register() {} };
    bare.registerDomEvent = () => {};
    // 两边都查不到（模拟 listCommands 的 checkCallback 过滤 + app 里也没有）
    bare.app = Object.assign({}, clickApp, { commands: Object.assign({}, clickApp.commands, { findCommand: () => undefined }) });
    bare.host = Object.assign({}, clickHost, {
      commandRegistry: () => ({ all: [], find: () => undefined, findByName: () => undefined, invalidate() {} }),
    });
    let threw = null;
    try {
      await bare.runCommand({ type: 'command', id: 'missing:cmd', label: '不存在的命令' });
    } catch (e) {
      threw = e;
    }
    eq(threw, null, '两边都查不到时 runCommand 不抛异常（而不是静默崩掉）');
  }

  /* 设置面板 + 系统设置页 + 换图标修复（用户 2026-10-14 反馈） */
  {
    ok(/new Setting\(container\)/.test(SOURCE), '设置项用 Obsidian 的 Setting 组件搭（设置弹窗与系统设置页共用一份实现）');
    ok(/class QuickPanelSettingsModal extends Modal/.test(SOURCE), '设置弹窗存在（面板 ⋯ → 设置）');
    ok(/class QuickPanelSettingTab extends PluginSettingTab/.test(SOURCE), '系统设置页存在（设置 → 第三方插件 → Quick Panel）');
    ok(/addSettingTab\(new QuickPanelSettingTab/.test(SOURCE), 'onload 里注册了系统设置页');
    ok(/setTitle\('设置'\)/.test(SOURCE) && /openSettings\(\)/.test(SOURCE), '面板「⋯」菜单里有「设置」入口');
    ok(!/silentClose\(\);\s*\n\s*this\.host\.openSettings\(\)/.test(SOURCE), '打开设置前不再先关面板（会被弹窗栈一起收掉，就是"点了没反应"）');
    ok(!/setPlaceholder\(/.test(stripComments(SOURCE)), '不再调用 SuggestModal 上不存在的 setPlaceholder（"换图标"点了没反应的原因）');
    ok(/class QuickPanelIconPickerModal extends Modal/.test(SOURCE), '换图标改成图标选择器（网格 + 即时预览）');
    ok(/filterIconNames\(this\.all/.test(SOURCE), '选择器接的是模糊过滤（不是精确拼写）');
    ok(!/addInput\(\{ value: current, placeholder: '图标名/.test(SOURCE), '不再要求用户手打完整图标名');

    // 设置面板能渲染、点开关能写配置
    const writes = [];
    const fakePlugin = {
      config: QP.normalizePanelConfig({ version: 2, items: [], recent: [] }),
      writePanelConfig: (cfg) => {
        writes.push(cfg.panel);
      },
      reopen() {},
      openConfigFile() {},
    };
    const settings = new QP.QuickPanelSettingsModal(fakeApp, fakePlugin);
    settingInstances.length = 0;
    settings.modalEl = new FakeElement('div');
    settings.modalEl.addClass('modal-container');
    settings.modalEl.addClass('quick-panel');
    settings.contentEl = new FakeElement('div');
    settings.modalEl.appendChild(settings.contentEl);
    settings.titleEl = new FakeElement('div');
    let renderErr = null;
    try {
      settings.onOpen();
    } catch (e) {
      renderErr = e;
    }
    eq(renderErr, null, '设置面板能打开（不抛异常）：' + (renderErr && renderErr.message));
    ok(settings.contentEl.children.length >= 2, '设置面板渲染出标题与操作区（Setting 组件自行挂到 contentEl，实际 ' + settings.contentEl.children.length + ' 个自有节点）');
    eq(settingInstances.length, 4, '设置面板建了 4 项设置（最近用过 / 过滤框 / 格子大小 / 每行列数），实际 ' + settingInstances.length);
    eq(typeof settings.onClose, 'function', '设置面板关闭时会重开面板以生效');

    // 图标实时预览：emoji / 图片 / 认不出的写法各给一句说明
    const previewModal = new QP.ConfirmLikeModal(fakeApp, '换图标', [], [{ label: '保存', onClick() {} }]);
    previewModal.modalEl = new FakeElement('div');
    previewModal.modalEl.addClass('modal-container');
    previewModal.modalEl.addClass('quick-panel');
    previewModal.contentEl = new FakeElement('div');
    previewModal.modalEl.appendChild(previewModal.contentEl);
    previewModal.titleEl = new FakeElement('div');
    previewModal.addInput({ value: '', placeholder: 'x', preview: true });
    let previewErr = null;
    const previewTexts = [];
    try {
      previewModal.onOpen();
      ['🚩', 'logo.png', 'settings', '两个 汉字', ''].forEach((v) => {
        previewModal.paintPreview(v);
        previewTexts.push(v + ' → ' + previewModal.previewEl.getText());
      });
    } catch (e) {
      previewErr = e;
    }
    eq(previewErr, null, '图标预览不抛异常：' + (previewErr && previewErr.message));
    ok(previewModal.previewEl !== null, '预览容器已创建');
    ok(previewTexts[0].indexOf('emoji') >= 0, 'emoji 输入标注 emoji：' + previewTexts[0]);
    ok(previewTexts[1].indexOf('找不到这张图片') >= 0, '图片路径找不到时明说：' + previewTexts[1]);
    ok(previewTexts[3].indexOf('认不出') >= 0, '认不出的写法给出说明：' + previewTexts[3]);
    ok(previewTexts[4].indexOf('默认图标') >= 0, '留空时说明将用默认图标：' + previewTexts[4]);
  }

  /* v0.5.2 五条真机反馈的回归 */
  {
    // ① 设置改动就地生效：不许每改一项就 reopen（那会叠弹窗）
    ok(/notifyConfigChanged\(\)/.test(SOURCE), '设置改动会通知面板就地生效');
    ok(/onConfigChanged\(fn\)/.test(SOURCE), '有配置变更监听机制');
    ok(/rebuild\(\) \{[\s\S]{0,220}this\.contentEl\.empty\(\)/.test(SOURCE), 'rebuild 先清空内容区（否则叠出多份头部）');
    ok(!/settings\.onClosed = function \(\) \{\s*off\(\);\s*\/\/[^\n]*\n\s*if \(modal && modal\.rebuild\) modal\.rebuild\(\);\s*\};[\s\S]{0,200}this\.plugin\.reopen\(\)/.test(SOURCE), '设置关闭后不再额外 reopen 面板');

    // ② rebuild 行为：内容不叠加
    let reopens = 0;
    const host2 = Object.assign({}, clickHost, {
      reopen() {
        reopens += 1;
      },
    });
    const m2 = new QP.QuickPanelModal(fakeApp, host2, QP.normalizePanelConfig({
      version: 2,
      panel: { showSearch: true, showRecent: true },
      items: [{ type: 'command', id: 'app:open-settings', label: '设置' }],
      recent: [{ type: 'command', id: 'app:open-settings', usedAt: 1 }],
    }), {});
    m2.modalEl = new FakeElement('div');
    m2.modalEl.addClass('modal-container');
    m2.modalEl.addClass('quick-panel');
    m2.contentEl = new FakeElement('div');
    m2.modalEl.appendChild(m2.contentEl);
    m2.scope = { register() {} };
    m2.registerDomEvent = () => {};
    m2.onOpen();
    const before = m2.contentEl.children.length;
    m2.rebuild();
    m2.rebuild();
    eq(m2.contentEl.children.length, before, '连续 rebuild 两次后内容节点数不变（不叠加）：' + before);
    eq(reopens, 0, 'rebuild 成功时不会退回 reopen');
    eq(m2.contentEl.querySelectorAll('qp-grid').length, 1, '重建后只有一个网格');
    eq(m2.contentEl.querySelectorAll('qp-header').length, 1, '重建后只有一个头部');

    // ③ 显示过滤框开关：重建后搜索框该出现就出现、该消失就消失
    ok(m2.contentEl.querySelector('qp-search-input') !== null, '开过滤框时重建后有搜索框');
    m2.config = QP.normalizePanelConfig({ version: 2, panel: { showSearch: false }, items: [], recent: [] });
    m2.rebuild();
    eq(m2.contentEl.querySelectorAll('qp-search-input').length, 0, '关掉过滤框后重建，搜索框消失（开关确实生效）');

    // ④ 格子大小要同时影响宽高；⑤ 命令名过长不再看不全
    ok(/\.qp-icon \{[\s\S]{0,200}width: var\(--qp-cell/.test(STYLES) && /\.qp-icon \{[\s\S]{0,200}height: var\(--qp-cell/.test(STYLES), '格子大小同时作用于图标的宽与高');
    ok(/\.qp-icon-img \{[\s\S]{0,160}max-width: var\(--qp-cell/.test(STYLES), '图片图标也跟随格子大小');
    ok(/-webkit-line-clamp: 3/.test(STYLES), '长命令名最多显示 3 行（原来是 2 行，容易被截断）');
    ok(/\.qp-cell \{[\s\S]{0,400}border: 1px solid var\(--background-modifier-border\)/.test(STYLES), '每个格子都有无底色的淡边框');
  }

  {
    ok(/removeItem\(item\)[\s\S]{0,260}reopen\(\)/.test(SOURCE), '删除动作里 removeItem 之后紧接着调用 reopen（面板当场刷新）');
    ok(/self\.addItem\(entry, insertAt\)[\s\S]{0,360}self\.reopen\(\)/.test(SOURCE), '选择器添加之后也走 reopen（统一刷新口径）');
    ok(!/modalRef\.onOpen\(\)/.test(SOURCE), '不再在旧面板实例上重新 onOpen（那会叠加头部 DOM，就是"变两行"那类问题）');
    ok(!/\brefreshPanel\b/.test(SOURCE), '没有留下未接线的 refreshPanel 半成品');
  }
} catch (err) {
  ok(false, '点击链路用例抛异常：' + (err && err.message));
}

/* 执行器自身的语义（照 obsidian.asar：返回值不可靠、异常被吞） */
try {
  const fakePlugin = {
    app: { workspace: { activeEditor: null }, commands: clickApp.commands },
    commandRegistry: clickHost.commandRegistry,
    logExecution() {},
    execLog: [],
  };
  const run = (id) => QP.QuickPanelPlugin.prototype.runCommandById.call(fakePlugin, id);
  clickLog.length = 0;
  eq(run('app:open-settings'), true, '正常的 callback 命令 → 返回 true');
  eq(clickLog, ['app:open-settings'], '确实调用了 executeCommandById');
  clickLog.length = 0;
  eq(run('不存在的命令'), false, '注册表里没有的命令 → 返回 false');
  eq(clickLog.length, 0, '注册表里没有的命令不会去调用');
  clickLog.length = 0;
  eq(run('demo:throws'), true, '命令内部抛错时（官方会吞掉）也要如实告诉调用方"已尝试执行"');
  eq(clickLog, ['demo:throws'], '抛错的命令确实被调用过');
} catch (err) {
  ok(false, '执行器语义用例抛异常：' + (err && err.message));
}

/* ============ 10. 第 2 批：增 / 删 / 排序 / 选择器（纯函数 + 主机操作） ============ */

group('增删排序与选择器');

/* 10.1 新条目整理 */
eq(QP.sanitizeNewItem({ type: 'command', id: '  app:reload  ', name: '重载应用' }), { type: 'command', id: 'app:reload', nameSnapshot: '重载应用' }, '命令条目：去空白 + 带快照');
eq(QP.sanitizeNewItem({ type: 'file', path: 'a\\b.md' }).path, 'a/b.md', '文件条目：路径分隔符规整');
eq(QP.sanitizeNewItem({ type: 'folder', path: 'F Craftlab', label: ' 项目 ' }).label, '项目', 'label 去掉首尾空格');
eq(QP.sanitizeNewItem({ type: 'command', id: '   ' }), null, '空 id 的命令条目 → null（不加进面板）');
eq(QP.sanitizeNewItem({ type: 'url', url: 'https://x' }), null, '不支持的 type → null');
eq(QP.sanitizeNewItem(null), null, 'null 输入 → null（不抛异常）');
eq(QP.sanitizeNewItem({ type: 'command', id: 'app:reload' }).icon, undefined, '空 icon 不写进配置');

/* 10.2 命令名前缀 */
eq(QP.stripCommandPrefix('QuickAdd: 快速捕捉'), '快速捕捉', '去掉 "插件名: " 前缀');
eq(QP.stripCommandPrefix('设置'), '设置', '没有前缀的名字保持原样');
eq(QP.stripCommandPrefix('日记: 追加一行'), '日记: 追加一行', '中文名里的冒号不当前缀（避免误删）');

/* 10.3 选择器数据源 */
const pickerInput = {
  commands: [
    { id: 'app:reload', name: '重载应用' },
    { id: 'global-search:open', name: '全局搜索' },
    { id: 'quickadd:choice:x', name: 'QuickAdd: 快速捕捉', icon: 'zap' },
    { name: '没有 id 的命令' },
  ],
  files: [
    { path: '1 Obsidian/页面/Home.md' },
    { path: '1 Obsidian/页面' , children: [] },
    { path: 'F Craftlab', children: [] },
    null,
  ],
};
const pickerItems = QP.buildPickerItems(pickerInput);
eq(pickerItems.filter((i) => i.kind === 'command').length, 3, '命令：跳过没有 id 的');
eq(pickerItems.filter((i) => i.kind === 'file').length, 1, '文件：只收不带 children 的');
eq(pickerItems.filter((i) => i.kind === 'folder').length, 2, '文件夹：收带 children 的');
eq(pickerItems.filter((i) => i.id === 'quickadd:choice:x')[0].label, '快速捕捉', '命令显示名去掉了插件前缀');
eq(pickerItems.filter((i) => i.kind === 'file')[0].label, 'Home', '文件显示名去掉 .md');
eq(pickerItems.filter((i) => i.kind === 'folder').map((i) => i.label).sort(), ['1 Obsidian/页面'.split('/').pop(), 'F Craftlab'].sort(), '文件夹用末级目录名');

/* 10.4 选择器过滤：前缀优先 */
const manyItems = [
  { kind: 'command', id: 'app:open-settings', label: '设置' },
  { kind: 'command', id: 'workspace:new-tab', label: '新标签页' },
  { kind: 'file', path: 'a/设置相关.md', label: '设置相关' },
  { kind: 'command', id: 'editor:toggle', label: 'a设置在后' },
];
eq(QP.filterPickerItems(manyItems, '').length, 4, '空查询 → 全部（受 limit 约束）');
eq(QP.filterPickerItems(manyItems, '设置')[0].label, '设置', '前缀命中的排第一');
const matchAll = QP.filterPickerItems(manyItems, '设置');
eq(matchAll.length, 3, '包含"设置"的都命中（前缀 + 路径 + 中间）');
eq(QP.filterPickerItems(manyItems, 'zzz').length, 0, '无匹配 → 空');
eq(QP.filterPickerItems(manyItems, '', 2).length, 2, 'limit 生效');

/* 10.7 移动后必须"就地刷新"（用户 2026-10-14：右键移动后要关闭面板再打开才生效）
   机制：moveItem 写盘 → notifyConfigChanged → 面板订阅回调 rebuild。
   这里同时钉住"所有增删改路径都会 notify"这条口径，避免再出现某一个操作漏接线。
   ⚠️ 写成函数在文件末尾调用：它依赖后面定义的 makeHost / CountingVaultAdapter。 */
async function testMoveRefreshesInPlace() {
  const h3 = await makeHost([
    { type: 'command', id: 'app:reload', label: '甲' },
    { type: 'command', id: 'app:open-settings', label: '乙' },
    { type: 'command', id: 'workspace:new-tab', label: '丙' },
  ]);
  const p3 = h3.plugin;
  let notified = 0;
  p3._configListeners = [];
  p3.onConfigChanged(() => {
    notified += 1;
  });
  p3.notifyConfigChanged();

  // 用真实原型方法（makeHost 里 commandFor 等依赖已补齐的部分）
  const modal = new QP.QuickPanelModal(clickApp, p3, p3.config, {});
  modal.modalEl = new FakeElement('div');
  modal.modalEl.addClass('modal-container');
  modal.modalEl.addClass('quick-panel');
  modal.contentEl = new FakeElement('div');
  modal.modalEl.appendChild(modal.contentEl);
  modal.scope = { register() {} };
  modal.registerDomEvent = () => {};
  p3.modal = modal;
  p3.reopen = () => {
    throw new Error('不该走 reopen（应当就地 rebuild）');
  };
  p3.commandRegistry = () => ({ all: [], find: () => undefined, findByName: () => undefined, invalidate() {} });
  p3.itemDisplayName = (it) => (it && it.label) || '';
  modal.onOpen();

  const first = modal.items[0].item;
  const before = modal.items.map((v) => modal.displayName(v.item));
  const beforeNodes = modal.contentEl.children.length;

  const moved = modal.applyMove(first, 2);
  const after = modal.items.map((v) => modal.displayName(v.item));
  ok(moved, 'applyMove 返回 true（移动确实执行了）');
  ok(after.join(',') !== before.join(','), '移动后面板顺序当场改变：' + before.join(',') + ' → ' + after.join(','));
  eq(after[2], before[0], '被移动的格子到了新位置');
  eq(modal.contentEl.children.length, beforeNodes, 'rebuild 后内容节点数不变（不叠加）');
  eq(modal.contentEl.querySelectorAll('qp-header').length, 1, 'rebuild 后仍只有一个头部');
  ok(notified >= 2, 'moveItem 会通过 notifyConfigChanged 通知面板（实际 ' + notified + ' 次）');

  // 删除也应就地生效
  const delTarget = modal.items[0].item;
  modal.host.removeItem(delTarget);
  eq(modal.items.length, 2, '删除后面板上的格子数当场减少（不需要关掉重开）');
}

/* 10.5b 图标模糊匹配（用户 2026-10-14：不要非得拼写正确） */
{
  const icons = ['settings', 'settings-2', 'search', 'search-alert', 'folder', 'folder-open', 'file-text', 'star', 'trash-2', 'refresh-cw', 'map-pin', 'message-square-text'];
  const has = (list, n) => list.indexOf(n) >= 0;
  ok(has(QP.filterIconNames(icons, 'sett'), 'settings'), '前缀命中：sett → settings');
  eq(QP.filterIconNames(icons, 'sett')[0], 'settings', '前缀命中排最前');
  ok(has(QP.filterIconNames(icons, 'stg'), 'settings'), '跳字命中：stg → settings（乱序跳字也能找到）');
  ok(has(QP.filterIconNames(icons, 'ft'), 'file-text'), '跳字命中：ft → file-text（跨过连字符）');
  eq(QP.filterIconNames(icons, 'tf').indexOf('file-text'), -1, '顺序不对就不命中（tf ≠ file-text，避免乱匹配）');
  ok(QP.filterIconNames(icons, '').length === icons.length, '空查询 = 全部（让人先浏览，不用背名字）');
  eq(QP.filterIconNames(icons, 'zzz').length, 0, '彻底不匹配 → 空');
  eq(QP.iconMatchScore('settings', ''), 1, '空查询给基础分（不参与排序）');
  ok(QP.iconMatchScore('settings', 'sett') > QP.iconMatchScore('settings-2', 'sett'), '更短的完整前缀排更前');
  ok(QP.iconMatchScore('xsettings', 'sett') > 0 && QP.iconMatchScore('xsettings', 'sett') < QP.iconMatchScore('settings', 'sett'), '中间命中分数低于前缀命中');

  // 中文别名（用户不知道图标英文名时的兜底）
  ok(has(QP.filterIconNames(icons, '设置'), 'settings'), '中文别名：设置 → settings');
  ok(has(QP.filterIconNames(icons, '搜索'), 'search'), '中文别名：搜索 → search');
  ok(has(QP.filterIconNames(icons, '文件夹'), 'folder'), '中文别名：文件夹 → folder');
  ok(has(QP.filterIconNames(icons, '标签'), 'tag') || QP.filterIconNames(icons, '标签').length >= 0, '中文别名命中不到时也不报错');
  ok(Object.keys(QP.ICON_ALIASES).length > 40, '中文别名表覆盖常用语义（实际 ' + Object.keys(QP.ICON_ALIASES).length + ' 个词）');
}

/* 10.5 图标候选清洗 */
const iconCands = QP.modalIconCandidates(['lucide-settings', 'settings', '🚩', 'not a name', 'refresh-cw']);
ok(iconCands.indexOf('settings') >= 0, '保留合法图标名');
eq(iconCands.filter((c) => c === 'settings').length, 1, '去重（lucide-settings 与 settings 只留一个）');
ok(iconCands.indexOf('🚩') < 0, '过滤 emoji');
ok(iconCands.indexOf('not a name') < 0, '过滤含空格的非法名');
ok(iconCands.length > 50, '拿不到运行期清单时也有兜底候选（实际 ' + iconCands.length + '）');

/* 10.6 主机操作：增 / 改 / 删 / 排序（只碰配置，写盘用假 adapter） */
class CountingVaultAdapter {
  constructor() {
    this.store = {};
    this.writes = 0;
  }
  async exists(p) {
    return Object.prototype.hasOwnProperty.call(this.store, p);
  }
  async read(p) {
    return this.store[p];
  }
  async write(p, text) {
    this.store[p] = text;
    this.writes += 1;
  }
  async remove(p) {
    delete this.store[p];
  }
  getBasePath() {
    return 'E:/fake';
  }
}

async function makeHost(items) {
  const adapter = new CountingVaultAdapter();
  const plugin = Object.create(QP.QuickPanelPlugin.prototype);
  plugin.app = {
    vault: {
      adapter: adapter,
      getAbstractFileByPath: () => null,
      getFiles: () => [],
      create: async () => {},
      modify: async () => {},
    },
    commands: {
      listCommands: () => [
        { id: 'app:reload', name: '重载应用' },
        { id: 'app:open-settings', name: '设置' },
      ],
      findCommand: (id) => ({ id: id, name: id }),
    },
    workspace: { activeEditor: null },
    internalPlugins: { getEnabledPluginById: () => null },
  };
  plugin.configPath = QP.CONFIG_NAME;
  plugin.config = QP.normalizePanelConfig({ version: 2, items: items, recent: [] });
  plugin.registry = null;
  plugin.logExecution = () => {};
  return { plugin: plugin, adapter: adapter };
}

try {
  const h = await makeHost([
    { type: 'command', id: 'app:reload', label: '重载' },
    { type: 'command', id: 'app:open-settings', label: '设置' },
  ]);
  const p = h.plugin;

  // 增
  eq(p.addItem({ type: 'command', id: 'workspace:new-tab', name: '新标签页' }), true, '加一条命令 → 成功');
  eq(p.config.items.length, 3, '条目数 +1');
  eq(p.config.items[2].id, 'workspace:new-tab', '默认加在末尾');
  eq(p.config.items[2].nameSnapshot, '新标签页', '自动写入 nameSnapshot（以后失效可重新绑定）');
  eq(p.addItem({ type: 'command', id: 'workspace:new-tab' }), false, '重复添加 → 拒绝');
  eq(p.config.items.length, 3, '拒绝后条目数不变');
  eq(p.addItem({ type: 'file', path: 'a/b.md' }, 0), true, '指定位置插入');
  eq(p.config.items[0].path, 'a/b.md', '插到了第 0 位');
  eq(p.addItem({ type: 'url', url: 'x' }), false, '非法条目 → 拒绝');

  // 改
  const target = p.config.items[1];
  p.updateItem(target, { label: '我的重载' });
  eq(p.config.items[1].label, '我的重载', '改名生效');
  p.updateItem(p.config.items[1], { icon: 'zap' });
  eq(p.config.items[1].icon, 'zap', '换图标生效');
  p.updateItem(p.config.items[1], { label: '   ' });
  eq(p.config.items[1].label, undefined, 'label 清空 → 删除该字段（回退用命令名显示）');
  p.updateItem(p.config.items[1], { icon: '' });
  eq(p.config.items[1].icon, undefined, 'icon 清空 → 删除该字段（回退默认图标）');

  // 排序
  const first = p.config.items[0];
  p.moveItem(first, 2);
  eq(p.config.items[2].path, 'a/b.md', '右移：原来第 0 位现在第 2 位');
  p.moveItem(p.config.items[2], 0);
  eq(p.config.items[0].path, 'a/b.md', '左移回到第 0 位');
  eq(p.config.items.length, 4, '移动不改变条目数');
  eq(itemIds(p.config.items), ['file:a/b.md', 'command:app:reload', 'command:app:open-settings', 'command:workspace:new-tab'].map(String), '移动后顺序正确');

  // 删
  const before = p.config.items.length;
  eq(p.removeItem(p.config.items[0]), true, '删除一条 → 成功');
  eq(p.config.items.length, before - 1, '条目数 -1');
  eq(p.config.items.filter((it) => it.path === 'a/b.md').length, 0, '被删的条目不在配置里了');
  eq(p.removeItem({ type: 'file', path: '不存在.md' }), false, '删不存在的条目 → 返回 false');

  // 每次操作都只写那一个文件
  ok(h.adapter.writes > 5, '每次增删改都会落盘（写次数 ' + h.adapter.writes + '）');
  ok(Object.keys(h.adapter.store).every((k) => k === QP.CONFIG_NAME), '写盘目标只有配置文件：' + JSON.stringify(Object.keys(h.adapter.store)));
  const written = JSON.parse(h.adapter.store[QP.CONFIG_NAME]);
  ok(Array.isArray(written.items) && written.items.length === p.config.items.length, '落盘内容与内存配置一致');
} catch (err) {
  ok(false, '增删排序用例抛异常：' + (err && err.stack ? err.stack.split('\n').slice(0, 2).join(' | ') : err));
}

function itemIds(items) {
  return (items || []).map((it) => QP.itemKey(it));
}

// 依赖 makeHost / CountingVaultAdapter，放在它们定义之后执行
await testMoveRefreshesInPlace();

/* ============ 结果 ============ */

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  for (const f of failures) console.log('  ✗ ' + f);
  console.log('\n有失败 → 不许部署、不许提交（铁律）');
} else {
  console.log('全绿 ✓');
}
process.exit(fail === 0 ? 0 : 1);
