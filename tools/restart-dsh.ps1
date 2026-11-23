<#
    restart-dsh.ps1
    ---------------------------------------------------------------
    用途：安全重启 DeepSeek Harness 桌面版（Windows）。
    探测得到的启动真相（2026-11-22 只读探测，绝对路径，勿改）：
      桌面窗口主进程 : <自动探测>\DeepSeek Harness.exe
      启动入口       : <用户桌面>\DeepSeek Harness.lnk
                       TargetPath = <快捷方式解出的 exe>
                       Arguments  = (空)
                       WorkDir    = <exe 所在目录>
      Web GUI 端口   : 127.0.0.1:54626，由主进程派生的 host 子进程监听
      附属子进程     : <用户目录>\.dsh\electron\electron.exe（dsh-pet 桌宠窗口，父为 host）
    说明：主进程不带任何参数启动，内部再拉起 host（node index.js）与桌宠 electron。
          因此重启必须"杀掉整棵树"再按 lnk 的 TargetPath + Arguments 重新拉起。

    用法：
      # 1) 只预演，不杀不启（默认）：
      powershell -NoProfile -ExecutionPolicy Bypass -File F:\dsh-plugins\restart-dsh.ps1
      # 2) 真重启：
      powershell -NoProfile -ExecutionPolicy Bypass -File F:\dsh-plugins\restart-dsh.ps1 -Force

    行为：
      1. 把当前 DSH 进程 PID / 命令行 / 端口状态快照写入 F:\dsh-backups\dsh-restart-<时间戳>.log
      2. 不带 -Force 只打印"将要执行什么"，一个进程都不碰
      3. 带 -Force：只杀 DSH 自己的进程树（主进程 + 后代），不碰其它 electron / node
      4. 等 3 秒
      5. 按 lnk 的 TargetPath + Arguments + WorkDir 重新启动
      6. 等 8 秒后校验：进程是否起来 + 54626 是否监听，打印结果

    安全护栏：
      - 杀之前逐个校验 ExecutablePath，命令行含 src\bridge.js 或 F:\node.exe 的 qq-bridge 永不杀
      - 永不杀本脚本自身 PID
      - 若本脚本是从 DSH 进程树内部被拉起的，会通过 WMI 把自己搬到进程树外再执行，
        避免"杀树时把自己也杀掉"导致重启半途中断
      - 所有路径均为绝对路径；退出码 0=成功/预演 2=校验失败 3=前置条件缺失
#>

[CmdletBinding()]
param(
    # 不带此开关 = 只预演
    [switch]$Force,

    # 内部使用：表示已通过 WMI 搬到 DSH 进程树之外，不要再次搬迁
    [switch]$Detached,

    # 快照/运行日志目录
    [string]$LogDirectory = 'F:\dsh-backups',

    # 由父进程指定的日志文件（搬迁时继承）；留空则自动按时间戳生成
    [string]$LogPath = '',

    # 重启前先剪一个会话（留空 = 不剪）。由 /slim 命令传入当前会话 id。
    [string]$PruneSession = '',

    # 传给 dsh-prune 的参数，如 '--keep-recent 12' 或 '--drop 3,7-9'
    [string]$PruneArgs = '--keep-recent 12',

    # 动手前先等几秒，给 command/run、command/done 留出落盘时间
    [int]$DelaySeconds = 0,

    # DSH Web GUI 端口
    [int]$Port = 54626,

    # 杀完之后等待秒数（需求要求 3 秒）
    [int]$StopWaitSeconds = 3,

    # 启动后等待校验秒数（需求要求 8 秒）
    [int]$BootWaitSeconds = 25
)

Set-StrictMode -Off
$ErrorActionPreference = 'Continue'

# ============================ 常量：绝对路径 ============================
# 自动探测：桌面 / 开始菜单里的快捷方式 → 解出 exe 路径与工作目录。
# 也可用环境变量 DSH_EXE_PATH 覆盖。
$DesktopExeName = 'DeepSeek Harness.exe'
$DesktopLnkList = @(
    (Join-Path $env:USERPROFILE 'Desktop\DeepSeek Harness.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\DeepSeek Harness.lnk')
)
function Resolve-DesktopExe {
    if ($env:DSH_EXE_PATH -and (Test-Path -LiteralPath $env:DSH_EXE_PATH)) { return $env:DSH_EXE_PATH }
    foreach ($lnk in $DesktopLnkList) {
        if (-not (Test-Path -LiteralPath $lnk)) { continue }
        try {
            $sh = New-Object -ComObject WScript.Shell
            $sc = $sh.CreateShortcut($lnk)
            if ($sc.TargetPath -and (Test-Path -LiteralPath $sc.TargetPath)) { return [string]$sc.TargetPath }
        } catch { }
    }
    return ''
}
$DesktopExePath = Resolve-DesktopExe
$DesktopWorkDir = if ($DesktopExePath) { Split-Path -Parent $DesktopExePath } else { '' }

