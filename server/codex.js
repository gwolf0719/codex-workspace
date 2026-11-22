import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export class Codex extends EventEmitter {
  #nextId = 0;
  #pending = new Map();

  constructor({ cwd, executable = process.env.CHAT_CODEX_BIN || 'codex' }) {
    super();
    const profile = 'permissions.chat_workspace.filesystem={":minimal"="read",":workspace_roots"={"."="read"}}';
    this.process = spawn(executable, [
      'app-server', '--listen', 'stdio://', '-c', profile,
      '-c', 'permissions.chat_workspace.network.enabled=false',
      '-c', 'default_permissions="chat_workspace"',
      '-c', 'mcp_servers={}',
      '--disable', 'request_permissions_tool',
      '--disable', 'shell_tool', '--disable', 'unified_exec',
      '--disable', 'hooks', '--disable', 'plugins',
    ], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stderr.on('data', (data) => process.stderr.write(data));
    this.process.stdin.on('error', () => this.close());
    this.process.on('error', (error) => this.close(error));
    this.process.on('exit', (code) => this.close(new Error(`Codex 已結束（${code}）`)));
    createInterface({ input: this.process.stdout }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method) {
        this.emit('event', message);
      } else if (this.#pending.has(message.id)) {
        const { resolve, reject, timer } = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    });
    this.ready = this.call('initialize', {
      clientInfo: { name: 'chat_ai', title: 'Codex 工作室', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false, requiredHumanApproval: true },
    }).then(() => this.send({ method: 'initialized' }));
    this.ready.catch(() => {});
  }

  close(error = new Error('Codex 連線中斷')) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
    this.emit('closed', error);
  }

  send(message) {
    if (this.closed || !this.process.stdin.writable) throw new Error('Codex 連線中斷');
    this.process.stdin.write(JSON.stringify(message) + '\n');
  }

  call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.#nextId;
      this.send({ id, method, params });
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex 回應逾時（${method}）`));
      }, 30000);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
    });
  }

  reply(id, result) { this.send({ id, result }); }
}
