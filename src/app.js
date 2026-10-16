/* 拼豆图纸生成器 · 界面交互逻辑
 * 纯脚本体：无模块语法，无外部资源，无框架。
 * 由 build.mjs 内联到单文件 HTML 的 body 末尾（在 palette / color / pipeline / render 之后）。
 * 依赖的全局契约：window.PINDOU_PALETTES、window.Pipeline、window.Render。
 * 可选增强契约：window.SourceEdit（原图裁剪 / 旋转 / 翻转），缺失时直接使用原图。
 * 四者缺失时界面仍完整渲染，并给出明确提示，不抛未捕获异常。
 */
(function () {
  'use strict';

  var win = (typeof window !== 'undefined' && window) ? window
    : ((typeof globalThis !== 'undefined') ? globalThis : {});
  var doc = (typeof document !== 'undefined') ? document : null;

  var MAX_DIM = 116;         /* 单边硬上限：4 × 4 板（= 4×4 块 29 孔板） */
  var BOARD_STEP = 29;       /* 每块拼板 29 × 29 格 */
  var BOARD_MAX = 4;
  var EMPTY_CELL = 65535;    /* Pattern.cells 里的空格标记，与 pipeline.js / render.js 保持一致 */
  var DEBOUNCE_MS = 200;
  var RULER_PAD = 16;        /* 内置降级渲染器的四周对称留白 */
  var SRC_MAX_EDGE = 1600;   /* 像素源长边上限：≥116 格图纸完全够用，且 getImageData 更快 */

  var MIN_CELL_PX = 8;       /* 格子像素滑杆下限 */
  var MAX_CELL_PX = 48;      /* 格子像素滑杆上限（render.js 已放宽到 256，48 是「看一眼」的舒适上限） */
  var DEFAULT_CELL_PX = 24;
  var LABEL_MIN_PX = 9;      /* 内置降级渲染器写字的最小格子像素 */
  /* render.js 实测阈值（code 模式 20px）。它会在 drawPattern 的返回值里
     自报 labelMinPx，这里只是「还没渲染过」时的兜底：提示文案绝不能和真实渲染层错开。
     只剩 code 一档：用户点名要删掉的第三档标签模式已从界面与代码里彻底移除。 */
  var LABEL_MIN_FALLBACK = { code: 20 };

  var ZOOM_MIN = 0.25;
  var ZOOM_MAX = 4;
  var ZOOM_DEFAULT = 1;
  var ZOOM_STEP_FACTOR = 1.25;

  /* 触摸端参数。捏合复用同一套缩放状态（state.viewZoom）与同一个 applyViewZoom，
     所以缩放范围仍然是 ZOOM_MIN / ZOOM_MAX，这里不另设一套上下限。 */
  var PINCH_CLICK_BLOCK_MS = 400;       /* 捏合结束后这段时间内忽略 click：两指抬起别被当成「点了一格」 */
  var TOUCH_DRAG_CLASS = 'touch-drag';  /* 加在 #patternCanvas 上：只在橡皮刷激活时关闭画布滚动 */

  /* 触摸端导出兜底文案。集中成常量，方便逐条核对「有没有说不成立的话」。 */
  var SAVE_TIP_IMG = '请长按下面这张图片，选「存储到相册 / 保存图片」。';
  var SAVE_TIP_IMG_NONE = '这个浏览器无法把图纸放进这里预览，长按保存用不了；请用系统截图保存，或改用电脑浏览器打开。';
  var SAVE_TIP_CSV_CLIP = '点「复制到剪贴板」，或在下面的文本框里长按，全选后复制。粘贴到备忘录或表格里即可。';
  var SAVE_TIP_CSV_PLAIN = '当前浏览器不支持一键复制（剪贴板接口不可用）。请在下面的文本框里长按，全选后复制。';
  var SAVE_TIP_CSV_DONE = '已复制到剪贴板。粘贴到备忘录或表格里即可。';

  var EXPORT_BASE_CELL = 24;            /* 导出基准格子像素：实际 = 24 × 倍数 */
  var EXPORT_SCALES = [1, 2, 4, 8];

  var HISTORY_MAX = 50;                 /* 撤销栈深上限：超了丢最旧的 */
  var RECENT_MAX = 12;                  /* 最近用过的色号个数 */
  var RECENT_KEY = 'pindou.recentColors.v1';
  var BEAD_RATE = 500;                  /* 图纸角标的「颗/小时」估算速率（契约固定 500） */
  var WAND_MAX = 20000;                 /* 魔术棒单次最多擦除的格数：区域再大也不会卡死界面 */

  /* 预处理滑杆的非线性压缩幂次：滑杆 50 → 生效 33，滑杆 20 → 生效 8（见 effCurve） */
  var EFF_POW = 1.6;

  /* 图纸工具互斥状态：任何时刻只有一个生效 */
  var TOOL_NONE = 'none';
  var TOOL_RECOLOR = 'recolor';
  var TOOL_WAND = 'wand';
  var TOOL_ERASER = 'eraser';
  var TAB_BASIC = 'basic';
  var TAB_ADVANCED = 'advanced';
  var PICKER_SCOPE_USED = 'used';
  var PICKER_SCOPE_ALL = 'all';

  var DISCLAIMER = 'RGB 为屏幕参考值，非品牌官方色值；严谨对色请以实物色卡为准。';

  /* 注意：quantizeEnabled / maxColors 必须与 Pipeline.DEFAULT_OPTS.quantize 保持一致
     （默认减色开启、24 色）——同一语义只能有这一份 UI 默认值，pipeline 那边另有默认值，
     两边是刻意对齐的；boot / 重置时还会用 syncQuantizeFromPipeline() 再从 pipeline 拉一次。 */
  var DEFAULTS = {
    brightness: 0, contrast: 0, saturation: 0, autoWB: false, autoLevels: false,
    method: 'nearest', bayerN: '4', ditherStrength: 30,
    quantizeEnabled: true, maxColors: 24,
    boards: '1', sizePreset: 'custom', lockAspect: true,
    cellLabel: 'code', showRuler: true, cellSize: DEFAULT_CELL_PX, viewZoom: ZOOM_DEFAULT,
    recolorMode: false, recolorScope: PICKER_SCOPE_USED, lockToggle: true,
    exportScale: '2', exportAnnotate: true
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
    srcW: 0, srcH: 0,    /* 原图自然尺寸（未被裁剪时的宽高比来源） */
    pixW: 0, pixH: 0,    /* 实际写入 sourceCanvas 的像素尺寸（长边受 SRC_MAX_EDGE 限制） */
    srcCtx: null,        /* sourceCanvas 的 2d 上下文：getImageData 取像素 */
    srcEdit: null,       /* SourceEdit.mount() 返回的 api；缺失时为 null */
    srcCropMode: false,
    pattern: null,
    /* 生成当前这张图纸时真正生效的减色设置：{ enabled, maxColors }；无图纸时为 null。
       汇总区并排显示「上限 / 实际」时用的是它，而不是当前 DOM 值。 */
    patternQuantize: null,
    renderFallback: false,
    renderTooLarge: false,
    labelMinPx: {},      /* 渲染层自报的格内文字阈值：{ code: 20 } */
    viewOpts: { cellPx: DEFAULT_CELL_PX, cellLabel: 'code', showCodes: true, showRuler: true, showGrid: true, annotate: false },
    /* 预览缩放：只影响 canvas 的 CSS 尺寸，不影响 canvas.width（== 导出与命中判定用的真实像素） */
    viewZoom: ZOOM_DEFAULT,
    viewZoomApplied: ZOOM_DEFAULT,
    history: [],         /* 撤销栈：[{w,h,cells,locked,colors}] 深拷贝快照；重新生成 / 换图时清空 */
    recolor: { scope: PICKER_SCOPE_USED, search: '', selected: '', recent: [] },
    status: { text: '', kind: 'info' },
    lastMs: 0,
    lockCount: 0,
    tab: TAB_BASIC,      /* 当前标签页：basic / advanced（只切显隐，不重建 DOM，不需要持久化） */
    /* 图纸工具互斥状态：none / recolor / wand / eraser。
       改色复选框 #recolorMode 与它双向同步，点击图纸的行为完全由它决定。 */
    tool: TOOL_NONE,
    eraseActive: false,  /* 橡皮刷是否处于一次按住拖动中 */
    eraseCount: 0,       /* 本次拖动已擦除的格数（pointerup 时统一收尾用） */
    /* 用户是否亲手动过某控件：没动过就跟随 Pipeline.DEFAULT_OPTS，避免两份默认值悄悄错开 */
    touched: { quantizeEnabled: false, maxColors: false }
  };

  var ui = {};
  var saveUrl = null;      /* 导出兜底层里 <img> 用的 objectURL：关闭时释放，避免一直占着内存 */

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

  function fmtPx(n) {
    var v = Number(n);
    if (!isFinite(v) || v <= 0) return '—';
    if (v >= 1e6) return (Math.round(v / 1e5) / 10) + 'M';
    return String(Math.round(v));
  }

  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

  function setText(el, t) { if (el) el.textContent = String(t); }
  function setVal(el, v) { if (el) el.value = v; }
  function setChecked(el, v) { if (el) el.checked = !!v; }
  function setDisabled(el, v) { if (el) el.disabled = !!v; }

  function on(el, type, fn) {
    if (el && typeof el.addEventListener === 'function') el.addEventListener(type, fn);
  }

  function hasClassList(el) { return !!(el && el.classList && typeof el.classList.add === 'function'); }

  function addCls(el, c) { if (hasClassList(el) && el.classList.add) el.classList.add(c); }
  function removeCls(el, c) { if (hasClassList(el) && el.classList.remove) el.classList.remove(c); }
  function toggleCls(el, c, on2) { if (on2) addCls(el, c); else removeCls(el, c); }

  /* localStorage 在 file:// 下可能直接抛异常（隐私模式 / 禁用 cookie）。
     存取都包在 try/catch 里：失败时静默降级为「仅本次会话有效」，绝不上抛。 */
  function storageGet(key) {
    try {
      var ls = win.localStorage;
      if (!ls || typeof ls.getItem !== 'function') return null;
      return ls.getItem(key);
    } catch (e) { return null; }
  }

  function storageSet(key, value) {
    try {
      var ls = win.localStorage;
      if (!ls || typeof ls.setItem !== 'function') return false;
      ls.setItem(key, value);
      return true;
    } catch (e) { return false; }
  }

  function isTypingTarget(t) {
    if (!t) return false;
    var tag = t.tagName ? String(t.tagName).toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (t.isContentEditable === true) return true;
    return false;
  }

  /* ------------------------------------------- 环境能力探测（触摸 / 窄屏） */

  /* 判据是能力查询而不是 UA 嗅探：`(pointer: coarse)` 为真 ⇔ 主输入设备是手指。
     刻意不把 navigator.maxTouchPoints / 'ontouchstart' 一起拿来做「或」——
     触摸屏笔记本上这两者都为真、主指针却仍是鼠标，那样会把导出兜底层错推到桌面上。
     matchMedia 不存在（老内核 / 测试桩）时返回 false，退化成现有桌面行为：照常下载、不弹兜底层。 */
  function coarsePointer() {
    try {
      if (typeof win.matchMedia !== 'function') return false;
      var mq = win.matchMedia('(pointer: coarse)');
      return !!(mq && mq.matches === true);
    } catch (e) { return false; }
  }

  function narrowScreen() {
    try {
      if (typeof win.matchMedia !== 'function') return false;
      var mq = win.matchMedia('(max-width: 1180px)');
      return !!(mq && mq.matches === true);
    } catch (e) { return false; }
  }

  /* 文案该按触摸端写还是按桌面写：任一成立就算「手指/窄屏」。
     两件事都要换说法——「拖进窗口」和「Ctrl+V」在手机上物理上做不到。 */
  function touchOrNarrow() { return coarsePointer() || narrowScreen(); }

  /* 文案只说实话：
     · 桌面端三条入口（点击 / 拖进来 / Ctrl+V）都真的能用，照旧写。
     · 触摸端只剩「点选择图片…从相册选」这一条真的走得通，就只写这一条。
     · 顶部副标题在任何端都不许再写「纯本地运行」——发到服务器后打开页面本来就需要联网；
       还能兑现的那句承诺是「图片不会上传」，所以只说这一句。 */
  function applyEnvironmentText() {
    var touch = touchOrNarrow();
    if (ui.dropHint) {
      setText(ui.dropHint, touch
        ? '点「选择图片…」从相册里选一张'
        : '也可拖拽图片到窗口，或按 Ctrl+V 粘贴');
    }
    if (ui.patternHint) {
      setText(ui.patternHint, touch
        ? '尚未载入图片\n点上面的「选择图片…」从相册里选一张'
        : '尚未载入图片\n点击上方「选择图片…」、把图片拖到这里，或按 Ctrl+V 粘贴');
    }
    if (ui.inputHint) {
      setText(ui.inputHint, (touch
        ? '入口只有一个：点上面的「选择图片…」从相册里选一张。'
        : '三种入口：点击「选择图片…」、把图片拖进窗口、或按 Ctrl+V 粘贴。')
        + '图片在你的浏览器里处理，不会上传到任何服务器。');
    }
    /* 导出兜底层只对触摸端存在：桌面端连这条提示都不该出现。
       （覆盖层本身也由 coarsePointer() 把关，这里是第二道同源的门。） */
    if (ui.saveTip) ui.saveTip.hidden = !coarsePointer();
  }

  /* --------------------------------------- 触摸端导出兜底（覆盖层） */

  /* 剪贴板能力检测：navigator.clipboard.writeText 存在才算可用。
     非安全上下文（http 页面）与老 WebView 上它是 undefined，此时不显示「复制」按钮，
     只留可长按选中的文本框——绝不画一个点了没反应的按钮。 */
  function clipboardApi() {
    try {
      var nav = win.navigator;
      if (!nav || !nav.clipboard || typeof nav.clipboard.writeText !== 'function') return null;
      return nav.clipboard;
    } catch (e) { return null; }
  }

  function closeSaveOverlay() {
    if (ui.saveOverlay) ui.saveOverlay.hidden = true;
    if (ui.saveImage) { ui.saveImage.hidden = true; try { ui.saveImage.removeAttribute('src'); } catch (e) { /* 忽略 */ } }
    if (ui.saveText) { ui.saveText.hidden = true; setVal(ui.saveText, ''); }
    if (ui.saveCopy) ui.saveCopy.hidden = true;
    if (saveUrl) { revoke(saveUrl); saveUrl = null; }
  }

  /* 覆盖层只对触摸端开：桌面端这些入口一律不出现（coarsePointer 为假时整个函数直接返回）。 */
  function openSaveOverlay() {
    if (!coarsePointer()) return false;
    if (!ui.saveOverlay || !ui.saveTip) return false;
    closeSaveOverlay();                 /* 清掉上一次的内容与 objectURL */
    ui.saveOverlay.hidden = false;
    return true;
  }

  /* PNG 兜底：把离屏画布变成能「长按保存」的 <img>。三条路依次退化，绝不给假地址：
       1) canvas.toBlob → URL.createObjectURL(blob) → img.src = 'blob:…'   ← 首选，不产生 base64 膨胀
       2) 老内核没有 toBlob（微信里有一部分较老的 X5 就属于这种）→ canvas.toDataURL('image/png')
          → img.src = 'data:image/png;…'（覆盖面最广，但 data: 串会让内存翻几倍，所以只在没 toBlob 时走）
       3) 两条都不行 → 不给 img 假地址，img 隐藏 + 明说「这里存不了图」，
          而不是留一个空框让用户长按（那是骗人）。
     objectURL 记在 saveUrl 上，关闭覆盖层时 revoke 掉；不然连导几次会一直占着内存。 */
  function offerPngSave(canvas) {
    if (!canvas || !openSaveOverlay()) return;
    var img = ui.saveImage;
    var put = function (url) {
      if (!img || !url) return false;
      try { img.src = url; } catch (e) { return false; }
      img.hidden = false;
      setText(ui.saveTip, SAVE_TIP_IMG);
      return true;
    };
    var dataUrlPath = function () {
      if (typeof canvas.toDataURL === 'function') {
        try { if (put(canvas.toDataURL('image/png'))) return; } catch (e) { /* 落到第 3 条 */ }
      }
      if (img) img.hidden = true;
      setText(ui.saveTip, SAVE_TIP_IMG_NONE);
    };
    if (typeof canvas.toBlob === 'function') {
      try {
        canvas.toBlob(function (blob) {
          var url = null;
          if (blob) {
            try { url = (win.URL && typeof win.URL.createObjectURL === 'function') ? win.URL.createObjectURL(blob) : null; } catch (e) { url = null; }
          }
          if (url) { saveUrl = url; if (put(url)) return; }
          dataUrlPath();
        }, 'image/png');
        return;
      } catch (e) { /* toBlob 自身抛错：照第 2 条试 */ }
    }
    dataUrlPath();
  }

  /* 剪贴板 API 可用时的写入口（成功/失败各给一个回调，界面据此改提示） */
  function writeClipboard(api, text, done, failed) {
    try {
      var ret = api.writeText(text);
      if (ret && typeof ret.then === 'function') ret.then(done, failed);
      else done();
    } catch (e) { failed(e); }
  }

  /* 剪贴板 API 不可用（http 页面 / 老 WebView）时的第二级：
     临时建一个 textarea 选中全文，再用 document.execCommand('copy')
     —— 这些内核上唯一还能用的复制路径。无论成败都把 CSV 留在可长按选中的 #saveText 里，
     用户手动也能拿走（那才是这一级真正兜住的东西）。 */
  function legacyCopy(text) {
    if (!doc || typeof doc.createElement !== 'function') return false;
    var ta = null, ok = false;
    try {
      ta = doc.createElement('textarea');
      setVal(ta, text);
      if (typeof ta.setAttribute === 'function') ta.setAttribute('readonly', 'readonly');
      if (ta.style) { ta.style.position = 'fixed'; ta.style.left = '-9999px'; ta.style.top = '0'; }
      if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(ta);
      if (typeof ta.select === 'function') ta.select();
      if (typeof ta.setSelectionRange === 'function') { try { ta.setSelectionRange(0, text.length); } catch (e) { /* 忽略 */ } }
      if (typeof doc.execCommand === 'function') ok = (doc.execCommand('copy') === true);
    } catch (e) { ok = false; }
    if (ta && ta.parentNode && typeof ta.parentNode.removeChild === 'function') {
      try { ta.parentNode.removeChild(ta); } catch (e) { /* 忽略 */ }
    }
    return ok;
  }

  /* CSV 兜底。两级降级：
     ① navigator.clipboard.writeText 可用 → 打开覆盖层 + 显示可用的「复制到剪贴板」按钮，
        并先自动试复制一次（微信里点一下就走的路径，不该还要用户多点一次）。
     ② 不可用 → 隐藏按钮（绝不画一个点了没反应的按钮），改走 legacyCopy，
        并把 CSV 放进可长按选中的文本框当最后一级。 */
  function offerCsvCopy(text) {
    if (!openSaveOverlay()) return;
    setVal(ui.saveText, text);
    if (ui.saveText) ui.saveText.hidden = false;
    if (ui.saveImage) ui.saveImage.hidden = true;
    var api = clipboardApi();
    if (ui.saveCopy) { ui.saveCopy.hidden = !api; setDisabled(ui.saveCopy, !api); }
    if (api) {
      setText(ui.saveTip, SAVE_TIP_CSV_CLIP);
      writeClipboard(api, text, function () { setText(ui.saveTip, SAVE_TIP_CSV_DONE); }, copyFailed);
      return;
    }
    setText(ui.saveTip, legacyCopy(text) ? SAVE_TIP_CSV_DONE : SAVE_TIP_CSV_PLAIN);
  }

  function copyFailed(e) {
    /* 失败不装死：把「按钮点了没反应」变成明确的下一步动作 */
    setText(ui.saveTip, '复制失败（' + errText(e) + '）：请在下面的文本框里长按，全选后手动复制。');
  }

  function onSaveCopy() {
    var text = ui.saveText ? String(ui.saveText.value === null || ui.saveText.value === undefined ? '' : ui.saveText.value) : '';
    var api = clipboardApi();
    if (api) { writeClipboard(api, text, function () { setText(ui.saveTip, SAVE_TIP_CSV_DONE); }, copyFailed); return; }
    if (ui.saveCopy) setDisabled(ui.saveCopy, true);
    setText(ui.saveTip, legacyCopy(text) ? SAVE_TIP_CSV_DONE : SAVE_TIP_CSV_PLAIN);
  }

  /* ------------------------------------------------------- 模块可用性探测 */

  function describeModules() {
    var P = win.PINDOU_PALETTES;
    var palettes = !!(P && typeof P === 'object' && typeof Object.keys === 'function' && Object.keys(P).length > 0);
    var pipeline = !!(win.Pipeline && (typeof win.Pipeline.generateFromRGBA === 'function' || typeof win.Pipeline.generate === 'function'));
    var render = !!(win.Render && (typeof win.Render.drawPattern === 'function' || typeof win.Render.legendHTML === 'function'));
    var srcEdit = !!(win.SourceEdit && typeof win.SourceEdit.mount === 'function');
    var missing = [];
    if (!palettes) missing.push('色卡数据 window.PINDOU_PALETTES');
    if (!pipeline) missing.push('转换引擎 window.Pipeline');
    if (!render) missing.push('渲染模块 window.Render');
    /* SourceEdit 是可选增强：不进 missing，界面应照常工作（退回直接用原图） */
    return { palettes: palettes, pipeline: pipeline, render: render, srcEdit: srcEdit, ok: missing.length === 0, missing: missing };
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

  /* 色卡 id：select 的值优先，为空时回落到第一个色卡（某些环境下 select 不会自动选中第一项） */
  function paletteIdForOpts() {
    var v = ui.paletteSelect ? ui.paletteSelect.value : '';
    if (v) return v;
    var p = currentPalette();
    return p ? p.id : '';
  }

  /* ------------------------------------------------------- 控件读写与同步 */

  function methodOf() {
    if (ui.methodBayer && ui.methodBayer.checked) return 'bayer';
    if (ui.methodFS && ui.methodFS.checked) return 'fs';
    return 'nearest';
  }

  function cellSizeValue() {
    return Math.round(clamp(num(ui.cellSize, DEFAULT_CELL_PX), MIN_CELL_PX, MAX_CELL_PX));
  }

  /* 格内显示二选：code（色号 A1，勾选「显示色号」）/ none（不勾，格内不写字）。
     只有这一个来源：用户点名要删掉的第三档标签模式已彻底删除，不留死分支。 */
  function cellLabelOf() {
    return (ui.showCodes && ui.showCodes.checked) ? 'code' : 'none';
  }

  /* 格内文字阈值：优先用渲染层自报的值（按模式分别缓存），没有就用实测兜底值 */
  function labelMinPx() {
    var label = cellLabelOf();
    if (label === 'none') return 0;
    var cached = state.labelMinPx[label];
    if (typeof cached === 'number' && cached > 0) return cached;
    return LABEL_MIN_FALLBACK[label] || 20;
  }

  /* 说的只有一件事：色号需要格子 ≥ min px 才会画（min 取渲染层自报的真实阈值） */
  function syncCellLabelHint() {
    if (!ui.cellLabelHint) return;
    var cell = cellSizeValue();
    var label = cellLabelOf();
    var min = labelMinPx();
    var need = '色号需要格子 ≥ ' + min + 'px 才会画出。';
    var text;
    if (label === 'none') {
      text = '当前不显示色号（格子 ' + cell + 'px）。' + need;
    } else if (cell < min) {
      text = '格子太小（' + cell + 'px），色号已隐藏：' + need;
    } else {
      text = '当前 ' + cell + 'px，格内显示色号（如 A1）。' + need;
    }
    setText(ui.cellLabelHint, text);
  }

  function syncLabels() {
    setText(ui.brightnessVal, signed(effSlider(ui.brightness, 0)));
    setText(ui.contrastVal, signed(effSlider(ui.contrast, 0)));
    setText(ui.saturationVal, signed(effSlider(ui.saturation, 0)));
    setText(ui.ditherStrengthVal, Math.round(clamp(num(ui.ditherStrength, 30), 0, 100)) + '%');
    /* 色数上限的「读数」就是那个数字框本身（没有第三个数字）：这里顺手把它对齐到滑杆值 */
    if (ui.maxColorsNum) setVal(ui.maxColorsNum, String(maxColorsSliderValue()));
    setText(ui.cellSizeVal, cellSizeValue() + 'px');
    setText(ui.viewZoomVal, Math.round(state.viewZoom * 100) + '%');
    syncCellLabelHint();
    syncMaxColorsHint();
    syncPreprocessHint();
  }

  /* ------------------------------------------------------- 预处理滑杆压缩 */

  /* 把滑杆位置压成生效值：靠近 0 的一小段变得更精细，滑到底仍是 ±100。
     幂次 1.6：滑杆 50 → 生效 33；滑杆 20 → 生效 8。
     量程不缩（滑杆仍是 -100..100，最大强度仍可达），只是把「小幅拖动就变化很大」压回可控。 */
  function effCurve(v) {
    var n = Number(v);
    if (!isFinite(n)) n = 0;
    var s = n < 0 ? -1 : 1;
    var a = Math.abs(n);
    if (a > 100) a = 100;
    return s * Math.round(100 * Math.pow(a / 100, EFF_POW));
  }

  /* 滑杆 → 生效值的唯一入口：buildOpts 与读数都走它，避免「读数 50 实际 33」这种撒谎的界面 */
  function effSlider(el, fallback) {
    return effCurve(num(el, (fallback === undefined) ? 0 : fallback));
  }

  function syncPreprocessHint() {
    if (!ui.preprocessHint) return;
    setText(ui.preprocessHint, '滑杆经过非线性压缩（幂次 ' + EFF_POW + '）：靠近 0 的一小段更精细，滑到底仍是满强度。'
      + '当前生效值 亮度 ' + signed(effSlider(ui.brightness, 0))
      + ' / 对比度 ' + signed(effSlider(ui.contrast, 0))
      + ' / 饱和度 ' + signed(effSlider(ui.saturation, 0)) + '。');
  }

  function signed(v) { return (v > 0 ? '+' : '') + v; }

  /* 色数上限：range 与数字框是同一份值的两个视图（id: maxColors / maxColorsNum）。
     越界一律「夹取」而不是拒绝：< 2 → 2，> 221 → 221。 */
  function clampMaxColors(v) {
    var n = Number(v);
    if (!isFinite(n)) n = DEFAULTS.maxColors;
    return Math.round(clamp(n, 2, 221));
  }

  /* 滑杆当前值（夹取后落在 2..221）—— 它永远是「上一次有效值」 */
  function maxColorsSliderValue() {
    return clampMaxColors(ui.maxColors ? ui.maxColors.value : DEFAULTS.maxColors);
  }

  /* 数字框 → 夹取后的有效值；空串 / 非法文本返回 null =「不改变，保留上一次有效值」。
     返回 null 而不是 0 是刻意的：把空框当成 0 再夹到 2，会让「清空后重新键入」打不成字。 */
  function maxColorsNumValue() {
    if (!ui.maxColorsNum) return null;
    var v = ui.maxColorsNum.value;
    var raw = String(v === null || v === undefined ? '' : v).replace(/\s+/g, '');
    if (!raw) return null;
    var n = Number(raw);
    if (!isFinite(n)) return null;
    return clampMaxColors(n);
  }

  /* 色数上限的唯一写入口：一次写两个控件。
     ⇒「夹取后两个控件必须一致」是结构性保证，而不是靠两处各自小心地同步。 */
  function setMaxColors(v) {
    var n = clampMaxColors(v);
    if (ui.maxColors) setVal(ui.maxColors, String(n));
    if (ui.maxColorsNum) setVal(ui.maxColorsNum, String(n));
    return n;
  }

  function syncEnabledState() {
    var method = methodOf();
    if (ui.bayerN) ui.bayerN.disabled = (method !== 'bayer');
    if (ui.ditherStrength) ui.ditherStrength.disabled = (method === 'nearest');
    var qOn = !!(ui.quantizeEnabled && ui.quantizeEnabled.checked);
    /* 减色未启用时滑杆与数字框一起置灰：一个灰着一个亮着会让人以为上限还在生效 */
    if (ui.maxColors) ui.maxColors.disabled = !qOn;
    if (ui.maxColorsNum) ui.maxColorsNum.disabled = !qOn;
    if (ui.eraserSize) ui.eraserSize.disabled = (state.tool !== TOOL_ERASER);
    syncMaxColorsHint();
  }

  /* 「色数上限」控件下的小字：说的是「设置」而不是「结果」。
     结果那一侧（实际用了几色、差额怎么解释）在用量汇总里，用生成时真正生效的值。
     这里的 N 走 quantizeOpts()：它才是实际会送进 Pipeline 的值（没动过控件时跟随 pipeline 默认值）。 */
  function syncMaxColorsHint() {
    if (!ui.maxColorsHint) return;
    var q = quantizeOpts();
    var text;
    if (!q.enabled) {
      text = '未启用减色：不使用色数上限，实际用色由算法与色卡决定。';
    } else {
      text = '这是「最多用几色」而不是精确色数；'
        + '实际用色受色卡与原图色彩分布限制，可能少于上限（生成后见右侧「用量汇总」）。';
    }
    setText(ui.maxColorsHint, text);
  }

  function syncMethodState() { syncEnabledState(); }

  /* 图纸标题（角标左下角那段）。空串 = 不显示该段，由 render.js 决定。 */
  function chartTitleValue() {
    var v = ui.chartTitle ? String(ui.chartTitle.value === null || ui.chartTitle.value === undefined ? '' : ui.chartTitle.value) : '';
    return v.replace(/^\s+|\s+$/g, '');
  }

  function viewOpts() {
    var cell = cellSizeValue();
    var label = cellLabelOf();
    var codes = (label !== 'none');
    var ruler = !!(ui.showRuler && ui.showRuler.checked);
    return {
      /* render.js 实际读取的键名 */
      cellPx: cell,
      showCodes: codes,
      showRuler: ruler,
      highlightLocked: true,
      /* 冻结契约里的新增键名。cellLabel 必须显式给出，只有 'code' / 'none' 两种取值：
         用户点名要删掉的第三档标签模式已彻底删除，不给它留任何分支。 */
      cellLabel: label,
      padMode: 'normal',
      /* 角标新格式：【标题】 · 实际 a×b 格 · 共 N 颗 · 预计 X 小时。
         尺寸与颗数由 render.js 从 cells 现算，这里只给标题与速率。 */
      captionName: chartTitleValue(),
      beadRate: BEAD_RATE,
      /* 预览必须 annotate:false —— 绝不能把用量清单画进预览画布！
         一旦 annotate:true，画布会变高变宽（下方清单表格），而 hitTestCell 要靠画布宽度
         反推网格原点，宽度方向多出清单列就会把 pad 算错、点击整体偏移。
         另外 render.js 本来就会在网格下方加一条「成品尺寸/板数」标注带（cap.h），
         画布高度因此永远不是 2*pad + gridH —— 这也是命中判定只信宽度、不信高度的一半原因。
         用量清单只出现在导出用的离屏画布上（exportViewOpts）。
         不要为了「顺手在预览里也看看清单」把这里改成 true。 */
      annotate: false,
      /* 契约文档中的键名：同义双写，兼容任一实现 */
      cellSize: cell,
      showNumbers: codes,
      showGrid: true,
      paletteId: state.pattern ? state.pattern.paletteId : (ui.paletteSelect ? ui.paletteSelect.value : '')
    };
  }

  /* 导出的 viewOpts：与预览完全解耦——格子像素 = 24 × 倍数，白边收紧，坐标刻度跟随「显示坐标刻度」 */
  function exportScaleValue() {
    var v = Math.round(num(ui.exportScale, 2));
    for (var i = 0; i < EXPORT_SCALES.length; i++) { if (EXPORT_SCALES[i] === v) return v; }
    return 2;
  }

  function exportViewOpts(scale) {
    var cell = EXPORT_BASE_CELL * scale;
    return {
      cellPx: cell,
      cellSize: cell,
      /* 导出永远带色号，且不给用户任何导出侧的色号开关 —— 这是刻意与预览解耦：
         预览可以取消勾选「显示色号」看没有字的效果（#showCodes 只管预览），
         但交付出去的图纸必须带色号，否则拿到手的人没法按色号配豆。
         因此这里恒 'code'，绝不读 #showCodes。 */
      cellLabel: 'code',
      showCodes: true,
      showNumbers: true,
      showRuler: !!(ui.showRuler && ui.showRuler.checked),
      highlightLocked: true,
      padMode: 'tight',
      annotate: !!(ui.exportAnnotate && ui.exportAnnotate.checked),
      captionName: chartTitleValue(),
      beadRate: BEAD_RATE,
      showGrid: true,
      paletteId: state.pattern ? state.pattern.paletteId : paletteIdForOpts()
    };
  }

  function syncExportHint() {
    if (!ui.exportHint) return;
    var scale = exportScaleValue();
    var cell = EXPORT_BASE_CELL * scale;
    var tail = '导出固定按「格子 24px × 倍数」离屏重绘，与预览缩放无关；白边收紧到约 4%。'
      + '坐标刻度跟随「图纸显示」组的「显示坐标刻度」；色号永远画出（与预览的「显示色号」开关无关）。';
    var p = state.pattern;
    if (!p) { setText(ui.exportHint, tail); return; }
    setText(ui.exportHint, '当前设置：格子 ' + cell + 'px（24 × ' + scale + '），网格区约 '
      + (p.w * cell) + ' × ' + (p.h * cell) + ' 像素 / ' + (p.w * p.h) + ' 格。' + tail);
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

  /* 裁剪 / 旋转之后，宽高比必须按 SourceEdit 的结果画布算，否则裁剪过的图纸比例会不对。 */
  function pixelSourceCanvas() {
    if (!state.srcEdit || typeof state.srcEdit.getResultCanvas !== 'function') return null;
    try {
      var c = state.srcEdit.getResultCanvas();
      if (c && Number(c.width) > 0 && Number(c.height) > 0) return c;
    } catch (e) { /* 落到原图 */ }
    return null;
  }

  function hasSource() { return !!state.source; }

  function sourceAspect() {
    var c = pixelSourceCanvas();
    if (c && Number(c.width) > 0 && Number(c.height) > 0) return Number(c.width) / Number(c.height);
    if (state.srcW > 0 && state.srcH > 0) return state.srcW / state.srcH;
    return 1;
  }

  function presetValueFor(w, h) {
    if (w !== h) return 'custom';
    if (w === 29 || w === 58 || w === 87 || w === 100 || w === 116) return String(w);
    return 'custom';
  }

  function syncSizePresetValue() {
    if (!ui.sizePreset) return;
    var d = gridDims();
    setVal(ui.sizePreset, presetValueFor(d.w, d.h));
  }

  function applyBoardsPreset() {
    var sel = ui.boardsSelect;
    if (!sel) return;
    if (sel.value === 'custom') { syncSizePresetValue(); return; }
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
    syncSizePresetValue();
  }

  /* 尺寸预设：29 / 58 / 87 / 100 / 116，固定正方形（不受「保持原图宽高比」影响，因为档位名就是 W×H） */
  function applySizePreset() {
    var sel = ui.sizePreset;
    if (!sel || sel.value === 'custom') return;
    var n = clamp(Math.round(num({ value: sel.value }, 29)), 1, MAX_DIM);
    setVal(ui.gridW, n);
    setVal(ui.gridH, n);
    if (ui.boardsSelect) {
      var bs = (n === 116) ? '4' : (n === 87) ? '3' : (n === 58) ? '2' : (n === 29) ? '1' : 'custom';
      setVal(ui.boardsSelect, bs);
    }
    syncLabels();
    setStatus('已套用尺寸预设 ' + n + ' × ' + n + '（正方形）', 'info');
    scheduleRegenerate(0);
  }

  /* 手动输入格数：夹到 1..116，按需同步另一边，并把拼板规格切到「自定义」 */
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
    syncSizePresetValue();
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
    if (typeof d.maxColors === 'number') setMaxColors(d.maxColors);
    syncEnabledState();
  }

  /* 没动过控件时跟随 pipeline 默认值；动过则完全按 UI 走。 */
  function quantizeOpts() {
    var enabled = !!(ui.quantizeEnabled && ui.quantizeEnabled.checked);
    var maxColors = maxColorsSliderValue();
    var d = pipelineQuantizeDefault();
    if (d) {
      if (!state.touched.quantizeEnabled && typeof d.enabled === 'boolean') enabled = !!d.enabled;
      if (!state.touched.maxColors && typeof d.maxColors === 'number') maxColors = clampMaxColors(d.maxColors);
    }
    return { enabled: enabled, maxColors: maxColors };
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
        /* 送进 pipeline 的必须是生效值（effCurve 压缩后的），不是滑杆原值 */
        brightness: effSlider(ui.brightness, 0),
        contrast: effSlider(ui.contrast, 0),
        saturation: effSlider(ui.saturation, 0),
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

  /* 像素源优先级：SourceEdit 的裁剪/旋转结果画布 → sourceCanvas 的 RGBA → 原图对象。
     裁剪后必须用 getResultCanvas()，否则图纸会按未裁剪的原图比例生成。 */
  function pixelSource() {
    var c = pixelSourceCanvas();
    if (c) return { canvas: c, w: Number(c.width), h: Number(c.height), edited: true };
    if (state.srcCtx && state.pixW > 0) return { ctx: state.srcCtx, w: state.pixW, h: state.pixH, edited: false };
    if (state.source) return { image: state.source, w: state.srcW, h: state.srcH, edited: false };
    return null;
  }

  function runPipeline(opts) {
    var P = win.Pipeline;
    if (!P) return null;
    var ps = pixelSource();
    if (!ps) return null;
    if (ps.canvas && typeof P.generate === 'function') return P.generate(ps.canvas, opts);
    if (typeof P.generateFromRGBA === 'function' && ps.ctx) {
      var img = ps.ctx.getImageData(0, 0, ps.w, ps.h);
      var data = (img && img.data) ? img.data : img;
      return P.generateFromRGBA(data, ps.w, ps.h, opts);
    }
    if (typeof P.generate === 'function') return P.generate(ps.image || state.source || ui.sourceCanvas, opts);
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
       而 colors 的顺序同时决定图例、CSV 与改色状态提示的呈现，一旦乱序整张图纸的颜色顺序就变了。
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
    /* 记下「这一版图纸」实际生效的减色设置：汇总区要拿它和 stats.usedColors 并排显示。
       不要在这里重新读 DOM —— 用户可能已经改了 #maxColors 但防抖还没重算，
       那读到的就是「下一次的上限」，会和眼前这张图纸对不上。 */
    state.patternQuantize = {
      enabled: !!(opts.quantize && opts.quantize.enabled),
      maxColors: (opts.quantize && opts.quantize.maxColors) || 0
    };
    state.viewOpts = viewOpts();
    /* 重新生成 = 新的图纸生命周期：撤销栈里的旧快照尺寸/色表都可能对不上，整栈作废。
       这也正合语义：撤销只覆盖改色与锁定，参数变更（会触发重算）不进历史。 */
    state.history.length = 0;

    renderPattern();
    renderLegend();
    renderSummary();
    syncRecolorPicker(pattern);
    updateLockInfo();
    syncUndoButton();
    syncExportHint();
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

  /* --------------------------------------------------------- 撤销（改色 / 锁定） */

  /* 快照必须是深拷贝：cells 是 Uint16Array（slice 保留类型）、locked 是定型数组或普通数组、
     colors 是对象数组（rgb 还可能是数组）。只存引用的话撤销会拿到「已经被改过的当前值」。 */
  function cloneColors(list) {
    var out = [];
    var src = list || [];
    for (var i = 0; i < src.length; i++) {
      var c = src[i] || {};
      out.push({
        code: c.code,
        hex: c.hex,
        rgb: isArr(c.rgb) ? c.rgb.slice(0) : c.rgb,
        group: c.group
      });
    }
    return out;
  }

  function snapshotOf(p) {
    if (!p || !p.cells) return null;
    var cells = (typeof p.cells.slice === 'function') ? p.cells.slice(0) : null;
    if (!cells) return null;
    var locked = null;
    if (p.locked && typeof p.locked.slice === 'function') locked = p.locked.slice(0);
    return { w: p.w, h: p.h, cells: cells, locked: locked, colors: cloneColors(p.colors) };
  }

  function pushHistory() {
    var snap = snapshotOf(state.pattern);
    if (!snap) return false;
    state.history.push(snap);
    while (state.history.length > HISTORY_MAX) state.history.shift();
    syncUndoButton();
    return true;
  }

  function syncUndoButton() {
    var n = state.history.length;
    if (ui.btnUndo) {
      ui.btnUndo.disabled = !(state.pattern && n > 0);
      setText(ui.btnUndo, n > 0 ? ('撤销（' + n + '）') : '撤销');
    }
  }

  function undo() {
    var p = state.pattern;
    if (!p) { setStatus('尚未生成图纸，没有可撤销的操作', 'warn'); return false; }
    if (!state.history.length) { setStatus('没有可撤销的操作', 'warn'); return false; }
    var snap = state.history.pop();
    if (!snap || snap.w !== p.w || snap.h !== p.h || !snap.cells || snap.cells.length !== p.cells.length) {
      state.history.length = 0;
      syncUndoButton();
      setStatus('图纸尺寸已变化，之前的操作无法撤销', 'warn');
      return false;
    }
    p.cells = snap.cells;
    if (snap.locked) p.locked = snap.locked;
    p.colors = snap.colors;
    recount(p);
    renderPattern();
    renderLegend();
    renderSummary();
    syncRecolorPicker(p);
    updateLockInfo();
    syncUndoButton();
    setStatus('已撤销（剩余 ' + state.history.length + ' 步可撤销）', 'ok');
    return true;
  }

  /* ------------------------------------------------------------- 改色模式 */

  /* 改色必须让 Pattern.colors 始终维持 Pipeline 的「自然序」：colors 的顺序就是图例、CSV
     与状态提示呈现颜色时的顺序，下标一乱，整张图纸的颜色顺序就变了。
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
    var already = indexOfCode(p, code);
    if (already < 0 && !findPaletteColor(p.paletteId, code)) {
      setStatus('色号 ' + code + ' 不在当前色卡中，无法改色', 'warn');
      return;
    }
    pushHistory();                       /* 快照必须在改动之前取 */
    var ci = already;
    if (ci < 0) ci = insertColorNatural(p, code);
    if (ci < 0) { state.history.pop(); syncUndoButton(); setStatus('色号 ' + code + ' 不在当前色卡中，无法改色', 'warn'); return; }
    p.cells[idx] = ci;
    if (p.locked) p.locked[idx] = lock ? 1 : 0;
    pruneUnusedColors(p);
    recount(p);
    var finalCi = p.cells[idx];
    renderPattern();
    renderLegend();
    renderSummary();
    updateLockInfo();
    var doneCode = p.colors[finalCi] ? p.colors[finalCi].code : '?';
    setStatus('已改色：第 ' + (Math.floor(idx / p.w) + 1) + ' 行 第 ' + (idx % p.w + 1) + ' 列 → 色号 '
      + doneCode + (lock ? '［已锁定，重新生成时保留］' : '［未锁定］'), 'ok');
  }

  /* 点击坐标 → 格子下标。
   * 优先使用 Render.hitTest(pattern, canvas, px, py, viewOpts)（若渲染模块提供）；
   * 否则用「画布宽度」反推留白：render.js 与内置降级渲染器都是 (pad, pad) 处起画、
   * 左右留白相等，且预览为 annotate:false ⇒ 内容宽 == 网格宽，于是
   * pad = (canvas.width - w*cellPx) / 2，X/Y 共用（见下方为何不能用 height 反推）。
   *
   * 预览缩放（viewZoom）只改 canvas 的 CSS 宽高，不改 canvas.width；
   * getBoundingClientRect() 量到的就是缩放后的 CSS 尺寸，所以 cv.width / rect.width 恰好是 1/zoom，
   * 折算回来的就是真实的画布像素坐标 —— 无论怎么缩放，这里都不需要额外乘除 zoom。 */
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
    var cell = v.cellSize || v.cellPx || DEFAULT_CELL_PX;
    var gridW = p.w * cell;
    /* 网格原点 (pad, pad)：两种渲染器都保证「左留白 == 上留白 == 右留白」。
       但**画布高度不等于 2*pad + gridH**：render.js 会在网格下方追加
          · annotate 的用量表（预览恒 annotate:false，不出现），
          · 一行「成品尺寸 / 板数」标注带 cap.h（总是出现，与 annotate 无关）。
       所以不能用 (cv.height - gridH)/2 反推——那会把原点整体下移 cap.h/2，
       格子越小越致命（cellPx=8 时正好差一整格，点击全部错行）。
       画布宽度没有这两条附加带（预览 annotate:false ⇒ 内容宽 == 网格宽），
       于是 pad 可以从宽度唯一还原，X/Y 共用同一个值。 */
    var pad = (cv.width > gridW) ? Math.floor((cv.width - gridW) / 2) : 0;
    var col = Math.floor((px - pad) / cell);
    var row = Math.floor((py - pad) / cell);
    if (col < 0 || row < 0 || col >= p.w || row >= p.h) return -1;
    return row * p.w + col;
  }

  /* --------------------------------------------------- 标签页（基本 / 高级） */

  /* 只切 hidden：不重建 DOM、不写 innerHTML ⇒ 任何控件状态（滑杆值、勾选、标题文本）都不会丢。 */
  function setTab(name) {
    var v = (name === TAB_ADVANCED) ? TAB_ADVANCED : TAB_BASIC;
    var basic = (v === TAB_BASIC);
    state.tab = v;
    if (ui.panelBasic) ui.panelBasic.hidden = !basic;
    if (ui.panelAdvanced) ui.panelAdvanced.hidden = basic;
    markTabButton(ui.tabBasic, basic);
    markTabButton(ui.tabAdvanced, !basic);
  }

  function markTabButton(btn, on2) {
    if (!btn) return;
    toggleCls(btn, 'on', !!on2);
    if (typeof btn.setAttribute === 'function') {
      try { btn.setAttribute('aria-selected', on2 ? 'true' : 'false'); } catch (e) { /* 忽略 */ }
    }
  }

  /* ------------------------------------------------- 图纸工具（互斥的单选状态） */

  function isTool(v) { return v === TOOL_RECOLOR || v === TOOL_WAND || v === TOOL_ERASER; }

  function toolOf() { return isTool(state.tool) ? state.tool : TOOL_NONE; }

  function toolName(t) {
    if (t === TOOL_RECOLOR) return '改色';
    if (t === TOOL_WAND) return '魔术棒';
    if (t === TOOL_ERASER) return '橡皮刷';
    return '关闭';
  }

  /* 工具状态的唯一写入口：三项单选、#recolorMode 复选框、画布光标、锁定提示全部由它对齐。
     任何时刻只有一个工具生效——勾上改色就自动取消魔术棒 / 橡皮刷的单选，反之亦然。 */
  function setTool(t, silent) {
    var v = isTool(t) ? t : TOOL_NONE;
    var changed = (state.tool !== v);
    state.tool = v;
    if (v !== TOOL_ERASER) state.eraseActive = false;   /* 中途换工具：结束这次拖动语义 */
    setChecked(ui.recolorMode, v === TOOL_RECOLOR);
    setChecked(ui.toolNone, v === TOOL_NONE);
    setChecked(ui.toolWand, v === TOOL_WAND);
    setChecked(ui.toolEraser, v === TOOL_ERASER);
    if (ui.eraserSize) ui.eraserSize.disabled = (v !== TOOL_ERASER);
    if (ui.patternCanvas && hasClassList(ui.patternCanvas)) toggleCls(ui.patternCanvas, 'editing', v !== TOOL_NONE);
    /* 图纸画布只有「橡皮刷」是按住拖动类工具，才需要 touch-action:none 把滚动让出来；
       魔术棒 / 改色都是一次点击，保留默认滚动（用户还得单指滑动看大图）。
       用加/去 class 切换，绝不把 touch-action:none 写死在 CSS 里。 */
    if (ui.patternCanvas && hasClassList(ui.patternCanvas)) toggleCls(ui.patternCanvas, TOUCH_DRAG_CLASS, v === TOOL_ERASER);
    syncToolHint();
    updateLockInfo();
    if (changed && !silent) setStatus('图纸工具：' + toolName(v), 'info');
  }

  function syncToolHint() {
    if (!ui.toolHint) return;
    var t = toolOf();
    var text;
    if (t === TOOL_WAND) {
      text = '魔术棒：点击图纸上的一格，会删掉与它上下左右相连（不斜连）、色号相同的整片区域。单次最多擦除 ' + WAND_MAX + ' 格。';
    } else if (t === TOOL_ERASER) {
      text = '橡皮刷：在图纸上按住拖动即可擦掉划过的格子（当前 ' + brushSizeValue() + ' × ' + brushSizeValue()
        + '，越界自动裁剪）。整个一次拖动只算一步撤销。';
    } else if (t === TOOL_RECOLOR) {
      text = '当前工具：改色（在上方色板里选目标色号后点击格子）。要抠图请改选「魔术棒」或「橡皮刷」。';
    } else {
      text = '未开启任何图纸工具：点击格子不会有任何改动。擦掉的格子会置空并锁定，重新生成时保持为空。';
    }
    setText(ui.toolHint, text);
  }

  function brushSizeValue() {
    var v = Math.round(num(ui.eraserSize, 1));
    return (v === 3 || v === 5) ? v : 1;
  }

  /* 刷子覆盖的下标：以落点为中心对齐，越界直接裁掉（不环绕、不折行） */
  function brushIndices(p, idx) {
    var size = brushSizeValue();
    if (size <= 1) return [idx];
    var half = (size - 1) / 2;
    var x = idx % p.w;
    var y = (idx - x) / p.w;
    var out = [];
    for (var dy = -half; dy <= half; dy++) {
      var yy = y + dy;
      if (yy < 0 || yy >= p.h) continue;
      for (var dx = -half; dx <= half; dx++) {
        var xx = x + dx;
        if (xx < 0 || xx >= p.w) continue;
        out.push(yy * p.w + xx);
      }
    }
    return out;
  }

  /* locked 缺失 / 长度不符时补齐：抠图必须能写下 locked[idx]=1（持久化的关键） */
  function ensureLocked(p) {
    if (!p || !p.cells) return;
    if (p.locked && p.locked.length === p.cells.length) return;
    var a = [];
    for (var i = 0; i < p.cells.length; i++) a.push((p.locked && p.locked[i]) ? 1 : 0);
    p.locked = a;
  }

  /* 把一组下标置为空 + 锁定；返回真正改变的格数（已经是空的格子不重复计） */
  function blankCells(p, list) {
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      var idx = list[i];
      if (idx < 0 || idx >= p.cells.length) continue;
      if (p.cells[idx] === EMPTY_CELL) continue;
      p.cells[idx] = EMPTY_CELL;
      if (p.locked) p.locked[idx] = 1;
      n++;
    }
    return n;
  }

  /* 擦除的统一收尾：清掉零颗色号 → 重算用量 → 重绘 + 刷新图例 / 汇总 / 锁定计数 */
  function finishErase(count) {
    var p = state.pattern;
    if (!p) return;
    pruneUnusedColors(p);
    recount(p);
    renderPattern();
    renderLegend();
    renderSummary();
    syncRecolorPicker(p);
    updateLockInfo();
    syncUndoButton();
    setStatus('已擦除 ' + count + ' 格（这些格子已置空并锁定，重新生成时保持为空）', 'ok');
  }

  /* 魔术棒：四连通（上下左右，不斜连）洪泛；条件是与起点同色号且非空。
     超过 WAND_MAX 格只擦前 WAND_MAX 格并提示，避免一张大图点一下就卡死。 */
  function wandErase(idx) {
    var p = state.pattern;
    if (!p || !p.cells) { setStatus('尚未生成图纸', 'warn'); return 0; }
    if (idx < 0 || idx >= p.cells.length) return 0;
    var color = p.cells[idx];
    if (color === EMPTY_CELL) { setStatus('这一格已经是空的，魔术棒没有可擦除的连通区域', 'warn'); return 0; }
    var w = p.w, h = p.h;
    var seen = {};
    var q = [idx];
    var head = 0;
    var region = [];
    var truncated = false;
    seen[idx] = 1;
    while (head < q.length) {
      if (region.length >= WAND_MAX) { truncated = true; break; }
      var cur = q[head++];
      region.push(cur);
      var x = cur % w;
      var y = (cur - x) / w;
      if (x > 0) pushNeighbor(cur - 1);
      if (x < w - 1) pushNeighbor(cur + 1);
      if (y > 0) pushNeighbor(cur - w);
      if (y < h - 1) pushNeighbor(cur + w);
    }
    function pushNeighbor(j) {
      if (seen[j]) return;
      if (j < 0 || j >= p.cells.length) return;
      if (p.cells[j] !== color) return;      /* 同色号且非空（color 本身非空） */
      seen[j] = 1;
      q.push(j);
    }
    if (!region.length) return 0;
    ensureLocked(p);
    pushHistory();                           /* 快照必须在改动之前取 */
    var n = blankCells(p, region);
    if (!n) { state.history.pop(); syncUndoButton(); return 0; }
    finishErase(n);
    if (truncated) {
      setStatus('已擦除 ' + n + ' 格：连通区域超过单次上限 ' + WAND_MAX + ' 格，本次只擦除了前 ' + WAND_MAX
        + ' 格，可再次点击继续。', 'warn');
    }
    return n;
  }

  /* 橡皮刷：pointerdown 起手 → pointermove 连续擦除 → pointerup 统一收尾。
     整段拖动只在 pointerdown 快照一次；move 期间只重绘（不写历史、不 recount），让用户即时看到效果。 */
  function onEraseDown(evt) {
    if (toolOf() !== TOOL_ERASER) return;
    /* 双指在画布上 == 用户在捏合缩放：这一下不是擦除 */
    if (pinch.active) return;
    /* 一次拖动还没收尾又来一个 pointerdown == 第二根手指落下。
       直接返回（不重复 pushHistory），这样捏合起手时的 undo() 能一步回滚干净。 */
    if (state.eraseActive) return;
    var p = state.pattern;
    if (!p || !p.cells) { setStatus('尚未生成图纸', 'warn'); return; }
    var idx = hitTestCell(evt);
    if (idx < 0) return;
    ensureLocked(p);
    var list = brushIndices(p, idx);
    var any = false;
    for (var i = 0; i < list.length; i++) { if (p.cells[list[i]] !== EMPTY_CELL) { any = true; break; } }
    if (!any) return;                        /* 起手就全是空的：不占一步历史 */
    state.eraseActive = true;
    state.eraseCount = 0;
    pushHistory();                           /* 一次拖动 = 一步撤销 */
    state.eraseCount += blankCells(p, list);
    scheduleRender();                        /* 即时看到效果（按帧合并，不在 move 里重复重绘） */
    if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
    var cv = ui.patternCanvas;
    if (cv && typeof cv.setPointerCapture === 'function' && evt && evt.pointerId !== undefined && evt.pointerId !== null) {
      try { cv.setPointerCapture(evt.pointerId); } catch (e) { /* 某些环境不支持，忽略 */ }
    }
  }

  function onEraseMove(evt) {
    if (pinch.active) return;
    if (!state.eraseActive) return;
    var p = state.pattern;
    if (!p || !p.cells) return;
    var idx = hitTestCell(evt);
    if (idx < 0) return;
    var n = blankCells(p, brushIndices(p, idx));
    if (n > 0) { state.eraseCount += n; scheduleRender(); }
  }

  function onEraseUp() {
    if (!state.eraseActive) return;
    state.eraseActive = false;
    var n = state.eraseCount;
    state.eraseCount = 0;
    if (!n) { syncUndoButton(); return; }
    finishErase(n);
  }

  function onPatternClick(evt) {
    /* 捏合过程中、以及捏合刚结束的那一小段时间：不认这一下
       （两指抬起后浏览器仍可能补一个 click，魔术棒 / 改色都不该被它触发） */
    if (pinch.active || intNow() < pinch.blockedUntil) return;
    var p = state.pattern;
    if (!p) { setStatus('尚未生成图纸', 'warn'); return; }
    var tool = toolOf();
    /* 橡皮刷完全由 pointerdown/move/up 驱动：这里什么都不做，免得一次拖动被算成两步 */
    if (tool === TOOL_ERASER) return;
    if (tool === TOOL_WAND) {
      var wi = hitTestCell(evt);
      if (wi < 0) { setStatus('点击位置不在图纸网格内（可调大「格子像素大小」后重试）', 'warn'); return; }
      wandErase(wi);
      return;
    }
    if (tool !== TOOL_RECOLOR) return;       /* 未开启任何工具：点击不改动图纸 */

    var idx = hitTestCell(evt);
    if (idx < 0) { setStatus('点击位置不在图纸网格内（可调大「格子像素大小」后重试）', 'warn'); return; }
    if (evt && (evt.altKey || evt.shiftKey)) {
      if (p.locked) {
        pushHistory();
        p.locked[idx] = p.locked[idx] ? 0 : 1;
      }
      renderPattern();
      updateLockInfo();
      setStatus(p.locked && p.locked[idx] ? '已锁定该格' : '已解锁该格', 'ok');
      return;
    }
    var code = recolorCode();
    if (!code) { setStatus('请先在上方色板里选一个目标色号', 'warn'); return; }
    var lock = !(ui.lockToggle && !ui.lockToggle.checked);
    applyRecolor(idx, code, lock);
  }

  function unlockAll() {
    var p = state.pattern;
    if (!p || !p.locked) { setStatus('当前没有可解锁的图纸', 'warn'); return; }
    var any = false;
    for (var k = 0; k < p.locked.length; k++) { if (p.locked[k]) { any = true; break; } }
    if (!any) { setStatus('当前没有锁定的格子', 'warn'); return; }
    pushHistory();
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
    var tool = toolOf();
    var lockOn = !(ui.lockToggle && !ui.lockToggle.checked);
    var text = '已锁定 ' + n + ' 格';
    if (tool === TOOL_RECOLOR) text += '（改色模式已开启' + (lockOn ? '，点击后自动锁定' : '，点击不锁定') + '）';
    else if (tool !== TOOL_NONE) text += '（当前工具：' + toolName(tool) + '，擦掉的格子会自动锁定）';
    setText(ui.lockInfo, text);
  }

  /* ------------------------------------------------------- 选色器（色板网格） */

  function normQuery(s) {
    var q = String(s === null || s === undefined ? '' : s).trim().toLowerCase();
    if (q.charAt(0) === '#') q = q.slice(1);
    return q;
  }

  function swatchMatch(c, q) {
    if (!q) return true;
    var code = String(c && c.code ? c.code : '').toLowerCase();
    var hex = String(c && c.hex ? c.hex : '').toLowerCase();
    if (hex.charAt(0) === '#') hex = hex.slice(1);
    if (code === q || hex === q) return true;
    if (code.indexOf(q) === 0) return true;
    if (hex.indexOf(q) === 0) return true;
    return false;
  }

  function swatchHTML(c, selected, extraClass, count) {
    var hex = (c && c.hex) ? c.hex : '#000000';
    var code = (c && c.code) ? String(c.code) : '';
    var tip = code + ' · ' + hex + (count ? (' · ' + count + ' 颗') : '');
    return '<button type="button" class="sw' + (extraClass ? (' ' + extraClass) : '') + (selected ? ' sw-on' : '')
      + '" data-code="' + esc(code) + '" title="' + esc(tip) + '" aria-label="' + esc(tip) + '"'
      + ' style="background:' + esc(hex) + ';color:' + contrastText(c && c.rgb) + '">'
      + '<span class="sw-code">' + esc(code) + '</span></button>';
  }

  /* 本图用到的色号：直接从 pattern.counts 取（recount 已按颗数降序排好），常用的排在前面 */
  function usedColorList(p) {
    var out = [];
    if (!p) return out;
    var list = p.counts;
    var i;
    if (list && list.length) {
      for (i = 0; i < list.length; i++) out.push({ code: list[i].code, hex: list[i].hex, rgb: list[i].rgb, count: list[i].count });
      return out;
    }
    for (i = 0; i < (p.colors || []).length; i++) {
      out.push({ code: p.colors[i].code, hex: p.colors[i].hex, rgb: p.colors[i].rgb });
    }
    return out;
  }

  /* 整张色卡：按 group（A–H/M）分组，保持色表自然序 */
  function allColorGroups() {
    var pal = paletteById(paletteIdForOpts()) || currentPalette();
    var groups = [], index = {};
    var colors = (pal && pal.colors) ? pal.colors : [];
    for (var i = 0; i < colors.length; i++) {
      var c = colors[i];
      if (!c) continue;
      var g = c.group ? String(c.group) : '其他';
      if (!index[g]) { index[g] = { label: g, items: [] }; groups.push(index[g]); }
      index[g].items.push(c);
    }
    return groups;
  }

  function pickerGroups() {
    var q = normQuery(state.recolor.search);
    var scope = (state.recolor.scope === PICKER_SCOPE_ALL) ? PICKER_SCOPE_ALL : PICKER_SCOPE_USED;
    var out = [], i, j;
    if (scope === PICKER_SCOPE_ALL) {
      var gs = allColorGroups();
      for (i = 0; i < gs.length; i++) {
        var items = [];
        for (j = 0; j < gs[i].items.length; j++) {
          if (swatchMatch(gs[i].items[j], q)) items.push(gs[i].items[j]);
        }
        out.push({ label: gs[i].label, items: items, key: 'g' + i });
      }
      return out;
    }
    var flat = [];
    var used = usedColorList(state.pattern);
    for (i = 0; i < used.length; i++) { if (swatchMatch(used[i], q)) flat.push(used[i]); }
    out.push({ label: '', items: flat, key: 'used' });
    return out;
  }

  function pickerEmptyText(total, q, scope) {
    if (total > 0) return '';
    if (q) return '无匹配';
    if (scope === PICKER_SCOPE_ALL) return '色卡数据未加载';
    if (!state.pattern) return '尚未生成图纸：生成后这里会按颗数列出本图用到的色号';
    return '本图暂无已用色号';
  }

  function renderRecolorGrid() {
    var box = ui.recolorGrid;
    if (!box) return;
    var scope = (state.recolor.scope === PICKER_SCOPE_ALL) ? PICKER_SCOPE_ALL : PICKER_SCOPE_USED;
    var q = normQuery(state.recolor.search);
    var groups = pickerGroups();
    var html = '', total = 0, i, j;
    for (i = 0; i < groups.length; i++) {
      var items = groups[i].items;
      if (!items.length) continue;
      html += '<div class="sw-group">';
      if (groups[i].label) html += '<div class="sw-group-label">' + esc(groups[i].label) + '</div>';
      html += '<div class="sw-grid">';
      for (j = 0; j < items.length; j++) {
        total++;
        html += swatchHTML(items[j], String(state.recolor.selected) === String(items[j].code), '', items[j].count);
      }
      html += '</div></div>';
    }
    box.innerHTML = html;
    if (ui.recolorEmpty) {
      var msg = pickerEmptyText(total, q, scope);
      ui.recolorEmpty.hidden = !msg;
      if (msg) setText(ui.recolorEmpty, msg);
    }
  }

  /* 只改高亮、不重建 DOM：重建 innerHTML 会把网格的滚动位置清零（选一次颜色就跳回顶部）。 */
  function syncSwatchHighlight() {
    var box = ui.recolorGrid;
    if (!box || typeof box.querySelectorAll !== 'function') return;
    var nodes = box.querySelectorAll('button[data-code]');
    if (!nodes || typeof nodes.length !== 'number') return;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var on2 = String(n.getAttribute ? n.getAttribute('data-code') : '') === String(state.recolor.selected);
      toggleCls(n, 'sw-on', on2);
    }
  }

  function readRecentColors() {
    var raw = storageGet(RECENT_KEY);
    if (!raw) return [];
    var arr = null;
    try { arr = JSON.parse(raw); } catch (e) { return []; }
    if (!isArr(arr)) return [];
    var out = [];
    for (var i = 0; i < arr.length && out.length < RECENT_MAX; i++) {
      var c = String(arr[i] === null || arr[i] === undefined ? '' : arr[i]);
      if (c && out.indexOf(c) < 0) out.push(c);
    }
    return out;
  }

  function noteRecentColor(code) {
    if (!code) return;
    var list = state.recolor.recent;
    var i = list.indexOf(code);
    if (i >= 0) list.splice(i, 1);
    list.unshift(code);
    if (list.length > RECENT_MAX) list.length = RECENT_MAX;
    storageSet(RECENT_KEY, JSON.stringify(list));   /* file:// 下可能失败，静默降级为仅本次会话有效 */
    renderRecentColors();
  }

  function renderRecentColors() {
    var box = ui.recolorRecentRow;
    if (!box) return;
    var list = state.recolor.recent;
    var html = '', used = 0;
    for (var i = 0; i < list.length; i++) {
      var c = findPaletteColor(paletteIdForOpts(), list[i]);
      if (!c) continue;
      used++;
      html += swatchHTML({ code: c.code, hex: c.hex, rgb: c.rgb }, String(state.recolor.selected) === String(c.code), 'sw-sm', 0);
    }
    if (!used) html = '<span class="muted">选过的色号会出现在这里</span>';
    box.innerHTML = html;
  }

  function syncRecolorCurrent() {
    if (!ui.recolorCurrent) return;
    var code = state.recolor.selected;
    if (!code) { setText(ui.recolorCurrent, '当前目标色号：未选择'); return; }
    var c = findPaletteColor(paletteIdForOpts(), code);
    setText(ui.recolorCurrent, '当前目标色号：' + code + (c && c.hex ? (' · ' + c.hex) : ''));
  }

  function recolorCode() {
    var code = state.recolor.selected;
    if (code && findPaletteColor(paletteIdForOpts(), code)) return code;
    var p = state.pattern;
    if (p && p.counts && p.counts.length) return p.counts[0].code;
    if (p && p.colors && p.colors.length) return p.colors[0].code;
    var pal = currentPalette();
    if (pal && pal.colors && pal.colors.length) return pal.colors[0].code;
    return code || '';
  }

  function selectRecolorCode(code) {
    if (!code) return;
    state.recolor.selected = String(code);
    noteRecentColor(state.recolor.selected);
    syncRecolorCurrent();
    syncSwatchHighlight();
    renderRecentColors();
    var c = findPaletteColor(paletteIdForOpts(), state.recolor.selected);
    setStatus('目标色号：' + state.recolor.selected + (c && c.hex ? ('（' + c.hex + '）') : ''), 'info');
  }

  /* 重建色板网格。关键约束：不能把用户当前选中的色号重置掉。 */
  function syncRecolorPicker(pattern) {
    if (state.recolor.scope !== PICKER_SCOPE_ALL) state.recolor.scope = PICKER_SCOPE_USED;
    if (ui.recolorScope) setVal(ui.recolorScope, state.recolor.scope);
    if (ui.recolorSearch && String(ui.recolorSearch.value || '') !== state.recolor.search) {
      setVal(ui.recolorSearch, state.recolor.search);
    }
    var keep = state.recolor.selected;
    if (!keep || !findPaletteColor(paletteIdForOpts(), keep)) {
      state.recolor.selected = (pattern && pattern.counts && pattern.counts.length) ? pattern.counts[0].code : '';
    }
    renderRecolorGrid();
    renderRecentColors();
    syncRecolorCurrent();
  }

  function onRecolorPick(evt) {
    var t = evt && evt.target;
    var root = evt && evt.currentTarget;
    while (t && t !== root) {
      if (t.getAttribute && t.getAttribute('data-code')) { selectRecolorCode(t.getAttribute('data-code')); return; }
      t = t.parentNode;
    }
  }

  /* --------------------------------------------------------------- 渲染区 */

  /* ok:false 的原因文案。三类原因处置完全不同，消息不能互相冒充：
     · too-large        我们的面积预算在分配画布前就拒绝了（needPixels > maxPixels）；
     · canvas-rejected  面积没超，是**浏览器**拒绝了我们合法申请的那块画布（回读尺寸不符）——
                        移动端（iOS Safari / WKWebView、部分 Android WebView）的主体情形，
                        这里的措辞必须落到「这台设备 / 这个浏览器」上，否则用户会去怀疑自己的图；
     · invalid-input    调用方输入有问题（没有 canvas / 宿主没 getContext 方法 / 上下文为空）。
     两种尺寸类原因都带上 needPixels / maxPixels 量级：render.js 在拒绝路径上如实返回了它们。
     这里只描述原因、不给建议 —— 「调小格子像素」是预览的出路，「降低导出倍数」是导出的出路，
     两条出路由各自的调用点补，混在这里会说错对象。 */
  function renderFailReason(res) {
    var reason = (res && res.reason) ? String(res.reason) : '';
    var need = res && Number(res.needPixels) > 0 ? Number(res.needPixels) : 0;
    var max = res && Number(res.maxPixels) > 0 ? Number(res.maxPixels) : 0;
    var extra = (need && max) ? ('（需要约 ' + fmtPx(need) + ' 像素，浏览器上限约 ' + fmtPx(max) + '）') : '';
    if (reason === 'too-large') return '格子像素太大，画布超出浏览器上限' + extra;
    if (reason === 'canvas-rejected') return '这台设备 / 这个浏览器画不出这么大的画布' + extra;
    if (reason === 'invalid-input') return '渲染模块拒绝了这个画布或图纸数据';
    return reason || '渲染模块拒绝了本次绘制';
  }

  /* 渲染层自报的格内文字阈值：按当前模式缓存，供 #cellLabelHint 用真实数字提示用户 */
  function recordLabelMinPx(res) {
    if (!res || typeof res.labelMinPx !== 'number' || !(res.labelMinPx > 0)) return;
    var label = cellLabelOf();
    if (label === 'none') return;
    state.labelMinPx[label] = Math.round(res.labelMinPx);
    syncCellLabelHint();
  }

  function renderPattern() {
    var cv = ui.patternCanvas;
    var p = state.pattern;
    setCanvasPlaceholders();
    if (!cv || !p) { applyViewZoom(); return; }
    state.viewOpts = viewOpts();
    var v = state.viewOpts;
    var R = win.Render;
    var fell = false;
    if (R && typeof R.drawPattern === 'function') {
      var res = null;
      try {
        res = R.drawPattern(p, cv, v);
      } catch (e) {
        fell = true;
        useFallbackRender(cv, p, v, '渲染失败，已改用内置简化渲染：' + errText(e));
      }
      /* 新契约：ok === false 时画布可能没被画出来。此时不要用内置渲染器硬画
         （内置渲染器同样会撑爆画布），保留旧内容并给出明确提示。 */
      if (!fell && res && res.ok === false) {
        state.renderTooLarge = true;
        setStatus('预览无法渲染：' + renderFailReason(res) + '（请调小「图纸显示」组的「格子像素大小」）', 'warn');
        applyViewZoom();
        return;
      }
      state.renderTooLarge = false;
      recordLabelMinPx(res);
    } else {
      fell = true;
      useFallbackRender(cv, p, v, null);
    }
    if (!fell && (!cv.width || cv.width < 2)) { fell = true; useFallbackRender(cv, p, v, null); }
    state.renderFallback = fell;
    if (hasClassList(cv)) {
      toggleCls(cv, 'editing', toolOf() !== TOOL_NONE);
    }
    applyViewZoom();
  }

  function contrastText(rgb) {
    var r = 0, g = 0, b = 0;
    if (isArr(rgb)) { r = rgb[0]; g = rgb[1]; b = rgb[2]; }
    else if (rgb && typeof rgb === 'object') { r = rgb.r; g = rgb.g; b = rgb.b; }
    r = Number(r) || 0; g = Number(g) || 0; b = Number(b) || 0;
    return ((0.299 * r + 0.587 * g + 0.114 * b) > 150) ? '#1b1b1b' : '#f5f5f5';
  }

  /* 内置降级渲染：render.js 缺失或抛错时仍能看到图纸（不依赖任何外部模块）。
     预览布局与 render.js 一致：左右上下留白都是 pad，网格从 (pad, pad) 起画，
     于是 hitTestCell 的「pad = (画布宽 - w*cellPx)/2」推断对两种渲染器都精确成立。
     导出（padMode:'tight' + annotate）会额外留出清单栏，但那只走导出路径，与命中判定无关；
     预览恒 annotate:false，所以宽度方向不会有清单列、高度方向也不会有表格。 */
  function fallbackPad(v, cell, p) {
    if (v.showRuler) return RULER_PAD;
    if (v.padMode !== 'tight') return RULER_PAD;
    return Math.max(2, Math.round(Math.max(p.w, p.h) * cell * 0.04));   /* 白边收到约 4% */
  }

  /* 内置渲染器会开多大的画布 —— 唯一一处算法。
     面积守卫与绘制都调它，绝不两处各算一遍（那正是「守卫看着没问题、画出来却撑爆」的来源）。 */
  function fallbackCanvasSize(p, v) {
    var cell = v.cellSize || v.cellPx || DEFAULT_CELL_PX;
    var pad = fallbackPad(v, cell, p);
    var list = v.annotate ? listEntries(p) : null;
    var rowH = Math.max(14, Math.min(22, Math.round(cell * 1.1)));
    var listFont = Math.max(11, Math.min(18, Math.round(cell * 0.9)));
    var listW = list ? clamp(Math.round(cell * 10), 180, 420) : 0;
    var perCol = list ? Math.max(1, Math.floor((pad * 2 + p.h * cell - 26) / rowH)) : 0;
    var cols = list ? Math.min(3, Math.max(1, Math.ceil((list.length + 1) / perCol))) : 0;
    if (list) listW = Math.max(listW, cols * (listFont * 12));
    return { w: pad * 2 + p.w * cell + listW, h: pad * 2 + p.h * cell };
  }

  /* 内置降级渲染器是个**没有面积守卫、也没有回读校验**的入口：
     它自己写 cv.width/cv.height，浏览器对超限面积会静默拒绝 —— 照旧画下去就是白图。
     app.js 没有 render 侧的回读能力，所以这里只能做「动手之前先按同一个口径算一次面积」，
     超了就明确失败、不硬画。够用：把第二个白图入口堵上。
     上限口径与 render.js 的 MAX_CANVAS_PIXELS 一致（1.2 亿像素）；
     刻意不按「移动端更低」拍一个数 —— 没有真机数据就不猜（render.js 的 opts.maxPixels 同理不传）。 */
  var FALLBACK_MAX_PIXELS = 120000000;

  function fallbackTooLarge(p, v) {
    var size = fallbackCanvasSize(p, v);
    var need = size.w * size.h;
    if (need <= FALLBACK_MAX_PIXELS) return null;
    return { needPixels: need, maxPixels: FALLBACK_MAX_PIXELS, width: size.w, height: size.h };
  }

  /* 所有走内置渲染器的地方都必须从这里过：超限就只报错，一笔都不画。 */
  function useFallbackRender(cv, p, v, why) {
    var guard = fallbackTooLarge(p, v);
    if (guard) {
      state.renderTooLarge = true;
      setStatus('这张图超出画布面积上限（需要约 ' + fmtPx(guard.needPixels) + ' 像素，上限约 ' + fmtPx(guard.maxPixels)
        + '），内置渲染器也没有画它。请调小「图纸显示」组的「格子像素大小」后重试。', 'err');
      return false;
    }
    fallbackDrawPattern(cv, p, v);
    if (why) setStatus(why, 'warn');
    return true;
  }

  function fallbackDrawPattern(cv, p, v) {
    if (!cv || typeof cv.getContext !== 'function' || !p || !p.cells) return;
    var cell = v.cellSize || v.cellPx || DEFAULT_CELL_PX;
    var label = v.cellLabel || (v.showNumbers === false ? 'none' : 'code');
    if (label !== 'none') state.labelMinPx[label] = LABEL_MIN_PX;   /* 内置渲染器自己的阈值，提示文案才准 */
    var size = fallbackCanvasSize(p, v);
    cv.width = size.w;
    cv.height = size.h;
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
        if (label !== 'none' && cell >= LABEL_MIN_PX) {
          /* 与 render.js 一致：格内只画色号字符串，阈值沿用它的 MIN_CODE_PX；
             墨色按其底色明暗取反以保证可读 */
          ctx.fillStyle = contrastText(col.rgb);
          ctx.font = Math.max(7, Math.floor(cell * 0.42)) + 'px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(col.code), dx + cell / 2, dy + cell / 2 + 0.5);
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

    if (list) drawUsageList(ctx, list, pad * 2 + p.w * cell, pad, rowH, listFont, perCol, cols);
  }

  function listEntries(p) {
    var out = [];
    var list = (p && p.counts) ? p.counts : [];
    for (var i = 0; i < list.length; i++) {
      out.push(list[i].code + ' ' + list[i].hex + ' × ' + list[i].count);
    }
    return out;
  }

  function drawUsageList(ctx, list, x0, y0, rowH, font, perCol, cols) {
    ctx.fillStyle = '#2B3240';
    ctx.font = 'bold ' + font + 'px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('色号用量清单（共 ' + list.length + ' 色）', x0, y0);
    ctx.font = font + 'px sans-serif';
    var shown = Math.min(list.length, perCol * cols);
    for (var i = 0; i < shown; i++) {
      var c = Math.floor(i / perCol), r = i % perCol;
      ctx.fillText(String(i + 1) + '. ' + list[i], x0 + c * (font * 12), y0 + 26 + r * rowH);
    }
    if (shown < list.length) {
      ctx.fillText('…还有 ' + (list.length - shown) + ' 色（见 CSV 清单）', x0, y0 + 26 + perCol * rowH);
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
    /* 减色设置取「生成这张图纸时真正生效的值」；极端情况下（没有记录）才回落到当前设置 */
    var q = state.patternQuantize || quantizeOpts();
    var html = '';
    html += summaryRow('总颗数', total + ' 颗');
    html += summaryRow('用色数', used + ' 色');
    /* 只有真的启用了减色才有「上限」可言；没启用就不显示这一行，也不假装有个数字 */
    if (q && q.enabled) html += summaryRow('减色上限', q.maxColors + ' 色');
    html += summaryRow('成品尺寸', fmt1(s.cmW) + ' × ' + fmt1(s.cmH) + ' cm');
    html += summaryRow('拼板', ((s.boardX !== null && s.boardX !== undefined) ? s.boardX : '—')
      + ' × ' + ((s.boardY !== null && s.boardY !== undefined) ? s.boardY : '—') + ' 板');
    html += summaryRow('图纸格数', p.w + ' × ' + p.h);
    html += summaryRow('色卡', p.paletteId || '—');
    var note = quantizeNote(q, used);
    if (note) html += '<p class="hint">' + esc(note) + '</p>';
    ui.summaryBox.innerHTML = html;
  }

  /* 「用色数」与「减色上限」对不上时，用一句不撒谎的话解释差额。
   *
   * 为什么只做中性文案、不做原因归因：要把差额拆成「原图可区分的颜色本来就少」与
   * 「算法没把上限用满」，需要量化器实际选中的色数（pipeline 里那个 qr.used.length）或
   * 「最近邻可达色号数」；而 Pattern 契约里只有 stats.usedColors 一个数，
   * 没有任何可达色数 / 量化器选色数的字段。从外部重新跑一遍去猜是被禁止的，
   * 而归错因（把算法损失说成「原图颜色少」）比少说一句更糟 —— 所以这里只陈述
   * 「上限保证的是什么」和「实际受哪些限制」，不指认具体是哪一种。
   * 判据一旦进契约（例如 stats 暴露量化器选色数），再在这里拆成两条更精确的文案。 */
  function quantizeNote(q, used) {
    if (!q || !q.enabled) return '';        /* 没启用减色 = 没有上限，也就没有差额可解释 */
    if (!(used > 0) || !(q.maxColors > 0)) return '';
    if (used === q.maxColors) return '';    /* 正好用满，没有差额 */
    if (used > q.maxColors) {
      return '实际用色（' + used + ' 色）已超过色数上限 ' + q.maxColors + ' 色：'
        + '上限只约束算法的自动减色，手动改色新增的色号不受它限制。';
    }
    return '实际用色 ' + used + ' 色，少于色数上限 ' + q.maxColors + ' 色。'
      + '减色保证的只是「不超过上限」，实际用色受色卡与原图色彩分布限制，可能少于上限。';
  }

  /* ----------------------------------------------------------- 预览缩放 */

  /* 预览缩放只改 CSS 尺寸：canvas.width/height（真实像素）保持不变，
     因此导出分辨率与点击命中判定都不受缩放影响。
     必须显式覆盖 .pattern-canvas 的 max-width:100%（否则显式宽度会被样式表压回去），
     height 也要显式给（覆盖样式表里的 height:auto）。 */
  function applyViewZoom(anchor) {
    var cv = ui.patternCanvas;
    var scroll = ui.canvasScroll;
    if (ui.viewZoom) setVal(ui.viewZoom, state.viewZoom);
    setText(ui.viewZoomVal, Math.round(state.viewZoom * 100) + '%');
    if (!cv || !cv.width || !cv.height) return;
    var w = Math.max(1, Math.round(cv.width * state.viewZoom));
    var h = Math.max(1, Math.round(cv.height * state.viewZoom));
    var prev = state.viewZoomApplied > 0 ? state.viewZoomApplied : state.viewZoom;
    var kx = (state.viewZoom / prev), ky = kx;
    if (cv.style) {
      cv.style.maxWidth = 'none';
      cv.style.width = w + 'px';
      cv.style.height = h + 'px';
    }
    if (scroll && anchor && typeof scroll.getBoundingClientRect === 'function') {
      try {
        var rect = scroll.getBoundingClientRect();
        var rx = Number(anchor.clientX) - Number(rect.left);
        var ry = Number(anchor.clientY) - Number(rect.top);
        var cx = Number(scroll.scrollLeft || 0) + rx;
        var cy = Number(scroll.scrollTop || 0) + ry;
        scroll.scrollLeft = Math.max(0, Math.round(cx * kx - rx));
        scroll.scrollTop = Math.max(0, Math.round(cy * ky - ry));
      } catch (e) { /* 无法调整滚动位置时忽略：缩放本身已经生效 */ }
    }
    state.viewZoomApplied = state.viewZoom;
  }

  function setViewZoom(z, anchor) {
    var next = Number(z);
    if (!isFinite(next) || next <= 0) next = ZOOM_DEFAULT;
    state.viewZoom = Math.round(clamp(next, ZOOM_MIN, ZOOM_MAX) * 100) / 100;
    applyViewZoom(anchor);
  }

  /* anchor 必须一路透传：滚轮缩放要停在光标下的那个内容点上（按钮缩放不需要锚点） */
  function zoomBy(factor, anchor) { setViewZoom(state.viewZoom * factor, anchor); }

  function fitViewZoom() {
    var cv = ui.patternCanvas, scroll = ui.canvasScroll;
    if (!cv || !cv.width || !cv.height) { setStatus('尚未生成图纸，无法适应窗口', 'warn'); return; }
    if (!state.pattern) { setStatus('尚未生成图纸，无法适应窗口', 'warn'); return; }
    var cw = Number(scroll && scroll.clientWidth) || 0;
    var ch = Number(scroll && scroll.clientHeight) || 0;
    if (!cw || !ch) { setStatus('当前环境无法测量预览区尺寸', 'warn'); return; }
    var availW = Math.max(1, cw - 20), availH = Math.max(1, ch - 20);
    setViewZoom(Math.min(availW / cv.width, availH / cv.height));
    setStatus('已适应窗口：' + Math.round(state.viewZoom * 100) + '%', 'info');
  }

  /* 滚轮缩放：以光标为锚点（applyViewZoom 里按缩放比例修正 scrollLeft/scrollTop）。
     wheel 需要 {passive:false} 才能 preventDefault 阻止页面滚动。 */
  function onCanvasWheel(e) {
    if (!ui.patternCanvas || !state.pattern) return;
    var d = e ? Number(e.deltaY) : 0;
    if (!d) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    zoomBy(d < 0 ? ZOOM_STEP_FACTOR : (1 / ZOOM_STEP_FACTOR), e);
  }

  function bindWheel() {
    var cv = ui.patternCanvas;
    if (!cv || typeof cv.addEventListener !== 'function') return;
    try {
      cv.addEventListener('wheel', onCanvasWheel, { passive: false });
    } catch (e) {
      cv.addEventListener('wheel', onCanvasWheel);
    }
  }

  /* --------------------------------------------------------- 双指捏合缩放 */

  /* 滚轮只在桌面存在，触摸端原本只能靠 +/− 两个按钮。这里补上双指捏合：
     · 单指一律不拦截 —— 常态必须能单指双向滑动看大图（.canvas-scroll 不设 touch-action）。
     · 两指按下才算捏合：以「起手两指距离 : 当前两指距离」的比值乘到起手时的 state.viewZoom 上，
       再走同一个 applyViewZoom(两指中点) —— 缩放状态只有 state.viewZoom 这一份，
       绝不另起一套，也不重复实现锚点修正。
     · 用 touch 事件而不是 pointer 事件：容器保持默认可滚动，没有 touch-action 可依赖，
       必须自己 preventDefault 掉滚动；而「阻止滚动」这件事只看 touch 事件，
       pointer 事件给不了这个能力，走 touch 的兼容面也最广（微信内置浏览器同理）。 */
  var pinch = { active: false, baseDist: 0, baseZoom: 1, blockedUntil: 0 };

  /* 取 evt.touches 里的前两根手指的屏幕坐标 */
  function firstTwoTouches(evt) {
    var out = [];
    var t = evt ? evt.touches : null;
    if (!t || !t.length) return out;
    for (var i = 0; i < t.length && out.length < 2; i++) {
      var p = t[i];
      if (p) out.push({ x: Number(p.clientX) || 0, y: Number(p.clientY) || 0 });
    }
    return out;
  }

  function pinchDist(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* 以当前两指重新起算基准：起手、以及三指里抬走一根时都用它，避免缩放跳一下 */
  function pinchBase(list) {
    pinch.active = true;
    pinch.baseDist = Math.max(1, pinchDist(list[0], list[1]));
    pinch.baseZoom = state.viewZoom;
  }

  /* 第二根手指落下时，如果橡皮刷已经擦了一下，立刻撤销掉 —— 捏合绝不能改动图纸。
     起手时 pushHistory() 压入的快照正好是擦除前的状态，撤销它即可原样回滚
     （两次手指落下只会压入一步：onEraseDown 在 state.eraseActive 为真时直接返回）。 */
  function cancelEraseForPinch() {
    if (!state.eraseActive) return;
    state.eraseActive = false;
    state.eraseCount = 0;
    undo();
    setStatus('双指捏合缩放中：本次拖动已取消，图纸未改动', 'info');
  }

  function onPinchStart(evt) {
    var list = firstTwoTouches(evt);
    if (list.length < 2) return;          /* 单指：什么都不做，交给浏览器滚动 */
    cancelEraseForPinch();
    pinchBase(list);
  }

  function onPinchMove(evt) {
    if (!pinch.active) return;
    var list = firstTwoTouches(evt);
    if (list.length < 2) return;
    /* 容器没设 touch-action:none（单指必须能滚），所以双指期间得自己拦掉滚动 */
    if (typeof evt.preventDefault === 'function') evt.preventDefault();
    var ratio = pinchDist(list[0], list[1]) / pinch.baseDist;
    if (!isFinite(ratio) || ratio <= 0) return;
    setViewZoom(pinch.baseZoom * ratio, { clientX: (list[0].x + list[1].x) / 2, clientY: (list[0].y + list[1].y) / 2 });
  }

  function onPinchEnd(evt) {
    var list = firstTwoTouches(evt);
    if (list.length >= 2) { pinchBase(list); return; }
    if (!pinch.active) return;
    pinch.active = false;
    /* 两指抬起后浏览器常常还会补一个 click；这段时间里把它丢掉，
       否则一次捏合会被当成「在图纸上点了一下」。 */
    pinch.blockedUntil = intNow() + PINCH_CLICK_BLOCK_MS;
  }

  /* touchstart 绑在画布上（捏合起手必须落在画布上）；touchmove/touchend 绑在 document 上，
     手指滑出画布也不会跟丢。touchmove 必须显式 {passive:false}，
     否则浏览器把 document 上的触摸监听默认当被动的，preventDefault 不生效。 */
  function bindPinch() {
    on(ui.patternCanvas, 'touchstart', onPinchStart);
    if (!doc || typeof doc.addEventListener !== 'function') return;
    try {
      doc.addEventListener('touchmove', onPinchMove, { passive: false });
      doc.addEventListener('touchend', onPinchEnd);
      doc.addEventListener('touchcancel', onPinchEnd);
    } catch (e) {
      doc.addEventListener('touchmove', onPinchMove);
      doc.addEventListener('touchend', onPinchEnd);
      doc.addEventListener('touchcancel', onPinchEnd);
    }
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
    var csv = '';
    try {
      csv = String(R.exportCSV(p) || '');
    } catch (e) {
      setStatus('导出 CSV 失败：' + errText(e), 'err');
      return;
    }
    var ok = downloadText(csv, '拼豆用量清单.csv', 'text/csv');
    /* 微信 / iOS 里 CSV 基本没法下载成一文件，所以触摸端再给一条真正走得通的路：
       复制到剪贴板；剪贴板 API 不可用则退化成可长按选中的文本框。
       桌面端 coarsePointer() 为假，这一整段不执行 —— 桌面体验与之前逐字一致。 */
    offerCsvCopy(csv);
    if (ok) setStatus('已导出用量清单 CSV', 'ok');
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

  /* 导出图纸：绝不复用预览画布。离屏 canvas + cellPx = 24 × 倍数 重绘，
     预览缩放（CSS 尺寸）与导出分辨率彻底解耦。 */
  function exportPng() {
    var p = state.pattern;
    var R = win.Render;
    if (!p) { setStatus('请先生成图纸', 'warn'); return; }
    if (!R || typeof R.drawPattern !== 'function') { setStatus('核心模块未加载：无法导出图纸 PNG', 'err'); return; }
    if (!doc || typeof doc.createElement !== 'function') { setStatus('当前环境不支持导出', 'err'); return; }
    var scale = exportScaleValue();
    var opts = exportViewOpts(scale);
    var off = null, ret = null, failure = '';
    try {
      off = doc.createElement('canvas');
      ret = R.drawPattern(p, off, opts);
    } catch (e) { failure = errText(e); }
    if (failure) { setStatus('导出图纸失败：' + failure, 'err'); return; }

    if (ret && ret.ok === false) {
      /* 契约：ok:false 时先看 reason，且不产生任何下载。
         浏览器会静默拒绝过大的画布（设了 width/height 却回读不出这个值，或直接撑爆），
         渲染模块对不上就会返回 ok:false —— 用户唯一能做的就是降低导出倍数，
         所以无论 reason 是什么，提示里都必须写清这一步，不能只说一句「失败了」。 */
      setStatus('导出图纸失败：' + renderFailReason(ret) + '。请降低导出倍数（把「分辨率倍数」改成 1× 或 2×）后重试。', 'err');
      return;
    }

    var msg = '已导出图纸 PNG（' + scale + '× · 格子 ' + opts.cellPx + 'px · ' + p.w + ' × ' + p.h + ' 格）';
    if (ret && ret.labelsSuppressed === true) {
      msg += '；格子太小，色号没画出来，把倍数调高或格子调大';
    }

    /* 事后校验：画布的真实尺寸必须与渲染模块报告的落地尺寸逐值相等。
       canvas.width/height 只是赋了个值，浏览器会静默拒绝过大的画布 —— 那样导出的是白图，
       而「赋值没报错」看起来一切正常。render.js 自己已经回读过一次，这里是独立复核第二道：
       拿它报告的 width/height 与画布回读值直接比，宽高都要查，对不上就不导出、按失败处理。
       刻意不去反推「p.w × cellPx + 白边」：tight 模式的白边不是 0，反推迟早会算错
       （旧实现就是这么漏掉 pad*2 的），而 render 报告的尺寸是权威值，不需要任何假设。 */
    var aw = Number(off.width) > 0 ? Number(off.width) : 0;
    var ah = Number(off.height) > 0 ? Number(off.height) : 0;
    var rw = (ret && Number(ret.width) > 0) ? Number(ret.width) : 0;
    var rh = (ret && Number(ret.height) > 0) ? Number(ret.height) : 0;
    var sizeBad = !(aw > 0 && ah > 0) || (rw > 0 && rh > 0 && (aw !== rw || ah !== rh));
    if (sizeBad) {
      setStatus('导出图纸失败：画布尺寸没生效（渲染报告 ' + (rw || '?') + ' × ' + (rh || '?') + '，实际 '
        + aw + ' × ' + ah + '）。请降低导出倍数（把「分辨率倍数」改成 1× 或 2×）后重试。', 'err');
      return;
    }
    exportPngOf(off, '拼豆图纸.png', msg);
    /* 触摸端额外给一层「长按保存」兜底：微信内置浏览器与 iOS Safari 的 <a download>
       可能只是打开图片而不是下载，长按存图是那边唯一稳妥的路。
       桌面端 coarsePointer() 为假，offerPngSave 直接返回，桌面体验与之前逐字一致。 */
    offerPngSave(off);
  }

  /* ----------------------------------------------------------- 原图调整（SourceEdit 对接） */

  function sourceEditApi() {
    return (win.SourceEdit && typeof win.SourceEdit.mount === 'function') ? win.SourceEdit : null;
  }

  function mountSourceEdit() {
    var S = sourceEditApi();
    var hint = '原图调整模块（window.SourceEdit）未加载：裁剪 / 旋转 / 翻转不可用，将直接使用原图生成图纸。';
    if (!S) { setText(ui.srceditHint, hint); syncSrcEditButtons(); return; }
    if (!ui.sourceCanvas || typeof ui.sourceCanvas.getContext !== 'function') {
      setText(ui.srceditHint, '缺少原图画布 #sourceCanvas：原图调整不可用，将直接使用原图。');
      syncSrcEditButtons();
      return;
    }
    try {
      state.srcEdit = S.mount(ui.sourceCanvas, { onChange: onSrcEditChange });
      if (!state.srcEdit || typeof state.srcEdit !== 'object') state.srcEdit = null;
    } catch (e) {
      state.srcEdit = null;
      setText(ui.srceditHint, '原图调整模块初始化失败（' + errText(e) + '）：将直接使用原图。');
    }
    syncSrcEditButtons();
    syncSrcEditHint();
  }

  function syncSrcEditButtons() {
    var api = state.srcEdit;
    var locked = !state.srcEdit;
    toggleCls(ui.sourceCanvas, 'crop-mode', !locked && !!state.srcCropMode);
    if (locked) return;
    /* CropMode 不在冻结契约里：有 setCropMode 就透传，没有就只保留 UI 状态（拖拽仍以模块自身实现为准） */
    if (api && typeof api.setCropMode === 'function') {
      try { api.setCropMode(!!state.srcCropMode); } catch (e) { /* 忽略 */ }
    }
    if (api && typeof api.setAspect === 'function') {
      try { api.setAspect((ui.srcAspectSquare && ui.srcAspectSquare.checked) ? 'square' : 'free'); } catch (e) { /* 忽略 */ }
    }
  }

  function syncSrcEditHint() {
    if (!ui.srceditHint) return;
    if (!state.srcEdit) return;   /* 降级文案已在 mountSourceEdit 里写好，不要覆盖 */
    var st = null;
    try { st = (typeof state.srcEdit.getState === 'function') ? state.srcEdit.getState() : null; } catch (e) { st = null; }
    var parts = [];
    if (st && typeof st === 'object') {
      parts.push('旋转 ' + (Number(st.rotation) || 0) + '°');
      parts.push('水平翻转 ' + (st.flipH ? '开' : '关') + ' · 垂直翻转 ' + (st.flipV ? '开' : '关'));
      parts.push(st.hasCrop || st.crop ? '已裁剪' : '未裁剪');
      parts.push('裁剪框 ' + (st.aspect === 'square' ? '正方形' : '自由'));
    } else {
      parts.push('状态未知');
    }
    setText(ui.srceditHint, '原图调整：' + parts.join(' · ') + '。生成图纸时使用裁剪旋转后的像素。');
  }

  function onSrcEditChange() {
    syncSrcEditHint();
    if (state.srcW > 0) {
      if (ui.lockAspect && ui.lockAspect.checked) applyBoardsPreset();
      else normalizeDims('gridW');
    }
    scheduleRegenerate(DEBOUNCE_MS);
  }

  /* SourceEdit 的方法都返回 boolean：真正改变了状态才是 true。
     没载入图片、参数被拒时返回 false —— 这时绝不能报「已右转 90°」这种假成功。 */
  function srcEditCall(method, arg, okMsg, failMsg) {
    var api = state.srcEdit;
    if (!api || typeof api[method] !== 'function') {
      setStatus('原图调整模块未加载，' + okMsg + '不可用', 'warn');
      return;
    }
    var res = true;
    try {
      res = api[method](arg);
    } catch (e) {
      setStatus('原图调整失败：' + errText(e), 'err');
      return;
    }
    syncSrcEditHint();
    if (res === false) {
      var why = '';
      if (!state.source) {
        why = '请先载入图片';
      } else if (typeof api.getLastError === 'function') {
        try { why = String(api.getLastError() || ''); } catch (e) { why = ''; }
      }
      setStatus((failMsg || (okMsg + '未生效')) + (why ? ('：' + why) : ''), 'warn');
      return;
    }
    setStatus(okMsg, 'ok');
    if (state.source) {
      if (ui.lockAspect && ui.lockAspect.checked) applyBoardsPreset();
      else normalizeDims('gridW');
      scheduleRegenerate(0);
    }
  }

  function onSrcCropModeChange() {
    state.srcCropMode = !!(ui.srcCropMode && ui.srcCropMode.checked);
    if (!state.srcEdit) {
      state.srcCropMode = false;
      setChecked(ui.srcCropMode, false);
      syncSrcEditButtons();
      setStatus('原图调整模块未加载，裁剪模式不可用', 'warn');
      return;
    }
    syncSrcEditButtons();
    /* 如实描述：冻结契约里没有「开关裁剪交互」的 API，SourceEdit 的裁剪框在载图后始终可拖拽，
       这个复选框只是操作提示，不能宣称「关闭后拖不动」。 */
    setStatus(state.srcCropMode
      ? '裁剪模式：在原图画布上按住并拖拽，框选出要保留的区域'
      : '裁剪模式已关闭（该模块的裁剪框始终可以用拖拽框选，此开关只作操作提示）', 'info');
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

  /* 原图缩放的本地副本：供 generateFromRGBA 取像素（SourceEdit 可用时改由它接管画布，这里直接跳过） */
  function drawSourceCanvas() {
    var cv = ui.sourceCanvas;
    var src = state.source;
    state.srcCtx = null;
    state.pixW = 0;
    state.pixH = 0;
    if (state.srcEdit) return;   /* 画布由 SourceEdit 接管，不要覆盖它的显示 */
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
    state.patternQuantize = null;     /* 图纸没了，减色上限的记录也一起清掉 */
    state.history.length = 0;         /* 换图 = 新图纸生命周期 */
    state.recolor.selected = '';
    if (state.srcEdit && typeof state.srcEdit.setSource === 'function') {
      try { state.srcEdit.setSource(src); } catch (e) {
        setStatus('原图调整模块载入图片失败：' + errText(e) + '（将直接使用原图）', 'warn');
      }
    }
    drawSourceCanvas();
    syncSrcEditHint();
    if (ui.lockAspect && ui.lockAspect.checked) applyBoardsPreset();
    else normalizeDims('gridW');
    setCanvasPlaceholders();
    renderPattern();
    renderLegend();
    renderSummary();
    syncRecolorPicker(null);
    updateLockInfo();
    syncUndoButton();
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
    toggleCls(ui.dropZone, 'drag-active', on2);
    toggleCls(ui.dropHint, 'drag-active', on2);
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

  /* 标题只影响角标（渲染层的事）：走 scheduleRender，绝不触发重算 */
  function onChartTitleChange() {
    scheduleRender();
  }

  function onControlInput(id, isCommit) {
    if (id === 'viewZoom') { setViewZoom(num(ui.viewZoom, ZOOM_DEFAULT)); return; }
    /* touched 标记必须在 syncLabels() 之前：syncLabels → syncMaxColorsHint → quantizeOpts()
       读的就是它，晚一步的话「第一次改色数上限时小字还显示 pipeline 默认值」。 */
    if (id === 'maxColors') {
      state.touched.maxColors = true;
      setMaxColors(maxColorsSliderValue());                 /* 拖滑块 → 数字框跟着变 */
    } else if (id === 'maxColorsNum') {
      var typed = maxColorsNumValue();
      if (typed === null) {
        /* 空串 / 非法文本：不夹取、不重算，保留上一次有效值；
           只在失焦(change) 时把文本回写成那个值 —— 边输边改写会让「先清空再键入」打不成字。 */
        if (isCommit) { setMaxColors(maxColorsSliderValue()); syncLabels(); }
        return;
      }
      state.touched.maxColors = true;
      setMaxColors(typed);                                  /* 键入 → 滑块跟着动；越界夹取后两者一致 */
    }
    syncLabels();
    if (id === 'cellSize') { scheduleRender(); return; }
    if (id === 'gridW' || id === 'gridH') normalizeDims(id);
    scheduleRegenerate(DEBOUNCE_MS);
  }

  function onToggleChange(id) {
    if (id === 'quantizeEnabled') state.touched.quantizeEnabled = true;
    if (id === 'showRuler') { scheduleRender(); syncExportHint(); return; }
    /* 显示色号只改「预览怎么画」（格内文字），不重算 */
    if (id === 'showCodes') { syncCellLabelHint(); scheduleRender(); return; }
    if (id === 'recolorMode') {
      setTool(ui.recolorMode && ui.recolorMode.checked ? TOOL_RECOLOR : TOOL_NONE);
      renderPattern();
      updateLockInfo();
      return;
    }
    if (id === 'lockToggle') { updateLockInfo(); return; }
    if (id === 'srcCropMode') { onSrcCropModeChange(); return; }
    if (id === 'srcAspectSquare') {
      if (!state.srcEdit) { setStatus('原图调整模块未加载，裁剪框比例设置不可用', 'warn'); return; }
      syncSrcEditButtons();
      setStatus((ui.srcAspectSquare && ui.srcAspectSquare.checked) ? '裁剪框已切换为正方形' : '裁剪框已切换为自由比例', 'info');
      return;
    }
    if (id === 'exportAnnotate') { syncExportHint(); return; }
    syncEnabledState();
    if (id === 'lockAspect' && ui.lockAspect && ui.lockAspect.checked) normalizeDims('gridW');
    scheduleRegenerate(0);
  }

  function onSelectChange(id) {
    if (id === 'paletteSelect') {
      syncPaletteMeta();
      syncRecolorPicker(state.pattern);
      scheduleRegenerate(0);
      return;
    }
    if (id === 'bayerN') { syncEnabledState(); scheduleRegenerate(0); return; }
    if (id === 'boardsSelect') { applyBoardsPreset(); scheduleRegenerate(0); return; }
    if (id === 'sizePreset') { applySizePreset(); syncSizePresetValue(); return; }
    if (id === 'recolorScope') {
      state.recolor.scope = (ui.recolorScope && String(ui.recolorScope.value) === PICKER_SCOPE_ALL)
        ? PICKER_SCOPE_ALL : PICKER_SCOPE_USED;
      renderRecolorGrid();
      return;
    }
    if (id === 'exportScale') { syncExportHint(); return; }
  }

  function onRecolorSearch() {
    state.recolor.search = ui.recolorSearch ? String(ui.recolorSearch.value || '') : '';
    renderRecolorGrid();
  }

  /* 输入框里按 Ctrl+Z 应该撤销「输入」，不该撤销图纸：输入类元素聚焦时直接放行。 */
  function onDocKeyDown(e) {
    if (!e) return;
    var key = e.key ? String(e.key).toLowerCase() : '';
    if (key !== 'z') return;
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.altKey || e.shiftKey) return;         /* Shift+Ctrl+Z 是重做，本项目未实现，不做任何事 */
    if (isTypingTarget(e.target)) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    undo();
  }

  function applyDefaults(regen) {
    if (!ui.brightness) { setStatus('界面控件缺失，无法重置微调', 'warn'); return; }
    setVal(ui.brightness, DEFAULTS.brightness);
    setVal(ui.contrast, DEFAULTS.contrast);
    setVal(ui.saturation, DEFAULTS.saturation);
    setVal(ui.ditherStrength, DEFAULTS.ditherStrength);
    setMaxColors(DEFAULTS.maxColors);
    setVal(ui.cellSize, DEFAULTS.cellSize);
    setChecked(ui.autoWB, DEFAULTS.autoWB);
    setChecked(ui.autoLevels, DEFAULTS.autoLevels);
    setChecked(ui.quantizeEnabled, DEFAULTS.quantizeEnabled);
    setChecked(ui.lockAspect, DEFAULTS.lockAspect);
    /* DEFAULTS.cellLabel 是 'code' / 'none'，这里映射到「显示色号」勾选框；标题刻意不在这里复位 */
    setChecked(ui.showCodes, DEFAULTS.cellLabel === 'code');
    setChecked(ui.showRuler, DEFAULTS.showRuler);
    setChecked(ui.lockToggle, DEFAULTS.lockToggle);
    setChecked(ui.recolorMode, DEFAULTS.recolorMode);
    setVal(ui.recolorScope, DEFAULTS.recolorScope);
    setChecked(ui.exportAnnotate, DEFAULTS.exportAnnotate);
    setVal(ui.exportScale, DEFAULTS.exportScale);
    setChecked(ui.methodNearest, DEFAULTS.method === 'nearest');
    setChecked(ui.methodFS, DEFAULTS.method === 'fs');
    setChecked(ui.methodBayer, DEFAULTS.method === 'bayer');
    setVal(ui.bayerN, DEFAULTS.bayerN);
    setVal(ui.boardsSelect, DEFAULTS.boards);
    applyBoardsPreset();
    state.recolor.scope = PICKER_SCOPE_USED;
    setVal(ui.sizePreset, DEFAULTS.sizePreset);
    syncSizePresetValue();
    syncQuantizeFromPipeline();      /* 回到默认 = 跟随 Pipeline.DEFAULT_OPTS.quantize */
    state.touched.quantizeEnabled = false;
    state.touched.maxColors = false;
    state.viewZoom = DEFAULTS.viewZoom;
    applyViewZoom();
    syncLabels();
    syncEnabledState();
    setTool(DEFAULTS.recolorMode ? TOOL_RECOLOR : TOOL_NONE, true);   /* 工具状态跟着一起复位 */
    state.viewOpts = viewOpts();
    renderPattern();
    updateLockInfo();
    syncExportHint();
    if (regen) {
      setStatus('已重置微调参数', 'info');
      scheduleRegenerate(0);
    }
  }

  function bindToolRadio(id, val) {
    var el = ui[id];
    on(el, 'change', function () { if (el && el.checked) setTool(val); });
  }

  function bindEvents() {
    /* 连续输入：input 边走「实时」、change 边走「提交」（目前只有 maxColorsNum 需要区分） */
    var continuous = ['brightness', 'contrast', 'saturation', 'ditherStrength', 'cellSize', 'viewZoom', 'maxColors',
      'maxColorsNum', 'gridW', 'gridH'];
    var toggles = ['autoWB', 'autoLevels', 'quantizeEnabled', 'lockAspect', 'showCodes', 'showRuler', 'lockToggle',
      'recolorMode', 'srcCropMode', 'srcAspectSquare', 'exportAnnotate'];
    var selects = ['boardsSelect', 'paletteSelect', 'bayerN', 'sizePreset', 'recolorScope', 'exportScale'];
    var methods = ['methodNearest', 'methodFS', 'methodBayer'];
    var i;

    for (i = 0; i < continuous.length; i++) {
      (function (id) {
        var el = ui[id];
        if (!el) return;
        on(el, 'input', function () { onControlInput(id, false); });
        on(el, 'change', function () { onControlInput(id, true); });
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

    on(ui.recolorSearch, 'input', onRecolorSearch);
    on(ui.recolorSearch, 'change', onRecolorSearch);
    /* 事件委托：色板网格与「最近用过」会在每次刷新时重建，逐个绑监听会漏 */
    on(ui.recolorGrid, 'click', onRecolorPick);
    on(ui.recolorRecentRow, 'click', onRecolorPick);

    /* 标签页：只切显隐，切换不重建 DOM ⇒ 控件状态不会丢 */
    on(ui.tabBasic, 'click', function () { setTab(TAB_BASIC); });
    on(ui.tabAdvanced, 'click', function () { setTab(TAB_ADVANCED); });

    /* 标题只影响角标：input 走 scheduleRender，不触发重算 */
    on(ui.chartTitle, 'input', onChartTitleChange);
    on(ui.chartTitle, 'change', onChartTitleChange);

    /* 抠图工具：三选一与 #recolorMode 共用同一个 state.tool，任何时刻只有一个生效 */
    bindToolRadio('toolNone', TOOL_NONE);
    bindToolRadio('toolWand', TOOL_WAND);
    bindToolRadio('toolEraser', TOOL_ERASER);
    on(ui.eraserSize, 'change', function () { syncToolHint(); });
    /* 捏合先于橡皮刷的 pointerdown 绑定：触摸端第二根手指落下时，
       捏合要先把「用户其实是在缩放」这件事记下来，橡皮刷才来得及拒绝起手。 */
    bindPinch();
    on(ui.patternCanvas, 'pointerdown', onEraseDown);
    /* move/up 绑在 document 上：拖到画布外面松手也能正确收尾（画布只负责起手） */
    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('pointermove', onEraseMove);
      doc.addEventListener('pointerup', onEraseUp);
      doc.addEventListener('pointercancel', onEraseUp);
    }

    on(ui.btnUndo, 'click', undo);
    on(ui.btnRegenerate, 'click', function () { scheduleRegenerate(0); });
    on(ui.btnResetAdjust, 'click', function () { applyDefaults(true); });
    on(ui.btnExportPng, 'click', exportPng);
    on(ui.btnExportCsv, 'click', exportCsv);
    on(ui.btnUnlockAll, 'click', unlockAll);
    on(ui.btnPickFile, 'click', pickFile);
    on(ui.emptyState, 'click', pickFile);
    /* 预览区里也有可键入的控件（预览区顶部的图纸标题栏）：点它的输入框、或点它那段
       <label>（会转发焦点到输入框），都不该顺手弹出文件选择器。
       dropZone 里除标题栏外没有别的 label，所以这个判断不会误伤「点预览区即选图」。 */
    on(ui.dropZone, 'click', function (e) {
      var t = e && e.target;
      var tag = (t && t.tagName) ? String(t.tagName).toLowerCase() : '';
      if (!state.source && tag !== 'label' && !isTypingTarget(t)) pickFile();
    });
    on(ui.sourceCanvas, 'click', function () { if (!state.source) pickFile(); });

    on(ui.viewZoomIn, 'click', function () { zoomBy(ZOOM_STEP_FACTOR); });
    on(ui.viewZoomOut, 'click', function () { zoomBy(1 / ZOOM_STEP_FACTOR); });
    on(ui.viewZoomFit, 'click', fitViewZoom);

    /* 导出兜底层（只有触摸端会真的被打开，见 openSaveOverlay） */
    on(ui.saveCopy, 'click', onSaveCopy);
    on(ui.saveClose, 'click', closeSaveOverlay);
    /* 点面板外的灰底也关掉；面板内的点击不算 */
    on(ui.saveOverlay, 'click', function (e) { if (e && e.target === ui.saveOverlay) closeSaveOverlay(); });

    on(ui.srcRotateL, 'click', function () { srcEditCall('rotate', -90, '已左转 90°', '原图左转未生效'); });
    on(ui.srcRotateR, 'click', function () { srcEditCall('rotate', 90, '已右转 90°', '原图右转未生效'); });
    on(ui.srcFlipH, 'click', function () { srcEditCall('flip', 'h', '已水平翻转', '水平翻转未生效'); });
    on(ui.srcFlipV, 'click', function () { srcEditCall('flip', 'v', '已垂直翻转', '垂直翻转未生效'); });
    on(ui.srcReset, 'click', function () {
      if (!state.srcEdit) { setStatus('原图调整模块未加载，重置原图调整不可用', 'warn'); return; }
      srcEditCall('reset', null, '已重置原图调整', '重置原图调整未生效（可能已经是初始状态）');
      setChecked(ui.srcCropMode, false);
      setChecked(ui.srcAspectSquare, false);
      state.srcCropMode = false;
      /* reset() 按冻结契约不动 aspect：app.js 的顺序控件已经复位，这里同步把模块也切成 free，
         否则会出现「界面显示自由比例、模块内部还是正方形」的失同步。 */
      syncSrcEditButtons();
    });

    on(ui.patternCanvas, 'click', onPatternClick);
    bindWheel();

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
      doc.addEventListener('keydown', onDocKeyDown);
    }
  }

  /* ------------------------------------------------------------------ 启动 */

  function buildUI() {
    ui = {
      app: byId('app'),
      fileInput: byId('fileInput'),
      btnPickFile: byId('btnPickFile'),
      dropHint: byId('dropHint'),
      inputHint: byId('inputHint'),
      moduleNotice: byId('moduleNotice'),
      tabBasic: byId('tabBasic'),
      tabAdvanced: byId('tabAdvanced'),
      panelBasic: byId('panelBasic'),
      panelAdvanced: byId('panelAdvanced'),
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
      maxColorsNum: byId('maxColorsNum'),
      maxColorsHint: byId('maxColorsHint'),
      preprocessHint: byId('preprocessHint'),
      boardsSelect: byId('boardsSelect'),
      sizePreset: byId('sizePreset'),
      gridW: byId('gridW'),
      gridH: byId('gridH'),
      lockAspect: byId('lockAspect'),
      paletteSelect: byId('paletteSelect'),
      paletteMeta: byId('paletteMeta'),
      cellLabelHint: byId('cellLabelHint'),
      chartTitle: byId('chartTitle'),
      showCodes: byId('showCodes'),
      showRuler: byId('showRuler'),
      cellSize: byId('cellSize'),
      cellSizeVal: byId('cellSizeVal'),
      viewZoom: byId('viewZoom'),
      viewZoomVal: byId('viewZoomVal'),
      viewZoomIn: byId('viewZoomIn'),
      viewZoomOut: byId('viewZoomOut'),
      viewZoomFit: byId('viewZoomFit'),
      recolorMode: byId('recolorMode'),
      toolNone: byId('toolNone'),
      toolWand: byId('toolWand'),
      toolEraser: byId('toolEraser'),
      eraserSize: byId('eraserSize'),
      toolHint: byId('toolHint'),
      recolorScope: byId('recolorScope'),
      recolorSearch: byId('recolorSearch'),
      recolorGrid: byId('recolorGrid'),
      recolorEmpty: byId('recolorEmpty'),
      recolorRecentRow: byId('recolorRecentRow'),
      recolorCurrent: byId('recolorCurrent'),
      lockToggle: byId('lockToggle'),
      btnUnlockAll: byId('btnUnlockAll'),
      btnUndo: byId('btnUndo'),
      lockInfo: byId('lockInfo'),
      btnRegenerate: byId('btnRegenerate'),
      btnResetAdjust: byId('btnResetAdjust'),
      exportScale: byId('exportScale'),
      exportAnnotate: byId('exportAnnotate'),
      exportHint: byId('exportHint'),
      btnExportPng: byId('btnExportPng'),
      btnExportCsv: byId('btnExportCsv'),
      dropZone: byId('dropZone'),
      statusText: byId('statusText'),
      elapsedText: byId('elapsedText'),
      progressWrap: byId('progressWrap'),
      progressBar: byId('progressBar'),
      canvasScroll: byId('canvasScroll'),
      patternCanvas: byId('patternCanvas'),
      patternHint: byId('patternHint'),
      emptyState: byId('emptyState'),
      sourceCanvas: byId('sourceCanvas'),
      sourceHint: byId('sourceHint'),
      srcCropMode: byId('srcCropMode'),
      srcAspectSquare: byId('srcAspectSquare'),
      srcRotateL: byId('srcRotateL'),
      srcRotateR: byId('srcRotateR'),
      srcFlipH: byId('srcFlipH'),
      srcFlipV: byId('srcFlipV'),
      srcReset: byId('srcReset'),
      srceditHint: byId('srceditHint'),
      summaryBox: byId('summaryBox'),
      legendBox: byId('legendBox'),
      saveOverlay: byId('saveOverlay'),
      saveTip: byId('saveTip'),
      saveImage: byId('saveImage'),
      saveText: byId('saveText'),
      saveCopy: byId('saveCopy'),
      saveClose: byId('saveClose')
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
    state.recolor.recent = readRecentColors();
    syncRecolorPicker(null);
    applyDefaults(false);
    setTab(state.tab);               /* 默认停在「基本」页，并让 DOM 与 state.tab 一致 */
    mountSourceEdit();
    bindEvents();
    var mods = describeModules();
    updateModuleNotice(mods);
    setStatus(mods.ok ? '就绪：请先选择一张图片' : '核心模块未加载：界面可用，生成 / 渲染 / 导出暂不可用', mods.ok ? 'info' : 'warn');
    renderLegend();
    renderSummary();
    updateLockInfo();
    syncUndoButton();
    syncExportHint();
    applyEnvironmentText();      /* 触摸/窄屏下把「拖拽 / Ctrl+V」换成真能走的入口，并按能力开门 */
    setCanvasPlaceholders();
  }

  var api = {
    boot: boot,
    modules: describeModules,
    regenerate: regenerate,
    adoptImage: useImageSource,
    options: buildOpts,
    viewOpts: viewOpts,
    exportViewOpts: exportViewOpts,
    clickCell: onPatternClick,
    hitTestCell: hitTestCell,
    applyRecolor: applyRecolor,
    effCurve: effCurve,
    setTab: setTab,
    setTool: setTool,
    tool: toolOf,
    eraserSize: brushSizeValue,
    wandErase: wandErase,
    eraseBrushAt: function (idx) {
      /* 测试 / 脚本入口：按当前刷子大小擦一次（不进历史，调用方自行 pushHistory） */
      var p = state.pattern;
      if (!p || !p.cells) return 0;
      ensureLocked(p);
      return blankCells(p, brushIndices(p, idx));
    },
    finishErase: finishErase,
    onEraseDown: onEraseDown,
    onEraseMove: onEraseMove,
    onEraseUp: onEraseUp,
    undo: undo,
    setViewZoom: setViewZoom,
    applyViewZoom: applyViewZoom,
    fitViewZoom: fitViewZoom,
    renderRecolorGrid: renderRecolorGrid,
    pickerGroups: pickerGroups,
    selectRecolorCode: selectRecolorCode,
    recolorCode: recolorCode,
    noteRecentColor: noteRecentColor,
    readRecentColors: readRecentColors,
    exportPng: exportPng,
    exportCsv: exportCsv,
    recount: recount,
    keydown: onDocKeyDown,
    state: function () { return state; },
    elements: function () { return ui; }
  };

  if (win && typeof win === 'object') win.PindouUI = api;

  if (doc && typeof doc.addEventListener === 'function') {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
}());