# 永不杀的进程特征（防御性白名单）
$NeverKillPathLike = @('F:\node.exe')
$NeverKillCmdLike  = @('src\bridge.js', 'start-bridge-at-logon')
# 永不按名字杀：conhost 是控制台宿主，杀掉它会把挂在上面的 powershell 一起带走
# （2026-11-22 22:38 实测：脚本把自己杀在半路，日志停在 STEP 1c）；
# bash.exe 是工具调用壳，杀掉只会让排查断线，对关 DSH 没帮助。
$NeverKillName     = @('conhost.exe', 'bash.exe', 'OpenConsole.exe')

if ([string]::IsNullOrWhiteSpace($LogPath)) {
    $LogPath = Join-Path $LogDirectory ('dsh-restart-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
}

# ============================ 日志 ============================
$script:LogBuffer = New-Object System.Collections.Generic.List[string]

function Write-Log {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [ValidateSet('INFO', 'OK', 'WARN', 'ERROR', 'PLAN')][string]$Level = 'INFO'
    )
    $line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $Level, $Text
    $script:LogBuffer.Add($line)
    switch ($Level) {
        'ERROR' { Write-Host $line -ForegroundColor Red }
        'WARN'  { Write-Host $line -ForegroundColor Yellow }
        'OK'    { Write-Host $line -ForegroundColor Green }
        'PLAN'  { Write-Host $line -ForegroundColor Cyan }
        default { Write-Host $line }
    }
}

function Save-Log {
    try {
        $dir = Split-Path -Parent $LogPath
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            [void](New-Item -ItemType Directory -Path $dir -Force)
        }
        [IO.File]::WriteAllLines($LogPath, $script:LogBuffer.ToArray(), (New-Object Text.UTF8Encoding($true)))
        return $true
    } catch {
        Write-Host ('[ERROR] cannot write log file: ' + $_.Exception.Message) -ForegroundColor Red
        return $false
    }
}

# ============================ 进程工具 ============================
function Get-ProcessSnapshot {
    return @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
}

function Test-IsDshProcess {
    param($Proc)
    if (-not $Proc) { return $false }
    if ($Proc.ExecutablePath -and ($Proc.ExecutablePath -ieq $DesktopExePath)) { return $true }
    if ($Proc.Name -and ($Proc.Name -ieq $DesktopExeName)) { return $true }
    return $false
}

function Get-DshProcess {
    param($AllProcesses)
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($p in $AllProcesses) {
        if (Test-IsDshProcess -Proc $p) { $out.Add($p) }
    }
    return $out
}

# 由 PID 集合沿 ParentProcessId 向下收集全部后代
function Get-DescendantPid {
    param([int[]]$RootPid, $AllProcesses)
    $childMap = @{}
    foreach ($p in $AllProcesses) {
        $pp = [int]$p.ParentProcessId
        if (-not $childMap.ContainsKey($pp)) {
            $childMap[$pp] = New-Object System.Collections.Generic.List[int]
        }
        $childMap[$pp].Add([int]$p.ProcessId)
    }
    $seen = New-Object System.Collections.Generic.List[int]
    $queue = New-Object System.Collections.Generic.Queue[int]
    foreach ($r in $RootPid) { $queue.Enqueue([int]$r) }
    while ($queue.Count -gt 0) {
        $cur = $queue.Dequeue()
        if ($childMap.ContainsKey($cur)) {
            foreach ($c in $childMap[$cur]) {
                if (-not $seen.Contains($c)) {
                    $seen.Add($c)
                    $queue.Enqueue($c)
                }
            }
        }
    }
    return $seen
}

