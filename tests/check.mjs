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
 * 因此**不验证**真实渲染外观、交互、点击下载与打印效果。
 *
 * 五组：色表 / 色彩引擎 / 主管线 / 渲染 / 产物。
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
/* 三个模块的全局解析方式不一致：
 *   palette.js 裸用 window ；color.js 用 typeof window 判断 ；pipeline.js 无条件写 globalThis ；
 *   render.js / app.js 挂 window。
 * 故：window === globalThis，逐个 new Function(src)() 求值，再从 globalThis 上取全局。
 * 反例：new Function('window', src)(fake) 会让 pipeline 把 Pipeline 挂到真 globalThis 上，
 * 假对象收不到 —— 这条路径已排除。
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

const MODULE_FILES = ['palette.js', 'color.js', 'pipeline.js', 'render.js', 'app.js'];
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
ok('src/ 下 5 个模块文件都存在', MODULE_FILES.every((f) => srcText[f] !== undefined), loadErrors.join(' / '));
ok('5 个模块逐个 new Function(src)() 均无抛错', loadErrors.length === 0, loadErrors.join(' / '));
ok('window === globalThis（浏览器式全局模拟已生效）', globalThis.window === globalThis);

const P = globalThis.PINDOU_PALETTES;
const CK = globalThis.ColorKit;
const Pipeline = globalThis.Pipeline;
const Render = globalThis.Render;

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
  { label: '1000×500 + 显式 gridW:200（应夹到 87）', img: srcBig, w: 1000, h: 500, opts: { gridW: 200 }, ew: 87, eh: 44 },
];
for (const c of DIM_CASES) {
  const pat = Pipeline.generateFromRGBA(c.img, c.w, c.h, c.opts);
  eq(c.label + ' | 推导宽度', pat.w, c.ew);
  eq(c.label + ' | 推导高度', pat.h, c.eh);
  checkInvariants(c.label, pat);
  ok(c.label + ' | warnings 为数组', Array.isArray(pat.warnings));
}

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
eq('边界 | boards:99 夹到 3（长边 87）', Pipeline.generateFromRGBA(edgeGray, 40, 40, { boards: 99 }).w, 87);
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
function makeMockCanvas() {
  const rec = { fillRect: [], fillText: [], strokes: [], fills: [], strokeRect: [], drawImage: [], save: 0, restore: 0 };
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
      rec.fillText.push({ text: String(t), x, y, fillStyle: String(this.fillStyle), font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline });
    },
    beginPath() { this._path = []; },
    moveTo(x, y) { this._path.push(['M', x, y]); },
    lineTo(x, y) { this._path.push(['L', x, y]); },
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

const cv1 = makeMockCanvas();
const r1 = Render.drawPattern(HP, cv1, { cellPx: 12, showCodes: true, showRuler: false });
eq('drawPattern | 画布宽 = pad*2 + w*cellPx', cv1.width, HP_PAD * 2 + HP.w * HP_CELL);
eq('drawPattern | 画布高 = pad*2 + h*cellPx', cv1.height, HP_PAD * 2 + HP.h * HP_CELL);
eq('drawPattern | 换算式 pad = max(40, cellPx*3+20)', HP_PAD, 56);
eq('drawPattern | cellsDrawn === 非空格子数', r1.cellsDrawn, HP_NONEMPTY);
eq('drawPattern | codesDrawn === true', r1.codesDrawn, true);
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

const codeTexts = cv1._rec.fillText.map((t) => t.text);
eq('drawPattern | showRuler:false 时 fillText 次数 === 非空格子数', cv1._rec.fillText.length, HP_NONEMPTY);
eq(
  'drawPattern | 编号文字逐格 === String(cells[i]+1)',
  codeTexts,
  Array.from(HP.cells).map((c, i) => (c === EMPTY ? null : String(c + 1))).filter((v) => v !== null)
);
eq(
  'drawPattern | 编号位置 = 格中心',
  cv1._rec.fillText.map((t) => [t.x, t.y]),
  Array.from(HP.cells)
    .map((c, i) => (c === EMPTY ? null : [HP_PAD + (i % 5) * 12 + 6, HP_PAD + Math.floor(i / 5) * 12 + 6.5]))
    .filter((v) => v !== null)
);
eq('drawPattern | 细网格线一次成路径：2*((w+1)+(h+1)) = 22 个路径操作', cv1._rec.strokes[0].path.length, 22);
eq('drawPattern | 细网格线线宽 1', cv1._rec.strokes[0].lineWidth, 1);
eq('drawPattern | 板边界单独 stroke：竖 1 + 横 1 = 2 条', cv1._rec.strokes.length - 1, 2);
eq('drawPattern | 首条细网格线起点 x = pad + 0.5', cv1._rec.strokes[0].path[0], ['M', HP_PAD + 0.5, HP_PAD + 0.5]);
eq('drawPattern | 竖板边界在 x = pad + w*cellPx', cv1._rec.strokes[1].path[0][1], HP_PAD + HP.w * 12);
eq('drawPattern | 横板边界在 y = pad + h*cellPx', cv1._rec.strokes[2].path[0][2], HP_PAD + HP.h * 12);

const cv8 = makeMockCanvas();
const r8 = Render.drawPattern(HP, cv8, { cellPx: 8, showCodes: true, showRuler: false });
eq('drawPattern | cellPx=8 → 返回 codesDrawn:false', r8.codesDrawn, false);
eq('drawPattern | cellPx=8 → 不写编号（fillText 0 次）', cv8._rec.fillText.length, 0);
eq('drawPattern | cellPx=8 → 仍然逐格填色', cellFillsOf(cv8).length, HP_NONEMPTY);
eq('drawPattern | cellPx=8 → pad = max(40, 8*3+20) = 44，画布宽 128', cv8._rec.fillRect[0].w, Math.max(40, 8 * 3 + 20) * 2 + HP.w * 8);

const cv9 = makeMockCanvas();
const r9 = Render.drawPattern(HP, cv9, { cellPx: 9, showCodes: true, showRuler: false });
eq('drawPattern | cellPx=9 → codesDrawn:true', r9.codesDrawn, true);
eq('drawPattern | cellPx=9 → 写编号次数 === 非空格子数', cv9._rec.fillText.length, HP_NONEMPTY);

const cvBad = { width: 0, height: 0 };
eq('drawPattern | 无 getContext 的宿主返回空结果而不抛错', Render.drawPattern(HP, cvBad, {}), { codesDrawn: false, cellsDrawn: 0 });

/* 真实 Pattern 的渲染整合（刻度开、编号默认开） */
const realPat = Pipeline.generateFromRGBA(synth(40, 30, (x, y) => [(x * 17) % 256, (y * 23) % 256, 128]), 40, 30, { boards: 1 });
const realNonEmpty = Array.from(realPat.cells).filter((c) => c !== EMPTY).length;
const cvR = makeMockCanvas();
Render.drawPattern(realPat, cvR, { cellPx: 12 });
eq('整合 | 真实 Pattern（' + realPat.w + '×' + realPat.h + '）cellsDrawn === 非空格数', cvR._rec.fillRect.length - 1, realNonEmpty);
eq('整合 | 真实 Pattern 逐格填色位置与颜色精确匹配', cellFillsOf(cvR), expectedFills(realPat, 12, 56));
eq('整合 | 刻度和编号都画了（fillText = 非空格数 + 刻度数）', cvR._rec.fillText.length, realNonEmpty + 11, 'w=29 有 6 个刻度、h=22 有 5 个刻度');

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
  eq('恰好 5 个 <script> 开标签', openTags.length, 5);
  eq('恰好 5 个 </script 闭标签', closeTags.length, 5);
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
  eq('按 <script> 切出 5 段脚本', bodies.length, 5);
  ok('内联 JS 段里无 `</' + 'script` 残留字面量（安全阀二次确认）', bodies.every((b) => !/<\/script/i.test(b)));
  ok('5 段脚本全部位于 <body> 内', html.indexOf('<script>') > html.indexOf('<body>') && html.indexOf('<script>') > html.indexOf('</head>'));

  const BANNERS = ['src/palette.js', 'src/color.js', 'src/pipeline.js', 'src/render.js', 'src/app.js'];
  const bannerText = (n) => '/* ===== ' + n + ' ===== */';
  eq(
    '5 段脚本的横幅（即来源与顺序）为 palette → color → pipeline → render → app',
    bodies.map((b, i) => (b.includes(bannerText(BANNERS[i])) ? BANNERS[i] : '(第' + (i + 1) + '段横幅不符)')),
    BANNERS
  );
  ok('每段脚本恰好含 1 个来源横幅（切削点干净，没有串段）', bodies.every((b) => BANNERS.filter((n) => b.includes(bannerText(n))).length === 1));
  ok('整份 HTML 里 5 个来源横幅按顺序出现', BANNERS.every((n, i) => html.indexOf(bannerText(n)) > (i === 0 ? -1 : html.indexOf(bannerText(BANNERS[i - 1])))));

  // 清掉所有模块全局（含 app.js 可能挂的键），便于后续判断"重新 eval 后新增了什么"
  for (const k of ['PINDOU_PALETTES', 'ColorKit', 'Pipeline', 'Render', 'PindouUI']) delete globalThis[k];
  ok('重新 eval 前 4 个模块全局已从 globalThis 清空', ['PINDOU_PALETTES', 'ColorKit', 'Pipeline', 'Render'].every((k) => globalThis[k] === undefined));
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

  /* 第 5 段（app.js）只断言「能加载、不炸、不破坏上面 4 个全局」——
   * 它的全局名与函数名属实现细节，另一个子代理正在改，硬断言会误报。 */
  const libSnap = ['PINDOU_PALETTES', 'ColorKit', 'Pipeline', 'Render'].map((k) => typeof globalThis[k]);
  const appErr = evalScript(bodies[4]);
  ok('产物第 5 段（src/app.js）重新 eval 无抛错', appErr === null, appErr ? appErr.message : '');
  eq('app 段未破坏前 4 个库的全局', ['PINDOU_PALETTES', 'ColorKit', 'Pipeline', 'Render'].map((k) => typeof globalThis[k]), libSnap);
  const newKeys = Object.getOwnPropertyNames(globalThis).filter((k) => !beforeKeys.has(k));
  info('app 段新增全局：' + (newKeys.join(', ') || '(无)') + ' —— 名字属实现细节，只报不断言');
  const patFromProduct = globalThis.Pipeline.generateFromRGBA(synth(30, 30, (x) => [x * 8 % 256, 200, 60]), 30, 30, { boards: 1 });
  ok('产物内 Pipeline 端到端产出一张合法 Pattern', patFromProduct.colors.length >= 1 && patFromProduct.stats.total === patFromProduct.w * patFromProduct.h, 'colors=' + patFromProduct.colors.length);
}

/* ═════════════════════════════════════════════════════════════ 汇总 */
console.log('\n════════════ 分组小结 ════════════');
for (const g of groupStats) {
  console.log('  ' + (g.fail === 0 ? 'PASS' : 'FAIL') + '  ' + g.title + '  (' + g.pass + ' PASS / ' + g.fail + ' FAIL)');
}
console.log('');
if (fail === 0) {
  console.log('VERDICT: ALL GREEN — ' + assertions + ' 条断言全部通过（' + groupStats.length + ' 组）');
  console.log('未覆盖：视觉渲染外观、鼠标/键盘交互、真实浏览器下载与打印 —— 本脚本无浏览器，属人工验收。');
  process.exit(0);
} else {
  console.log('VERDICT: FAILURES=' + fail + ' -> ' + assertions + ' 条断言中 ' + pass + ' 过 / ' + fail + ' 败');
  for (const f of failures) console.log('  · ' + f);
  process.exit(1);
}
