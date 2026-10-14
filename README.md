# Quick Panel

An icon grid that one hotkey away — pin the commands and notes you actually use onto a panel that appears where your mouse is, so you don't have to memorise hotkeys or type search queries.

> Status: **v0.4.0 — batch 2 (add / edit / reorder + recent)**. Working today: the panel, keyboard/mouse execution, icons from three sources, live config file, broken-item detection, **add tiles from inside the panel**, **right-click editing**, **the "recently used" row**. Coming next: import/export for multi-machine merging.
>
> **v0.4.0 — you can now build the panel from inside the panel.**
> * **Add**: the `+` button in the header (or a tile's right-click → *insert after this tile*) opens a picker with **all commands + your notes + your folders**; type to filter, arrows to select, Enter to add. It resolves commands through `app.commands.findCommand`-backed full table, so context-dependent commands can be added too. The tile appears immediately — the panel is not closed, and the JSON is written right away.
> * **Edit**: right-click a tile → **rename** / **change icon** (with live suggestions from the full Lucide set via `getIconIds()`, or type an emoji / an in-vault image path) / **move left** / **move right** / **insert after** / **delete** (with confirmation). Every change is written to `快捷面板.json` immediately and the panel re-renders in place.
> * **Recent**: the **「最近用过」row sits directly under the grid** (labels + icons, click to run). It only lists items that are *not* already on the panel, so it is the "long tail" of things you use occasionally. Toggle it with `panel.showRecent` (or ⋯ → the toggle item).
> * Deleting a tile removes it **from the panel only** — no note, file or plugin is touched.
>
> **v0.3.1** fixed keyboard handling (keys must go through Obsidian's `Scope`; now arrows/Enter/Home/End work, and the panel closes as soon as a tile runs). **v0.3.0** fixed the root cause of "clicking does nothing" (`listCommands()` is filtered by `checkCallback`; commands are now resolved via `findCommand`). **v0.1.x** history: pure-CSS centering, no ×, three-way diagnostic writes, config rename to **快捷面板**.

## What it is

If you have ever used the "quick access panel" in SolidWorks, this is the same habit for Obsidian: press one key, the panel opens, click the command you want. No memorising, no allocating hotkeys, no typing.

**You cannot register a system-wide global hotkey from an Obsidian plugin** — `globalShortcut` lives in Electron's main process, and plugins run in the renderer. So this plugin does the next best thing: **one key inside the Obsidian window** (you bind it yourself) plus a ribbon icon.

## Features (v0.1.1)

- **Icon grid panel**, opened by a command or the ribbon icon, **centered in the window**.
- **Columns adapt to the window width** (2–12), computed by a pure function, never hard-coded.
- **Three icon sources per tile**: a Lucide icon name, an emoji, or an in-vault image (`logo.png`). Unrecognised values fall back to a default icon *and* say why in the tooltip.
- **Tiles are Obsidian commands, files, or folders** — the panel is only a launcher; it never edits your notes.
- **Keyboard everywhere**: arrows to move, `Enter` to run, `Esc` to close, type anything to filter (no need to click the search box first), `Home`/`End` to jump.
- **Failures are never silent**: a command that has disappeared is greyed out and offers a one-click re-bind to a same-named command; `executeCommandById` returning `false` raises a Notice explaining that the command is currently unavailable; a corrupt config file is reported and **left untouched**.
- **"Recently used" row** at the bottom — the item you just ran moves to the front (or into the panel, if it was only in the recent list).
- **Startup cost is zero by design**: `onload` reads the config once, registers one command and one ribbon icon. The command table is only resolved when you open the panel.

## Install

1. Copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/quick-panel/`.
2. Obsidian → Settings → Community plugins → enable **Quick Panel**.
3. (Optional) Settings → Hotkeys → search "快捷面板" → bind **Ctrl+Alt+Space**.

`tools/deploy.ps1` does step 1 for you and verifies hash equality afterwards:

```powershell
powershell -ExecutionPolicy Bypass -File tools\deploy.ps1 -Vault E:\Dnotes
```

## Configuration

The panel reads and writes exactly one file: **`<vault root>/快捷面板.json`**. It is created on first run, it is plain readable JSON, and it is the single source of truth — the plugin's own `data.json` only stores UI state. Delete the plugin and the file is still there and still meaningful.

```json
{
  "version": 1,
  "panel": { "columns": "auto", "showRecent": true, "iconSize": 40, "showSearch": true },
  "items": [
    { "type": "command", "id": "app:open-settings", "label": "设置", "icon": "settings" },
    { "type": "command", "id": "quickadd:choice:ed7d5905", "label": "快速捕捉", "icon": "zap", "nameSnapshot": "快速捕捉" },
    { "type": "file", "path": "1 Obsidian/页面/Home.md", "label": "首页", "icon": "home" },
    { "type": "folder", "path": "F Craftlab", "label": "项目", "icon": "folder" }
  ],
  "recent": [{ "type": "command", "id": "app:reload", "usedAt": 1760000000000 }]
}
```

| Field | Meaning |
|---|---|
| `type` | `command` / `file` / `folder` |
| `id` / `path` | Command id, or a **vault-relative** path (never an absolute one — it would break sync) |
| `label` | What the tile shows; empty falls back to the command name or the file name |
| `icon` | Lucide name, emoji, or an in-vault image path; empty uses the default icon |
| `nameSnapshot` | The command name as it was when you added it — used to offer a re-bind after a plugin update |
| `level` | Optional heading level (2–6) — stored for the upcoming "insert heading into the current note" action |
| `panel.columns` | `"auto"` or an integer 2–12 |
| `panel.iconSize` | 20–96 px |
| `recent` | Maintained automatically; `pushRecent` de-duplicates by id/path and keeps the newest 12 |

Hand-editing the file is fully supported; reopen the panel and the change is live.

## Behaviour guarantees

1. **One write target.** Every write goes to `<vault root>/快捷面板.json`. The plugin never touches `.obsidian`, never creates or deletes files, and never modifies a note.
2. **A corrupt config is never overwritten.** Bad JSON is reported, the original file is left byte-for-byte intact, and the panel starts empty.
3. **Nothing happens by itself.** No timers, no background scans, no file watchers, no network. Actions run when you click.
4. **Uninstalling loses nothing.** Your configuration is ordinary JSON; the tiles point at Obsidian's own commands and your own files.

## Tests

```bash
node tools/test.mjs        # 132 assertions, no dependencies, no Obsidian needed
node tools/check-id.mjs    # verifies the plugin id is not taken in the community registry
```

`tools/test.mjs` covers the pure functions (config normalisation and validation, icon source detection, adaptive column calculation, recent-list de-duplication, broken-item detection, filtering, JSON round-trip and idempotence) **and** asserts startup invariants by reading `main.js` as text: `onload` must not contain `listCommands`, `getFiles`, timers or network calls, and the whole file may contain exactly one write call.

Deployment and commit are gated on that exit code: non-zero means do not ship.

## Troubleshooting

Run **Quick Panel: 导出面板诊断** from the command palette (after opening the panel once). It writes `.quick-panel-diag.txt` to the vault root with the real numbers: viewport size, the modal container / card / `.modal-bg` / grid / first cell rectangles, the computed `display` / `width` / `transform` of each, how many items were resolved, and the last five commands you ran. Delete the file afterwards — it is created only when you run that command.

| Symptom | Likely cause |
|---|---|
| Whole screen dims, panel not visible / a white sliver in a corner | A theme or another plugin overrides `.modal-container` / `.modal` geometry. Run the diagnostic and check `container` and `card` rects |
| Panel opens but stays empty with a status line | The config file has bad rows, or every command id in it is missing (the status line says how many) |
| A tile is greyed out | Its command id no longer exists (plugin disabled/renamed) or its path is gone — right-click the tile for "re-bind" |

## Roadmap

| Batch | Contents | State |
|---|---|---|
| 1 | Panel + execution + icons + config file | **done (0.1.0)** |
| 2 | Add a tile from inside the panel (`/` or `+`, command/file picker, instant write + live re-render); tile context menu (rename / change icon / move / delete) | not started |
| 3 | File & folder tiles polish (open note, reveal in file explorer), JSON export/import for multi-machine merging | partially in place (open / reveal work) |

Out of scope on purpose: system-wide hotkeys, a permanent sidebar panel, shell/script execution, multiple panel pages, URL tiles.

## License

MIT — see [LICENSE](LICENSE).

---

# 快捷面板（中文）

一个快捷键呼出的**图标网格面板**：把你真正在用的命令、笔记、文件夹钉在眼前，不用记快捷键，也不用打字搜索。

> 状态：**v0.4.0 —— 第 2 批（增 / 删 / 排序 + 最近用过）**。现在能用的：面板本体、键盘/鼠标执行、三种图标来源、库内配置实时生效、失效项检测、**面板内即时添加**、**右键编辑格子**、**「最近用过」一行**。再下一批：JSON 导入导出（多机合并）。
>
> **v0.4.0 —— 现在可以直接在面板里搭建面板。**
> * **添加**：头部「＋」（或某个格子右键 →「插到这一格后面」）打开选择器，数据源是**全部命令 + 你的笔记 + 文件夹**；打字过滤、方向键选择、Enter 加入。命令走完整命令表，所以依赖上下文的命令也能加进来。选中后**面板不关、立刻写入 JSON、就地出现新格子**。
> * **编辑**：格子右键 → **改名** / **换图标**（带全量图标名实时建议，也可填 emoji 或库内图片路径）/ **左移** / **右移** / **插到后面** / **删除**（有确认）。每次改动都立即写进 `快捷面板.json`，面板就地重绘。
> * **最近用过**：**「最近用过」一行就在网格下面**（名字 + 图标，点一下即执行）。只列**不在面板里**的项 —— 它是"偶尔用一次"的补充。开关是 `panel.showRecent`（也可用 ⋯ 菜单切换）。
> * 删除格子**只从面板移除**，不动任何笔记、文件或插件。
>
> **v0.3.1** 修好键盘（按键必须先过 Obsidian 的 `Scope`；现在方向键/Enter/Home/End 都可用，且执行后立即关面板）。**v0.3.0** 修掉"点了没反应"的根因（`listCommands()` 按 `checkCallback` 过滤；现在用 `findCommand` 取命令）。**v0.1.x** 历史：纯 CSS 居中、去掉所有 ×、诊断三重落盘、配置改名 **快捷面板**。

## 它是什么

如果你用过 SolidWorks 的"快捷面板"，就是同一个习惯搬到 Obsidian：按一个键，面板出来，点你要的命令。

**Obsidian 插件注册不了系统级全局热键** —— `globalShortcut` 属 Electron 主进程，插件跑在渲染进程。所以本插件做的是次优解：**Obsidian 窗口内一键呼出**（快捷键由你自己绑）+ ribbon 图标入口。

## 现在具备的（v0.1.1）

- **图标网格面板**：命令或 ribbon 图标呼出，**在窗口正中显示**。
- **列数随窗口自适应**（2–12 列），由纯函数算，不写死在 CSS 里。
- **每个格子三种图标来源**：Lucide 名、emoji、库内图片（`logo.png`）；认不出的写法会退回默认图标**并在悬停提示里说明原因**。
- **格子指向 Obsidian 命令 / 笔记 / 文件夹**：面板只负责"启动"，从不改动你的笔记。
- **全程键盘可用**：方向键移动、`Enter` 执行、`Esc` 关闭、直接打字即过滤（不必先点搜索框）、`Home`/`End` 跳首尾。
- **异常一律出声**：命令失效 → 标灰，并提供「一键重新绑定到同名命令」；`executeCommandById` 返回 false → 明确提示当前不可用；配置损坏 → 提示 + **保留原文件** + 空面板起步。
- **底部「最近用过」**：刚执行的项自动前移（不在面板里的会补进来）。
- **启动零开销**：`onload` 只读一次配置 + 注册一条命令 + 一个 ribbon 图标；命令表在**打开面板那一刻**才解析。

## 安装

1. 把 `main.js`、`manifest.json`、`styles.css` 放到 `<库>/.obsidian/plugins/quick-panel/`。
2. Obsidian → 设置 → 第三方插件 → 启用 **Quick Panel**。
3. （可选）设置 → 快捷键 → 搜「快捷面板」→ 绑 **Ctrl+Alt+Space**。

第 1 步可以用脚本代劳，跑完会核对哈希：

```powershell
powershell -ExecutionPolicy Bypass -File tools\deploy.ps1 -Vault E:\Dnotes
```

## 配置

面板只读写一个文件：**`<库根>/快捷面板.json`**。首次运行自动创建，是纯文本 JSON，也是配置的**唯一真源** —— 插件自己的 `data.json` 只存 UI 状态。卸载插件后这个文件仍在、仍然可读。

```json
{
  "version": 1,
  "panel": { "columns": "auto", "showRecent": true, "iconSize": 40, "showSearch": true },
  "items": [
    { "type": "command", "id": "app:open-settings", "label": "设置", "icon": "settings" },
    { "type": "file", "path": "1 Obsidian/页面/Home.md", "label": "首页", "icon": "home" },
    { "type": "folder", "path": "F Craftlab", "label": "项目", "icon": "folder" }
  ],
  "recent": []
}
```

| 字段 | 含义 |
|---|---|
| `type` | `command` / `file` / `folder` |
| `id` / `path` | 命令 id，或**库内相对路径**（不要写绝对路径，那会破坏同步） |
| `label` | 格子显示名；留空则用命令名 / 文件名 |
| `icon` | Lucide 名、emoji 或库内图片路径；留空用默认图标 |
| `nameSnapshot` | 添加时的命令名快照 —— 插件升级后命令改名时，用它提供"重新绑定" |
| `level` | 可选（2–6），为后续"把标题插进当前笔记"预留 |
| `recent` | 自动维护：按 id/path 去重，只留最近 12 条 |

手改这个文件完全支持；改完重新打开面板就生效。

## 行为承诺

1. **只有一个写入对象**：所有写操作都发生在 `<库根>/快捷面板.json`；不碰 `.obsidian`，不新建/删除库内文件，不改任何笔记。
2. **坏配置绝不覆盖**：JSON 损坏时只提示、保留原文件逐字节不变，用空面板起步。
3. **不点不动**：没有定时器、没有后台扫描、没有文件监听、没有联网。
4. **卸载不丢东西**：配置就是普通 JSON，格子指向的仍是 Obsidian 自己的命令和你自己的文件。

## 测试

```bash
node tools/test.mjs        # 132 项断言，零依赖，不需要 Obsidian
node tools/check-id.mjs    # 查插件 id 是否与社区注册表撞名
```

`tools/test.mjs` 覆盖纯函数（配置归一化与校验、图标来源判定、自适应列数、最近记录去重、失效检测、过滤、JSON 往返与幂等），**并直接读 `main.js` 源码**断言启动纪律：`onload` 里不许出现 `listCommands`、`getFiles`、定时器、网络调用，全文件只允许一处写盘调用。

部署与提交以这个退出码为闸门：非 0 就不许发布。

## 路线图

| 批次 | 内容 | 状态 |
|---|---|---|
| 1 | 面板 + 执行 + 图标 + 配置文件 | **完成（0.1.0）** |
| 2 | 面板内即时添加（`/` 或 `+` → 选择器 → 立刻写盘并重绘）；格子右键菜单（改名 / 换图标 / 移动 / 删除） | 未开始 |
| 3 | 文件与文件夹项打磨、JSON 导出导入（多机合并） | 部分已可用（打开 / 定位已实现） |

明确不做：系统级热键、常驻侧栏、执行 shell 或外部程序、多面板分页、网址项。

## 许可

MIT，见 [LICENSE](LICENSE)。
