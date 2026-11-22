import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createTwoFilesPatch } from 'diff';
import { documentLimit, isDocument, isLegacyDocument, makeDocument, readDocument } from './documents.js';

export function within(root, file) {
  const path = relative(root, file);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
}

export function canonical(path) {
  if (existsSync(path)) return realpathSync(path);
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error('檔案路徑含失效的連結');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return resolve(canonical(dirname(path)), relative(dirname(path), path));
}

const string = { type: 'string' };
const integer = { type: 'integer', minimum: 1 };
const paths = { type: 'array', items: string, maxItems: 30 };
const spec = (name, description, properties, required = Object.keys(properties)) => ({
  type: 'function', name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});

export const workspaceTools = [
  spec('workspace_read', 'Read text or extract PDF, Word (.doc/.docx) and Excel (.xls/.xlsx) contents. For documents, start and count select pages, paragraphs or rows. For Excel, sheet selects a worksheet and column selects the first column. Returns SHA-256 version. External reads require approval.', { path: string, reason: string, start: integer, count: integer, sheet: string, column: integer }, ['path', 'reason']),
  spec('workspace_write', 'Create, replace or remove a file, including PDF, DOCX and XLSX. For binary office formats provide a JSON string in contents as described in the developer instructions. Use the SHA-256 version from workspace_read or "new" for new files. Use operation "delete" to remove it.', { path: string, version: string, contents: string, reason: string, operation: { enum: ['write', 'delete'] } }, ['path', 'version', 'reason']),
  spec('workspace_patch', 'Replace one exact occurrence of text in an existing file with conflict protection. Use the version returned by workspace_read.', { path: string, version: string, find: string, replacement: string, reason: string }),
  spec('workspace_command', 'Run a local shell command in the project. List every intended file write explicitly, including new files. List external reads explicitly. An empty writes array runs a read-only command. Network is disabled.', { command: string, writes: paths, externalReads: paths, reason: string }),
];

function fileState(path, limit = 512 * 1024, includeBytes = false) {
  if (!existsSync(path)) return { version: 'new', text: '' };
  const file = statSync(path);
  if (!file.isFile()) throw new Error('請提供一般檔案的路徑');
  if (file.nlink > 1) throw new Error('此操作需要一般檔案，請先移除額外的硬連結');
  if (file.size > limit) throw new Error('此操作的檔案大小超過限制');
  const buffer = readFileSync(path);
  return {
    version: createHash('sha256').update(buffer).digest('hex'),
    text: isDocument(path) || buffer.includes(0) ? null : buffer.toString('utf8'),
    mode: file.mode & 0o777,
    ...(includeBytes ? { bytes: buffer } : {}),
  };
}

const inputText = (value, label, max = 512 * 1024) => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max) throw new Error(`${label}格式或長度不符`);
  return value;
};