# 本脚本自身是否位于某个目标的进程树里（沿父链上溯）
function Test-InsideTree {
    param([int]$TargetPid, [int[]]$TreePid, $AllProcesses)
    $map = @{}
    foreach ($p in $AllProcesses) { $map[[int]$p.ProcessId] = [int]$p.ParentProcessId }
    $cur = [int]$PID
    for ($i = 0; $i -lt 64 -and $cur -gt 4; $i++) {
        if ($TreePid -contains $cur) { return $true }
        if (-not $map.ContainsKey($cur)) { break }
        $cur = $map[$cur]
    }
    return $false
}

function Test-NeverKill {
    param($Proc)
    if (-not $Proc) { return $true }
    $exe = [string]$Proc.ExecutablePath
    $cmd = [string]$Proc.CommandLine
    $nm  = [string]$Proc.Name
    foreach ($n in $NeverKillPathLike) {
        if ($exe -and ($exe -ieq $n)) { return $true }
    }
    foreach ($n in $NeverKillCmdLike) {
        if ($cmd -and ($cmd.IndexOf($n, [StringComparison]::OrdinalIgnoreCase) -ge 0)) { return $true }
    }
    foreach ($n in $NeverKillName) {
        if ($nm -and ($nm -ieq $n)) { return $true }
    }
    return $false
}

# ============================ 端口工具 ============================
function Get-PortListenerPid {
    param([int]$ListenPort)
    $owners = New-Object System.Collections.Generic.List[int]
    try {
        $conns = Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction Stop
        foreach ($c in $conns) { $owners.Add([int]$c.OwningProcess) }
    } catch {
        # 回退到 netstat（无 Get-NetTCPConnection 的老系统）
        $lines = & netstat.exe -ano -p TCP 2>$null
        $pattern = '^\s*TCP\s+\S+:' + $ListenPort + '\s+\S+\s+LISTENING\s+(\d+)\s*$'
        foreach ($l in $lines) {
            if ($l -match $pattern) { $owners.Add([int]$Matches[1]) }
        }
    }
    return @($owners | Sort-Object -Unique)
}

# 端口工具：DSH 每次重启挑到的端口可能变（54626 只是最早那次的），所以校验时
# 不看死端口，直接问「DSH 自己的进程有没有在监听」。
function Get-DshListeningPort {
    param($AllProcesses)
    $ids = @($AllProcesses | Where-Object { Test-IsDshProcess -Proc $_ } | ForEach-Object { [int]$_.ProcessId })
    $out = New-Object System.Collections.Generic.List[object]
    if ($ids.Count -eq 0) { return $out }
    try {
        $conns = Get-NetTCPConnection -State Listen -ErrorAction Stop
        foreach ($c in $conns) {
            if ($ids -contains [int]$c.OwningProcess) {
                $out.Add([pscustomobject]@{ Port = [int]$c.LocalPort; Pid = [int]$c.OwningProcess })
            }
        }
    } catch {
        $lines = & netstat.exe -ano -p TCP 2>$null
        foreach ($l in $lines) {
            if ($l -match '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
                if ($ids -contains [int]$Matches[2]) {
                    $out.Add([pscustomobject]@{ Port = [int]$Matches[1]; Pid = [int]$Matches[2] })
                }
            }
        }
    }
    return $out
}

# ============================ 启动入口解析 ============================
# 依次尝试桌面 lnk、开始菜单 lnk；都不可用时退回硬编码 exe 路径
function Resolve-LaunchEntry {
    foreach ($lnk in $DesktopLnkList) {
        if (-not (Test-Path -LiteralPath $lnk)) { continue }
        try {
            $shell = New-Object -ComObject WScript.Shell
            $sc = $shell.CreateShortcut($lnk)
            $target = [string]$sc.TargetPath
            if ($target -and (Test-Path -LiteralPath $target)) {
                $wd = [string]$sc.WorkingDirectory
                if ([string]::IsNullOrWhiteSpace($wd) -or -not (Test-Path -LiteralPath $wd)) {
                    $wd = $DesktopWorkDir
                }
                return [pscustomobject]@{
                    Source           = $lnk
                    FilePath         = $target
                    Arguments        = [string]$sc.Arguments
                    WorkingDirectory = $wd
                }
            }
        } catch {
            Write-Log -Level WARN -Text ('cannot read shortcut ' + $lnk + ' : ' + $_.Exception.Message)
        }
    }
    return [pscustomobject]@{
        Source           = 'hardcoded-exe (no shortcut found)'
        FilePath         = $DesktopExePath
        Arguments        = ''
        WorkingDirectory = $DesktopWorkDir
    }
}

