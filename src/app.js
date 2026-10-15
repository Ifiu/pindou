/* 拼豆图纸生成器 · 界面交互逻辑
 * 纯脚本体：无模块语法，无外部资源，无框架。
 * 由 build.mjs 内联到单文件 HTML 的 body 末尾（在 palette / color / pipeline / render 之后）。
 * 依赖的全局契约：window.PINDOU_PALETTES、window.Pipeline、window.Render。
 * 三者缺失时界面仍完整渲染，并给出明确提示，不抛未捕获异常。
 */
(function () {
  'use strict';

  var win = (typeof window !== 'undefined' && window) ? window
    : ((typeof globalThis !== 'undefined') ? globalThis : {});
  var doc = (typeof document !== 'undefined') ? document : null;

  var MAX_DIM = 87;          /* 单边硬上限：3 × 3 板 */
  var BOARD_STEP = 29;       /* 每块拼板 29 × 29 格 */
  var BOARD_MAX = 3;
  var EMPTY_CELL = 65535;    /* Pattern.cells 里的空格标记，与 pipeline.js / render.js 保持一致 */
  var DEBOUNCE_MS = 200;
  var RULER_PAD = 16;        /* 内置降级渲染器的四周对称留白 */
  var SRC_MAX_EDGE = 1600;   /* 像素源长边上限：≥87 格图纸完全够用，且 getImageData 更快 */

  var DISCLAIMER = 'RGB 为屏幕参考值，非品牌官方色值；严谨对色请以实物色卡为准。';

  /* 注意：quantizeEnabled / maxColors 必须与 Pipeline.DEFAULT_OPTS.quantize 保持一致
     （默认减色开启、24 色）——同一语义只能有这一份 UI 默认值，pipeline 那边另有默认值，
     两边是刻意对齐的；boot / 重置时还会用 syncQuantizeFromPipeline() 再从 pipeline 拉一次。 */
  var DEFAULTS = {
    brightness: 0, contrast: 0, saturation: 0, autoWB: false, autoLevels: false,
    method: 'nearest', bayerN: '4', ditherStrength: 30,
    quantizeEnabled: true, maxColors: 24,
    boards: '1', lockAspect: true,
    showNumbers: true, showRuler: false, cellSize: 12,
    recolorMode: false, lockToggle: true
  };

  /* ---------------------------------------------------------------- 状态 */

  var state = {
    booted: false,
    busy: false,
    pending: false,
    timer: null,
    renderScheduled: false,
    dragActive: false,
    missingUI: [],
    source: null,        /* <img> / ImageBitmap / canvas：交给 Pipeline.generate 的像素源 */
    srcW: 0, srcH: 0,    /* 原图自然尺寸（用于宽高比） */
    pixW: 0, pixH: 0,    /* 实际写入 sourceCanvas 的像素尺寸（长边受 SRC_MAX_EDGE 限制） */
    srcCtx: null,        /* sourceCanvas 的 2d 上下文：getImageData 取像素 */
    pattern: null,
    renderFallback: false,
    viewOpts: { cellSize: 12, showNumbers: true, showRuler: false, showGrid: true },
    status: { text: '', kind: 'info' },
    lastMs: 0,
    lockCount: 0,
    /* 用户是否亲手动过某控件：没动过就跟随 Pipeline.DEFAULT_OPTS，避免两份默认值悄悄错开 */
    touched: { quantizeEnabled: false, maxColors: false }
  };

  var ui = {};

  /* ---------------------------------------------------------- 小工具函数 */

  function byId(id) {
    if (!doc || typeof doc.getElementById !== 'function') return null;
    return doc.getElementById(id);
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function num(el, fallback) {
    if (!el) return fallback;
    var v = Number(el.value);
    return (isFinite(v) ? v : fallback);
  }

  function intNow() { return Date.now(); }

  function now() {
    if (win.performance && typeof win.performance.now === 'function') return win.performance.now();
    return intNow();
  }

  function later(fn, ms) {
    if (typeof win.setTimeout === 'function') return win.setTimeout(fn, ms);
    fn();
    return null;
  }

  function cancelLater(id) {
    if (id !== null && id !== undefined && typeof win.clearTimeout === 'function') win.clearTimeout(id);
  }

  function errText(e) {
    if (!e) return '未知错误';
    if (typeof e === 'string') return e;
    if (e.message) return String(e.message);
    try { return String(e); } catch (err) { return '未知错误'; }
  }

  function fmt1(v) {
    var n = Number(v);
    if (!isFinite(n)) return '—';
    return (Math.round(n * 10) / 10).toFixed(1);
  }

  function setText(el, t) { if (el) el.textContent = String(t); }
  function setVal(el, v) { if (el) el.value = v; }
  function setChecked(el, v) { if (el) el.checked = !!v; }

  function on(el, type, fn) {
    if (el && typeof el.addEventListener === 'function') el.addEventListener(type, fn);
  }

  function hasClassList(el) { return !!(el && el.classList && typeof el.classList.add === 'function'); }

  /* ------------------------------------------------------- 模块可用性探测 */

  function describeModules() {
    var P = win.PINDOU_PALETTES;
    var palettes = !!(P && typeof P === 'object' && typeof Object.keys === 'function' && Object.keys(P).length > 0);
    var pipeline = !!(win.Pipeline && (typeof win.Pipeline.generateFromRGBA === 'function' || typeof win.Pipeline.generate === 'function'));
    var render = !!(win.Render && (typeof win.Render.drawPattern === 'function' || typeof win.Render.legendHTML === 'function'));
    var missing = [];
    if (!palettes) missing.push('色卡数据 window.PINDOU_PALETTES');
    if (!pipeline) missing.push('转换引擎 window.Pipeline');
    if (!render) missing.push('渲染模块 window.Render');
    return { palettes: palettes, pipeline: pipeline, render: render, ok: missing.length === 0, missing: missing };
  }

  function updateModuleNotice(mods) {
    if (!ui.moduleNotice) return;
    var msgs = [];
    if (state.missingUI.length) {
      msgs.push('界面结构不完整，缺少控件：' + state.missingUI.join('、') + '（对应功能不可用）。');
    }
    if (!mods.ok) {
      msgs.push('核心模块未加载：' + mods.missing.join('、') + '。界面可以正常浏览、调整参数，但生成 / 渲染 / 导出暂不可用；'
        + '请用 build.mjs 把 palette.js、color.js、pipeline.js、render.js 内联进单文件后再打开。');
    }
    if (!msgs.length) {
      ui.moduleNotice.hidden = true;
      setText(ui.moduleNotice, '');
      return;
    }
    ui.moduleNotice.hidden = false;
    setText(ui.moduleNotice, msgs.join(' '));
    if (hasClassList(ui.moduleNotice) && ui.moduleNotice.classList.add) ui.moduleNotice.classList.add('notice-warn');
  }

  /* ------------------------------------------------------------- 色卡数据 */

  function paletteEntries() {
    var out = [];
    var P = win.PINDOU_PALETTES;
    if (!P || typeof P !== 'object') return out;
    var keys = Object.keys(P);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var p = P[key];
      if (!p) continue;
      var colors = p.colors || [];
      out.push({
        id: p.id || key,
        key: key,
        label: p.label || key,
        count: p.count || colors.length,
        colors: colors,
        source: p.source,
        license: p.license,
        disclaimer: p.disclaimer
      });
    }
    return out;
  }

  function paletteById(id) {
    if (!id) return null;
    var list = paletteEntries();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id || list[i].key === id) return list[i];
    }
    return null;
  }

  function currentPalette() {
    return paletteById(ui.paletteSelect ? ui.paletteSelect.value : '') || paletteEntries()[0] || null;
  }

  function fillPaletteSelect() {
    var sel = ui.paletteSelect;
    if (!sel) return;
    var prev = sel.value;
    var list = paletteEntries();
    var html = '';
    if (!list.length) {
      html = '<option value="">（色卡数据未加载）</option>';
    } else {
      for (var i = 0; i < list.length; i++) {
        html += '<option value="' + esc(list[i].id) + '">' + esc(list[i].label + '（' + list[i].count + ' 色）') + '</option>';
      }
    }
    sel.innerHTML = html;
    if (prev && hasOptionValue(sel, prev)) sel.value = prev;
    syncPaletteMeta();
  }

  function hasOptionValue(sel, v) {
    var opts = sel && sel.options;
    if (!opts) return false;
    for (var i = 0; i < opts.length; i++) { if (opts[i].value === v) return true; }
    return false;
  }

  function syncPaletteMeta() {
    if (!ui.paletteMeta) return;
    var mods = describeModules();
    var p = currentPalette();
    if (!mods.palettes || !p) {
      setText(ui.paletteMeta, '色卡数据未加载，暂时无法生成图纸。' + DISCLAIMER);
      return;
    }
    var parts = ['共 ' + (p.count || (p.colors || []).length) + ' 色'];
    if (p.source) parts.push('来源：' + p.source);
    if (p.license) parts.push('许可：' + p.license);
    var text = parts.join(' · ');
    if (p.disclaimer) text += '。' + p.disclaimer;
    else text += '。' + DISCLAIMER;
    setText(ui.paletteMeta, text);
  }

  function findPaletteColor(paletteId, code) {
    var entries = paletteEntries();
    var pick = null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].id === paletteId || entries[i].key === paletteId) { pick = entries[i]; break; }
    }
    var pools = pick ? [pick] : entries;
    for (var p = 0; p < pools.length; p++) {
      var colors = pools[p].colors || [];
      for (var j = 0; j < colors.length; j++) {
        if (colors[j] && colors[j].code === code) return colors[j];
      }
    }
    return null;
  }

  /* ------------------------------------------------------- 控件读写与同步 */

  function methodOf() {
    if (ui.methodBayer && ui.methodBayer.checked) return 'bayer';
    if (ui.methodFS && ui.methodFS.checked) return 'fs';
    return 'nearest';
  }

  function syncLabels() {
    setText(ui.brightnessVal, signed(num(ui.brightness, 0)));
    setText(ui.contrastVal, signed(num(ui.contrast, 0)));
    setText(ui.saturationVal, signed(num(ui.saturation, 0)));
    setText(ui.ditherStrengthVal, Math.round(clamp(num(ui.ditherStrength, 30), 0, 100)) + '%');
    setText(ui.cellSizeVal, Math.round(clamp(num(ui.cellSize, 12), 4, 28)) + 'px');
  }

  function signed(v) { return (v > 0 ? '+' : '') + v; }

  function syncEnabledState() {
    var method = methodOf();
    if (ui.bayerN) ui.bayerN.disabled = (method !== 'bayer');
    if (ui.ditherStrength) ui.ditherStrength.disabled = (method === 'nearest');
    if (ui.maxColors) ui.maxColors.disabled = !(ui.quantizeEnabled && ui.quantizeEnabled.checked);
  }

  function syncMethodState() { syncEnabledState(); }

  function viewOpts() {
    var cell = Math.round(clamp(num(ui.cellSize, 12), 4, 28));
    var codes = !!(ui.showNumbers && ui.showNumbers.checked);
    var ruler = !!(ui.showRuler && ui.showRuler.checked);
    return {
      /* render.js 实际读取的键名 */
      cellPx: cell,
      showCodes: codes,
      showRuler: ruler,
      highlightLocked: true,
      /* 契约文档中的键名：同义双写，兼容任一实现 */
      cellSize: cell,
      showNumbers: codes,
      showGrid: true,
      paletteId: state.pattern ? state.pattern.paletteId : (ui.paletteSelect ? ui.paletteSelect.value : '')
    };
  }

  function gridDims() {
    return {
      w: Math.round(clamp(num(ui.gridW, 29), 1, MAX_DIM)),
      h: Math.round(clamp(num(ui.gridH, 29), 1, MAX_DIM))
    };
  }

  function boardLayoutFor(w, h) {
    return clamp(Math.max(Math.ceil(w / BOARD_STEP), Math.ceil(h / BOARD_STEP)), 1, BOARD_MAX);
  }

  function sourceAspect() {
    if (state.srcW > 0 && state.srcH > 0) return state.srcW / state.srcH;
    return 1;
  }

  function applyBoardsPreset() {
    var sel = ui.boardsSelect;
    if (!sel) return;
    if (sel.value === 'custom') return;
    var limit = clamp(Math.round(num({ value: sel.value }, 1)) * BOARD_STEP, 1, MAX_DIM);
    var w, h;
    var lock = !!(ui.lockAspect && ui.lockAspect.checked);
    if (!lock) {
      w = limit; h = limit;
    } else {
      var aspect = sourceAspect();
      if (aspect >= 1) { w = limit; h = clamp(Math.round(limit / aspect), 1, MAX_DIM); }
      else { h = limit; w = clamp(Math.round(limit * aspect), 1, MAX_DIM); }
    }
    setVal(ui.gridW, w);
    setVal(ui.gridH, h);
    syncLabels();
  }

  /* 手动输入格数：夹到 1..87，按需同步另一边，并把拼板规格切到「自定义」 */
  function normalizeDims(which) {
    var dims = gridDims();
    var w = dims.w, h = dims.h;
    if (ui.lockAspect && ui.lockAspect.checked && state.srcW > 0 && state.srcH > 0) {
      var aspect = sourceAspect();
      if (which === 'gridW') h = clamp(Math.round(w / aspect), 1, MAX_DIM);
      else w = clamp(Math.round(h * aspect), 1, MAX_DIM);
    }
    if (String(w) !== String(ui.gridW ? ui.gridW.value : w)) setVal(ui.gridW, w);
    if (String(h) !== String(ui.gridH ? ui.gridH.value : h)) setVal(ui.gridH, h);
    if (ui.boardsSelect && ui.boardsSelect.value !== 'custom') setVal(ui.boardsSelect, 'custom');
    syncLabels();
    return { w: w, h: h };
  }

  /* 减色的单一事实来源是 Pipeline.DEFAULT_OPTS.quantize：初次进入与「重置微调」都从它同步 UI。
     这样将来任一边改了默认值，界面显示值与实际传给 Pipeline 的值仍然一致。 */
  function pipelineQuantizeDefault() {
    var D = win.Pipeline && win.Pipeline.DEFAULT_OPTS;
    return (D && D.quantize && typeof D.quantize === 'object') ? D.quantize : null;
  }

  function syncQuantizeFromPipeline() {
    var d = pipelineQuantizeDefault();
    if (!d) return;
    if (typeof d.enabled === 'boolean') setChecked(ui.quantizeEnabled, d.enabled);
    if (typeof d.maxColors === 'number') setVal(ui.maxColors, Math.round(clamp(d.maxColors, 2, 221)));
    syncEnabledState();
  }

  /* 没动过控件时跟随 pipeline 默认值；动过则完全按 UI 走。 */
  function quantizeOpts() {
    var enabled = !!(ui.quantizeEnabled && ui.quantizeEnabled.checked);
    var maxColors = Math.round(clamp(num(ui.maxColors, 24), 2, 221));
    var d = pipelineQuantizeDefault();
    if (d) {
      if (!state.touched.quantizeEnabled && typeof d.enabled === 'boolean') enabled = !!d.enabled;
      if (!state.touched.maxColors && typeof d.maxColors === 'number') maxColors = Math.round(clamp(d.maxColors, 2, 221));
    }
    return { enabled: enabled, maxColors: maxColors };
  }

  /* 色卡 id：select 的值优先，为空时回落到第一个色卡（某些环境下 select 不会自动选中第一项） */
  function paletteIdForOpts() {
    var v = ui.paletteSelect ? ui.paletteSelect.value : '';
    if (v) return v;
    var p = currentPalette();
    return p ? p.id : '';
  }

  function buildOpts() {
    var dims = gridDims();
    var method = methodOf();
    return {
      paletteId: paletteIdForOpts(),
      boards: boardLayoutFor(dims.w, dims.h),
      gridW: dims.w,
      gridH: dims.h,
      lockAspect: !!(ui.lockAspect && ui.lockAspect.checked),
      preprocess: {
        brightness: num(ui.brightness, 0),
        contrast: num(ui.contrast, 0),
        saturation: num(ui.saturation, 0),
        autoWB: !!(ui.autoWB && ui.autoWB.checked),
        autoLevels: !!(ui.autoLevels && ui.autoLevels.checked)
      },
      method: method,
      bayerN: (Math.round(num(ui.bayerN, 4)) === 8) ? 8 : 4,
      ditherStrength: clamp(num(ui.ditherStrength, 30), 0, 100) / 100,
      quantize: quantizeOpts()
    };
  }

  /* ----------------------------------------------------------- 状态提示区 */

  function setStatus(text, kind) {
    state.status = { text: String(text), kind: kind || 'info' };
    if (!ui.statusText) return;
    setText(ui.statusText, state.status.text);
    if (hasClassList(ui.statusText)) {
      ui.statusText.classList.remove('ok');
      ui.statusText.classList.remove('warn');
      ui.statusText.classList.remove('err');
      if (kind === 'ok' || kind === 'warn' || kind === 'err') ui.statusText.classList.add(kind);
    }
  }

  function setElapsed(ms) {
    state.lastMs = Math.max(0, Math.round(ms));
    setText(ui.elapsedText, state.lastMs ? ('耗时 ' + state.lastMs + ' ms') : '');
  }

  function setProgress(active) {
    if (ui.progressWrap) ui.progressWrap.hidden = !active;
    if (ui.progressBar && ui.progressBar.style) ui.progressBar.style.width = active ? '35%' : '0%';
  }

  function setCanvasPlaceholders() {
    if (ui.patternHint) ui.patternHint.hidden = !!state.pattern;
    if (ui.emptyState) ui.emptyState.hidden = !!state.source;
    if (ui.sourceHint) ui.sourceHint.hidden = !!state.source;
  }

  /* ------------------------------------------------------- 计时 / 防抖调度 */

  function afterPaint(fn) {
    var raf = win.requestAnimationFrame;
    if (typeof raf === 'function') {
      raf(function () { later(fn, 0); });
      return;
    }
    later(fn, 16);
  }

  function scheduleRegenerate(delay) {
    var ms = (delay === null || delay === undefined) ? DEBOUNCE_MS : delay;
    cancelLater(state.timer);
    state.timer = null;
    if (typeof win.setTimeout !== 'function') { regenerate(); return; }
    state.timer = win.setTimeout(function () { state.timer = null; regenerate(); }, ms);
  }

  function scheduleRender() {
    if (state.renderScheduled) return;
    state.renderScheduled = true;
    afterPaint(function () {
      state.renderScheduled = false;
      renderPattern();
    });
  }

  /* ------------------------------------------------------------- 生成流程 */

  function runPipeline(opts) {
    var P = win.Pipeline;
    if (!P) return null;
    if (typeof P.generateFromRGBA === 'function' && state.srcCtx && state.pixW > 0) {
      var img = state.srcCtx.getImageData(0, 0, state.pixW, state.pixH);
      var data = (img && img.data) ? img.data : img;
      return P.generateFromRGBA(data, state.pixW, state.pixH, opts);
    }
    if (typeof P.generate === 'function') {
      return P.generate(state.source || ui.sourceCanvas, opts);
    }
    return null;
  }

  function regenerate() {
    var mods = describeModules();
    updateModuleNotice(mods);
    if (!state.source) { setStatus('请先选择一张图片', 'warn'); return; }
    if (!mods.pipeline) { setStatus('核心模块未加载：无法生成图纸。', 'err'); return; }
    if (state.busy) { state.pending = true; return; }
    state.busy = true;
    setStatus('正在生成图纸…', 'info');
    setProgress(true);
    afterPaint(doGenerate);
  }

  function doGenerate() {
    var t0 = now();
    var opts = buildOpts();
    /* 锁定格的恢复只由 Pipeline 负责（它会按色号并入、自然序重排、全量重映射下标）。
       app.js 不再自带一份恢复实现：两份实现必然错开，且本地恢复会打乱 colors 的自然序，
       而图纸上的编号 = colors 下标 + 1（见 render.js），一旦乱序就会改动整张图纸的编号。
       尺寸不一致时 Pipeline 会忽略锁定并在 warnings 里说明，这里照原样展示。 */
    if (state.pattern) opts.prevPattern = state.pattern;
    var pattern = null;
    var failure = '';
    try {
      pattern = runPipeline(opts);
    } catch (e) {
      failure = errText(e);
    }
    state.busy = false;
    var again = state.pending;
    state.pending = false;
    setProgress(false);

    if (!pattern) {
      setStatus('生成失败：' + (failure || 'Pipeline 未返回图纸数据'), 'err');
      setElapsed(now() - t0);
      if (again) scheduleRegenerate(0);
      return;
    }

    state.pattern = pattern;
    state.viewOpts = viewOpts();

    renderPattern();
    renderLegend();
    renderSummary();
    syncRecolorColors(pattern);
    updateLockInfo();
    setElapsed(now() - t0);

    var stats = pattern.stats || {};
    var total = (stats.total !== null && stats.total !== undefined) ? stats.total : countBeads(pattern);
    var note = '';
    var kept = countLocked(pattern);
    if (kept) note += ' · 保留手动改色 ' + kept + ' 格';
    if (state.renderFallback) note += ' · 渲染降级为内置模式';
    var warn = (pattern.warnings && pattern.warnings.length) ? '（' + pattern.warnings.join('；') + '）' : '';
    setStatus('已生成 ' + pattern.w + ' × ' + pattern.h + ' 格 · 共 ' + total + ' 颗' + note + warn, 'ok');

    if (again) scheduleRegenerate(0);
  }

  function countLocked(p) {
    var n = 0;
    if (p && p.locked) {
      for (var i = 0; i < p.locked.length; i++) { if (p.locked[i]) n++; }
    }
    return n;
  }

  /* 锁定格的恢复不在 app.js 实现：见 doGenerate 里 opts.prevPattern 的注释。 */

  function countBeads(p) {
    var n = 0;
    if (p && p.cells && p.colors) {
      for (var i = 0; i < p.cells.length; i++) { if (p.cells[i] < p.colors.length) n++; }
    }
    return n;
  }

  function recount(p) {
    if (!p || !p.cells || !p.colors) return p;
    var n = p.colors.length;
    var acc = [];
    for (var i = 0; i < n; i++) acc.push(0);
    var total = 0;
    for (var j = 0; j < p.cells.length; j++) {
      var c = p.cells[j];
      if (c >= 0 && c < n) { acc[c]++; total++; }
    }
    var list = [];
    for (var k = 0; k < n; k++) {
      if (acc[k] > 0) {
        list.push({ code: p.colors[k].code, hex: p.colors[k].hex, rgb: p.colors[k].rgb, count: acc[k] });
      }
    }
    list.sort(function (a, b) { return b.count - a.count; });
    p.counts = list;
    p.stats = p.stats || {};
    p.stats.total = total;
    p.stats.usedColors = list.length;
    return p;
  }

  /* ------------------------------------------------------------- 改色模式 */

  /* 改色必须让 Pattern.colors 始终维持 Pipeline 的「自然序」：图纸上的编号 = colors 下标 + 1
     （render.js 画的是 String(idx+1)），下标一乱，整张图纸的编号就变了。
     排序键用色表（palette.js）里的数组顺序 —— 集成回归证明它与 Pipeline 内部 compareCodes
     的顺序一致，所以不必在 app.js 里再复制一份比较器（一份语义只留一处实现）。 */
  function paletteOrderKeyMap(paletteId) {
    var pal = paletteById(paletteId) || currentPalette();
    var map = {};
    if (!pal || !pal.colors) return map;
    for (var i = 0; i < pal.colors.length; i++) map[String(pal.colors[i].code)] = i;
    return map;
  }

  function indexOfCode(p, code) {
    for (var i = 0; i < p.colors.length; i++) { if (String(p.colors[i].code) === String(code)) return i; }
    return -1;
  }

  /* 把色表里的新色号按自然序插入，并把受影响格子的下标整体平移（只对非空格操作） */
  function insertColorNatural(p, code) {
    var c = findPaletteColor(p.paletteId, code);
    if (!c) return -1;
    var order = paletteOrderKeyMap(p.paletteId);
    var big = Number.MAX_SAFE_INTEGER;
    var key = (order[String(code)] === undefined) ? big : order[String(code)];
    var pos = p.colors.length;
    for (var i = 0; i < p.colors.length; i++) {
      var k = (order[String(p.colors[i].code)] === undefined) ? big : order[String(p.colors[i].code)];
      if (k > key) { pos = i; break; }
    }
    p.colors.splice(pos, 0, { code: c.code, hex: c.hex, rgb: c.rgb, group: c.group });
    for (var j = 0; j < p.cells.length; j++) {
      if (p.cells[j] !== EMPTY_CELL && p.cells[j] >= pos) p.cells[j]++;
    }
    return pos;
  }

  /* 移除颗数归零的色号（保持 colors.length === counts.length 与「colors 只含用到的色号」），
     移除同样会平移下标；从后往前删，删除点之前的下标不受影响。 */
  function pruneUnusedColors(p) {
    var used = {};
    for (var i = 0; i < p.cells.length; i++) {
      var ci = p.cells[i];
      if (ci !== EMPTY_CELL && ci >= 0 && ci < p.colors.length) used[ci] = true;
    }
    for (var k = p.colors.length - 1; k >= 0; k--) {
      if (used[k]) continue;
      p.colors.splice(k, 1);
      for (var j = 0; j < p.cells.length; j++) {
        var v = p.cells[j];
        if (v !== EMPTY_CELL && v > k) p.cells[j] = v - 1;
      }
    }
  }

  function applyRecolor(idx, code, lock) {
    var p = state.pattern;
    if (!p || !p.cells) return;
    if (idx < 0 || idx >= p.cells.length) return;
    var ci = indexOfCode(p, code);
    if (ci < 0) {
      ci = insertColorNatural(p, code);
      if (ci < 0) { setStatus('色号 ' + code + ' 不在当前色卡中，无法改色', 'warn'); return; }
    }
    p.cells[idx] = ci;
    if (p.locked) p.locked[idx] = lock ? 1 : 0;
    pruneUnusedColors(p);
    recount(p);
    var finalCi = p.cells[idx];
    renderPattern();
    renderLegend();
    renderSummary();
    updateLockInfo();
    var code = p.colors[finalCi] ? p.colors[finalCi].code : '?';
    setStatus('已改色：第 ' + (Math.floor(idx / p.w) + 1) + ' 行 第 ' + (idx % p.w + 1) + ' 列 → 色号 '
      + code + '（图纸编号 ' + (finalCi + 1) + '）' + (lock ? '［已锁定，重新生成时保留］' : '［未锁定］'), 'ok');
  }

  /* 点击坐标 → 格子下标。
   * 优先使用 Render.hitTest(pattern, canvas, px, py, viewOpts)（若渲染模块提供）；
   * 否则按「四周对称留白」推断：render.js 的画布为 pad*2 + w*cellPx、(pad, pad) 处起画，
   * 内置降级渲染器采用同样的对称留白，因此 (canvas 尺寸 - 网格尺寸) / 2 即为原点。 */
  function hitTestCell(evt) {
    var p = state.pattern;
    var cv = ui.patternCanvas;
    if (!p || !cv || typeof cv.getBoundingClientRect !== 'function' || !evt) return -1;
    var rect = cv.getBoundingClientRect();
    var scaleX = rect.width ? (cv.width / rect.width) : 1;
    var scaleY = rect.height ? (cv.height / rect.height) : 1;
    var px = (evt.clientX - rect.left) * scaleX;
    var py = (evt.clientY - rect.top) * scaleY;

    if (win.Render && typeof win.Render.hitTest === 'function') {
      try {
        var r = win.Render.hitTest(p, cv, px, py, state.viewOpts);
        if (typeof r === 'number') return (r >= 0 && r < p.cells.length) ? r : -1;
      } catch (e) { /* 落到内置推断 */ }
    }

    var v = state.viewOpts || {};
    var cell = v.cellSize || v.cellPx || 12;
    var gridW = p.w * cell, gridH = p.h * cell;
    var offX = (cv.width > gridW) ? Math.floor((cv.width - gridW) / 2) : 0;
    var offY = (cv.height > gridH) ? Math.floor((cv.height - gridH) / 2) : 0;
    var col = Math.floor((px - offX) / cell);
    var row = Math.floor((py - offY) / cell);
    if (col < 0 || row < 0 || col >= p.w || row >= p.h) return -1;
    return row * p.w + col;
  }

  function onPatternClick(evt) {
    if (!ui.recolorMode || !ui.recolorMode.checked) return;
    var p = state.pattern;
    if (!p) { setStatus('尚未生成图纸', 'warn'); return; }
    var idx = hitTestCell(evt);
    if (idx < 0) { setStatus('点击位置不在图纸网格内（可调大「格子像素大小」后重试）', 'warn'); return; }
    if (evt && (evt.altKey || evt.shiftKey)) {
      if (p.locked) p.locked[idx] = p.locked[idx] ? 0 : 1;
      renderPattern();
      updateLockInfo();
      setStatus(p.locked && p.locked[idx] ? '已锁定该格' : '已解锁该格', 'ok');
      return;
    }
    var code = ui.recolorColor ? ui.recolorColor.value : '';
    if (!code) { setStatus('请先在上方「目标色号」里选一个色号', 'warn'); return; }
    var lock = !(ui.lockToggle && !ui.lockToggle.checked);
    applyRecolor(idx, code, lock);
  }

  function unlockAll() {
    var p = state.pattern;
    if (!p || !p.locked) { setStatus('当前没有可解锁的图纸', 'warn'); return; }
    for (var i = 0; i < p.locked.length; i++) p.locked[i] = 0;
    renderPattern();
    updateLockInfo();
    setStatus('已清除所有锁定（下次重算将按算法重新取色）', 'ok');
  }

  function updateLockInfo() {
    var p = state.pattern;
    var n = 0;
    if (p && p.locked) {
      for (var i = 0; i < p.locked.length; i++) { if (p.locked[i]) n++; }
    }
    state.lockCount = n;
    if (!ui.lockInfo) return;
    var editing = !!(ui.recolorMode && ui.recolorMode.checked);
    var lockOn = !(ui.lockToggle && !ui.lockToggle.checked);
    var text = '已锁定 ' + n + ' 格';
    if (editing) text += '（改色模式已开启' + (lockOn ? '，点击后自动锁定' : '，点击不锁定') + '）';
    setText(ui.lockInfo, text);
  }

  function syncRecolorColors(pattern) {
    var sel = ui.recolorColor;
    if (!sel) return;
    var prev = sel.value;
    var pid = pattern ? pattern.paletteId : (ui.paletteSelect ? ui.paletteSelect.value : '');
    var pal = paletteById(pid)
      || paletteById(ui.paletteSelect ? ui.paletteSelect.value : '')
      || paletteEntries()[0] || null;
    var list = (pal && pal.colors && pal.colors.length) ? pal.colors
      : ((pattern && pattern.colors) ? pattern.colors : []);
    if (!list.length) {
      sel.innerHTML = '<option value="">（色卡数据未加载）</option>';
      return;
    }
    var groups = {}, order = [];
    for (var j = 0; j < list.length; j++) {
      var c = list[j];
      if (!c) continue;
      var g = c.group ? String(c.group) : '色号';
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push(c);
    }
    var html = '';
    for (var k = 0; k < order.length; k++) {
      var arr = groups[order[k]];
      html += '<optgroup label="' + esc(order[k]) + '">';
      for (var m = 0; m < arr.length; m++) {
        html += '<option value="' + esc(arr[m].code) + '">' + esc(arr[m].code + ' · ' + (arr[m].hex || '')) + '</option>';
      }
      html += '</optgroup>';
    }
    sel.innerHTML = html;
    if (prev && hasOptionValue(sel, prev)) sel.value = prev;
    else if (pattern && pattern.counts && pattern.counts.length) sel.value = pattern.counts[0].code;
    else if (sel.options && sel.options.length) sel.value = sel.options[0].value;
  }

  /* --------------------------------------------------------------- 渲染区 */

  function renderPattern() {
    var cv = ui.patternCanvas;
    var p = state.pattern;
    setCanvasPlaceholders();
    if (!cv || !p) return;
    state.viewOpts = viewOpts();
    var v = state.viewOpts;
    var R = win.Render;
    var fell = false;
    if (R && typeof R.drawPattern === 'function') {
      try {
        R.drawPattern(p, cv, v);
      } catch (e) {
        fell = true;
        fallbackDrawPattern(cv, p, v);
        setStatus('渲染失败，已改用内置简化渲染：' + errText(e), 'warn');
      }
    } else {
      fell = true;
      fallbackDrawPattern(cv, p, v);
    }
    if (!fell && (!cv.width || cv.width < 2)) { fell = true; fallbackDrawPattern(cv, p, v); }
    state.renderFallback = fell;
    if (hasClassList(cv)) {
      if (ui.recolorMode && ui.recolorMode.checked) cv.classList.add('editing');
      else cv.classList.remove('editing');
    }
  }

  function contrastText(rgb) {
    var r = 0, g = 0, b = 0;
    if (Object.prototype.toString.call(rgb) === '[object Array]') { r = rgb[0]; g = rgb[1]; b = rgb[2]; }
    else if (rgb && typeof rgb === 'object') { r = rgb.r; g = rgb.g; b = rgb.b; }
    r = Number(r) || 0; g = Number(g) || 0; b = Number(b) || 0;
    return ((0.299 * r + 0.587 * g + 0.114 * b) > 150) ? '#1b1b1b' : '#f5f5f5';
  }

  /* 内置降级渲染：render.js 缺失或抛错时仍能看到图纸（不依赖任何外部模块）。
     画布布局与 render.js 一致：四周对称留白 pad，网格从 (pad, pad) 起画，
     这样 hitTestCell 的「对称余量」推断对两种渲染器都精确成立。 */
  function fallbackDrawPattern(cv, p, v) {
    if (!cv || typeof cv.getContext !== 'function' || !p || !p.cells) return;
    var cell = v.cellSize || v.cellPx || 12;
    var pad = RULER_PAD;
    cv.width = pad * 2 + p.w * cell;
    cv.height = pad * 2 + p.h * cell;
    var ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#FFFFFF';                 /* 纸底，与 render.js 的 C.paper 一致（图纸要能打印） */
    ctx.fillRect(0, 0, cv.width, cv.height);

    for (var y = 0; y < p.h; y++) {
      for (var x = 0; x < p.w; x++) {
        var i = y * p.w + x;
        var ci = p.cells[i];
        /* 空格（65535）与任何越界下标都跳过：不填色，保留纸底，避免被画成黑方块 */
        if (!(ci >= 0 && ci < p.colors.length)) continue;
        var col = p.colors[ci];
        var dx = pad + x * cell, dy = pad + y * cell;
        ctx.fillStyle = col.hex || '#000000';
        ctx.fillRect(dx, dy, cell, cell);
        if (p.locked && p.locked[i] && cell >= 6) {
          ctx.strokeStyle = '#E8695F';         /* 白底上用红框标出「手动锁定」的格子 */
          ctx.lineWidth = 1;
          ctx.strokeRect(dx + 0.5, dy + 0.5, cell - 1, cell - 1);
        }
        if (v.showNumbers && cell >= 9) {
          /* 与 render.js 一致：图纸上的编号 = colors 下标 + 1（不是色号字符串），
             阈值也沿用它的 MIN_CODE_PX = 9；墨色按其底色明暗取反以保证可读 */
          ctx.fillStyle = contrastText(col.rgb);
          ctx.font = Math.max(7, Math.floor(cell * 0.42)) + 'px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(ci + 1), dx + cell / 2, dy + cell / 2 + 0.5);
        }
      }
    }

    ctx.strokeStyle = '#DCE0E6';               /* 细网格，与 render.js 的 C.grid 一致（白底上可见） */
    ctx.lineWidth = 1;
    for (var gx = 0; gx <= p.w; gx++) {
      ctx.beginPath();
      ctx.moveTo(pad + gx * cell + 0.5, pad);
      ctx.lineTo(pad + gx * cell + 0.5, pad + p.h * cell);
      ctx.stroke();
    }
    for (var gy = 0; gy <= p.h; gy++) {
      ctx.beginPath();
      ctx.moveTo(pad, pad + gy * cell + 0.5);
      ctx.lineTo(pad + p.w * cell, pad + gy * cell + 0.5);
      ctx.stroke();
    }

    if (v.showRuler) {
      ctx.fillStyle = '#5A6472';               /* 刻度文字，与 render.js 的 C.rulerText 一致 */
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (var cx = 0; cx < p.w; cx++) {
        if (cell < 12 && (cx + 1) % 5 !== 0) continue;
        ctx.fillText(String(cx + 1), pad + cx * cell + cell / 2, pad / 2);
      }
      ctx.textAlign = 'right';
      for (var cy = 0; cy < p.h; cy++) {
        if (cell < 12 && (cy + 1) % 5 !== 0) continue;
        ctx.fillText(String(cy + 1), pad - 3, pad + cy * cell + cell / 2);
      }
    }
  }

  function builtinLegendHTML(p) {
    var rows = [];
    var list = (p && p.counts) ? p.counts : [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      rows.push('<div class="legend-row">'
        + '<span class="legend-code">' + esc(c.code) + '</span>'
        + '<span class="legend-sw" style="background:' + esc(c.hex) + '"></span>'
        + '<span class="legend-hex">' + esc(c.hex) + '</span>'
        + '<span class="legend-count">' + esc(c.count) + ' 颗</span>'
        + '</div>');
    }
    if (!rows.length) return '<p class="muted">暂无用量数据</p>';
    return '<div class="legend-grid">' + rows.join('') + '</div>';
  }

  function renderLegend() {
    if (!ui.legendBox) return;
    var p = state.pattern;
    if (!p) { ui.legendBox.innerHTML = '<p class="muted">尚未生成图纸</p>'; return; }
    var R = win.Render;
    if (R && typeof R.legendHTML === 'function') {
      try {
        var html = R.legendHTML(p);
        ui.legendBox.innerHTML = html ? html : '<p class="muted">图例为空</p>';
        return;
      } catch (e) {
        /* 落到内置图例 */
      }
    }
    ui.legendBox.innerHTML = builtinLegendHTML(p);
  }

  function summaryRow(k, v) {
    return '<div class="summary-row"><span class="summary-k">' + esc(k) + '</span>'
      + '<span class="summary-v">' + esc(v) + '</span></div>';
  }

  function renderSummary() {
    if (!ui.summaryBox) return;
    var p = state.pattern;
    if (!p) { ui.summaryBox.innerHTML = '<p class="muted">尚未生成图纸</p>'; return; }
    var s = p.stats || {};
    var total = (s.total !== null && s.total !== undefined) ? s.total : countBeads(p);
    var used = (s.usedColors !== null && s.usedColors !== undefined) ? s.usedColors : ((p.counts || []).length);
    var html = '';
    html += summaryRow('总颗数', total + ' 颗');
    html += summaryRow('用色数', used + ' 色');
    html += summaryRow('成品尺寸', fmt1(s.cmW) + ' × ' + fmt1(s.cmH) + ' cm');
    html += summaryRow('拼板', ((s.boardX !== null && s.boardX !== undefined) ? s.boardX : '—')
      + ' × ' + ((s.boardY !== null && s.boardY !== undefined) ? s.boardY : '—') + ' 板');
    html += summaryRow('图纸格数', p.w + ' × ' + p.h);
    html += summaryRow('色卡', p.paletteId || '—');
    ui.summaryBox.innerHTML = html;
  }

  /* ------------------------------------------------------------- 文件输出 */

  function downloadBlob(blob, filename) {
    if (!blob) { setStatus('导出失败：文件内容为空', 'err'); return false; }
    if (!doc || typeof doc.createElement !== 'function') { setStatus('当前环境不支持下载', 'err'); return false; }
    var url = null;
    try {
      url = (win.URL && typeof win.URL.createObjectURL === 'function') ? win.URL.createObjectURL(blob) : null;
    } catch (e) { url = null; }
    if (!url) { setStatus('当前环境不支持文件下载（缺少 Blob URL 支持）', 'err'); return false; }
    var a = doc.createElement('a');
    a.href = url;
    a.download = filename;
    if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(a);
    if (typeof a.click === 'function') a.click();
    later(function () {
      try { if (win.URL && win.URL.revokeObjectURL) win.URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ }
      if (a.parentNode && typeof a.parentNode.removeChild === 'function') a.parentNode.removeChild(a);
    }, 4000);
    return true;
  }

  /* 语义：确保落地文本以 UTF-8 BOM 开头，且只加一次。
     render.js 的 exportCSV 按冻结契约已经自带 U+FEFF，所以这里仅当首字符不是 U+FEFF 时才补，
     否则落地文件会变成双 BOM（U+FEFF U+FEFF 编号,...）。不要改回「无条件前置 BOM」。 */
  function downloadText(text, filename, mime) {
    if (!win.Blob) { setStatus('当前环境不支持导出（缺少 Blob 支持）', 'err'); return false; }
    var body = String(text === null || text === undefined ? '' : text);
    if (body.charCodeAt(0) !== 0xFEFF) body = '\ufeff' + body;
    return downloadBlob(new win.Blob([body], { type: (mime || 'text/plain') + ';charset=utf-8' }), filename);
  }

  function exportCsv() {
    var p = state.pattern;
    var R = win.Render;
    if (!p) { setStatus('请先生成图纸', 'warn'); return; }
    if (!R || typeof R.exportCSV !== 'function') { setStatus('核心模块未加载：无法导出用量清单 CSV', 'err'); return; }
    try {
      var csv = R.exportCSV(p);
      if (downloadText(csv || '', '拼豆用量清单.csv', 'text/csv')) setStatus('已导出用量清单 CSV', 'ok');
    } catch (e) {
      setStatus('导出 CSV 失败：' + errText(e), 'err');
    }
  }

  function exportPngOf(canvas, filename, okMsg) {
    var R = win.Render;
    if (!R || typeof R.exportPNG !== 'function') { setStatus('核心模块未加载：无法导出 PNG', 'err'); return; }
    if (!canvas) { setStatus('导出失败：画布不存在', 'err'); return; }
    try {
      var ret = R.exportPNG(canvas, filename);
      if (ret && typeof ret.then === 'function') {
        ret.then(function () { setStatus(okMsg, 'ok'); },
          function (e) { setStatus('导出 PNG 失败：' + errText(e), 'err'); });
      } else {
        setStatus(okMsg, 'ok');
      }
    } catch (e) {
      setStatus('导出 PNG 失败：' + errText(e), 'err');
    }
  }

  function exportPng() {
    if (!state.pattern) { setStatus('请先生成图纸', 'warn'); return; }
    exportPngOf(ui.patternCanvas, '拼豆图纸.png', '已导出图纸 PNG');
  }

  function exportCompare() {
    var p = state.pattern;
    var R = win.Render;
    if (!p) { setStatus('请先生成图纸', 'warn'); return; }
    if (!R || typeof R.exportPNG !== 'function') { setStatus('核心模块未加载：无法导出对照图', 'err'); return; }
    if (!ui.sourceCanvas) { setStatus('导出失败：原图尚未载入', 'err'); return; }
    if (typeof R.drawCompare !== 'function') { setStatus('核心模块未加载：无法合成对照图', 'err'); return; }
    if (!doc || typeof doc.createElement !== 'function') { setStatus('当前环境不支持导出', 'err'); return; }
    try {
      var tmp = doc.createElement('canvas');
      R.drawCompare(p, ui.sourceCanvas, tmp, state.viewOpts);
      exportPngOf(tmp, '拼豆对照图.png', '已导出对照图 PNG');
    } catch (e) {
      setStatus('导出对照图失败：' + errText(e), 'err');
    }
  }

  /* ------------------------------------------------------------- 图片读入 */

  function isImageType(t) {
    return !t || String(t).toLowerCase().indexOf('image/') === 0;
  }

  function pickFile() {
    if (!ui.fileInput) { setStatus('当前环境不支持文件选择', 'warn'); return; }
    if (typeof ui.fileInput.click === 'function') ui.fileInput.click();
  }

  function revoke(url) {
    try { if (url && win.URL && win.URL.revokeObjectURL) win.URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ }
  }

  function loadViaImageBitmap(blob, ok, fail) {
    if (typeof win.createImageBitmap === 'function') {
      try {
        win.createImageBitmap(blob).then(function (bmp) { ok(bmp, bmp.width, bmp.height); },
          function (e) { fail(errText(e)); });
        return;
      } catch (e) { /* 继续走失败分支 */ }
    }
    fail('当前环境不支持读取该图片格式');
  }

  function loadImageFromBlob(blob) {
    if (!blob) { setStatus('没有拿到图片数据', 'warn'); return; }
    var type = blob.type || '';
    if (!isImageType(type)) { setStatus('这不是图片文件：' + type, 'err'); return; }
    setStatus('正在读取图片…', 'info');
    var url = null;
    try {
      url = (win.URL && typeof win.URL.createObjectURL === 'function') ? win.URL.createObjectURL(blob) : null;
    } catch (e) { url = null; }

    var finished = false;
    function ok(src, w, h) {
      if (finished) return;
      finished = true;
      revoke(url);
      useImageSource(src, w, h);
    }
    function fail(msg) {
      if (finished) return;
      finished = true;
      revoke(url);
      setStatus('图片读取失败：' + msg, 'err');
    }

    if (!url) { loadViaImageBitmap(blob, ok, fail); return; }
    var Img = win.Image;
    if (typeof Img !== 'function') { loadViaImageBitmap(blob, ok, fail); return; }
    var img = new Img();
    img.onload = function () {
      ok(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
    };
    img.onerror = function () { loadViaImageBitmap(blob, ok, fail); };
    img.src = url;
  }

  function drawSourceCanvas() {
    var cv = ui.sourceCanvas;
    var src = state.source;
    state.srcCtx = null;
    state.pixW = 0;
    state.pixH = 0;
    if (!cv || !src || !state.srcW || !state.srcH) return;
    var scale = 1;
    var edge = Math.max(state.srcW, state.srcH);
    if (edge > SRC_MAX_EDGE) scale = SRC_MAX_EDGE / edge;
    var pw = Math.max(1, Math.round(state.srcW * scale));
    var ph = Math.max(1, Math.round(state.srcH * scale));
    cv.width = pw;
    cv.height = ph;
    if (typeof cv.getContext !== 'function') return;
    var ctx = cv.getContext('2d');
    if (!ctx) return;
    if (typeof ctx.drawImage === 'function') {
      try { ctx.drawImage(src, 0, 0, pw, ph); } catch (e) { /* 来源不可绘制：保留空白画布 */ }
    }
    state.srcCtx = ctx;
    state.pixW = pw;
    state.pixH = ph;
  }

  function useImageSource(src, w, h) {
    if (!src || !w || !h) { setStatus('图片尺寸无效，无法处理', 'err'); return; }
    state.source = src;
    state.srcW = Math.round(w);
    state.srcH = Math.round(h);
    state.pattern = null;
    drawSourceCanvas();
    if (ui.lockAspect && ui.lockAspect.checked) applyBoardsPreset();
    else normalizeDims('gridW');
    setCanvasPlaceholders();
    renderPattern();
    renderLegend();
    renderSummary();
    updateLockInfo();
    setStatus('已载入 ' + state.srcW + ' × ' + state.srcH + ' 图片，正在生成图纸…', 'info');
    scheduleRegenerate(0);
  }

  /* --------------------------------------------------------- 拖拽 / 粘贴 */

  function dragHasFiles(e) {
    var dt = e && e.dataTransfer;
    if (!dt) return false;
    var types = dt.types;
    if (!types || !types.length) return true;
    for (var i = 0; i < types.length; i++) {
      if (String(types[i]).toLowerCase() === 'files') return true;
    }
    return false;
  }

  function imageFileFrom(dt) {
    if (!dt) return null;
    var files = dt.files;
    if (files && files.length) {
      for (var i = 0; i < files.length; i++) {
        if (files[i] && isImageType(files[i].type)) return files[i];
      }
    }
    var items = dt.items;
    if (items && items.length) {
      for (var j = 0; j < items.length; j++) {
        var it = items[j];
        if (it && it.kind === 'file' && isImageType(it.type) && typeof it.getAsFile === 'function') {
          var f = it.getAsFile();
          if (f) return f;
        }
      }
    }
    return null;
  }

  function setDragActive(active) {
    var on2 = !!active;
    if (state.dragActive === on2) return;
    state.dragActive = on2;
    if (hasClassList(ui.dropZone)) {
      if (on2) ui.dropZone.classList.add('drag-active');
      else ui.dropZone.classList.remove('drag-active');
    }
    if (hasClassList(ui.dropHint)) {
      if (on2) ui.dropHint.classList.add('drag-active');
      else ui.dropHint.classList.remove('drag-active');
    }
  }

  function onDragOver(e) {
    if (!dragHasFiles(e)) return;
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (e && e.dataTransfer) { try { e.dataTransfer.dropEffect = 'copy'; } catch (err) { /* 忽略 */ } }
    setDragActive(true);
  }

  function onDragLeave(e) {
    if (e && e.relatedTarget) return;   /* 仅在真正离开窗口时取消高亮 */
    setDragActive(false);
  }

  function onDrop(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    setDragActive(false);
    var f = imageFileFrom(e && e.dataTransfer);
    if (f) loadImageFromBlob(f);
    else setStatus('没有识别到图片文件，请拖入 PNG / JPEG / WebP / GIF 图片', 'warn');
  }

  function onPaste(e) {
    var cb = e && e.clipboardData;
    if (!cb) return;
    var f = imageFileFrom(cb);
    if (!f) {
      var text = '';
      try { text = (typeof cb.getData === 'function') ? (cb.getData('text') || '') : ''; } catch (err) { text = ''; }
      if (text) setStatus('剪贴板里是文本而不是图片：请先在系统里复制图片，再按 Ctrl+V。', 'warn');
      return;
    }
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    loadImageFromBlob(f);
  }

  /* ------------------------------------------------------------- 事件绑定 */

  function onControlInput(id) {
    syncLabels();
    if (id === 'maxColors') state.touched.maxColors = true;
    if (id === 'cellSize') { scheduleRender(); return; }
    if (id === 'gridW' || id === 'gridH') normalizeDims(id);
    scheduleRegenerate(DEBOUNCE_MS);
  }

  function onToggleChange(id) {
    if (id === 'quantizeEnabled') state.touched.quantizeEnabled = true;
    if (id === 'showNumbers' || id === 'showRuler') { scheduleRender(); return; }
    if (id === 'recolorMode') {
      renderPattern();
      updateLockInfo();
      setStatus(ui.recolorMode && ui.recolorMode.checked
        ? '改色模式已开启：点击图纸格子即可改成目标色号'
        : '改色模式已关闭', 'info');
      return;
    }
    if (id === 'lockToggle') { updateLockInfo(); return; }
    syncEnabledState();
    if (id === 'lockAspect' && ui.lockAspect && ui.lockAspect.checked) normalizeDims('gridW');
    scheduleRegenerate(0);
  }

  function onSelectChange(id) {
    if (id === 'paletteSelect') {
      syncPaletteMeta();
      syncRecolorColors(state.pattern);
      scheduleRegenerate(0);
      return;
    }
    if (id === 'bayerN') { syncEnabledState(); scheduleRegenerate(0); return; }
    if (id === 'boardsSelect') { applyBoardsPreset(); scheduleRegenerate(0); return; }
  }

  function applyDefaults(regen) {
    if (!ui.brightness) { setStatus('界面控件缺失，无法重置微调', 'warn'); return; }
    setVal(ui.brightness, DEFAULTS.brightness);
    setVal(ui.contrast, DEFAULTS.contrast);
    setVal(ui.saturation, DEFAULTS.saturation);
    setVal(ui.ditherStrength, DEFAULTS.ditherStrength);
    setVal(ui.maxColors, DEFAULTS.maxColors);
    setVal(ui.cellSize, DEFAULTS.cellSize);
    setChecked(ui.autoWB, DEFAULTS.autoWB);
    setChecked(ui.autoLevels, DEFAULTS.autoLevels);
    setChecked(ui.quantizeEnabled, DEFAULTS.quantizeEnabled);
    setChecked(ui.lockAspect, DEFAULTS.lockAspect);
    setChecked(ui.showNumbers, DEFAULTS.showNumbers);
    setChecked(ui.showRuler, DEFAULTS.showRuler);
    setChecked(ui.lockToggle, DEFAULTS.lockToggle);
    setChecked(ui.recolorMode, DEFAULTS.recolorMode);
    setChecked(ui.methodNearest, DEFAULTS.method === 'nearest');
    setChecked(ui.methodFS, DEFAULTS.method === 'fs');
    setChecked(ui.methodBayer, DEFAULTS.method === 'bayer');
    setVal(ui.bayerN, DEFAULTS.bayerN);
    setVal(ui.boardsSelect, DEFAULTS.boards);
    applyBoardsPreset();
    syncQuantizeFromPipeline();      /* 回到默认 = 跟随 Pipeline.DEFAULT_OPTS.quantize */
    state.touched.quantizeEnabled = false;
    state.touched.maxColors = false;
    syncLabels();
    syncEnabledState();
    state.viewOpts = viewOpts();
    renderPattern();
    updateLockInfo();
    if (regen) {
      setStatus('已重置微调参数', 'info');
      scheduleRegenerate(0);
    }
  }

  function bindEvents() {
    var continuous = ['brightness', 'contrast', 'saturation', 'ditherStrength', 'cellSize', 'maxColors', 'gridW', 'gridH'];
    var toggles = ['autoWB', 'autoLevels', 'quantizeEnabled', 'lockAspect', 'showNumbers', 'showRuler', 'lockToggle', 'recolorMode'];
    var selects = ['boardsSelect', 'paletteSelect', 'bayerN'];
    var methods = ['methodNearest', 'methodFS', 'methodBayer'];
    var i;

    for (i = 0; i < continuous.length; i++) {
      (function (id) {
        var el = ui[id];
        if (!el) return;
        on(el, 'input', function () { onControlInput(id); });
        on(el, 'change', function () { onControlInput(id); });
      }(continuous[i]));
    }
    for (i = 0; i < toggles.length; i++) {
      (function (id) {
        on(ui[id], 'change', function () { onToggleChange(id); });
      }(toggles[i]));
    }
    for (i = 0; i < selects.length; i++) {
      (function (id) {
        on(ui[id], 'change', function () { onSelectChange(id); });
      }(selects[i]));
    }
    for (i = 0; i < methods.length; i++) {
      on(ui[methods[i]], 'change', function () {
        syncEnabledState();
        scheduleRegenerate(0);
      });
    }

    on(ui.btnRegenerate, 'click', function () { scheduleRegenerate(0); });
    on(ui.btnResetAdjust, 'click', function () { applyDefaults(true); });
    on(ui.btnExportPng, 'click', exportPng);
    on(ui.btnExportCompare, 'click', exportCompare);
    on(ui.btnExportCsv, 'click', exportCsv);
    on(ui.btnUnlockAll, 'click', unlockAll);
    on(ui.btnPickFile, 'click', pickFile);
    on(ui.emptyState, 'click', pickFile);
    on(ui.dropZone, 'click', function () { if (!state.source) pickFile(); });
    on(ui.sourceCanvas, 'click', function () { if (!state.source) pickFile(); });
    on(ui.patternCanvas, 'click', onPatternClick);
    on(ui.fileInput, 'change', function () {
      var f = (ui.fileInput.files && ui.fileInput.files.length) ? ui.fileInput.files[0] : null;
      if (f) loadImageFromBlob(f);
      else setStatus('没有选中文件', 'warn');
      try { ui.fileInput.value = ''; } catch (e) { /* 某些环境只读，忽略 */ }
    });

    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('dragover', onDragOver);
      doc.addEventListener('dragleave', onDragLeave);
      doc.addEventListener('drop', onDrop);
      doc.addEventListener('paste', onPaste);
    }
  }

  /* ------------------------------------------------------------------ 启动 */

  function buildUI() {
    ui = {
      fileInput: byId('fileInput'),
      btnPickFile: byId('btnPickFile'),
      dropHint: byId('dropHint'),
      moduleNotice: byId('moduleNotice'),
      brightness: byId('brightness'),
      brightnessVal: byId('brightnessVal'),
      contrast: byId('contrast'),
      contrastVal: byId('contrastVal'),
      saturation: byId('saturation'),
      saturationVal: byId('saturationVal'),
      autoWB: byId('autoWB'),
      autoLevels: byId('autoLevels'),
      methodNearest: byId('methodNearest'),
      methodFS: byId('methodFS'),
      methodBayer: byId('methodBayer'),
      bayerN: byId('bayerN'),
      ditherStrength: byId('ditherStrength'),
      ditherStrengthVal: byId('ditherStrengthVal'),
      quantizeEnabled: byId('quantizeEnabled'),
      maxColors: byId('maxColors'),
      boardsSelect: byId('boardsSelect'),
      gridW: byId('gridW'),
      gridH: byId('gridH'),
      lockAspect: byId('lockAspect'),
      paletteSelect: byId('paletteSelect'),
      paletteMeta: byId('paletteMeta'),
      showNumbers: byId('showNumbers'),
      showRuler: byId('showRuler'),
      cellSize: byId('cellSize'),
      cellSizeVal: byId('cellSizeVal'),
      recolorMode: byId('recolorMode'),
      recolorColor: byId('recolorColor'),
      lockToggle: byId('lockToggle'),
      btnUnlockAll: byId('btnUnlockAll'),
      lockInfo: byId('lockInfo'),
      btnRegenerate: byId('btnRegenerate'),
      btnResetAdjust: byId('btnResetAdjust'),
      btnExportPng: byId('btnExportPng'),
      btnExportCompare: byId('btnExportCompare'),
      btnExportCsv: byId('btnExportCsv'),
      dropZone: byId('dropZone'),
      statusText: byId('statusText'),
      elapsedText: byId('elapsedText'),
      progressWrap: byId('progressWrap'),
      progressBar: byId('progressBar'),
      patternCanvas: byId('patternCanvas'),
      patternHint: byId('patternHint'),
      emptyState: byId('emptyState'),
      sourceCanvas: byId('sourceCanvas'),
      sourceHint: byId('sourceHint'),
      summaryBox: byId('summaryBox'),
      legendBox: byId('legendBox')
    };
    var missing = [];
    for (var k in ui) {
      if (Object.prototype.hasOwnProperty.call(ui, k) && !ui[k]) missing.push(k);
    }
    return missing;
  }

  function boot() {
    if (state.booted) return;
    if (!doc || typeof doc.getElementById !== 'function') return;  /* 无 DOM：只保留 API，不做任何事 */
    state.booted = true;
    state.missingUI = buildUI();
    fillPaletteSelect();
    syncRecolorColors(null);
    applyDefaults(false);
    bindEvents();
    var mods = describeModules();
    updateModuleNotice(mods);
    setStatus(mods.ok ? '就绪：请先选择一张图片' : '核心模块未加载：界面可用，生成 / 渲染 / 导出暂不可用', mods.ok ? 'info' : 'warn');
    renderLegend();
    renderSummary();
    updateLockInfo();
    setCanvasPlaceholders();
  }

  var api = {
    boot: boot,
    modules: describeModules,
    regenerate: regenerate,
    adoptImage: useImageSource,
    options: buildOpts,
    clickCell: onPatternClick,
    hitTestCell: hitTestCell,
    applyRecolor: applyRecolor,
    recount: recount,
    exportCsv: exportCsv,
    state: function () { return state; },
    elements: function () { return ui; }
  };

  if (win && typeof win === 'object') win.PindouUI = api;

  if (doc && typeof doc.addEventListener === 'function') {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
}());
