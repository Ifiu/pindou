#!/usr/bin/env node
/**
 * build.mjs —— 把 src/ 的 5 个模块与 UI 片段拼装成「双击就能用」的单文件 HTML。
 *
 * 用法：node build.mjs
 * 依赖：零依赖，只用 node: 内置模块（node:fs / node:path / node:url）。
 * 产物：<工作目录>/拼豆图纸生成器.html
 *
 * 三条硬约束（对应验收脚本 tests/check.mjs 第 5 组）：
 *   1) 安全阀：任何输入 JS 含 `</script` → 立即失败，绝不写产物（否则产物会被浏览器截断）。
 *   2) 零外部资源：产物里不得出现任何会发起网络请求的加载点。
 *   3) 确定性：同输入两次运行产出字节完全相同（不写时间戳 / 随机数 / 绝对路径）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(ROOT, 'src');
const OUT_PATH = path.join(ROOT, '拼豆图纸生成器.html');

/** 脚本顺序冻结：palette → color → pipeline → render → app（后者依赖前者的全局）。 */
const JS_FILES = ['palette.js', 'color.js', 'pipeline.js', 'render.js', 'app.js'];
const UI_FILE = 'ui.html';

/* ───────────────────────────────────────────────────────── 安全阀 A：</script */

/** 字面量命中：`</script`（大小写不敏感）。 */
const RE_CLOSE_TAG = /<\/script/i;

/**
 * 拼接绕开命中：`'</scr' + 'ipt>'` / `"</scrip"+"t>"` 之类。
 * 做法：找到每一处 `</scr`，把紧随其后的 48 个字符去掉引号/加号/空白后压缩，
 * 若以 `ipt` 开头即视为「运行时才拼出闭合标签」→ 同样必须拦截。
 */
