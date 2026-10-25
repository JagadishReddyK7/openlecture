# Runs one Q&A WebSocket load level and collects everything results.md needs.
#
#   .\scripts\run-qa-load.ps1 -Clients 200 -Tag p1-200
#
# Writes to docs/raw/:
#   <Tag>-k6.txt        k6 console output + end-of-test summary
#   <Tag>-summary.json  k6 --summary-export
#   <Tag>-stats.csv     docker stats samples (services + the k6 container)
#   <Tag>-redis.txt     Redis INFO stats/commandstats (reset just before the run)
#   <Tag>-derived.txt   per-client rates, CPU over the steady window, socket spread
param(
  [Parameter(Mandatory = $true)] [int] $Clients,
  [Parameter(Mandatory = $true)] [string] $Tag,
  [int] $Ramp = 30,
  [int] $Steady = 120,
  [string] $K6Image = 'grafana/k6:1.3.0',
  # Extra k6 env vars, e.g. -K6Env 'SEED_QUESTIONS=1000','QMAX=1100'
  [string[]] $K6Env = @(),
  [switch] $AllowBattery
)

# A laptop on battery throttles the CPU and may sleep mid-run (an earlier
# attempt at 500 clients was frozen by a critical-battery sleep), so refuse
# to measure unless on AC power.
$battery = Get-CimInstance Win32_Battery
if ($battery -and $battery.BatteryStatus -ne 2 -and -not $AllowBattery) {
  Write-Error "On battery ($($battery.EstimatedChargeRemaining)%). Plug in, or pass -AllowBattery."
  exit 1
}

# Keep Windows awake while this script runs (released automatically on exit)
Add-Type -Namespace Win32 -Name Power -MemberDefinition `
  '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);' -ErrorAction SilentlyContinue
[Win32.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
$gc = Split-Path -Parent $PSScriptRoot                     # globalclass/
$raw = Join-Path (Split-Path -Parent $gc) 'docs\raw'
New-Item -ItemType Directory -Force $raw | Out-Null
Set-Location $gc

docker compose exec -T redis redis-cli CONFIG RESETSTAT 2>$null | Out-Null

# docker stats in the background; the k6 container is named globalclass-k6 so
# the sampler's name filter picks it up too
$statsCsv = Join-Path $raw "$Tag-stats.csv"
$sampler = Start-Job -ScriptBlock {
  param($script, $out) & $script -Out $out -Seconds 3600 | Out-Null
} -ArgumentList (Join-Path $PSScriptRoot 'sample-stats.ps1'), $statsCsv

$stdout = Join-Path $raw "$Tag-k6.out"
$stderr = Join-Path $raw "$Tag-k6.err"
# --memory: if the clients can't keep up with the fan-out, k6's queues grow
# without bound. Capped, k6 is OOM-killed; uncapped, it took the whole Docker
# VM down with it (P1, 500 clients).
$k6Args = @('run', '--rm', '-i', '--name', 'globalclass-k6', '--memory', '5g', '--network', 'globalclass_default',
  '-v', "$gc\k6:/k6", '-v', "${raw}:/out", $K6Image, 'run', '/k6/qa_ws_test.js',
  '--env', "CLIENTS=$Clients", '--env', "RAMP=$Ramp", '--env', "STEADY=$Steady",
  '--summary-export', "/out/$Tag-summary.json")
foreach ($e in $K6Env) { $k6Args += @('--env', $e) }
$p = Start-Process docker -ArgumentList $k6Args -NoNewWindow -Wait -PassThru `
  -RedirectStandardOutput $stdout -RedirectStandardError $stderr
Stop-Job $sampler; Remove-Job $sampler -Force

$k6Txt = Join-Path $raw "$Tag-k6.txt"
"docker $($k6Args -join ' ')`n# exit code $($p.ExitCode)`n" | Out-File -Encoding utf8 $k6Txt
Get-Content $stderr, $stdout | Out-File -Append -Encoding utf8 $k6Txt
Remove-Item $stdout, $stderr

docker compose exec -T redis redis-cli INFO stats 2>$null | Out-File -Encoding utf8 (Join-Path $raw "$Tag-redis.txt")
docker compose exec -T redis redis-cli INFO commandstats 2>$null | Out-File -Append -Encoding utf8 (Join-Path $raw "$Tag-redis.txt")

