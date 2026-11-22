#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const write = (data) => process.stdout.write(JSON.stringify(data) + '\n');
const event = (method, params) => write({ method, params });
const response = (id, result) => write({ id, result });
const threads = new Map();
const pending = new Map();
let callId = 0;

function runTool(threadId, turnId, tool, args, resolve) {
  const id = ++callId;
  pending.set(id, resolve);
  write({ id, method: 'item/tool/call', params: { threadId, turnId, callId: randomUUID(), tool, arguments: args } });
}
function complete(threadId, turnId, text) {
  event('item/completed', { threadId, item: { type: 'agentMessage', id: randomUUID(), text } });
  event('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params = {}, result } = JSON.parse(line);
  if (!method) {
    const callback = pending.get(id);
    pending.delete(id);
    callback?.(result);
    return;
  }
  const { threadId, input } = params;
  switch (method) {
    case 'initialize': return response(id, {});
    case 'config/read': return response(id, { config: { model: 'gpt-6.2-sol', model_reasoning_effort: 'low' } });
    case 'model/list': return response(id, { data: [] });
    case 'thread/start': return response(id, { thread: { id: randomUUID() } });
    case 'thread/resume': return response(id, { thread: { id: threadId } });
    case 'turn/steer': {
      const current = threads.get(threadId);
      if (current !== params.expectedTurnId) return write({ id, error: { message: 'Wrong turn' } });
      response(id, {});
      event('item/completed', { threadId, item: { id: randomUUID(), type: 'agentMessage', text: 'Steered: ' + input[0].text } });
      return;
    }
    case 'turn/start': {
      const turnId = randomUUID();
      threads.set(threadId, turnId);
      event('turn/started', { threadId, turn: { id: turnId } });
      response(id, { turn: { id: turnId, status: 'inProgress' } });
      const text = input[0].text.split('使用者訊息：\n').at(-1);
      if (text === 'hold') {
        return runTool(threadId, turnId, 'workspace_write', { path: 'shared.txt', version: 'new', contents: 'hello', reason: 'test' }, (written) => {
          if (!written.success) return complete(threadId, turnId, JSON.stringify(written));
          return runTool(threadId, turnId, 'workspace_read', { path: '/private/tmp/test-single-access.txt', reason: '核准測試' },
            (toolResult) => complete(threadId, turnId, JSON.stringify(toolResult)));
        });
      }
      if (text === 'conflict') {
        return runTool(threadId, turnId, 'workspace_write', { path: 'shared.txt', version: 'new', contents: 'later', reason: 'test' },
          (toolResult) => complete(threadId, turnId, JSON.stringify(toolResult)));
      }
      complete(threadId, turnId, input[0].text);
    }
  }
});
