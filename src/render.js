/*!
 * src/render.js —— 拼豆图纸渲染层（零依赖 / 零外部资源）
 *
 * 职责：
 *   1) drawPattern  把 Pattern 画成可打印的白底图纸（网格 + 29 格板边界 + 刻度 + 色号标签 + 可选用量表）
 *   2) drawCompare  原图 / 图纸 等高并排对照
 *   3) exportPNG    canvas -> PNG 下载
 *   4) exportCSV    Pattern -> CSV 字符串（UTF-8 BOM，由调用方负责下载）
 *   5) legendHTML   Pattern -> 图例 HTML 片段
 *
 * viewOpts（全部可选）：
 *   cellPx          每格像素（4..256，默认 12）—— 导出放大由调用方给
 *   cellLabel       'code'(默认) 画真色号 A1/A10/M15 | 'index' 画图纸编号 | 'none' 不画
 *   showCodes       旧键：false 等价于 cellLabel:'none'；true 且未给 cellLabel 时视为 'index'
 *   padMode         'tight'(默认) 白边约 4%，受刻度文字下限约束 | 'normal' 旧的 max(40, cellPx*3+20)
 *   annotate        true 时在网格下方追加「色号 | 色块 | HEX | 颗数」用量表
 *   showRuler       默认 true，每 5 格一个刻度（29 格板边界额外补标）
 *   highlightLocked 默认 false，锁定的格子画一个角标
 *
 * 硬约束：
 *   - 只读 Pattern（不重排 colors、不改 cells、不改 counts）
 *   - 图纸画布永远是白底（可打印文档），深色主题只属于 UI
 *   - cells[i] === 65535 的格子零填色；越界下标一律跳过
 *   - 不逐格建渐变/阴影；颜色与文字色按色号预计算
 *   - 大画布先算面积再落笔：超过 MAX_CANVAS_PIXELS 直接返回 ok:false
 *     （浏览器画布超限会静默空白，明确失败比空白好）
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
  var MAX_CANVAS_PIXELS = 120000000;  // 约 1.2 亿像素，超出即拒绝绘制
  var GRID_HALF = 0.5;       // 1px 线落在像素中心，避免糊边

  // 标签可读性：字号 = round(cellPx*0.42)，且必须同时满足「最小可读字号」与「装得下」
  var LABEL_FONT_RATIO = 0.42;
  var LABEL_FONT_MIN = 7;              // 字号落在这个区间之外就不画
  var LABEL_FONT_MAX = 40;
  var LABEL_MIN_READABLE = { code: 8, index: 7 };
  var LABEL_CHAR_W = 0.62;             // 等宽字体单字符宽度估算（相对字号）
  var LABEL_FIT = 0.9;                 // 文本宽度上限 = cellPx * 0.9（留 10% 余量）

  // 版式
  var PAD_TIGHT_RATIO = 0.02;          // tight：每边目标 2%（合计约 4%）
  var RULER_FONT_RATIO = 0.5;
  var RULER_FONT_MIN = 9;
  var RULER_FONT_MAX = 40;
  var ANNOTATE_FONT_RATIO = 0.45;
  var TABLE_HEAD = ['色号', '色块', 'HEX', '颗数'];

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
    title: '#2B3240',
    placeholder: '#EEF1F5',
    placeholderText: '#8A94A6',
    tableHead: '#EEF1F5',    // 用量表表头底
    tableLine: '#DCE0E6',    // 用量表分隔线
    tableBorder: '#98A2B3',  // 用量表外框
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

  // 旧键 showCodes 与新键 cellLabel 的兼容规则：cellLabel 优先
  function normCellLabel(o) {
    var v = o.cellLabel;
    if (v === 'code' || v === 'index' || v === 'none') return v;
    if (o.showCodes === false) return 'none';
    if (o.showCodes === true) return 'index';
    return 'code';                                  // 新默认
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
      highlightLocked: o.highlightLocked === true   // 默认 false
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

  // 编号文字颜色按色块亮度取反，保证任何色号上都看得见
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

  // 本图实际用到的色号扫描：最长色号长度（code）与最大色号下标（index）都从这里取，不写死
  function usedScan(pattern) {
    var colors = (pattern && pattern.colors) || [];
    var cells = (pattern && pattern.cells) || [];
    var n = colors.length;
    var w = Math.max(0, Math.floor((pattern && pattern.w) || 0));
    var h = Math.max(0, Math.floor((pattern && pattern.h) || 0));
    var total = Math.min(cells.length, w * h);
    var maxIdx = -1, maxCodeLen = 0, used = 0, i, idx, code;
    for (i = 0; i < total; i++) {
      idx = cells[i];
      if (idx === EMPTY) continue;
      if (!isNum(idx) || idx < 0 || idx >= n) continue;
      used++;
      if (idx > maxIdx) maxIdx = idx;
      code = colors[idx] ? colors[idx].code : null;
      if (typeof code === 'string' || typeof code === 'number') {
        if (String(code).length > maxCodeLen) maxCodeLen = String(code).length;
      }
    }
    return { used: used, maxIdx: maxIdx, maxCodeLen: maxCodeLen };
  }

  // 某模式下文本最长的长度：'code' = 实际用到的色号里最长的；'index' = String(最大下标+1).length
  function labelTextLen(mode, scan) {
    if (mode === 'index') return scan.maxIdx < 0 ? 1 : String(scan.maxIdx + 1).length;
    return scan.maxCodeLen > 0 ? scan.maxCodeLen : 1;
  }

  // 该 cellPx 下能否画标签：约束 A（最小可读字号）+ 约束 B（装得下，留 10% 余量）
  // 注意顺序：B 判定必须在「夹到宽度上限」之前 —— 否则夹到上限后判定恒为等号，B 等于失效，
  // 长色号会被缩成蚂蚁字硬塞进格子（正是「画了等于没画」）。装不下就干脆不画。
  function labelFit(cellPx, mode, len) {
    var minReadable = mode === 'index' ? LABEL_MIN_READABLE.index : LABEL_MIN_READABLE.code;
    var exact = cellPx * LABEL_FONT_RATIO;
    if (exact < LABEL_FONT_MIN || exact > LABEL_FONT_MAX) return { draw: false, fontPx: 0, mode: mode };
    if (exact < minReadable) return { draw: false, fontPx: 0, mode: mode };
    var fontPx = clamp(Math.round(exact), LABEL_FONT_MIN, LABEL_FONT_MAX);
    if (fontPx * LABEL_CHAR_W * len > cellPx * LABEL_FIT) return { draw: false, fontPx: 0, mode: mode };
    var widthLimit = cellPx * LABEL_FIT / (LABEL_CHAR_W * len);   // 装得下所允许的最大字号
    if (fontPx > widthLimit) fontPx = widthLimit;                 // 兜底夹紧，绝不越出格子
    return { draw: true, fontPx: fontPx, mode: mode };
  }

  // 想画标签所需的最小 cellPx（供 UI 提示）：扫描出第一个真正画得出的格子尺寸
  function labelMinCellPx(mode, len) {
    var c;
    for (c = MIN_CELL_PX; c <= MAX_CELL_PX; c++) {
      if (labelFit(c, mode, len).draw) return c;
    }
    return MAX_CELL_PX + 1;    // 该文本长度下无解（例如 4 字以上色号装不进任何格子）
  }

  function labelStat(pattern, opts, scan) {
    var mode = opts.cellLabel;
    if (mode === 'none') {
      return { mode: mode, len: 0, minPx: 0, fit: { draw: false, fontPx: 0, mode: mode }, suppressed: false };
    }
    var len = labelTextLen(mode, scan);
    var fit = labelFit(opts.cellPx, mode, len);
    return { mode: mode, len: len, minPx: labelMinCellPx(mode, len), fit: fit, suppressed: !fit.draw };
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

  // 用量清单：优先读 pattern.counts（管线已按颗数降序），缺失时才退回 tally() 现场统计
  function usageRows(pattern) {
    var counts = (pattern && pattern.counts) || null;
    var colors = (pattern && pattern.colors) || [];
    var rows = [], i, c, n;
    if (counts && counts.length) {
      for (i = 0; i < counts.length; i++) {
        c = counts[i] || {};
        n = Number(c.count);
        if (!isNum(n) || n <= 0) continue;
        rows.push({ code: c.code, hex: c.hex, count: n });
      }
      if (rows.length) return rows;
    }
    var t = tally(pattern);
    for (i = 0; i < colors.length; i++) {
      if (!t.perIndex[i]) continue;
      rows.push({ code: colors[i] && colors[i].code, hex: colors[i] && colors[i].hex, count: t.perIndex[i] });
    }
    rows.sort(function (a, b) { return b.count - a.count; });
    return rows;
  }

  // 列宽按比例拉伸到目标总宽（最后一列吃下取整误差）
  function stretchCols(nat, total) {
    var sum = 0, i, out = [], prev = 0, edge, cum = 0;
    for (i = 0; i < nat.length; i++) sum += nat[i];
    if (sum <= 0 || total <= sum) return nat.slice();
    for (i = 0; i < nat.length; i++) {
      cum += nat[i];
      edge = (i === nat.length - 1) ? total : Math.round(total * cum / sum);
      out.push(edge - prev);
      prev = edge;
    }
    return out;
  }

  // 网格下方用量表的版式（尺寸只在这里算一次，绘制与面积守卫共用）
  function annotateLayout(pattern, opts, gridW) {
    var rows = usageRows(pattern);
    var fontPx = clamp(Math.round(opts.cellPx * ANNOTATE_FONT_RATIO), 9, 40);
    var rowH = Math.max(fontPx + 6, Math.round(fontPx * 1.9));
    var cellPad = Math.max(6, Math.round(fontPx * 0.6));
    var swatch = Math.max(8, Math.round(fontPx * 0.9));
    var wCode = estTextW(TABLE_HEAD[0], fontPx), wSwatch = estTextW(TABLE_HEAD[1], fontPx);
    var wHex = estTextW(TABLE_HEAD[2], fontPx), wCount = estTextW(TABLE_HEAD[3], fontPx);
    var i, r;
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      wCode = Math.max(wCode, estTextW(textOf(r.code), fontPx));
      wHex = Math.max(wHex, estTextW(safeHex(r.hex), fontPx));
      wCount = Math.max(wCount, estTextW(r.count + ' 颗', fontPx));
    }
    var nat = [
      Math.ceil(wCode) + cellPad * 2,
      Math.ceil(Math.max(wSwatch, swatch)) + cellPad * 2,
      Math.ceil(wHex) + cellPad * 2,
      Math.ceil(wCount) + cellPad * 2
    ];
    var natW = nat[0] + nat[1] + nat[2] + nat[3];
    var tableW = Math.max(natW, gridW);            // 至少与网格同宽，超出就撑开（网格随后居中）
    return {
      rows: rows,
      fontPx: fontPx,
      rowH: rowH,
      cellPad: cellPad,
      swatch: swatch,
      cols: stretchCols(nat, tableW),
      tableW: tableW,
      tableH: rowH * (rows.length + 1),            // 表头 + 数据行
      gap: Math.max(2, Math.round(opts.cellPx * 0.5))
    };
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
    var contentW = Math.max(gridW, table ? table.tableW : 0);
    if (table) {
      table.dx = Math.round((contentW - table.tableW) / 2);   // 相对网格原点
      table.dy = gridH + table.gap;                            // 表格在网格下方，绝不重叠
    }
    return {
      w: w,
      h: h,
      cellPx: cellPx,
      pad: pad,
      gridW: gridW,
      gridH: gridH,
      contentW: contentW,
      gridDX: Math.round((contentW - gridW) / 2),              // 表格更宽时网格整体居中
      rulerFontPx: ruler.fontPx,
      rulerGap: ruler.gap,
      table: table,
      width: pad * 2 + contentW,
      height: pad * 2 + gridH + (table ? table.gap + table.tableH : 0)
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

  // 逐格标签：'code' 写真色号（A1/A10/M15），'index' 写图纸编号（cells[i]+1）
  function paintCodes(ctx, pattern, lay, ox, oy, fit, pal) {
    var colors = (pattern && pattern.colors) || [];
    var cells = (pattern && pattern.cells) || [];
    var hexes = pal.hexes, inks = pal.inks;
    var n = hexes.length;
    var cellPx = lay.cellPx;
    var total = Math.min(cells.length, lay.w * lay.h);
    var texts = [], i, idx, p, code, drawn = 0;

    for (i = 0; i < colors.length; i++) {
      if (fit.mode === 'index') {
        texts.push(String(i + 1));
      } else {
        code = colors[i] ? colors[i].code : null;
        texts.push((typeof code === 'string' || typeof code === 'number') && String(code) !== '' ? String(code) : null);
      }
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

  /* ------------------------------------------------------- 绘制：用量表 */

  function paintTable(ctx, lay, ox, oy) {
    var t = lay.table;
    if (!t) return 0;
    var rows = t.rows, cols = t.cols, f = t.fontPx;
    var x = ox + t.dx, y = oy + t.dy, w = t.tableW, h = t.tableH;
    var headMid = y + t.rowH / 2;
    var bx, ty, i, r, sx, sy;

    // 表头底 + 行/列分隔线
    ctx.fillStyle = C.tableHead;
    ctx.fillRect(x, y, w, t.rowH);
    ctx.strokeStyle = C.tableLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (i = 1; i <= rows.length; i++) {
      ty = y + i * t.rowH + GRID_HALF;
      ctx.moveTo(x, ty);
      ctx.lineTo(x + w, ty);
    }
    bx = x;
    for (i = 0; i < cols.length - 1; i++) {
      bx += cols[i];
      ctx.moveTo(bx + GRID_HALF, y);
      ctx.lineTo(bx + GRID_HALF, y + h);
    }
    ctx.stroke();
    ctx.strokeStyle = C.tableBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + GRID_HALF, y + GRID_HALF, w, h);

    // 表头文字
    ctx.fillStyle = C.title;
    ctx.font = '600 ' + f + 'px ' + FONT_SANS;
    ctx.textBaseline = 'middle';
    bx = x;
    ctx.textAlign = 'left';
    ctx.fillText(TABLE_HEAD[0], bx + t.cellPad, headMid);
    bx += cols[0];
    ctx.textAlign = 'center';
    ctx.fillText(TABLE_HEAD[1], bx + cols[1] / 2, headMid);
    bx += cols[1];
    ctx.textAlign = 'left';
    ctx.fillText(TABLE_HEAD[2], bx + t.cellPad, headMid);
    bx += cols[2];
    ctx.textAlign = 'right';
    ctx.fillText(TABLE_HEAD[3], bx + cols[3] - t.cellPad, headMid);

    // 数据行：色号 | 色块 | HEX | 颗数
    ctx.font = f + 'px ' + FONT_MONO;
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      ty = y + (i + 1) * t.rowH + t.rowH / 2;
      bx = x;
      ctx.fillStyle = C.title;
      ctx.textAlign = 'left';
      ctx.fillText(textOf(r.code), bx + t.cellPad, ty);
      bx += cols[0];

      sx = bx + (cols[1] - t.swatch) / 2;
      sy = ty - t.swatch / 2;
      ctx.fillStyle = safeHex(r.hex);
      ctx.fillRect(sx, sy, t.swatch, t.swatch);
      ctx.strokeStyle = C.swatchEdge;
      ctx.lineWidth = 1;
      ctx.strokeRect(sx + GRID_HALF, sy + GRID_HALF, t.swatch, t.swatch);
      bx += cols[1];

      ctx.fillStyle = C.title;
      ctx.textAlign = 'left';
      ctx.fillText(safeHex(r.hex), bx + t.cellPad, ty);
      bx += cols[2];
      ctx.textAlign = 'right';
      ctx.fillText(textOf(r.count) + ' 颗', bx + cols[3] - t.cellPad, ty);
    }
    return rows.length;
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
      height: o.height || 0
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
    base.width = lay.width;
    base.height = lay.height;

    // 面积守卫：先算后画；超限时连画布尺寸都不设置，避免浏览器静默空白
    if (!(need <= MAX_CANVAS_PIXELS)) {
      base.ok = false;
      base.reason = 'too-large';
      base.width = lay.width;
      base.height = lay.height;
      base.needPixels = need;
      base.maxPixels = MAX_CANVAS_PIXELS;
      return makeResult(base);
    }

    canvas.width = lay.width;
    canvas.height = lay.height;
    var ctx = canvas.getContext('2d');
    if (!ctx) {
      base.ok = false; base.reason = 'invalid-input';
      base.width = 0; base.height = 0;
      return makeResult(base);
    }

    ctx.save();
    fillPaper(ctx, lay.width, lay.height);
    var res = paintPatternAt(ctx, pattern, opts, lay, lay.pad + lay.gridDX, lay.pad, stat);
    ctx.restore();

    base.ok = true;
    base.cellsDrawn = res.cellsDrawn;
    base.labelsDrawn = res.labelsDrawn > 0;
    base.labelsSuppressed = stat.suppressed && res.cellsDrawn > 0;
    base.labelMinPx = stat.minPx;
    return makeResult(base);
  }

  function sourceSize(src) {
    if (!src || typeof src !== 'object') return null;
    var w = Number(src.naturalWidth || src.videoWidth || src.width) || 0;
    var h = Number(src.naturalHeight || src.videoHeight || src.height) || 0;
    if (!(w > 0) || !(h > 0)) return null;
    return { w: w, h: h };
  }

  function drawCompare(pattern, sourceImage, canvas, viewOpts) {
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

    var titleH = 28;
    var gap = Math.max(24, Math.round(opts.cellPx * 2));
    var padX = 16, padY = 12;
    var maxLeftW = Math.max(240, lay.height);       // 防止超宽原图撑出巨大画布

    var size = sourceSize(sourceImage);
    var leftW = maxLeftW, imgW = 0, imgH = 0, imgX = padX, imgY = padY + titleH;
    if (size) {
      var sc = Math.min(maxLeftW / size.w, lay.height / size.h);
      imgW = Math.max(1, Math.round(size.w * sc));
      imgH = Math.max(1, Math.round(size.h * sc));
      imgX = padX + Math.round((leftW - imgW) / 2);
      imgY = padY + titleH + Math.round((lay.height - imgH) / 2);   // 面板等高，图内居中（contain 不变形）
    }

    var gridX = padX + leftW + gap;
    var gridY = padY + titleH;
    var W = gridX + lay.width + padX;
    var H = padY * 2 + titleH + lay.height;

    var need = W * H;
    base.width = W;
    base.height = H;
    if (!(need <= MAX_CANVAS_PIXELS)) {           // 同一道面积守卫
      base.ok = false;
      base.reason = 'too-large';
      base.needPixels = need;
      base.maxPixels = MAX_CANVAS_PIXELS;
      return makeResult(base);
    }

    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d');
    if (!ctx) {
      base.ok = false; base.reason = 'invalid-input';
      base.width = 0; base.height = 0;
      return makeResult(base);
    }

    ctx.save();
    fillPaper(ctx, W, H);

    // 小标题
    ctx.fillStyle = C.title;
    ctx.font = '600 15px ' + FONT_SANS;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('原图', padX + leftW / 2, padY + 14);
    ctx.fillText('拼豆图纸', gridX + lay.width / 2, padY + 14);

    // 左：原图（contain 缩放，不拉伸变形）
    if (size && typeof ctx.drawImage === 'function') {
      try {
        ctx.drawImage(sourceImage, imgX, imgY, imgW, imgH);
      } catch (e) {
        drawImagePlaceholder(ctx, imgX, imgY, imgW, imgH);
      }
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      ctx.strokeRect(imgX + GRID_HALF, imgY + GRID_HALF, imgW, imgH);
    } else {
      drawImagePlaceholder(ctx, imgX, imgY, leftW, lay.height);
    }

    // 右：图纸（复用同一套绘制逻辑，不复制粘贴）
    var res = paintPatternAt(ctx, pattern, opts, lay, gridX + lay.pad + lay.gridDX, gridY + lay.pad, stat);
    ctx.restore();

    base.ok = true;
    base.cellsDrawn = res.cellsDrawn;
    base.labelsDrawn = res.labelsDrawn > 0;
    base.labelsSuppressed = stat.suppressed && res.cellsDrawn > 0;
    base.labelMinPx = stat.minPx;
    return makeResult(base);
  }

  function drawImagePlaceholder(ctx, x, y, w, h) {
    ctx.fillStyle = C.placeholder;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + GRID_HALF, y + GRID_HALF, w, h);
    ctx.fillStyle = C.placeholderText;
    ctx.font = '13px ' + FONT_SANS;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('（原图不可用）', x + w / 2, y + h / 2);
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
    drawCompare: drawCompare,
    exportPNG: exportPNG,
    exportCSV: exportCSV,
    legendHTML: legendHTML
  };
})();
