/* 抄经应用 · 生成式氛围音乐引擎（Web Audio，无外部资源）
 *
 * 三层独立混音，每层独立控制：
 *   1) 背景层：静 / 雨声 / 海浪 / 经文（合成诵经式持续低音） / 音乐
 *      （音乐 = 五声音阶生成式：持续低音 drone + 轻磬 + 和声铺底 + 小磬/泉/雨自然声）
 *   2) 纯音层：正弦波，可选 174/285/396/417/432/528/639/741/852/963 Hz（默认 528Hz，很轻）
 *   3) 脑波层（可选）：双耳搏动，载波 180Hz ± 差频/2；
 *      Delta 2 / Theta 6 / Schumann 7.83 / Alpha 10 / Gamma 44
 * 每层有独立音量（背景/纯音），脑波层开关 + 选频率；选择与音量经 localStorage 持久化。
 *
 * 音乐背景层沿用原设计：
 * - 以中国五声音阶（宫商角徵羽）为音高材料，相对半音 [0, 2, 4, 7, 9]
 * - 每部经文配一组参数：{ root_midi, tempo_bpm, timbre }（setConfig）
 * - 书写 activity 0~1（0=静止/慢，1=疾书）：setActivity() 设目标，
 *   内部每 0.7s 平滑跟随；activity 高 → 自然声部淡出，只留 drone
 * - 自然声出现条件（setNatureFlags({chime, spring, rain})，由 app.js 按书写节奏评估）：
 *     chime（高音：轻磬/小磬）：停笔时间 > 用户通常 5 个字的换字时间
 *     spring（泉声）：慢写（本字书写超过前两个字）
 *     rain（细雨）：连续慢写 4 个字
 */
