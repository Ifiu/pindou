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
const PRODUCT = path.join(ROOT, 'index.html');
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
/* Render 的对外 API 冻结清单：本轮删掉「对照图」功能，只剩 4 个（用户要求整条删除） */
eq('Render 的对外 API 恰好是这 4 个（drawPattern / exportPNG / exportCSV / legendHTML）',
  Object.keys(Render).sort(), ['drawPattern', 'exportCSV', 'exportPNG', 'legendHTML']);
ok('Render.drawCompare 已删除（typeof === "undefined"，不是留着不导出）', typeof Render.drawCompare === 'undefined', typeof Render.drawCompare);

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
/* 桩画布补全浏览器**本来就有的**能力：toBlob / toDataURL。
   没有它，「触摸端长按保存」这条路径（toBlob → createObjectURL → img.src）在桩里永远走不通，
   会逼实现者写一句「只在测试里成立」的假代码 —— 桩该如实提供真浏览器的能力。
   注意：Render.exportPNG 的「没有 toBlob 必须明确 reject」那条断言用的是**专门构造的空对象**
   （`Render.exportPNG({}, 'x.png')`），不依赖这里的默认能力，所以两者可以共存。 */
function canvasCaps(cv) {
  if (typeof cv.toBlob !== 'function') cv.toBlob = function (cb, type) { cb({ type: type || 'image/png', size: 1 }); };
  if (typeof cv.toDataURL !== 'function') cv.toDataURL = function (type) { return 'data:' + (type || 'image/png') + ';base64,AAAA'; };
  return cv;
}
function makeUrlStub() {
  let n = 0;
  return { createObjectURL() { return 'blob:stub/' + (++n); }, revokeObjectURL() {} };
}
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
  const canvas = canvasCaps({ width: 0, height: 0, _rec: rec, getContext(kind) { return kind === '2d' ? ctx : null; } });
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

