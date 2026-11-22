import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

const app = document.querySelector('#app');
const modal = document.querySelector('#modal');
const preview = document.querySelector('#preview');
const notices = document.querySelector('#notices');
const lib = window.lucide;
const icon = (name, className = '') => `<i class="${className}" data-lucide="${name}" aria-hidden="true"></i>`;
const scenarioIcons = {
  chat: ['messages-square', '對話'], folder: ['folder', '資料夾'], code: ['code-xml', '程式'],
  pen: ['pen-tool', '設計'], image: ['image', '圖片'], flask: ['flask-conical', '研究'],
  book: ['book-open', '閱讀'], terminal: ['terminal', '終端機'], layers: ['layers', '企劃'],
};
const escape = (value = '') => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const fileUrl = (id, type = 'asset') => `/api/${type}/${encodeURIComponent(id)}`;
const href = (scenario, session = '') => `#/${encodeURIComponent(scenario)}${session ? '/' + encodeURIComponent(session) : ''}`;
const date = (timestamp) => timestamp ? new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric' }).format(timestamp) : '';
const modelLabels = { none: '無', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '極高', max: '最高', ultra: 'Ultra' };
const modelLabel = (model) => catalog.models.find((item) => item.model === model)?.displayName || model;

let state;
let catalog = { models: [] };
let thread;
let files = [];
let ws;
let reconnect;
let connection = false;
let drawer = false;
let pendingRefresh = false;
let syncInProgress = false;
let lastRoute = '';
let signingIn = false;
let sending = false;
let composerStatus = '';
const drafts = new Map();

