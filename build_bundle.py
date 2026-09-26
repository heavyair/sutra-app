#!/usr/bin/env python3
"""把 frontend 打成单文件 bundle（供 App 热更新 /api/app/bundle 与 APK 内置页）。

- 内联 styles.css / music.js / writing.js / app.js（保持原有顺序）
- 在 <head> 注入热更新引导脚本（含构建版本号 __BUNDLE_V__）
- 外部 CDN 字体链接保持不动
- 输出 frontend/dist/bundle.html

每次改完前端、升完 ?v= 后跑一次；部署时一起 scp 到服务器。
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
FE = os.path.join(ROOT, "frontend")
DIST = os.path.join(FE, "dist")

BOOT_TMPL = """<script>
/* 热更新引导（构建注入）：本地 localStorage 有新版 bundle 则直接载入 */
(function(){
  var V = __V__;
  window.__BUNDLE_V__ = V;
  function g(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }
  function s(k,v){ try { localStorage.setItem(k,v); } catch(e){} }
  try {
    var sv = g('sutra_bundle_v');
    if (sv && parseInt(sv,10) > V && sv !== g('sutra_bundle_bad')) {
      var tk = 'sutra_bundle_try_' + sv;
      var n = (parseInt(g(tk)||'0',10)||0) + 1;
      if (n > 3) { s('sutra_bundle_bad', sv); }
      else {
        s(tk, String(n));
        var html = g('sutra_bundle_html');
        if (html && html.indexOf('__BUNDLE_V__') >= 0) {
          document.open(); document.write(html); document.close();
          return;
        }
      }
    }
  } catch(e){}
})();
</script>
"""


def main():
    with open(os.path.join(FE, "index.html"), encoding="utf-8") as f:
        html = f.read()
    m = re.search(r"app\.js\?v=(\d+)", html)
    if not m:
        sys.exit("找不到版本号 app.js?v=N")
    v = m.group(1)

    with open(os.path.join(FE, "styles.css"), encoding="utf-8") as f:
        css = f.read()
    css = re.sub(r"</style", r"<\\/style", css, flags=re.I)

    js_parts = []
    for name in ["music.js", "writing.js", "app.js"]:
        with open(os.path.join(FE, name), encoding="utf-8") as f:
            code = f.read()
        # 内联进 <script> 时必须转义，防止提前闭合
        code = re.sub(r"</script", r"<\\/script", code, flags=re.I)
        js_parts.append((name, code))

    # 1) 注入引导脚本（charset 之后，保证前 1024 字节内仍有 charset 声明）
    boot = BOOT_TMPL.replace("__V__", v)
    if '<meta charset="UTF-8">' not in html:
        sys.exit("index.html 里找不到 <meta charset>")
    html = html.replace('<meta charset="UTF-8">',
                        '<meta charset="UTF-8">\n' + boot, 1)

    # 2) 内联 CSS
    html2, n = re.subn(r'<link rel="stylesheet" href="styles\.css\?v=\d+">',
                       "<style>\n/* inlined: styles.css */\n" + css + "\n</style>",
                       html, count=1)
    if n != 1:
        sys.exit("内联 styles.css 失败")
    html = html2

    # 3) 内联 JS（顺序：music, writing, app）
    def js_repl(mm):
        name = mm.group(1) + ".js"
        for n_, code in js_parts:
            if n_ == name:
                return "<script>\n/* inlined: %s */\n%s\n</script>" % (n_, code)
        return mm.group(0)

    html, n = re.subn(r'<script src="(music|writing|app)\.js\?v=\d+"></script>',
                      js_repl, html)
    if n != 3:
        sys.exit("内联 JS 失败，替换了 %d 处（应为 3）" % n)

    # 4) 兜底：不应再残留本地 css/js 引用
    leftover = re.findall(r'(?:src|href)="(?:styles|music|writing|app)\.[^"]*"', html)
    if leftover:
        sys.exit("内联失败，残留本地引用：%s" % leftover)

    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, "bundle.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print("bundle v%s -> %s (%d bytes)" % (v, out, os.path.getsize(out)))


if __name__ == "__main__":
    main()
