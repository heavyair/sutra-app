/* 抄经应用 · 全屏手指书写（无外部依赖）
 *
 * WritingPad(paperCanvas, inkCanvas, opts)
 *   opts.onStrokeEnd(coverage, strokeCount)  每笔结束回调
 *   opts.onFirstStroke()                     第一笔回调
 *
 *   setPen('pencil' | 'maobi' | 'gangbi')
 *   setFont(fontStack)         设置临摹字字体
 *   newChar(ch)                开始一个新字：画纸面 + 虚影字 + 重置检测网格
 *   clearInk()                 清空墨迹（橡皮），保留虚影字
 *   coverage()                 当前墨迹覆盖虚影字的比例 0~1
 *   fadeOut(ms)                缓缓隐藏墨迹（可被 cancelFade 中断）
 *   cancelFade()               中断隐藏，恢复墨迹
 *   snapshot()                 导出当前字的成品图（dataURL，已裁剪）
 *
 * 笔：
 *   铅笔：恒定细灰线
 *   毛笔：浓墨大锋 + 晕染底层 + 毛丝缕锋；慢→粗浓，快→细并带飞白
 *   钢笔：恒定适中深色线
 *
 * 完成检测：虚影字像素 → 48×48 占用网格；墨迹落入的格子 / 字的格子 ≥ 阈值即判为写成。
 */
