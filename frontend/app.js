/* 抄经应用 · 主流程（无构建、原生 JS）
 *
 * 流程：推荐码 → 注册/登录（手机或邮箱）→ 经文库 → 选字体 → 开场（经名2秒 → 段落慢读高亮）→ 选笔 →
 *       全屏单字临摹（虚影字）→ 自动检测写成 → 缓缓隐藏 → 下一字 →
 *       全部写完 → 欣赏 / PDF / 分享
 * 工具（左下角 ☰）：经文 · 字体 · 笔 · 背景音 · 欣赏 · 分享（点开散布全屏）
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
    { id: 'pencil', name: '铅笔', desc: '细线起稿 · 默认' },
    { id: 'maobi', name: '毛笔', desc: '提按分明 · 随速变化' },
    { id: 'gangbi', name: '钢笔', desc: '流畅书写 · 粗细均匀' },
  ];

  var DONE_COVERAGE = 0.22;   // 覆盖虚影字多少判为写成
  var HINT_COVERAGE = 0.10;   // 出现"写好了"提示的阈值

  var state = {
    sutra: null,
    chars: [],
    charIndex: 0,
    filter: 'all',
    font: FONTS[0],
    pen: PENS[0],
    musicOn: false,
    workImages: [],
    flowToken: 0,
    completing: false,
  };

  var music = new MusicEngine();
  var pad = null;

  function $(id) { return document.getElementById(id); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(function (s) {
      s.classList.toggle('active', s.id === id);
    });
    window.scrollTo(0, 0);
  }

  function getToken() {
    try { return localStorage.getItem('sutra_token'); } catch (e) { return null; }
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    var token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
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
    $('auth-msg').textContent = '';
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

  $('btn-auth-submit').addEventListener('click', function () {
    var account = $('auth-account').value.trim();
    var password = $('auth-password').value;
    var msg = $('auth-msg');
    if (!account) { msg.textContent = authType === 'phone' ? '请输入手机号' : '请输入邮箱'; return; }
    if (password.length < 6) { msg.textContent = '密码至少 6 位'; return; }
    msg.textContent = authMode === 'register' ? '注册中…' : '登录中…';
    var path = authMode === 'register' ? '/api/register' : '/api/login';
    var body = { account: account, password: password };
    if (authMode === 'register') {
      body.account_type = authType;
      try { body.invite_code = localStorage.getItem('sutra_invite') || ''; } catch (e) {}
    }
    api(path, { method: 'POST', body: JSON.stringify(body), noAuthRedirect: true })
      .then(function (res) {
        if (res.ok && res.token) {
          try { localStorage.setItem('sutra_token', res.token); } catch (e) {}
          $('auth-password').value = '';
          loadLibrary();
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

  /* 启动：有 token 先校验 → 经文库；有推荐码 → 注册/登录；都没有 → 推荐码页 */
  (function boot() {
    var token = getToken();
    var code = null;
    try { code = localStorage.getItem('sutra_invite'); } catch (e) {}
    function enterAfterInvite() { showScreen(code ? 'screen-auth' : 'screen-invite'); }
    if (token) {
      api('/api/me', { noAuthRedirect: true }).then(function (res) {
        if (res.ok) { loadLibrary(); showScreen('screen-library'); }
        else {
          try { localStorage.removeItem('sutra_token'); } catch (e) {}
          enterAfterInvite();
        }
      }).catch(enterAfterInvite);
    } else {
      enterAfterInvite();
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
        li.addEventListener('click', function () { openSutra(s.id); });
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

  /* ---------- 4. 选经文 → 选字体 ---------- */
  function openSutra(id) {
    api('/api/sutra/' + encodeURIComponent(id)).then(function (res) {
      if (!res.ok) return;
      var chars = (res.sutra.full_text || '').replace(/\s+/g, '').split('');
      if (!chars.length) {
        alert('《' + res.sutra.title + '》全文待补充，敬请期待');
        return;
      }
      state.sutra = res.sutra;
      state.chars = chars;
      state.charIndex = 0;
      state.workImages = [];
      state.completing = false;
      state.flowToken++;
      renderFontCards($('font-cards'), state.font.id, function (f) { state.font = f; });
      music.setConfig(res.sutra.music_config || {});
      showScreen('screen-font');
    });
  }

  $('btn-back-lib2').addEventListener('click', function () {
    showScreen('screen-library');
  });

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

  $('btn-start-copy').addEventListener('click', function () {
    startWriting(state.flowToken);
  });

  /* ---------- 5. 开场：经名 2 秒 → 段落慢读高亮 → 选笔 ---------- */
  function firstParagraph(text) {
    var t = (text || '').replace(/\s+/g, '');
    var parts = t.split(/([。！？；\n])/);
    var out = '';
    for (var i = 0; i < parts.length && out.length < 36; i += 2) {
      out += parts[i] + (parts[i + 1] || '');
      if (/[。！？]/.test(parts[i + 1] || '')) break;
    }
    return out.slice(0, 36) || t.slice(0, 36);
  }

  function startWriting(token) {
    showScreen('screen-write');
    closeTools();
    hideOverlays();
    ensurePad();
    pad.setFont(state.font.stack);
    pad.setPen(state.pen.id);

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
      overlay.classList.remove('fading');
      titleEl.style.display = 'none';
      paraEl.style.display = '';

      // 段落逐字慢读高亮
      var para = firstParagraph(state.sutra.full_text);
      paraEl.innerHTML = '';
      var spans = para.split('').map(function (ch) {
        var sp = document.createElement('span');
        sp.textContent = ch;
        paraEl.appendChild(sp);
        return sp;
      });
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

      showPenPicker(true);                     // 首次选笔
    })();
  }

  /* ---------- 6. 选笔 ---------- */
  function renderPenCards() {
    var c = $('pen-cards');
    c.innerHTML = '';
    PENS.forEach(function (p) {
      var b = document.createElement('button');
      b.className = 'pick-card' + (p.id === state.pen.id ? ' selected' : '');
      b.innerHTML =
        '<span><span class="pick-name">' + p.name + '</span>' +
        '<span class="pick-desc" style="display:block">' + p.desc + '</span></span>';
      b.addEventListener('click', function () {
        c.querySelectorAll('.pick-card').forEach(function (x) { x.classList.remove('selected'); });
        b.classList.add('selected');
        state.pen = p;
        if (pad) pad.setPen(p.id);
      });
      c.appendChild(b);
    });
  }

  function showPenPicker(first) {
    renderPenCards();
    $('btn-pen-done').textContent = first ? '开始书写' : '确定';
    $('pen-picker').classList.remove('hidden');
    $('pen-picker').dataset.first = first ? '1' : '';
  }

  $('btn-pen-done').addEventListener('click', function () {
    var first = $('pen-picker').dataset.first === '1';
    $('pen-picker').classList.add('hidden');
    if (first) {
      // 开乐：用户手势链中，可直接启动 AudioContext
      if (!state.musicOn) { music.start(); state.musicOn = true; }
      beginChar();
    }
  });

  /* ---------- 7. 全屏单字临摹 ---------- */
  function ensurePad() {
    if (pad) return;
    pad = new WritingPad($('paper-canvas'), $('ink-canvas'), {
      onStrokeEnd: function (cov, n) {
        if (state.completing) return;
        // 最小运笔：超过字区最大边的一半（防误触），单笔画字也能通过
        var minLen = pad.bbox ? Math.max(pad.bbox.w, pad.bbox.h) * 0.5 : 60;
        if (cov >= DONE_COVERAGE && pad.inkLength > minLen) {
          charComplete();
        } else if (n >= 2 && cov >= HINT_COVERAGE) {
          $('btn-force-next').classList.remove('hidden');
        }
      },
    });
    // 长按不弹出菜单
    $('screen-write').addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function beginChar() {
    state.completing = false;
    $('btn-keep-editing').classList.add('hidden');
    $('btn-force-next').classList.add('hidden');
    var ch = state.chars[state.charIndex];
    // 确保 webfont 就绪后再画虚影字（带超时兜底，只执行一次）
    var called = false;
    var done = function () {
      if (called) return;
      called = true;
      pad.newChar(ch);
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

  function charComplete() {
    if (state.completing) return;
    state.completing = true;
    $('btn-force-next').classList.add('hidden');
    var img = pad.snapshot();
    state.workImages.push(img);
    updateProgress();

    // 缓缓隐藏，同时给"继续改写"
    $('btn-keep-editing').classList.remove('hidden');
    pad.fadeOut(1700, function () {
      if (!state.completing) return; // 被"继续改写"中断
      $('btn-keep-editing').classList.add('hidden');
      state.charIndex++;
      if (state.charIndex >= state.chars.length) {
        showDone();
      } else {
        beginChar();
      }
    });
  }

  $('btn-force-next').addEventListener('click', function () {
    charComplete();
  });

  $('btn-keep-editing').addEventListener('click', function () {
    state.completing = false;
    state.workImages.pop(); // 丢弃刚收录的成品
    pad.cancelFade();
    $('btn-keep-editing').classList.add('hidden');
    updateProgress();
  });

  // 橡皮：一下清空重写（若在"缓缓隐藏"中点橡皮，视同继续改写）
  $('btn-eraser').addEventListener('click', function () {
    if (!pad) return;
    if (state.completing) {
      state.completing = false;
      state.workImages.pop();
      updateProgress();
    }
    pad.cancelFade();
    pad.clearInk();
    $('btn-keep-editing').classList.add('hidden');
    $('btn-force-next').classList.add('hidden');
  });

  function updateProgress() {
    var p = state.chars.length ? state.workImages.length / state.chars.length : 0;
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
        showScreen('screen-library');
      } else if (t === 'font') {
        renderFontCards($('font-cards-2'), state.font.id, function (f) {
          state.font = f;
          if (pad) pad.setFont(f.stack);
        });
        $('font-overlay').classList.remove('hidden');
      } else if (t === 'pen') {
        showPenPicker(false);
      } else if (t === 'music') {
        var on = music.toggle();
        state.musicOn = on;
        b.classList.toggle('off', !on);
      } else if (t === 'view') {
        openAppreciate();
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
    ['pen-picker', 'font-overlay', 'done-overlay'].forEach(function (id) {
      $(id).classList.add('hidden');
    });
    $('intro-overlay').classList.add('hidden');
  }

  /* ---------- 9. 全部写完 ---------- */
  function showDone() {
    var d = new Date();
    $('done-summary').textContent =
      '《' + state.sutra.title + '》 · 共 ' + state.chars.length + ' 字 · ' +
      d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
    $('done-overlay').classList.remove('hidden');
  }

  $('btn-done-view').addEventListener('click', function () {
    $('done-overlay').classList.add('hidden');
    openAppreciate();
  });
  $('btn-done-lib').addEventListener('click', function () {
    state.flowToken++;
    if (state.musicOn) { music.stop(); state.musicOn = false; }
    showScreen('screen-library');
  });
  $('btn-done-pdf').addEventListener('click', printWork);
  $('btn-done-share').addEventListener('click', shareWork);

  /* ---------- 10. 欣赏 ---------- */
  function openAppreciate() {
    $('work-title').textContent = state.sutra ? '《' + state.sutra.title + '》' : '';
    var d = new Date();
    $('work-meta').textContent =
      '已抄 ' + state.workImages.length + ' / ' + state.chars.length + ' 字 · ' +
      d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    var sheet = $('work-sheet');
    sheet.innerHTML = '';
    if (!state.workImages.length) {
      sheet.innerHTML = '<div class="work-empty">还没有写完的字，回去继续吧。</div>';
    } else {
      state.workImages.forEach(function (src) {
        if (!src) return;
        var div = document.createElement('div');
        div.className = 'work-char';
        var img = document.createElement('img');
        img.src = src;
        div.appendChild(img);
        sheet.appendChild(div);
      });
    }
    showScreen('screen-appreciate');
  }

  $('btn-back-write').addEventListener('click', function () {
    showScreen('screen-write');
  });
  $('btn-work-pdf').addEventListener('click', printWork);
  $('btn-work-share').addEventListener('click', shareWork);

  /* ---------- 11. 生成 PDF（系统打印 → 存为 PDF） ---------- */
  function buildPrintSheet() {
    var ps = $('print-sheet');
    var d = new Date();
    var html = '<h1>抄经作品</h1>' +
      '<div class="print-meta">《' + escapeHtml(state.sutra ? state.sutra.title : '') + '》 · ' +
      state.workImages.length + ' 字 · ' +
      d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + '</div>' +
      '<div class="print-grid">';
    state.workImages.forEach(function (src) {
      if (src) html += '<img src="' + src + '">';
    });
    ps.innerHTML = html + '</div>';
  }

  function printWork() {
    if (!state.workImages.length) { alert('还没有写完的字'); return; }
    buildPrintSheet();
    setTimeout(function () { window.print(); }, 300);
  }

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
