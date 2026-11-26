# dsh-slim

**给 DeepSeek Harness（DSH）会话做「一键瘦身」的插件**：点输入框左下角的 `+`，选一条命令，它就把这条对话里多余的轮次删掉——废话轮清干净、重复讨论只留一份、经验和要求抽成档案，然后在后台自动关掉再重开 DSH，回来看到的就是精简后的对话。

> 面向长会话的 token 成本问题。DSH 自带的 `/compact` 只能整段压成一条摘要、不能挑轮；本项目按轮操作，保留你要的那部分原文。

---

## 1. 它到底做什么

| 命令 | 行为 |
| --- | --- |
| `slim` | **安全自动档**。删掉三类高置信度废话：`[SCHEDULE REMINDER]` 定时提醒刷屏、单字回复（好/嗯/怎么回事/过期了）、纯过场（你弄/继续/接着改/打开看看/你看着办），以及几乎逐字重复的同一句话。零误伤，点完立刻剪。 |
| `slimmerge` | **合并精简**。把这条会话的逐轮摘要导出，登记成待办；下一轮对话开始时，助手按主题分组去重、把经验和要求写成档案，再把「保留哪几轮 / 删哪几轮」清单交给你确认后执行。 |

两个命令都走同一条执行链：**干跑探路 → 写盘前五项结构自检 → 写盘后四道容器校验 → 备份 → 写盘 → 自动重启 DSH**。

---

## 2. 为什么必须重启 DSH

DSH 的会话文件是**严格校验的事件流**（多帧 zstd + JSONL）。会话在界面里开着时，进程内存里留着它的游标；剪完不重启，下一次追加就会把内存里的旧历史 flush 回文件，覆盖剪枝结果，甚至写出 seq 断层导致「历史加载失败」。

所以本项目把「杀掉 DSH → 剪文件 → 按桌面快捷方式重新拉起」做成一条链，只有 DSH 真正死透了才动文件。

---

## 3. 安装

### 3.1 环境

- DSH（DeepSeek Harness）桌面版，profile 为 `desktop`
- Node.js ≥ 22（DSH 自带运行时也行）
- Windows（重启脚本依赖 PowerShell + 桌面快捷方式；剪枝本体跨平台）

### 3.2 装插件

把本仓库放进任意目录，然后在 DSH 里：

```bash
# 用 DSH 的插件管理器安装（推荐，自动登记 profile）
plugin_manager install_bundle  <本仓库绝对路径>
```

或者手工登记：在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 里加一行本包名，并在 `node_modules` 里做一个指向本仓库的 junction。

装完**重启一次 DSH**，输入框左下角 `+` 菜单里就会出现 `slim` 和 `slimmerge`。

### 3.3 配置路径（重要）

默认路径是作者的机器，别人用必须改。四条路径都支持环境变量覆盖：

| 环境变量 | 含义 | 默认值（示例） |
| --- | --- | --- |
| `DSH_PRUNE_RESTART` | 重启脚本 | `F:/dsh-plugins/restart-dsh.ps1` |
| `DSH_PRUNE_CLI` | 剪枝 CLI | `E:/…/session-tools/dsh-prune.mjs` |
| `DSH_PRUNE_NODE` | node 可执行文件 | DSH 运行时里的 node.exe |
| `DSH_PRUNE_WORKDIR` | 摘要/待办输出目录 | `%TEMP%/dsh-slim` |

`tools/restart-dsh.ps1` 会自动从桌面快捷方式解出 exe 与工作目录（也可用 `DSH_EXE_PATH` 覆盖）；Web GUI 端口默认在启动后自动探测，不写死。

---

## 4. 命令行用法（不装插件也能用）

```bash
node tools/dsh-prune.mjs list                       # 列出所有会话
node tools/dsh-prune.mjs show <id|目录> --all       # 逐轮表：时间/事件/token/用户话术
node tools/dsh-prune.mjs digest <id> --all --out d.md   # 导出逐轮摘要（给 AI 判断用）
node tools/dsh-prune.mjs prune <id> --keep-recent 12 --dry-run
node tools/dsh-prune.mjs prune <id> --drop 3,7-9 --restart
node tools/dsh-prune.mjs prune <id> --keep 1,2,5-8 --restart
node tools/dsh-prune.mjs restore <id>               # 从最近备份回滚
node tools/dsh-prune.mjs export <id> --out x.jsonl  # 导出明文事件流
```

参数：

| 参数 | 说明 |
| --- | --- |
| `--drop 3,7-9` | 删这些轮 |
| `--keep 1,2,5-8` | 只留这些轮（反向白名单） |
| `--keep-recent N` | 只留最近 N 轮 + 第 1 轮 |
| `--dry-run` | 只算不写 |
| `--restart` | 写完自动重启 DSH（不重启会被活会话 flush 覆盖） |
| `--root <目录>` | 会话根目录，默认 `~/.dsh/sessions` |

---

## 5. 安全设计

写盘前（结构层）：

