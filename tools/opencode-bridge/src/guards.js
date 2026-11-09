/**
 * Heuristic denylist for shell commands that must never run without an explicit
 * user confirmation (confirm=true in opencode_shell_run). Covers deletes that
 * recurse, Windows registry edits, service/driver changes, system installs,
 * boot/FS manipulation, and forced process/network operations.
 */
export const HIGH_RISK_COMMAND =
  /(\breg\.exe\b|\breg\s+(add|edit|delete|compare|copy|export|import|load|restore|save|unload)\b|\bregedit\b|\bdism\b|\bformat\s+[a-z]:|\bdel\s+\/(s|f|q)|\brmdir\s+\/s|\bremove-item\b[^|]*-(recurs|force)|\brm\s+-[a-z]*r[a-z]f?|\b(set|stop|start|restart|new)-service\b|\bsc(\.exe)?\s+(config|delete|create|stop|start)\b|\bnetsh\b|\bbcdedit\b|\bbcdboot\b|\bicacls\b|\btakeown\b|\btaskkill\b\s*\/(f|im)|\bshutdown(\.exe)?\b|\b(restart|stop)-computer\b|\bmsiexec\b|\bwinget\s+(install|uninstall|upgrade)\b|\bchoco\s+(install|uninstall|upgrade)\b|\bapt(-get)?\s+(remove|purge|autoremove|install)\b|\bpip\s+(uninstall|install)\b.*--(system|break)|\bcipher\s+\/w\b|\bwevtutil\b\s+cl\b|\bclear-recyclebin\b|\bfsutil\b|\bdiskpart\b|\bmountvol\b|\bnet\s+(user|localgroup)\s+\S+\s|driverquery\s+\/\S*\b|pnputil\s+(\/delete-driver|\/add-driver)\b|\bgit\s+push\s+\S+\s+(main|master)\b|\bSet-ItemProperty\b.*\bHK(CU|LM):)/i;

export function isHighRiskCommand(command) {
  return HIGH_RISK_COMMAND.test(String(command || ''));
}
