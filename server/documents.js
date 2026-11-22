import { execFile } from 'node:child_process';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import mammoth from 'mammoth';
import { DomUtils, parseDocument } from 'htmlparser2';
import ExcelJS from 'exceljs';
import yauzl from 'yauzl';
import { checkLegacyHeader, convertLegacyOffice, legacyOffice } from './legacy-office.js';

export const documentTypes = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
export const documentLimit = 25 * 1024 * 1024;
const extension = (name) => extname(name).toLowerCase();
export const isDocument = (name) => Object.hasOwn(documentTypes, extension(name));
export const isLegacyDocument = (name) => Object.hasOwn(legacyOffice, extension(name));
const outputLimit = 60000;
const ocrScript = fileURLToPath(new URL('./pdf-ocr.swift', import.meta.url));

export function validateDocument(name, bytes) {
  const ext = extension(name);
  if (isLegacyDocument(name)) {
    checkLegacyHeader(ext, bytes);
    return Promise.resolve();
  }
  if (ext === '.pdf') {
    if (!bytes.subarray(0, 1024).includes('%PDF-')) throw new Error('這個檔案沒有有效的 PDF 標頭');
    return Promise.resolve();
  }
  const expected = ext === '.docx' ? 'word/document.xml' : 'xl/workbook.xml';
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (failure, zip) => {
      if (failure) return reject(new Error('這個檔案不是有效的 Word 或 Excel 檔案'));
      let found = false;
      let total = 0;
      const names = new Set();
      const fail = (message) => { zip.close(); reject(new Error(message)); };
      if (zip.entryCount > 4096) return fail('Office 檔案內部項目過多');
      zip.on('error', (error) => fail('無法讀取 Office 檔案：' + error.message));
      zip.on('entry', (entry) => {
        total += entry.uncompressedSize;
        if (entry.uncompressedSize > 32 * 1024 * 1024 || total > 96 * 1024 * 1024) {
          return fail('Office 檔案解壓縮後超過大小限制');
        }
        if (names.has(entry.fileName) || (entry.generalPurposeBitFlag & 1)) {
          return fail('Office 檔案的內部項目重複或受密碼保護');
        }
        names.add(entry.fileName);
        found ||= entry.fileName === expected;
        zip.readEntry();
      });
      zip.on('end', () => {
        if (found && names.has('[Content_Types].xml')) resolve();
        else reject(new Error('副檔名與檔案的 Office 格式不符'));
      });
      zip.readEntry();
    });
  });
}

function pipeFile(executable, args, bytes, timeout) {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(bytes);
  });
}

async function pdfText(bytes, start, count) {
  let output;
  try {
    output = await pipeFile(process.env.CHAT_PDFTOTEXT || 'pdftotext', [
      '-f', String(start), '-l', String(start + count - 1), '-layout', '-enc', 'UTF-8', '-', '-',
    ], bytes, 12000);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Mac 找不到 pdftotext，請安裝 Poppler 或設定 CHAT_PDFTOTEXT');
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error.killed) throw new Error('讀取的 PDF 頁面過多，請縮小範圍');
    throw new Error('無法讀取這段 PDF 頁面，請檢查頁碼、檔案格式或密碼設定');
  }
  const pages = output.split('\f');
  if (!pages.at(-1)?.trim() && pages.length > 1) pages.pop();
  const scanned = pages.flatMap((page, index) => page.trim() ? [] : [start + index]);
  const ocr = [];
  if (scanned.length && process.platform === 'darwin') {
    try {
      const found = JSON.parse(await pipeFile('/usr/bin/swift', [ocrScript, ...scanned.slice(0, 8).map(String)], bytes, 45000));
      for (const [page, value] of Object.entries(found)) {
        if (value.trim()) {
          pages[Number(page) - start] = value;
          ocr.push(Number(page));
        }
      }
    } catch {
      // Text on other pages is still available if the host cannot run Vision.
    }
  }
  return { text: pages.join('\f'), ocr, scanned };
}

async function wordBlocks(bytes) {
  const result = await mammoth.convertToHtml({ buffer: bytes }, {
    convertImage: mammoth.images.imgElement(async () => ({})),
  });
  const getText = (node) => DomUtils.textContent(node).trim();
  const blocks = [];
  function visit(nodes) {
    for (const node of nodes) {
      if (node.type !== 'tag') continue;
      if (node.name === 'table') {
        const rows = DomUtils.findAll((item) => item.name === 'tr', node.children);
        blocks.push(...rows.map((row) => row.children
          .filter((cell) => cell.name === 'td' || cell.name === 'th')
          .map((cell) => getText(cell).replace(/\s+/g, ' ')).join('\t')).filter(Boolean));
      } else if (/^(p|li|h[1-6])$/.test(node.name)) {
        const value = getText(node);
        if (value) blocks.push(value);
      } else {
        visit(node.children || []);
      }
    }
  }
  visit(parseDocument(result.value).children);
  return blocks;
}

function selection(value, fallback, max) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('讀取範圍超過限制');
  return value;
}

