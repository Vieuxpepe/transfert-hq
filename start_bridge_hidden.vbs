' Transfert HQ - starts the bridge in a hidden window, with its output going to bridge_stdout.log / bridge_stderr.log
' (see start_bridge_logged.cmd). The console stays invisible; the traceback does not disappear.
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run chr(34) & "C:\Transfert\start_bridge_logged.cmd" & chr(34), 0, False
