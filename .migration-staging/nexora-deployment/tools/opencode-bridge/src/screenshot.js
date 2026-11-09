import { spawn } from 'node:child_process';

const MAX_BYTES = 4 * 1024 * 1024; // keep MCP image blocks reasonable

const SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$graphics.Dispose()
$stream = New-Object System.IO.MemoryStream
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/png' }
$encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Compression, [long]0)
$bitmap.Save($stream, $codec, $encoderParams)
$bitmap.Dispose()
[Convert]::ToBase64String($stream.ToArray())
`;

function runPowerShell(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('screenshot capture timed out'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `screenshot capture failed (exit ${code})`));
    });
  });
}

/**
 * Capture the primary screen as a PNG. Returns { data, mimeType } where data is
 * base64 PNG suitable for an MCP image content block. Runs only when called.
 */
export async function captureScreenshot({ timeoutMs = 20_000 } = {}) {
  const base64 = await runPowerShell(SCRIPT, timeoutMs);
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('screenshot capture produced no image data');
  if (buffer.length > MAX_BYTES) {
    throw new Error(
      `Screenshot is ${Math.round(buffer.length / 1024)} KB, above the ${(MAX_BYTES / 1024 / 1024).toFixed(0)} MB image limit. Reduce screen resolution/zoom and retry.`,
    );
  }
  return { data: base64, mimeType: 'image/png', bytes: buffer.length };
}

/** Diagnostic helper used by tests: validates the PowerShell stack works. */
export async function screenshotSupported() {
  try {
    const result = await captureScreenshot({ timeoutMs: 15_000 });
    return { supported: true, ...result };
  } catch (error) {
    return { supported: false, error: error.message };
  }
}