function findSplicedCloseTag(src) {
  const re = /<\/scr/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 48);
    if (tail.replace(/["'\s+]/g, '').toLowerCase().startsWith('ipt')) return m.index;
  }
  return -1;
}

/** 返回 [行号, 原因] 或 null。 */
function scriptSafetyViolation(src) {
  const hit = RE_CLOSE_TAG.exec(src);
  if (hit) {
    const line = src.slice(0, hit.index).split('\n').length;
    return [line, '含字面量 `</' + 'script`（HTML 解析器会在此处提前结束脚本，产物被静默截断）'];
  }
  const at = findSplicedCloseTag(src);
  if (at >= 0) {
    const line = src.slice(0, at).split('\n').length;
    return [line, '含可用字符串拼接绕开扫描的 `</' + 'script`（`</scr` + `ipt` 形式）'];
  }
  return null;
}

/* ─────────────────────────────────────────────── 安全阀 B：零外部资源（产物自检） */

/**
 * 精确规则：只在「HTML 属性 / JS 属性式赋值」位置命中 src|href，且其值以
 * http(s):// 或协议相对 // 开头。它不是在找「文本里出现过 https」。
 * 前缀用 `[^\w$]`（而非空白/引号白名单）是为了同时覆盖 `el.href = "https://…"`
 * 这种带点号的属性赋值；`src\s*=` 里 `=` 前的字符必须是 src|href 的结尾，
 * 因此 `source: "https://…"` 这类键名不会命中（src 后面跟的是 e，不是 =）。
 *
 * 为什么不会把 src/palette.js 的数据来源注释误判为违规（逐条对照真实内容）：
 *   · 注释里的 `数据来源（…抓取于 https://github.com/HansBug/pindou-color-data…）`
 *     —— 前面既没有 src= 也没有 href=，不命中。
 *   · 数据字段 `source: "https://raw.githubusercontent.com/…"` —— 键名是 source
 *     （`src` 后面是 `e`，不是 `=`），且分隔符是 `:` 不是 `=`，不命中。
 *   · app.js 的 `img.src = url;` / `a.href = url;` —— 等号右侧是变量 `url`，
 *     不是以 http(s):// 开头的字面量，不命中。
 *
 * 已知残余（静态扫描的边界，无法覆盖，如实记录）：运行时拼接出来的 URL
 * （`'htt'+'ps://x'`）、以及未列入本规则的加载点（srcset / poster / CSS url()）。
 */
const RESOURCE_RULES = [
  { name: '<script src=…> 外链脚本', re: /<script\b[^>]*\ssrc\s*=/i },
  { name: '<link> 外链资源', re: /<link\b/i },
  { name: 'CSS @import', re: /@import/i },
  { name: 'src 指向 http(s):// 或 //', re: /(?:^|[^\w$])src\s*=\s*["']?\s*(?:https?:)?\/\//i },
  { name: 'href 指向 http(s):// 或 //', re: /(?:^|[^\w$])href\s*=\s*["']?\s*(?:https?:)?\/\//i },
  { name: "setAttribute('src'|'href', http(s)://…)", re: /setAttribute\s*\(\s*["'](?:src|href)["']\s*,\s*["']\s*(?:https?:)?\/\//i },
];

function findExternalResources(html) {
  const hits = [];
  for (const rule of RESOURCE_RULES) {
    const m = rule.re.exec(html);
    if (m) {
      const line = html.slice(0, m.index).split('\n').length;
      hits.push(rule.name + '（第 ' + line + ' 行：' + JSON.stringify(m[0].slice(0, 60)) + '）');
    }
  }
  return hits;
}

/* ──────────────────────────────────────────────────────────────── 读取与校验 */

const readFailures = [];
function readSrc(file) {
  const abs = path.join(SRC_DIR, file);
  try {
    return readFileSync(abs, 'utf8');
  } catch (err) {
    readFailures.push({
      file: 'src/' + file,
      abs,
      why: err && err.code === 'ENOENT' ? '文件不存在' : ('读取失败：' + (err && err.message)),
    });
    return null;
  }
}

function lineCount(text) {
  if (text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

function fail(lines) {
  console.error('\n✗ 构建失败，未写出任何产物：\n');
  for (const line of lines) console.error('  · ' + line);
  console.error('');
  process.exit(1);
}

/* 1) 读取全部输入（缺文件要指出缺哪个） */
const ui = readSrc(UI_FILE);
const jsSources = JS_FILES.map((f) => ({ file: f, abs: path.join(SRC_DIR, f), text: readSrc(f) }));
if (readFailures.length) {
  fail(
    readFailures.map((r) => '缺少输入文件 ' + r.file + '（' + r.why + '）；绝对路径 ' + r.abs) .concat(
      '构建需要以下输入：src/' + UI_FILE + '、' + JS_FILES.map((f) => 'src/' + f).join('、')
    )
  );
}

/* 2) 安全阀：逐段扫 JS（在拼接之前，命中就退出，不产出任何文件） */
const safetyHits = [];
for (const m of jsSources) {
  const v = scriptSafetyViolation(m.text);
  if (v) safetyHits.push('src/' + m.file + ' 第 ' + v[0] + ' 行：' + v[1]);
}
if (safetyHits.length) {
  fail(safetyHits.map((h) => '安全阀拦截 → ' + h).concat('该字符串内联进 <script> 会被浏览器当成结束标签，产物会被截断。'));
}

/* 3) ui.html 结构校验：它会被原样内联进 <body>，不得自带 script 块或残留闭合标签。
 *    产物必须「恰好 5 个 <script> 块」，UI 片段自带脚本会破坏该契约。 */
const uiProblems = [];
if (/<script\b/i.test(ui)) uiProblems.push('src/' + UI_FILE + ' 含 <script 标签（UI 片段不得自带脚本，脚本只能来自 src/*.js）');
if (/<\/script/i.test(ui)) uiProblems.push('src/' + UI_FILE + ' 含 `</' + 'script` 字面量');
if (/<\/?(?:html|head|body)\b/i.test(ui)) uiProblems.push('src/' + UI_FILE + ' 含 <html>/<head>/<body> 标签（UI 片段只应含 <style> 与 <div id="app">）');
if (uiProblems.length) fail(uiProblems.concat('UI 片段必须能原样内联进 <body>。'));

/* ──────────────────────────────────────────────────────────────────────── 拼装 */

const trimTail = (s) => s.replace(/\s+$/, '');
const parts = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>拼豆图纸生成器</title>',
  '</head>',
  '<body>',
  trimTail(ui),
];
for (const m of jsSources) {
  parts.push('<script>');
  parts.push('/* ===== src/' + m.file + ' ===== */');
  parts.push(trimTail(m.text));
  parts.push('</' + 'script>');
}
parts.push('</body>');
parts.push('</html>');
const html = parts.join('\n') + '\n';

/* 4) 产物自检：零外部资源 + 残留闭合标签 */
const externals = findExternalResources(html);
if (externals.length) fail(externals.map((e) => '产物含外部资源加载点 → ' + e));
const residual = RE_CLOSE_TAG.exec(trimTail(ui)) || RE_CLOSE_TAG.exec(jsSources.map((m) => m.text).join('\n'));
if (residual) fail(['产物内联段残留 `</' + 'script` 字面量（与安全阀结果不一致，已拒绝写出）']);

/* ──────────────────────────────────────────────────────────────────────── 写出 */

writeFileSync(OUT_PATH, html, 'utf8');   // utf8 且不写 BOM（HTML 自带 <meta charset=utf-8>）

const bytes = Buffer.byteLength(html, 'utf8');
console.log('✓ 已生成单文件：' + path.basename(OUT_PATH));
console.log('  路径            : ' + OUT_PATH);
console.log('  产物字节数      : ' + bytes);
console.log('  产物行数        : ' + lineCount(html));
console.log('  内联脚本块      : ' + jsSources.length + ' 个（顺序 ' + JS_FILES.join(' → ') + '）');
console.log('  输入明细        :');
console.log('    src/' + UI_FILE + '  ' + lineCount(ui) + ' 行 · ' + Buffer.byteLength(ui, 'utf8') + ' 字节（原样内联进 <body>）');
for (const m of jsSources) {
  console.log('    src/' + m.file.padEnd(12, ' ') + lineCount(m.text) + ' 行 · ' + Buffer.byteLength(m.text, 'utf8') + ' 字节');
}
console.log('  安全阀          : 通过（无 `</' + 'script` 字面量 / 无拼接变体）');
console.log('  外部资源扫描    : 通过（0 个加载点，见 build.mjs 的 RESOURCE_RULES 精确规则）');
console.log('  确定性          : 无时间戳 / 无随机数 / 无绝对路径写入产物');
