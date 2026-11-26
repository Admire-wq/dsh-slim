#!/usr/bin/env node
/**
 * dsh-prune —— DSH 会话历史精简器（按"轮"自主删除 & 压缩上下文）
 *
 * 为什么要"按轮"而不是按单条消息：
 *   DSH 的会话日志（session.vN.jsonl[.zstd]）不是聊天记录，而是一条严格校验的
 *   事件流。dsh-session-format 的加载器要求 seq 从 0 连续、turn/start 的 turn 编号
 *   从 1 连续、turn 内 step 从 1 连续、tool/call 与 tool/result 必须配对。
 *   随便删几行就会让会话打不开。删掉"完整的 turn"（turn/start…turn/end 之间全部
 *   事件）再重编号，是唯一既安全又能保住语义的粒度。
 *
 * 用法（推荐用 dsh 自带的 node，版本较新、带 zstd）：
 *   NODE="<node 可执行文件路径>"   # 需要带 zstd 支持的 Node ≥ 22
 *
 *   $NODE dsh-prune.mjs list                 # 列出所有会话（按修改时间倒序）
 *   $NODE dsh-prune.mjs show <会话id|目录>    # 看轮次表：第几轮、时间、用户说了啥、约多少 token
 *   $NODE dsh-prune.mjs prune <会话id> --drop 3,7-9 --dry-run   # 先空跑看结果
 *   $NODE dsh-prune.mjs prune <会话id> --drop 3,7-9             # 真删（自动备份）
 *   $NODE dsh-prune.mjs prune <会话id> --keep 1,2,5-8           # 反过来：只留这些轮
 *   $NODE dsh-prune.mjs restore <会话id>     # 从最近一次备份回滚
 *   $NODE dsh-prune.mjs export <会话id>      # 导出明文 JSONL，方便用记事本自己看
 *
 * 安全设计：
 *   1) 删前先跑内置校验器（seq 连续 / turn 连续 / step 连续 / tool 配对 / seq 引用可解析），
 *      校验不过就拒绝写盘。
 *   2) 写盘前把原文件复制成 session.vN.jsonl.zstd.prune-bak-<时间戳>，restore 一键回滚。
 *   3) 写入用 tmp + rename，断电也不会留下半个文件。
 *   4) 只改"存盘文件"。目标会话如果在 GUI 里还开着，请先切走/关掉，否则活会话会把内存里的
 *      旧历史重新 flush 覆盖上去。
 */