function route() {
  try {
    const [scenarioId, page] = location.hash.slice(2).split('/').map(decodeURIComponent);
    return { scenarioId, page, sessionId: page === 'files' ? '' : page };
  } catch { return {}; }
}
function icons() {
  lib?.createIcons({ attrs: { 'stroke-width': 1.7 } });
}
async function api(path, data, body) {
  const options = data === undefined && body === undefined ? {} : {
    method: 'POST', headers: { 'X-Chat-Client': 'web' },
  };
  if (data !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(data);
  }
  if (body !== undefined) options.body = body;
  const response = await fetch('/api/' + path, options);
  const result = await response.json();
  if (!response.ok) {
    const error = Object.assign(new Error(result.error || '操作失敗'), { status: response.status });
    if (error.status === 401 && path !== 'login') showLogin();
    throw error;
  }
  return result;
}
function connect() {
  if (ws) return;
  const client = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  ws = client;
  client.addEventListener('open', () => { connection = true; refresh(); });
  client.addEventListener('message', () => refresh());
  client.addEventListener('close', () => {
    if (client !== ws) return;
    connection = false;
    ws = null;
    if (state) {
      renderConnection();
      reconnect = setTimeout(() => { connect(); refresh(); }, 1700);
    }
  });
}
async function refresh() {
  if (syncInProgress) { pendingRefresh = true; return; }
  syncInProgress = true;
  do {
    pendingRefresh = false;
    const hash = location.hash;
    const { scenarioId, page, sessionId } = route();
    try {
      const [next, selected, listing] = await Promise.all([
        api('state'),
        sessionId ? api('sessions/' + encodeURIComponent(sessionId)).catch((error) => {
          if (error.status !== 404) throw error;
          return null;
        }) : null,
        page === 'files' ? api('files/' + encodeURIComponent(scenarioId)).catch((error) => {
          if (error.status !== 404) throw error;
          return [];
        }) : [],
      ]);
      if (hash !== location.hash) { pendingRefresh = true; continue; }
      state = next;
      thread = selected?.session.scenarioId === scenarioId ? selected : null;
      files = listing;
      render();
    } catch (error) {
      if (error.status !== 401) showNotice(error.message);
    }
  } while (pendingRefresh);
  syncInProgress = false;
}
function showLogin() {
  state = null;
  clearTimeout(reconnect);
  const client = ws;
  ws = null;
  client?.close();
  if (modal.open) modal.close();
  if (preview.open) preview.close();
  if (app.querySelector('#login-form')) return;
  lastRoute = '';
  app.innerHTML = `<div class="login-layout">
    <div class="login-art"><div class="brand">${icon('orbit')}<span>Codex 工作室</span></div>
    <div class="login-art-mark">${icon('messages-square')}</div></div>
    <main class="login-content">
      <form id="login-form">
        <div class="login-symbol">${icon('lock-keyhole')}</div>
        <h1>登入工作室</h1>
        <p>使用 Mac 上設定的密碼，接續你的工作。</p>
        <label for="password">工作室密碼</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <p class="error" role="alert" id="login-error" hidden></p>
        <button class="primary login-submit">登入 ${icon('arrow-right')}</button>
      </form>
    </main>
  </div>`;
  icons();
}
function showNotice(message) {
  if (!message) return;
  const note = document.createElement('p');
  note.className = 'notice';
  note.textContent = message;
  notices.append(note);
  setTimeout(() => note.remove(), 6000);
}
function renderConnection() {
  const element = app.querySelector('#connection');
  if (element) element.innerHTML = `<span class="connection-dot ${connection ? 'online' : ''}"></span>${connection ? 'Mac 已連線' : '重新連線中'}`;
}
function scenarioIcon(scenario) {
  return scenario.iconAsset ? `<img src="${fileUrl(scenario.iconAsset)}" alt="" class="scenario-img">` : icon(scenarioIcons[scenario.icon]?.[0] || 'folder');
}
function alertCount(sessionId) { return state.pending.filter((item) => item.sessionId === sessionId).length; }
function renderNav(scenario) {
  const current = route().sessionId;
  const scenarios = state.scenarios.map((item) => `<a href="${href(item.id)}" class="nav-link ${item.id === scenario?.id ? 'selected' : ''}">
    <span class="nav-icon">${scenarioIcon(item)}</span><span class="nav-name">${escape(item.name)}</span></a>`).join('');
  const history = scenario ? state.sessions.filter((item) => item.scenarioId === scenario.id).map((item) => {
    const label = alertCount(item.id) ? '待核准' : item.status === 'running' ? '執行中' : '';
    return `<a href="${href(scenario.id, item.id)}" class="session-link ${item.id === current ? 'selected' : ''}">
      ${icon('message-circle')}<span>${escape(item.title)}</span>${label ? `<small>${label}</small>` : ''}</a>`;
  }).join('') : '';
  const nav = app.querySelector('#sidebar-content');
  const markup = `
    <a href="#/" class="brand">${icon('orbit')}<span>Codex 工作室</span></a>
    <div class="nav-section">
      <a href="#/" class="nav-link ${!scenario ? 'selected' : ''}">${icon('layout-grid')}<span>情境首頁</span></a>
    </div>
    <div class="nav-section scenario-links">
      <div class="nav-heading">情境 <button class="ghost square compact" data-action="create" aria-label="新增情境">${icon('plus')}</button></div>
      ${scenarios}
    </div>
    ${scenario ? `<div class="nav-section history">
      <div class="nav-heading">這個情境的對話</div>
      <a class="nav-link new-thread" href="${href(scenario.id)}">${icon('plus')}<span>新對話</span></a>
      ${history || '<p class="nav-empty">還沒有對話</p>'}
    </div>` : ''}
    <div class="nav-foot"><span id="connection"></span>
      <button class="ghost square compact" data-action="logout" aria-label="登出" title="登出">${icon('log-out')}</button></div>`;
  if (nav.dataset.markup !== markup) {
    nav.innerHTML = markup;
    nav.dataset.markup = markup;
  }
  renderConnection();
}
function alertBar(current) {
  const others = state.pending.filter((pending) => pending.sessionId !== current);
  return others.map((pending) => {
    const session = state.sessions.find((item) => item.id === pending.sessionId);
    if (!session) return '';
    return `<a class="alert-link" href="${href(session.scenarioId, session.id)}">${icon('bell')}<span><strong>${escape(session.title)}</strong> ${pending.kind === 'conflict' ? '等待你處理檔案衝突' : '等待你核准'}</span>${icon('arrow-right')}</a>`;
  }).join('');
}
function renderHome() {
  return `<div class="home">
    <header class="home-heading">
      <h1>選擇一個情境</h1>
      <p>直接跟 Codex 聊，或為你的專案建立工作情境。</p>
    </header>
    <div class="scenario-grid">
    ${state.scenarios.map((scenario) => `<a class="scenario-card ${scenario.id === 'chat' ? 'featured' : ''}" href="${href(scenario.id)}">
      <span class="card-icon">${scenarioIcon(scenario)}</span>
      <span class="card-title">${escape(scenario.name)} ${icon('arrow-up-right')}</span>
      <span class="card-caption">${scenario.id === 'chat' ? '從一段新對話開始' : scenario.project ? escape(scenario.root.split('/').at(-1)) : '情境工作資料夾'}</span>
    </a>`).join('')}
    <button class="scenario-card add-card" data-action="create">
      <span class="card-icon">${icon('plus')}</span>
      <span class="card-title">新增情境 ${icon('arrow-up-right')}</span>
      <span class="card-caption">設定共用提示詞、圖示和資料夾</span>
    </button></div>
  </div>`;
}
function renderFiles(scenario) {
  return `<div class="file-page">
    <h1>${escape(scenario.name)}的檔案</h1>
    <p class="project-path">${icon('folder')}專案 ${escape(scenario.project ? scenario.root.split('/').at(-1) : scenario.name)}<span>${escape(scenario.root)}</span></p>
    ${files.length ? `<ul class="files">${files.map((item) => {
      const session = state.sessions.find(({ id }) => item.sessionId === id);
      const url = fileUrl(item.id, item.asset ? 'asset' : 'file');
      return `<li>${icon(item.asset ? 'image' : 'file-text')}<div class="file-description">
        <button class="text-button" data-action="preview-file" data-url="${escape(url)}" data-name="${escape(item.name)}" ${item.available ? '' : 'disabled'}>${escape(item.name)}</button>
        <small>專案 ${escape(scenario.project ? scenario.root.split('/').at(-1) : scenario.name)} · ${escape(session?.title || '')} · ${date(item.at)}</small>
      </div>${item.available ? `<a class="ghost square" href="${url}?download=1" aria-label="下載 ${escape(item.name)}">${icon('download')}</a>` : '<small>已移除</small>'}</li>`;
    }).join('')}</ul>` : `<div class="empty-files">${icon('folder-open')}<p>Codex 在這個情境新增或修改的檔案會顯示在這裡。</p></div>`}
  </div>`;
}
function assistantText(text) {
  const clean = DOMPurify.sanitize(marked.parse(text || ''), {
    FORBID_TAGS: ['img', 'video', 'audio', 'source', 'form', 'style', 'input', 'button', 'iframe'],
    FORBID_ATTR: ['style', 'class', 'id', 'data-action'],
    ALLOW_DATA_ATTR: false,
  });
  const template = document.createElement('template');
  template.innerHTML = clean;
  for (const link of template.content.querySelectorAll('a')) {
    const to = link.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(to)) link.removeAttribute('href');
    else {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  }
  return template.innerHTML;
}
function attachments(assets = []) {
  if (!assets.length) return '';
  return `<div class="attachments">${assets.map((asset) => {
    const url = fileUrl(asset.id, asset.type);
    return asset.image
      ? `<button class="image-button" data-action="preview-file" data-url="${escape(url)}" data-name="${escape(asset.name)}"><img src="${url}" alt="${escape(asset.name)}" loading="lazy"></button>`
      : `<button class="file-chip" data-action="preview-file" data-url="${escape(url)}" data-name="${escape(asset.name)}">${icon('paperclip')}${escape(asset.name)}</button>`;
  }).join('')}</div>`;
}
function renderItem(item, expanded) {
  if (item.type === 'user') return `<article class="message user-message"><div class="message-body"><div class="user-text">${escape(item.text)}</div>${attachments(item.assets)}</div></article>`;
  if (item.type === 'assistant' || item.type === 'image') {
    return `<article class="message"><div class="message-icon">${icon('orbit')}</div><div class="message-body assistant-body">
      <div class="author">Codex</div>${item.type === 'assistant' ? assistantText(item.text) : attachments(item.assets)}
      </div></article>`;
  }
  return `<details class="activity" data-item="${escape(item.id)}" ${expanded.has(item.id) ? 'open' : ''}>
    <summary>${icon(item.type === 'command' ? 'terminal' : 'file-diff')} ${escape(item.title)} ${icon('chevron-down')}</summary>
    <pre>${escape(item.detail)}</pre></details>${item.assets?.length ? `<div class="activity-attachments">${attachments(item.assets)}</div>` : ''}`;
}
function renderApproval(item) {
  if (item.kind === 'conflict') return `<form class="approval" data-pending="${item.id}">
    <h3>${icon('files')} 檔案正在由另一段對話修改</h3><code>${escape(item.path)}</code>
    <label>給這段對話的替代做法<textarea name="instruction" rows="2" placeholder="例如先處理另一個檔案"></textarea></label>
    <div class="actions"><button class="secondary" name="decision" value="redirect">改用其他做法</button><button class="primary" name="decision" value="wait">等待並讀取最新版</button></div>
  </form>`;
  return `<form class="approval" data-pending="${item.id}">
    <h3>${icon('shield-check')} ${item.kind === 'access' ? '工作資料夾外的檔案存取' : '指令等待核准'}</h3>
    ${item.reason ? `<p>${escape(item.reason)}</p>` : ''}
    ${item.entries?.map(({ path, access }) => `<div class="approval-path"><strong>${access === 'write' ? '寫入' : '讀取'}</strong><code>${escape(path)}</code></div>`).join('') || ''}
    ${item.command ? `<pre>${escape(item.command)}</pre>` : ''}
    <div class="actions"><button class="secondary" name="decision" value="decline">拒絕</button><button class="primary" name="decision" value="accept">核准這一次</button></div>
  </form>`;
}
function renderThread(scenario) {
  const container = app.querySelector('#thread');
  const { sessionId } = route();
  const expanded = new Set([...container.querySelectorAll('details[open]')].map((item) => item.dataset.item));
  const atBottom = container.scrollHeight - container.clientHeight - container.scrollTop < 80;
  const items = thread?.items || [];
  if (!sessionId) {
    container.innerHTML = `<div class="empty-thread" data-scenario="${escape(scenario.id)}">
      <span class="empty-symbol">${scenarioIcon(scenario)}</span>
      <h1>${escape(scenario.name)}</h1>
      <p>輸入訊息，開始一段新對話。</p></div>`;
    return;
  }
  const approval = state.pending.filter((item) => item.sessionId === sessionId);
  const focus = document.activeElement;
  const activeApproval = focus?.closest('form[data-pending]');
  const oldApprovals = [...container.querySelectorAll('form[data-pending]')];
  if (activeApproval && approval.some(({ id }) => id === activeApproval.dataset.pending)) {
    // Keep an in-progress decision intact while the model streams.
    return;
  }
  const pendingTexts = new Map(oldApprovals.map((form) => [form.dataset.pending, form.elements.instruction?.value]));
  container.innerHTML = `<div class="thread-content">
    ${items.map((item) => renderItem(item, expanded)).join('')}
    ${approval.map(renderApproval).join('')}
    ${thread?.session.status === 'running' && !approval.length ? '<p class="working"><span></span>Codex 執行中</p>' : ''}
    ${thread?.session.error ? `<p class="error" role="alert">${escape(thread.session.error)}</p>` : ''}
  </div>`;
  for (const form of container.querySelectorAll('form[data-pending]')) {
    if (form.elements.instruction) form.elements.instruction.value = pendingTexts.get(form.dataset.pending) || '';
  }
  if (atBottom) container.scrollTop = container.scrollHeight;
}
function draft() {
  const { scenarioId, sessionId } = route();
  const key = sessionId || scenarioId;
  if (!drafts.has(key)) {
    const settings = (thread?.session || state?.sessions.find(({ id }) => id === sessionId))?.settings;
    drafts.set(key, { text: '', attachments: [], model: settings?.model || '', effort: settings?.effort || '' });
  }
  return drafts.get(key);
}
function renderSettings() {
  const form = app.querySelector('#composer');
  if (!form) return;
  const current = draft();
  const model = catalog.models.find((item) => item.model === (current.model || catalog.defaultModel));
  const efforts = model?.supportedReasoningEfforts?.map((item) => item.reasoningEffort) || [];
  const models = catalog.models.map((item) => [item.model, item.displayName]);
  if (current.model && !models.some(([id]) => id === current.model)) models.push([current.model, current.model]);
  if (current.effort && !efforts.includes(current.effort)) efforts.push(current.effort);
  const options = (value, list, label) => `<option value="">${escape(label)}</option>` +
    list.map(([id, name]) => `<option value="${escape(id)}" ${value === id ? 'selected' : ''}>${escape(name)}</option>`).join('');
  const modelOptions = options(current.model, models, catalog.defaultModel ? `預設 · ${modelLabel(catalog.defaultModel)}` : '預設模型');
  const selectedEffortDefault = current.model
    ? (efforts.includes(catalog.defaultEffort) ? catalog.defaultEffort : model?.defaultReasoningEffort)
    : catalog.defaultEffort;
  const effortOptions = options(current.effort, efforts.map((value) => [value, modelLabels[value] || value]),
    selectedEffortDefault ? `預設 · ${modelLabels[selectedEffortDefault] || selectedEffortDefault}` : '預設思考強度');
  if (form.elements.model.dataset.options !== modelOptions) {
    form.elements.model.innerHTML = modelOptions;
    form.elements.model.dataset.options = modelOptions;
  }
  if (form.elements.effort.dataset.options !== effortOptions) {
    form.elements.effort.innerHTML = effortOptions;
    form.elements.effort.dataset.options = effortOptions;
  }
  form.elements.model.value = current.model;
  form.elements.effort.value = current.effort;
}
function renderComposer() {
  const form = app.querySelector('#composer');
  if (!form) return;
  const current = draft();
  const attached = form.querySelector('.draft-attachments');
  const markup = current.attachments.map((asset) => `<span class="file-chip">${icon('paperclip')}${escape(asset.name)}
    <button type="button" class="ghost square compact" data-action="detach" data-id="${asset.id}" aria-label="移除 ${escape(asset.name)}">${icon('x')}</button></span>`).join('');
  if (attached.dataset.markup !== markup) {
    attached.innerHTML = markup;
    attached.dataset.markup = markup;
  }
  form.querySelector('.compose-status').textContent = composerStatus;
  form.querySelector('[type=submit]').disabled = sending || (!current.text.trim() && !current.attachments.length);
  form.querySelector('[data-action=interrupt]').hidden = thread?.session?.status !== 'running';
  form.elements.message.placeholder = thread?.session?.status === 'running' ? '補充指示給 Codex…' : '傳訊息給 Codex…';
  renderSettings();
}
function render() {
  if (!state) return;
  const { scenarioId, page, sessionId } = route();
  const scenario = state.scenarios.find((item) => item.id === scenarioId);
  if (!app.querySelector('#layout')) {
    app.innerHTML = `<div id="layout"><button id="scrim" aria-label="關閉導覽" data-action="drawer"></button>
      <aside id="sidebar" aria-label="工作室導覽"><div id="sidebar-content"></div></aside>
      <main class="main"><header class="topbar">
        <button data-action="drawer" class="ghost square mobile-menu" aria-label="開啟導覽">${icon('panel-left')}</button>
        <div class="breadcrumb"></div><div class="top-actions"></div>
      </header><div id="alerts" aria-live="polite"></div><section id="screen"></section></main></div>`;
  }
  app.querySelector('#layout').classList.toggle('drawer-open', drawer);
  const nav = app.querySelector('#sidebar-content');
  const navPosition = nav.scrollTop;
  renderNav(scenario);
  nav.scrollTop = navPosition;
  app.querySelector('.breadcrumb').innerHTML = scenario
    ? `<a href="#/" aria-label="情境首頁">${icon('layout-grid')}</a>${icon('chevron-right')}<span>${escape(scenario.name)}</span>`
    : `<span>情境首頁</span>`;
  app.querySelector('.top-actions').innerHTML = scenario ? `
    <a href="${href(scenario.id, 'files')}" class="secondary ${page === 'files' ? 'active' : ''}">${icon('folder')}<span>檔案</span></a>
    ${scenario.id !== 'chat' ? `<button data-action="edit" class="ghost square" aria-label="情境設定" title="情境設定">${icon('settings-2')}</button>` : ''}
  ` : '';
  app.querySelector('#alerts').innerHTML = alertBar(sessionId);
  const screen = app.querySelector('#screen');
  const isChat = scenario && page !== 'files';
  const changed = lastRoute !== location.hash;
  if (isChat) {
    if (!screen.querySelector('#composer') || changed) {
      screen.innerHTML = `<div class="chat-screen"><div id="thread" aria-label="對話內容"></div>
        <div class="composer-outer"><form id="composer">
          <div class="draft-attachments"></div>
          <textarea name="message" rows="2" aria-label="訊息" placeholder="傳訊息給 Codex…"></textarea>
          <p class="compose-status" role="status"></p>
          <div class="composer-bar">
            <button type="button" data-action="attach" class="ghost square" title="加附件，支援 PDF、Word（.doc、.docx）、Excel（.xls、.xlsx）和圖片" aria-label="加附件">${icon('paperclip')}</button>
            <input type="file" id="attachments-input" multiple hidden>
            <select name="model" aria-label="模型"></select>
            <select name="effort" aria-label="思考強度"></select>
            <button type="button" data-action="interrupt" class="ghost square stop" title="停止本輪" aria-label="停止本輪" hidden>${icon('square')}</button>
            <button class="primary square send" type="submit" title="送出訊息" aria-label="送出訊息">${icon('arrow-up')}</button>
          </div>
        </form></div></div>`;
      screen.querySelector('textarea').value = draft().text;
    }
    renderThread(scenario);
    renderComposer();
    if (changed) {
      const container = screen.querySelector('#thread');
      container.scrollTop = container.scrollHeight;
    }
  } else {
    screen.innerHTML = scenario ? renderFiles(scenario) : renderHome();
  }
  lastRoute = location.hash;
  icons();
}

