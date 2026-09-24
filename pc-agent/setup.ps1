# One-time setup for the Home Deck PC agent.
#   powershell -ExecutionPolicy Bypass -File setup.ps1            # install deps + start at logon
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Uninstall # remove the logon shortcut
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$venv = Join-Path $here '.venv'
$shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Home Deck Agent.lnk'

if ($Uninstall) {
    if (Test-Path $shortcut) { Remove-Item $shortcut -Confirm:$false; Write-Host 'Removed logon shortcut.' }
    Get-CimInstance Win32_Process -Filter "Name = 'pythonw.exe'" |
        Where-Object { $_.CommandLine -like '*agent.py*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Confirm:$false; Write-Host "Stopped agent (PID $($_.ProcessId))." }
    return
}

if (-not (Test-Path (Join-Path $venv 'Scripts\python.exe'))) {
    Write-Host 'Creating virtual environment...'
    py -3 -m venv $venv
}
Write-Host 'Installing dependencies...'
& (Join-Path $venv 'Scripts\python.exe') -m pip install --quiet --disable-pip-version-check -r (Join-Path $here 'requirements.txt')

# Start at logon, windowless. It must run inside your user session (not as a service) so it can
# see Spotify and send keystrokes.
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($shortcut)
$lnk.TargetPath = Join-Path $venv 'Scripts\pythonw.exe'
$lnk.Arguments = '"' + (Join-Path $here 'agent.py') + '"'
$lnk.WorkingDirectory = $here
$lnk.Description = 'Home Deck PC agent'
$lnk.Save()
Write-Host "Added logon shortcut: $shortcut"

$running = Get-CimInstance Win32_Process -Filter "Name = 'pythonw.exe' OR Name = 'python.exe'" |
    Where-Object { $_.CommandLine -like '*agent.py*' }
if (-not $running) {
    Start-Process -FilePath $lnk.TargetPath -ArgumentList $lnk.Arguments -WorkingDirectory $here
    Start-Sleep -Seconds 3
    Write-Host 'Agent started.'
}

$config = Get-Content (Join-Path $here 'config.json') -Raw | ConvertFrom-Json
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -eq 'Dhcp' -or $_.PrefixOrigin -eq 'Manual' } |
    Where-Object { $_.IPAddress -notlike '169.254*' } | Select-Object -First 1).IPAddress
Write-Host ''
Write-Host 'Enter these in Home Deck -> Settings -> PC agent:'
Write-Host "  Agent URL:   http://${ip}:$($config.port)"
Write-Host "  Agent token: $($config.token)"
Write-Host ''
Write-Host 'If the laptop cannot connect, allow the port through Windows Firewall (run PowerShell as Administrator):'
Write-Host "  New-NetFirewallRule -DisplayName 'Home Deck Agent' -Direction Inbound -Protocol TCP -LocalPort $($config.port) -Profile Private -Action Allow"
