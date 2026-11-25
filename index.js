/**
 * dsh-slim —— 加号菜单里的一键/按需精简会话。
 *
 * 两种入口：
 *   /slim      → 弹输入框，主人自己写要求（留几轮 / 留哪几轮 / 删哪几轮）
 *   /slimmerge → 登记合并待办：按主题去重、经验合到一起（下一轮自动执行）
 *
 * 为什么要先关 DSH：会话是严格校验的事件流，剪完以后如果 DSH 进程里还留着
 * 旧 cursor，下一次追加就会写出 seq 断层（历史加载失败）。所以流程是
 *   命令落在会话日志里（command/run、command/done）
 *   → 先干跑一遍算出会删几轮，没得删就直接返回不折腾
 *   → 等 4 秒让日志落盘
 *   → 杀掉 DSH 进程树（conhost / bash / qq-bridge 在白名单里，永不碰）
 *   → DSH 已经死了，这时剪文件不会被覆盖
 *   → 按桌面快捷方式把 DSH 重新拉起来
 * 真正的杀/剪/重启由 F:\dsh-plugins\restart-dsh.ps1 完成（带 WMI 自我搬迁）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 路径全部可用环境变量覆盖；默认值相对本包位置推导，不含任何本机用户名或盘符。
const HERE = dirname(fileURLToPath(import.meta.url));
const RESTART_SCRIPT = process.env.DSH_PRUNE_RESTART || join(HERE, 'tools', 'restart-dsh.ps1');
const PRUNE_CLI = process.env.DSH_PRUNE_CLI || join(HERE, 'tools', 'dsh-prune.mjs');
const NODE_EXE = process.env.DSH_PRUNE_NODE || process.execPath;
const WORK_DIR = process.env.DSH_PRUNE_WORKDIR || join(tmpdir(), 'dsh-slim');
const POWERSHELL = 'powershell.exe';
const DELAY_SECONDS = '4';
const DEFAULT_KEEP_RECENT = '12';

/**
 * 主人输入的这句话到底要哪种剪法。宽松解析：数字可以和说明写在同一句里。
 * 优先级：显式「删/留 + 轮次清单」 > 纯数字清单 > 句子里任意一个整数（当留最近 N 轮）> 自然语言。
 */
function planFromInput(raw) {
  const s = String(raw || '').trim();
  if (s === '') {
    return { args: ['--keep-recent', DEFAULT_KEEP_RECENT], label: `保留最近 ${DEFAULT_KEEP_RECENT} 轮 + 第 1 轮` };
  }
  const clean = (t) => t.replace(/[，、]/g, ',').replace(/\s+/g, '').replace(/[–—]/g, '-').replace(/,$/, '');

  // 1) 显式清单，允许夹在句子里
  let m = /(?:keep|保留|只留)\s*[:：]?\s*([0-9][0-9,，、\-–\s]*)/i.exec(s);
  if (m) {
    const spec = clean(m[1]);
    if (spec) return { args: ['--keep', spec], label: `只保留第 ${spec} 轮` };
  }
  m = /(?:drop|delete)\s*[:：]?\s*([0-9][0-9,，、\-–\s]*)/i.exec(s);
  if (m) {
    const spec = clean(m[1]);
    if (spec) return { args: ['--drop', spec], label: `删掉第 ${spec} 轮` };
  }
  m = /(?:删掉|删去|删除|去掉|去除|删)\s*[:：]?\s*([0-9][0-9,，、\-–\s]*)/.exec(s);
  if (m) {
    const spec = clean(m[1]);
    if (spec) return { args: ['--drop', spec], label: `删掉第 ${spec} 轮` };
  }

  // 2) 整句只有数字和分隔符 → 当成保留清单
  if (/^[0-9,，、\-–\s]+$/.test(s) && !/^\d+$/.test(s)) {
    return { args: ['--keep', clean(s)], label: `只保留第 ${clean(s)} 轮` };
  }

  // 3) 句子里任意一个独立整数 → 保留最近 N 轮（后面的说明当作主人的偏好，记住但不机械执行）
  m = /(?:^|[^\d])(\d{1,3})(?![\d])/.exec(s);
  if (m) {
    const n = m[1];
    const extra = s.replace(/(?:^|[^\d])\d{1,3}(?![\d])/, '').trim();
    return { args: ['--keep-recent', n], label: `保留最近 ${n} 轮 + 第 1 轮`, extra };
  }

  return null;
}

