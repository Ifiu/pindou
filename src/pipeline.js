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
 * 【核心决策 2】色号下标与排序规则（冻结，最易崩的地方）
 * Pattern.colors 恒按「色号自然序」排列：组序固定 A,B,C,D,E,F,G,H,M，组内按数字升序
 *   （A9 在 A10 之前）。不是按颗数排、不是按首次出现顺序排。
 * cells[i] 是 colors 的下标（图纸上印的是色号本身 A1/A10，不再有数字编号）。这个对应因此与「参数怎么调」无关，
 * 用户微调参数后重新生成的图纸可以逐格对照。
 * counts 是另一个数组，按颗数降序，colors.length === counts.length（保证每个色号都有用量）。
 *
 * 【核心决策 3】管线的固定顺序
 *   RGBA → 区域平均降采样(线性光) → alpha 判定空格 → 预处理
 *        → ②中性区色偏去噪 → 减色(可选) → 抖动/最近邻
 *        → 锁定格扫描 → ③小色块归并 → 色号装配/全量重映射 → 统计 → Pattern
 * 减色必须在抖动之前：quantize 的角色是「先把调色板收窄」，像素本身不被替换；随后抖动/
 * 最近邻都跑在收窄后的调色板上，因此 Pattern.colors ⊆ 减色子集。若先抖动再减色，
 * 抖动辛苦铺开的中间色会被减色抹掉，两种方法的对比也就失去意义。
 * ② 在量化之前：它改的是「格子颜色」，先让同一片浅色面的色相抖动收敛，减色的输入才干净。
 * ③ 在「格→色号」之后、色号装配之前：它改的是「色号分布」，必须拿到真实色号才能算 ΔE；
 *    放在装配之前，被并空的色号自动不再进入 colors（colors.length === counts.length 由此保证，
 *    不需要额外的 prune 步骤）。第 3 段的「①区域一致分配」就插在 ③ 之前、同一位置。
 *
 * 【style 两档（opts.style，默认 'bead'）与阈值依据】——两档都在跑 ②③，只是强度不同
 *   'bead'     更像拼豆图纸（色块硬、色号少、好拼）：② 强度 0.80、③ MIN_PATCH 4 / ΔE 门限 8
 *   'faithful' 更还原原图（保留原图的杂，接近本轮之前的观感）：② 强度 0.25、③ MIN_PATCH 2 / ΔE 门限 4
 *   ② C_MAX = 18（Lab C*）：拼豆色卡的「浅色 / 近中性」色号绝大多数落在 C* < 18；超过 18 的
 *     格子属于「明确有颜色的面」，动它等于改画面主色，风险远大于收益。
 *   ② 邻域半径 1（3×3，含自身），且只统计同样 C* < C_MAX 的邻居：按格色相抖动的周期通常就是
 *     1–2 格，3×3 足够把它平均掉；再放大半径会把「冷暖分区的大趋势」一起抹平，那就成了改画面。
 *     含自身带来一个好处：没有任何同类邻居的孤立低彩度格子，目标值就是它自己 → 数学上无操作。
 *   ② 只拉 a/b，L 一律不动：明暗是真实结构（受光/背光），动了就毁层次。也**不是**直接去饱和：
 *     拉向「局部平均」只杀逐格抖动、保留局部色偏趋势（真实氛围光不会被做死）。
 *   ③ ΔE 门限 8（bead）：CIE76 ΔE≈8 在珠距 2.6mm、正常观看距离下已接近「两颗相邻豆一眼可辨」
 *     的下限附近。误差小于它的碎块并掉，人眼基本看不出，但少一堆碎块、少几个色号。
 *     'faithful' 收到 4（≈「几乎同色才并」），所以 faithful 的改动量远小于 bead。
 *   ③ 门限以「每颗平均 ΔE」表述（= 总 ΔE ÷ 块珠数）：块内同色，故 argmin(总ΔE) 与
 *     argmin(每颗ΔE) 完全等价；但用每颗做门限才不会让「珠数多的块因为总量大而更容易过门」。
 *   ③ MIN_PATCH 4 / 2：只有 1–3 颗（bead）/ 1 颗（faithful）的碎块是候选。块内只要有一颗
 *     locked，整块跳过 —— 所以锁定格永远不会被 ③ 改到。
 *   两档都确定性、无随机；②③ 都由内部总开关控制（见 readOpts 的 steps，缺省全开）。
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
  var MAX_DIM = 200;            // 单边格数硬上限（只用于夹取/校验；app/ui 侧应保持一致）
  var DEFAULT_LONG_EDGE = 100;   // 未给 gridW/gridH 时的默认长边（短边按原图宽高比自适应）
                                 // 与 MAX_DIM 刻意分成两个常量：默认 ≠ 上限，上限一改默认不该跟着变。
  var EMPTY = 65535;            // cells 里的空格标记
  var ALPHA_MIN = 128;          // alpha < 128 视为透明
  var MAX_SRC_PIXELS = 1200 * 1200;  // generate() 读取源图的像素上限（防止把 4000×3000 全量读进来）
  var GROUP_ORDER = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'M'];
  var DEFAULT_PALETTE_ID = 'mard-221-getcolors';

  /**
   * 默认参数：与 src/ui.html 的默认控件值保持一致（否则「不传 opts」与「用界面默认值」
   * 会得到两张不同的图纸，用户会认为有 bug）。逐项理由：
   *   method 'nearest'      忠实、快、色块最干净，便于用户先看清原图结构再切 FS/Bayer 对比。
   *   bayerN 4              UI 默认 4×4；4×4 在小格数下纹理比 8×8 更细。
   *   ditherStrength 0.3    UI 滑杆默认 30%；全强度(1)在拼豆这种「色块即成品」的载体上
   *                         会把边缘打散成杂色，0.3 是稳妥起点。
   *   quantize.enabled true 默认必须「拼得完」：随机噪声图用最近邻实测会命中 208/221 个色号，
   *                         真实照片也常上百色，而没有人手上有两百种拼豆。默认开减色。
   *   quantize.maxColors 24 常用拼豆作品通常 10–25 色，24 落在「表现力够 + 买得到豆」的
   *                         甜点上：200×200 满配时每色平均仍有 ~1667 颗，足以表现渐变；
   *                         同时与 UI 的 maxColors 默认值一致。
   *   paletteId             默认主谱系 mard-221-getcolors（palette.js 的第一个 key）。
   *   style 'bead'          默认「像拼豆图纸」档：②③ 强度拉满（阈值依据见文件头「style 两档」）。
   *                         'faithful' 档是「接近上一版观感」的退路，强度只有 0.25 / 2 / 4。
   *   gridW/gridH null      未给时按原图宽高比铺满长边 DEFAULT_LONG_EDGE = 100 格（默认尺寸，
   *                         刻意不等于上限）；给出则优先并夹到 [1, MAX_DIM = 200]。
   * 说明：opts 里出现约定外的附加字段（如 app.js 的 keepLocks / locks）一律忽略，不报错。
   *      唯一例外是 opts.steps（内部/测试开关，缺省全开，不进 DEFAULT_OPTS）：
   *      { chroma:false } 只关 ②，{ merge:false } 只关 ③，{ gate:false } 只关 ③ 的 ΔE 门控。
   */
  var DEFAULT_OPTS = {
    gridW: null,
    gridH: null,
    lockAspect: true,
    paletteId: DEFAULT_PALETTE_ID,
    preprocess: { brightness: 0, contrast: 0, saturation: 0, autoWB: false, autoLevels: false },
    method: 'nearest',
    bayerN: 4,
    ditherStrength: 0.3,
    style: 'bead',
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

  /**
   * 两档 style 的全部强度参数（唯一真源，改阈值只改这张表）。
   * 阈值依据见文件头「style 两档（opts.style，默认 'bead'）与阈值依据」。
   * 注意：两档都跑 ②③，只是强度不同；'faithful' 不是「关掉」，是「弱化」。
   */
  var STYLE_PARAMS = {
    bead: { chromaMax: 18, chromaRadius: 2, chromaStrength: 0.80, minPatch: 4, deltaEGate: 8, mergeDE: 8 },
    faithful: { chromaMax: 18, chromaRadius: 1, chromaStrength: 0.25, minPatch: 2, deltaEGate: 4, mergeDE: 2 }
  };

  /** 只读解析，绝不修改传入的 opts。 */
  function readOpts(opts) {
    var o = (opts && typeof opts === 'object') ? opts : {};
    var q = (o.quantize && typeof o.quantize === 'object') ? o.quantize : {};
    var pp = (o.preprocess && typeof o.preprocess === 'object') ? o.preprocess : {};
    var method = (o.method === 'fs' || o.method === 'bayer' || o.method === 'nearest') ? o.method : DEFAULT_OPTS.method;
    var styleId = (o.style === 'faithful') ? 'faithful' : DEFAULT_OPTS.style;
    return {
      gridW: numOrNull(o.gridW),
      gridH: numOrNull(o.gridH),
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
      style: styleId,
      styleGiven: o.style,
      styleParams: STYLE_PARAMS[styleId],
      // ①②③ 总开关：缺省全开；opts.steps 是内部/测试开关（约定外可选字段，不进 DEFAULT_OPTS）
      steps: {
        region: !(o.steps && o.steps.region === false),
        chroma: !(o.steps && o.steps.chroma === false),
        merge: !(o.steps && o.steps.merge === false),
        gate: !(o.steps && o.steps.gate === false)
      },
      prevPattern: (o.prevPattern && typeof o.prevPattern === 'object') ? o.prevPattern : null
    };
  }

  /**
   * 尺寸推导。单边硬上限 MAX_DIM = 200，默认长边 DEFAULT_LONG_EDGE = 100 —— **两个数不是一回事**。
   * - gridW/gridH 都未给：长边取 DEFAULT_LONG_EDGE = 100（默认尺寸），短边按原图宽高比推导后
   *   夹到 [1, MAX_DIM]（极端比例不强行方形，短边可以小到 1）。这是唯一的回落值，永远不会推出 0 / NaN。
   *   ⚠️ 这里必须用 DEFAULT_LONG_EDGE 而不是 MAX_DIM：否则上限从 100 提到 200 时，默认尺寸会
   *   被顺手放大到 200，与「默认原图最长边 100 格」的产品要求冲突。
   * - 只给一边：另一边按 lockAspect 推导（true = 按原图比例；false = 取与已给一边相同的格数）。
   * - 两边都给：优先采用，各自夹到 [1, MAX_DIM]（是否等比拉伸由调用方决定，管线不擅自改用户输入）。
   */
  function deriveDims(sw, sh, o, warnings) {
    var w = o.gridW, h = o.gridH;
    var aspect = sw / sh;                    // 宽/高，恒 > 0
    if (w === null && h === null) {
      if (aspect >= 1) { w = DEFAULT_LONG_EDGE; h = clampInt(Math.round(DEFAULT_LONG_EDGE / aspect), 1, MAX_DIM); }
      else { h = DEFAULT_LONG_EDGE; w = clampInt(Math.round(DEFAULT_LONG_EDGE * aspect), 1, MAX_DIM); }
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

  /* ------------------------------------------------ 图块结构（4-连通标记） */

  var ISOLATED_MAX = 3;         // 「孤立珠」判定阈值：所在同色块珠数 < 3 即算孤立

  /**
   * 4-连通同色图块标记（两遍扫描 + 并查集，O(格数)，无递归、无随机、无排序依赖）。
   *
   * 约定：
   * - 只把「珠子」当块成员；cells[i] === EMPTY 的格子直接跳过，labels[i] 保持 -1。
   *   空格没有色号，谈不上「同色」，因此不参与连通、不参与任何图块统计。
   * - 并查集一律「小下标当根」，所以每块的根 = 该块在行主序里第一次出现的格子下标；
   *   再把根按升序压成稠密编号 0..count-1 ⇒ **块号天然等于「按首格下标」的顺序**，
   *   与任何遍历/哈希顺序无关，可逐字节复现。
   * 返回 { labels（逐格块号，-1=空格）, sizes（逐块珠数）, firsts（逐块首格下标）, count }
   * 后续步骤（如小色块归并）可直接复用：块号 + 大小 + 首格下标就够了。
   */
  function labelPatches(cells, w, h) {
    var n = w * h;
    var labels = new Int32Array(n).fill(-1);
    var parent = new Int32Array(n);
    var count = 0, i, x, y;

    function find(a) {                       // 迭代 + 路径压缩（不用递归，避免深链爆栈）
      var r = a;
      while (parent[r] !== r) r = parent[r];
      while (parent[a] !== r) { var nx = parent[a]; parent[a] = r; a = nx; }
      return r;
    }

    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        var c = cells[i];
        if (c === EMPTY) continue;
        var lId = (x > 0 && cells[i - 1] === c) ? labels[i - 1] : -1;
        var uId = (y > 0 && cells[i - w] === c) ? labels[i - w] : -1;
        if (lId >= 0 && uId >= 0) {
          labels[i] = lId;
          var ra = find(lId), rb = find(uId);
          if (ra !== rb) parent[ra < rb ? rb : ra] = (ra < rb ? ra : rb);
        } else if (lId >= 0) {
          labels[i] = lId;
        } else if (uId >= 0) {
          labels[i] = uId;
        } else {
          parent[count] = count;
          labels[i] = count;
          count++;
        }
      }
    }

    // 第二遍：按根聚合珠数与首格，再压成稠密块号
    var rootSize = new Int32Array(count);
    var rootFirst = new Int32Array(count).fill(-1);
    for (i = 0; i < n; i++) {
      if (labels[i] < 0) continue;
      var r = find(labels[i]);
      rootSize[r]++;
      if (rootFirst[r] < 0) rootFirst[r] = i;
    }
    var dense = new Int32Array(count).fill(-1);
    var sizes = new Int32Array(count), firsts = new Int32Array(count), k = 0;
    for (var q = 0; q < count; q++) {
      if (rootSize[q] === 0) continue;
      dense[q] = k;
      sizes[k] = rootSize[q];
      firsts[k] = rootFirst[q];
      k++;
    }
    for (i = 0; i < n; i++) {
      if (labels[i] < 0) continue;
      labels[i] = dense[find(labels[i])];
    }
    return {
      labels: labels,
      sizes: sizes.subarray(0, k),
      firsts: firsts.subarray(0, k),
      count: k
    };
  }

  /**
   * 四个图块结构指标（都在**最终** pattern 的 cells 上算，O(格数)，确定性）：
   *   isolatedShare  0..1  所在同色四连通块珠数 < ISOLATED_MAX 的珠子数 ÷ 非空格数
   *   patchCount     整数  同色四连通块总数
   *   patchMean      数字  非空格数 ÷ patchCount（没有珠子时取 0，避免 0/0 出 NaN）
   *   boundaryPairs  整数  四邻相接、两侧都是珠子且色号不同的对数
   *                        （每对只数一次：右邻 + 下邻；珠子↔空格不算，因为空格没有色号）
   */
  function measurePattern(cells, w, h) {
    var lp = labelPatches(cells, w, h);
    var n = cells.length, i, nonEmpty = 0, isolated = 0;
    for (i = 0; i < n; i++) {
      var lb = lp.labels[i];
      if (lb < 0) continue;
      nonEmpty++;
      if (lp.sizes[lb] < ISOLATED_MAX) isolated++;
    }
    var pairs = 0;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        i = y * w + x;
        var c = cells[i];
        if (c === EMPTY) continue;
        if (x + 1 < w) { var rn = cells[i + 1]; if (rn !== EMPTY && rn !== c) pairs++; }
        if (y + 1 < h) { var dn = cells[i + w]; if (dn !== EMPTY && dn !== c) pairs++; }
      }
    }
    return {
      isolatedShare: nonEmpty > 0 ? isolated / nonEmpty : 0,
      patchCount: lp.count,
      patchMean: lp.count > 0 ? nonEmpty / lp.count : 0,
      boundaryPairs: pairs
    };
  }

  /* ------------------------------------------- Lab 反变换（② 需要写回 sRGB） */

  // 与 src/color.js 的 labInto 完全同源的常量（不改 color.js，只在本文件内复用同一套数）
  var LAB_Xn = 0.95047, LAB_Yn = 1.0, LAB_Zn = 1.08883;
  var LAB_EPS = 216 / 24389, LAB_KAPPA = 24389 / 27;

  // sRGB(0–255 浮点) → CIE Lab(D65)，写 out[off..off+2]。与 color.js 的 labInto 逐位一致（自测有对照）
  function labInto(r, g, b, out, off) {
    var lr = srgbToLinear01(r / 255);
    var lg = srgbToLinear01(g / 255);
    var lb = srgbToLinear01(b / 255);
    var X = 0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb;
    var Y = 0.2126729 * lr + 0.7151522 * lg + 0.0721750 * lb;
    var Z = 0.0193339 * lr + 0.1191920 * lg + 0.9503041 * lb;
    var fx = labF(X / LAB_Xn), fy = labF(Y / LAB_Yn), fz = labF(Z / LAB_Zn);
    out[off] = 116 * fy - 16;
    out[off + 1] = 500 * (fx - fy);
    out[off + 2] = 200 * (fy - fz);
  }

  function labF(t) { return t > LAB_EPS ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116; }

  function labFinv(f) {
    var t3 = f * f * f;
    return t3 > LAB_EPS ? t3 : (116 * f - 16) / LAB_KAPPA;
  }

  // Lab → sRGB(0–255 浮点)，写 out[off..off+2]
  function labToRgb(L, A, B, out, off) {
    var fy = (L + 16) / 116, fx = fy + A / 500, fz = fy - B / 200;
    var X = LAB_Xn * labFinv(fx), Y = LAB_Yn * labFinv(fy), Z = LAB_Zn * labFinv(fz);
    var lr = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
    var lg = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
    var lb = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
    out[off] = linearToSrgb255(lr);
    out[off + 1] = linearToSrgb255(lg);
    out[off + 2] = linearToSrgb255(lb);
  }

  /* ------------------------------------------------- ② 中性区色偏去噪 */

  /**
   * DL_BAND = 12：② 汇总邻域 a/b 时的「同一明度带」容差（|ΔL*| ≤ DL_BAND 才参与平均）。
   *
   * 依据：
   * - ② 的职责是「同一个明度面上的色相抖动」。抖动本身不改 L*，所以同带内 ΔL*≈0，
   *   这条约束对主作用几乎零成本；它只挡掉「跨明度带汇总」这种本来就不归 ② 管的情况。
   * - L* 值域 0–100，12 约等于八分之一。实测必须挡掉的那个例子是「白色高光 L*100 挨着
   *   中浅色面 L*72」—— 两者 ΔL*=28，远大于 12，因此不会再互相污染。
   * - 12 也覆盖了「同一片受光面上的正常明暗起伏」（渐变相邻格通常 ΔL* < 5），
   *   不会因为明暗抖动而分裂成互不汇总的碎片。
   */
  var DL_BAND = 12;

  /**
   * ② 把「低彩度格子」的 a/b 往**局部邻域（同样低彩度）的平均 a/b** 拉，L* 一律不动。
   *
   * 为什么这样做（而不是直接去饱和）：低彩度区的逐格色相抖动（白平衡/JPEG 色度噪声/抗锯齿）
   * 会把它如实翻译成好几个不同色号 —— 这就是「图纸发虚 + 滥色」的主因。拉向局部平均只削掉
   * 「相对邻域的那点偏差」，保留邻域的色偏趋势（真实氛围光），所以不会把画面做死。
   *
   * 细节：
   * - 两趟：先按**原始** Lab 算目标 a/b（同时改会导致遍历顺序影响结果），再统一写回。
   * - 邻域含自身：于是「没有任何同类邻居的孤格子」目标值就是它自己 → 数学上无操作，不引入伪影。
   * - 只统计同样 C* < C_MAX 的邻居：否则一片浅暖色靠着一片深冷色时，浅暖色会被拖向冷色。
   * - **只在同一明度带内汇总（|ΔL*| ≤ DL_BAND）**：② 治的是「同一个明度面上的色相抖动」，
   *   跨明度带汇总本来就不是它的职责。白色高光（L*100）挨着一片中浅色面（L*72）时，
   *   若跨带汇总，高光的 a/b 会被那片面的色偏拉走 —— 实测会让 H2(#FFFFFF) 变成 H18(#FCFFF8)，
   *   用户为了一个几乎看不出的色差要多买一个色号。加上明度带约束后这类改动不再发生，
   *   而「同亮度面的色相抖动」这条主作用完全不受影响（抖动本身不改 L，同带内 ΔL*≈0）。
   * - 强度 s ∈ [0,1]：a' = a + (aMean - a) * s。s=0 → 完全无操作。
   * 返回被动过的格子数（供自测/日志用；不写进 warnings，避免污染用户可见告警）。
   */
  function denoiseNeutralChroma(rgb, empty, w, h, p) {
    var n = w * h;
    if (n === 0 || !(p.chromaStrength > 0)) return 0;
    var lab = new Float64Array(n * 3);
    var neutral = new Uint8Array(n);
    var i, q, x, y, cnt = 0;
    for (i = 0; i < n; i++) {
      if (empty[i]) continue;
      q = i * 3;
      labInto(rgb[q], rgb[q + 1], rgb[q + 2], lab, q);
      var a = lab[q + 1], b = lab[q + 2];
      if (Math.sqrt(a * a + b * b) < p.chromaMax) { neutral[i] = 1; cnt++; }
    }
    if (cnt === 0) return 0;

    var R = p.chromaRadius;
    var tA = new Float64Array(n), tB = new Float64Array(n);
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        if (!neutral[i]) continue;
        var L0 = lab[i * 3];
        var sa = 0, sb = 0, k = 0;
        for (var dy = -R; dy <= R; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (var dx = -R; dx <= R; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            var j = yy * w + xx;
            if (!neutral[j]) continue;
            if (Math.abs(lab[j * 3] - L0) > DL_BAND) continue;   // 跨明度带不汇总
            sa += lab[j * 3 + 1]; sb += lab[j * 3 + 2]; k++;
          }
        }
        if (k === 0) continue;                       // 理论上不会（自身一定被统计）
        tA[i] = sa / k; tB[i] = sb / k;
      }
    }

    var s = clampNum(p.chromaStrength, 0, 1);
    var tmp = new Float64Array(3);
    var touched = 0;
    for (i = 0; i < n; i++) {
      if (!neutral[i]) continue;
      q = i * 3;
      var L = lab[q], a0 = lab[q + 1], b0 = lab[q + 2];
      var na = a0 + (tA[i] - a0) * s;
      var nb = b0 + (tB[i] - b0) * s;
      // ★ 彩度单调不增：拉向均值只许「减饱和」，不许「加饱和」。
      // 保持色相方向、只把长度缩回原 C*：C*_new ≤ C*_old 恒成立。
      // 依据：一个「去色偏」的步骤在数学上不可能增加彩度。没有这一夹，一颗纯白格（C*=0）
      // 挨着略偏色的邻居时会被「注入」一点彩度（H2 #FFFFFF → H18 #FCFFF8），
      // 那是凭空造出一个新色号，与去噪的语义相反。
      var c0 = Math.sqrt(a0 * a0 + b0 * b0);
      var cn = Math.sqrt(na * na + nb * nb);
      if (cn > c0) {
        if (c0 <= 1e-12) { na = 0; nb = 0; }      // 纯中性：夹回 0，永远不染色
        else { var shrink = c0 / cn; na *= shrink; nb *= shrink; }
      }
      if (Math.abs(na - a0) < 1e-9 && Math.abs(nb - b0) < 1e-9) continue;   // 已等于邻域均值
      labToRgb(L, na, nb, tmp, 0);
      rgb[q] = clampNum(tmp[0], 0, 255);
      rgb[q + 1] = clampNum(tmp[1], 0, 255);
      rgb[q + 2] = clampNum(tmp[2], 0, 255);
      touched++;
    }
    return touched;
  }

  /* ---------------------------------------------------- ③ 小色块归并 */

  /**
   * ③ 把「碎成 MIN_PATCH 颗以下」的同色块并进相邻色号里，带 ΔE 误差门控。
   *
   * 为什么需要门控（硬要求）：人像的瞳孔/高光只有 1–2 颗，它们本身就是「小色块」。
   * 不门控会被当成噪声一起抹掉 —— 所以只有「并过去后每颗平均 ΔE ≤ 门限」才允许并。
   *
   * 规则：
   * - 块内只要有一颗 locked，整块跳过（锁定是用户的意图，不许动）。
   * - 候选块 = 珠数 < minPatch 且无锁定格；遍历顺序：珠数升序 → 首格下标升序（确定性来自结构）。
   * - 目标 = 所有相邻色号里「每颗平均 ΔE」最小的那个；相等时取先遇到的（邻域扫描顺序固定）。
   * - 全部候选先算完、再一次性写回：因为算用「原 cells」，写用「同色块互不重叠」这一性质，
   *   所以结果与执行顺序无关，也不存在「边改边读」的不确定性。
   * - 门控以「每颗平均 ΔE」表示（等价于「总 ΔE ≤ 门限 × 珠数」）；块内同色 ⇒ argmin 与总 ΔE 一致。
   * 返回 { patches, beads }：被并掉的块数与珠数（供自测；不写进 warnings）。
   */
  function mergeSmallPatches(cells, w, h, colors, locked, p, gate) {
    var n = w * h;
    if (n === 0 || !(p.minPatch > 1)) return { patches: 0, beads: 0 };
    var lp = labelPatches(cells, w, h);
    var patchCount = lp.count;
    if (patchCount === 0) return { patches: 0, beads: 0 };

    var i, pid;
    var lockedAny = new Uint8Array(patchCount);
    for (i = 0; i < n; i++) {
      var lb = lp.labels[i];
      if (lb < 0) continue;
      if (locked[i]) lockedAny[lb] = 1;
    }

    var cand = [];
    for (pid = 0; pid < patchCount; pid++) {
      if (lockedAny[pid]) continue;
      if (lp.sizes[pid] < p.minPatch) cand.push(pid);
    }
    if (cand.length === 0) return { patches: 0, beads: 0 };
    cand.sort(function (u, v) {
      var d = lp.sizes[u] - lp.sizes[v];
      return d !== 0 ? d : (lp.firsts[u] - lp.firsts[v]);
    });

    // 块 → 格 的反向索引（逆序插头 ⇒ 块内按格下标升序，O(n)）
    var head = new Int32Array(patchCount).fill(-1);
    var nextOf = new Int32Array(n).fill(-1);
    for (i = n - 1; i >= 0; i--) {
      var l2 = lp.labels[i];
      if (l2 < 0) continue;
      nextOf[i] = head[l2];
      head[l2] = i;
    }

    // 色号 Lab 缓存 + CIE76 ΔE
    var labs = new Float64Array(colors.length * 3);
    for (var c = 0; c < colors.length; c++) {
      var cc = colors[c];
      labInto(cc.rgb[0], cc.rgb[1], cc.rgb[2], labs, c * 3);
    }
    function deltaEByIndex(ca, cb) {
      var o1 = ca * 3, o2 = cb * 3;
      var d1 = labs[o1] - labs[o2], d2 = labs[o1 + 1] - labs[o2 + 1], d3 = labs[o1 + 2] - labs[o2 + 2];
      return Math.sqrt(d1 * d1 + d2 * d2 + d3 * d3);
    }

    var gateMax = gate === false ? Infinity : p.deltaEGate;
    var mark = new Int32Array(colors.length).fill(-1);
    var gen = 0;
    var planPid = [], planTo = [];

    for (var k = 0; k < cand.length; k++) {
      pid = cand[k];
      var pcIdx = cells[lp.firsts[pid]];                 // 块内同色 → 取首格的色号
      if (pcIdx === EMPTY || !(pcIdx >= 0 && pcIdx < colors.length)) continue;
      gen++;
      var bestTo = -1, bestD = Infinity;
      for (var cell = head[pid]; cell >= 0; cell = nextOf[cell]) {
        var cy = Math.floor(cell / w), cx = cell - cy * w;
        // 四邻固定顺序：左、右、上、下
        for (var dir = 0; dir < 4; dir++) {
          var nx = cx + (dir === 0 ? -1 : dir === 1 ? 1 : 0);
          var ny = cy + (dir === 2 ? -1 : dir === 3 ? 1 : 0);
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          var nbIdx = cells[ny * w + nx];
          if (nbIdx === EMPTY || nbIdx === pcIdx) continue;
          if (!(nbIdx >= 0 && nbIdx < colors.length)) continue;
          if (mark[nbIdx] === gen) continue;
          mark[nbIdx] = gen;
          var d = deltaEByIndex(pcIdx, nbIdx);
          if (d < bestD) { bestD = d; bestTo = nbIdx; }
        }
      }
      if (bestTo < 0) continue;                          // 四周只有空格 / 无可用邻色
      if (bestD <= gateMax) { planPid.push(pid); planTo.push(bestTo); }
    }

    var beads = 0;
    for (var m = 0; m < planPid.length; m++) {
      var to = planTo[m];
      for (var cc2 = head[planPid[m]]; cc2 >= 0; cc2 = nextOf[cc2]) cells[cc2] = to;
      beads += lp.sizes[planPid[m]];
    }
    return { patches: planPid.length, beads: beads };
  }

  /* ------------------------- ① 区域一致分配（区域合并 + 合并体整体配色号） */

  var MAX_MERGE_PASSES = 3;      // 合并最多迭代趟数（每趟重建 root 对并重算权重）

  /**
   * ① 把「格→色号」的结果切成区域，把相邻且平均色差 < mergeDE 的区域并起来，
   *    再给每个**合并体**整体分配一个色号。
   *
   * 为什么需要它：② 只治「虚」（逐格色相抖动），它按设计不动 L*，所以「一片跨 L* 69–100 的
   * 浅色面被切成 6–8 个窄带色号」它管不了。那需要先把「相邻且看不出差别的区域」并成一片、
   * 再给这一片一个色号 —— 这就是 ①。它是本轮唯一负责「压色号数」的步骤。
   *
   * 规则与理由：
   * - 区域来自 labelPatches（4-连通同色块），区域号顺序 = 行主序首格顺序（确定性来自结构）。
   * - 相邻两区域的色差 = 两者**真实平均色**的 CIE76 ΔE。用真实平均色（预处理后 rgb 的均值）
   *   而不是吸附后的色号：两条窄带被吸附成两个不同色号，但真实平均色可能只差 3 ΔE，
   *   它们正是要并的对象；用色号去比就永远并不动。
   * - 边按 ΔE 升序处理；**每次合并后重算合并体的平均色**，于是合并体与第三者的色差会随
   *   「体变大、均值向中间漂移」而增大 —— 这天然限制了单链蔓延（一条渐变不会一路并成一色）。
   * - 最多 MAX_MERGE_PASSES 趟，每趟用当前 root 对重建边表并重算权重，逼近
   *   「所有相邻区域的平均色差 ≥ mergeDE」这个停止条件（不追求严格不动点，够稳且可解释）。
   * - **含锁定格的区域整块跳过**：既不参与合并，也不改颜色。
   * - 只有「由 ≥2 个原始区域合并而成」的合并体才整体重配色号，单个原始区域保持原色号。
   *   原因：fs/bayer 抖动靠的正是「同一片平滑区里逐格用不同色号」；若把每个区域都重配成
   *   「真实平均色的最近色」，抖动会被整体抹平，用户选的取色方式就失效了。
   * - 目标色只在当前色号表 colors（可能是减色后的子集）里挑，因此不会突破 maxColors。
   * 返回 { merged, touched, regions }：合并次数 / 被改色的格数 / 最终区域数。
   */
  function regionConsistentAssign(cells, rgb, w, h, colors, locked, p) {
    var n = w * h, i;
    var mergeDE = p.mergeDE;
    if (n === 0 || !(mergeDE > 0) || !colors || colors.length === 0) {
      return { merged: 0, touched: 0, regions: 0 };
    }
    var lp = labelPatches(cells, w, h);
    var P0 = lp.count;
    if (P0 === 0) return { merged: 0, touched: 0, regions: 0 };

    // 每个原始区域：珠数 + 真实平均色的 Lab 累加 + 是否含锁定格
    var sz = new Float64Array(P0), sL = new Float64Array(P0), sA = new Float64Array(P0), sB = new Float64Array(P0);
    var lockedRegion = new Uint8Array(P0);
    var lab = new Float64Array(3);
    for (i = 0; i < n; i++) {
      var lb = lp.labels[i];
      if (lb < 0) continue;
      if (locked[i]) lockedRegion[lb] = 1;
      var q = i * 3;
      labInto(rgb[q], rgb[q + 1], rgb[q + 2], lab, 0);
      sz[lb] += 1; sL[lb] += lab[0]; sA[lb] += lab[1]; sB[lb] += lab[2];
    }

    var parent = new Int32Array(P0);
    var members = new Int32Array(P0);            // 该根由几个原始区域组成
    for (var r0 = 0; r0 < P0; r0++) { parent[r0] = r0; members[r0] = 1; }

    function find(x) {
      var y = x;
      while (parent[y] !== y) y = parent[y];
      while (parent[x] !== y) { var nx = parent[x]; parent[x] = y; x = nx; }
      return y;
    }
    function rootDE(ra, rb) {
      var sa = sz[ra], sb2 = sz[rb];
      if (!(sa > 0) || !(sb2 > 0)) return Infinity;
      var d1 = sL[ra] / sa - sL[rb] / sb2;
      var d2 = sA[ra] / sa - sA[rb] / sb2;
      var d3 = sB[ra] / sa - sB[rb] / sb2;
      return Math.sqrt(d1 * d1 + d2 * d2 + d3 * d3);
    }

    // 邻接对（无向去重，只存一次）：O(格数) —— 每个格子最多贡献「右」「下」两条边
    var pairsA = [], pairsB = [];
    var seen = new Set();
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        i = y * w + x;
        var r1 = lp.labels[i];
        if (r1 < 0) continue;
        var rn = (x + 1 < w) ? lp.labels[i + 1] : -1;
        var dn = (y + 1 < h) ? lp.labels[i + w] : -1;
        if (rn >= 0 && rn !== r1) pushPair(r1, rn);
        if (dn >= 0 && dn !== r1) pushPair(r1, dn);
      }
    }
    function pushPair(a, b) {
      var lo = a < b ? a : b, hi = a < b ? b : a;
      var key = lo * P0 + hi;
      if (seen.has(key)) return;
      seen.add(key);
      pairsA.push(lo); pairsB.push(hi);
    }

    var mergedCount = 0;
    for (var pass = 0; pass < MAX_MERGE_PASSES; pass++) {
      // 每趟：按当前 root 重建边（去重）并重算权重
      var ea = [], eb = [], ew = [];
      var seenRoot = new Set();
      for (var e = 0; e < pairsA.length; e++) {
        var ra = find(pairsA[e]), rb = find(pairsB[e]);
        if (ra === rb) continue;
        if (lockedRegion[ra] || lockedRegion[rb]) continue;
        var lo2 = ra < rb ? ra : rb, hi2 = ra < rb ? rb : ra;
        var k2 = lo2 * P0 + hi2;
        if (seenRoot.has(k2)) continue;
        seenRoot.add(k2);
        var de = rootDE(lo2, hi2);
        if (!(de < mergeDE)) continue;              // 已经够远，不进本轮候选
        ea.push(lo2); eb.push(hi2); ew.push(de);
      }
      if (ea.length === 0) break;                   // 收敛：没有任何相邻对达标

      var idx = new Array(ea.length);
      for (var t = 0; t < idx.length; t++) idx[t] = t;
      idx.sort(function (u, v) {
        if (ew[u] !== ew[v]) return ew[u] - ew[v];  // 色差升序
        if (ea[u] !== ea[v]) return ea[u] - ea[v];  // 同色差按首格下标（确定性）
        return eb[u] - eb[v];
      });

      var didMerge = 0;
      for (var m = 0; m < idx.length; m++) {
        var u2 = idx[m];
        var A = find(ea[u2]), B = find(eb[u2]);
        if (A === B) continue;
        if (lockedRegion[A] || lockedRegion[B]) continue;
        if (!(rootDE(A, B) < mergeDE)) continue;    // 合并体的均值变了，必须重算
        var keep = A < B ? A : B, drop = A < B ? B : A;
        parent[drop] = keep;
        sz[keep] += sz[drop]; sL[keep] += sL[drop]; sA[keep] += sA[drop]; sB[keep] += sB[drop];
        members[keep] += members[drop];
        if (lockedRegion[drop]) lockedRegion[keep] = 1;   // 理论不可达（só merge 未锁的）
        didMerge++;
      }
      mergedCount += didMerge;
      if (didMerge === 0) break;
    }

    // 合并体整体配色号：只对「由 ≥2 个原始区域合成」且不含锁定格的根
    var colorLab = new Float64Array(colors.length * 3);
    for (var c = 0; c < colors.length; c++) {
      var cc = colors[c];
      labInto(cc.rgb[0], cc.rgb[1], cc.rgb[2], colorLab, c * 3);
    }
    var rootColor = new Int32Array(P0).fill(-1);
    for (var r3 = 0; r3 < P0; r3++) {
      if (find(r3) !== r3) continue;
      if (members[r3] < 2 || lockedRegion[r3]) continue;    // 单块 / 锁定块：色号保持原样
      var s3 = sz[r3];
      if (!(s3 > 0)) continue;
      var mL = sL[r3] / s3, mA = sA[r3] / s3, mB = sB[r3] / s3;
      var best = -1, bestD = Infinity;
      for (var c2 = 0; c2 < colors.length; c2++) {
        var p3 = c2 * 3;
        var d1 = mL - colorLab[p3], d2 = mA - colorLab[p3 + 1], d3 = mB - colorLab[p3 + 2];
        var dd = d1 * d1 + d2 * d2 + d3 * d3;
        if (dd < bestD) { bestD = dd; best = c2; }
      }
      rootColor[r3] = best;
    }

    // 落格：整块一次性换成同一个色号
    var rootOf = new Int32Array(P0);
    for (var r4 = 0; r4 < P0; r4++) rootOf[r4] = find(r4);
    var touched = 0, regions = 0;
    var counted = new Uint8Array(P0);
    for (i = 0; i < n; i++) {
      var lb4 = lp.labels[i];
      if (lb4 < 0) continue;
      var rt = rootOf[lb4];
      if (!counted[rt]) { counted[rt] = 1; regions++; }
      var nc = rootColor[rt];
      if (nc < 0) continue;
      if (cells[i] !== nc) { cells[i] = nc; touched++; }
    }
    return { merged: mergedCount, touched: touched, regions: regions };
  }

  /* -------------------------------------------------------------- 主装配 */

  function buildPattern(gw, gh, ds, o, pal, warnings) {
    var n = gw * gh;
    var rgb = ds.rgb, empty = ds.empty;

    preprocess(rgb, empty, o.preprocess);

    // ② 中性区色偏去噪：作用在下采样后的格子、量化之前（改的是「格子颜色」）
    if (o.steps.chroma) denoiseNeutralChroma(rgb, empty, gw, gh, o.styleParams);

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

    /* ① 区域一致分配：作用在「格→色号」之后、③ 之前。
       ① 负责把「相邻且看不出差别的区域」并成一片并整体配色号（压色号数）；
       ③ 负责把「剩下的 1–3 颗碎块」并进邻居（清尾）。顺序不能反：① 需要看见真实的
       区域边界，若先跑 ③，碎块已经被并走、区域图就不是原貌了，而且 ③ 的门控是按
       「单块 vs 邻色」的 ΔE 判的，先跑 ① 会让候选变少、结果更干净。 */
    if (o.steps.region) {
      regionConsistentAssign(cells, rgb, gw, gh, redList || [], locked, o.styleParams);
    }

    /* ③ 小色块归并：作用在「格→色号」之后、色号装配之前，用上面的 locked 掩码跳过锁定块。 */
    if (o.steps.merge && redList && redList.length) {
      mergeSmallPatches(cells, gw, gh, redList, locked, o.styleParams, o.steps.gate);
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

    // 5) 图块结构指标：在**最终** cells 上算（此时锁定/空格/重映射都已尘埃落定，
    //    所以得到的是最终 pattern 的真实值，而不是中间态）
    var metrics = measurePattern(finalCells, gw, gh);

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
        cmW: round2(gw * BEAD_MM / 10),
        cmH: round2(gh * BEAD_MM / 10),
        isolatedShare: metrics.isolatedShare,
        patchCount: metrics.patchCount,
        patchMean: metrics.patchMean,
        boundaryPairs: metrics.boundaryPairs
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
    if (o.styleGiven !== undefined && o.styleGiven !== null && o.style !== o.styleGiven) {
      warnings.push('style "' + o.styleGiven + '" 非法，已回退到 "' + o.style + '"');
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

  /* ------------------------------- analyzeSource：源图分析与参数建议 */

  var WORK_GRID = 200;          // 分析用工作栅格长边 = MAX_DIM。为什么正好等于上限：
                                // 结构量测是「把工作栅格重采样到各候选档」，工作栅格必须**不细于**
                                // 最大候选，否则 200 档会变成「放大采样」、边界对数失真。
                                // 取 200（而不是 256）的理由：最大候选恰好 1:1、无重采样，且实测六档
                                // 边界对数严格单调（256 时 200 档要从 256 缩下来，实测会在 87→100
                                // 处出现非单调 874→770，把量测分辨率对齐后消失）。耗时两者相同。
  var EDGE_DE = 6;              // 判「边界格」的 ΔE（与「可区分色数」同阈值，口径统一）
  var DISTINCT_DE = 6;          // 判「可区分颜色」的 ΔE
  var DISTINCT_CAP = 256;       // 可区分色数上限（超过按 ≥256 记，反正早已超过任何 maxColors）
  var BG_DE = 8;                // 判「接近四角背景色」的 ΔE
  var FLAT_DE = 2;              // 判「几乎同色」的 ΔE（用于平坦占比）
  var FLAT_COLORS = 20;         // flatArt 判据（组合型）：可区分色数 ≤ 20
  var FLAT_SHARE = 0.70;        // flatArt 判据（组合型）：相邻格「几乎同色」占比 ≥ 70%
  var FLAT_STRONG_COLORS = 8;   // flatArt 判据（单独成立）：可区分色数 ≤ 8 —— 这么少颜色的图不可能是照片
  var KEEP_RATIO = 0.5;         // 尺寸门槛：以**最大候选**（SIZE_PRESETS 末档 = 200）的绝对边界对数为
                                // 100%，取保留 ≥ 50% 的最小档
  var SIZE_PRESETS = [29, 58, 87, 100, 150, 200];   // 候选阶梯：界面预设的 4 档 + 100→200 的中间档 150
                                                    // + 上限档 200（六个候选）。都是数字输入框可直接键入的值。

  /** 按长边 L 推 (w,h)：与 deriveDims 同一套宽高比规则；cap 是对短边/自身的上限。 */
  function analyzeDims(sw, sh, L, cap) {
    var aspect = sw / sh;
    if (aspect >= 1) return { w: L, h: clampInt(Math.round(L / aspect), 1, cap) };
    return { w: clampInt(Math.round(L * aspect), 1, cap), h: L };
  }

  /** 一次 Lab 化：返回逐格 Lab（空格留 0，靠 empty 掩码排除）。 */
  function labOfGrid(rgb, empty, w, h) {
    var n = w * h;
    var lab = new Float64Array(n * 3);
    for (var i = 0; i < n; i++) {
      if (empty[i]) continue;
      var q = i * 3;
      labInto(rgb[q], rgb[q + 1], rgb[q + 2], lab, q);
    }
    return lab;
  }

  function labDE2(lab, a, b) {
    var p = a * 3, q = b * 3;
    var d1 = lab[p] - lab[q], d2 = lab[p + 1] - lab[q + 1], d3 = lab[p + 2] - lab[q + 2];
    return d1 * d1 + d2 * d2 + d3 * d3;
  }

  /**
   * 在「工作栅格」上按某候选尺寸跑一遍**真实管线**，返回该尺寸的 stats.boundaryPairs（绝对量）。
   * 为什么这样量：boundaryPairs 是「同色四邻相接且色号不同的对数」，它随手艺参数（尺寸/色数/style）
   * 真实变化，而且和用户最后在 stats 里看到的数字完全同源，可被独立复算。
   * 相比「edgeShare 比例」，它没有饱和问题（比例在粗格下天然趋近 100%）。
   * 失败（缺 ColorKit / 尺寸为 0）返回 -1，由调用方走兜底。
   */
  function measureStructure(rgbaWork, ww, wh, gw, gh, maxColors, styleId) {
    if (!(ww > 0) || !(wh > 0) || !(gw > 0) || !(gh > 0)) return -1;
    try {
      var pat = generateFromRGBA(rgbaWork, ww, wh, {
        gridW: gw, gridH: gh,
        style: styleId,
        method: 'nearest',
        quantize: { enabled: true, maxColors: maxColors },
        preprocess: { brightness: 0, contrast: 0, saturation: 0, autoWB: false, autoLevels: false }
      });
      if (pat && pat.stats && typeof pat.stats.boundaryPairs === 'number') return pat.stats.boundaryPairs;
      return -1;
    } catch (e) {
      return -1;
    }
  }

  /**
   * 工作栅格的完整分析（一次 Lab 化，四种统计共用）：
   *   edgeShare   边缘格占比 = detail
   *   flatShare   相邻格 ΔE ≤ FLAT_DE 的对数占比（判线稿/插画用）
   *   distinct    以 ΔE > DISTINCT_DE 做贪心聚类的簇数（行主序，确定性；≥DISTINCT_CAP 按上限记）
   *   bgShare     与「任意一个四角颜色」ΔE ≤ BG_DE 的格占比
   *   cornerCount 参与背景统计的角数（透明角不计）
   */
  function analyzeWorkGrid(rgb, empty, w, h) {
    var n = w * h, i, x, y, q;
    var lab = labOfGrid(rgb, empty, w, h);

    // 边缘 + 平坦
    var nonEmpty = 0, edgeCells = 0, pairs = 0, flatPairs = 0;
    var e2 = EDGE_DE * EDGE_DE, f2 = FLAT_DE * FLAT_DE;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        if (empty[i]) continue;
        nonEmpty++;
        var isEdge = false;
        if (x + 1 < w && !empty[i + 1]) {
          var d1 = labDE2(lab, i, i + 1);
          pairs++; if (d1 <= f2) flatPairs++;
          if (d1 > e2) isEdge = true;
        }
        if (y + 1 < h && !empty[i + w]) {
          var d2 = labDE2(lab, i, i + w);
          pairs++; if (d2 <= f2) flatPairs++;
          if (d2 > e2) isEdge = true;
        }
        if (isEdge) edgeCells++;
      }
    }

    // 四角背景色
    var corners = [0, w - 1, (h - 1) * w, h * w - 1];
    var cLab = [];
    for (var c = 0; c < corners.length; c++) {
      var ci = corners[c];
      if (ci < 0 || ci >= n || empty[ci]) continue;
      cLab.push(lab[ci * 3], lab[ci * 3 + 1], lab[ci * 3 + 2]);
    }
    var bgHit = 0, b2 = BG_DE * BG_DE;
    if (cLab.length) {
      for (i = 0; i < n; i++) {
        if (empty[i]) continue;
        var L0 = lab[i * 3], A0 = lab[i * 3 + 1], B0 = lab[i * 3 + 2];
        for (var c2 = 0; c2 < cLab.length; c2 += 3) {
          var dd1 = L0 - cLab[c2], dd2 = A0 - cLab[c2 + 1], dd3 = B0 - cLab[c2 + 2];
          if (dd1 * dd1 + dd2 * dd2 + dd3 * dd3 <= b2) { bgHit++; break; }
        }
      }
    }
    // 多少个角彼此「看起来是同一个背景色」（与第一个有效角比较）；用来避免把「四角各一色」误报成背景
    var cornerAgree = 0;
    if (cLab.length) {
      for (var c4 = 0; c4 < cLab.length; c4 += 3) {
        var g1 = cLab[c4] - cLab[0], g2 = cLab[c4 + 1] - cLab[1], g3 = cLab[c4 + 2] - cLab[2];
        if (g1 * g1 + g2 * g2 + g3 * g3 <= b2) cornerAgree++;
      }
    }

    // 可区分色数（贪心聚类，行主序 → 确定性）
    var cents = new Float64Array(DISTINCT_CAP * 3);
    var k = 0, d2c = DISTINCT_DE * DISTINCT_DE;
    for (i = 0; i < n; i++) {
      if (empty[i]) continue;
      var l0 = lab[i * 3], a0 = lab[i * 3 + 1], b0 = lab[i * 3 + 2];
      var hit = false;
      for (var c3 = 0; c3 < k; c3++) {
        var o3 = c3 * 3;
        var e1 = l0 - cents[o3], e2b = a0 - cents[o3 + 1], e3 = b0 - cents[o3 + 2];
        if (e1 * e1 + e2b * e2b + e3 * e3 <= d2c) { hit = true; break; }
      }
      if (!hit && k < DISTINCT_CAP) { cents[k * 3] = l0; cents[k * 3 + 1] = a0; cents[k * 3 + 2] = b0; k++; }
    }

    return {
      edgeShare: nonEmpty > 0 ? edgeCells / nonEmpty : 0,
      flatShare: pairs > 0 ? flatPairs / pairs : 1,
      distinct: k,
      bgShare: nonEmpty > 0 ? bgHit / nonEmpty : 0,
      cornerCount: cLab.length / 3,
      cornerAgree: cornerAgree
    };
  }

  /**
   * 分析源图并给出「可解释的」参数建议。纯函数：不读 DOM、不联网、无随机。
   *
   * 全部指标都在一张 128 长边的工作栅格上算（由源图按线性光区域平均得到），
   * 所以成本是 O(源像素 + 128²)，与源图尺寸不成平方关系。
   *
   * reasons 里每一条都只引用本函数算出来的数（detail / distinct / bgShare / flatShare /
   * 各档尺寸的实测边缘存活率），没有任何「凭感觉」的阈值文案。
   * 注意：本函数**只产生建议**，不修改任何参数；应用是用户点的。
   */
  function analyzeSource(rgba, srcW, srcH, opts) {
    var o = (opts && typeof opts === 'object') ? opts : {};
    var reasons = [];
    var sw = Math.round(num(srcW, 0)), sh = Math.round(num(srcH, 0));
    var okInput = !!rgba && typeof rgba.length === 'number' && sw >= 1 && sh >= 1 && rgba.length >= sw * sh * 4;

    var palSize = 221;
    try {
      var pal = resolvePalette(typeof o.paletteId === 'string' ? o.paletteId : '', []);
      if (pal && pal.colors && pal.colors.length) palSize = pal.colors.length;
    } catch (e) { /* 色表缺失也照常分析，只影响 maxColors 上限 */ }

    var legalFallback = {
      gridW: 29, gridH: 29,
      maxColors: Math.min(24, Math.max(2, palSize)),
      method: 'nearest',
      style: 'bead'
    };
    if (!okInput) {
      return {
        ok: false, detail: 0, flatArt: false, distinctColors: 0, bgShare: 0,
        suggested: legalFallback,
        reasons: ['入参非法（rgba 长度 ' + (rgba && rgba.length) + ' 不足 ' + (sw * sh * 4) + ' 或尺寸 ' + srcW + '×' + srcH + ' 非法），无法分析']
      };
    }

    var bytes = toBytes(rgba, sw * sh * 4);
    // 工作栅格长边不超过源图长边：小图 1:1 分析（于是 reasons 里的数字能手算），大图压到 128
    var workLong = Math.min(WORK_GRID, Math.max(sw, sh));
    var wd = analyzeDims(sw, sh, workLong, workLong);
    var work = downsample(bytes, sw, sh, wd.w, wd.h);
    if (wd.w * wd.h === 0) {
      return {
        ok: false, detail: 0, flatArt: false, distinctColors: 0, bgShare: 0,
        suggested: legalFallback, reasons: ['工作栅格为空，无法分析']
      };
    }
    var st = analyzeWorkGrid(work.rgb, work.empty, wd.w, wd.h);
    var detail = st.edgeShare;
    var distinct = st.distinct;
    var bgShare = st.bgShare;

    if (detail === 0 && distinct === 0) {
      return {
        ok: false, detail: 0, flatArt: false, distinctColors: 0, bgShare: 0,
        suggested: legalFallback, reasons: ['整图没有不透明像素，没有可分析的内容']
      };
    }

    // 尺寸建议：用**绝对量**衡量「保留了多少结构」，不用比例。
    // 为什么不能比例：edgeShare(该档)/edgeShare(工作栅格) 的分子分母都是「边缘格占该档格数的
    // 百分比」，而粗图的比例天然饱和 —— 格子越少，几乎每格都挨着边界 → edgeShare≈1 → 存活率≈100%。
    // 实测反例（用户真实照片 1208×1556）：按比例报「29 档保住 100%」，而真实管线跑出来的
    // boundaryPairs 是 29:548 / 58:1776 / 87:3194 / 100:3854 —— 29 档其实只剩 14%。比例注定失效。
    // 改用：把工作栅格喂给**真实管线**跑各候选尺寸，取 stats.boundaryPairs（同色四邻相接的对数），
    // 以最大候选（100 档）为 100% 基准算保留率。单调、不饱和、并且与 stats 里的数字完全对得上。
    var sizes = SIZE_PRESETS.filter(function (s) { return s <= MAX_DIM; });
    var dimsList = [], bps = [];
    // 工作栅格 → RGBA 字节（透明格保持 alpha=0，让子跑也把它们当空格）
    var wCount = wd.w * wd.h;
    var rgbaWork = new Uint8ClampedArray(wCount * 4);
    for (var wi = 0; wi < wCount; wi++) {
      if (work.empty[wi]) continue;
      var wq = wi * 4, wr = wi * 3;
      rgbaWork[wq] = byte(work.rgb[wr]);
      rgbaWork[wq + 1] = byte(work.rgb[wr + 1]);
      rgbaWork[wq + 2] = byte(work.rgb[wr + 2]);
      rgbaWork[wq + 3] = 255;
    }
    for (var si = 0; si < sizes.length; si++) {
      var dm0 = analyzeDims(sw, sh, sizes[si], MAX_DIM);
      dimsList.push(dm0);
      bps.push(0);                     // 先占位，等 maxColors/style 算出来再实测
    }

    // 线稿/插画判定：
    //   ① 可区分色数 ≤ FLAT_STRONG_COLORS(8) —— **单独成立**，不看平坦占比。
    //      依据：照片在 ΔE>6 口径下的可区分色数普遍远大于 8（我实测合成人像 122、1600×1600 大图 239+），
    //      而只有 3–8 色的图基本只可能是线稿/图标/网格。且这条判据是「单向安全」的：判成 flatArt
    //      只是建议 faithful（弱去噪），代价小；漏判才会让用户吃到不该有的强去噪。
    //   ② 或者「色数 ≤ 20 且相邻格几乎同色占比 ≥ 70%」——覆盖「色数不多但确实是平滑插画」的情况。
    //      注意 ② 不能单独用：规则网格（黑白线条 + 色块）的平坦占比可能只有 50%，会被 ② 判成照片，
    //      所以少色这一条必须能单独成立。
    var flatArt = distinct <= FLAT_STRONG_COLORS
      || (distinct <= FLAT_COLORS && st.flatShare >= FLAT_SHARE);

    // 色数建议：可区分色数（但不超 24 与色表容量）；下限 2（界面允许的最小值）
    var maxColorsCap = Math.max(2, Math.min(24, palSize));
    var maxColors = clampInt(Math.max(distinct, 2), 2, maxColorsCap);

    // 取色方式：**永远只推 nearest**。
    // 这是产品方向，不是口味：本产品的目标是「色块硬、好拼」。抖动在珠面上等于撒胡椒面 ——
    // 一颗颗交错的双色珠子既难拼、又正是用户抱怨的那种「虚」。更矛盾的是同一管线里
    // ② 中性色偏去噪存在的意义就是消除这种交错，自动建议不该反过来推它。
    // 平滑渐变确实会因最近邻出现色阶断层，但那要留给用户自己权衡（见下面那条 reason）。
    var method = 'nearest';

    // 风格：线稿/插画不做强去噪
    var style = flatArt ? 'faithful' : 'bead';

    // 用真实管线在各候选尺寸上量「绝对结构量」（stats.boundaryPairs），再以最大档为 100% 基准。
    // 注意 style / maxColors 都会影响边界对数，所以必须等它们定了再量（上面才算完）。
    // 「量测失败」(-1) 与「量出来是 0」（纯色图合法结果）必须分开处理。
    var baseBP = 0, anyFail = false;
    for (var sj = 0; sj < sizes.length; sj++) {
      bps[sj] = measureStructure(rgbaWork, wd.w, wd.h, dimsList[sj].w, dimsList[sj].h, maxColors, style);
      if (bps[sj] < 0) anyFail = true;
    }
    baseBP = bps[sizes.length - 1];
    var measured = !anyFail;
    var keepPct = [];
    for (var sk = 0; sk < sizes.length; sk++) {
      keepPct.push(measured && baseBP > 0
        ? Math.min(100, Math.round(bps[sk] * 100 / baseBP))
        : 0);
    }
    var pick;
    if (measured && baseBP > 0) {
      pick = sizes.length - 1;
      for (var km = 0; km < sizes.length; km++) {
        if (keepPct[km] >= KEEP_RATIO * 100) { pick = km; break; }
      }
    } else if (measured) {
      pick = 0;                       // 各档都没有对比边界（纯色/极平图）：最小档就够
    } else {
      // 兜底（缺 ColorKit 等）时没法量结构，按细节密度定性 —— 高细节不给最小档
      pick = detail < 0.05 ? 0 : (detail < 0.25 ? 1 : (detail < 0.5 ? 2 : 3));
      if (pick >= sizes.length) pick = sizes.length - 1;
    }
    var chosenDims = dimsList[pick];
    var chosenL = sizes[pick];

    // ---- reasons：每条都只用上面算出来的数 ----
    reasons.push('细节密度 ' + detail.toFixed(2) + '（在 ' + wd.w + '×' + wd.h + ' 的工作栅格上，'
      + Math.round(detail * 100) + '% 的格子存在 ΔE>' + EDGE_DE + ' 的相邻边界）');
    if (measured) {
      var series = [];
      for (var sq = 0; sq < sizes.length; sq++) series.push(sizes[sq] + '→' + bps[sq]);
      if (baseBP === 0) {
        reasons.push('建议 ' + chosenDims.w + '×' + chosenDims.h + '：按真实管线实测各档的邻接边界对数 '
          + series.join('、') + '；这张图几乎没有对比边界，最小档就够');
      } else if (pick === 0) {
        // 只出现一个百分比：没有可比的第二档（避免「100% vs 100%」这种没有信息的对比）
        reasons.push('建议 ' + chosenDims.w + '×' + chosenDims.h + '：按真实管线实测各档的邻接边界对数 '
          + series.join('、') + '；' + chosenL + ' 格已保住最大档的 ' + keepPct[0]
          + '%，再调大只是更多珠子、不是更多结构');
      } else {
        // 两个百分比必然不同：pick>0 意味着最小档达不到门槛（<50%），而本档 ≥50%
        reasons.push('建议 ' + chosenDims.w + '×' + chosenDims.h + '：按真实管线实测各档的邻接边界对数 '
          + series.join('、') + '；本档保留了最大档（' + sizes[sizes.length - 1] + ' 格）的 '
          + keepPct[pick] + '%，最小档 ' + sizes[0] + ' 格只有 ' + keepPct[0] + '%');
      }
    } else {
      reasons.push('建议 ' + chosenDims.w + '×' + chosenDims.h
        + '：结构量测不可用（缺 ColorKit 或图为空），按细节密度 ' + detail.toFixed(2) + ' 定性判断');
    }
    reasons.push('在 ΔE>' + DISTINCT_DE + ' 的意义下有 ' + distinct + ' 种可区分颜色'
      + (distinct > maxColors
        ? '，但人手备不了这么多，建议收到 ' + maxColors + ' 色'
        : '，建议就用 ' + maxColors + ' 色'));
    // 判据要写清楚：色数极少时不受「相邻同色比例」影响
    reasons.push((distinct <= FLAT_STRONG_COLORS
      ? '可区分颜色只有 ' + distinct + ' 种（≤ ' + FLAT_STRONG_COLORS + ' 种：这么少颜色的图不可能是照片）→ 判为线稿/插画'
      : '可区分颜色 ' + distinct + ' 种、相邻格几乎同色（ΔE≤' + FLAT_DE + '）的比例 '
        + Math.round(st.flatShare * 100) + '% → 判为' + (flatArt ? '线稿/插画' : '照片'))
      + (flatArt ? '，建议 style=faithful（不做强去噪）' : '，建议 style=bead'));
    if (!flatArt && detail < 0.15 && distinct > maxColors) {
      reasons.push('大面积平滑渐变（细节密度 ' + detail.toFixed(2) + '，可区分颜色 ' + distinct
        + ' 种 > 建议色数 ' + maxColors + '）：最近邻会出现色阶断层。想要过渡更柔和，可以自己手动切到'
        + '「误差扩散」——代价是相邻珠子会交错，拼起来更费劲。');
    } else if (flatArt) {
      reasons.push('线稿/插画是硬边色块，抖动会把边缘打散 → 建议 method=nearest');
    } else {
      reasons.push('细节密度 ' + detail.toFixed(2) + ' 偏高，抖动会把细节打散成杂色 → 建议 method=nearest');
    }
    if (bgShare >= 0.55 && st.cornerAgree >= 2) {
      reasons.push('四角里有 ' + st.cornerAgree + '/' + st.cornerCount + ' 个是同一背景色，它覆盖了 '
        + Math.round(bgShare * 100) + '% 的画面 → 建议先抠掉背景再生成，可省下这些格子');
    }

    return {
      ok: true,
      detail: detail,
      flatArt: flatArt,
      distinctColors: distinct,
      bgShare: bgShare,
      suggested: {
        gridW: chosenDims.w,
        gridH: chosenDims.h,
        maxColors: maxColors,
        method: method,
        style: style
      },
      reasons: reasons
    };
  }

  root.Pipeline = {
    generateFromRGBA: generateFromRGBA,
    generate: generate,
    analyzeSource: analyzeSource,
    DEFAULT_OPTS: DEFAULT_OPTS
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