1. `seq` 从 baseSeq 连续，不许有洞；
2. `turn` 从 1 连续递增；
3. 轮内 `step` 从 1 连续；
4. `tool/call` 与 `tool/result` 必须成对；
5. 所有 seq 引用（`sourceEventSeq(s)`、`surfaceOp.startSeq/endSeq`、`shadowedSeqs`、`shadowedRange`）必须可解析。

写盘后（容器层，对齐官方加载器）：

1. 不允许残帧（torn frame）；
2. 第一帧必须是独立 header（首行可 JSON.parse）；
3. 其余每帧明文必须以 `\n` 收尾——否则 DSH 报 `complete frame contains a torn JSONL record`；
4. 每行必须能 JSON.parse，`sourceEventSeqs` 不得重复。

任何一条不过 → **拒绝落盘，原文件一个字节不动**。每次写盘前自动备份 `session.v4.jsonl.zstd.prune-bak-<时间戳>`，`restore` 可整条退回。

几个真实踩坑，已内置修复：

- **区间引用塌缩**：rewind 型替换事件的 `sourceEventSeqs` 里夹着区间（`[[999,1003],1005]`），只按数字映射会让两个端点撞成同一个值，DSH 报 `duplicate sourceEventSeqs ranges`。现在统一展开成去重后的单值列表。
- **反斜杠吞字符**：Windows 路径写进 JS 字符串时 `\r`、`\d` 会被当转义，路径悄悄变成错的。本项目路径一律用正斜杠。
- **第一帧必须是「恰好一行 header」**（1.0.2）：DSH 枚举会话列表走 `readFirstZstdLine` + `assertZstdHeaderFrame`，第一帧多一行就判 corrupt，会话整条从左侧列表里消失——而完整加载器把帧全解开再拼，照样 PASS，肉眼与常规校验都看不出来。现在写盘自检里加了这条断言，只允许 `header + "\n"` 单独一帧。
- **孤儿 inbox splice**（1.0.2）：剪枝删掉了「把消息塞进待处理队列」的事件，却留下「从队列里删消息」的 `agent/inbox/spliced`，重放时 `start + removedCount` 越界，加载器抛 `invalid persisted inbox splice at session seq N`，会话打不开（而 seq/turn/step/tool 配对全绿）。现在剪枝会按顺序重放 inbox、把越界 splice 收敛成合法范围，并把残留的待处理输入一并清空（那些多是被删轮次里没跑完的定时提醒）。
- **会话内 spawn 的重启器会被一起杀掉**（1.0.2）：从会话里 `spawn` 出去的 powershell 仍挂在 Electron 的 job object 里，剪枝进程一退、job 关闭就被带走，重启日志只写到 `STEP 1c` 就断，DSH 其实没重启。现在改由 WMI（`Win32_Process.Create`）创建重启进程，父进程是 `WmiPrvSE`，杀树带不走它。
- **投影缓存里的旧游标会把文件写坏**（1.0.3）：`~/.dsh/storages/session_projcache/sessions/<id>.json` 记着上次折叠到哪条事件（`contextHeaders.seq`）。剪枝把 seq 重编号之后，DSH 若带着旧游标续写，新事件会按旧编号接在文件尾部，立刻变成「新编号 + 旧编号」两截，加载器报 `seq gap`。现在剪完自动作废该会话的投影缓存（下次打开自动重建，标题短暂显示「未命名」属正常）。
- **DSH 还在跑的时候剪枝，必然写坏**（1.0.5）：活会话内存里拿着旧的 `lastSeq`，剪完它会接着按旧编号追加，文件立刻两截。2026-11-26 同一个会话连坏三次都是这个原因。现在 `prune` 写盘前先查 `DeepSeek Harness.exe` 是否在跑，在跑就直接拒绝写盘（原文件一个字节不动），只提示改用「排重启 → 先停 DSH → 再剪 → 再拉起」；确实需要在运行中剪再加 `--force-live`。

---

## 6. 目录结构

```
dsh-slim/
├─ index.js              宿主插件：注册 slim / slimmerge 两条命令
├─ cordis.patch.yml      把插件插进 DSH 的 bundle patch
├─ locale/{en,zh}.json   插件列表里的标题与说明
├─ icon.svg
└─ tools/
   ├─ dsh-prune.mjs      剪枝 CLI（读/写/校验/备份/回滚/摘要）
   └─ restart-dsh.ps1    杀 DSH 进程树 + 剪 + 重新拉起（WMI 自我搬迁，附带白名单）
```

---

## 7. 已知限制

- 只能**整轮**删除：DSH 的事件流要求 turn/step 连续，删半轮会破坏结构。
- 「按主题去重」需要模型理解，纯规则做不到——`slim` 只做高置信度判定，`slimmerge` 才交给模型。
- 重启依赖桌面快捷方式；改了 exe 路径要同步改 `restart-dsh.ps1`。
- 剪枝期间 DSH 必须是关闭状态，否则会被 flush 覆盖。

---

## 8. 许可

MIT。欢迎 issue / PR。
