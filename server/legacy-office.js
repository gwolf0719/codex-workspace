import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export const legacyOffice = {
  '.doc': { extension: '.docx', filter: 'docx:MS Word 2007 XML', label: 'Word' },
  '.xls': { extension: '.xlsx', filter: 'xlsx:Calc MS Excel 2007 XML', label: 'Excel' },
};
export const defaultOfficeBinary = '/Applications/LibreOffice.app/Contents/MacOS/soffice';
const run = promisify(execFile);
const compoundHeader = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const converted = new Map();
const pending = new Map();
const cacheLimit = 48 * 1024 * 1024;
let cacheBytes = 0;
const registry = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
  <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
    <prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>
    <prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop>
  </item>
</oor:items>`;

export function checkLegacyHeader(ext, bytes) {
  const compound = bytes.length >= 512 && bytes.subarray(0, 8).equals(compoundHeader);
  const rtf = ext === '.doc' && bytes.subarray(0, 5).toString('ascii') === '{\\rtf';
  const biff = ext === '.xls' && bytes.length >= 8 && [0x0009, 0x0209, 0x0409, 0x0809].includes(bytes.readUInt16LE(0))
    && bytes.readUInt16LE(2) > 0 && bytes.readUInt16LE(2) <= bytes.length - 4;
  if (!compound && !rtf && !biff) {
    throw new Error(`這個檔案的內容與舊版 ${legacyOffice[ext].label}（${ext}）格式不符`);
  }
}

function conversionSandbox(root, officeDirectory) {
  const ancestors = new Set(['/']);
  for (const location of [root, officeDirectory]) {
    for (let path = dirname(location); path !== '/'; path = dirname(path)) ancestors.add(path);
  }
  const filter = (kind, paths) => paths.map((path) => `(${kind} ${JSON.stringify(path)})`).join(' ');
  const allowedRead = [root, officeDirectory, '/System/Library', '/System/Cryptexes/OS',
    '/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld', '/usr/lib', '/usr/share', '/dev',
    '/Library/Fonts', '/private/var/db/dyld', '/private/var/db/timezone'];
  return [
    '(version 1)', '(allow default)', '(deny network*)', '(deny file-write*)', '(deny file-read-data)',
    `(allow file-read-data ${filter('literal', [...ancestors])} ${filter('subpath', allowedRead)})`,
    `(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))`,
    // LibreOffice requires an internal IPC socket for its own profile.
    `(allow network-bind network-inbound (local unix-socket (subpath ${JSON.stringify(root)})))`,
    `(allow network-outbound (remote unix-socket (subpath ${JSON.stringify(root)})))`,
  ].join('\n');
}

async function convert(ext, bytes, maxBytes) {
  const configured = process.env.CHAT_OFFICE_BIN || defaultOfficeBinary;
  if (process.platform !== 'darwin' || !isAbsolute(configured)) {
    throw new Error('讀取舊版 Office 檔案需要 Mac 上的 LibreOffice 執行檔');
  }
  let office;
  try {
    office = await realpath(configured);
    await access(office, 1);
  } catch {
    throw new Error('Mac 找不到 LibreOffice，請安裝 LibreOffice 或設定 CHAT_OFFICE_BIN');
  }

  // Keep the path short enough for macOS Unix domain sockets.
  const root = await mkdtemp('/private/tmp/chat-office-');
  const input = resolve(root, 'source' + ext);
  const target = legacyOffice[ext];
  const output = resolve(root, 'source' + target.extension);
  const profile = resolve(root, 'profile');
  try {
    await mkdir(resolve(profile, 'user'), { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(input, bytes, { mode: 0o600 }),
      writeFile(resolve(profile, 'user', 'registrymodifications.xcu'), registry, { mode: 0o600 }),
    ]);
    try {
      await run('/usr/bin/sandbox-exec', [
        '-p', conversionSandbox(root, dirname(dirname(office))), office,
        '-env:UserInstallation=' + pathToFileURL(profile).href, '-env:OSL_SOCKET_PATH=' + root,
        '--headless', '--nologo', '--norestore', '--nodefault', '--convert-to', target.filter, '--outdir', root, input,
      ], {
        cwd: root, timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 512 * 1024,
        env: { HOME: root, TMPDIR: root, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
      });
    } catch (error) {
      if (error.killed) throw new Error('舊版 Office 檔案讀取逾時');
      throw new Error(`無法讀取此 ${target.label} 檔案，請確認檔案完整且已解除密碼保護`);
    }
    const file = await lstat(output).catch(() => null);
    if (!file?.isFile() || !file.size) {
      throw new Error(`無法讀取此 ${target.label} 檔案，請確認檔案完整且已解除密碼保護`);
    }
    if (file.size > maxBytes) throw new Error('舊版 Office 檔案轉換後超過大小限制');
    return await readFile(output);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function convertLegacyOffice(ext, bytes, maxBytes) {
  const key = ext + '/' + createHash('sha256').update(bytes).digest('hex');
  const cached = converted.get(key);
  if (cached) {
    converted.delete(key);
    converted.set(key, cached);
    return Promise.resolve(cached);
  }
  if (pending.has(key)) return pending.get(key);
  const task = convert(ext, bytes, maxBytes).then((output) => {
    for (const [oldKey, oldBytes] of converted) {
      if (cacheBytes + output.length <= cacheLimit && converted.size < 12) break;
      cacheBytes -= oldBytes.length;
      converted.delete(oldKey);
    }
    converted.set(key, output);
    cacheBytes += output.length;
    return output;
  }).finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}
