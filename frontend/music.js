/* 抄经应用 · 生成式氛围音乐引擎（Web Audio，无外部资源）
 *
 * 设计：
 * - 以中国五声音阶（宫商角徵羽）为音高材料，相对半音 [0, 2, 4, 7, 9]
 * - 每部经文配一组参数：{ root_midi, tempo_bpm, timbre, mood }
 * - 四层声部随抄写进度 setProgress(0~1) 逐层加入：
 *     L0 持续低音 drone（一直开）
 *     L1 五声音阶随机游走的拨弦音（p > 0.15）
 *     L2 和声铺底 pad（p > 0.45）
 *     L3 高音泛音点缀（p > 0.75）
 * - L4 gamma 脑波层：40Hz 纯正弦，极低音量，全程铺底（一直开）
 *   可按经文配置 music_config.gamma = {hz, vol, off}，缺省 40Hz / 0.03 / 开
 */
(function (global) {
  'use strict';

  // 宫 商 角 徵 羽（相对半音）
  var PENTA = [0, 2, 4, 7, 9];

  function midiToFreq(m) {
    return 440 * Math.pow(2, (m - 69) / 12);
  }

  function MusicEngine() {
    this.ctx = null;
    this.master = null;
    this.layers = {};      // L0..L4 的 gain 节点
    this.timers = [];
    this.config = { root_midi: 57, tempo_bpm: 50, timbre: 'soft_sine', mood: '' };
    this.playing = false;
    this.muted = false;
    this.noteIndex = 0;    // 五声音阶随机游走当前位置
  }

  MusicEngine.prototype.setConfig = function (cfg) {
    for (var k in cfg) {
      if (cfg[k] !== undefined && cfg[k] !== null) this.config[k] = cfg[k];
    }
  };

  MusicEngine.prototype._ensureCtx = function () {
    if (this.ctx) return;
    var AC = global.AudioContext || global.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.6;
    this.master.connect(this.ctx.destination);
    for (var i = 0; i < 5; i++) {
      var g = this.ctx.createGain();
      g.gain.value = 0;
      g.connect(this.master);
      this.layers['L' + i] = g;
    }
  };

  // 简单拨弦音色：triangle + 指数衰减包络
  MusicEngine.prototype._pluck = function (midi, when, dur, vol, layer) {
    var ctx = this.ctx;
    var osc = ctx.createOscillator();
    osc.type = this.config.timbre === 'bell' ? 'sine' : 'triangle';
    osc.frequency.value = midiToFreq(midi);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(vol, when + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(g);
    g.connect(this.layers[layer]);
    osc.start(when);
    osc.stop(when + dur + 0.1);
  };

  // L0：持续低音（根音 + 高五度），极慢呼吸式起伏
  MusicEngine.prototype._startDrone = function () {
    var ctx = this.ctx, root = this.config.root_midi;
    var self = this;
    [0, 7].forEach(function (iv, i) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = midiToFreq(root - 12 + iv);
      var g = ctx.createGain();
      g.gain.value = i === 0 ? 0.10 : 0.05;
      var lfo = ctx.createOscillator();
      lfo.frequency.value = 0.07 + i * 0.03;
      var lfoG = ctx.createGain();
      lfoG.gain.value = 0.03;
      lfo.connect(lfoG); lfoG.connect(g.gain);
      osc.connect(g); g.connect(self.layers.L0);
      osc.start(); lfo.start();
    });
    this.layers.L0.gain.setTargetAtTime(1, ctx.currentTime, 2);
  };

  // L1：五声音阶随机游走拨弦
  MusicEngine.prototype._startMelody = function () {
    var self = this;
    var beat = 60 / this.config.tempo_bpm;
    function tick() {
      if (!self.playing) return;
      // 随机游走：-2..+2 步，偶尔大跳
      self.noteIndex += Math.floor(Math.random() * 5) - 2;
      if (Math.random() < 0.12) self.noteIndex += (Math.random() < 0.5 ? -5 : 5);
      var scaleLen = PENTA.length * 2;
      var idx = ((self.noteIndex % scaleLen) + scaleLen) % scaleLen;
      var octave = Math.floor(idx / PENTA.length);
      var midi = self.config.root_midi + 12 + PENTA[idx % PENTA.length] + octave * 12;
      var t = self.ctx.currentTime + 0.05;
      self._pluck(midi, t, beat * 4, 0.16, 'L1');
      self.timers.push(setTimeout(tick, beat * 1000 * (Math.random() < 0.3 ? 2 : 1)));
    }
    tick();
  };

  // L2：和声铺底（根音三和弦的五声化和）
  MusicEngine.prototype._startPad = function () {
    var self = this;
    var beat = 60 / this.config.tempo_bpm;
    var chords = [[0, 4, 7], [7, 12, 16], [4, 7, 12], [0, 7, 12]];
    var ci = 0;
    function tick() {
      if (!self.playing) return;
      var t = self.ctx.currentTime + 0.05;
      chords[ci % chords.length].forEach(function (iv) {
        self._pluck(self.config.root_midi + iv, t, beat * 8, 0.05, 'L2');
      });
      ci++;
      self.timers.push(setTimeout(tick, beat * 1000 * 4));
    }
    tick();
  };

  // L3：高音泛音点缀
  MusicEngine.prototype._startSparkle = function () {
    var self = this;
    function tick() {
      if (!self.playing) return;
      var idx = Math.floor(Math.random() * PENTA.length);
      var midi = self.config.root_midi + 36 + PENTA[idx];
      var t = self.ctx.currentTime + 0.05;
      self._pluck(midi, t, 5, 0.05, 'L3');
      self.timers.push(setTimeout(tick, 4000 + Math.random() * 6000));
    }
    tick();
  };

  // L4：gamma 脑波层（40Hz 纯正弦，极低音量，全程铺底）
  MusicEngine.prototype._startGamma = function () {
    var ctx = this.ctx;
    var cfg = this.config.gamma || {};
    if (cfg.off) return;
    var freq = cfg.hz || 40;
    var vol = (cfg.vol !== undefined && cfg.vol !== null) ? cfg.vol : 0.03;
    if (!(vol > 0)) return;
    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    var g = ctx.createGain();
    g.gain.value = vol;
    osc.connect(g);
    g.connect(this.layers.L4);
    osc.start();
    // 缓慢浮现，不打扰入静
    this.layers.L4.gain.setTargetAtTime(1, ctx.currentTime, 4);
  };

  MusicEngine.prototype.start = function () {
    if (this.playing) return;
    this._ensureCtx();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.playing = true;
    this.noteIndex = 0;
    this._startDrone();
    this._startGamma();
    this._startMelody();
    this._startPad();
    this._startSparkle();
    this.setProgress(this._progress || 0);
  };

  MusicEngine.prototype.stop = function () {
    this.playing = false;
    this.timers.forEach(clearTimeout);
    this.timers = [];
    if (this.ctx) {
      var self = this;
      this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.5);
      setTimeout(function () {
        if (!self.playing && self.ctx) {
          self.ctx.close().catch(function () {});
          self.ctx = null;
        }
      }, 1500);
    }
  };

  MusicEngine.prototype.toggle = function () {
    if (this.playing) { this.stop(); return false; }
    this.start(); return true;
  };

  /* 核心接口：抄写进度 0~1，逐层打开声部 */
  MusicEngine.prototype.setProgress = function (p) {
    this._progress = Math.max(0, Math.min(1, p));
    if (!this.ctx) return;
    var t = this.ctx.currentTime;
    var gates = [
      1,                                    // L0 drone：一直开
      this._progress > 0.15 ? 1 : 0,        // L1 旋律
      this._progress > 0.45 ? 1 : 0,        // L2 和声
      this._progress > 0.75 ? 1 : 0,        // L3 泛音
      1                                     // L4 gamma：一直开
    ];
    var self = this;
    gates.forEach(function (on, i) {
      self.layers['L' + i].gain.setTargetAtTime(on ? 1 : 0, t, 1.5);
    });
  };

  /* 录制：把写字时生成的音乐录下来，随作品一起保留 */
  MusicEngine.prototype.startRecording = function () {
    try {
      this._ensureCtx();
      if (!this._recDest) {
        this._recDest = this.ctx.createMediaStreamDestination();
        this.master.connect(this._recDest);
      }
      var MR = global.MediaRecorder;
      if (!MR) return false;
      var rec = new MR(this._recDest.stream);
      var chunks = [];
      var self = this;
      rec.ondataavailable = function (e) {
        if (e.data && e.data.size) chunks.push(e.data);
      };
      rec.onstop = function () {
        var cb = self._recCb;
        self._recCb = null;
        self._recorder = null;
        var blob = null;
        try { blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' }); } catch (e) {}
        if (cb) cb(blob);
      };
      rec.start(1000);
      this._recorder = rec;
      this._recCb = null;
      return true;
    } catch (e) { return false; }
  };

  MusicEngine.prototype.stopRecording = function (cb) {
    this._recCb = cb || null;
    try {
      if (this._recorder && this._recorder.state !== 'inactive') {
        this._recorder.stop();
        return;
      }
    } catch (e) {}
    this._recorder = null;
    var f = this._recCb; this._recCb = null;
    if (f) f(null);
  };

  global.MusicEngine = MusicEngine;
})(window);
