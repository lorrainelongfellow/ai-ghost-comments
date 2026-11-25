const { createHash } = require('node:crypto');
const vscode = require('vscode');

const MAX_BATCH_LINES = 80;
const MAX_BATCH_SOURCE_LENGTH = 16_000;
const FUNCTION_KINDS = new Set([
  vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor
]);

async function findFunctions(document) {
  const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri)
    .then(result => result ?? [], () => []);
  const ranges = [];
  const pending = [...symbols];
  while (pending.length > 0) {
    const symbol = pending.pop();
    if (symbol.children) pending.push(...symbol.children);
    if (!FUNCTION_KINDS.has(symbol.kind)) continue;
    if (symbol.location && symbol.location.uri.toString() !== document.uri.toString()) continue;

    const reportedRange = symbol.range ?? symbol.location?.range;
    if (!reportedRange) continue;
    const range = document.validateRange(reportedRange);
    if (!range.isEmpty) ranges.push(range);
  }
  return ranges.sort((a, b) => a.start.compareTo(b.start) || b.end.compareTo(a.end));
}

function enclosingFunction(functions, position) {
  let enclosing;
  for (const range of functions) {
    if (range.start.isAfter(position)) break;
    if (range.contains(position) && (!enclosing || enclosing.contains(range))) enclosing = range;
  }
  return enclosing;
}

function sourceLines(document, range) {
  const lines = [];
  const first = range?.start.line ?? 0;
  const last = range?.end.line ?? document.lineCount - 1;
  for (let index = first; index <= last; index++) {
    const row = document.lineAt(index).text;
    const start = index === range?.start.line ? range.start.character : 0;
    const end = index === range?.end.line ? range.end.character : row.length;
    const text = row.slice(start, end);
    if (text.trim()) lines.push({ line: index + 1, text });
  }
  return lines;
}

function fileSections(lines, functions) {
  const spans = [];
  for (const range of functions) {
    const first = range.start.line + 1;
    const last = range.end.line + (range.end.character > 0 ? 1 : 0);
    const previous = spans.at(-1);
    if (previous && first <= previous.last) {
      previous.last = Math.max(previous.last, last);
    } else {
      spans.push({ first, last });
    }
  }

  const sections = [];
  let section;
  let spanIndex = 0;
  let previousSpan;
  let previousLine = 0;
  for (const line of lines) {
    while (spans[spanIndex]?.last < line.line) spanIndex++;
    const span = spans[spanIndex]?.first <= line.line ? spans[spanIndex] : undefined;
    if (!section || span !== previousSpan || (!span && line.line > previousLine + 1)) {
      section = [];
      sections.push(section);
    }
    section.push(line);
    previousSpan = span;
    previousLine = line.line;
  }
  return sections;
}

function pack(items, getLines) {
  const batches = [];
  let batch = [];
  let lineCount = 0;
  let sourceLength = 0;
  for (const item of items) {
    const lines = getLines(item);
    const length = lines.reduce((total, line) => total + line.text.length, 0);
    if (batch.length > 0 && (
      lineCount + lines.length > MAX_BATCH_LINES || sourceLength + length > MAX_BATCH_SOURCE_LENGTH
    )) {
      batches.push(batch);
      batch = [];
      lineCount = 0;
      sourceLength = 0;
    }
    batch.push(item);
    lineCount += lines.length;
    sourceLength += length;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function lineBatches(lines) {
  return pack(lines, line => [line]);
}

function annotationParts(sections) {
  return sections.flatMap(lines => {
    if (lines.length === 0) return [];

    const signature = JSON.stringify(lines.map(line => [line.line - lines[0].line, line.text]));
    const id = createHash('sha256').update(signature).digest('hex').slice(0, 40);
    return lineBatches(lines).map((batch, index) => ({ id: id + '-' + index, lines: batch }));
  });
}

function requestBatches(parts, firstVisibleLine) {
  const batches = pack(parts, part => part.missing);
  const first = batches.findIndex(batch => batch.at(-1).missing.at(-1).line >= firstVisibleLine);
  if (first > 0) batches.unshift(...batches.splice(first, 1));
  return batches;
}

module.exports = { findFunctions, enclosingFunction, sourceLines, fileSections, lineBatches, annotationParts, requestBatches };
