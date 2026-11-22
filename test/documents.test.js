import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeDocument, readDocument, validateDocument } from '../server/documents.js';
import { Workspace } from '../server/workspace.js';
import { defaultOfficeBinary } from '../server/legacy-office.js';

const body = { title: '十一月結算', blocks: [
  { type:'paragraph', text:'原始單據與收入核對。' },
  { type:'table', header:true, rows:[['項目','金額'],['營業收入','12345']] },
] };
const workbook = { sheets: [
  { name:'結算', header:true, rows:[['項目','金額'],['營業收入',12345],['合計',{ formula:'SUM(B2:B2)', result:12345 }]] },
  { name:'備註', rows:[['金額為新臺幣']] },
] };

test('PDF and Office output can be reopened and read with Chinese text, rows and formulas', async () => {
  const word = await makeDocument('a.docx', JSON.stringify(body));
  const extracted = await readDocument('a.docx', word, { start:3, count:2 });
  assert.match(extracted.text, /項目\t金額/);
  assert.match(extracted.text, /營業收入\t12345/);
  const excel = await makeDocument('a.xlsx', JSON.stringify(workbook));
  assert.deepEqual((await readDocument('a.xlsx', excel, { sheet:'備註' })).sheets.map(({ name }) => name), ['結算','備註']);
  assert.match((await readDocument('a.xlsx', excel, { start:2, count:2 })).text, /營業收入\t12345\n3\t合計\t=SUM\(B2:B2\) → 12345/);
  await assert.rejects(() => readDocument('a.xlsx', excel, { sheet:'無效' }), /找不到指定工作表/);
  await assert.rejects(() => validateDocument('wrong.xlsx', word), /格式不符/);
  await assert.rejects(() => makeDocument('external.xlsx', JSON.stringify({ sheets:[{ name:'表', rows:[[{ formula:'WEBSERVICE("https://example.invalid")' }]] }] })), /工作簿內/);
  if (process.platform === 'darwin') {
    execFileSync('pdftotext', ['-v'], { stdio:'ignore' });
    const pdf = await makeDocument('a.pdf', JSON.stringify(body));
    const data = await readDocument('a.pdf', pdf);
    assert.match(data.text, /十一月結算/);
    assert.match(data.text, /營業收入\s+12345/);
    assert.throws(() => validateDocument('wrong.pdf', excel), /PDF 標頭/);
  }
});

test('the existing workspace tools create, register and reopen Office output', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'chat-doc-test-'));
  t.after(() => rmSync(folder, { recursive:true, force:true }));
  const log = [];
  const files = [];
  const workspace = new Workspace({
    active: () => true, sensitive: () => false,
    decide: () => { throw new Error('unexpected approval'); },
    log: (_, item) => log.push(item),
    addFile: (_, path) => { files.push(path); return 'result-link'; },
  });
  const use = (tool, args) => workspace.execute({ sessionId:'session', turnId:'turn',
    root:execFileSync('/bin/pwd', ['-P'], { cwd:folder, encoding:'utf8' }).trim(),
    tool, itemId:'result', args:{ reason:'test', path:'result.xlsx', ...args },
  }).then(JSON.parse);
  const generated = await use('workspace_write', { version:'new', contents:JSON.stringify(workbook) });
  assert.equal(files.length, 1);
  assert.equal(log[0].assets[0].id, 'result-link');
  assert.equal(log[0].title, '文件已產生');
  assert.equal((await use('workspace_read', { sheet:'備註' })).version, generated.version);
  assert.match((await readDocument('result.xlsx', readFileSync(generated.path))).text, /營業收入/);
  await assert.rejects(() => use('workspace_write', { version:'new', contents:JSON.stringify(workbook) }), /檔案已更新/);
});


test('legacy Office attachments reopen without changing original bytes', {
  skip: process.platform !== 'darwin' || !existsSync(process.env.CHAT_OFFICE_BIN || defaultOfficeBinary),
}, async (t) => {
  const source = mkdtempSync(join(tmpdir(), 'chat-legacy-test-'));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  const profile = '-env:UserInstallation=' + pathToFileURL(join(source, 'fixture-profile')).href;
  const office = process.env.CHAT_OFFICE_BIN || defaultOfficeBinary;
  for (const [modern, legacyFilter, spec] of [['docx', 'doc:MS Word 97', body], ['xlsx', 'xls:MS Excel 97', workbook]]) {
    const filename = join(source, 'sample.' + modern);
    writeFileSync(filename, await makeDocument(filename, JSON.stringify(spec)));
    execFileSync(office, [profile, '--headless', '--convert-to', legacyFilter, '--outdir', source, filename],
      { timeout: 20000, stdio: 'pipe' });
  }

  const wordPath = join(source, 'sample.doc');
  const excelPath = join(source, 'sample.xls');
  const word = readFileSync(wordPath);
  const excel = readFileSync(excelPath);
  assert.match((await readDocument(wordPath, word)).text, /原始單據與收入核對/);
  const sheet = await readDocument(excelPath, excel, { sheet: '結算', grid: true });
  assert.equal(sheet.format, 'xls');
  assert.equal(sheet.grid[1].cells[1], '12345');
  assert.match(sheet.grid[2].cells[1], /^=SUM\(.*\) → 12345$/);
  assert.deepEqual(sheet.sheets.map(({ name }) => name), ['結算', '備註']);
  assert.match((await readDocument(excelPath, excel, { sheet: '備註' })).text, /金額為新臺幣/);
  assert.deepEqual(readFileSync(wordPath), word);
  assert.deepEqual(readFileSync(excelPath), excel);
  assert.throws(() => validateDocument('bad.doc', Buffer.from('invented')), /格式不符/);
  assert.throws(() => validateDocument('bad.xls', Buffer.from('invented')), /格式不符/);
});
