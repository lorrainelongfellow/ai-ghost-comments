const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function fileCacheId(document) {
  return createHash('sha256').update(document.uri.toString()).digest('hex');
}

function fileCacheDirectory(storageDirectory, document) {
  return path.join(storageDirectory, 'annotation-cache-v1', fileCacheId(document));
}

async function hasCache(storageDirectory, document) {
  try {
    await fs.access(fileCacheDirectory(storageDirectory, document));
    return true;
  } catch {
    return false;
  }
}

function createCache(storageDirectory, document, request) {
  const configuration = JSON.stringify([document.languageId, request.cliPath, request.model]);
  const configurationId = createHash('sha256').update(configuration).digest('hex').slice(0, 24);
  const key = createHash('sha256')
    .update(configuration)
    .update('\0')
    .update(document.getText())
    .digest('hex');
  const legacyDirectory = fileCacheDirectory(storageDirectory, document);
  const directory = path.join(legacyDirectory, 'models', configurationId);
  return { directory, legacyDirectory, key };
}

function batchPath(directory, lines) {
  return path.join(directory, String(lines[0].line) + '.json');
}

function partPath(cache, part) {
  return path.join(cache.directory, 'parts', part.id + '.json');
}

async function readEntry(directory, key, lines) {
  try {
    const entry = JSON.parse(await fs.readFile(batchPath(directory, lines), 'utf8'));
    if (entry?.key !== key || entry.lastLine !== lines[lines.length - 1].line ||
        !Array.isArray(entry.annotations)) return undefined;

    const lineNumbers = new Set(lines.map(line => line.line));
    for (const note of entry.annotations) {
      if (typeof note?.text !== 'string' || !lineNumbers.delete(note.line)) return undefined;
    }
    return entry.annotations;
  } catch {
    return undefined;
  }
}

async function readBatch(cache, lines) {
  const current = await readEntry(cache.directory, cache.key, lines);
  return current ?? readEntry(cache.legacyDirectory, cache.key, lines);
}

async function readPart(cache, part) {
  try {
    const data = JSON.parse(await fs.readFile(partPath(cache, part), 'utf8'));
    const entries = Array.isArray(data) ? data : data?.annotations;
    const pendingIndexes = Array.isArray(data) ? [] : data?.pending;
    if (!Array.isArray(entries) || !Array.isArray(pendingIndexes)) return undefined;

    const pending = new Set();
    for (const index of pendingIndexes) {
      if (!Number.isInteger(index) || !part.lines[index] || pending.has(part.lines[index].line)) return undefined;
      pending.add(part.lines[index].line);
    }
    const seen = new Set();
    const annotations = [];
    for (const entry of entries) {
      if (!Number.isInteger(entry?.index) || typeof entry.text !== 'string' ||
          !part.lines[entry.index] || seen.has(entry.index) || pending.has(part.lines[entry.index].line)) return undefined;

      seen.add(entry.index);
      annotations.push({ line: part.lines[entry.index].line, text: entry.text, important: entry.important });
    }
    return { annotations, pending };
  } catch {
    return undefined;
  }
}

async function writeEntry(filename, value, signal) {
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    if (signal?.aborted) return;

    await fs.writeFile(temporary, JSON.stringify(value), 'utf8');
    if (!signal?.aborted) await fs.rename(temporary, filename);
  } catch {
    // Display and generation can still work when local storage is unavailable.
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function writePart(cache, part, annotations, signal, remaining = []) {
  const entries = [];
  const remainingLines = new Set(remaining.map(line => line.line));
  const pending = [];
  for (const [index, line] of part.lines.entries()) {
    if (remainingLines.has(line.line)) {
      pending.push(index);
    } else {
      const note = annotations.get(line.line);
      if (note) entries.push({ index, text: note.text, important: note.important });
    }
  }
  return writeEntry(partPath(cache, part), pending.length ? { pending, annotations: entries } : entries, signal);
}

function visibilityPath(storageDirectory, document) {
  return path.join(fileCacheDirectory(storageDirectory, document), 'visibility.json');
}

async function readVisibility(storageDirectory, document) {
  try {
    const visible = JSON.parse(await fs.readFile(visibilityPath(storageDirectory, document), 'utf8'));
    if (typeof visible === 'boolean') return visible;
  } catch {
    // There is no saved visibility for older cache entries.
  }
  return undefined;
}

function writeVisibility(storageDirectory, document, visible) {
  return writeEntry(visibilityPath(storageDirectory, document), visible);
}

module.exports = { fileCacheId, hasCache, createCache, readBatch, readPart, writePart, readVisibility, writeVisibility };