function readCell(cell) {
  if (!cell) return '';
  if (cell.formula) {
    const result = cell.result instanceof Date ? cell.result.toISOString() : cell.result?.error || cell.result;
    return result == null ? '=' + cell.formula : `=${cell.formula} → ${result}`;
  }
  if (cell.value instanceof Date) return cell.value.toISOString();
  return cell.text;
}

export async function readDocument(name, bytes, options = {}) {
  await validateDocument(name, bytes);
  const sourceExtension = extension(name);
  const legacy = legacyOffice[sourceExtension];
  const ext = legacy?.extension ?? sourceExtension;
  if (legacy) {
    bytes = await convertLegacyOffice(sourceExtension, bytes, documentLimit);
    await validateDocument('converted' + ext, bytes);
  }
  const start = selection(options.start, 1, 1048576);
  const count = selection(options.count, ext === '.xlsx' ? 30 : ext === '.docx' ? 80 : 8, ext === '.docx' ? 200 : 100);
  const result = { format: sourceExtension.slice(1), start };
  let contents;
  if (ext === '.pdf') {
    const pdf = await pdfText(bytes, start, count);
    contents = pdf.text;
    if (pdf.ocr.length) result.ocrPages = pdf.ocr;
    if (pdf.scanned.length > pdf.ocr.length) result.note = '有些 PDF 頁面沒有可擷取的文字。若頁面包含掃描文字，請縮小頁面範圍或提供更清楚的檔案。';
  } else if (ext === '.docx') {
    const paragraphs = await wordBlocks(bytes);
    result.total = paragraphs.length;
    contents = paragraphs.slice(start - 1, start + count - 1).join('\n\n');
  } else {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    const sheet = options.sheet ? workbook.getWorksheet(options.sheet) : workbook.worksheets[0];
    if (!sheet) throw new Error('找不到指定工作表');
    const column = selection(options.column, 1, 16384);
    result.sheets = workbook.worksheets.map((item) => ({ name: item.name, rows: item.rowCount, columns: item.columnCount }));
    result.sheet = sheet.name;
    result.total = sheet.rowCount;
    result.column = column;
    const rows = [];
    const grid = [];
    let length = 0;
    for (let index = start; index <= Math.min(sheet.rowCount, start + count - 1); index += 1) {
      const row = sheet.findRow(index);
      const cells = [];
      for (let col = column; col <= Math.min(sheet.columnCount, column + 39); col += 1) {
        const text = readCell(row?.findCell(col)).slice(0, 2000);
        cells.push(text.replace(/\r?\n/g, ' ↵ ').replaceAll('\t', ' '));
      }
      const line = index + '\t' + cells.join('\t');
      length += line.length;
      if (options.grid && length <= outputLimit) grid.push({ row: index, cells });
      rows.push(line);
      if (length > outputLimit) break;
    }
    contents = rows.join('\n');
    if (options.grid) {
      result.grid = grid;
      result.partial = start + grid.length - 1 < sheet.rowCount || column + 39 < sheet.columnCount;
    }
  }
  result.truncated = contents.length > outputLimit;
  result.text = contents.slice(0, outputLimit).replaceAll('\f', '\n\n').trim();
  return result;
}

function text(value, label, max = 60000) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error(label + '格式或長度不符');
  return value;
}