import { zstdDecompressSync, zstdCompressSync, constants as zconstants } from "node:zlib";
import {
  readFileSync, writeFileSync, renameSync, copyFileSync, readdirSync,
  statSync, existsSync, unlinkSync, openSync, closeSync, readSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

const DEFAULT_ROOT = join(homedir(), ".dsh", "sessions");
// 会话日志的代际文件名：session.v4.jsonl.zstd。读目录时按这个正则识别。
const LOG_RE = /^session\.v(\d+)\.jsonl(\.zstd)?$/;

/* ────────────────────────────── zstd 读写 ────────────────────────────── */

/**
 * DSH 的会话文件不是"一个 zstd 流"，而是**多个独立 zstd frame 顺序拼接**
 * （header 一帧 + 每次追加一批事件一帧）。Node 的 zstdDecompressSync 只解第一个
 * frame 且不报错 —— 整文件直接解压会静默丢 99% 的数据。
 * 所以必须照 dsh-session-persistence-jsonl 的 scanZstdFrames 自己扫帧边界。
 */
const ZSTD_MAGIC = 4247762216; // 0xFD2FB528，按小端读

function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`帧头魔数不对，不是 dsh 会话文件？字节 ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`帧头保留位非零，字节 ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`块类型保留值，字节 ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/** 逐帧解压并拼成完整明文；live 文件结尾的半帧用 ZSTD_e_flush 抢救，不丢已写好的部分。 */
function zstdDecode(buffer) {
  const { frames, tornStart } = scanZstdFrames(buffer);
  const parts = [];
  for (const { start, end } of frames) {
    parts.push(zstdDecompressSync(buffer.subarray(start, end)));
  }
  if (tornStart !== undefined) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(tornStart), { finishFlush: zconstants.ZSTD_e_flush }));
    } catch { /* 半帧抢救失败就丢掉尾巴：会话正在写，丢了也只是最后半条记录 */ }
  }
  return Buffer.concat(parts).toString("utf8");
}

/** 只读前几帧，用于快速读 header（list 时不必解压整个几 MB 的日志）。 */
function zstdDecodePrefix(buffer, maxFrames = 2) {
  const { frames } = scanZstdFrames(buffer, maxFrames);
  return Buffer.concat(frames.map(({ start, end }) => zstdDecompressSync(buffer.subarray(start, end)))).toString("utf8");
}

/** 压缩一个字符串为一帧 zstd，带校验和（与官方 CHECKSUM_OPTIONS 同口径）。 */
function zstdEncode(text) {
  const opts = zconstants.ZSTD_c_checksumFlag !== undefined
    ? { params: { [zconstants.ZSTD_c_checksumFlag]: 1 } }
    : {};
  return zstdCompressSync(Buffer.from(text, "utf8"), opts);
}

/* ────────────────────────────── 会话定位 ────────────────────────────── */

/** 把项目路径编码成 DSH 的目录名（与 dsh-session-persistence-jsonl 的 projectKey 同规则）。 */
function projectKey(cwd) {
  let readable = "";
  let sepRun = false;
  for (const ch of cwd) {
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!sepRun) readable += "-";
      sepRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      sepRun = false;
    } else {
      readable += "~" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
      sepRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** 列出 root 下所有会话目录。 */
function* walkSessions(root) {
  if (!existsSync(root)) return;
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectPath = join(root, project.name);
    for (const session of readdirSync(projectPath, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const dir = join(projectPath, session.name);
      const logs = readdirSync(dir).filter((f) => LOG_RE.test(f));
      if (logs.length === 0) continue;
      // 取版本号最高的那一代
      logs.sort((a, b) => Number(LOG_RE.exec(b)[1]) - Number(LOG_RE.exec(a)[1]));
      yield { project: project.name, session: session.name, dir, log: join(dir, logs[0]), file: logs[0] };
    }
  }
}

/** 用 id 或目录路径找到唯一的会话。 */
function resolveSession(target, root) {
  if (existsSync(target) && statSync(target).isDirectory()) {
    const logs = readdirSync(target).filter((f) => LOG_RE.test(f));
    if (logs.length === 0) throw new Error(`目录里没有会话日志: ${target}`);
    logs.sort((a, b) => Number(LOG_RE.exec(b)[1]) - Number(LOG_RE.exec(a)[1]));
    return { dir: target, log: join(target, logs[0]), file: logs[0] };
  }
  const tail = String(target).replace(/\\/g, "/").split("/").filter(Boolean).pop();
  const hits = [];
  for (const item of walkSessions(root)) {
    // 目录名可能是 session-<uuid>，也可能直接是 <uuid>；允许只给 uuid 的一部分
    if (item.session === tail || item.session.includes(tail)) hits.push(item);
  }
  if (hits.length === 0) throw new Error(`没找到会话: ${target}（root=${root}）`);
  if (hits.length > 1) {
    const exact = hits.filter((h) => h.session === tail);
    if (exact.length === 1) return exact[0];
    throw new Error(`匹配到 ${hits.length} 个会话，请给更长的 id 或直接给目录路径：\n${hits.map((h) => "  " + h.dir).join("\n")}`);
  }
  return hits[0];
}

/* ────────────────────────────── 日志解析 ────────────────────────────── */

async function readHeader(logPath) {
  const buf = readHeadBytes(logPath);
  if (logPath.endsWith(".zstd")) {
    const text = zstdDecodePrefix(buf, 2);
    const firstLine = text.split("\n")[0];
    if (!firstLine) throw new Error("读不到 header 行");
    return JSON.parse(firstLine);
  }
  const firstLine = buf.toString("utf8").split("\n")[0];
  return JSON.parse(firstLine);
}

/** 只读文件头部若干字节：list 几 MB 的会话时不必整文件读进来。 */
function readHeadBytes(path, limit = 1 << 16) {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const len = Math.min(size, limit);
    const buf = Buffer.alloc(len);
    const read = readSync(fd, buf, 0, len, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

async function readLog(logPath) {
  const buf = readFileSync(logPath);
  const text = logPath.endsWith(".zstd") ? zstdDecode(buf) : buf.toString("utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error("会话日志是空的");
  const header = JSON.parse(lines[0]);
  if (header.type !== "session") throw new Error(`首行不是 session header: ${lines[0].slice(0, 120)}`);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch (error) {
      throw new Error(`第 ${i + 1} 行不是合法 JSON: ${String(error)}`);
    }
    rows.push({ raw: lines[i], obj, lineNo: i + 1 });
  }
  return { header, rows, headerRaw: lines[0], baseSeq: rows.length ? (rows[0].obj.seq ?? 0) : 0 };
}

/* ────────────────────────────── 文本工具 ────────────────────────────── */

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (typeof block.text === "string") parts.push(block.text);
    else if (block.type === "tool-result" && typeof block.toolCallId === "string") parts.push("[tool-result]");
    else if (typeof block.type === "string") parts.push(`[${block.type}]`);
  }
  return parts.join(" ");
}

/** 只数不建字符串：给大段文本做 token 估算时省内存。 */
function countChars(text) {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)) cjk++;
    else other++;
  }
  return { cjk, other };
}

function tokensOfCounts({ cjk, other }) {
  return Math.ceil(cjk + other / 4);
}

function messageTextOf(obj) {
  // user/message: data 本身就是 message；其余消息事件在 data.message 里
  if (obj.type === "user/message") return contentText(obj.data?.content);
  if (obj.type === "assistant/message") return contentText(obj.data?.message?.content);
  if (obj.type === "tool/result") return contentText(obj.data?.message?.content);
  if (obj.type === "system/message" || obj.type === "developer/message") return contentText(obj.data?.message?.content);
  return "";
}

function clip(text, width) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : flat.slice(0, width - 1) + "…";
}

function fmtTime(ts) {
  if (typeof ts !== "number") return "        ";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ────────────────────────────── 轮次切分 ────────────────────────────── */

const COMPACTION_TYPES = new Set(["compaction/start", "compaction/summary", "compaction/end", "compaction/prune"]);

/**
 * 把事件流切成：preamble（第一轮之前的事件）+ 若干完整轮。
 * 有 turn/start 没有 turn/end 的轮（被打断/断线）closed=false，show 会标 ⚠未闭合；
 * prune 交给 validate 兜底，宁可不写也不写坏。
 */
function groupTurns(rows) {
  const preamble = [];
  const turns = [];
  let cur = null;
  for (let i = 0; i < rows.length; i++) {
    const obj = rows[i].obj;
    if (obj.type === "turn/start") {
      cur = { turn: obj.data?.turn, idx: [i], closed: false, startLine: rows[i].lineNo };
      turns.push(cur);
      continue;
    }
    if (cur) {
      cur.idx.push(i);
      if (obj.type === "turn/end") {
        cur.closed = true;
        cur = null;
      }
    } else {
      preamble.push(i);
    }
  }
  return { preamble, turns };
}

function turnSummary(rows, turn, listIndex) {
  let userText = "";
  let assistantText = "";
  let toolCalls = 0;
  let toolResults = 0;
  let cjk = 0;
  let other = 0;
  let firstTs;
  let lastTs;
  let hasCompaction = false;
  const add = (text) => {
    const c = countChars(text);
    cjk += c.cjk;
    other += c.other;
  };
  for (const i of turn.idx) {
    const obj = rows[i].obj;
    const when = typeof obj.time === "number" ? obj.time : obj.ts;
    if (typeof when === "number") {
      if (firstTs === undefined) firstTs = when;
      lastTs = when;
    }
    if (COMPACTION_TYPES.has(obj.type)) hasCompaction = true;
    if (obj.type === "user/message") {
      const t = messageTextOf(obj);
      add(t);
      if (!userText) userText = t;
    } else if (obj.type === "assistant/message") {
      const t = messageTextOf(obj);
      add(t);
      if (t.trim()) assistantText += (assistantText ? " " : "") + t;
    } else if (obj.type === "tool/result") {
      toolResults++;
      add(messageTextOf(obj));
    } else if (obj.type === "tool/call") {
      toolCalls++;
      add(String(obj.data?.arguments ?? ""));
    }
  }
  return {
    listIndex,
    turn: turn.turn,
    events: turn.idx.length,
    chars: cjk + other,
    tokens: tokensOfCounts({ cjk, other }),
    userText,
    assistantText,
    toolCalls,
    toolResults,
    hasCompaction,
    closed: turn.closed,
    firstTs,
    lastTs,
  };
}

/* ────────────────────────────── seq 引用重映射 ────────────────────────────── */

function applyRefRemap(obj, oldToNew) {
  // 返回被删掉的引用描述；调用方据此决定是否放弃该事件
  const lost = [];
  const data = obj.data;
  if (typeof obj.sourceEventSeq === "number") {
    const next = oldToNew.get(obj.sourceEventSeq);
    if (next === undefined) { delete obj.sourceEventSeq; lost.push("sourceEventSeq"); }
    else obj.sourceEventSeq = next;
  }
  if (Array.isArray(obj.sourceEventSeqs)) {
    // 注意：rewind/替换型 user-message 的 sourceEventSeqs 里会夹着区间数组，
    // 例如 [[999,1003], 1005, 1009]。这里一律**展开成去重后的单值列表**：
    //   ① 区间端点映射完可能塌成同一个数（1003→1004、1005→1004），官方加载器会报
    //      "duplicate sourceEventSeqs ranges must contain unique earlier seqs"；
    //   ② 官方只要求「唯一且都早于本事件的 seq」，不需要保留区间形状。
    // 2026-11-22 23:5x c9ec6015 打不开就是栽在 ① 上。
    const seen = new Set();
    const out = [];
    let lostOne = false;
    for (const s of obj.sourceEventSeqs) {
      const olds = Array.isArray(s)
        ? Array.from({ length: Math.max(0, s[s.length - 1] - s[0] + 1) }, (_, i) => s[0] + i)
        : [s];
      for (const oldSeq of olds) {
        const next = oldToNew.get(oldSeq);
        if (next === undefined) continue;          // 被删的引用直接跳过，不算丢失
        if (seen.has(next)) continue;
        seen.add(next);
        out.push(next);
      }
    }
    if (out.length === 0) { lost.push("sourceEventSeqs"); return { lost, fatal: true }; }
    out.sort((a, b) => a - b);
    const own = typeof obj.seq === "number" ? obj.seq : Infinity;
    if (out.some((v) => v >= own)) { lostOne = true; }
    if (lostOne) { lost.push("sourceEventSeqs"); return { lost, fatal: true }; }
    obj.sourceEventSeqs = out;
  }
  if (data && typeof data === "object") {
    for (const key of ["sourceEventSeq", "headerSeq", "checkpointSeq", "summarySeq", "startSeq", "endSeq", "baseSeq"]) {
      if (typeof data[key] !== "number") continue;
      const next = oldToNew.get(data[key]);
      if (next === undefined) { delete data[key]; lost.push(`data.${key}`); }
      else data[key] = next;
    }
    for (const key of ["sourceEventSeqs", "shadowedSeqs"]) {
      if (!Array.isArray(data[key])) continue;
      const mapped = data[key].map((s) => oldToNew.get(s));
      if (mapped.some((v) => v === undefined)) { delete data[key]; lost.push(`data.${key}`); }
      else data[key] = mapped;
    }
    if (data.shadowedRange && typeof data.shadowedRange === "object") {
      const s = oldToNew.get(data.shadowedRange.start);
      const e = oldToNew.get(data.shadowedRange.end);
      if (s === undefined || e === undefined) { delete data.shadowedRange; lost.push("data.shadowedRange"); }
      else data.shadowedRange = { start: s, end: e };
    }
  }
  if (obj.surfaceOp && typeof obj.surfaceOp === "object") {
    const s = oldToNew.get(obj.surfaceOp.startSeq);
    const e = oldToNew.get(obj.surfaceOp.endSeq);
    if (s === undefined || e === undefined) { lost.push("surfaceOp"); return { lost, fatal: true }; }
    obj.surfaceOp = { ...obj.surfaceOp, startSeq: s, endSeq: e };
  }
  return { lost, fatal: false };
}

/* ────────────────────────────── 校验器 ────────────────────────────── */

/**
 * 复刻 dsh-session-format 加载器会卡住的关键关系校验。
 * 不通过就绝不写盘 —— 宁可失败，也不给主人一个打不开的会话。
 */
function validate(events, baseSeq = 0) {
  const errors = [];
  // 1) seq 连续（种子会话的起点可能不是 0，所以从 baseSeq 起算）
  for (let i = 0; i < events.length; i++) {
    if (events[i].seq !== baseSeq + i) {
      errors.push(`seq 不连续：第 ${i} 个事件的 seq=${events[i].seq}，应为 ${baseSeq + i}`);
      break;
    }
  }
  // 2) turn 结构
  let nextTurn = 1;
  let current = null;
  let openStep = null;
  let nextStep = 1;
  const pendingCalls = new Map();
  for (const event of events) {
    const data = event.data ?? {};
    switch (event.type) {
      case "turn/start":
        if (current !== null) errors.push(`seq ${event.seq}: turn/start 时上一轮 ${current} 还没结束`);
        if (data.turn !== nextTurn) errors.push(`seq ${event.seq}: turn/start 的 turn=${data.turn}，应为 ${nextTurn}`);
        current = data.turn;
        nextStep = 1;
        break;
      case "turn/end":
        if (current === null) errors.push(`seq ${event.seq}: turn/end 没有对应的 turn/start`);
        else if (data.turn !== current) errors.push(`seq ${event.seq}: turn/end 的 turn=${data.turn}，当前是 ${current}`);
        if (openStep !== null) errors.push(`seq ${event.seq}: turn/end 时 step ${openStep} 还没结束`);
        // 轮闭合时还挂着未配对的 call 才是真问题；最后一轮未闭合（活会话在跑、工具被中断）不算
        if (pendingCalls.size > 0) {
          for (const [cid, s] of pendingCalls) errors.push(`seq ${s}: tool/call ${cid} 在轮内没有 tool/result`);
          pendingCalls.clear();
        }
        current = null;
        nextTurn += 1;
        openStep = null;
        break;
      case "step/start":
        if (current === null) errors.push(`seq ${event.seq}: step/start 在轮外`);
        if (data.turn !== current) errors.push(`seq ${event.seq}: step/start 的 turn 与当前轮不符`);
        if (data.step !== nextStep) errors.push(`seq ${event.seq}: step/start 的 step=${data.step}，应为 ${nextStep}`);
        openStep = nextStep;
        break;
      case "step/end":
        if (data.step !== openStep) errors.push(`seq ${event.seq}: step/end 的 step=${data.step} 与打开的 ${openStep} 不符`);
        openStep = null;
        nextStep += 1;
        break;
      case "tool/call": {
        const callId = data.callId ?? data.message?.id;
        if (callId !== undefined) pendingCalls.set(String(callId), event.seq);
        break;
      }
      case "tool/result": {
        const callId = data.message?.toolCallId ?? data.message?.source?.callId;
        if (callId !== undefined) {
          if (!pendingCalls.has(String(callId))) { /* 孤立 tool/result：官方 closeTools 不拦，跳过 */ }
          else pendingCalls.delete(String(callId));
        }
        break;
      }
      default:
        break;
    }
  }
  // 结尾未闭合的轮/step 与未配对的 call 都是"活会话正在执行"的正常状态，不算错误
  return errors;
}

/* ────────────────────────────── 命令实现 ────────────────────────────── */

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name, fallback = undefined) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const next = args[i + 1];
  if (next === undefined || next.startsWith("--")) return true;
  return next;
}

function has(name) {
  return args.includes(name);
}

function parseSelection(spec) {
  const out = new Set();
  if (spec === undefined || spec === true) return out;
  for (const part of String(spec).split(/[, ]+/).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(i);
    } else if (/^\d+$/.test(part)) out.add(Number(part));
    else throw new Error(`看不懂的轮次选择: ${part}`);
  }
  return out;
}

function usage() {
  console.log(`dsh-prune —— DSH 会话历史精简器

  list                                   列出所有会话
  show <id|目录> [--all]                 看轮次表（默认只看最近 40 轮）
  digest <id|目录> [--all] [--out 文件]  导出每轮详细摘要（给"精简员"读判断用）
  prune <id|目录> --drop 3,7-9 [--dry-run]
  prune <id|目录> --keep 1,2,5-8 [--dry-run]
  prune <id|目录> --keep-recent 20 [--dry-run]   只留最近 20 轮（+第 1 轮）
  restore <id|目录>                      从最近备份回滚
  export <id|目录> [--out 文件]          导出明文 JSONL

选项
  --root <目录>     会话根目录，默认 ${DEFAULT_ROOT}
  --all             显示全部轮次
  --full            预览正文时多显示几行
  --dry-run         只算不写
  --yes             跳过确认
  --restart         剪完自动重启 DSH（不重启会被活会话 flush 盖回去）`);
}

async function cmdList() {
  const root = String(flag("--root", DEFAULT_ROOT));
  const items = [];
  for (const item of walkSessions(root)) {
    try {
      const header = await readHeader(item.log);
      items.push({ ...item, header, mtime: statSync(item.log).mtimeMs, size: statSync(item.log).size });
    } catch (error) {
      items.push({ ...item, error: String(error), mtime: 0, size: 0 });
    }
  }
  items.sort((a, b) => b.mtime - a.mtime);
  console.log(`共 ${items.length} 个会话（root=${root}）\n`);
  for (const item of items) {
    const when = fmtTime(item.mtime);
    const kb = (item.size / 1024).toFixed(0).padStart(6);
    const cwd = item.header?.cwd ?? "(无 cwd)";
    console.log(`${when}  ${kb}KB  ${item.session}`);
    console.log(`                 cwd: ${cwd}`);
    if (item.error) console.log(`                 ⚠ ${item.error}`);
  }
}

async function cmdShow() {
  const target = args[1];
  if (!target) throw new Error("要给会话 id");
  const root = String(flag("--root", DEFAULT_ROOT));
  const found = resolveSession(target, root);
  const { header, rows } = await readLog(found.log);
  const { preamble, turns } = groupTurns(rows);
  const all = has("--all");
  const summaries = turns.map((turn, i) => turnSummary(rows, turn, i + 1));
  const limit = all ? summaries.length : Math.min(summaries.length, 40);
  const shown = summaries.slice(-limit);
  const offset = summaries.length - shown.length;

  console.log(`会话 ${header.id}`);
  console.log(`cwd    ${header.cwd ?? "(无)"}`);
  console.log(`文件   ${found.log}`);
  console.log(`事件   ${rows.length} 条，轮次 ${turns.length} 轮，第一轮前 ${preamble.length} 条事件`);
  const totalTokens = summaries.reduce((sum, s) => sum + s.tokens, 0);
  console.log(`估算   ~${totalTokens} tokens（按字符数粗算，仅供比较）`);
  console.log("");
  console.log("  轮次  时间             事件  工具   token  内容");
  console.log("  ────  ───────────────  ────  ────  ─────  ─────────────────────────────");
  shown.forEach((s, i) => {
    const listIndex = offset + i + 1;
    const auto = s.hasCompaction ? " ⟳" : "";
    const unclosed = s.closed ? "" : " ⚠未闭合";
    const head = clip(s.userText || s.assistantText || "(无文本)", 40);
    console.log(
      `  ${String(listIndex).padStart(4)}  ${fmtTime(s.firstTs)}  ${String(s.events).padStart(4)}  ${String(s.toolCalls).padStart(4)}  ${String(s.tokens).padStart(5)}  ${head}${auto}${unclosed}`,
    );
  });
  if (!all && summaries.length > shown.length) {
    console.log(`\n  … 还有 ${summaries.length - shown.length} 轮没显示，加 --all 看全部`);
  }
  // 自动压缩记录经常写在最后一轮 turn/end 之后，不属于任何轮；单独报一下
  // 注意：不能再把 preamble 算成"已覆盖"——最后一轮之后的事件也会被 groupTurns 塞进 preamble
  const covered = new Set();
  for (const turn of turns) for (const i of turn.idx) covered.add(i);
  let orphanCompaction = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!covered.has(i) && COMPACTION_TYPES.has(rows[i].obj.type)) orphanCompaction++;
  }
  if (orphanCompaction > 0) {
    console.log(`\n  本会话另有 ${orphanCompaction} 条自动压缩(compaction)记录落在所有轮次之外，prune 会一并丢弃。`);
  }
  console.log("\n  ⟳ = 这一轮里有过自动压缩(compaction)记录；prune 会丢弃压缩摘要，让被压的原文回到上下文。");
}

async function cmdPrune() {
  const target = args[1];
  if (!target) throw new Error("要给会话 id");
  const root = String(flag("--root", DEFAULT_ROOT));
  const found = resolveSession(target, root);
  const { header, rows, headerRaw, baseSeq } = await readLog(found.log);
  if (header.isSeeded) throw new Error("这是种子会话（subagent / fork 派生），暂不支持 prune，怕把继承前缀的长度语义弄坏");
  const { preamble, turns } = groupTurns(rows);
  if (turns.length === 0) throw new Error("这个会话里没有 turn 结构，没东西可删");

  const dropSpec = flag("--drop");
  const keepSpec = flag("--keep");
  const recentSpec = flag("--keep-recent");
  if (dropSpec === undefined && keepSpec === undefined && recentSpec === undefined) {
    throw new Error("要么 --drop 3,7-9，要么 --keep 1,2,5-8，要么 --keep-recent 20（先用 show 看轮次表）");
  }
  let keepSet;
  if (recentSpec !== undefined) {
    const n = Number(recentSpec);
    if (!Number.isInteger(n) || n < 1) throw new Error("--keep-recent 要给正整数");
    keepSet = new Set();
    for (let i = Math.max(1, turns.length - n + 1); i <= turns.length; i++) keepSet.add(i);
    keepSet.add(1); // 第一轮通常带着任务背景和约束，默认保住
  } else if (keepSpec !== undefined) {
    keepSet = parseSelection(keepSpec);
  } else {
    const dropSet = parseSelection(dropSpec);
    if (dropSet.size === 0) throw new Error("--drop 后面要写轮次，比如 --drop 3,7-9");
    keepSet = new Set();
    for (let i = 1; i <= turns.length; i++) if (!dropSet.has(i)) keepSet.add(i);
  }
  const bad = [...keepSet].filter((i) => i < 1 || i > turns.length);
  if (bad.length) throw new Error(`轮次超出范围: ${bad.join(",")}（共 ${turns.length} 轮）`);
  if (keepSet.size === 0) throw new Error("一轮都不留的话就别 prune 了，直接开新会话");

  const keptIdx = new Set(preamble);
  const turnPlan = [];
  turns.forEach((turn, i) => {
    const listIndex = i + 1;
    const keep = keepSet.has(listIndex);
    turnPlan.push({ listIndex, keep, turn, summary: turnSummary(rows, turn, listIndex) });
    if (keep) for (const idx of turn.idx) keptIdx.add(idx);
  });

  // 丢弃所有 compaction 事件：它们的 shadowedSeqs 精确指向被压缩的旧 seq，
  // 删轮之后几乎必然失配；丢掉它等于"取消压缩"，被压的原文会重新出现（副作用，报告里会写）。
  const compactionIdx = new Set();
  rows.forEach((row, idx) => { if (COMPACTION_TYPES.has(row.obj.type)) compactionIdx.add(idx); });

  // ① 候选集合（保留轮 + preamble，去掉 compaction）
  const candidateIdx = new Set([...keptIdx].filter((idx) => !compactionIdx.has(idx)));
  const candidateSeqs = new Set([...candidateIdx].map((idx) => rows[idx].obj.seq ?? idx));

  // ② 找出必须丢弃的"替换型"事件：它要替换的区间端点已被删掉，留着会让加载器报
  //    "start seq not found in surface"。只丢这两类事件，其他一律不动。
  const droppedReplace = new Map();
  for (const idx of candidateIdx) {
    const op = rows[idx].obj.surfaceOp;
    if (!op || typeof op !== "object") continue;
    if (!candidateSeqs.has(op.startSeq) || !candidateSeqs.has(op.endSeq)) {
      droppedReplace.set(idx, `${rows[idx].obj.type}@seq${rows[idx].obj.seq}（替换区间 ${op.startSeq}~${op.endSeq} 的端点已被删）`);
    }
  }

  // ③ 最终顺序 + 一次性分配 seq：先定集合再编号，绝不留下空洞
  const finalIdx = [...candidateIdx].filter((idx) => !droppedReplace.has(idx)).sort((a, b) => a - b);
  const oldToNew = new Map();
  let nextSeq = baseSeq;
  for (const idx of finalIdx) oldToNew.set(rows[idx].obj.seq ?? idx, nextSeq++);

  // ④ turn 重编号：保留轮按顺序 1..k
  const turnRemap = new Map();
  let nextTurnNo = 1;
  for (const plan of turnPlan) {
    if (!plan.keep) continue;
    if (typeof plan.turn.turn === "number") turnRemap.set(plan.turn.turn, nextTurnNo++);
  }

  // ⑤ 克隆 + 重映射
  const keptEvents = [];
  const warnings = [];
  for (const [idx, reason] of droppedReplace) warnings.push(`丢弃替换型事件 ${reason}，下次请求时运行时会自动重建它`);
  for (const idx of finalIdx) {
    const row = rows[idx];
    const clone = JSON.parse(JSON.stringify(row.obj));
    clone.seq = oldToNew.get(row.obj.seq ?? idx);
    if (clone.data && typeof clone.data === "object" && typeof clone.data.turn === "number") {
      const mapped = turnRemap.get(clone.data.turn);
      if (mapped !== undefined) clone.data.turn = mapped;
    }
    const { lost, fatal } = applyRefRemap(clone, oldToNew);
    if (fatal) {
      // 兜底：绝不删事件（删了就会在 seq 上留洞），改成普通 append 保留内容
      clone.surfaceOp = "append";
      warnings.push(`seq ${row.obj.seq} ${row.obj.type} 的替换目标已不存在，已降级为 append 保留`);
    }
    if (lost.length) warnings.push(`seq ${row.obj.seq} ${row.obj.type} 的引用已失效，删掉字段 ${lost.join("/")}`);
    // 压缩检查点必须成套存在：compaction/start+summary+checkpoint+end。上面已经把 compaction/* 全删了，
    // 所以任何还活着的 replace 型 compact-checkpoint 都是"孤壳"，官方加载器会报
    // "replacement sourceEventSeqs requires an array" / "compaction checkpoint has no matching compaction/start"。
    // 正确做法是降级成 append：历史原文仍在 surface 上，不丢内容。
    if (clone.surfaceOp && typeof clone.surfaceOp === "object" && clone.data?.source?.kind === "compact-checkpoint") {
      clone.surfaceOp = "append";
      delete clone.sourceEventSeqs;
      warnings.push(`seq ${row.obj.seq} 的压缩检查点失去了配套 compaction 事件，已降级为普通消息（历史原文保留）`);
    }
    keptEvents.push(clone);
  }

  // ⑥ inbox 重放收敛（2026-11-25 血案）：
  //   剪枝会留下「删待处理队列消息」的 agent/inbox/spliced，而把消息塞进队列的那条
  //   已经在被删的轮次里没了。重放时 start+removedCount 越界，官方 projection 直接抛
  //   "invalid persisted inbox splice at session seq N"，整个会话打不开——而格式校验
  //   （seq/turn/step/tool 配对）全是绿的，查不出来。
  //   这里按 seq 顺序重放 inbox，把越界的 splice 收敛成合法范围，inserted 原样保留。
  {
    const inboxState = { "next-turn": [], "next-step": [] };
    const msgKey = (m) => (m && typeof m === "object" ? (m.id ?? JSON.stringify(m).slice(0, 40)) : String(m));
    for (const event of keptEvents) {
      if (event.type !== "agent/inbox/spliced" || !event.data) continue;
      const splice = event.data;
      const inbox = inboxState[splice.target];
      if (!Array.isArray(inbox)) continue;
      const before = { start: splice.start, removedCount: splice.removedCount ?? 0 };
      let changed = false;
      if (!Number.isSafeInteger(splice.start) || splice.start < 0) { splice.start = 0; changed = true; }
      if (splice.start > inbox.length) { splice.start = inbox.length; changed = true; }
      if (!Number.isSafeInteger(splice.removedCount) || splice.removedCount < 0) { splice.removedCount = 0; changed = true; }
      if (splice.start + (splice.removedCount ?? 0) > inbox.length) {
        splice.removedCount = Math.max(0, inbox.length - splice.start);
        changed = true;
      }
      if (!Array.isArray(splice.inserted)) { splice.inserted = []; changed = true; }
      // 先按 splice 语义把该删的删掉，再看 inserted 是否与「剩下的 pending」撞 id
      const rest = inbox.slice();
      rest.splice(splice.start, splice.removedCount ?? 0);
      const other = splice.target === "next-turn" ? inboxState["next-step"] : inboxState["next-turn"];
      const pendingIds = new Set([...other, ...rest].map(msgKey));
      const keptInserted = [];
      for (const message of splice.inserted) {
        const k = msgKey(message);
        if (pendingIds.has(k)) { changed = true; continue; }
        pendingIds.add(k);
        keptInserted.push(message);
      }
      if (keptInserted.length !== splice.inserted.length) splice.inserted = keptInserted;
      const spliced = inbox.slice();
      spliced.splice(splice.start, splice.removedCount ?? 0, ...splice.inserted);
      inboxState[splice.target] = spliced;
      if (before.start !== splice.start || before.removedCount !== (splice.removedCount ?? 0)) {
        warnings.push(`seq ${event.seq} 的 inbox splice 指向了已被删掉的待处理消息（${JSON.stringify(before)} → ${JSON.stringify({ start: splice.start, removedCount: splice.removedCount ?? 0 })}），已收敛`);
      }
    }
    const left = inboxState["next-turn"].length + inboxState["next-step"].length;
    if (left > 0) {
      // 剪枝删的是整轮历史，队列里剩下的这些基本是被删轮次里没跑完的定时提醒/半句话
      // （2026-11-25 d8d8d648 残留 87 条）。留着它们，会话一打开就顶着一堆待处理输入，
      // 用户一说话就可能被一起消费掉。所以剪完顺手清空，并明说清了多少条。
      let seq = keptEvents[keptEvents.length - 1].seq;
      for (const target of ["next-turn", "next-step"]) {
        const n = inboxState[target].length;
        if (n === 0) continue;
        keptEvents.push({
          type: "agent/inbox/spliced",
          time: Date.now(),
          seq: seq += 1,
          data: { target, start: 0, removedCount: n, inserted: [] },
        });
      }
      warnings.push(`剪完清空了 ${left} 条残留待处理输入（被删轮次里没跑完的定时提醒等）`);
    }
  }

  const errors = validate(keptEvents, baseSeq);

  const droppedTurns = turnPlan.filter((p) => !p.keep);
  const droppedTokens = droppedTurns.reduce((sum, p) => sum + p.summary.tokens, 0);
  const totalTokens = turnPlan.reduce((sum, p) => sum + p.summary.tokens, 0);

  console.log(`会话 ${header.id}`);
  console.log(`保留 ${turnPlan.filter((p) => p.keep).length} 轮，删除 ${droppedTurns.length} 轮`);
  if (droppedTurns.length) {
    console.log("删除的轮：");
    for (const p of droppedTurns) {
      console.log(`  #${String(p.listIndex).padStart(3)}  ${String(p.summary.tokens).padStart(6)} tok  ${clip(p.summary.userText || "(无用户文本)", 60)}`);
    }
  }
  console.log(`事件 ${rows.length} → ${keptEvents.length}`);
  console.log(`估算上下文 ~${totalTokens} → ~${totalTokens - droppedTokens} tokens（省 ~${droppedTokens}）`);
  if (compactionIdx.size) {
    console.log(`\n注意：丢弃了 ${compactionIdx.size} 条自动压缩(compaction)记录。原来被压掉的早期原文会重新回到上下文，`);
    console.log("      如果那不是你要的，就顺手把那些早期轮次也 drop 掉。");
  }
  if (warnings.length) {
    console.log(`\n结构调整 ${warnings.length} 处：`);
    for (const w of warnings.slice(0, 12)) console.log("  · " + w);
    if (warnings.length > 12) console.log(`  · …另有 ${warnings.length - 12} 处`);
  }
  if (errors.length) {
    console.log(`\n✗ 自检不通过，拒绝写盘（原文件没动）：`);
    for (const e of errors.slice(0, 20)) console.log("  · " + e);
    process.exitCode = 2;
    return;
  }
  console.log("\n✓ 自检通过（seq 连续 / turn 连续 / step 连续 / tool 配对 / seq 引用可解析）");

  if (has("--dry-run")) {
    console.log("\n--dry-run：到此为止，没有改任何文件。去掉 --dry-run 才会真写。");
    return;
  }

  // 备份
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const backup = `${found.log}.prune-bak-${stamp}`;
  copyFileSync(found.log, backup);

  // 写盘：header 一帧 + 事件一帧（与官方 materialization 同构）
  const bodyLines = keptEvents.map((event) => JSON.stringify(event));
  const bodyText = bodyLines.length ? bodyLines.join("\n") + "\n" : "";
  const out = Buffer.concat([zstdEncode(headerRaw + "\n"), zstdEncode(bodyText)]);

  // 写完先按 DSH 加载器的规则自检一遍再落盘：
  //   ① 不能有残帧（tornStart 必须不存在）
  //   ② 第一帧必须是独立 header（首行 JSON 可解析）
  //   ③ 其余每一帧的明文都必须以 "\n" 收尾（否则 DSH 报
  //      "complete frame contains a torn JSONL record"）
  //   ④ 每一行都必须能 JSON.parse
  // 2026-11-22 23:52 就是栽在 ③ 上，会话直接打不开。
  try {
    const check = scanZstdFrames(out);
    if (check.tornStart !== undefined) throw new Error(`容器尾部有残帧（字节 ${check.tornStart}）`);
    if (!check.frames.length) throw new Error("没有任何帧");
    const headerText = zstdDecompressSync(out.subarray(check.frames[0].start, check.frames[0].end)).toString("utf8");
    // 第一帧必须"恰好一行 header"：DSH 枚举会话列表时用 readFirstZstdLine + assertZstdHeaderFrame
    // 卡这个，多一行就判 corrupt，整条会话从列表里消失（2026-11-25 d8d8d648 就是这么没的）。
    if (headerText.indexOf("\n") !== headerText.length - 1) throw new Error("第一帧不是恰好一行 header（会被列表枚举判 corrupt）");
    JSON.parse(headerText.split("\n")[0]);
    for (let i = 1; i < check.frames.length; i++) {
      const plain = zstdDecompressSync(out.subarray(check.frames[i].start, check.frames[i].end));
      if (plain.length === 0) continue;
      if (plain[plain.length - 1] !== 0x0a) throw new Error(`第 ${i} 帧没有以换行结尾`);
      for (const line of plain.toString("utf8").split("\n")) {
        if (line.trim() === "") continue;
        let ev;
        try { ev = JSON.parse(line); } catch (e) { throw new Error(`第 ${i} 帧有一行不是合法 JSON（${line.slice(0, 80)}…）`); }
        // 官方加载器只卡「唯一」。注意：真实会话里确实存在 sourceEventSeqs
        // 指向文件后段的事件（2026-11-23 07:56 c9ec6015 就是这样），所以这里
        // 不能按「必须更早」判，否则会误杀，导致该剪的剪不掉。
        if (ev && Array.isArray(ev.sourceEventSeqs)) {
          const seen = new Set();
          for (const v of ev.sourceEventSeqs) {
            if (typeof v !== "number") throw new Error(`seq ${ev.seq} 的 sourceEventSeqs 含非数字项`);
            if (seen.has(v)) throw new Error(`seq ${ev.seq} 的 sourceEventSeqs 有重复引用 ${v}`);
            seen.add(v);
          }
        }
      }
    }
  } catch (error) {
    console.log(`\n✗ 写完自检不通过，拒绝落盘（原文件没动）：${error.message}`);
    process.exitCode = 2;
    return;
  }

  const tmp = `${found.log}.${process.pid}.tmp`;
  writeFileSync(tmp, out);
  renameSync(tmp, found.log);

  console.log(`\n已写入 ${found.log}`);
  console.log(`备份   ${backup}`);

  // 投影缓存里记着旧游标（contextHeaders.seq / title.seq 等）。剪完必须作废，否则 DSH
  // 带着旧游标续写，会把新事件按旧编号接在重编号过的新历史后面，文件立刻变成
  // 「新编号 + 旧编号」两截，加载器报 seq gap（2026-11-26 e13b4896 就是这么坏的）。
  try {
    const cacheFile = join(homedir(), ".dsh", "storages", "session_projcache", "sessions", `${header.id}.json`);
    if (existsSync(cacheFile)) {
      unlinkSync(cacheFile);
      console.log("投影缓存 已作废（重新打开会话时 DSH 会自动重建，标题短暂显示为未命名属正常）");
    }
  } catch (error) {
    console.log(`投影缓存 作废失败（不影响剪枝结果）：${error.message}`);
  }

  // --restart：写盘后自动重启 DSH。必须重启一次，否则活会话会把内存里的旧历史
  // flush 回文件，把刚剪好的结果盖掉（2026-11-23 EDA 会话就是这样被提醒的）。
  if (has("--restart")) {
    const script = process.env.DSH_PRUNE_RESTART || "F:\\dsh-plugins\\restart-dsh.ps1";
    if (!existsSync(script)) {
      console.log(`\n⚠ 没找到重启脚本 ${script}（可用 DSH_PRUNE_RESTART 环境变量指定）；这次改动要手动重启 DSH 才生效。`);
    } else {
      try {
        // 注意：不能加 detached——Windows 的 DETACHED_PROCESS 会让 powershell 5.1
        // 拿不到控制台直接 exit 0。脱离进程树靠脚本自己的 WMI 搬迁。
        // 2026-11-25 实测：从会话里 spawn 出去的 powershell 仍挂在 Electron 的 job object 里，
        // 剪枝进程一退出 job 关闭，重启器就被一起带走——日志只写到 STEP 1c 就断，DSH 根本没重启。
        // 必须让 WMI 服务（WmiPrvSE）来创建进程，父进程在树外，杀树带不走它。
        const cmdLine = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}" -Force -DelaySeconds 3`;
        const psCmd = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${cmdLine}'}; if ($r.ReturnValue -ne 0) { throw ('WMI create failed: ' + $r.ReturnValue) }; $r.ProcessId`;
        const launched = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCmd], { encoding: "utf8", windowsHide: true, timeout: 30000 });
        const outText = `${launched.stdout || ""}${launched.stderr || ""}`.trim();
        if (launched.status !== 0) throw new Error(outText || `powershell 退出码 ${launched.status}`);
        const newPid = outText.split(/\s+/).filter(Boolean).pop();
        console.log(`\n重启已排队（WMI 拉起，进程 ${newPid}，已在 DSH 进程树外）：3 秒后关掉 DSH，重开时就是剪好的会话。`);
        console.log("要看进度：F:\\dsh-backups\\dsh-restart-*.log");
      } catch (error) {
        console.log(`\n⚠ 没能拉起重启脚本：${error.message}；这次改动要手动重启 DSH 才生效。`);
      }
    }
  } else {
    console.log("\n下一步：回到 GUI 重新打开这个会话看看；不对就跑 restore 回滚。");
    console.log("重要：如果这个会话刚才在 GUI 里还开着，先把窗口切走再操作，否则活会话会把旧历史 flush 回来。加 --restart 可以让脚本自己处理这一步。");
  }
}