(function (global) {
  'use strict';

  // 中日韩及常用 ASCII 标点：盖印时用小字号，避免字形占满整个字格显得过大
  var PUNCT_RE = /[　-〿！-／：-＠［-｀｛-･\u2000-\u206F\u2E00-\u2E7F.,;:?!"'()\[\]{}…—–·•‹›«»\-/]/;

  var GRID = 48;

  var PENS = {
    pencil: { width: 2.4, color: '#5a5a5a' },
    gangbi: { width: 5, color: '#23232e' },
    maobi: { color: '#2b2118' }, // 线宽动态
  };

  function WritingPad(paperCanvas, inkCanvas, opts) {
    this.paper = paperCanvas;
    this.ink = inkCanvas;
    this.opts = opts || {};
    this.pen = 'pencil';
    this.fontStack = 'serif';
    this.pctx = paperCanvas.getContext('2d');
    this.ictx = inkCanvas.getContext('2d');
    this.drawing = false;
    this.points = [];
    this.strokeCount = 0;
    this.inkLength = 0;
    this.charCells = null; // Uint8Array(GRID*GRID)：字占用的格
    this.inkCells = null;  // Uint8Array(GRID*GRID)：墨迹落入的格
    this.charCellCount = 0;
    this.bbox = null;      // 虚影字包围盒（CSS px）
    this.charPx = 0;       // 字号（CSS px）
    this.fading = false;
    this.fadeRaf = 0;
    // 毛笔笔锋随字号自动缩放（newChar 时按虚影字包围盒校准）
    this._brushMax = 34;
    this._brushMin = 6;
    // 落笔状态：死区 + 起笔收锋，避免落笔一团墨
    this._inking = false;
    this._strokeDist = 0;
    this._downX = 0;
    this._downY = 0;
    this._resize();
    this._bind();
  }

  WritingPad.prototype._sizeOf = function (canvas) {
    var r = canvas.getBoundingClientRect();
    return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
  };

  WritingPad.prototype._resize = function () {
    var self = this;
    [this.paper, this.ink].forEach(function (c) {
      var s = self._sizeOf(c);
      var dpr = global.devicePixelRatio || 1;
      c.width = Math.max(1, Math.round(s.w * dpr));
      c.height = Math.max(1, Math.round(s.h * dpr));
      c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    this.pctx.lineCap = this.pctx.lineJoin = 'round';
    this.ictx.lineCap = this.ictx.lineJoin = 'round';
    if (this._char) this._drawPaper();
  };

  WritingPad.prototype.setPen = function (name) {
    if (PENS[name]) this.pen = name;
  };

  WritingPad.prototype.setFont = function (stack) {
    this.fontStack = stack || 'serif';
    if (this._char) this._drawPaper();
  };

  /* ---------- 纸面：宣纸底 + 虚影字 ---------- */
  WritingPad.prototype._drawPaper = function () {
    var s = this._sizeOf(this.paper);
    var ctx = this.pctx;
    ctx.clearRect(0, 0, s.w, s.h);
    // 宣纸底色 + 细微纹理
    var g = ctx.createLinearGradient(0, 0, 0, s.h);
    g.addColorStop(0, '#f4eddc');
    g.addColorStop(1, '#efe5cf');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s.w, s.h);

    if (!this._char) return;
    var px = Math.min(s.w, s.h) * 0.52;
    this.charPx = px;
    var cx = s.w / 2, cy = s.h * 0.44;
    ctx.font = px + 'px ' + this.fontStack;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(140,115,70,0.30)';
    ctx.fillText(this._char, cx, cy);
    this._computeGrid(s, px, cx, cy);
  };

  // 在离屏画布上渲染虚影字，扫描像素得到包围盒与占用网格
  WritingPad.prototype._computeGrid = function (s, px, cx, cy) {
    var off = document.createElement('canvas');
    off.width = Math.max(1, Math.round(s.w));
    off.height = Math.max(1, Math.round(s.h));
    var c = off.getContext('2d', { willReadFrequently: true });
    c.font = px + 'px ' + this.fontStack;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#000';
    c.fillText(this._char, cx, cy);
    var img;
    try {
      img = c.getImageData(0, 0, off.width, off.height);
    } catch (e) {
      this.bbox = { x: cx - px / 2, y: cy - px / 2, w: px, h: px };
      this._fallbackGrid();
      return;
    }
    var d = img.data, W = off.width, H = off.height;
    var minX = W, minY = H, maxX = -1, maxY = -1;
    for (var y = 0; y < H; y += 2) {
      for (var x = 0; x < W; x += 2) {
        if (d[(y * W + x) * 4 + 3] > 40) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) { this._fallbackGrid(); return; }
    // CSS px 坐标（off 与 CSS 1:1）
    this.bbox = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    this.charCells = new Uint8Array(GRID * GRID);
    this.charCellCount = 0;
    // 每格内 3×3 子采样：任一子点有墨即算字区（细笔画不漏检）
    for (var gy = 0; gy < GRID; gy++) {
      for (var gx = 0; gx < GRID; gx++) {
        var hit = false;
        for (var qy = 0; qy < 3 && !hit; qy++) {
          for (var qx = 0; qx < 3 && !hit; qx++) {
            var sx = Math.min(W - 1, Math.round(minX + (maxX - minX + 1) * (gx + (qx + 0.5) / 3) / GRID));
            var sy = Math.min(H - 1, Math.round(minY + (maxY - minY + 1) * (gy + (qy + 0.5) / 3) / GRID));
            if (d[(sy * W + sx) * 4 + 3] > 40) hit = true;
          }
        }
        if (hit) {
          this.charCells[gy * GRID + gx] = 1;
          this.charCellCount++;
        }
      }
    }
    if (this.charCellCount === 0) this._fallbackGrid();
  };

  WritingPad.prototype._fallbackGrid = function () {
    // 扫描失败时：以字号正方形为包围盒，全格视为字区
    var s = this._sizeOf(this.paper);
    var px = this.charPx || Math.min(s.w, s.h) * 0.52;
    this.bbox = { x: s.w / 2 - px / 2, y: s.h * 0.44 - px / 2, w: px, h: px };
    this.charCells = new Uint8Array(GRID * GRID).fill(1);
    this.charCellCount = GRID * GRID;
  };

  /* ---------- 新字 / 清空 ---------- */
  WritingPad.prototype.newChar = function (ch) {
    this._char = ch || '　';
    this.cancelFade();
    this.ink.style.opacity = '1';
    this.clearInk();
    // 落笔记录：每个字从空白开始累积，供存储与回放
    this._recStrokes = [];
    this._recStroke = null;
    this._charT0 = Date.now();
    this._drawPaper();
    // 按当前虚影字的实际显示大小校准毛笔笔锋
    if (this.bbox) this._setBrushScale(Math.max(this.bbox.w, this.bbox.h));
  };

  WritingPad.prototype.clearInk = function () {
    var s = this._sizeOf(this.ink);
    this.ictx.clearRect(0, 0, s.w, s.h);
    this.inkCells = new Uint8Array(GRID * GRID);
    this.strokeCount = 0;
    this.inkLength = 0;
    this.drawing = false;
    this.ink.style.opacity = '1';
  };

  /* ---------- 书写 ---------- */
  WritingPad.prototype._pos = function (e) {
    var r = this.ink.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, t: Date.now() };
  };

  WritingPad.prototype._widthFor = function (speed) {
    if (this.pen === 'pencil') return PENS.pencil.width;
    if (this.pen === 'gangbi') return PENS.gangbi.width;
    // 毛笔：慢→浓粗（_brushMax，随字号自动定），快→细（_brushMin）
    var range = this._brushMax - this._brushMin;
    return Math.max(this._brushMin, this._brushMax - Math.min(range, speed * range / 0.51));
  };

  // 按当前虚影字大小校准笔锋：最大锋宽 ≈ 字宽的 12%，最小 ≈ 2.5%
  WritingPad.prototype._setBrushScale = function (charW) {
    if (!charW || charW <= 0) return;
    this._brushMax = Math.max(14, Math.min(46, charW * 0.12));
    this._brushMin = Math.max(3, Math.min(8, charW * 0.025));
  };

  WritingPad.prototype._colorFor = function () {
    return PENS[this.pen].color;
  };

  WritingPad.prototype._markCells = function (a, b, lineWidth) {
    if (!this.bbox || !this.charCells) return;
    // 按笔宽半径标记：细笔也不吃亏，胡乱涂抹仍难达标
    var cellW = this.bbox.w / GRID, cellH = this.bbox.h / GRID;
    var cellMin = Math.min(cellW, cellH);
    var r = Math.max((lineWidth || 3) / 2, cellMin * 0.6);
    var dx = b.x - a.x, dy = b.y - a.y;
    var dist = Math.hypot(dx, dy);
    var steps = Math.max(1, Math.ceil(dist / 3));
    for (var i = 0; i <= steps; i++) {
      var x = a.x + dx * i / steps, y = a.y + dy * i / steps;
      var gx0 = Math.floor((x - r - this.bbox.x) / cellW);
      var gx1 = Math.floor((x + r - this.bbox.x) / cellW);
      var gy0 = Math.floor((y - r - this.bbox.y) / cellH);
      var gy1 = Math.floor((y + r - this.bbox.y) / cellH);
      for (var gy = gy0; gy <= gy1; gy++) {
        for (var gx = gx0; gx <= gx1; gx++) {
          if (gx < 0 || gx >= GRID || gy < 0 || gy >= GRID) continue;
          var cxp = this.bbox.x + (gx + 0.5) * cellW;
          var cyp = this.bbox.y + (gy + 0.5) * cellH;
          if (Math.hypot(cxp - x, cyp - y) <= r + cellMin * 0.5) {
            this.inkCells[gy * GRID + gx] = 1;
          }
        }
      }
    }
  };

  WritingPad.prototype.coverage = function () {
    if (!this.charCellCount) return 0;
    var hit = 0;
    for (var i = 0; i < this.charCells.length; i++) {
      if (this.charCells[i] && this.inkCells[i]) hit++;
    }
    return hit / this.charCellCount;
  };

  WritingPad.prototype._bind = function () {
    var self = this;
    this.ink.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      if (self.fading) return;
      self.drawing = true;
      self._smoothSpeed = null; // 每笔重新平滑测速
      self._bristlePhase = Math.random() * Math.PI * 2; // 每笔毛丝走向不同
      self._bristleDist = 0;
      self._inking = false;   // 落笔死区：未行笔前不出墨
      self._strokeDist = 0;
      var dp = self._pos(e);
      self._downX = dp.x;
      self._downY = dp.y;
      self.points = [dp];
      self._recStroke = [];                       // 新一笔的落笔记录
      self._recSize = self._sizeOf(self.ink);      // 记录时的画布尺寸（归一化用）
      try { self.ink.setPointerCapture(e.pointerId); } catch (err) {}
      if (self.opts.onStrokeStart) self.opts.onStrokeStart();
      if (self.strokeCount === 0 && self.opts.onFirstStroke) self.opts.onFirstStroke();
    });
    this.ink.addEventListener('pointermove', function (e) {
      if (!self.drawing || self.fading) return;
      e.preventDefault();
      var p = self._pos(e);
      var last = self.points[self.points.length - 1];
      self.points.push(p);
      var segLen = Math.hypot(p.x - last.x, p.y - last.y);
      self._strokeDist += segLen;
      // 落笔死区（仅毛笔）：手指离开落笔点 4px 后才出墨，点按不留一团墨
      if (self.pen === 'maobi' && !self._inking) {
        if (Math.hypot(p.x - self._downX, p.y - self._downY) <= 4) return;
        self._inking = true;
      }
      var dt = Math.max(1, p.t - last.t);
      // 瞬时速度做上限裁剪 + 指数滑动平均：事件批量到达或时间戳抖动时笔锋不突变
      var rawSpeed = Math.min(4, segLen / dt);
      if (self._smoothSpeed == null) self._smoothSpeed = rawSpeed;
      else self._smoothSpeed += (rawSpeed - self._smoothSpeed) * 0.35;
      var w = self._widthFor(self._smoothSpeed);
      if (self.pen === 'maobi') {
        // 起笔收锋：行程前 28px 内笔锋由 40% 渐放到全宽
        var taperIn = Math.min(1, self._strokeDist / 28);
        w = self._brushMin + (w - self._brushMin) * (0.4 + 0.6 * taperIn);
      }
      self.inkLength += segLen;
      self._drawSegment(last, p, w);
      self._markCells(last, p, w);
      // 落笔记录：归一化坐标 + 相对时间 + 归一化笔宽（回放时还原）
      var rs = self._recSize || (self._recSize = self._sizeOf(self.ink));
      var unit = Math.min(rs.w, rs.h) || 1;
      self._recStroke.push([
        +((p.x / rs.w).toFixed(4)),
        +((p.y / rs.h).toFixed(4)),
        Math.round(p.t - (self._charT0 || p.t)),
        +((w / unit).toFixed(5))
      ]);
    });
    function end() {
      if (!self.drawing) return;
      self.drawing = false;
      self.strokeCount++;
      if (self._recStroke && self._recStroke.length >= 2) self._recStrokes.push(self._recStroke);
      self._recStroke = null;
      if (self.opts.onStrokeEnd) self.opts.onStrokeEnd(self.coverage(), self.strokeCount);
    }
    this.ink.addEventListener('pointerup', end);
    this.ink.addEventListener('pointercancel', end);
    var rt;
    global.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { self._resize(); }, 200);
    });
  };

  WritingPad.prototype._drawSegment = function (a, b, w) {
    var ctx = this.ictx;
    if (this.pen !== 'maobi') {
      ctx.strokeStyle = this._colorFor();
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      return;
    }
    // ---- 毛笔：三层渲染 ----
    var dx = b.x - a.x, dy = b.y - a.y;
    var len = Math.hypot(dx, dy) || 0.001;
    var nx = -dy / len, ny = dx / len; // 法线方向
    // 1) 晕染底层：宽而淡，墨韵"浓"
    ctx.strokeStyle = 'rgba(48,36,24,0.16)';
    ctx.lineWidth = w * 1.6;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    // 2) 主锋：浓黑饱满
    ctx.strokeStyle = 'rgba(24,18,12,0.93)';
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    // 3) 毛丝：四缕偏置细锋，边缘参差；运笔越快越容易飞白（随机跳过，露出纸色）
    this._bristleDist = (this._bristleDist || 0) + len;
    var speedNorm = Math.min(1, len / 24);
    var lanes = [-0.46, -0.22, 0.22, 0.46];
    var phase = this._bristlePhase || 0;
    for (var k = 0; k < lanes.length; k++) {
      if (Math.random() < speedNorm * 0.45) continue; // 飞白
      var sway = Math.sin(this._bristleDist * 0.11 + k * 1.7 + phase) * w * 0.07;
      var off = lanes[k] * w + sway;
      ctx.strokeStyle = 'rgba(24,18,12,0.6)';
      ctx.lineWidth = Math.max(1, w * 0.20);
      ctx.beginPath();
      ctx.moveTo(a.x + nx * off, a.y + ny * off);
      ctx.lineTo(b.x + nx * off, b.y + ny * off);
      ctx.stroke();
    }
    // 4) 飞白：快速行笔时在主锋内部擦出纸色丝缕（destination-out 透出宣纸底）；
    //    固定缕位 + 缓慢起伏，丝缕沿笔画连贯不断
    if (speedNorm > 0.3) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      var feiLanes = [-0.28, 0.08, 0.34];
      for (var sIdx = 0; sIdx < feiLanes.length; sIdx++) {
        var soff = (feiLanes[sIdx] + Math.sin(this._bristleDist * 0.008 + sIdx * 2.1 + phase) * 0.08) * w;
        var sAlpha = 0.30 + 0.25 * Math.sin(this._bristleDist * 0.006 + sIdx * 1.7 + phase * 0.7);
        ctx.strokeStyle = 'rgba(0,0,0,' + Math.max(0.12, sAlpha).toFixed(2) + ')';
        ctx.lineWidth = Math.max(1, w * 0.10);
        ctx.beginPath();
        ctx.moveTo(a.x + nx * soff, a.y + ny * soff);
        ctx.lineTo(b.x + nx * soff, b.y + ny * soff);
        ctx.stroke();
      }
      ctx.restore();
    }
  };

  /* ---------- 缓缓隐藏 / 继续改写 ---------- */
  WritingPad.prototype.fadeOut = function (ms, done) {
    var self = this;
    this.cancelFade();
    this.fading = true;
    this.ink.style.transition = 'opacity ' + ms + 'ms ease';
    this.ink.style.opacity = '0';
    this._fadeTimer = setTimeout(function () {
      self.fading = false;
      self.ink.style.transition = '';
      if (done) done();
    }, ms + 60);
  };

  WritingPad.prototype.cancelFade = function () {
    if (this._fadeTimer) clearTimeout(this._fadeTimer);
    this._fadeTimer = 0;
    this.fading = false;
    if (this.ink) {
      this.ink.style.transition = '';
      this.ink.style.opacity = '1';
    }
    if (this.fadeRaf) cancelAnimationFrame(this.fadeRaf);
  };

  /* ---------- 导出成品（裁剪到字区） ---------- */
  WritingPad.prototype.snapshot = function () {
    var dpr = global.devicePixelRatio || 1;
    var tmp = document.createElement('canvas');
    var b = this.bbox;
    var pad = Math.max(b.w, b.h) * 0.25;
    var x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
    var w = Math.min(this.paper.width / dpr - x, b.w + pad * 2);
    var h = Math.min(this.paper.height / dpr - y, b.h + pad * 2);
    var outW = 360, outH = Math.round(360 * h / w);
    tmp.width = outW;
    tmp.height = outH;
    var c = tmp.getContext('2d');
    c.fillStyle = '#f4eddc';
    c.fillRect(0, 0, outW, outH);
    c.drawImage(this.ink, x * dpr, y * dpr, w * dpr, h * dpr, 0, 0, outW, outH);
    try {
      return tmp.toDataURL('image/png');
    } catch (e) {
      return '';
    }
  };

  global.WritingPad = WritingPad;

  // 把当前字（自动跳过的标点）以墨色盖印到墨层，成品依然完整
  // 标点用小字号盖印：字形按正常比例显示，不占满整个字格
  WritingPad.prototype.stampChar = function (ch) {
    var s = this._sizeOf(this.ink);
    var ctx = this.ictx;
    var px = (this.charPx || Math.min(s.w, s.h) * 0.52);
    if (PUNCT_RE.test(ch)) px *= 0.55;
    ctx.save();
    ctx.fillStyle = (PENS[this.pen] && PENS[this.pen].color) || '#2b2118';
    ctx.font = px + 'px ' + this.fontStack;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, s.w / 2, s.h * 0.44);
    ctx.restore();
  };

  // 取出当前字的落笔记录（最小存储单位）：{ pen, ar, strokes: [[[x,y,t,w]...]] }
  // x,y 为相对画布的 0~1 坐标；t 为相对本字首笔的毫秒；w 为相对画布短边的笔宽；
  // ar 为书写画布宽高比（重画时按原比例显示，不拉伸变形）
  WritingPad.prototype.getCharRecord = function () {
    var s = this._sizeOf(this.ink);
    return { pen: this.pen, ar: s.w / s.h, strokes: this._recStrokes || [] };
  };

  // 按原始宽高比 ar(=w/h) 把内容 contain 进 w×h，返回 {ox,oy,dw,dh}
  WritingPad._fitRect = function (w, h, ar) {
    if (!(ar > 0)) return { ox: 0, oy: 0, dw: w, dh: h };
    var dw, dh;
    if (ar > w / h) { dw = w; dh = w / ar; }
    else { dh = h; dw = h * ar; }
    return { ox: (w - dw) / 2, oy: (h - dh) / 2, dw: dw, dh: dh };
  };

  // 当前视口宽高比（旧记录无 ar 时的兜底：同一台手机上看即准确）
  WritingPad._viewportAr = function () {
    return (global.innerWidth && global.innerHeight) ? global.innerWidth / global.innerHeight : 0;
  };

  // 回放落笔记录：按原时间节奏重画（过长则加速，上限 maxMs）
  WritingPad.prototype.replayStrokes = function (rec, opts) {
    opts = opts || {};
    var self = this;
    this.cancelReplay();
    this.setPen(rec.pen || 'maobi');
    this.clearInk();
    this._bristlePhase = Math.random() * Math.PI * 2;
    this._bristleDist = 0;
    var s = this._sizeOf(this.ink);
    var fr = WritingPad._fitRect(s.w, s.h, (rec && rec.ar) || WritingPad._viewportAr());
    var unit = Math.min(fr.dw, fr.dh) || 1;
    var segs = [];
    (rec.strokes || []).forEach(function (st) {
      for (var i = 1; i < st.length; i++) segs.push([st[i - 1], st[i]]);
    });
    if (!segs.length) { if (opts.onDone) opts.onDone(); return; }
    var t0 = segs[0][0][2];
    var span = Math.max(1, segs[segs.length - 1][1][2] - t0);
    var maxMs = opts.maxMs || 8000;
    var scale = span > maxMs ? maxMs / span : 1;
    var raf = global.requestAnimationFrame ||
      function (fn) { return setTimeout(function () { fn(Date.now()); }, 16); };
    var i = 0, start = null;
    function frame(now) {
      if (start === null) start = now;
      var el = (now - start) / scale;
      var guard = 0;
      while (i < segs.length && (segs[i][1][2] - t0) <= el && guard++ < 5000) {
        var a = segs[i][0], b = segs[i][1];
        self._drawSegment(
          { x: fr.ox + a[0] * fr.dw, y: fr.oy + a[1] * fr.dh },
          { x: fr.ox + b[0] * fr.dw, y: fr.oy + b[1] * fr.dh },
          b[3] * unit
        );
        i++;
      }
      if (i < segs.length) {
        self._replayRaf = raf(frame);
      } else {
        self._replayRaf = 0;
        if (opts.onDone) opts.onDone();
      }
    }
    self._replayRaf = raf(frame);
  };

  WritingPad.prototype.cancelReplay = function () {
    if (this._replayRaf) {
      if (global.cancelAnimationFrame) global.cancelAnimationFrame(this._replayRaf);
      else clearTimeout(this._replayRaf);
      this._replayRaf = 0;
    }
  };

  /* 静态渲染一字的笔迹（作品查看 / PDF 用）：不动画，一次画完。
   * rec: {pen, strokes:[[[x,y,t,w]...]]} 或 {auto:'punct'}；ch 仅标点盖印用 */
  WritingPad.drawStatic = function (canvas, rec, ch) {
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = ctx.lineJoin = 'round';
    var fr = WritingPad._fitRect(canvas.width, canvas.height,
      (rec && rec.ar) || WritingPad._viewportAr());
    if (rec && rec.auto === 'punct') {
      var px = Math.min(fr.dw, fr.dh) * 0.52 * 0.55;
      ctx.save();
      ctx.fillStyle = '#2b2118';
      ctx.font = px + 'px "Kaiti SC","KaiTi","STKaiti",serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ch || '', fr.ox + fr.dw / 2, fr.oy + fr.dh * 0.44);
      ctx.restore();
      return;
    }
    var fake = Object.create(WritingPad.prototype);
    fake.ictx = ctx;
    fake.pen = (rec && rec.pen) || 'maobi';
    fake._bristleDist = 0;
    fake._bristlePhase = Math.random() * Math.PI * 2;
    var unit = Math.min(fr.dw, fr.dh) || 1;
    ((rec && rec.strokes) || []).forEach(function (st) {
      for (var i = 1; i < st.length; i++) {
        var a = st[i - 1], b = st[i];
        WritingPad.prototype._drawSegment.call(fake,
          { x: fr.ox + a[0] * fr.dw, y: fr.oy + a[1] * fr.dh },
          { x: fr.ox + b[0] * fr.dw, y: fr.oy + b[1] * fr.dh },
          (b[3] || 0.03) * unit);
      }
    });
  };

  /* 模板字形测量见 glyphBox；作品查看器 PDF 用：复刻书写时 pad.snapshot() 的取景 ——
  /* 模板字形包围盒（与 pad._computeGrid 同算法；renderCropped / 整纸通用格共用）。
   * ar：参考画布宽高比（renderCropped 传本字 rec.ar；整纸传当前视口比即可） */
  WritingPad.glyphBox = function (ch, fontStack, ar) {
    var W = 390;
    var r = ar || WritingPad._viewportAr() || 0.5;
    var H = Math.max(1, Math.round(W / r));
    var px = Math.min(W, H) * 0.52;
    var cx = W / 2, cy = H * 0.44;
    var fs = fontStack || '"Kaiti SC","KaiTi","STKaiti",serif';
    var font = px + 'px ' + fs;
    try {
      var off = document.createElement('canvas');
      off.width = W; off.height = H;
      var c = off.getContext('2d', { willReadFrequently: true });
      c.font = font;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = '#000';
      c.fillText(ch || '', cx, cy);
      var d = c.getImageData(0, 0, W, H).data;
      var minX = W, minY = H, maxX = -1, maxY = -1, x, y;
      for (y = 0; y < H; y += 2) {
        for (x = 0; x < W; x += 2) {
          if (d[(y * W + x) * 4 + 3] > 40) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) throw 0;
      return { bx: minX, by: minY, bw: maxX - minX + 1, bh: maxY - minY + 1,
               W: W, H: H, px: px, cx: cx, cy: cy, font: font, fs: fs };
    } catch (e) {
      return { bx: cx - px / 2, by: cy - px / 2, bw: px, bh: px,
               W: W, H: H, px: px, cx: cx, cy: cy, font: font, fs: fs };
    }
  };

  /* 整纸通用格：所有字共用 side×side 正方形（含 25% 留白），各自以包围盒中心为锚居中，
   * 同一比例、透明底、无格线。side 取全部字形边框的最大值，由调用方先量好传入。
   * trailPunct：尾随标点（不占格，贴在本字格右下角，约 0.32 格大小，与字保持间距）。 */
  WritingPad.renderSheetCell = function (rec, ch, fontStack, side, box, trailPunct) {
    box = box || WritingPad.glyphBox(ch, fontStack, (rec && rec.ar) || null);
    var W = box.W, H = box.H, px = box.px, cx = box.cx, cy = box.cy, fs = box.fs;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    if (rec && rec.auto === 'punct') {
      // 标点复刻 pad.stampChar：0.55x 字号、同字体栈、同锚点盖印
      var c2 = cv.getContext('2d');
      c2.font = (px * 0.55) + 'px ' + fs;
      c2.textAlign = 'center';
      c2.textBaseline = 'middle';
      c2.fillStyle = '#2b2118';
      c2.fillText(ch || '', cx, cy);
    } else {
      WritingPad.drawStatic(cv, rec, ch);
    }
    var bcx = box.bx + box.bw / 2, bcy = box.by + box.bh / 2;
    var sx = Math.max(0, Math.min(W - side, Math.round(bcx - side / 2)));
    var sy = Math.max(0, Math.min(H - side, Math.round(bcy - side / 2)));
    var out = 200, tmp = document.createElement('canvas');
    tmp.width = out; tmp.height = out;
    var t2d = tmp.getContext('2d');
    t2d.drawImage(cv, sx, sy, side, side, 0, 0, out, out);
    if (trailPunct) {
      // 标点不占格：贴在上一个字格的右下角（约 0.32 格，与书写时 0.55x 印章同比例）；
      // 与字保持间距：锚点往角落挪，不破坏字格间距
      t2d.font = (out * 0.32) + 'px ' + fs;
      t2d.textAlign = 'center';
      t2d.textBaseline = 'middle';
      t2d.fillStyle = '#2b2118';
      t2d.fillText(trailPunct, out * 0.80, out * 0.83);
    }
    try { return tmp.toDataURL('image/png'); } catch (e2) { return ''; }
  };

  WritingPad.renderCropped = function (rec, ch, fontStack) {
    var box = WritingPad.glyphBox(ch, fontStack, (rec && rec.ar) || null);
    var W = box.W, H = box.H, px = box.px, cx = box.cx, cy = box.cy, fs = box.fs;
    var bx = box.bx, by = box.by, bw = box.bw, bh = box.bh;
    // 2) 重画字迹。标点复刻 pad.stampChar：0.55x 字号、同字体栈、同锚点盖印，
    //    与书写时的成品快照完全一致（drawStatic 的标点分支字体不同，裁剪会对不上）
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    if (rec && rec.auto === 'punct') {
      var c2 = cv.getContext('2d');
      c2.font = (px * 0.55) + 'px ' + fs;
      c2.textAlign = 'center';
      c2.textBaseline = 'middle';
      c2.fillStyle = '#2b2118';
      c2.fillText(ch || '', cx, cy);
    } else {
      WritingPad.drawStatic(cv, rec, ch);
    }
    // 3) snapshot 同款裁剪：包围盒四周留 25%，输出 360px 宽，纸底 #f4eddc
    var pad = Math.max(bw, bh) * 0.25;
    var sx = Math.max(0, bx - pad), sy = Math.max(0, by - pad);
    var sw = Math.min(W - sx, bw + pad * 2), sh = Math.min(H - sy, bh + pad * 2);
    var outW = 360, outH = Math.max(1, Math.round(360 * sh / sw));
    var tmp = document.createElement('canvas');
    tmp.width = outW; tmp.height = outH;
    var t = tmp.getContext('2d');
    t.fillStyle = '#f4eddc';
    t.fillRect(0, 0, outW, outH);
    t.drawImage(cv, sx, sy, sw, sh, 0, 0, outW, outH);
    try { return tmp.toDataURL('image/png'); } catch (e2) { return ''; }
  };
})(window);
