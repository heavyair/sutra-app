/* 抄经应用 · 主流程（无构建、原生 JS）
 *
 * 流程：推荐码 → 注册/登录（手机或邮箱）→ 经文库 → 选字体 → 开场（经名2秒 → 段落慢读高亮）→
 *       全屏单字临摹（虚影字）→ 自动检测写成 → 缓缓隐藏 → 下一字 →
 *       一段写完 → 下一段同样先显示经文（无音乐）再书写 → 全部写完 → 欣赏 / PDF / 分享
 * 工具（左下角 ☰）：经文 · 字体 · 背景音 · 欣赏 · 分享（点开散布全屏）
 */
(function () {
  'use strict';

  var FONTS = [
    { id: 'kaiti', name: '楷书', desc: '端正楷则 · 默认',
      stack: '"LXGW WenKai","Kaiti SC","STKaiti","KaiTi","楷体",serif',
      web: '100px "LXGW WenKai"' },
    { id: 'song', name: '宋体', desc: '横平竖直 · 清晰',
      stack: '"Noto Serif SC","Songti SC","STSong","SimSun",serif',
      web: '100px "Noto Serif SC"' },
    { id: 'xingshu', name: '行书', desc: '笔意连绵 · 毛笔韵味',
      stack: '"Ma Shan Zheng","Kaiti SC","STKaiti",cursive',
      web: '100px "Ma Shan Zheng"' },
  ];

  var PENS = [
    { id: 'maobi', name: '毛笔', desc: '浓墨毛丝 · 随速飞白' },
  ];

  var DONE_COVERAGE = 0.22;   // 覆盖虚影字多少判为写成
  var HINT_COVERAGE = 0.10;   // 出现"写好了"提示的阈值

  var state = {
    sutra: null,
    chars: [],         // 当前段落的字（书写用）；作品查看器里为全文
    charIndex: 0,      // 段落内字序号；全局序号 = paraStart + charIndex
    paras: [],         // 全文按标点切成的段落
    paraIndex: 0,      // 当前段落序号
    paraStart: 0,      // 当前段落起始的全局字序号
    totalChars: 0,     // 全文总字数
    filter: 'all',
    font: FONTS[0],
    pen: PENS[0],
    musicOn: false,
    workImages: [],
    flowToken: 0,
    completing: false,
    paraEndFading: false, // 段末标点淡出中：等它淡完才算段落结束，期间忽略落笔/橡皮
    work: null,        // 当前作品（服务端）：{id, anon_key, ...}
    workData: null,    // 作品查看器数据：{work, chars}
    workShare: '',     // 查看器打开时的 share token（分享链接直达）
    audioBlobUrl: null, // 查看器音频 blob URL（带鉴权取回的录音）
    pauses: [],        // 笔画间停顿时长（ms），用于学习书写节奏
    pendingTimer: 0,   // 完成判定的延迟计时器
    lastStrokeEnd: 0,  // 上一笔抬起的时间戳
    pace: 'slow',      // 书写节奏：'fast' 疾书 / 'slow' 缓慢（初始视为静）
    paceHist: [],      // 最近 3 个字的单字周期（书写时长+字前等待），用于判断加速/减速
    charT0: 0,         // 当前字第一笔落笔时间
    charGap: 0,        // 当前字开始前等待了多久（上一字结束→本字第一笔）
    lastCharEnd: 0,    // 上一字完成的时间戳
    pacePushedFor: -1, // 已计入 paceHist 的字序号（防"继续改写"重复计入）
    usualCharMs: 2500, // 用户通常的换字时间：加权统计，初值 2.5s（本机学习，跨会话保留）
    writeHist: [],     // 最近 3 个字的书写时长，用于慢写判断
    slowStreak: 0,     // 连续明显慢写字数（本字超过前两字各 20%）
    lastSpringAt: -99, // 上次泉消提醒的字序号（脉冲式提醒）
    lastRainAt: -99,   // 上次细雨提醒的字序号
    springPulse: false, // 泉消提醒脉冲进行中
    rainPulse: false,   // 细雨提醒脉冲进行中
  };

  var music = new MusicEngine();
  var pad = null;

  function $(id) { return document.getElementById(id); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 读入历史书写节奏（本机学习）
  try {
    var _p = JSON.parse(localStorage.getItem('sutra_pauses') || '[]');
    if (Array.isArray(_p)) state.pauses = _p.filter(function (x) { return x > 0; }).slice(-60);
    var _u = parseFloat(localStorage.getItem('sutra_usual_char') || '0');
    if (_u >= 800 && _u <= 8000) state.usualCharMs = _u;
  } catch (e) {}

  function saveUsualCharMs() {
    try { localStorage.setItem('sutra_usual_char', String(Math.round(state.usualCharMs))); } catch (e) {}
  }

  function recordPause(ms) {
    state.pauses.push(ms);
    if (state.pauses.length > 60) state.pauses.shift();
    try { localStorage.setItem('sutra_pauses', JSON.stringify(state.pauses)); } catch (e) {}
  }

  // 自适应等待：停顿中位数×2+300ms， clamp 到 0.9~2.8 秒；样本不足时默认 1.6 秒
  function learnedDelay() {
    var p = state.pauses;
    if (p.length < 3) return 1600;
    var s = p.slice().sort(function (a, b) { return a - b; });
    var med = s[Math.floor(s.length / 2)];
    return Math.min(2800, Math.max(900, Math.round(med * 2 + 300)));
  }

  // 书写节奏：看最近 3 个字的单字周期（书写时长 + 字前等待）
  // 连续变短 → 加速 → fast；连续变长 → 减速 → slow；否则保持（天然迟滞）
  function pushPaceSample() {
    if (state.pacePushedFor === state.charIndex) return;
    state.pacePushedFor = state.charIndex;
    var now = Date.now();
    var writeMs = state.charT0 ? Math.max(300, now - state.charT0) : 2000;
    var gapMs = Math.max(0, state.charGap || 0);
    // 用户通常的换字时间：加权统计（新样本权重 0.35，初值 2.5s）；
    // 长停笔按 3 倍 usual 封顶计入，不污染"通常"统计
    var gapStat = Math.min(gapMs, 3 * state.usualCharMs);
    state.usualCharMs = 0.35 * (writeMs + gapStat) + 0.65 * state.usualCharMs;
    if (state.usualCharMs < 800) state.usualCharMs = 800;
    if (state.usualCharMs > 8000) state.usualCharMs = 8000;
    saveUsualCharMs();
    // 慢写：本字书写时长超过前两个字
    var wh = state.writeHist;
    wh.push(writeMs);
    if (wh.length > 3) wh.shift();
    var n = wh.length;
    // 明显慢：本字书写超过前两字各 20%（过滤正常波动，不是稍慢就响）
    var slowChar = n >= 3 && writeMs > wh[n - 2] * 1.2 && writeMs > wh[n - 3] * 1.2;
    state.slowStreak = slowChar ? state.slowStreak + 1 : 0;
    // 脉冲式提醒（稍稍提醒，非持续）：
    // 泉消：连续 2 字明显慢 → 轻响约 3 个字后退下，6 字内不再打扰
    // 细雨：连续 4 字明显慢 → 加入，10 字内不再打扰
    if (state.slowStreak >= 2 && state.charIndex - state.lastSpringAt >= 6) state.lastSpringAt = state.charIndex;
    if (state.slowStreak >= 4 && state.charIndex - state.lastRainAt >= 10) state.lastRainAt = state.charIndex;
    state.springPulse = state.charIndex - state.lastSpringAt <= 2;
    state.rainPulse = state.charIndex - state.lastRainAt <= 2;
    var h = state.paceHist;
    h.push(writeMs + gapMs);
    if (h.length > 3) h.shift();
    if (h.length >= 3) {
      var a = h[0], b = h[1], c = h[2], e = 0.06; // 6% 容差，防抖动误判
      if (c < b * (1 - e) && b < a * (1 - e)) setPace('fast');
      else if (c > b * (1 + e) && b > a * (1 + e)) setPace('slow');
    }
    evaluateNature();
  }

  function setPace(p) {
    if (state.pace === p) return;
    state.pace = p;
    try { music.setActivity(p === 'fast' ? 1 : 0); } catch (err) {}
  }

  // 自然声出现条件评估（每 2s + 每字完成后）：
  // 停笔超过用户通常 5 个字的换字时间 → 高音（轻磬/小磬）；
  // 慢写（本字超过前两个字）→ 泉消；连续慢写 4 字 → 细雨
  function evaluateNature() {
    try {
      if (!music.setNatureFlags) return;
      var now = Date.now(), gapMs = 0;
      if (state.lastStrokeEnd) gapMs = now - state.lastStrokeEnd;            // 字内：笔间停顿
      else if (state.lastCharEnd && !state.charT0) gapMs = now - state.lastCharEnd; // 字间：写完等待落笔
      var flags = {
        chime: gapMs > 5 * state.usualCharMs,
        spring: !!state.springPulse, // 泉消：脉冲式提醒
        rain: !!state.rainPulse       // 细雨：脉冲式提醒
      };
      music.setNatureFlags(flags);
      if (flags.chime) setPace('slow'); // 长停笔直接视为慢，不等下一字写完
    } catch (e) {}
  }

  setInterval(function () {
    try {
      if (!$('screen-write').classList.contains('active')) return;
      if (state.completing) return;
      evaluateNature();
    } catch (e) {}
  }, 2000);

  function cancelPendingComplete() {
    if (state.pendingTimer) { clearTimeout(state.pendingTimer); state.pendingTimer = 0; }
  }

  // 中日韩及常用 ASCII 标点：抄经时直接跳过，不用手写
  var PUNCT_RE = /[　-〿！-／：-＠［-｀｛-･\u2000-\u206F\u2E00-\u2E7F.,;:?!'"()\[\]{}…—–·•‹›«»\-/]/;
  function isPunct(ch) { return PUNCT_RE.test(ch); }

  // 手指离开后不立刻判完成：等一等，若用户继续落笔则取消
  function scheduleComplete() {
    cancelPendingComplete();
    var token = state.flowToken;
    var delay = learnedDelay();
    state.pendingTimer = setTimeout(function () {
      state.pendingTimer = 0;
      if (token !== state.flowToken || state.completing) return;
      if (pad && pad.coverage() >= DONE_COVERAGE) charComplete(); // 重新核对（防中途橡皮擦除）
    }, delay);
  }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(function (s) {
      s.classList.toggle('active', s.id === id);
    });
    window.scrollTo(0, 0);
    if (id === 'screen-library') refreshLibraryWorks();
    if (id === 'screen-write' && $('write-ui')) $('write-ui').style.display = '';
    setScreenTools(toolsFor(id)); // 各屏功能按钮收拢进全局工具按钮
  }

  /* ---------- 全局工具按钮：各屏功能按钮不用时缩进 ☰ ---------- */
  function closeGlobalTools() {
    var m = $('global-menu');
    if (!m || m.classList.contains('hidden')) return;
    m.classList.remove('open');
    setTimeout(function () { m.classList.add('hidden'); }, 320);
  }
  function setScreenTools(items) {
    var m = $('global-menu'), fab = $('global-tools');
    if (!m || !fab) return;
    m.classList.remove('open');
    m.classList.add('hidden');
    m.innerHTML = '';
    (items || []).forEach(function (it) {
      var b = document.createElement('button');
      b.className = 'tool-item';
      b.textContent = it.label;
      b.addEventListener('click', function () { closeGlobalTools(); it.onClick(); });
      m.appendChild(b);
    });
    fab.style.display = (items && items.length) ? '' : 'none';
  }
  // 各屏的功能按钮清单（书写屏用自己的工具菜单，不走全局；顶栏已全部移除）
  function toolsFor(id) {
    if (id === 'screen-library') {
      return getToken() ? [] : [{ label: '登录', onClick: gotoLogin }];
    }
    if (id === 'screen-work') {
      return workScreenTools();
    }
    if (id === 'screen-char') {
      return []; // 单字屏用自己的悬浮按钮（☰/🧽/▶），不走全局
    }
    if (id === 'screen-dedications') {
      return [{ label: '经文库', onClick: function () { showScreen('screen-library'); } }];
    }
    return [];
  }
  // 逐字/整纸切换收进工具菜单：按钮文字显示将要切换到的视图
  function viewToggleItem(dual, screenId) {
    if (!dual || typeof dual.switch !== 'function') return null;
    return {
      label: dual.view === 'char' ? '整纸' : '逐字',
      onClick: function () {
        dual.switch(dual.view === 'char' ? 'sheet' : 'char');
        setScreenTools(toolsFor(screenId)); // 刷新菜单文字
      }
    };
  }
  function backToLibrary() {
    $('done-overlay').classList.add('hidden');
    state.flowToken++;
    if (state.musicOn) { music.stop(); state.musicOn = false; }
    try { music.stopRecording(); } catch (e) {}
    showScreen('screen-library');
  }
  $('global-tools').addEventListener('click', function (e) {
    e.stopPropagation();
    var m = $('global-menu');
    if (m.classList.contains('hidden')) {
      m.classList.remove('hidden');
      requestAnimationFrame(function () { m.classList.add('open'); });
    } else {
      closeGlobalTools();
    }
  });
  // 点菜单外任意处收起
  document.addEventListener('pointerdown', function (e) {
    var m = $('global-menu');
    if (!m || m.classList.contains('hidden')) return;
    if (m.contains(e.target)) return;
    if (e.target && (e.target.id === 'global-tools' || e.target.closest('#global-tools'))) return;
    closeGlobalTools();
  }, true);

  function getToken() {
    try { return localStorage.getItem('sutra_token'); } catch (e) { return null; }
  }

  function getAnonKey() {
    try { return localStorage.getItem('sutra_anon_key') || ''; } catch (e) { return ''; }
  }
  function saveAnonKey(k) {
    if (!k) return;
    try { localStorage.setItem('sutra_anon_key', k); } catch (e) {}
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    var token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    var ak = getAnonKey();
    if (ak) headers['X-Anon-Key'] = ak;
    return fetch(path, Object.assign({ headers: headers }, opts)).then(function (r) {
      return r.json().then(function (body) {
        if (r.status === 401 && body && body.need_auth && !opts.noAuthRedirect) {
          try { localStorage.removeItem('sutra_token'); } catch (e) {}
          enterAuth('login', '登录已过期，请重新登录');
          body.authExpired = true;
        }
        return body;
      });
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------- 1. 推荐码 ---------- */
  $('btn-verify').addEventListener('click', function () {
    var code = $('invite-code').value.trim();
    var msg = $('invite-msg');
    msg.textContent = '验证中…';
    api('/api/invite/verify', {
      method: 'POST',
      body: JSON.stringify({ code: code }),
    }).then(function (res) {
      if (res.ok) {
        try { localStorage.setItem('sutra_invite', code); } catch (e) {}
        enterAuth('register');
      } else {
        msg.textContent = res.message || '验证失败';
      }
    }).catch(function () {
      msg.textContent = '网络错误，请重试';
    });
  });

  /* ---------- 2. 注册 / 登录 ---------- */
  var authMode = 'register';   // register | login
  var authType = 'phone';      // phone | email

  function refreshAuthUI() {
    $('auth-title').textContent = authMode === 'register' ? '注册' : '登录';
    $('auth-sub').textContent = authMode === 'register'
      ? '推荐码验证通过，请注册账号'
      : '欢迎回来，请登录';
    $('btn-auth-submit').textContent = authMode === 'register' ? '注册' : '登录';
    $('chip-mode-register').classList.toggle('active', authMode === 'register');
    $('chip-mode-login').classList.toggle('active', authMode === 'login');
    $('chip-type-phone').classList.toggle('active', authType === 'phone');
    $('chip-type-email').classList.toggle('active', authType === 'email');
    var acc = $('auth-account');
    acc.placeholder = authType === 'phone' ? '手机号' : '邮箱';
    acc.inputMode = authType === 'phone' ? 'tel' : 'email';
    $('auth-code-row').style.display = authMode === 'register' ? 'flex' : 'none';
    $('auth-msg').textContent = '';
    $('auth-msg').style.color = '';
  }

  function enterAuth(mode, notice) {
    authMode = mode || 'register';
    refreshAuthUI();
    if (notice) $('auth-msg').textContent = notice;
    showScreen('screen-auth');
  }

  $('chip-mode-register').addEventListener('click', function () { authMode = 'register'; refreshAuthUI(); });
  $('chip-mode-login').addEventListener('click', function () { authMode = 'login'; refreshAuthUI(); });
  $('chip-type-phone').addEventListener('click', function () { authType = 'phone'; refreshAuthUI(); });
  $('chip-type-email').addEventListener('click', function () { authType = 'email'; refreshAuthUI(); });

  var codeTimer = null;
  $('btn-auth-send-code').addEventListener('click', function () {
    var btn = $('btn-auth-send-code');
    if (btn.disabled) return;
    var account = $('auth-account').value.trim();
    var msg = $('auth-msg');
    msg.style.color = '';
    if (!account) { msg.textContent = authType === 'phone' ? '请先输入手机号' : '请先输入邮箱'; return; }
    msg.textContent = '发送中…';
    api('/api/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ account_type: authType, account: account }),
      noAuthRedirect: true,
    }).then(function (res) {
      if (res.ok) {
        msg.style.color = 'var(--green, #2e7d32)';
        msg.textContent = authType === 'phone' ? '短信验证码已发送' : '邮件验证码已发送，请查收';
        var left = 60;
        btn.disabled = true;
        btn.textContent = left + ' 秒后重发';
        if (codeTimer) clearInterval(codeTimer);
        codeTimer = setInterval(function () {
          left -= 1;
          if (left <= 0) {
            clearInterval(codeTimer);
            btn.disabled = false;
            btn.textContent = '发送验证码';
          } else {
            btn.textContent = left + ' 秒后重发';
          }
        }, 1000);
      } else {
        msg.textContent = res.message || '发送失败';
      }
    }).catch(function () { msg.textContent = '网络错误，请重试'; });
  });

  $('btn-auth-submit').addEventListener('click', function () {
    var account = $('auth-account').value.trim();
    var password = $('auth-password').value;
    var msg = $('auth-msg');
    msg.style.color = '';
    if (!account) { msg.textContent = authType === 'phone' ? '请输入手机号' : '请输入邮箱'; return; }
    if (password.length < 6) { msg.textContent = '密码至少 6 位'; return; }
    var code = '';
    if (authMode === 'register') {
      code = $('auth-code').value.trim();
      if (!/^\d{6}$/.test(code)) { msg.textContent = '请输入 6 位验证码'; return; }
    }
    msg.textContent = authMode === 'register' ? '注册中…' : '登录中…';
    var path = authMode === 'register' ? '/api/register' : '/api/login';
    var body = { account: account, password: password };
    if (authMode === 'register') {
      body.account_type = authType;
      body.code = code;
      try { body.invite_code = localStorage.getItem('sutra_invite') || ''; } catch (e) {}
    }
    api(path, { method: 'POST', body: JSON.stringify(body), noAuthRedirect: true })
      .then(function (res) {
        if (res.ok && res.token) {
          try { localStorage.setItem('sutra_token', res.token); } catch (e) {}
          $('auth-password').value = '';
          $('auth-code').value = '';
          loadLibrary();
          refreshLoginBtn();
          showScreen('screen-library');
        } else {
          msg.textContent = res.message || '失败，请重试';
        }
      })
      .catch(function () { msg.textContent = '网络错误，请重试'; });
  });

  $('btn-auth-reinvite').addEventListener('click', function () {
    try { localStorage.removeItem('sutra_invite'); } catch (e) {}
    $('invite-code').value = '';
    $('invite-msg').textContent = '';
    showScreen('screen-invite');
  });

  /* 登录入口：未登录时收进经文库的工具按钮 */
  function gotoLogin() {
    if (getToken()) return;   // 已登录，不再跳转
    var code = null;
    try { code = localStorage.getItem('sutra_invite'); } catch (e) {}
    if (code) { enterAuth('login'); } else { showScreen('screen-invite'); }
  }
  function refreshLoginBtn() {
    // 登录态变化时刷新经文库的工具菜单（顶栏已移除）
    if ($('screen-library').classList.contains('active')) setScreenTools(toolsFor('screen-library'));
  }

  /* 启动：无需注册/登录，直接进入经文库；有 token 则静默校验登录态 */
  (function boot() {
    loadLibrary();
    showScreen('screen-library');
    refreshLoginBtn();
    var token = getToken();
    if (token) {
      api('/api/me', { noAuthRedirect: true }).then(function (res) {
        if (!res || !res.ok) {
          try { localStorage.removeItem('sutra_token'); } catch (e) {}
          refreshLoginBtn();
        }
      }).catch(function () {});
    }
  })();

  /* ---------- 3. 经文库 ---------- */
  function loadLibrary() {
    api('/api/sutras').then(function (res) {
      if (!res.ok) return;
      renderLibrary(res.sutras);
    });
  }

  function renderLibrary(sutras) {
    var list = $('sutra-list');
    list.innerHTML = '';
    sutras
      .filter(function (s) { return state.filter === 'all' || s.tradition === state.filter; })
      .forEach(function (s) {
        var li = document.createElement('li');
        var trad = s.tradition === 'buddhist' ? '佛经' : '道经';
        var todo = s.char_count === 0 ? '<span class="badge-todo">待补充全文</span>' : '';
        li.innerHTML =
          '<div class="sutra-title">' + escapeHtml(s.title) + todo + '</div>' +
          '<div class="sutra-meta">' + trad + ' · ' + s.char_count + '字 · ♥ ' + s.like_count + '</div>' +
          '<div class="sutra-intro">' + escapeHtml(s.intro || '') + '</div>';
        var dc = s.dedication_count || 0;
        if (dc > 0) {
          var db = document.createElement('button');
          db.className = 'ded-count';
          db.textContent = '🪷 回向 ' + dc;
          db.addEventListener('click', function (e) {
            e.stopPropagation();
            openDedicationWall(s.id, s.title);
          });
          li.appendChild(db);
        }
        li.addEventListener('click', function () {
          if (li.dataset.busy) return;           // 防重复点击
          li.dataset.busy = '1';
          var meta = li.querySelector('.sutra-meta');
          var oldMeta = meta.textContent;
          meta.textContent = '加载中…';
          openSutra(s.id, function () {
            delete li.dataset.busy;
            meta.textContent = oldMeta;
          });
        });
        list.appendChild(li);
      });
  }

  document.querySelectorAll('#screen-library .chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      document.querySelectorAll('#screen-library .chip').forEach(function (c) { c.classList.remove('active'); });
      chip.classList.add('active');
      state.filter = chip.dataset.trad;
      loadLibrary();
    });
  });

  /* ---------- 3b. 回向记录 ---------- */
  var DED_KIND_NAMES = { huixiangji: '回向偈', puxian: '普贤回向', pingdeng: '平等回向', xiaozai: '消灾祈福' };

  function openDedicationWall(sutraId, sutraTitle) {
    state.dedWallSutra = sutraId;
    $('ded-wall-title').textContent = '🪷 ' + sutraTitle + ' · 回向记录';
    $('ded-wall').innerHTML = '<div class="picker-hint">加载中…</div>';
    showScreen('screen-dedications');
    api('/api/sutra/' + sutraId + '/dedications').then(function (res) {
      if (!res.ok) { $('ded-wall').innerHTML = '<div class="picker-hint">加载失败</div>'; return; }
      renderDedicationWall(res.dedications || []);
    });
  }

  function renderDedicationWall(list) {
    var wall = $('ded-wall');
    wall.innerHTML = '';
    if (!list.length) {
      wall.innerHTML = '<div class="picker-hint">尚无回向记录</div>';
      return;
    }
    var note = document.createElement('div');
    note.className = 'picker-hint';
    note.textContent = '共 ' + list.length + ' 次回向 · 每条记录有人看即续存 7 天';
    wall.appendChild(note);
    list.forEach(function (d) {
      var card = document.createElement('div');
      card.className = 'ded-card';
      var text = document.createElement('div');
      text.className = 'ded-text';
      text.textContent = d.dedication_text || '';
      card.appendChild(text);
      // 尘埃：灰烬格子条
      var cells = d.ash_cells || [];
      var strip = document.createElement('div');
      strip.className = 'ded-ash';
      var show = cells.slice(0, 40);
      show.forEach(function () {
        var c = document.createElement('div');
        c.className = 'ded-ashcell';
        strip.appendChild(c);
      });
      if (cells.length > show.length) {
        var more = document.createElement('div');
        more.className = 'ded-ashmore';
        more.textContent = '+' + (cells.length - show.length);
        strip.appendChild(more);
      }
      card.appendChild(strip);
      var foot = document.createElement('div');
      foot.className = 'ded-foot';
      var who = (d.dedicator_name || '').trim() ? '🖊 ' + d.dedicator_name : '匿名';
      var when = (d.dedicated_at || '').slice(0, 10);
      var kind = DED_KIND_NAMES[d.dedication_kind] || '';
      foot.textContent = who + (kind ? ' · ' + kind : '') + (when ? ' · ' + when : '');
      card.appendChild(foot);
      wall.appendChild(card);
    });
  }

  /* ---------- 4. 点经文：写过/写完的直达欣赏，没写过的直达抄写 ---------- */
  function openSutra(id, done) {
    var proceed = function () {
      var mine = (state.myWorks || []).filter(function (w) { return w.sutra_id === id; });
      if (mine.length) { if (done) done(); openWork(mine[0].id); return; }
      // 新经：手势链内先解锁音频，再拉经文，直达抄写界面
      try { if (!state.musicOn) { music.start(); state.musicOn = true; } } catch (e) {}
      api('/api/sutra/' + encodeURIComponent(id)).then(function (res) {
        if (done) done();
        if (!res.ok) { stopPreMusic(); alert(res.message || '加载失败，请重试'); return; }
        var clean = (res.sutra.full_text || '').replace(/\s+/g, '');
        state.fullChars = clean.split(''); // 全文（欣赏页用；书写时 state.chars 为段内）
        if (!clean.length) {
          stopPreMusic();
          alert('《' + res.sutra.title + '》全文待补充，敬请期待');
          return;
        }
        state.sutra = res.sutra;
        state.paras = splitParagraphs(clean);
        state.totalChars = clean.length;
        setPara(0);
        state.workImages = [];
        state.sessionStartPos = 0; // 新开：本会话快照从全文 0 开始
        state.completing = false;
        state.work = null;      // 新开一部作品（懒创建）
        state.workData = null;
        state.workCharsByPos = {}; // 新开：清空旧字迹表（欣赏页从头只显示本部）
        state.flowToken++;
        music.setConfig(res.sutra.music_config || {});
        startWriting(state.flowToken); // 直达抄写（字体可在书写屏 ☰ → 字体 中换）
      }).catch(function () {
        if (done) done();
        stopPreMusic();
        alert('网络错误，请重试');
      });
    };
    if (state.myWorksLoaded) { proceed(); return; }
    // 我的作品还没拉到：先拉再分流（点经文时已显示"加载中…"）
    api('/api/my/works').then(function (res) {
      state.myWorks = (res && res.ok && res.works) || [];
      state.myWorksLoaded = true;
      proceed();
    }).catch(function () { state.myWorksLoaded = true; proceed(); });
  }
  function stopPreMusic() {
    try { music.stop(); } catch (e) {}
    state.musicOn = false;
  }

  function renderFontCards(container, selectedId, onPick) {
    container.innerHTML = '';
    FONTS.forEach(function (f) {
      var b = document.createElement('button');
      b.className = 'pick-card' + (f.id === selectedId ? ' selected' : '');
      b.innerHTML =
        '<span class="preview" style="font-family:' + f.stack + '">永</span>' +
        '<span><span class="pick-name">' + f.name + '</span>' +
        '<span class="pick-desc" style="display:block">' + f.desc + '</span></span>';
      b.addEventListener('click', function () {
        container.querySelectorAll('.pick-card').forEach(function (x) { x.classList.remove('selected'); });
        b.classList.add('selected');
        // 预加载 webfont，让虚影字一次成型
        try { document.fonts.load(f.web, '永'); } catch (e) {}
        onPick(f);
      });
      container.appendChild(b);
    });
  }

  /* ---------- 5. 开场：经名 2 秒 → 段落慢读高亮（无音乐）→ 书写 ---------- */
  // 全文按标点切成段落：遇到 。！？ 必断；；， 视长度断；超 40 字硬断
  function splitParagraphs(text) {
    var t = (text || '').replace(/\s+/g, '');
    var parts = t.split(/([。！？；，])/);
    var paras = [], cur = '';
    for (var i = 0; i < parts.length; i += 2) {
      var seg = parts[i] + (parts[i + 1] || '');
      if (!seg) continue;
      cur += seg;
      var d = parts[i + 1] || '';
      if (/[。！？]/.test(d) || (/[；，]/.test(d) && cur.length >= 28) || cur.length >= 44) {
        paras.push(cur);
        cur = '';
      }
    }
    if (cur) paras.push(cur);
    return paras.length ? paras : [t];
  }

  function setPara(pi) {
    state.paraIndex = pi;
    var off = 0;
    for (var i = 0; i < pi; i++) off += state.paras[i].length;
    state.paraStart = off;
    state.chars = state.paras[pi].split('');
    state.charIndex = 0;
  }

  // 续写：按全局字序号定位到段落
  function setParaForGlobalPos(pos) {
    var off = 0;
    for (var i = 0; i < state.paras.length; i++) {
      var len = state.paras[i].length;
      if (pos < off + len) {
        state.paraIndex = i;
        state.paraStart = off;
        state.chars = state.paras[i].split('');
        state.charIndex = pos - off;
        return;
      }
      off += len;
    }
    var li = state.paras.length - 1;
    state.paraIndex = li;
    state.paraStart = off - state.paras[li].length;
    state.chars = state.paras[li].split('');
    state.charIndex = state.chars.length;
  }

  // 段落经文显示：逐字慢读高亮，显示期间没有音乐
  function showParaIntro(paraText, token, cb) {
    var overlay = $('intro-overlay');
    var titleEl = $('intro-title');
    var paraEl = $('intro-para');
    overlay.classList.remove('hidden', 'fading');
    titleEl.style.display = 'none';
    paraEl.style.display = '';
    paraEl.innerHTML = '';
    var spans = paraText.split('').map(function (ch) {
      var sp = document.createElement('span');
      sp.textContent = ch;
      paraEl.appendChild(sp);
      return sp;
    });
    (async function () {
      for (var i = 0; i < spans.length; i++) {
        if (token !== state.flowToken) return;
        spans[i].classList.add('lit');
        await sleep(550);                      // 慢读速
      }
      await sleep(600);
      if (token !== state.flowToken) return;
      overlay.classList.add('fading');
      await sleep(650);
      overlay.classList.add('hidden');
      if (cb) cb();
    })();
  }

  function startWriting(token) {
    state.sessionStartPos = 0; // 新开：本会话快照从全文 0 开始
    showScreen('screen-write');
    closeTools();
    hideOverlays();
    ensurePad();
    // 新开书写：节奏复位为慢（自然声开着，入静氛围）
    resetParaRhythm();
    pad.setFont(state.font.stack);
    pad.setPen(state.pen.id);
    // 开乐（用户手势链中，可直接启动 AudioContext）；显示经文时静音
    if (!state.musicOn) { music.start(); state.musicOn = true; }
    try { music.setAudible(false); } catch (e) {}

    var overlay = $('intro-overlay');
    var titleEl = $('intro-title');
    var paraEl = $('intro-para');
    overlay.classList.remove('hidden', 'fading');
    titleEl.style.display = '';
    paraEl.style.display = 'none';

    titleEl.textContent = '《' + state.sutra.title + '》';

    (async function () {
      await sleep(2000);                       // 经名显示 2 秒
      if (token !== state.flowToken) return;
      overlay.classList.add('fading');
      await sleep(650);
      if (token !== state.flowToken) return;
      // 第一段经文显示（慢读高亮，无音乐）
      showParaIntro(state.paras[state.paraIndex], token, function () {
        beginWritePara(true);
      });
    })();
  }

  // 段落书写前的节奏复位：每段都从入静开始
  function resetParaRhythm() {
    state.pace = 'slow';
    state.paceHist = [];
    state.charT0 = 0;
    state.charGap = 0;
    state.lastCharEnd = 0;
    state.pacePushedFor = -1;
    state.writeHist = [];
    state.slowStreak = 0;
    state.lastSpringAt = -99;
    state.lastRainAt = -99;
    state.springPulse = false;
    state.rainPulse = false;
    try { music.setActivity(0); } catch (e) {}
    try { if (music.setNatureFlags) music.setNatureFlags({ chime: false, spring: false, rain: false }); } catch (e) {}
  }

  // 一段经文显示完 → 开始书写本段：音乐淡入；首段同时开始录制写字音乐
  function beginWritePara(first) {
    try { music.setAudible(true); } catch (e) {}
    if (first) { try { music.startRecording(); } catch (e) {} }
    beginChar();
  }

  // 一段写完 → 下一段同样先显示经文（无音乐），再书写
  function nextParagraph() {
    setPara(state.paraIndex + 1);
    resetParaRhythm();
    try { music.setAudible(false); } catch (e) {}  // 显示经文时没有音乐
    showParaIntro(state.paras[state.paraIndex], state.flowToken, function () {
      beginWritePara(false);
    });
  }

  /* ---------- 6. 笔：只保留毛笔（PENS 单一，无需选择器） ---------- */

  /* ---------- 作品（服务端逐字存储） ---------- */
  // 懒创建：写下第一个字时才建作品，避免空作品堆积
  function ensureWork(cb) {
    if (state.work && state.work.id) { if (cb) cb(); return; }
    api('/api/works', {
      method: 'POST',
      body: JSON.stringify({ sutra_id: state.sutra.id, font_id: state.font.id })
    }).then(function (res) {
      if (res && res.ok && res.work) {
        state.work = res.work;
        if (res.work.anon_key) saveAnonKey(res.work.anon_key);
      }
      if (cb) cb();
    }).catch(function () { if (cb) cb(); });
  }

  // 每个字写完即存：最小存储单位 = 一个字（含落笔记录，可回放）
  function saveCharToServer() {
    var doSave = function () {
      if (!state.work || !state.work.id) return;
      var rec = pad.getCharRecord();
      var strokes = (rec.strokes && rec.strokes.length)
        ? rec
        : { pen: rec.pen, auto: 'punct', strokes: [] };
      var pos = state.paraStart + state.charIndex;
      var ch = state.chars[state.charIndex];
      // 本地字迹表同步：欣赏页可从头展示全部已写字（含续写的新字）
      try {
        var byPos = state.workCharsByPos || (state.workCharsByPos = {});
        byPos[pos] = { pos: pos, ch: ch, pen: state.pen.id, strokes: strokes };
      } catch (e) {}
      api('/api/works/' + state.work.id + '/chars', {
        method: 'PUT',
        body: JSON.stringify({ pos: pos, ch: ch, pen: state.pen.id, strokes: strokes })
      }).catch(function () {});
    };
    if (state.work && state.work.id) doSave();
    else ensureWork(doSave);
  }

  /* ---------- 7. 全屏单字临摹 ---------- */
  function ensurePad() {
    if (pad) return;
    pad = new WritingPad($('paper-canvas'), $('ink-canvas'), {
      onStrokeStart: function () {
        // 落笔：取消待定的完成判定；记录与上一笔的停顿，学习书写节奏
        cancelPendingComplete();
        var now = Date.now();
        if (state.lastStrokeEnd) {
          var pause = now - state.lastStrokeEnd;
          if (pause > 60 && pause < 8000) recordPause(pause);
        }
        state.lastStrokeEnd = 0;
      },
      onStrokeEnd: function (cov, n) {
        if (state.completing || state.paraEndFading) return;
        state.lastStrokeEnd = Date.now();
        // 最小运笔：超过字区最大边的一半（防误触），单笔画字也能通过
        var minLen = pad.bbox ? Math.max(pad.bbox.w, pad.bbox.h) * 0.5 : 60;
        if (cov >= DONE_COVERAGE && pad.inkLength > minLen) {
          scheduleComplete(); // 抬笔后等一等再判，写得慢的人不会被提前收卷
        } else if (n >= 2 && cov >= HINT_COVERAGE) {
          $('btn-force-next').classList.remove('hidden');
        }
      },
      onFirstStroke: function () {
        // 本字第一笔：记录书写起点与字前等待（上一字结束→本字第一笔）
        var now = Date.now();
        state.charT0 = now;
        state.charGap = state.lastCharEnd ? now - state.lastCharEnd : 0;
      },
    });
    // 长按不弹出菜单
    $('screen-write').addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function beginChar() {
    state.completing = false;
    cancelPendingComplete();
    state.lastStrokeEnd = 0;
    state.charT0 = 0;
    state.charGap = 0;
    state.pacePushedFor = -1;
    $('btn-keep-editing').classList.add('hidden');
    $('btn-force-next').classList.add('hidden');
    var ch = state.chars[state.charIndex];
    // 确保 webfont 就绪后再画虚影字（带超时兜底，只执行一次）
    var called = false;
    var token = state.flowToken;
    var done = function () {
      if (called) return;
      called = true;
      var pc = $('paper-canvas');
      if (!isPunct(ch)) {
        // 新字显现：写得快 → 慢显（1s 淡入）；写得慢 → 快现（0.35s）
        var fadeMs = state.pace === 'fast' ? 1000 : 350;
        pc.style.transition = 'none';
        pc.style.opacity = '0';
        pad.newChar(ch);
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            pc.style.transition = 'opacity ' + fadeMs + 'ms ease';
            pc.style.opacity = '1';
          });
        });
      } else {
        pc.style.transition = 'none';
        pc.style.opacity = '1';
        pad.newChar(ch);
      }
      if (isPunct(ch)) {
        // 标点直接跳过：静默盖印收录，不展示，立即进下一字
        if (token !== state.flowToken || state.completing) return;
        punctAdvance();
      }
    };
    try {
      if (document.fonts && document.fonts.load) {
        document.fonts.load(state.font.web, ch).then(done, done);
        setTimeout(done, 1200);
        return;
      }
    } catch (e) {}
    done();
  }

  // 标点直接跳过：小字号静默盖印收录，不展示，立即进下一字
  function punctAdvance() {
    if (state.completing) return;
    cancelPendingComplete();
    pad.stampChar(state.chars[state.charIndex]);
    var img = pad.snapshot();
    if (img) state.workImages.push(img);
    updateProgress();
    saveCharToServer();
    state.lastCharEnd = Date.now(); // 标点不计入节奏样本，但更新等待起点
    state.charIndex++;
    if (state.charIndex >= state.chars.length) {
      // 段末标点：先盖印展示，等它淡出后才算段落结束
      var token = state.flowToken;
      state.paraEndFading = true;
      pad.fadeOut(1200, function () {
        state.paraEndFading = false;
        if (token !== state.flowToken) return;
        if (state.paraIndex < state.paras.length - 1) nextParagraph();
        else showDone();
      });
    } else {
      beginChar();
    }
  }

  function charComplete() {
    if (state.completing) return;
    cancelPendingComplete();
    state.completing = true;
    $('btn-force-next').classList.add('hidden');
    var img = pad.snapshot();
    state.workImages.push(img);
    updateProgress();
    saveCharToServer();
    pushPaceSample();              // 计入书写节奏（前字/本字/等待）
    state.lastCharEnd = Date.now();

    // 缓缓隐藏，同时给"继续改写"
    $('btn-keep-editing').classList.remove('hidden');
    pad.fadeOut(1700, function () {
      if (!state.completing) return; // 被"继续改写"中断
      $('btn-keep-editing').classList.add('hidden');
      state.charIndex++;
      if (state.charIndex >= state.chars.length) {
        // 本段写完：还有下一段 → 显示新段落经文；否则全篇完成
        if (state.paraIndex < state.paras.length - 1) nextParagraph();
        else showDone();
      } else {
        // 新字显现：写得快 → 慢显现；写得慢 → 快出现
        var token = state.flowToken;
        var delay = state.pace === 'fast' ? 900 : 200;
        setTimeout(function () {
          if (token !== state.flowToken || !state.completing) return;
          beginChar();
        }, delay);
      }
    });
  }

  $('btn-force-next').addEventListener('click', function () {
    cancelPendingComplete();
    charComplete();
  });

  $('btn-keep-editing').addEventListener('click', function () {
    cancelPendingComplete();
    state.completing = false;
    state.workImages.pop(); // 丢弃刚收录的成品
    pad.cancelFade();
    $('btn-keep-editing').classList.add('hidden');
    updateProgress();
  });

  // 橡皮：一下清空重写（若在"缓缓隐藏"中点橡皮，视同继续改写）
  $('btn-eraser').addEventListener('click', function () {
    if (!pad || state.paraEndFading) return; // 段末标点淡出中：不打断，等它自然结束段落
    cancelPendingComplete();
    if (state.completing) {
      state.completing = false;
      state.workImages.pop();
      updateProgress();
      // 刚存进服务端的字也删掉（全文序号），本地字迹表同步
      if (state.work && state.work.id) {
        var delPos = state.paraStart + state.charIndex;
        api('/api/works/' + state.work.id + '/chars/' + delPos, { method: 'DELETE' }).catch(function () {});
        try { delete (state.workCharsByPos || {})[delPos]; } catch (e) {}
      }
    }
    pad.cancelFade();
    pad.clearInk();
    $('btn-keep-editing').classList.add('hidden');
    $('btn-force-next').classList.add('hidden');
  });

  function updateProgress() {
    var p = state.totalChars ? state.workImages.length / state.totalChars : 0;
    music.setProgress(p); // 音乐随进度加层
  }

  /* ---------- 8. 工具菜单 ---------- */
  function closeTools() {
    $('tools-menu').classList.remove('open');
    setTimeout(function () { $('tools-menu').classList.add('hidden'); }, 320);
  }

  $('btn-tools').addEventListener('click', function (e) {
    e.stopPropagation();
    var m = $('tools-menu');
    if (m.classList.contains('hidden')) {
      m.classList.remove('hidden');
      requestAnimationFrame(function () { m.classList.add('open'); });
    } else {
      closeTools();
    }
  });

  document.querySelectorAll('.tool-item').forEach(function (b) {
    b.addEventListener('click', function () {
      var t = b.dataset.tool;
      closeTools();
      if (t === 'sutra') {
        state.flowToken++;
        if (state.musicOn) { music.stop(); state.musicOn = false; }
        try { music.stopRecording(); } catch (e) {}
        showScreen('screen-library');
      } else if (t === 'font') {
        renderFontCards($('font-cards-2'), state.font.id, function (f) {
          state.font = f;
          if (pad) pad.setFont(f.stack);
        });
        $('font-overlay').classList.remove('hidden');
      } else if (t === 'music') {
        var on = music.toggle();
        state.musicOn = on;
        b.classList.toggle('off', !on);
      } else if (t === 'view') {
        openWorkLocal();
      } else if (t === 'share') {
        shareWork();
      }
    });
  });

  // 点菜单外任意处收起
  $('screen-write').addEventListener('pointerdown', function (e) {
    var m = $('tools-menu');
    if (!m.classList.contains('hidden') && !e.target.classList.contains('tool-item')) {
      closeTools();
    }
  }, true);

  $('btn-font-done').addEventListener('click', function () {
    $('font-overlay').classList.add('hidden');
    if (pad && !state.completing) pad.newChar(state.chars[state.charIndex]); // 新字体重画虚影
  });

  function hideOverlays() {
    ['font-overlay', 'done-overlay'].forEach(function (id) {
      $(id).classList.add('hidden');
    });
    $('intro-overlay').classList.add('hidden');
  }

  /* ---------- 9. 全部写完 ---------- */
  function showDone() {
    var d = new Date();
    $('done-summary').textContent =
      '《' + state.sutra.title + '》 · 共 ' + state.totalChars + ' 字 · ' +
      d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
    $('done-overlay').classList.remove('hidden');
    $('done-main').classList.remove('hidden');
    $('done-cremated').classList.add('hidden');
    // 完成屏期间收起书写屏自己的工具按钮，功能走全局工具按钮
    if ($('write-ui')) $('write-ui').style.display = 'none';
    setScreenTools(doneTools());
    // 标记完成并渲染去向选择（陈列 / 焚化；注册用户多一个私藏）
    renderFarewell(null);
    if (state.work && state.work.id) {
      api('/api/works/' + state.work.id + '/complete', { method: 'POST' })
        .then(function (res) { if (res && res.ok) renderFarewell(res.work); })
        .catch(function () {});
    }
    // 写字时生成的音乐：录制收尾并随作品保存
    try {
      music.stopRecording(function (blob) {
        if (!blob || !blob.size || !state.work || !state.work.id) return;
        var fd = new FormData();
        fd.append('audio', blob, 'music.webm');
        var headers = {};
        var ak = getAnonKey();
        if (ak) headers['X-Anon-Key'] = ak;
        var t = getToken();
        if (t) headers['Authorization'] = 'Bearer ' + t;
        fetch('/api/works/' + state.work.id + '/audio', { method: 'POST', headers: headers, body: fd })
          .catch(function () {});
      });
    } catch (e) {}
  }

  // 完成屏的功能按钮收拢进全局工具按钮
  function doneTools() {
    return [
      { label: '欣赏', onClick: function () {
          $('done-overlay').classList.add('hidden');
          openWorkLocal();
        } },
      { label: 'PDF', onClick: printWork },
      { label: '分享', onClick: shareWork },
      { label: '经文库', onClick: backToLibrary }
    ];
  }

  /* ---------- 9b. 完成后去向：陈列 / 焚化 ---------- */
  var FAREWELL_MODES = [
    { id: 'keep', label: '私藏', loginOnly: true },
    { id: 'public', label: '陈列七日' },
    { id: 'cremate', label: '焚化' },
  ];
  function farewellModeOf(work) {
    if (work && work.farewell_mode) return work.farewell_mode;
    return getToken() ? 'keep' : 'public';
  }
  function renderFarewell(work) {
    var logged = !!getToken();
    var mode = farewellModeOf(work);
    var box = $('farewell-modes');
    box.innerHTML = '';
    FAREWELL_MODES.forEach(function (m) {
      if (m.loginOnly && !logged) return;
      var b = document.createElement('button');
      b.className = 'chip' + (m.id === mode ? ' active' : '');
      b.textContent = m.label;
      b.addEventListener('click', function () { chooseFarewell(m.id, null); });
      box.appendChild(b);
    });
    $('farewell-days-row').classList.toggle('hidden', mode !== 'cremate');
    if (mode === 'cremate' && work && work.farewell_days != null) {
      markFarewellDay(work.farewell_days);
    }
    updateFarewellNote(work, mode);
  }
  function markFarewellDay(days) {
    var chips = $('farewell-days-row').querySelectorAll('.chip');
    chips.forEach(function (c) {
      c.classList.toggle('active', parseInt(c.dataset.days, 10) === days);
    });
  }
  function updateFarewellNote(work, mode) {
    var note = '';
    if (mode === 'keep') note = '已私藏 · 容量够用时一直保留';
    else if (mode === 'public') note = '公众陈列中 · 七日后焚化';
    else if (work && work.farewell_days != null) {
      var pre = work.is_public ? '公众陈列中 · ' : '';
      note = pre + (work.farewell_days <= 0 ? '今日焚化' : work.farewell_days + ' 日后焚化');
    }
    $('farewell-note').textContent = note;
  }
  function chooseFarewell(mode, days) {
    if (!state.work || !state.work.id) return;
    if (mode === 'cremate' && days == null) {
      // 只展开时间选择，不调接口
      var box = $('farewell-modes');
      box.querySelectorAll('.chip').forEach(function (c) {
        c.classList.toggle('active', c.textContent === '焚化');
      });
      $('farewell-days-row').classList.remove('hidden');
      $('farewell-note').textContent = '选择焚化时间（最多七日）';
      return;
    }
    if (mode === 'cremate' && days === 0) {
      if (!confirm('确定现在焚化此作吗？形化去，功德留存。')) return;
      api('/api/works/' + state.work.id + '/cremate', { method: 'POST' })
        .then(function (res) {
          if (res && res.ok) {
            $('done-main').classList.add('hidden');
            $('done-cremated').classList.remove('hidden');
            // 焚化后只剩一个去处
            setScreenTools([{ label: '经文库', onClick: backToLibrary }]);
            state.work = null;
          } else { alert('焚化失败，请重试'); }
        }).catch(function () { alert('焚化失败，请重试'); });
      return;
    }
    api('/api/works/' + state.work.id + '/complete',
        { method: 'POST', body: JSON.stringify({ mode: mode, days: days || 7 }) })
      .then(function (res) { if (res && res.ok) renderFarewell(res.work); })
      .catch(function () {});
  }
  $('farewell-days-row').addEventListener('click', function (e) {
    var t = e.target.closest('.chip');
    if (!t) return;
    markFarewellDay(parseInt(t.dataset.days, 10));
    chooseFarewell('cremate', parseInt(t.dataset.days, 10));
  });

  /* ---------- 9.5 双视图：逐字 / 整纸 ---------- */
  // 字位格：{pos, ch, saved(落笔记录|null), ash(是否纸灰)}
  var SHEET_CAP = 180; // 保留：旧分页常量（现整纸为单张横排，不再分页）
  function mkEl(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function inkImg(saved, ch, px, fill) {
    var cv = document.createElement('canvas');
    cv.width = cv.height = px || 240;
    var rec = (saved && saved.strokes) || {};
    if (fill) {
      // 整纸视图：按笔画包围盒等比放大填满格子（不变形），格内无多余留白
      var pts = [];
      ((rec && rec.strokes) || []).forEach(function (st) {
        (st || []).forEach(function (p) { if (p && p[0] != null && p[1] != null) pts.push(p); });
      });
      if (pts.length > 1) {
        var x0 = 1, y0 = 1, x1 = 0, y1 = 0, i, p;
        for (i = 0; i < pts.length; i++) {
          p = pts[i];
          if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
          if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
        }
        var bw = Math.max(0.05, x1 - x0), bh = Math.max(0.05, y1 - y0);
        var sc = Math.min(cv.width / bw, cv.height / bh) * 0.9;
        var ox = (cv.width - bw * sc) / 2 - x0 * sc;
        var oy = (cv.height - bh * sc) / 2 - y0 * sc;
        var nstrokes = (rec.strokes || []).map(function (st) {
          return (st || []).map(function (pp) {
            return [(pp[0] * sc + ox) / cv.width, (pp[1] * sc + oy) / cv.height, pp[2], pp[3]];
          });
        });
        WritingPad.drawStatic(cv, { pen: rec.pen, ar: 1, strokes: nstrokes }, ch);
        var fimg = document.createElement('img');
        fimg.src = cv.toDataURL('image/png');
        fimg.alt = ch;
        return fimg;
      }
    }
    WritingPad.drawStatic(cv, rec, ch);
    var img = document.createElement('img');
    img.src = cv.toDataURL('image/png');
    img.alt = ch;
    return img;
  }
  function ashImg() { var img = document.createElement('img'); img.src = randomAsh(); return img; }

  // 整纸字格：与 PDF 同取景（renderCropped 紧裁剪，大字满格）；按 pos+笔画对象缓存
  var _sheetCropCache = { key: '', map: {} };
  function sheetCellImg(c) {
    var wk = (state.work && state.work.id) ? 'w' + state.work.id : 'sess';
    if (_sheetCropCache.key !== wk) _sheetCropCache = { key: wk, map: {} };
    var rec = (c.saved && c.saved.strokes) || {};
    var e = _sheetCropCache.map[c.pos];
    var img = document.createElement('img');
    if (e && e.rec === rec) { img.src = e.src; }
    else {
      var src = WritingPad.renderCropped(rec, c.ch, (state.font && state.font.stack) || '');
      _sheetCropCache.map[c.pos] = { rec: rec, src: src };
      img.src = src;
    }
    img.alt = c.ch || '';
    return img;
  }

  // 双视图组件：withToggle 为 true 时才显示 逐字|整纸 切换条（仪式用）；
  // 欣赏/查看器的切换收进工具菜单（ctx: {onTap(pos), isBurned(pos)}）
  function createDualView(mount, ctx, withToggle) {
    mount.innerHTML = '';
    var wrap = mkEl('div', 'dual-view');
    var bChar = null, bSheet = null;
    if (withToggle) {
      var toggle = mkEl('div', 'view-toggle');
      bChar = mkEl('button', 'vt-btn active'); bChar.textContent = '逐字';
      bSheet = mkEl('button', 'vt-btn'); bSheet.textContent = '整纸';
      toggle.appendChild(bChar); toggle.appendChild(bSheet);
      wrap.appendChild(toggle);
    }
    var charBox = mkEl('div', 'dual-char');
    var sheetBox = mkEl('div', 'dual-sheet hidden');
    wrap.appendChild(charBox); wrap.appendChild(sheetBox);
    mount.appendChild(wrap);
    var api = {
      view: 'char', cells: [], total: 0, title: '', cardByPos: {},
      pagerIdx: 0, sheetIdx: 0,
      render: function (cells, total, title) {
        api.cells = cells || []; api.total = total || 0; api.title = title || '';
        api.pagerIdx = 0; api.sheetIdx = 0;
        renderActive();
      },
      switch: function (v) { setView(v); },
      goTo: function (i) { if (api._go) api._go(i); },
      drawSheetPage: function (i) { if (api._drawPage) api._drawPage(i); }
    };
    function setView(v) {
      api.view = v;
      if (bChar) bChar.classList.toggle('active', v === 'char');
      if (bSheet) bSheet.classList.toggle('active', v === 'sheet');
      charBox.classList.toggle('hidden', v !== 'char');
      sheetBox.classList.toggle('hidden', v !== 'sheet');
      renderActive();
    }
    function renderActive() {
      if (api.view === 'char') renderPager(charBox, api, ctx);
      else renderSheet(sheetBox, api, ctx);
    }
    if (bChar) bChar.addEventListener('click', function () { setView('char'); });
    if (bSheet) bSheet.addEventListener('click', function () { setView('sheet'); });
    return api;
  }

  function cellImg(c, ctx, card) {
    var burned = c.ash || (ctx.isBurned && ctx.isBurned(c.pos));
    var img = burned ? ashImg() : inkImg(c.saved, c.ch, 240);
    if (burned) card.classList.add('burned');
    return img;
  }

  // 逐字：一列大纸卡，上下滚动浏览，点卡回放落笔（无按钮，翻页靠滚动）
  function renderPager(box, api, ctx) {
    box.innerHTML = ''; api.cardByPos = {};
    var cells = api.cells;
    if (!cells.length) {
      box.innerHTML = '<div class="work-empty">还没有写完的字，回去继续吧。</div>';
      return;
    }
    var list = mkEl('div', 'char-list');
    cells.forEach(function (c, i) {
      var row = mkEl('div', 'list-row');
      var card = mkEl('div', 'work-char list-card');
      card.appendChild(cellImg(c, ctx, card));
      if (ctx.onTap) {
        card.style.cursor = 'pointer';
        (function (pos) { card.addEventListener('click', function () { ctx.onTap(pos); }); })(c.pos);
      }
      var cap = mkEl('div', 'list-cap');
      cap.textContent = '第 ' + (i + 1) + ' / ' + cells.length + ' 字 · ' + c.ch;
      row.appendChild(card); row.appendChild(cap);
      list.appendChild(row);
      api.cardByPos[c.pos] = card;
    });
    box.appendChild(list);
    // 仪式燃烧跟随：把正在烧的字滚进视野
    api._go = function (i) {
      var row = list.children[Math.max(0, Math.min(cells.length - 1, i))];
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
  }

  // 单行自适应：宽度不够则逐级缩小字号（字距同比），直到放下为止
  function fitSheetText(el, startSize, minSize) {
    var size = startSize;
    el.style.fontSize = size + 'px';
    for (var i = 0; i < 24 && size > minSize; i++) {
      if (el.scrollWidth <= el.clientWidth + 1) break;
      size -= 1;
      el.style.fontSize = size + 'px';
      var ls = Math.round(size * 0.35);
      el.style.letterSpacing = ls + 'px';
      el.style.textIndent = ls + 'px'; // 抵消字距尾随，保持视觉居中
    }
  }

  // 整纸：复刻 PDF 版式（等比缩小）：标题"抄经作品"＋《经名》·字数·日期＋字格；
  // 字图与 PDF 同取景（renderCropped 紧裁剪，大字满格）
  function renderSheet(box, api, ctx) {
    box.innerHTML = ''; api.cardByPos = {};
    var cells = api.cells || [];
    if (!cells.length) {
      box.innerHTML = '<div class="work-empty">还没有写完的字，回去继续吧。</div>';
      return;
    }
    var sheet = mkEl('div', 'paper-sheet');
    var titleEl = mkEl('div', 'sheet-title');
    titleEl.textContent = '抄经作品';
    var fontStack = (state.font && state.font.stack) || '';
    if (fontStack) titleEl.style.fontFamily = fontStack;
    sheet.appendChild(titleEl);
    var now = new Date();
    var metaEl = mkEl('div', 'sheet-meta');
    metaEl.textContent = '《' + (api.title || '') + '》 · ' + cells.length + ' 字 · ' +
      now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
    sheet.appendChild(metaEl);
    var grid = mkEl('div', 'sheet-grid');
    cells.forEach(function (c) {
      var d = mkEl('div', 'sheet-cell');
      var burned = c.ash || (ctx.isBurned && ctx.isBurned(c.pos));
      d.appendChild(burned ? ashImg() : sheetCellImg(c));
      if (burned) d.classList.add('burned');
      if (ctx.onTap) {
        d.style.cursor = 'pointer';
        (function (pos) { d.addEventListener('click', function () { ctx.onTap(pos); }); })(c.pos);
      }
      api.cardByPos[c.pos] = d;
      grid.appendChild(d);
    });
    sheet.appendChild(grid);
    box.appendChild(sheet);
    fitSheetText(titleEl, 17, 12);
    fitSheetText(metaEl, 11, 8);
    // 兼容旧调用：单张纸，直接滚到顶部
    api._drawPage = function () {
      if (sheet && sheet.scrollIntoView) sheet.scrollIntoView({ block: 'start', behavior: 'smooth' });
      api.sheetIdx = 0;
    };
  }

  /* ---------- 10. 欣赏（已并入作品查看器：会话内用本地字迹表 + 会话快照，不拉服务端字） ---------- */
  function openWorkLocal() {
    state.workViewLocal = true;
    state.workMetaLoaded = false;
    state.workData = { ok: true, work: state.work || {} };
    state.workShare = '';
    renderWorkView(state.workData, '', { local: true });
    showScreen('screen-work');
    // 再拉一份服务端作品信息（只要权限字段：role/can_dedicate/chars_done…），
    // 把功能菜单补成和查看器完全一致；字仍用本地的，不重拉（刚写的字服务端可能还没落盘）
    var wid = state.work && state.work.id;
    if (wid) {
      api('/api/works/' + wid).then(function (res) {
        if (!res || !res.ok || !res.work) return;
        if (!state.workViewLocal) return; // 已离开，不管
        var w = res.work, lw = state.workData.work;
        lw.role = w.role; lw.can_dedicate = w.can_dedicate;
        lw.chars_done = w.chars_done; lw.chars_total = w.chars_total;
        lw.dedicated_at = w.dedicated_at; lw.has_audio = w.has_audio;
        lw.owner_type = w.owner_type; lw.title = w.title || lw.title;
        state.workMetaLoaded = true;
        if ($('screen-work').classList.contains('active')) setScreenTools(workScreenTools());
      }).catch(function () { /* 取不到就保持精简菜单 */ });
    }
  }

  // 会话内欣赏的过渡菜单（权限未取回前）：PDF、分享、视图切换、返回抄写
  function localWorkTools() {
    return [
      { label: 'PDF', onClick: printWork },
      { label: '分享', onClick: shareWork }
    ];
  }

  // 作品屏统一菜单：功能项只看作品状态（欣赏/查看器一致），只有"回去哪"看入口
  function workScreenTools() {
    var items = (state.workViewLocal && !state.workMetaLoaded) ? localWorkTools() : workviewTools();
    var vt = viewToggleItem(state.workviewDual, 'screen-work');
    if (vt) items.push(vt);
    if (state.workViewLocal) {
      items.push({ label: '返回', onClick: function () { showScreen('screen-write'); } });
    } else {
      items.push({ label: '经文库', onClick: function () { state.flowToken++; showScreen('screen-library'); } });
    }
    return items;
  }

  /* ---------- 11. 生成 PDF（系统打印 → 存为 PDF） ---------- */
  // 把已写字的笔迹渲染成图片（作品查看器用：按落笔记录重画，取景复刻书写时的成品快照）
  function renderInkImages() {
    var imgs = [];
    var byPos = state.workCharsByPos || {};
    var fontStack = (state.font && state.font.stack) || '';
    for (var i = 0; i < state.chars.length; i++) {
      var saved = byPos[i];
      if (!saved) continue;
      var dataUrl = WritingPad.renderCropped(saved.strokes || {}, state.chars[i], fontStack);
      if (dataUrl) imgs.push(dataUrl);
    }
    return imgs;
  }

  function printableImages() {
    // 刚写完的会话用成品快照；打开旧作则按笔迹记录渲染
    if (state.workImages && state.workImages.length) return state.workImages.filter(Boolean);
    return renderInkImages();
  }

  function buildPrintSheet(imgs) {
    var ps = $('print-sheet');
    var d = new Date();
    var html = '<h1>抄经作品</h1>' +
      '<div class="print-meta">《' + escapeHtml(state.sutra ? state.sutra.title : '') + '》 · ' +
      imgs.length + ' 字 · ' +
      d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + '</div>' +
      '<div class="print-grid">';
    imgs.forEach(function (src) {
      if (src) html += '<img src="' + src + '">';
    });
    ps.innerHTML = html + '</div>';
  }

  function printWork() {
    var imgs = printableImages();
    if (!imgs.length) { alert('还没有写完的字'); return; }
    buildPrintSheet(imgs);
    setTimeout(function () { window.print(); }, 300);
  }

  /* ---------- 11.5 作品查看：画廊 / 我的 / 回放 / 续写 ---------- */
  function fmtTime(s) {
    if (!s) return '';
    return String(s).slice(0, 16).replace('T', ' ');
  }

  function renderWorkCards(el, works, mine) {
    el.innerHTML = '';
    if (!works.length) {
      el.innerHTML = '<div class="work-empty-hint">' +
        (mine ? '还没有作品，去抄一段经吧。' : '还没有公开作品。') + '</div>';
      return;
    }
    works.forEach(function (w) {
      var b = document.createElement('button');
      b.className = 'work-card';
      var pct = w.chars_total ? Math.round(w.chars_done / w.chars_total * 100) : 0;
      var fw = (w.farewell_days == null) ? '' :
        (w.farewell_days <= 0 ? ' · 今日焚化' : ' · ' + w.farewell_days + '日后焚化');
      if (w.dedicated_at) fw = ' · 🪷 已回向';
      b.innerHTML =
        '<div class="wc-title">《' + escapeHtml(w.title || '') + '》</div>' +
        '<div class="wc-meta">' + w.chars_done + ' / ' + w.chars_total + ' 字 · ' +
        fmtTime(w.updated_at) + (w.owner_type === 'anon' ? ' · 匿名' : '') + fw + '</div>' +
        '<div class="wc-bar"><i style="width:' + pct + '%"></i></div>';
      b.addEventListener('click', function () { openWork(w.id); });
      el.appendChild(b);
    });
  }

  function refreshLibraryWorks() {
    api('/api/my/works').then(function (res) {
      var works = (res && res.ok && res.works) || [];
      state.myWorks = works; state.myWorksLoaded = true; // 点经文智能分流用
      $('my-works-title').style.display = works.length ? '' : 'none';
      renderWorkCards($('my-works'), works, true);
    }).catch(function () { state.myWorksLoaded = true; });
    api('/api/works?limit=24').then(function (res) {
      renderWorkCards($('public-works'), (res && res.ok && res.works) || [], false);
    }).catch(function () {});
  }

  // 打开作品：viewer（只读/续写），share 为分享 token 时只读
  function openWork(wid, share) {
    var url = '/api/works/' + wid + (share ? '?share=' + encodeURIComponent(share) : '');
    api(url).then(function (res) {
      if (!res || !res.ok) { alert('打不开这个作品'); return; }
      api('/api/sutra/' + encodeURIComponent(res.work.sutra_id)).then(function (sr) {
        if (!sr || !sr.ok || !sr.sutra) { alert('经文数据缺失'); return; }
        state.sutra = sr.sutra;
        var clean = (sr.sutra.full_text || '').replace(/\s+/g, '');
        state.fullChars = clean.split('');
        state.chars = clean.split(''); // 查看器：全文（字格用）
        state.paras = splitParagraphs(clean);
        state.totalChars = clean.length;
        var f = FONTS.filter(function (x) { return x.id === res.work.font_id; })[0] || FONTS[0];
        state.font = f;
        state.work = res.work;
        state.workData = res;
        state.workShare = share || '';
        state.workImages = []; // viewer 的 PDF 按笔迹记录渲染，不用会话快照
        state.workViewLocal = false;
        state.workMetaLoaded = true; // 服务端一次拉全，权限字段齐了
        renderWorkView(res, share);
        showScreen('screen-work');
      });
    }).catch(function () { alert('网络异常'); });
  }

  // 作品查看器的功能按钮（供全局工具菜单用）
  function workviewTools() {
    var res = state.workData;
    var w = res && res.work;
    if (!w) return [];
    var dedicated = !!w.dedicated_at;
    var finished = w.chars_done >= w.chars_total && w.chars_total > 0;
    var isOwner = w.role === 'owner';
    var canDedicate = w.can_dedicate && !dedicated && w.chars_done > 0;
    var items = [];
    if (!dedicated && !finished) items.push({ label: '续写', onClick: continueWork });
    if (!dedicated && w.chars_done > 0) {
      items.push({ label: '放映', onClick: openInkPlay });
      items.push({ label: 'PDF', onClick: printWork });
    }
    if (isOwner && getToken()) items.push({ label: '分享', onClick: shareViewedWork });
    if (canDedicate) items.push({ label: '回向', onClick: openDedicateDialog });
    if (isOwner) items.push({ label: '删除', onClick: deleteWork });
    return items;
  }

  function renderWorkView(res, share, opts) {
    var local = !!(opts && opts.local); // 会话内欣赏：本地字迹表，不拉服务端
    var w = res.work || {};
    var full = state.fullChars || state.chars || [];
    // 录音只供落笔放映播放，不再显示播放器（纸上无按钮）
    var au = $('workview-audio');
    au.style.display = 'none';
    if (state.audioBlobUrl) { try { URL.revokeObjectURL(state.audioBlobUrl); } catch (e) {} state.audioBlobUrl = null; }
    if (!local && w.has_audio) {
      au.removeAttribute('src');
      var audioUrl = '/api/works/' + w.id + '/audio' + (share ? '?share=' + encodeURIComponent(share) : '');
      // <audio> 发不出 Authorization / X-Anon-Key，带鉴权取 blob 再播（登录用户私作直连会 404）
      var ah = {};
      var at = getToken(); if (at) ah['Authorization'] = 'Bearer ' + at;
      var aak = getAnonKey(); if (aak) ah['X-Anon-Key'] = aak;
      fetch(audioUrl, { headers: ah }).then(function (r) {
        if (!r.ok) throw 0;
        return r.blob();
      }).then(function (blob) {
        if (!blob || !blob.size) throw 0;
        state.audioBlobUrl = URL.createObjectURL(blob);
        au.src = state.audioBlobUrl;
      }).catch(function () { /* 取不到录音：放映时用现场音乐兜底 */ });
    } else {
      au.removeAttribute('src');
    }
    var byPos;
    if (local) {
      // 会话内：刚写的字服务端可能还没落盘，用本地字迹表，不覆盖
      byPos = state.workCharsByPos || {};
    } else {
      byPos = {};
      (res.chars || []).forEach(function (c) { byPos[c.pos] = c; });
      state.workCharsByPos = byPos;
    }
    var dedicated = !local && !!w.dedicated_at;
    // 双视图：逐字 / 整纸；写过的字展示手写纸卡（点卡回放落笔）；已回向则只显示尘埃卡
    var cells = [];
    if (dedicated) {
      (w.ash_cells || []).slice().sort(function (a, b) { return a - b; }).forEach(function (pos) {
        cells.push({ pos: pos, ch: full[pos], ash: true });
      });
    } else {
      for (var i = 0; i < full.length; i++) {
        var saved = byPos[i];
        if (saved) cells.push({ pos: i, ch: saved.ch || full[i], saved: saved });
      }
    }
    if (!state.workviewDual) {
      state.workviewDual = createDualView($('workview-dual'), {
        onTap: function (pos) {
          var cw = state.workData && state.workData.work;
          if (cw && !cw.dedicated_at) openChar(pos);
        },
        isBurned: function () { return false; }
      });
    }
    state.workviewTitle = (local ? (state.sutra && state.sutra.title) : w.title) || '';
    state.workviewDual.render(cells, full.length, state.workviewTitle);
    // 功能按钮收拢进全局工具按钮：与查看器同一套（欣赏/查看器一致），只有"回去哪"看入口
    setScreenTools(workScreenTools());
    if (dedicated) {
      // 纪念态：不可再欣赏（无放映/PDF/回放/续写），展示尘埃与回向文
      var db = $('dedication-block');
      db.classList.remove('hidden');
      $('dedication-text').textContent = w.dedication_text || '';
      $('dedication-meta').textContent =
        (w.dedication_target ? '回向：' + w.dedication_target + ' · ' : '') + fmtTime(w.dedicated_at);
    } else {
      $('dedication-block').classList.add('hidden');
    }
  }

  // 续写：从第一个没写的字进入（跳过开场，直达书写）
  function continueWork() {
    var res = state.workData;
    if (!res) return;
    var byPos = state.workCharsByPos || {};
    var idx = 0;
    while (idx < state.totalChars && byPos[idx]) idx++;
    if (idx >= state.totalChars) { alert('已经写完了'); return; }
    state.workImages = [];
    state.sessionStartPos = idx; // 续写：本会话快照从 idx 开始对应全文序号
    setParaForGlobalPos(idx); // 按全文序号定位到段落
    startWritingDirect();
  }

  function startWritingDirect() {
    state.flowToken++;
    showScreen('screen-write');
    closeTools();
    hideOverlays();
    ensurePad();
    // 续写：节奏同样复位为慢，直接进入书写（无段落显示）
    resetParaRhythm();
    pad.setFont(state.font.stack);
    pad.setPen(state.pen.id);
    if (!state.musicOn) { music.start(); state.musicOn = true; }
    try { music.setAudible(true); } catch (e) {}
    try { music.startRecording(); } catch (e) {}
    beginChar();
  }

  function shareViewedWork() {
    var w = state.workData && state.workData.work;
    if (!w) return;
    api('/api/works/' + w.id + '/share', { method: 'POST' }).then(function (res) {
      if (!res || !res.ok) { alert(res && res.message || '分享失败'); return; }
      var url = location.origin + location.pathname + '#w=' + w.id + '&share=' + res.share_token;
      var title = '《' + (w.title || '心经') + '》抄经作品';
      var text = '我抄的《' + (w.title || '心经') + '》，点开欣赏，还可看落笔放映。';
      if (navigator.share) {
        navigator.share({ title: title, text: text, url: url }).catch(function () {});
      } else {
        var done = function () { alert('分享链接已复制，发给朋友即可查看'); };
        if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, function () { prompt('复制分享链接：', url); });
        else prompt('复制分享链接：', url);
      }
    }).catch(function () { alert('网络异常'); });
  }

  function deleteWork() {
    var w = state.workData && state.workData.work;
    if (!w || !confirm('确定删除这个作品吗？')) return;
    api('/api/works/' + w.id, { method: 'DELETE' }).then(function (res) {
      if (res && res.ok) showScreen('screen-library');
      else alert('删除失败');
    });
  }

  /* ---------- 回向 ---------- */
  // 与服务端 DEDICATION_TEXTS 保持一致（{target} 为回向对象占位）
  var DEDICATION_TEXTS = {
    huixiangji: '愿以此抄经功德，回向{target}。愿以此功德，庄严佛净土，上报四重恩，下济三途苦；若有见闻者，悉发菩提心，尽此一报身，同生极乐国。',
    puxian: '愿以此抄经功德，回向{target}。所有十方世界中，三世一切人师子，我以清净身语意，一切遍礼尽无余。愿我临欲命终时，尽除一切诸障碍，面见彼佛阿弥陀，即得往生安乐刹。',
    pingdeng: '愿以此抄经功德，回向{target}。愿以此功德，平等施一切，同发菩提心，往生安乐国。',
    xiaozai: '愿以此抄经功德，回向{target}。愿消三障诸烦恼，愿得智慧真明了，普愿罪障悉消除，世世常行菩萨道。'
  };
  var DEDICATION_KINDS = ['huixiangji', 'puxian', 'pingdeng', 'xiaozai'];
  function dedicationKind() {
    try {
      var k = localStorage.getItem('sutra_dedicate_kind');
      if (DEDICATION_TEXTS[k]) return k;
    } catch (e) {}
    return 'huixiangji';
  }
  function dedicationTextFor(kind, target) {
    var t = DEDICATION_TEXTS[kind] || DEDICATION_TEXTS.huixiangji;
    return t.split('{target}').join(target);
  }
  function defaultDedicateTarget() {
    try { return localStorage.getItem('sutra_dedicate_target') || '法界一切众生'; }
    catch (e) { return '法界一切众生'; }
  }
  function updateDedicatePreview() {
    var t = ($('dedicate-target').value || '').trim() || '法界一切众生';
    $('dedicate-preview').textContent = dedicationTextFor(dedicationKind(), t);
  }
  function paintDedicateKinds() {
    var cur = dedicationKind();
    var box = $('dedicate-kinds');
    var btns = box.querySelectorAll('.chip');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute('data-kind') === cur) btns[i].classList.add('active');
      else btns[i].classList.remove('active');
    }
  }

  function openDedicateDialog() {
    $('dedicate-target').value = defaultDedicateTarget();
    try { var sn = localStorage.getItem('sutra_dedicate_sign'); if (sn) $('dedicate-sign').value = sn; } catch (e) {}
    paintDedicateKinds();
    paintDedicateNames();
    updateDedicatePreview();
    $('dedicate-overlay').classList.remove('hidden');
  }
  // 回向署名：匿名 / 署名（自填名字）
  function dedicateAnon() {
    try { return localStorage.getItem('sutra_dedicate_anon') !== '0'; } catch (e) { return true; }
  }
  function paintDedicateNames() {
    var anon = dedicateAnon();
    var box = $('dedicate-names');
    var btns = box.querySelectorAll('.chip');
    for (var i = 0; i < btns.length; i++) {
      var isAnon = btns[i].getAttribute('data-anon') === '1';
      if ((isAnon && anon) || (!isAnon && !anon)) btns[i].classList.add('active');
      else btns[i].classList.remove('active');
    }
    $('dedicate-sign').classList.toggle('hidden', anon);
  }
  function dedicateSignName() {
    if (dedicateAnon()) return '';
    return ($('dedicate-sign').value || '').trim().slice(0, 20);
  }
  $('dedicate-kinds').addEventListener('click', function (e) {
    var b = e.target && e.target.getAttribute ? e.target.getAttribute('data-kind') : null;
    if (!b || !DEDICATION_TEXTS[b]) return;
    try { localStorage.setItem('sutra_dedicate_kind', b); } catch (err) {}
    paintDedicateKinds();
    updateDedicatePreview();
  });
  $('dedicate-target').addEventListener('input', updateDedicatePreview);
  $('dedicate-names').addEventListener('click', function (e) {
    var b = e.target && e.target.getAttribute ? e.target.getAttribute('data-anon') : null;
    if (b === null) return;
    try { localStorage.setItem('sutra_dedicate_anon', b === '1' ? '1' : '0'); } catch (err) {}
    paintDedicateNames();
  });
  $('btn-dedicate-cancel').addEventListener('click', function () {
    $('dedicate-overlay').classList.add('hidden');
  });
  $('btn-dedicate-confirm').addEventListener('click', function () {
    var w = state.workData && state.workData.work;
    if (!w) return;
    var target = ($('dedicate-target').value || '').trim() || '法界一切众生';
    var kind = dedicationKind();
    var dname = dedicateSignName();
    try { localStorage.setItem('sutra_dedicate_target', target); } catch (e) {}
    try { if (dname) localStorage.setItem('sutra_dedicate_sign', dname); } catch (e) {}
    if (!confirm('回向后字迹化烟，唯留尘埃与回向文，不可再欣赏、续写。确定回向吗？')) return;
    $('btn-dedicate-confirm').disabled = true;
    api('/api/works/' + w.id + '/dedicate', { method: 'POST', body: JSON.stringify({ target: target, kind: kind, dedicator_name: dname }) })
      .then(function (res) {
        $('btn-dedicate-confirm').disabled = false;
        if (!res || !res.ok) { alert(res && res.message || '回向失败'); return; }
        $('dedicate-overlay').classList.add('hidden');
        playDedicationCeremony(res.dedication_text, res.ash_cells || []);
      })
      .catch(function () { $('btn-dedicate-confirm').disabled = false; alert('网络异常'); });
  });

  /* 庄严读出回向文：有中文嗓音则朗读（onBoundary 给出朗读到的字符位置），
     否则走 onSilent（静默，只高亮+燃烧，进度由计时器驱动） */
  function speakDedication(text, onBoundary, onEnd, onSilent) {
    var ended = false, silenced = false;
    function end() { if (!ended) { ended = true; onEnd(); } }
    function silent() { if (!silenced) { silenced = true; onSilent(); } }
    try {
      var synth = window.speechSynthesis;
      if (!synth) { silent(); return; }
      synth.cancel();
      var vs = [];
      try { vs = synth.getVoices() || []; } catch (e) {}
      var zh = null, i;
      for (i = 0; i < vs.length; i++) if (/^zh([-_]CN)?$/i.test(vs[i].lang || '')) { zh = vs[i]; break; }
      if (!zh) for (i = 0; i < vs.length; i++) if (/^zh/i.test(vs[i].lang || '')) { zh = vs[i]; break; }
      if (!zh) { silent(); return; }
      var u = new SpeechSynthesisUtterance(text);
      u.voice = zh; u.lang = zh.lang || 'zh-CN';
      u.rate = 0.82; u.pitch = 0.9;
      try {
        u.onboundary = function (e) {
          if (e && typeof e.charIndex === 'number') onBoundary(e.charIndex);
        };
      } catch (e) {}
      u.onend = end; u.onerror = end;
      synth.speak(u);
      setTimeout(end, text.length * 600 + 15000); // 兜底
    } catch (e) { silent(); }
  }

  /* 纸灰：随机生成灰烬纹理（预生成 12 种，每格随机取用，看着像烧过的抄经纸） */
  var ASH_VARIANTS = [];
  function makeAshTexture() {
    var S = 56;
    var cv = document.createElement('canvas');
    cv.width = cv.height = S;
    var c = cv.getContext('2d');
    var base = 198 + ((Math.random() * 28) | 0);
    c.fillStyle = 'rgb(' + base + ',' + (base - 5) + ',' + (base - 16) + ')';
    c.fillRect(0, 0, S, S);
    var i, r, g;
    for (i = 0; i < 22; i++) { // 深浅不一的灰斑
      r = 2 + Math.random() * 7;
      g = 150 + ((Math.random() * 70) | 0);
      c.fillStyle = 'rgba(' + g + ',' + (g - 4) + ',' + (g - 12) + ',' + (0.25 + Math.random() * 0.4).toFixed(2) + ')';
      c.beginPath(); c.arc(Math.random() * S, Math.random() * S, r, 0, 6.29); c.fill();
    }
    for (i = 0; i < 80; i++) { // 尘埃颗粒
      g = 90 + ((Math.random() * 100) | 0);
      c.fillStyle = 'rgba(' + g + ',' + (g - 6) + ',' + (g - 14) + ',' + (0.5 + Math.random() * 0.5).toFixed(2) + ')';
      var s = Math.random() < 0.85 ? 1 : 2;
      c.fillRect(Math.random() * S, Math.random() * S, s, s);
    }
    if (Math.random() < 0.35) { // 偶尔一点未燃尽的纸角
      c.fillStyle = 'rgba(74,62,48,0.55)';
      var cx = Math.random() * S, cy = Math.random() * S;
      c.beginPath(); c.moveTo(cx, cy);
      c.lineTo(cx + 7 + Math.random() * 9, cy + 2);
      c.lineTo(cx + 3, cy + 7 + Math.random() * 8);
      c.closePath(); c.fill();
    }
    if (Math.random() < 0.25) { // 偶尔一丝余烬暗红
      c.fillStyle = 'rgba(150,60,30,0.35)';
      c.beginPath(); c.arc(Math.random() * S, Math.random() * S, 1.5, 0, 6.29); c.fill();
    }
    return cv.toDataURL();
  }
  function randomAsh() {
    while (ASH_VARIANTS.length < 12) ASH_VARIANTS.push(makeAshTexture());
    return ASH_VARIANTS[(Math.random() * ASH_VARIANTS.length) | 0];
  }
  function setAsh(card) {
    // 纸卡燃尽：手写图换成随机纸灰
    var img = card.querySelector('img');
    if (img) img.src = randomAsh();
    card.classList.add('burned');
  }

  /* 一张纸卡燃烧：边缘先起火光，墨迹化作火星与烟上升，燃尽后随机落下纸灰 */
  function burnCell(card, dur, done) {
    var finished = false;
    function fin() { if (!finished) { finished = true; done(); } }
    function cleanup() { try { document.body.removeChild(ov); } catch (e) {} }
    var src = card.querySelector('img');
    var r = src ? src.getBoundingClientRect() : card.getBoundingClientRect();
    if (!src || !r.width) { setAsh(card); fin(); return; }
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var W = Math.max(2, Math.round(r.width)), H = Math.max(2, Math.round(r.height));
    var ov = document.createElement('canvas');
    ov.width = W * dpr; ov.height = H * dpr;
    ov.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + W + 'px;height:' + H +
      'px;pointer-events:none;z-index:90;';
    document.body.appendChild(ov);
    var ctx = ov.getContext('2d');
    ctx.scale(dpr, dpr);
    var off = document.createElement('canvas');
    off.width = W; off.height = H;
    var octx = off.getContext('2d');
    try { octx.drawImage(src, 0, 0, W, H); } catch (e) {}
    var embers = [], smokes = [];
    try {
      var img = octx.getImageData(0, 0, W, H).data;
      var y, x;
      for (y = 0; y < H; y += 3) {
        for (x = 0; x < W; x += 3) {
          if (img[(y * W + x) * 4 + 3] > 40) {
            if (Math.random() < 0.55) {
              embers.push({ x: x, y: y, vx: (Math.random() - 0.5) * 0.9, vy: -(0.8 + Math.random() * 1.6),
                life: 1, decay: 0.012 + Math.random() * 0.02, sz: 0.8 + Math.random() * 1.8,
                hue: 18 + Math.random() * 28, ph: Math.random() * 6.28 });
            } else {
              smokes.push({ x: x, y: y, vx: (Math.random() - 0.5) * 0.4, vy: -(0.3 + Math.random() * 0.7),
                life: 1, decay: 0.006 + Math.random() * 0.008, sz: 1.5 + Math.random() * 2.5,
                ph: Math.random() * 6.28, tone: 70 + Math.random() * 50 });
            }
          }
        }
      }
    } catch (e) {}
    function trim(arr, max) {
      if (arr.length <= max) return arr;
      var out = [], i;
      for (i = 0; i < max; i++) out.push(arr[(Math.random() * arr.length) | 0]);
      return out;
    }
    embers = trim(embers, 420); smokes = trim(smokes, 420);
    src.style.transition = 'opacity ' + Math.round(dur * 0.5) + 'ms';
    src.style.opacity = '0';
    var start = performance.now();
    (function frame(now) {
      var t = (now - start) / dur;
      ctx.clearRect(0, 0, W, H);
      var i, p;
      if (t < 0.45) { // 火光边缘闪烁
        var fl = 0.5 + 0.5 * Math.sin(now / 47) * Math.sin(now / 31 + 1.7);
        ctx.save();
        ctx.strokeStyle = 'rgba(255,' + (120 + ((fl * 80) | 0)) + ',30,' + (0.55 + fl * 0.4).toFixed(2) + ')';
        ctx.lineWidth = 2 + fl * 2;
        ctx.shadowColor = 'rgba(255,140,40,0.9)';
        ctx.shadowBlur = 10 + fl * 12;
        ctx.strokeRect(1.5, 1.5, W - 3, H - 3);
        ctx.restore();
      }
      var alive = false;
      for (i = 0; i < embers.length; i++) { // 火星：橙黄，闪烁上升
        p = embers[i];
        if (p.life <= 0) continue;
        alive = true;
        p.x += p.vx + Math.sin(now / 260 + p.ph) * 0.5;
        p.y += p.vy;
        p.vy *= 0.99;
        p.life -= p.decay;
        var tw = 0.6 + 0.4 * Math.sin(now / 60 + p.ph * 3);
        var al = Math.max(0, Math.min(1, p.life)) * tw;
        ctx.fillStyle = 'hsla(' + p.hue.toFixed(0) + ',100%,' + (48 + p.life * 12).toFixed(0) + '%,' + al.toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.4, p.sz * p.life), 0, 6.29);
        ctx.fill();
      }
      for (i = 0; i < smokes.length; i++) { // 烟：灰色，缓慢上升扩大
        p = smokes[i];
        if (p.life <= 0) continue;
        alive = true;
        p.x += p.vx + Math.sin(now / 400 + p.ph) * 0.4;
        p.y += p.vy;
        p.life -= p.decay;
        var g = Math.round(Math.min(235, p.tone + (1 - p.life) * 110));
        var sal = Math.max(0, Math.min(1, p.life)) * 0.6;
        ctx.fillStyle = 'rgba(' + g + ',' + g + ',' + (g - 8) + ',' + sal.toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.5, p.sz * (1.7 - p.life * 0.7)), 0, 6.29);
        ctx.fill();
      }
      if (t < 1 && alive) requestAnimationFrame(frame);
      else { cleanup(); setAsh(card); fin(); }
    })(start);
    setTimeout(function () { cleanup(); setAsh(card); fin(); }, dur + 1500); // 兜底
  }

  /* 回向仪式：朗读进度驱动回向文高亮、进度条与纸燃烧（三者严格同步） */
  function playDedicationCeremony(text, ashCells) {
    var overlay = $('ceremony-overlay');
    var txtEl = $('ceremony-text');
    var statusEl = $('ceremony-status');
    var barEl = $('ceremony-progress-i');
    txtEl.innerHTML = '';
    var spans = [];
    text.split('').forEach(function (ch) {
      var s = document.createElement('span');
      s.textContent = ch;
      txtEl.appendChild(s); spans.push(s);
    });
    statusEl.textContent = '字迹化烟中……';
    barEl.style.width = '0%';
    $('ceremony-banner').classList.remove('collapsed');
    $('ceremony-fold').textContent = '收起 ↑';
    // 仪式舞台：双视图（逐字/整纸），字迹在当前视图的字卡上燃烧
    var byPosC = state.workCharsByPos || {};
    var fullC = state.fullChars || state.chars || [];
    var cellsC = ashCells.map(function (p) {
      var s = byPosC[p];
      return { pos: p, ch: (s && s.ch) || fullC[p], saved: s };
    });
    var burnedSet = {};
    var dual = createDualView($('ceremony-stage'), {
      onTap: null, // 仪式中不点播回放
      isBurned: function (pos) { return !!burnedSet[pos]; }
    }, true); // 仪式保留自己的 逐字|整纸 切换
    dual.render(cellsC, state.totalChars || fullC.length);
    try { $('ceremony-stage').scrollTop = 0; } catch (e) {}
    overlay.classList.remove('hidden');
    var n = ashCells.length;
    var readPos = 0;             // 朗读到的字符位置（进度之源）
    var boundarySeen = false;    // TTS 是否给出 boundary 事件
    var silent = false;          // 无中文嗓音：静默仪式
    var ttsEnded = false, ttsDone = false, finDone = false;
    var highlighted = 0, ignited = 0, burnedCount = 0;
    function paintProgress() {
      var prog = Math.min(1, readPos / text.length);
      barEl.style.width = (prog * 100).toFixed(1) + '%';
      var h = Math.min(spans.length, Math.floor(prog * spans.length));
      while (highlighted < h) { spans[highlighted].className = 'ch-read'; highlighted++; }
      var b = Math.min(n, Math.floor(prog * n));
      while (ignited < b) { igniteCell(ignited); ignited++; }
    }
    function igniteCell(i) {
      var pos = ashCells[i];
      burnedSet[pos] = 1;
      if (dual.view === 'char') dual.goTo(i); // 逐字：翻到正在烧的那张
      var card = dual.cardByPos[pos];
      if (!card) { burnedCount++; checkFinish(); return; }
      if (dual.view === 'sheet' && card.scrollIntoView) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); // 整纸：把正在烧的字滚进视野
      burnCell(card, 750 + Math.random() * 550, function () { burnedCount++; checkFinish(); });
    }
    function checkFinish() {
      if (finDone || !ttsDone || burnedCount < n) return;
      finDone = true;
      clearInterval(tick);
      spans.forEach(function (s) { s.className = 'ch-read'; });
      barEl.style.width = '100%';
      statusEl.innerHTML = '<div class="ceremony-done-mark">尘归尘 · 功德圆满 🪷</div>';
      setTimeout(function () {
        overlay.classList.add('hidden');
        var w = state.workData && state.workData.work;
        if (w) {
          var d = new Date();
          function p2(x) { return ('0' + x).slice(-2); }
          w.dedicated_at = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' +
            p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
          w.dedication_text = text;
          w.ash_cells = ashCells;
          w.has_audio = false;
        }
        state.workViewLocal = false; // 回向后不可再写，"回去"改回经文库
        renderWorkView(state.workData, state.workShare);
        try { window.scrollTo(0, 0); } catch (e) {}
      }, 3200);
    }
    speakDedication(text,
      function (ci) { boundarySeen = true; readPos = ci; paintProgress(); },
      function () { ttsEnded = true; },
      function () { silent = true; });
    // 无 boundary 事件时按估计时长推算进度（有声 TTS 封顶 95%，等 onend 补齐）
    var estTotal = Math.max(8000, text.length * 380);
    var t0 = performance.now();
    var tick = setInterval(function () {
      if (finDone) { clearInterval(tick); return; }
      if (!boundarySeen && !ttsEnded) {
        var cap = silent ? text.length : Math.floor(text.length * 0.95);
        readPos = Math.min(cap, (performance.now() - t0) / estTotal * text.length);
      }
      if (ttsEnded) readPos = text.length;
      if (!ttsDone && (ttsEnded || (silent && readPos >= text.length))) {
        ttsDone = true; readPos = text.length;
      }
      paintProgress();
      checkFinish();
    }, 120);
  }

  $('ceremony-fold').addEventListener('click', function () {
    var b = $('ceremony-banner');
    var collapsed = b.classList.toggle('collapsed');
    $('ceremony-fold').textContent = collapsed ? '展开 ↓' : '收起 ↑';
  });

  /* ---------- 回放：重演一字的落笔过程（与落笔放映同一套实现） ---------- */
  // 按书写宽高比定舞台尺寸——先定尺寸、显示，再建 pad 并 _resize，
  // 否则 backing store 与 CSS 对不上会被拉伸变形
  function sizePlayStage(stageEl, ar, maxW, maxH) {
    ar = ar || (window.innerWidth / window.innerHeight) || 0.5;
    var sw = maxW, sh = sw / ar;
    if (sh > maxH) { sh = maxH; sw = sh * ar; }
    stageEl.style.width = Math.round(sw) + 'px';
    stageEl.style.height = Math.round(sh) + 'px';
    stageEl.style.aspectRatio = 'auto';
  }

  // 单字演绎（放映/单字回放共用）：标点盖印停 450ms，字后停 500ms；返回取消函数
  function playOneChar(pad, ch, saved, onDone) {
    pad.setFont(state.font.stack);
    pad.newChar(ch);
    var rec = (saved && saved.strokes) || {};
    var timer = null, done = false;
    var finish = function () { if (!done) { done = true; onDone(); } };
    if (rec.auto === 'punct') {
      pad.stampChar(ch);
      timer = setTimeout(finish, 450);
    } else {
      pad.replayStrokes(rec.strokes ? rec : { pen: (saved && saved.pen) || 'maobi', strokes: [] }, {
        onDone: function () { timer = setTimeout(finish, 500); }
      });
    }
    return function () {
      if (timer) clearTimeout(timer);
      try { pad.cancelReplay(); } catch (e) {}
    };
  }

  /* ---------- 单字欣赏：全屏，界面同首次书写该字 ---------- */
  var charPad = null;
  var charPos = -1;          // 全文序号
  var charSaved = null;      // 已保存版本
  var charEditing = false;   // 改写中（可落笔）
  var charReplayCancel = null;
  var charSaveTimer = 0;
  var charQueue = [];        // 已写字序号（升序）

  function charCh() { return ((state.fullChars || state.chars || [])[charPos]) || ''; }

  // 单字是否可改写：未回向，且（会话内作者本人 / owner / writer）
  function charCanRewrite() {
    var w = (state.workData && state.workData.work) || {};
    if (w.dedicated_at) return false;
    if (state.workViewLocal) return true;
    return w.role === 'owner' || w.role === 'writer';
  }

  function openChar(pos) {
    var saved = (state.workCharsByPos || {})[pos];
    if (!saved) return;
    charPos = pos; charSaved = saved;
    var byPos = state.workCharsByPos || {};
    var full = state.fullChars || state.chars || [];
    charQueue = [];
    for (var i = 0; i < full.length; i++) if (byPos[i]) charQueue.push(i);
    showScreen('screen-char');
    if (!charPad) {
      charPad = new WritingPad($('char-paper'), $('char-ink'), {
        onStrokeStart: function () { clearTimeout(charSaveTimer); },
        onStrokeEnd: function (cov, n) {
          if (!charEditing) return;
          // 最小运笔：超过字区最大边的一半（防误触）
          var minLen = charPad.bbox ? Math.max(charPad.bbox.w, charPad.bbox.h) * 0.5 : 60;
          if (cov >= DONE_COVERAGE && charPad.inkLength > minLen) {
            clearTimeout(charSaveTimer);
            charSaveTimer = setTimeout(function () {
              if (charEditing && charPad.coverage() >= DONE_COVERAGE) saveCharRewrite();
            }, 900);
          }
        }
      });
    } else {
      charPad._resize();
    }
    $('btn-char-eraser').style.display = charCanRewrite() ? '' : 'none';
    charShow();
  }

  function charShow() {
    var qi = charQueue.indexOf(charPos);
    $('char-title').textContent = '第 ' + (charPos + 1) + ' 字 · ' + charCh();
    $('char-prev').style.visibility = qi > 0 ? '' : 'hidden';
    $('char-next').style.visibility = (qi >= 0 && qi < charQueue.length - 1) ? '' : 'hidden';
    closeCharMenu();
    charReplay();
  }

  function charSetEditing(on) {
    charEditing = on;
    $('screen-char').classList.toggle('no-input', !on); // 回放态禁落笔，改写态可落笔
    if (on && charPad) charPad.setPen('maobi');
  }

  // 打开默认重播一次笔迹（与放映同一套实现）
  function charReplay() {
    if (charReplayCancel) { charReplayCancel(); charReplayCancel = null; }
    clearTimeout(charSaveTimer);
    charSetEditing(false);
    var ch = charCh(), saved = charSaved;
    var doPlay = function () {
      charReplayCancel = playOneChar(charPad, ch, saved, function () { charReplayCancel = null; });
    };
    try {
      var fam = state.font.web ? state.font.web.split(' ').slice(1).join(' ') : null;
      if (document.fonts && fam) document.fonts.load(state.font.web, ch).then(doPlay, doPlay);
      else doPlay();
    } catch (e) { doPlay(); }
  }

  // 左右滑动 / 点‹ ›：上一个 / 下一个已写的字
  function charGo(dir) {
    var qi = charQueue.indexOf(charPos) + dir;
    if (qi < 0 || qi >= charQueue.length) return;
    charPos = charQueue[qi];
    charSaved = (state.workCharsByPos || {})[charPos];
    if (!charSaved) return;
    charShow();
  }

  // 橡皮：擦除重写（进改写态即一张干净纸，虚影字引导）
  function charEnterEdit() {
    if (!charPad || charPos < 0 || !charCanRewrite()) return;
    if (charReplayCancel) { charReplayCancel(); charReplayCancel = null; }
    clearTimeout(charSaveTimer);
    charPad.newChar(charCh()); // 清空墨迹、重置落笔记录与计时、重画虚影字
    charSetEditing(true);
  }

  // 改写完成后自动保存（写字屏同款覆盖判定），存下即播新版
  function saveCharRewrite() {
    if (charPos < 0 || !charPad || !charEditing) return;
    charEditing = false;
    var rec = charPad.getCharRecord();
    var entry = { pos: charPos, ch: charCh(), pen: rec.pen || 'maobi', strokes: rec };
    state.workCharsByPos[charPos] = entry;
    charSaved = entry;
    var w = (state.workData && state.workData.work) || {};
    if (w.id) {
      api('/api/works/' + w.id + '/chars', {
        method: 'PUT',
        body: JSON.stringify({ pos: charPos, ch: entry.ch, pen: entry.pen, strokes: rec })
      }).catch(function () {});
    }
    if (state.workImages && state.workImages.length) {
      var si = charPos - (state.sessionStartPos || 0);
      var img = null;
      try { img = charPad.snapshot(); } catch (e) {}
      if (img && si >= 0 && si < state.workImages.length) state.workImages[si] = img;
    }
    refreshWorkCells();
    charToast('已保存');
    charReplay();
  }

  function charBack() {
    if (charReplayCancel) { charReplayCancel(); charReplayCancel = null; }
    clearTimeout(charSaveTimer);
    closeCharMenu();
    charPos = -1; charSaved = null; charEditing = false;
    showScreen('screen-work');
  }

  var charToastTimer = 0;
  function charToast(msg) {
    var t = $('char-toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    t.style.opacity = '1';
    clearTimeout(charToastTimer);
    charToastTimer = setTimeout(function () {
      t.style.opacity = '0';
      setTimeout(function () { t.classList.add('hidden'); }, 350);
    }, 1200);
  }

  function closeCharMenu() {
    var m = $('char-menu');
    if (!m || m.classList.contains('hidden')) return;
    m.classList.remove('open');
    setTimeout(function () { m.classList.add('hidden'); }, 320);
  }
  $('btn-char-tools').addEventListener('click', function (e) {
    e.stopPropagation();
    var m = $('char-menu');
    if (m.classList.contains('hidden')) {
      m.classList.remove('hidden');
      requestAnimationFrame(function () { m.classList.add('open'); });
    } else {
      closeCharMenu();
    }
  });
  $('char-menu').addEventListener('click', function (e) {
    var t = e.target && e.target.dataset ? e.target.dataset.ctool : null;
    closeCharMenu();
    if (t === 'back') charBack();
  });
  $('btn-char-eraser').addEventListener('click', function (e) {
    e.stopPropagation();
    charEnterEdit();
  });
  $('btn-char-play').addEventListener('click', function (e) {
    e.stopPropagation();
    if (charPos >= 0) charReplay(); // 重播已保存版本（改写中点=放弃未保存的）
  });
  $('char-prev').addEventListener('click', function () { charGo(-1); });
  $('char-next').addEventListener('click', function () { charGo(1); });
  // 菜单打开时点别处收起（capture，先于滑动判定）
  $('screen-char').addEventListener('pointerdown', function (e) {
    var m = $('char-menu');
    if (!m.classList.contains('hidden') && !e.target.classList.contains('tool-item')) {
      closeCharMenu();
    }
  }, true);
  // 回放态左右滑动：上一个 / 下一个字（改写态的滑动是运笔，不触发）
  var charSwipe = null;
  $('screen-char').addEventListener('pointerdown', function (e) {
    charSwipe = { x: e.clientX, y: e.clientY, t: Date.now() };
  });
  $('screen-char').addEventListener('pointerup', function (e) {
    if (!charSwipe) return;
    var s = charSwipe; charSwipe = null;
    if (charEditing) return;
    var dx = e.clientX - s.x, dy = e.clientY - s.y, dt = Date.now() - s.t;
    if (dt < 600 && Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 2) {
      charGo(dx < 0 ? 1 : -1);
    }
  });

  /* ---------- 落笔放映：整部作品按原节奏依次重演 ---------- */
  var inkplayPad = null, inkplayActive = false, inkplayLiveMusic = false, inkplayCancel = null;

  function startInkplayLiveMusic() {
    // 没有录音时：现场生成写字时的同一套音乐
    try {
      if (!state.musicOn) { music.start(); state.musicOn = true; inkplayLiveMusic = true; }
      music.setAudible(true);
    } catch (e) {}
  }

  function openInkPlay() {
    var byPos = state.workCharsByPos || {};
    var full = state.fullChars || state.chars || [];
    var queue = [];
    for (var i = 0; i < full.length; i++) if (byPos[i]) queue.push(i);
    if (!queue.length) { alert('还没有写完的字'); return; }
    // 舞台按书写时的宽高比定尺寸——先定尺寸、显示，再建 pad 并 _resize，
    // 否则 backing store 与 CSS 对不上会被拉伸变形
    var firstRec = (byPos[queue[0]] && byPos[queue[0]].strokes) || {};
    var ar = firstRec.ar || (window.innerWidth / window.innerHeight) || 0.5;
    sizePlayStage($('inkplay-stage'), ar, Math.min(window.innerWidth * 0.94, 480), window.innerHeight * 0.62);
    $('inkplay-overlay').classList.remove('hidden');
    if (!inkplayPad) inkplayPad = new WritingPad($('inkplay-paper'), $('inkplay-ink'), {});
    else inkplayPad._resize();
    inkplayPad.setFont(state.font.stack);
    inkplayActive = true;
    // 声音：优先放写字时录下的音乐；没有录音则现场生成
    try {
      var au = $('workview-audio');
      var w = state.workData && state.workData.work;
      if (w && w.has_audio && au && au.src) {
        try { au.currentTime = 0; } catch (e0) {}
        var p = au.play();
        if (p && p.catch) p.catch(function () { startInkplayLiveMusic(); });
      } else {
        startInkplayLiveMusic();
      }
    } catch (e) { startInkplayLiveMusic(); }
    var idx = 0;
    var step = function () {
      if (!inkplayActive) return;
      if (idx >= queue.length) {
        $('inkplay-label').textContent = '放映结束 · 共 ' + queue.length + ' 字';
        inkplayActive = false;
        return;
      }
      var pos = queue[idx++];
      var ch = full[pos];
      var saved = byPos[pos];
      $('inkplay-label').textContent = '第 ' + (pos + 1) + ' 字 · ' + ch + '（' + idx + '/' + queue.length + '）';
      inkplayCancel = playOneChar(inkplayPad, ch, saved, step);
    };
    step();
  }

  function closeInkPlay() {
    inkplayActive = false;
    if (inkplayCancel) { inkplayCancel(); inkplayCancel = null; }
    try { var au = $('workview-audio'); if (au) au.pause(); } catch (e) {}
    if (inkplayLiveMusic) {
      // 现场音乐是我们开的，关掉并还原
      inkplayLiveMusic = false;
      try { music.setAudible(false); } catch (e) {}
      try { if (state.musicOn) { music.stop(); state.musicOn = false; } } catch (e2) {}
    }
    $('inkplay-overlay').classList.add('hidden');
  }
  $('btn-inkplay-close').addEventListener('click', closeInkPlay);

  /* ---------- 分享链接直达：#w=123&share=xxx ---------- */
  (function () {
    var m = location.hash.match(/#w=(\d+)(?:&share=([^&]+))?/);
    if (m) {
      setTimeout(function () { openWork(m[1], m[2]); }, 600);
    }
  })();

  /* ---------- 12. 分享 ---------- */
  function shareWork() {
    var title = state.sutra ? '《' + state.sutra.title + '》' : '抄经';
    var text = '我在抄' + title + '，已写 ' + state.workImages.length + ' 字，一起来静心。';
    var url = location.origin + '/#sutra-' + (state.sutra ? state.sutra.id : '');
    if (navigator.share) {
      navigator.share({ title: title, text: text, url: url }).catch(function () {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text + ' ' + url).then(function () {
        alert('分享链接已复制');
      });
    } else {
      prompt('复制分享链接：', url);
    }
  }
})();
