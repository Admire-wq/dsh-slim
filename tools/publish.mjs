#!/usr/bin/env node
/**
 * publish.mjs —— 一条命令把本仓库同步到 GitHub + Gitee（没有 git 也能用，走 REST API）。
 *
 * 用法：
 *   node tools/publish.mjs                 # 同步文件（新增或覆盖）
 *   node tools/publish.mjs --ver 1.0.1     # 顺便把 package.json 版本号改成 1.0.1 再同步
 *   node tools/publish.mjs --only github   # 只发一个平台
 *
 * 令牌来源（二选一，不存在就跳过该平台）：
 *   环境变量 GH_TOKEN / GT
 *   或文件   <仓库同级>/.gh-token 、<仓库同级>/.gitee-token
 *
 * 依赖：Node ≥ 18（自带 fetch），无需 npm install。
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKIP = new Set(['.git', 'node_modules', '.gh-token', '.gitee-token']);
const SKIP_EXT = new Set(['.log', '.tmp']);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const only = flag('--only', 'all');
const version = flag('--ver', '');

function readToken(envName, fileName) {
  if (process.env[envName]) return process.env[envName].trim();
  const candidates = [join(ROOT, fileName), join(dirname(ROOT), fileName)];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  }
  return '';
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (!SKIP_EXT.has(extname(name)) && (!name.startsWith('.') || name === '.gitignore')) out.push(p);
  }
  return out;
}

async function api(base, token, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'dsh-slim-publish',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text || '{}'); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

async function ghApi(token, method, path, body) {
  return api('https://api.github.com', token, method, path, body);
}

async function giteeApi(token, method, path, body) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`https://gitee.com/api/v5${path}${sep}access_token=${encodeURIComponent(token)}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text || '{}'); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

async function pushGitHub(token, owner, repo, files) {
  let ok = 0, fail = 0;
  for (const p of files) {
    const rel = relative(ROOT, p).replace(/\\/g, '/');
    const content = Buffer.from(readFileSync(p)).toString('base64');
    const cur = await ghApi(token, 'GET', `/repos/${owner}/${repo}/contents/${rel}`);
    const sha = cur.json && cur.json.sha;
    const res = await ghApi(token, 'PUT', `/repos/${owner}/${repo}/contents/${rel}`, {
      message: `chore: sync ${rel}`, content, branch: 'main', ...(sha ? { sha } : {}),
    });
    res.status === 200 || res.status === 201 ? ok++ : (fail++, console.log('  ✗', rel, res.status));
  }
  return { ok, fail };
}

async function pushGitee(token, owner, repo, files) {
  let ok = 0, fail = 0;
  for (const p of files) {
    const rel = relative(ROOT, p).replace(/\\/g, '/');
    const content = Buffer.from(readFileSync(p)).toString('base64');
    const cur = await giteeApi(token, 'GET', `/repos/${owner}/${repo}/contents/${encodeURIComponent(rel)}`);
    const sha = cur.json && cur.json.sha;
    const res = sha
      ? await giteeApi(token, 'PUT', `/repos/${owner}/${repo}/contents/${encodeURIComponent(rel)}`, {
          content, message: `chore: sync ${rel}`, branch: 'main', sha,
        })
      : await giteeApi(token, 'POST', `/repos/${owner}/${repo}/contents/${encodeURIComponent(rel)}`, {
          content, message: `add ${rel}`, branch: 'main',
        });
    res.status === 200 || res.status === 201 ? ok++ : (fail++, console.log('  ✗', rel, res.status));
  }
  return { ok, fail };
}

if (version) {
  const pkgPath = join(ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`version → ${version}`);
}

const files = walk(ROOT).filter((p) => !p.endsWith('publish.mjs'));
console.log(`待同步 ${files.length} 个文件`);

const gh = readToken('GH_TOKEN', '.gh-token');
const gt = readToken('GT', '.gitee-token');

if (gh && only !== 'gitee') {
  const r = await pushGitHub(gh, 'Admire-wq', 'dsh-slim', files);
  console.log(`GitHub  ok=${r.ok} fail=${r.fail}  https://github.com/Admire-wq/dsh-slim`);
} else {
  console.log('GitHub 跳过（没有 GH_TOKEN / .gh-token）');
}

if (gt && only !== 'github') {
  const r = await pushGitee(gt, 'admire-wq', 'dsh-slim', files);
  console.log(`Gitee   ok=${r.ok} fail=${r.fail}  https://gitee.com/admire-wq/dsh-slim`);
} else {
  console.log('Gitee 跳过（没有 GT / .gitee-token）');
}
