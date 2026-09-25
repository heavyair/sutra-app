/* 抄经应用 · 生成式氛围音乐引擎（Web Audio，无外部资源）
 *
 * 设计：
 * - 以中国五声音阶（宫商角徵羽）为音高材料，相对半音 [0, 2, 4, 7, 9]
 * - 每部经文配一组参数：{ root_midi, tempo_bpm, timbre, mood }（调制频率由用户全局选择）
 * - 声部：
 *     L0 持续低音 drone（一直开，按场景缩放）
 *     L1 轻磬：纯净柔和的磬声，余韵悠长（书写慢/停时浮现，按场景缩放/疏密）
 *     L2 和声铺底 pad（p > 0.45；写得快时降到三成；按场景缩放）
 *     L3 小磬 + 泉消 + 细雨 + 风层（书写慢/停时浮现；风层为各场景的可调滤波噪声）
 *     L4 调制层（用户自选频率；默认 Gamma 44Hz；脑波类用双耳搏动实现）
 * - 场景（用户自选，默认"密"）：静 / 山 / 风 / 谷 / 海 / 林 / 沙 / 崖 / 密
 * - 调制（用户自选，默认 Gamma 44Hz）：关 / Gamma 44 / Delta / Theta /
 *   Schumann 7.83 / Alpha / 索尔费乔 174-963Hz
 * - 书写 activity 0~1（0=静止/慢，1=疾书）：setActivity() 设目标，
 *   内部每 0.7s 平滑跟随；activity 高 → 自然声部淡出，只留 L0 + 调制层
 * - 自然声出现条件（setNatureFlags({chime, spring, rain})，由 app.js 按书写节奏评估）：
 *     chime（高音：L1 轻磬 / L3 小磬）：停笔时间 > 用户通常 5 个字的换字时间
 *     spring（泉消）：慢写（本字书写超过前两个字）
 *     rain（细雨）：连续慢写 4 个字
 */
