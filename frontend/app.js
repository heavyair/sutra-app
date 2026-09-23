/* 抄经应用 · 主逻辑（无构建、原生 JS） */
(function () {
  'use strict';

  var state = {
    sutra: null,          // 当前经文详情
    chars: [],            // 经文字符数组（用于临摹推进）
    charIndex: 0,
    filter: 'all',
    musicOn: false,
  };

  var music = new MusicEngine();
  var pad = null;

  function $(id) { return document.getElementById(id); }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(function (s) {
      s.classList.toggle('active', s.id === id);
    });
    window.scrollTo(0, 0);
  }

  function api(path, opts) {
    return fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
    }, opts || {})).then(function (r) { return r.json(); });
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
        loadLibrary();
        showScreen('screen-library');
      } else {
        msg.textContent = res.message || '验证失败';
      }
    }).catch(function () {
      msg.textContent = '网络错误，请重试';
    });
  });

  // 已验证过则跳过推荐码页
  try {
    if (localStorage.getItem('sutra_invite')) {
      loadLibrary();
      showScreen('screen-library');
    }
  } catch (e) {}

  /* ---------- 2. 经文库 ---------- */
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

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------- 3. 读经 / 抄经 ---------- */
  function openSutra(id) {
    api('/api/sutra/' + encodeURIComponent(id)).then(function (res) {
      if (!res.ok) return;
      state.sutra = res.sutra;
      state.chars = (res.sutra.full_text || '').replace(/\s+/g, '').split('');
      state.charIndex = 0;

      $('copy-title').textContent = res.sutra.title;
      $('like-count').textContent = res.sutra.like_count || 0;
      $('btn-like').classList.remove('liked');

      if (!pad) {
        pad = new WritingPad($('writing-canvas'), {
          onStrokeEnd: function () { /* 每笔回调：后续可接笔顺校验 */ },
        });
      }
      pad.clear();
      pad.setTraceChar(state.chars[0] || '　');
      updateProgress();

      // 按经文配置启动生成式音乐
      music.setConfig(res.sutra.music_config || {});
      if (state.musicOn) music.stop();
      music.start();
      state.musicOn = true;
      $('btn-music-toggle').textContent = '♪';

      showScreen('screen-copy');
    });
  }

  function updateProgress() {
    var total = state.chars.length || 1;
    var p = Math.min(1, state.charIndex / total);
    $('progress-bar').style.width = Math.round(p * 100) + '%';
    $('progress-text').textContent = Math.round(p * 100) + '%';
    music.setProgress(p);   // 音乐随抄写进度加层
  }

  $('btn-back-lib').addEventListener('click', function () {
    showScreen('screen-library');
  });

  $('btn-music-toggle').addEventListener('click', function () {
    var on = music.toggle();
    state.musicOn = on;
    this.textContent = on ? '♪' : '∅';
  });

  document.querySelectorAll('.brush').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.brush').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      if (pad) pad.setBrush(b.dataset.brush);
    });
  });

  $('btn-clear').addEventListener('click', function () {
    if (pad) pad.clear();
  });

  $('btn-next-char').addEventListener('click', function () {
    if (!state.chars.length) return;
    state.charIndex = Math.min(state.chars.length - 1, state.charIndex + 1);
    if (pad) { pad.clear(); pad.setTraceChar(state.chars[state.charIndex]); }
    updateProgress();
  });

  $('btn-like').addEventListener('click', function () {
    if (!state.sutra) return;
    var btn = this;
    api('/api/like', {
      method: 'POST',
      body: JSON.stringify({ sutra_id: state.sutra.id }),
    }).then(function (res) {
      if (res.ok) {
        btn.classList.add('liked');
        var n = $('like-count');
        n.textContent = parseInt(n.textContent || '0', 10) + 1;
      }
    });
  });

  $('btn-share').addEventListener('click', function () {
    if (!state.sutra) return;
    var url = location.origin + '/#sutra-' + state.sutra.id;
    var text = '我在抄《' + state.sutra.title + '》，一起来静心。';
    if (navigator.share) {
      navigator.share({ title: state.sutra.title, text: text, url: url }).catch(function () {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text + ' ' + url).then(function () {
        alert('分享链接已复制');
      });
    } else {
      prompt('复制分享链接：', url);
    }
  });

  /* ---------- 4. 评论区 ---------- */
  $('btn-comments').addEventListener('click', function () {
    if (!state.sutra) return;
    loadComments();
    showScreen('screen-comments');
  });

  $('btn-back-copy').addEventListener('click', function () {
    showScreen('screen-copy');
  });

  function loadComments() {
    api('/api/comments?sutra_id=' + encodeURIComponent(state.sutra.id)).then(function (res) {
      var list = $('comment-list');
      list.innerHTML = '';
      (res.comments || []).forEach(function (c) {
        var li = document.createElement('li');
        var kindLabel = { text: '文字', audio: '音频', image: '图片', video: '视频' }[c.kind] || c.kind;
        var html = '<span class="comment-kind">[' + kindLabel + ']</span>';
        if (c.kind === 'text') {
          html += escapeHtml(c.body || '');
        } else if (c.kind === 'audio') {
          html += '<audio controls src="' + escapeHtml(c.file_url || '') + '"></audio>';
        } else if (c.kind === 'image') {
          html += '<img src="' + escapeHtml(c.file_url || '') + '" alt="评论图片">';
        } else if (c.kind === 'video') {
          html += '<video controls src="' + escapeHtml(c.file_url || '') + '"></video>';
        }
        li.innerHTML = html;
        list.appendChild(li);
      });
      if (!res.comments || !res.comments.length) {
        list.innerHTML = '<li>还没有留言，来做第一个吧。</li>';
      }
    });
  }

  function postComment(kind, body, fileUrl) {
    api('/api/comments', {
      method: 'POST',
      body: JSON.stringify({
        sutra_id: state.sutra.id,
        kind: kind,
        body: body || '',
        file_url: fileUrl || '',
      }),
    }).then(function (res) {
      if (res.ok) {
        $('comment-input').value = '';
        loadComments();
      }
    });
  }

  $('btn-send-comment').addEventListener('click', function () {
    var text = $('comment-input').value.trim();
    if (!text || !state.sutra) return;
    postComment('text', text, '');
  });

  // 音/图/视频：选文件 → 上传 → 以评论形式发布（音频录制后续接 MediaRecorder）
  var pendingKind = 'image';
  $('btn-pick-image').addEventListener('click', function () {
    pendingKind = 'image';
    var fi = $('file-input');
    fi.accept = 'image/*';
    fi.click();
  });
  $('btn-pick-video').addEventListener('click', function () {
    pendingKind = 'video';
    var fi = $('file-input');
    fi.accept = 'video/*';
    fi.click();
  });
  $('btn-record-audio').addEventListener('click', function () {
    pendingKind = 'audio';
    var fi = $('file-input');
    fi.accept = 'audio/*';
    fi.click();
  });
  $('file-input').addEventListener('change', function () {
    var file = this.files[0];
    if (!file || !state.sutra) return;
    var fd = new FormData();
    fd.append('file', file);
    fetch('/api/upload', { method: 'POST', body: fd })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.ok) postComment(pendingKind, '', res.url);
        else alert(res.message || '上传失败');
      })
      .catch(function () { alert('上传失败'); });
    this.value = '';
  });
})();
