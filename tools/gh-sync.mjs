// 用 curl（走系统代理）调 GitHub Git Data API，一次提交把工作区同步到远端。
// 为什么不用 git push：国内直连 GitHub 经常被 reset，代理走 CONNECT 也常超时，而 curl 走同一个
// 代理却能稳定 200，所以把传输交给 curl，逻辑留在 node 里。
// 用法：node tools/gh-sync.mjs [--owner Admire-wq] [--repo dsh-slim] [--branch main] [--proxy http://127.0.0.1:17897]
import { readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const OWNER = flag("--owner", "Admire-wq");
const REPO = flag("--repo", "dsh-slim");
const BRANCH = flag("--branch", "main");
const PROXY = flag("--proxy", "http://127.0.0.1:17897");

const tokenCandidates = [process.env.GH_TOKEN, join(ROOT, ".gh-token"), join(dirname(ROOT), ".gh-token")].filter(Boolean);
let token = "";
for (const c of tokenCandidates) {
  if (existsSync(c)) { token = readFileSync(c, "utf8").trim(); break; }
  if (c === process.env.GH_TOKEN) { token = c; break; }
}
if (!token) throw new Error("没有 GH_TOKEN / .gh-token");

const SKIP = new Set([".git", "node_modules", ".gh-token", ".gitee-token", ".npm-token"]);
const SKIP_EXT = new Set([".log", ".tmp", ".tgz"]);
function walk(dir, base, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (!SKIP_EXT.has(e.name.slice(e.name.lastIndexOf(".")))) out.push(relative(base, p).replace(/\\/g, "/"));
  }
}
const files = [];
walk(ROOT, ROOT, files);

function api(method, path, body) {
  const argv = ["-sS", "--max-time", "60", "--http1.1", "--retry", "4", "--retry-delay", "2", "--retry-all-errors",
    "-x", PROXY, "-X", method,
    "-H", `Authorization: Bearer ${token}`,
    "-H", "Accept: application/vnd.github+json",
    "-H", "X-GitHub-Api-Version: 2022-11-28",
    `https://api.github.com${path}`];
  if (body !== undefined) {
    // body 可能上百 KB（base64 后的文件内容），不能走命令行参数（Windows 32KB 上限 → ENOBUFS），
    // 落到临时文件用 curl -d @file。
    const tmp = join(tmpdir(), `gh-sync-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(tmp, JSON.stringify(body));
    argv.push("-H", "Content-Type: application/json", "-d", `@${tmp}`);
    try {
      return runCurl(argv);
    } finally {
      try { unlinkSync(tmp); } catch { }
    }
  }
  return runCurl(argv);
}
function runCurl(argv) {
  const out = execFileSync("curl", argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (!out.trim()) return undefined;
  try { return JSON.parse(out); } catch { throw new Error(`非 JSON 响应: ${out.slice(0, 200)}`); }
}

console.log(`仓库 ${OWNER}/${REPO}@${BRANCH}，待同步 ${files.length} 个文件（curl 走 ${PROXY}）`);
const ref = api("GET", `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
const baseCommit = ref.object.sha;
const base = api("GET", `/repos/${OWNER}/${REPO}/git/commits/${baseCommit}`);
console.log(`base commit ${baseCommit.slice(0, 7)}`);

const tree = [];
for (const f of files) {
  const content = readFileSync(join(ROOT, f));
  const blob = api("POST", `/repos/${OWNER}/${REPO}/git/blobs`, { content: content.toString("base64"), encoding: "base64" });
  tree.push({ path: f, mode: "100644", type: "blob", sha: blob.sha });
  console.log(`  blob ${f}`);
}
const newTree = api("POST", `/repos/${OWNER}/${REPO}/git/trees`, { base_tree: base.tree.sha, tree });
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const commit = api("POST", `/repos/${OWNER}/${REPO}/git/commits`, {
  message: `chore(release): dsh-slim ${pkg.version} 同步（首帧单行 header / 孤儿 inbox splice / WMI 重启）`,
  tree: newTree.sha,
  parents: [baseCommit],
});
const updated = api("PATCH", `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
console.log(`✓ 已推送 ${updated.object.sha.slice(0, 7)} → https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`);
