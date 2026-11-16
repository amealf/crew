import { execute } from './adapters/process.js';

function xmlText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function notificationScript({ task, status }) {
  const statuses = { approved: '审阅通过', waiting_approval: '等待人工确认', stopped: '运行已停止' };
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlText(`crew · ${task}`)}</text><text>${xmlText(`${statuses[status] ?? status}（${status}）`)}</text></binding></visual></toast>`;
  const payload = Buffer.from(xml, 'utf8').toString('base64');
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')))`,
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
    // Windows 11 already registers this app ID. An arbitrary unregistered
    // PowerShell label creates a notifier whose Setting getter fails.
    "$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.WindowsTerminal_8wekyb3d8bbwe!App')",
    // Direct invocation surfaces a WinRT HRESULT; PowerShell property syntax
    // can suppress a getter exception and return null instead.
    '$setting = $notifier.get_Setting()',
    "if ($setting.ToString() -ne 'Enabled') { throw ('Windows 通知不可用：' + $setting.ToString()) }",
    '$notifier.Show($toast)',
    '',
  ].join('\n');
}

export async function notify({ cwd, task, status, runDir, platform = process.platform, executeCommand = execute }) {
  if (platform !== 'win32') return { ok: false, skipped: true, error: '桌面通知仅支持 Windows。' };
  try {
    const script = notificationScript({ task, status });
    const reader = '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))';
    const raw = await executeCommand('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', reader], {
      cwd, prompt: script, timeoutMs: 15_000,
    });
    if (raw.exitCode !== 0 || raw.timedOut || raw.error) return { ok: false,
      error: `桌面通知发送失败：${raw.error || raw.stderr?.trim() || (raw.timedOut ? '通知进程超时。' : `退出码 ${raw.exitCode}`)}` };
    return { ok: true };
  } catch (error) { return { ok: false, error: `桌面通知发送失败：${error.message}` }; }
}