async function cmdRestore() {
  const target = args[1];
  if (!target) throw new Error("要给会话 id");
  const root = String(flag("--root", DEFAULT_ROOT));
  const found = resolveSession(target, root);
  const backups = readdirSync(found.dir)
    .filter((f) => f.includes(".prune-bak-"))
    .sort();
  if (backups.length === 0) throw new Error("没有备份可回滚");
  const latest = backups[backups.length - 1];
  copyFileSync(join(found.dir, latest), found.log);
  console.log(`已从 ${latest} 回滚到 ${found.log}`);
  if (backups.length > 1) console.log(`（还有 ${backups.length - 1} 个更早的备份没动）`);
}

async function cmdExport() {
  const target = args[1];
  if (!target) throw new Error("要给会话 id");
  const root = String(flag("--root", DEFAULT_ROOT));
  const found = resolveSession(target, root);
  const buf = readFileSync(found.log);
  const text = found.log.endsWith(".zstd") ? zstdDecode(buf) : buf.toString("utf8");
  const outPath = String(flag("--out", join(process.cwd(), `${basename(found.dir)}.jsonl`)));
  writeFileSync(outPath, text);
  const lines = text.split("\n").filter(Boolean).length;
  console.log(`已导出 ${lines} 行 → ${outPath}`);
  console.log("用记事本/VSCode 打开就能看到每条事件了；改完想还原成会话格式，可以再 compress 回去（不是首版功能）。");
}

