#!/usr/bin/env node
/**
 * tests/check.mjs —— 拼豆图纸生成器验收脚本（零依赖，只用 node: 内置模块）
 *
 * 用法：
 *   node tests/check.mjs            逐条打印 PASS/FAIL
 *   node tests/check.mjs --quiet    只打印 FAIL 与分组小计（复核时用）
 *
 * 退出码：全过 0，有任何失败 1。
 *
 * 边界声明：本脚本只做「加载 + 逻辑 + 结构」层面的验收。它没有浏览器，
 * 因此**不验证**真实渲染外观、鼠标/键盘交互、点击下载与打印效果。
 *
 * 八组：模块加载 / 色表 / 色彩引擎 / 主管线 / 渲染 / 产物 / 界面契约（app.js + ui.html）/ 原图编辑（srcedit.js）。
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'src');
const PRODUCT = path.join(ROOT, '拼豆图纸生成器.html');
const QUIET = process.argv.includes('--quiet');

/* ══════════════════════════════════════════════════════════ 断言框架 */
let pass = 0;
let fail = 0;
let assertions = 0;
const failures = [];
const groupStats = [];
let current = null;

function startGroup(title) {
  current = { title, pass: 0, fail: 0 };
  groupStats.push(current);
  console.log('\n─── ' + title + ' ───');
}
function record(name, okFlag, detail) {
  assertions++;
  if (okFlag) {
    pass++;
    current.pass++;
    if (!QUIET) console.log('  PASS  ' + name);
  } else {
    fail++;
    current.fail++;
    const line = name + (detail ? '   [' + detail + ']' : '');
    failures.push(current.title + ' :: ' + line);
    console.log('  FAIL  ' + line);
  }
}
const ok = (name, cond, detail) => record(name, !!cond, detail);
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  record(name, a === e, a === e ? '' : '期望 ' + e + '，实际 ' + a);
}
function near(name, actual, expected, tol) {
  const d = Math.abs(actual - expected);
  record(name, d <= tol, d <= tol ? '' : '期望 ' + expected + '±' + tol + '，实际 ' + actual);
}
const info = (msg) => console.log('  INFO  ' + msg);

/* ══════════════════════════════════════════════════ 模块加载（唯一可靠姿势） */
/* 各模块的全局解析方式不一致：
 *   palette.js 裸用 window ；color.js 用 typeof window 判断 ；pipeline.js 无条件写 globalThis ；
 *   render.js / srcedit.js / app.js 挂 window。
 * 故：window === globalThis，逐个 new Function(src)() 求值，再从 globalThis 上取全局。
 * 反例：new Function('window', src)(fake) 会让 pipeline 把 Pipeline 挂到真 globalThis 上，
 * 假对象收不到 —— 这条路径已排除。srcedit.js 在这条路径下（无 document）同样只挂
 * globalThis.SourceEdit、不抛异常，已实测。
 */
globalThis.window = globalThis;

function evalScript(src) {
  try {
    new Function(src)();
    return null;
  } catch (e) {
    return e;
  }
}
function readSrc(file) {
  const abs = path.join(SRC_DIR, file);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, 'utf8');
}

const MODULE_FILES = ['palette.js', 'color.js', 'pipeline.js', 'render.js', 'srcedit.js', 'app.js'];
const srcText = {};
const loadErrors = [];
for (const f of MODULE_FILES) {
  const text = readSrc(f);
  if (text === null) {
    loadErrors.push('src/' + f + ' 不存在');
    continue;
  }
  srcText[f] = text;
  const err = evalScript(text);
  if (err) loadErrors.push('src/' + f + ' 求值抛错：' + err.message);
}

startGroup('第 0 组 · 模块加载');
ok('src/ 下 6 个模块文件都存在', MODULE_FILES.every((f) => srcText[f] !== undefined), loadErrors.join(' / '));
ok('6 个模块逐个 new Function(src)() 均无抛错', loadErrors.length === 0, loadErrors.join(' / '));
ok('window === globalThis（浏览器式全局模拟已生效）', globalThis.window === globalThis);

const P = globalThis.PINDOU_PALETTES;
const CK = globalThis.ColorKit;
const Pipeline = globalThis.Pipeline;
const Render = globalThis.Render;
const SourceEdit = globalThis.SourceEdit;
ok('globalThis.SourceEdit 已挂载（srcedit.js 无 document 也能挂）', !!SourceEdit && typeof SourceEdit === 'object');
ok('typeof SourceEdit.mount === "function"', !!SourceEdit && typeof SourceEdit.mount === 'function', typeof (SourceEdit && SourceEdit.mount));

/* ══════════════════════════════════════════════ 共用：色号自然序比较器（冻结规则） */
const GROUP_ORDER = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'M'];
const groupRank = (g) => {
  const k = GROUP_ORDER.indexOf(String(g === null || g === undefined ? '' : g).toUpperCase());
  return k >= 0 ? k : GROUP_ORDER.length + 1;
};
const codeNumber = (c) => {
  const m = /(\d+)/.exec(String(c));
  return m ? parseInt(m[1], 10) : -1;
};
function compareColors(a, b) {
  const ra = groupRank(a.group);
  const rb = groupRank(b.group);
  if (ra !== rb) return ra - rb;
  if (ra > GROUP_ORDER.length) {
    const ga = String(a.group).toUpperCase();
    const gb = String(b.group).toUpperCase();
    if (ga !== gb) return ga < gb ? -1 : 1;
  }
  const na = codeNumber(a.code);
  const nb = codeNumber(b.code);
  if (na !== nb) return na - nb;
  const ca = String(a.code);
  const cb = String(b.code);
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}
const isNaturalOrder = (colors) =>
  JSON.stringify(colors.map((c) => c.code)) ===
  JSON.stringify(colors.slice().sort(compareColors).map((c) => c.code));

/* 确定性合成像素生成器（禁用 Math.random，保证可复跑） */
function synth(w, h, fn) {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = fn(x, y);
      const o = (y * w + x) * 4;
      buf[o] = p[0];
      buf[o + 1] = p[1];
      buf[o + 2] = p[2];
      buf[o + 3] = p.length > 3 ? p[3] : 255;
    }
  }
  return buf;
}

/* ═══════════════════════════════════════════════════════════ 第 1 组 · 色表 */
const EXPECT_GROUP_COUNTS = { A: 26, B: 32, C: 29, D: 26, E: 24, F: 25, G: 21, H: 23, M: 15 };
const HEX6 = /^#[0-9A-F]{6}$/;

startGroup('第 1 组 · 色表（PINDOU_PALETTES）');
ok('window.PINDOU_PALETTES 已挂载且为对象', !!P && typeof P === 'object');
const palKeys = P ? Object.keys(P) : [];
eq('谱系数量 = 2', palKeys.length, 2);

const allPaletteHexes = [];
for (const key of palKeys) {
  const entry = P[key];
  const colors = (entry && entry.colors) || [];
  const palCodes = colors.map((c) => c.code);
  allPaletteHexes.push(...colors.map((c) => c.hex));

  ok(key + ' 含 221 条颜色', colors.length === 221, '实际 ' + colors.length);
  eq(key + ' 的 entry.count 字段 = 221', entry.count, 221);

  const byGroup = {};
  for (const c of colors) byGroup[c.group] = (byGroup[c.group] || 0) + 1;
  for (const g of GROUP_ORDER) eq(key + ' 组 ' + g + ' 计数 = ' + EXPECT_GROUP_COUNTS[g], byGroup[g] || 0, EXPECT_GROUP_COUNTS[g]);
  eq(key + ' 无 A..M 之外的分组', Object.keys(byGroup).sort().join(','), GROUP_ORDER.slice().sort().join(','));

  ok(key + ' 色号唯一', new Set(palCodes).size === palCodes.length, '唯一 ' + new Set(palCodes).size + ' / 共 ' + palCodes.length);

  for (const g of GROUP_ORDER) {
    const nums = colors
      .filter((c) => c.group === g)
      .map((c) => codeNumber(c.code))
      .sort((a, b) => a - b);
    const want = Array.from({ length: nums.length }, (_, i) => i + 1);
    ok(key + ' 组 ' + g + ' 编号 1..' + nums.length + ' 连续', JSON.stringify(nums) === JSON.stringify(want), '实际 ' + JSON.stringify(nums));
  }

  const badHex = colors.find((c) => !HEX6.test(String(c.hex)));
  ok(key + ' 全部 hex 匹配 ^#[0-9A-F]{6}$', !badHex, badHex ? '首个违规色号 ' + badHex.code + ' → ' + badHex.hex : '');

  const badRgb = colors.find((c) => JSON.stringify(c.rgb) !== JSON.stringify(CK && CK.hexToRgb(c.hex)));
  ok(key + ' 全部 rgb 可由 hex 还原', !badRgb, badRgb ? '首个不一致色号 ' + badRgb.code + ' hex=' + badRgb.hex + ' rgb=' + JSON.stringify(badRgb.rgb) : '');

  ok(key + ' 文件顺序即自然序（组 A→H→M，组内数字升序）', isNaturalOrder(colors));
  const i9 = palCodes.indexOf('A9');
  const i10 = palCodes.indexOf('A10');
  ok(key + ' A9 排在 A10 之前', i9 >= 0 && i10 >= 0 && i9 < i10, 'A9@' + i9 + ' A10@' + i10);
}

/* ═════════════════════════════════════════════════════ 第 2 组 · 色彩引擎 */
startGroup('第 2 组 · 色彩引擎（ColorKit）');
ok('window.ColorKit 已挂载', !!CK && typeof CK === 'object');
ok(
  '对外 API 齐全（10 个函数）',
  CK && ['hexToRgb', 'rgbToHex', 'srgbToLab', 'srgbToOklab', 'deltaE', 'deltaEOklab', 'makeMatcher', 'ditherFS', 'ditherBayer', 'quantize'].every((k) => typeof CK[k] === 'function')
);

const RED_LAB = CK ? CK.srgbToLab([255, 0, 0]) : [0, 0, 0];
near('srgbToLab([255,0,0]).L ≈ 53.24', RED_LAB[0], 53.24, 1);
near('srgbToLab([255,0,0]).a ≈ 80.09', RED_LAB[1], 80.09, 1);
near('srgbToLab([255,0,0]).b ≈ 67.20', RED_LAB[2], 67.2, 1);
near('srgbToLab 白点 L ≈ 100', CK.srgbToLab([255, 255, 255])[0], 100, 0.5);

eq('hexToRgb("#FAF5CD")', CK.hexToRgb('#FAF5CD'), [250, 245, 205]);
eq('hexToRgb 小写 "#faf5cd" 与大写同值', CK.hexToRgb('#faf5cd'), CK.hexToRgb('#FAF5CD'));
eq('hexToRgb 三位缩写 "#fff"', CK.hexToRgb('#fff'), [255, 255, 255]);
eq('hexToRgb 非法输入 → null', CK.hexToRgb('not-a-hex'), null);
eq('rgbToHex([255,255,255]) 无 # 前缀且大写', CK.rgbToHex([255, 255, 255]), '#FFFFFF');
eq('rgbToHex 越界值被夹紧', CK.rgbToHex([-5, 300, 12.6]), '#00FF0D');

let rtBad = null;
for (const h of allPaletteHexes) {
  if (CK.rgbToHex(CK.hexToRgb(h)) !== h.toUpperCase()) {
    rtBad = h;
    break;
  }
}
ok('全表 ' + allPaletteHexes.length + ' 个 hex → rgb → hex 往返一致（含小写输入）', rtBad === null, rtBad ? '首个失败 ' + rtBad : '');
ok('hexToRgb 小写全表往返一致', allPaletteHexes.every((h) => JSON.stringify(CK.hexToRgb(h.toLowerCase())) === JSON.stringify(CK.hexToRgb(h))));
near('deltaE 为 CIE76 欧氏距离：deltaE([0,0,0],[3,4,0]) = 5', CK.deltaE([0, 0, 0], [3, 4, 0]), 5, 1e-9);
near('deltaEOklab 对称', CK.deltaEOklab([0.1, 0.2, 0.3], [0.4, 0.1, 0.2]), CK.deltaEOklab([0.4, 0.1, 0.2], [0.1, 0.2, 0.3]), 1e-12);

let emptyThrew = false;
try {
  CK.makeMatcher([]);
} catch (e) {
  emptyThrew = true;
}
ok('makeMatcher([]) 按契约抛错（色表不能为空）', emptyThrew);

const matColors = (P[palKeys[0]] && P[palKeys[0]].colors) || [];
const mat = CK.makeMatcher(matColors);
eq('matcher.size === 色表长度', mat.size, matColors.length);
ok('matcher.labs 长度 === size*3', mat.labs && mat.labs.length === mat.size * 3);
const ring = synth(24, 18, (x, y) => [(x * 37 + y * 11) % 256, (x * 13 + y * 29) % 256, (x * 53 + y * 7) % 256]);
const RW = 24;
const RH = 18;
const ringRGB = new Float32Array(RW * RH * 3);
for (let i = 0; i < RW * RH; i++) {
  ringRGB[i * 3] = ring[i * 4];
  ringRGB[i * 3 + 1] = ring[i * 4 + 1];
  ringRGB[i * 3 + 2] = ring[i * 4 + 2];
}
ok('matcher.nearest 对所有样本返回合法下标', Array.from({ length: RW * RH }, (_, i) => mat.nearest([ringRGB[i * 3], ringRGB[i * 3 + 1], ringRGB[i * 3 + 2]])).every((v) => v >= 0 && v < mat.size));

const fs0 = CK.ditherFS(ringRGB, RW, RH, mat, 0);
let fsMismatch = -1;
for (let i = 0; i < RW * RH; i++) {
  if (fs0[i] !== mat.nearest([ringRGB[i * 3], ringRGB[i * 3 + 1], ringRGB[i * 3 + 2]])) {
    fsMismatch = i;
    break;
  }
}
ok('ditherFS(strength=0) 逐格等于 matcher.nearest', fsMismatch < 0, fsMismatch < 0 ? '' : '首处不一致 i=' + fsMismatch);

const by4 = CK.ditherBayer(ringRGB, RW, RH, mat, 4, 0);
let b4Mismatch = -1;
for (let i = 0; i < RW * RH; i++) {
  if (by4[i] !== mat.nearest([ringRGB[i * 3], ringRGB[i * 3 + 1], ringRGB[i * 3 + 2]])) {
    b4Mismatch = i;
    break;
  }
}
ok('ditherBayer(4, strength=0) 逐格等于 matcher.nearest', b4Mismatch < 0, b4Mismatch < 0 ? '' : '首处不一致 i=' + b4Mismatch);

const fsFull = CK.ditherFS(ringRGB, RW, RH, mat, 1);
const by8Full = CK.ditherBayer(ringRGB, RW, RH, mat, 8, 1);
ok('ditherFS 输出全部 < matcher.size', Array.from(fsFull).every((v) => v < mat.size));
ok('ditherBayer(8) 输出全部 < matcher.size', Array.from(by8Full).every((v) => v < mat.size));
ok('ditherFS 两次调用结果完全相同', JSON.stringify(Array.from(CK.ditherFS(ringRGB, RW, RH, mat, 1))) === JSON.stringify(Array.from(fsFull)));
ok('ditherBayer 两次调用结果完全相同', JSON.stringify(Array.from(CK.ditherBayer(ringRGB, RW, RH, mat, 8, 1))) === JSON.stringify(Array.from(by8Full)));

for (const mc of [1, 24, 221, 0, -5, 999]) {
  const clampMax = Math.min(221, Math.max(1, Math.floor(mc)));
  let out = null;
  let err = null;
  try {
    out = CK.quantize(ringRGB, RW, RH, mc, mat);
  } catch (e) {
    err = e;
  }
  ok('quantize(maxColors=' + mc + ') 不抛错', err === null, err ? err.message : '');
  if (out) {
    ok('quantize(maxColors=' + mc + ') 的 used.length ≤ ' + clampMax, out.used.length <= clampMax, 'used=' + out.used.length);
    ok('quantize(maxColors=' + mc + ') 的 used 升序去重', JSON.stringify(out.used) === JSON.stringify(Array.from(new Set(out.used)).sort((a, b) => a - b)));
  }
}
const q1 = CK.quantize(ringRGB, RW, RH, 16, mat);
const q2 = CK.quantize(ringRGB, RW, RH, 16, mat);
ok('quantize | 输出的 indices 全部 < matcher.size', Array.from(q1.indices).every((v) => v >= 0 && v < mat.size));
eq('quantize | indices.length === w*h', q1.indices.length, RW * RH);
ok('quantize | 两次调用结果完全相同（indices + used）', JSON.stringify({ i: Array.from(q1.indices), u: q1.used }) === JSON.stringify({ i: Array.from(q2.indices), u: q2.used }));

/* ═════════════════════════════════════════════════════════ 第 3 组 · 主管线 */
startGroup('第 3 组 · 主管线（Pipeline）');
ok('window.Pipeline 已挂载', !!Pipeline && typeof Pipeline === 'object');
ok('Pipeline.generateFromRGBA 是函数', Pipeline && typeof Pipeline.generateFromRGBA === 'function');
ok('Pipeline.DEFAULT_OPTS 存在', !!Pipeline.DEFAULT_OPTS);

/** 每个用例都要查的核心不变量。 */
function checkInvariants(label, pat) {
  const cells = Array.from(pat.cells);
  const nonEmpty = cells.filter((c) => c !== 65535).length;
  const countsSum = pat.counts.reduce((s, c) => s + c.count, 0);
  eq(label + ' | colors.length === counts.length', pat.colors.length, pat.counts.length);
  eq(label + ' | Σcounts.count === stats.total', countsSum, pat.stats.total);
  eq(label + ' | stats.total === 非空格子数', pat.stats.total, nonEmpty);
  ok(label + ' | colors 为自然序', isNaturalOrder(pat.colors));
  ok(
    label + ' | counts 按颗数降序（同数按色号自然序）',
    pat.counts.every((c, i) => i === 0 || pat.counts[i - 1].count >= c.count)
  );
  ok(
    label + ' | 每个非空 cells[i] 都 < colors.length',
    cells.every((c) => c === 65535 || (c >= 0 && c < pat.colors.length))
  );
  eq(label + ' | cells.length === w*h', pat.cells.length, pat.w * pat.h);
  eq(label + ' | stats.usedColors === colors.length', pat.stats.usedColors, pat.colors.length);
  ok(label + ' | stats.boardX/Y 与 29 格/板一致', pat.stats.boardX === Math.ceil(pat.w / 29) && pat.stats.boardY === Math.ceil(pat.h / 29));
  return nonEmpty;
}

const srcBig = synth(1000, 500, (x, y) => [(x * 7) % 256, (y * 5) % 256, ((x + y) * 3) % 256]);
const srcWide = synth(1000, 50, (x, y) => [(x * 3) % 256, (y * 17) % 256, 90]);
const DIM_CASES = [
  { label: '1000×500 + boards:1', img: srcBig, w: 1000, h: 500, opts: { boards: 1 }, ew: 29, eh: 15 },
  { label: '1000×500 + boards:2', img: srcBig, w: 1000, h: 500, opts: { boards: 2 }, ew: 58, eh: 29 },
  { label: '1000×500 + boards:3', img: srcBig, w: 1000, h: 500, opts: { boards: 3 }, ew: 87, eh: 44 },
  { label: '1000×50 + boards:1', img: srcWide, w: 1000, h: 50, opts: { boards: 1 }, ew: 29, eh: 1 },
  { label: '1000×500 + 显式 gridW:200（应夹到 116）', img: srcBig, w: 1000, h: 500, opts: { gridW: 200 }, ew: 116, eh: 58 },
];
for (const c of DIM_CASES) {
  const pat = Pipeline.generateFromRGBA(c.img, c.w, c.h, c.opts);
  eq(c.label + ' | 推导宽度', pat.w, c.ew);
  eq(c.label + ' | 推导高度', pat.h, c.eh);
  checkInvariants(c.label, pat);
  ok(c.label + ' | warnings 为数组', Array.isArray(pat.warnings));
}

/* ── MAX_DIM 从 87 提到 116：116 必须真的可用，而不是被静默夹回 ───────────── */
const srcMed = synth(240, 240, (x, y) => [(x * 7) % 256, (y * 5) % 256, ((x + y) * 3) % 256]);
const pat116 = Pipeline.generateFromRGBA(srcMed, 240, 240, { gridW: 116, gridH: 116 });
eq('116×116 | pattern.w === 116', pat116.w, 116);
eq('116×116 | pattern.h === 116', pat116.h, 116);
eq('116×116 | warnings 原文为空（没有任何夹取提示）', pat116.warnings, []);
ok('116×116 | warnings 里不出现「夹到」', !pat116.warnings.some((w) => String(w).includes('夹到')), JSON.stringify(pat116.warnings));
eq('116×116 | stats.boardX === ceil(116/29) === 4', pat116.stats.boardX, 4);
eq('116×116 | stats.boardY === 4', pat116.stats.boardY, 4);
eq('116×116 | cells.length === 116*116', pat116.cells.length, 116 * 116);
eq('116×116 | stats.total === 116*116（源图无透明像素）', pat116.stats.total, 116 * 116);
checkInvariants('116×116', pat116);

/* 上限真的是 116 而不是 87：117 必须被夹回 116，且告警文案由 MAX_DIM 拼出 */
const pat117 = Pipeline.generateFromRGBA(srcMed, 240, 240, { gridW: 117, gridH: 117 });
eq('117 → 夹到 116（上限不是 87）', [pat117.w, pat117.h], [116, 116]);
ok('117 夹取告警含 [1,116]（文案不再硬编码 87）', pat117.warnings.some((w) => String(w).includes('[1,116]')), JSON.stringify(pat117.warnings));
ok('117 夹取告警里不出现 87', !pat117.warnings.some((w) => String(w).includes('87')), JSON.stringify(pat117.warnings));

/* 100 与 116 都不是 29 的整数倍/整倍数：末格补线规则由渲染层负责，此处只锁 boardX/Y */
const pat100 = Pipeline.generateFromRGBA(srcMed, 240, 240, { gridW: 100, gridH: 100 });
eq('100×100 | w/h', [pat100.w, pat100.h], [100, 100]);
eq('100×100 | stats.boardX === ceil(100/29) === 4', pat100.stats.boardX, 4);
eq('100×100 | stats.boardY === 4', pat100.stats.boardY, 4);
eq('100×100 | warnings 原文为空', pat100.warnings, []);

const flatPat = Pipeline.generateFromRGBA(synth(60, 60, () => [10, 200, 60]), 60, 60, { boards: 1 });
eq('纯色图 | colors.length === 1', flatPat.colors.length, 1);
eq('纯色图 | colors.length === counts.length', flatPat.colors.length, flatPat.counts.length);
eq('纯色图 | counts[0].count === w*h', flatPat.counts[0].count, flatPat.w * flatPat.h);
eq('纯色图 | Σcounts.count === w*h', flatPat.counts.reduce((s, c) => s + c.count, 0), flatPat.w * flatPat.h);

const alphaImg = synth(100, 100, (x) => (x < 50 ? [0, 0, 0, 0] : [255, 0, 0, 255]));
const alphaPat = Pipeline.generateFromRGBA(alphaImg, 100, 100, { gridW: 4, gridH: 4 });
const ac = Array.from(alphaPat.cells);
eq('透明图 | w×h', [alphaPat.w, alphaPat.h], [4, 4]);
eq('透明图 | 8 个全透明格写成 65535', ac.filter((c) => c === 65535).length, 8);
ok('透明图 | 左半区每格都是 65535', [0, 1, 4, 5, 8, 9, 12, 13].every((i) => ac[i] === 65535));
ok('透明图 | 右半区每格都不是 65535', [2, 3, 6, 7, 10, 11, 14, 15].every((i) => ac[i] !== 65535));
eq('透明图 | stats.total 只计非空格 = 8', alphaPat.stats.total, 8);
eq('透明图 | Σcounts.count = 8（空格不计入）', alphaPat.counts.reduce((s, c) => s + c.count, 0), 8);
eq('透明图 | 只剩 1 个色号', alphaPat.colors.length, 1);

const q16Pat = Pipeline.generateFromRGBA(synth(60, 60, (x, y) => [(x * 9) % 256, (y * 11) % 256, ((x * y) * 5) % 256]), 60, 60, {
  boards: 1,
  quantize: { enabled: true, maxColors: 16 },
});
ok('quantize.maxColors=16 | colors.length ≤ 16', q16Pat.colors.length <= 16, '实际 ' + q16Pat.colors.length);
eq('quantize.maxColors=16 | colors.length === counts.length', q16Pat.colors.length, q16Pat.counts.length);

const detOpts = { boards: 1, method: 'fs', ditherStrength: 0.4, preprocess: { brightness: 5, contrast: 10, saturation: -10, autoWB: true, autoLevels: true } };
const detImg = synth(50, 40, (x, y) => [(x * 21) % 256, (y * 33) % 256, ((x + 2 * y) * 13) % 256]);
const detSnap = JSON.stringify(detOpts);
const detA = Pipeline.generateFromRGBA(detImg, 50, 40, detOpts);
const detOptsAfterA = JSON.stringify(detOpts);
const detB = Pipeline.generateFromRGBA(detImg, 50, 40, detOpts);
ok('确定性 | 同输入两次调用 Pattern 深度相等', JSON.stringify(detA) === JSON.stringify(detB));
ok('确定性 | opts 调用后未被修改', JSON.stringify(detOpts) === detSnap, detOptsAfterA === detSnap ? '' : '差异 ' + detOptsAfterA);
ok('确定性 | 未传 prevPattern 时 opts 里不出现新键', Object.keys(detOpts).join(',') === Object.keys(JSON.parse(detSnap)).join(','));

