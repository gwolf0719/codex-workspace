import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { WebSocket } from 'ws';
import { Workspace } from '../server/workspace.js';

async function until(get, match) {
  const end = Date.now() + 7000;
  let value;
  while (Date.now() < end) {
    value = await get();
    if (match(value)) return value;
    await delay(30);
  }
  throw Error('Timed out: ' + JSON.stringify(value));
}

test('password, WebSocket reconnect, concurrent sessions, steering, file approvals, conflict resolution and downloads', async (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), 'chat-server-test-'));
  const password = '4058';
  const server = spawn(process.execPath, ['server/index.js'], { env: {
    ...process.env, CHAT_PORT: '0', CHAT_HOST: '127.0.0.1', CHAT_COOKIE_SECURE: '0',
    CHAT_DATA_DIR: folder, CHAT_PASSWORD: password, CHAT_CODEX_BIN: resolve('test/fake-codex.mjs'),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  const clients = [];
  t.after(async () => {
    for (const ws of clients) ws.terminate();
    if (server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, 'exit');
      server.kill();
      await stopped;
    }
    rmSync(folder, { force: true, recursive: true });
  });
  let startup = '';
  server.stdout.on('data', (data) => { startup += data; });
  const base = await until(() => startup.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0], Boolean);
  const headers = { Origin: base, 'X-Chat-Client': 'web', 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await fetch(base + '/api/login', { method:'POST', headers, body: '{"password":"wrong"}' })).status, 401);
  async function login(entered = password) {
    const result = await fetch(base + '/api/login', { method: 'POST', headers, body: JSON.stringify({ password: entered }) });
    assert.equal(result.status, 200);
    const cookies = { ...headers, Cookie: result.headers.get('set-cookie').split(';')[0] };
    return {
      api: async (path, data, body) => {
        const options = { headers: cookies, method: data || body ? 'POST' : 'GET', body: body || (data ? JSON.stringify(data) : undefined) };
        const response = await fetch(base + '/api/' + path, options);
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
      },
      open: async () => {
        const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: cookies });
        clients.push(ws);
        await once(ws, 'open');
        return ws;
      },
      cookies,
    };
  }
  const first = await login();
  const second = await login(' ４０５８ ');
  assert.equal((await fetch(base + '/api/scenarios', {
    method:'POST', headers:{ ...first.cookies, Origin: 'http://example.invalid' }, body: '{}',
  })).status, 403);
  const project = await first.api('scenarios', { name:'測試', prompt: 'v1', icon:'code' });
  assert.equal((await first.api('state')).scenarios[0].id, 'chat');
  const ws = await first.open();
  const received = [];
  ws.on('message', (message) => received.push(JSON.parse(message)));
  const send = (api, text, settings = {}) => api('messages', { scenarioId: project.id, text, ...settings });
  const holder = await send(first.api, 'hold');
  const hold = await until(() => first.api('state'), (state) => state.pending.some(({ kind }) => kind === 'access'));
  assert.equal(hold.pending[0].entries[0].access, 'read');
  assert.equal(hold.pending[0].entries[0].path, '/private/tmp/test-single-access.txt');
  await until(() => received.some(({ type }) => type === 'update'), Boolean);
  const closed = once(ws, 'close');
  ws.close();
  await closed;
  const conflict = await send(second.api, 'conflict');
  const waiting = await until(() => second.api('state'), (state) => state.pending.some(({ kind }) => kind === 'conflict'));
  const request = waiting.pending.find(({ kind }) => kind === 'conflict');
  assert.equal(request.owner, holder.id);
  const other = await send(second.api, 'parallel', { messageId:'unique' });
  assert.equal((await send(second.api, 'parallel', { messageId:'unique' })).id, other.id);
  assert.equal((await second.api('sessions/' + other.id)).session.status, 'completed');
  const reconnection = await first.open();
  assert.equal((await first.api('state')).pending.length, 2);
  await send(first.api, 'change direction', { sessionId: holder.id });
  await until(() => first.api('sessions/' + holder.id), (data) => data.items.some(({ text }) => text?.includes('Steered:')));
  await second.api('pending/' + request.id, { decision: 'redirect', instruction: '改用別的路徑' });
  const redirected = await until(() => first.api('sessions/' + conflict.id), (data) => data.session.status === 'completed');
  assert.ok(redirected.items.at(-1).text.includes('改用別的路徑'));
  await second.api('pending/' + hold.pending[0].id, { decision: 'decline' });
  await until(() => first.api('sessions/' + holder.id), (data) => data.session.status === 'completed');
  await first.api('scenarios/' + project.id, { name:'測試', prompt: 'v2', icon:'code' });
  const asset = await first.api('upload?name=note.txt&scenario=' + project.id, undefined, Buffer.from('attachment'));
  await send(first.api, 'updated', { sessionId: other.id, attachments:[asset.id] });
  const next = await until(() => first.api('sessions/' + other.id), (data) => data.session.status === 'completed');
  assert.match(next.items.at(-1).text, /v2/);
  assert.equal(next.items.find(({ assets }) => assets?.length).assets[0].id, asset.id);
  const files = await first.api('files/' + project.id);
  assert.equal(files.length, 1);
  const path = 'file/' + encodeURIComponent(files[0].id);
  assert.deepEqual(await first.api(path + '?preview=1'), { text: 'hello' });
  const download = await fetch(base + '/api/' + path + '?download=1', { headers: second.cookies });
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  assert.equal(await download.text(), 'hello');
  reconnection.close();
});

test('conflict wait requires a fresh version and shell writes only declared files', async (t) => {
  const folder = realpathSync(mkdtempSync(resolve(tmpdir(), 'chat-workspace-test-')));
  t.after(() => rmSync(folder, { force: true, recursive: true }));
  let decided;
  const prompts = [];
  const workspace = new Workspace({
    decide: (...args) => { prompts.push(args); return new Promise((resolve) => { decided = resolve; }); },
    active: () => true, sensitive: () => false, addFile: () => 'test-file', log: () => {},
  });
  const call = (sessionId, tool, args) => workspace.execute({ root: folder, turnId: sessionId, sessionId, tool, args: { reason: 'test', ...args } });
  await call('A', 'workspace_write', { path: 'shared.txt', version: 'new', contents: 'version A' });
  const blocked = call('B', 'workspace_write', { path: 'shared.txt', version: 'new', contents: 'version B' });
  const rejection = assert.rejects(blocked, /重新讀取/);
  await until(() => prompts.length, Boolean);
  decided({ decision: 'wait' });
  workspace.release('A', 'A');
  await rejection;
  await assert.rejects(call('B', 'workspace_write', { path: 'shared.txt', version: 'new', contents: 'version B' }), /檔案已更新/);
  const { version } = JSON.parse(await call('B', 'workspace_read', { path: 'shared.txt' }));
  await call('B', 'workspace_write', { path: 'shared.txt', version, contents: 'version B' });
  workspace.release('B', 'B');
  if (process.platform === 'darwin') {
    const run = (command, writes) => call('C', 'workspace_command', { command, writes, externalReads: [] }).then(JSON.parse);
    const result = await run('cat shared.txt; printf allowed > declared.txt', ['declared.txt']);
    assert.equal(result.code, 0);
    assert.equal(result.output, 'version B');
    assert.notEqual((await run('printf forbidden > undeclared.txt', [])).code, 0);
    assert.notEqual((await run('cat /private/etc/hosts', [])).code, 0);
  }
});