function Start-DshDesktop {
    param($Entry)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Entry.FilePath
    $psi.Arguments = $Entry.Arguments
    $psi.WorkingDirectory = $Entry.WorkingDirectory
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $false

    # 环境变量清理：Electron 一旦继承 ELECTRON_RUN_AS_NODE 会不进 GUI；
    # 缺 DSH_PROFILE 会让 host 报 "cannot determine the boot profile" 直接崩。
    $dropKeys = @('ELECTRON_RUN_AS_NODE', 'DSH_PURGE_RESTART', 'DSH_PERMISSION_MODE')
    $existing = @($psi.EnvironmentVariables.Keys)
    foreach ($k in $existing) {
        if ($dropKeys -contains $k.ToUpperInvariant()) {
            [void]$psi.EnvironmentVariables.Remove($k)
        }
    }
    if (-not $psi.EnvironmentVariables.ContainsKey('DSH_PROFILE')) {
        $psi.EnvironmentVariables['DSH_PROFILE'] = 'desktop'
    }

    $proc = [System.Diagnostics.Process]::Start($psi)
    return $proc
}

# ============================ 主流程 ============================
Write-Host ''
Write-Host '=====================================================' -ForegroundColor Cyan
if ($Force) { Write-Host ' DSH RESTART - LIVE MODE (-Force)' -ForegroundColor Yellow }
else        { Write-Host ' DSH RESTART - DRY RUN (nothing will be killed)' -ForegroundColor Cyan }
Write-Host '=====================================================' -ForegroundColor Cyan

Write-Log -Text ('log file: ' + $LogPath)
Write-Log -Text ('mode: ' + $(if ($Force) { 'LIVE' } else { 'DRY-RUN' }) + ' | my pid: ' + $PID)

# ---- 0. 前置检查 ----
if (-not (Test-Path -LiteralPath $DesktopExePath)) {
    Write-Log -Level ERROR -Text ('desktop exe not found: ' + $DesktopExePath)
    [void](Save-Log)
    exit 3
}

if ($DelaySeconds -gt 0) {
    Write-Log -Text ('delay ' + $DelaySeconds + ' second(s) before touching anything (command log flush)')
    Start-Sleep -Seconds $DelaySeconds
}

# ---- 1. 快照：PID / 命令行 / 端口 ----
Write-Log -Text '--- STEP 1: snapshot current DSH processes ---'
$all = Get-ProcessSnapshot
$dsh = Get-DshProcess -AllProcesses $all

if ($dsh.Count -eq 0) {
    Write-Log -Level WARN -Text 'no running DSH process found; nothing to restart'
    [void](Save-Log)
    exit 3
}

$dshPidSet = @($dsh | ForEach-Object { [int]$_.ProcessId })
foreach ($p in $dsh) {
    $inSet = $dshPidSet -contains [int]$p.ParentProcessId
    Write-Log -Text ('  PID {0} | PPID {1} | in-tree-parent={2} | {3}' -f $p.ProcessId, $p.ParentProcessId, $inSet, $p.ExecutablePath)
    Write-Log -Text ('    CMD: ' + ([string]$p.CommandLine).Trim())
}

$portPid = Get-PortListenerPid -ListenPort $Port
if ($portPid.Count -gt 0) {
    Write-Log -Text ('  port ' + $Port + ' LISTEN owner pid: ' + ($portPid -join ','))
} else {
    Write-Log -Level WARN -Text ('  port ' + $Port + ' is not listening right now')
}

# 主进程 = 在 DSH 集合里"父进程不在集合内"的根，通常只有一个
$rootPid = @()
foreach ($p in $dsh) {
    if (-not ($dshPidSet -contains [int]$p.ParentProcessId)) { $rootPid += [int]$p.ProcessId }
}
if ($rootPid.Count -eq 0) { $rootPid = @($dshPidSet | Sort-Object | Select-Object -First 1) }
Write-Log -Text ('  root dsh pid: ' + ($rootPid -join ','))

$descPid = Get-DescendantPid -RootPid $rootPid -AllProcesses $all
$treePid = @($rootPid + @($descPid)) | Sort-Object -Unique

