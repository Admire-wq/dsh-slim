import base64, json, os, sys, urllib.parse, urllib.request, urllib.error

TOKEN = os.environ["GT"]
OWNER = "admire-wq"
REPO = "dsh-slim"
ROOT = r"F:\dsh-plugins\dsh-slim-oss"
API = "https://gitee.com/api/v5"

def call(method, path, payload=None, query=None):
    url = API + path
    q = dict(query or {})
    q["access_token"] = TOKEN
    url += "?" + urllib.parse.urlencode(q)
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "dsh-slim-publisher")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, {"raw": e.read().decode(errors="replace")[:300]}

st, body = call("POST", "/user/repos", {
    "name": REPO,
    "description": "DSH (DeepSeek Harness) 会话一键瘦身插件：加号菜单删废话/去重合并，剪完自动重启",
    "private": False,
    "auto_init": False,
    "default_branch": "main",
})
print("create:", st, body.get("full_name") or str(body)[:200])

files = []
for dirpath, dirnames, names in os.walk(ROOT):
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
    st, body = call("POST", f"/repos/{OWNER}/{REPO}/contents/{urllib.parse.quote(rel)}", {
        "content": content, "message": f"add {rel}", "branch": "main",
    })
    if st in (200, 201):
        ok += 1
    else:
        fail += 1
        print("  fail", rel, st, str(body)[:160])
print(f"uploaded {ok}, failed {fail}")
print("URL: https://gitee.com/%s/%s" % (OWNER, REPO))
