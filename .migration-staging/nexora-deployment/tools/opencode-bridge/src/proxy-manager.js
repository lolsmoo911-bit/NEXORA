import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WARP_PROXY_URL = 'http://127.0.0.1:40000';
const PROBE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
const VALUES = {
  HTTP_PROXY: WARP_PROXY_URL,
  HTTPS_PROXY: WARP_PROXY_URL,
  NO_PROXY: 'localhost,127.0.0.1,::1',
};
const NAMES = Object.keys(VALUES);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function decodeXml(value) {
  return String(value || '').replaceAll('&quot;', '"').replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}
function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function parseTag(tag) {
  const n = tag.match(/\bname\s*=\s*(["'])(.*?)\1/i);
  const v = tag.match(/\bvalue\s*=\s*(["'])(.*?)\1/i);
  return n ? { name: decodeXml(n[2]), value: v ? decodeXml(v[2]) : '' } : null;
}
export function parseProxyEnvironment(xml) {
  const entries = new Map();
  for (const match of String(xml).matchAll(/<env\b[^>]*\/>/gi)) {
    const item = parseTag(match[0]);
    if (!item || !NAMES.includes(item.name)) continue;
    const list = entries.get(item.name) || [];
    list.push({ raw: match[0], value: item.value });
    entries.set(item.name, list);
  }
  return entries;
}
function insertTags(xml, tags) {
  if (!tags.length) return xml;
  const nl = xml.includes('\r\n') ? '\r\n' : '\n';
  const indent = (xml.match(/\r?\n([ \t]*)<env\b/i) || [null, '  '])[1];
  const block = tags.map((tag) => indent + tag).join(nl) + nl;
  const start = xml.match(/^[ \t]*<startmode\b.*$/im);
  if (start && start.index !== undefined) {
    return xml.slice(0, start.index) + block + xml.slice(start.index);
  }
  const close = xml.lastIndexOf('</service>');
  if (close < 0) throw new Error('OpenCodeAgent.xml is missing </service>');
  return xml.slice(0, close) + block + xml.slice(close);
}
export function applyManagedProxyEnvironment(xml) {
  const input = String(xml);
  const current = parseProxyEnvironment(input);
  const originalEntries = {};
  const missing = [];
  for (const name of NAMES) {
    const found = current.get(name) || [];
    if (found.length > 1) throw new Error('Duplicate ' + name + ' entries; refusing to continue.');
    originalEntries[name] = found.length ? found[0].raw : null;
    if (found.length && found[0].value !== VALUES[name]) {
      throw new Error('Existing ' + name + ' differs; refusing to overwrite.');
    }
    if (!found.length) missing.push('<env name="' + name + '" value="' + escapeXml(VALUES[name]) + '"/>');
  }
  const updated = insertTags(input, missing);
  return { xml: updated, originalEntries, changed: updated !== input };
}
export function restoreManagedProxyEnvironment(xml, originals) {
  let updated = String(xml);
  const current = parseProxyEnvironment(updated);
  for (const name of NAMES) {
    const found = current.get(name) || [];
    if (found.length !== 1 || found[0].value !== VALUES[name]) {
      throw new Error('Current ' + name + ' is not Bridge-owned; refusing to remove it.');
    }
  }
  for (const name of NAMES) {
    const item = parseProxyEnvironment(updated).get(name)[0];
    updated = updated.replace(item.raw, '');
  }
  const restore = NAMES.map((name) => originals && originals[name])
    .filter((tag) => typeof tag === 'string' && tag.startsWith('<env '));
  updated = insertTags(updated, restore);
  const nl = updated.includes('\r\n') ? '\r\n' : '\n';
  return updated.replace(new RegExp('^[ \t]*' + nl, 'gm'), '');
}
function portIsOpen(host = '127.0.0.1', port = 40000, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
function detectWarpInstallation() {
  if (process.platform !== 'win32') return false;
  const paths = [
    'C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-svc.exe',
    'C:\\Program Files\\Cloudflare\\Cloudflare WARP\\Cloudflare WARP.exe',
  ];
  if (paths.some((path) => existsSync(path))) return true;
  const result = spawnSync('sc.exe', ['query', 'CloudflareWARP'], {
    encoding: 'utf8', windowsHide: true, timeout: 2500,
  });
  return result.status === 0 && /SERVICE_NAME:\s*CloudflareWARP/i.test(result.stdout || '');
}
function probeHttpsThroughProxy() {
  if (process.platform !== 'win32') return false;
  const result = spawnSync('curl.exe', [
    '--proxy', WARP_PROXY_URL, '--noproxy', '',
    '--silent', '--show-error', '--fail', '--output', 'NUL',
    '--write-out', '%{http_code}', '--connect-timeout', '3',
    '--max-time', '8', PROBE_URL,
  ], { encoding: 'utf8', windowsHide: true, timeout: 9500 });
  return result.status === 0 && /^2\d\d$/.test(String(result.stdout || '').trim());
}
async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + '.' + process.pid + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}
async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}
export function createProxyManager(options = {}) {
  const root = options.root || ROOT;
  const detectWarp = options.detectWarp || detectWarpInstallation;
  const checkPort = options.checkPort || portIsOpen;
  const probeHttps = options.probeHttps || probeHttpsThroughProxy;
  const serviceXml = join(root, 'service', 'OpenCodeAgent.xml');
  const stateFile = join(root, '.service', 'proxy-state.json');
  const backupDir = join(root, '.service', 'proxy-backups');

  async function status() {
    let configured = Object.fromEntries(NAMES.map((name) => [name, false]));
    try {
      const env = parseProxyEnvironment(await readFile(serviceXml, 'utf8'));
      configured = Object.fromEntries(NAMES.map((name) => {
        const found = env.get(name) || [];
        return [name, found.length === 1 && found[0].value === VALUES[name]];
      }));
    } catch {}
    const results = await Promise.all([
      Promise.resolve(Boolean(detectWarp())),
      checkPort('127.0.0.1', 40000),
    ]);
    const portOpen = Boolean(results[1]);
    return {
      warpInstalled: Boolean(results[0]),
      proxyEndpoint: WARP_PROXY_URL,
      portOpen,
      httpsVerified: portOpen ? Boolean(probeHttps()) : false,
      configured,
      managedByBridge: await fileExists(stateFile),
      enabledForOpenCode: NAMES.every((name) => configured[name]),
    };
  }

  async function enable() {
    const s = await status();
    if (!s.warpInstalled) throw new Error('Cloudflare WARP is not installed; activation refused.');
    if (!s.portOpen) throw new Error('WARP Local Proxy is not listening on 127.0.0.1:40000; activation refused.');
    if (!s.httpsVerified) throw new Error('TLS-verified HTTPS probe through WARP failed; activation refused.');

    if (await fileExists(stateFile)) {
      const env = parseProxyEnvironment(await readFile(serviceXml, 'utf8'));
      const okay = NAMES.every((name) => {
        const found = env.get(name) || [];
        return found.length === 1 && found[0].value === VALUES[name];
      });
      if (okay) return { enabled: true, alreadyEnabled: true, restartRequired: true };
      throw new Error('Bridge proxy state exists but service XML differs; refusing to overwrite.');
    }

    const originalXml = await readFile(serviceXml, 'utf8');
    const update = applyManagedProxyEnvironment(originalXml);
    if (!update.changed) throw new Error('Proxy settings already exist outside Bridge ownership; refusing to claim them.');
    await mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = 'OpenCodeAgent-' + stamp + '-' + randomUUID().slice(0, 8) + '.xml';
    await writeFile(join(backupDir, backupName), originalXml, { encoding: 'utf8', flag: 'wx' });
    await atomicWrite(stateFile, JSON.stringify({
      version: 1,
      proxy: WARP_PROXY_URL,
      backupName,
      originalEntries: update.originalEntries,
      enabledXmlSha256: createHash('sha256').update(update.xml).digest('hex'),
      createdAt: new Date().toISOString(),
    }, null, 2));
    try {
      await atomicWrite(serviceXml, update.xml);
    } catch (error) {
      await unlink(stateFile).catch(() => {});
      throw error;
    }
    return {
      enabled: true,
      restartRequired: true,
      message: 'OpenCodeAgent.xml updated; restart OpenCodeAgent explicitly before the proxy takes effect.',
    };
  }

  async function disable() {
    if (!(await fileExists(stateFile))) return { disabled: true, alreadyDisabled: true };
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (state.version !== 1 || state.proxy !== WARP_PROXY_URL) {
      throw new Error('Unrecognized Bridge proxy state; refusing to edit service XML.');
    }
    const xml = await readFile(serviceXml, 'utf8');
    const currentHash = createHash('sha256').update(xml).digest('hex');
    if (!state.enabledXmlSha256 || currentHash !== state.enabledXmlSha256) {
      throw new Error('OpenCodeAgent.xml changed after Bridge enable; refusing to overwrite external edits.');
    }
    const backupPath = join(backupDir, state.backupName);
    if (!(await fileExists(backupPath))) {
      throw new Error('Original OpenCodeAgent.xml backup is missing; refusing to edit service XML.');
    }
    const originalXml = await readFile(backupPath, 'utf8');
    await atomicWrite(serviceXml, originalXml);
    await unlink(stateFile);
    return {
      disabled: true,
      restartRequired: true,
      message: 'Bridge-managed proxy entries removed/restored; restart OpenCodeAgent explicitly.',
    };
  }

  return { status, enable, disable };
}
export const proxyManager = createProxyManager();
