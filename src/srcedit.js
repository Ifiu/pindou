/*!
 * src/srcedit.js —— 原图编辑层：交互式裁剪 + 旋转 / 翻转（零依赖 / 零外部资源）
 *
 * 职责：
 *   1) mount(canvasEl, opts) 接管一块 canvas，按容器宽度等比显示原图（contain，不拉伸）
 *   2) 在原图预览上交互式裁剪：8 个调整柄缩放、框内拖拽平移、框外拖拽重新框选
 *   3) rotate / flip 作用于「基准图」，getResultCanvas() 产出「原图 → 旋转翻转 → 裁剪」的像素
 *
 * ── 旋转 / 翻转之后裁剪框的语义（冻结决策，getState() 如实反映）────────────
 * 语义：rotate() / flip() 改变的是**基准图**，并且**任何一次旋转或翻转都把裁剪框清空为
 *      null**（getState() 返回 crop === null、hasCrop === false）：变换后在一张新的基准图上
 *      重新框选，而不是把旧框的坐标搬进新坐标系。
 * 为什么这么选（两条路都合规，这里选可预测的那条）：
 *   · 搬迁旧框必须先回答「框算在旋转前还是旋转后的坐标系」，以及 90°/270° 宽高互换后旧框
 *     该贴哪条边 —— 没有唯一正确答案，用户无法预期结果；
 *   · 清空是幂等的：旋转/翻转 ≡ 换一张基准图，裁剪从零开始；
 *   · 旧框若不重算就留下，在 90°/270° 下会出现「框跑到图外」与负宽高的脏状态，清空从源头
 *     上排除了这类状态。
 *   · reset() 只清裁剪与旋转/翻转，**不改变 aspect**（比例是 app.js 的 UI 模式，不是图像变换；
 *     reset 顺手改掉它会让 app.js 的比例控件与真实状态失同步）。
 *
 * ── 坐标系与几何约定 ───────────────────────────────────────────────────────
 *   · 「基准图」= 传入的 imageLike，尺寸 bw × bh（只读像素，永不修改入参）
 *   · 「变换帧」= 基准图经旋转/翻转后的图，尺寸 fw × fh（90°/270° 时 bw 与 bh 互换）
 *   · crop 永远用**变换帧的整数像素坐标**表示：{x,y,w,h} 全为整数，且**恒有**
 *       0 <= x、0 <= y、x+w <= fw、y+h <= fh、w >= ms、h >= ms，
 *       其中 ms = max(1, min(MIN_SIZE(8), fw, fh))；square 模式下还恒有 w === h。
 *       这四条是不变量：任何拖拽序列都不可能产出违反它们的框（有回归断言守着）。
 *   · **尺寸下限优先于锚点固定**：方框贴边时「对角锚点不动」与「边长 >= ms」会真的冲突 ——
 *     例如把 8×8 框的左上柄朝右下方拖，而对角已贴住右/下边，沿锚点方向可用的空间不足 8px。
 *     冲突时选**保下限 + 挪锚点**：边长先按边界允许范围夹取、再把下界抬到 ms，框朝图内长大，
 *     最后由 fitRect 整体平移回图内（锚点因此最多被挪到贴边处，绝不会缩成 1×1）。
 *     为什么不选「拒绝这次缩放」：那会让指针在贴边方向上完全无响应、用户以为界面卡住；
 *     挪锚点的结果与「把柄往图内松开一点」视觉连续，且两条路的确定性相同。
 *   · 变换用「有符号置换矩阵」L（元素只有 0/±1）+ 平移描述，所以 90° 整数倍旋转与镜像都是
 *     像素精确的：不重采样、不插值、不引入半像素误差
 *   · 操作累加：每次 rotate/flip 都是在**当前视图**上再做一次（左乘）。等价于
 *     view = F(flipH, flipV) ∘ R(rotation)（先旋转后镜像），与常见图像编辑器一致 ——
 *     因此「水平翻转」按钮永远是把当前看到的画面左右镜像，而不是把原图的左右镜像。
 *   · 由矩阵反推 getState() 的 rotation/flipH/flipV 时用固定规范化规则：翻转次数最少 → 旋转
 *     角度最小 → 优先 flipV=false。同一个矩阵可能有多种等价表示（如「flipV」= 「flipH + 旋转
 *     180°」），规范化保证同一状态永远报同一组数字。副作用需知：先翻转再旋转 90° 后，
 *     getState() 可能报成「flipH + 旋转 90°」——像素与行为都正确，只是标记轴换了名字。
 *
 * ── 契约（app.js 按此调用，签名冻结）──────────────────────────────────────
 *   window.SourceEdit = { mount(canvasEl, opts) -> api }
 *   opts:  { onChange: function(state){} }        // 状态变化后调用，供 app.js 刷新自己的 UI
 *   api:   setSource(imageLike) / getResultCanvas() / getState() / rotate(deltaDeg)
 *          flip(axis) / setAspect(mode) / reset() / hasTransform()
 *   state: { rotation, flipH, flipV, crop, hasCrop, aspect }（每次返回新对象，crop 也是副本）
 *   返回值：rotate/flip/setAspect/reset/setSource 返回 boolean（是否真的改变了状态）；
 *           getResultCanvas() 返回 HTMLCanvasElement 或 null
 *   契约之外的附加方法（纯增量，不影响上面任何签名）：
 *     getLastError() -> string|null   最近一次被拒绝的原因（如图片加载失败、rotate(45)）
 *     destroy()      -> void          解除 window 监听与观察器，释放引用
 *     relayout()     -> void          容器宽度变化后主动重排预览（侧栏折叠等场景；已自动挂
 *                                     ResizeObserver + window resize，一般不用手动调）
 *   onChange 触发策略（恰好每次状态变化一次，拖拽中途不触发）：
 *     setSource 成功（重置裁剪与旋转）、rotate、flip、setAspect、reset、以及**拖拽结束时**
 *     裁剪框确实变了 —— 各触发一次；pointermove 期间一次都不触发；被拒绝的调用不触发。
 *
 * ── 性能 ──────────────────────────────────────────────────────────────────
 *   · pointermove 只重画预览（原图 + 遮罩 + 框），不做任何全量像素处理
 *   · getResultCanvas() 惰性生成 + 按「状态签名」缓存：状态没变时返回**同一个** canvas 对象；
 *     状态一变就换一块新 canvas（不原地改写旧对象，避免调用方手里的引用被悄悄改内容）
 *
 * ── 硬约束 ────────────────────────────────────────────────────────────────
 *   零外部资源；无 import/export/require；只挂 window.SourceEdit；不写死任何色表数据；
 *   不修改 imageLike 与调用方对象；无 document 的环境下被加载不抛异常。
 */