function scenarioDialog(existing) {
  const saved = { icon: existing?.icon || 'folder', image: existing?.iconAsset || null };
  modal.innerHTML = `<form id="scenario-form">
    <header class="dialog-header"><h2>${existing ? '情境設定' : '新增情境'}</h2><button type="button" class="ghost square" data-action="close-modal" aria-label="關閉">${icon('x')}</button></header>
    <label>情境名稱<input name="name" maxlength="60" required value="${escape(existing?.name)}" placeholder="例如網站開發"></label>
    <fieldset><legend>首頁圖示</legend>
      <div class="icon-methods">
        <button class="secondary" type="button" data-icon-mode="builtin">內建圖示</button>
        <button class="secondary" type="button" data-icon-mode="upload">上傳圖片</button>
        <button class="secondary" type="button" data-icon-mode="generate">讓 Codex 繪製</button>
      </div>
      <div data-mode="builtin" class="icon-options">${Object.entries(scenarioIcons).map(([key, [graphic, label]]) =>
        `<button type="button" data-icon-id="${key}" title="${label}" aria-label="${label}">${icon(graphic)}</button>`).join('')}</div>
      <div data-mode="upload" hidden><label>選擇圖示圖片<input type="file" name="icon-file" accept="image/png,image/jpeg,image/webp,image/gif"></label></div>
      <div data-mode="generate" hidden class="generate-row"><label>圖示描述<input name="icon-prompt" placeholder="例如一座線條簡潔的山" maxlength="2500"></label>
        <button class="secondary" type="button" data-action="generate-icon">${icon('sparkles')} 生成圖示</button></div>
      <img id="saved-icon" alt="首頁圖示預覽" hidden>
      <p class="error" id="icon-status" role="status" hidden></p>
    </fieldset>
    <label>共用提示詞<textarea name="prompt" rows="4" maxlength="24000" placeholder="這個情境的每段對話都會套用">${escape(existing?.prompt)}</textarea></label>
    <label>Mac 專案資料夾 <small>選填</small><input name="root" placeholder="/Users/你的帳號/Projects/專案" value="${escape(existing?.project ? existing.root : '')}" ${existing ? 'readonly' : ''}></label>
    <p class="field-hint">${existing ? '要使用另一個資料夾時，請新增情境。' : '留空時，會自動建立情境專屬的共用工作資料夾。'}</p>
    <p id="scenario-error" class="error" role="alert" hidden></p>
    <div class="actions"><button class="secondary" type="button" data-action="close-modal">取消</button><button class="primary" type="submit">${existing ? '儲存設定' : '建立情境'}</button></div>
  </form>`;
  const form = modal.querySelector('form');
  const setIconMode = (mode) => {
    for (const panel of form.querySelectorAll('[data-mode]')) panel.hidden = panel.dataset.mode !== mode;
    for (const button of form.querySelectorAll('[data-icon-mode]')) button.setAttribute('aria-pressed', String(button.dataset.iconMode === mode));
  };
  const updateIcon = () => {
    const image = form.querySelector('#saved-icon');
    image.hidden = !saved.image;
    if (saved.image) image.src = fileUrl(saved.image);
    for (const button of form.querySelectorAll('[data-icon-id]')) button.setAttribute('aria-pressed', String(!saved.image && button.dataset.iconId === saved.icon));
  };
  const status = (message) => {
    const element = form.querySelector('#icon-status');
    element.hidden = !message;
    element.textContent = message;
  };
  setIconMode(saved.image ? 'upload' : 'builtin');
  updateIcon();
  form.addEventListener('click', async (event) => {
    const mode = event.target.closest('[data-icon-mode]')?.dataset.iconMode;
    const iconId = event.target.closest('[data-icon-id]')?.dataset.iconId;
    const generate = event.target.closest('[data-action=generate-icon]');
    if (mode) setIconMode(mode);
    if (iconId) { saved.icon = iconId; saved.image = null; updateIcon(); }
    if (!generate) return;
    const prompt = form.elements['icon-prompt'].value.trim();
    if (!prompt) return status('請輸入圖示描述');
    generate.disabled = true;
    form.querySelector('[type=submit]').disabled = true;
    status('Codex 正在繪製圖示…');
    try {
      let job = await api('jobs', { prompt });
      while (form.isConnected && modal.open && job.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 1600));
        job = await api('jobs/' + job.id);
      }
      if (!form.isConnected || !modal.open) return;
      if (job.status !== 'completed') throw new Error(job.error || '圖示生成失敗');
      saved.image = job.assetId;
      updateIcon();
      status('');
    } catch (error) { status(error.message); }
    finally { generate.disabled = false; form.querySelector('[type=submit]').disabled = false; }
  });
  form.elements['icon-file'].addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    form.querySelector('[type=submit]').disabled = true;
    status('上傳中…');
    try {
      const result = await upload(file, 'icon');
      saved.image = result.id;
      updateIcon();
      status('');
    } catch (error) { status(error.message); }
    finally { form.querySelector('[type=submit]').disabled = false; }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    event.submitter.disabled = true;
    try {
      await api(existing ? 'scenarios/' + existing.id : 'scenarios', {
        name: form.elements.name.value, root: form.elements.root.value, prompt: form.elements.prompt.value,
        icon: saved.icon, iconAsset: saved.image,
      });
      modal.close();
      refresh();
    } catch (error) {
      const message = form.querySelector('#scenario-error');
      message.hidden = false;
      message.textContent = error.message;
    } finally { event.submitter.disabled = false; }
  });
  modal.showModal();
  icons();
}