# 组装杀灭清单：只含 DSH 树，剔除自身与白名单
$killList = New-Object System.Collections.Generic.List[object]
$skipList = New-Object System.Collections.Generic.List[object]
foreach ($tp in $treePid) {
    if ([int]$tp -eq $PID) {
        $skipList.Add([pscustomobject]@{ Pid = [int]$tp; Why = 'this script itself' })
        continue
    }
    $proc = $all | Where-Object { [int]$_.ProcessId -eq [int]$tp } | Select-Object -First 1
    if (-not $proc) { continue }
    if (Test-NeverKill -Proc $proc) {
        $skipList.Add([pscustomobject]@{ Pid = [int]$tp; Why = 'never-kill list (bridge/helper)' })
        continue
    }
    $killList.Add($proc)
}

Write-Log -Text '--- STEP 1b: processes that WOULD be stopped ---'
foreach ($k in $killList) {
    Write-Log -Text ('  KILL PID {0} | {1} | {2}' -f $k.ProcessId, $k.Name, $k.ExecutablePath)
    Write-Log -Text ('    CMD: ' + ([string]$k.CommandLine).Trim())
}
foreach ($s in $skipList) {
    Write-Log -Level WARN -Text ('  SKIP PID {0} ({1})' -f $s.Pid, $s.Why)
}
Write-Log -Text ('  total to stop: ' + $killList.Count)

# ---- 启动入口 ----
$entry = Resolve-LaunchEntry
Write-Log -Text '--- STEP 1c: launch entry (from desktop / start-menu shortcut) ---'
Write-Log -Text ('  source : ' + $entry.Source)
Write-Log -Text ('  exe    : ' + $entry.FilePath)
Write-Log -Text ('  args   : [' + $entry.Arguments + ']')
Write-Log -Text ('  workdir: ' + $entry.WorkingDirectory)

if (-not [string]::IsNullOrWhiteSpace($PruneSession)) {
    Write-Log -Text ('  prune  : session=' + $PruneSession + ' args=[' + $PruneArgs + '] delay=' + $DelaySeconds + 's')
} else {
    Write-Log -Text '  prune  : none (plain restart)'
}

[void](Save-Log)

# ---- 2. 没有 -Force：只打印计划 ----
if (-not $Force) {
    Write-Host ''
    Write-Log -Level PLAN -Text '=== DRY RUN: the following would happen with -Force ==='
    Write-Log -Level PLAN -Text ('  0) snapshot log already written: ' + $LogPath)
    Write-Log -Level PLAN -Text ('  1) Stop-Process -Force on ' + $killList.Count + ' pid(s): ' + (($killList | ForEach-Object { $_.ProcessId }) -join ','))
    Write-Log -Level PLAN -Text ('  2) wait ' + $StopWaitSeconds + ' second(s) for ports/handles to release')
    Write-Log -Level PLAN -Text ('  3) relaunch: "' + $entry.FilePath + '" ' + $entry.Arguments + ' (cwd ' + $entry.WorkingDirectory + ', DSH_PROFILE=desktop, ELECTRON_RUN_AS_NODE removed)')
    Write-Log -Level PLAN -Text ('  4) wait ' + $BootWaitSeconds + ' second(s) then verify process + port ' + $Port)
    Write-Log -Level PLAN -Text '  hint: nothing was killed. re-run with -Force to actually restart.'
    [void](Save-Log)
    Write-Host ''
    Write-Host ('DRY RUN COMPLETE. log: ' + $LogPath) -ForegroundColor Cyan
    exit 0
}