/** 一句话要求时用：先倒出每轮摘要，按形状挑出「废话轮」，算出要删哪几轮。 */
const NOISE_REPLY = /^(好了|好|行了|行|嗯|哦|成功了|成功|过期了|又过期了|那我扫码|那我扫|我扫|你继续|继续|开|可以了|怎么回事|ok|OK)[。！!~～？?\s]*$/;

function isJunkTurn(userText, tokens) {
  if (/^\[SCHEDULE REMINDER/i.test(userText)) return '定时提醒';
  const u = userText.replace(/^【当前时间】[^\n]*\n?/, '').trim();
  if (u === '') return '空轮';
  if (NOISE_REPLY.test(u)) return '单字回复';
  if (/(又)?过期了/.test(u) && u.length < 40) return '扫码过期';
  return null;
}

/** 纯过场：只有指令没有信息，删了不影响理解。 */
const PASS_REPLY = /^(你弄|你弄吧|弄吧|你继续|继续排|接着改|继续|继续画|接着画|打开看看|你打开看看|你看着办|你试试|那就弄)[。！!~～？?\s]*$/;

/** 把一句话切成可用于比较的词片（中文按 2 字滑窗，英文按单词）。 */
function shingles(text) {
  const t = text.replace(/\s+/g, '').toLowerCase();
  const out = new Set();
  for (const w of t.match(/[a-z][a-z0-9_]+|[\u4e00-\u9fa5]+/g) || []) {
    if (w.length <= 2) { out.add(w); continue; }
    for (let i = 0; i + 2 <= w.length; i++) out.add(w.slice(i, i + 2));
  }
  return out;
}
function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function autoPlan(sessionId) {
  const out = join(tmpdir(), `dsh-slim-digest-${Date.now()}.md`);
  const run = spawnSync(NODE_EXE, [PRUNE_CLI, 'digest', String(sessionId), '--all', '--out', out], {
    encoding: 'utf8', windowsHide: true, timeout: 180_000,
  });
  if (run.status !== 0 || !existsSync(out)) return null;
  const text = readFileSync(out, 'utf8');
  const blocks = text.split(/\n## 第 /).slice(1);
  const turns = [];
  for (const b of blocks) {
    const n = parseInt(b, 10);
    if (!Number.isFinite(n)) continue;
    const tokMatch = /~(\d+)\s*tok/.exec(b);
    const user = (b.split('USER:')[1] || '').split('ASSISTANT:')[0].trim();
    turns.push({ n, tokens: tokMatch ? Number(tokMatch[1]) : 0, user });
  }

  const drop = new Map();      // turn -> 原因
  for (const t of turns) {
    if (t.n === 1) continue;
    const u = t.user.replace(/^【当前时间】[^\n]*\n?/, '').trim();
    const junk = isJunkTurn(t.user, t.tokens);
    if (junk) { drop.set(t.n, junk); continue; }
    if (PASS_REPLY.test(u)) drop.set(t.n, '纯过场');
  }

  // 近似重复合并：只认「几乎是同一句话」的轮次，保留 token 更多的那条。
  // 语义层面的“同一主题”不做自动判断——实测关键词聚类会把不相干的轮并错。
  const alive = turns.filter((t) => !drop.has(t.n)).map((t) => ({ ...t, sig: shingles(t.user) }));
  const used = new Set();
  for (let i = 0; i < alive.length; i++) {
    if (used.has(alive[i].n)) continue;
    const cluster = [alive[i]];
    for (let j = i + 1; j < alive.length; j++) {
      if (used.has(alive[j].n)) continue;
      if (similarity(alive[i].sig, alive[j].sig) >= 0.75) { cluster.push(alive[j]); used.add(alive[j].n); }
    }
    if (cluster.length > 1) {
      cluster.sort((a, b) => b.tokens - a.tokens);
      for (const t of cluster.slice(1)) drop.set(t.n, `重复并入 #${cluster[0].n}`);
    }
  }

  const why = {};
  for (const r of drop.values()) { const k = r.replace(/\s*#\d+$/, ''); why[k] = (why[k] || 0) + 1; }
  const kept = turns.filter((t) => !drop.has(t.n)).reduce((s, t) => s + t.tokens, 0);
  return { total: turns.length, drop: [...drop.keys()].sort((a, b) => a - b), why, kept };
}

/** 先只读地算一遍：会删几轮、省多少 token。没得删就不重启。 */
function probe(agentId, args) {
  const result = spawnSync(NODE_EXE, [PRUNE_CLI, 'prune', String(agentId), ...args, '--dry-run'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  const drop = /删除\s*(\d+)\s*轮/.exec(out);
  const evt = /事件\s*(\d+)\s*→\s*(\d+)/.exec(out);
  const tok = /~(\d+)\s*→\s*~(\d+)\s*tokens/.exec(out);
  return {
    ok: result.status === 0 && /自检通过/.test(out),
    dropped: drop ? Number(drop[1]) : 0,
    before: tok ? Number(tok[1]) : undefined,
    after: tok ? Number(tok[2]) : undefined,
    events: evt ? `${evt[1]} → ${evt[2]}` : undefined,
    raw: out,
  };
}

function launch(agentId, pruneArgs) {
  if (!existsSync(RESTART_SCRIPT)) throw new Error(`找不到执行器 ${RESTART_SCRIPT}`);
  // 绝对不要加 detached:true：Windows 的 DETACHED_PROCESS 让 powershell 5.1 拿不到控制台，
  // 会立刻 exit 0 掉，脚本一行都不执行（2026-11-22 23:05 实测）。脱离进程树靠脚本自己的 WMI 搬迁。
  // 2026-11-25 实测：spawn 出去的重启器仍留在 Electron 的 job object 里，剪枝进程一退
  // job 关闭就把它带走，DSH 根本没重启（日志停在 STEP 1c）。改由 WMI 服务创建进程，
  // 父进程是 WmiPrvSE，不在 DSH 树里，杀树带不走它。
  const cmdLine = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${RESTART_SCRIPT}" -Force -DelaySeconds ${DELAY_SECONDS} -PruneSession "${agentId}" -PruneArgs "${pruneArgs}"`;
  const psCmd = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${cmdLine}'}; if ($r.ReturnValue -ne 0) { throw ('WMI create failed: ' + $r.ReturnValue) }; $r.ProcessId`;
  const launched = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  const outText = `${launched.stdout || ''}${launched.stderr || ''}`.trim();
  if (launched.status !== 0) throw new Error(outText || `powershell 退出码 ${launched.status}`);
  const pid = outText.split(/\s+/).filter(Boolean).pop();
  return pid;
}

function fmtTokens(n) {
  if (n === undefined) return '?';
  return n >= 10_000 ? `${(n / 10_000).toFixed(1)} 万` : String(n);
}

function runSlim(invocation, plan) {
  const sessionId = String(invocation.agent.id);
  const dry = probe(sessionId, plan.args);
  if (!dry.ok) {
    return { kind: 'error', text: `干跑算不出来，什么都没动。${dry.raw.slice(-160)}` };
  }
  if (dry.dropped === 0) {
    return { kind: 'success', text: '没有可删的轮次，不折腾 DSH。' };
  }
  let pid;
  try {
    pid = launch(sessionId, plan.args.join(' '));
  } catch (error) {
    return { kind: 'error', text: `没启动成：${error && error.message ? error.message : String(error)}` };
  }
  const note = plan.extra ? '（说明已记下）' : '';
  const head = plan.head || `删 ${dry.dropped} 轮`;
  // 回复里必须带换行：官方命令卡片只有在文本含 \n 时才给「展开/收起」，
  // 单行会被截成一行小字且展不开（2026-11-23 主人反馈）。
  const lines = [
    `${head}，${fmtTokens(dry.before)} → ${fmtTokens(dry.after)} token${note}`,
    plan.detail ? `明细：${plan.detail}` : `事件 ${dry.events}，备份留在会话文件旁边`,
    `${DELAY_SECONDS} 秒后关窗，剪完自动重开；不对就 safe-prune.mjs restore 回滚。`,
  ];
  return { kind: 'success', text: lines.join('\n') };
}

export const inject = ['commands'];

export function apply(ctx) {
  const custom = {
    name: 'slim',
    description: '按你的要求精简这个对话：直接写一句话（如「把废话删掉，有用的留着」），或写 12 / 保留 1,5,7-9 / 删 3,7-9',
    input: { hint: '一句话就行：把废话删掉、有用的留着 ／ 或写 12、删 3,7-9' },
    handler(invocation) {
      const plan = planFromInput(invocation.rawInput);
      if (plan !== null) return runSlim(invocation, plan);

      // 一句话要求：先倒摘要，按形状挑废话轮
      const auto = autoPlan(String(invocation.agent.id));
      if (!auto) return { kind: 'error', text: '倒摘要失败，什么都没动。' };
      if (auto.drop.length === 0) return { kind: 'success', text: `这条对话 ${auto.total} 轮里没找到废话轮，不用剪。` };
      const detail = Object.entries(auto.why).map(([k, v]) => `${k} ${v}`).join('、');
      return runSlim(invocation, {
        args: ['--drop', auto.drop.join(',')],
        label: `删 ${auto.drop.length} 轮废话`,
        head: `删 ${auto.drop.length} 轮废话`,
        detail,
      });
    },
  };

  // 路线 2：登记一条「合并」待办。真正的语义合并由 agent 下一轮执行。
  // 注意：AGENTS.md 是「每个工作区一份」，别的目录下的会话看不到本工作区那条规矩，
  // 所以这里把指令直接写进命令结果——它会作为历史消息出现在对话里，模型下一轮必然读到。
  const merge = {
    name: 'slimmerge',
    description: '合并精简这个对话：把重复的只留一份、经验和要求合到一起——先导摘要登记待办，下一轮自动执行',
    input: { hint: '可写一句要求（留空＝按主题去重、把经验合到一起、精度优先）' },
    handler(invocation) {
      const sid = String(invocation.agent.id);
      const dir = WORK_DIR;
      const digest = join(dir, `slim-digest-${sid}.md`);
      const pending = join(dir, `slim-pending-${sid}.json`);
      const run = spawnSync(NODE_EXE, [PRUNE_CLI, 'digest', sid, '--all', '--out', digest], {
        encoding: 'utf8', windowsHide: true, timeout: 180_000,
      });
      if (run.status !== 0 || !existsSync(digest)) {
        return { kind: 'error', text: '导摘要失败，什么都没登记。' };
      }
      const request = String(invocation.rawInput || '').trim()
        || '把重复的对话只保留一个，把经验和要求合到一起，精度优先';
      writeFileSync(pending, JSON.stringify({ sessionId: sid, request, digest, createdAt: Date.now() }, null, 2), 'utf8');
      return {
        kind: 'success',
        text: [
          `已登记合并任务：${request}`,
          `【待办｜下一个回话的模型必须最先做这件事】`,
          `1. 读 ${digest} 的逐轮摘要，按主题分组，同一件事只留信息最全那一轮；纯过场/定时提醒/单字回复直接删。`,
          `2. 把「保留哪几轮 / 删哪几轮」压成三行发给主人（带 token 前后值），确认后执行 node session-tools/dsh-prune.mjs prune ${sid} --keep 1,2,5… --restart（--restart 会在剪完后自动关掉并重开 DSH，不用主人动手）。`,
          `3. 被删轮次里的经验和要求抽成档案，再删掉 ${pending}。`,
          `4. 这件事做完之前，不要接着干别的活。`,
        ].join('\n'),
      };
    },
  };

  ctx.effect(() => {
    const disposers = [custom, merge].map((definition) => ctx.commands.register(definition));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'dsh-slim: commands');
}
