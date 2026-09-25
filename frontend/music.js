/* 抄经应用 · 生成式氛围音乐引擎（Web Audio，无外部资源）
 *
 * 设计：
 * - 以中国五声音阶（宫商角徵羽）为音高材料，相对半音 [0, 2, 4, 7, 9]
 * - 每部经文配一组参数：{ root_midi, tempo_bpm, timbre, mood, gamma }
 * - 声部：
 *     L0 持续低音 drone（一直开）
 *     L1 轻磬：纯净柔和的磬声，余韵悠长（书写慢/停时浮现）
 *     L2 和声铺底 pad（p > 0.45；写得快时降到三成）
 *     L3 小磬 + 泉消 + 细雨（书写慢/停时浮现）
 *     L4 gamma 脑波层（一直开）
 * - 书写 activity 0~1（0=静止/慢，1=疾书）：setActivity() 设目标，
 *   内部每 0.7s 平滑跟随；activity 高 → 自然声部淡出，只留 L0 + gamma
 * - 自然声出现条件（setNatureFlags({chime, spring, rain})，由 app.js 按书写节奏评估）：
 *     chime（高音：L1 轻磬 / L3 小磬）：停笔时间 > 用户通常 5 个字的换字时间
 *     spring（泉消）：慢写（本字书写超过前两个字）
 *     rain（细雨）：连续慢写 4 个字
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
    // 40Hz 铺底开关：用户可选，默认开，localStorage 记住
    var savedGamma = null;
    try { savedGamma = localStorage.getItem('sutra_gamma40'); } catch (e) {}
    this._gammaOn = savedGamma !== '0';
    // 低音声部风格：'drone' 持续低音（默认）/ 'bigchime' 大罄，localStorage 记住
    var savedBass = null;
    try { savedBass = localStorage.getItem('sutra_bass'); } catch (e) {}
    this._bassStyle = savedBass === 'bigchime' ? 'bigchime' : 'drone';
    this._bassNodes = [];   // drone 振荡器（切换风格时停掉）
    this._bassTimers = [];  // 大罄敲击定时器
  }

  MusicEngine.prototype.setConfig = function (cfg) {
    for (var k in cfg) {
      if (cfg[k] !== undefined && cfg[k] !== null) this.config[k] = cfg[k];
    }
  };

  MusicEngine.prototype._ensureCtx = function () {
    if (this.ctx) return;
    var AC = global.AudioContext || global.webkitAudioContext;
    // latencyHint: 'playback' —— 增大音频缓冲，防手机端 CPU 繁忙时随机爆音（环境音乐对延迟不敏感）
    try { this.ctx = new AC({ latencyHint: 'playback' }); }
    catch (e) { this.ctx = new AC(); }
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
    // 尾部 0.2 秒渐变为头部首值：loop 循环点连续，消除周期性爆破音
    var fadeLen = Math.floor(this.ctx.sampleRate * 0.2);
    for (var fi = 0; fi < fadeLen; fi++) {
      var ft = fi / (fadeLen - 1); // 0 → 1
      var tailIdx = nd.length - fadeLen + fi;
      nd[tailIdx] = nd[tailIdx] * (1 - ft) + nd[0] * ft;
    }
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

  // L0 低音声部：两种风格可选（'drone' 持续低音 / 'bigchime' 大罄）
  MusicEngine.prototype._stopBass = function () {
    if (this._bassNodes) {
      this._bassNodes.forEach(function (n) { try { n.stop(); } catch (e) {} });
      this._bassNodes = [];
    }
    if (this._bassTimers) {
      this._bassTimers.forEach(clearTimeout);
      this._bassTimers = [];
    }
  };

  // 低音风格调度：先停旧声部，再按当前风格启动；L0 总线不断层
  MusicEngine.prototype._startBass = function () {
    this._stopBass();
    if (this._bassStyle === 'bigchime') this._startBigChime();
    else this._startDrone();
    if (this.ctx) this.layers.L0.gain.setTargetAtTime(1, this.ctx.currentTime, 2);
  };

  // 低音风格：用户二选一（播放中即时切换，记住选择）
  MusicEngine.prototype.setBassStyle = function (s) {
    this._bassStyle = (s === 'bigchime') ? 'bigchime' : 'drone';
    try { localStorage.setItem('sutra_bass', this._bassStyle); } catch (e) {}
    if (this.playing) this._startBass();
  };
  MusicEngine.prototype.getBassStyle = function () {
    return this._bassStyle === 'bigchime' ? 'bigchime' : 'drone';
  };

  // L0 持续低音（根音 + 高五度），极慢呼吸式起伏
  MusicEngine.prototype._startDrone = function () {
    var ctx = this.ctx, root = this.config.root_midi;
    var self = this;
    this._bassNodes = [];
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
      self._bassNodes.push(osc, lfo);
    });
  };

  // 大罄：一击深沉寺磬（低八度 + 非谐泛音列，余韵可达 30 分钟）
  MusicEngine.prototype._bigChime = function (when) {
    var ctx = this.ctx, self = this;
    var base = midiToFreq(this.config.root_midi - 12);
    // [倍频, 相对音量, 衰减秒数]
    [[1, 1.0, 1800], [2.01, 0.45, 1350], [2.74, 0.30, 1080], [3.76, 0.18, 810], [5.43, 0.10, 630]].forEach(function (pr) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = base * pr[0];
      var g = ctx.createGain();
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(0.085 * pr[1], when + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, when + pr[2]);
      osc.connect(g);
      g.connect(self.layers.L0);
      osc.start(when);
      osc.stop(when + pr[2] + 0.5);
      self._bassNodes.push(osc); // 跟踪：切换风格时停掉，不留 30 分钟余音鬼影
    });
  };

  // 大罄：低音声部一直开，每 31 分钟敲一下
  MusicEngine.prototype._startBigChime = function () {
    var self = this;
    this._bassTimers = [];
    var INTERVAL = 31 * 60 * 1000;
    function tick() {
      if (!self.playing) return;
      self._bigChime(self.ctx.currentTime + 0.05);
      self._bassTimers.push(setTimeout(tick, INTERVAL));
    }
    // 开场先敲一声，确立低音
    this._bigChime(this.ctx.currentTime + 0.1);
    this._bassTimers.push(setTimeout(tick, INTERVAL));
  };

  // 背景音三选一：静 / 弦（持续低音） / 罄（大罄）
  MusicEngine.prototype.setBgMode = function (mode) {
    if (mode !== 'strings' && mode !== 'chime') mode = 'silent';
    try { localStorage.setItem('sutra_bgmode', mode); } catch (e) {}
    if (mode === 'silent') { this.stop(); return; }
    this.setBassStyle(mode === 'chime' ? 'bigchime' : 'drone');
    if (!this.playing) this.start();
  };
  MusicEngine.prototype.getSavedBgMode = function () {
    try {
      var m = localStorage.getItem('sutra_bgmode');
      if (m === 'silent' || m === 'strings' || m === 'chime') return m;
    } catch (e) {}
    return 'strings'; // 默认：开（弦）
  };
  MusicEngine.prototype.getBgMode = function () {
    if (!this.playing) return this.getSavedBgMode();
    return this._bassStyle === 'bigchime' ? 'chime' : 'strings';
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
      // 高音只在停笔足够久（条件成立）且非疾书时触发
      if (self._chimeArmed) {
        var t = self.ctx.currentTime + 0.05;
        self._lightChime(t);
        if (Math.random() < 0.2) self._lightChime(t + 2.5 + Math.random() * 3); // 偶尔应和一声
      }
      self.timers.push(setTimeout(tick, 12000 + Math.random() * 18000));
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
      self.timers.push(setTimeout(tick, 40000 + Math.random() * 60000));
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

  // L4：gamma 脑波层（40Hz 纯正弦，极低音量，全程铺底）
  MusicEngine.prototype._startGamma = function () {
    var ctx = this.ctx;
    var cfg = this.config.gamma || {};
    if (cfg.off) return;
    var freq = cfg.hz || 40;
    var vol = (cfg.vol !== undefined && cfg.vol !== null) ? cfg.vol : 0.015;
    if (!(vol > 0)) return;
    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    var g = ctx.createGain();
    g.gain.value = vol;
    osc.connect(g);
    g.connect(this.layers.L4);
    osc.start();
    // 缓慢浮现，不打扰入静；尊重用户的 40Hz 开关
    this.layers.L4.gain.setTargetAtTime(this._gammaOn ? 1 : 0, ctx.currentTime, 4);
  };

  // 40Hz 铺底开关（用户可选）
  MusicEngine.prototype.setGammaOn = function (on) {
    this._gammaOn = !!on;
    try { localStorage.setItem('sutra_gamma40', this._gammaOn ? '1' : '0'); } catch (e) {}
    this._applyGates();
  };
  MusicEngine.prototype.getGammaOn = function () { return this._gammaOn !== false; };

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
    this._startBass();
    this._startGamma();
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

  // 综合门控：进度 × 书写状态，每 0.7s 平滑跟随一次
  MusicEngine.prototype._applyGates = function () {
    if (!this.ctx || !this.playing) return;
    this._activity += (this._activityTarget - this._activity) * 0.3;
    if (Math.abs(this._activityTarget - this._activity) < 0.01) this._activity = this._activityTarget;
    this._nature = 1 - this._activity;
    var pg = this._progGates || [1, 1, 0, 1, 1];
    var t = this.ctx.currentTime;
    this.layers.L0.gain.setTargetAtTime(1, t, 2.5);
    this.layers.L1.gain.setTargetAtTime(pg[1] * this._nature, t, 2.5);
    this.layers.L2.gain.setTargetAtTime(pg[2] * (1 - 0.7 * this._activity), t, 2.5);
    this.layers.L3.gain.setTargetAtTime(pg[3] * this._nature, t, 2.5);
    this.layers.L4.gain.setTargetAtTime(this._gammaOn ? 1 : 0, t, 2.5);
    // 高音实际可触发 = 条件成立且非疾书；泉消/细雨按各自条件淡入淡出（疾书时 L3 总线已静音）
    this._chimeArmed = this._wantChime && this._nature > 0.45;
    if (this._springGain) this._springGain.gain.setTargetAtTime(0.016 * (this._wantSpring ? 1 : 0), t, 2.5);
    if (this._springLfoDepth) this._springLfoDepth.gain.setTargetAtTime(0.008 * (this._wantSpring ? 1 : 0), t, 2.5);
    if (this._rainGain) this._rainGain.gain.setTargetAtTime(0.010 * (this._wantRain ? 1 : 0), t, 2.5);
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
