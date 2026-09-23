/* 抄经应用 · 手指书写画布（无外部依赖）
 *
 * WritingPad(canvas, opts)
 *   opts.onStrokeEnd(strokeCount)  每完成一笔时的回调
 *   setBrush('maobi' | 'yingbi' | 'bangshu')
 *   setTraceChar(ch)   设置当前临摹字（占位：显示用）
 *   clear()            清空画布
 *
 * 笔触：
 *   毛笔：线宽随运笔速度变化（慢粗快细），模拟提按
 *   硬笔：恒定细线
 *   榜书：恒定粗线
 */
(function (global) {
  'use strict';

  function WritingPad(canvas, opts) {
    this.canvas = canvas;
    this.opts = opts || {};
    this.brush = 'maobi';
    this.drawing = false;
    this.points = [];
    this.strokeCount = 0;
    this.ctx = canvas.getContext('2d');
    this._resize();
    this._bind();
  }

  WritingPad.prototype._resize = function () {
    var r = this.canvas.getBoundingClientRect();
    var dpr = global.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
  };

  WritingPad.prototype.setBrush = function (name) {
    if (['maobi', 'yingbi', 'bangshu'].indexOf(name) >= 0) this.brush = name;
  };

  // 按笔触 + 速度计算线宽（速度单位：px/ms）
  WritingPad.prototype._widthFor = function (speed) {
    if (this.brush === 'yingbi') return 2.5;
    if (this.brush === 'bangshu') return 16;
    // 毛笔：慢→粗（最大 18），快→细（最小 3）
    var w = 18 - Math.min(15, speed * 60);
    return Math.max(3, w);
  };

  WritingPad.prototype._pos = function (e) {
    var r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, t: Date.now() };
  };

  WritingPad.prototype._bind = function () {
    var self = this;
    this.canvas.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      self.drawing = true;
      self.points = [self._pos(e)];
      self.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', function (e) {
      if (!self.drawing) return;
      e.preventDefault();
      var p = self._pos(e);
      var last = self.points[self.points.length - 1];
      self.points.push(p);
      self._drawSegment(last, p);
    });
    function end(e) {
      if (!self.drawing) return;
      self.drawing = false;
      self.strokeCount++;
      if (self.opts.onStrokeEnd) self.opts.onStrokeEnd(self.strokeCount);
    }
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    global.addEventListener('resize', function () { self._resize(); });
  };

  WritingPad.prototype._drawSegment = function (a, b) {
    var dt = Math.max(1, b.t - a.t);
    var dist = Math.hypot(b.x - a.x, b.y - a.y);
    var speed = dist / dt;
    var w = this._widthFor(speed);
    var ctx = this.ctx;
    ctx.strokeStyle = '#2b2118';
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  };

  WritingPad.prototype.clear = function () {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  };

  // 当前临摹字：占位实现（显示在 #trace-char 元素中，由 app.js 推进）
  WritingPad.prototype.setTraceChar = function (ch) {
    var el = document.getElementById('trace-char');
    if (el) el.textContent = ch || '　';
  };

  global.WritingPad = WritingPad;
})(window);
