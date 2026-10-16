/**
 * Pipeline —— 拼豆图纸生成管线（零依赖、核心为纯函数、无模块语法）
 * 挂载点：window.Pipeline
 * 依赖（同页全局，均已冻结）：window.PINDOU_PALETTES（src/palette.js）、window.ColorKit（src/color.js）
 *
 * 对外契约：
 *   Pipeline.generateFromRGBA(rgba, srcW, srcH, opts) -> Pattern   // 纯函数，无 DOM，Node 可测
 *   Pipeline.generate(imageLike, opts) -> Pattern                  // DOM 包装（img/canvas/ImageBitmap/ImageData）
 *   Pipeline.DEFAULT_OPTS
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 【核心决策 1】降采样在【线性光空间】做区域平均，不是 sRGB 空间。理由原文：
 * ───────────────────────────────────────────────────────────────────────────────
 * 1) 物理正确性（主要依据）：一格拼豆在远处看是「一片面积混合后的光」。人眼与相机对
 *    光量的积分是线性的，而 sRGB 只是显示器的非线性编码。在 sRGB 数值上直接求平均，
 *    得到的既不是该区域的平均光量，也不是平均感知亮度。实测（本文件自测用例「黑白棋盘」）：
 *      等量黑白像素降采样到 1 格 —— 线性光平均 = #BCBCBC（188，约 50% 光量）；
 *      sRGB 空间平均 = #808080（128，只对应约 21% 光量）。
 *    也就是说 sRGB 平均会把高对比细节（细线、纹理、边缘）系统性地压暗发灰，而这正是
 *    降采样最典型的伪影；拼豆图纸上表现为「白底黑线上的细线变成一片脏灰」。
 * 2) 与下游一致：ColorKit 的 Lab 内部先把 sRGB 线性化再算 L/a/b，匹配与抖动都在
 *    「线性光导出的量」上工作。若在上游用 sRGB 平均、下游再线性化，同一份数据被非线性
 *    混合两次，Lab 的 L 不再等价于「这格反射多少光」，抖动强度的量纲也随之失真。
 *    在线性光上平均后，降采样 → 预处理 → 匹配 → 抖动的「光量」语义全程一致。
 * 3) 抖动均值保真：FS/Bayer 保的是区域均值。线性光基底上抖动，区域平均光量与源区域一致；
 *    sRGB 基底上抖动保的是均值编码值，展开成光量后整体偏暗。
 * 已知代价（接受）：高细节区域的成品会比「浏览器缩略图」的观感略亮一点。这是正确方向；
 *    用户仍可用 brightness / contrast 自行补偿。
 *
 * 【与 app.js 的锁定约定】
 * app.js 通过 opts.prevPattern 把上一张 Pattern 传进来（已对接，见其 doGenerate），
 * 锁定语义由本模块独家负责：锁定色号即使被减色丢掉也会并入 colors、colors 按自然序重排、
 * cells 下标全量重映射，并继承 locked 标记；尺寸与上一张不一致时忽略锁定并把原因写进 warnings。
 * 约定外的 opts.locks / keepLocks 本模块一律忽略，不做任何处理。
 *
 * 【锁定语义：两类，且优先级固定】上一张图里 locked[i] 为真的格子分两类，都按原样保留：
 *   ① 锁定为空——snapshotLockedEmpty(i) 为真：上一张 cells[i] === 65535（空格）。
 *      本次必须仍为 65535，且 locked[i] === 1。「抠图」（擦掉背景/多余格）依赖这一类：
 *      擦掉的格子在改参数重新生成后必须仍然是空的，否则抠图结果会被重新填色。
 *   ② 锁定色号——snapshotLockedCode(i) 返回色号：上一张 cells[i] 是有效色号下标。
 *      本次仍为该色号，即使它被减色量化掉（见下方「锁定色号即使被减色丢掉也会并入 colors」）。
 * 两类互斥（cells[i] === 65535 不是任何颜色的下标），但判定顺序仍然显式固定为
 *   ① 锁定为空 > ② 锁定色号 > ③ 新图算出空格 > ④ 新图算出色号（命中即停，前者覆盖后者）。
 * 实现位置：扫描见 buildPattern「锁定格」段，落格见其「全量重映射」段的注释。
 *
 * 【核心决策 2】编号与排序规则（冻结，最易崩的地方）
 * Pattern.colors 恒按「色号自然序」排列：组序固定 A,B,C,D,E,F,G,H,M，组内按数字升序
 *   （A9 在 A10 之前）。不是按颗数排、不是按首次出现顺序排。
 * cells[i] 是 colors 的下标；图纸上的编号 = cells[i] + 1。编号因此与「参数怎么调」无关，
 * 用户微调参数后重新生成的图纸可以逐格对照。
 * counts 是另一个数组，按颗数降序，colors.length === counts.length（保证每个色号都有用量）。
 *
 * 【核心决策 3】管线的固定顺序
 *   RGBA → 区域平均降采样(线性光) → alpha 判定空格 → 预处理 → 减色(可选) → 抖动/最近邻 → 统计 → Pattern
 * 减色必须在抖动之前：quantize 的角色是「先把调色板收窄」，像素本身不被替换；随后抖动/
 * 最近邻都跑在收窄后的调色板上，因此 Pattern.colors ⊆ 减色子集。若先抖动再减色，
 * 抖动辛苦铺开的中间色会被减色抹掉，两种方法的对比也就失去意义。
 *
 * 【预处理固定顺序】autoWB → autoLevels → brightness → contrast → saturation
 *   autoWB     灰度世界假设：整图（非空格）通道均值缩放到中性灰。
 *   autoLevels 直方图拉伸，每通道各裁 0.5% 分位抗噪点。
 *   brightness v += b*2.55                （b ∈ [-100,100]，0 = 不变）
 *   contrast   v = (v-128)*f + 128，f = 259*(C+255)/(255*(259-C))，C = c*2.55
 *   saturation v = gray + (v-gray)*(1+s/100)，gray = 0.299r+0.587g+0.114b
 *   全部为确定性点运算，无随机、无时间依赖；每步后夹紧到 [0,255]。
 *
 * 【空格与占位约定】
 *   alpha < 128 的源像素视为透明，不参与区域平均（避免透明黑边把颜色拉暗）。
 *   整格全透明 → cells[i] = 65535，不计入 counts / stats.total，也不占用 colors 的色号。
 *   抖动阶段 ColorKit 只接受稠密栅格，故空格先用「行主序前一个非空格的颜色」占位，
 *   抖动结束后再按空格标记写回 65535；占位色与邻域色差很小，对误差扩散的影响可忽略。
 *   若整图没有任何非空像素，直接返回全空图纸（不构造 matcher）。
 *
 * 【自测实测值（Node，见任务回报）】
 *   黑白棋盘降采样到 1 格 → #BCBCBC（线性光空间，符合本决策 1）。
 * ═══════════════════════════════════════════════════════════════════════════════
 */