# ---- 3. 真重启：如果自己被包在 DSH 树里，先搬到树外 ----
$insideTree = Test-InsideTree -TargetPid $PID -TreePid $treePid -AllProcesses $all
if ($insideTree -and $Detached) {
    Write-Log -Level ERROR -Text '-Detached was passed but this script is STILL inside the DSH tree: it would kill its own console. refusing to touch anything.'
    [void](Save-Log)
    exit 3
}
if ($insideTree -and -not $Detached) {
    Write-Log -Level WARN -Text 'this script runs INSIDE the DSH process tree; re-spawning itself outside via WMI'
    $self = $PSCommandPath
    $childLog = $LogPath
    $cmdLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $self + '"' +
               ' -Force -Detached -LogDirectory "' + $LogDirectory + '" -LogPath "' + $childLog + '"' +
               ' -Port ' + $Port + ' -StopWaitSeconds ' + $StopWaitSeconds + ' -BootWaitSeconds ' + $BootWaitSeconds +
               ' -DelaySeconds ' + $DelaySeconds + ' -PruneSession "' + $PruneSession + '" -PruneArgs "' + $PruneArgs + '"'
    try {
        $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
            CommandLine    = $cmdLine
            CurrentDirectory = 'C:\Windows'
        }
        if ($res.ReturnValue -ne 0) { throw ('Win32_Process.Create returned ' + $res.ReturnValue) }
        Write-Log -Level OK -Text ('detached restarter started, pid ' + $res.ProcessId + ' (parent = WmiPrvSE, outside DSH tree)')
        Write-Log -Text ('watch progress in: ' + $childLog)
        [void](Save-Log)
        exit 0
    } catch {
        Write-Log -Level ERROR -Text ('cannot detach restarter: ' + $_.Exception.Message)
        Write-Log -Level ERROR -Text 'aborted before killing anything; run this script from a plain PowerShell window instead'
        [void](Save-Log)
        exit 3
    }
}

# ---- 4. 停进程 ----
Write-Log -Text '--- STEP 3: stopping DSH process tree ---'
foreach ($k in $killList) {
    try {
        Stop-Process -Id ([int]$k.ProcessId) -Force -ErrorAction Stop
        Write-Log -Level OK -Text ('  stopped pid ' + $k.ProcessId + ' (' + $k.Name + ')')
    } catch {
        Write-Log -Level ERROR -Text ('  stop pid ' + $k.ProcessId + ' failed: ' + $_.Exception.Message)
    }
    [void](Save-Log)
}

# 等它们真的消失，最多 StopWaitSeconds 秒
$deadline = (Get-Date).AddSeconds($StopWaitSeconds)
$alive = @()
while ((Get-Date) -lt $deadline) {
    $alive = @($killList | ForEach-Object { $_.ProcessId } | Where-Object { Get-Process -Id ([int]$_) -ErrorAction SilentlyContinue })
    if ($alive.Count -eq 0) { break }
    Start-Sleep -Milliseconds 200
}
if ($alive.Count -gt 0) {
    Write-Log -Level WARN -Text ('  still alive after ' + $StopWaitSeconds + 's: ' + ($alive -join ','))
} else {
    Write-Log -Level OK -Text '  all target pids are gone'
}

# ---- 5. 等 3 秒 ----
Write-Log -Text ('--- STEP 4: waiting ' + $StopWaitSeconds + ' second(s) ---')
[void](Save-Log)
Start-Sleep -Seconds $StopWaitSeconds

$leftPort = Get-DshListeningPort -AllProcesses (Get-ProcessSnapshot)
if ($leftPort.Count -gt 0) {
    Write-Log -Level WARN -Text ('  DSH pid still listening on ' + (($leftPort | ForEach-Object { $_.Port }) -join ',') + ' (new instance may fail to bind)')
} else {
    Write-Log -Level OK -Text '  no DSH listener left'
}

