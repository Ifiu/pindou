/*!
 * src/render.js —— 拼豆图纸渲染层（零依赖 / 零外部资源）
 *
 * 职责：
 *   1) drawPattern  把 Pattern 画成可打印的白底图纸（网格 + 29 格板边界 + 刻度 + 编号）
 *   2) drawCompare  原图 / 图纸 等高并排对照
 *   3) exportPNG    canvas -> PNG 下载
 *   4) exportCSV    Pattern -> CSV 字符串（UTF-8 BOM，由调用方负责下载）
 *   5) legendHTML   Pattern -> 图例 HTML 片段
 *
 * 硬约束：
 *   - 只读 Pattern（不重排 colors、不改 cells）
 *   - 编号规则：图纸上的数字 = cells[i] + 1（colors 下标从 0 开始，编号从 1 开始）
 *   - 图纸画布永远是白底（可打印文档），深色主题只属于 UI
 *   - 无 import / export / require，全部通过 window.Render 挂载
 */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- 常量 */

  var EMPTY = 65535;         // cells 里的空格 / 不用豆标记
  var BOARD = 29;            // 一块拼豆板的边长（格）
  var MIN_CODE_PX = 9;       // cellPx 小于此值不写编号（4px 数字是噪声不是信息）
  var MIN_CELL_PX = 4;
  var MAX_CELL_PX = 40;
  var DEFAULT_CELL_PX = 12;
  var MIN_PAD = 40;          // 刻度区最小边距
  var GRID_HALF = 0.5;       // 1px 线落在像素中心，避免糊边

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
    placeholderText: '#8A94A6'
  };

  /* ------------------------------------------------------------ 小工具 */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function clampCellPx(v) {
    if (!isNum(v) || v <= 0) return DEFAULT_CELL_PX;
    return clamp(Math.round(v), MIN_CELL_PX, MAX_CELL_PX);
  }

  function normalizeOpts(viewOpts) {
    var o = viewOpts || {};
    return {
      showCodes: o.showCodes !== false,          // 默认 true
      showRuler: o.showRuler !== false,          // 默认 true
      cellPx: clampCellPx(o.cellPx),             // 默认 12，夹到 4..40
      highlightLocked: o.highlightLocked === true // 默认 false
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

  /* ------------------------------------------------------------ 版式计算 */

  function layoutOf(pattern, opts) {
    var w = Math.max(0, Math.floor((pattern && pattern.w) || 0));
    var h = Math.max(0, Math.floor((pattern && pattern.h) || 0));
    var cellPx = opts.cellPx;
    var pad = Math.max(MIN_PAD, cellPx * 3 + 20);
    return {
      w: w,
      h: h,
      cellPx: cellPx,
      pad: pad,
      gridW: w * cellPx,
      gridH: h * cellPx,
      width: pad * 2 + w * cellPx,
      height: pad * 2 + h * cellPx
    };
  }

  // 板边界位置：29, 58, 87 …；末格外框也补一条（它同样是板的边）
  function boardPositions(n) {
    var out = [], k;
    for (k = BOARD; k <= n; k += BOARD) out.push(k);
    if (n > 0 && out[out.length - 1] !== n) out.push(n);
    return out;
  }

  // 刻度文字位置：每 5 格一个数字；29 的板边界额外补标（二者重合时只标一次）
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

  function cellPos(i, w, cellPx, ox, oy) {
    return [ox + (i % w) * cellPx, oy + Math.floor(i / w) * cellPx];
  }

  function paintCells(ctx, pattern, opts, lay, ox, oy) {
    var colors = (pattern && pattern.colors) || [];
    var cells = (pattern && pattern.cells) || [];
    var locked = (pattern && pattern.locked) || null;
    var n = colors.length;
    var cellPx = lay.cellPx;
    var total = Math.min(cells.length, lay.w * lay.h);
    var hexes = [], inks = [], i, idx, p, x, y, s;
    var drawn = 0, markers = 0;

    // 每个色号只算一次 hex / 文字色，避免逐格解析
    for (i = 0; i < n; i++) {
      hexes.push(colors[i] && typeof colors[i].hex === 'string' ? colors[i].hex : null);
      inks.push(textColorFor(hexes[i]));
    }

    for (i = 0; i < total; i++) {
      idx = cells[i];
      if (idx === EMPTY) continue;
      if (!isNum(idx) || idx < 0 || idx >= n) continue;
      if (!hexes[idx]) continue;
      p = cellPos(i, lay.w, cellPx, ox, oy);
      x = p[0]; y = p[1];
      ctx.fillStyle = hexes[idx];
      ctx.fillRect(x, y, cellPx, cellPx);
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

    return { codesDrawn: opts.showCodes && cellPx >= MIN_CODE_PX, cellsDrawn: drawn, markers: markers };
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

  function paintCodes(ctx, pattern, lay, ox, oy) {
    var colors = (pattern && pattern.colors) || [];
    var cells = (pattern && pattern.cells) || [];
    var n = colors.length;
    var cellPx = lay.cellPx;
    var total = Math.min(cells.length, lay.w * lay.h);
    var size = Math.max(5, Math.round(cellPx * 0.5));
    var inks = [], i, idx, p, drawn = 0;

    for (i = 0; i < n; i++) inks.push(textColorFor(colors[i] && colors[i].hex));

    ctx.font = '600 ' + size + 'px ' + FONT_MONO;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (i = 0; i < total; i++) {
      idx = cells[i];
      if (idx === EMPTY) continue;
      if (!isNum(idx) || idx < 0 || idx >= n) continue;
      p = cellPos(i, lay.w, cellPx, ox, oy);
      ctx.fillStyle = inks[idx];
      ctx.fillText(String(idx + 1), p[0] + cellPx / 2, p[1] + cellPx / 2 + 0.5);
      drawn++;
    }
    return drawn;
  }

  function paintRuler(ctx, lay, ox, oy) {
    var w = lay.w, h = lay.h, cellPx = lay.cellPx;
    var size = clamp(Math.round(cellPx * 0.9), 9, 14);
    var pos, i, k, x, y, len, board;

    // 顶部刻度线
    ctx.strokeStyle = C.rulerLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    pos = rulerPositions(w);
    for (i = 0; i < pos.length; i++) {
      k = pos[i].at;
      len = (k % 10 === 0 || pos[i].board) ? 12 : 7;
      x = ox + k * cellPx + GRID_HALF;
      ctx.moveTo(x, oy - GRID_HALF);
      ctx.lineTo(x, oy - len);
    }
    // 左侧刻度线
    pos = rulerPositions(h);
    for (i = 0; i < pos.length; i++) {
      k = pos[i].at;
      len = (k % 10 === 0 || pos[i].board) ? 12 : 7;
      y = oy + k * cellPx + GRID_HALF;
      ctx.moveTo(ox - GRID_HALF, y);
      ctx.lineTo(ox - len, y);
    }
    ctx.stroke();

    // 刻度数字（1 基：标在格子起始边界上）
    ctx.font = size + 'px ' + FONT_SANS;
    pos = rulerPositions(w);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (i = 0; i < pos.length; i++) {
      k = pos[i].at;
      ctx.fillStyle = pos[i].board ? C.rulerBoardText : C.rulerText;
      ctx.fillText(String(k), ox + k * cellPx, oy - 16);
    }
    pos = rulerPositions(h);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (i = 0; i < pos.length; i++) {
      k = pos[i].at;
      ctx.fillStyle = pos[i].board ? C.rulerBoardText : C.rulerText;
      ctx.fillText(String(k), ox - 16, oy + k * cellPx);
    }
  }

  /* --------------------------------------------------- 绘制：图纸（核心） */

  // 在 (ox, oy) = 网格左上角处绘制一张完整图纸；调用方负责白底与画布尺寸
  function paintPatternAt(ctx, pattern, opts, lay, ox, oy) {
    var res = paintCells(ctx, pattern, opts, lay, ox, oy);
    paintGrid(ctx, pattern, lay, ox, oy);
    if (res.codesDrawn) paintCodes(ctx, pattern, lay, ox, oy);
    if (opts.showRuler) paintRuler(ctx, lay, ox, oy);
    return res;
  }

  function fillPaper(ctx, w, h) {
    ctx.fillStyle = C.paper;
    ctx.fillRect(0, 0, w, h);
  }

  /* ------------------------------------------------------------- 公开 API */

  function drawPattern(pattern, canvas, viewOpts) {
    var blank = { codesDrawn: false, cellsDrawn: 0 };
    if (!pattern || !canvas || typeof canvas.getContext !== 'function') return blank;
    var opts = normalizeOpts(viewOpts);
    var lay = layoutOf(pattern, opts);
    canvas.width = lay.width;
    canvas.height = lay.height;
    var ctx = canvas.getContext('2d');
    if (!ctx) return blank;

    ctx.save();
    fillPaper(ctx, lay.width, lay.height);
    var res = paintPatternAt(ctx, pattern, opts, lay, lay.pad, lay.pad);
    ctx.restore();
    return { codesDrawn: res.codesDrawn, cellsDrawn: res.cellsDrawn };
  }

  function sourceSize(src) {
    if (!src || typeof src !== 'object') return null;
    var w = Number(src.naturalWidth || src.videoWidth || src.width) || 0;
    var h = Number(src.naturalHeight || src.videoHeight || src.height) || 0;
    if (!(w > 0) || !(h > 0)) return null;
    return { w: w, h: h };
  }

  function drawCompare(pattern, sourceImage, canvas, viewOpts) {
    var blank = { codesDrawn: false, cellsDrawn: 0 };
    if (!pattern || !canvas || typeof canvas.getContext !== 'function') return blank;
    var opts = normalizeOpts(viewOpts);
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

    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d');
    if (!ctx) return blank;

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
    var res = paintPatternAt(ctx, pattern, opts, lay, gridX + lay.pad, gridY + lay.pad);
    ctx.restore();
    return { codesDrawn: res.codesDrawn, cellsDrawn: res.cellsDrawn, width: W, height: H };
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