/* ─────────────────────────────────━━ 锁定格（最易崩的一环） */
const lockImg = synth(60, 60, (x, y) => [40 + (x % 3), 90 + (y % 3), 160]);
const lockOpts = { boards: 1, method: 'nearest', quantize: { enabled: true, maxColors: 1 } };
const basePat = Pipeline.generateFromRGBA(lockImg, 60, 60, lockOpts);
eq('锁定 | 基准图（maxColors:1）只有 1 个色号', basePat.colors.length, 1);
eq('锁定 | 基准图非空格 = 29×29', basePat.stats.total, basePat.w * basePat.h);
const baseCode = basePat.colors[0].code;
const lockIdx = 3 * basePat.w + 5;

const palColors = (P[basePat.paletteId] && P[basePat.paletteId].colors) || matColors;
const forced = palColors.find((c) => c.code !== baseCode) || null;
const expectedOrder = compareColors(
  { code: baseCode, group: basePat.colors[0].group },
  { code: forced.code, group: forced.group }
) <= 0
  ? [baseCode, forced.code]
  : [forced.code, baseCode];

const prevPattern = {
  w: basePat.w,
  h: basePat.h,
  cells: Uint16Array.from(basePat.cells),
  colors: basePat.colors.concat([{ code: forced.code, hex: forced.hex, rgb: forced.rgb.slice(), group: forced.group }]),
  locked: new Uint8Array(basePat.cells.length),
};
prevPattern.cells[lockIdx] = basePat.colors.length;
prevPattern.locked[lockIdx] = 1;
const prevSnap = JSON.stringify(prevPattern);
const baseSnap = JSON.stringify(basePat);

const lockPat = Pipeline.generateFromRGBA(lockImg, 60, 60, Object.assign({}, lockOpts, { prevPattern }));
eq('锁定 | 新 colors 恰好 2 项且按自然序重排（不是追加）', lockPat.colors.map((c) => c.code), expectedOrder);
eq('锁定 | 被锁格色号保持为强制色号', lockPat.colors[lockPat.cells[lockIdx]].code, forced.code);
eq('锁定 | 被锁格 locked=1（继承）', lockPat.locked[lockIdx], 1);
eq('锁定 | 全图只有 1 个锁定格', Array.from(lockPat.locked).filter((v) => v === 1).length, 1);
let cellDiff = -1;
for (let i = 0; i < lockPat.cells.length; i++) {
  if (i === lockIdx) continue;
  if (lockPat.colors[lockPat.cells[i]].code !== basePat.colors[basePat.cells[i]].code) {
    cellDiff = i;
    break;
  }
}
ok('锁定 | 其余格逐格色号与基准一致', cellDiff < 0, cellDiff < 0 ? '' : '首处不一致 i=' + cellDiff);
eq('锁定 | colors.length === counts.length', lockPat.colors.length, lockPat.counts.length);
eq('锁定 | 强制色号颗数 = 1', (lockPat.counts.find((c) => c.code === forced.code) || {}).count, 1);
eq('锁定 | Σcounts.count === 非空格数', lockPat.counts.reduce((s, c) => s + c.count, 0), lockPat.stats.total);
ok('锁定 | prevPattern 调用后未被修改', JSON.stringify(prevPattern) === prevSnap);
ok('锁定 | 上一张 Pattern 调用后未被修改', JSON.stringify(basePat) === baseSnap);

/* ── 边界与契约回退（探到即回归） ───────────────────────────── */
const edgeGray = synth(40, 40, (x, y) => [80 + (x % 5), 80 + (y % 5), 90]);
const nilPat = Pipeline.generateFromRGBA(synth(20, 20, () => [0, 0, 0, 0]), 20, 20, { boards: 1 });
eq('边界 | 全透明图 → colors 为空', nilPat.colors.length, 0);
eq('边界 | 全透明图 → counts 为空', nilPat.counts.length, 0);
eq('边界 | 全透明图 → stats.total = 0', nilPat.stats.total, 0);
ok('边界 | 全透明图 → cells 全为 65535', Array.from(nilPat.cells).every((c) => c === 65535));

const mismatched = {
  w: 9,
  h: 9,
  cells: new Uint16Array(81),
  colors: [{ code: 'A1', hex: '#FAF5CD', rgb: [250, 245, 205], group: 'A' }],
  locked: new Uint8Array(81).fill(1),
};
const misPat = Pipeline.generateFromRGBA(edgeGray, 40, 40, { boards: 1, quantize: { enabled: true, maxColors: 1 }, prevPattern: mismatched });
ok('边界 | prevPattern 尺寸不符 → 告警且忽略锁定（不崩）', misPat.warnings.some((w) => w.includes('不一致')), JSON.stringify(misPat.warnings));
eq('边界 | prevPattern 尺寸不符 → 仍照常出图', misPat.warnings.length >= 1 && misPat.colors.length, 1);

eq('边界 | 1000×1 极端宽比的短边夹到 1', Pipeline.generateFromRGBA(synth(1000, 1, () => [10, 20, 30]), 1000, 1, { boards: 1 }).h, 1);
eq('边界 | boards 参数仍夹到 3（长边 87，与 MAX_DIM 116 是两套口径；app.js 永远显式给 gridW/gridH 故不触发）', Pipeline.generateFromRGBA(edgeGray, 40, 40, { boards: 99 }).w, 87);
const onePat = Pipeline.generateFromRGBA(edgeGray, 40, 40, { gridW: 0, gridH: 0 });
eq('边界 | gridW/gridH = 0 夹到 1×1', [onePat.w, onePat.h], [1, 1]);
ok('边界 | 尺寸被夹时给出告警', onePat.warnings.some((w) => w.includes('夹到合法范围')), JSON.stringify(onePat.warnings));

let shortThrew = '';
try {
  Pipeline.generateFromRGBA(new Uint8ClampedArray(4), 10, 10, {});
} catch (e) {
  shortThrew = e.message;
}
ok('边界 | rgba 长度不足 → 抛错且说明需要多少字节', shortThrew.includes('长度不足'), shortThrew);
let dimThrew = '';
try {
  Pipeline.generateFromRGBA(edgeGray, 0, 0, {});
} catch (e) {
  dimThrew = e.message;
}
ok('边界 | 源图尺寸非法 → 抛错', dimThrew.includes('尺寸非法'), dimThrew);
let noDomThrew = '';
try {
  Pipeline.generate({ width: 10, height: 10 }, {});
} catch (e) {
  noDomThrew = e.message;
}
ok('边界 | 无 DOM 时 generate() 抛错并指路 generateFromRGBA', noDomThrew.includes('generateFromRGBA'), noDomThrew);
eq('边界 | ImageData 形状入参 → 自动走 generateFromRGBA', Pipeline.generate({ data: synth(30, 30, () => [200, 30, 30]), width: 30, height: 30 }, { boards: 1 }).w, 29);
ok('边界 | 非法 method → 回退 nearest 并告警', Pipeline.generateFromRGBA(edgeGray, 40, 40, { method: 'nope' }).warnings.some((w) => w.includes('method')));
const badPalPat = Pipeline.generateFromRGBA(edgeGray, 40, 40, { paletteId: 'no-such-lineage' });
eq('边界 | 不存在的 paletteId → 回退到第一个可用谱系', badPalPat.paletteId, palKeys[0]);
ok('边界 | 不存在的 paletteId → 告警', badPalPat.warnings.some((w) => w.includes('不存在')));

/* 锁定色号只存在于上一张 colors（用户换过色表）→ 必须沿用历史色值，而不是丢格 */
const ghost = { code: 'ZZ9', hex: '#123456', rgb: [18, 52, 86], group: 'Z' };
const ghostBase = Pipeline.generateFromRGBA(edgeGray, 40, 40, { boards: 1, quantize: { enabled: true, maxColors: 1 } });
const ghostPrev = {
  w: ghostBase.w,
  h: ghostBase.h,
  cells: Uint16Array.from(ghostBase.cells),
  colors: ghostBase.colors.concat([ghost]),
  locked: new Uint8Array(ghostBase.cells.length),
};
ghostPrev.cells[7] = ghostBase.colors.length;
ghostPrev.locked[7] = 1;
const ghostPat = Pipeline.generateFromRGBA(edgeGray, 40, 40, { boards: 1, quantize: { enabled: true, maxColors: 1 }, prevPattern: ghostPrev });
eq('边界 | 色表里没有的锁定色号 → 沿用历史色值', ghostPat.colors[ghostPat.cells[7]].hex + ' ' + ghostPat.colors[ghostPat.cells[7]].code, '#123456 ZZ9');
eq('边界 | 0 尺寸栅格 ditherFS 返回长度 0', CK.ditherFS(new Float32Array(0), 0, 0, mat, 0).length, 0);
eq('边界 | 0 尺寸栅格 quantize 返回空 used', CK.quantize(new Float32Array(0), 0, 0, 8, mat).used, []);

/* ═════════════════════════════════════════════════════════ 第 4 组 · 渲染 */
startGroup('第 4 组 · 渲染（Render）');

/** Mock 2D context：记录每次绘图调用及其当时的 fillStyle / lineWidth；跟踪当前路径。 */
/* 角标独占色：写死字面量，**不从 render.js 读**（读了就是自证）。
   与 src/render.js 的 C.caption 必须一致；不一致时本组末尾的独占色断言会红。 */
const CAPTION_INK = '#616B7A';
function makeMockCanvas() {
  // 图纸上有三类文字：格内标签/编号、坐标刻度、左下角角标。角标单独归到 rec.caption，
  // 这样断言里的 rec.fillText 仍然精确表示「标签 + 刻度」这两类，不会被角标污染计数。
  // 归类按「独占颜色」而不是文字格式：角标文案已经改过两次，每次按文本正则归类都会连锁打红
  // 几十条与角标无关的计数断言。C.caption 是 render.js 里角标独占的写法颜色，
  // 不与格内标签 / 坐标刻度 / 用量块复用（第 4 组末尾有独占色的独立断言兜底）。
  const rec = { fillRect: [], fillText: [], caption: [], strokes: [], fills: [], strokeRect: [], drawImage: [], roundRect: [], save: 0, restore: 0 };
  const ctx = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineCap: 'butt',
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    _path: [],
    save() { rec.save++; },
    restore() { rec.restore++; },
    fillRect(x, y, w, h) { rec.fillRect.push({ x, y, w, h, fillStyle: String(this.fillStyle) }); },
    strokeRect(x, y, w, h) { rec.strokeRect.push({ x, y, w, h, strokeStyle: String(this.strokeStyle) }); },
    drawImage(...a) { rec.drawImage.push(a); },
    fillText(t, x, y) {
      const item = { text: String(t), x, y, fillStyle: String(this.fillStyle), font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline };
      if (String(item.fillStyle) === CAPTION_INK) rec.caption.push(item); else rec.fillText.push(item);
    },
    beginPath() { this._path = []; },
    moveTo(x, y) { this._path.push(['M', x, y]); },
    lineTo(x, y) { this._path.push(['L', x, y]); },
    rect(x, y, w, h) { this._path.push(['R', x, y, w, h]); },
    roundRect(x, y, w, h, r) { rec.roundRect.push({ x, y, w, h, r }); this._path.push(['RR', x, y, w, h, r]); },
    closePath() { this._path.push(['Z']); },
    stroke() { rec.strokes.push({ path: this._path.slice(), strokeStyle: String(this.strokeStyle), lineWidth: this.lineWidth, lineCap: this.lineCap }); this._path = []; },
    fill() { rec.fills.push({ path: this._path.slice(), fillStyle: String(this.fillStyle) }); this._path = []; },
  };
  const canvas = { width: 0, height: 0, _rec: rec, getContext(kind) { return kind === '2d' ? ctx : null; } };
  return canvas;
}
const EMPTY = 65535;
const HP = {
  w: 5,
  h: 4,
  colors: [
    { code: 'A1', hex: '#FF0000', rgb: [255, 0, 0], group: 'A' },
    { code: 'B2', hex: '#00FF00', rgb: [0, 255, 0], group: 'B' },
    { code: 'C3', hex: '#0000FF', rgb: [0, 0, 255], group: 'C' },
  ],
  cells: new Uint16Array([0, 1, 2, 0, 1, 2, 0, EMPTY, EMPTY, 1, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1]),
  locked: new Uint8Array(20),
  counts: [],
  stats: {},
};
HP.locked[3] = 1;
const HP_NONEMPTY = 18;
const HP_PAD = Math.max(40, 12 * 3 + 20); // cellPx=12 → 56
const HP_CELL = 12;
const hpSnap = JSON.stringify({ c: Array.from(HP.cells), l: Array.from(HP.locked), colors: HP.colors });

function expectedFills(pat, cellPx, pad) {
  const out = [];
  for (let i = 0; i < pat.w * pat.h; i++) {
    const idx = pat.cells[i];
    if (idx === EMPTY) continue;
    out.push({ x: pad + (i % pat.w) * cellPx, y: pad + Math.floor(i / pat.w) * cellPx, w: cellPx, h: cellPx, fillStyle: pat.colors[idx].hex });
  }
  return out;
}
const isPaper = (r, cv) => r.x === 0 && r.y === 0 && r.w === cv.width && r.h === cv.height;
const cellFillsOf = (cv) => cv._rec.fillRect.filter((r) => !isPaper(r, cv));

/* 逐格标签期望值：'code' → colors[cells[i]].code；'index' → String(cells[i]+1) */
function expectedLabels(pat, cellPx, pad, mode) {
  const out = [];
  for (let i = 0; i < pat.w * pat.h; i++) {
    const idx = pat.cells[i];
    if (idx === EMPTY) continue;
    out.push({
      text: mode === 'index' ? String(idx + 1) : String(pat.colors[idx].code),
      x: pad + (i % pat.w) * cellPx + cellPx / 2,
      y: pad + Math.floor(i / pat.w) * cellPx + cellPx / 2 + 0.5
    });
  }
  return out;
}

/* 合成 Pattern（用于 116 格 / 面积守卫 / 板边界等大尺寸用例，避免每次都跑一遍管线） */
function makePat(w, h, colorCount) {
  const colors = [];
  for (let i = 0; i < colorCount; i++) {
    const v = (i * 97) % 256;
    const hex = '#' + [v, 255 - v, (v * 3) % 256].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase();
    colors.push({ code: 'T' + (i + 1), hex, rgb: [v, 255 - v, (v * 3) % 256], group: 'A' });
  }
  const cells = new Uint16Array(w * h);
  const tally = new Array(colorCount).fill(0);
  for (let i = 0; i < w * h; i++) { cells[i] = i % colorCount; tally[i % colorCount]++; }
  const counts = colors.map((c, i) => ({ code: c.code, hex: c.hex, rgb: c.rgb, count: tally[i] })).sort((a, b) => b.count - a.count);
  return { w, h, colors, cells, locked: new Uint8Array(w * h), counts, stats: { total: w * h } };
}

/* 板边界「格子下标 × cellPx」的独立重述（29 的整数倍 + 末格补线） */
function expectBoardOffsets(n, cellPx) {
  const out = [];
  for (let k = 29; k <= n; k += 29) out.push(k * cellPx);
  if (n > 0 && out[out.length - 1] !== n * cellPx) out.push(n * cellPx);
  return out;
}

const cv1 = makeMockCanvas();
/* padMode:'normal' 是 render.js 保留的向后兼容路径（旧公式 max(40, cellPx*3+20)），
 * 所有旧几何断言都走它；新默认是 'tight'，几何另有专项断言。 */
const r1 = Render.drawPattern(HP, cv1, { cellPx: 12, cellLabel: 'code', showRuler: false, padMode: 'normal' });
/* 左下角尺寸标注占用的额外高度，镜像 render.js 的 captionMetrics（必须算进画布高与面积守卫） */
const capH = (cellPx) => {
  const f = Math.max(9, Math.min(28, Math.round(cellPx * 0.45)));
  const top = Math.max(4, Math.round(cellPx * 0.35));
  return top + f + Math.max(3, Math.round(f * 0.35));
};
eq('drawPattern | 画布宽 = pad*2 + w*cellPx', cv1.width, HP_PAD * 2 + HP.w * HP_CELL);
eq('drawPattern | 画布高 = pad*2 + h*cellPx + 尺寸标注高', cv1.height, HP_PAD * 2 + HP.h * HP_CELL + capH(HP_CELL));
eq('drawPattern | 换算式 pad = max(40, cellPx*3+20)', HP_PAD, 56);
eq('drawPattern | cellsDrawn === 非空格子数', r1.cellsDrawn, HP_NONEMPTY);
/* 新标签规则：code 模式最小 cellPx = 20（本图最长色号 2 字符），12px 必然被抑制 */
eq('drawPattern | cellPx=12 + cellLabel:code → codesDrawn === false（阈值已提到 20）', r1.codesDrawn, false);
eq('drawPattern | cellPx=12 + cellLabel:code → labelsSuppressed === true', r1.labelsSuppressed, true);
eq('drawPattern | cellPx=12 + cellLabel:code → labelMinPx === 20', r1.labelMinPx, 20);
eq('drawPattern | 每格恰好一次填色（数量）', cellFillsOf(cv1).length, HP_NONEMPTY);
eq('drawPattern | 每格位置与颜色逐格精确匹配', cellFillsOf(cv1), expectedFills(HP, 12, HP_PAD));
ok(
  'drawPattern | 空格（65535）零填色',
  [7, 8].every((i) => {
    const x = HP_PAD + (i % HP.w) * 12;
    const y = HP_PAD + Math.floor(i / HP.w) * 12;
    return !cellFillsOf(cv1).some((r) => r.x === x && r.y === y);
  })
);
eq('drawPattern | 纸张底色先铺满画布', cv1._rec.fillRect[0], { x: 0, y: 0, w: cv1.width, h: cv1.height, fillStyle: '#FFFFFF' });
eq('drawPattern | 标签被抑制时 fillText 0 次（showRuler:false）', cv1._rec.fillText.length, 0);
eq('drawPattern | 细网格线一次成路径：2*((w+1)+(h+1)) = 22 个路径操作', cv1._rec.strokes[0].path.length, 22);
eq('drawPattern | 细网格线线宽 1', cv1._rec.strokes[0].lineWidth, 1);
eq('drawPattern | 板边界单独 stroke：竖 1 + 横 1 = 2 条', cv1._rec.strokes.length - 1, 2);
eq('drawPattern | 首条细网格线起点 x = pad + 0.5', cv1._rec.strokes[0].path[0], ['M', HP_PAD + 0.5, HP_PAD + 0.5]);
eq('drawPattern | 竖板边界在 x = pad + w*cellPx', cv1._rec.strokes[1].path[0][1], HP_PAD + HP.w * 12);
eq('drawPattern | 横板边界在 y = pad + h*cellPx', cv1._rec.strokes[2].path[0][2], HP_PAD + HP.h * 12);

/* 旧「编号文字 = String(cells[i]+1)」的规则只在 cellLabel:'index' 下成立，
 * 而且必须把 cellPx 抬到 index 阈值（17）之上才会真的画出来。 */
const INDEX_PX = 20;
const PAD_I = Math.max(40, INDEX_PX * 3 + 20);
const cv1i = makeMockCanvas();
const r1i = Render.drawPattern(HP, cv1i, { cellPx: INDEX_PX, cellLabel: 'index', showRuler: false, padMode: 'normal' });
eq('drawPattern | cellLabel:index + cellPx=20 → codesDrawn === true', r1i.codesDrawn, true);
eq('drawPattern | cellLabel:index + cellPx=20 → labelsSuppressed === false', r1i.labelsSuppressed, false);
eq('drawPattern | cellLabel:index → fillText 次数 === 非空格子数', cv1i._rec.fillText.length, HP_NONEMPTY);
eq(
  'drawPattern | 编号文字逐格 === String(cells[i]+1)',
  cv1i._rec.fillText.map((t) => t.text),
  Array.from(HP.cells).map((c) => (c === EMPTY ? null : String(c + 1))).filter((v) => v !== null)
);
eq(
  'drawPattern | 编号位置 = 格中心',
  cv1i._rec.fillText.map((t) => [t.x, t.y]),
  Array.from(HP.cells)
    .map((c, i) => (c === EMPTY ? null : [PAD_I + (i % 5) * INDEX_PX + INDEX_PX / 2, PAD_I + Math.floor(i / 5) * INDEX_PX + INDEX_PX / 2 + 0.5]))
    .filter((v) => v !== null)
);

const cv8 = makeMockCanvas();
const r8 = Render.drawPattern(HP, cv8, { cellPx: 8, cellLabel: 'index', showRuler: false, padMode: 'normal' });
eq('drawPattern | cellPx=8 → 返回 codesDrawn:false（index 阈值 17）', r8.codesDrawn, false);
eq('drawPattern | cellPx=8 → 不写编号（fillText 0 次）', cv8._rec.fillText.length, 0);
eq('drawPattern | cellPx=8 → 仍然逐格填色', cellFillsOf(cv8).length, HP_NONEMPTY);
eq('drawPattern | cellPx=8 → pad = max(40, 8*3+20) = 44，画布宽 128', cv8._rec.fillRect[0].w, Math.max(40, 8 * 3 + 20) * 2 + HP.w * 8);

const cv9 = makeMockCanvas();
const r9 = Render.drawPattern(HP, cv9, { cellPx: 9, cellLabel: 'index', showRuler: false, padMode: 'normal' });
/* 阈值已提高：9px 在 index 模式（17）下同样画不出来，旧期望 codesDrawn:true 已过期 */
eq('drawPattern | cellPx=9 → codesDrawn:false（index 阈值 17）', r9.codesDrawn, false);
eq('drawPattern | cellPx=9 → 写编号次数 === 0', cv9._rec.fillText.length, 0);

const cvBad = { width: 0, height: 0 };
const rBad = Render.drawPattern(HP, cvBad, {});
/* 新契约：返回完整结果对象（含 ok/reason/尺寸/阈值），不再是旧的两键对象 */
eq('drawPattern | 无 getContext 的宿主不抛错且 ok === false', rBad.ok, false);
eq('drawPattern | 无 getContext 的宿主 reason === "invalid-input"', rBad.reason, 'invalid-input');
eq('drawPattern | 无 getContext 的宿主 cellsDrawn === 0', rBad.cellsDrawn, 0);
eq('drawPattern | 无 getContext 的宿主 labelsDrawn === false', rBad.labelsDrawn, false);
eq('drawPattern | 无 getContext 的宿主 width/height = 0', [rBad.width, rBad.height], [0, 0]);
eq('drawPattern | 无 getContext 的宿主 width/height 未写进宿主对象', [cvBad.width, cvBad.height], [0, 0]);
ok('drawPattern | 返回对象含冻结契约的 9 个键（新增 captionDrawn）', ['ok', 'cellsDrawn', 'labelsDrawn', 'labelsSuppressed', 'labelMinPx', 'width', 'height', 'codesDrawn', 'captionDrawn'].every((k) => k in rBad), Object.keys(rBad).join(','));
eq('drawPattern | codesDrawn 是 labelsDrawn 的别名', rBad.codesDrawn, rBad.labelsDrawn);

/* 真实 Pattern 的渲染整合（刻度开、标签默认 mode = code） */
const realPat = Pipeline.generateFromRGBA(synth(40, 30, (x, y) => [(x * 17) % 256, (y * 23) % 256, 128]), 40, 30, { boards: 1 });
const realNonEmpty = Array.from(realPat.cells).filter((c) => c !== EMPTY).length;
const cvR = makeMockCanvas();
const rR = Render.drawPattern(realPat, cvR, { cellPx: 12, padMode: 'normal' });
eq('整合 | 真实 Pattern（' + realPat.w + '×' + realPat.h + '）cellsDrawn === 非空格数', cvR._rec.fillRect.length - 1, realNonEmpty);
eq('整合 | 真实 Pattern 逐格填色位置与颜色精确匹配', cellFillsOf(cvR), expectedFills(realPat, 12, 56));
/* cellPx=12 下 code 模式被抑制 → 只剩刻度数字：w=29 有 6 个刻度、h=22 有 5 个刻度 */
eq('整合 | cellPx=12 → 标签被抑制，fillText 只剩刻度 6+5=11 个', cvR._rec.fillText.length, 11);
eq('整合 | cellPx=12 → labelsSuppressed === true', rR.labelsSuppressed, true);
/* 显式 cellLabel + cellPx ≥ 20 时才是「非空格数 + 刻度数」 */
const cvR2 = makeMockCanvas();
const rR2 = Render.drawPattern(realPat, cvR2, { cellPx: 20, cellLabel: 'index', padMode: 'normal' });
eq('整合 | cellPx=20 + cellLabel:index → fillText = 非空格数 + 刻度数', cvR2._rec.fillText.length, realNonEmpty + 11, 'w=29 有 6 个刻度、h=22 有 5 个刻度');
eq('整合 | cellPx=20 + cellLabel:index → labelsDrawn === true', rR2.labelsDrawn, true);

