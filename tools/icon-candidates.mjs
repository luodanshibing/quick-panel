/*
 * 一次性取证脚本（只读 obsidian.asar）：
 *  1) 取出 setIcon 用的别名表 `Cg`（gear→settings、magnifying-glass→search …）；
 *  2) 用"别名 → gg 表"的真实规则，核对插件里用到的每个图标名能否渲染；
 *  3) 产出"给图标选择器用的兜底候选清单"（精选常用名，限定在真实可用集合内）。
 * 用法：node tools/icon-candidates.mjs [--write]
 *   --write 时把候选清单写回 main.js 的 LUCIDE_CANDIDATES（默认只打印核对结果）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ASAR = 'C:\\Program Files\\Obsidian\\resources\\obsidian.asar';
const src = readFileSync(ASAR, 'latin1');

/** 从 `名字={` 起做花括号配对，返回对象字面量文本 */
function objectLiteralAt(anchor) {
  const i = src.indexOf(anchor);
  if (i < 0) return '';
  const start = src.indexOf('{', i);
  if (start < 0) return '';
  let depth = 0;
  let quote = '';
  for (let j = start; j < src.length; j += 1) {
    const c = src[j];
    if (quote) {
      if (c === '\\') j += 1;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  return '';
}

const ggText = objectLiteralAt('const gg={');
const cgText = (function () {
  // 别名表就紧邻在 gg 之后出现，用它的首个键定位更稳
  const i = src.indexOf('trash:"trash-2",search:"search"');
  if (i < 0) return '';
  const start = src.lastIndexOf('{', i);
  if (start < 0) return '';
  let depth = 0;
  let quote = '';
  for (let j = start; j < src.length; j += 1) {
    const c = src[j];
    if (quote) {
      if (c === '\\') j += 1;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  return '';
})();

function keysOf(objText) {
  const out = [];
  if (!objText) return out;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < objText.length; i += 1) {
    const c = objText[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      // 尝试把这段字符串当成"顶层键"：深度 1 且后面紧跟 :
      let j = i + 1;
      let v = '';
      while (j < objText.length) {
        if (objText[j] === '\\') {
          v += objText[j + 1] || '';
          j += 2;
          continue;
        }
        if (objText[j] === quote) break;
        v += objText[j];
        j += 1;
      }
      let k = j + 1;
      while (k < objText.length && /\s/.test(objText[k])) k += 1;
      if (depth === 1 && objText[k] === ':') out.push(v);
      i = j;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
  }
  return out;
}

const ggKeys = keysOf(ggText);
const alias = {};
// 别名表是 `别名:"目标"` 的平铺对象，用正则取（值都是短标识符，安全）
for (const m of cgText.matchAll(/([A-Za-z][\w-]*|"[^"]+")\s*:\s*"([^"]+)"/g)) {
  alias[m[1].replace(/"/g, '')] = m[2];
}

console.log('gg（内置图标表）键数 =', ggKeys.length);
console.log('Cg（别名表）条目数 =', Object.keys(alias).length);

/** 与 setIcon 一致的可解析判定 */
function resolvable(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  if (ggKeys.includes(n)) return true;
  if (Object.prototype.hasOwnProperty.call(alias, n)) return alias[n] === n || ggKeys.includes(alias[n]);
  return false;
}
function resolvesTo(name) {
  const n = String(name || '').trim();
  if (ggKeys.includes(n)) return n;
  const t = alias[n];
  if (t && ggKeys.includes(t)) return t;
  if (t) return 'alias->' + t + (ggKeys.includes(t) ? '' : '（目标也不存在）');
  return '（无法解析）';
}

// 插件里实际用到的图标名
const SRC = readFileSync(join(ROOT, 'main.js'), 'utf8');
const used = new Set();
for (const m of SRC.matchAll(/setIcon\([^,]+,\s*'([^']+)'/g)) used.add(m[1]);
for (const m of SRC.matchAll(/icon:\s*'([^']+)'/g)) used.add(m[1]);
for (const m of SRC.matchAll(/setIcon\([^,]+,\s*([A-Za-z_$][\w$.]*)\)/g)) used.add('${' + m[1] + '}');

const fallbackBlock = (SRC.match(/const LUCIDE_CANDIDATES = \[([\s\S]*?)\];/) || [, ''])[1];
const fallback = [...fallbackBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]);

console.log('\n=== 插件里用到的固定图标名 ===');
let badUsed = 0;
for (const n of [...used].sort()) {
  if (n.startsWith('${')) continue;
  const ok = resolvable(n);
  if (!ok) badUsed += 1;
  console.log('  ' + n.padEnd(26) + (ok ? 'OK (' + resolvesTo(n) + ')' : '✗ 不可解析'));
}

console.log('\n=== 兜底候选清单核对（' + fallback.length + ' 个）===');
const badFallback = fallback.filter((n) => !resolvable(n));
console.log('不可解析的：' + (badFallback.length ? badFallback.join(', ') : '无 ✓'));
const viaAlias = fallback.filter((n) => ggKeys.includes(n)).length;
console.log('其中直接命中 gg 的：' + viaAlias + '，靠别名解析的：' + (fallback.length - badFallback.length - viaAlias));

// 产出：全部"真实可用名字"（gg 键 + 能解析到 gg 的别名），供选择器兜底
const usable = new Set(ggKeys);
Object.keys(alias).forEach((a) => {
  if (ggKeys.includes(alias[a])) usable.add(a);
});
const list = [...usable].sort();
console.log('\n可渲染名字总数 =', list.length);

const outFile = join(ROOT, 'tools', 'preview', 'icon-names.json');
writeFileSync(outFile, JSON.stringify(list, null, 0) + '\n', 'utf8');
console.log('已写出候选清单：' + outFile);
if (badUsed || badFallback.length) process.exitCode = 1;
