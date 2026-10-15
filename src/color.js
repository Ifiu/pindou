/**
 * ColorKit —— 拼豆色卡映射用的纯函数色彩引擎（零依赖、无 DOM、无模块语法）
 * 挂载点：window.ColorKit（Node 自测环境自动挂到 globalThis，方便直接跑断言）
 *
 * ── 默认匹配空间为什么是 CIE Lab（CIE76 欧氏距离）而不是 Oklab ──────────────
 * 1) 与色卡数据对齐：拼豆色卡（包括 221 色卡）的公开资料与既有换算工具几乎都以
 *    CIE Lab / ΔE(CIE76) 给出色值。默认用 Lab 匹配，色卡坐标与匹配坐标是同一套，
 *    不必在色卡侧和匹配侧各做一次空间转换，也省掉“哪套空间才是准的”的争论成本。
 * 2) 抖动 / 减色的量纲统一：Lab 的 L 分量近似感知明度、值域 0–100。Floyd–Steinberg
 *    的误差扩散与 Bayer 阈值都作用在 L 上时量纲一致，“抖动幅度相当于多少明度”
 *    可以用一个常量直接表述（见 BAYER_L_SCALE）。
 * 3) Oklab 感知均匀性更好，但它的优势在“生成新配色”这类任务；本模块的任务是
 *    “把像素吸附到既有色卡”，换成 Oklab 不会让吸附结果更贴近色卡本身。故默认仍用
 *    Lab，同时以 srgbToOklab / deltaEOklab 暴露 Oklab，调用方若要换匹配空间可自行
 *    替换（makeMatcher 内部只依赖 Lab，换空间需要自建匹配器）。
 *
 * ── quantize 为什么用 Lab 空间 k-means 而不是 median-cut ────────────────────
 * 1) 与吸附目标一致：减色最后一步是“每个簇心再吸附到色卡”。k-means 直接最小化像素
 *    Lab 与簇心 Lab 的平方误差，簇心越贴近图像真实色，吸附到色卡后的偏差越小。
 *    median-cut 在 RGB 箱体上沿坐标轴递归二分，切分点不好与 Lab 感知误差挂钩，
 *    容易切出细长簇，吸附后偏色更明显。
 * 2) 规模合适：目标色数 ≤ 色表大小（最多 221），87×87=7569 像素，k-means 在该规模下
 *    毫秒级收敛；median-cut 还要额外维护箱体统计与分裂顺序，收益不成比例。
 * 3) 确定性好实现：初始化用“出现次数最多的颜色 + 最远点补种”，遍历顺序固定、无随机，
 *    同一输入两次调用逐字节一致。
 * 健壮性：迭代上限 KMEANS_MAX_ITER = 12；空簇会被重新播种到“离自己所属簇心最远”的
 * 颜色上，无点可搬时保持原簇心不动；maxColors 会被夹到 [1, min(实际色数, 色表大小)]。
 *
 * ── 其它实现约定 ───────────────────────────────────────────────────────────
 * - 输入 rgb 为扁平数组（Uint8ClampedArray / Float32Array / 普通数组均可），长度 w*h*3，
 *   通道顺序 R,G,B，取值 0–255；浮点值也能处理（线性化前夹紧到 [0,1]）。
 * - 输出为 Uint16Array，值域是色表下标；65535 约定表示“空格 / 不使用”，本模块不产出该值。
 * - strength ∈ [0,1]，缺省 1；strength = 0 时误差权重与阈值偏移全为 0，严格退化为逐像素
 *   最近邻（与 matcher.nearest 逐格完全一致）。
 * - Bayer 阈值矩阵归一化到 [-0.5, 0.5)；因 L 通道值域是 0–100，直接叠加 ±0.5 的偏移等于
 *   没有抖动，故乘常量 BAYER_L_SCALE = 12.5 映射回 L 的量纲（strength=1 时偏移量落在
 *   ±6.25 个明度单位内）。这是本模块唯一的量纲约定，需更强 / 更弱的抖动就调这个常量。
 * - 中间量一律 Float64 计算，色表 Lab 预计算缓存在 Float32Array（matcher.labs）中；
 *   无随机数、无时间依赖、无 DOM 调用、不含任何模块加载或模块导出语法。
 */
