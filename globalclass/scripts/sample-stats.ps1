# Samples `docker stats` for the globalclass containers into a CSV while a
# load test runs. Start it in a second terminal just before k6:
#
#   .\scripts\sample-stats.ps1 -Out results\p0-stress-stats.csv -Seconds 540
#
# Each row: timestamp, container, CPU %, memory, net I/O. Use the CSV for the
# CPU numbers in docs/results.md (peak and mean per container).
param(
  [Parameter(Mandatory = $true)] [string] $Out,
  [int] $Seconds = 600,
  [string] $Filter = 'globalclass'
)

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
'timestamp,container,cpu_pct,mem_usage,net_io' | Out-File -Encoding utf8 $Out

$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  $ts = (Get-Date).ToString('o')
  # --no-stream takes one sample (~1-2 s per call)
  docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.NetIO}}' |
    Where-Object { $_ -like "*$Filter*" } |
    ForEach-Object { "$ts,$($_ -replace '%','')" } |
    Out-File -Append -Encoding utf8 $Out
}

# Summary: mean and peak CPU per container
Import-Csv $Out | Group-Object container | ForEach-Object {
  $cpu = $_.Group | ForEach-Object { [double]$_.cpu_pct }
  [pscustomobject]@{
    container = $_.Name
    samples   = $cpu.Count
    cpu_mean  = [math]::Round(($cpu | Measure-Object -Average).Average, 1)
    cpu_peak  = [math]::Round(($cpu | Measure-Object -Maximum).Maximum, 1)
  }
} | Format-Table -AutoSize
