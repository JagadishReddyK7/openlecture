# Failure demo: kill one core-api instance in the middle of a Q&A load run.
#
#   .\scripts\chaos-kill-core.ps1 -Clients 1000 -Tag p4-chaos
#
# 1. starts run-qa-load.ps1 (k6 clients reconnect with jittered backoff)
# 2. KillAfter seconds into the steady window: `docker kill` one core-api
# 3. after k6 ends, waits for the dead instance's heartbeat to expire and the
#    sweeper to run the final flush, then compares with Postgres:
#      every ACKed question / vote must be in Postgres
#      (unacked = sent - acked - rejected: may or may not have been stored)
# 4. brings core-api back to 3 instances
#
# Results are appended to docs/raw/<Tag>-derived.txt (and printed).
param(
  [int] $Clients = 1000,
  [Parameter(Mandatory = $true)] [string] $Tag,
  [int] $KillAfter = 30,
  [int] $SettleSeconds = 30,
  [int] $Steady = 120,
  [string[]] $K6Env = @()
)
$gc = Split-Path -Parent $PSScriptRoot
$raw = Join-Path (Split-Path -Parent $gc) 'docs\raw'
Set-Location $gc

$victim = (docker compose ps -q core-api 2>$null | Select-Object -First 1)
$victimName = (docker inspect -f '{{.Name}}' $victim).TrimStart('/')
$killLog = Join-Path $raw "$Tag-kill.txt"

# Killer: wait for k6 to print its steady window, then kill at start + KillAfter
$killer = Start-Job -ScriptBlock {
  param($victim, $victimName, $killAfter, $killLog)
  $start = $null
  while (-not $start) {
    Start-Sleep -Milliseconds 500
    $line = docker logs globalclass-k6 2>&1 | Select-String 'STEADY_WINDOW (\S+)' | Select-Object -First 1
    if ($line) { $start = [datetimeoffset]::Parse(($line.Matches[0].Groups[1].Value).Trim('"')) }
  }
  $at = $start.AddSeconds($killAfter)
  $wait = ($at - [datetimeoffset]::UtcNow).TotalMilliseconds
  if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
  docker kill $victim | Out-Null
  "killed $victimName ($victim) at $([datetimeoffset]::UtcNow.ToString('o')) (steady start + ${killAfter}s)" | Out-File -Encoding utf8 $killLog
} -ArgumentList $victim, $victimName, $KillAfter, $killLog

& (Join-Path $PSScriptRoot 'run-qa-load.ps1') -Clients $Clients -Tag $Tag -Steady $Steady -K6Env $K6Env | Out-Null
Wait-Job $killer -Timeout 5 | Out-Null; Remove-Job $killer -Force

# The dead instance's sockets stop counting once qa:alive:<id> expires (15 s);
# the next 5 s sweep then runs the final flush.
Start-Sleep -Seconds $SettleSeconds

$k6Txt = Get-Content (Join-Path $raw "$Tag-k6.txt") -Raw
$lectureId = [regex]::Match($k6Txt, 'LECTURE_ID ([0-9a-f-]{36})').Groups[1].Value
$summaryPath = Join-Path $raw "$Tag-summary.json"
if (-not $lectureId -or -not (Test-Path $summaryPath)) {
  Write-Error "k6 produced no lecture id or summary (see $Tag-k6.txt): nothing to verify."
  docker compose up -d --scale core-api=3 --scale streaming-engine=3 2>$null | Out-Null
  exit 1
}
$m = (Get-Content (Join-Path $raw "$Tag-summary.json") -Raw | ConvertFrom-Json).metrics
function C($name) { $v = $m.$name; if ($v) { [int]$v.count } else { 0 } }

$pgQ = (docker compose exec -T postgres psql -U postgres -d globalclass -tAc "SELECT count(*) FROM questions WHERE lecture_id = '$lectureId'" 2>$null).Trim()
$pgV = (docker compose exec -T postgres psql -U postgres -d globalclass -tAc "SELECT count(*) FROM votes v JOIN questions q ON q.id = v.question_id WHERE q.lecture_id = '$lectureId'" 2>$null).Trim()
$left = docker compose exec -T redis redis-cli --scan --pattern "qa:*$lectureId" 2>$null
$active = (docker compose exec -T redis redis-cli SISMEMBER qa:active $lectureId 2>$null).Trim()

$out = @('', '--- chaos ---')
$out += Get-Content $killLog
foreach ($t in 'SUBMIT_QUESTION', 'VOTE') {
  $sent = C "qa_sent_total{type:$t}"; $acked = C "qa_acked_total{type:$t}"; $rej = C "qa_rejected_total{type:$t}"
  $pg = if ($t -eq 'VOTE') { [int]$pgV } else { [int]$pgQ }
  $unacked = $sent - $acked - $rej
  $ok = ($pg -ge $acked) -and ($pg -le $acked + $unacked)
  $out += "{0,-16} sent {1,6}  acked {2,6}  rejected {3,5}  unacked {4,4}  in Postgres {5,6}  -> {6}" -f `
    $t, $sent, $acked, $rej, $unacked, $pg, $(if ($ok) { 'OK (acked <= stored <= acked + unacked)' } else { 'MISMATCH' })
}
$rt = $m.qa_reconnect_time
$out += "abnormal closes: $(C 'qa_abnormal_close')   reconnects: $(C 'qa_reconnects')   ticket errors: $(C 'qa_ticket_errors')   connect errors: $(C 'qa_connect_errors')"
if ($rt) { $out += "reconnect time ms (close -> open): med $($rt.med)  p95 $($rt.'p(95)')  p99 $($rt.'p(99)')  max $($rt.max)" }
$out += "Redis after settle: $(@($left | Where-Object { $_ }).Count) qa:* keys left for the lecture, in qa:active: $active"

$out | Out-File -Append -Encoding utf8 (Join-Path $raw "$Tag-derived.txt")
$out

docker compose logs core-api 2>$null | Select-String "Sweep\] $lectureId|Flush\] $lectureId" |
  ForEach-Object { $_.Line } | Out-File -Encoding utf8 (Join-Path $raw "$Tag-sweep.txt")

docker compose up -d --scale core-api=3 --scale streaming-engine=3 2>$null | Out-Null
Start-Sleep -Seconds 8
docker compose restart api-gateway 2>$null | Out-Null