;(function (root) {
  'use strict';

  var BEAD_MM = 2.6;            // 单颗拼豆外径（毫米）
  var BOARD_CELLS = 29;         // 一块板 29×29 格
  var MAX_DIM = 116;            // 4 板 = 116 格（与 ui.html 的 max="116" / 4×4 板档一致）
  var EMPTY = 65535;            // cells 里的空格标记
  var ALPHA_MIN = 128;          // alpha < 128 视为透明
  var MAX_SRC_PIXELS = 1200 * 1200;  // generate() 读取源图的像素上限（防止把 4000×3000 全量读进来）
  var GROUP_ORDER = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'M'];
  var DEFAULT_PALETTE_ID = 'mard-221-getcolors';

  /**
   * 默认参数：与 src/ui.html 的默认控件值保持一致（否则「不传 opts」与「用界面默认值」
   * 会得到两张不同的图纸，用户会认为有 bug）。逐项理由：
   *   method 'nearest'      忠实、快、色块最干净，便于用户先看清原图结构再切 FS/Bayer 对比。
   *   bayerN 4              UI 默认 4×4；4×4 在小格数（29×29）下纹理比 8×8 更细。
   *   ditherStrength 0.3    UI 滑杆默认 30%；全强度(1)在拼豆这种「色块即成品」的载体上
   *                         会把边缘打散成杂色，0.3 是稳妥起点。
   *   quantize.enabled true 默认必须「拼得完」：随机噪声图用最近邻会命中 172/221 个色号，
   *                         真实照片也常上百色，而没有人手上有 172 种拼豆。默认开减色。
   *   quantize.maxColors 24 一板 29×29 = 841 颗；常用拼豆作品通常 10–25 色，24 落在
   *                         「表现力够 + 买得到豆」的甜点上：116×116 满配时每色平均仍有
   *                         ~560 颗，足以表现渐变；同时与 UI 的 maxColors 默认值一致。
   *   paletteId             默认主谱系 mard-221-getcolors（palette.js 的第一个 key）。
   *   gridW/gridH null      未给时按 boards + 原图宽高比推导；给出则优先并夹到 [1,116]。
   *   boards 1              一板起步，最省豆。
   * 说明：opts 里出现约定外的附加字段（如 app.js 的 keepLocks / locks）一律忽略，不报错。
   */
  var DEFAULT_OPTS = {
    gridW: null,
    gridH: null,
    boards: 1,
    lockAspect: true,
    paletteId: DEFAULT_PALETTE_ID,
    preprocess: { brightness: 0, contrast: 0, saturation: 0, autoWB: false, autoLevels: false },
    method: 'nearest',
    bayerN: 4,
    ditherStrength: 0.3,
    quantize: { enabled: true, maxColors: 24 },
    prevPattern: null
  };

  /* ------------------------------------------------------------------ 小工具 */

  function isFin(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity; }

  function num(v, d) { return isFin(v) ? v : d; }

  function numOrNull(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && v.trim() !== '') { var p = parseFloat(v); return isFin(p) ? p : null; }
    return isFin(v) ? v : null;
  }

  function clampInt(v, lo, hi) {
    var n = Math.round(v);
    if (!isFin(n)) return lo;
    return n < lo ? lo : (n > hi ? hi : n);
  }

  function clampNum(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function byte(v) {
    var n = Math.round(isFin(v) ? v : 0);
    return n < 0 ? 0 : (n > 255 ? 255 : n);
  }

  function round2(v) { return Math.round(v * 100) / 100; }

  /* -------------------------------------------------- 色号自然序（冻结规则） */

  function groupRank(group) {
    var s = (group === null || group === undefined) ? '' : String(group).toUpperCase();
    var k = GROUP_ORDER.indexOf(s);
    return k >= 0 ? k : GROUP_ORDER.length + 1;   // 未知组排在 A..M 之后
  }

  function codeNumber(code) {
    var m = /(\d+)/.exec(String(code));
    return m ? parseInt(m[1], 10) : -1;
  }

  /** 自然序比较：组序 A,B,C,D,E,F,G,H,M → 组内数字升序 → 同号按字符串兜底。 */
  function compareCodes(a, b) {
    var ra = groupRank(a.group), rb = groupRank(b.group);
    if (ra !== rb) return ra - rb;
    if (ra > GROUP_ORDER.length) {
      var ga = String(a.group).toUpperCase(), gb = String(b.group).toUpperCase();
      if (ga !== gb) return ga < gb ? -1 : 1;
    }
    var na = codeNumber(a.code), nb = codeNumber(b.code);
    if (na !== nb) return na - nb;
    var ca = String(a.code), cb = String(b.code);
    return ca < cb ? -1 : (ca > cb ? 1 : 0);
  }

  /* --------------------------------------------------------------- 线性光 */

  function srgbToLinear01(v) {           // v ∈ [0,1]
    if (!(v > 0)) return 0;
    if (v >= 1) return 1;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function linearToSrgb255(l) {          // 线性光 → sRGB 0–255（浮点，不取整）
    if (!(l > 0)) return 0;
    if (l >= 1) return 255;
    var v = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
    return v * 255;
  }

  // 字节 → 线性光 查表，热循环不重复调用 Math.pow
  var BYTE_TO_LIN = new Float64Array(256);
  (function () {
    for (var i = 0; i < 256; i++) BYTE_TO_LIN[i] = srgbToLinear01(i / 255);
  })();

  /* ------------------------------------------------------------------ 色表 */

  function resolvePalette(paletteId, warnings) {
    var all = root.PINDOU_PALETTES;
    if (!all) throw new Error('Pipeline: 未找到全局色表 window.PINDOU_PALETTES（请先加载 src/palette.js）');
    var key = (typeof paletteId === 'string' && paletteId) ? paletteId : DEFAULT_PALETTE_ID;
    var entry = all[key];
    if (!entry || !entry.colors || !entry.colors.length) {
      var keys = Object.keys(all), fb = null;
      for (var i = 0; i < keys.length; i++) {
        var e = all[keys[i]];
        if (e && e.colors && e.colors.length) { fb = keys[i]; break; }
      }
      if (!fb) throw new Error('Pipeline: 色表数据为空');
      warnings.push('色表 "' + key + '" 不存在，已回退到 "' + fb + '"');
      key = fb; entry = all[fb];
    }
    var CK = root.ColorKit;
    var src = entry.colors, colors = new Array(src.length);
    for (var j = 0; j < src.length; j++) {
      var c = src[j] || {};
      var rgb = null;
      if (c.rgb && typeof c.rgb.length === 'number' && c.rgb.length >= 3) {
        rgb = [byte(c.rgb[0]), byte(c.rgb[1]), byte(c.rgb[2])];
      } else if (typeof c.hex === 'string' && CK && CK.hexToRgb) {
        rgb = CK.hexToRgb(c.hex);
      }
      if (!rgb) rgb = [0, 0, 0];
      var hex = (typeof c.hex === 'string' && c.hex) ? c.hex : ((CK && CK.rgbToHex) ? CK.rgbToHex(rgb) : '#000000');
      colors[j] = {
        code: c.code === undefined ? String(j) : String(c.code),
        hex: hex,
        rgb: rgb,
        group: c.group === undefined ? '' : String(c.group)
      };
    }
    return { id: key, colors: colors };
  }

  /* -------------------------------------------------------------- 参数解读 */

  /** 只读解析，绝不修改传入的 opts。 */
  function readOpts(opts) {
    var o = (opts && typeof opts === 'object') ? opts : {};
    var q = (o.quantize && typeof o.quantize === 'object') ? o.quantize : {};
    var pp = (o.preprocess && typeof o.preprocess === 'object') ? o.preprocess : {};
    var method = (o.method === 'fs' || o.method === 'bayer' || o.method === 'nearest') ? o.method : DEFAULT_OPTS.method;
    return {
      gridW: numOrNull(o.gridW),
      gridH: numOrNull(o.gridH),
      boards: clampInt(num(o.boards, DEFAULT_OPTS.boards), 1, 3),
      lockAspect: o.lockAspect === undefined ? DEFAULT_OPTS.lockAspect : !!o.lockAspect,
      paletteId: typeof o.paletteId === 'string' ? o.paletteId : '',
      method: method,
      methodGiven: o.method,
      bayerN: clampInt(num(o.bayerN, DEFAULT_OPTS.bayerN), 4, 8) === 8 ? 8 : 4,
      ditherStrength: clampNum(num(o.ditherStrength, DEFAULT_OPTS.ditherStrength), 0, 1),
      preprocess: {
        brightness: clampNum(num(pp.brightness, 0), -100, 100),
        contrast: clampNum(num(pp.contrast, 0), -100, 100),
        saturation: clampNum(num(pp.saturation, 0), -100, 100),
        autoWB: !!pp.autoWB,
        autoLevels: !!pp.autoLevels
      },
      quantize: {
        enabled: q.enabled === undefined ? DEFAULT_OPTS.quantize.enabled : !!q.enabled,
        maxColors: clampInt(num(q.maxColors, DEFAULT_OPTS.quantize.maxColors), 1, 221)
      },
      prevPattern: (o.prevPattern && typeof o.prevPattern === 'object') ? o.prevPattern : null
    };
  }

  /**
   * 尺寸推导。长边上限 = 29 * boards（29/58/87；boards 自身夹在 1..3），单边硬上限 MAX_DIM = 116。
   * - gridW/gridH 都未给：长边取上限，短边按原图宽高比推导后夹到 [1,116]（极端比例不强行方形）。
   * - 只给一边：另一边按 lockAspect 推导（true = 按原图比例；false = 取与已给一边相同的格数）。
   * - 两边都给：优先采用，各自夹到 [1,116]（是否等比拉伸由调用方决定，管线不擅自改用户输入）。
   */
  function deriveDims(sw, sh, o, warnings) {
    var w = o.gridW, h = o.gridH;
    var aspect = sw / sh;                    // 宽/高，恒 > 0
    if (w === null && h === null) {
      var lim = BOARD_CELLS * o.boards;      // 29 / 58 / 87
      if (aspect >= 1) { w = lim; h = clampInt(Math.round(lim / aspect), 1, MAX_DIM); }
      else { h = lim; w = clampInt(Math.round(lim * aspect), 1, MAX_DIM); }
    } else if (w === null) {
      h = clampInt(h, 1, MAX_DIM);
      w = o.lockAspect ? clampInt(Math.round(h * aspect), 1, MAX_DIM) : h;
    } else if (h === null) {
      w = clampInt(w, 1, MAX_DIM);
      h = o.lockAspect ? clampInt(Math.round(w / aspect), 1, MAX_DIM) : w;
    } else {
      var cw = clampInt(w, 1, MAX_DIM), ch = clampInt(h, 1, MAX_DIM);
      if (cw !== Math.round(w) || ch !== Math.round(h)) {
        warnings.push('gridW/gridH 已夹到合法范围 [1,' + MAX_DIM + ']：' + w + '×' + h + ' → ' + cw + '×' + ch);
      }
      w = cw; h = ch;
    }
    return { w: w, h: h };
  }

  /* ------------------------------------------------------- 区域平均降采样 */

  /** 归一化成 RGBA 字节。非 Uint8 输入按 ToUint8Clamp 规则转（确定性）。 */
  function toBytes(rgba, need) {
    if (rgba instanceof Uint8Array) return rgba;                       // 覆盖 Uint8ClampedArray
    var out = new Uint8ClampedArray(rgba.length);
    out.set(rgba);
    return out;
  }

  /**
   * box filter 降采样：每个目标格覆盖源图一块整数对齐的区域，逐像素在线性光空间累加，
   * 再转回 sRGB 浮点。alpha < 128 的像素直接跳过（不计入平均、不拉暗颜色）。
   * 全透明格 → empty[i] = 1，rgb 留 0。
   */
  function downsample(rgba, sw, sh, gw, gh) {
    var rgb = new Float64Array(gw * gh * 3);
    var empty = new Uint8Array(gw * gh);
    for (var gy = 0; gy < gh; gy++) {
      var y0 = Math.floor(gy * sh / gh), y1 = Math.floor((gy + 1) * sh / gh);
      if (y1 <= y0) y1 = y0 + 1;
      if (y1 > sh) y1 = sh;
      for (var gx = 0; gx < gw; gx++) {
        var x0 = Math.floor(gx * sw / gw), x1 = Math.floor((gx + 1) * sw / gw);
        if (x1 <= x0) x1 = x0 + 1;
        if (x1 > sw) x1 = sw;
        var sR = 0, sG = 0, sB = 0, n = 0;
        for (var sy = y0; sy < y1; sy++) {
          var rowBase = sy * sw;
          for (var sx = x0; sx < x1; sx++) {
            var p = (rowBase + sx) * 4;
            if (rgba[p + 3] < ALPHA_MIN) continue;
            sR += BYTE_TO_LIN[rgba[p]];
            sG += BYTE_TO_LIN[rgba[p + 1]];
            sB += BYTE_TO_LIN[rgba[p + 2]];
            n++;
          }
        }
        var gi = gy * gw + gx;
        if (n === 0) { empty[gi] = 1; continue; }
        var q = gi * 3;
        rgb[q] = linearToSrgb255(sR / n);
        rgb[q + 1] = linearToSrgb255(sG / n);
        rgb[q + 2] = linearToSrgb255(sB / n);
      }
    }
    return { rgb: rgb, empty: empty };
  }

  /* -------------------------------------------------------------- 预处理 */

  function emptyCount(empty) {
    var n = 0;
    for (var i = 0; i < empty.length; i++) if (!empty[i]) n++;
    return n;
  }

  function grayWorld(rgb, empty) {
    var mR = 0, mG = 0, mB = 0, n = 0;
    for (var i = 0; i < empty.length; i++) {
      if (empty[i]) continue;
      var q = i * 3;
      mR += rgb[q]; mG += rgb[q + 1]; mB += rgb[q + 2]; n++;
    }
    if (n === 0) return;
    mR /= n; mG /= n; mB /= n;
    var mg = (mR + mG + mB) / 3;
    if (!(mR > 1e-6) || !(mG > 1e-6) || !(mB > 1e-6)) return;   // 全黑 / 退化图不动
    var kR = mg / mR, kG = mg / mG, kB = mg / mB;
    for (var j = 0; j < empty.length; j++) {
      if (empty[j]) continue;
      var p = j * 3;
      rgb[p] = clampNum(rgb[p] * kR, 0, 255);
      rgb[p + 1] = clampNum(rgb[p + 1] * kG, 0, 255);
      rgb[p + 2] = clampNum(rgb[p + 2] * kB, 0, 255);
    }
  }

  function autoLevels(rgb, empty) {
    var n = emptyCount(empty);
    if (n === 0) return;
    var cut = Math.floor(n * 0.005);                 // 每通道各裁 0.5% 分位
    var hist = [new Int32Array(256), new Int32Array(256), new Int32Array(256)];
    for (var i = 0; i < empty.length; i++) {
      if (empty[i]) continue;
      var q = i * 3;
      hist[0][byte(rgb[q])]++;
      hist[1][byte(rgb[q + 1])]++;
      hist[2][byte(rgb[q + 2])]++;
    }
    var lo = [0, 0, 0], hi = [255, 255, 255];
    for (var ch = 0; ch < 3; ch++) {
      var h = hist[ch], acc = 0, a, b;
      for (a = 0; a < 256; a++) { acc += h[a]; if (acc > cut) break; }
      if (a > 255) a = 255;
      acc = 0;
      for (b = 255; b >= 0; b--) { acc += h[b]; if (acc > cut) break; }
      if (b < 0) b = 0;
      lo[ch] = a; hi[ch] = b;
    }
    var sc = [1, 1, 1];
    for (var c = 0; c < 3; c++) if (hi[c] > lo[c]) sc[c] = 255 / (hi[c] - lo[c]); else sc[c] = 0;
    for (var j = 0; j < empty.length; j++) {
      if (empty[j]) continue;
      var p = j * 3;
      for (var k = 0; k < 3; k++) {
        var v = rgb[p + k];
        rgb[p + k] = (sc[k] === 0) ? clampNum(v, 0, 255)
          : clampNum((v - lo[k]) * sc[k], 0, 255);
      }
    }
  }

  /** brightness → contrast → saturation（单趟完成，与三趟点运算等价）。 */
  function toneAndSaturation(rgb, empty, bv, cv, sv) {
    var shift = bv * 2.55;
    var C = cv * 2.55;
    var f = (259 * (C + 255)) / (255 * (259 - C));      // C = 0 时 f = 1（恒等）
    var sat = 1 + sv / 100;
    for (var i = 0; i < empty.length; i++) {
      if (empty[i]) continue;
      var p = i * 3;
      var r = clampNum(rgb[p] + shift, 0, 255);
      var g = clampNum(rgb[p + 1] + shift, 0, 255);
      var b = clampNum(rgb[p + 2] + shift, 0, 255);
      r = clampNum((r - 128) * f + 128, 0, 255);
      g = clampNum((g - 128) * f + 128, 0, 255);
      b = clampNum((b - 128) * f + 128, 0, 255);
      var gray = 0.299 * r + 0.587 * g + 0.114 * b;
      r = clampNum(gray + (r - gray) * sat, 0, 255);
      g = clampNum(gray + (g - gray) * sat, 0, 255);
      b = clampNum(gray + (b - gray) * sat, 0, 255);
      rgb[p] = r; rgb[p + 1] = g; rgb[p + 2] = b;
    }
  }

  function preprocess(rgb, empty, pp) {
    if (pp.autoWB) grayWorld(rgb, empty);
    if (pp.autoLevels) autoLevels(rgb, empty);
    if (pp.brightness !== 0 || pp.contrast !== 0 || pp.saturation !== 0) {
      toneAndSaturation(rgb, empty, pp.brightness, pp.contrast, pp.saturation);
    }
  }

  /* ------------------------------------------------------------ 分类与统计 */

  /** 最近邻（逐格吸附到 matcher 的调色板）。 */
  function nearestPass(work, w, h, matcher) {
    var out = new Uint16Array(w * h);
    var CK = root.ColorKit;
    for (var i = 0; i < out.length; i++) {
      var p = i * 3;
      var lab = CK.srgbToLab([work[p], work[p + 1], work[p + 2]]);
      out[i] = matcher._nearestL ? matcher._nearestL(lab[0], lab[1], lab[2]) : matcher.nearestLab(lab);
    }
    return out;
  }

  function classify(work, w, h, matcher, o) {
    var CK = root.ColorKit;
    if (o.method === 'fs') return CK.ditherFS(work, w, h, matcher, o.ditherStrength);
    if (o.method === 'bayer') return CK.ditherBayer(work, w, h, matcher, o.bayerN, o.ditherStrength);
    return nearestPass(work, w, h, matcher);
  }

  /* ------------------------------------------------------------ 锁定格处理 */

  function findPaletteColorByCode(palette, code) {
    for (var i = 0; i < palette.length; i++) if (palette[i].code === code) return palette[i];
    return null;
  }

  /**
   * 「锁定为空」探测：上一张图里 locked[i] 为真且 cells[i] 是空格标记。
   * 与 snapshotLockedCode 严格互斥——空格没有色号，有色号就不是空格。
   */
  function snapshotLockedEmpty(prev, i) {
    if (!prev || !prev.locked || !prev.locked[i]) return false;
    if (!prev.cells || typeof prev.cells.length !== 'number') return false;
    return prev.cells[i] === EMPTY;
  }

  /** 「锁定色号」探测：返回色号字符串；不是锁定色号（含「锁定为空」）返回 null。 */
  function snapshotLockedCode(prev, i) {
    if (!prev || !prev.locked || !prev.locked[i]) return null;
    if (!prev.cells || !prev.colors) return null;
    var ci = prev.cells[i];
    if (ci === EMPTY) return null;         // 空格走 snapshotLockedEmpty，这里不是色号
    if (!(ci >= 0 && ci < prev.colors.length)) return null;
    var c = prev.colors[ci];
    if (!c || c.code === undefined || c.code === null) return null;
    return String(c.code);
  }

  function copyColor(c) {
    return { code: c.code, hex: c.hex, rgb: [c.rgb[0], c.rgb[1], c.rgb[2]], group: c.group };
  }

  /* -------------------------------------------------------------- 主装配 */

  function buildPattern(gw, gh, ds, o, pal, warnings) {
    var n = gw * gh;
    var rgb = ds.rgb, empty = ds.empty;

    preprocess(rgb, empty, o.preprocess);

    // 非空像素压缩成一维栅格交给 quantize（它只接受稠密栅格；空格不参与减色统计）
    var nonEmpty = emptyCount(empty);
    var redList = null;                       // 本次使用的调色板子集（matcher 的 index 空间）
    if (nonEmpty > 0) {
      var packed = new Float32Array(nonEmpty * 3);
      var k = 0;
      for (var i = 0; i < n; i++) {
        if (empty[i]) continue;
        var q = i * 3;
        packed[k * 3] = rgb[q]; packed[k * 3 + 1] = rgb[q + 1]; packed[k * 3 + 2] = rgb[q + 2];
        k++;
      }
      var matcher = root.ColorKit.makeMatcher(pal.colors);
      if (o.quantize.enabled) {
        // quantize 返回的 indices 是【色表下标】（见 color.js 第 464/468 行：簇心先经
        // nearestL 吸附成 palOf[]，再用 palOf 填 indices）。这里只取 used 作为调色板收窄依据。
        var qr = root.ColorKit.quantize(packed, nonEmpty, 1, o.quantize.maxColors, matcher);
        var used = qr.used;
        redList = new Array(used.length);
        for (var u = 0; u < used.length; u++) redList[u] = pal.colors[used[u]];
        if (redList.length === 0) redList = pal.colors;      // 理论上不会发生
      } else {
        redList = pal.colors;
      }
    }

    // 空格占位（行主序前一个非空格的颜色；若之前没有则用整图第一个非空格的颜色）后分类
    var cells = null;
    if (redList && redList.length) {
      var work = new Float32Array(n * 3);
      var carryR = 0, carryG = 0, carryB = 0, has = false;
      for (var f = 0; f < n; f++) {
        if (!empty[f]) { var pf = f * 3; carryR = rgb[pf]; carryG = rgb[pf + 1]; carryB = rgb[pf + 2]; has = true; break; }
      }
      for (var c = 0; c < n; c++) {
        var pc = c * 3;
        if (!empty[c]) { carryR = rgb[pc]; carryG = rgb[pc + 1]; carryB = rgb[pc + 2]; has = true; }
        work[pc] = has ? carryR : 0;
        work[pc + 1] = has ? carryG : 0;
        work[pc + 2] = has ? carryB : 0;
      }
      cells = classify(work, gw, gh, root.ColorKit.makeMatcher(redList), o);
    } else {
      cells = new Uint16Array(n);
    }

    /* 锁定格：① 锁定为空 / ② 锁定色号 → 并入色号 → 自然序排序 → 全量重映射下标 */
    var forcedCode = new Array(n);            // 只对「锁定色号」的格有值
    var lockedEmpty = new Uint8Array(n);      // 只对「锁定为空」的格为 1
    var locked = new Uint8Array(n);
    var prev = o.prevPattern;
    if (prev) {
      var sameSize = (Math.round(prev.w) === gw && Math.round(prev.h) === gh
        && prev.cells && typeof prev.cells.length === 'number'
        && prev.cells.length === n && prev.colors);
      if (sameSize) {
        for (var s = 0; s < n; s++) {
          // 判定顺序＝契约优先级：先 ① 锁定为空，再 ② 锁定色号（两类互斥，顺序仍显式固定）
          if (snapshotLockedEmpty(prev, s)) { lockedEmpty[s] = 1; locked[s] = 1; continue; }
          var code = snapshotLockedCode(prev, s);
          if (code === null) continue;
          forcedCode[s] = code;
          locked[s] = 1;
        }
      } else {
        warnings.push('prevPattern 尺寸（' + prev.w + '×' + prev.h + '）与本次（'
          + gw + '×' + gh + '）不一致，已忽略锁定格（无法逐格对应）');
      }
    }

    // 1) 收齐本次真正用到的色号（含锁定格并入的新色号）
    var prevColors = (prev && prev.colors && typeof prev.colors.length === 'number') ? prev.colors : [];
    var byCode = new Map();
    var set = [];
    function ensure(color) {
      var code = String(color.code);
      var idx = byCode.get(code);
      if (idx !== undefined) return idx;
      idx = set.length;
      byCode.set(code, idx);
      set.push(copyColor(color));
      return idx;
    }
    if (redList) {
      // 只登记「真正被格点用到」的色号：未被用到的色号不进 colors（colors.length === counts.length 依赖这一点）。
      // 必须跳过两类「最终颜色不取自新图分类」的格子，否则会在 colors 里留下 0 颗的条目：
      //   · 锁定为空：最终是空格（抠图后某色号可能因此一颗不剩）
      //   · 锁定色号：最终是强制色号（由下面第二个循环登记），其新图分类结果作废
      for (var m = 0; m < n; m++) {
        if (empty[m] || lockedEmpty[m] || forcedCode[m] !== undefined) continue;
        ensure(redList[cells[m]]);
      }
    }
    for (var t = 0; t < n; t++) {
      if (!forcedCode[t]) continue;
      // 锁定色号优先取当前色表的规范值；色表里没有（例如用户换过色表）则沿用历史色值
      var canonical = findPaletteColorByCode(pal.colors, forcedCode[t])
        || findPaletteColorByCode(prevColors, forcedCode[t]);
      if (canonical) ensure(canonical);
    }

    // 2) 按色号自然序排序，建立「色号 → 终值下标」
    set.sort(compareCodes);
    byCode = new Map();
    for (var v = 0; v < set.length; v++) byCode.set(String(set[v].code), v);

    // 3) 全量重映射：cells 下标必须依然指向正确的色号
    var finalCells = new Uint16Array(n);
    for (var z = 0; z < n; z++) {
      // 判定顺序＝契约优先级 ①→④，命中即停，前者覆盖后者：
      //   ① 锁定为空：优先级最高，压过下面所有判定——抠掉的背景格必须保持空格
      //   ② 锁定色号：用户锁了这格就说明他要求这里保留这颗豆（即便新图在这格算出的是空格）
      //   ③ 新图算出空格   ④ 新图算出色号
      if (lockedEmpty[z]) { finalCells[z] = EMPTY; continue; }
      if (forcedCode[z] !== undefined) { finalCells[z] = byCode.get(forcedCode[z]); continue; }
      if (empty[z]) { finalCells[z] = EMPTY; continue; }
      var old = cells[z];
      finalCells[z] = byCode.get(String(redList[old].code));
    }

    // 4) 统计（空格不计入）
    var acc = new Int32Array(set.length);
    var total = 0;
    for (var y = 0; y < n; y++) {
      var ci = finalCells[y];
      if (ci >= 0 && ci < set.length) { acc[ci]++; total++; }
    }
    var counts = [];
    for (var x = 0; x < set.length; x++) {
      if (acc[x] > 0) {
        counts.push({ code: set[x].code, hex: set[x].hex, rgb: set[x].rgb, count: acc[x], _i: x });
      }
    }
    counts.sort(function (a, b) { return (b.count - a.count) || (a._i - b._i); });
    for (var w2 = 0; w2 < counts.length; w2++) delete counts[w2]._i;
    if (counts.length !== set.length) {
      warnings.push('内部不一致：colors ' + set.length + ' 项，counts ' + counts.length + ' 项');
    }

    return {
      w: gw,
      h: gh,
      beadMM: BEAD_MM,
      paletteId: pal.id,
      colors: set,
      cells: finalCells,
      locked: locked,
      counts: counts,
      stats: {
        total: total,
        usedColors: set.length,
        boardX: Math.ceil(gw / BOARD_CELLS),
        boardY: Math.ceil(gh / BOARD_CELLS),
        cmW: round2(gw * BEAD_MM / 10),
        cmH: round2(gh * BEAD_MM / 10)
      },
      warnings: warnings
    };
  }

  /* ------------------------------------------------------------- 公开 API */

  /** 纯函数核心：无 DOM 依赖，可在 Node 中直接跑。不修改 rgba / opts / opts.prevPattern。 */
  function generateFromRGBA(rgba, srcW, srcH, opts) {
    if (!rgba || typeof rgba.length !== 'number') {
      throw new Error('Pipeline.generateFromRGBA: rgba 必须是像素缓冲（Uint8ClampedArray 等）');
    }
    var sw = Math.round(num(srcW, 0)), sh = Math.round(num(srcH, 0));
    if (!(sw >= 1) || !(sh >= 1)) throw new Error('Pipeline.generateFromRGBA: 源图尺寸非法（' + srcW + '×' + srcH + '）');
    if (rgba.length < sw * sh * 4) {
      throw new Error('Pipeline.generateFromRGBA: rgba 长度不足（需要 ' + (sw * sh * 4) + '，实际 ' + rgba.length + '）');
    }
    if (!root.ColorKit) throw new Error('Pipeline: 未找到 window.ColorKit（请先加载 src/color.js）');

    var warnings = [];
    var o = readOpts(opts);
    if (o.methodGiven !== undefined && o.methodGiven !== null && o.method !== o.methodGiven) {
      warnings.push('method "' + o.methodGiven + '" 非法，已回退到 "' + o.method + '"');
    }
    var pal = resolvePalette(o.paletteId, warnings);
    var dims = deriveDims(sw, sh, o, warnings);
    var bytes = toBytes(rgba, sw * sh * 4);
    var ds = downsample(bytes, sw, sh, dims.w, dims.h);
    return buildPattern(dims.w, dims.h, ds, o, pal, warnings);
  }

  function sourceSize(imageLike) {
    if (!imageLike) return null;
    var w = imageLike.naturalWidth || imageLike.videoWidth || imageLike.width;
    var h = imageLike.naturalHeight || imageLike.videoHeight || imageLike.height;
    if (isFin(w) && isFin(h) && w >= 1 && h >= 1) return { w: Math.round(w), h: Math.round(h) };
    return null;
  }

  /**
   * DOM 包装：把 imageLike 画到 canvas 取 ImageData，再交给 generateFromRGBA。
   * 支持 HTMLImageElement / HTMLCanvasElement / ImageBitmap / OffscreenCanvas / ImageData。
   * 源图超过 MAX_SRC_PIXELS 时先等比缩小再读像素，避免把 4000×3000 全量读进内存。
   * 注意：这条路径依赖浏览器环境，Node 里只测过「缺 DOM 时报错清晰」。
   */
  function generate(imageLike, opts) {
    // 已经是 ImageData：直接用
    if (imageLike && imageLike.data && isFin(imageLike.width) && isFin(imageLike.height)) {
      return generateFromRGBA(imageLike.data, imageLike.width, imageLike.height, opts);
    }
    var doc = root.document;
    if (!doc || typeof doc.createElement !== 'function') {
      throw new Error('Pipeline.generate: 当前环境没有 DOM，请改用 generateFromRGBA(rgba, w, h, opts)');
    }
    var size = sourceSize(imageLike);
    if (!size) throw new Error('Pipeline.generate: 无法识别图片来源（缺少 width/height）');
    var scale = 1;
    var px = size.w * size.h;
    if (px > MAX_SRC_PIXELS) scale = Math.sqrt(MAX_SRC_PIXELS / px);
    var dw = Math.max(1, Math.round(size.w * scale));
    var dh = Math.max(1, Math.round(size.h * scale));

    var cv = doc.createElement('canvas');
    cv.width = dw;
    cv.height = dh;
    var ctx = cv.getContext ? cv.getContext('2d') : null;
    if (!ctx) throw new Error('Pipeline.generate: 无法获取 2D 绘图上下文');
    ctx.drawImage(imageLike, 0, 0, dw, dh);
    var img = ctx.getImageData(0, 0, dw, dh);
    return generateFromRGBA(img.data, dw, dh, opts);
  }

  root.Pipeline = {
    generateFromRGBA: generateFromRGBA,
    generate: generate,
    DEFAULT_OPTS: DEFAULT_OPTS
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