(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════════════ 环境 ══ */

  var G = (typeof window !== 'undefined' && window) ? window
    : ((typeof globalThis !== 'undefined' && globalThis) ? globalThis : null);

  /* ══════════════════════════════════════════════════════════════════ 常量 ══ */

  var MIN_SIZE = 8;              // 裁剪框最小边长（变换帧像素）
  var HANDLE_HIT = 11;           // 调整柄不可见热区（CSS px 半径，>=10 才点得中）
  var HANDLE_DRAW = 7;           // 调整柄绘制边长（CSS px）
  var CLICK_SLOP = 3;            // 位移小于该值（CSS px）视为「点击」而非「拖拽」
  var FALLBACK_RATIO = 0.8;      // 首次点击建框：整图 80% 居中
  var PREVIEW_MIN_W = 80;        // 预览 CSS 宽度下限
  var PREVIEW_MAX_W = 1600;      // 预览 CSS 宽度上限（超大 canvas 的内存保护）
  var DPR_MAX = 2;
  var BG_FILL = '#0c0e12';       // 与 ui.html 的 .source-canvas 背景一致
  var MASK_FILL = 'rgba(0,0,0,0.58)';
  var BOX_STROKE = '#5b9bf3';    // 与 ui.html 的 --accent 一致
  var BOX_SHADOW = 'rgba(0,0,0,0.85)';
  var HANDLE_FILL = '#ffffff';
  var HANDLE_EDGE = '#101216';
  var CURSORS = ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize',
    'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'];

  /* ══════════════════════════════════════════════════ 有符号置换矩阵运算 ══ */

  /* 矩阵按 [a,b,c,d] 存：x' = a*x + b*y，y' = c*x + d*y */
  function mul(A, B) {
    return [
      A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3],
      A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3]
    ];
  }

  var L_IDENT = [1, 0, 0, 1];
  var OP_ROT_CW = [0, -1, 1, 0];      // 屏幕坐标（y 向下）里的顺时针 90°
  var OP_ROT_CCW = [0, 1, -1, 0];
  var OP_FLIP_H = [-1, 0, 0, 1];      // 镜像水平方向（作用于当前视图）
  var OP_FLIP_V = [1, 0, 0, -1];

  function sameMatrix(A, B) {
    return A[0] === B[0] && A[1] === B[1] && A[2] === B[2] && A[3] === B[3];
  }

  /* 由 L 与基准图尺寸算出「变换帧」尺寸与平移（把变换后的图平移到 (0,0) 起） */
  function frameOf(L, bw, bh) {
    var xs = [0, L[0] * bw, L[1] * bh, L[0] * bw + L[1] * bh];
    var ys = [0, L[2] * bw, L[3] * bh, L[2] * bw + L[3] * bh];
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    return { tx: -minX, ty: -minY, fw: maxX - minX, fh: maxY - minY };
  }

  /* 矩阵 → {rotation, flipH, flipV} 的固定规范化表（16 组候选，按规则取唯一解） */
  var DECOMP = (function () {
    var rots = [
      L_IDENT,
      OP_ROT_CW,
      mul(OP_ROT_CW, OP_ROT_CW),
      mul(OP_ROT_CW, mul(OP_ROT_CW, OP_ROT_CW))
    ];
    var list = [];
    for (var r = 0; r < 4; r++) {
      for (var h = 0; h < 2; h++) {
        for (var v = 0; v < 2; v++) {
          var m = rots[r];
          if (h) m = mul(OP_FLIP_H, m);
          if (v) m = mul(OP_FLIP_V, m);
          list.push({ m: m, rotation: r * 90, flipH: !!h, flipV: !!v, cost: h + v });
        }
      }
    }
    return list;
  })();

  /* 规范化：翻转次数最少 → 旋转角度最小 → 优先 flipV=false（同一矩阵唯一解） */
  function decompose(L) {
    var best = null;
    for (var i = 0; i < DECOMP.length; i++) {
      var e = DECOMP[i];
      if (!sameMatrix(e.m, L)) continue;
      if (!best) { best = e; continue; }
      if (e.cost !== best.cost) { if (e.cost < best.cost) best = e; continue; }
      if (e.rotation !== best.rotation) { if (e.rotation < best.rotation) best = e; continue; }
      if (best.flipV && !e.flipV) best = e;
    }
    return best
      ? { rotation: best.rotation, flipH: best.flipH, flipV: best.flipV }
      : { rotation: 0, flipH: false, flipV: false };
  }

  /* ══════════════════════════════════════════════════════════════ 工具函数 ══ */

  function num(v) {
    return (typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity) ? v : 0;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /* 取文档对象：无 document 环境（Node 里 eval）返回 null 而不是抛异常 */
  function getDocument() {
    if (G && G.document) return G.document;
    if (typeof document !== 'undefined' && document) return document;
    return null;
  }

  /*
   * 读基准图尺寸。HTMLImageElement 走 naturalWidth/naturalHeight（naturalWidth === 0
   * 表示加载失败 / 尚未解码 → 明确拒绝）；canvas / ImageBitmap 走 width/height。
   * 返回 [w,h] 或 null。
   */
  function sourceSize(imageLike) {
    if (!imageLike || typeof imageLike !== 'object') return null;
    var isImgLike = (typeof imageLike.naturalWidth !== 'undefined') ||
      (typeof imageLike.naturalHeight !== 'undefined');
    if (isImgLike) {
      var nw = Math.floor(num(imageLike.naturalWidth));
      var nh = Math.floor(num(imageLike.naturalHeight));
      if (nw > 0 && nh > 0) return [nw, nh];
      return null;
    }
    var w = Math.floor(num(imageLike.width));
    var h = Math.floor(num(imageLike.height));
    if (w > 0 && h > 0) return [w, h];
    return null;
  }

  function initialState() {
    return { rotation: 0, flipH: false, flipV: false, crop: null, hasCrop: false, aspect: 'free' };
  }

  function bind(target, type, fn) {
    if (!target || typeof target.addEventListener !== 'function') return false;
    target.addEventListener(type, fn, false);
    return true;
  }

  function unbind(target, type, fn) {
    if (target && typeof target.removeEventListener === 'function') target.removeEventListener(type, fn, false);
  }

  /* ═══════════════════════════════════════════════════ 降级：什么都不做的 api ══ */

  function createInertApi(reason) {
    var why = reason || 'mount() 失败：未拿到可用的 2d 上下文（canvasEl 为空 / 无 getContext）';
    return {
      setSource: function () { return false; },
      getResultCanvas: function () { return null; },
      getState: function () { return initialState(); },
      rotate: function () { return false; },
      flip: function () { return false; },
      setAspect: function () { return false; },
      reset: function () { return false; },
      hasTransform: function () { return false; },
      getLastError: function () { return why; },
      destroy: function () {}
    };
  }

  /* ══════════════════════════════════════════════════════════════ 实例工厂 ══ */

  function createInstance(canvasEl, opts, ctx) {
    var onChange = (opts && typeof opts.onChange === 'function') ? opts.onChange : null;

    /* ---- 状态 ---- */
    var src = null, srcW = 0, srcH = 0, srcId = 0;
    var L = L_IDENT;
    var frame = frameOf(L, 0, 0);
    var crop = null;                 // {x,y,w,h}：变换帧整数像素
    var aspect = 'free';
    var cacheSig = '';
    var cacheCanvas = null;
    var lastError = null;
    var warned = {};
    var drag = null;
    var hoverCursor = '';
    var alive = true;

    /* ---- 预览布局状态 ---- */
    var cssW = 320, cssH = 240, dpr = 1, viewScale = 1;

    function warn(msg) {
      lastError = msg;
      if (warned[msg]) return;
      warned[msg] = true;
      if (typeof console !== 'undefined' && console && console.warn) console.warn('[SourceEdit] ' + msg);
    }

    /* --------------------------------------------------------------- 几何 */

    /* 圆整 + 夹进图内：宽高先贴边，再整体平移，绝不产生负宽高或越界 */
    function fitRect(x, y, w, h) {
      w = Math.round(w); h = Math.round(h);
      w = Math.max(1, Math.min(w, frame.fw));
      h = Math.max(1, Math.min(h, frame.fh));
      x = Math.round(x); y = Math.round(y);
      x = clamp(x, 0, frame.fw - w);
      y = clamp(y, 0, frame.fh - h);
      return { x: x, y: y, w: w, h: h };
    }

    function minSide() {
      return Math.max(1, Math.min(MIN_SIZE, frame.fw, frame.fh));
    }

    /* 以锚点角 + 方向 + 边长构造框（平滑处理贴边：必要时整体平移回图内） */
    function rectFromCorner(ax, ay, sx, sy, w, h) {
      return fitRect(sx > 0 ? ax : ax - w, sy > 0 ? ay : ay - h, w, h);
    }

    /* 角柄 / 新建框：锚点 = 固定角，移动点 = 指针（含反向拖拽自动换向、越界夹取） */
    function resizeCorner(ax, ay, mx, my) {
      /* 先把移动点夹进图像范围：这样宽高必然为正、锚点不动、框不会越界。
       * 夹取不改变方向（ax 在 [0,fw] 内，夹取只会把 mx 拉向 ax 所在的同一侧）。 */
      mx = clamp(mx, 0, frame.fw);
      my = clamp(my, 0, frame.fh);
      var sx = mx >= ax ? 1 : -1, sy = my >= ay ? 1 : -1;
      var ms = minSide();
      if (aspect === 'square') {
        var s = Math.max(Math.abs(mx - ax), Math.abs(my - ay));
        var limX = sx > 0 ? (frame.fw - ax) : ax;
        var limY = sy > 0 ? (frame.fh - ay) : ay;
        var lim = Math.max(0, Math.min(limX, limY));
        /* 下限优先于锚点固定（见文件头「尺寸下限优先于锚点固定」）：
         * 先把边长夹到边界允许的范围，再把下界抬到 ms —— 绝不再出现 min(ms, lim) 把下界拉到 lim
         * 从而产出 1×1 的框。抬过 lim 时框朝图内长大，由 rectFromCorner→fitRect 整体平移回图内，
         * 所以锚点最多被挪到贴边处。 */
        s = Math.max(Math.min(s, lim), ms);
        return rectFromCorner(ax, ay, sx, sy, s, s);
      }
      var w = Math.max(Math.abs(mx - ax), ms);
      var h = Math.max(Math.abs(my - ay), ms);
      return rectFromCorner(ax, ay, sx, sy, w, h);
    }

    /* 边柄：锚定对边，垂直方向按当前中心定位（square 时保持 1:1） */
    function resizeEdge(idx, before, mx, my) {
      var ms = minSide();
      var cx = before.x + before.w / 2, cy = before.y + before.h / 2;
      var side;
      if (idx === 3) {                                     /* 右边 */
        if (aspect === 'square') {
          side = clamp(mx - before.x, ms, frame.fw - before.x);
          side = Math.min(side, frame.fh);
          return fitRect(before.x, Math.round(cy - side / 2), side, side);
        }
        return fitRect(before.x, before.y, clamp(mx, before.x + ms, frame.fw) - before.x, before.h);
      }
      if (idx === 7) {                                     /* 左边 */
        if (aspect === 'square') {
          side = clamp(before.x + before.w - mx, ms, before.x + before.w);
          side = Math.min(side, frame.fh);
          return fitRect(before.x + before.w - side, Math.round(cy - side / 2), side, side);
        }
        var nx = clamp(mx, 0, before.x + before.w - ms);
        return fitRect(nx, before.y, before.x + before.w - nx, before.h);
      }
      if (idx === 5) {                                     /* 下边 */
        if (aspect === 'square') {
          side = clamp(my - before.y, ms, frame.fh - before.y);
          side = Math.min(side, frame.fw);
          return fitRect(Math.round(cx - side / 2), before.y, side, side);
        }
        return fitRect(before.x, before.y, before.w, clamp(my, before.y + ms, frame.fh) - before.y);
      }
      if (idx === 1) {                                     /* 上边 */
        if (aspect === 'square') {
          side = clamp(before.y + before.h - my, ms, before.y + before.h);
          side = Math.min(side, frame.fw);
          return fitRect(Math.round(cx - side / 2), before.y + before.h - side, side, side);
        }
        var ny = clamp(my, 0, before.y + before.h - ms);
        return fitRect(before.x, ny, before.w, before.y + before.h - ny);
      }
      return before;
    }

    /* 整框平移：只改位置，宽高不变（square 也就一直保持正方形） */
    function moveRect(before, dx, dy) {
      return fitRect(before.x + dx, before.y + dy, before.w, before.h);
    }

    /* 首次点击 / 点击建框：整图 80% 居中（square 时取正方形） */
    function fallbackRect() {
      var w = Math.round(frame.fw * FALLBACK_RATIO);
      var h = Math.round(frame.fh * FALLBACK_RATIO);
      var ms = minSide();
      if (aspect === 'square') { var s = Math.max(Math.min(w, h), ms); w = s; h = s; }
      w = Math.max(w, ms); h = Math.max(h, ms);
      return fitRect(Math.round((frame.fw - w) / 2), Math.round((frame.fh - h) / 2), w, h);
    }

    /* 切到 square：以中心为锚就地变正方形（边长取较大边，夹进图内） */
    function squareFromCenter(r) {
      var ms = minSide();
      var side = Math.max(r.w, r.h, ms);
      side = Math.min(side, frame.fw, frame.fh);
      var cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      return fitRect(Math.round(cx - side / 2), Math.round(cy - side / 2), side, side);
    }

    /* --------------------------------------------------------- 预览布局 */

    function measureWidth() {
      var w = 0;
      if (canvasEl.clientWidth > 0) w = canvasEl.clientWidth;
      if (!w && canvasEl.parentElement && canvasEl.parentElement.clientWidth > 0) {
        w = canvasEl.parentElement.clientWidth;
      }
      if (!w && typeof canvasEl.getBoundingClientRect === 'function') {
        try {
          var r = canvasEl.getBoundingClientRect();
          if (r && r.width > 0) w = r.width;
        } catch (err) { /* 取不到就继续兜底 */ }
      }
      if (!w && canvasEl.width > 0) w = canvasEl.width;
      if (!w) w = 320;
      return Math.round(clamp(w, PREVIEW_MIN_W, PREVIEW_MAX_W));
    }

    function layout() {
      if (!alive || !ctx || !canvasEl) return;
      var w, h;
      if (src && frame.fw > 0 && frame.fh > 0) {
        w = measureWidth();
        h = Math.max(1, Math.round(w * frame.fh / frame.fw));
        viewScale = w / frame.fw;
      } else {
        w = Math.min(measureWidth(), 320);
        h = Math.max(1, Math.round(w * 3 / 4));
        viewScale = 1;
      }
      dpr = (G && num(G.devicePixelRatio) > 1) ? Math.min(num(G.devicePixelRatio), DPR_MAX) : 1;
      var pxW = Math.max(1, Math.round(w * dpr)), pxH = Math.max(1, Math.round(h * dpr));
      cssW = w; cssH = h;
      if (canvasEl.width !== pxW || canvasEl.height !== pxH) {
        canvasEl.width = pxW;
        canvasEl.height = pxH;
      }
      if (!src && canvasEl.style && hoverCursor !== '') {
        hoverCursor = '';
        canvasEl.style.cursor = '';              /* 无源图：交还光标控制权给 UI 层的 CSS */
      }
      drawPreview();
    }

    /* ----------------------------------------------------------- 预览绘制 */

    function handlePoints(x, y, w, h) {
      return [
        { x: x, y: y },                       /* 0 nw */
        { x: x + w / 2, y: y },               /* 1 n  */
        { x: x + w, y: y },                   /* 2 ne */
        { x: x + w, y: y + h / 2 },           /* 3 e  */
        { x: x + w, y: y + h },               /* 4 se */
        { x: x + w / 2, y: y + h },           /* 5 s  */
        { x: x, y: y + h },                   /* 6 sw */
        { x: x, y: y + h / 2 }                /* 7 w  */
      ];
    }

    function cropCssRect() {
      return {
        x: crop.x * viewScale, y: crop.y * viewScale,
        w: crop.w * viewScale, h: crop.h * viewScale
      };
    }

    function drawOverlay() {
      var r = cropCssRect();
      var x = r.x, y = r.y, w = r.w, h = r.h;
      /* 框外加深色遮罩：四条带，一眼看出裁掉了什么 */
      ctx.fillStyle = MASK_FILL;
      ctx.fillRect(0, 0, cssW, Math.max(0, y));
      ctx.fillRect(0, y + h, cssW, Math.max(0, cssH - (y + h)));
      ctx.fillRect(0, y, Math.max(0, x), h);
      ctx.fillRect(x + w, y, Math.max(0, cssW - (x + w)), h);
      /* 框：深色外描边保证浅色图上也有对比 */
      ctx.strokeStyle = BOX_SHADOW;
      ctx.lineWidth = 3;
      ctx.strokeRect(x - 1.5, y - 1.5, w + 3, h + 3);
      ctx.strokeStyle = BOX_STROKE;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, w, h);
      /* 8 个调整柄 */
      var pts = handlePoints(x, y, w, h);
      for (var i = 0; i < pts.length; i++) {
        var px = Math.round(pts[i].x - HANDLE_DRAW / 2);
        var py = Math.round(pts[i].y - HANDLE_DRAW / 2);
        ctx.fillStyle = HANDLE_FILL;
        ctx.fillRect(px, py, HANDLE_DRAW, HANDLE_DRAW);
        ctx.strokeStyle = HANDLE_EDGE;
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py + 0.5, HANDLE_DRAW - 1, HANDLE_DRAW - 1);
      }
    }

    function drawPreview() {
      if (!ctx || !canvasEl) return;
      var pxW = canvasEl.width, pxH = canvasEl.height;
      try {
        if (typeof ctx.setTransform !== 'function') return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (typeof ctx.clearRect === 'function') ctx.clearRect(0, 0, pxW, pxH);
        if (typeof ctx.fillRect === 'function') {
          ctx.fillStyle = BG_FILL;
          ctx.fillRect(0, 0, pxW, pxH);
        }
        if (!src || typeof ctx.drawImage !== 'function') return;
        var s = viewScale * dpr;
        if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = false;
        /* 基准图 → 变换帧：setTransform(a,b,c,d,e,f)。fold 了预览缩放与 dpr */
        ctx.setTransform(L[0] * s, L[2] * s, L[1] * s, L[3] * s, frame.tx * s, frame.ty * s);
        ctx.drawImage(src, 0, 0);
        /* 覆盖层回到 CSS 像素空间绘制，保证描边与手柄在任何缩放/DPR 下都是固定视觉粗细 */
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (crop) drawOverlay();
      } catch (err) {
        warn('预览绘制失败：' + (err && err.message ? err.message : String(err)));
      }
    }

    /* ------------------------------------------------------- 指针坐标换算 */

    function cssPoint(e) {
      var rect = null;
      if (typeof canvasEl.getBoundingClientRect === 'function') {
        try { rect = canvasEl.getBoundingClientRect(); } catch (err) { rect = null; }
      }
      var bl = num(canvasEl.clientLeft), bt = num(canvasEl.clientTop);
      var dispW = canvasEl.clientWidth > 0 ? canvasEl.clientWidth : (rect && rect.width > 0 ? rect.width : cssW);
      var dispH = canvasEl.clientHeight > 0 ? canvasEl.clientHeight : (rect && rect.height > 0 ? rect.height : cssH);
      var left = (rect ? rect.left : 0) + bl, top = (rect ? rect.top : 0) + bt;
      var ex = num(e && e.clientX), ey = num(e && e.clientY);
      var kx = dispW > 0 ? cssW / dispW : 1, ky = dispH > 0 ? cssH / dispH : 1;
      return { x: (ex - left) * kx, y: (ey - top) * ky };
    }

    /* 命中判定：内区平移 → 柄缩放（角柄优先）→ 框内平移 → 框外新建 */
    function hitTest(p) {
      var r = cropCssRect();
      var hs = HANDLE_HIT;
      var ix = r.x + hs * 0.5, iy = r.y + hs * 0.5;
      var iw = Math.max(0, r.w - hs), ih = Math.max(0, r.h - hs);
      if (iw > 0 && ih > 0 && p.x > ix && p.x < ix + iw && p.y > iy && p.y < iy + ih) {
        return { kind: 'move', idx: -1 };
      }
      var pts = handlePoints(r.x, r.y, r.w, r.h);
      var order = [0, 2, 4, 6, 1, 3, 5, 7];
      for (var i = 0; i < order.length; i++) {
        var k = order[i];
        if (Math.abs(p.x - pts[k].x) <= hs && Math.abs(p.y - pts[k].y) <= hs) {
          return { kind: 'handle', idx: k };
        }
      }
      if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) {
        return { kind: 'move', idx: -1 };
      }
      return { kind: 'new', idx: -1 };
    }

    /* 角柄的锚点 = 对角固定点（变换帧整数像素） */
    function anchorForHandle(idx) {
      if (idx === 0) return { x: crop.x + crop.w, y: crop.y + crop.h };
      if (idx === 2) return { x: crop.x, y: crop.y + crop.h };
      if (idx === 4) return { x: crop.x, y: crop.y };
      if (idx === 6) return { x: crop.x + crop.w, y: crop.y };
      return { x: crop.x, y: crop.y };
    }

    function updateCursor(p) {
      if (!canvasEl.style) return;
      /* 无源图时写空串：清掉内联覆盖，让 ui.html 自己的 .source-canvas.crop-mode{cursor:crosshair}
       * 这类样式规则重新生效（本模块不抢 UI 层的样式所有权）。 */
      var next = '';
      if (src) {
        if (!crop) next = 'crosshair';
        else {
          var hit = hitTest(p);
          next = hit.kind === 'handle' ? CURSORS[hit.idx]
            : (hit.kind === 'move' ? 'move' : 'crosshair');
        }
      }
      if (next !== hoverCursor) {
        hoverCursor = next;
        canvasEl.style.cursor = next;
      }
    }

    /* --------------------------------------------------------------- 通知 */

    function notify() {
      if (!onChange) return;
      try { onChange(getState()); }
      catch (err) { warn('onChange 回调抛错：' + (err && err.message ? err.message : String(err))); }
    }

    /* --------------------------------------------------------- 指针交互 */

    function isPrimary(e) {
      return !(e && typeof e.button === 'number' && e.button > 0);
    }

    function onDown(e) {
      if (!src || !alive) return;
      if (!isPrimary(e)) return;
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      var p = cssPoint(e);
      var c = { x: p.x / viewScale, y: p.y / viewScale };
      var hit = crop ? hitTest(p) : { kind: 'new', idx: -1 };
      drag = {
        kind: hit.kind, idx: hit.idx,
        startX: c.x, startY: c.y,
        startCssX: p.x, startCssY: p.y,
        before: crop ? { x: crop.x, y: crop.y, w: crop.w, h: crop.h } : null,
        anchorX: c.x, anchorY: c.y,
        moved: false
      };
      if (hit.kind === 'handle') {
        var a = anchorForHandle(hit.idx);
        drag.anchorX = a.x; drag.anchorY = a.y;
      }
      if (typeof canvasEl.setPointerCapture === 'function' && e && e.pointerId !== undefined) {
        try { canvasEl.setPointerCapture(e.pointerId); } catch (err) { /* 不支持就算了 */ }
      }
    }

    /* 拖拽中的几何更新（纯预览，不产出结果图、不触发 onChange） */
    function applyDrag(d, c) {
      if (d.kind === 'move') return moveRect(d.before, c.x - d.startX, c.y - d.startY);
      if (d.kind === 'handle' && (d.idx === 1 || d.idx === 3 || d.idx === 5 || d.idx === 7)) {
        return resizeEdge(d.idx, d.before, c.x, c.y);
      }
      return resizeCorner(d.anchorX, d.anchorY, c.x, c.y);
    }

    function onMove(e) {
      if (!alive) return;
      var p = cssPoint(e);
      if (!drag) { if (src) updateCursor(p); return; }
      var c = { x: p.x / viewScale, y: p.y / viewScale };
      if (!drag.moved) {
        var ddx = p.x - drag.startCssX, ddy = p.y - drag.startCssY;
        if (ddx * ddx + ddy * ddy >= CLICK_SLOP * CLICK_SLOP) drag.moved = true;
      }
      if (drag.kind === 'new' && !drag.moved) return;   /* 还没形成拖拽，先不建框 */
      crop = applyDrag(drag, c);
      drawPreview();
    }

    function onUp() {
      if (!alive || !drag) return;
      var d = drag;
      drag = null;
      if (d.kind === 'new' && !d.moved) crop = fallbackRect();      /* 点击（位移未过阈值）= 兜底框 */
      if (crop) crop = fitRect(crop.x, crop.y, crop.w, crop.h);
      var changed = (!!d.before !== !!crop) ||
        (d.before && crop && (d.before.x !== crop.x || d.before.y !== crop.y ||
          d.before.w !== crop.w || d.before.h !== crop.h));
      drawPreview();
      if (changed) notify();
    }

    /* --------------------------------------------------------- 状态签名 */

    function signature() {
      var c = crop ? (crop.x + ',' + crop.y + ',' + crop.w + ',' + crop.h) : 'full';
      return srcId + '|' + L[0] + ',' + L[1] + ',' + L[2] + ',' + L[3] + '|' +
        frame.tx + ',' + frame.ty + '|' + frame.fw + 'x' + frame.fh + '|' + c;
    }

    /* --------------------------------------------------------- 公开方法 */

    function resetTransform() {
      L = L_IDENT;
      frame = frameOf(L, srcW, srcH);
      crop = null;
    }

    function setSource(imageLike) {
      if (!alive) return false;
      if (imageLike === null || imageLike === undefined) {
        if (!src) return false;
        src = null; srcW = 0; srcH = 0; srcId += 1;
        resetTransform();
        cacheSig = ''; cacheCanvas = null;
        layout();
        notify();
        return true;
      }
      var size = sourceSize(imageLike);
      if (!size) {
        warn('源图不可用：尺寸为 0（图片可能加载失败或尚未解码），已忽略本次 setSource');
        return false;
      }
      src = imageLike;
      srcW = size[0]; srcH = size[1];
      srcId += 1;
      resetTransform();                                    /* 换原图 → 重置裁剪与旋转 */
      cacheSig = ''; cacheCanvas = null;
      drag = null;
      lastError = null;
      layout();
      notify();
      return true;
    }

    function rotate(deltaDeg) {
      if (!alive || !src) return false;
      var d = num(deltaDeg);
      if (d !== 90 && d !== -90 && d !== 270 && d !== -270) {
        warn('rotate() 只接受 ±90 的整数倍，收到 ' + String(deltaDeg) + '，已拒绝');
        return false;
      }
      L = mul(d > 0 ? OP_ROT_CW : OP_ROT_CCW, L);
      frame = frameOf(L, srcW, srcH);
      crop = null;                                         /* 语义：变换后重新框选（见文件头） */
      cacheSig = '';
      drag = null;
      layout();
      notify();
      return true;
    }

    function flip(axis) {
      if (!alive || !src) return false;
      if (axis !== 'h' && axis !== 'v') {
        warn("flip() 只接受 'h' 或 'v'，收到 " + String(axis) + "，已拒绝");
        return false;
      }
      L = mul(axis === 'h' ? OP_FLIP_H : OP_FLIP_V, L);
      frame = frameOf(L, srcW, srcH);
      crop = null;                                         /* 语义：变换后重新框选（见文件头） */
      cacheSig = '';
      drag = null;
      layout();
      notify();
      return true;
    }

    function setAspect(mode) {
      if (!alive) return false;
      if (mode !== 'free' && mode !== 'square') {
        warn("setAspect() 只接受 'free' 或 'square'，收到 " + String(mode) + "，已拒绝");
        return false;
      }
      if (mode === aspect) return false;
      aspect = mode;
      if (mode === 'square' && crop) {
        crop = squareFromCenter(crop);                     /* 就地调整，中心不变 */
        cacheSig = '';
      }
      drawPreview();
      notify();
      return true;
    }

    function reset() {
      if (!alive) return false;
      var changed = !!crop || !sameMatrix(L, L_IDENT);
      resetTransform();                                    /* aspect 不动（见文件头） */
      cacheSig = '';
      drag = null;
      if (!changed) { drawPreview(); return false; }
      layout();
      notify();
      return true;
    }

    function getState() {
      var d = decompose(L);
      return {
        rotation: d.rotation,
        flipH: d.flipH,
        flipV: d.flipV,
        crop: crop ? { x: crop.x, y: crop.y, w: crop.w, h: crop.h } : null,
        hasCrop: !!crop,
        aspect: aspect
      };
    }

    function hasTransform() {
      return !!(crop || !sameMatrix(L, L_IDENT));
    }

    function getResultCanvas() {
      if (!alive || !src) return null;
      var sig = signature();
      if (cacheCanvas && cacheSig === sig) return cacheCanvas;
      var doc = getDocument();
      if (!doc || typeof doc.createElement !== 'function') {
        warn('getResultCanvas() 失败：当前环境没有可用的 document.createElement');
        return null;
      }
      var cw = crop ? crop.w : frame.fw;
      var ch = crop ? crop.h : frame.fh;
      if (!(cw > 0) || !(ch > 0)) return null;
      var out;
      try { out = doc.createElement('canvas'); } catch (err) { out = null; }
      if (!out || typeof out.getContext !== 'function') {
        warn('getResultCanvas() 失败：无法创建 canvas');
        return null;
      }
      var octx = null;
      try { octx = out.getContext('2d'); } catch (err) { octx = null; }
      if (!octx || typeof octx.drawImage !== 'function') {
        warn('getResultCanvas() 失败：新 canvas 没有可用的 2d 上下文');
        return null;
      }
      out.width = cw;
      out.height = ch;
      /* 状态一变就换新 canvas：调用方手里的旧引用不会被悄悄改写 */
      cacheCanvas = out;
      cacheSig = sig;
      var ox = crop ? crop.x : 0, oy = crop ? crop.y : 0;
      if ('imageSmoothingEnabled' in octx) octx.imageSmoothingEnabled = false;
      try {
        octx.setTransform(1, 0, 0, 1, 0, 0);
        if (typeof octx.clearRect === 'function') octx.clearRect(0, 0, cw, ch);
        octx.setTransform(L[0], L[2], L[1], L[3], frame.tx - ox, frame.ty - oy);
        octx.drawImage(src, 0, 0);
        octx.setTransform(1, 0, 0, 1, 0, 0);
      } catch (err) {
        warn('结果图绘制失败：' + (err && err.message ? err.message : String(err)));
      }
      return out;
    }

    function getLastError() {
      return lastError;
    }

    function destroy() {
      if (!alive) return;
      alive = false;
      detach();
      src = null; srcW = 0; srcH = 0;
      resetTransform();
      cacheSig = ''; cacheCanvas = null;
      drag = null;
    }

    /* --------------------------------------------------------- 事件绑定 */

    var observers = [];
    var detachers = [];

    function detach() {
      for (var i = 0; i < detachers.length; i++) detachers[i]();
      detachers.length = 0;
      for (var j = 0; j < observers.length; j++) {
        try { observers[j].disconnect(); } catch (err) { /* 忽略 */ }
      }
      observers.length = 0;
    }

    bind(canvasEl, 'pointerdown', onDown);
    detachers.push(function () { unbind(canvasEl, 'pointerdown', onDown); });
    /* move/up 挂在 window 上：pointer 快速拖出画布也不会丢失 */
    if (G) {
      bind(G, 'pointermove', onMove);
      detachers.push(function () { unbind(G, 'pointermove', onMove); });
      bind(G, 'pointerup', onUp);
      detachers.push(function () { unbind(G, 'pointerup', onUp); });
      bind(G, 'pointercancel', onUp);
      detachers.push(function () { unbind(G, 'pointercancel', onUp); });
      bind(G, 'resize', layout);
      detachers.push(function () { unbind(G, 'resize', layout); });
      if (G.ResizeObserver && typeof G.ResizeObserver === 'function') {
        try {
          var ro = new G.ResizeObserver(function () { layout(); });
          ro.observe(canvasEl);
          observers.push(ro);
        } catch (err) { /* 不支持就算了，window resize 仍能兜住 */ }
      }
    }
    if (canvasEl.style) {
      try { canvasEl.style.touchAction = 'none'; } catch (err) { /* 忽略 */ }
    }

    layout();

    return {
      setSource: setSource,
      getResultCanvas: getResultCanvas,
      getState: getState,
      rotate: rotate,
      flip: flip,
      setAspect: setAspect,
      reset: reset,
      hasTransform: hasTransform,
      getLastError: getLastError,
      destroy: destroy,
      /* 供 app.js 在容器宽度变化后（如侧栏折叠）主动重排预览；非契约必需 */
      relayout: layout
    };
  }

  /* ══════════════════════════════════════════════════════════════ 挂载入口 ══ */

  /* 同一块 canvas 重复 mount 时先卸掉上一实例的 window 监听，避免监听泄漏 */
  var mounted = [];

  function teardownFor(el) {
    for (var i = mounted.length - 1; i >= 0; i--) {
      if (mounted[i].el === el) {
        try { mounted[i].api.destroy(); } catch (err) { /* 忽略 */ }
        mounted.splice(i, 1);
      }
    }
  }

  function mount(canvasEl, opts) {
    if (!canvasEl || typeof canvasEl.getContext !== 'function') return createInertApi();
    var ctx = null;
    try { ctx = canvasEl.getContext('2d'); } catch (err) { ctx = null; }
    if (!ctx || typeof ctx !== 'object') return createInertApi();
    teardownFor(canvasEl);
    var api = createInstance(canvasEl, opts, ctx);
    mounted.push({ el: canvasEl, api: api });
    return api;
  }

  var API = { mount: mount };

  if (G) G.SourceEdit = API;
})();
