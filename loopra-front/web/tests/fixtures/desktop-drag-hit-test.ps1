param([long]$Handle, [string]$Coordinates)

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DesktopDragHitTest {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
}
'@

[DesktopDragHitTest]::SetProcessDPIAware() | Out-Null
foreach ($coordinate in $Coordinates.Split(';')) {
  $xy = $coordinate.Split(',')
  $point = New-Object DesktopDragHitTest+Point
  $point.X = [int]$xy[0]
  $point.Y = [int]$xy[1]
  [DesktopDragHitTest]::ClientToScreen([IntPtr]::new($Handle), [ref]$point) | Out-Null
  $position = (($point.Y -band 0xffff) -shl 16) -bor ($point.X -band 0xffff)
  [DesktopDragHitTest]::SendMessage([IntPtr]::new($Handle), 0x84, [IntPtr]::Zero, [IntPtr]::new($position)).ToInt64()
}
