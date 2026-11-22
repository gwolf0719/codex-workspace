import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { Codex } from './codex.js';
import { isDocument } from './documents.js';
import { canonical, within, Workspace, workspaceTools } from './workspace.js';

const defaults = {
  permissions: 'chat_workspace', approvalPolicy: 'on-request', approvalsReviewer: 'user',
};
const documentInstructions = [
  'For PDF, Word (.doc or .docx) and Excel (.xls or .xlsx) input, call workspace_read with the original file path. The workspace handles legacy formats internally. For Word and Excel table output, preserve numbers and row alignment.',
  'For requested PDF, Word or Excel output, call workspace_write with .pdf, .docx or .xlsx and contents as a JSON string. PDF and DOCX JSON: {"title":"Title","blocks":[{"type":"heading","text":"Heading"},{"type":"paragraph","text":"Body"},{"type":"table","header":true,"rows":[["A","B"],["C","D"]]}]}. Simple documents can use {"title":"Title","text":"Body"} instead.',
  'XLSX JSON: {"sheets":[{"name":"Sheet","header":true,"rows":[["Name","Count"],["Item",2],["Total",{"formula":"SUM(B2:B2)","result":2}]]}]}. Use actual numbers and booleans where appropriate. The workspace provides working download buttons in the conversation. Refer to the names of the resulting files without linking to local filesystem URLs.',
];
const instructions = [
  'Use workspace_read, workspace_write or workspace_patch for file edits. Use workspace_command for local shell commands.',
  'Declare exact file paths in workspace_command writes and externalReads. These tools coordinate concurrent edits and request one-time human approval for external paths.',
  'Use the native image generation tool for user-requested images. Do not use shell, scripts, SVG or external APIs to draw images. The application imports the generated image automatically.',
  ...documentInstructions,
  'Each user message may carry a scenario instruction block. Use the latest block as the current scenario instructions, subject to these tool rules.',
].join('\n');

export class Sessions {
  live = new Map();
  pending = new Map();
  activeTurns = new Map();

  constructor({ store, data, notify, codexFactory = (options) => new Codex(options), imageRoots }) {
    Object.assign(this, { store, data, notify, codexFactory, imageRoots });
    this.workspace = new Workspace({
      decide: this.decide.bind(this), log: this.log.bind(this), addFile: this.addFile.bind(this),
      active: (id, turnId) => this.activeTurns.get(id) === turnId,
      sensitive: (path) => [resolve(data, 'assets'), resolve(data, 'state.sqlite'), resolve(data, 'login-password')]
        .some((protectedPath) => within(protectedPath, path)) || /^state\.sqlite-/.test(basename(path)) && dirname(path) === data,
    });
    for (const session of store.list('sessions')) {
      if (session.status === 'running') this.saveSession(session.id, { status: 'interrupted', error: '主機已重新啟動，可接續對話。' });
    }
    for (const job of store.list('jobs')) {
      if (job.status === 'running') store.put('jobs', { ...job, status: 'failed', error: '主機已重新啟動' });
    }
  }

  connect() {
    if (this.codex && !this.codex.closed) return this.codex;
    const codex = this.codexFactory({ cwd: this.data });
    this.codex = codex;
    codex.on('event', (event) => {
      Promise.resolve(this.handle(codex, event)).catch((error) => console.error('Codex event:', error.message));
    });
    codex.on('closed', (error) => {
      for (const id of this.live.values()) {
        const session = this.store.get('sessions', id);
        if (session?.status === 'running') this.finish(id, 'interrupted', error.message);
      }
      this.live.clear();
    });
    return codex;
  }

  saveSession(id, changes) {
    const session = this.store.get('sessions', id);
    const next = this.store.put('sessions', { ...session, ...changes, id });
    this.notify(id);
    return next;
  }

  log(sessionId, item) {
    const id = sessionId + '/' + item.id;
    const previous = this.store.get('timeline', id);
    this.store.put('timeline', { ...previous, ...item, id, sessionId, at: previous?.at ?? Date.now() });
    this.notify(sessionId);
  }

  storeAsset({ source, name, scenarioId, sessionId, kind }) {
    const id = randomUUID();
    const path = resolve(this.data, 'assets', id);
    copyFileSync(source, path);
    return this.store.put('assets', { id, path, name, scenarioId, sessionId, kind });
  }

  addFile(id, path, removed = false) {
    const session = this.store.get('sessions', id);
    const key = session.scenarioId + '/' + path;
    if (removed) this.store.remove('files', key);
    else this.store.put('files', { id: key, path, name: basename(path), sessionId: id, scenarioId: session.scenarioId, at: Date.now() });
    this.notify(id);
    return key;
  }

  decide(sessionId, turnId, prompt) {
    const id = randomUUID();
    const { resolve, promise } = Promise.withResolvers();
    this.pending.set(id, { id, sessionId, turnId, ...prompt, resolve });
    this.notify(sessionId);
    return promise;
  }