(function (global) {
  'use strict';

  // 宫 商 角 徵 羽（相对半音）
  var PENTA = [0, 2, 4, 7, 9];

  // 背景音场景：drone/pad 缩放；chime 缩放+疏密；spring/rain 缩放；
  // wind 为可调滤波噪声（type/freq/q/lfo/gain），null 表示该场景无风层
  var SCENES = {
    silent:   { name: '静', silent: true },
    mountain: { name: '山', drone: 1,   pad: 0.4, chime: 0.6,  spring: 0,   rain: 0,
                wind: { type: 'bandpass', freq: 350,  q: 0.6, lfo: 0.05, gain: 0.022 } },
    wind:     { name: '风', drone: 0.3, pad: 0,   chime: 0.2,  spring: 0,   rain: 0,
                wind: { type: 'bandpass', freq: 750,  q: 0.5, lfo: 0.09, gain: 0.035 } },
    valley:   { name: '谷', drone: 0.8, pad: 0.7, chime: 1.3,  spring: 0.6, rain: 0,
                wind: { type: 'bandpass', freq: 1100, q: 0.7, lfo: 0.045, gain: 0.014 } },
    ocean:    { name: '海', drone: 0.5, pad: 0.5, chime: 0.3,  spring: 0,   rain: 0,
                wind: { type: 'lowpass',  freq: 420,  q: 0.4, lfo: 0.075, gain: 0.05 } },
    forest:   { name: '林', drone: 0.6, pad: 0.3, chime: 0.9,  spring: 0.3, rain: 0.5,
                wind: { type: 'highpass', freq: 5200, q: 0.6, lfo: 0.12, gain: 0.008 } },
    desert:   { name: '沙', drone: 0.4, pad: 0,   chime: 0.15, spring: 0,   rain: 0,
                wind: { type: 'bandpass', freq: 550,  q: 0.7, lfo: 0.06, gain: 0.018 } },
    cliff:    { name: '崖', drone: 0.7, pad: 0,   chime: 0.2,  spring: 0,   rain: 0,
                wind: { type: 'bandpass', freq: 2100, q: 2.5, lfo: 0.11, gain: 0.016 } },
    dense:    { name: '密', drone: 1,   pad: 1,   chime: 1,    spring: 1,   rain: 1, wind: null },
  };
  var SCENE_IDS = ['silent', 'mountain', 'wind', 'valley', 'ocean', 'forest', 'desert', 'cliff', 'dense'];

  // 调制频率：beat 为双耳搏动差频（载波 180Hz），hz 为单音正弦
  var MODS = [
    { id: 'off',      name: '关' },
    { id: 'gamma44',  name: 'Gamma 44Hz', hz: 44 },
    { id: 'delta',    name: 'Delta', beat: 2 },
    { id: 'theta',    name: 'Theta', beat: 6 },
    { id: 'schumann', name: 'Schumann 7.83', beat: 7.83 },
    { id: 'alpha',    name: 'Alpha', beat: 10 },
    { id: 'sf174',    name: '174Hz', hz: 174 },
    { id: 'sf285',    name: '285Hz', hz: 285 },
    { id: 'sf396',    name: '396Hz', hz: 396 },
    { id: 'sf417',    name: '417Hz', hz: 417 },
    { id: 'sf432',    name: '432Hz', hz: 432 },
    { id: 'sf528',    name: '528Hz', hz: 528 },
    { id: 'sf639',    name: '639Hz', hz: 639 },
    { id: 'sf741',    name: '741Hz', hz: 741 },
    { id: 'sf852',    name: '852Hz', hz: 852 },
    { id: 'sf963',    name: '963Hz', hz: 963 },
  ];

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
    // 场景与调制：用户全局选择，localStorage 持久化（默认 密 / Gamma 44Hz）
    var savedScene = null, savedMod = null;
    try {
      savedScene = localStorage.getItem('sutra_scene');
      savedMod = localStorage.getItem('sutra_mod');
    } catch (e) {}
    this._scene = (savedScene && SCENES[savedScene]) ? savedScene : 'dense';
    this._modId = savedMod || 'gamma44';
    this._l4nodes = [];
    this._l4on = false;
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
    // 4 秒噪声缓冲：泉消 / 细雨共用
    var nb = this.ctx.createBuffer(1, this.ctx.sampleRate * 4, this.ctx.sampleRate);
    var nd = nb.getChannelData(0);
    for (var n = 0; n < nd.length; n++) nd[n] = Math.random() * 2 - 1;
    this._noiseBuf = nb;
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

  // L1 轻磬：纯净柔和，一声、余韵悠长（近谐泛音，无滑音）
  MusicEngine.prototype._lightChime = function (when) {
    var ctx = this.ctx, self = this;
    var base = midiToFreq(this.config.root_midi + 24); // 高两个八度
    [[1, 1.0], [2.003, 0.35], [2.997, 0.15]].forEach(function (pr) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = base * pr[0];
      var g = ctx.createGain();
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(0.030 * pr[1], when + 0.08); // 轻起音
      g.gain.exponentialRampToValueAtTime(0.0001, when + 6 + Math.random() * 4);
      osc.connect(g);
      g.connect(self.layers.L1);
      osc.start(when);
      osc.stop(when + 12);
    });
  };

  MusicEngine.prototype._startLightChimes = function () {
    var self = this;
    function tick() {
      if (!self.playing) return;
      // 高音只在停笔足够久（条件成立）且非疾书时触发；间隔按场景疏密缩放
      if (self._chimeArmed) {
        var t = self.ctx.currentTime + 0.05;
        self._lightChime(t);
        if (Math.random() < 0.2) self._lightChime(t + 2.5 + Math.random() * 3); // 偶尔应和一声
      }
      var sc = SCENES[self._scene] || SCENES.dense;
      var dens = Math.max(0.12, sc.chime || 0);
      self.timers.push(setTimeout(tick, (12000 + Math.random() * 18000) / dens));
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

  // L3 小磬：微失谐泛音，一击、十几秒自然衰减
  MusicEngine.prototype._chime = function (when) {
    var ctx = this.ctx, self = this;
    var base = midiToFreq(this.config.root_midi + 24); // 高两个八度
    [1, 2.02, 2.94].forEach(function (r, i) {
      [-2, 2].forEach(function (cents) { // ±2 音分失谐 → 慢拍频 shimmer
        var osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = base * r * Math.pow(2, cents / 1200);
        var g = ctx.createGain();
        g.gain.setValueAtTime(0, when);
        g.gain.linearRampToValueAtTime(0.035 / (i + 1) / 2, when + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, when + 12 + Math.random() * 6);
        osc.connect(g);
        g.connect(self.layers.L3);
        osc.start(when);
        osc.stop(when + 20);
      });
    });
  };

  MusicEngine.prototype._startChime = function () {
    var self = this;
    function tick() {
      if (!self.playing) return;
      if (self._chimeArmed) self._chime(self.ctx.currentTime + 0.05);
      var sc = SCENES[self._scene] || SCENES.dense;
      var dens = Math.max(0.12, sc.chime || 0);
      self.timers.push(setTimeout(tick, (40000 + Math.random() * 60000) / dens));
    }
    tick();
  };

  // L3 泉消：带通噪声 + 极慢起伏，一起一伏约 22 秒
  MusicEngine.prototype._startSpring = function () {
    var ctx = this.ctx;
    var src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1100;
    bp.Q.value = 0.7;
    var g = ctx.createGain();
    g.gain.value = 0; // 初始静音，由门控按"慢写"条件淡入
    this._springGain = g;
    var lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    var lg = ctx.createGain();
    lg.gain.value = 0;
    this._springLfoDepth = lg;
    lfo.connect(lg);
    lg.connect(g.gain);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.layers.L3);
    src.start();
    lfo.start();
  };

  // L3 细雨：高通噪声极低音量 + 偶发微小水滴
  MusicEngine.prototype._startRain = function () {
    var ctx = this.ctx, self = this;
    var src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.7;
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6000;
    var g = ctx.createGain();
    g.gain.value = 0; // 初始静音，由门控按"连慢4字"条件淡入
    this._rainGain = g;
    src.connect(hp);
    hp.connect(g);
    g.connect(this.layers.L3);
    src.start();
    function droplet() {
      if (!self.playing) return;
      if (self._wantRain && self._nature > 0.5) {
        var t = self.ctx.currentTime + 0.05;
        var o = self.ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = 3000 + Math.random() * 4000;
        var dg = self.ctx.createGain();
        dg.gain.setValueAtTime(0, t);
        dg.gain.linearRampToValueAtTime(0.016, t + 0.01);
        dg.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
        o.connect(dg);
        dg.connect(self.layers.L3);
        o.start(t);
        o.stop(t + 0.15);
      }
      self.timers.push(setTimeout(droplet, 2000 + Math.random() * 7000));
    }
    droplet();
  };

  // L3 风层：可调滤波噪声 + 极慢起伏，各场景的风/海/林底噪（参数随场景切换）
  MusicEngine.prototype._startWind = function () {
    var ctx = this.ctx;
    var src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.5;
    var flt = ctx.createBiquadFilter();
    flt.type = 'bandpass';
    flt.frequency.value = 800;
    flt.Q.value = 0.5;
    var g = ctx.createGain();
    g.gain.value = 0; // 初始静音，由场景门控淡入
    this._windGain = g;
    this._windFilter = flt;
    var lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    var lg = ctx.createGain();
    lg.gain.value = 0;
    this._windLfo = lfo;
    this._windLfoDepth = lg;
    lfo.connect(lg);
    lg.connect(g.gain);
    src.connect(flt);
    flt.connect(g);
    g.connect(this.layers.L3);
    src.start();
    lfo.start();
    this._applyWindParams();
  };

  // 场景切换时重设风层滤波器参数（不断声，平滑过渡）
  MusicEngine.prototype._applyWindParams = function () {
    if (!this.ctx || !this._windFilter) return;
    var sc = SCENES[this._scene] || SCENES.dense;
    var w = sc.wind;
    var t = this.ctx.currentTime;
    if (!w) {
      if (this._windLfoDepth) this._windLfoDepth.gain.setTargetAtTime(0, t, 2);
      return;
    }
    try { this._windFilter.type = w.type; } catch (e) {}
    this._windFilter.frequency.setTargetAtTime(w.freq, t, 2);
    this._windFilter.Q.setTargetAtTime(w.q, t, 2);
    if (this._windLfo) this._windLfo.frequency.setTargetAtTime(w.lfo, t, 2);
    if (this._windLfoDepth) this._windLfoDepth.gain.setTargetAtTime(w.gain * 0.6, t, 2);
  };

  // L4：调制层（用户自选；默认 Gamma 44Hz 纯正弦极低音量铺底；
  // 脑波类用双耳搏动实现：载波 180Hz ± 差频/2）
  MusicEngine.prototype._clearL4 = function () {
    (this._l4nodes || []).forEach(function (n) {
      try { n.stop(); } catch (e) {}
      try { n.disconnect(); } catch (e2) {}
    });
    this._l4nodes = [];
    this._l4on = false;
  };

  MusicEngine.prototype._startModulation = function () {
    this._clearL4();
    if (!this.ctx) return;
    var sc = SCENES[this._scene] || SCENES.dense;
    if (sc.silent) return;
    // 先把总线拉低（0.5s），新声部建好后由 _applyGates 平滑推回，避免切换爆音
    if (this.layers.L4) this.layers.L4.gain.setTargetAtTime(0, this.ctx.currentTime, 0.5);
    var mod = null;
    for (var i = 0; i < MODS.length; i++) {
      if (MODS[i].id === this._modId) { mod = MODS[i]; break; }
    }
    if (!mod || mod.id === 'off') return;
    var ctx = this.ctx, self = this;
    this._l4nodes = [];
    if (mod.beat) {
      [180 - mod.beat / 2, 180 + mod.beat / 2].forEach(function (f) {
        var osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = f;
        var g = ctx.createGain();
        g.gain.value = 0.012;
        osc.connect(g);
        g.connect(self.layers.L4);
        osc.start();
        self._l4nodes.push(osc);
      });
    } else {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = mod.hz;
      var g = ctx.createGain();
      g.gain.value = mod.hz < 100 ? 0.015 : 0.02;
      osc.connect(g);
      g.connect(self.layers.L4);
      osc.start();
      self._l4nodes.push(osc);
    }
    this._l4on = true;
  };

  /* 场景 / 调制：用户全局选择，即时生效并持久化 */
  MusicEngine.prototype.setScene = function (name) {
    if (!SCENES[name]) return;
    this._scene = name;
    try { localStorage.setItem('sutra_scene', name); } catch (e) {}
    this._applyWindParams();
    if (this.playing) { this._startModulation(); this._applyGates(); }
  };

  MusicEngine.prototype.setModulation = function (id) {
    var ok = false;
    for (var i = 0; i < MODS.length; i++) {
      if (MODS[i].id === id) { ok = true; break; }
    }
    if (!ok) return;
    this._modId = id;
    try { localStorage.setItem('sutra_mod', id); } catch (e) {}
    if (this.playing) { this._startModulation(); this._applyGates(); }
  };

  MusicEngine.prototype.getScene = function () { return this._scene; };
  MusicEngine.prototype.getModulation = function () { return this._modId; };
  MusicEngine.getScenes = function () {
    return SCENE_IDS.map(function (id) { return { id: id, name: SCENES[id].name }; });
  };
  MusicEngine.getModulations = function () {
    return MODS.map(function (m) { return { id: m.id, name: m.name }; });
  };

  MusicEngine.prototype.start = function () {
    if (this.playing) return;
    this._ensureCtx();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.playing = true;
    this._activity = 0;          // 当前书写 activity（平滑值）
    this._activityTarget = 0;    // 目标：setActivity() 设置
    this._nature = 1;            // 自然声部电平 = 1 - activity
    this._wantChime = false;     // 高音条件：停笔 > 通常5字
    this._wantSpring = false;    // 泉消条件：慢写
    this._wantRain = false;      // 细雨条件：连续慢写4字
    this._chimeArmed = false;    // 高音实际可触发 = 条件成立且非疾书
    this._startDrone();
    this._startWind();
    this._startModulation();
    this._startLightChimes();
    this._startPad();
    this._startChime();
    this._startSpring();
    this._startRain();
    this.setProgress(this._progress || 0);
    var self = this;
    this._gateTimer = setInterval(function () { self._applyGates(); }, 700);
  };

  MusicEngine.prototype.stop = function () {
    this.playing = false;
    this.timers.forEach(clearTimeout);
    this.timers = [];
    if (this._gateTimer) { clearInterval(this._gateTimer); this._gateTimer = 0; }
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

  // 显示经文时静音 / 书写时淡入：不断 AudioContext，录制不中断
  MusicEngine.prototype.setAudible = function (on) {
    if (!this.ctx || !this.master) return;
    var target = on ? (this.muted ? 0 : 0.6) : 0;
    try { this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.8); } catch (e) {}
  };

  /* 自然声出现条件：app.js 按书写节奏评估后传入
   * {chime: 停笔>通常5字 → 高音（轻磬/小磬）, spring: 慢写 → 泉消, rain: 连慢4字 → 细雨} */
  MusicEngine.prototype.setNatureFlags = function (f) {
    f = f || {};
    this._wantChime = !!f.chime;
    this._wantSpring = !!f.spring;
    this._wantRain = !!f.rain;
  };

  /* 书写 activity：0=静止/慢，1=疾书；内部平滑跟随 */
  MusicEngine.prototype.setActivity = function (a) {
    this._activityTarget = Math.max(0, Math.min(1, a || 0));
  };

  // 综合门控：进度 × 书写状态 × 场景，每 0.7s 平滑跟随一次
  MusicEngine.prototype._applyGates = function () {
    if (!this.ctx || !this.playing) return;
    this._activity += (this._activityTarget - this._activity) * 0.3;
    if (Math.abs(this._activityTarget - this._activity) < 0.01) this._activity = this._activityTarget;
    this._nature = 1 - this._activity;
    var sc = SCENES[this._scene] || SCENES.dense;
    var silent = !!sc.silent;
    var pg = this._progGates || [1, 1, 0, 1, 1];
    var t = this.ctx.currentTime;
    this.layers.L0.gain.setTargetAtTime(silent ? 0 : sc.drone, t, 2.5);
    this.layers.L1.gain.setTargetAtTime(silent ? 0 : pg[1] * this._nature * sc.chime, t, 2.5);
    this.layers.L2.gain.setTargetAtTime(silent ? 0 : pg[2] * (1 - 0.7 * this._activity) * sc.pad, t, 2.5);
    this.layers.L3.gain.setTargetAtTime(silent ? 0 : pg[3] * this._nature, t, 2.5);
    this.layers.L4.gain.setTargetAtTime((silent || !this._l4on) ? 0 : 1, t, 2.5);
    // 高音实际可触发 = 条件成立且非疾书；场景无磬时不触发
    this._chimeArmed = this._wantChime && this._nature > 0.45 && sc.chime > 0 && !silent;
    var springT = silent ? 0 : 0.016 * (this._wantSpring ? 1 : 0) * (sc.spring || 0);
    var rainT = silent ? 0 : 0.010 * (this._wantRain ? 1 : 0) * (sc.rain || 0);
    if (this._springGain) this._springGain.gain.setTargetAtTime(springT, t, 2.5);
    if (this._springLfoDepth) this._springLfoDepth.gain.setTargetAtTime(springT * 0.5, t, 2.5);
    if (this._rainGain) this._rainGain.gain.setTargetAtTime(rainT, t, 2.5);
    if (this._windGain) {
      var wg = (silent || !sc.wind) ? 0 : sc.wind.gain * (0.35 + 0.65 * this._nature);
      this._windGain.gain.setTargetAtTime(wg, t, 2.5);
    }
  };

  /* 核心接口：抄写进度 0~1（L2 和声铺底仍随进度加层；L1/L3 自然声只跟书写状态） */
  MusicEngine.prototype.setProgress = function (p) {
    this._progress = Math.max(0, Math.min(1, p));
    this._progGates = [1, 1, this._progress > 0.45 ? 1 : 0, 1, 1];
    this._applyGates();
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
