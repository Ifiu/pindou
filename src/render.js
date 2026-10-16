/*!
 * src/render.js —— 拼豆图纸渲染层（零依赖 / 零外部资源）
 *
 * 职责：
 *   1) drawPattern  把 Pattern 画成可打印的白底图纸（网格 + 29 格板边界 + 刻度 + 色号标签 + 可选用量表）
 *   2) exportPNG    canvas -> PNG 下载
 *   3) exportCSV    Pattern -> CSV 字符串（UTF-8 BOM，由调用方负责下载）
 *   4) legendHTML   Pattern -> 图例 HTML 片段
 *
 * viewOpts（全部可选）：
 *   cellPx          每格像素（4..256，默认 12）—— 导出放大由调用方给
 *   cellLabel       'code' 画真色号 A1/A10/M15 | 其余值（'none' 与历史值 'index'）一律不画
 *   showCodes       旧键：只在未给 cellLabel 时生效，true → 'code'，否则 → 'none'
 *   maxPixels       面积上限（正整数，可选）。移动端的画布上限远低于桌面，调用方用它按设备能力
 *                   收紧；给了更大的合法值即表示调用方明确要放宽（有回读校验兜底）。
 *                   非法值（0 / 负数 / 小数 / NaN / Infinity / 字符串 / null / undefined）
 *                   一律回落内置常量 MAX_CANVAS_PIXELS
 *   padMode         'tight'(默认) 白边约 4%，受刻度文字下限约束 | 'normal' 旧的 max(40, cellPx*3+20)
 *   annotate        true 时在网格下方追加用量块：每个色号一个「圆角色块 + 色号 + 颗数」的
 *                   行内块，按色号自然序（A1,A2..B1,B2..）排列，横向排布、自动换行、每行居中
 *   showRuler       默认 true，每 5 格一个刻度（29 格板边界额外补标）
 *   highlightLocked 默认 false，锁定的格子画一个角标
 *
 * 硬约束：
 *   - 只读 Pattern（不重排 colors、不改 cells、不改 counts）
 *   - 图纸画布永远是白底（可打印文档），深色主题只属于 UI
 *   - cells[i] === 65535 的格子零填色；越界下标一律跳过
 *   - 不逐格建渐变/阴影；颜色与文字色按色号预计算
 *   - 大画布先算面积再落笔：超过上限（opts.maxPixels 或内置 MAX_CANVAS_PIXELS）直接返回
 *     ok:false / 'too-large'（浏览器画布超限会静默空白，明确失败比空白好）
 *   - 「调用成功」不等于「效果生效」：设置完 canvas.width/height 立即回读实测，尺寸没生效或
 *     2d 上下文为空一律判失败（ok:false / 'canvas-rejected' 或 'invalid-input'），绝不落笔 ——
 *     否则用户得到一张看着成功、其实是纯白的 PNG
 *   - 无 import / export / require，全部通过 window.Render 挂载
 */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- 常量 */

  var EMPTY = 65535;         // cells 里的空格 / 不用豆标记
  var BOARD = 29;            // 一块拼豆板的边长（格）
  var MIN_CELL_PX = 4;
  var MAX_CELL_PX = 256;     // 导出倍率会放大格子；真正的护栏是 MAX_CANVAS_PIXELS
  var DEFAULT_CELL_PX = 12;
  var MIN_PAD = 40;          // padMode:'normal' 的刻度区最小边距（向后兼容）
  var MAX_CANVAS_PIXELS = 120000000;  // 约 1.2 亿像素（桌面上限）；移动端低得多，可用 opts.maxPixels 收紧
  var GRID_HALF = 0.5;       // 1px 线落在像素中心，避免糊边

  // 左下角角标：标题上限 24 字符（超出截到 23 + '…'）；时长按 viewOpts.beadRate 折算（UI 默认 500 颗/小时）
  var CAPTION_TITLE_MAX = 24;
  var CAPTION_FONT_MIN = 9;    // 角标字号下限；连它都放不下就不画（与「格内标签太小就不画」同原则）
  var CAPTION_FONT_MAX = 28;

  // 标签可读性：字号 = round(cellPx*0.42)，且必须同时满足「最小可读字号」与「装得下」
  var LABEL_FONT_RATIO = 0.42;
  var LABEL_FONT_MIN = 7;              // 字号落在这个区间之外就不画
  var LABEL_FONT_MAX = 40;
  var LABEL_MIN_READABLE_CODE = 8;     // 色号的最小可读字号（数字编号模式已删除，不再有第二档阈值）
  var LABEL_CHAR_W = 0.62;             // 等宽字体单字符宽度估算（相对字号）
  var LABEL_FIT = 0.9;                 // 文本宽度上限 = cellPx * 0.9（留 10% 余量）

  // 版式
  var PAD_TIGHT_RATIO = 0.02;          // tight：每边目标 2%（合计约 4%）
  var RULER_FONT_RATIO = 0.5;
  var RULER_FONT_MIN = 9;
  var RULER_FONT_MAX = 40;
  var ANNOTATE_FONT_RATIO = 0.45;

  var HEX_FULL = /^#[0-9a-fA-F]{6}$/;
  var HEX_SHORT = /^#[0-9a-fA-F]{3}$/;

  var FONT_SANS = 'system-ui, "Segoe UI", "Microsoft YaHei", sans-serif';
  var FONT_MONO = 'ui-monospace, "Cascadia Mono", "SFMono-Regular", Consolas, monospace';

  var C = {
    paper: '#FFFFFF',        // 纸底
    grid: '#DCE0E6',         // 细网格线
    board: '#39424F',        // 29 格板边界线（加粗）
    rulerLine: '#98A2B3',
    rulerText: '#5A6472',
    rulerBoardText: '#39424F',
    // 左下角角标专用色：**不与任何其它绘制复用**（rulerText / chipCount 仍是 #5A6472），
    // 好让测试能按颜色直接认出「这次 fillText 是角标」，不必再依赖易变的文字格式正则。
    // 同族中性灰、与旧值(rulerText)几乎不可分辨，不引入新色相。
    caption: '#616B7A',
    title: '#2B3240',
    chipBg: '#F5F7FA',       // 用量块底
    chipLine: '#DCE0E6',     // 用量块描边
    chipCount: '#5A6472',    // 用量块里的颗数文字
    swatchEdge: '#8A94A6'    // 色块描边
  };

  /* ------------------------------------------------------------ 小工具 */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function clampCellPx(v) {
    if (!isNum(v) || v <= 0) return DEFAULT_CELL_PX;
    return clamp(Math.round(v), MIN_CELL_PX, MAX_CELL_PX);
  }

  function isValidHex(v) { return typeof v === 'string' && (HEX_FULL.test(v) || HEX_SHORT.test(v)); }

  function textOf(v) { return (v === null || v === undefined) ? '' : String(v); }

  function safeHex(v) { return isValidHex(v) ? v : '#000000'; }

  // cellLabel 归一化为二值（只剩「画色号」与「不画」两种语义）：
  //   'code'                               → 'code'
  //   'none' / 历史值 'index' / 其它未知值  → 'none'（数字编号功能已删除，不再有第三种模式）
  //   缺省（未给 / null / 空串）            → 沿用旧键 showCodes：true → 'code'，否则 'none'
  function normCellLabel(o) {
    var v = o.cellLabel;
    if (v === 'code') return 'code';
    if (v !== undefined && v !== null && v !== '') return 'none';
    return o.showCodes === true ? 'code' : 'none';
  }

  // 角标标题：只认字符串，去首尾空白；非字符串 / 全空白 = 没有标题（整段省略）
  function normCaptionName(v) {
    if (typeof v !== 'string') return '';
    return v.trim();
  }

  // 角标时长：只有有限正数才算得出来；缺失 / 0 / 负数 / NaN / 字符串一律让「预计 X 小时」整段消失
  // （绝不输出 Infinity / NaN）。UI 侧未配置时应主动传 500 颗/小时，这是应用层默认值。
  function normBeadRate(v) {
    if (!isNum(v) || v <= 0) return 0;
    return v;
  }

  // 面积上限：调用方可按设备能力收紧（移动端画布上限远低于桌面，写死一个常量对本用例不利）。
  // 只有「有限正数且是整数」才算合法值；0 / 负数 / 小数 / NaN / Infinity / 字符串 / null / undefined
  // 一律回落内置常量 —— 未给该键与给了非法值的行为和返回值逐值一致。
  // 不向上夹到 MAX_CANVAS_PIXELS：给了更大的合法值就是调用方明确要放宽，而放宽是安全的，
  // 因为后面有回读校验兜底（尺寸真没生效就明确失败，不会退化成一张白图）。
  function normMaxPixels(v) {
    if (!isNum(v) || v <= 0 || Math.floor(v) !== v) return MAX_CANVAS_PIXELS;
    return v;
  }

  function normalizeOpts(viewOpts) {
    var o = viewOpts || {};
    return {
      cellLabel: normCellLabel(o),
      showCodes: o.showCodes !== false,             // 默认 true（仅用于向后兼容语义）
      padMode: o.padMode === 'normal' ? 'normal' : 'tight',   // 新默认 tight
      annotate: o.annotate === true,                // 默认 false
      showRuler: o.showRuler !== false,             // 默认 true
      cellPx: clampCellPx(o.cellPx),                // 默认 12，夹到 4..256
      highlightLocked: o.highlightLocked === true,  // 默认 false
      captionName: normCaptionName(o.captionName),  // 角标标题，默认没有
      beadRate: normBeadRate(o.beadRate),           // 角标折算速率（颗/小时）
      maxPixels: normMaxPixels(o.maxPixels)         // 面积上限：非法/缺省回落内置常量
    };
  }

  function hexToRgb(hex) {
    if (typeof hex !== 'string') return null;
    var s = hex, r, g, b;
    if (HEX_SHORT.test(s)) {
      r = parseInt(s.charAt(1) + s.charAt(1), 16);
      g = parseInt(s.charAt(2) + s.charAt(2), 16);
      b = parseInt(s.charAt(3) + s.charAt(3), 16);
      return [r, g, b];
    }
    if (HEX_FULL.test(s)) {
      return [parseInt(s.substr(1, 2), 16), parseInt(s.substr(3, 2), 16), parseInt(s.substr(5, 2), 16)];
    }
    return null;
  }

  // 色号文字颜色按色块亮度取反，保证任何色号上都看得见
  function textColorFor(hex) {
    var rgb = hexToRgb(hex);
    if (!rgb) return '#111827';
    var lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    return lum > 0.55 ? '#111827' : '#FFFFFF';
  }

  function escapeHTML(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function csvField(v) {
    var s = (v === null || v === undefined) ? '' : String(v);
    if (s.indexOf('"') >= 0 || s.indexOf(',') >= 0 || s.indexOf('\r') >= 0 || s.indexOf('\n') >= 0) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // 文本宽度估算：中日韩 / 全角按整字宽，其余按等宽 0.62 字宽
  function estTextW(text, fontPx) {
    var s = textOf(text), w = 0, i, cu;
    for (i = 0; i < s.length; i++) {
      cu = s.charCodeAt(i);
      w += cu > 0x2E80 ? fontPx : LABEL_CHAR_W * fontPx;
    }
    return w;
  }

  /* ------------------------------------------------- 标签：长度 / 可读性 */

  // 本图实际用到的色号扫描：最长色号长度从这里取，不写死
  function usedScan(pattern) {
    var colors = (pattern && pattern.colors) || [];
    var cells = (pattern && pattern.cells) || [];
    var n = colors.length;
    var w = Math.max(0, Math.floor((pattern && pattern.w) || 0));
    var h = Math.max(0, Math.floor((pattern && pattern.h) || 0));
    var total = Math.min(cells.length, w * h);
    var maxCodeLen = 0, used = 0, i, idx, code;
    for (i = 0; i < total; i++) {
      idx = cells[i];
      if (idx === EMPTY) continue;
      if (!isNum(idx) || idx < 0 || idx >= n) continue;
      used++;
      code = colors[idx] ? colors[idx].code : null;
      if (typeof code === 'string' || typeof code === 'number') {
        if (String(code).length > maxCodeLen) maxCodeLen = String(code).length;
      }
    }
    return { used: used, maxCodeLen: maxCodeLen };
  }

  // 该 cellPx 下能否画色号：约束 A（最小可读字号）+ 约束 B（装得下，留 10% 余量）
  // 注意顺序：B 判定必须在「夹到宽度上限」之前 —— 否则夹到上限后判定恒为等号，B 等于失效，
  // 长色号会被缩成蚂蚁字硬塞进格子（正是「画了等于没画」）。装不下就干脆不画。
  function labelFit(cellPx, len) {
    var exact = cellPx * LABEL_FONT_RATIO;
    if (exact < LABEL_FONT_MIN || exact > LABEL_FONT_MAX) return { draw: false, fontPx: 0 };
    if (exact < LABEL_MIN_READABLE_CODE) return { draw: false, fontPx: 0 };
    var fontPx = clamp(Math.round(exact), LABEL_FONT_MIN, LABEL_FONT_MAX);
    if (fontPx * LABEL_CHAR_W * len > cellPx * LABEL_FIT) return { draw: false, fontPx: 0 };
    var widthLimit = cellPx * LABEL_FIT / (LABEL_CHAR_W * len);   // 装得下所允许的最大字号
    if (fontPx > widthLimit) fontPx = widthLimit;                 // 兜底夹紧，绝不越出格子
    return { draw: true, fontPx: fontPx };
  }

  // 想画色号所需的最小 cellPx（供 UI 提示）：扫描出第一个真正画得出的格子尺寸
  function labelMinCellPx(len) {
    var c;
    for (c = MIN_CELL_PX; c <= MAX_CELL_PX; c++) {
      if (labelFit(c, len).draw) return c;
    }
    return MAX_CELL_PX + 1;    // 该文本长度下无解（例如 4 字以上色号装不进任何格子）
  }

  function labelStat(pattern, opts, scan) {
    if (opts.cellLabel !== 'code') {          // 已归一化为二值：这里就是 'none'
      return { len: 0, minPx: 0, fit: { draw: false, fontPx: 0 }, suppressed: false };
    }
    var len = scan.maxCodeLen > 0 ? scan.maxCodeLen : 1;   // 本图最长色号；没有色号时按 1 字算
    var fit = labelFit(opts.cellPx, len);
    return { len: len, minPx: labelMinCellPx(len), fit: fit, suppressed: !fit.draw };
  }

  /* ------------------------------------------------------------ 版式计算 */

  function rulerMetrics(cellPx) {
    var fontPx = clamp(Math.round(cellPx * RULER_FONT_RATIO), RULER_FONT_MIN, RULER_FONT_MAX);
    return { fontPx: fontPx, gap: Math.max(2, Math.round(fontPx * 0.35)) };
  }

  // tight：pad 目标 = 网格长边 * 2%，但下限必须放得下刻度线 + 刻度数字
  function padOf(opts, gridW, gridH, ruler, maxDigits) {
    if (opts.padMode !== 'tight') return Math.max(MIN_PAD, opts.cellPx * 3 + 20);
    var target = Math.round(Math.max(gridW, gridH) * PAD_TIGHT_RATIO);
    var minPad = Math.ceil(ruler.fontPx * 1.6) + 4;                                  // 刻度行高
    var needTop = ruler.gap + Math.ceil(ruler.fontPx * 0.78) + 2;                    // 上方数字（按 ascent 估）
    var needSide = ruler.gap + Math.ceil(LABEL_CHAR_W * ruler.fontPx * maxDigits) + 2; // 左侧数字宽度
    return Math.max(target, minPad, needTop, needSide);
  }

  // 色号自然序的比较器：组序**写死**为 A,B,C,D,E,F,G,H,M（不依赖字母表），组内按**数字**升序，
  // 所以 A9 排在 A10 之前（字符串比较恰好相反）。
  // 为什么不直接沿用 pattern.colors 的顺序：colors 是自然序只是**管线**的产物（Pipeline 里排过），
  // 一旦色号被 append / 重排（例如「改色」把新色号补到末尾），数组顺序就不再是自然序，
  // 而用户要的是「不管数据怎么来的，图上都按 A1,A2..B1,B2.. 排」。所以顺序必须现算。
  // 解析不出「组+数字」的色号（例如 T1 这类合成色号）：已知组排在前面；都不认识就按组名字符串比，
  // 最后按原字符串兜底 —— 保证任何输入下都是全序，顺序不随 sort 实现抖动。
  var CODE_GROUP_ORDER = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, M: 8 };

  function parseCode(code) {
    var s = textOf(code).trim();
    var m = /^([A-Za-z]+)\s*(\d+)$/.exec(s);
    if (m) {
      var g = m[1].toUpperCase();
      var known = Object.prototype.hasOwnProperty.call(CODE_GROUP_ORDER, g);
      return {
        known: known,
        rank: known ? CODE_GROUP_ORDER[g] : 0,
        group: g,
        num: parseInt(m[2], 10),
        text: s
      };
    }
    return { known: false, rank: 0, group: s.toUpperCase(), num: -1, text: s };
  }

  function compareCodes(a, b) {
    var pa = parseCode(a), pb = parseCode(b);
    if (pa.known && pb.known) {
      if (pa.rank !== pb.rank) return pa.rank - pb.rank;      // 组序
    } else if (pa.known !== pb.known) {
      return pa.known ? -1 : 1;                               // 已知组一律排在不认识的组之前
    } else if (pa.group !== pb.group) {
      return pa.group < pb.group ? -1 : 1;
    }
    if (pa.num !== pb.num) return pa.num - pb.num;            // 组内数字升序（A9 < A10）
    if (pa.group !== pb.group) return pa.group < pb.group ? -1 : 1;
    return pa.text < pb.text ? -1 : (pa.text > pb.text ? 1 : 0);
  }

  // 图上用量块（网格下方那排 chips）的顺序：**按色号自然序**（见上面的比较器）。
  // 颗数一律取自 pattern.counts（冻结契约：它按颗数降序，只当数据源、不当顺序来源）；
  // 0 颗 / 坏数据不进 chips（与 paintCells / tally 同一口径，不凭空造 0 颗的块）。
  // 右侧图例 legendHTML 与 exportCSV 不走这里，各自的顺序不变。
  function usageRows(pattern) {
    var counts = (pattern && pattern.counts) || null;
    var colors = (pattern && pattern.colors) || [];
    var rows = [], i, c, n;
    if (counts && counts.length) {
      for (i = 0; i < counts.length; i++) {
        c = counts[i] || {};
        n = Number(c.count);
        if (!isNum(n) || n <= 0) continue;                     // 0 颗 / 坏数据不进用量块
        rows.push({ code: c.code, hex: c.hex, count: n });
      }
      if (rows.length) {
        rows.sort(function (a, b) { return compareCodes(a.code, b.code); });
        return rows;
      }
    }
    // counts 缺失 / 全不可用时的兜底：现场统计，同样按自然序输出
    var t = tally(pattern);
    for (i = 0; i < colors.length; i++) {
      if (!t.perIndex[i]) continue;
      rows.push({ code: colors[i] && colors[i].code, hex: colors[i] && colors[i].hex, count: t.perIndex[i] });
    }
    rows.sort(function (a, b) { return compareCodes(a.code, b.code); });
    return rows;
  }

  // 网格下方用量块的版式：每个色号一个「圆角色块 + 色号 + 颗数」的行内块，横向排布、自动换行。
  // 尺寸只在这里算一次，绘制与面积守卫共用。
  function annotateLayout(pattern, opts, gridW) {
    var rows = usageRows(pattern);
    var gap = Math.max(2, Math.round(opts.cellPx * 0.5));
    if (!rows.length) {
      return { rows: rows, chips: [], lines: [], fontPx: 0, swatch: 0, chipPadX: 0, inner: 0,
        chipGapX: 0, chipGapY: 0, chipH: 0, chipR: 0, tableW: gridW, tableH: 0, gap: 0 };
    }

    var fontPx = clamp(Math.round(opts.cellPx * ANNOTATE_FONT_RATIO), 9, 40);
    var swatch = Math.max(10, Math.round(fontPx * 1.15));    // 圆角色块边长
    var padX = Math.max(7, Math.round(fontPx * 0.6));        // 块内左右留白
    var inner = Math.max(4, Math.round(fontPx * 0.45));      // 色块↔色号↔颗数 的间距
    var gapX = Math.max(6, Math.round(fontPx * 0.55));       // 块与块的横向间距
    var gapY = Math.max(6, Math.round(fontPx * 0.55));       // 行距
    var chipH = Math.max(Math.round(fontPx * 2.2), swatch + Math.round(fontPx * 0.7));
    var chipR = Math.max(3, Math.round(chipH * 0.3));        // 胶囊圆角半径

    var i, r, chip, chips = [], widest = 0;
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      chip = { code: textOf(r.code), hex: safeHex(r.hex), count: textOf(r.count) };
      chip.w = padX * 2 + swatch + inner + Math.ceil(estTextW(chip.code, fontPx))
        + inner + Math.ceil(estTextW(chip.count + ' 颗', fontPx));
      chips.push(chip);
      if (chip.w > widest) widest = chip.w;
    }

    // 换行容器：至少与网格同宽；单个块比网格还宽时以最宽的那个块为准
    var boxW = Math.max(gridW, widest);
    var lines = [], cur = [], curW = 0, need;
    for (i = 0; i < chips.length; i++) {
      need = cur.length ? curW + gapX + chips[i].w : chips[i].w;
      if (cur.length && need > boxW) { lines.push({ items: cur, w: curW }); cur = []; curW = 0; need = chips[i].w; }
      cur.push(chips[i]);
      curW = need;
    }
    if (cur.length) lines.push({ items: cur, w: curW });
    var lineCount = lines.length;

    return {
      rows: rows,
      chips: chips,
      lines: lines,
      fontPx: fontPx,
      swatch: swatch,
      chipPadX: padX,
      inner: inner,
      chipGapX: gapX,
      chipGapY: gapY,
      chipH: chipH,
      chipR: chipR,
      tableW: boxW,
      tableH: lineCount * chipH + (lineCount - 1) * gapY,
      gap: gap
    };
  }

  // 非空格子的包围盒与颗数：cells 是唯一真源（绝不读 stats，否则角标会与图纸对不上）
  // 判定口径与 usedScan / paintCells 对齐：空格跳过、越界下标跳过、只扫 w*h 以内的格子
  function cellsExtent(pattern) {
    var colors = (pattern && pattern.colors) || [];
    var cells = (pattern && pattern.cells) || [];
    var w = Math.max(0, Math.floor((pattern && pattern.w) || 0));
    var h = Math.max(0, Math.floor((pattern && pattern.h) || 0));
    if (!w || !h) return null;
    var n = colors.length;
    var total = Math.min(cells.length, w * h);
    var minX = w, minY = h, maxX = -1, maxY = -1, count = 0, i, idx, x, y;
    for (i = 0; i < total; i++) {
      idx = cells[i];
      if (idx === EMPTY) continue;
      if (!isNum(idx) || idx < 0 || idx >= n) continue;
      x = i % w;
      y = Math.floor(i / w);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      count++;
    }
    if (!count) return null;                       // 一颗都没有 → 没有角标
    return {
      minX: minX, minY: minY, maxX: maxX, maxY: maxY,
      bw: maxX - minX + 1, bh: maxY - minY + 1, count: count
    };
  }

  // 标题截断：按码点切（不切坏代理对）；超过上限就留 23 个字符 + '…'
  function captionTitle(v) {
    if (typeof v !== 'string') return '';
    var s = v.trim();
    if (!s) return '';
    var cp = Array.from(s);
    if (cp.length <= CAPTION_TITLE_MAX) return s;
    return cp.slice(0, CAPTION_TITLE_MAX - 1).join('') + '…';
  }

  // 时长段：不足 1 小时按分钟显示 —— `预计 0.0 小时` 是没有意义的数字，而小挂件正是这种工具的常见用途；
  // 四舍五入到 0 分钟同样没意义，所以最少显示 1 分钟。
  // 收口：不足 1 小时但四舍五入后已满 60 分钟 → 一律写 `1.0 小时`（60 分钟就是 1 小时，不做两种写法）。
  // rate 非法时 normBeadRate 已返回 0 → 整段省略。
  function captionTime(count, rate) {
    if (!(rate > 0)) return '';
    var hrs = count / rate;
    var mins = Math.round(hrs * 60);
    if (hrs < 1 && mins < 60) return '预计 ' + Math.max(1, mins) + ' 分钟';
    return '预计 ' + hrs.toFixed(1) + ' 小时';
  }

  // 角标候选阶梯（从全到简，去重后按此序）：先掉信息，最后才不画。
  //   C1 标题 + 实际 a×b 格 · 共 N 颗 · 预计 X 小时（rate 非法时退化为 C2）
  //   C2      实际 a×b 格 · 共 N 颗 · 预计 X 小时   ← 先掉标题
  //   C3      实际 a×b 格 · 共 N 颗                 ← 再掉时长
  //   C4      共 N 颗                               ← 再掉尺寸（颗数是最后幸存者）
  // 损失次序的原则：标题是用户自己提供、能自己改短的数据；尺寸/颗数/时长是程序算出来的事实。
  // 空间不足时先扔用户可控的那一段，所以「掉标题」早于「掉时长」。
  // 标题只保留「完整（仍受 24 字上限截断）」或「整段去掉」两种：截断名没有辨识价值。
  function captionCandidates(ext, opts) {
    var o = opts || {};
    var title = captionTitle(o.captionName);
    var sizeText = '实际 ' + ext.bw + '×' + ext.bh + ' 格';
    var countText = '共 ' + ext.count + ' 颗';
    var brief = sizeText + ' · ' + countText;
    var rate = normBeadRate(o.beadRate);              // 非法速率 → 0 → 没有时长段
    var timeText = captionTime(ext.count, rate);
    var full = timeText ? brief + ' · ' + timeText : brief;
    var list = [], out = [], seen = {}, i, s;
    list.push(title ? title + ' · ' + full : full);   // C1
    list.push(full);                                  // C2（掉标题，保时长）
    list.push(brief);                                 // C3（掉时长）
    list.push(countText);                             // C4（只留颗数）
    for (i = 0; i < list.length; i++) {
      s = list[i];
      if (!seen[s]) { seen[s] = 1; out.push(s); }
    }
    return out;
  }

  // 自适应角标：**绝不撑宽画布**，只在给定可用内宽里收缩。
  // 顺序固定：字号从自然值降到 CAPTION_FONT_MIN(9)，每个字号档内按 C1→C4 依次试第一个放得下的；
  // 所有字号档都不行 → 整条不画（text/h 全 0，不留空白带）。
  // 先保字号（大字号比一个被截断的名字有价值），所以「宁可掉标题/掉时长，也不轻易缩字号」。
  // 每一档都满足 estTextW(text, fontPx) <= availW，所以文字永远不会画到画布外。
  function captionFit(pattern, opts, availW) {
    var blank = { text: '', fontPx: 0, top: 0, h: 0, drawn: false };
    var ext = cellsExtent(pattern);
    if (!ext) return blank;                           // 一颗都没有 → 没有角标
    var cands = captionCandidates(ext, opts);
    var nat = clamp(Math.round(opts.cellPx * 0.45), CAPTION_FONT_MIN, CAPTION_FONT_MAX);
    var top = Math.max(4, Math.round(opts.cellPx * 0.35));
    var f, i;
    for (f = nat; f >= CAPTION_FONT_MIN; f--) {
      for (i = 0; i < cands.length; i++) {
        if (estTextW(cands[i], f) <= availW) {
          return {
            text: cands[i],
            fontPx: f,
            top: top,
            h: top + f + Math.max(3, Math.round(f * 0.35)),
            drawn: true
          };
        }
      }
    }
    return blank;
  }

  function layoutOf(pattern, opts) {
    var w = Math.max(0, Math.floor((pattern && pattern.w) || 0));
    var h = Math.max(0, Math.floor((pattern && pattern.h) || 0));
    var cellPx = opts.cellPx;
    var gridW = w * cellPx, gridH = h * cellPx;
    var ruler = rulerMetrics(cellPx);
    var maxDigits = String(Math.max(w, h, 1)).length;
    var pad = padOf(opts, gridW, gridH, ruler, maxDigits);
    var table = opts.annotate ? annotateLayout(pattern, opts, gridW) : null;
    // 内容宽只看网格与用量块：角标**绝不参与** contentW/width（hitTestCell 依赖 width - w*cellPx 反推 pad）
    var contentW = Math.max(gridW, table ? table.tableW : 0);
    var gridDX = Math.round((contentW - gridW) / 2);          // 表格更宽时网格整体居中
    if (table) {
      table.dx = Math.round((contentW - table.tableW) / 2);   // 相对网格原点
      table.dy = gridH + table.gap;                            // 表格在网格下方，绝不重叠
    }
    var width = pad * 2 + contentW;
    // 角标可用内宽 = 从角标左边缘(pad+gridDX)到画布右边缘再留一个 pad。
    // gridDX = 0（无更宽的用量块）时它就等于 width - 2*pad = contentW。
    var availW = Math.max(0, contentW - gridDX);
    var cap = captionFit(pattern, opts, availW);
    return {
      w: w,
      h: h,
      cellPx: cellPx,
      pad: pad,
      gridW: gridW,
      gridH: gridH,
      contentW: contentW,
      gridDX: gridDX,
      rulerFontPx: ruler.fontPx,
      rulerGap: ruler.gap,
      table: table,
      caption: cap,
      width: width,
      height: pad * 2 + gridH + (table ? table.gap + table.tableH : 0) + cap.h
    };
  }

  // 板边界位置：29, 58, 87 …；末格外框也补一条（它同样是板的边）
  function boardPositions(n) {
    var out = [], k;
    for (k = BOARD; k <= n; k += BOARD) out.push(k);
    if (n > 0 && out[out.length - 1] !== n) out.push(n);
    return out;
  }

  // 刻度文字位置：恒定每 5 格一个数字（与 cellPx 无关）；29 的板边界额外补标（重合时只标一次）
  function rulerPositions(n) {
    var boards = boardPositions(n), boardSet = {}, seen = {}, out = [], i, k;
    for (i = 0; i < boards.length; i++) boardSet[boards[i]] = 1;
    for (k = 5; k <= n; k += 5) {
      seen[k] = 1;
      out.push({ at: k, board: boardSet[k] === 1 });
    }
    for (i = 0; i < boards.length; i++) {
      k = boards[i];
      if (!seen[k]) { seen[k] = 1; out.push({ at: k, board: true }); }
    }
    out.sort(function (a, b) { return a.at - b.at; });
    return out;
  }

  /* --------------------------------------------------------------- 统计 */

  // 从 cells 统计每个色号下标的颗数（cells 是唯一真源，保证与图纸一致）
  function tally(pattern) {
    var colors = (pattern && pattern.colors) || [];
    var cells = (pattern && pattern.cells) || [];
    var n = colors.length;
    var arr = [], i, idx, total = 0;
    for (i = 0; i < n; i++) arr.push(0);
    for (i = 0; i < cells.length; i++) {
      idx = cells[i];
      if (idx === EMPTY) continue;                       // 空格
      if (!isNum(idx) || idx < 0 || idx >= n) continue;   // 越界 / 坏数据
      arr[idx]++;
      total++;
    }
    return { perIndex: arr, total: total };
  }

  /* ------------------------------------------------------------- 绘制：格 */

  // 每个色号只算一次 hex / 文字色，避免逐格解析与逐格建样式
  function paletteCache(pattern) {
    var colors = (pattern && pattern.colors) || [];
    var hexes = [], inks = [], n = colors.length, i, hex;
    for (i = 0; i < n; i++) {
      hex = colors[i] && isValidHex(colors[i].hex) ? colors[i].hex : null;
      hexes.push(hex);
      inks.push(textColorFor(colors[i] && colors[i].hex));
    }
    return { hexes: hexes, inks: inks };
  }

  function cellPos(i, w, cellPx, ox, oy) {
    return [ox + (i % w) * cellPx, oy + Math.floor(i / w) * cellPx];
  }

  function paintCells(ctx, pattern, opts, lay, ox, oy, pal) {
    var cells = (pattern && pattern.cells) || [];
    var locked = (pattern && pattern.locked) || null;
    var hexes = pal.hexes, inks = pal.inks;
    var n = hexes.length;
    var cellPx = lay.cellPx;
    var total = Math.min(cells.length, lay.w * lay.h);
    var i, idx, p, x, y, s;
    var drawn = 0, markers = 0;

    for (i = 0; i < total; i++) {
      idx = cells[i];
      if (idx === EMPTY) continue;
      if (!isNum(idx) || idx < 0 || idx >= n) continue;
      if (!hexes[idx]) continue;
      p = cellPos(i, lay.w, cellPx, ox, oy);
      ctx.fillStyle = hexes[idx];
      ctx.fillRect(p[0], p[1], cellPx, cellPx);
      drawn++;
    }

    if (opts.highlightLocked && locked && locked.length) {
      s = Math.max(3, Math.round(cellPx * 0.28));
      for (i = 0; i < total; i++) {
        idx = cells[i];
        if (idx === EMPTY) continue;
        if (!isNum(idx) || idx < 0 || idx >= n) continue;
        if (locked[i] !== 1) continue;
        p = cellPos(i, lay.w, cellPx, ox, oy);
        x = p[0]; y = p[1];
        ctx.fillStyle = inks[idx];
        ctx.beginPath();
        ctx.moveTo(x + cellPx, y + 0.5);          // 右上角小三角
        ctx.lineTo(x + cellPx, y + s + 0.5);
        ctx.lineTo(x + cellPx - s, y + 0.5);
        ctx.closePath();
        ctx.fill();
        markers++;
      }
    }

    return { cellsDrawn: drawn, markers: markers };
  }

  function paintGrid(ctx, pattern, lay, ox, oy) {
    var w = lay.w, h = lay.h, cellPx = lay.cellPx, i, x, y, k, vb, hb;

    // 细网格线：一次成路径、一次 stroke（性能）
    ctx.beginPath();
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    for (i = 0; i <= w; i++) {
      x = ox + i * cellPx + GRID_HALF;
      ctx.moveTo(x, oy + GRID_HALF);
      ctx.lineTo(x, oy + lay.gridH + GRID_HALF);
    }
    for (i = 0; i <= h; i++) {
      y = oy + i * cellPx + GRID_HALF;
      ctx.moveTo(ox + GRID_HALF, y);
      ctx.lineTo(ox + lay.gridW + GRID_HALF, y);
    }
    ctx.stroke();

    // 29 格板边界：每一条单独成路径并单独 stroke，便于数清也便于后续调线型
    vb = boardPositions(w);
    hb = boardPositions(h);
    ctx.strokeStyle = C.board;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'butt';
    for (k = 0; k < vb.length; k++) {
      x = ox + vb[k] * cellPx;
      ctx.beginPath();
      ctx.moveTo(x, oy - 2);
      ctx.lineTo(x, oy + lay.gridH + 2);
      ctx.stroke();
    }
    for (k = 0; k < hb.length; k++) {
      y = oy + hb[k] * cellPx;
      ctx.beginPath();
      ctx.moveTo(ox - 2, y);
      ctx.lineTo(ox + lay.gridW + 2, y);
      ctx.stroke();
    }
    return { v: vb.length, h: hb.length };
  }

  // 逐格标签：只写真色号（A1/A10/M15）。数字编号模式已删除，本函数只服务 'code' 一种模式。
  function paintCodes(ctx, pattern, lay, ox, oy, fit, pal) {
    var colors = (pattern && pattern.colors) || [];
    var cells = (pattern && pattern.cells) || [];
    var hexes = pal.hexes, inks = pal.inks;
    var n = hexes.length;
    var cellPx = lay.cellPx;
    var total = Math.min(cells.length, lay.w * lay.h);
    var texts = [], i, idx, p, code, drawn = 0;

    for (i = 0; i < colors.length; i++) {
      code = colors[i] ? colors[i].code : null;
      texts.push((typeof code === 'string' || typeof code === 'number') && String(code) !== '' ? String(code) : null);
    }

    ctx.font = '600 ' + fit.fontPx + 'px ' + FONT_MONO;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (i = 0; i < total; i++) {
      idx = cells[i];
      if (idx === EMPTY) continue;
      if (!isNum(idx) || idx < 0 || idx >= n) continue;
      if (!hexes[idx] || !texts[idx]) continue;         // 没填色的格子不写标签
      p = cellPos(i, lay.w, cellPx, ox, oy);
      ctx.fillStyle = inks[idx];
      ctx.fillText(texts[idx], p[0] + cellPx / 2, p[1] + cellPx / 2 + 0.5);
      drawn++;
    }
    return drawn;
  }

  function paintRuler(ctx, lay, ox, oy) {
    var w = lay.w, h = lay.h, cellPx = lay.cellPx;
    var size = lay.rulerFontPx;
    var gap = lay.rulerGap;
    var long = Math.max(7, Math.round(size * 0.9));
    var short = Math.max(4, Math.round(size * 0.5));
    var pos, i, k, x, y, len;

    // 刻度线
    ctx.strokeStyle = C.rulerLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    pos = rulerPositions(w);
    for (i = 0; i < pos.length; i++) {
      k = pos[i].at;
      len = (k % 10 === 0 || pos[i].board) ? long : short;
      x = ox + k * cellPx + GRID_HALF;
      ctx.moveTo(x, oy - GRID_HALF);
      ctx.lineTo(x, oy - len);
    }
    pos = rulerPositions(h);
    for (i = 0; i < pos.length; i++) {
      k = pos[i].at;
      len = (k % 10 === 0 || pos[i].board) ? long : short;
      y = oy + k * cellPx + GRID_HALF;
      ctx.moveTo(ox - GRID_HALF, y);
      ctx.lineTo(ox - len, y);
    }
    ctx.stroke();

    // 刻度数字：每 5 格一个（外加 29 的板边界），恒定，不随 cellPx 变密
    ctx.font = size + 'px ' + FONT_SANS;
    pos = rulerPositions(w);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (i = 0; i < pos.length; i++) {
      k = pos[i].at;
      ctx.fillStyle = pos[i].board ? C.rulerBoardText : C.rulerText;
      ctx.fillText(String(k), ox + k * cellPx, oy - gap);
    }
    pos = rulerPositions(h);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (i = 0; i < pos.length; i++) {
      k = pos[i].at;
      ctx.fillStyle = pos[i].board ? C.rulerBoardText : C.rulerText;
      ctx.fillText(String(k), ox - gap, oy + k * cellPx);
    }
  }

  /* ------------------------------------------------------- 绘制：用量块 */

  // 圆角矩形路径：优先用原生 roundRect（现代浏览器）；旧环境退回直角，不报错
  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, w, h, r); return; }
    ctx.rect(x, y, w, h);
  }

  // 单个用量块：圆角色块 + 色号 + 颗数
  function paintChip(ctx, chip, x, y, t) {
    var f = t.fontPx, h = t.chipH, mid = y + h / 2;
    var sx = x + t.chipPadX, sy = mid - t.swatch / 2;
    var sr = Math.max(2, Math.round(t.swatch * 0.3));
    var tx;

    ctx.fillStyle = C.chipBg;
    roundRectPath(ctx, x, y, chip.w, h, t.chipR);
    ctx.fill();
    ctx.strokeStyle = C.chipLine;
    ctx.lineWidth = 1;
    roundRectPath(ctx, x + GRID_HALF, y + GRID_HALF, chip.w, h, t.chipR);
    ctx.stroke();

    ctx.fillStyle = chip.hex;
    roundRectPath(ctx, sx, sy, t.swatch, t.swatch, sr);
    ctx.fill();
    ctx.strokeStyle = C.swatchEdge;
    ctx.lineWidth = 1;
    roundRectPath(ctx, sx + GRID_HALF, sy + GRID_HALF, t.swatch, t.swatch, sr);
    ctx.stroke();

    tx = sx + t.swatch + t.inner;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = C.title;
    ctx.font = '600 ' + f + 'px ' + FONT_MONO;
    ctx.fillText(chip.code, tx, mid);
    tx += Math.ceil(estTextW(chip.code, f)) + t.inner;
    ctx.fillStyle = C.chipCount;
    ctx.font = f + 'px ' + FONT_SANS;
    ctx.fillText(chip.count + ' 颗', tx, mid);
  }

  // 横向排布、每行居中；返回画出的块数
  function paintTable(ctx, lay, ox, oy) {
    var t = lay.table;
    if (!t || !t.lines || !t.lines.length) return 0;
    var x0 = ox + t.dx, y0 = oy + t.dy;
    var drawn = 0, li, ci, line, cx, cy;
    for (li = 0; li < t.lines.length; li++) {
      line = t.lines[li];
      cx = x0 + Math.round((t.tableW - line.w) / 2);
      cy = y0 + li * (t.chipH + t.chipGapY);
      for (ci = 0; ci < line.items.length; ci++) {
        paintChip(ctx, line.items[ci], cx, cy, t);
        cx += line.items[ci].w + t.chipGapX;
        drawn++;
      }
    }
    return drawn;
  }

  /* --------------------------------------------------- 绘制：图纸（核心） */

  // 在 (ox, oy) = 网格左上角处绘制一张完整图纸；调用方负责白底与画布尺寸
  function paintPatternAt(ctx, pattern, opts, lay, ox, oy, stat) {
    var pal = paletteCache(pattern);
    var res = paintCells(ctx, pattern, opts, lay, ox, oy, pal);
    paintGrid(ctx, pattern, lay, ox, oy);
    var labels = 0;
    if (stat && stat.fit && stat.fit.draw) labels = paintCodes(ctx, pattern, lay, ox, oy, stat.fit, pal);
    if (opts.showRuler) paintRuler(ctx, lay, ox, oy);
    if (lay.table) paintTable(ctx, lay, ox, oy);
    return { cellsDrawn: res.cellsDrawn, markers: res.markers, labelsDrawn: labels };
  }

  function fillPaper(ctx, w, h) {
    ctx.fillStyle = C.paper;
    ctx.fillRect(0, 0, w, h);
  }

  // 冻结的返回契约（app.js 依赖）：codesDrawn 是 labelsDrawn 的向后兼容别名
  function makeResult(o) {
    var r = {
      ok: o.ok === true,
      cellsDrawn: o.cellsDrawn || 0,
      labelsDrawn: o.labelsDrawn === true,
      labelsSuppressed: o.labelsSuppressed === true,
      labelMinPx: o.labelMinPx || 0,
      width: o.width || 0,
      height: o.height || 0,
      captionDrawn: o.captionDrawn === true          // 本次是否真的画了角标（放不下 → false）
    };
    if (o.reason) r.reason = o.reason;
    if (o.needPixels !== undefined) {
      r.needPixels = o.needPixels;
      r.maxPixels = o.maxPixels;
    }
    r.codesDrawn = r.labelsDrawn;
    return r;
  }

  /* ------------------------------------------------------------- 公开 API */

  /* --------------------------------------------- 绘制：左下角尺寸标注 */

  function paintCaption(ctx, lay) {
    var cap = lay.caption;
    if (!cap || !cap.drawn || !cap.text) return;    // 放不下就不画（h 也是 0，不留空白带）
    var blockTop = lay.pad + lay.gridH + (lay.table ? lay.table.gap + lay.table.tableH : 0);
    ctx.fillStyle = C.caption;
    ctx.font = cap.fontPx + 'px ' + FONT_SANS;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(cap.text, lay.pad + lay.gridDX, blockTop + cap.top);
  }

  function drawPattern(pattern, canvas, viewOpts) {
    var opts = normalizeOpts(viewOpts);
    var stat = labelStat(pattern, opts, usedScan(pattern));
    var base = {
      cellsDrawn: 0, labelsDrawn: false, labelMinPx: stat.minPx,
      labelsSuppressed: stat.suppressed, width: 0, height: 0
    };

    if (!pattern || !canvas || typeof canvas.getContext !== 'function') {
      base.ok = false; base.reason = 'invalid-input';
      return makeResult(base);
    }

    var lay = layoutOf(pattern, opts);
    var need = lay.width * lay.height;
    var maxPixels = opts.maxPixels;
    base.width = lay.width;
    base.height = lay.height;

    // 面积守卫：先算后画；超限时连画布尺寸都不设置，避免浏览器静默空白
    if (!(need <= maxPixels)) {
      base.ok = false;
      base.reason = 'too-large';
      base.width = lay.width;
      base.height = lay.height;
      base.needPixels = need;
      base.maxPixels = maxPixels;
      return makeResult(base);
    }

    canvas.width = lay.width;
    canvas.height = lay.height;

    /* 回读校验：「调用成功」不等于「效果生效」。
     * canvas.width/height 只是**赋了个值**。移动端（iOS Safari / WKWebView、部分 Android WebView）
     * 对超限面积会**静默拒绝**：赋值不抛错、回读却仍是旧值（或 0）。照旧一路画下去的话，
     * 所有绘制都落进一块尺寸并非我们所求的画布，返回值却是 ok:true —— 用户拿到一张纯白 PNG，
     * 而所有「调用没报错」的验收都是绿的。所以落笔前必须回读实测值：逐值相等才算尺寸生效。
     * reason 用 'canvas-rejected'，与 'too-large' 严格区分：too-large 是**我们的面积预算**在分配前
     * 拒绝（needPixels > maxPixels），canvas-rejected 是**浏览器拒绝**了我们合法申请的那块画布
     * （needPixels <= maxPixels）。调用方的处置完全不同，消息也不能互相冒充。
     * 这条路一笔都不落（fillRect/fillText/stroke 全 0），但如实报告计划尺寸与像素量供 UI 提示。 */
    if (canvas.width !== lay.width || canvas.height !== lay.height) {
      base.ok = false;
      base.reason = 'canvas-rejected';
      base.width = lay.width;
      base.height = lay.height;
      base.needPixels = need;
      base.maxPixels = maxPixels;
      return makeResult(base);
    }

    var ctx = canvas.getContext('2d');
    if (!ctx) {
      /* 尺寸生效但 2d 上下文为空：这块 canvas 不是可用的绘图面。
       * 沿用既有语义（'invalid-input' + width/height 0）：与「宿主没给 getContext 方法」同一类
       * 调用方输入问题，保持既有分支逐值不变；它同样在落笔前返回，绝不会产出白图。 */
      base.ok = false; base.reason = 'invalid-input';
      base.width = 0; base.height = 0;
      return makeResult(base);
    }

    ctx.save();
    fillPaper(ctx, lay.width, lay.height);
    var res = paintPatternAt(ctx, pattern, opts, lay, lay.pad + lay.gridDX, lay.pad, stat);
    paintCaption(ctx, lay);
    ctx.restore();

    base.ok = true;
    base.cellsDrawn = res.cellsDrawn;
    base.labelsDrawn = res.labelsDrawn > 0;
    base.labelsSuppressed = stat.suppressed && res.cellsDrawn > 0;
    base.labelMinPx = stat.minPx;
    base.captionDrawn = lay.caption.drawn === true;
    return makeResult(base);
  }

  function exportPNG(canvas, filename) {
    return new Promise(function (resolve, reject) {
      if (!canvas || typeof canvas.toBlob !== 'function') {
        reject(new Error('exportPNG：传入的 canvas 不支持 toBlob()'));
        return;
      }
      var name = (filename === null || filename === undefined || filename === '') ? 'pattern.png' : String(filename);

      canvas.toBlob(function (blob) {
        if (!blob) {
          reject(new Error('exportPNG：canvas.toBlob() 返回 null，导出失败（画布过大或上下文已丢失）'));
          return;
        }
        var url = null;
        var U = hostURL();
        try {
          if (!U) throw new Error('exportPNG：当前环境不支持 URL.createObjectURL()');
          var D = hostDocument();
          if (!D) throw new Error('exportPNG：当前环境缺少 document，无法触发下载');
          url = U.createObjectURL(blob);
          var a = D.createElement('a');
          a.href = url;
          a.download = name;
          a.rel = 'noopener';
          if (a.style) a.style.display = 'none';
          D.body.appendChild(a);
          a.click();
          D.body.removeChild(a);
        } catch (err) {
          revokeURL(U, url);
          reject(err);
          return;
        }
        // 延迟回收：个别浏览器在下载真正启动前还需要这个 URL 有效
        var later = hostSetTimeout();
        if (later) {
          later(function () { revokeURL(U, url); }, 1000);
        } else {
          revokeURL(U, url);
        }
        resolve();
      }, 'image/png');
    });
  }

  function revokeURL(U, url) {
    if (!U || !url) return;
    try { U.revokeObjectURL(url); } catch (e) { /* 回收失败不影响导出结果 */ }
  }

  /* 宿主对象解析：浏览器里裸 URL / document / setTimeout 与 window.X 是同一份，
   * 但桩环境、沙箱可能只提供其中一份，两份都取，避免把“环境差异”误判成“不支持导出”。 */
  function hostURL() {
    var bare = (typeof URL !== 'undefined') ? URL : null;
    if (bare && typeof bare.createObjectURL === 'function') return bare;
    var w = window.URL;
    return (w && typeof w.createObjectURL === 'function') ? w : null;
  }

  function hostDocument() {
    var d = (typeof document !== 'undefined') ? document : null;
    if (!d) d = window.document;
    return (d && d.body && typeof d.createElement === 'function') ? d : null;
  }

  function hostSetTimeout() {
    if (typeof setTimeout === 'function') return setTimeout;
    return (typeof window.setTimeout === 'function') ? window.setTimeout : null;
  }

  function exportCSV(pattern) {
    var colors = (pattern && pattern.colors) || [];
    var t = tally(pattern);
    var lines = [];
    var i, c, rgb, hex, r, g, b;

    lines.push(['编号', '色号', '颜色名', 'HEX', 'R', 'G', 'B', '颗数'].map(csvField).join(','));

    for (i = 0; i < colors.length; i++) {
      if (!t.perIndex[i]) continue;                  // 本图没用到就不列
      c = colors[i] || {};
      hex = typeof c.hex === 'string' ? c.hex : '';
      rgb = (c.rgb && c.rgb.length >= 3) ? c.rgb : (hexToRgb(hex) || []);
      r = rgb.length >= 3 ? rgb[0] : '';
      g = rgb.length >= 3 ? rgb[1] : '';
      b = rgb.length >= 3 ? rgb[2] : '';
      lines.push([i + 1, c.code, '', hex, r, g, b, t.perIndex[i]].map(csvField).join(','));
    }

    lines.push(['合计', '', '', '', '', '', '', t.total].map(csvField).join(','));
    return '\uFEFF' + lines.join('\r\n') + '\r\n';   // BOM + CRLF（Excel 友好）
  }

  function legendHTML(pattern) {
    var colors = (pattern && pattern.colors) || [];
    var t = tally(pattern);
    var rows = [];
    var i, c, code, raw, hex, count;

    for (i = 0; i < colors.length; i++) {
      count = t.perIndex[i];
      if (!count) continue;
      c = colors[i] || {};
      code = c.code === null || c.code === undefined ? '' : String(c.code);
      raw = typeof c.hex === 'string' ? c.hex : '';
      hex = (HEX_FULL.test(raw) || HEX_SHORT.test(raw)) ? raw : '#000000';  // 只放行合法色值，防注入
      rows.push(
        '<div class="pd-legend-row" style="display:flex;align-items:center;gap:8px;padding:2px 0;line-height:1.4">' +
          '<span class="pd-legend-no" style="min-width:2.5em;text-align:right;font-variant-numeric:tabular-nums">' + (i + 1) + '</span>' +
          '<span class="pd-legend-swatch" style="display:inline-block;width:16px;height:16px;border-radius:3px;border:1px solid rgba(0,0,0,.28);background-color:' + hex + '"></span>' +
          '<span class="pd-legend-code" style="min-width:3.2em;font-weight:600">' + escapeHTML(code) + '</span>' +
          '<span class="pd-legend-hex" style="opacity:.75;font-variant-numeric:tabular-nums">' + escapeHTML(hex) + '</span>' +
          '<span class="pd-legend-count" style="margin-left:auto;font-variant-numeric:tabular-nums">' + count + ' 颗</span>' +
        '</div>'
      );
    }
    return rows.join('\n');
  }

  /* --------------------------------------------------------------- 挂载 */

  window.Render = {
    drawPattern: drawPattern,
    exportPNG: exportPNG,
    exportCSV: exportCSV,
    legendHTML: legendHTML
  };
})();
