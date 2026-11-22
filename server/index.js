import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createStore } from './store.js';
import { documentLimit, documentTypes, isDocument, readDocument, validateDocument } from './documents.js';
import { Sessions, ensureScenarioRoot } from './sessions.js';
import { canonical, within } from './workspace.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dataFolder = resolve(process.env.CHAT_DATA_DIR || resolve(homedir(), 'Library/Application Support/Codex Workspace'));
const host = process.env.CHAT_HOST || '127.0.0.1';
const port = Number(process.env.CHAT_PORT || 4317);
mkdirSync(dataFolder, { recursive: true, mode: 0o700 });
const data = canonical(dataFolder);
mkdirSync(resolve(data, 'assets'), { recursive: true, mode: 0o700 });
const passwordFile = resolve(data, 'login-password');
if (!process.env.CHAT_PASSWORD && !existsSync(passwordFile)) {
  writeFileSync(passwordFile, randomBytes(18).toString('base64url') + '\n', { flag: 'wx', mode: 0o600 });
}
const password = process.env.CHAT_PASSWORD || readFileSync(passwordFile, 'utf8').trim();
if (password.length < 4) throw new Error('試用密碼至少需要 4 個字元');
const digest = (value) => createHash('sha256').update(value).digest();
const passwordHash = digest(password);
const store = createStore(resolve(data, 'state.sqlite'));
const ws = new WebSocketServer({ noServer: true, maxPayload: 4096 });
const logins = new Map();
const attempts = new Map();
const maxAge = 7 * 24 * 3600;
const builtins = new Set(['chat', 'folder', 'code', 'pen', 'image', 'flask', 'book', 'terminal', 'layers']);
const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const publicFiles = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/vendor/marked.js': ['node_modules/marked/lib/marked.esm.js', 'text/javascript; charset=utf-8'],
  '/vendor/purify.js': ['node_modules/dompurify/dist/purify.es.mjs', 'text/javascript; charset=utf-8'],
  '/vendor/lucide.js': ['node_modules/lucide/dist/umd/lucide.min.js', 'text/javascript; charset=utf-8'],
};
const imageRoots = [resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'), 'generated_images'),
  resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'), 'artifacts')];

const tokenFor = (req) => /(?:^|;\s*)chat_auth=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
function authenticated(req) {
  const token = tokenFor(req);
  const expires = logins.get(token);
  if (expires > Date.now()) return true;
  if (expires) logins.delete(token);
  return false;
}
function sameOrigin(req) {
  if (!req.headers.origin || !req.headers.host) return false;
  try {
    const origin = new URL(req.headers.origin);
    const scheme = req.socket.encrypted || process.env.CHAT_COOKIE_SECURE === '1' ? 'https:' : 'http:';
    return origin.host.toLowerCase() === req.headers.host.toLowerCase() && origin.protocol === scheme;
  } catch { return false; }
}

let notifications = new Set();
let flush;
function notify(sessionId) {
  if (sessionId) notifications.add(sessionId);
  flush ||= setTimeout(() => {
    const update = JSON.stringify({ type: 'update', sessions: [...notifications] });
    notifications = new Set();
    flush = null;
    for (const client of ws.clients) {
      if ((logins.get(client.token) || 0) <= Date.now()) client.close(1008);
      else if (client.readyState === 1 && client.bufferedAmount < 65536) client.send(update);
    }
  }, 70);
}

const sessions = new Sessions({ store, data, notify, imageRoots });
sessions.connect();
if (!store.get('scenarios', 'chat')) {
  store.put('scenarios', { id: 'chat', name: '純聊天', prompt: '', icon: 'chat', iconAsset: null,
    root: ensureScenarioRoot(data, 'chat'), project: false });
}
const iconScenario = { id: 'icon-generator', name: '情境圖示生成', prompt: '', root: ensureScenarioRoot(data, 'icon-generator') };
store.put('scenarios', iconScenario);

function httpError(status, message) { return Object.assign(new Error(message), { status }); }
function lookup(collection, id) {
  const item = store.get(collection, id);
  if (!item) throw httpError(404, '找不到指定的項目');
  return item;
}
function text(value, max, label) {
  if (typeof value !== 'string' || value.length > max) throw httpError(400, label + '格式或長度不符');
  return value.trim();
}
function newSession(scenarioId, title, hidden = false) {
  return store.put('sessions', { id: randomUUID(), scenarioId, title, hidden, status: 'ready', updatedAt: Date.now(),
    settings: { model: '', effort: '' }, threadId: null });
}
async function body(req, max = 256 * 1024) {
  let length = 0;
  const chunks = [];
  if (Number(req.headers['content-length']) > max) throw httpError(413, '資料大小超過限制');
  for await (const chunk of req) {
    length += chunk.length;
    if (length > max) throw httpError(413, '資料大小超過限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function json(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw httpError(415, '需要 JSON 格式');
  try {
    const value = JSON.parse((await body(req)).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) { throw error.status ? error : httpError(400, 'JSON 格式錯誤'); }
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function login(req, res, data) {
  const now = Date.now();
  for (const [key, attempt] of attempts) if (now - attempt.since >= 600_000) attempts.delete(key);
  for (const [key, expires] of logins) if (expires <= now) logins.delete(key);
  const key = req.socket.remoteAddress;
  const attempt = attempts.get(key) || { count: 0, since: now };
  if (attempt.count >= 10) throw httpError(429, '登入嘗試過多，請稍後再試');
  attempt.count += 1;
  attempts.set(key, attempt);
  let entered = data.password;
  if (typeof entered !== 'string') throw httpError(401, '密碼不正確');
  if (/^[0-9]{4}$/.test(password) && /^[0-9０-９]{4}$/.test(entered.trim())) {
    entered = entered.trim().normalize('NFKC');
  }
  if (!timingSafeEqual(digest(entered), passwordHash)) throw httpError(401, '密碼不正確');
  attempts.delete(key);
  logins.delete(tokenFor(req));
  const token = randomBytes(32).toString('base64url');
  logins.set(token, now + maxAge * 1000);
  res.setHeader('Set-Cookie', `chat_auth=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${process.env.CHAT_COOKIE_SECURE === '1' ? '; Secure' : ''}`);
  return { ok: true };
}

function scenarioView(scenario) {
  const { id, name, icon, iconAsset, root, project, prompt } = scenario;
  return { id, name, icon, iconAsset, root, project, prompt };
}
function sessionView({ threadId, ...rest }) { return rest; }

function updateScenario(id, input) {
  const name = text(input.name, 60, '情境名稱');
  if (!name) throw httpError(400, '請輸入情境名稱');
  const existing = id && lookup('scenarios', id);
  if (id === 'chat' || id === iconScenario.id) throw httpError(400, '這個情境由系統管理');
  const scenarioId = id || randomUUID();
  const requested = text(input.root || '', 4096, '資料夾');
  if (existing && requested !== (existing.project ? existing.root : '')) {
    throw httpError(400, '要使用另一個專案資料夾，請建立新情境。');
  }
  const root = existing?.root || ensureScenarioRoot(data, scenarioId, requested);
  const icon = builtins.has(input.icon) ? input.icon : 'folder';
  const iconAsset = input.iconAsset ? lookup('assets', input.iconAsset) : null;
  if (iconAsset && !['icon', 'output'].includes(iconAsset.kind)) throw httpError(400, '請選擇有效的圖示圖片');
  const prompt = text(input.prompt || '', 24000, '共用提示詞');
  const record = store.put('scenarios', { id: scenarioId, name, icon, iconAsset: iconAsset?.id || null, root,
    project: existing?.project ?? Boolean(requested), prompt, createdAt: existing?.createdAt || Date.now() });
  notify();
  return scenarioView(record);
}

async function previewText(file, name, query) {
  if (isDocument(name)) {
    if (statSync(file).size > documentLimit) throw httpError(415, '此檔案超過預覽大小限制');
    const result = await readDocument(name, readFileSync(file), { sheet: query.get('sheet') || undefined, grid: true });
    return { ...result, text: result.text || result.note || '這個檔案沒有可預覽的文字。' };
  }
  if (statSync(file).size > 300 * 1024) throw httpError(415, '此檔案需要下載查看');
  const contents = readFileSync(file);
  if (contents.includes(0)) throw httpError(415, '此檔案需要下載查看');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(contents);
  return { text };
}

function serveFile(res, file, name, download) {
  const size = statSync(file).size;
  const extension = extname(name).toLowerCase();
  const media = imageTypes[extension];
  const type = media || documentTypes[extension];
  const inline = !download && (media || extension === '.pdf');
  res.writeHead(200, {
    'Content-Type': type || 'application/octet-stream', 'Content-Length': size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Content-Security-Policy': 'sandbox',
  });
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

async function upload(req, url) {
  const kind = url.searchParams.get('kind') === 'icon' ? 'icon' : 'attachment';
  const scenarioId = url.searchParams.get('scenario');
  const scenario = kind === 'attachment' ? lookup('scenarios', scenarioId) : null;
  const name = basename(text(url.searchParams.get('name') || '', 180, '檔名'));
  if (!name || name === '..' || name === '.' || /[\x00-\x1f]/.test(name)) throw httpError(400, '請提供有效檔名');
  const extension = extname(name).toLowerCase();
  const bytes = await body(req, kind === 'icon' ? 8 * 1024 * 1024 : documentLimit);
  const image = Boolean(imageTypes[extension]);
  if (kind === 'attachment' && isDocument(name)) await validateDocument(name, bytes);
  const validImage = extension === '.png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
    ['.jpg', '.jpeg'].includes(extension) ? bytes.subarray(0, 3).equals(Buffer.from([255,216,255])) :
    extension === '.webp' ? bytes.toString('ascii', 8, 12) === 'WEBP' : bytes.toString('ascii', 0, 3) === 'GIF';
  if (kind === 'icon' && !image || image && !validImage) throw httpError(400, '請使用有效的 PNG、JPG、WebP 或 GIF 圖片');
  const id = randomUUID();
  const path = resolve(data, 'assets', id);
  let localPath;
  if (scenario) {
    const uploadRoot = resolve(scenario.root, '.chat-ai-attachments');
    if (canonical(uploadRoot) !== uploadRoot) throw httpError(400, '附件資料夾路徑已變更');
    mkdirSync(resolve(uploadRoot, id), { recursive: true, mode: 0o700 });
    localPath = resolve(uploadRoot, id, name);
    writeFileSync(localPath, bytes, { flag: 'wx', mode: 0o600 });
  }
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  store.put('assets', { id, path, name, kind, image, scenarioId, localPath });
  return { id, name, image };
}

async function api(req, res, url, parts) {
  const [resource, id, action] = parts;
  if (req.method !== 'GET' && (!sameOrigin(req) || req.headers['x-chat-client'] !== 'web')) {
    throw httpError(403, '請從聊天頁操作');
  }
  if (req.method === 'POST' && resource === 'login') return login(req, res, await json(req));
  if (!authenticated(req)) throw httpError(401, '請先登入');
  if (req.method === 'GET') {
    switch (resource) {
      case 'state':
        return {
          scenarios: store.list('scenarios').filter((item) => item.id !== iconScenario.id)
            .sort((a, b) => Number(b.id === 'chat') - Number(a.id === 'chat') || (a.createdAt || 0) - (b.createdAt || 0)).map(scenarioView),
          sessions: store.list('sessions').filter((item) => !item.hidden).map(sessionView).sort((a, b) => b.updatedAt - a.updatedAt),
          pending: sessions.listPending().filter((item) => !store.get('sessions', item.sessionId)?.hidden),
        };
      case 'models': return sessions.models();
      case 'jobs': return lookup('jobs', id);
      case 'sessions': return {
        session: sessionView(lookup('sessions', id)),
        items: store.list('timeline').filter((item) => item.sessionId === id).sort((a, b) => a.at - b.at),
      };
      case 'files': {
        lookup('scenarios', id);
        const files = store.list('files').filter((item) => item.scenarioId === id).map((item) => ({ ...item, available: existsSync(item.path) }));
        const images = store.list('assets').filter((item) => item.kind === 'output' && item.scenarioId === id).map((item) => ({
          id: item.id, name: item.name, asset: true, available: true, sessionId: item.sessionId,
          at: store.get('sessions', item.sessionId)?.updatedAt,
        }));
        return [...files, ...images].sort((a, b) => b.at - a.at);
      }
      case 'asset': {
        const item = lookup('assets', id);
        if (url.searchParams.has('preview')) return previewText(item.path, item.name, url.searchParams);
        serveFile(res, item.path, item.name, url.searchParams.has('download'));
        return;
      }
      case 'file': {
        const item = lookup('files', id);
        if (!existsSync(item.path) || canonical(item.path) !== item.path || !statSync(item.path).isFile() || statSync(item.path).nlink > 1) {
          throw httpError(404, '檔案已移除或變更');
        }
        if (url.searchParams.has('preview')) return previewText(item.path, item.name, url.searchParams);
        serveFile(res, item.path, item.name, url.searchParams.has('download'));
        return;
      }
    }
  }
  if (req.method === 'POST') {
    if (resource === 'upload') return upload(req, url);
    const input = await json(req);
    if (resource === 'logout') {
      const token = tokenFor(req);
      logins.delete(token);
      for (const client of ws.clients) if (client.token === token) client.close(1008);
      res.setHeader('Set-Cookie', 'chat_auth=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      return { ok: true };
    }
    if (resource === 'scenarios') return updateScenario(id, input);
    if (resource === 'pending') {
      sessions.answer(id, input);
      return { ok: true };
    }
    if (resource === 'sessions' && action === 'interrupt') {
      await sessions.interrupt(id);
      return { ok: true };
    }
    if (resource === 'messages') {
      const scenario = lookup('scenarios', text(input.scenarioId, 100, '情境'));
      if (scenario.id === iconScenario.id) throw httpError(400, '請使用圖示生成功能');
      const message = text(input.text || '', 60000, '訊息');
      const attachments = (Array.isArray(input.attachments) ? input.attachments.slice(0, 12) : []).map((id) => {
        const asset = lookup('assets', text(id, 100, '附件'));
        if (asset.kind !== 'attachment' || asset.scenarioId !== scenario.id) throw httpError(400, '附件不屬於這個情境');
        return asset;
      });
      if (!message && !attachments.length) throw httpError(400, '請輸入訊息或加入附件');
      const messageId = text(input.messageId || randomUUID(), 100, '訊息識別碼');
      const settings = { model: text(input.model || '', 100, '模型'), effort: text(input.effort || '', 20, '思考強度') };
      const previouslyStarted = store.get('messageSessions', scenario.id + '/' + messageId);
      const session = input.sessionId ? lookup('sessions', text(input.sessionId, 100, '對話')) :
        previouslyStarted ? lookup('sessions', previouslyStarted.sessionId) : newSession(scenario.id, (message || attachments[0].name).slice(0, 52));
      if (!input.sessionId && !previouslyStarted) store.put('messageSessions', { id: scenario.id + '/' + messageId, sessionId: session.id });
      if (session.scenarioId !== scenario.id) throw httpError(400, '對話不屬於這個情境');
      return sessionView(await sessions.message({ scenario, session, text: message, attachments, settings, messageId }));
    }
    if (resource === 'jobs' && action === undefined) {
      const prompt = text(input.prompt || '', 2500, '圖示描述');
      if (!prompt) throw httpError(400, '請描述想要的圖示');
      const session = newSession(iconScenario.id, '生成圖示', true);
      const job = store.put('jobs', { id: session.id, status: 'running' });
      sessions.message({ scenario: iconScenario, session, messageId: randomUUID(), settings: session.settings,
        text: '請使用內建 image_gen 繪製一張灰階的方形情境圖示。保留清楚的輪廓，不放文字。請直接生成圖片。使用者描述：' + prompt })
        .catch((error) => { store.put('jobs', { ...job, status: 'failed', error: error.message }); notify(); });
      return job;
    }
  }
  throw httpError(404, '找不到這個頁面');
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const file = publicFiles[url.pathname];
    if (req.method === 'GET' && Array.isArray(file)) {
      res.writeHead(200, { 'Content-Type': file[1], 'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; style-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'" });
      return res.end(readFileSync(resolve(repo, file[0])));
    }
    if (url.pathname.startsWith('/api/')) {
      const parts = url.pathname.slice(5).split('/').map(decodeURIComponent);
      const result = await api(req, res, url, parts);
      if (!res.headersSent) send(res, 200, result);
      return;
    }
    throw httpError(404, '找不到這個頁面');
  } catch (error) {
    if (!res.headersSent) send(res, error.status || 400, { error: error.message });
    else res.destroy();
  }
});
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || !sameOrigin(req) || !authenticated(req)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  ws.handleUpgrade(req, socket, head, (client) => {
    client.token = tokenFor(req);
    client.send(JSON.stringify({ type: 'connected' }));
  });
});
server.listen(port, host, () => {
  console.log(`Codex 工作室 http://${host}:${server.address().port}`);
  if (!process.env.CHAT_PASSWORD) console.log(`登入密碼檔案 ${passwordFile}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    sessions.codex?.process.kill();
    for (const client of ws.clients) client.terminate();
    server.close(() => { store.close(); process.exit(0); });
  });
}