# ---- derived numbers -------------------------------------------------------
$log = Get-Content $k6Txt -Raw
$lectureId = [regex]::Match($log, 'LECTURE_ID ([0-9a-f-]{36})').Groups[1].Value
$win = [regex]::Match($log, 'STEADY_WINDOW ([^\s"]+) ([^\s"]+)')
$from = [datetimeoffset]::Parse($win.Groups[1].Value)
$to = [datetimeoffset]::Parse($win.Groups[2].Value)

$summaryPath = Join-Path $raw "$Tag-summary.json"
if (-not (Test-Path $summaryPath)) {
  Write-Warning "k6 did not finish (exit code $($p.ExitCode)): no client-side metrics. Server-side stats and Redis INFO are still saved."
  $m = [pscustomobject]@{}
} else {
  # k6 writes setup()'s return value (every test user's JWT) into the
  # summary. Drop it so the file is safe to commit.
  $summary = Get-Content $summaryPath -Raw | ConvertFrom-Json
  $summary.PSObject.Properties.Remove('setup_data')
  $summary | ConvertTo-Json -Depth 20 | Out-File -Encoding utf8 $summaryPath
  $m = $summary.metrics
}
function Count($name) { if ($m.$name) { [double]$m.$name.count } else { 0 } }
$perClient = { param($v) [math]::Round($v / $Clients / $Steady, 2) }

$out = @()
$out += "tag=$Tag clients=$Clients steady=${Steady}s lecture=$lectureId"
$out += "window $($from.ToString('o')) .. $($to.ToString('o'))"
$out += ''
$out += "mutations sent (steady)      : $(Count 'qa_mutations_sent')  ($([math]::Round((Count 'qa_mutations_sent') / $Steady, 1))/s cluster-wide)"
$out += "msgs received per client/s   : $(& $perClient (Count 'qa_msgs'))"
$out += "updates received per client/s: $(& $perClient (Count 'qa_update_msgs'))"
$out += "bytes received per client/s  : $(& $perClient (Count 'qa_bytes'))"
$out += "total bytes received/s       : $([math]::Round((Count 'qa_bytes') / $Steady))"
$out += "ack timeouts / errors        : $(Count 'qa_ack_timeouts') / $(Count 'qa_errors')"
$out += "abnormal closes / connect err: $(Count 'qa_abnormal_close') / $(Count 'qa_connect_errors')"
$lat = $m.qa_update_latency
if ($lat) { $out += "update latency ms            : med $($lat.med)  p95 $($lat.'p(95)')  p99 $($lat.'p(99)')  max $($lat.max)" }

$out += ''
$out += 'CPU % over the steady window (100 = one core):'
Import-Csv $statsCsv | Where-Object {
  $t = [datetimeoffset]::Parse($_.timestamp); $t -ge $from -and $t -le $to
} | Group-Object container | Sort-Object Name | ForEach-Object {
  $cpu = $_.Group | ForEach-Object { [double]$_.cpu_pct }
  $out += '  {0,-32} n={1,3} mean={2,6:N1} peak={3,6:N1}' -f $_.Name, $cpu.Count,
    ($cpu | Measure-Object -Average).Average, ($cpu | Measure-Object -Maximum).Maximum
}

$out += ''
$out += 'Sockets per core-api instance:'
docker compose logs core-api 2>$null | Select-String "connected to lecture $lectureId" |
  ForEach-Object { ($_.Line -split '\|')[0].Trim() } | Group-Object | Sort-Object Name |
  ForEach-Object { $out += "  $($_.Name): $($_.Count)" }

$out += ''
$redis = Get-Content (Join-Path $raw "$Tag-redis.txt")
$out += 'Redis (since RESETSTAT):'
$redis | Select-String '^(total_net_output_bytes|total_commands_processed|cmdstat_(publish|hgetall|incr|eval|hsetnx|hincrby)):' |
  ForEach-Object { $out += "  $($_.Line.Trim())" }

$out | Out-File -Encoding utf8 (Join-Path $raw "$Tag-derived.txt")
$out
[Win32.Power]::SetThreadExecutionState([uint32]2147483648) | Out-Null   # ES_CONTINUOUS: back to normal