/* ══════════════════════════════════ 新增覆盖：标签模式 / 版式 / 守卫 / 刻度 / 板边界 */
/* 本次用 HP（5×4，色号 2 字符）作为标签用例的载体：code 阈值 20、index 阈值 17 */
const LABEL_PX = 24;
const LABEL_PAD = Math.max(40, LABEL_PX * 3 + 20);          // 92
const drawHP = (opts) => {
  const cv = makeMockCanvas();
  const r = Render.drawPattern(HP, cv, Object.assign({ showRuler: false, padMode: 'normal' }, opts));
  return { cv, r, texts: cv._rec.fillText.map((t) => t.text), pos: cv._rec.fillText.map((t) => [t.x, t.y]) };
};

const code24 = drawHP({ cellPx: LABEL_PX, cellLabel: 'code' });
const index24 = drawHP({ cellPx: LABEL_PX, cellLabel: 'index' });
const none24 = drawHP({ cellPx: LABEL_PX, cellLabel: 'none' });
eq('新增 | cellPx=24 + cellLabel:code → codesDrawn true 且填字次数 = 非空格数', [code24.r.codesDrawn, code24.texts.length], [true, HP_NONEMPTY]);
eq('新增 | cellLabel:code → 逐格文字 === colors[cells[i]].code', code24.texts, expectedLabels(HP, LABEL_PX, LABEL_PAD, 'code').map((o) => o.text));
eq('新增 | cellLabel:code → 逐格位置 === 格中心', code24.pos, expectedLabels(HP, LABEL_PX, LABEL_PAD, 'code').map((o) => [o.x, o.y]));
eq('新增 | cellLabel:index → 逐格文字 === String(cells[i]+1)', index24.texts, expectedLabels(HP, LABEL_PX, LABEL_PAD, 'index').map((o) => o.text));
eq('新增 | cellLabel:index → 逐格位置 === 格中心', index24.pos, expectedLabels(HP, LABEL_PX, LABEL_PAD, 'index').map((o) => [o.x, o.y]));
eq('新增 | cellLabel:none → 零 fillText', none24.texts.length, 0);
eq('新增 | cellLabel:none → labelsDrawn/labelsSuppressed/labelMinPx', [none24.r.labelsDrawn, none24.r.labelsSuppressed, none24.r.labelMinPx], [false, false, 0]);
eq('新增 | cellLabel:none → 仍然逐格填色', cellFillsOf(none24.cv).length, HP_NONEMPTY);

/* 阈值边界：code 19 不画 / 20 画；index 16 不画 / 17 画 */
const code19 = drawHP({ cellPx: 19, cellLabel: 'code' });
const code20 = drawHP({ cellPx: 20, cellLabel: 'code' });
const index16 = drawHP({ cellPx: 16, cellLabel: 'index' });
const index17 = drawHP({ cellPx: 17, cellLabel: 'index' });
eq('新增 | 阈值 | code@19 不画（codesDrawn/填字）', [code19.r.codesDrawn, code19.texts.length], [false, 0]);
eq('新增 | 阈值 | code@20 画（codesDrawn/填字）', [code20.r.codesDrawn, code20.texts.length], [true, HP_NONEMPTY]);
eq('新增 | 阈值 | code 的 labelsSuppressed / labelMinPx（19 / 20）', [code19.r.labelsSuppressed, code20.r.labelsSuppressed, code19.r.labelMinPx, code20.r.labelMinPx], [true, false, 20, 20]);
eq('新增 | 阈值 | index@16 不画（codesDrawn/填字）', [index16.r.codesDrawn, index16.texts.length], [false, 0]);
eq('新增 | 阈值 | index@17 画（codesDrawn/填字）', [index17.r.codesDrawn, index17.texts.length], [true, HP_NONEMPTY]);
eq('新增 | 阈值 | index 的 labelsSuppressed / labelMinPx（16 / 17）', [index16.r.labelsSuppressed, index17.r.labelsSuppressed, index16.r.labelMinPx, index17.r.labelMinPx], [true, false, 17, 17]);

/* 向后兼容：showCodes 旧键与 cellLabel 新键的优先级 */
const oldFalse = drawHP({ cellPx: LABEL_PX, cellLabel: undefined, showCodes: false });
const oldTrue = drawHP({ cellPx: LABEL_PX, cellLabel: undefined, showCodes: true });
const both = drawHP({ cellPx: LABEL_PX, cellLabel: 'code', showCodes: true });
const both2 = drawHP({ cellPx: LABEL_PX, cellLabel: 'index', showCodes: false });
const noKey = drawHP({ cellPx: LABEL_PX });
eq('新增 | 兼容 | {showCodes:false} → 零标签', oldFalse.texts.length, 0);
eq('新增 | 兼容 | {showCodes:false} → codesDrawn false', oldFalse.r.codesDrawn, false);
eq('新增 | 兼容 | {showCodes:true} 单独给出 → 走 index', oldTrue.texts, expectedLabels(HP, LABEL_PX, LABEL_PAD, 'index').map((o) => o.text));
eq('新增 | 兼容 | 两者同给时 cellLabel 优先（code 赢过 showCodes:true）', both.texts, expectedLabels(HP, LABEL_PX, LABEL_PAD, 'code').map((o) => o.text));
eq('新增 | 兼容 | 两者同给时 cellLabel 优先（index 赢过 showCodes:false）', both2.texts, expectedLabels(HP, LABEL_PX, LABEL_PAD, 'index').map((o) => o.text));
eq('新增 | 兼容 | 两个键都不给 → 默认 code（新语义）', noKey.texts, expectedLabels(HP, LABEL_PX, LABEL_PAD, 'code').map((o) => o.text));

/* padMode：normal 复现旧公式；tight 在 116 格 @24px 时白边约 4%，且不大于 normal */
const BIG = 116;
const bigPat = makePat(BIG, BIG, 3);
const dimsOf = (cv) => ({ pad: (cv.width - BIG * LABEL_PX) / 2, w: cv.width, h: cv.height });
const cvNormal = makeMockCanvas();
Render.drawPattern(bigPat, cvNormal, { cellPx: LABEL_PX, cellLabel: 'none', padMode: 'normal' });
const cvTight = makeMockCanvas();
Render.drawPattern(bigPat, cvTight, { cellPx: LABEL_PX, cellLabel: 'none', padMode: 'tight' });
const dN = dimsOf(cvNormal);
const dT = dimsOf(cvTight);
eq('新增 | padMode:normal 复现旧公式 max(40, cellPx*3+20)', dN.pad, Math.max(40, LABEL_PX * 3 + 20));
const tightRatio = (dT.w - BIG * LABEL_PX) / dT.w;
ok('新增 | padMode:tight 白边占比在 3%–6%（实测 ' + (tightRatio * 100).toFixed(2) + '%）', tightRatio >= 0.03 && tightRatio <= 0.06, tightRatio);
eq('新增 | padMode:tight 的 pad 实测 56（= round(2784×2%)，受刻度下限抬升）', dT.pad, 56);
ok('新增 | tight 的白边 ≤ normal 的白边', dT.pad <= dN.pad, dT.pad + ' vs ' + dN.pad);
eq('新增 | 未给 padMode 时默认 tight（与 tight 显式结果一致）', (() => { const cv = makeMockCanvas(); Render.drawPattern(bigPat, cv, { cellPx: LABEL_PX, cellLabel: 'none' }); return cv.width; })(), cvTight.width);

/* annotate：用量块落在网格下方（不重叠）；每块 = 圆角色块 + 色号 + 颗数，横向排布、自动换行 */
const cvAnnOff = makeMockCanvas();
Render.drawPattern(bigPat, cvAnnOff, { cellPx: LABEL_PX, cellLabel: 'none', padMode: 'tight', annotate: false });
const cvAnnOn = makeMockCanvas();
Render.drawPattern(bigPat, cvAnnOn, { cellPx: LABEL_PX, cellLabel: 'none', padMode: 'tight', annotate: true });
ok('新增 | annotate:true 画布更高（下方追加用量块）', cvAnnOn.height > cvAnnOff.height, cvAnnOff.height + ' → ' + cvAnnOn.height);
eq('新增 | annotate:false 时宽度不变、高度 = 宽度 + 尺寸标注高（网格本身是正方形）', [cvAnnOff.width, cvAnnOff.height - capH(LABEL_PX)], [cvAnnOn.width, cvAnnOn.width]);
eq('新增 | annotate:false 与 true 的宽度相同（块不比网格宽时不撑宽画布）', cvAnnOff.width, cvAnnOn.width);

const chipFills = cvAnnOn._rec.fills.filter((f) => f.fillStyle === '#F5F7FA');
eq('新增 | 每个色号一个圆角底块', chipFills.length, bigPat.counts.length);
ok('新增 | 底块走的是 roundRect（圆角），不是直角 fillRect', chipFills.length > 0 && chipFills.every((f) => f.path[0][0] === 'RR'), JSON.stringify(chipFills[0] ? chipFills[0].path[0] : null));
ok('新增 | 圆角半径为正（真的是圆角）', cvAnnOn._rec.roundRect.every((r) => r.r >= 1), JSON.stringify(cvAnnOn._rec.roundRect.slice(0, 2)));
const chipBoxes = chipFills.map((f) => ({ x: f.path[0][1], y: f.path[0][2], w: f.path[0][3], h: f.path[0][4] }));
const gridBottom = dT.pad + BIG * LABEL_PX;
const chipTop = Math.min.apply(null, chipBoxes.map((b) => b.y));
ok('新增 | 用量块顶 > 网格底（不遮挡网格）', chipTop > gridBottom, chipTop + ' > ' + gridBottom);
eq('新增 | 用量块顶 = 网格底 + gap（gap = max(2, round(cellPx*0.5))）', chipTop, gridBottom + Math.max(2, Math.round(LABEL_PX * 0.5)));
ok('新增 | 所有块都在画布内', chipBoxes.every((b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= cvAnnOn.width && b.y + b.h <= cvAnnOn.height), JSON.stringify(chipBoxes.slice(0, 2)));

const annTexts = cvAnnOn._rec.fillText.map((t) => t.text);
for (const row of bigPat.counts) {
  ok('用量块含色号 ' + row.code, annTexts.includes(row.code));
  ok('用量块含颗数 ' + row.count + ' 颗', annTexts.includes(row.count + ' 颗'));
  ok('用量块画了该色号的圆角块 ' + row.hex, cvAnnOn._rec.fills.some((f) => String(f.fillStyle).toUpperCase() === String(row.hex).toUpperCase()));
}
ok('用量块不再输出 HEX 文字（用户只要 色块 + 色号 + 颗数）', !annTexts.some((t) => String(t).startsWith('#')), JSON.stringify(annTexts.filter((t) => String(t).startsWith('#')).slice(0, 4)));
ok('新增 | annotate:false 时零用量块（无底块、无 HEX 文字）', !cvAnnOff._rec.fills.some((f) => f.fillStyle === '#F5F7FA') && !cvAnnOff._rec.fillText.some((t) => String(t.text).startsWith('#')));

/* 换行：窄容器下多个块必须自动折行，同一行内不重叠、全部在画布内 */
const wrapPat = makePat(7, 7, 5);
const cvWrap = makeMockCanvas();
Render.drawPattern(wrapPat, cvWrap, { cellPx: 20, cellLabel: 'none', padMode: 'tight', annotate: true });
const wrapBoxes = cvWrap._rec.fills.filter((f) => f.fillStyle === '#F5F7FA').map((f) => ({ x: f.path[0][1], y: f.path[0][2], w: f.path[0][3], h: f.path[0][4] }));
eq('换行 | 5 个块全部画出', wrapBoxes.length, 5);
const rowYs = Array.from(new Set(wrapBoxes.map((b) => b.y))).sort((a, b) => a - b);
ok('换行 | 窄容器下确实折成了多行', rowYs.length > 1, rowYs.length + ' 行');
let rowOverlap = 0, wrapOutside = 0;
for (const y of rowYs) {
  const line = wrapBoxes.filter((b) => b.y === y).sort((a, b) => a.x - b.x);
  for (let i = 1; i < line.length; i++) if (line[i].x < line[i - 1].x + line[i - 1].w) rowOverlap++;
}
for (const b of wrapBoxes) if (b.x < 0 || b.y < 0 || b.x + b.w > cvWrap.width || b.y + b.h > cvWrap.height) wrapOutside++;
eq('换行 | 同一行内的块不重叠', rowOverlap, 0);
eq('换行 | 所有块都在画布内', wrapOutside, 0);
const shortLine = wrapBoxes.filter((b) => b.y === rowYs[rowYs.length - 1]);
ok('换行 | 末行也比画布（容器）更靠内 → 该行有水平居中留白', shortLine.length > 0 && shortLine[0].x > 0, JSON.stringify(shortLine[0] || null));

/* 左下角尺寸标注：内容从 pattern 推导（不读 stats）、位置在网格左下、算进画布高 */
const capTop = (cellPx) => Math.max(4, Math.round(cellPx * 0.35));
const cvCap = makeMockCanvas();
const capPat = makePat(7, 4, 3);
capPat.beadMM = 2.6;
capPat.stats = { total: 0, usedColors: 0, boardX: 99, boardY: 99, cmW: 999, cmH: 999 };  // 故意写错：标注若读 stats 就会露馅
const rCap = Render.drawPattern(capPat, cvCap, { cellPx: 20, cellLabel: 'none', padMode: 'tight', annotate: false });
eq('尺寸标注 | 恰好画一次', cvCap._rec.caption.length, 1);
const capItem = cvCap._rec.caption[0] || { text: '', x: -1, y: -1, textAlign: '', textBaseline: '' };
eq('尺寸标注 | 文字全部由 pattern 推导（stats 故意写错 99 板 / 999cm 也不受影响）', capItem.text, '实际 7×4 格 · 共 28 颗');
eq('尺寸标注 | 左对齐', capItem.textAlign, 'left');
eq('尺寸标注 | 顶对齐（便于按底边定位）', capItem.textBaseline, 'top');
const capPad = (cvCap.width - 7 * 20) / 2;
eq('尺寸标注 | x 与网格左边缘对齐（左下角，不是画布最左）', capItem.x, capPad);
eq('尺寸标注 | y = 网格底 + 标注上间距', capItem.y, capPad + 4 * 20 + capTop(20));
ok('尺寸标注 | 落在网格下方（不遮挡图纸）', capItem.y > capPad + 4 * 20, capItem.y + ' > ' + (capPad + 4 * 20));
eq('尺寸标注 | 画布高 = 网格 + 标注高（标注确实被计入布局）', rCap.height, capPad * 2 + 4 * 20 + capH(20));
const cvCapAnn = makeMockCanvas();
Render.drawPattern(capPat, cvCapAnn, { cellPx: 20, cellLabel: 'none', padMode: 'tight', annotate: true });
eq('尺寸标注 | 开用量块时也画一次', cvCapAnn._rec.caption.length, 1);
const capItem2 = cvCapAnn._rec.caption[0] || { y: -1 };
const chipTopY = Math.min.apply(null, cvCapAnn._rec.fills.filter((f) => f.fillStyle === '#F5F7FA').map((f) => f.path[0][2]));
ok('尺寸标注 | 开用量块时标注在用量块【下方】（不重叠）', capItem2.y >= chipTopY + 24, capItem2.y + ' vs chips@' + chipTopY);
eq('尺寸标注 | 标注不混进「标签 + 刻度」的计数', cvCapAnn._rec.fillText.some((t) => /共 \d+ 颗/.test(String(t.text))), false);

/* ═════════════ 角标（新格式 + 分段降级 + captionDrawn）═════════════════
   新格式：【标题 ·】实际 a×b 格 · 共 N 颗【· 预计 X 小时 / X 分钟】
   —— 已无板数、无成品 cm。尺寸 = 非空格子包围盒；颗数 = 非空格子数；
   时长 = count / beadRate，不足 1 小时且分钟取整后 < 60 才写分钟（不出现「60 分钟」）。
   空间不足按固定次序掉段：先掉标题 → 再掉时长 → 再掉尺寸（「共 N 颗」最后幸存）。 */

const capTextsSeen = [];        // 本段画过的每一个角标文字：供「任何算例都不含 60 分钟」整体扫
function drawCaption(pat, viewOpts) {
  const cv = makeMockCanvas();
  const r = Render.drawPattern(pat, cv, viewOpts);
  const items = cv._rec.caption;
  const item = items.length ? items[0] : null;
  const text = item ? String(item.text) : '';
  if (text) capTextsSeen.push(text);
  return { cv: cv, r: r, items: items, item: item, text: text };
}
/* estTextW 的独立重述：render.js 按 UTF-16 码元算，> 0x2E80（CJK/全角）整字宽，其余 0.62 字宽 */
function estCaptionW(text, fontPx) {
  let w = 0;
  const s = String(text);
  for (let i = 0; i < s.length; i++) w += (s.charCodeAt(i) > 0x2E80 ? fontPx : 0.62 * fontPx);
  return w;
}
const capFontPx = (item) => parseInt(String(item.font), 10);
const capPadN = (cellPx) => Math.max(40, cellPx * 3 + 20);   // padOf 的 padMode:'normal' 路径
const capSegs = (t) => String(t).split(' · ');
const CAP_TITLE24 = '012345678901234567890123';              // 恰好 24 码点（上限）
const CAP_TITLE25 = CAP_TITLE24 + '4';                       // 25 码点（必须截断）
const capBase = { cellPx: 24, cellLabel: 'none', showRuler: false, padMode: 'normal', beadRate: 500 };
const capOpts = (extra) => Object.assign({}, capBase, extra || {});
const capPlain = (extra) => Object.assign({ cellPx: 20, cellLabel: 'none', showRuler: false, padMode: 'normal' }, extra || {});
const capPatOf = (w, h, filled, fn) => {
  const cells = new Uint16Array(w * h).fill(EMPTY);
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (fn ? fn(i % w, Math.floor(i / w)) : i < filled) { cells[i] = 0; n++; }
  }
  return { w: w, h: h, colors: [{ code: 'A1', hex: '#FF0000', rgb: [255, 0, 0], group: 'A' }], cells: cells, locked: new Uint8Array(w * h), counts: [], stats: {}, nonEmpty: n };
};
const capWide = makePat(116, 116, 2);      // 宽画布，13456 颗
const capRate = makePat(29, 29, 2);        // 841 颗
const capSmall = makePat(20, 20, 2);       // 400 颗
const capTiny = makePat(5, 5, 2);          // 25 颗

/* a) 尺寸 = 非空格子的包围盒（不是 w×h）；颗数 = 非空格子数 */
const bboxPat = capPatOf(10, 8, 0, (x, y) => x >= 2 && x <= 5 && y >= 3 && y <= 6);
eq('角标 | 包围盒 | 造出来的算例确实是 16 格非空（10×8 里第 3–6 行 × 第 2–5 列）', bboxPat.nonEmpty, 16);
const bboxRes = drawCaption(bboxPat, capPlain());
eq('角标 | 尺寸段 = 非空格子的包围盒（4×4，而不是整张 10×8）', bboxRes.text, '实际 4×4 格 · 共 16 颗');
eq('角标 | 颗数段 = 自己重数的非空格子数，且 === cellsDrawn',
  [bboxRes.text.indexOf('共 ' + bboxPat.nonEmpty + ' 颗') >= 0, bboxRes.r.cellsDrawn], [true, bboxPat.nonEmpty]);
eq('角标 | 全填满时尺寸段 = w×h', drawCaption(makePat(7, 4, 3), capPlain()).text, '实际 7×4 格 · 共 28 颗');

/* b) 时长分支：小时档 / 分钟档 / 接缝（不允许出现「60 分钟」） */
const capHour = drawCaption(capRate, capPlain({ cellPx: 8, captionName: CAP_TITLE24, beadRate: 500 }));
ok('角标 | 时长 | 841 颗 @500 → 预计 1.7 小时（回归）', / · 预计 1\.7 小时$/.test(capHour.text), capHour.text);
const capMin = drawCaption(capSmall, capOpts({ captionName: CAP_TITLE24 }));   // 400 颗 @24
const capMinM = / · 预计 (\d+) 分钟$/.exec(capMin.text);
ok('角标 | 时长 | 400 颗 @500 → 不足 1 小时走分钟档（不再有「预计 0.0 小时」）', !!capMinM, capMin.text);
ok('角标 | 时长 | 分钟数 ≥ 1（不会出现「预计 0 分钟」）', !!capMinM && Number(capMinM[1]) >= 1, capMin.text);
const cap16 = drawCaption(bboxPat, capPlain({ beadRate: 500 }));               // 16 颗 @20
eq('角标 | 时长 | 16 颗 @500 → 恰好「实际 4×4 格 · 共 16 颗 · 预计 2 分钟」', cap16.text, '实际 4×4 格 · 共 16 颗 · 预计 2 分钟');
const cap1 = drawCaption(capPatOf(29, 29, 1), capPlain({ cellPx: 24, beadRate: 500 }));   // 29×29 网格里只放 1 颗
eq('角标 | 时长 | 1 颗 @500 → 恰好「实际 1×1 格 · 共 1 颗 · 预计 1 分钟」', cap1.text, '实际 1×1 格 · 共 1 颗 · 预计 1 分钟');
/* 接缝：分钟取整到 60 时必须进位成小时。25×20 = 500 格，前 N 格非空 */
const seamPat = (n) => capPatOf(25, 20, n);
const seam = (n) => drawCaption(seamPat(n), capPlain({ cellPx: 24, beadRate: 500 })).text;
const seamTexts = [494, 495, 496, 497, 499, 500].map((n) => [n, seam(n)]);
ok('角标 | 时长接缝 | 六个算例的颗数段都写对了（证明算例真的是前 N 格非空）',
  seamTexts.every((s) => s[1].indexOf('共 ' + s[0] + ' 颗') >= 0), seamTexts.map((s) => s[1]).join(' | '));
eq('角标 | 时长接缝 | 494 颗 @500 → 预计 59 分钟', / · 预计 59 分钟$/.test(seam(494)), true);
eq('角标 | 时长接缝 | 495 颗 @500 → 预计 59 分钟（59.4 分钟取整仍是 59）', / · 预计 59 分钟$/.test(seam(495)), true);
for (const n of [496, 497, 499, 500]) {
  ok('角标 | 时长接缝 | ' + n + ' 颗 @500 → 预计 1.0 小时（分钟取整到 60 必须进位，不允许「预计 60 分钟」）',
    / · 预计 1\.0 小时$/.test(seam(n)), seam(n));
}
for (const bad of [['0', 0], ['负数 -3', -3], ['NaN', NaN], ['undefined', undefined], ['字符串 "500"', '500'], ['Infinity', Infinity], ['null', null]]) {
  const badRes = drawCaption(capSmall, capOpts({ captionName: CAP_TITLE24, beadRate: bad[1] }));
  ok('角标 | 时长 | beadRate=' + bad[0] + ' → 整段省略（无 预计 / 分钟 / 小时 / Infinity / NaN）',
    /预计|分钟|小时|Infinity|NaN/.test(badRes.text) === false, badRes.text);
}

/* c) 非空格子为 0 → 没有角标，也不留空白带 */
const capEmptyPat = capPatOf(10, 8, 0);
const capEmpty = drawCaption(capEmptyPat, capPlain());
eq('角标 | 非空格子为 0 → 角标一次 fillText 都不画', [capEmpty.items.length, capEmpty.cv._rec.fillText.length], [0, 0]);
eq('角标 | 非空格子为 0 → captionDrawn === false', capEmpty.r.captionDrawn, false);
eq('角标 | 非空格子为 0 → 画布高 = pad*2 + gridH（角标带高度 0）', capEmpty.r.height, capPadN(20) * 2 + 8 * 20);
eq('角标 | 非空格子为 0 → 比同尺寸「有角标」的图矮一整个角标带 capH', bboxRes.r.height - capEmpty.r.height, capH(20));

/* d) 标题：空 / 全空白 / 非字符串 → 整段省略；> 24 码点 → 23 字 + 「…」 */
for (const t of [['空串', ''], ['全空白', '   '], ['number', 123], ['null', null], ['undefined', undefined], ['对象', {}]]) {
  const res = drawCaption(capWide, capOpts({ captionName: t[1] }));
  eq('角标 | 标题=' + t[0] + ' → 没有标题段（首段就是尺寸段，没有前导「 · 」）', capSegs(res.text)[0], '实际 116×116 格');
}
const capT25 = drawCaption(capWide, capOpts({ captionName: CAP_TITLE25 }));
const capT25Head = capSegs(capT25.text)[0];
eq('角标 | 标题 | 超 24 码点 → 截断为 23 字 + 「…」', [Array.from(capT25Head).length, capT25Head.slice(-1)], [24, '…']);
eq('角标 | 标题 | 截断取的是前 23 个码点', capT25Head, CAP_TITLE25.slice(0, 23) + '…');
eq('角标 | 标题 | 恰好 24 码点 → 原样保留（不截断、不加 …）', capSegs(drawCaption(capWide, capOpts({ captionName: CAP_TITLE24 })).text)[0], CAP_TITLE24);
eq('角标 | 标题 | 去首尾空白后使用', capSegs(drawCaption(capWide, capOpts({ captionName: '  AB  ' })).text)[0], 'AB');

