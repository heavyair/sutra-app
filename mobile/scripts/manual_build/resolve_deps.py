#!/usr/bin/env python3
"""手工 Maven 依赖解析（替代 Gradle）：递归读 POM，下载 AAR/JAR 到 .deps/。

用法: python3 resolve_deps.py
输出: mobile/.deps/{aar,jar}/... + deps.json（坐标清单）
注意: 不需要 Gradle，不起 daemon，不碰 127.0.0.1。
"""
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))          # .../mobile/scripts/manual_build
MOBILE = os.path.dirname(os.path.dirname(HERE))            # .../mobile
DEPS = os.path.join(MOBILE, ".deps")

REPOS = [
    "https://dl.google.com/dl/android/maven2/",
    "https://maven-central.storage-download.googleapis.com/maven2/",
    "https://repo.maven.apache.org/maven2/",
    "https://repo1.maven.org/maven2/",
]

# 根依赖（app + capacitor 6.2.2 的 implementation）
ROOTS = [
    "androidx.appcompat:appcompat:1.6.1",
    "androidx.core:core:1.12.0",
    "androidx.activity:activity:1.8.0",
    "androidx.fragment:fragment:1.6.2",
    "androidx.coordinatorlayout:coordinatorlayout:1.2.0",
    "androidx.webkit:webkit:1.9.0",
    "androidx.core:core-splashscreen:1.0.1",
    "org.apache.cordova:framework:10.1.1",
    "org.jetbrains.kotlin:kotlin-stdlib:1.9.10",
    # 注：kotlin-stdlib-jdk7/jdk8 在 1.9.x 已是空壳（类已并入 stdlib），不需要
]

# 版本强制覆盖（教训：androidx.annotation 1.6.0 的 jar 在 Google Maven 是空壳）
VERSION_OVERRIDE = {
    "androidx.annotation:annotation": "1.5.0",
}

_pom_cache = {}


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "muse-manual-build"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def coord_path(group, artifact, version, ext):
    return "/".join([group.replace(".", "/"), artifact, version,
                      "%s-%s.%s" % (artifact, version, ext)])


def get_pom(group, artifact, version):
    key = (group, artifact, version)
    if key in _pom_cache:
        return _pom_cache[key]
    last = None
    for repo in REPOS:
        url = repo + coord_path(group, artifact, version, "pom")
        try:
            data = fetch(url)
            _pom_cache[key] = data
            return data
        except Exception as e:
            last = e
    raise RuntimeError("POM 下载失败 %s:%s:%s (%s)" % (group, artifact, version, last))


def ns_tag(el):
    return el.tag.split("}", 1)[1] if "}" in el.tag else el.tag


def children(el, name):
    return [c for c in el if ns_tag(c) == name]


def text_of(el, name):
    for c in children(el, name):
        return (c.text or "").strip()
    return ""


def parse_pom(data):
    root = ET.fromstring(data)
    info = {
        "group": text_of(root, "groupId"),
        "artifact": text_of(root, "artifactId"),
        "version": text_of(root, "version"),
        "packaging": text_of(root, "packaging") or "jar",
        "parent": None,
        "props": {},
        "depman": {},   # dependencyManagement: (g,a) -> version
        "deps": [],     # (g,a,v,type,scope,optional,exclusions)
    }
    for p in children(root, "parent"):
        info["parent"] = (text_of(p, "groupId"), text_of(p, "artifactId"), text_of(p, "version"))
    for props in children(root, "properties"):
        for c in props:
            info["props"][ns_tag(c)] = (c.text or "").strip()
    for dm in children(root, "dependencyManagement"):
        for ds in children(dm, "dependencies"):
            for d in children(ds, "dependency"):
                g, a = text_of(d, "groupId"), text_of(d, "artifactId")
                v = text_of(d, "version")
                if g and a and v:
                    info["depman"][(g, a)] = v
    for ds in children(root, "dependencies"):
        for d in children(ds, "dependency"):
            g, a = text_of(d, "groupId"), text_of(d, "artifactId")
            if not g or not a:
                continue
            v = text_of(d, "version")
            t = text_of(d, "type") or "jar"
            scope = text_of(d, "scope") or "compile"
            opt = text_of(d, "optional") == "true"
            excl = set()
            for exs in children(d, "exclusions"):
                for x in children(exs, "exclusion"):
                    excl.add((text_of(x, "groupId"), text_of(x, "artifactId")))
            info["deps"].append((g, a, v, t, scope, opt, excl))
    return info


