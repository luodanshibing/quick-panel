/*
 * 图标名守卫：把 main.js 里的兜底候选清单与"本机 Obsidian 真实图标名"逐一核对。
 *
 * 为什么需要它（2026-10-14 实测）：Obsidian 的 setIcon 有一条**别名表**（gear→settings、
 * magnifying-glass→search…），别名能渲染但**不在 getIconIds() 里**；而 getIconIds() 返回的是
 * 带 `lucide-` 前缀的规范名。把别名写进兜底清单，在不同版本上会静默变成"没有图标"。
 * 所以：清单只允许放**真实规范名**，由本工具核对。
 *
 * 用法：node tools/check-icons.mjs [真实名单路径]
 *   真实名单由 tools/extract-icon-names.mjs 从 obsidian.asar 解析得到（1408 个 lucide- 名）。
 * 退出码：0 = 全部可渲染；1 = 有名字不在真实名单里（或清单为空）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FALLBACK_LIST = process.argv[2] || 'E:\\AGI\\DeepseekHarness\\Projects\\2026-10-13_快接面板插件\\icons\\lucide-names-2026-10-13-2340.txt';

const src = readFileSync(join(ROOT, 'main.js'), 'utf8');

if (!existsSync(FALLBACK_LIST)) {
  console.log('找不到真实图标名单：' + FALLBACK_LIST);
  console.log('（这份名单由 tools/extract-icon-names.mjs 从本机 obsidian.asar 解析而来；没有它就无法核对）');
  process.exit(1);
}
const real = new Set(
  readFileSync(FALLBACK_LIST, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.indexOf('lucide-') === 0 ? s.slice(7) : s))
);

const block = (src.match(/const LUCIDE_CANDIDATES = \[([\s\S]*?)\];/) || [, ''])[1];
const listed = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
const used = new Set();
for (const m of src.matchAll(/setIcon\([^,]+,\s*'([^']+)'/g)) used.add(m[1]);
for (const m of src.matchAll(/DEFAULT_ICON = '([^']+)'/)) used.add(m[1]);

console.log('真实图标名（去 lucide- 前缀）：' + real.size);
console.log('兜底清单条目：' + listed.length);
console.log('代码里固定使用的图标名：' + [...used].join(', '));

let bad = 0;
const badListed = listed.filter((n) => !real.has(n));
const badUsed = [...used].filter((n) => !real.has(n) && !/[\u4e00-\u9fa5]/.test(n));

if (badListed.length) {
  bad += badListed.length;
  console.log('\n✗ 兜底清单里不在真实名单里的名字（' + badListed.length + '）：');
  console.log('  ' + badListed.join(', '));
} else {
  console.log('\n✓ 兜底清单全部是真实图标名');
}
if (badUsed.length) {
  bad += badUsed.length;
  console.log('✗ 代码里固定使用的名字不可渲染：' + badUsed.join(', '));
} else {
  console.log('✓ 代码里固定使用的名字都可渲染');
}
if (!listed.length) {
  bad += 1;
  console.log('✗ 兜底清单是空的（拿不到运行期 getIconIds 时就没有候选）');
}

console.log(bad === 0 ? '\n图标名核对通过 ✓' : '\n需要修正 ' + bad + ' 个名字');
process.exitCode = bad === 0 ? 0 : 1;