/* e) 分段降级：先掉标题 → 再掉时长 → 再掉尺寸 */
const lad1 = drawCaption(capWide, capOpts({ captionName: CAP_TITLE24 }));
const lad2 = drawCaption(capRate, capPlain({ cellPx: 8, captionName: CAP_TITLE24, beadRate: 500 }));
const lad3 = drawCaption(capSmall, capPlain({ cellPx: 9, captionName: CAP_TITLE24, beadRate: 500 }));
const lad4 = drawCaption(capTiny, capPlain({ cellPx: 9, captionName: CAP_TITLE24, beadRate: 500 }));
eq('角标 | 降级 | 档 1（116×116@24）四段全在', capSegs(lad1.text).length, 4);
ok('角标 | 降级 | 档 1 的内容 = 标题 + 尺寸 + 颗数 + 时长',
  capSegs(lad1.text)[0] === CAP_TITLE24 && capSegs(lad1.text)[1] === '实际 116×116 格'
  && capSegs(lad1.text)[2] === '共 13456 颗' && /^预计 [\d.]+ (小时|分钟)$/.test(capSegs(lad1.text)[3]), lad1.text);
eq('角标 | 降级 | 档 2（29×29@8 + 标题 + rate500）先掉标题、保时长', lad2.text, '实际 29×29 格 · 共 841 颗 · 预计 1.7 小时');
eq('角标 | 降级 | 档 3（20×20@9 + 标题 + rate500）再掉时长，只剩尺寸 + 颗数', lad3.text, '实际 20×20 格 · 共 400 颗');
eq('角标 | 降级 | 档 4（5×5@9）「共 N 颗」是最后幸存者', lad4.text, '共 25 颗');
eq('角标 | 降级 | 段数逐档递减 4 → 3 → 2 → 1', [lad1, lad2, lad3, lad4].map((x) => capSegs(x.text).length), [4, 3, 2, 1]);
ok('角标 | 降级 | 次序证据 1：存在「没有标题但有时长」的一档（掉标题早于掉时长）',
  lad2.text.indexOf(CAP_TITLE24) < 0 && lad2.text.indexOf('预计 ') > 0, lad2.text);
ok('角标 | 降级 | 次序证据 2：存在「有尺寸但没有时长」的一档（掉时长早于掉尺寸）',
  /^实际 /.test(lad3.text) && lad3.text.indexOf('预计') < 0, lad3.text);
const capTinyRes = drawCaption(capTiny, capPlain({ cellPx: 8, captionName: CAP_TITLE24, beadRate: 500 }));
eq('角标 | 降级 | 极窄（5×5@8）→ captionDrawn === false', capTinyRes.r.captionDrawn, false);
eq('角标 | 降级 | 极窄 → 角标带高度 0（画布高 = pad*2 + gridH）', capTinyRes.r.height, capPadN(8) * 2 + 5 * 8);
eq('角标 | 降级 | 极窄 → 与「无标题无速率」的同尺寸算例画布高完全相同',
  capTinyRes.r.height, drawCaption(capTiny, { cellPx: 8, cellLabel: 'none', showRuler: false, padMode: 'normal' }).r.height);

/* f) 返回值键集：正常 9 键 / too-large 12 键；captionDrawn 的四个 false 分支 */
const capKeys = (o) => Object.keys(o).sort().join(',');
eq('角标 | 返回值 | 正常路径 9 键（含 captionDrawn）', capKeys(lad1.r),
  'captionDrawn,cellsDrawn,codesDrawn,height,labelMinPx,labelsDrawn,labelsSuppressed,ok,width');
const capBig = Render.drawPattern(capWide, makeMockCanvas(), { cellPx: 256, cellLabel: 'none', padMode: 'normal' });
eq('角标 | 返回值 | too-large 路径 12 键（含 captionDrawn/needPixels/maxPixels）', capKeys(capBig),
  'captionDrawn,cellsDrawn,codesDrawn,height,labelMinPx,labelsDrawn,labelsSuppressed,maxPixels,needPixels,ok,reason,width');
eq('角标 | captionDrawn | 正常画出来 → true', lad1.r.captionDrawn, true);
eq('角标 | captionDrawn | 降级到不画 → false', capTinyRes.r.captionDrawn, false);
eq('角标 | captionDrawn | 非空格子为 0 → false', capEmpty.r.captionDrawn, false);
eq('角标 | captionDrawn | too-large → false', capBig.captionDrawn, false);
eq('角标 | captionDrawn | invalid-input → false', Render.drawPattern(capSmall, { width: 0, height: 0 }, { cellPx: 20 }).captionDrawn, false);

/* g) 画布宽度不受角标影响（app.js 的 hitTestCell 靠「宽度 - w*cellPx」反推 pad） */
for (const dims of [[29, 29, 24], [10, 8, 20], [116, 116, 24]]) {
  const p = makePat(dims[0], dims[1], 2);
  const wEmpty = drawCaption(p, capOpts({ cellPx: dims[2], captionName: '' })).r.width;
  const wTitle = drawCaption(p, capOpts({ cellPx: dims[2], captionName: CAP_TITLE24 })).r.width;
  ok('角标 | 宽度不变量 | ' + dims[0] + '×' + dims[1] + '@' + dims[2] + ' 空标题与 24 字标题 width 完全相同且 > 0',
    wEmpty === wTitle && wEmpty > 0, wEmpty + ' vs ' + wTitle);
}

/* h) 角标永不超出画布（x + 估算宽度 <= 画布宽度） */
const capOverflowCases = [
  ['116×116@24 四段', capWide, capOpts({ captionName: CAP_TITLE24 })],
  ['29×29@8 三段', capRate, capPlain({ cellPx: 8, captionName: CAP_TITLE24, beadRate: 500 })],
  ['20×20@9 两段', capSmall, capPlain({ cellPx: 9, captionName: CAP_TITLE24, beadRate: 500 })],
  ['5×5@9 一段', capTiny, capPlain({ cellPx: 9, captionName: CAP_TITLE24, beadRate: 500 })],
  ['20×20@24 分钟档', capSmall, capOpts({ captionName: CAP_TITLE24 })],
  ['10×8@20 裸算例', bboxPat, capPlain()]
];
const capOverflowBad = [];
for (const c of capOverflowCases) {
  const res = drawCaption(c[1], c[2]);
  if (!res.item) { capOverflowBad.push(c[0] + '：没画角标'); continue; }
  const est = estCaptionW(res.text, capFontPx(res.item));
  if (!(res.item.x + est <= res.r.width)) capOverflowBad.push(c[0] + '：' + (res.item.x + est) + ' > ' + res.r.width);
}
eq('角标 | 永不超出画布：6 个算例里溢出的个数为 0', capOverflowBad.length, 0);
eq('角标 | 永不超出画布：这 6 个算例都真的画了角标（否则上一条是空转）',
  capOverflowCases.filter((c) => drawCaption(c[1], c[2]).item !== null).length, capOverflowCases.length);

/* i) 独占色 #616B7A：只出现在角标上，不混进格内标签 / 刻度 / 用量块 */
const capInkCv = makeMockCanvas();
const capInkRes = Render.drawPattern(makePat(40, 30, 3), capInkCv,
  { cellPx: 24, cellLabel: 'code', showRuler: true, annotate: true, padMode: 'normal', captionName: CAP_TITLE24, beadRate: 500 });
const capOtherTexts = capInkCv._rec.fillText;
eq('角标 | 独占色 | 角标恰好写一次', capInkCv._rec.caption.length, 1);
eq('角标 | 独占色 | 角标那次 fillStyle 就是字面量 #616B7A', (capInkCv._rec.caption[0] || {}).fillStyle, '#616B7A');
eq('角标 | 独占色 | 标签 / 刻度 / 用量块这三类 fillText 里 #616B7A 出现 0 次',
  capOtherTexts.filter((t) => t.fillStyle === CAPTION_INK).length, 0);
ok('角标 | 独占色 | 该算例的角标文字确实是新格式（不是把别的东西误当角标）',
  /^012345678901234567890123 · 实际 40×30 格 · 共 1200 颗 · 预计 /.test(capInkCv._rec.caption[0].text), capInkCv._rec.caption[0].text);
ok('角标 | 独占色 | 非角标文字确实有三类（颜色种数 ≥ 3，覆盖不是空的）',
  new Set(capOtherTexts.map((t) => t.fillStyle)).size >= 3,
  'fillText=' + capOtherTexts.length + ' styles=' + JSON.stringify(Array.from(new Set(capOtherTexts.map((t) => t.fillStyle)))));

/* j) 本段整体扫描：覆盖上面画过的每一个角标文字（不只看某几个算例） */
const capMinuteNums = capTextsSeen.map((t) => /预计 (\d+) 分钟$/.exec(t)).filter(Boolean).map((m) => Number(m[1]));
ok('角标 | 整体扫描 | 本段共画过 ' + capTextsSeen.length + ' 个角标，其中分钟档 ' + capMinuteNums.length + ' 个，数值全部落在 1–59',
  capTextsSeen.length >= 10 && capMinuteNums.length > 0 && capMinuteNums.every((n) => n >= 1 && n <= 59), JSON.stringify(capMinuteNums));
ok('角标 | 整体扫描 | 任何角标文字都不含「预计 0 分钟」或「预计 60 分钟」',
  capTextsSeen.every((t) => !/预计 (?:0|60) 分钟/.test(t)),
  capTextsSeen.filter((t) => /预计 (?:0|60) 分钟/.test(t)).join(' | '));
ok('角标 | 整体扫描 | 任何角标文字都不含旧格式残留（板 / 块板 / 成品约 / cm）',
  capTextsSeen.every((t) => !/块板|成品约|cm$/.test(t)),
  capTextsSeen.filter((t) => /块板|成品约|cm$/.test(t)).join(' | '));


/* 面积守卫：先算后画，超限时连画布尺寸都不设置 */
const cvGuard = makeMockCanvas();
const rGuard = Render.drawPattern(bigPat, cvGuard, { cellPx: 256, cellLabel: 'none', padMode: 'normal' });
eq('新增 | 面积守卫 ok === false', rGuard.ok, false);
eq('新增 | 面积守卫 reason === "too-large"', rGuard.reason, 'too-large');
ok('新增 | 面积守卫 needPixels > maxPixels', rGuard.needPixels > rGuard.maxPixels, rGuard.needPixels + ' > ' + rGuard.maxPixels);
eq('新增 | 面积守卫 maxPixels === 120000000', rGuard.maxPixels, 120000000);
ok('新增 | 面积守卫仍报告计划尺寸（供 UI 出提示）', rGuard.width > 0 && rGuard.height > 0, rGuard.width + '×' + rGuard.height);
eq('新增 | 面积守卫 canvas 未被设置尺寸', [cvGuard.width, cvGuard.height], [0, 0]);
eq('新增 | 面积守卫零绘制调用', [cvGuard._rec.fillRect.length, cvGuard._rec.fillText.length, cvGuard._rec.strokes.length, cvGuard._rec.save, cvGuard._rec.restore], [0, 0, 0, 0, 0]);

/* 刻度恒定每 5 格：与 cellPx 无关 */
const rulerCounts = [12, 24, 64].map((px) => {
  const cv = makeMockCanvas();
  Render.drawPattern(bigPat, cv, { cellPx: px, cellLabel: 'none', padMode: 'normal' });
  return cv._rec.fillText.length;
});
eq('新增 | 116 格刻度标签数 = rulerPositions(116)×2 = 27×2 = 54', rulerCounts[1], 54);
ok('新增 | 刻度标签数远小于格数（< 60）', rulerCounts[1] < 60, rulerCounts[1]);
ok('新增 | 刻度数与 cellPx 无关（12 / 24 / 64 相同）', rulerCounts[0] === rulerCounts[1] && rulerCounts[1] === rulerCounts[2], rulerCounts.join(' / '));

/* 板边界线：ceil(宽/29) + ceil(高/29) 条，末格补线正确（100 / 116 都不是 29 的整数倍关系） */
const BOARD_PX = 4;
for (const n of [29, 87, 100, 116]) {
  const pat = makePat(n, n, 2);
  const cv = makeMockCanvas();
  Render.drawPattern(pat, cv, { cellPx: BOARD_PX, cellLabel: 'none', padMode: 'normal' });
  const strokes = cv._rec.strokes;
  const perSide = Math.ceil(n / 29);
  const pad = Math.max(40, BOARD_PX * 3 + 20);
  eq('新增 | 板边界 | ' + n + '×' + n + ' 的线数 = 2×ceil(' + n + '/29) + 刻度 1', strokes.length - 1, 2 * perSide + 1);
  eq('新增 | 板边界 | ' + n + '×' + n + ' 竖线位置（末格补线）', strokes.slice(1, 1 + perSide).map((s) => s.path[0][1] - pad), expectBoardOffsets(n, BOARD_PX));
  eq('新增 | 板边界 | ' + n + '×' + n + ' 横线位置（末格补线）', strokes.slice(1 + perSide, 1 + 2 * perSide).map((s) => s.path[0][2] - pad), expectBoardOffsets(n, BOARD_PX));
}
eq('新增 | 板边界 | 细网格线仍是第 1 条路径（116×116 的 2×(117+117)）', (() => { const cv = makeMockCanvas(); Render.drawPattern(makePat(116, 116, 2), cv, { cellPx: BOARD_PX, cellLabel: 'none', padMode: 'normal' }); return cv._rec.strokes[0].path.length; })(), 2 * (117 + 117));

/* exportCSV */
const csvA = Render.exportCSV(HP);
const csvB = Render.exportCSV(HP);
ok('exportCSV | 首字符是 BOM', csvA.charCodeAt(0) === 0xfeff);
ok('exportCSV | 且只有 1 个 BOM（不重复）', csvA.split('\uFEFF').length - 1 === 1);
const csvLines = csvA.replace(/^\uFEFF/, '').split('\r\n');
eq('exportCSV | 行数 = 用到的色号数(3) + 表头 + 合计行', csvLines.filter((l) => l !== '').length, 3 + 2);
eq('exportCSV | 末尾以 CRLF 结束', csvA.slice(-2), '\r\n');
ok('exportCSV | 只有 CRLF，无孤立 LF', !/[^\r]\n/.test(csvA));
ok('exportCSV | 无孤立 CR', !/\r[^\n]/.test(csvA));
eq('exportCSV | 表头字段', csvLines[0], '编号,色号,颜色名,HEX,R,G,B,颗数');
const dataRows = csvLines.slice(1).filter((l) => l !== '' && !l.startsWith('合计'));
eq('exportCSV | 数据行数 = 用到的色号数', dataRows.length, 3);
eq('exportCSV | 数据行首列编号从 1 递增', dataRows.map((l) => l.split(',')[0]), ['1', '2', '3']);
eq('exportCSV | 各色颗数之和 === 非空格子数', dataRows.reduce((s, l) => s + Number(l.split(',').pop()), 0), HP_NONEMPTY);
eq('exportCSV | 合计行颗数 === 非空格子数', Number(csvLines.filter((l) => l.startsWith('合计'))[0].split(',').pop()), HP_NONEMPTY);
ok('exportCSV | 两次调用输出完全一致', csvA === csvB);

