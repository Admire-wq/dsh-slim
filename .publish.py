import base64, json, os, sys, urllib.request, urllib.error

TOKEN = os.environ["GH_TOKEN"]
OWNER = "Admire-wq"
REPO = "dsh-slim"
ROOT = r"F:\dsh-plugins\dsh-slim-oss"
DESC = "DSH (DeepSeek Harness) 会话一键瘦身插件：加号菜单删废话/去重合并，剪完自动重启"

def api(method, path, payload=None):
    url = "https://api.github.com" + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "token " + TOKEN)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "dsh-slim-publisher")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        return e.code, {"raw": body}

# 1. 建仓库
st, body = api("POST", "/user/repos", {
    "name": REPO, "description": DESC, "private": False,
    "has_issues": True, "has_wiki": False, "auto_init": False,
})
print("create repo:", st, body.get("full_name") or body.get("raw", "")[:200])

# 2. 上传文件
files = []
for dirpath, _, names in os.walk(ROOT):
    if ".git" in dirpath.split(os.sep):
        continue
    for n in names:
        p = os.path.join(dirpath, n)
        rel = os.path.relpath(p, ROOT).replace("\\", "/")
        files.append((rel, p))
files.sort()

ok = fail = 0
for rel, p in files:
    content = base64.b64encode(open(p, "rb").read()).decode()
    st, body = api("PUT", f"/repos/{OWNER}/{REPO}/contents/{rel}", {
        "message": f"add {rel}", "content": content, "branch": "main",
    })
    if st in (200, 201):
        ok += 1
    else:
        fail += 1
        print("  fail", rel, st, str(body)[:160])
print(f"uploaded {ok} files, failed {fail}")

# 3. 打标签
st, head = api("GET", f"/repos/{OWNER}/{REPO}/git/ref/heads/main")
sha = (head.get("object") or {}).get("sha")
if sha:
    st, body = api("POST", f"/repos/{OWNER}/{REPO}/git/refs", {"ref": "refs/tags/v1.0.0", "sha": sha})
    print("tag:", st, body.get("ref") or str(body)[:160])
else:
    print("no head sha:", head)

print("URL: https://github.com/%s/%s" % (OWNER, REPO))