function runCommand({ command, cwd, writes, reads, signal }) {
  if (process.platform !== 'darwin') throw new Error('本版的指令沙箱需要 macOS');
  const filters = (mode, targets) => targets.map((target) => `(${mode} ${JSON.stringify(target)})`).join(' ');
  const ancestors = new Set(['/']);
  for (const path of [cwd, ...reads, ...writes]) {
    for (let parent = dirname(path); parent !== '/'; parent = dirname(parent)) ancestors.add(parent);
  }
  const rules = [
    '(version 1)', '(allow default)', '(deny network*)', '(deny file-write*)',
    '(deny file-read-data)',
    `(allow file-read-data ${filters('literal', [...ancestors])} ${filters('subpath', [cwd, '/System/Library', '/usr/bin', '/usr/lib', '/usr/share', '/bin', '/sbin', '/Library/Apple', '/opt/homebrew', '/dev', '/private/var/db/dyld'])})`,
    reads.length ? `(allow file-read-data ${filters('literal', reads)})` : '',
    '(allow file-write* (literal "/dev/null"))',
    writes.length ? `(allow file-read-data file-write* ${filters('literal', writes)})` : '',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', rules, '/bin/zsh', '-f', '-c', command], {
      cwd, env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    let output = '';
    const capture = (chunk) => { output = (output + chunk.toString()).slice(-24000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(killGroup, 90000);
    signal?.addEventListener('abort', killGroup, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', killGroup);
    };
    child.on('error', (error) => { cleanup(); reject(error); });
    child.on('exit', killGroup);
    child.on('close', (code, signal) => {
      cleanup();
      resolve({ output, code, signal });
    });
  });
}

export class Workspace {
  #locks = new Map();
  #running = new Map();

  constructor({ decide, addFile, log, active, sensitive }) {
    Object.assign(this, { decide, addFile, log, active, sensitive });
  }

  release(sessionId, turnId) {
    const running = this.#running.get(sessionId + '/' + turnId);
    if (running?.size) {
      for (const controller of running) controller.abort();
      return;
    }
    for (const [path, owner] of this.#locks) {
      if (owner.sessionId === sessionId && owner.turnId === turnId) {
        this.#locks.delete(path);
        owner.release();
      }
    }
  }

  async lock(paths, sessionId, turnId) {
    // Claim the set atomically. Waiting while already holding a different path
    // can create a cycle between two turns, so detect that cycle explicitly.
    const identity = { sessionId, turnId };
    while (this.active(sessionId, turnId)) {
      const conflict = paths.map((path) => [path, this.#locks.get(path)])
        .find(([, owner]) => owner && (owner.sessionId !== sessionId || owner.turnId !== turnId));
      if (!conflict) {
        for (const path of paths) {
          if (!this.#locks.has(path)) {
            const { promise, resolve: release } = Promise.withResolvers();
            this.#locks.set(path, { ...identity, promise, release });
          }
        }
        return false;
      }
      const [path, owner] = conflict;
      const answer = await this.decide(sessionId, turnId, { kind: 'conflict', path, owner: owner.sessionId });
      if (answer.decision !== 'wait') throw new Error(`使用者要求調整做法：${answer.instruction || '請改用其他檔案或做法。'}`);
      const own = [...this.#locks.values()].filter((item) => item.sessionId === sessionId && item.turnId === turnId);
      for (let next = owner; next; next = next.waitingFor) {
        if (next.sessionId === sessionId && next.turnId === turnId) {
          throw new Error('兩個對話正在互等檔案。請結束本輪，讓另一個對話完成後，再重新讀取最新版。');
        }
      }
      for (const item of own) item.waitingFor = owner;
      try { await owner.promise; } finally { for (const item of own) delete item.waitingFor; }
      // Return control to Codex so it must read the latest version before retrying.
      throw new Error(`前一個對話已釋放 ${path}。請重新讀取檔案與版本，再依最新版調整並重試。`);
    }
    throw new Error('對話已停止');
  }

  async execute({ sessionId, turnId, root, tool, args, itemId }) {
    const ensureActive = () => {
      if (!this.active(sessionId, turnId)) throw new Error('對話已停止');
    };
    if (!existsSync(root) || canonical(root) !== root) throw new Error('工作資料夾路徑已變更');
    const pathFor = (value, write = false) => {
      const requested = resolve(root, inputText(value, '檔案路徑', 4096));
      const path = canonical(requested);
      if (this.sensitive(path) || (write && within(path, root))) throw new Error('該路徑受保護');
      if (write && path !== requested) throw new Error('請直接使用實際的檔案路徑寫入');
      return path;
    };
    const reason = inputText(args.reason, '操作原因', 4000).trim();
    const authorize = async (entries, command) => {
      if (!entries.length) return;
      if (!reason) throw new Error('請提供存取工作資料夾外檔案的原因');
      const answer = await this.decide(sessionId, turnId, { kind: 'access', entries, reason, command });
      if (answer.decision !== 'accept') throw new Error('使用者拒絕這次檔案存取');
      ensureActive();
    };
    const record = (path, before, after) => {
      if (before.version === after.version) return null;
      const diff = before.text === null || after.text === null ? '二進位檔案' :
        createTwoFilesPatch(path, path, before.text, after.text).slice(0, 90000);
      const removed = after.version === 'new';
      const id = this.addFile(sessionId, path, removed);
      return { path, diff, asset: removed ? null : { id, name: relative(dirname(path), path), type: 'file', image: /\.(png|jpe?g|webp|gif)$/i.test(path) } };
    };

    ensureActive();
    if (tool === 'workspace_read') {
      const path = pathFor(args.path);
      if (!within(root, path)) await authorize([{ path, access: 'read' }]);
      if (pathFor(args.path) !== path) throw new Error('檔案路徑已變更');
      if (isDocument(path)) {
        const { bytes, version } = fileState(path, documentLimit, true);
        if (!bytes) throw new Error('找不到指定的文件');
        const extracted = await readDocument(path, bytes, args);
        return JSON.stringify({ path, version, ...extracted });
      }
      return JSON.stringify({ path, ...fileState(path) });
    }
    if (tool === 'workspace_write' || tool === 'workspace_patch') {
      const path = pathFor(args.path, true);
      if (isLegacyDocument(path) && args.operation !== 'delete') {
        throw new Error('請使用 .docx 或 .xlsx 輸出文件');
      }
      await this.lock([path], sessionId, turnId);
      ensureActive();
      const expected = inputText(args.version, '版本', 64);
      const document = isDocument(path);
      const limit = document ? documentLimit : undefined;
      if (tool === 'workspace_patch' && document) throw new Error('請用 workspace_write 輸出文件格式');
      if (fileState(path, limit).version !== expected) throw new Error('檔案已更新，請重新讀取最新版再重試');
      if (!within(root, path)) await authorize([{ path, access: 'write' }]);
      const before = fileState(path, limit);
      if (before.version !== expected || pathFor(args.path, true) !== path) throw new Error('檔案已更新，請重新讀取再重試');
      if (args.operation === 'delete') {
        if (before.version !== 'new') unlinkSync(path);
      } else {
        let contents = args.contents;
        if (tool === 'workspace_patch') {
          const find = inputText(args.find, '比對文字');
          if (!find || !before.text?.includes(find) || before.text.indexOf(find) !== before.text.lastIndexOf(find)) {
            throw new Error('指定文字須在最新版本中剛好出現一次');
          }
          contents = before.text.replace(find, () => inputText(args.replacement, '替換文字'));
        }
        inputText(contents, '檔案內容');
        if (document) {
          contents = await makeDocument(path, contents);
          if (contents.length > documentLimit) throw new Error('文件輸出超過 25 MB');
          ensureActive();
          if (pathFor(args.path, true) !== path || fileState(path, limit).version !== expected) {
            throw new Error('檔案已更新，請重新讀取再重試');
          }
        }
        if (within(root, path)) mkdirSync(dirname(path), { recursive: true });
        const temporary = resolve(dirname(path), `.chat-ai-${randomUUID()}`);
        try {
          if (within(root, path)) {
            writeFileSync(temporary, contents, { flag: 'wx', mode: before.mode ?? 0o644 });
            renameSync(temporary, path);
          } else {
            writeFileSync(path, contents, { flag: before.version === 'new' ? 'wx' : 'w', mode: before.mode ?? 0o644 });
          }
        } finally {
          if (existsSync(temporary)) unlinkSync(temporary);
        }
      }
      const after = fileState(path, limit);
      const change = record(path, before, after);
      if (change) this.log(sessionId, { id: itemId, type: 'file', title: document && change.asset ? '文件已產生' : '已變更檔案', detail: document ? path : change.diff, assets: change.asset ? [change.asset] : [] });
      return JSON.stringify({ path, version: after.version });
    }
    if (tool !== 'workspace_command') throw new Error('這項工具未啟用');
    if (!Array.isArray(args.writes) || !Array.isArray(args.externalReads) ||
      args.writes.length > 30 || args.externalReads.length > 30) throw new Error('請列出命令涉及的檔案');
    const command = inputText(args.command, '指令', 24000);
    const writes = [...new Set(args.writes.map((path) => pathFor(path, true)))];
    const reads = [...new Set(args.externalReads.map((path) => pathFor(path)))];
    await this.lock(writes, sessionId, turnId);
    ensureActive();
    const external = [...writes.filter((path) => !within(root, path)).map((path) => ({ path, access: 'write' })),
      ...reads.filter((path) => !within(root, path) && !writes.includes(path)).map((path) => ({ path, access: 'read' }))];
    await authorize(external, command);
    if (args.writes.some((path) => !writes.includes(pathFor(path, true))) ||
      args.externalReads.some((path) => !reads.includes(pathFor(path)))) throw new Error('檔案路徑已變更');
    const before = new Map(writes.map((path) => [path, fileState(path, 32 * 1024 * 1024)]));
    this.log(sessionId, { id: itemId, type: 'command', title: '執行指令中', detail: command });
    const key = sessionId + '/' + turnId;
    const controller = new AbortController();
    const running = this.#running.get(key) || new Set();
    this.#running.set(key, running);
    running.add(controller);
    try {
      const result = await runCommand({ command, cwd: root, writes, reads, signal: controller.signal });
      const changes = [];
      for (const path of writes) {
        // A command may remove the original or create a binary output.
        const after = fileState(path, 32 * 1024 * 1024);
        const change = record(path, before.get(path), after);
        if (change) changes.push(change);
      }
      this.log(sessionId, { id: itemId, type: 'command', title: result.code === 0 ? '指令已完成' : '指令執行失敗',
        detail: [command, result.output, ...changes.map(({ diff }) => diff)].join('\n\n'), assets: changes.flatMap(({ asset }) => asset ? [asset] : []) });
      return JSON.stringify(result);
    } finally {
      running.delete(controller);
      if (!running.size) this.#running.delete(key);
      if (!this.active(sessionId, turnId) && !running.size) this.release(sessionId, turnId);
    }
  }
}