/* 逐格标签期望值：只保留 'code'（'index' 数字编码已被用户要求彻底删除） */
function expectedLabels(pat, cellPx, pad) {
  const out = [];
  for (let i = 0; i < pat.w * pat.h; i++) {
    const idx = pat.cells[i];
    if (idx === EMPTY) continue;
    out.push({
      text: String(pat.colors[idx].code),
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

/* 'index'（格内数字编号）已被用户要求彻底删除：它不再是一种模式。
   传 'index' 必须等价于「不画」（fail-safe），绝不能回退成数字编号。 */
const INDEX_PX = 20;
const cv1i = makeMockCanvas();
const r1i = Render.drawPattern(HP, cv1i, { cellPx: INDEX_PX, cellLabel: 'index', showRuler: false, padMode: 'normal' });
eq('drawPattern | cellLabel:"index" 已不是一种模式 → codesDrawn === false', r1i.codesDrawn, false);
eq('drawPattern | cellLabel:"index" → labelsDrawn/labelsSuppressed 都是 false', [r1i.labelsDrawn, r1i.labelsSuppressed], [false, false]);
eq('drawPattern | cellLabel:"index" → 一次文字都不画（等价于 none）', cv1i._rec.fillText.length, 0);
eq('drawPattern | cellLabel:"index" → 仍然逐格填色（删掉的只是文字模式）', cellFillsOf(cv1i).length, HP_NONEMPTY);
ok('drawPattern | cellLabel:"index" → 绝不出现纯数字编号', !cv1i._rec.fillText.some((t) => /^\d+$/.test(String(t.text))), JSON.stringify(cv1i._rec.fillText.slice(0, 4)));

const cv8 = makeMockCanvas();
const r8 = Render.drawPattern(HP, cv8, { cellPx: 8, cellLabel: 'none', showRuler: false, padMode: 'normal' });
eq('drawPattern | cellPx=8 + cellLabel:none → 返回 codesDrawn:false', r8.codesDrawn, false);
eq('drawPattern | cellPx=8 → 不写编号（fillText 0 次）', cv8._rec.fillText.length, 0);
eq('drawPattern | cellPx=8 → 仍然逐格填色', cellFillsOf(cv8).length, HP_NONEMPTY);
eq('drawPattern | cellPx=8 → pad = max(40, 8*3+20) = 44，画布宽 128', cv8._rec.fillRect[0].w, Math.max(40, 8 * 3 + 20) * 2 + HP.w * 8);

const cv9 = makeMockCanvas();
const r9 = Render.drawPattern(HP, cv9, { cellPx: 9, cellLabel: 'index', showRuler: false, padMode: 'normal' });
eq('drawPattern | cellPx=9 + cellLabel:"index"（已删除的模式）→ codesDrawn:false', r9.codesDrawn, false);
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
/* 必须显式给 cellLabel:'code'：本轮 render.js 的缺省规则改成「没给 cellLabel 时按缺省 none」，
   不给就测不到「code 模式在 12px 被抑制」这件事本身（断言意图不变，只是把隐式默认写成显式）。 */
const rR = Render.drawPattern(realPat, cvR, { cellPx: 12, cellLabel: 'code', padMode: 'normal' });
eq('整合 | 真实 Pattern（' + realPat.w + '×' + realPat.h + '）cellsDrawn === 非空格数', cvR._rec.fillRect.length - 1, realNonEmpty);
eq('整合 | 真实 Pattern 逐格填色位置与颜色精确匹配', cellFillsOf(cvR), expectedFills(realPat, 12, 56));
/* cellPx=12 下 code 模式被抑制 → 只剩刻度数字：w=29 有 6 个刻度、h=22 有 5 个刻度 */
eq('整合 | cellPx=12 → 标签被抑制，fillText 只剩刻度 6+5=11 个', cvR._rec.fillText.length, 11);
eq('整合 | cellPx=12 → labelsSuppressed === true', rR.labelsSuppressed, true);
/* 显式 cellLabel + cellPx ≥ 20 时才是「非空格数 + 刻度数」（原 index 用例改为 code：index 已删除） */
const cvR2 = makeMockCanvas();
const rR2 = Render.drawPattern(realPat, cvR2, { cellPx: 20, cellLabel: 'code', padMode: 'normal' });
eq('整合 | cellPx=20 + cellLabel:code → fillText = 非空格数 + 刻度数', cvR2._rec.fillText.length, realNonEmpty + 11, 'w=29 有 6 个刻度、h=22 有 5 个刻度');
eq('整合 | cellPx=20 + cellLabel:code → labelsDrawn === true', rR2.labelsDrawn, true);

/* ══════════════════════════════════ 新增覆盖：标签模式 / 版式 / 守卫 / 刻度 / 板边界 */
/* 本次用 HP（5×4，色号 2 字符）作为标签用例的载体：只剩 code 一档阈值 20（index 已删除） */
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
eq('新增 | cellLabel:code → 逐格文字 === colors[cells[i]].code', code24.texts, expectedLabels(HP, LABEL_PX, LABEL_PAD).map((o) => o.text));
eq('新增 | cellLabel:code → 逐格位置 === 格中心', code24.pos, expectedLabels(HP, LABEL_PX, LABEL_PAD).map((o) => [o.x, o.y]));
eq('新增 | cellLabel:none → 零 fillText', none24.texts.length, 0);
eq('新增 | cellLabel:none → labelsDrawn/labelsSuppressed/labelMinPx', [none24.r.labelsDrawn, none24.r.labelsSuppressed, none24.r.labelMinPx], [false, false, 0]);
eq('新增 | cellLabel:none → 仍然逐格填色', cellFillsOf(none24.cv).length, HP_NONEMPTY);
ok('新增 | cellLabel:"index"（已删除的模式）→ 文字与 none 完全一致（零文字）', index24.texts.length === 0 && index24.r.labelsDrawn === false, JSON.stringify(index24.texts.slice(0, 4)));

/* 阈值边界：只剩 code 一档（19 不画 / 20 画）；index 模式已删除，不再有 17 这一档 */
const code19 = drawHP({ cellPx: 19, cellLabel: 'code' });
const code20 = drawHP({ cellPx: 20, cellLabel: 'code' });
const index16 = drawHP({ cellPx: 16, cellLabel: 'index' });
const index17 = drawHP({ cellPx: 17, cellLabel: 'index' });
eq('新增 | 阈值 | code@19 不画（codesDrawn/填字）', [code19.r.codesDrawn, code19.texts.length], [false, 0]);
eq('新增 | 阈值 | code@20 画（codesDrawn/填字）', [code20.r.codesDrawn, code20.texts.length], [true, HP_NONEMPTY]);
eq('新增 | 阈值 | code 的 labelsSuppressed / labelMinPx（19 / 20）', [code19.r.labelsSuppressed, code20.r.labelsSuppressed, code19.r.labelMinPx, code20.r.labelMinPx], [true, false, 20, 20]);
eq('新增 | 阈值 | index@16 / index@17 都不画（该模式已删除，不存在 17 阈值档）',
  [index16.r.codesDrawn, index16.texts.length, index17.r.codesDrawn, index17.texts.length], [false, 0, false, 0]);
eq('新增 | 阈值 | index 模式的 labelMinPx 不再是 17（回落到 none 的 0）', [index16.r.labelMinPx, index17.r.labelMinPx], [0, 0]);

/* 向后兼容：showCodes 旧键与 cellLabel 新键的优先级（index 已删除，只保证不再画数字编号） */
const oldFalse = drawHP({ cellPx: LABEL_PX, cellLabel: undefined, showCodes: false });
const oldTrue = drawHP({ cellPx: LABEL_PX, cellLabel: undefined, showCodes: true });
const both = drawHP({ cellPx: LABEL_PX, cellLabel: 'code', showCodes: true });
const both2 = drawHP({ cellPx: LABEL_PX, cellLabel: 'index', showCodes: false });
const noKey = drawHP({ cellPx: LABEL_PX });
eq('新增 | 兼容 | {showCodes:false} → 零标签', oldFalse.texts.length, 0);
eq('新增 | 兼容 | {showCodes:false} → codesDrawn false', oldFalse.r.codesDrawn, false);
ok('新增 | 兼容 | {showCodes:true} 单独给出 → 绝不画数字编号（index 已删除）',
  !oldTrue.texts.some((t) => /^\d+$/.test(String(t))), JSON.stringify(oldTrue.texts.slice(0, 6)));
eq('新增 | 兼容 | 两者同给时 cellLabel 优先（code 赢过 showCodes:true）', both.texts, expectedLabels(HP, LABEL_PX, LABEL_PAD).map((o) => o.text));
ok('新增 | 兼容 | cellLabel:"index" 时 showCodes:false 仍不画任何文字（已删除的模式 fail-safe 成 none）',
  both2.texts.length === 0 && both2.r.labelsDrawn === false, JSON.stringify(both2.texts.slice(0, 4)));
/* 本轮 render.js 改了缺省契约（见其 normCellLabel 注释）：没给 cellLabel / 给 null / 空串
   → 回落到旧键 showCodes；showCodes 也不是 true → 'none'（fail-safe）。即「什么都不给 = 不画」，
   不再有上一版那层「缺省画色号」。下面按新契约断言，并保留旧键 showCodes 的合同。 */
eq('新增 | 缺省 | 两个键都不给 → 按缺省 none 处理（不画任何格内文字）', [noKey.texts.length, noKey.r.labelsDrawn, noKey.r.labelMinPx], [0, false, 0]);
eq('新增 | 缺省 | cellLabel 给空串 / null 时同样回落到 showCodes（结果仍是 none）',
  [drawHP({ cellPx: LABEL_PX, cellLabel: '' }).texts.length, drawHP({ cellPx: LABEL_PX, cellLabel: null }).texts.length], [0, 0]);
eq('新增 | 缺省 | showCodes:true 单独给出 → 仍然画色号（旧键的合同没被破坏）', oldTrue.texts, expectedLabels(HP, LABEL_PX, LABEL_PAD).map((o) => o.text));
eq('新增 | 缺省 | showCodes:true + cellLabel:none → cellLabel 优先，仍然不画', drawHP({ cellPx: LABEL_PX, cellLabel: 'none', showCodes: true }).texts.length, 0);

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

/* ══════════ 本轮唯一被改的排序：图上「用量条」改按色号自然序 ══════════
   A) 用量条算例：colors **自然序**、counts **恰好是自然序的逆序**（M1 最多 → A1 最少）。
      这正是用户抱怨的场景——旧实现读 counts，用量条于是按颗数降序 = 与色号序完全相反。
   B) 图例 / CSV 算例：colors 刻意乱序（既不是自然序也不是颗数序），用来证明这两条输出
      仍然只跟 pattern.colors 的数组顺序走、没被动过（「只改图上那一条」的直接对照）。 */
const USAGE_NATURAL = ['A1', 'A2', 'A9', 'A10', 'B1', 'B2', 'M1'];
const USAGE_SCRAMBLED = ['M1', 'B2', 'A10', 'B1', 'A9', 'A2', 'A1'];
const USAGE_HEX_OF = { A1: '#F00A01', A2: '#F00A02', A9: '#F00A09', A10: '#F00A10', B1: '#F00B01', B2: '#F00B02', M1: '#F00D01' };
const USAGE_REV_COUNT = { M1: 7, B2: 6, B1: 5, A10: 4, A9: 3, A2: 2, A1: 1 };   // 颗数 = 自然序的逆序
function usagePatOf(colorOrder, countOf) {
  const w = 7, h = 4;
  const colors = colorOrder.map((code) => ({ code: code, hex: USAGE_HEX_OF[code], rgb: [1, 2, 3], group: code.charAt(0) }));
  const cells = new Uint16Array(w * h).fill(EMPTY);
  const idxOf = (code) => colorOrder.indexOf(code);
  const layout = [];
  for (let ci = 0; ci < colorOrder.length; ci++) for (let k = 0; k < countOf[colorOrder[ci]]; k++) layout.push(idxOf(colorOrder[ci]));
  for (let i = 0; i < layout.length && i < w * h; i++) cells[i] = layout[i];
  const counts = colorOrder.map((c) => ({ code: c, hex: USAGE_HEX_OF[c], rgb: [1, 2, 3], count: countOf[c] }))
    .sort((a, b) => b.count - a.count);
  return { w: w, h: h, colors: colors, cells: cells, locked: new Uint8Array(w * h), counts: counts, stats: { total: w * h } };
}
const usagePat = usagePatOf(USAGE_NATURAL, USAGE_REV_COUNT);
const usageCountOrder = usagePat.counts.map((c) => c.code);
ok('用量条前置 | counts 顺序恰好是自然序的逆序（所以「按颗数降序」与「按色号」完全相反）',
  JSON.stringify(usageCountOrder) === JSON.stringify(USAGE_NATURAL.slice().reverse()), JSON.stringify(usageCountOrder));
eq('用量条前置 | colors 数组是自然序（app 侧的真实不变量：pipeline 排序 + insertColorNatural 插位）',
  usagePat.colors.map((c) => c.code), USAGE_NATURAL);
eq('用量条前置 | 非空格子总数 = 28（7 个色号各有颗数）', Array.from(usagePat.cells).filter((c) => c !== EMPTY).length, 28);

const usageCv = makeMockCanvas();
Render.drawPattern(usagePat, usageCv, { cellPx: 24, cellLabel: 'none', showRuler: false, annotate: true, padMode: 'normal' });
eq('用量条 | 画了 7 个圆角块（每个色号一个）', usageCv._rec.fills.filter((f) => f.fillStyle === '#F5F7FA').length, 7);
const usageTextSeq = usageCv._rec.fillText.map((t) => String(t.text));
const usageCodeSeq = usageTextSeq.filter((t) => USAGE_NATURAL.includes(t));
eq('用量条 | 色号文字序列 = 自然序 A1,A2,A9,A10,B1,B2,M1', usageCodeSeq, USAGE_NATURAL);
ok('用量条 | A9 必须排在 A10 之前（数字不能按字符串比）',
  usageCodeSeq.indexOf('A9') >= 0 && usageCodeSeq.indexOf('A9') < usageCodeSeq.indexOf('A10'), JSON.stringify(usageCodeSeq));
ok('用量条 | 顺序不是按颗数降序（不是 counts 的顺序 —— 旧行为就是这一条）',
  JSON.stringify(usageCodeSeq) !== JSON.stringify(usageCountOrder), JSON.stringify(usageCodeSeq));
const usageSwatchSeq = usageCv._rec.fills
  .map((f) => String(f.fillStyle)).filter((s) => Object.values(USAGE_HEX_OF).indexOf(s) >= 0)
  .map((s) => Object.keys(USAGE_HEX_OF).filter((k) => USAGE_HEX_OF[k] === s)[0]);
eq('用量条 | 色块（fill）顺序同样是自然序（独立于文字的第二个信号）', usageSwatchSeq, USAGE_NATURAL);
for (const code of USAGE_NATURAL) {
  ok('用量条 | ' + code + ' 的颗数文字 = ' + USAGE_REV_COUNT[code] + ' 颗', usageTextSeq.includes(USAGE_REV_COUNT[code] + ' 颗'));
}

/* B) 图例 / CSV：colors 乱序时仍然不重排（用户只要求改图上那一条） */
const usageScramblePat = usagePatOf(USAGE_SCRAMBLED, USAGE_REV_COUNT);
ok('图例前置 | 乱序 colors 与自然序、与颗数序都不相同',
  JSON.stringify(USAGE_SCRAMBLED) !== JSON.stringify(USAGE_NATURAL)
  && JSON.stringify(USAGE_SCRAMBLED) !== JSON.stringify(usageScramblePat.counts.map((c) => c.code)));
const usageLegend = Render.legendHTML(usageScramblePat);
const usageLegendCodes = [...usageLegend.matchAll(/class="pd-legend-code"[^>]*>([^<]*)</g)].map((m) => m[1]);
const usageCsvCodes = Render.exportCSV(usageScramblePat).replace(/^\uFEFF/, '').split('\r\n')
  .filter((l) => l !== '' && !/^(编号|合计)/.test(l)).map((l) => l.split(',')[1]);
eq('图例 | 7 行都在', usageLegendCodes.length, 7);
eq('图例 | 顺序未变：仍按 pattern.colors 数组顺序（不重排）', usageLegendCodes, USAGE_SCRAMBLED);
eq('CSV | 7 行都在', usageCsvCodes.length, 7);
eq('CSV | 顺序未变：仍按 pattern.colors 数组顺序（不重排）', usageCsvCodes, USAGE_SCRAMBLED);
ok('对照 | 图例与 CSV 都没有改成自然序（自然序是图上用量条独有的新行为）',
  JSON.stringify(usageLegendCodes) !== JSON.stringify(USAGE_NATURAL) && JSON.stringify(usageCsvCodes) !== JSON.stringify(USAGE_NATURAL),
  JSON.stringify({ legend: usageLegendCodes, csv: usageCsvCodes }));
/* 加强（防御性）：colors 数组的顺序**不由 render.js 保证**（它只保证自己按色号现算），
   所以这里额外用一个 colors 乱序的算例验证：即使上游数组顺序不自然，图上仍按 A1,A2,… 排。 */
const usageScrambleCv = makeMockCanvas();
Render.drawPattern(usageScramblePat, usageScrambleCv, { cellPx: 24, cellLabel: 'none', showRuler: false, annotate: true, padMode: 'normal' });
const usageScrambleSeq = usageScrambleCv._rec.fillText.map((t) => String(t.text)).filter((t) => USAGE_NATURAL.includes(t));
eq('用量条 | colors 数组乱序时仍按自然序输出（比较器自己现算，不依赖上游数组顺序）', usageScrambleSeq, USAGE_NATURAL);

/* 不可变性：一串渲染/导出调用后 Pattern 快照不变 */
ok('不可变性 | 手造 Pattern 渲染+导出后快照不变', JSON.stringify({ c: Array.from(HP.cells), l: Array.from(HP.locked), colors: HP.colors }) === hpSnap);
const realSnap = JSON.stringify(realPat);
const legendSnap = JSON.stringify({ cells: Array.from(EVIL.cells), colors: EVIL.colors });
Render.drawPattern(realPat, makeMockCanvas(), { showCodes: true, showRuler: true, cellPx: 20, highlightLocked: true });
Render.exportCSV(realPat);
Render.legendHTML(realPat);
ok('不可变性 | drawPattern/exportCSV/legendHTML 后 Pattern 快照不变（drawCompare 已删除，故只测这 3 个）', JSON.stringify(realPat) === realSnap);
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

/* ═══════════════════════════════════════════════════════════════════════
   B 侧新契约：设尺寸后的【回读校验】+ 可选 opts.maxPixels
   ═══════════════════════════════════════════════════════════════════════ */
/* 三种宿主桩：
   'normal'        尺寸写入生效、getContext 正常
   'silent-reject' width/height 赋值被静默吞掉（读回来恒为 0）—— 就是「ok:true 但画布没生效」那个 bug 的宿主
   'null-ctx'      尺寸写入生效，但 getContext('2d') 返回 null */
const CANVAS_DRAW_CALLS = (cv) => {
  const r = cv._rec || {};
  const n = (v) => Array.isArray(v) ? v.length : (typeof v === 'number' ? v : 0);   // mock 记录数组 / 计数桩两种形态
  return n(r.fillRect) + n(r.fillText) + n(r.strokes) + n(r.save) + n(r.restore);
};
function makeHostStub(mode) {
  const rec = { fillRect: 0, fillText: 0, strokes: 0, save: 0, restore: 0, ctxCalls: 0 };
  const ctx = {
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt',
    font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
    save() { rec.save++; }, restore() { rec.restore++; },
    fillRect() { rec.fillRect++; }, strokeRect() {}, drawImage() {},
    fillText() { rec.fillText++; },
    beginPath() {}, moveTo() {}, lineTo() {}, rect() {}, roundRect() {}, closePath() {},
    stroke() { rec.strokes++; }, fill() {}
  };
  const cv = {
    _w: 0, _h: 0, _rec: rec, _mode: mode,
    get width() { return this._w; },
    set width(v) { if (mode !== 'silent-reject') this._w = v; },
    get height() { return this._h; },
    set height(v) { if (mode !== 'silent-reject') this._h = v; },
    getContext(kind) {
      if (kind !== '2d') return null;
      if (mode === 'null-ctx') return null;
      rec.ctxCalls++;
      return ctx;
    }
  };
  return cv;
}
const MP_PAT = makePat(116, 116, 2);          // 116×116：@24 约 845 万像素，@256 约 8.9 亿像素
const MP_OPTS = { cellPx: 24, cellLabel: 'none', padMode: 'tight' };
const mpNeed = (function () { const cv = makeMockCanvas(); const r = Render.drawPattern(MP_PAT, cv, MP_OPTS); return r.width * r.height; })();
ok('回读校验前置 | 116×116@24 的像素需求在 1e6–1.2e8 之间（下面几条算例才有区分度）',
  mpNeed > 1000000 && mpNeed < 120000000, 'need=' + mpNeed);

/* 三态一：正常宿主 → ok:true 且尺寸逐值相符 */
const hostOk = makeHostStub('normal');
const rHostOk = Render.drawPattern(MP_PAT, hostOk, MP_OPTS);
eq('回读校验 | 正常宿主 → ok:true', rHostOk.ok, true);
eq('回读校验 | 正常宿主 → 画布尺寸逐值等于返回值', [hostOk.width, hostOk.height], [rHostOk.width, rHostOk.height]);
ok('回读校验 | 正常宿主 → 确实画了东西（零绘制的 ok:true 不算通过）', CANVAS_DRAW_CALLS(hostOk) > 0, String(CANVAS_DRAW_CALLS(hostOk)));

/* 三态二：尺寸被静默拒绝 → ok:false + 零绘制 */
const hostReject = makeHostStub('silent-reject');
const rHostReject = Render.drawPattern(MP_PAT, hostReject, MP_OPTS);
eq('回读校验 | 尺寸被静默拒绝 → ok:false', rHostReject.ok, false);
ok('回读校验 | 尺寸被静默拒绝 → reason ∈ {"canvas-rejected","too-large"}（以作者实现为准）',
  ['canvas-rejected', 'too-large'].indexOf(rHostReject.reason) >= 0, String(rHostReject.reason));
eq('回读校验 | 尺寸被静默拒绝 → 零绘制调用（fillRect/fillText/stroke/save/restore 全 0）', CANVAS_DRAW_CALLS(hostReject), 0);
eq('回读校验 | 尺寸被静默拒绝 → 宿主画布仍是未设尺寸（0×0）', [hostReject.width, hostReject.height], [0, 0]);
ok('回读校验 | 尺寸被静默拒绝 → 不谎报成功（ok 与「画布真的被设上尺寸」不可能同时成立）',
  !(rHostReject.ok === true && (hostReject.width !== rHostReject.width || hostReject.height !== rHostReject.height)));

/* 三态三：getContext('2d') 为 null → ok:false + 零绘制 */
const hostNullCtx = makeHostStub('null-ctx');
const rHostNullCtx = Render.drawPattern(MP_PAT, hostNullCtx, MP_OPTS);
eq('回读校验 | getContext 返回 null → ok:false', rHostNullCtx.ok, false);
ok('回读校验 | getContext 返回 null → reason 非空字符串', typeof rHostNullCtx.reason === 'string' && rHostNullCtx.reason.length > 0, String(rHostNullCtx.reason));
eq('回读校验 | getContext 返回 null → 零绘制调用', CANVAS_DRAW_CALLS(hostNullCtx), 0);

/* 核心回归：不存在「ok === true 但画布尺寸与期望不一致」的组合（跨一批算例横扫） */
const SIZE_INVARIANT_CASES = [
  ['小图 @24', makePat(5, 4, 3), { cellPx: 24, cellLabel: 'none', padMode: 'normal' }],
  ['116×116 @24 tight', MP_PAT, { cellPx: 24, cellLabel: 'none', padMode: 'tight' }],
  ['116×116 @24 annotate', MP_PAT, { cellPx: 24, cellLabel: 'none', padMode: 'tight', annotate: true }],
  ['116×116 @8 满刻度', MP_PAT, { cellPx: 8, cellLabel: 'code', padMode: 'normal', showRuler: true }],
  ['小图 @256 面积超限', makePat(5, 4, 3), { cellPx: 256, cellLabel: 'none', padMode: 'normal' }],
  ['116×116 @256 面积超限', MP_PAT, { cellPx: 256, cellLabel: 'none', padMode: 'normal' }]
];
const SIZE_INVARIANT_VIOLATIONS = [];
for (const c of SIZE_INVARIANT_CASES) {
  for (const mode of ['normal', 'silent-reject', 'null-ctx']) {
    const cv = makeHostStub(mode);
    let res = null;
    try { res = Render.drawPattern(c[1], cv, c[2]); } catch (e) { SIZE_INVARIANT_VIOLATIONS.push(c[0] + '/' + mode + ' 抛错 ' + e.message); continue; }
    if (res.ok === true && (cv.width !== res.width || cv.height !== res.height)) {
      SIZE_INVARIANT_VIOLATIONS.push(c[0] + '/' + mode + ' ok:true 但 ' + cv.width + '×' + cv.height + ' ≠ ' + res.width + '×' + res.height);
    }
    if (res.ok === true && CANVAS_DRAW_CALLS(cv) === 0 && res.cellsDrawn > 0) {
      SIZE_INVARIANT_VIOLATIONS.push(c[0] + '/' + mode + ' ok:true 且 cellsDrawn>0 却零绘制');
    }
  }
}
eq('回读校验 | 18 个「算例 × 宿主」组合里，不存在 ok:true 但尺寸不符/零绘制的组合', SIZE_INVARIANT_VIOLATIONS, []);

/* opts.maxPixels：合法值生效 + 回显生效值 */
const cvCustom = makeMockCanvas();
const rCustom = Render.drawPattern(MP_PAT, cvCustom, Object.assign({}, MP_OPTS, { maxPixels: 5000000 }));
eq('maxPixels | 调用方给 5000000（小于本图需求）→ 按面积守卫拒绝', rCustom.ok, false);
eq('maxPixels | 拒绝时 reason === "too-large"', rCustom.reason, 'too-large');
eq('maxPixels | 返回值 maxPixels 回显【本次真正生效】的 5000000', rCustom.maxPixels, 5000000);
eq('maxPixels | 拒绝时零绘制调用', CANVAS_DRAW_CALLS(cvCustom), 0);
eq('maxPixels | 拒绝时画布仍未设尺寸（守卫先于分配）', [cvCustom.width, cvCustom.height], [0, 0]);
const cvCustom2 = makeMockCanvas();
const rCustom2 = Render.drawPattern(MP_PAT, cvCustom2, Object.assign({}, MP_OPTS, { maxPixels: 50000000 }));
eq('maxPixels | 同一张图给 50000000（大于需求）→ 正常绘制', rCustom2.ok, true);
eq('maxPixels | 正常绘制时尺寸逐值相符', [cvCustom2.width, cvCustom2.height], [rCustom2.width, rCustom2.height]);
const cvDefaultBig = makeMockCanvas();
const rDefaultBig = Render.drawPattern(MP_PAT, cvDefaultBig, { cellPx: 256, cellLabel: 'none', padMode: 'normal' });
eq('maxPixels | 没给 maxPixels 时过大算例仍按内置常量拒绝', [rDefaultBig.ok, rDefaultBig.reason, rDefaultBig.maxPixels], [false, 'too-large', 120000000]);

/* opts.maxPixels：非法值一律回落内置常量，且行为与「不传」逐值一致 */
const mpBaselineSmall = (function () { const cv = makeHostStub('normal'); const r = Render.drawPattern(MP_PAT, cv, MP_OPTS); return [r.ok, r.maxPixels === undefined ? null : r.maxPixels, r.width, r.height]; })();
const mpBaselineBig = (function () { const cv = makeHostStub('normal'); const r = Render.drawPattern(MP_PAT, cv, { cellPx: 256, cellLabel: 'none', padMode: 'normal' }); return [r.ok, r.maxPixels === undefined ? null : r.maxPixels]; })();
for (const bad of [[0, '0'], [-1, '-1'], [NaN, 'NaN'], ['x', '"x"'], [Infinity, 'Infinity'], [null, 'null'], [undefined, 'undefined']]) {
  const cvS = makeHostStub('normal');
  const rS = Render.drawPattern(MP_PAT, cvS, Object.assign({}, MP_OPTS, { maxPixels: bad[0] }));
  eq('maxPixels | 非法值 ' + bad[1] + ' → 小算例行为与不传时逐值一致（ok/尺寸/maxPixels 键）',
    [rS.ok, rS.maxPixels === undefined ? null : rS.maxPixels, rS.width, rS.height], mpBaselineSmall);
  const cvB = makeHostStub('normal');
  const rB = Render.drawPattern(MP_PAT, cvB, { cellPx: 256, cellLabel: 'none', padMode: 'normal', maxPixels: bad[0] });
  eq('maxPixels | 非法值 ' + bad[1] + ' → 超大算例回落 120000000 并仍拒绝',
    [rB.ok, rB.maxPixels === undefined ? null : rB.maxPixels], mpBaselineBig);
}

/* ═════════════════════════════════════════════════════════ 第 5 组 · 产物 */
startGroup('第 5 组 · 产物（index.html）');
/* 产物缺失时，本组那 69 条断言会「整组不执行」—— 总数会悄悄少掉一大块，
   只留一条红，极易被误读成「几乎全绿」。所以下面：① 显式 INFO 报出跳过条数；
   ② 用 EXPECTED_PRODUCT_ASSERTIONS 自校验（产物存在时必须恰好执行这么多条，
      数量变动而没同步这个常量就会红），③ 缺失时断言实际执行数为 0。 */
const EXPECTED_PRODUCT_ASSERTIONS = 69;
let productSkipNotice = '';
let productAssertionsRan = 0;
let productAssertionsBase = null;
const productExists = existsSync(PRODUCT);
ok('产物文件存在', productExists, productExists ? PRODUCT : ('缺少产物文件：' + PRODUCT + '（先跑 `node build.mjs`）'));
if (!productExists) {
  productSkipNotice = '因产物缺失（' + PRODUCT + '），本组 ' + EXPECTED_PRODUCT_ASSERTIONS + ' 条断言被整组跳过 —— 本次总数会比正常情况少这么多，别把总数塌缩读成「几乎全绿」';
  info(productSkipNotice);
} else {
  productAssertionsBase = current.pass + current.fail;
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
     照样 50/50 全绿 —— 而那时产物里根本没有新加的东西（当时缺的是 toolWand / tabBasic /
     effCurve；换到本轮就是 #showCodes / #maxColorsNum / #chartTitle 这一类）。
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

  /* 正向对照 + 负向对照都跑在「现场用 src/ 重建出的产物文本」上：
     把 7 段内容各自换成当前 src/ 的内容（结构、横幅、标签一律沿用真产物），
     得到一个**必然与 src/ 同步**的文本。这样对照的有效性不依赖真产物是否已重建，
     而且比对函数一旦退化成恒真/恒假都会被立刻抓到。 */
  const patchSegment = (text, file, replacement) => {
    const span = segmentSpan(text, file);
    return (span && replacement !== null) ? text.slice(0, span[0]) + replacement + text.slice(span[1]) : null;
  };
  const inSyncHtml = ['ui.html'].concat(BARE_FILES).reduce((t, file) => {
    const src = (file === 'ui.html') ? readSrc('ui.html') : srcText[file];
    return (t === null || src === undefined || src === null) ? null : patchSegment(t, file, trimTailText(src));
  }, html);
  const segRepInSync = inSyncHtml === null ? null : productSegmentReport(inSyncHtml);
  ok('正向对照 | 现场用 src/ 重建出的产物文本 7 段全绿（证明比对函数内容一致时会通过，不是恒假）',
    !!segRepInSync && segRepInSync.ok, segRepInSync ? ('不一致：' + segRepInSync.failed.join('、')) : '重建失败');
  ok('正向对照 | 重建只改了段内容，段数与横幅结构没变（7 段、6 个横幅各一次）',
    !!inSyncHtml && (inSyncHtml.match(/<script>/g) || []).length === 6
    && BARE_FILES.every((f) => inSyncHtml.split(segmentOpen(f)).length - 1 === 1));

  /* ── 负向对照：在内存里改坏 1 个字节，比对必须报红，并指出是哪一段 ──────
     没有这几条，就无法区分「全绿是因为产物新鲜」还是「因为比对本身在空转」。 */
  const flipAt = (text, pos) => text.slice(0, pos) + (text.charAt(pos) === 'X' ? 'Y' : 'X') + text.slice(pos + 1);
  const dropAt = (text, pos) => text.slice(0, pos) + text.slice(pos + 1);
  const midOf = (span) => (span ? Math.floor((span[0] + span[1]) / 2) : 0);
  /* 想让「翻转 1 个字符后两侧字节数完全相同」，落点必须是**单字节**位置：
     中文/全角是多字节，换成 'X' 会让字节数少 2，那就不再是「字节数相同」的对照了。 */
  const asciiByteOf = (text, span) => {
    if (!span) return 0;
    for (let p = Math.floor((span[0] + span[1]) / 2); p < span[1]; p++) if (text.charCodeAt(p) < 128) return p;
    for (let p = span[0]; p < span[1]; p++) if (text.charCodeAt(p) < 128) return p;
    return Math.floor((span[0] + span[1]) / 2);
  };
  const ctlAppSpan = segmentSpan(inSyncHtml || '', 'app.js') || [0, 1];
  const ctlUiSpan = segmentSpan(inSyncHtml || '', 'ui.html') || [0, 1];
  const ctlPalSpan = segmentSpan(inSyncHtml || '', 'palette.js') || [0, 1];
  ok('负向对照 | 三个对照组用的段边界都截取到了（否则下面的破坏点落在段外，对照无意义）',
    !!segmentSpan(inSyncHtml || '', 'app.js') && !!segmentSpan(inSyncHtml || '', 'ui.html') && !!segmentSpan(inSyncHtml || '', 'palette.js'));
  const repTamperApp = productSegmentReport(flipAt(inSyncHtml, asciiByteOf(inSyncHtml, ctlAppSpan)));
  const repTamperUi = productSegmentReport(flipAt(inSyncHtml, asciiByteOf(inSyncHtml, ctlUiSpan)));
  const repTamperPal = productSegmentReport(dropAt(inSyncHtml, midOf(ctlPalSpan)));
  ok('负向对照 | 改坏 app.js 段 1 个字节（字节数不变）→ 总判必须为 false（比对不是空转）', repTamperApp.ok === false, '总判 ' + repTamperApp.ok);
  eq('负向对照 | 且恰好只报 app.js 这一段（其余 6 段仍绿）', repTamperApp.failed, ['app.js']);
  ok('负向对照 | 改坏 ui.html 段 1 个字节（字节数不变）→ 总判必须为 false（旧套件漏掉的正是这一段）', repTamperUi.ok === false, '总判 ' + repTamperUi.ok);
  eq('负向对照 | 且恰好只报 ui.html 这一段', repTamperUi.failed, ['ui.html']);
  eq('负向对照 | 从 palette.js 段删掉 1 个字节（长度变化也要抓到）→ 恰好只报 palette.js', repTamperPal.failed, ['palette.js']);
  const segAppBytes = Buffer.byteLength(trimTailText(srcText['app.js']), 'utf8');
  const tamperedAppRow = repTamperApp.rows.filter((r) => r.file === 'app.js')[0];
  eq('负向对照 | 字节数不变的那次破坏：两侧字节数完全相同却仍判不一致（证明靠内容判，不是靠长度）',
    tamperedAppRow.detail, segAppBytes + ' vs ' + segAppBytes + ' 字节（不一致）');
  ok('负向对照 | 三种破坏各只炸自己那一段（7 段都在报、不串段、不整体崩）',
    repTamperApp.rows.length === 7 && repTamperUi.rows.length === 7 && repTamperPal.rows.length === 7
    && repTamperApp.failed.length === 1 && repTamperUi.failed.length === 1 && repTamperPal.failed.length === 1,
    [repTamperApp.failed, repTamperUi.failed, repTamperPal.failed].join(' | '));
  eq('负向对照 | 三种破坏下其余 6 段都仍判为一致', [
    repTamperApp.rows.filter((r) => r.ok).length,
    repTamperUi.rows.filter((r) => r.ok).length,
    repTamperPal.rows.filter((r) => r.ok).length
  ], [6, 6, 6]);

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
  if (typeof productAssertionsBase === 'number') productAssertionsRan = (current.pass + current.fail) - productAssertionsBase;
}
/* ① 产物存在时必须**恰好**执行 EXPECTED_PRODUCT_ASSERTIONS 条（数量变了却没同步常量 → 红）；
   ② 产物缺失时实际执行数必须是 0，且输出里已经显式报出跳过条数（总数塌缩必须被看见）。 */
eq('产物新鲜度守卫的执行条数（产物存在时应恰好 ' + EXPECTED_PRODUCT_ASSERTIONS + ' 条；缺失时为 0）',
  productAssertionsRan, productExists ? EXPECTED_PRODUCT_ASSERTIONS : 0);
ok('产物缺失时显式报出「因产物缺失而跳过的断言数」（不是只留一条红就完事）',
  productExists ? productSkipNotice === '' : (productSkipNotice.indexOf(String(EXPECTED_PRODUCT_ASSERTIONS)) >= 0 && productSkipNotice.length > 20),
  productSkipNotice || '（产物存在：本组无跳过）');

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
/* 本轮增删：删 #cellLabelMode（下拉）→ 换成「显示色号」勾选框 #showCodes；
   删 #maxColorsVal（只读读数）→ 换成可键入的数字框 #maxColorsNum；删「导出对照图」整条。 */
ok('本轮替换 | #cellLabelMode 已彻底删除（html + app.js 双清，改为并列勾选框）', !htmlIds.includes('cellLabelMode') && !appRefs.includes('cellLabelMode'));
ok('本轮替换 | #maxColorsVal 已彻底删除（html + app.js 双清，改为数字框）', !htmlIds.includes('maxColorsVal') && !appRefs.includes('maxColorsVal'));
ok('本轮替换 | #btnExportCompare（导出对照图）已彻底删除（html + app.js 双清）', !htmlIds.includes('btnExportCompare') && !appRefs.includes('btnExportCompare'));
ok('本轮替换 | 「对照图」字样与标识符在 ui.html / app.js 里都清干净了（不是只藏起按钮）',
  UI_HTML.indexOf('对照图') < 0 && APP_SRC.indexOf('对照图') < 0 && APP_SRC.indexOf('exportCompare') < 0);
ok('本轮替换 | 新的「显示色号」勾选框 #showCodes 存在且被引用', htmlIds.includes('showCodes') && appRefs.includes('showCodes'));
ok('本轮替换 | 新的数字框 #maxColorsNum 存在且被引用', htmlIds.includes('maxColorsNum') && appRefs.includes('maxColorsNum'));
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
    /* 真实 2D 上下文有的路径方法，桩里也必须齐全：render.js 画用量块走 rect + roundRect，
       缺一个就会让「导出带用量清单」这条路在桩里抛异常（曾因此掩盖了导出断言的真实结果）。 */
    rect(x, y, w, h) { ctx._path.push(['R', x, y, w, h]); },
    roundRect(x, y, w, h, r) { ctx._path.push(['RR', x, y, w, h, r]); },
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
    canvasCaps(map[id]);
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
        canvasCaps(cv);
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
  ColorKit: globalThis.ColorKit,          /* 批量修改要用 srgbToLab / deltaE 算推荐色 */
  Pipeline: globalThis.Pipeline,
  Render: null,
  setTimeout(fn) { const id = ++timerSeq; timers.push({ id, fn, cancelled: false }); return id; },
  clearTimeout(id) { for (const t of timers) if (t.id === id) t.cancelled = true; },
  performance: { now: () => 0 },
  Blob: class StubBlob { constructor(parts, opts) { this.parts = parts; this.type = (opts || {}).type; } },
  URL: makeUrlStub(),
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
/* 原断言钉死了旧措辞「倍数太大」；本轮 A 把文案改成更明确的说法
   （「格子像素太大，画布超出浏览器上限（需要约 900M 像素…）。请降低导出倍数（把「分辨率倍数」改成 1× 或 2×）后重试。」），
   钉死措辞会逼实现保留更差的文案。改为语义判定：必须同时给出「原因（尺寸/像素超出上限）」与「出路（降低倍数）」。 */
ok('判断顺序 | ok:false + reason:too-large → 文案同时给出原因（像素/尺寸超出上限）与出路（降低倍数）',
  /(像素|尺寸|画布).{0,14}(太大|超出|上限)/.test(statusTooLarge)
  && statusTooLarge.indexOf('降低') >= 0 && statusTooLarge.indexOf('倍数') >= 0, statusTooLarge);
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
/* 允许集里绝不能留 'index'：那等于给「回退成数字编码」这个已删功能留后门。
   预览只下发 'code' / 'none' 两种值（来自「显示色号」勾选框）。 */
ok('预览 | 每次都显式给出 cellLabel，且只可能是 "code" / "none"',
  previewCalls.length > 0 && previewCalls.every((c) => c.opts.cellLabel === 'code' || c.opts.cellLabel === 'none'),
  JSON.stringify(previewCalls.map((c) => c.opts.cellLabel)));
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
/* 上一轮新增、且本轮仍然存在的控件（#maxColorsVal 本轮已被数字框取代，故从这里移出） */
const TAB_NEW_IDS = ['tabBasic', 'tabAdvanced', 'panelBasic', 'panelAdvanced', 'preprocessHint',
  'chartTitle', 'toolNone', 'toolWand', 'toolEraser', 'eraserSize', 'toolHint'];
ok('控件清单 | 上一轮新增、本轮仍在的 11 个 id 全在 ui.html 里', TAB_NEW_IDS.every((id) => htmlIds.includes(id)), TAB_NEW_IDS.filter((id) => !htmlIds.includes(id)).join(','));
ok('控件清单 | 且这 11 个 id 全部被 app.js 引用（没有一个是摆设）', TAB_NEW_IDS.every((id) => appRefs.includes(id)), TAB_NEW_IDS.filter((id) => !appRefs.includes(id)).join(','));
/* 本轮增删后的精确计数：90（上一轮）+ 7（移动端：inputHint / saveOverlay / saveTip / saveImage / saveText / saveCopy / saveClose）= 97 */
eq('控件清单 | ui.html 的 id 总数 = 102（97 + 本轮新增 5）', htmlIds.length, 102);
eq('控件清单 | 上一轮删除的 3 个 id 一个都不在产物 id 集合里',
  ['cellLabelMode', 'maxColorsVal', 'btnExportCompare'].filter((id) => htmlIds.includes(id)), []);
const MOBILE_NEW_IDS = ['inputHint', 'saveOverlay', 'saveTip', 'saveImage', 'saveText', 'saveCopy', 'saveClose'];
ok('控件清单 | 上一轮移动端新增的 7 个 id 全在 ui.html 里', MOBILE_NEW_IDS.every((id) => htmlIds.includes(id)), MOBILE_NEW_IDS.filter((id) => !htmlIds.includes(id)).join(','));
ok('控件清单 | 且这 7 个 id 全部被 app.js 引用（没有一个是摆设）', MOBILE_NEW_IDS.every((id) => appRefs.includes(id)), MOBILE_NEW_IDS.filter((id) => !appRefs.includes(id)).join(','));
/* 本轮（用户实测 4 个问题 → 作者改 app.js / srcedit.js / ui.html）新增的 5 个 id */
const THIS_ROUND_NEW_IDS = ['batchMode', 'batchRecoRow', 'batchHint', 'btnEraseUndo', 'srcCropHint'];
ok('控件清单 | 本轮新增的 5 个 id 全在 ui.html 里', THIS_ROUND_NEW_IDS.every((id) => htmlIds.includes(id)), THIS_ROUND_NEW_IDS.filter((id) => !htmlIds.includes(id)).join(','));
ok('控件清单 | 且这 5 个 id 全部被 app.js 引用（没有一个是摆设）', THIS_ROUND_NEW_IDS.every((id) => appRefs.includes(id)), THIS_ROUND_NEW_IDS.filter((id) => !appRefs.includes(id)).join(','));
ok('控件清单 | 触摸端兜底层默认全部隐藏（#saveOverlay 与层内元素都带 hidden）',
  /id="saveOverlay"[^>]*hidden/.test(UI_HTML) && /id="saveImage"[^>]*hidden/.test(UI_HTML)
  && /id="saveText"[^>]*hidden/.test(UI_HTML) && /id="saveCopy"[^>]*hidden/.test(UI_HTML));

const maxColorsTag = (UI_HTML.match(/<input\b[^>]*\bid="maxColors"[^>]*>/) || [''])[0];
ok('控件 | #maxColors 仍是 range（min 2 / max 221 / step 1 / value 24，可拖到色卡上限）',
  /type="range"/.test(maxColorsTag) && /min="2"/.test(maxColorsTag) && /max="221"/.test(maxColorsTag)
  && /step="1"/.test(maxColorsTag) && /value="24"/.test(maxColorsTag), maxColorsTag);
ok('控件 | #maxColors 不是 number（滑杆与数字框是两个并列控件，不是同一个元素兼两种类型）', !/type="number"/.test(maxColorsTag), maxColorsTag);
const maxColorsNumTag = (UI_HTML.match(/<input\b[^>]*\bid="maxColorsNum"[^>]*>/) || [''])[0];
ok('控件 | #maxColorsNum 是 number 框（min 2 / max 221 / step 1 / value 24，与滑杆同量程）',
  /type="number"/.test(maxColorsNumTag) && /min="2"/.test(maxColorsNumTag) && /max="221"/.test(maxColorsNumTag)
  && /step="1"/.test(maxColorsNumTag) && /value="24"/.test(maxColorsNumTag), maxColorsNumTag);
ok('控件 | #maxColors 与 #maxColorsNum 在同一个「减色」组里',
  UI_HTML.indexOf('id="maxColors"') > UI_HTML.indexOf('<h2>减色</h2>') && UI_HTML.indexOf('id="maxColorsNum"') > UI_HTML.indexOf('<h2>减色</h2>')
  && UI_HTML.indexOf('id="maxColors"') < UI_HTML.indexOf('<h2>色卡版本</h2>') && UI_HTML.indexOf('id="maxColorsNum"') < UI_HTML.indexOf('<h2>色卡版本</h2>'));
eq('控件 | boot 后滑杆 = 数字框 = 24（与 Pipeline 默认一致）', [String(els.maxColors.value), String(els.maxColorsNum.value)], ['24', '24']);

/* 标题：默认值 + 位置（预览区，不是「图纸显示」组） */
const chartTitleTag = (UI_HTML.match(/<input\b[^>]*\bid="chartTitle"[^>]*>/) || [''])[0];
ok('控件 | #chartTitle 默认值就是「未命名图纸」（写在 HTML 的 value 属性上，首屏不空）',
  /value="未命名图纸"/.test(chartTitleTag), chartTitleTag);
ok('控件 | #chartTitle 是文本输入', /type="text"/.test(chartTitleTag), chartTitleTag);
ok('控件 | #chartTitle 落在预览容器 <main id="dropZone"> 内部（DOM 层级，不是「图纸显示」组）',
  UI_HTML.indexOf('<main id="dropZone"') >= 0 && UI_HTML.indexOf('id="chartTitle"') > UI_HTML.indexOf('<main id="dropZone"')
  && UI_HTML.indexOf('id="chartTitle"') < UI_HTML.indexOf('</main>', UI_HTML.indexOf('<main id="dropZone"')),
  UI_HTML.indexOf('id="chartTitle"') + ' vs main ' + UI_HTML.indexOf('<main id="dropZone"') + '…' + UI_HTML.indexOf('</main>'));
ok('控件 | #chartTitle 已从「图纸显示」组移出（该组文本里不再有它）',
  (function () { const a = UI_HTML.indexOf('<h2>图纸显示</h2>'); const b = UI_HTML.indexOf('</section>', a); return a >= 0 && b > a && UI_HTML.slice(a, b).indexOf('chartTitle') < 0; })());
ok('控件 | #chartTitle 位于 #canvasScroll 之前（用户原话：放在预览区「上面」）',
  UI_HTML.indexOf('id="chartTitle"') >= 0 && UI_HTML.indexOf('id="canvasScroll"') > UI_HTML.indexOf('id="chartTitle"'),
  UI_HTML.indexOf('id="chartTitle"') + ' < ' + UI_HTML.indexOf('id="canvasScroll"'));
eq('控件 | boot 后 #showCodes.checked === true（「显示色号」默认开着）', els.showCodes.checked, true);
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
eq('标签页 | 高级页恰好 6 组，且就是这 6 个', tabAdvTitles, ['预处理', '减色', '色卡版本', '预览缩放', '画笔 / 批量修改', '操作']);
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
els.showCodes.checked = false;    // 「显示色号」勾选框（本轮取代了 #cellLabelMode 下拉）
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

/* ══════════════════════════════════════════════════════════════════════
   本轮新需求：两个并列勾选框 / 色数上限双控件 / 导出强制色号 / 卡片配色 / 标题落位
   ══════════════════════════════════════════════════════════════════════ */
const ruleBodyOf = (sel) => {
  const i = UI_HTML.indexOf(sel + '{');
  if (i < 0) return null;
  return UI_HTML.slice(i + sel.length + 1, UI_HTML.indexOf('}', i));
};
const sectionOf = (h2Text) => {
  const a = UI_HTML.indexOf('<h2>' + h2Text + '</h2>');
  if (a < 0) return null;
  return UI_HTML.slice(a, UI_HTML.indexOf('</section>', a));
};
const checkboxIdsIn = (h2Text) => ((sectionOf(h2Text) || '').match(/<input\b[^>]*type="checkbox"[^>]*>/g) || [])
  .map((t) => (/\bid="([^"]+)"/.exec(t) || [null, null])[1]);

/* ── 两个并列勾选框：显示色号 / 显示坐标刻度 ─────────────────────────── */
const displaySection = sectionOf('图纸显示');
ok('勾选框 | 「图纸显示」组能定位到（下面几条不是空转）', !!displaySection, String(displaySection).slice(0, 80));
eq('勾选框 | 该组恰好 2 个勾选框，且就是 #showCodes 与 #showRuler', checkboxIdsIn('图纸显示'), ['showCodes', 'showRuler']);
ok('勾选框 | #showCodes 的文案是「显示色号」', /id="showCodes"[^>]*\/>\s*显示色号/.test(displaySection || ''));
ok('勾选框 | #showRuler 的文案仍是「显示坐标刻度」', /id="showRuler"[^>]*\/>\s*显示坐标刻度/.test(displaySection || ''));
ok('勾选框 | 两个都默认勾选（checked 写在 HTML 上）',
  /id="showCodes"[^>]*checked/.test(displaySection || '') && /id="showRuler"[^>]*checked/.test(displaySection || ''));
ok('勾选框 | 该组已无下拉（旧的 #cellLabelMode 换成了勾选框）', (displaySection || '').indexOf('<select') < 0);
/* 「并列」是用户原话：两个勾选框必须在同一个 .check-row 里，且该容器是横向 flex（不是上下堆叠） */
const checkRowSpan = (function () {
  const i = UI_HTML.indexOf('<div class="check-row">');
  return i < 0 ? null : UI_HTML.slice(i, UI_HTML.indexOf('</div>', i));
})();
ok('勾选框 | .check-row 容器能定位到（下面两条不是空转）', !!checkRowSpan, String(checkRowSpan).slice(0, 80));
eq('勾选框 | #showCodes 与 #showRuler 在同一个 .check-row 容器里（并列成一行）',
  ((checkRowSpan || '').match(/<input\b[^>]*type="checkbox"[^>]*>/g) || []).map((t) => (/\bid="([^"]+)"/.exec(t) || [null, null])[1]),
  ['showCodes', 'showRuler']);
ok('勾选框 | .check-row 用 display:flex（横排，不是上下堆叠）',
  /display\s*:\s*flex/.test(ruleBodyOf('.check-row') || ''), JSON.stringify(ruleBodyOf('.check-row')));
els.showCodes.checked = true;
fire(els.showCodes, 'change');
eq('勾选框 | 勾上「显示色号」→ viewOpts().cellLabel === "code"', ui.viewOpts().cellLabel, 'code');
els.showCodes.checked = false;
fire(els.showCodes, 'change');
eq('勾选框 | 取消「显示色号」→ viewOpts().cellLabel === "none"', ui.viewOpts().cellLabel, 'none');
ok('勾选框 | 取消后格内文字真的不画（render 层 labelsDrawn === false）',
  Render.drawPattern(HP, makeMockCanvas(), ui.viewOpts()).labelsDrawn === false);
els.showCodes.checked = true;
fire(els.showCodes, 'change');
eq('勾选框 | 重新勾上 → 回到 "code"', ui.viewOpts().cellLabel, 'code');
els.showRuler.checked = false;
fire(els.showRuler, 'change');
eq('勾选框 | 取消「显示坐标刻度」只改 showRuler，不动 cellLabel', [ui.viewOpts().showRuler, ui.viewOpts().cellLabel], [false, 'code']);
els.showRuler.checked = true;
fire(els.showRuler, 'change');
ok('勾选框 | #cellLabelHint 文案里不再出现「编号」（数字编号功能已删除）',
  String(els.cellLabelHint.textContent).length > 0 && String(els.cellLabelHint.textContent).indexOf('编号') < 0, String(els.cellLabelHint.textContent));
erFlushAll();

/* ── 色数上限：滑杆 ↔ 数字框 双向同步 + 越界夹取 ─────────────────────── */
const maxColorsBoth = () => [String(els.maxColors.value), String(els.maxColorsNum.value)];
eq('色数上限 | 前置 | 滑杆与数字框初始一致', maxColorsBoth(), ['24', '24']);
els.maxColors.value = '60';
fire(els.maxColors, 'input');
eq('色数上限 | 拖滑杆 → 数字框跟着变', maxColorsBoth(), ['60', '60']);
eq('色数上限 | 拖滑杆 → 送进 pipeline 的上限也是 60', ui.options().quantize.maxColors, 60);
for (const t of [['0', '2'], ['1', '2'], ['222', '221'], ['999', '221'], ['150', '150']]) {
  els.maxColorsNum.value = t[0];
  fire(els.maxColorsNum, 'input');
  eq('色数上限 | 键入 ' + t[0] + ' → 夹取为 ' + t[1] + '，滑杆与数字框都变成该值', maxColorsBoth(), [t[1], t[1]]);
}
els.maxColorsNum.value = 'abc';
fire(els.maxColorsNum, 'input');
eq('色数上限 | 键入 "abc" 时 input 阶段不动滑杆、且保留原文（便于继续编辑）',
  [String(els.maxColors.value), String(els.maxColorsNum.value)], ['150', 'abc']);
fire(els.maxColorsNum, 'change');
eq('色数上限 | 失焦(change) 时把非法文本回写成上一次有效值 150，两者恢复一致', maxColorsBoth(), ['150', '150']);
eq('色数上限 | 非法文本不污染送进 pipeline 的值', ui.options().quantize.maxColors, 150);
ok('色数上限 | 提交之后两个控件相等（结构性同步；输入中途允许数字框暂时持有未提交文本）',
  String(els.maxColors.value) === String(els.maxColorsNum.value));
els.quantizeEnabled.checked = false;
fire(els.quantizeEnabled, 'change');
eq('色数上限 | 关闭减色 → 滑杆与数字框一起 disabled（不出现一个灰一个亮）', [els.maxColors.disabled, els.maxColorsNum.disabled], [true, true]);
els.quantizeEnabled.checked = true;
fire(els.quantizeEnabled, 'change');
eq('色数上限 | 重新开启减色 → 一起恢复可用', [els.maxColors.disabled, els.maxColorsNum.disabled], [false, false]);
erFlushAll();

/* ── 导出：格内色号永远画出（与预览开关解耦），导出组没有色号开关 ───── */
eq('导出 | 「导出」组的控件恰好是这 4 个（无格内色号开关、无对照图按钮）',
  ((sectionOf('导出') || '').match(/<(?:input|select|button)\b[^>]*>/g) || []).map((t) => (/\bid="([^"]+)"/.exec(t) || [null, '?' + t.slice(0, 18)])[1]),
  ['exportScale', 'exportAnnotate', 'btnExportPng', 'btnExportCsv']);
els.showCodes.checked = false;          // 预览侧关掉色号
fire(els.showCodes, 'change');
eq('导出 | 预览关掉「显示色号」→ 导出 opts 仍强制 cellLabel === "code"', ui.exportViewOpts(2).cellLabel, 'code');
eq('导出 | 兼容键 showCodes 也被写成 true（旧键不能把导出色号关掉）', ui.exportViewOpts(2).showCodes, true);
eq('导出 | 此时预览侧确实是 none（两套开关真的解耦）', ui.viewOpts().cellLabel, 'none');
els.exportScale.value = '1';
els.exportAnnotate.checked = false;
erFlushAll();                   // 不用 dropTimers()：丢弃重渲染定时器会让 renderScheduled 永久卡住
dom.created.canvases.length = 0;
drawCalls.length = 0;
st.pattern = st.pattern || Pipeline.generateFromRGBA(synth(20, 20, (x) => [x * 9 % 256, 120, 60]), 20, 20, { gridW: 8, gridH: 8 });
ui.exportPng();
ok('导出 | 真导出路径（exportPng → drawPattern）拿到的 cellLabel 也是 "code"',
  drawCalls.length > 0 && drawCalls[drawCalls.length - 1].opts.cellLabel === 'code',
  JSON.stringify(drawCalls.length ? drawCalls[drawCalls.length - 1].opts.cellLabel : null));
ok('导出 | #exportHint 文案说明了「导出永远画色号、与预览开关无关」',
  /色号.{0,8}永远画出/.test(String(els.exportHint.textContent)) && String(els.exportHint.textContent).indexOf('显示色号') >= 0,
  String(els.exportHint.textContent));
els.showCodes.checked = true;
fire(els.showCodes, 'change');
erFlushAll();

/* ── 预览区点击守卫：无图时点标题输入框 / 它的 <label> 不该顺手弹文件选择器 ── */
const guardSourceBackup = st.source;
st.source = null;                       // 只在「无图」状态下走这条守卫
const guardTagNameBackup = els.chartTitle.tagName;
els.chartTitle.tagName = 'INPUT';       // 桩元素默认 tagName 是 DIV，这里显式模拟真实输入框
const guardClicks0 = els.fileInput._clicks;
fire(els.dropZone, 'click', { target: els.chartTitle });
eq('预览区点击守卫 | 无图时点标题输入框（<input>）→ 不触发文件选择', els.fileInput._clicks - guardClicks0, 0);
fire(els.dropZone, 'click', { target: { tagName: 'label' } });
eq('预览区点击守卫 | 无图时点标题的 <label>（会把焦点转发给输入框）→ 也不触发文件选择', els.fileInput._clicks - guardClicks0, 0);
fire(els.dropZone, 'click', { target: els.patternCanvas });
eq('预览区点击守卫 | 无图时点预览区其它位置 → 行为不变，仍然弹出文件选择', els.fileInput._clicks - guardClicks0, 1);
els.chartTitle.tagName = guardTagNameBackup;
st.source = guardSourceBackup;

/* ── 标题：默认值在 HTML 层面已断言（桩元素不解析 value 属性）；这里补行为契约 ── */
els.chartTitle.value = '不该被重置的标题';
fire(els.btnResetAdjust, 'click');
erFlushAll();
eq('标题 | 「重置微调」不会清掉用户输入的标题（applyDefaults 刻意不复位 chartTitle）', String(els.chartTitle.value), '不该被重置的标题');
els.chartTitle.value = '';
fire(els.chartTitle, 'input');
erFlushAll();
eq('标题 | 清空后 viewOpts / exportViewOpts 的 captionName 都是空串（导出侧同步）',
  [ui.viewOpts().captionName, ui.exportViewOpts(2).captionName], ['', '']);
els.chartTitle.value = '未命名图纸';
fire(els.chartTitle, 'input');
erFlushAll();

/* ── 卡片配色：.group 用自己的专色（更浅），且没有连带改亮 --panel2 的其它使用者 ── */
const cssVarLit = (name) => {
  const m = new RegExp('--' + name + '\\s*:\\s*(#[0-9a-fA-F]{3,6})').exec(UI_HTML);
  return m ? m[1].toUpperCase() : null;
};
const hexLum = (h) => {
  const s = String(h).replace('#', '');
  const n = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  const f = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(parseInt(n.slice(0, 2), 16) / 255) + 0.7152 * f(parseInt(n.slice(2, 4), 16) / 255) + 0.0722 * f(parseInt(n.slice(4, 6), 16) / 255);
};
const groupRule = ruleBodyOf('.group');
ok('卡片配色 | .group 规则能解析出来（下面几条不是空转）', !!groupRule, JSON.stringify(groupRule));
const groupBgVar = /background\s*:\s*var\(\s*--([\w-]+)\s*\)/.exec(groupRule || '');
const groupBorderVar = /border\s*:\s*1px\s+solid\s+var\(\s*--([\w-]+)\s*\)/.exec(groupRule || '');
const groupBg = groupBgVar ? cssVarLit(groupBgVar[1]) : null;
const groupBorder = groupBorderVar ? cssVarLit(groupBorderVar[1]) : null;
const panel2Lit = cssVarLit('panel2');
const lineLit = cssVarLit('line');
eq('卡片配色 | --panel2 的字面量未被改动（仍是 #1F232B）', panel2Lit, '#1F232B');
eq('卡片配色 | --line 的字面量未被改动（仍是 #2A2F39）', lineLit, '#2A2F39');
eq('卡片配色 | .group 的底色字面量 === #272D37（写死的期望值）', groupBg, '#272D37');
eq('卡片配色 | .group 的边框字面量 === #3A4250（写死的期望值）', groupBorder, '#3A4250');
ok('卡片配色 | .group 不再复用 --panel2（自有变量，不是同一份颜色）',
  !!groupBgVar && groupBgVar[1] !== 'panel2' && groupBg !== panel2Lit, JSON.stringify(groupBgVar && groupBgVar[1]));
ok('卡片配色 | .group 的底色比 --panel2 更浅（相对亮度更高）',
  !!groupBg && hexLum(groupBg) > hexLum(panel2Lit),
  groupBg + ' lum=' + (groupBg ? hexLum(groupBg).toFixed(4) : '?') + ' vs ' + panel2Lit + ' lum=' + hexLum(panel2Lit).toFixed(4));
ok('卡片配色 | .group 的边框比 --line 更亮一档',
  !!groupBorder && hexLum(groupBorder) > hexLum(lineLit),
  groupBorder + ' lum=' + (groupBorder ? hexLum(groupBorder).toFixed(4) : '?') + ' vs ' + lineLit + ' lum=' + hexLum(lineLit).toFixed(4));
for (const sel of ['.legend-row', '.sw-grid-wrap', '.progress']) {
  const body = ruleBodyOf(sel);
  ok('卡片配色 | ' + sel + ' 仍用 var(--panel2)（没被一起改亮）', !!body && /background\s*:\s*var\(--panel2\)/.test(body), JSON.stringify(body));
}
const inputRule = ruleBodyOf('input[type="number"],input[type="text"],select');
ok('卡片配色 | 输入框 / 下拉仍用 var(--panel2)（没被一起改亮）', !!inputRule && /background\s*:\s*var\(--panel2\)/.test(inputRule), JSON.stringify(inputRule));
ok('卡片配色 | --panel2 的 4 个其它使用者都还在引用它（一个都没被摘掉）',
  ['.legend-row', '.sw-grid-wrap', '.progress'].every((s) => new RegExp(s.replace(/\./g, '\\.') + '\\{[^}]*var\\(--panel2\\)').test(UI_HTML)) && /input\[type="text"\],select\{[^}]*var\(--panel2\)/.test(UI_HTML));

/* ══════════════════════════════════════════════════════════════════════
   移动端 / 服务器部署：布局（CSS 文本层）、触摸、导出兜底、文案诚实性
   ══════════════════════════════════════════════════════════════════════ */

/* ── CSS 解析：先剥掉注释（否则注释文本会被当成选择器），再做一层 @media 嵌套 ── */
const cssSource = (UI_HTML.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1].replace(/\/\*[\s\S]*?\*\//g, ' ');
function parseCssRules(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('{', i);
    if (at < 0) break;
    const prelude = css.slice(i, at).trim();
    let depth = 1, j = at + 1;
    while (j < css.length && depth > 0) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    const body = css.slice(at + 1, j - 1);
    if (/^@media\b/i.test(prelude)) {
      for (const r of parseCssRules(body)) { r.media = prelude; out.push(r); }
    } else if (prelude) {
      out.push({ selector: prelude, body: body, media: null });
    }
    i = j;
  }
  return out;
}
const cssRules = parseCssRules(cssSource);
ok('CSS 前置 | 解析出 ' + cssRules.length + ' 条规则 / 含 ' + cssRules.filter((r) => r.media).length + ' 条在 @media 内（下面的断言不是空转）',
  cssRules.length > 40 && cssRules.filter((r) => r.media).length > 3);
const simpleSel = (r) => r.selector.split(',').map((s) => s.trim());
const mediaMax = (media) => { const m = /max-width\s*:\s*([\d.]+)px/.exec(media || ''); return m ? Number(m[1]) : null; };
/* CSS 级联：同一条规则里如果写了多条 touch-action，**最后一条**才生效。
   只看「body 里出现过 none」会被 `touch-action:none;touch-action:pan-y` 这种写法骗过去。 */
const touchActionOf = (body) => {
  const all = [...String(body).matchAll(/touch-action\s*:\s*([^;}]+)/g)].map((m) => m[1].trim().toLowerCase());
  return all.length ? all[all.length - 1] : null;
};

/* ── touch-action：源画布恒 none；图纸画布只在橡皮刷激活态为 none ─────── */
const sourceCanvasRules = cssRules.filter((r) => /#sourceCanvas|\.source-canvas\b/.test(r.selector));
ok('触摸 | CSS 里能定位到源画布规则（下面不是空转）', sourceCanvasRules.length > 0, JSON.stringify(sourceCanvasRules.map((r) => r.selector)));
/* 本轮实现变了：常态**不再**是 none（页面可滚），只有「裁剪模式」才吃掉手势。
   原判据 `some(===none) && every(===null||none)` 在这种情况下**仍然通过**，但已经不表示
   它名字里说的那件事了（语义过时却仍绿 —— 正是这次要消除的形态）。改成两条，分别钉住两件事。 */
const sourcePlainRules = cssRules.filter((r) => simpleSel(r).some((s) => /^(#sourceCanvas|\.source-canvas)$/.test(s)));
const sourceCropRules = cssRules.filter((r) => /(#sourceCanvas|\.source-canvas)\.crop-mode\b/.test(r.selector));
ok('触摸 | CSS 里能定位到源画布的【常态】规则（下面不是空转）', sourcePlainRules.length > 0, JSON.stringify(sourcePlainRules.map((r) => r.selector)));
ok('触摸 | 源画布【常态】实际生效的 touch-action 不是 none（否则用户想滚页面时滚不动 —— 用户报的就是这个 bug）',
  sourcePlainRules.length > 0 && sourcePlainRules.every((r) => touchActionOf(r.body) !== 'none'),
  JSON.stringify(sourcePlainRules.map((r) => [r.selector, touchActionOf(r.body)])));
ok('触摸 | 存在 .source-canvas.crop-mode 规则且其【实际生效】值为 none（打开裁剪模式才吃掉手势）',
  sourceCropRules.length >= 1 && sourceCropRules.some((r) => touchActionOf(r.body) === 'none'),
  JSON.stringify(sourceCropRules.map((r) => [r.selector, touchActionOf(r.body)])));
const patternPlainRules = cssRules.filter((r) => simpleSel(r).some((s) => /^(#patternCanvas|\.pattern-canvas)$/.test(s)));
ok('触摸 | CSS 里能定位到图纸画布的【常态】规则（下面不是空转）', patternPlainRules.length > 0, JSON.stringify(patternPlainRules.map((r) => r.selector)));
ok('触摸 | 图纸画布【常态】实际生效的 touch-action 不是 none（否则大图在手机上没法滚动）',
  patternPlainRules.length > 0 && patternPlainRules.every((r) => touchActionOf(r.body) !== 'none'),
  JSON.stringify(patternPlainRules.map((r) => [r.selector, touchActionOf(r.body)])));
const patternStateRules = cssRules.filter((r) => /(#patternCanvas|\.pattern-canvas)\.[\w-]+/.test(r.selector));
const patternEraserRules = patternStateRules.filter((r) => touchActionOf(r.body) === 'none');
ok('触摸 | 存在「图纸画布 + 状态类」的规则设为 touch-action:none（橡皮刷激活态）',
  patternEraserRules.length >= 1, JSON.stringify(patternStateRules.map((r) => [r.selector, /touch-action[^;]*/.exec(r.body) ? /touch-action[^;]*/.exec(r.body)[0] : null])));
const eraserStateClass = patternEraserRules.length
  ? (new RegExp('(?:#patternCanvas|\\.pattern-canvas)\\.([\\w-]+)').exec(patternEraserRules[0].selector) || [null, '__none__'])[1]
  : '__none__';

/* ── 响应式：100dvh 兜底、hover 隔离、移动字号、触控目标、桌面三栏 ─────── */
const dvhRules = cssRules.filter((r) => /100dvh/.test(r.body));
ok('响应式 | 存在 100dvh 用法（移动端地址栏动态高度）', dvhRules.length > 0);
ok('响应式 | 含 100dvh 的规则里同时保留 100vh 兜底，且 vh 写在 dvh 之前（老浏览器按后者覆盖）',
  dvhRules.every((r) => /100vh/.test(r.body) && r.body.indexOf('100vh') < r.body.indexOf('100dvh')),
  JSON.stringify(dvhRules.map((r) => r.body.replace(/\s+/g, ' ').slice(0, 120))));
const hoverRules = cssRules.filter((r) => r.selector.indexOf(':hover') >= 0);
ok('响应式 | 存在 :hover 规则（下面不是空转）', hoverRules.length > 0, String(hoverRules.length));
ok('响应式 | 所有 :hover 规则都包在 @media (hover:hover) 里（触摸端不该有悬停态）',
  hoverRules.every((r) => !!r.media && /hover\s*:\s*hover/.test(r.media)),
  JSON.stringify(hoverRules.filter((r) => !(r.media && /hover\s*:\s*hover/.test(r.media))).map((r) => r.selector + ' @ ' + r.media)));
const inputFontRules = cssRules.filter((r) => !!r.media && /(^|[\s,[>])(input|select|textarea)/.test(r.selector) && /font-size\s*:\s*[\d.]+px/.test(r.body));
const inputFontSizes = inputFontRules.map((r) => ({ sel: r.selector, media: r.media, px: Number(/font-size\s*:\s*([\d.]+)px/.exec(r.body)[1]) }));
ok('响应式 | 移动断点内有 ≥16px 的输入框字号（防 iOS 聚焦自动放大）',
  inputFontSizes.some((x) => x.px >= 16), JSON.stringify(inputFontSizes));
const touchTargetRules = cssRules.filter((r) => !!r.media && /button|\.btn\b|\.tab\b/.test(r.selector));
const touchTargetSizes = [];
for (const r of touchTargetRules) {
  const m = /(?:min-)?height\s*:\s*([\d.]+)px/.exec(r.body);
  if (m) touchTargetSizes.push({ sel: r.selector, media: r.media, px: Number(m[1]) });
}
ok('响应式 | 移动断点内触控目标 ≥44px（按钮/标签页）',
  touchTargetSizes.some((x) => x.px >= 44), JSON.stringify(touchTargetSizes));
const layoutColRules = cssRules.filter((r) => /(?:^|[\s,])\.layout\b/.test(r.selector) && /grid-template-columns/.test(r.body));
ok('桌面布局 | 三栏定义 310px minmax(0,1fr) 320px 原样保留（不得改动）',
  layoutColRules.some((r) => /310px\s+minmax\(\s*0\s*,\s*1fr\s*\)\s+320px/.test(r.body)),
  JSON.stringify(layoutColRules.map((r) => [r.selector, r.body.replace(/\s+/g, ' ').slice(0, 70)])));
ok('桌面布局 | 任何改写 .layout 列定义的规则都只在 <1181px 生效（动不到桌面三栏）',
  layoutColRules.filter((r) => !/310px\s+minmax\(\s*0\s*,\s*1fr\s*\)\s+320px/.test(r.body))
    .every((r) => { const mx = mediaMax(r.media); return mx !== null && mx < 1181; }),
  JSON.stringify(layoutColRules.filter((r) => !/310px\s+minmax\(\s*0\s*,\s*1fr\s*\)\s+320px/.test(r.body)).map((r) => [r.media, r.body.replace(/\s+/g, ' ').slice(0, 60)])));
/* 手机上预览区要能出现在前面：要么 DOM 把预览排到控制面板之前，要么移动断点里用 order 指定 */
const mobileOrderRules = cssRules.filter((r) => !!r.media && mediaMax(r.media) !== null && mediaMax(r.media) <= 1180
  && /(^|[^-\w])order\s*:\s*-?\d+/.test(r.body)
  && /dropZone|canvas-panel|controls|aside|layout/.test(r.selector));
ok('移动布局 | 手机上预览区排到控制面板之前（DOM 重排 或 移动断点里用 order 指定）',
  mobileOrderRules.length > 0,
  JSON.stringify(mobileOrderRules.map((r) => [r.media, r.selector, r.body.replace(/\s+/g, ' ').slice(0, 60)])));

/* ── 触摸行为：橡皮刷状态类增删 ───────────────────────────────────────── */
ok('触摸行为前置 | 从 CSS 里解析出了橡皮刷状态类名（下面不是空转）', eraserStateClass !== '__none__', eraserStateClass);
els.toolEraser.checked = true;
fire(els.toolEraser, 'change');
eq('触摸行为 | 橡皮刷激活 → #patternCanvas 带上 ' + eraserStateClass + ' 类（该类的规则就是 touch-action:none）',
  els.patternCanvas.classList.contains(eraserStateClass), true);
els.toolWand.checked = true;
fire(els.toolWand, 'change');
eq('触摸行为 | 换成魔术棒 → 该类被移除（只有橡皮刷需要吃掉手势）',
  els.patternCanvas.classList.contains(eraserStateClass), false);
els.toolNone.checked = true;
fire(els.toolNone, 'change');
eq('触摸行为 | 关闭工具 → 常态无该类（画布可正常滚动）', els.patternCanvas.classList.contains(eraserStateClass), false);
erFlushAll();

/* ── 文案诚实性（服务器 + 触摸端）──────────────────────────────────────
   实现口径（app.js applyEnvironmentText）：桌面端三条入口都真的能用，照旧写；
   触摸端只剩「从相册选」这一条走得通，必须改掉；副标题在任何端都不许再写「纯本地运行」。 */
const dropHintHtml = (UI_HTML.match(/<span id="dropHint"[^>]*>([^<]*)</) || [null, ''])[1];
const subHtml = (UI_HTML.match(/<p class="app-sub"[^>]*>([^<]*)</) || [null, ''])[1];
info('文案原文 | #dropHint(HTML) = ' + JSON.stringify(dropHintHtml) + ' ｜ 副标题(HTML) = ' + JSON.stringify(subHtml));
ok('文案 | #dropHint 与副标题在 HTML 里都非空（下面的否定断言才有意义，不是空转）',
  !!dropHintHtml && !!subHtml, JSON.stringify([dropHintHtml, subHtml]));
ok('文案 | 顶部副标题不再宣称「纯本地运行」（发到服务器后这句不成立）',
  !!subHtml && subHtml.indexOf('纯本地运行') < 0, JSON.stringify(subHtml));
ok('文案 | 整个 ui.html 里都不再出现「纯本地运行」', UI_HTML.indexOf('纯本地运行') < 0);
ok('文案 | 副标题如实说明图片在浏览器里处理 / 不会上传（服务器部署下仍然成立的说法）',
  /不上传|不会上传|不会离开|浏览器内|浏览器里/.test(subHtml || ''), JSON.stringify(subHtml));

/* ── 捏合缩放：两指距离比 → state.viewZoom（与 +/−/适应窗口同一套）────── */
els.toolNone.checked = true;
fire(els.toolNone, 'change');
erFlushAll();
st.pattern = st.pattern || Pipeline.generateFromRGBA(synth(20, 20, (x) => [x * 9 % 256, 120, 60]), 20, 20, { gridW: 8, gridH: 8 });
const pinchCv = dom.map.patternCanvas;
globalThis.Render.drawPattern(st.pattern, pinchCv, ui.viewOpts());   // applyViewZoom 需要画布已有尺寸
const handlersOf = (el) => (el && el._handlers) ? el._handlers : {};
const bindTypes = (el) => Object.keys(handlersOf(el));
const pinchUsesTouch = [pinchCv, dom.map.canvasScroll, dom.doc].some((el) => bindTypes(el).indexOf('touchstart') >= 0 || bindTypes(el).indexOf('touchmove') >= 0);
const pinchDownT = bindTypes(pinchCv).indexOf('touchstart') >= 0 ? pinchCv : (handlersOf(pinchCv).pointerdown ? pinchCv : dom.map.canvasScroll);
const pinchMoveT = bindTypes(pinchCv).indexOf('touchmove') >= 0 ? pinchCv : (handlersOf(pinchCv).pointermove ? pinchCv : dom.doc);
const pinchUpT = handlersOf(pinchCv).pointerup ? pinchCv : dom.doc;
const pinchDownType = pinchUsesTouch ? 'touchstart' : 'pointerdown';
const pinchMoveType = pinchUsesTouch ? 'touchmove' : 'pointermove';
const pinchUpType = pinchUsesTouch ? 'touchend' : 'pointerup';
const pinchEv = (a, b) => (pinchUsesTouch
  ? { touches: [{ identifier: 11, clientX: a, clientY: 100 }, { identifier: 12, clientX: b, clientY: 100 }], changedTouches: [{ identifier: 11, clientX: a, clientY: 100 }, { identifier: 12, clientX: b, clientY: 100 }] }
  : { pointerId: 11, clientX: a, clientY: 100 });
const pinchEv2 = (a, b) => (pinchUsesTouch
  ? { touches: [{ identifier: 11, clientX: a, clientY: 100 }, { identifier: 12, clientX: b, clientY: 100 }], changedTouches: [{ identifier: 12, clientX: b, clientY: 100 }] }
  : { pointerId: 12, clientX: b, clientY: 100 });
ok('捏合前置 | 找到了手势事件的绑定目标与事件类型（下面不是空转）',
  bindTypes(pinchCv).concat(bindTypes(dom.doc), bindTypes(dom.map.canvasScroll)).some((t) => /pointerdown|touchstart/.test(t)),
  'event=' + pinchDownType + ' downOnCanvas=' + (pinchDownT === pinchCv) + ' handlers=' + JSON.stringify(bindTypes(pinchCv)));
ui.setViewZoom(1);
st.history.length = 0;
const pinchCellsBefore = Array.from(st.pattern.cells).join(',');
const pinchHistBefore = st.history.length;
fire(pinchDownT, pinchDownType, pinchEv(100, 200));
fire(pinchMoveT, pinchMoveType, pinchEv(50, 250));
eq('捏合 | 两指距离 100 → 200（比例 2）→ viewZoom 1 → 2', st.viewZoom, 2);
eq('捏合 | 与按钮走同一套 applyViewZoom（viewZoomApplied 同步）', st.viewZoomApplied, st.viewZoom);
ok('捏合 | applyViewZoom 真的跑了（画布 CSS 尺寸被写成 px）',
  /^\d+px$/.test(String(pinchCv.style.width || '')) && /^\d+px$/.test(String(pinchCv.style.height || '')),
  JSON.stringify([pinchCv.style.width, pinchCv.style.height]));
eq('捏合 | 捏合不改 cells', Array.from(st.pattern.cells).join(','), pinchCellsBefore);
eq('捏合 | 捏合不进历史栈', st.history.length, pinchHistBefore);
fire(pinchDownT, pinchDownType, pinchEv(100, 200));
fire(pinchMoveT, pinchMoveType, pinchEv(-4000, 4000));
eq('捏合 | 比例极大 → 夹取到上限 4×', st.viewZoom, 4);
fire(pinchMoveT, pinchMoveType, pinchEv(100, 200));
fire(pinchMoveT, pinchMoveType, pinchEv2(100, 101));
eq('捏合 | 比例极小 → 夹取到下限 0.25×', st.viewZoom, 0.25);
fire(pinchUpT, pinchUpType, pinchEv(100, 200));
ui.setViewZoom(1);
erFlushAll();
ok('捏合 | 触摸端常态下图纸画布没有 touch-action:none（有人图省事写死的话就没法滚动了）',
  !els.patternCanvas.classList.contains(eraserStateClass), eraserStateClass);

/* ── 能力检测 + 触摸端导出兜底（第二/第三个 app 实例）────────────────── */
ok('兜底 | 触摸判定走能力检测（matchMedia 的 (pointer: coarse) / 窄屏），不是 UA 嗅探',
  /matchMedia/.test(APP_SRC) && /pointer\s*:\s*coarse/.test(APP_SRC) && !/userAgent|navigator\.platform/.test(APP_SRC));
ok('兜底 | 声明了「长按 / 保存到相册」入口文案', /长按/.test(APP_SRC) && /相册/.test(APP_SRC));
ok('兜底 | CSV 有「剪贴板 + 可长按选中文本框」两级降级',
  /clipboard/.test(APP_SRC) && /writeText/.test(APP_SRC) && /saveText/.test(APP_SRC));
function mkInstance(winExtra, instrument) {
  const d = makeDoc(htmlIds);
  const timers = [];
  let seq = 0;
  const win = Object.assign({
    PINDOU_PALETTES: globalThis.PINDOU_PALETTES,
    ColorKit: globalThis.ColorKit,
    Pipeline: globalThis.Pipeline,
    Render: globalThis.Render,
    setTimeout(fn) { const id = ++seq; timers.push({ id, fn, cancelled: false }); return id; },
    clearTimeout(id) { for (const t of timers) if (t.id === id) t.cancelled = true; },
    performance: { now: () => 0 },
    Blob: class StubBlob { constructor() {} },
    URL: makeUrlStub(),
    localStorage: (function () { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; })()
  }, winExtra || {});
  const ctx = vm.createContext({ window: win, document: d.doc, console: { warn() {}, log() {} } });
  let err = null;
  try { vm.runInContext(APP_SRC, ctx, { filename: 'app.js' }); } catch (e) { err = e; }
  if (instrument) instrument(d);
  const flush = (n) => { for (let i = 0; i < (n || 3); i++) { const q = timers.splice(0); for (const t of q) if (!t.cancelled) t.fn(); } };
  return { win: win, d: d, api: win.PindouUI, err: err, flush: flush };
}
const coarseMedia = (q) => ({ matches: /pointer\s*:\s*coarse/.test(String(q)), media: String(q), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
const clipWrites = [];
const coarse = mkInstance({ matchMedia: coarseMedia, navigator: { clipboard: { writeText(t) { clipWrites.push(String(t)); return Promise.resolve(); } } } });
ok('兜底 | coarse 实例（(pointer: coarse) 为真）app.js 加载无抛错', coarse.err === null, coarse.err ? coarse.err.message : '');
ok('兜底 | coarse 实例挂上了 PindouUI', !!coarse.api && typeof coarse.api.boot === 'function');
if (coarse.api && typeof coarse.api.boot === 'function') coarse.api.boot();
const coarseEls = (coarse.api && typeof coarse.api.elements === 'function') ? coarse.api.elements() : {};
const missingIn = (obj, names) => names.filter((n) => !obj || !obj[n]);
/* 派发事件前先确认元素真的在：src/ 半成品（元素缺失）时必须「断言失败」而不是「整个套件崩掉」 */
const safeFire = (el, type, extra) => { if (el && typeof el.dispatchEvent === 'function') { fire(el, type, extra); return true; } return false; };
const stateOf = (inst) => (inst.api && typeof inst.api.state === 'function') ? inst.api.state() : null;
const OVERLAY_ELS = ['saveOverlay', 'saveTip', 'saveImage', 'saveText', 'saveCopy'];
const UI_REQUIRED = OVERLAY_ELS.concat(['btnExportPng', 'btnExportCsv', 'patternCanvas', 'dropHint', 'inputHint', 'statusText', 'fileInput']);
const coarseOverlayReady = missingIn(coarseEls, OVERLAY_ELS).length === 0;
eq('兜底前置 | coarse 实例暴露了覆盖层与导出按钮（元素缺失时下面的行为断言会一起报假）', missingIn(coarseEls, UI_REQUIRED), []);
const coarseState = stateOf(coarse);
if (coarseState) coarseState.pattern = pat6;

/* ── 文案诚实性：触摸端不得再写触摸端做不到的入口（桌面端保留真实可用的提示）──────
   A 的实现是 applyEnvironmentText() 按端改写；所以否定断言只对 coarse 实例做，
   桌面端那两个入口（拖拽 / Ctrl+V）真的能用，断它们「不含」等于要求界面对桌面用户撒谎。 */
ok('文案 | 触摸端 #dropHint 不含「Ctrl+V」（手机上做不到）',
  String(coarseEls.dropHint.textContent).indexOf('Ctrl+V') < 0, String(coarseEls.dropHint.textContent));
ok('文案 | 触摸端 #dropHint 不含「拖拽」（触摸端无法拖拽）',
  !/拖拽/.test(String(coarseEls.dropHint.textContent)), String(coarseEls.dropHint.textContent));
ok('文案 | 触摸端 #dropHint 给出真正可行的入口（从相册选）',
  /选择图片|相册/.test(String(coarseEls.dropHint.textContent)), String(coarseEls.dropHint.textContent));
ok('文案 | 触摸端 #inputHint 同样不含 Ctrl+V / 拖拽',
  !/Ctrl\+V|拖拽/.test(String(coarseEls.inputHint.textContent)), String(coarseEls.inputHint.textContent));
ok('文案 | 桌面端 #dropHint 仍保留 Ctrl+V 与拖拽（这两个入口在桌面真的能用）',
  /Ctrl\+V/.test(String(els.dropHint.textContent)) && /拖拽/.test(String(els.dropHint.textContent)), String(els.dropHint.textContent));
ok('文案 | 桌面端 #inputHint 同理保留 Ctrl+V（不做否定断言）',
  /Ctrl\+V/.test(String(els.inputHint.textContent)), String(els.inputHint.textContent));

/* 触摸端 PNG：覆盖层 + 可长按保存的 <img>；三条路径都要断言（toBlob → toDataURL → 诚实降级） */
safeFire(coarseEls.btnExportPng, 'click');
ok('兜底 | 触摸端导出 PNG → 覆盖层打开', coarseOverlayReady && coarseEls.saveOverlay.hidden === false, String(coarseEls.saveOverlay && coarseEls.saveOverlay.hidden));
ok('兜底 | 路径1 有 toBlob → 显示可长按保存的 img（而不是空白框）', coarseOverlayReady && coarseEls.saveImage.hidden === false, String(coarseEls.saveImage && coarseEls.saveImage.hidden));
ok('兜底 | 路径1 img.src 以 blob: 开头（走 toBlob → createObjectURL，不产生 base64 膨胀）',
  coarseOverlayReady && /^blob:/.test(String(coarseEls.saveImage.src || '')), String((coarseEls.saveImage || {}).src || ''));
ok('兜底 | 提示文案写明「长按…存储到相册 / 保存图片」',
  coarseOverlayReady && /长按/.test(String(coarseEls.saveTip.textContent)) && /相册|保存图片/.test(String(coarseEls.saveTip.textContent)), String((coarseEls.saveTip || {}).textContent));
/* 路径2：老内核没有 toBlob，但有 toDataURL → img.src = data:image/png;… */
const noBlob = mkInstance({ matchMedia: coarseMedia }, (d) => {
  const orig = d.doc.createElement;
  d.doc.createElement = function (tag) {
    const el = orig.call(this, tag);
    if (String(tag).toLowerCase() === 'canvas') delete el.toBlob;      // 只有 toDataURL
    return el;
  };
});
if (noBlob.api && typeof noBlob.api.boot === 'function') noBlob.api.boot();
const noBlobEls = (noBlob.api && typeof noBlob.api.elements === 'function') ? noBlob.api.elements() : {};
const noBlobReady = missingIn(noBlobEls, OVERLAY_ELS).length === 0;
eq('兜底前置 | 路径2 实例暴露了覆盖层元素', missingIn(noBlobEls, OVERLAY_ELS), []);
if (stateOf(noBlob)) stateOf(noBlob).pattern = pat6;
safeFire(noBlobEls.btnExportPng, 'click');
ok('兜底 | 路径2 无 toBlob 但有 toDataURL → img 可见且 src 以 data:image/png 开头',
  noBlobReady && noBlobEls.saveImage.hidden === false && /^data:image\/png/.test(String(noBlobEls.saveImage.src || '')),
  JSON.stringify({ hidden: noBlobEls.saveImage && noBlobEls.saveImage.hidden, src: String((noBlobEls.saveImage || {}).src).slice(0, 30) }));
/* 路径3：两者都没有 → 不给假地址，必须同时「藏起 img」+「给出明确的存不了文案」 */
const noCaps = mkInstance({ matchMedia: coarseMedia }, (d) => {
  const orig = d.doc.createElement;
  d.doc.createElement = function (tag) {
    const el = orig.call(this, tag);
    if (String(tag).toLowerCase() === 'canvas') { delete el.toBlob; delete el.toDataURL; }
    return el;
  };
});
if (noCaps.api && typeof noCaps.api.boot === 'function') noCaps.api.boot();
const noCapsEls = (noCaps.api && typeof noCaps.api.elements === 'function') ? noCaps.api.elements() : {};
const noCapsReady = missingIn(noCapsEls, OVERLAY_ELS).length === 0;
eq('兜底前置 | 路径3 实例暴露了覆盖层元素', missingIn(noCapsEls, OVERLAY_ELS), []);
if (stateOf(noCaps)) stateOf(noCaps).pattern = pat6;
safeFire(noCapsEls.btnExportPng, 'click');
ok('兜底 | 路径3 两种能力都没有 → img 藏起来、src 为空、且给出明确的「这里存不了」文案（两件事同时成立，不是随便什么文案都算）',
  noCapsReady && noCapsEls.saveImage.hidden === true && String(noCapsEls.saveImage.src || '') === ''
  && /用不了|无法|不支持|存不了/.test(String(noCapsEls.saveTip.textContent))
  && /截图|电脑浏览器|手动/.test(String(noCapsEls.saveTip.textContent)),
  JSON.stringify({ hidden: noCapsEls.saveImage && noCapsEls.saveImage.hidden, src: String((noCapsEls.saveImage || {}).src), tip: String((noCapsEls.saveTip || {}).textContent) }));
/* 触摸端 CSV（剪贴板可用）：先给文本框 + 「复制到剪贴板」按钮；点按钮才真的写剪贴板 */
safeFire(coarseEls.btnExportCsv, 'click');
ok('兜底 | 触摸端导出 CSV → 覆盖层打开、文本框里是可复制的 CSV 全文',
  coarseOverlayReady && coarseEls.saveOverlay.hidden === false && coarseEls.saveText.hidden === false && String(coarseEls.saveText.value).indexOf('编号,色号') >= 0,
  JSON.stringify({ overlay: coarseEls.saveOverlay && coarseEls.saveOverlay.hidden, ta: coarseEls.saveText && coarseEls.saveText.hidden, v: String((coarseEls.saveText || {}).value).slice(0, 22) }));
ok('兜底 | 剪贴板可用 → 「复制到剪贴板」按钮可见且可用',
  coarseOverlayReady && coarseEls.saveCopy.hidden === false && coarseEls.saveCopy.disabled === false,
  JSON.stringify({ hidden: coarseEls.saveCopy && coarseEls.saveCopy.hidden, disabled: coarseEls.saveCopy && coarseEls.saveCopy.disabled }));
safeFire(coarseEls.saveCopy, 'click');
ok('兜底 | 点「复制到剪贴板」→ navigator.clipboard.writeText 收到 CSV 全文',
  clipWrites.some((t) => t.indexOf('编号,色号') >= 0), JSON.stringify(clipWrites.map((t) => String(t).slice(0, 24))));

/* 桌面端：就算给了剪贴板能力也不走兜底 —— 照样下载，覆盖层内容不被填充 */
const fineClip = [];
let finePng = 0;
const fine = mkInstance({
  matchMedia: (q) => ({ matches: false, media: String(q), addEventListener() {}, addListener() {} }),
  navigator: { clipboard: { writeText(t) { fineClip.push(String(t)); return Promise.resolve(); } } },
  Render: Object.assign({}, globalThis.Render, { exportPNG() { finePng++; return undefined; } })
});
if (fine.api && typeof fine.api.boot === 'function') fine.api.boot();
const fineEls = (fine.api && typeof fine.api.elements === 'function') ? fine.api.elements() : {};
const fineOverlayReady = missingIn(fineEls, OVERLAY_ELS).length === 0;
ok('兜底前置 | 桌面实例 app.js 加载无抛错且暴露了导出按钮（否则下面那条 0 次调用会产生误导）',
  fine.err === null && missingIn(fineEls, ['btnExportPng', 'btnExportCsv']).length === 0,
  JSON.stringify({ err: fine.err ? fine.err.message : null, missing: missingIn(fineEls, ['btnExportPng', 'btnExportCsv']) }));
if (stateOf(fine)) stateOf(fine).pattern = pat6;
safeFire(fineEls.btnExportCsv, 'click');
eq('兜底 | 桌面端导出 CSV 不碰剪贴板、不填触摸端文本框',
  [fineClip.length, fineOverlayReady ? String(fineEls.saveText.value) : ''], [0, '']);
ok('兜底 | 桌面端导出 CSV 仍然产生真实下载（新建 <a>）', fine.d.created.anchors.length > 0, String(fine.d.created.anchors.length));
safeFire(fineEls.btnExportPng, 'click');
ok('兜底 | 桌面端导出 PNG 仍然走 Render.exportPNG（不打开覆盖层）', finePng > 0, String(finePng));
eq('兜底前置 | 桌面实例暴露了覆盖层元素（下面那条 img 为空的断言才有意义）', missingIn(fineEls, OVERLAY_ELS), []);
eq('兜底 | 桌面端全程没有填充过 img（覆盖层那条路没被走到）', String(fineEls.saveImage.src || ''), '');

/* 触摸端 + 剪贴板不可用：只给可长按选中的文本框，不画一个点了没反应的按钮 */
const noClipSel = { n: 0 };
const noClip = mkInstance({ matchMedia: coarseMedia }, (d) => {
  const orig = d.doc.createElement;
  d.doc.createElement = function (tag) {
    const el = orig.call(this, tag);
    el._createdTag = String(tag).toLowerCase();
    if (el._createdTag === 'textarea') el.select = function () { noClipSel.n++; };
    return el;
  };
});
if (noClip.api && typeof noClip.api.boot === 'function') noClip.api.boot();
const noClipEls = (noClip.api && typeof noClip.api.elements === 'function') ? noClip.api.elements() : {};
const noClipReady = missingIn(noClipEls, OVERLAY_ELS).length === 0;
if (stateOf(noClip)) stateOf(noClip).pattern = pat6;
safeFire(noClipEls.btnExportCsv, 'click');
eq('兜底 | 剪贴板不可用 → 覆盖层打开、文本框可见且已填入 CSV',
  noClipReady ? [noClipEls.saveOverlay.hidden, noClipEls.saveText.hidden, String(noClipEls.saveText.value).indexOf('编号,色号') >= 0] : 'not-ready',
  [false, false, true]);
eq('兜底 | 剪贴板不可用 → 「复制到剪贴板」按钮藏起来并置灰（绝不画一个点了没反应的按钮）',
  noClipReady ? [noClipEls.saveCopy.hidden, noClipEls.saveCopy.disabled] : 'not-ready', [true, true]);
ok('兜底 | 剪贴板不可用时提示改成「在文本框里长按全选复制」',
  noClipReady && /长按/.test(String(noClipEls.saveTip.textContent)) && /文本框/.test(String(noClipEls.saveTip.textContent)), String((noClipEls.saveTip || {}).textContent));
/* drawPattern 失败提示：降低导出倍数 */
forceTooLarge = true;
st.pattern = pat6;
dom.created.canvases.length = 0;
pngCalls.length = 0;
ui.exportPng();
ok('兜底 | drawPattern 返回 ok:false 时文案同时含「降低」与「倍数」（语义判定，不钉死实现措辞）',
  String(els.statusText.textContent).indexOf('降低') >= 0 && String(els.statusText.textContent).indexOf('倍数') >= 0
  && /超出|太大|上限/.test(String(els.statusText.textContent)), String(els.statusText.textContent));
forceTooLarge = false;
eq('兜底 | 该分支仍然零下载', pngCalls.length, 0);

/* ══════════════════════════════════════════════════════════════════════
   本轮（用户实测 4 个问题）：导入重试阶梯 / 批量修改 / 抠图撤销键
   ══════════════════════════════════════════════════════════════════════ */

/* ── 导入重试阶梯：<img> → createImageBitmap → 两条都失败才判失败 ─────────── */
function mkDecoderWin(spec) {
  const bmpCalls = [];
  const imgDims = spec.imgDims || [400, 300];
  const bmpDims = spec.bmpDims || [800, 600];
  function Img() {
    const img = { naturalWidth: 0, naturalHeight: 0, _src: '' };
    Object.defineProperty(img, 'src', {
      get() { return img._src; },
      set(v) {
        img._src = v;
        if (spec.img === 'ok') { img.naturalWidth = imgDims[0]; img.naturalHeight = imgDims[1]; if (img.onload) img.onload(); }
        else if (img.onerror) img.onerror();
      }
    });
    return img;
  }
  function createImageBitmap(blob, options) {
    bmpCalls.push({ argsLen: arguments.length, options: options, blob: blob });
    if (spec.bmp === 'throw-on-options' && options !== undefined) throw new Error('old engine: options unsupported');
    if (spec.bmp === 'fail') return Promise.reject(new Error('bitmap 解码失败'));
    return Promise.resolve({ width: bmpDims[0], height: bmpDims[1] });
  }
  return { Image: Img, createImageBitmap: createImageBitmap, bmpCalls: bmpCalls };
}
const mkBlob = (name, type, size) => ({ name: name, type: type, size: size });
/* createImageBitmap 的 ok/fail 回调都在 Promise 的微任务里 —— 断言前必须先让微任务跑完，
   否则会看到「还在读取图片…」的中间态（这不是实现的问题，是测试时序的问题）。 */
const flushAsync = () => new Promise((resolve) => setImmediate(resolve));
const fireFileInput = (els, blob) => {
  els.fileInput.files = { 0: blob, length: 1 };
  return safeFire(els.fileInput, 'change');
};
/* ① <img> 成功 → **不得**再去调 createImageBitmap */
const wImg = mkDecoderWin({ img: 'ok' });
const instImg = mkInstance(wImg);
if (instImg.api && instImg.api.boot) instImg.api.boot();
const elsImg = instImg.api.elements();
fireFileInput(elsImg, mkBlob('ok.png', 'image/png', 2048));
await flushAsync();
const stImg = instImg.api.state();
eq('导入阶梯 ① | <img> 成功 → 源图被采用（尺寸来自 <img>）', [stImg.srcW, stImg.srcH], [400, 300]);
ok('导入阶梯 ① | 源对象就是 <img> 实例', !!stImg.source && typeof stImg.source === 'object' && stImg.source._src !== undefined);
eq('导入阶梯 ① | createImageBitmap 调用 0 次（第一条路成功就不走第二条）', wImg.bmpCalls.length, 0);
ok('导入阶梯 ① | 提示为成功路径（不含「失败」）', String(elsImg.statusText.textContent).indexOf('失败') < 0, String(elsImg.statusText.textContent));

/* ② <img> 失败但 createImageBitmap 成功 → 换源成功，且**带 imageOrientation 选项** */
const wBmp = mkDecoderWin({ img: 'fail', bmp: 'ok' });
const instBmp = mkInstance(wBmp);
if (instBmp.api && instBmp.api.boot) instBmp.api.boot();
const elsBmp = instBmp.api.elements();
fireFileInput(elsBmp, mkBlob('fallback.jpg', 'image/jpeg', 4096));
await flushAsync();
const stBmp = instBmp.api.state();
eq('导入阶梯 ② | 第一条路失败、第二条成功 → 仍成功换源（尺寸来自 bitmap）', [stBmp.srcW, stBmp.srcH], [800, 600]);
eq('导入阶梯 ② | createImageBitmap 恰好调用 1 次', wBmp.bmpCalls.length, 1);
eq('导入阶梯 ② | spy：第二个实参是 { imageOrientation: "from-image" }（方向必须与 <img> 一致）',
  wBmp.bmpCalls[0].options, { imageOrientation: 'from-image' });
eq('导入阶梯 ② | spy：确实是带选项的两次实参调用', wBmp.bmpCalls[0].argsLen, 2);

/* ③ 两条都失败 → 判失败，且 state.source 仍为空 */
const wNone = mkDecoderWin({ img: 'fail', bmp: 'fail' });
const instNone = mkInstance(wNone);
if (instNone.api && instNone.api.boot) instNone.api.boot();
const elsNone = instNone.api.elements();
fireFileInput(elsNone, mkBlob('broken.heic', 'image/heic', 54321));
await flushAsync();
const stNone = instNone.api.state();
eq('导入阶梯 ③ | 两条路都失败 → state.source 仍为空', stNone.source, null);
eq('导入阶梯 ③ | 两条路都失败 → srcW/srcH 仍为 0', [stNone.srcW, stNone.srcH], [0, 0]);
const failMsg = String(elsNone.statusText.textContent);
ok('导入阶梯 ③ | 失败文案含文件名', failMsg.indexOf('broken.heic') >= 0, failMsg);
ok('导入阶梯 ③ | 失败文案含浏览器声明的 MIME', failMsg.indexOf('image/heic') >= 0, failMsg);
ok('导入阶梯 ③ | 失败文案含字节数', /字节/.test(failMsg) && failMsg.indexOf('54321') >= 0, failMsg);
ok('导入阶梯 ③ | 失败文案分别报出两条解码路径的原因', /<img>/.test(failMsg) && /createImageBitmap/.test(failMsg), failMsg);
ok('导入阶梯 ③ | 失败文案给出可行动建议（导出为 JPEG / 用截图）', /导出为 JPEG|截图/.test(failMsg), failMsg);

/* ④ 旧内核：带选项当场抛错 → 自动不带选项重试（2 次调用，第二次无选项） */
const wRetry = mkDecoderWin({ img: 'fail', bmp: 'throw-on-options' });
const instRetry = mkInstance(wRetry);
if (instRetry.api && instRetry.api.boot) instRetry.api.boot();
const elsRetry = instRetry.api.elements();
fireFileInput(elsRetry, mkBlob('old-engine.jpg', 'image/jpeg', 999));
await flushAsync();
const stRetry = instRetry.api.state();
eq('导入阶梯 ④ | 带选项抛错 → 自动重试，共 2 次调用', wRetry.bmpCalls.length, 2);
eq('导入阶梯 ④ | 第一次带 { imageOrientation }', wRetry.bmpCalls[0].options, { imageOrientation: 'from-image' });
eq('导入阶梯 ④ | 第二次不带任何选项（argsLen === 1 且 options === undefined）',
  [wRetry.bmpCalls[1].argsLen, wRetry.bmpCalls[1].options], [1, undefined]);
eq('导入阶梯 ④ | 重试仍成功换源', [stRetry.srcW, stRetry.srcH], [800, 600]);

/* ⑤ 大图不被拒：4000×3000 走完阶梯正常出图（上游不许加尺寸限制） */
const wBig = mkDecoderWin({ img: 'ok', imgDims: [4000, 3000] });
const instBig = mkInstance(wBig);
if (instBig.api && instBig.api.boot) instBig.api.boot();
const elsBig = instBig.api.elements();
fireFileInput(elsBig, mkBlob('big.jpg', 'image/jpeg', 5 * 1024 * 1024));
await flushAsync();
const stBig = instBig.api.state();
eq('导入阶梯 ⑤ | 4000×3000 源图被原样采用（不因尺寸被拒）', [stBig.srcW, stBig.srcH], [4000, 3000]);
ok('导入阶梯 ⑤ | 没有出现「尺寸无效/太大」类拒绝文案',
  !/尺寸无效|太大|超出/.test(String(elsBig.statusText.textContent)), String(elsBig.statusText.textContent));

/* ⑥ #fileInput 的 accept 原文（与 onDrop 兜底文案必须同口径） */
const fileInputTag = (UI_HTML.match(/<input\b[^>]*\bid="fileInput"[^>]*>/) || [''])[0];
eq('导入 | #fileInput 的 accept 原文', (fileInputTag.match(/accept="([^"]*)"/) || [null, null])[1],
  'image/*,.jpg,.jpeg,.png,.webp,.gif,.bmp,.avif,.heic,.heif');

/* ⑦ 非 image/* 的 MIME（application/octet-stream）**不许被静默丢弃**：
     要么交给解码阶梯成功换源，要么给出可诊断的失败文案（含文件名/类型/两条原因）。
     注意：这里**不**断言「被静默忽略」——那正是要消灭的形态。 */
const wOctet = mkDecoderWin({ img: 'ok' });
const instOctet = mkInstance(wOctet);
if (instOctet.api && instOctet.api.boot) instOctet.api.boot();
const elsOctet = instOctet.api.elements();
fireFileInput(elsOctet, mkBlob('sniffed.jpg', 'application/octet-stream', 7777));
await flushAsync();
const stOctet = instOctet.api.state();
ok('导入 ⑦ | octet-stream 但内容可解码 → 仍然成功换源（不被 MIME 挡掉）',
  stOctet.srcW === 400 && stOctet.srcH === 300, JSON.stringify([stOctet.srcW, stOctet.srcH, String(elsOctet.statusText.textContent)]));
const wOctetBad = mkDecoderWin({ img: 'fail', bmp: 'fail' });
const instOctetBad = mkInstance(wOctetBad);
if (instOctetBad.api && instOctetBad.api.boot) instOctetBad.api.boot();
const elsOctetBad = instOctetBad.api.elements();
fireFileInput(elsOctetBad, mkBlob('mystery.bin', 'application/octet-stream', 2048));
await flushAsync();
const octetMsg = String(elsOctetBad.statusText.textContent);
ok('导入 ⑦ | octet-stream 且两条解码都失败 → 给出可诊断文案（不是静默丢弃，也不只说「不是图片」）',
  octetMsg.indexOf('mystery.bin') >= 0 && octetMsg.indexOf('application/octet-stream') >= 0 && /字节/.test(octetMsg)
  && /<img>/.test(octetMsg) && /createImageBitmap/.test(octetMsg), octetMsg);

/* ══════════════════════════════════════════════════════════════════════
   批量修改（#batchMode）：四连通选区 + Lab 推荐 + 整片改色
   ══════════════════════════════════════════════════════════════════════ */
sandboxWin.ColorKit = globalThis.ColorKit;      /* 批量修改用 srgbToLab / deltaE */
const batchK = globalThis.ColorKit;
const batchPal = (function () {
  const keys = Object.keys(globalThis.PINDOU_PALETTES);
  const entry = globalThis.PINDOU_PALETTES[keys[0]];
  return { id: keys[0], colors: entry.colors };
})();
/* 9×5：区域 A = 第 0 行第 0–2 列（色 0）；区域 B = 第 4 行第 6–8 列（同色 0，与 A 不相连）；
   第 1 行第 0–2 列用色 1（保证三个色号都被用到，pruneUnusedColors 不会平移下标） */
const batchPat = erMkPat(9, 5, (x, y) => {
  if (y === 0 && x <= 2) return 0;
  if (y === 4 && x >= 6) return 0;
  if (y === 1 && x <= 2) return 1;
  if (y === 2) return null;
  return 2;
});
batchPat.paletteId = batchPal.id;
const codeOfCell = (pat, i) => (pat.cells[i] === EMPTY ? null : String(pat.colors[pat.cells[i]].code));
st.pattern = batchPat;
st.viewOpts = ui.viewOpts();
st.history.length = 0;
els.batchMode.checked = true;
fire(els.batchMode, 'change');
eq('批量 | 勾 #batchMode → state.tool === "batch"', ui.tool(), 'batch');
eq('批量 | 且 #recolorMode 被取消勾选（双向互斥）', els.recolorMode.checked, false);
eq('批量 | 三项单选（关闭/魔术棒/橡皮）都未选中', [els.toolNone.checked, els.toolWand.checked, els.toolEraser.checked], [false, false, false]);
els.recolorMode.checked = true;
fire(els.recolorMode, 'change');
eq('批量 | 反向：勾 #recolorMode → tool=recolor 且 #batchMode 自动取消', [ui.tool(), els.batchMode.checked], ['recolor', false]);
els.batchMode.checked = true;
fire(els.batchMode, 'change');
eq('批量 | 回到 batch（同一套 state.tool 状态机）', ui.tool(), 'batch');

/* 未选定：无选区、无推荐、不画高亮 */
eq('批量 | 未点格子时无选区', ui.batchRegion(), []);
eq('批量 | 未点格子时无推荐（recs 为 null）', ui.batchRecs(), null);
eq('批量 | 未选定 → 高亮不画（drawBatchHighlight 返回 false）', ui.drawBatchHighlight(), false);

/* 点一格 → 四连通那一片 */
const batchSelN = ui.batchSelect(1);
eq('批量 | 点一格 → 选区 = 四连通那一片（3 格）', ui.batchRegion().slice().sort((a, b) => a - b), [0, 1, 2]);
eq('批量 | batchSelect 返回值 = 选区大小', batchSelN, 3);
eq('批量 | 分离的同色区域 B 一格未动', [42, 43, 44].map((i) => st.pattern.cells[i]), [0, 0, 0]);
ok('批量 | 分离的 B 区 locked 也保持 0', [42, 43, 44].every((i) => !st.pattern.locked[i]));
ok('批量 | 选定后高亮画出来了（drawBatchHighlight 返回 true）', ui.drawBatchHighlight() === true);
ok('批量 | 高亮用色来自 ui.highlightColors()（rgba 形态，没写死在别处）',
  typeof ui.highlightColors().fill === 'string' && ui.highlightColors().fill.indexOf('rgba') === 0, JSON.stringify(ui.highlightColors()));
ok('批量 | 选中后状态栏报出选区大小', /已选中 3 格/.test(String(els.statusText.textContent)), String(els.statusText.textContent));
const recsNow = ui.batchRecs() || [];
const origBatchCode = codeOfCell(st.pattern, 1);
eq('批量 | 推荐色恰好 8 个', recsNow.length, 8);
ok('批量 | 推荐里不含原色号 ' + origBatchCode, recsNow.every((r) => r.code !== origBatchCode));
/* 独立重算：用 ColorKit 自己再算一遍 Lab 距离（不读实现里的数组） */
const origRgb = st.pattern.colors[st.pattern.cells[1]].rgb;
const lab0 = batchK.srgbToLab(origRgb);
const myDist = {};
for (const c of batchPal.colors) if (String(c.code) !== origBatchCode) myDist[c.code] = batchK.deltaE(lab0, batchK.srgbToLab(c.rgb));
const myTop8 = Object.keys(myDist).sort((a, b) => (myDist[a] - myDist[b]) || (String(a) < String(b) ? -1 : 1)).slice(0, 8);
ok('批量 | 每个推荐的 d 都与独立重算的 deltaE 逐值相等（同一把尺子）',
  recsNow.length > 0 && recsNow.every((r) => Math.abs(r.d - myDist[r.code]) < 1e-9),
  JSON.stringify(recsNow.map((r) => [r.code, r.d, myDist[r.code]]).slice(0, 3)));
ok('批量 | 推荐按 Lab 距离升序（单调不减）', recsNow.every((r, i) => i === 0 || recsNow[i - 1].d <= r.d), JSON.stringify(recsNow.map((r) => r.d)));
ok('批量 | 推荐集合 = 独立取「色卡里除原色外最近的 8 个」',
  JSON.stringify(recsNow.map((r) => r.code).slice().sort()) === JSON.stringify(myTop8.slice().sort()),
  JSON.stringify([recsNow.map((r) => r.code), myTop8]));

/* 选推荐色 → 整片改色 + 其余格逐格不变 + 1 步历史 + lockToggle 语义 */
const batchBeforeCodes = Array.from({ length: batchPat.w * batchPat.h }, (_, i) => codeOfCell(st.pattern, i));
const batchRegionIdx = ui.batchRegion();
const batchTarget = recsNow[0].code;
const batchApplied = ui.batchApply(batchTarget);
eq('批量 | 改色格数 = 选区大小', batchApplied, 3);
eq('批量 | 选区整片改成目标色号', batchRegionIdx.map((i) => codeOfCell(st.pattern, i)), [batchTarget, batchTarget, batchTarget]);
const batchOutsideChanged = [];
for (let i = 0; i < batchBeforeCodes.length; i++) {
  if (batchRegionIdx.indexOf(i) >= 0) continue;
  if (codeOfCell(st.pattern, i) !== batchBeforeCodes[i]) batchOutsideChanged.push(i);
}
eq('批量 | 其余格逐格不变（按色号比对，允许 colors 下标平移）', batchOutsideChanged, []);
eq('批量 | 整片改色只占 1 步历史', st.history.length, 1);
eq('批量 | #lockToggle 勾着 → 选区格 locked === 1', batchRegionIdx.map((i) => st.pattern.locked[i]), [1, 1, 1]);
eq('批量 | 改完自动清空选区与推荐（高亮随之消失）', [ui.batchRegion().length, ui.batchRecs(), ui.drawBatchHighlight()], [0, null, false]);
ok('批量 | 收尾提示写出「已批量改色：3 格」', /已批量改色：3 格/.test(String(els.statusText.textContent)), String(els.statusText.textContent));

/* 撤销：批量改色可被撤销 */
eq('批量 | undo() 返回 true', ui.undo(), true);
eq('批量 | undo 后选区格回到原色号', batchRegionIdx.map((i) => codeOfCell(st.pattern, i)), [origBatchCode, origBatchCode, origBatchCode]);

/* 切走工具 → 选区与高亮一起清掉 */
ui.batchSelect(1);
eq('批量 | 重新选定后有选区', ui.batchRegion().length, 3);
ui.setTool('none');
eq('批量 | 切走工具 → 选区清空、推荐清空、高亮消失',
  [ui.batchRegion().length, ui.batchRecs(), ui.drawBatchHighlight()], [0, null, false]);

/* 色板路径同样生效：selectRecolorCode → 立刻整片改 + 进入「最近使用」 */
ui.setTool('batch');
ui.batchSelect(1);
const paletteCode = recsNow[1].code;
ui.selectRecolorCode(paletteCode);
eq('批量 | 用色板/推荐入口选色 → 立刻整片改色', [0, 1, 2].map((i) => codeOfCell(st.pattern, i)), [paletteCode, paletteCode, paletteCode]);
eq('批量 | 选中色进入「最近用过」队首', st.recolor.recent[0], paletteCode);
eq('批量 | 色板路径同样只占 1 步历史', st.history.length, 1);
ui.undo();

/* 20000 格上限：与魔术棒同一口径 */
const hugeBatch = erMkPat(150, 150, () => 2);
hugeBatch.paletteId = batchPal.id;
const hugeOrigCode = codeOfCell(hugeBatch, 0);
st.pattern = hugeBatch;
st.viewOpts = ui.viewOpts();
st.history.length = 0;
ui.setTool('batch');
const hugeSel = ui.batchSelect(0);
eq('批量 | 单次选区上限 = 20000 格（与魔术棒同一常量）', hugeSel, 20000);
eq('批量 | 超限时标记 truncated', !!st.batch.truncated, true);
ok('批量 | 超限时提示说明只处理前 20000 格', /超过单次上限 20000 格/.test(String(els.batchHint.textContent)), String(els.batchHint.textContent));
const hugeApplied = ui.batchApply(recsNow[0].code);
eq('批量 | 超限时也只改 20000 格', hugeApplied, 20000);
/* 批量是「改色」不是「擦除」：格子总数不变（22500），只是 20000 格换成目标色、其余 2500 格仍是原色 */
const hugeAfterCodes = Array.from(hugeBatch.cells).map((c) => (c === EMPTY ? null : String(hugeBatch.colors[c].code)));
eq('批量 | 改成目标色的格子恰好 20000 格', hugeAfterCodes.filter((c) => c === String(recsNow[0].code)).length, 20000);
eq('批量 | 剩下的 2500 格仍是原来的色号（只换色、不擦除，总数仍是 22500）',
  [hugeAfterCodes.filter((c) => c !== null).length, hugeAfterCodes.filter((c) => c === hugeOrigCode).length],
  [22500, 2500]);

/* 四工具互斥：任意时刻只有一个生效 */
const fourTools = [['batchMode', 'batch'], ['recolorMode', 'recolor'], ['toolWand', 'wand'], ['toolEraser', 'eraser'], ['toolNone', 'none']];
const toolExclusiveBad = [];
for (const t of fourTools) {
  els[t[0]].checked = true;
  safeFire(els[t[0]], 'change');
  const checkedCount = ['batchMode', 'recolorMode', 'toolWand', 'toolEraser', 'toolNone'].filter((k) => els[k].checked).length;
  if (ui.tool() !== t[1] || checkedCount !== 1) toolExclusiveBad.push(t[0] + '→' + ui.tool() + '/' + checkedCount);
}
eq('批量 | 四工具（+关闭）逐个切换：每次恰好 1 个生效、状态机一致', toolExclusiveBad, []);
eq('批量 | 高亮没有动 Render 接口（仍是那 4 个键）',
  Object.keys(Render).sort(), ['drawPattern', 'exportCSV', 'exportPNG', 'legendHTML']);

/* ColorKit 缺失：不抛、不编造推荐、提示如实 */
const ckBackup = sandboxWin.ColorKit;
delete sandboxWin.ColorKit;
st.pattern = batchPat;
st.viewOpts = ui.viewOpts();
ui.setTool('batch');
ui.clearBatch();
ok('批量 | ColorKit 缺失 + 未选定时，提示如实说明「色彩模块未加载、给不出推荐、色板仍可用」',
  /色彩模块未加载/.test(String(els.batchHint.textContent)) && /色板/.test(String(els.batchHint.textContent)), String(els.batchHint.textContent));
let ckThrew = '';
let ckSel = 0;
try { ckSel = ui.batchSelect(1); } catch (e) { ckThrew = e.message; }
eq('批量 | ColorKit 缺失时不抛异常', ckThrew, '');
eq('批量 | ColorKit 缺失时选区仍然建立（改色本身不依赖推荐）', ckSel, 3);
eq('批量 | ColorKit 缺失时不编造推荐（batchRecs 为 null）', ui.batchRecs(), null);
eq('批量 | ColorKit 缺失时 recommendColors 返回 null（不是空数组假装成功）', ui.recommendColors([255, 0, 0], 'A1', 8), null);
ok('批量 | ColorKit 缺失 + 已选定：提示不再承诺推荐色，只说用色板选色',
  String(els.batchHint.textContent).indexOf('推荐色号') < 0 && /色板/.test(String(els.batchHint.textContent)), String(els.batchHint.textContent));
sandboxWin.ColorKit = ckBackup;

/* ── 抠图撤销键 #btnEraseUndo：与 #btnUndo 是同一个函数引用 ─────────────── */
const undoHandlers = (els.btnUndo._handlers.click || []);
const eraseUndoHandlers = (els.btnEraseUndo._handlers.click || []);
ok('抠图撤销 | #btnUndo 与 #btnEraseUndo 绑定**同一个函数引用**（不是两份实现）',
  undoHandlers.length === 1 && eraseUndoHandlers.length === 1 && undoHandlers[0] === eraseUndoHandlers[0],
  'undo=' + undoHandlers.length + ' eraseUndo=' + eraseUndoHandlers.length + ' same=' + (undoHandlers[0] === eraseUndoHandlers[0]));
st.pattern = erMkPat(6, 4, () => 0);
st.viewOpts = ui.viewOpts();
st.history.length = 0;
ui.setTool('none');
const eraseUndoBeforeCodes = Array.from({ length: 24 }, (_, i) => codeOfCell(st.pattern, i));
ui.setTool('wand');
ui.wandErase(0);
eq('抠图撤销 | 擦除后两个撤销键都可用（置灰状态同步）', [els.btnUndo.disabled, els.btnEraseUndo.disabled], [false, false]);
eq('抠图撤销 | 擦除后出现 1 步历史', st.history.length, 1);
safeFire(els.btnEraseUndo, 'click');
eq('抠图撤销 | 点 #btnEraseUndo 回退一步（栈清空）', st.history.length, 0);
ok('抠图撤销 | 回退后图纸内容确实还原（与快照逐格比对）',
  JSON.stringify(Array.from({ length: 24 }, (_, i) => codeOfCell(st.pattern, i))) === JSON.stringify(eraseUndoBeforeCodes));
eq('抠图撤销 | 栈空后两个撤销键一起置灰', [els.btnUndo.disabled, els.btnEraseUndo.disabled], [true, true]);
/* 批量改色同样可被它撤销 */
st.pattern = batchPat;
st.viewOpts = ui.viewOpts();
st.history.length = 0;
ui.setTool('batch');
ui.batchSelect(1);
const batchUndoBefore = [0, 1, 2].map((i) => codeOfCell(st.pattern, i));
ui.batchApply(recsNow[0].code);
safeFire(els.btnEraseUndo, 'click');
eq('抠图撤销 | 批量改色也能被 #btnEraseUndo 回退', [0, 1, 2].map((i) => codeOfCell(st.pattern, i)), batchUndoBefore);
ui.setTool('none');

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

/* ══════════════ 裁剪模式门控（本轮用户报的「手机上没法滚页面」）══════════════
   实现口径：常态不吃手势（页面可滚），只有「裁剪模式」开着才把 touch-action 设成 none
   并且对 pointerType === 'touch' 的 pointerdown 调 preventDefault；鼠标 / 触控笔不受门控。 */
const cropWorld = makeEditWorld(400);
const cropApi = cropWorld.win.SourceEdit.mount(cropWorld.canvas, {});
eq('裁剪门控 | mount 后 setCropMode 存在且是函数', typeof cropApi.setCropMode, 'function');
eq('裁剪门控 | 挂载后（裁剪默认关）画布 touch-action 不是 none（页面可滚）',
  cropWorld.canvas.style.touchAction === 'none', false);
eq('裁剪门控 | setCropMode(true) → 返回 true 且写入 none',
  [cropApi.setCropMode(true), cropWorld.canvas.style.touchAction], [true, 'none']);
eq('裁剪门控 | setCropMode(false) → 恢复可滚动（不再是 none）',
  [cropApi.setCropMode(false), cropWorld.canvas.style.touchAction === 'none'], [true, false]);
cropApi.setCropMode(true);
cropApi.destroy();
eq('裁剪门控 | destroy() 不残留 touch-action:none', cropWorld.canvas.style.touchAction === 'none', false);

/* 触摸真行为：关着不拦手势、开着才拦并起框；鼠标不受门控 */
const touchWorld = makeEditWorld(400);
const touchApi = touchWorld.win.SourceEdit.mount(touchWorld.canvas, {});
touchApi.setSource({ naturalWidth: 200, naturalHeight: 100 });
const pdEvent = (x, y, pointerType) => {
  const rec = { prevented: 0 };
  const evt = {
    type: 'pointerdown', button: 0, pointerId: 1, pointerType: pointerType, clientX: x, clientY: y,
    target: touchWorld.canvas, currentTarget: touchWorld.canvas,
    preventDefault() { rec.prevented++; }, stopPropagation() {}
  };
  return { evt: evt, rec: rec };
};
const moveEvent = (x, y, pointerType) => ({
  type: 'pointermove', button: 0, pointerId: 1, pointerType: pointerType, clientX: x, clientY: y,
  target: touchWorld.win, currentTarget: touchWorld.win, preventDefault() {}, stopPropagation() {}
});
const upEvent = (x, y, pointerType) => ({
  type: 'pointerup', button: 0, pointerId: 1, pointerType: pointerType, clientX: x, clientY: y,
  target: touchWorld.win, currentTarget: touchWorld.win, preventDefault() {}, stopPropagation() {}
});
touchApi.setCropMode(false);
const pdOff = pdEvent(100, 50, 'touch');
touchWorld.canvas.dispatchEvent(pdOff.evt);
eq('裁剪门控 | 裁剪关 + 触摸 pointerdown → 不调 preventDefault（把手势留给页面滚动）', pdOff.rec.prevented, 0);
touchWorld.win.dispatchEvent(moveEvent(160, 80, 'touch'));
touchWorld.win.dispatchEvent(upEvent(160, 80, 'touch'));
eq('裁剪门控 | 裁剪关 + 触摸拖拽 → 不起框（crop 仍为 null）', touchApi.getState().crop, null);
touchApi.setCropMode(true);
const pdOn = pdEvent(100, 50, 'touch');
touchWorld.canvas.dispatchEvent(pdOn.evt);
eq('裁剪门控 | 裁剪开 + 触摸 pointerdown → 调 preventDefault（吃掉滚动手势）', pdOn.rec.prevented, 1);
touchWorld.win.dispatchEvent(moveEvent(160, 80, 'touch'));
touchWorld.win.dispatchEvent(upEvent(160, 80, 'touch'));
ok('裁剪门控 | 裁剪开 + 触摸拖拽 → 框选真的生效（crop 非 null）',
  !!touchApi.getState().crop, JSON.stringify(touchApi.getState().crop));
touchApi.setCropMode(false);
const pdMouse = pdEvent(100, 50, 'mouse');
touchWorld.canvas.dispatchEvent(pdMouse.evt);
eq('裁剪门控 | 裁剪关 + 鼠标 pointerdown → 仍然 preventDefault（鼠标 / 触控笔不受门控）', pdMouse.rec.prevented, 1);
touchWorld.win.dispatchEvent(upEvent(160, 80, 'mouse'));
touchApi.setCropMode(false);
const pdPen = pdEvent(100, 50, 'pen');
touchWorld.canvas.dispatchEvent(pdPen.evt);
eq('裁剪门控 | 裁剪关 + 触控笔 pointerdown → 同样不受门控', pdPen.rec.prevented, 1);
touchWorld.win.dispatchEvent(upEvent(160, 80, 'pen'));

/* app.js 侧：宿主是旧版 SourceEdit（没有 setCropMode）时也必须不抛 */
const legacyInst = mkInstance({
  SourceEdit: {
    mount: function () {
      return {
        setSource: function () { return true; }, getResultCanvas: function () { return null; },
        getState: function () { return { crop: null }; }, rotate: function () {}, flip: function () {},
        setAspect: function () {}, reset: function () {}, hasTransform: function () { return false; }
      };
    }
  }
});
if (legacyInst.api && legacyInst.api.boot) legacyInst.api.boot();
const legacyEls = legacyInst.api.elements();
ok('裁剪门控 | 旧版 SourceEdit（无 setCropMode）也能挂载', typeof legacyInst.api.elements === 'function' && !!legacyEls.srcCropMode);
let legacyThrew = '';
legacyEls.srcCropMode.checked = true;
try { safeFire(legacyEls.srcCropMode, 'change'); } catch (e) { legacyThrew = e.message; }
eq('裁剪门控 | 宿主没有 setCropMode 时 app.js 不抛异常（旧版 SourceEdit 兼容）', legacyThrew, '');
eq('裁剪门控 | 宿主没有 setCropMode 时 app.js 自己的裁剪状态仍然正确记录', legacyInst.api.state().srcCropMode, true);

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