/* legendHTML */
const EVIL = {
  w: 5,
  h: 4,
  colors: [
    { code: '<script>alert(1)', hex: '#FF0000', rgb: [255, 0, 0], group: 'A' },
    { code: 'B&"2', hex: 'javascript:alert(2)', rgb: [0, 255, 0], group: 'B' },
    { code: 'C3', hex: '#0000FF', rgb: [0, 0, 255], group: 'C' },
  ],
  cells: HP.cells,
  locked: new Uint8Array(20),
};
const legend = Render.legendHTML(EVIL);
ok('legendHTML | 用到的色号都出现在图例里', ['1', '2', '3'].every((n) => legend.includes('pd-legend-no')));
eq('legendHTML | 行数 = 用到的色号数', legend.split('\n').length, 3);
ok('legendHTML | `<` 被转义为 &lt;', legend.includes('&lt;'));
ok('legendHTML | `&` 被转义为 &amp;', legend.includes('&amp;'));
ok('legendHTML | `"` 被转义为 &quot;', legend.includes('&quot;'));
ok('legendHTML | 输出里没有活的 <script', !/<script/i.test(legend));
ok('legendHTML | 非法 hex 被兜底为 #000000（不注入 javascript:）', !legend.includes('javascript:') && legend.includes('background-color:#000000'));
ok('legendHTML | 无外链（无 http(s):// 与 <a href）', !/https?:\/\//i.test(legend) && !/<a\b/i.test(legend));
ok('legendHTML | 空 Pattern 不抛错', Render.legendHTML({ colors: [], cells: [] }) === '');

/* 不可变性：一串渲染/导出调用后 Pattern 快照不变 */
ok('不可变性 | 手造 Pattern 渲染+导出后快照不变', JSON.stringify({ c: Array.from(HP.cells), l: Array.from(HP.locked), colors: HP.colors }) === hpSnap);
const realSnap = JSON.stringify(realPat);
const legendSnap = JSON.stringify({ cells: Array.from(EVIL.cells), colors: EVIL.colors });
Render.drawPattern(realPat, makeMockCanvas(), { showCodes: true, showRuler: true, cellPx: 20, highlightLocked: true });
Render.drawCompare(realPat, { width: 40, height: 30 }, makeMockCanvas(), { cellPx: 6 });
Render.exportCSV(realPat);
Render.legendHTML(realPat);
ok('不可变性 | drawPattern/drawCompare/exportCSV/legendHTML 后 Pattern 快照不变', JSON.stringify(realPat) === realSnap);
Render.legendHTML(EVIL);
ok('不可变性 | legendHTML 不改 colors/cells', JSON.stringify({ cells: Array.from(EVIL.cells), colors: EVIL.colors }) === legendSnap);

/* exportPNG 的失败路径（无 DOM 时必须拒绝而不是静默成功） */
let pngRejected = false;
let pngMsg = '';
try {
  await Render.exportPNG({}, 'x.png');
} catch (e) {
  pngRejected = e instanceof Error;
  pngMsg = e && e.message;
}
ok('exportPNG | 不支持 toBlob 的 canvas 明确 reject(Error)', pngRejected, 'message=' + pngMsg);
ok('exportPNG | reject 信息非空且可读', pngMsg.length > 8, pngMsg);

/* ═════════════════════════════════════════════════════════ 第 5 组 · 产物 */
startGroup('第 5 组 · 产物（拼豆图纸生成器.html）');
const productExists = existsSync(PRODUCT);
ok('产物文件存在', productExists, PRODUCT);
if (!productExists) {
  console.log('  INFO  产物不存在：先跑 `node build.mjs` 再跑本脚本');
} else {
  const html = readFileSync(PRODUCT, 'utf8');
  const size = statSync(PRODUCT).size;
  ok('以 <!doctype html> 开头', html.slice(0, 15).toLowerCase() === '<!doctype html>', JSON.stringify(html.slice(0, 30)));
  ok('无 BOM（首字符不是 U+FEFF）', html.charCodeAt(0) !== 0xfeff);
  ok('含 <meta charset="utf-8">', html.includes('<meta charset="utf-8">'));
  ok('含 <meta name="viewport" ...>', /<meta\s+name="viewport"/.test(html));
  ok('含 <html lang="zh-CN">', html.includes('<html lang="zh-CN">'));
  ok('含 <title>拼豆图纸生成器</title>', html.includes('<title>拼豆图纸生成器</title>'));
  ok('含 </html> 收尾', /<\/html>\s*$/.test(html));

  const openTags = html.match(/<script[^>]*>/gi) || [];
  const closeTags = html.match(/<\/script/gi) || [];
  eq('恰好 6 个 <script> 开标签', openTags.length, 6);
  eq('恰好 6 个 </script 闭标签', closeTags.length, 6);
  ok('全部脚本都是内联（开标签无属性）', openTags.every((t) => t.toLowerCase() === '<script>'), openTags.join(' | '));
  ok('无 <script src=...> 外链脚本', !/<script\b[^>]*\ssrc\s*=/i.test(html));
  ok('无 <link 标签', !/<link\b/i.test(html));
  ok('无 @import', !/@import/i.test(html));
  /* 以下 4 条正则与 build.mjs 的 RESOURCE_RULES 逐字同源，属独立二次确认。
   * 前缀 [^\w$] 而非空白白名单：覆盖 `el.href = "https://…"` 形式的属性赋值，
   * 同时不误伤 `source: "https://…"`（src 后跟 e 不跟 =）。 */
  ok('无 src= 指向 http(s):// 或 //', !/(?:^|[^\w$])src\s*=\s*["']?\s*(?:https?:)?\/\//i.test(html));
  ok('无 href= 指向 http(s):// 或 //', !/(?:^|[^\w$])href\s*=\s*["']?\s*(?:https?:)?\/\//i.test(html));
  ok("无 setAttribute('src'|'href', http(s)://…)", !/setAttribute\s*\(\s*["'](?:src|href)["']\s*,\s*["']\s*(?:https?:)?\/\//i.test(html));
  ok('无 XMLHttpRequest', !/XMLHttpRequest/.test(html));
  ok('无 new Worker(', !/\bnew\s+Worker\s*\(/.test(html));
  ok('无 import( 动态导入', !/\bimport\s*\(/.test(html));
  ok('无 require( CJS 加载', !/\brequire\s*\(/.test(html));
  ok('产物无 NUL/BEL 控制字符（可安全文本 diff）', !/[\u0000\u0007]/.test(html));

  ok('产物大小在 100KB–3MB 合理区间', size >= 100 * 1024 && size <= 3 * 1024 * 1024, '实际 ' + size + ' 字节 = ' + (size / 1024).toFixed(1) + ' KB');
  info('产物度量：' + PRODUCT);
  info('产物度量：' + size + ' 字节 · ' + (html.match(/\n/g) || []).length + ' 行（换行符计数口径，与 build.mjs 一致）');

  /* 按 <script> 切削并重新 eval（证明产物真的能跑，而不是「文本上有这些代码」） */
  const bodies = [];
  const reTag = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = reTag.exec(html)) !== null) bodies.push(m[1]);
  eq('按 <script> 切出 6 段脚本', bodies.length, 6);
  ok('内联 JS 段里无 `</' + 'script` 残留字面量（安全阀二次确认）', bodies.every((b) => !/<\/script/i.test(b)));
  ok('6 段脚本全部位于 <body> 内', html.indexOf('<script>') > html.indexOf('<body>') && html.indexOf('<script>') > html.indexOf('</head>'));

  const BANNERS = ['src/palette.js', 'src/color.js', 'src/pipeline.js', 'src/render.js', 'src/srcedit.js', 'src/app.js'];
  const bannerText = (n) => '/* ===== ' + n + ' ===== */';
  eq(
    '6 段脚本的横幅（即来源与顺序）为 palette → color → pipeline → render → srcedit → app',
    bodies.map((b, i) => (b.includes(bannerText(BANNERS[i])) ? BANNERS[i] : '(第' + (i + 1) + '段横幅不符)')),
    BANNERS
  );
  ok('每段脚本恰好含 1 个来源横幅（切削点干净，没有串段）', bodies.every((b) => BANNERS.filter((n) => b.includes(bannerText(n))).length === 1));
  ok('整份 HTML 里 6 个来源横幅按顺序出现', BANNERS.every((n, i) => html.indexOf(bannerText(n)) > (i === 0 ? -1 : html.indexOf(bannerText(BANNERS[i - 1])))));
  /* 新模块必须真的在产物里（而不是只有文件在 src/ 下）：app.js 靠 window.SourceEdit 决定
     裁剪 / 旋转是否可用，漏内联会静默退回"直接用原图"。 */
  ok('产物内确实含 src/srcedit.js 段（不只是 src/ 下有这个文件）', typeof srcText['srcedit.js'] === 'string' && bodies[4].includes(bannerText('src/srcedit.js')));
  const srceditInline = bodies[4].replace(/^\n\/\* ===== src\/srcedit\.js ===== \*\/\n/, '').replace(/\n$/, '');
  ok('产物内 srcedit 段与 src/srcedit.js 逐字符相同（原样内联，无改写）', srceditInline === srcText['srcedit.js'].replace(/\s+$/, ''), Buffer.byteLength(srceditInline, 'utf8') + ' vs ' + Buffer.byteLength(srcText['srcedit.js'].replace(/\s+$/, ''), 'utf8'));

  /* ── 产物新鲜度：7 个内联段（ui.html + 6 个模块）逐字节比对 ─────────────
     真实漏洞：旧套件只比对 srcedit 那一段，于是「src/ 改了但没跑 node build.mjs」
     照样 50/50 全绿 —— 而产物里的 toolWand / tabBasic / maxColorsVal / effCurve 根本不存在。
     只在文本上「含有这些代码」的检查等于没有检查，所以这里逐字节比对全部 7 段，
     并由紧随其后的正向 / 负向对照证明它既会通过、也会红、而且能指出是哪一段。 */
  const BARE_FILES = BANNERS.map((b) => b.replace(/^src\//, ''));
  const trimTailText = (s) => String(s).replace(/\s+$/, '');
  const segmentOpen = (file) => '\n<script>\n' + bannerText('src/' + file) + '\n';
  /* 段边界：[start, end) —— ui.html 段从 <body>\n 到第 1 个 \n<script>\n；模块段从横幅行之后到 \n</script> */
  function segmentSpan(text, file) {
    if (file === 'ui.html') {
      const bodyAt = text.indexOf('<body>\n');
      const firstScript = text.indexOf('\n<script>\n');
      if (bodyAt < 0 || firstScript <= bodyAt) return null;
      return [bodyAt + '<body>\n'.length, firstScript];
    }
    const open = segmentOpen(file);
    const at = text.indexOf(open);
    if (at < 0) return null;
    const start = at + open.length;
    const end = text.indexOf('\n</script>', start);
    return end < 0 ? null : [start, end];
  }
  function productSegmentReport(text) {
    const rows = [];
    for (const file of ['ui.html'].concat(BARE_FILES)) {
      const src = (file === 'ui.html') ? readSrc('ui.html') : srcText[file];
      const head = (file === 'ui.html') ? '产物第 0 段（ui.html）' : ('产物第 ' + (BARE_FILES.indexOf(file) + 1) + ' 段（src/' + file + '）');
      const name = head + ' 与 src/' + file + ' 逐字节相同';
      if (src === undefined || src === null) { rows.push({ file: file, name: name, ok: false, detail: 'src/' + file + ' 读取失败' }); continue; }
      const span = segmentSpan(text, file);
      if (!span) { rows.push({ file: file, name: name, ok: false, detail: '截取失败：产物里找不到该段的边界' }); continue; }
      const expected = trimTailText(src);
      const inline = text.slice(span[0], span[1]);
      const same = inline === expected;
      rows.push({ file: file, name: name, ok: same, detail: Buffer.byteLength(inline, 'utf8') + ' vs ' + Buffer.byteLength(expected, 'utf8') + ' 字节' + (same ? '' : '（不一致）') });
    }
    return { rows: rows, ok: rows.every((r) => r.ok), failed: rows.filter((r) => !r.ok).map((r) => r.file) };
  }
  const segRep = productSegmentReport(html);
  for (const row of segRep.rows) ok(row.name, row.ok, row.detail);
  ok('产物新鲜度 | 7 个内联段全部与 src/ 逐字节一致（任一段不符 → 上面已逐段报红）', segRep.ok,
    segRep.ok ? '' : ('不一致的段：' + segRep.failed.join('、') + '（多半是 src/ 改了却没跑 node build.mjs）'));
  ok('产物新鲜度 | 每个模块段的开口标记在产物里唯一（切削点无歧义）',
    BARE_FILES.every((f) => html.split(segmentOpen(f)).length - 1 === 1),
    BARE_FILES.map((f) => f + '×' + (html.split(segmentOpen(f)).length - 1)).join(' '));

  /* 正向对照：把产物里的 render.js 段换成当前 src/ 的内容 → 必须 7 段全绿。
     证明比对函数在内容一致时确实会通过（不是恒假的假检查）。 */
  const patchSegment = (text, file, replacement) => {
    const span = segmentSpan(text, file);
    return (span && replacement !== null) ? text.slice(0, span[0]) + replacement + text.slice(span[1]) : null;
  };
  const freshRenderText = trimTailText(srcText['render.js']);
  const freshRenderHtml = patchSegment(html, 'render.js', freshRenderText);
  const segRepFresh = freshRenderHtml === null ? null : productSegmentReport(freshRenderHtml);
  ok('正向对照 | 把 render.js 段替换成当前 src/render.js 后 7 段全绿（证明比对函数会通过）',
    !!segRepFresh && segRepFresh.ok, segRepFresh ? ('不一致：' + segRepFresh.failed.join('、')) : '截取失败');

  /* ── 负向对照：在内存里改坏 1 个字节，比对必须报红，并指出是哪一段 ──────
     没有这几条，就无法区分「全绿是因为产物新鲜」还是「因为比对本身在空转」。 */
  const flipAt = (text, pos) => text.slice(0, pos) + (text.charAt(pos) === 'X' ? 'Y' : 'X') + text.slice(pos + 1);
  const dropAt = (text, pos) => text.slice(0, pos) + text.slice(pos + 1);
  const midOf = (span) => (span ? Math.floor((span[0] + span[1]) / 2) : 0);
  const ctlAppSpan = segmentSpan(html, 'app.js') || [0, 1];
  const ctlUiSpan = segmentSpan(html, 'ui.html') || [0, 1];
  const ctlPalSpan = segmentSpan(html, 'palette.js') || [0, 1];
  ok('负向对照 | 三个对照组用的段边界都截取到了（否则下面的破坏点落在段外，对照无意义）',
    !!segmentSpan(html, 'app.js') && !!segmentSpan(html, 'ui.html') && !!segmentSpan(html, 'palette.js'));
  const repTamperApp = productSegmentReport(flipAt(html, midOf(ctlAppSpan)));
  const repTamperUi = productSegmentReport(flipAt(html, midOf(ctlUiSpan)));
  const repTamperPal = productSegmentReport(dropAt(html, midOf(ctlPalSpan)));
  ok('负向对照 | 改坏 app.js 段 1 个字节 → 总判必须为 false（比对不是空转）', repTamperApp.ok === false, '总判 ' + repTamperApp.ok);
  eq('负向对照 | 且只报 app.js 这一段（定位精确，其余 6 段仍绿）', repTamperApp.failed, ['app.js']);
  ok('负向对照 | 改坏 ui.html 段 1 个字节 → 总判必须为 false（旧套件漏掉的正是这一段）', repTamperUi.ok === false, '总判 ' + repTamperUi.ok);
  eq('负向对照 | 且只报 ui.html 这一段', repTamperUi.failed, ['ui.html']);
  eq('负向对照 | 从 palette.js 段删掉 1 个字节（长度变化也要抓到）→ 只报 palette.js', repTamperPal.failed, ['palette.js']);
  ok('负向对照 | 三种破坏各只影响自己那一段（7 段都仍在报，不串段）',
    repTamperApp.rows.length === 7 && repTamperUi.rows.length === 7 && repTamperPal.rows.length === 7
    && repTamperApp.failed.length === 1 && repTamperUi.failed.length === 1 && repTamperPal.failed.length === 1,
    [repTamperApp.failed, repTamperUi.failed, repTamperPal.failed].join(' | '));
  ok('负向对照 | 未改动的那 6 段在破坏后仍判为一致（说明红的是被改的那一段，不是整体崩）',
    repTamperApp.rows.filter((r) => r.ok).length === 6 && repTamperUi.rows.filter((r) => r.ok).length === 6,
    repTamperApp.rows.filter((r) => r.ok).length + ' / ' + repTamperUi.rows.filter((r) => r.ok).length);

  // 清掉所有模块全局（含 app.js 可能挂的键），便于后续判断"重新 eval 后新增了什么"
  for (const k of ['PINDOU_PALETTES', 'ColorKit', 'Pipeline', 'Render', 'SourceEdit', 'PindouUI']) delete globalThis[k];
  ok('重新 eval 前 4 个模块全局已从 globalThis 清空', ['PINDOU_PALETTES', 'ColorKit', 'Pipeline', 'Render'].every((k) => globalThis[k] === undefined));
  ok('重新 eval 前 SourceEdit / PindouUI 也已从 globalThis 清空（产物证明不受上一轮污染）', globalThis.SourceEdit === undefined && globalThis.PindouUI === undefined);
  const beforeKeys = new Set(Object.getOwnPropertyNames(globalThis));
  const libErrors = [];
  for (let i = 0; i < 4; i++) {
    const err = evalScript(bodies[i]);
    if (err) libErrors.push('第 ' + (i + 1) + ' 段（' + BANNERS[i] + '）抛错：' + err.message);
  }
  ok('产物前 4 段（4 个库）重新 eval 无一抛错', libErrors.length === 0, libErrors.join(' / '));
  ok('重新 eval 后 window.PINDOU_PALETTES 挂上了', typeof globalThis.PINDOU_PALETTES === 'object' && globalThis.PINDOU_PALETTES !== null);
  ok('重新 eval 后 window.ColorKit 挂上了', typeof globalThis.ColorKit === 'object');
  ok('重新 eval 后 window.Pipeline 挂上了', typeof globalThis.Pipeline === 'object');
  ok('重新 eval 后 window.Render 挂上了', typeof globalThis.Render === 'object');
  ok('重新 eval 后 typeof window.Pipeline.generateFromRGBA === "function"', typeof globalThis.window.Pipeline.generateFromRGBA === 'function');
  ok('产物内色表仍是 2 × 221', Object.keys(globalThis.PINDOU_PALETTES).length === 2 && Object.keys(globalThis.PINDOU_PALETTES).every((k) => globalThis.PINDOU_PALETTES[k].colors.length === 221));

  /* 第 5 段（srcedit.js）必须挂上 window.SourceEdit，否则界面会安静地退回原图 */
  const srceditErr = evalScript(bodies[4]);
  ok('产物第 5 段（src/srcedit.js）重新 eval 无抛错', srceditErr === null, srceditErr ? srceditErr.message : '');
  ok('重新 eval 后 window.SourceEdit 挂上了', typeof globalThis.SourceEdit === 'object' && globalThis.SourceEdit !== null);
  ok('重新 eval 后 typeof window.SourceEdit.mount === "function"', typeof globalThis.window.SourceEdit.mount === 'function');
  /* 行为证明（不是读常量）：产物里的 pipeline MAX_DIM 必须是 116 —— 让它真的生一张 116×116 */
  const productSrc = synth(116, 116, (x, y) => [(x * 5) % 256, (y * 3) % 256, ((x + y) * 7) % 256]);
  const patProduct116 = globalThis.Pipeline.generateFromRGBA(productSrc, 116, 116, { gridW: 116, gridH: 116 });
  eq('产物内 pipeline MAX_DIM = 116（行为证明：116×116 不被夹回）', [patProduct116.w, patProduct116.h], [116, 116]);
  eq('产物内 pipeline 的 116×116 零告警（没有"夹到"提示）', patProduct116.warnings, []);
  eq('产物内 pipeline 的 116×116 boardX/Y = 4', [patProduct116.stats.boardX, patProduct116.stats.boardY], [4, 4]);

  /* 第 6 段（app.js）只断言「能加载、不炸、不破坏上面 5 个全局」——
   * 它的全局名与函数名属实现细节，硬断言会误报。 */
  const libSnap = ['PINDOU_PALETTES', 'ColorKit', 'Pipeline', 'Render', 'SourceEdit'].map((k) => typeof globalThis[k]);
  const appErr = evalScript(bodies[5]);
  ok('产物第 6 段（src/app.js）重新 eval 无抛错', appErr === null, appErr ? appErr.message : '');
  eq('app 段未破坏前 5 个库的全局', ['PINDOU_PALETTES', 'ColorKit', 'Pipeline', 'Render', 'SourceEdit'].map((k) => typeof globalThis[k]), libSnap);
  const newKeys = Object.getOwnPropertyNames(globalThis).filter((k) => !beforeKeys.has(k));
  info('app 段新增全局：' + (newKeys.join(', ') || '(无)') + ' —— 名字属实现细节，只报不断言');
  ok('产物内 app 段挂上了 PindouUI（模块级描述符：palettes/pipeline/render 均可用）', !!globalThis.PindouUI && globalThis.PindouUI.modules && globalThis.PindouUI.modules().ok === true, JSON.stringify(globalThis.PindouUI && globalThis.PindouUI.modules ? globalThis.PindouUI.modules() : null));
  const patFromProduct = globalThis.Pipeline.generateFromRGBA(synth(30, 30, (x) => [x * 8 % 256, 200, 60]), 30, 30, { boards: 1 });
  ok('产物内 Pipeline 端到端产出一张合法 Pattern', patFromProduct.colors.length >= 1 && patFromProduct.stats.total === patFromProduct.w * patFromProduct.h, 'colors=' + patFromProduct.colors.length);
}

/* ═════════════════════════════════════════════════════════════ 汇总 */
/* ══════════════════════════════════════════ 第 6 组 · 界面契约（app.js + ui.html） */
startGroup('第 6 组 · 界面契约（app.js / ui.html）');

const UI_HTML = readSrc('ui.html') || '';
const APP_SRC = srcText['app.js'] || '';

/* ── 控件 id 双向核对：0 重复 / 0 遗漏 / 0 悬空 ───────────────────────── */
const htmlIds = [...UI_HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const appRefList = [...APP_SRC.matchAll(/byId\(\s*'([^']+)'\s*\)/g)].map((m) => m[1])
  .concat([...APP_SRC.matchAll(/byId\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]));
const appRefs = [...new Set(appRefList)];
eq('ui.html 的 id 无重复', htmlIds.length - new Set(htmlIds).size, 0);
eq('app.js 的 byId 引用数 === ui.html 的 id 数（双向 0 遗漏）', appRefs.length, htmlIds.length);
ok('app.js 无悬空 id 引用（每个 byId(...) 都能在 ui.html 里找到）', appRefs.length > 0 && appRefs.every((id) => htmlIds.includes(id)), appRefs.filter((id) => !htmlIds.includes(id)).join(','));
ok('ui.html 无未被 app.js 引用的死 id', htmlIds.length > 0 && htmlIds.every((id) => appRefs.includes(id)), htmlIds.filter((id) => !appRefs.includes(id)).join(','));
ok('本轮替换 | 旧的 #showNumbers 已彻底消失（html + app.js 双清）', !htmlIds.includes('showNumbers') && !appRefs.includes('showNumbers'));
ok('本轮替换 | #cellLabelMode 存在且被引用', htmlIds.includes('cellLabelMode') && appRefs.includes('cellLabelMode'));
ok('本轮替换 | 旧的 #recolorColor 已彻底消失（html + app.js 双清）', !htmlIds.includes('recolorColor') && !appRefs.includes('recolorColor'));
ok('本轮替换 | 色板网格那组 id 齐全且都被引用', ['recolorGrid', 'recolorSearch', 'recolorScope', 'recolorEmpty', 'recolorRecentRow', 'recolorCurrent'].every((id) => htmlIds.includes(id) && appRefs.includes(id)));

/* ── 死按钮与覆盖层（纯结构 + CSS 规则，无需 DOM） ───────────────────── */
const emptyTag = (UI_HTML.match(/<[^>]*\bid="emptyState"[^>]*>/) || [''])[0];
ok('#emptyState 带 empty-cta 类', /class="[^"]*\bempty-cta\b[^"]*"/.test(emptyTag), emptyTag);
ok('#emptyState 是 <button>（能真的被点）', /^<button\b/.test(emptyTag), emptyTag);
ok('.canvas-overlay 仍是 pointer-events:none', /\.canvas-overlay\s*\{[^}]*pointer-events\s*:\s*none/.test(UI_HTML));
ok('.empty-cta 单独恢复 pointer-events:auto', /\.empty-cta\s*\{[^}]*pointer-events\s*:\s*auto/.test(UI_HTML));
ok('覆盖层排在画布之后且都在 #canvasScroll 内（绝对定位覆盖层 + none 才等于不拦截画布点击）', UI_HTML.indexOf('id="canvasScroll"') < UI_HTML.indexOf('id="patternCanvas"') && UI_HTML.indexOf('id="patternCanvas"') < UI_HTML.indexOf('class="canvas-overlay"'));

/* ── 最小 DOM 桩：只实现 app.js 真正用到的 API ──────────────────────── */
function makeRecCtx() {
  const rec = { fillRect: [], fillText: [], strokeRect: [], strokes: [], paths: 0, save: 0, restore: 0, drawImage: 0, setTransform: 0, clearRect: 0 };
  const ctx = {
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt',
    font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', imageSmoothingEnabled: true,
    _path: [], _rec: rec,
    save() { rec.save++; }, restore() { rec.restore++; },
    setTransform() { rec.setTransform++; }, clearRect() { rec.clearRect++; },
    fillRect(x, y, w, h) { rec.fillRect.push({ x, y, w, h }); },
    strokeRect(x, y, w, h) { rec.strokeRect.push({ x, y, w, h }); },
    drawImage() { rec.drawImage++; },
    fillText(t, x, y) { rec.fillText.push({ text: String(t), x, y }); },
    beginPath() { ctx._path = []; rec.paths++; },
    moveTo(x, y) { ctx._path.push(['M', x, y]); },
    lineTo(x, y) { ctx._path.push(['L', x, y]); },
    closePath() { ctx._path.push(['Z']); },
    stroke() { rec.strokes.push(ctx._path.slice()); ctx._path = []; },
    fill() { rec.strokes.push([]); }
  };
  return ctx;
}
function makeFireable(el) {
  const handlers = {};
  el._handlers = handlers;
  el.addEventListener = (t, fn) => { (handlers[t] = handlers[t] || []).push(fn); };
  el.removeEventListener = (t, fn) => { if (handlers[t]) handlers[t] = handlers[t].filter((f) => f !== fn); };
  el.dispatchEvent = (evt) => { (handlers[evt.type] || []).slice().forEach((fn) => fn(evt)); return true; };
  return el;
}
function fire(el, type, extra) {
  const evt = Object.assign({ type, target: el, currentTarget: el, button: 0, pointerId: 1, key: '', altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, preventDefault() {}, stopPropagation() {} }, extra || {});
  el.dispatchEvent(evt);
  return evt;
}
function makeDomEl(id) {
  const cls = new Set();
  const el = makeFireable({
    id, tagName: 'DIV', value: '', checked: false, disabled: false, hidden: false,
    textContent: '', innerHTML: '', files: null, width: 0, height: 0,
    clientWidth: 0, clientHeight: 0, clientLeft: 0, clientTop: 0,
    style: {}, dataset: {}, children: [], parentNode: null, parentElement: null,
    _clicks: 0, _attrs: {},
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), _set: cls },
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    appendChild(c) { this.children.push(c); if (c) c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); if (c) c.parentNode = null; return c; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  });
  el.click = function () { this._clicks++; fire(this, 'click'); };
  return el;
}
function makeDoc(ids) {
  const map = {};
  const created = { canvases: [], anchors: [], others: [] };
  for (const id of ids) map[id] = makeDomEl(id);
  for (const id of ['patternCanvas', 'sourceCanvas']) {
    if (!map[id]) continue;
    map[id]._ctx = makeRecCtx();
    map[id].getContext = function () { return this._ctx; };
  }
  const doc = makeFireable({
    readyState: 'complete',
    body: { appendChild() {}, removeChild() {} },
    getElementById: (id) => map[id] || null,
    createElement(tag) {
      const t = String(tag).toLowerCase();
      if (t === 'canvas') {
        const cv = makeDomEl('#created-canvas');
        cv._ctx = makeRecCtx();
        cv.getContext = function () { return this._ctx; };
        created.canvases.push(cv);
        return cv;
      }
      if (t === 'a') {
        const a = makeDomEl('#created-a');
        a.click = function () { this._clicks++; };
        created.anchors.push(a);
        return a;
      }
      const el = makeDomEl('#created-' + t);
      created.others.push(el);
      return el;
    }
  });
  return { map, doc, created };
}

/* ── 在 vm 沙箱里跑真的 app.js（不污染 globalThis / 不碰真 DOM） ──────── */
const dom = makeDoc(htmlIds);
const timers = [];
let timerSeq = 0;
const sandboxWin = {
  PINDOU_PALETTES: globalThis.PINDOU_PALETTES,
  Pipeline: globalThis.Pipeline,
  Render: null,
  setTimeout(fn) { const id = ++timerSeq; timers.push({ id, fn, cancelled: false }); return id; },
  clearTimeout(id) { for (const t of timers) if (t.id === id) t.cancelled = true; },
  performance: { now: () => 0 },
  Blob: class StubBlob { constructor(parts, opts) { this.parts = parts; this.type = (opts || {}).type; } },
  URL: { createObjectURL: () => 'blob:stub/1', revokeObjectURL() {} },
  localStorage: (function () { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; })()
};
const dropTimers = () => { timers.length = 0; };
const flushTimers = () => { const q = timers.splice(0); for (const t of q) if (!t.cancelled) t.fn(); };
const drawCalls = [];
const pngCalls = [];
let forceTooLarge = false;
let forceSuppressed = false;
sandboxWin.Render = Object.assign({}, globalThis.Render, {
  drawPattern(pat, cv, opts) {
    drawCalls.push({ cv, opts, pat });
    if (cv !== dom.map.patternCanvas && forceTooLarge) {
      return { ok: false, reason: 'too-large', needPixels: 900000000, maxPixels: 120000000, cellsDrawn: 0, labelsDrawn: false, labelsSuppressed: true, labelMinPx: 20, width: 99999, height: 99999, codesDrawn: false };
    }
    if (cv !== dom.map.patternCanvas && forceSuppressed) {
      const r = globalThis.Render.drawPattern(pat, cv, opts);
      return Object.assign({}, r, { ok: true, labelsSuppressed: true, labelsDrawn: false, codesDrawn: false });
    }
    return globalThis.Render.drawPattern(pat, cv, opts);
  },
  exportPNG(cv, name) { pngCalls.push({ cv, name }); return undefined; }
});
const appCtx = vm.createContext({ window: sandboxWin, document: dom.doc, console: { warn() {}, log() {} } });
let appLoadErr = null;
try { vm.runInContext(APP_SRC, appCtx, { filename: 'app.js' }); } catch (e) { appLoadErr = e; }
eq('app.js 在 DOM 桩沙箱里加载无抛错', appLoadErr, null);
const ui = sandboxWin.PindouUI;
ok('沙箱内 window.PindouUI 挂上了', !!ui && typeof ui === 'object');
ok('PindouUI 暴露了验收需要的全部方法', ['boot', 'modules', 'options', 'undo', 'exportPng', 'applyRecolor', 'pickerGroups', 'renderRecolorGrid', 'selectRecolorCode', 'readRecentColors', 'noteRecentColor', 'exportViewOpts', 'setViewZoom', 'state', 'elements'].every((k) => typeof ui[k] === 'function'), Object.keys(ui).join(','));
ui.boot();
const els = ui.elements();
const st = ui.state();
eq('boot 后 ui 元素全部解析到（0 个 missing）', st.missingUI.length, 0);
eq('boot 后 state.booted === true', st.booted, true);
ok('模块描述符 ok（palettes/pipeline/render 均在；SourceEdit 属可选项，不进 missing）', ui.modules().ok === true, JSON.stringify(ui.modules()));
ok('SourceEdit 缺失时给出降级提示（不阻塞其它功能）', String(els.srceditHint.textContent).includes('SourceEdit'), els.srceditHint.textContent);

/* ── 尺寸：gridW 200 → 116；预设 100；拼板 4×4 → 116 ─────────────────── */
els.gridW.value = '200';
els.gridH.value = '200';
fire(els.gridW, 'input');
eq('尺寸 | gridW 输入 200 → options().gridW 夹到 116', ui.options().gridW, 116);
eq('尺寸 | 输入框里的值也被回写夹到 116', String(els.gridW.value), '116');
els.sizePreset.value = '100';
fire(els.sizePreset, 'change');
eq('尺寸 | 预设 100 → options().gridW === 100', ui.options().gridW, 100);
eq('尺寸 | 预设 100 是正方形（gridH 也是 100）', ui.options().gridH, 100);
els.boardsSelect.value = '4';
fire(els.boardsSelect, 'change');
eq('尺寸 | 拼板规格 4×4 → 116', ui.options().gridW, 116);
eq('尺寸 | 拼板规格 4×4 → gridH 也是 116（无源图时按 1:1）', ui.options().gridH, 116);

/* ── 预览缩放与导出解耦 ────────────────────────────────────────────── */
ui.setViewZoom(0.25);
eq('预览缩放 | setViewZoom(0.25) 生效', st.viewZoom, 0.25);
const cellAt25 = ui.exportViewOpts(2).cellPx;
ui.setViewZoom(4);
eq('预览缩放 | setViewZoom(4) 生效', st.viewZoom, 4);
const cellAt4 = ui.exportViewOpts(2).cellPx;
eq('预览缩放与导出解耦 | 0.25 与 4 两种缩放下导出 cellPx 相同', [cellAt25, cellAt4], [48, 48]);
eq('导出 cellPx = 24 × 倍数（1/2/4/8 → 24/48/96/192）', [1, 2, 4, 8].map((s) => ui.exportViewOpts(s).cellPx), [24, 48, 96, 192]);

/* ── 导出路径：每次新建离屏 canvas + cellPx + padMode + annotate ────── */
const pat6 = Pipeline.generateFromRGBA(synth(29, 29, (x, y) => [(x * 11) % 256, (y * 7) % 256, 120]), 29, 29, { gridW: 8, gridH: 8, quantize: { enabled: true, maxColors: 3 } });
st.pattern = pat6;
dropTimers();
const exportCase = (scale, annotate) => {
  els.exportScale.value = String(scale);
  els.exportAnnotate.checked = annotate;
  dom.created.canvases.length = 0;
  drawCalls.length = 0;
  pngCalls.length = 0;
  ui.exportPng();
  return { off: dom.created.canvases[dom.created.canvases.length - 1], call: drawCalls[drawCalls.length - 1], png: pngCalls.length };
};
const e1x = exportCase(1, false);
eq('导出 | 每次导出新建 1 块离屏 canvas', dom.created.canvases.length, 1);
ok('导出 | 离屏 canvas !== #patternCanvas（绝不复用预览画布）', e1x.off !== dom.map.patternCanvas);
eq('导出 | drawPattern 的目标就是那块新离屏 canvas', e1x.call.cv, e1x.off);
eq('导出 | 倍数 1 → cellPx 24', e1x.call.opts.cellPx, 24);
eq('导出 | 传 padMode:"tight"', e1x.call.opts.padMode, 'tight');
eq('导出 | annotate 跟随复选框（未勾 → false）', e1x.call.opts.annotate, false);
eq('导出 | 成功路径调用了 Render.exportPNG 一次', e1x.png, 1);
const e2x = exportCase(2, true);
eq('导出 | 倍数 2 → cellPx 48', e2x.call.opts.cellPx, 48);
eq('导出 | annotate 跟随复选框（已勾 → true）', e2x.call.opts.annotate, true);
eq('导出 | 倍数 4 → cellPx 96', exportCase(4, false).call.opts.cellPx, 96);
eq('导出 | 倍数 8 → cellPx 192', exportCase(8, false).call.opts.cellPx, 192);

/* ── 判断顺序：ok:false 时不能提示成「色号没画出来」─────────────────── */
forceTooLarge = true;
dom.created.canvases.length = 0;
dom.created.anchors.length = 0;
pngCalls.length = 0;
st.pattern = pat6;
ui.exportPng();
const statusTooLarge = String(els.statusText.textContent);
ok('判断顺序 | ok:false + reason:too-large → 提示「倍数太大」', statusTooLarge.includes('倍数太大'), statusTooLarge);
ok('判断顺序 | ok:false 时不出现「色号没画出来」（先看 ok/reason，再看 labelsSuppressed）', !statusTooLarge.includes('色号没画出来'), statusTooLarge);
ok('判断顺序 | 提示里带上了 needPixels/maxPixels 量级', statusTooLarge.includes('像素'), statusTooLarge);
eq('面积守卫联动 | 零下载：未调用 Render.exportPNG', pngCalls.length, 0);
eq('面积守卫联动 | 零下载：未新增 <a>', dom.created.anchors.length, 0);
forceTooLarge = false;
/* 反向：ok:true + labelsSuppressed 时才走「色号没画出来」分支，且正常下载 */
forceSuppressed = true;
dom.created.anchors.length = 0;
pngCalls.length = 0;
ui.exportPng();
const statusSuppressed = String(els.statusText.textContent);
ok('判断顺序 | ok:true + labelsSuppressed → 才提示「色号没画出来」', statusSuppressed.includes('色号没画出来'), statusSuppressed);
eq('判断顺序 | 该分支仍会真的下载（调用 Render.exportPNG）', pngCalls.length, 1);
forceSuppressed = false;

/* ── 预览恒 annotate:false ─────────────────────────────────────────── */
st.source = { data: synth(24, 24, (x, y) => [(x * 9) % 256, (y * 5) % 256, 200]), width: 24, height: 24 };
st.srcW = 24;
st.srcH = 24;
drawCalls.length = 0;
dropTimers();
ui.regenerate();
flushTimers();
const previewCalls = drawCalls.filter((c) => c.cv === dom.map.patternCanvas);
ok('预览恒 annotate:false | 预览确实渲染过（≥1 次 drawPattern 打到 #patternCanvas）', previewCalls.length >= 1, String(previewCalls.length));
ok('预览恒 annotate:false | 每次预览 drawPattern 收到的 annotate === false', previewCalls.length > 0 && previewCalls.every((c) => c.opts.annotate === false), JSON.stringify(previewCalls.map((c) => c.opts.annotate)));
ok('预览 | 每次都显式给出 cellLabel（只给 showCodes 会退回画数字编号）', previewCalls.length > 0 && previewCalls.every((c) => ['code', 'index', 'none'].includes(c.opts.cellLabel)), JSON.stringify(previewCalls.map((c) => c.opts.cellLabel)));
ok('预览 | padMode 仍是 normal（与导出的 tight 是有意分开的两套白边策略）', previewCalls.length > 0 && previewCalls.every((c) => c.opts.padMode === 'normal'), JSON.stringify(previewCalls.map((c) => c.opts.padMode)));
eq('预览 | 预览真的产出了图纸（state.pattern 被 doGenerate 换掉）', st.pattern !== pat6, true);

/* ── 撤销：改色 → 撤销；栈空；栈上限 50 ────────────────────────────── */
st.pattern = pat6;
const pal6 = globalThis.PINDOU_PALETTES[pat6.paletteId] || globalThis.PINDOU_PALETTES[Object.keys(globalThis.PINDOU_PALETTES)[0]];
const usedCodes6 = new Set(pat6.colors.map((c) => c.code));
const otherCode = pal6.colors.map((c) => c.code).filter((c) => !usedCodes6.has(c)).pop();
ok('撤销 | 测试用目标色号确实不在当前图纸里', !!otherCode && !usedCodes6.has(otherCode), String(otherCode));
const beforeCells = Array.from(st.pattern.cells);
const beforeLocked = Array.from(st.pattern.locked);
const beforeCodes = st.pattern.colors.map((c) => c.code);
st.history.length = 0;
ui.applyRecolor(0, otherCode, true);
eq('撤销 | 改色后第 0 格换成新色号', st.pattern.colors[st.pattern.cells[0]].code, otherCode);
eq('撤销 | 改色后该格 locked === 1', st.pattern.locked[0], 1);
eq('撤销 | 改色 push 了 1 个快照', st.history.length, 1);
eq('撤销 | undo() 返回 true', ui.undo(), true);
eq('撤销 | cells 回到快照', Array.from(st.pattern.cells), beforeCells);
eq('撤销 | locked 回到快照', Array.from(st.pattern.locked), beforeLocked);
eq('撤销 | colors 回到快照', st.pattern.colors.map((c) => c.code), beforeCodes);
eq('撤销 | 快照已弹出，栈空', st.history.length, 0);
eq('撤销 | 栈空时 undo() 返回 false（不抛）', ui.undo(), false);
ok('撤销 | 栈空时给出可读提示', String(els.statusText.textContent).includes('没有可撤销'), els.statusText.textContent);
st.history.length = 0;
const alt6 = pal6.colors.slice(0, 2).map((c) => c.code);
for (let i = 0; i < 60; i++) ui.applyRecolor(0, alt6[i % 2], false);
eq('撤销 | 栈上限 50 生效（连续 push 60 次后仍为 50）', st.history.length, 50);

/* ── 选色器：本图色号 ↔ 全部；HEX 搜索；空态；recent ────────────────── */
els.recolorScope.value = 'used';
fire(els.recolorScope, 'change');
const gUsed = ui.pickerGroups();
eq('选色器 | 默认只列本图色号（1 组，key = used）', [gUsed.length, gUsed[0].key], [1, 'used']);
ok('选色器 | 本图色号的每一项都带颗数', gUsed[0].items.every((i) => typeof i.count === 'number' && i.count > 0), JSON.stringify(gUsed[0].items.slice(0, 2)));
ok('选色器 | 本图色号数 > 0 且 ≤ 图纸 colors 数', gUsed[0].items.length > 0 && gUsed[0].items.length <= st.pattern.colors.length, gUsed[0].items.length + ' / ' + st.pattern.colors.length);
els.recolorScope.value = 'all';
fire(els.recolorScope, 'change');
const gAll = ui.pickerGroups();
eq('选色器 | 切到「全部色号」后列出整张色卡 221 色', gAll.reduce((s, g) => s + g.items.length, 0), 221);
ok('选色器 | 全部色号按 group 分组（≥ 9 组 A–H/M）', gAll.length >= 9, gAll.length);
const target6 = pal6.colors[0];
els.recolorSearch.value = target6.hex.toUpperCase();
fire(els.recolorSearch, 'input');
const hitUp = ui.pickerGroups().some((g) => g.items.some((i) => i.code === target6.code));
els.recolorSearch.value = target6.hex.toLowerCase();
fire(els.recolorSearch, 'input');
const hitLo = ui.pickerGroups().some((g) => g.items.some((i) => i.code === target6.code));
ok('选色器 | HEX 大写搜索命中（' + target6.hex.toUpperCase() + ' → ' + target6.code + '）', hitUp);
ok('选色器 | HEX 小写搜索命中（' + target6.hex.toLowerCase() + ' → ' + target6.code + '）', hitLo);
let pickerThrew = '';
try {
  els.recolorSearch.value = 'zz-no-such-color';
  fire(els.recolorSearch, 'input');
} catch (e) { pickerThrew = e.message; }
eq('选色器 | 无匹配搜索不抛异常', pickerThrew, '');
eq('选色器 | 无匹配时网格为空', String(els.recolorGrid.innerHTML), '');
eq('选色器 | 无匹配时空态可见且文案为「无匹配」', [els.recolorEmpty.hidden, String(els.recolorEmpty.textContent)], [false, '无匹配']);
ui.selectRecolorCode(target6.code);
eq('选色器 | 选中后 state.recolor.selected 更新', st.recolor.selected, target6.code);
ok('选色器 | 当前目标色号提示同时含色号与 HEX', String(els.recolorCurrent.textContent).includes(target6.code) && String(els.recolorCurrent.textContent).includes(target6.hex), els.recolorCurrent.textContent);
eq('选色器 | 选过的色号进入「最近用过」队首', st.recolor.recent[0], target6.code);

/* ── localStorage 抛错时静默降级 ──────────────────────────────────── */
const lsBackup = sandboxWin.localStorage;
sandboxWin.localStorage = { getItem() { throw new Error('localStorage 被禁用'); }, setItem() { throw new Error('localStorage 被禁用'); } };
let lsReadThrew = '';
let lsRead = null;
let lsWriteThrew = '';
try { lsRead = ui.readRecentColors(); } catch (e) { lsReadThrew = e.message; }
try { ui.noteRecentColor('A1'); } catch (e) { lsWriteThrew = e.message; }
eq('localStorage 抛错 | readRecentColors() 静默降级为 []', [lsReadThrew, lsRead], ['', []]);
eq('localStorage 抛错 | noteRecentColor() 不抛异常', lsWriteThrew, '');
eq('localStorage 抛错 | 仍降级为「仅本次会话有效」', st.recolor.recent[0], 'A1');
sandboxWin.localStorage = lsBackup;

/* ── 死按钮：#emptyState 真的能唤起文件选择 ─────────────────────────── */
const clicksBefore = els.fileInput._clicks;
fire(els.emptyState, 'click');
eq('死按钮 | #emptyState 点击触发 #fileInput.click() 一次', els.fileInput._clicks - clicksBefore, 1);
const clicksBefore2 = els.fileInput._clicks;
fire(els.btnPickFile, 'click');
eq('死按钮 | #btnPickFile 也触发 #fileInput.click()', els.fileInput._clicks - clicksBefore2, 1);

/* ── 降级：vm 沙箱只给 window = {}（无 DOM、无任何模块） ─────────────── */
const bareWin = {};
let bareErr = null;
try {
  const bareCtx = vm.createContext({ window: bareWin, console: { warn() {}, log() {} } });
  vm.runInContext(APP_SRC, bareCtx, { filename: 'app.js' });
} catch (e) { bareErr = e; }
eq('降级 | 只给 window={} 加载 app.js 不抛异常', bareErr, null);
ok('降级 | 仍然挂上 window.PindouUI', !!bareWin.PindouUI && typeof bareWin.PindouUI === 'object');
eq('降级 | modules() 如实报告 3 个核心模块缺失', bareWin.PindouUI.modules().missing.length, 3);
eq('降级 | modules().ok === false', bareWin.PindouUI.modules().ok, false);
let bareBootThrew = '';
try { bareWin.PindouUI.boot(); } catch (e) { bareBootThrew = e.message; }
eq('降级 | 无 DOM 时 boot() 是空操作且不抛', bareBootThrew, '');
eq('降级 | 无 DOM 时 state().booted === false（确实没启动）', bareWin.PindouUI.state().booted, false);

/* ══════════════════════════════════════════════════════════════════════
   本轮新需求：双标签页 / 抠图工具 / 预处理非线性压缩 / 图纸标题
   ══════════════════════════════════════════════════════════════════════ */

/* ── 5.1 双标签页（基本 / 高级）───────────────────────────────────────── */
const TAB_NEW_IDS = ['tabBasic', 'tabAdvanced', 'panelBasic', 'panelAdvanced', 'maxColorsVal', 'preprocessHint',
  'chartTitle', 'toolNone', 'toolWand', 'toolEraser', 'eraserSize', 'toolHint'];
ok('控件清单 | 本轮新增的 12 个 id 全部在 ui.html 里', TAB_NEW_IDS.every((id) => htmlIds.includes(id)), TAB_NEW_IDS.filter((id) => !htmlIds.includes(id)).join(','));
ok('控件清单 | 且这 12 个 id 全部被 app.js 引用（没有一个是摆设）', TAB_NEW_IDS.every((id) => appRefs.includes(id)), TAB_NEW_IDS.filter((id) => !appRefs.includes(id)).join(','));
eq('控件清单 | ui.html 的 id 总数 = 91（原来 79 + 本轮 12）', htmlIds.length, 91);

const maxColorsTag = (UI_HTML.match(/<input\b[^>]*\bid="maxColors"[^>]*>/) || [''])[0];
ok('控件 | #maxColors 变成 range（min 2 / max 221 / step 1 / value 24，可拖到色卡上限）',
  /type="range"/.test(maxColorsTag) && /min="2"/.test(maxColorsTag) && /max="221"/.test(maxColorsTag)
  && /step="1"/.test(maxColorsTag) && /value="24"/.test(maxColorsTag), maxColorsTag);
ok('控件 | #maxColors 不再是 type="number"（旧的数字输入已彻底消失）', !/type="number"/.test(maxColorsTag), maxColorsTag);
eq('控件 | #maxColorsVal 读数存在且 boot 后显示 24（与 Pipeline 默认一致）', String(els.maxColorsVal.textContent), '24');
ok('控件 | #chartTitle 是文本输入，且在「图纸显示」组之后（属于该组）',
  /type="text"/.test((UI_HTML.match(/<input\b[^>]*\bid="chartTitle"[^>]*>/) || [''])[0]) && UI_HTML.indexOf('id="chartTitle"') > UI_HTML.indexOf('<h2>图纸显示</h2>'), UI_HTML.indexOf('id="chartTitle"') + ' vs ' + UI_HTML.indexOf('<h2>图纸显示</h2>'));
ok('控件 | #preprocessHint 落在「预处理」组里', UI_HTML.indexOf('id="preprocessHint"') > UI_HTML.indexOf('<h2>预处理</h2>'));
ok('控件 | #toolHint 与 #eraserSize 落在「抠图」组里（都在 panelBasic 内、panelAdvanced 之前）',
  UI_HTML.indexOf('id="toolHint"') > UI_HTML.indexOf('<h2>抠图</h2>') && UI_HTML.indexOf('id="toolHint"') < UI_HTML.indexOf('<div id="panelAdvanced"'));

/* 分组标题：11 个旧标题都去过号，另加「抠图」组 */
function tabPanelTitles(fromMark, toMark) {
  const a = UI_HTML.indexOf(fromMark), b = UI_HTML.indexOf(toMark);
  if (a < 0 || b < 0 || b <= a) return null;
  return (UI_HTML.slice(a, b).match(/<h2>[^<]*<\/h2>/g) || []).map((s) => s.replace(/<\/?h2>/g, ''));
}
const tabBasicTitles = tabPanelTitles('<div id="panelBasic"', '<div id="panelAdvanced"');
const tabAdvTitles = tabPanelTitles('<div id="panelAdvanced"', '<main id="dropZone"');
eq('标签页 | 基本页恰好 6 组，且就是这 6 个（新增「抠图」）', tabBasicTitles, ['图片输入', '取色方式', '图纸尺寸', '图纸显示', '抠图', '导出']);
eq('标签页 | 高级页恰好 6 组，且就是这 6 个', tabAdvTitles, ['预处理', '减色', '色卡版本', '预览缩放', '改色模式', '操作']);
const tabAllH2 = (UI_HTML.match(/<h2>[^<]*<\/h2>/g) || []).map((s) => s.replace(/<\/?h2>/g, ''));
ok('标签页 | 全部 ' + tabAllH2.length + ' 个 <h2> 都不存在「数字 · 」序号前缀',
  tabAllH2.length >= 16 && tabAllH2.every((t) => !/^\s*\d+\s*·/.test(t)), JSON.stringify(tabAllH2));
ok('标签页 | 旧标题「1 · 图片输入」这类带号标题已彻底消失', !/\d+ · 图片输入/.test(UI_HTML));
ok('标签页 | 两个面板的静态初始态：基本可见 / 高级带 hidden',
  !/\shidden(\s|>|=)/.test((UI_HTML.match(/<div\b[^>]*\bid="panelBasic"[^>]*>/) || [''])[0] + ' ')
  && /\shidden(\s|>|=)/.test((UI_HTML.match(/<div\b[^>]*\bid="panelAdvanced"[^>]*>/) || [''])[0] + ' '),
  (UI_HTML.match(/<div\b[^>]*\bid="panelAdvanced"[^>]*>/) || [''])[0]);

/* 运行时的默认态：先证明此前没有任何标签按钮被点过，否则下面看到的不是 boot 默认态 */
eq('标签页 | 前置事实 | 到此刻为止没有点过任何标签按钮（下面看到的就是 boot 默认态）', [els.tabBasic._clicks, els.tabAdvanced._clicks], [0, 0]);
eq('标签页 | 默认停在基本页：state.tab === "basic"', st.tab, 'basic');
eq('标签页 | 默认面板显隐：#panelBasic 可见 / #panelAdvanced 隐藏', [els.panelBasic.hidden, els.panelAdvanced.hidden], [false, true]);
eq('标签页 | 按钮高亮与 aria-selected 与 state.tab 一致',
  [els.tabBasic.classList.contains('on'), els.tabAdvanced.classList.contains('on'), els.tabBasic.getAttribute('aria-selected'), els.tabAdvanced.getAttribute('aria-selected')],
  [true, false, 'true', 'false']);

/* 切换：控件值不丢 / 面板不被重建 */
els.gridW.value = '33';
els.brightness.value = '40';
els.quantizeEnabled.checked = false;
els.chartTitle.value = '标签页标题';
els.showRuler.checked = false;
const tabSentinelBasic = makeDomEl('#sentinel-basic');
const tabSentinelAdv = makeDomEl('#sentinel-adv');
els.panelBasic.appendChild(tabSentinelBasic);
els.panelAdvanced.appendChild(tabSentinelAdv);
const tabChildrenBefore = [els.panelBasic.children.length, els.panelAdvanced.children.length];
const tabCreatedBefore = dom.created.others.length;
let tabPanelHtmlWrites = 0;
for (const p of [els.panelBasic, els.panelAdvanced]) {
  let raw = p.innerHTML;
  Object.defineProperty(p, 'innerHTML', {
    configurable: true,
    get() { return raw; },
    set(v) { tabPanelHtmlWrites++; raw = v; }
  });
}
fire(els.tabBasic, 'click');
eq('标签页 | 点「基本」→ state.tab 与面板显隐同步', [st.tab, els.panelBasic.hidden, els.panelAdvanced.hidden], ['basic', false, true]);
fire(els.tabAdvanced, 'click');
eq('标签页 | 点「高级」→ 高级面板可见、基本面板隐藏', [st.tab, els.panelBasic.hidden, els.panelAdvanced.hidden], ['advanced', true, false]);
eq('标签页 | 切到高级后按钮高亮互换', [els.tabBasic.classList.contains('on'), els.tabAdvanced.classList.contains('on')], [false, true]);
fire(els.tabBasic, 'click');
fire(els.tabAdvanced, 'click');
fire(els.tabBasic, 'click');
eq('标签页 | 来回切换 5 次后控件值一个都没被重置（滑杆 / 勾选框 / 标题文本）',
  [els.gridW.value, els.brightness.value, els.quantizeEnabled.checked, els.chartTitle.value, els.showRuler.checked],
  ['33', '40', false, '标签页标题', false]);
eq('标签页 | 切换不改写面板 innerHTML（不是重建 DOM）', tabPanelHtmlWrites, 0);
eq('标签页 | 切换期间没有新建任何元素', dom.created.others.length, tabCreatedBefore);
eq('标签页 | 面板子节点数不变且是同一个节点（不是重建出来的新副本）',
  [els.panelBasic.children.length, els.panelAdvanced.children.length, els.panelBasic.children[0] === tabSentinelBasic, els.panelAdvanced.children[0] === tabSentinelAdv],
  [tabChildrenBefore[0], tabChildrenBefore[1], true, true]);
fire(els.tabBasic, 'click');
eq('标签页 | 收尾：回到基本页', st.tab, 'basic');
els.quantizeEnabled.checked = true;
els.showRuler.checked = true;

/* ── 5.3 预处理滑杆的非线性压缩（effCurve / 生效值）────────────────────── */
const EFF_TABLE = [[0, 0], [1, 0], [5, 1], [20, 8], [50, 33], [80, 70], [100, 100], [-50, -33], [-100, -100]];
eq('预处理压缩 | effCurve 精确值表（含负半轴）', EFF_TABLE.map((p) => ui.effCurve(p[0])), EFF_TABLE.map((p) => p[1]));
eq('预处理压缩 | effCurve(0) === 0（0 仍映射到 0，重置语义不变）', [ui.effCurve(0), ui.effCurve(-0)], [0, 0]);
els.brightness.value = '50';
fire(els.brightness, 'input');
eq('预处理压缩 | 滑杆 50 → buildOpts 送进 pipeline 的是生效值 33（不是滑杆原值 50）', ui.options().preprocess.brightness, 33);
eq('预处理压缩 | 读数控件显示生效值（+33，不是 +50）', String(els.brightnessVal.textContent), '+33');
els.brightness.value = '-50';
fire(els.brightness, 'input');
eq('预处理压缩 | 负半轴：滑杆 -50 → 生效 -33', [ui.options().preprocess.brightness, String(els.brightnessVal.textContent)], [-33, '-33']);
els.contrast.value = '50';
fire(els.contrast, 'input');
els.saturation.value = '80';
fire(els.saturation, 'input');
eq('预处理压缩 | 对比度 / 饱和度走同一条曲线（50→33、80→70）',
  [ui.options().preprocess.contrast, ui.options().preprocess.saturation, String(els.contrastVal.textContent), String(els.saturationVal.textContent)],
  [33, 70, '+33', '+70']);
els.ditherStrength.value = '50';
fire(els.ditherStrength, 'input');
eq('预处理压缩 | ditherStrength 不受压缩影响（50 → opts 0.5，不是 0.33）', ui.options().ditherStrength, 0.5);
eq('预处理压缩 | 抖动强度读数仍是滑杆原值 50%', String(els.ditherStrengthVal.textContent), '50%');
dropTimers();
fire(els.btnResetAdjust, 'click');
dropTimers();
eq('预处理压缩 | 重置微调后回到 DEFAULTS.brightness = 0（滑杆 0 与生效值 0 都是 0）',
  [ui.options().preprocess.brightness, String(els.brightnessVal.textContent)], [0, '0']);
const effDefMatch = /var DEFAULTS = \{([\s\S]*?)\n  \};/.exec(APP_SRC);
ok('预处理压缩 | app.js 的 DEFAULTS 字面量能解析出来（下面两条不是空转）', !!effDefMatch, effDefMatch ? '' : '未匹配到 DEFAULTS');
const effDefText = effDefMatch ? effDefMatch[1] : '';
const effPipelineQ = globalThis.Pipeline.DEFAULT_OPTS.quantize;
ok('预处理压缩 | DEFAULTS.quantizeEnabled 与 Pipeline.DEFAULT_OPTS.quantize.enabled 逐字段一致',
  new RegExp('quantizeEnabled:\\s*' + String(effPipelineQ.enabled)).test(effDefText), effDefText.slice(0, 160));
ok('预处理压缩 | DEFAULTS.maxColors 与 Pipeline.DEFAULT_OPTS.quantize.maxColors 逐字段一致',
  new RegExp('maxColors:\\s*' + effPipelineQ.maxColors + '\\b').test(effDefText), effDefText.slice(0, 160));
eq('预处理压缩 | 没动过减色控件时 options().quantize 就是 pipeline 默认（同一语义只有一份来源）',
  ui.options().quantize, { enabled: effPipelineQ.enabled, maxColors: effPipelineQ.maxColors });

/* ── 5.2 抠图（魔术棒 / 橡皮刷 / 撤销 / 保护 / 持久化）──────────────────── */
const erColors = [
  { code: 'A1', hex: '#FF0000', rgb: [255, 0, 0], group: 'A' },
  { code: 'B2', hex: '#00FF00', rgb: [0, 255, 0], group: 'B' },
  { code: 'C3', hex: '#0000FF', rgb: [0, 0, 255], group: 'C' }
];
/* 注意：不能用 dropTimers() 丢弃挂起的重渲染 —— scheduleRender 的 renderScheduled 标志只有
   在回调里才会复位，丢掉定时器会让它永久卡在 true，后面的 scheduleRender 全部变成空操作。
   需要清场时一律用 erFlushAll()（把排队的回调真的跑掉）。 */
const erFlushAll = (n) => { for (let i = 0; i < (n || 4); i++) flushTimers(); };
function erMkPat(w, h, fn) {
  const cells = new Uint16Array(w * h).fill(EMPTY);
  for (let i = 0; i < w * h; i++) {
    const v = fn(i % w, Math.floor(i / w), i);
    if (v !== null && v !== undefined) cells[i] = v;
  }
  return { w: w, h: h, colors: erColors.map((c) => Object.assign({}, c)), cells: cells, locked: new Uint8Array(w * h), counts: [], stats: {} };
}
/* 四连通（不斜连）洪泛的独立重述：与 app.js 的 wandErase 无共享代码 */
function erFlood4(pat, start) {
  const color = pat.cells[start];
  const seen = new Set([start]);
  const q = [start];
  const out = [];
  for (let head = 0; head < q.length; head++) {
    const cur = q[head];
    out.push(cur);
    const x = cur % pat.w, y = Math.floor(cur / pat.w);
    const nb = [];
    if (x > 0) nb.push(cur - 1);
    if (x < pat.w - 1) nb.push(cur + 1);
    if (y > 0) nb.push(cur - pat.w);
    if (y < pat.h - 1) nb.push(cur + pat.w);
    for (const j of nb) { if (!seen.has(j) && pat.cells[j] === color) { seen.add(j); q.push(j); } }
  }
  return out.sort((a, b) => a - b);
}
const erWandPat = erMkPat(9, 5, (x, y) => {
  if (y === 0 && x <= 2) return 0;        // 区域 A：3 格同色
  if (y === 4 && x >= 6) return 0;        // 区域 B：同色但与 A 分离
  if (y === 2) return null;               // 整行空：洪泛也不该跨过它
  if (y === 1 && x <= 2) return 1;        // 用上色号 1：三个色号都被用到，pruneUnusedColors 才不会平移下标
  return 2;
});
st.pattern = erWandPat;
st.viewOpts = ui.viewOpts();
st.history.length = 0;
const erWandRegion = erFlood4(erWandPat, 1);
eq('抠图 | 魔术棒 | 独立重算的四连通区域（起点第 1 格）', erWandRegion, [0, 1, 2]);
const erWandSnap = Array.from(erWandPat.cells);
const erWandLockSnap = Array.from(erWandPat.locked);
const erWandReturn = ui.wandErase(1);
eq('抠图 | 魔术棒 | 返回值 === 独立重算的区域大小', erWandReturn, erWandRegion.length);
eq('抠图 | 魔术棒 | 区域 A 全部置空', erWandRegion.map((i) => st.pattern.cells[i]), erWandRegion.map(() => EMPTY));
eq('抠图 | 魔术棒 | 分离的同色区域 B 一格未动（cells）', [42, 43, 44].map((i) => st.pattern.cells[i]), [0, 0, 0]);
eq('抠图 | 魔术棒 | 分离的同色区域 B 一格未动（locked 也保持 0）', [42, 43, 44].map((i) => st.pattern.locked[i]), [0, 0, 0]);
const erChangedOutside = [];
for (let i = 0; i < st.pattern.cells.length; i++) {
  if (erWandRegion.indexOf(i) >= 0) continue;
  if (st.pattern.cells[i] !== erWandSnap[i] || st.pattern.locked[i] !== erWandLockSnap[i]) erChangedOutside.push(i);
}
eq('抠图 | 魔术棒 | 其余格逐格完全不变（cells 与 locked 都比对过）', erChangedOutside, []);
eq('抠图 | 魔术棒 | 被擦格 locked === 1（重新生成时才会保持为空）', erWandRegion.map((i) => st.pattern.locked[i]), [1, 1, 1]);
eq('抠图 | 魔术棒 | colors.length === counts.length', st.pattern.colors.length, st.pattern.counts.length);
eq('抠图 | 魔术棒 | 色号 0 仍被区域 B 使用 → 没有被 pruneUnusedColors 误删', st.pattern.colors.length, 3);
const erWandRecount = Array.from(st.pattern.cells).filter((c) => c !== EMPTY).length;
eq('抠图 | 魔术棒 | stats.total === 自己重数的非空格子数', st.pattern.stats.total, erWandRecount);
eq('抠图 | 魔术棒 | 整次点击只占 1 步历史', st.history.length, 1);
ok('抠图 | 魔术棒 | 提示写明擦除数与「保持为空」',
  /已擦除 3 格/.test(String(els.statusText.textContent)) && /保持为空/.test(String(els.statusText.textContent)), els.statusText.textContent);

/* 撤销覆盖抠图 */
eq('抠图 | 撤销 | undo() 返回 true', ui.undo(), true);
eq('抠图 | 撤销 | 被擦格全部还原（cells 逐格与快照一致）', Array.from(st.pattern.cells), erWandSnap);
eq('抠图 | 撤销 | locked 也逐格还原', Array.from(st.pattern.locked), erWandLockSnap);
eq('抠图 | 撤销 | 快照已弹出，栈空', st.history.length, 0);

/* 橡皮刷：pointerdown + 若干 pointermove + pointerup */
function erBrushMirror(w, h, col, row, size) {
  const half = (size - 1) / 2;
  const out = [];
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const x = col + dx, y = row + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      out.push(y * w + x);
    }
  }
  return out;
}
els.eraserSize.value = '3';
els.cellSize.value = '24';
els.cellLabelMode.value = 'none';
els.showRuler.checked = false;
fire(els.eraserSize, 'change');
st.pattern = erMkPat(9, 5, () => 0);
st.viewOpts = ui.viewOpts();
st.history.length = 0;
ui.setTool('eraser');
eq('橡皮刷 | 前置 | state.tool === "eraser"', ui.tool(), 'eraser');
eq('橡皮刷 | 前置 | ui.elements().patternCanvas 就是桩里的那一块画布', els.patternCanvas === dom.map.patternCanvas, true);
const erBrushCv = dom.map.patternCanvas;
globalThis.Render.drawPattern(st.pattern, erBrushCv, st.viewOpts);   // 与 app.js 一样，先渲染一次让画布尺寸就位
const erBrushCell = st.viewOpts.cellPx;
const erBrushPad = Math.floor((erBrushCv.width - st.pattern.w * erBrushCell) / 2);
const erBrushPt = (col, row) => ({ clientX: erBrushPad + col * erBrushCell + erBrushCell / 2, clientY: erBrushPad + row * erBrushCell + erBrushCell / 2 });
const erBrushPath = [
  erBrushMirror(9, 5, 4, 2, 3), erBrushMirror(9, 5, 5, 2, 3), erBrushMirror(9, 5, 6, 2, 3),
  erBrushMirror(9, 5, 0, 0, 3)
];
const erBrushUnion = Array.from(new Set([].concat.apply([], erBrushPath))).sort((a, b) => a - b);
eq('橡皮刷 | 前置 | 3×3 刷子在中部覆盖 9 格', erBrushPath[0].length, 9);
eq('橡皮刷 | 前置 | 3×3 刷子在角上被裁剪成 4 格（不是 9 格，也不环绕）', erBrushPath[3].length, 4);
eq('橡皮刷 | 前置 | 独立重算的并集 = 19 格', erBrushUnion.length, 19);
const erBrushBefore = Array.from(st.pattern.cells);
fire(erBrushCv, 'pointerdown', erBrushPt(4, 2));
eq('橡皮刷 | pointerdown 就占 1 步历史', st.history.length, 1);
fire(dom.doc, 'pointermove', erBrushPt(5, 2));
fire(dom.doc, 'pointermove', erBrushPt(6, 2));
fire(dom.doc, 'pointermove', erBrushPt(0, 0));
eq('橡皮刷 | pointermove 期间只重绘、不追加历史（仍只有 1 步）', st.history.length, 1);
eq('橡皮刷 | 拖动中已即时置空：已空格子数 === 独立重算的并集', Array.from(st.pattern.cells).filter((c) => c === EMPTY).length, erBrushUnion.length);
fire(dom.doc, 'pointerup', {});
eq('橡皮刷 | 划过的路径（含整个刷子范围）全部为空', erBrushUnion.filter((i) => st.pattern.cells[i] === EMPTY).length, erBrushUnion.length);
eq('橡皮刷 | 越界被裁剪 | 实际置空的格子总数 === 独立重算的并集（不多不少）', Array.from(st.pattern.cells).filter((c) => c === EMPTY).length, erBrushUnion.length);
eq('橡皮刷 | 越界被裁剪 | 并集之外的格子仍是原色（没有环绕/折行到对侧）', [2, 7, 8, 11, 17, 26, 35, 36, 44].filter((i) => st.pattern.cells[i] === EMPTY), []);
eq('橡皮刷 | 整段拖动只 1 步历史', st.history.length, 1);
eq('橡皮刷 | pointerup 后拖动状态复位', [st.eraseActive, st.eraseCount], [false, 0]);
ok('橡皮刷 | 收尾提示写明一共擦掉 19 格', /已擦除 19 格/.test(String(els.statusText.textContent)), els.statusText.textContent);
erFlushAll();     // 跑掉 pointerdown 期间排队的那次重渲染（不跑掉会卡住 renderScheduled）

/* 撤销覆盖橡皮刷 */
eq('橡皮刷 | 撤销 | undo() 返回 true', ui.undo(), true);
eq('橡皮刷 | 撤销 | 划过的格子全部还原', Array.from(st.pattern.cells), erBrushBefore);
eq('橡皮刷 | 撤销 | locked 也还原（全 0）', Array.from(st.pattern.locked).filter((v) => v !== 0), []);

/* 擦空整张图：不崩、total/colors/counts 全归零 */
st.pattern = erMkPat(3, 3, () => 1);
st.viewOpts = ui.viewOpts();
st.history.length = 0;
dom.map.patternCanvas.width = 0;      // 哨兵：若渲染流程没走完，宽度会一直留在 0
dom.map.patternCanvas.height = 0;
let erSolidThrew = '';
let erSolidReturn = 0;
try { erSolidReturn = ui.wandErase(0); } catch (e) { erSolidThrew = e.message; }
eq('抠图 | 擦空整张图 | 不抛异常', erSolidThrew, '');
eq('抠图 | 擦空整张图 | 魔术棒擦掉全部 9 格', erSolidReturn, 9);
eq('抠图 | 擦空整张图 | stats.total === 0', st.pattern.stats.total, 0);
eq('抠图 | 擦空整张图 | colors.length === 0', st.pattern.colors.length, 0);
eq('抠图 | 擦空整张图 | counts.length === 0', st.pattern.counts.length, 0);
ok('抠图 | 擦空整张图 | 擦了 9 格且给出了可读提示', /已擦除 9 格/.test(String(els.statusText.textContent)), els.statusText.textContent);
ok('抠图 | 擦空整张图 | 擦空后渲染流程仍走完（哨兵宽高 0 → 被重新设置，不是沿用旧值）', dom.map.patternCanvas.width > 0 && dom.map.patternCanvas.height > 0, dom.map.patternCanvas.width + '×' + dom.map.patternCanvas.height);

/* 20000 格保护 */
els.cellSize.value = '8';
st.pattern = erMkPat(150, 150, () => 2);      // 22500 格连通同色
st.viewOpts = ui.viewOpts();
st.history.length = 0;
const erHugeReturn = ui.wandErase(0);
eq('抠图 | 20000 格保护 | 单次魔术棒最多擦 20000 格', erHugeReturn, 20000);
eq('抠图 | 20000 格保护 | 剩余非空格子 = 22500 - 20000 = 2500', Array.from(st.pattern.cells).filter((c) => c !== EMPTY).length, 2500);
ok('抠图 | 20000 格保护 | 提示说明「连通区域超过单次上限 20000 格」并可再次点击继续',
  /超过单次上限 20000 格/.test(String(els.statusText.textContent)) && /可再次点击继续/.test(String(els.statusText.textContent)), els.statusText.textContent);
eq('抠图 | 20000 格保护 | 仍只占 1 步历史', st.history.length, 1);

/* 工具互斥：三选一与 #recolorMode 共用同一个 state.tool */
els.recolorMode.checked = true;
fire(els.recolorMode, 'change');
eq('抠图 | 工具互斥 | 勾 #recolorMode → state.tool === "recolor"', ui.tool(), 'recolor');
eq('抠图 | 工具互斥 | 且魔术棒 / 橡皮刷 / 关闭三个单选都被取消', [els.toolNone.checked, els.toolWand.checked, els.toolEraser.checked], [false, false, false]);
eq('抠图 | 工具互斥 | 复选框自身保持勾上', els.recolorMode.checked, true);
els.toolWand.checked = true;
fire(els.toolWand, 'change');
eq('抠图 | 工具互斥 | 反向：选魔术棒 → state.tool === "wand" 且 #recolorMode 被取消勾选', [ui.tool(), els.recolorMode.checked], ['wand', false]);
els.toolEraser.checked = true;
fire(els.toolEraser, 'change');
eq('抠图 | 工具互斥 | 再选橡皮刷 → state.tool === "eraser" 且魔术棒单选被取消', [ui.tool(), els.toolWand.checked, els.toolEraser.checked], ['eraser', false, true]);
els.toolNone.checked = true;
fire(els.toolNone, 'change');
eq('抠图 | 工具互斥 | 选「关闭」→ 全部工具失效', [ui.tool(), els.recolorMode.checked, els.toolWand.checked, els.toolEraser.checked], ['none', false, false, false]);
eq('抠图 | 工具互斥 | 任意时刻只有一个工具生效（四个开关里 checked 的正好 1 个）',
  [els.toolNone.checked, els.toolWand.checked, els.toolEraser.checked, els.recolorMode.checked].filter(Boolean).length, 1);

/* 橡皮刷坐标：pad 只能从画布宽度反推（画布下方还有角标带，高度不可信） */
els.cellSize.value = '8';
els.eraserSize.value = '1';
st.pattern = erMkPat(9, 5, () => 0);
st.viewOpts = ui.viewOpts();
const erPadCv = dom.map.patternCanvas;
globalThis.Render.drawPattern(st.pattern, erPadCv, st.viewOpts);
erPadCv.clientWidth = erPadCv.width;
erPadCv.clientHeight = erPadCv.height * 4;     // 模拟「高 ≫ 宽」：画布被 CSS 拉高，下方还有角标带
const erPadRect = erPadCv.getBoundingClientRect();
const erPadCell = st.viewOpts.cellPx;
const erPadTrue = Math.floor((erPadCv.width - st.pattern.w * erPadCell) / 2);
const erPadWrong = Math.floor((erPadCv.height - st.pattern.h * erPadCell) / 2);
const erToClient = (px, py) => ({ clientX: px * erPadRect.width / erPadCv.width, clientY: py * erPadRect.height / erPadCv.height });
ok('橡皮刷坐标 | 前置 | 桩画布确实是「高 ≫ 宽」（否则这条覆盖不到角标带）', erPadRect.height > erPadCv.width * 2, erPadRect.height + ' vs ' + erPadCv.width);
ok('橡皮刷坐标 | 前置 | 角标带真的存在（画布高 > pad*2 + gridH）', erPadCv.height > erPadTrue * 2 + st.pattern.h * erPadCell, erPadCv.height + ' vs ' + (erPadTrue * 2 + st.pattern.h * erPadCell));
eq('橡皮刷坐标 | 点击格 (2,1) 的中心 → 命中下标 11', ui.hitTestCell(erToClient(erPadTrue + 2 * erPadCell + erPadCell / 2, erPadTrue + 1 * erPadCell + erPadCell / 2)), 11);
eq('橡皮刷坐标 | 落在网格下方的角标带内 → 返回未命中 -1', ui.hitTestCell(erToClient(erPadTrue + 2 * erPadCell + erPadCell / 2, erPadTrue + st.pattern.h * erPadCell + 8)), -1);
eq('橡皮刷坐标 | 落在网格左侧留白 → 返回未命中 -1', ui.hitTestCell(erToClient(erPadTrue - 2, erPadTrue + erPadCell / 2)), -1);
ok('橡皮刷坐标 | 反证：若按「高度反推 pad」就会算出别的行（说明命中判定真的走宽度）',
  erPadWrong !== erPadTrue && Math.floor((erPadTrue + 1 * erPadCell + erPadCell / 2 - erPadWrong) / erPadCell) !== 1,
  'pad(宽度)=' + erPadTrue + ' pad(高度)=' + erPadWrong);

/* 持久化（核心）：擦掉若干格 → 改参数重新生成 → 被擦格仍是 65535 */
const genCallCount = { n: 0 };
const erRealPipeline = globalThis.Pipeline;
sandboxWin.Pipeline = Object.assign({}, erRealPipeline, {
  generate(imageLike, opts) { genCallCount.n++; return erRealPipeline.generate(imageLike, opts); }
});
els.gridW.value = '10';
els.gridH.value = '10';
els.lockAspect.checked = false;
els.cellSize.value = '24';
els.showRuler.checked = false;
st.source = { data: synth(12, 12, (x, y) => [(x * 21) % 256, (y * 17) % 256, ((x + y) * 13) % 256]), width: 12, height: 12 };
st.srcW = 12;
st.srcH = 12;
st.history.length = 0;
erFlushAll();
const erGenBefore = genCallCount.n;
ui.regenerate();
erFlushAll();
ok('持久化 | 前置 | 确实跑了一次真 Pipeline 重算（走 generateFromRGBA + prevPattern）', genCallCount.n > erGenBefore, genCallCount.n + ' vs ' + erGenBefore);
const erPatA = st.pattern;
eq('持久化 | 前置 | 新图纸是 10×10 且一颗不缺', [erPatA.w, erPatA.h, erPatA.stats.total], [10, 10, 100]);
st.viewOpts = ui.viewOpts();
const erErased = ui.wandErase(0);
ok('持久化 | 前置 | 魔术棒至少擦掉 1 格', erErased >= 1, String(erErased));
const erErasedIdx = [];
for (let i = 0; i < erPatA.cells.length; i++) if (erPatA.cells[i] === EMPTY) erErasedIdx.push(i);
eq('持久化 | 前置 | 被擦格数 === 魔术棒返回值', erErasedIdx.length, erErased);
eq('持久化 | 前置 | 被擦格全部 locked === 1', erErasedIdx.filter((i) => erPatA.locked[i] === 1).length, erErasedIdx.length);
eq('持久化 | 前置 | 擦除后 stats.total = 100 - 擦掉数', erPatA.stats.total, 100 - erErased);
els.brightness.value = '60';
fire(els.brightness, 'input');
erFlushAll(6);
ok('持久化 | 改参数确实触发了第二次真重算', genCallCount.n > erGenBefore + 1, genCallCount.n + ' vs ' + (erGenBefore + 1));
const erPatB = st.pattern;
ok('持久化 | 重新生成产出的是新对象（真的重算了，不是原地复用）', erPatB !== erPatA);
eq('持久化 | 核心 | 被擦的每一格重新生成后仍然是 65535（locked-empty 被 Pipeline 继承）',
  erErasedIdx.filter((i) => erPatB.cells[i] === EMPTY).length, erErasedIdx.length);
eq('持久化 | 核心 | 这些格子的 locked 重新生成后仍是 1', erErasedIdx.filter((i) => erPatB.locked[i] === 1).length, erErasedIdx.length);
eq('持久化 | 核心 | stats.total 相应减少（= 100 - 擦掉数）', erPatB.stats.total, 100 - erErased);
eq('持久化 | 尺寸未变（否则 Pipeline 会忽略锁定并给警告）', [erPatB.w, erPatB.h], [10, 10]);
eq('持久化 | 没有出现「尺寸不一致 → 忽略锁定」类的告警',
  (erPatB.warnings || []).filter((w) => /忽略|尺寸不一致/.test(String(w))), []);
eq('持久化 | 擦掉的那部分没有被别的色号重新填回来（非空格数 === total）', erPatB.stats.total, erPatB.counts.reduce((s, c) => s + c.count, 0));

/* ── 5.4 图纸标题（只重渲染，不重算）──────────────────────────────────── */
els.chartTitle.value = '测试标题';
fire(els.chartTitle, 'input');
eq('图纸标题 | viewOpts().captionName 传出标题', ui.viewOpts().captionName, '测试标题');
eq('图纸标题 | exportViewOpts(2).captionName 也传出标题', ui.exportViewOpts(2).captionName, '测试标题');
eq('图纸标题 | 去首尾空白后传出', (els.chartTitle.value = '  A B  ', fire(els.chartTitle, 'input'), ui.viewOpts().captionName), 'A B');
eq('图纸标题 | 标题不进入导出几何（cellPx 仍是 24 × 倍数）', ui.exportViewOpts(2).cellPx, 48);
const erRendersBefore = drawCalls.filter((c) => c.cv === dom.map.patternCanvas).length;
const erGenBeforeTitle = genCallCount.n;
els.chartTitle.value = '标题改变';
fire(els.chartTitle, 'input');
erFlushAll();
eq('图纸标题 | 输入标题不触发重算（Pipeline.generate 调用次数完全不变）', genCallCount.n, erGenBeforeTitle);
ok('图纸标题 | 但确实触发了重渲染（#patternCanvas 上的 drawPattern 次数增加）',
  drawCalls.filter((c) => c.cv === dom.map.patternCanvas).length > erRendersBefore,
  erRendersBefore + ' → ' + drawCalls.filter((c) => c.cv === dom.map.patternCanvas).length);
const erTitleCalls = drawCalls.filter((c) => c.cv === dom.map.patternCanvas);
ok('图纸标题 | 重渲染实际传给 render 的 captionName 就是新标题（不是只有 viewOpts() 会说）',
  erTitleCalls.length > 0 && erTitleCalls[erTitleCalls.length - 1].opts.captionName === '标题改变',
  JSON.stringify(erTitleCalls.length ? erTitleCalls[erTitleCalls.length - 1].opts.captionName : null));
els.chartTitle.value = '';
fire(els.chartTitle, 'input');
erFlushAll();
eq('图纸标题 | 清空标题后 captionName 为空串（render.js 负责整段省略）', ui.viewOpts().captionName, '');

/* ══════════════════════════════════════════ 第 7 组 · 原图编辑（srcedit.js） */
startGroup('第 7 组 · 原图编辑（SourceEdit）');

/* 桩 canvas 必须模拟 ui.html 的 .source-canvas（width:100%;height:auto）：
   clientHeight 跟随 backing store 的固有比例，否则 viewScale 会在测试侧被算错
   （模块是对的，坑在测试侧 —— 已踩过）。 */
function makeEditWorld(clientW) {
  const created = { canvases: [] };
  const canvasHandlers = {};
  const canvas = {
    width: 0, height: 0, style: {}, parentElement: null,
    _cw: clientW,
    get clientWidth() { return this._cw; },
    get clientHeight() { return this.width > 0 ? Math.round(this._cw * this.height / this.width) : 0; },
    get clientLeft() { return 0; },
    get clientTop() { return 0; },
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; },
    getContext() { return this._ctx; },
    addEventListener(t, fn) { (canvasHandlers[t] = canvasHandlers[t] || []).push(fn); },
    removeEventListener(t, fn) { if (canvasHandlers[t]) canvasHandlers[t] = canvasHandlers[t].filter((f) => f !== fn); },
    dispatchEvent(evt) { (canvasHandlers[evt.type] || []).slice().forEach((fn) => fn(evt)); return true; }
  };
  canvas._ctx = makeRecCtx();
  const winHandlers = {};
  const win = {
    devicePixelRatio: 1,
    addEventListener(t, fn) { (winHandlers[t] = winHandlers[t] || []).push(fn); },
    removeEventListener(t, fn) { if (winHandlers[t]) winHandlers[t] = winHandlers[t].filter((f) => f !== fn); },
    dispatchEvent(evt) { (winHandlers[evt.type] || []).slice().forEach((fn) => fn(evt)); return true; },
    document: {
      createElement(tag) {
        if (String(tag).toLowerCase() !== 'canvas') return {};
        const cv = { width: 0, height: 0, _ctx: makeRecCtx(), getContext() { return this._ctx; } };
        created.canvases.push(cv);
        return cv;
      }
    }
  };
  let loadErr = null;
  try { vm.runInContext(srcText['srcedit.js'], vm.createContext({ window: win, console: { warn() {}, log() {} } }), { filename: 'srcedit.js' }); } catch (e) { loadErr = e; }
  return { win, canvas, created, loadErr };
}
function editFire(target, type, x, y) {
  target.dispatchEvent({ type, button: 0, pointerId: 1, clientX: x, clientY: y, target, currentTarget: target, preventDefault() {}, stopPropagation() {} });
}

const world = makeEditWorld(400);
eq('srcedit | 在 vm 沙箱里加载无抛错', world.loadErr, null);
const SE = world.win.SourceEdit;
ok('srcedit | window.SourceEdit 挂上且 mount 是函数', !!SE && typeof SE.mount === 'function');
let notifyCount = 0;
const api = SE.mount(world.canvas, { onChange() { notifyCount++; } });
ok('srcedit | mount 返回带全部契约方法的 api', ['setSource', 'getResultCanvas', 'getState', 'rotate', 'flip', 'setAspect', 'reset', 'hasTransform'].every((k) => typeof api[k] === 'function'), Object.keys(api).join(','));
const st0 = api.getState();
eq('srcedit | 初始 crop === null / hasCrop === false', [st0.crop, st0.hasCrop], [null, false]);
eq('srcedit | 初始 rotation === 0 且两个翻转都关', [st0.rotation, st0.flipH, st0.flipV], [0, false, false]);
eq('srcedit | 初始 aspect === "free" / hasTransform() === false', [st0.aspect, api.hasTransform()], ['free', false]);
eq('srcedit | 无源图时 getResultCanvas() 返回 null', api.getResultCanvas(), null);

/* 坐标系：clientWidth 固定 400，故 frame 坐标 f ↔ clientX = f * (400 / frameW)。
   换算必须用**当前帧的宽度**，且不做 round：否则小图上「1 帧像素」会退化到小于
   CLICK_SLOP(3) 的位移，pointerup 会被模块判成「点击」→ 走 fallbackRect 分支，
   断言就会在「没测拖拽」的情况下通过（本套件踩过这个坑）。 */
const SRCW = 200;
const SRCH = 100;
const VIEW_W = 400;
const src200 = { naturalWidth: SRCW, naturalHeight: SRCH };
const dragIn = (frameW, from, to, steps) => {
  const s = VIEW_W / frameW;
  const X = (f) => f * s;
  editFire(world.canvas, 'pointerdown', X(from[0]), X(from[1]));
  const n = steps || 1;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    editFire(world.win, 'pointermove', X(from[0] + (to[0] - from[0]) * t), X(from[1] + (to[1] - from[1]) * t));
  }
  editFire(world.win, 'pointerup', X(to[0]), X(to[1]));
};
const drag = (from, to, steps) => dragIn(SRCW, from, to, steps);
const c200 = (f) => f * (VIEW_W / SRCW);   /* 仅 200×100 帧的 frame→client 换算（供手动派发事件的用例） */
const reseed = () => { api.setSource(src200); api.setAspect('free'); notifyCount = 0; };
const boundsOk = (c) => !!c && c.x >= 0 && c.y >= 0 && c.x + c.w <= SRCW && c.y + c.h <= SRCH && c.w >= 8 && c.h >= 8;

/* 初始状态与载入源图 */
reseed();
ok('srcedit | setSource 有效源图返回 true', api.setSource(src200) === true);
api.setSource(src200);
eq('srcedit | 载入源图后 getResultCanvas() = 原图 200×100', [api.getResultCanvas().width, api.getResultCanvas().height], [SRCW, SRCH]);

/* 正向拖拽 */
reseed();
drag([10, 10], [60, 40]);
eq('srcedit | 正向拖拽 → 框为 {10,10,50,30}', api.getState().crop, { x: 10, y: 10, w: 50, h: 30 });
ok('srcedit | 正向拖拽后 hasCrop === true', api.getState().hasCrop === true);

/* 反向拖拽（两轴都反向）：宽高必须为正 */
reseed();
drag([60, 40], [10, 10]);
const rev = api.getState().crop;
ok('srcedit | 反向拖拽（两轴都反向）→ w > 0 且 h > 0', rev.w > 0 && rev.h > 0, JSON.stringify(rev));
eq('srcedit | 反向拖拽得到与正向相同的框', rev, { x: 10, y: 10, w: 50, h: 30 });

/* 起止越界被夹取 */
reseed();
drag([100, 50], [500, 500]);
eq('srcedit | 终点越界 → 夹到右下角 {100,50,100,50}', api.getState().crop, { x: 100, y: 50, w: 100, h: 50 });
reseed();
drag([150, 80], [0, 0]);
eq('srcedit | 终点越到负坐标 → 夹到左上角 {0,0,150,80}', api.getState().crop, { x: 0, y: 0, w: 150, h: 80 });
reseed();
drag([190, 90], [195, 95]);
eq('srcedit | 起点贴右下角的最小拖拽仍是合法框（正向）', api.getState().crop, { x: 190, y: 90, w: 8, h: 8 });
reseed();
drag([100, 50], [103, 50]);
eq('srcedit | 最小尺寸下限实测 8×8', [api.getState().crop.w, api.getState().crop.h], [8, 8]);

/* 8 个柄的「对边不动」不变量 */
const SEED = { x: 20, y: 15, w: 40, h: 30 };
const HANDLES = [
  { name: 'nw', p: [20, 15], to: [10, 10], inv: (c) => c.x + c.w === 60 && c.y + c.h === 45 },
  { name: 'n', p: [40, 15], to: [40, 5], inv: (c) => c.x === 20 && c.w === 40 && c.y + c.h === 45 },
  { name: 'ne', p: [60, 15], to: [70, 10], inv: (c) => c.x === 20 && c.y + c.h === 45 },
  { name: 'e', p: [60, 30], to: [80, 30], inv: (c) => c.x === 20 && c.y === 15 && c.h === 30 },
  { name: 'se', p: [60, 45], to: [75, 60], inv: (c) => c.x === 20 && c.y === 15 },
  { name: 's', p: [40, 45], to: [40, 60], inv: (c) => c.x === 20 && c.y === 15 && c.w === 40 },
  { name: 'sw', p: [20, 45], to: [10, 60], inv: (c) => c.x + c.w === 60 && c.y === 15 },
  { name: 'w', p: [20, 30], to: [10, 30], inv: (c) => c.x + c.w === 60 && c.y === 15 && c.h === 30 }
];
for (const h of HANDLES) {
  reseed();
  drag([SEED.x, SEED.y], [SEED.x + SEED.w, SEED.y + SEED.h]);
  const seeded = api.getState().crop;
  ok('srcedit | 柄 ' + h.name + ' | 种子框存在', !!seeded, JSON.stringify(seeded));
  eq('srcedit | 柄 ' + h.name + ' | 种子框 === {20,15,40,30}', seeded, SEED);
  if (!seeded) continue;
  drag(h.p, h.to);
  const c = api.getState().crop;
  ok('srcedit | 柄 ' + h.name + ' | 对边不动（拖到 ' + h.to.join(',') + '）', !!c && h.inv(c), JSON.stringify(c));
  ok('srcedit | 柄 ' + h.name + ' | 拖后框仍在图内且 ≥ 8×8', boundsOk(c), JSON.stringify(c));
}

/* setAspect('square')：|w-h| ≤ 1 且不越界（含拖出画布的方向） */
reseed();
drag([SEED.x, SEED.y], [SEED.x + SEED.w, SEED.y + SEED.h]);
eq('srcedit | setAspect("square") 返回 true', api.setAspect('square'), true);
eq('srcedit | 切换正方形后 aspect === "square"', api.getState().aspect, 'square');
const sqBefore = api.getState().crop;
ok('srcedit | 切换时以中心为锚就地变方（|w-h| ≤ 1）', Math.abs(sqBefore.w - sqBefore.h) <= 1, JSON.stringify(sqBefore));
const SQ_TARGETS = [[0, 0], [250, 10], [10, 90], [150, 95], [300, 300], [-30, 50]];
/* square 模式的完整不变量（srcedit.js 文件头「坐标系与几何约定」）：恒有
   |w-h| ≤ 1、w ≥ ms、h ≥ ms、0 ≤ x/y 且 x+w ≤ fw、y+h ≤ fh，其中 ms = max(1, min(8, fw, fh))。
   下限必须按**该用例自己的帧尺寸**算（小图时 ms < 8），不能写死 8。 */
const msOf = (fw, fh) => Math.max(1, Math.min(8, fw, fh));
const inFrame = (c, fw, fh) => !!c && c.x >= 0 && c.y >= 0 && c.x + c.w <= fw && c.y + c.h <= fh;
const squareOk = (c, fw, fh) => inFrame(c, fw, fh) && Math.abs(c.w - c.h) <= 1 && c.w >= msOf(fw, fh) && c.h >= msOf(fw, fh);
let sqMinSeen = Infinity;
const sqSeen = [];
for (const t of SQ_TARGETS) {
  const cur = api.getState().crop;
  ok('srcedit | 正方形 | 拖拽起点（当前 nw 柄）存在', !!cur, JSON.stringify(cur));
  if (!cur) continue;
  drag([cur.x, cur.y], t);
  const c = api.getState().crop;
  ok('srcedit | 正方形 | 拖到 (' + t.join(',') + ') 后框存在', !!c, JSON.stringify(c));
  if (!c) continue;
  ok('srcedit | 正方形 | 拖到 (' + t.join(',') + ') 后 |w-h| ≤ 1', Math.abs(c.w - c.h) <= 1, JSON.stringify(c));
  ok('srcedit | 正方形 | 拖到 (' + t.join(',') + ') 后在图内', inFrame(c, SRCW, SRCH), JSON.stringify(c));
  ok('srcedit | 正方形 | 拖到 (' + t.join(',') + ') 后 w ≥ ms 且 h ≥ ms（ms=' + msOf(SRCW, SRCH) + '）', c.w >= msOf(SRCW, SRCH) && c.h >= msOf(SRCW, SRCH), JSON.stringify(c));
  sqSeen.push(c.w + '×' + c.h);
  sqMinSeen = Math.min(sqMinSeen, c.w, c.h);
}
eq('srcedit | 正方形拖拽后 aspect 仍是 "square"', api.getState().aspect, 'square');

/* ── 新增：极端贴边序列（SE 贴右下角 → NW 再越过它）—— 必守 ms，且可复跑 ── */
const extremeSequence = () => {
  reseed();
  drag([SEED.x, SEED.y], [SEED.x + SEED.w, SEED.y + SEED.h]);
  api.setAspect('square');                              /* {20,10,40,40}（中心不变） */
  const sq = api.getState().crop;
  drag([sq.x + sq.w, sq.y + sq.h], [SRCW, SRCH]);       /* SE 柄拖到右下角贴边 */
  const pinned = api.getState().crop;
  drag([pinned.x, pinned.y], [SRCW, SRCH]);             /* NW 柄再越过贴边锚点（沿锚点方向可用空间=0） */
  return { sq, pinned, after: api.getState().crop };
};
const extA = extremeSequence();
ok('srcedit | 极端贴边 | 切方后框存在', !!extA.sq, JSON.stringify(extA.sq));
eq('srcedit | 极端贴边 | 切方后就地变方 {20,10,40,40}（中心不变）', extA.sq, { x: 20, y: 10, w: 40, h: 40 });
ok('srcedit | 极端贴边 | SE 贴右下角后框存在', !!extA.pinned, JSON.stringify(extA.pinned));
eq('srcedit | 极端贴边 | SE 拖到右下角 → {20,10,90,90}（右下角贴边）', extA.pinned, { x: 20, y: 10, w: 90, h: 90 });
ok('srcedit | 极端贴边 | 越过锚点后框存在', !!extA.after, JSON.stringify(extA.after));
eq('srcedit | 极端贴边 | NW 越过贴边锚点 → 保下限 {110,92,8,8}（不缩成 1×1，锚点最多挪到贴边）', extA.after, { x: 110, y: 92, w: 8, h: 8 });
ok('srcedit | 极端贴边 | 结果满足全部不变量（1:1 / ≥ms / 在图内）', squareOk(extA.after, SRCW, SRCH), JSON.stringify(extA.after));
const extB = extremeSequence();
eq('srcedit | 极端贴边 | 同序列重跑逐字段一致', JSON.stringify(extB), JSON.stringify(extA));
eq('srcedit | 极端贴边 | 重跑的两个中间态也逐字段一致', [JSON.stringify(extB.sq), JSON.stringify(extB.pinned)], [JSON.stringify(extA.sq), JSON.stringify(extA.pinned)]);
sqMinSeen = Math.min(sqMinSeen, extA.after.w, extA.after.h);

/* ── 新增：极小图的下限按 min(8, fw, fh) 跟随 ─────────────────────────── */
const tinyCase = (fw, fh) => {
  api.setSource({ naturalWidth: fw, naturalHeight: fh });
  api.setAspect('square');
  dragIn(fw, [0, 0], [fw, fh]);                       /* 满拖，正好取到整图 */
  const exact = api.getState().crop;
  dragIn(fw, [0, 0], [fw * 10 + 50, fh * 10 + 50]);   /* 再满拖一次（远超图外）应得到同一个框 */
  return { exact, overshoot: api.getState().crop };
};
const t5 = tinyCase(5, 5);
ok('srcedit | 极小图 | 5×5 满拖后框存在', !!t5.exact, JSON.stringify(t5.exact));
eq('srcedit | 极小图 | 5×5（ms = min(8,5,5) = 5）→ {0,0,5,5}', t5.exact, { x: 0, y: 0, w: 5, h: 5 });
ok('srcedit | 极小图 | 5×5 满足 1:1 / ≥ms / 在图内', squareOk(t5.exact, 5, 5), JSON.stringify(t5.exact));
eq('srcedit | 极小图 | 5×5 拖出图外与满拖得到同一框', t5.overshoot, t5.exact);
const t1 = tinyCase(1, 1);
ok('srcedit | 极小图 | 1×1 满拖后框存在', !!t1.exact, JSON.stringify(t1.exact));
eq('srcedit | 极小图 | 1×1（ms = min(8,1,1) = 1）→ {0,0,1,1}', t1.exact, { x: 0, y: 0, w: 1, h: 1 });
eq('srcedit | 极小图 | 1×1 拖出图外与满拖得到同一框', t1.overshoot, t1.exact);
/* 这一次是自由的 1 帧像素拖拽（不是「点击 → fallbackRect」）：12 帧宽下 1 帧 = 33.3 CSS px，
   远超 CLICK_SLOP，模块必然走 resizeCorner 并把短边下限夹到 ms = min(8,12,4) = 4。 */
api.setSource({ naturalWidth: 12, naturalHeight: 4 });
api.setAspect('free');
dragIn(12, [0, 0], [1, 1]);
eq('srcedit | 极小图 | 12×4（ms = min(8,12,4) = 4）自由比例下小拖亦不小于 ms → {0,0,4,4}', api.getState().crop, { x: 0, y: 0, w: 4, h: 4 });
api.setAspect('free');

/* 判别「真拖拽」与「点击 → fallbackRect」：kind:'new' 且位移未过 CLICK_SLOP(3) 时，
   模块在 pointermove 里直接 return，crop 仍为 null；只有真拖拽才会在 move 阶段就建框。
   极小图上「1 帧像素」= 很大一段 CSS 距离，故这里显式验证 move 阶段已建框 ——
   否则 1×1 的 {0,0,1,1} 与点击兜底的结果相同，断言会在没测到拖拽的情况下通过。 */
const midDragProof = (fw, fh) => {
  api.setSource({ naturalWidth: fw, naturalHeight: fh });
  api.setAspect('square');
  const s = VIEW_W / fw;
  editFire(world.canvas, 'pointerdown', 0, 0);
  editFire(world.win, 'pointermove', fw * s, fh * s);
  const mid = api.getState().crop;
  editFire(world.win, 'pointerup', fw * s, fh * s);
  return { mid, after: api.getState().crop };
};
const m1 = midDragProof(1, 1);
ok('srcedit | 极小图 | 1×1 在 pointermove 阶段就已建框（证明走的是拖拽分支，不是点击兜底）', !!m1.mid, JSON.stringify(m1.mid));
eq('srcedit | 极小图 | 1×1 move 阶段与 pointerup 之后一致', [m1.mid, m1.after], [{ x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 1, h: 1 }]);
const m5 = midDragProof(5, 5);
ok('srcedit | 极小图 | 5×5 在 pointermove 阶段就已建框', !!m5.mid, JSON.stringify(m5.mid));
eq('srcedit | 极小图 | 5×5 move 阶段框 = {0,0,5,5}', m5.mid, { x: 0, y: 0, w: 5, h: 5 });
api.setAspect('free');

/* rotate / flip 的恒等与合法参数 */
reseed();
for (let i = 0; i < 4; i++) api.rotate(90);
const stR4 = api.getState();
eq('srcedit | rotate(90)×4 === 恒等（rotation 0 / 无翻转 / 无裁剪）', [stR4.rotation, stR4.flipH, stR4.flipV, stR4.crop], [0, false, false, null]);
eq('srcedit | rotate(90)×4 后 hasTransform() === false', api.hasTransform(), false);
reseed();
drag([20, 15], [60, 45]);
ok('srcedit | 旋转前确实有裁剪框（种子断言）', !!api.getState().crop);
api.rotate(90);
const stR1 = api.getState();
eq('srcedit | rotate(90) → rotation 90 且 crop 被清空（冻结语义）', [stR1.rotation, stR1.crop, stR1.hasCrop], [90, null, false]);
eq('srcedit | rotate(90) 后结果画布宽高互换（200×100 → 100×200）', [api.getResultCanvas().width, api.getResultCanvas().height], [SRCH, SRCW]);
api.rotate(-90);
eq('srcedit | rotate(90) 再 rotate(-90) 回到原尺寸', [api.getResultCanvas().width, api.getResultCanvas().height], [SRCW, SRCH]);
reseed();
eq('srcedit | flip("h") 两次 === 恒等', [api.flip('h'), api.flip('h'), api.hasTransform()], [true, true, false]);
eq('srcedit | flip("v") 两次 === 恒等', [api.flip('v'), api.flip('v'), api.hasTransform()], [true, true, false]);
const stFlip = api.getState();
eq('srcedit | 两次翻转后 rotation / flipH / flipV 全归零', [stFlip.rotation, stFlip.flipH, stFlip.flipV], [0, false, false]);

/* 非法参数：返回 false 且状态逐字段不变 */
const snapBefore = JSON.stringify(api.getState());
eq('srcedit | rotate(45) 返回 false', api.rotate(45), false);
eq('srcedit | flip("x") 返回 false', api.flip('x'), false);
eq('srcedit | setAspect("wide") 返回 false', api.setAspect('wide'), false);
eq('srcedit | 三次非法调用后状态逐字段不变', JSON.stringify(api.getState()), snapBefore);
ok('srcedit | getLastError() 记录了最近一次被拒绝的原因', typeof api.getLastError() === 'string' && api.getLastError().length > 0, String(api.getLastError()));

/* getResultCanvas 的尺寸语义 */
reseed();
eq('srcedit | 无裁剪无旋转 → 结果尺寸 = 原图', [api.getResultCanvas().width, api.getResultCanvas().height], [SRCW, SRCH]);
drag([20, 15], [60, 45]);
eq('srcedit | 有裁剪 → 结果尺寸 = 裁剪框尺寸', [api.getResultCanvas().width, api.getResultCanvas().height], [40, 30]);
eq('srcedit | reset() 返回 true', api.reset(), true);
eq('srcedit | reset() → 回原图尺寸且 crop 清空', [api.getResultCanvas().width, api.getResultCanvas().height, api.getState().crop], [SRCW, SRCH, null]);

/* 缓存：状态未变 → 同一对象；状态一变 → 新对象 */
reseed();
const cA = api.getResultCanvas();
const cB = api.getResultCanvas();
ok('srcedit | 缓存 | 状态未变时两次调用返回同一对象', !!cA && cA === cB);
api.rotate(90);
const cC = api.getResultCanvas();
ok('srcedit | 缓存 | rotate 后返回新对象（旧引用不被悄悄改写）', cC !== cA && cC !== cB);
eq('srcedit | 缓存 | rotate 后新对象尺寸正确', [cC.width, cC.height], [SRCH, SRCW]);
api.rotate(-90);
const cD = api.getResultCanvas();
ok('srcedit | 缓存 | 转回原状态也换新对象（按状态签名而非形状判定）', cD !== cA && cD !== cC);
eq('srcedit | 缓存 | 转回后尺寸正确', [cD.width, cD.height], [SRCW, SRCH]);

/* 拖拽期间零光栅化 */
reseed();
world.created.canvases.length = 0;
notifyCount = 0;
editFire(world.canvas, 'pointerdown', c200(20), c200(15));
for (let i = 1; i <= 5; i++) editFire(world.win, 'pointermove', c200(20 + i * 8), c200(15 + i * 6));
eq('srcedit | 拖拽期间零光栅化（5 次 pointermove 未创建任何结果 canvas）', world.created.canvases.length, 0);
eq('srcedit | 拖拽期间零 onChange（pointermove 不通知）', notifyCount, 0);
eq('srcedit | 拖拽期间 crop 已随指针更新（预览态）', api.getState().crop, { x: 20, y: 15, w: 40, h: 30 });
editFire(world.win, 'pointerup', c200(60), c200(45));
eq('srcedit | pointerup 本身也不自动光栅化（惰性生成）', world.created.canvases.length, 0);
eq('srcedit | pointerup 触发恰好 1 次 onChange', notifyCount, 1);
eq('srcedit | pointerup 后得框 = 起止点构成的框', api.getState().crop, { x: 20, y: 15, w: 40, h: 30 });
api.getResultCanvas();
eq('srcedit | 惰性生成：首次 getResultCanvas() 才创建 1 块结果 canvas', world.created.canvases.length, 1);
api.getResultCanvas();
eq('srcedit | 生成后该状态命中缓存（再调不新建）', world.created.canvases.length, 1);

/* setSource：0 尺寸必须被拒绝且保留上一个有效源 */
reseed();
drag([20, 15], [60, 45]);
const beforeInvalid = JSON.stringify(api.getState());
const cBeforeInvalid = api.getResultCanvas();
let invalidThrew = '';
let invalidRet = null;
try { invalidRet = api.setSource({ naturalWidth: 0, naturalHeight: 0, width: 0, height: 0 }); } catch (e) { invalidThrew = e.message; }
eq('srcedit | setSource(0 尺寸) 返回 false 且不抛异常', [invalidThrew, invalidRet], ['', false]);
eq('srcedit | setSource(0 尺寸) 保留上一个有效源（状态逐字段不变）', JSON.stringify(api.getState()), beforeInvalid);
const cAfterInvalid = api.getResultCanvas();
ok('srcedit | setSource(0 尺寸) 后结果尺寸仍是有限正数（不是 null）', !!cAfterInvalid && Number.isFinite(cAfterInvalid.width) && cAfterInvalid.width > 0 && Number.isFinite(cAfterInvalid.height) && cAfterInvalid.height > 0, JSON.stringify(cAfterInvalid ? { w: cAfterInvalid.width, h: cAfterInvalid.height } : null));
eq('srcedit | setSource(0 尺寸) 后缓存对象未被换掉', cAfterInvalid, cBeforeInvalid);
ok('srcedit | setSource(0 尺寸) 给出了可读的 lastError', String(api.getLastError()).includes('尺寸为 0'), String(api.getLastError()));
eq('srcedit | setSource(null) 清空源图并返回 true', api.setSource(null), true);
eq('srcedit | 清空源图后 getResultCanvas() 返回 null', api.getResultCanvas(), null);

/* mount(null) / mount({})：可安全调用的空操作 api */
const inert = SE.mount(null);
ok('srcedit | mount(null) 返回对象（不是 undefined）', !!inert && typeof inert === 'object');
const inertErrs = [];
const safe = (label, fn) => { try { return fn(); } catch (e) { inertErrs.push(label + ' → ' + e.message); return undefined; } };
eq('srcedit | mount(null) | getResultCanvas() → null', safe('getResultCanvas', () => inert.getResultCanvas()), null);
eq('srcedit | mount(null) | setSource({}) → false', safe('setSource', () => inert.setSource({})), false);
eq('srcedit | mount(null) | rotate/flip/setAspect/reset → false', [safe('rotate', () => inert.rotate(90)), safe('flip', () => inert.flip('h')), safe('setAspect', () => inert.setAspect('square')), safe('reset', () => inert.reset())], [false, false, false, false]);
eq('srcedit | mount(null) | hasTransform() → false', safe('hasTransform', () => inert.hasTransform()), false);
eq('srcedit | mount(null) | getState() 返回初始状态', safe('getState', () => inert.getState()), { rotation: 0, flipH: false, flipV: false, crop: null, hasCrop: false, aspect: 'free' });
safe('destroy', () => inert.destroy());
eq('srcedit | mount(null) | 所有方法调用零异常', inertErrs, []);
ok('srcedit | mount({})（无 getContext）同样降级为惰性 api', !!SE.mount({}) && typeof SE.mount({}).getResultCanvas === 'function');

/* square 模式的尺寸下限（修复后的事实，可核对）：
   resizeCorner 的 square 分支是 `s = Math.max(Math.min(s, lim), ms)`，其中
   lim = max(0, min(limX, limY))、ms = max(1, min(MIN_SIZE(8), fw, fh))：边长先夹进边界允许范围，
   再把下界抬到 ms；被抬过 lim 的部分由 rectFromCorner→fitRect 整体平移回图内，
   因此锚点最多被挪到贴边处（「尺寸下限优先于锚点固定」，见 srcedit.js 文件头）。
   即 square 模式下 w === h 与 w,h >= ms 同时成立 —— 本组的 square 用例（6 个拖拽目标 +
   极端贴边序列 + 极小图 5×5 / 1×1）都按这个不变量断言，其中极小图按 ms = min(8, fw, fh) 跟随。 */
info('srcedit square 下限策略：6 个拖拽目标实测 ' + sqSeen.join(' → ') + '（帧 200×100 → ms = 8）；'
  + '极端贴边序列 40×40 → 90×90 → 8×8 且锚点被平移到 {110,92}、不缩框；'
  + '极小图 5×5 → 5×5（ms=5）、1×1 → 1×1（ms=1）、12×4 → 4×4（ms=4）。'
  + '全部满足 1:1 与 ≥ms 同时成立，本轮观测最小边长 side = ' + sqMinSeen + 'px。');

/* ═════════════════════════════════════════════════════════════ 汇总 */
console.log('\n════════════ 分组小结 ════════════');
for (const g of groupStats) {
  console.log('  ' + (g.fail === 0 ? 'PASS' : 'FAIL') + '  ' + g.title + '  (' + g.pass + ' PASS / ' + g.fail + ' FAIL)');
}
console.log('');
if (fail === 0) {
  console.log('VERDICT: ALL GREEN — ' + assertions + ' 条断言全部通过（' + groupStats.length + ' 组）');
  console.log('未覆盖：真实浏览器里的像素级视觉外观（字体度量/抗锯齿/打印分页）、真实下载与打印、滚轮与触摸输入 —— 本脚本无浏览器，属人工验收。');
  process.exit(0);
} else {
  console.log('VERDICT: FAILURES=' + fail + ' -> ' + assertions + ' 条断言中 ' + pass + ' 过 / ' + fail + ' 败');
  for (const f of failures) console.log('  · ' + f);
  process.exit(1);
}