  answer(id, answer) {
    const pending = this.pending.get(id);
    if (!pending) throw new Error('這筆核准已處理或逾時');
    const allowed = pending.kind === 'conflict' ? ['wait', 'redirect'] : ['accept', 'decline'];
    if (!allowed.includes(answer.decision)) throw new Error('無效的決定');
    if (answer.decision === 'redirect' && (!String(answer.instruction || '').trim() || String(answer.instruction).length > 10000)) {
      throw new Error('請輸入要交給對話的指示');
    }
    this.pending.delete(id);
    pending.resolve(answer);
    this.notify(pending.sessionId);
  }

  listPending() {
    return [...this.pending.values()].map(({ resolve, ...item }) => item);
  }

  finish(id, status, error) {
    const turnId = this.activeTurns.get(id);
    this.activeTurns.delete(id);
    for (const [key, pending] of this.pending) {
      if (pending.sessionId === id) {
        this.pending.delete(key);
        pending.resolve({ decision: 'decline' });
      }
    }
    this.workspace.release(id, turnId);
    this.saveSession(id, { status, error: error || null });
    const job = this.store.get('jobs', id);
    if (job?.status === 'running') {
      this.store.put('jobs', { ...job, status: 'failed', error: error || 'Codex 沒有傳回生成的圖片' });
      this.notify(id);
    }
  }

  async models() {
    const codex = this.connect();
    await codex.ready;
    const [{ data }, { config }] = await Promise.all([
      codex.call('model/list', {}), codex.call('config/read', {}),
    ]);
    return { models: data.filter((model) => !model.hidden), defaultModel: config.model ?? null, defaultEffort: config.model_reasoning_effort ?? null };
  }

  async message({ scenario, session, text, attachments = [], settings, messageId }) {
    if (canonical(scenario.root) !== scenario.root || !existsSync(scenario.root)) throw new Error('工作資料夾路徑已變更');
    const codex = this.connect();
    const previous = this.store.get('timeline', session.id + '/' + messageId);
    if (previous) return session;
    const wasRunning = session.status === 'running';
    const currentTurn = this.activeTurns.get(session.id);
    if (wasRunning && !currentTurn) throw new Error('Codex 正在啟動這段對話，請稍候');
    this.saveSession(session.id, { ...session, settings, status: 'running', error: null, updatedAt: Date.now() });
    try {
      await codex.ready;
      let threadId = session.threadId;
      if (!this.live.has(threadId)) {
        const options = {
          ...defaults, cwd: scenario.root, runtimeWorkspaceRoots: [scenario.root],
          developerInstructions: instructions,
          config: {
            mcp_servers: {}, 'features.request_permissions_tool': false, 'features.image_generation': true,
            'features.shell_tool': false, 'features.unified_exec': false, 'features.hooks': false, 'features.plugins': false,
          },
        };
        const response = threadId ? await codex.call('thread/resume', { ...options, threadId, excludeTurns: true }) :
          await codex.call('thread/start', { ...options, dynamicTools: workspaceTools });
        threadId = response.thread.id;
        this.live.set(threadId, session.id);
        this.saveSession(session.id, { threadId });
      }

      const hidden = [
        '此訊息的情境設定（取代前面訊息的情境設定）',
        '情境名稱：' + scenario.name,
        '工作資料夾：' + scenario.root,
        '共用提示詞：' + (scenario.prompt || '空白'),
        ...documentInstructions,
        ...attachments.map(({ name, localPath }) => `使用者本次上傳的檔案 ${name}（本機路徑 ${localPath}）${isDocument(name) ? '，可用 workspace_read 擷取內容' : ''}`),
      ].join('\n');
      const input = [{ type: 'text', text: hidden + '\n\n使用者訊息：\n' + text, text_elements: [] }];
      for (const attachment of attachments) {
        if (attachment.image) input.push({ type: 'localImage', path: attachment.localPath });
      }
      this.log(session.id, { id: messageId, type: 'user', text, assets: attachments.map(({ id, name, image }) => ({ id, name, image })) });
      if (wasRunning) {
        await codex.call('turn/steer', { threadId, expectedTurnId: currentTurn, clientUserMessageId: messageId, input });
      } else {
        const config = (await codex.call('config/read', { cwd: scenario.root })).config;
        const model = settings.model || config.model;
        let effort = settings.effort || config.model_reasoning_effort;
        if (settings.model && settings.model !== config.model) {
          const { data } = await codex.call('model/list', {});
          const chosen = data.find((item) => item.model === settings.model);
          if (!chosen) throw new Error('這個模型目前無法使用');
          const supported = chosen.supportedReasoningEfforts.map((item) => item.reasoningEffort);
          if (settings.effort && !supported.includes(settings.effort)) throw new Error('模型不支援這個思考強度');
          if (!supported.includes(effort)) effort = chosen.defaultReasoningEffort;
        }
        await codex.call('turn/start', { ...defaults, threadId, clientUserMessageId: messageId, input,
          model: model || null, effort: effort || null });
      }
      return this.store.get('sessions', session.id);
    } catch (error) {
      this.store.remove('timeline', session.id + '/' + messageId);
      if (!wasRunning || !this.activeTurns.has(session.id)) this.finish(session.id, 'failed', error.message);
      throw error;
    }
  }