;(function (root) {
  'use strict';

  var KMEANS_MAX_ITER = 12;
  var BAYER_L_SCALE = 12.5;

  // D65 白点
  var D65_Xn = 0.95047;
  var D65_Yn = 1.0;
  var D65_Zn = 1.08883;
  // CIE Lab 的 ε = (6/29)^3、κ = (29/3)^3
  var LAB_EPS = 216 / 24389;
  var LAB_KAPPA = 24389 / 27;

  // 标准 Bayer 阈值矩阵（原始序号）
  var BAYER_RAW_4 = [
    0, 8, 2, 10,
    12, 4, 14, 6,
    3, 11, 1, 9,
    15, 7, 13, 5
  ];
  var BAYER_RAW_8 = [
    0, 32, 8, 40, 2, 34, 10, 42,
    48, 16, 56, 24, 50, 18, 58, 26,
    12, 44, 4, 36, 14, 46, 6, 38,
    60, 28, 52, 20, 62, 30, 54, 22,
    3, 35, 11, 43, 1, 33, 9, 41,
    51, 19, 59, 27, 49, 17, 57, 25,
    15, 47, 7, 39, 13, 45, 5, 37,
    63, 31, 55, 23, 61, 29, 53, 21
  ];

  function normalizeBayer(raw, size) {
    var out = new Float64Array(raw.length);
    var total = size * size;
    for (var i = 0; i < raw.length; i++) out[i] = (raw[i] + 0.5) / total - 0.5;
    return out;
  }

  var BAYER_N4 = normalizeBayer(BAYER_RAW_4, 4);
  var BAYER_N8 = normalizeBayer(BAYER_RAW_8, 8);

  function clamp01(v) {
    if (!(v > 0)) return 0;
    return v > 1 ? 1 : v;
  }

  function clampByte(v) {
    if (typeof v !== 'number' || v !== v) return 0;
    var x = Math.round(v);
    return x < 0 ? 0 : (x > 255 ? 255 : x);
  }

  // sRGB 通道（0–255）→ 线性光，含正确 gamma 解码
  function channelToLinear(c) {
    var v = c / 255;
    if (!(v > 0)) return 0;
    if (v >= 1) return 1;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function labF(t) {
    return t > LAB_EPS ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116;
  }

  // sRGB(0–255) → CIE Lab(D65)，写入 out[off..off+2]
  function labInto(r, g, b, out, off) {
    var lr = channelToLinear(r);
    var lg = channelToLinear(g);
    var lb = channelToLinear(b);
    var X = 0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb;
    var Y = 0.2126729 * lr + 0.7151522 * lg + 0.0721750 * lb;
    var Z = 0.0193339 * lr + 0.1191920 * lg + 0.9503041 * lb;
    var fx = labF(X / D65_Xn);
    var fy = labF(Y / D65_Yn);
    var fz = labF(Z / D65_Zn);
    out[off] = 116 * fy - 16;
    out[off + 1] = 500 * (fx - fy);
    out[off + 2] = 200 * (fy - fz);
  }

  function srgbToLab(rgb) {
    var out = [0, 0, 0];
    labInto(rgb[0], rgb[1], rgb[2], out, 0);
    return out;
  }

  function srgbToOklab(rgb) {
    var r = channelToLinear(rgb[0]);
    var g = channelToLinear(rgb[1]);
    var b = channelToLinear(rgb[2]);
    var l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    var m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    var s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    var l_ = Math.cbrt(l);
    var m_ = Math.cbrt(m);
    var s_ = Math.cbrt(s);
    return [
      0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
      1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
      0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    ];
  }

  function euclid3(a1, a2, a3, b1, b2, b3) {
    var d1 = a1 - b1, d2 = a2 - b2, d3 = a3 - b3;
    return Math.sqrt(d1 * d1 + d2 * d2 + d3 * d3);
  }

  // CIE76：Lab 空间欧氏距离
  function deltaE(labA, labB) {
    return euclid3(labA[0], labA[1], labA[2], labB[0], labB[1], labB[2]);
  }

  // Oklab 欧氏距离（Oklab 本身已是感知均匀空间，直接取欧氏距离）
  function deltaEOklab(a, b) {
    return euclid3(a[0], a[1], a[2], b[0], b[1], b[2]);
  }

  var HEX_RE = /^[0-9a-fA-F]+$/;

  function hexToRgb(hex) {
    if (typeof hex !== 'string') return null;
    var s = hex.trim();
    if (s.charAt(0) === '#') s = s.slice(1);
    if (!HEX_RE.test(s)) return null;
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (s.length !== 6) return null;
    var v = parseInt(s, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  function byteToHex(v) {
    return (v < 16 ? '0' : '') + v.toString(16).toUpperCase();
  }

  function rgbToHex(rgb) {
    return '#' + byteToHex(clampByte(rgb[0])) + byteToHex(clampByte(rgb[1])) + byteToHex(clampByte(rgb[2]));
  }

  // 取匹配函数：优先用 makeMatcher 暴露的无分配内部版本，退化为通用版本
  function resolveNearest(matcher) {
    if (matcher && typeof matcher._nearestL === 'function') return matcher._nearestL;
    if (matcher && typeof matcher.nearestLab === 'function') {
      return function (L, A, B) { return matcher.nearestLab([L, A, B]); };
    }
    throw new Error('ColorKit: 无效的 matcher，请用 makeMatcher() 创建');
  }

  /**
   * colors: [{code, hex, rgb, group}, ...]，hex 与 rgb 至少有一个（都没有按黑色处理）。
   * 返回 { nearest(rgb), nearestLab(lab), size, labs: Float32Array, ... }
   * labs 是预计算的色表 Lab 缓存，逐像素匹配只做线性扫描，绝不重算色表 Lab。
   */
  function makeMatcher(colors) {
    if (!colors || typeof colors.length !== 'number') {
      throw new Error('ColorKit.makeMatcher: colors 必须是数组');
    }
    var size = colors.length;
    if (size === 0) throw new Error('ColorKit.makeMatcher: 色表不能为空');

    var labs = new Float32Array(size * 3);
    var rgbs = new Array(size);
    var hexes = new Array(size);
    var codes = new Array(size);
    var groups = new Array(size);

    for (var i = 0; i < size; i++) {
      var c = colors[i] || {};
      var rgb = null;
      if (c.rgb && typeof c.rgb.length === 'number' && c.rgb.length >= 3) {
        rgb = [clampByte(c.rgb[0]), clampByte(c.rgb[1]), clampByte(c.rgb[2])];
      } else if (typeof c.hex === 'string') {
        rgb = hexToRgb(c.hex);
      }
      if (!rgb) rgb = [0, 0, 0];
      labInto(rgb[0], rgb[1], rgb[2], labs, i * 3);
      rgbs[i] = rgb;
      hexes[i] = typeof c.hex === 'string' ? c.hex : rgbToHex(rgb);
      codes[i] = c.code !== undefined ? c.code : String(i);
      groups[i] = c.group !== undefined ? c.group : null;
    }

    function nearestL(L, A, B) {
      var best = 0;
      var bestD = Infinity;
      var p = 0;
      for (var i2 = 0; i2 < size; i2++) {
        var dl = L - labs[p];
        var da = A - labs[p + 1];
        var db = B - labs[p + 2];
        var d = dl * dl + da * da + db * db;
        if (d < bestD) { bestD = d; best = i2; }
        p += 3;
      }
      return best;
    }

    return {
      nearest: function (rgb) {
        var lab = srgbToLab(rgb);
        return nearestL(lab[0], lab[1], lab[2]);
      },
      nearestLab: function (lab) {
        return nearestL(lab[0], lab[1], lab[2]);
      },
      size: size,
      labs: labs,
      colors: colors,
      rgbs: rgbs,
      hexes: hexes,
      codes: codes,
      groups: groups,
      _nearestL: nearestL
    };
  }

  /** Floyd–Steinberg 抖动，蛇形扫描，误差在 Lab 空间扩散。返回 Uint16Array 下标。 */
  function ditherFS(rgb, w, h, matcher, strength) {
    w = w | 0;
    h = h | 0;
    var n = (w > 0 && h > 0) ? w * h : 0;
    var out = new Uint16Array(n);
    if (n === 0) return out;
    var s = (strength === undefined || strength === null) ? 1 : clamp01(strength);
    var nearestL = resolveNearest(matcher);
    var pl = matcher.labs;

    // 工作缓冲：像素 Lab（Float64，保证与 srgbToLab 的逐位一致）
    var labs = new Float64Array(n * 3);
    for (var i = 0; i < n; i++) {
      var j = i * 3;
      labInto(rgb[j], rgb[j + 1], rgb[j + 2], labs, j);
    }

    // strength 直接缩放扩散权重：strength=0 时权重全为 0，退化为逐像素最近邻
    var W7 = (7 / 16) * s, W3 = (3 / 16) * s, W5 = (5 / 16) * s, W1 = (1 / 16) * s;
    var rowBytes = w * 3;

    for (var y = 0; y < h; y++) {
      var ltr = (y & 1) === 0;      // 偶数行左→右，奇数行右→左
      var d = ltr ? 1 : -1;
      for (var step = 0; step < w; step++) {
        var x = ltr ? step : w - 1 - step;
        var p = (y * w + x) * 3;
        var L = labs[p], A = labs[p + 1], B = labs[p + 2];
        var idx = nearestL(L, A, B);
        out[y * w + x] = idx;
        var q = idx * 3;
        var eL = L - pl[q], eA = A - pl[q + 1], eB = B - pl[q + 2];
        var t;
        if (x + d >= 0 && x + d < w) {            // 本行前进方向 7/16
          t = p + d * 3;
          labs[t] += eL * W7; labs[t + 1] += eA * W7; labs[t + 2] += eB * W7;
        }
        if (y + 1 < h) {
          var nrow = p + rowBytes;
          if (x - d >= 0 && x - d < w) {          // 下一行后侧 3/16
            t = nrow - d * 3;
            labs[t] += eL * W3; labs[t + 1] += eA * W3; labs[t + 2] += eB * W3;
          }
          t = nrow;                               // 下一行正下 5/16
          labs[t] += eL * W5; labs[t + 1] += eA * W5; labs[t + 2] += eB * W5;
          if (x + d >= 0 && x + d < w) {          // 下一行前侧 1/16
            t = nrow + d * 3;
            labs[t] += eL * W1; labs[t + 1] += eA * W1; labs[t + 2] += eB * W1;
          }
        }
      }
    }
    return out;
  }

  /** 有序抖动（Bayer 4×4 / 8×8）：阈值加到 L 通道后取最近邻。 */
  function ditherBayer(rgb, w, h, matcher, n, strength) {
    w = w | 0;
    h = h | 0;
    var count = (w > 0 && h > 0) ? w * h : 0;
    var out = new Uint16Array(count);
    if (count === 0) return out;
    var size = n === 8 ? 8 : 4;
    var thr = size === 8 ? BAYER_N8 : BAYER_N4;
    var s = (strength === undefined || strength === null) ? 1 : clamp01(strength);
    var amp = s * BAYER_L_SCALE;
    var nearestL = resolveNearest(matcher);
    var tmp = new Float64Array(3);
    for (var y = 0; y < h; y++) {
      var row = (y % size) * size;
      var base = y * w;
      for (var x = 0; x < w; x++) {
        var j = (base + x) * 3;
        labInto(rgb[j], rgb[j + 1], rgb[j + 2], tmp, 0);
        out[base + x] = nearestL(tmp[0] + thr[row + (x % size)] * amp, tmp[1], tmp[2]);
      }
    }
    return out;
  }

  /**
   * Lab 空间 k-means 减色 + 簇心吸附色卡。返回 { indices: Uint16Array, used: number[] }。
   * used 为升序去重的色表下标列表，长度必然 ≤ 实际簇数 ≤ maxColors。
   */
  function quantize(rgb, w, h, maxColors, matcher) {
    w = w | 0;
    h = h | 0;
    var n = (w > 0 && h > 0) ? w * h : 0;
    var indices = new Uint16Array(n);
    var used = [];
    if (n === 0) return { indices: indices, used: used };
    var nearestL = resolveNearest(matcher);
    var palSize = matcher.size;

    // 1) 统计独立颜色（按四舍五入后的 RGB 去重）及其 Lab 均值、出现次数
    var pxLab = new Float64Array(n * 3);
    var pxKey = new Int32Array(n);
    var keyToEntry = new Map();
    var accL = [], accA = [], accB = [], accN = [];
    for (var i = 0; i < n; i++) {
      var j = i * 3;
      labInto(rgb[j], rgb[j + 1], rgb[j + 2], pxLab, j);
      var key = (clampByte(rgb[j]) << 16) | (clampByte(rgb[j + 1]) << 8) | clampByte(rgb[j + 2]);
      var e = keyToEntry.get(key);
      if (e === undefined) {
        e = accL.length;
        keyToEntry.set(key, e);
        accL.push(0); accA.push(0); accB.push(0); accN.push(0);
      }
      accL[e] += pxLab[j]; accA[e] += pxLab[j + 1]; accB[e] += pxLab[j + 2]; accN[e]++;
      pxKey[i] = e;
    }
    var uniq = accL.length;
    var eL = new Float64Array(uniq), eA = new Float64Array(uniq), eB = new Float64Array(uniq), eW = new Float64Array(uniq);
    for (var q = 0; q < uniq; q++) {
      var cnt0 = accN[q];
      eL[q] = accL[q] / cnt0; eA[q] = accA[q] / cnt0; eB[q] = accB[q] / cnt0; eW[q] = cnt0;
    }

    // 2) 目标簇数：夹到 [1, min(实际色数, 色表大小)]
    var k = Math.floor(maxColors);
    if (!(k >= 1)) k = 1;
    if (k > uniq) k = uniq;
    if (k > palSize) k = palSize;
    if (k < 1) k = 1;

    var cx = new Float64Array(k), cy = new Float64Array(k), cz = new Float64Array(k);

    // 3) 确定性初始化：最多出现的颜色 + 最远点补种
    var seed = 0;
    for (var q1 = 1; q1 < uniq; q1++) if (eW[q1] > eW[seed]) seed = q1;
    cx[0] = eL[seed]; cy[0] = eA[seed]; cz[0] = eB[seed];
    var minD = new Float64Array(uniq);
    for (q1 = 0; q1 < uniq; q1++) {
      var dl0 = eL[q1] - cx[0], da0 = eA[q1] - cy[0], db0 = eB[q1] - cz[0];
      minD[q1] = dl0 * dl0 + da0 * da0 + db0 * db0;
    }
    minD[seed] = -1;
    var kk = 1;
    for (var c1 = 1; c1 < k; c1++) {
      var pick = -1, pickD = -1;
      for (q1 = 0; q1 < uniq; q1++) if (minD[q1] > pickD) { pickD = minD[q1]; pick = q1; }
      if (pick < 0) break;
      cx[c1] = eL[pick]; cy[c1] = eA[pick]; cz[c1] = eB[pick];
      minD[pick] = -1;
      kk = c1 + 1;
      for (q1 = 0; q1 < uniq; q1++) {
        var dl1 = eL[q1] - cx[c1], da1 = eA[q1] - cy[c1], db1 = eB[q1] - cz[c1];
        var d1 = dl1 * dl1 + da1 * da1 + db1 * db1;
        if (d1 < minD[q1]) minD[q1] = d1;
      }
    }

    // 4) 迭代（上限 KMEANS_MAX_ITER，空簇重新播种）
    var assign = new Int32Array(uniq);
    var sumL = new Float64Array(kk), sumA = new Float64Array(kk), sumB = new Float64Array(kk), sumW = new Float64Array(kk);
    var iter = 0, changed = true;
    while (iter < KMEANS_MAX_ITER && changed) {
      iter++;
      changed = false;
      sumL.fill(0); sumA.fill(0); sumB.fill(0); sumW.fill(0);
      for (q1 = 0; q1 < uniq; q1++) {
        var l3 = eL[q1], a3 = eA[q1], b3 = eB[q1];
        var best = 0, bestD = Infinity;
        for (var c2 = 0; c2 < kk; c2++) {
          var dl2 = l3 - cx[c2], da2 = a3 - cy[c2], db2 = b3 - cz[c2];
          var d2 = dl2 * dl2 + da2 * da2 + db2 * db2;
          if (d2 < bestD) { bestD = d2; best = c2; }
        }
        if (assign[q1] !== best) { assign[q1] = best; changed = true; }
        var wgt = eW[q1];
        sumL[best] += l3 * wgt; sumA[best] += a3 * wgt; sumB[best] += b3 * wgt; sumW[best] += wgt;
      }
      for (var c3 = 0; c3 < kk; c3++) {
        if (sumW[c3] > 0) {
          cx[c3] = sumL[c3] / sumW[c3]; cy[c3] = sumA[c3] / sumW[c3]; cz[c3] = sumB[c3] / sumW[c3];
        } else {
          var far = -1, farD = 0;
          for (q1 = 0; q1 < uniq; q1++) {
            var ac = assign[q1];
            var dl3 = eL[q1] - cx[ac], da3 = eA[q1] - cy[ac], db3 = eB[q1] - cz[ac];
            var d3 = dl3 * dl3 + da3 * da3 + db3 * db3;
            if (d3 > farD) { farD = d3; far = q1; }
          }
          if (far >= 0) {
            cx[c3] = eL[far]; cy[c3] = eA[far]; cz[c3] = eB[far];
            assign[far] = c3;
            changed = true;
          }
        }
      }
    }

    // 5) 用最终簇心重算归属，再吸附到色卡
    for (q1 = 0; q1 < uniq; q1++) {
      var lf = eL[q1], af = eA[q1], bf = eB[q1];
      var b2 = 0, bd2 = Infinity;
      for (var c4 = 0; c4 < kk; c4++) {
        var dlf = lf - cx[c4], daf = af - cy[c4], dbf = bf - cz[c4];
        var df = dlf * dlf + daf * daf + dbf * dbf;
        if (df < bd2) { bd2 = df; b2 = c4; }
      }
      assign[q1] = b2;
    }
    var palOf = new Int32Array(kk);
    for (var c5 = 0; c5 < kk; c5++) palOf[c5] = nearestL(cx[c5], cy[c5], cz[c5]);

    var seen = new Uint8Array(palSize);
    for (var i2 = 0; i2 < n; i2++) {
      var pi = palOf[assign[pxKey[i2]]];
      indices[i2] = pi;
      seen[pi] = 1;
    }
    for (var s2 = 0; s2 < palSize; s2++) if (seen[s2]) used.push(s2);
    return { indices: indices, used: used };
  }

  var ColorKit = {
    hexToRgb: hexToRgb,
    rgbToHex: rgbToHex,
    srgbToLab: srgbToLab,
    srgbToOklab: srgbToOklab,
    deltaE: deltaE,
    deltaEOklab: deltaEOklab,
    makeMatcher: makeMatcher,
    ditherFS: ditherFS,
    ditherBayer: ditherBayer,
    quantize: quantize
  };

  if (typeof window !== 'undefined') window.ColorKit = ColorKit;
  else root.ColorKit = ColorKit;
})(typeof globalThis !== 'undefined' ? globalThis : this);