function workbookValue(value) {
  if (value == null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string') return text(value, '儲存格內容', 32767);
  if (typeof value !== 'object' || typeof value.formula !== 'string') throw new Error('Excel 儲存格格式不支援');
  const formula = text(value.formula.replace(/^=/, ''), '公式', 8192);
  if (!formula || /[\[\]|]|\b(?:WEBSERVICE|HYPERLINK|RTD)\s*\(/i.test(formula)) throw new Error('請使用工作簿內的公式');
  const result = value.result == null ? undefined : value.result;
  if (result !== undefined && typeof result !== 'string' && typeof result !== 'boolean' &&
    !(typeof result === 'number' && Number.isFinite(result))) throw new Error('公式快取值格式不支援');
  return { formula, ...(result === undefined ? {} : { result }) };
}

async function makeWorkbook(spec) {
  const workbook = new ExcelJS.Workbook();
  workbook.calcProperties.fullCalcOnLoad = true;
  const { sheets } = spec;
  if (!Array.isArray(sheets) || !sheets.length || sheets.length > 20) throw new Error('請提供 1 到 20 個工作表');
  let rowsWritten = 0;
  for (const sheetSpec of sheets) {
    if (!sheetSpec || typeof sheetSpec !== 'object') throw new Error('工作表格式不支援');
    const { name, rows, header } = sheetSpec;
    if (!Array.isArray(rows)) throw new Error('請提供工作表的列資料');
    rowsWritten += rows.length;
    if (rowsWritten > 4000) throw new Error('工作簿最多可輸出 4000 列');
    const label = text(name, '工作表名稱', 31).trim();
    if (!label || /[:\\/?*\[\]]/.test(label) || workbook.worksheets.some((sheet) => sheet.name.toLowerCase() === label.toLowerCase())) {
      throw new Error('工作表名稱重複或包含不支援的符號');
    }
    const sheet = workbook.addWorksheet(label);
    const widths = [];
    for (const values of rows) {
      if (!Array.isArray(values) || values.length > 80) throw new Error('每列最多可輸出 80 欄');
      const row = sheet.addRow(values.map(workbookValue));
      row.eachCell((cell, index) => {
        const characters = Array.from(cell.text);
        const length = characters.reduce((sum, char) => sum + (char.codePointAt(0) > 0xff ? 2 : 1), 0);
        widths[index] = Math.max(widths[index] || 10, Math.min(42, length + 3));
      });
    }
    for (let col = 1; col < widths.length; col += 1) sheet.getColumn(col).width = widths[col] || 10;
    if (header === true && sheet.rowCount && sheet.columnCount) {
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      sheet.getRow(1).eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FF252525' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E6E6' } };
      });
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function blocksFor(spec) {
  const title = text(spec.title || '', '標題', 240);
  const blocks = spec.blocks ?? (typeof spec.text === 'string' ? spec.text.split(/\n{2,}/).map((value) => ({ type: 'paragraph', text: value })) : []);
  if (!Array.isArray(blocks) || !blocks.length && !title || blocks.length > 250) throw new Error('請提供標題或文件段落');
  return { title, blocks: blocks.map((block) => {
    if (['heading', 'paragraph'].includes(block?.type)) return { type: block.type, text: text(block.text, '段落') };
    if (block?.type !== 'table' || !Array.isArray(block.rows) || !block.rows.length || block.rows.length > 100) throw new Error('文件區塊格式不支援');
    const columns = block.rows[0]?.length;
    if (!columns || columns > 8 || block.rows.some((row) => !Array.isArray(row) || row.length !== columns)) {
      throw new Error('文件表格須維持固定欄數，每列最多八欄');
    }
    return { type: 'table', rows: block.rows.map((row) => row.map((cell) => text(String(cell ?? ''), '文件表格內容', 1000))), header: block.header === true };
  }) };
}

async function makeWord(spec) {
  const { title, blocks } = blocksFor(spec);
  const paragraph = (value, heading) => new Paragraph({
    heading,
    children: [new TextRun({
      text: value,
      color: '262626',
      font: { ascii: 'Aptos', hAnsi: 'Aptos', eastAsia: 'Noto Sans CJK TC', hint: 'eastAsia' },
      language: { eastAsia: 'zh-TW' },
    })],
  });
  const children = title ? [paragraph(title, HeadingLevel.TITLE)] : [];
  for (const block of blocks) {
    if (block.type === 'table') {
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: block.rows.map((row, index) => new TableRow({
        tableHeader: index === 0 && block.header,
        children: row.map((value) => new TableCell({ children: [paragraph(value)], shading: index === 0 && block.header ? { fill: 'E6E6E6' } : undefined })),
      })) }));
    } else {
      for (const line of block.text.split('\n')) children.push(paragraph(line, block.type === 'heading' ? HeadingLevel.HEADING_1 : undefined));
    }
  }
  return Packer.toBuffer(new Document({ title, sections: [{ children }] }));
}

function makePDF(spec) {
  const { title, blocks } = blocksFor(spec);
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 56, info: { Title: title }, autoFirstPage: false });
    const chunks = [];
    pdf.on('data', (chunk) => chunks.push(chunk));
    pdf.on('error', reject);
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.registerFont('body', process.env.CHAT_PDF_FONT || '/System/Library/Fonts/STHeiti Light.ttc',
      process.env.CHAT_PDF_FONT_FACE || (process.env.CHAT_PDF_FONT ? undefined : 'STHeitiTC-Light'));
    pdf.addPage().font('body').fillColor('#292929');
    if (title) pdf.fontSize(24).text(title, { lineGap: 4 }).moveDown(.8);
    for (const block of blocks) {
      if (block.type === 'table') {
        pdf.fontSize(10).table({
          defaultStyle: { padding: 6, border: .5, borderColor: '#a0a0a0' },
          rowStyles: (index) => index === 0 && block.header ? { backgroundColor: '#e6e6e6' } : {},
          data: block.rows,
        }).moveDown(.9);
      } else {
        pdf.fontSize(block.type === 'heading' ? 16 : 11).text(block.text, { lineGap: 4 }).moveDown(.55);
      }
    }
    pdf.end();
  });
}

export async function makeDocument(name, contents) {
  let spec;
  try {
    spec = JSON.parse(text(contents, '文件內容', 512 * 1024));
    if (!spec || Array.isArray(spec) || typeof spec !== 'object') throw new Error();
  } catch { throw new Error('請提供有效的文件結構 JSON'); }
  const ext = extension(name);
  if (ext === '.xlsx') return makeWorkbook(spec);
  if (ext === '.docx') return makeWord(spec);
  if (ext === '.pdf') return makePDF(spec);
  throw new Error('不支援的文件格式');
}