  async interrupt(id) {
    const session = this.store.get('sessions', id);
    const turnId = this.activeTurns.get(id);
    if (!turnId) throw new Error('對話目前沒有執行中的任務');
    await this.codex.call('turn/interrupt', { threadId: session.threadId, turnId });
  }

  async handle(codex, { id, method, params = {} }) {
    if (this.codex !== codex) return;
    const sessionId = this.live.get(params.threadId);
    const reply = (result) => { if (!codex.closed) codex.reply(id, result); };
    if (id !== undefined) {
      if (method === 'item/tool/call') {
        let text;
        let success = true;
        try {
          const session = this.store.get('sessions', sessionId);
          const scenario = this.store.get('scenarios', session?.scenarioId || '');
          if (!scenario) throw new Error('找不到這項工具的對話');
          text = await this.workspace.execute({ sessionId, turnId: params.turnId, root: scenario.root,
            tool: params.tool, args: params.arguments, itemId: params.callId });
        } catch (error) {
          success = false;
          text = error.message;
        }
        reply({ success, contentItems: [{ type: 'inputText', text }] });
      } else if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        if (sessionId && params.kind === 'humanCommand' && this.activeTurns.get(sessionId) === params.turnId) {
          const answer = await this.decide(sessionId, params.turnId, { kind: 'command', reason: params.reason, command: params.command });
          reply({ decision: answer.decision });
        } else {
          reply({ decision: 'decline' });
        }
      } else if (method === 'item/permissions/requestApproval') {
        reply({ permissions: {}, scope: 'turn' });
      } else {
        if (!codex.closed) codex.send({ id, error: { code: -32601, message: 'Unsupported request' } });
      }
      return;
    }
    if (!sessionId) return;
    if (method === 'turn/started') this.activeTurns.set(sessionId, params.turn.id);
    if (method === 'turn/completed') this.finish(sessionId, params.turn.status, params.turn.error?.message);
    if (method === 'item/agentMessage/delta') {
      const previous = this.store.get('timeline', sessionId + '/' + params.itemId);
      this.log(sessionId, { id: params.itemId, type: 'assistant', text: (previous?.text || '') + params.delta });
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item;
      if (item.type === 'agentMessage' && item.text) this.log(sessionId, { id: item.id, type: 'assistant', text: item.text });
      if (item.type === 'commandExecution') this.log(sessionId, { id: item.id, type: 'command',
        title: item.status === 'inProgress' ? '執行指令中' : '指令紀錄',
        detail: [item.command, item.aggregatedOutput].filter(Boolean).join('\n\n') });
      if (item.type === 'imageGeneration' && method === 'item/completed') this.importImage(sessionId, item);
    }
  }

  importImage(sessionId, item) {
    if (!item.savedPath || !isAbsolute(item.savedPath) || !existsSync(item.savedPath)) return;
    const source = canonical(item.savedPath);
    const session = this.store.get('sessions', sessionId);
    const scenario = this.store.get('scenarios', session.scenarioId);
    if (![scenario.root, ...this.imageRoots].some((root) => within(root, source))) return;
    if (!/\.(png|jpe?g|webp|gif)$/i.test(source) || !statSync(source).isFile() || statSync(source).size > 30 * 1024 * 1024) return;
    const asset = this.storeAsset({ source, name: basename(source), scenarioId: scenario.id, sessionId, kind: 'output' });
    this.log(sessionId, { id: item.id, type: 'image', assets: [{ id: asset.id, name: asset.name, image: true }] });
    const job = this.store.get('jobs', sessionId);
    if (job?.status === 'running') {
      this.store.put('jobs', { ...job, status: 'completed', assetId: asset.id });
      this.notify(sessionId);
    }
  }
}

export function ensureScenarioRoot(data, id, requested = '') {
  if (requested && !isAbsolute(requested)) throw new Error('請輸入 Mac 上的完整資料夾路徑');
  const path = requested || resolve(data, 'workspaces', id);
  if (!requested) mkdirSync(path, { recursive: true });
  const root = canonical(path);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error('找不到這個專案資料夾');
  if (within(root, data) || (within(data, root) && !within(resolve(data, 'workspaces'), root))) {
    throw new Error('請使用個別專案或工作的資料夾');
  }
  return root;
}