def merged_props(group, artifact, version, seen=None):
    """合并祖先 POM 的 properties（子覆盖父）。"""
    seen = seen or set()
    props = {}
    stack = []
    g, a, v = group, artifact, version
    while (g, a, v) not in seen:
        seen.add((g, a, v))
        try:
            info = parse_pom(get_pom(g, a, v))
        except Exception:
            break
        stack.append(info)
        if not info["parent"]:
            break
        g, a, v = info["parent"]
    for info in reversed(stack):
        props.update(info["props"])
    return props, stack[0] if stack else None


_sub_re = re.compile(r"\$\{([^}]+)\}")


def subst(s, props, info):
    def rep(m):
        k = m.group(1)
        if k == "project.version":
            return info["version"] or ""
        return props.get(k, m.group(0))
    prev = None
    while prev != s:
        prev = s
        s = _sub_re.sub(rep, s)
    return s


def max_version_from_metadata(group, artifact):
    last = None
    for repo in REPOS:
        url = repo + "/".join([group.replace(".", "/"), artifact, "maven-metadata.xml"])
        try:
            data = fetch(url)
            root = ET.fromstring(data)
            vers = [c.text.strip() for v in children(root, "versioning")
                    for c in children(v, "versions") for c in children(c, "version")]
            vers = [x for x in vers if x and not x.endswith("-SNAPSHOT")]
            if vers:
                return sorted(vers)[-1]
        except Exception as e:
            last = e
    raise RuntimeError("取不到版本列表 %s:%s (%s)" % (group, artifact, last))


def resolve_version(v):
    # 版本区间 [1.2,) 取上界；( ,2.0] 取下界
    v = v.strip()
    if v.startswith("[") or v.startswith("("):
        inner = v[1:-1]
        lo, _, hi = inner.partition(",")
        return hi.strip() or lo.strip()
    return v


def download_artifact(group, artifact, version, prefer_aar):
    """返回 (本地路径, 类型)。AAR 优先，失败回落 JAR。"""
    dest_dir = os.path.join(DEPS, "aar" if prefer_aar else "jar",
                            group, artifact, version)
    os.makedirs(dest_dir, exist_ok=True)
    for ext in (["aar", "jar"] if prefer_aar else ["jar", "aar"]):
        dest = os.path.join(dest_dir, "%s-%s.%s" % (artifact, version, ext))
        if os.path.exists(dest) and os.path.getsize(dest) > 1024:
            return dest, ext
        for repo in REPOS:
            url = repo + coord_path(group, artifact, version, ext)
            try:
                data = fetch(url)
                if len(data) < 1024:
                    continue
                with open(dest, "wb") as f:
                    f.write(data)
                return dest, ext
            except Exception:
                continue
    raise RuntimeError("构件下载失败 %s:%s:%s" % (group, artifact, version))


def main():
    os.makedirs(DEPS, exist_ok=True)
    resolved = {}   # (g,a) -> (version, path, kind)
    queue = list(ROOTS)
    while queue:
        coord = queue.pop(0)
        g, a, v = coord.split(":")
        key = (g, a)
        ov = VERSION_OVERRIDE.get("%s:%s" % (g, a))
        if ov:
            v = ov
        if key in resolved:
            continue
        v = resolve_version(v)
        if v.startswith("[") or v.startswith("(") or not v:
            v = max_version_from_metadata(g, a)
        props, info = merged_props(g, a, v)
        info = info or parse_pom(get_pom(g, a, v))
        if not info["group"]:
            info["group"] = g
        real_v = info["version"] or v
        # packaging=aar 的一律按 aar 取；jar 的取 jar
        prefer_aar = (info["packaging"] == "aar")
        path, kind = download_artifact(g, a, real_v, prefer_aar)
        resolved[key] = (real_v, path, kind)
        print("OK %s:%s:%s [%s]" % (g, a, real_v, kind))
        # 子依赖入队（BFS，先到先得 = 最近优先）
        for (dg, da, dv, dt, scope, opt, excl) in info["deps"]:
            if opt or scope not in ("compile", "runtime"):
                continue
            if (dg, da) in excl:
                continue
            dg = subst(dg, props, info)
            da = subst(da, props, info)
            dv = subst(dv, props, info) if dv else subst(
                info["depman"].get((dg, da), ""), props, info)
            if not dv:
                continue
            if (dg, da) not in resolved and not any(
                    q.split(":")[0] == dg and q.split(":")[1] == da for q in queue):
                queue.append("%s:%s:%s" % (dg, da, dv))
    import json
    manifest = [{"group": g, "artifact": a, "version": v, "path": p, "kind": k}
                for (g, a), (v, p, k) in sorted(resolved.items())]
    with open(os.path.join(DEPS, "deps.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    print("\n共 %d 个构件 -> %s" % (len(manifest), DEPS))


if __name__ == "__main__":
    main()