async function cmdDigest() {
  const target = args[1];
  if (!target) throw new Error("要给会话 id");
  const root = String(flag("--root", DEFAULT_ROOT));
  const found = resolveSession(target, root);
  const { header, rows } = await readLog(found.log);
  const { turns } = groupTurns(rows);
  if (turns.length === 0) throw new Error("这个会话里没有 turn 结构");
  const all = has("--all");
  const summaries = turns.map((turn, i) => turnSummary(rows, turn, i + 1));
  const totalTokens = summaries.reduce((sum, s) => sum + s.tokens, 0);
  const limit = all ? summaries.length : Math.min(summaries.length, 60);
  const offset = summaries.length - limit;

  const lines = [];
  lines.push(`# 会话摘要 ${header.id}`);
  lines.push(`cwd: ${header.cwd ?? "(无)"}`);
  lines.push(`文件: ${found.log}`);
  lines.push(`共 ${turns.length} 轮，估算 ~${totalTokens} tokens；这里列出第 ${offset + 1}~${summaries.length} 轮`);
  lines.push("");
  for (let i = offset; i < summaries.length; i++) {
    const s = summaries[i];
    const toolNames = new Map();
    for (const idx of turns[i].idx) {
      const obj = rows[idx].obj;
      if (obj.type === "tool/call" && typeof obj.data?.name === "string") {
        toolNames.set(obj.data.name, (toolNames.get(obj.data.name) ?? 0) + 1);
      }
    }
    const tools = [...toolNames.entries()].map(([n, c]) => `${n}×${c}`).join(" ") || "无";
    lines.push(`## 第 ${s.listIndex} 轮  [${fmtTime(s.firstTs)}]  ~${s.tokens} tok  ${s.events} 事件  工具: ${tools}`);
    lines.push(`USER: ${clip(s.userText, 400) || "(无用户文本)"}`);
    if (s.assistantText) lines.push(`ASSISTANT: ${clip(s.assistantText, 400)}`);
    lines.push("");
  }
  const text = lines.join("\n");
  const outPath = flag("--out");
  if (outPath && outPath !== true) {
    writeFileSync(String(outPath), text);
    console.log(`✓ 已写出 ${text.split("\n").length} 行 → ${outPath}`);
    console.log(`  共 ${summaries.length} 轮，估算 ~${totalTokens} tokens（列出第 ${offset + 1}~${summaries.length} 轮）`);
    console.log("  下一步：读这份摘要判断哪些轮没用，再用 prune --drop 删掉；或者据此写一段前情摘要带进新会话。");
  } else {
    console.log(text);
  }
}

/* ────────────────────────────── 入口 ────────────────────────────── */

async function main() {
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") { usage(); return; }
  switch (cmd) {
    case "list": return cmdList();
    case "show": return cmdShow();
    case "prune": return cmdPrune();
    case "restore": return cmdRestore();
    case "digest": return cmdDigest();
    case "export": return cmdExport();
    default:
      usage();
      throw new Error(`未知子命令: ${cmd}`);
  }
}

main().catch((error) => {
  console.error(`✗ ${error?.message ?? error}`);
  process.exitCode = 1;
});