async function upload(file, kind, scenario) {
  const query = new URLSearchParams({ kind, name: file.name });
  if (scenario) query.set('scenario', scenario);
  return api('upload?' + query, undefined, file);
}
async function previewFile(url, name) {
  const image = /\.(png|jpe?g|webp|gif)$/i.test(name);
  const pdf = /\.pdf$/i.test(name);
  preview.innerHTML = `<div class="preview-file">
    <header class="dialog-header"><h2>${escape(name)}</h2><button data-action="close-preview" class="ghost square" aria-label="關閉">${icon('x')}</button></header>
    ${image ? `<img src="${escape(url)}" alt="${escape(name)}">` : '<label id="preview-sheet" hidden>工作表<select aria-label="工作表"></select></label><pre id="preview-content">載入中…</pre><div id="preview-grid" hidden></div><p id="preview-note" class="field-hint" hidden></p>'}
    <div class="actions">
      ${pdf ? `<a class="secondary" target="_blank" rel="noopener" href="${escape(url)}">${icon('external-link')}開啟 PDF</a>` : ''}
      <a class="secondary" href="${escape(url)}?download=1">${icon('download')}下載</a>
    </div>
  </div>`;
  preview.showModal();
  icons();
  if (!image) {
    const element = preview.querySelector('pre');
    const sheetLabel = preview.querySelector('#preview-sheet');
    const selector = sheetLabel.querySelector('select');
    const grid = preview.querySelector('#preview-grid');
    const note = preview.querySelector('#preview-note');
    let request = 0;
    async function show(sheet) {
      const currentRequest = ++request;
      element.hidden = false;
      element.textContent = '載入中…';
      grid.hidden = true;
      note.hidden = true;
      try {
        const query = new URLSearchParams({ preview: '1' });
        if (sheet) query.set('sheet', sheet);
        const result = await api(url.slice(5) + '?' + query);
        if (currentRequest !== request) return;
        element.textContent = result.text + (result.truncated ? '\n\n預覽已截短，可下載完整檔案。' : '');
        if (result.grid?.length) {
          grid.innerHTML = `<table aria-label="工作表預覽"><tbody>${result.grid.map(({ row, cells }) =>
            `<tr><th scope="row">${escape(row)}</th>${cells.map((value) => `<td>${escape(value)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
          element.hidden = true;
          grid.hidden = false;
          if (result.partial || result.truncated) {
            note.textContent = '目前顯示部分內容，可下載完整工作簿。';
            note.hidden = false;
          }
        }
        if (result.sheets?.length) {
          selector.replaceChildren(...result.sheets.map(({ name }) => new Option(name, name, false, name === result.sheet)));
          sheetLabel.hidden = false;
        }
      } catch (error) {
        if (currentRequest === request) {
          element.textContent = /\.(doc|xls)$/i.test(name) ? error.message : '請下載以開啟此檔案。';
        }
      }
    }
    selector.addEventListener('change', () => show(selector.value));
    await show();
  }
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  try {
    switch (button.dataset.action) {
      case 'drawer': drawer = !drawer; app.querySelector('#layout').classList.toggle('drawer-open', drawer); break;
      case 'create': scenarioDialog(); break;
      case 'edit': scenarioDialog(state.scenarios.find((item) => item.id === route().scenarioId)); break;
      case 'close-modal': modal.close(); break;
      case 'close-preview': preview.close(); break;
      case 'logout': await api('logout', {}); showLogin(); break;
      case 'attach': document.querySelector('#attachments-input').click(); break;
      case 'detach': draft().attachments = draft().attachments.filter((item) => item.id !== button.dataset.id); renderComposer(); icons(); break;
      case 'interrupt': await api('sessions/' + route().sessionId + '/interrupt', {}); break;
      case 'preview-file': await previewFile(button.dataset.url, button.dataset.name); break;
    }
  } catch (error) { showNotice(error.message); }
});
document.addEventListener('input', (event) => {
  if (event.target.matches('#composer textarea')) {
    draft().text = event.target.value;
    renderComposer();
  }
});
document.addEventListener('change', async (event) => {
  const target = event.target;
  if (!target.closest('#composer')) return;
  const current = draft();
  if (target.name === 'model') {
    current.model = target.value;
    current.effort = '';
    renderSettings();
  }
  if (target.name === 'effort') current.effort = target.value;
  if (target.id !== 'attachments-input') return;
  const loaded = [...target.files];
  target.value = '';
  const { scenarioId } = route();
  if (current.attachments.length + loaded.length > 12) return showNotice('每則訊息最多附加 12 個檔案');
  composerStatus = '上傳附件中…';
  renderComposer();
  try {
    for (const file of loaded) current.attachments.push(await upload(file, 'attachment', scenarioId));
  } catch (error) { showNotice(error.message); }
  finally { composerStatus = ''; renderComposer(); icons(); }
});
document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (form.id === 'login-form') {
    event.preventDefault();
    if (signingIn) return;
    signingIn = true;
    const output = form.querySelector('#login-error');
    output.hidden = true;
    try {
      await api('login', { password: form.elements.password.value });
      await refresh();
      if (!state) throw new Error('登入後無法開啟工作室，請確認瀏覽器允許此網站使用 Cookie。');
      connect();
      loadCatalog();
    } catch (error) {
      output.textContent = error.message;
      output.hidden = false;
    } finally { signingIn = false; }
  }
  if (form.matches('[data-pending]')) {
    event.preventDefault();
    event.submitter.disabled = true;
    try {
      await api('pending/' + form.dataset.pending, { decision: event.submitter.value, instruction: form.elements.instruction?.value });
      refresh();
    } catch (error) { showNotice(error.message); }
    finally { event.submitter.disabled = false; }
  }
  if (form.id !== 'composer') return;
  event.preventDefault();
  const value = draft();
  if (sending || (!value.text.trim() && !value.attachments.length)) return;
  const { scenarioId, sessionId } = route();
  const page = location.hash;
  sending = true;
  composerStatus = '傳送中…';
  renderComposer();
  const messageId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  try {
    const item = await api('messages', { scenarioId, sessionId, text: value.text, model: value.model, effort: value.effort,
      attachments: value.attachments.map(({ id }) => id), messageId });
    value.text = '';
    value.attachments = [];
    if (!sessionId) {
      drafts.set(item.id, { ...value });
      if (location.hash === page) location.hash = href(scenarioId, item.id);
    } else if (location.hash === page) {
      form.elements.message.value = '';
      form.elements.message.focus();
    }
    refresh();
  } catch (error) { showNotice(error.message); refresh(); }
  finally { sending = false; composerStatus = ''; renderComposer(); icons(); }
});
document.addEventListener('keydown', (event) => {
  if (!event.target.matches('#composer textarea') || event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.isComposing) return;
  event.preventDefault();
  event.target.form.requestSubmit();
});
window.addEventListener('hashchange', () => {
  drawer = false;
  thread = null;
  files = [];
  render();
  if (state) refresh();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && state) refresh(); });
async function loadCatalog() {
  try { catalog = await api('models'); renderSettings(); }
  catch (error) { if (error.status !== 401) showNotice(error.message); }
}
await refresh();
if (state) { connect(); loadCatalog(); }