(function (global) {
  'use strict';

  // 宫 商 角 徵 羽（相对半音）
  var PENTA = [0, 2, 4, 7, 9];

  /* ---------- 三层定义 ---------- */

  var BG_DEFS = {
    silent: { name: '静' },
    rain:   { name: '雨声' },
    ocean:  { name: '海浪' },
    chant:  { name: '经文' },
    music:  { name: '音乐' },
  };
  var BG_IDS = ['silent', 'rain', 'ocean', 'chant', 'music'];

  var TONE_FREQS = [174, 285, 396, 417, 432, 528, 639, 741, 852, 963];

  var BRAIN_DEFS = {
    off:      { name: '关' },
    delta:    { name: 'Delta', beat: 2 },
    theta:    { name: 'Theta', beat: 6 },
    schumann: { name: 'Schumann 7.83', beat: 7.83 },
    alpha:    { name: 'Alpha 10', beat: 10 },
    gamma:    { name: 'Gamma 44', beat: 44 },
  };
  var BRAIN_IDS = ['off', 'delta', 'theta', 'schumann', 'alpha', 'gamma'];

  function load(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return (v === null || v === undefined || v === '') ? fallback : v;
    } catch (e) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, String(val)); } catch (e) {}
  }

  function MusicEngine() {
    this.ctx = null;
    this.buses = null;      // { bg, tone, brain } 每层总线
    this.master = null;
    this.audibleGain = null;
    this._noiseBuf = null;
    this.timers = [];
    this._gateTimer = null;
    this.config = { root_midi: 45, tempo_bpm: 50, timbre: 0.7 };
    this._activity = 0;
    this._activityTarget = 0;
    this._nature = 1;
    this._wantChime = false;
    this._wantSpring = false;
    this._wantRain = false;
    this._chimeArmed = false;
    this._progGates = [1, 1, 0, 1];
    this.playing = false;
    this.muted = false;
    this.noteIndex = 0;

    // 三层选择（持久化）
    var bg = load('sutra_bg', 'music');
    this._bg = BG_DEFS[bg] ? bg : 'music';
    this._bgVol = Math.max(0, Math.min(100, parseInt(load('sutra_bgvol', '75'), 10) || 0));
    var tf = load('sutra_tonefreq', '528');
    this._toneFreq = (tf === 'off' || TONE_FREQS.indexOf(parseInt(tf, 10)) >= 0) ? tf : '528';
    this._toneVol = Math.max(0, Math.min(100, parseInt(load('sutra_tonevol', '20'), 10) || 0));
    var br = load('sutra_brain', 'off');
    this._brain = BRAIN_DEFS[br] ? br : 'off';

    // 每层节点（切换时重建）
    this._bgNodes = [];
    this._bgTimers = [];
    this._toneNodes = [];
    this._brainNodes = [];
    this._layerGen = { bg: 0, tone: 0, brain: 0 };
    // 音乐背景层内部子总线（drone/高音磬/pad/自然声）
    this._mLayers = null;
    this._musicOn = false;
  }

  /* ---------- 选择/音量 API（即时生效 + 持久化） ---------- */

  MusicEngine.prototype.setBackground = function (id) {
    if (!BG_DEFS[id]) return;
    this._bg = id;
    save('sutra_bg', id);
    this._switchLayer('bg');
  };
  MusicEngine.prototype.setBgVolume = function (v) {
    v = Math.max(0, Math.min(100, Math.round(v)));
    this._bgVol = v;
    save('sutra_bgvol', v);
    this._applyVolumes();
  };
  MusicEngine.prototype.setToneFreq = function (id) {
    if (!(id === 'off' || TONE_FREQS.indexOf(parseInt(id, 10)) >= 0)) return;
    this._toneFreq = id;
    save('sutra_tonefreq', id);
    this._switchLayer('tone');
  };
  MusicEngine.prototype.setToneVolume = function (v) {
    v = Math.max(0, Math.min(100, Math.round(v)));
    this._toneVol = v;
    save('sutra_tonevol', v);
    this._applyVolumes();
  };
  MusicEngine.prototype.setBrain = function (id) {
    if (!BRAIN_DEFS[id]) return;
    this._brain = id;
    save('sutra_brain', id);
    this._switchLayer('brain');
  };

  MusicEngine.prototype.getBackground = function () { return this._bg; };
  MusicEngine.prototype.getBgVolume = function () { return this._bgVol; };
  MusicEngine.prototype.getToneFreq = function () { return this._toneFreq; };
  MusicEngine.prototype.getToneVolume = function () { return this._toneVol; };
  MusicEngine.prototype.getBrain = function () { return this._brain; };
  MusicEngine.getBackgrounds = function () {
    return BG_IDS.map(function (id) { return { id: id, name: BG_DEFS[id].name }; });
  };
  MusicEngine.getToneFreqs = function () {
    return [{ id: 'off', name: '关' }].concat(TONE_FREQS.map(function (f) {
      return { id: String(f), name: f + 'Hz' };
    }));
  };
  MusicEngine.getBrains = function () {
    return BRAIN_IDS.map(function (id) { return { id: id, name: BRAIN_DEFS[id].name }; });
  };

  /* ---------- 基础 ---------- */

  MusicEngine.prototype._ensureCtx = function () {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx = new AC();
    this.ctx = ctx;
    if (ctx.state === 'suspended') ctx.resume();

    // 主链：三层总线 → master → audible(段落显示时静音) → 压缩 → 输出
    function g() { var n = ctx.createGain(); n.gain.value = 0; return n; }
    this.buses = { bg: g(), tone: g(), brain: g() };
    this.master = ctx.createGain();
    this.master.gain.value = 1;
    this.audibleGain = ctx.createGain();
    this.audibleGain.gain.value = this.muted ? 0 : 1;
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.ratio.value = 6;
    this.buses.bg.connect(this.master);
    this.buses.tone.connect(this.master);
    this.buses.brain.connect(this.master);
    this.master.connect(this.audibleGain);
    this.audibleGain.connect(comp);
    comp.connect(ctx.destination);

    // 共享噪声缓冲（4s 白噪声）
    var len = ctx.sampleRate * 4;
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._noiseBuf = buf;
    return ctx;
  };

  MusicEngine.prototype.setConfig = function (cfg) {
    cfg = cfg || {};
    if (cfg.root_midi) this.config.root_midi = cfg.root_midi;
    if (cfg.tempo_bpm) this.config.tempo_bpm = cfg.tempo_bpm;
    if (cfg.timbre !== undefined) this.config.timbre = cfg.timbre;
  };

  MusicEngine.prototype.setActivity = function (v) {
    this._activityTarget = Math.max(0, Math.min(1, v));
  };

  MusicEngine.prototype.setNatureFlags = function (f) {
    f = f || {};
    this._wantChime = !!f.chime;
    this._wantSpring = !!f.spring;
    this._wantRain = !!f.rain;
  };

  // p: 0~1 全文进度；音乐背景层随进度加层
  MusicEngine.prototype.setProgress = function (p) {
    p = Math.max(0, Math.min(1, p));
    this._progGates = [
      1,
      p > 0.12 ? 1 : 0,
      p > 0.45 ? 1 : 0,
      p > 0.06 ? 1 : 0,
    ];
  };

  MusicEngine.prototype._midiToFreq = function (m) {
    return 440 * Math.pow(2, (m - 69) / 12);
  };

  /* ---------- 启停 ---------- */

  MusicEngine.prototype.start = function () {
    if (this.playing) return;
    var ctx = this._ensureCtx();
    this.playing = true;
    this._buildLayer('bg');
    this._buildLayer('tone');
    this._buildLayer('brain');
    this._applyVolumes(true);
    var self = this;
    this._gateTimer = setInterval(function () { self._applyGates(); }, 700);
  };

  MusicEngine.prototype.stop = function () {
    if (!this.playing) return;
    this.playing = false;
    this._teardownLayer('bg');
    this._teardownLayer('tone');
    this._teardownLayer('brain');
    if (this._gateTimer) { clearInterval(this._gateTimer); this._gateTimer = null; }
    this.timers.forEach(function (t) { clearTimeout(t); });
    this.timers = [];
    var self = this;
    if (this.ctx) {
      setTimeout(function () {
        try { self.ctx.close(); } catch (e) {}
        self.ctx = null;
        self.buses = null;
      }, 800);
    }
  };

  MusicEngine.prototype.toggle = function () {
    if (this.playing) { this.stop(); return false; }
    this.start();
    return true;
  };

  // 段落显示时整机静音（不断声部），书写时淡入
  MusicEngine.prototype.setAudible = function (on) {
    this.muted = !on;
    if (this.ctx && this.audibleGain) {
      this.audibleGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, on ? 1.2 : 0.4);
    }
  };

  /* ---------- 三层构建/切换 ---------- */

  MusicEngine.prototype._track = function (kind, node) {
    if (kind === 'bg') this._bgNodes.push(node);
    else if (kind === 'tone') this._toneNodes.push(node);
    else this._brainNodes.push(node);
    return node;
  };

  MusicEngine.prototype._teardownLayer = function (kind) {
    var nodes = kind === 'bg' ? this._bgNodes : kind === 'tone' ? this._toneNodes : this._brainNodes;
    nodes.forEach(function (n) {
      try { n.stop(); } catch (e) {}
      try { n.disconnect(); } catch (e2) {}
    });
    if (kind === 'bg') {
      this._bgNodes = [];
      this._bgTimers.forEach(function (t) { clearTimeout(t); });
      this._bgTimers = [];
      this._mLayers = null;
      this._musicOn = false;
    } else if (kind === 'tone') {
      this._toneNodes = [];
    } else {
      this._brainNodes = [];
    }
  };

  MusicEngine.prototype._buildLayer = function (kind) {
    if (!this.ctx || !this.buses) return;
    if (kind === 'bg') this._buildBackground();
    else if (kind === 'tone') this._buildTone();
    else this._buildBrain();
  };

  // 切换一层：总线先淡出 → 重建 → 淡回（防爆音；用代际计数防快速连点错乱）
  MusicEngine.prototype._switchLayer = function (kind) {
    var self = this;
    if (!this.ctx || !this.playing || !this.buses) return;
    var gen = (this._layerGen[kind] || 0) + 1;
    this._layerGen[kind] = gen;
    var bus = this.buses[kind];
    bus.gain.setTargetAtTime(0, this.ctx.currentTime, 0.25);
    var build = function () { self._buildLayer(kind); };
    setTimeout(function () {
      if (self._layerGen[kind] !== gen || !self.playing) return;
      self._teardownLayer(kind);
      build();
      self._applyVolumes(true);
    }, 650);
  };

  MusicEngine.prototype._applyVolumes = function (ramp) {
    if (!this.ctx || !this.buses) return;
    var t = this.ctx.currentTime;
    var tc = ramp ? 1.5 : 0.1;
    this.buses.bg.gain.setTargetAtTime(this._bgVol / 100, t, tc);
    this.buses.tone.gain.setTargetAtTime(this._toneFreq === 'off' ? 0 : this._toneVol / 100, t, tc);
    this.buses.brain.gain.setTargetAtTime(this._brain === 'off' ? 0 : 1, t, tc);
  };

  /* ---------- 背景层 ---------- */

  MusicEngine.prototype._buildBackground = function () {
    var id = this._bg;
    if (id === 'silent') return;
    if (id === 'rain') this._startRainBg();
    else if (id === 'ocean') this._startOceanBg();
    else if (id === 'chant') this._startChantBg();
    else if (id === 'music') this._startMusicBg();
  };

  // 雨声：高频滤波噪声 + 雨点起伏
  MusicEngine.prototype._startRainBg = function () {
    var ctx = this.ctx;
    var src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    src.playbackRate.value = 1.1;
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 6000;
    bp.Q.value = 0.4;
    var g = ctx.createGain();
    g.gain.value = 0.030;
    var lfo = ctx.createOscillator();
    lfo.frequency.value = 0.4;
    var lg = ctx.createGain();
    lg.gain.value = 0.010;
    lfo.connect(lg);
    lg.connect(g.gain);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.buses.bg);
    src.start();
    lfo.start();
    this._track('bg', src);
    this._track('bg', lfo);
  };

  // 海浪：低频滤波噪声 + 缓慢涌动
  MusicEngine.prototype._startOceanBg = function () {
    var ctx = this.ctx;
    var src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.5;
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    lp.Q.value = 0.4;
    var g = ctx.createGain();
    g.gain.value = 0.055;
    var lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    var lg = ctx.createGain();
    lg.gain.value = 0.035;
    lfo.connect(lg);
    lg.connect(g.gain);
    src.connect(lp);
    lp.connect(g);
    g.connect(this.buses.bg);
    src.start();
    lfo.start();
    this._track('bg', src);
    this._track('bg', lfo);
  };

  // 经文：合成诵经式持续低音（基音+五度+八度，缓慢呼吸起伏 + 轻微颤音）
  MusicEngine.prototype._startChantBg = function () {
    var ctx = this.ctx, self = this;
    var out = ctx.createGain();
    out.gain.value = 1;
    out.connect(this.buses.bg);
    var base = 98; // G2
    [[1, 0.020], [1.5, 0.011], [2, 0.007], [3, 0.003]].forEach(function (p) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = base * p[0];
      var g = ctx.createGain();
      g.gain.value = p[1];
      osc.connect(g);
      g.connect(out);
      osc.start();
      self._track('bg', osc);
    });
    // 呼吸：整体缓慢起伏
    var breath = ctx.createOscillator();
    breath.frequency.value = 0.08;
    var bg2 = ctx.createGain();
    bg2.gain.value = 0.35;
    var breathBase = ctx.createGain();
    breathBase.gain.value = 0.65;
    breath.connect(bg2);
    bg2.connect(out.gain);
    breathBase.connect(out.gain);
    breath.start();
    this._track('bg', breath);
  };

  /* ---------- 背景层：音乐（生成式五声音阶） ---------- */

  MusicEngine.prototype._startMusicBg = function () {
    var ctx = this.ctx;
    function g(v) { var n = ctx.createGain(); n.gain.value = v; return n; }
    this._mLayers = { drone: g(0), chimeHi: g(0), pad: g(0), nature: g(0) };
    var self = this;
    Object.keys(this._mLayers).forEach(function (k) { self._mLayers[k].connect(self.buses.bg); });
    this._musicOn = true;
    this._startDrone();
    this._startPad();
    this._startLightChimes();
    this._startChime();
    this._startSpring();
    this._startRain();
    this._applyGates();
  };

  // drone：两个微失谐正弦 + 缓慢呼吸
  MusicEngine.prototype._startDrone = function () {
    var ctx = this.ctx, self = this;
    var root = this._midiToFreq(this.config.root_midi);
    var g = ctx.createGain();
    g.gain.value = 0.05;
    var o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = root;
    var o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = root * 1.003;
    var o3 = ctx.createOscillator(); o3.type = 'sine'; o3.frequency.value = root / 2;
    var g3 = ctx.createGain(); g3.gain.value = 0.5;
    o1.connect(g); o2.connect(g); o3.connect(g3); g3.connect(g);
    var lfo = ctx.createOscillator(); lfo.frequency.value = 0.05;
    var lg = ctx.createGain(); lg.gain.value = 0.012;
    lfo.connect(lg); lg.connect(g.gain);
    g.connect(this._mLayers.drone);
    [o1, o2, o3, lfo].forEach(function (o) { o.start(); self._track('bg', o); });
  };

  // pad：五声音阶随机游走的柔和拨弦铺底（p > 0.45）
  MusicEngine.prototype._startPad = function () {
    var self = this;
    function tick() {
      if (!self.playing || !self._musicOn) return;
      var pg = self._progGates || [1, 1, 0, 1];
      if (pg[2] && self._mLayers) {
        var t = self.ctx.currentTime + 0.05;
        self.noteIndex += Math.floor(Math.random() * 3) - 1;
        if (self.noteIndex < 0) self.noteIndex = 0;
        if (self.noteIndex > 4) self.noteIndex = 4;
        var midi = self.config.root_midi + 12 + PENTA[self.noteIndex];
        self._pluck(self._midiToFreq(midi), t, 0.028, 9);
      }
      self._bgTimers.push(setTimeout(tick, 60000 / (self.config.tempo_bpm || 50)));
    }
    tick();
  };

  MusicEngine.prototype._pluck = function (freq, when, vol, decaySecs) {
    var ctx = this.ctx;
    var timbre = this.config.timbre == null ? 0.7 : this.config.timbre;
    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    var osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = freq * 2;
    var g2 = ctx.createGain();
    g2.gain.value = 0.25 * timbre;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(vol, when + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, when + decaySecs);
    osc.connect(g);
    osc2.connect(g2);
    g2.connect(g);
    g.connect(this._mLayers.pad);
    osc.start(when); osc2.start(when);
    osc.stop(when + decaySecs + 0.2); osc2.stop(when + decaySecs + 0.2);
  };

  // 轻磬：纯净柔和，余韵悠长（书写慢/停时浮现）
  MusicEngine.prototype._lightChime = function (when) {
    var ctx = this.ctx;
    var midi = this.config.root_midi + 24 + PENTA[Math.floor(Math.random() * 5)];
    var f = this._midiToFreq(midi);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(0.016, when + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 7);
    [1, 2.76, 5.4].forEach(function (m, i) {
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * m;
      var og = ctx.createGain();
      og.gain.value = i === 0 ? 1 : 0.25 / i;
      o.connect(og); og.connect(g);
      o.start(when); o.stop(when + 7.5);
    });
    var pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) { pan.pan.value = Math.random() * 1.2 - 0.6; g.connect(pan); pan.connect(this._mLayers.chimeHi); }
    else g.connect(this._mLayers.chimeHi);
  };

  MusicEngine.prototype._startLightChimes = function () {
    var self = this;
    function tick() {
      if (!self.playing || !self._musicOn) return;
      if (self._chimeArmed) {
        var t = self.ctx.currentTime + 0.05;
        self._lightChime(t);
        if (Math.random() < 0.2) self._lightChime(t + 2.5 + Math.random() * 3);
      }
      self._bgTimers.push(setTimeout(tick, 12000 + Math.random() * 18000));
    }
    tick();
  };

  // 小磬：深远空灵（书写慢/停时偶发）
  MusicEngine.prototype._chime = function (when) {
    var ctx = this.ctx;
    var f = this._midiToFreq(this.config.root_midi + 12 + PENTA[Math.floor(Math.random() * 5)]);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(0.010, when + 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 10);
    [1, 2.01, 2.74].forEach(function (m, i) {
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * m;
      var og = ctx.createGain();
      og.gain.value = i === 0 ? 1 : 0.3 / i;
      o.connect(og); og.connect(g);
      o.start(when); o.stop(when + 10.5);
    });
    g.connect(this._mLayers.nature);
  };

  MusicEngine.prototype._startChime = function () {
    var self = this;
    function tick() {
      if (!self.playing || !self._musicOn) return;
      if (self._chimeArmed) self._chime(self.ctx.currentTime + 0.05);
      self._bgTimers.push(setTimeout(tick, 40000 + Math.random() * 60000));
    }
    tick();
  };

  // 泉声：带通噪声 + 慢速起伏
  MusicEngine.prototype._startSpring = function () {
    var ctx = this.ctx;
    var src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.7;
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400;
    bp.Q.value = 0.8;
    var g = ctx.createGain();
    g.gain.value = 0;
    this._springGain = g;
    var lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    var lg = ctx.createGain();
    lg.gain.value = 0;
    this._springLfoDepth = lg;
    lfo.connect(lg);
    lg.connect(g.gain);
    src.connect(bp);
    bp.connect(g);
    g.connect(this._mLayers.nature);
    src.start();
    lfo.start();
    this._track('bg', src);
    this._track('bg', lfo);
  };

  // 细雨：高频噪声 + 雨点起伏
  MusicEngine.prototype._startRain = function () {
    var ctx = this.ctx;
    var src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    src.playbackRate.value = 1.4;
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 7000;
    bp.Q.value = 0.5;
    var g = ctx.createGain();
    g.gain.value = 0;
    this._rainGain = g;
    var lfo = ctx.createOscillator();
    lfo.frequency.value = 0.31;
    var lg = ctx.createGain();
    lg.gain.value = 0.004;
    lfo.connect(lg);
    lg.connect(g.gain);
    src.connect(bp);
    bp.connect(g);
    g.connect(this._mLayers.nature);
    src.start();
    lfo.start();
    this._track('bg', src);
    this._track('bg', lfo);
  };

  // 综合门控：进度 × 书写状态，每 0.7s 平滑跟随一次（只作用于音乐背景层）
  MusicEngine.prototype._applyGates = function () {
    if (!this.ctx || !this.playing || !this._musicOn || !this._mLayers) return;
    this._activity += (this._activityTarget - this._activity) * 0.3;
    if (Math.abs(this._activityTarget - this._activity) < 0.01) this._activity = this._activityTarget;
    this._nature = 1 - this._activity;
    var pg = this._progGates || [1, 1, 0, 1];
    var t = this.ctx.currentTime;
    this._mLayers.drone.gain.setTargetAtTime(1, t, 2.5);
    this._mLayers.chimeHi.gain.setTargetAtTime(pg[1] * this._nature, t, 2.5);
    this._mLayers.pad.gain.setTargetAtTime(pg[2] * (1 - 0.7 * this._activity), t, 2.5);
    this._mLayers.nature.gain.setTargetAtTime(pg[3] * this._nature, t, 2.5);
    this._chimeArmed = this._wantChime && this._nature > 0.45;
    if (this._springGain) this._springGain.gain.setTargetAtTime(0.016 * (this._wantSpring ? 1 : 0), t, 2.5);
    if (this._springLfoDepth) this._springLfoDepth.gain.setTargetAtTime(0.008 * (this._wantSpring ? 1 : 0), t, 2.5);
    if (this._rainGain) this._rainGain.gain.setTargetAtTime(0.010 * (this._wantRain ? 1 : 0), t, 2.5);
  };

  /* ---------- 纯音层 ---------- */

  MusicEngine.prototype._buildTone = function () {
    if (this._toneFreq === 'off') return;
    var ctx = this.ctx;
    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = parseInt(this._toneFreq, 10);
    var g = ctx.createGain();
    g.gain.value = 0.035;
    osc.connect(g);
    g.connect(this.buses.tone);
    osc.start();
    this._track('tone', osc);
  };

  /* ---------- 脑波层（双耳搏动） ---------- */

  MusicEngine.prototype._buildBrain = function () {
    if (this._brain === 'off') return;
    var def = BRAIN_DEFS[this._brain];
    if (!def || !def.beat) return;
    var ctx = this.ctx, self = this;
    [180 - def.beat / 2, 180 + def.beat / 2].forEach(function (f) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      var g = ctx.createGain();
      g.gain.value = 0.012;
      osc.connect(g);
      g.connect(self.buses.brain);
      osc.start();
      self._track('brain', osc);
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
