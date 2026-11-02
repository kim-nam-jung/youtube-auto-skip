param([Parameter(Mandatory)][int]$BrowserProcessId,
      [Parameter(Mandatory)][string]$BrowserExecutable,
      [switch]$Inspect)
$ErrorActionPreference = 'Stop'
$fixtureProcess = Get-Process -Id $BrowserProcessId
if ($fixtureProcess.Path -ne [IO.Path]::GetFullPath($BrowserExecutable)) { throw 'Fixture process path changed' }
$fixtureCommand = (Get-CimInstance Win32_Process -Filter "ProcessId = $BrowserProcessId").CommandLine
if ($fixtureCommand -notmatch 'youtube-background-fixture-[A-Za-z0-9]+') { throw 'Not an isolated fixture process' }
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class FixtureWindow {
 public delegate bool EnumCallback(IntPtr hwnd, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback c,IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 public static IntPtr[] Find(uint pid) {
  var list=new List<IntPtr>();
  EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);if(owner==pid && IsWindowVisible(h))list.Add(h);return true;},IntPtr.Zero);
  return list.ToArray();
 }
 public static uint ForegroundPid(){uint p;GetWindowThreadProcessId(GetForegroundWindow(),out p);return p;}
}
'@
$fixtureWindows = @([FixtureWindow]::Find($BrowserProcessId))
if (!$fixtureWindows.Count) { throw 'No native fixture window to minimize' }
if (!$Inspect) { foreach ($fixtureWindow in $fixtureWindows) { $null = [FixtureWindow]::ShowWindow($fixtureWindow, 6) } }
[pscustomobject]@{ windowCount=$fixtureWindows.Count;
  allMinimized=(@($fixtureWindows | Where-Object { ![FixtureWindow]::IsIconic($_) }).Count -eq 0);
  foregroundInProcess=([FixtureWindow]::ForegroundPid() -eq $BrowserProcessId) } | ConvertTo-Json -Compress