# ---- 5b. 剪会话（DSH 已经死了，此时写文件不会被活会话覆盖）----
if (-not [string]::IsNullOrWhiteSpace($PruneSession)) {
    Write-Log -Text '--- STEP 4b: pruning session while DSH is down ---'
    $nodeExe = if ($env:DSH_PRUNE_NODE) { $env:DSH_PRUNE_NODE } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
    $pruneCli = if ($env:DSH_PRUNE_CLI) { $env:DSH_PRUNE_CLI } else { Join-Path $PSScriptRoot 'dsh-prune.mjs' }
    if (-not (Test-Path -LiteralPath $nodeExe)) {
        Write-Log -Level ERROR -Text ('  node not found: ' + $nodeExe + ' -- skip prune, session untouched')
    } elseif (-not (Test-Path -LiteralPath $pruneCli)) {
        Write-Log -Level ERROR -Text ('  dsh-prune.mjs not found: ' + $pruneCli + ' -- skip prune, session untouched')
    } else {
        $extra = @()
        if (-not [string]::IsNullOrWhiteSpace($PruneArgs)) {
            $extra = @($PruneArgs -split '\s+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        }
        Write-Log -Text ('  cmd: node dsh-prune.mjs prune ' + $PruneSession + ' ' + ($extra -join ' '))
        $pruneOut = @()
        try {
            $pruneOut = @(& $nodeExe $pruneCli 'prune' $PruneSession @extra 2>&1 | ForEach-Object { [string]$_ })
            $pruneCode = $LASTEXITCODE
        } catch {
            $pruneOut = @('exception: ' + $_.Exception.Message)
            $pruneCode = 1
        }
        foreach ($line in $pruneOut) { Write-Log -Text ('    ' + $line) }
        if ($pruneCode -eq 0) {
            Write-Log -Level OK -Text '  prune finished (backup kept beside the session file)'
        } else {
            Write-Log -Level ERROR -Text ('  prune failed with exit ' + $pruneCode + ' -- session file left as it was')
        }
    }
}

# ---- 6. 重新启动 ----
Write-Log -Text '--- STEP 5: relaunching ---'
[void](Save-Log)
$newPid = 0
try {
    $proc = Start-DshDesktop -Entry $entry
    $newPid = [int]$proc.Id
    Write-Log -Level OK -Text ('  launched pid ' + $newPid + ' : "' + $entry.FilePath + '" ' + $entry.Arguments)
} catch {
    Write-Log -Level ERROR -Text ('  relaunch failed: ' + $_.Exception.Message + ' -- retry with ShellExecute')
    try {
        Start-Process -FilePath $entry.FilePath -ArgumentList $entry.Arguments -WorkingDirectory $entry.WorkingDirectory
        Write-Log -Level OK -Text '  retried launch via ShellExecute (env inherited from explorer)'
    } catch {
        Write-Log -Level ERROR -Text ('  retry failed too: ' + $_.Exception.Message)
        [void](Save-Log)
        exit 2
    }
}

# ---- 7. 等 8 秒后校验 ----
Write-Log -Text ('--- STEP 6: verifying, polling up to ' + $BootWaitSeconds + ' second(s) ---')
# 宿主从起进程到开始监听一般要 10 秒以上，固定 8 秒会误报 PARTIAL。
# 改成每 2 秒轮询一次，抓到监听就提前收工。
$deadline = (Get-Date).AddSeconds($BootWaitSeconds)
do {
    Start-Sleep -Seconds 2
    $all2 = Get-ProcessSnapshot
    $dsh2 = Get-DshProcess -AllProcesses $all2
    $listen2 = Get-DshListeningPort -AllProcesses $all2
} while (((Get-Date) -lt $deadline) -and ($listen2.Count -eq 0))

$winTitles = @()
foreach ($p in $dsh2) {
    $gp = Get-Process -Id ([int]$p.ProcessId) -ErrorAction SilentlyContinue
    if ($gp -and $gp.MainWindowTitle) { $winTitles += ($p.ProcessId.ToString() + ':' + $gp.MainWindowTitle) }
}

$okProc = ($dsh2.Count -gt 0)
$okPort = ($listen2.Count -gt 0)

Write-Log -Text ('  dsh processes now: ' + $dsh2.Count)
foreach ($p in $dsh2) {
    Write-Log -Text ('    PID {0} | PPID {1} | {2}' -f $p.ProcessId, $p.ParentProcessId, $p.ExecutablePath)
}
if ($listen2.Count -gt 0) {
    Write-Log -Text ('  DSH listening on: ' + (($listen2 | ForEach-Object { $_.Port.ToString() + '(pid ' + $_.Pid + ')' }) -join ', '))
} else {
    Write-Log -Text '  no DSH process owns a listening port yet'
}
if ($winTitles.Count -gt 0) {
    Write-Log -Text ('  windows: ' + ($winTitles -join ' | '))
} else {
    Write-Log -Level WARN -Text '  no visible window title detected yet (may still be loading)'
}

if ($okProc -and $okPort) {
    Write-Log -Level OK -Text 'RESULT: PASS - desktop process up and serving'
    $code = 0
} elseif ($okProc) {
    Write-Log -Level WARN -Text 'RESULT: PARTIAL - process up but nothing listening yet (give it more seconds)'
    $code = 2
} else {
    Write-Log -Level ERROR -Text 'RESULT: FAIL - no DSH process after relaunch'
    $code = 2
}

[void](Save-Log)
Write-Host ''
Write-Host ('done. log: ' + $LogPath) -ForegroundColor Cyan
exit $code
