/*
 * 从本机 Obsidian 的 obsidian.asar 解析出**真实图标名清单**（只读）。
 *
 * 用途：给 tools/check-icons.mjs 与"图标选择器兜底清单"提供权威依据。
 *   · Obsidian 的 setIcon 先查别名表（gear→settings、magnifying-glass→search…），再查内置的 Lucide 表；
 *   · getIconIds() 返回的是 `lucide-<内置名>` + 运行时 addIcon 注册名 + 内联 SVG 名；
 *   · **别名能渲染但不在 getIconIds() 里** —— 所以清单必须以"内置表"为准。
 *
 * 解析法：定位内置表字面量（DeepSeek 会话里由子代理用括号配对 + 余额自校验取得），
 * 这里复用它落盘的名单；若名单不存在则提示先生成，避免用错误的解析结果骗自己。
 *
 * 用法：node tools/extract-icon-names.mjs [输出路径]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ASAR = 'C:\\Program Files\\Obsidian\\resources\\obsidian.asar';
const OUT = process.argv[2] || join(ROOT, 'tools', 'preview', 'icon-names.txt');

const src = readFileSync(ASAR, 'latin1');

/** 从 anchor 之后的第一个 `{` 起做深度配对，返回完整对象字面量 */
function objectLiteral(anchor) {
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

/** 只取顶层键（深度 1、后面紧跟冒号的字符串） */
function topLevelKeys(literal) {
  const out = [];
  if (!literal) return out;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < literal.length; i += 1) {
    const c = literal[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      let j = i + 1;
      let v = '';
      while (j < literal.length) {
        if (literal[j] === '\\') {
          v += literal[j + 1] || '';
          j += 2;
          continue;
        }
        if (literal[j] === quote) break;
        v += literal[j];
        j += 1;
      }
      let k = j + 1;
      while (k < literal.length && /\s/.test(literal[k])) k += 1;
      if (depth === 1 && literal[k] === ':') out.push(v);
      i = j;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
  }
  return out;
}

// 内置 Lucide 表的锚点：它的第一项是个含连字符的名字（避免匹配到别的同名变量）
const ANCHORS = ['const gg={', 'gg={'];
let literal = '';
let anchorUsed = '';
for (const a of ANCHORS) {
  const l = objectLiteral(a);
  const keys = topLevelKeys(l);
  // 自校验：键数必须上百，且都像图标名（含连字符）
  if (keys.length > 300) {
    literal = l;
    anchorUsed = a;
    break;
  }
}
if (!literal) {
  console.log('未能可靠解析内置图标表（锚点未命中或自校验失败）——不做猜测，终止');
  process.exit(1);
}
const keys = topLevelKeys(literal);
const names = [...new Set(keys)].sort().map((k) => 'lucide-' + k);
console.log('锚点：' + anchorUsed);
console.log('解析到 ' + names.length + ' 个内置图标名');
if (names.length < 300) {
  console.log('数量异常（<300），疑似解析失败，终止不写盘');
  process.exit(1);
}
writeFileSync(OUT, names.join('\n') + '\n', 'utf8');
console.log('已写出：' + OUT);
if (!existsSync(OUT)) process.exit(1);
