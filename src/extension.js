const path = require('node:path');
const vscode = require('vscode');

const {
  fileCacheId, hasCache, createCache, readBatch, readPart, writePart, readVisibility, writeVisibility
} = require('./cache');
const {
  findFunctions, enclosingFunction, sourceLines, fileSections, lineBatches, annotationParts, requestBatches
} = require('./source');
const { DEFINITION_COMMAND, makeDecoration, openDefinition } = require('./annotations');
const { requestAnnotations, listModels } = require('./gemini');
const { SETTINGS_VIEW_ID, SettingsView } = require('./settings-view');

const SETTINGS = 'aiGhostComments';
const SCOPE_LABELS = { file: '全文', function: '当前函数', selection: '选区' };

function activate(context) {
  const states = new Map();
  const pendingVisibility = new Map();
  const functionLookups = new WeakMap();
  const pendingScopes = new WeakMap();
  const decoration = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      margin: '0 0 0 1.2em'
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  const storageDirectory = context.globalStorageUri.fsPath;
  const cliDirectory = path.join(storageDirectory, 'antigravity');
  const configuration = () => vscode.workspace.getConfiguration(SETTINGS);
  const settingsView = new SettingsView(context.extensionUri, cliDirectory, configuration, currentFile);
  let hasSelection = vscode.window.activeTextEditor?.selection.isEmpty === false;

  function decorationsFor(state) {
    if (!state) return [];

    const onlyImportant = configuration().get('density', 'all') === 'key';
    const decorations = [];
    for (const note of state.decorations.values()) {
      if (!onlyImportant || note.important) decorations.push(note.options);
    }
    return decorations;
  }

  function currentFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const { document } = editor;
    const state = states.get(document);
    return {
      name: path.basename(document.fileName),
      visible: state?.visible ?? false,
      running: Boolean(state?.controller && state.generateRequested),
      preparing: Boolean(state?.refreshTimer || (state?.controller && !state.ready)),
      failed: state?.failed ?? false,
      hasSelection: !editor.selection.isEmpty,
      scope: SCOPE_LABELS[state?.scope ?? 'file'],
      scoped: Boolean(state && state.scope !== 'file'),
      annotationCount: decorationsFor(state).length,
      hasAnnotations: Boolean(state?.decorations.size),
      canComplete: Boolean(state?.ready && !state.controller &&
        ((state.failed && state.pendingBatches.length > 0) ||
          (state.visible && (state.scope !== 'file' || state.pendingBatches.length > 0)))),
      totalBatches: state?.totalBatches ?? 0,
      finishedBatches: state ? state.totalBatches - state.pendingBatches.length : 0
    };
  }

  function render(document) {
    const state = states.get(document);
    const decorations = state?.visible ? decorationsFor(state) : [];
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === document) editor.setDecorations(decoration, decorations);
    }
    settingsView.update();
  }

  function clear(document, updateEditors = true) {
    pendingScopes.delete(document);
    const state = states.get(document);
    if (!state) return;

    states.delete(document);
    clearTimeout(state.refreshTimer);
    state.controller?.abort();
    if (updateEditors && state.visible) render(document);
    else settingsView.update();
  }

  function rememberVisibility(document, visible) {
    const key = fileCacheId(document);
    const previous = pendingVisibility.get(key);
    const write = Promise.resolve(previous?.write)
      .then(() => writeVisibility(storageDirectory, document, visible));
    const pending = { visible, write };
    pendingVisibility.set(key, pending);
    return write.finally(() => {
      if (pendingVisibility.get(key) === pending) pendingVisibility.delete(key);
    });
  }

  function createState(editor, scope, range, loadCache = true) {
    const document = editor.document;
    const settings = configuration();
    const request = {
      cliPath: settings.get('cliPath', ''),
      model: settings.get('model', ''),
      cwd: cliDirectory,
      language: document.languageId
    };
    const state = {
      documentId: fileCacheId(document),
      version: document.version,
      scope,
      range,
      totalBatches: 0,
      pendingBatches: [],
      ready: false,
      visible: false,
      generateRequested: false,
      decorations: new Map(),
      request,
      loadCache
    };
    states.set(document, state);
    return state;
  }

  async function restore(editor) {
    if (!configuration().get('autoRestore', true)) return;

    const document = editor.document;
    if (states.has(document)) return;

    const key = fileCacheId(document);
    const version = document.version;
    const [exists, savedVisibility] = await Promise.all([
      hasCache(storageDirectory, document),
      readVisibility(storageDirectory, document)
    ]);
    const visible = pendingVisibility.get(key)?.visible ?? savedVisibility;
    if (!exists || visible === false || !configuration().get('autoRestore', true)) return;

    const currentEditor = vscode.window.visibleTextEditors.find(view => view.document === document);
    if (!currentEditor || document.isClosed || document.version !== version || states.has(document)) return;

    const state = createState(currentEditor, 'file');
    await fill(currentEditor, state, true);
  }

  function refreshVisible(visibleEditors) {
    for (const editor of visibleEditors) {
      const state = states.get(editor.document);
      editor.setDecorations(decoration, state?.visible ? decorationsFor(state) : []);
      if (!state) void restore(editor);
    }
    settingsView.update();
  }

  async function functionsFor(document) {
    const previous = functionLookups.get(document);
    if (previous?.version === document.version) return previous.result;

    const lookup = { version: document.version, result: findFunctions(document) };
    functionLookups.set(document, lookup);
    const ranges = await lookup.result;
    if (ranges.length === 0 && functionLookups.get(document) === lookup) functionLookups.delete(document);
    return ranges;
  }

  async function prepare(editor, state, isCurrent, signal) {
    const { document } = editor;
    const functions = state.scope === 'file' ? await functionsFor(document) : [];
    if (!isCurrent()) return;

    const lines = sourceLines(document, state.range);
    const sections = state.scope === 'file' ? fileSections(lines, functions) : [lines];
    const parts = annotationParts(sections);
    state.cache = createCache(storageDirectory, document, state.request);
    const hits = state.loadCache
      ? await Promise.all(parts.map(part => readPart(state.cache, part)))
      : [];
    if (!isCurrent()) return;

    // The older cache used line numbers and a whole-file digest. Promote any covered
    // source lines before generating missing lines so an upgrade can resume a partial file.
    const legacy = new Map();
    if (state.loadCache && hits.some(hit => !hit || hit.pending.size > 0)) {
      const batches = lineBatches(state.range ? sourceLines(document) : lines);
      const previous = await Promise.all(batches.map(batch => readBatch(state.cache, batch)));
      if (!isCurrent()) return;

      for (const [index, annotations] of previous.entries()) {
        if (annotations === undefined) continue;
        const byLine = new Map(annotations.map(note => [note.line, note]));
        for (const line of batches[index]) {
          legacy.set(line.line, { text: line.text, note: byLine.get(line.line) });
        }
      }
    }

    const missing = [];
    const promotions = [];
    for (const [index, part] of parts.entries()) {
      const hit = hits[index];
      const cached = new Map(hit?.annotations.map(note => [note.line, note]));
      const remaining = part.lines.filter(line => {
        if (hit && !hit.pending.has(line.line)) return false;
        const saved = legacy.get(line.line);
        if (saved?.text !== line.text) return true;
        if (saved.note) cached.set(line.line, saved.note);
        return false;
      });
      addNotes(document, state, cached.values());
      if (remaining.length > 0) {
        missing.push({ part, missing: remaining, cached });
      } else if (!hit || hit.pending.size > 0) {
        promotions.push(writePart(state.cache, part, cached, signal));
      }
    }
    state.pendingBatches = requestBatches(missing, (editor.visibleRanges[0]?.start.line ?? 0) + 1);
    state.totalBatches = state.pendingBatches.length;
    state.ready = true;
    await Promise.all(promotions);
  }

  function addNotes(document, state, notes) {
    for (const note of notes) state.decorations.set(note.line, makeDecoration(document, state.documentId, note));
  }

  async function selectModel() {
    const settings = vscode.workspace.getConfiguration(SETTINGS);
    const current = settings.get('model', '');
    try {
      const models = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title: '正在读取 Antigravity 模型'
      }, () => listModels(settings.get('cliPath', ''), cliDirectory));

      const options = [{
        label: '沿用 Antigravity 当前模型',
        description: current === '' ? '当前设置' : undefined,
        model: ''
      }];
      for (const { id, label } of models) {
        const description = [];
        if (id === current) description.push('当前设置');
        if (id === 'gemini-4-neon-xhigh') description.push('复杂代码推荐');
        options.push({ label, description: description.join(' · '), detail: id, model: id });
      }

      const picked = await vscode.window.showQuickPick(options, {
        placeHolder: '选择用于生成幽灵注释的模型',
        matchOnDetail: true
      });
      if (!picked || picked.model === current) return;

      await settings.update('model', picked.model, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage('AI 幽灵注释已选用 ' + picked.label + '。');
    } catch (error) {
      void vscode.window.showErrorMessage('AI 幽灵注释无法选择模型。' + error.message);
    }
  }

  async function fill(editor, state, startupRestore = false) {
    if (state.controller || (state.ready && state.pendingBatches.length === 0)) return;

    clearTimeout(state.refreshTimer);
    state.refreshTimer = undefined;
    const { document } = editor;
    const controller = new AbortController();
    state.controller = controller;
    settingsView.update();
    const isCurrent = () => states.get(document) === state &&
      state.controller === controller && document.version === state.version;
    const release = () => {
      if (state.controller === controller) {
        state.controller = undefined;
        settingsView.update();
      }
    };

    try {
      if (!state.ready) {
        await prepare(editor, state, isCurrent, controller.signal);
        if (!isCurrent()) return;

        if (startupRestore && !state.generateRequested) {
          state.visible = configuration().get('autoRestore', true) && state.decorations.size > 0;
        }
        if (state.visible) render(document);
      }
      if (!state.generateRequested || !state.visible || state.pendingBatches.length === 0) return;

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title: '正在生成 AI 幽灵注释 · ' + SCOPE_LABELS[state.scope]
      }, async progress => {
        try {
          while (state.visible && state.pendingBatches.length > 0 && isCurrent()) {
            const batchNumber = state.totalBatches - state.pendingBatches.length + 1;
            const batchLabel = '第 ' + batchNumber + '/' + state.totalBatches + ' 批';
            progress.report({ message: batchLabel });
            const batch = state.pendingBatches[0].filter(work => work.missing.length > 0);
            await requestAnnotations({
              ...state.request,
              lines: batch.flatMap(work => work.missing),
              blocks: batch.map(work => [work.missing[0].line, work.missing.at(-1).line]),
              signal: controller.signal,
              shouldContinue: () => isCurrent() && state.visible,
              onRetry: () => progress.report({ message: batchLabel + ' · 正在重试返回异常的批次' }),
              onResult: async (lines, annotations) => {
                if (!isCurrent()) return false;

                const covered = new Set(lines.map(line => line.line));
                const byLine = new Map(annotations.map(note => [note.line, note]));
                const writes = [];
                for (const work of batch) {
                  const remaining = work.missing.filter(line => {
                    if (!covered.has(line.line)) return true;
                    const note = byLine.get(line.line);
                    if (note) work.cached.set(line.line, note);
                    return false;
                  });
                  if (remaining.length === work.missing.length) continue;

                  work.missing = remaining;
                  writes.push(writePart(state.cache, work.part, work.cached, controller.signal, remaining));
                }
                addNotes(document, state, annotations);
                if (state.visible) render(document);
                else settingsView.update();
                await Promise.all(writes);
                return isCurrent() && state.visible;
              }
            });
            if (!isCurrent()) return;
            if (batch.every(work => work.missing.length === 0)) state.pendingBatches.shift();
          }
        } finally {
          // Release before yielding so a subsequent show can resume any remaining batches.
          release();
        }
      });
    } catch (error) {
      if (states.get(document) !== state || controller.signal.aborted || !state.visible) return;
      if (state.controller && state.controller !== controller) return;

      state.failed = state.pendingBatches.length > 0;
      state.visible = state.decorations.size > 0;
      render(document);
      const completed = state.totalBatches - state.pendingBatches.length;
      void vscode.window.showErrorMessage(
        'AI 幽灵注释已完成 ' + completed + '/' + state.totalBatches + ' 批。' + error.message
      );
    } finally {
      release();
    }
  }

  async function show(editor, state) {
    const document = editor.document;
    state.failed = false;
    state.visible = true;
    state.generateRequested = true;
    render(document);
    await Promise.all([
      state.scope === 'file' ? rememberVisibility(document, true) : undefined,
      fill(editor, state)
    ]);

    if (states.get(document) === state && state.visible && state.ready && !state.controller &&
        state.pendingBatches.length === 0 && state.decorations.size === 0) {
      state.visible = false;
      settingsView.update();
      void vscode.window.showInformationMessage('当前范围没有可显示的注释。');
    }
  }

  async function toggle(regenerate = false) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const { document } = editor;
    pendingScopes.delete(document);
    let state = states.get(document);
    if (!regenerate && state?.visible && state.version === document.version) {
      state.visible = false;
      render(document);
      await rememberVisibility(document, false);
      return;
    }

    if (regenerate || state?.scope !== 'file' || state.version !== document.version) {
      clear(document);
      state = createState(editor, 'file', undefined, !regenerate);
    }
    await show(editor, state);
  }

  async function annotateScope(scope) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const { document } = editor;
    pendingScopes.delete(document);
    let range = editor.selection;
    if (scope === 'function') {
      const request = { version: document.version, position: range.active };
      pendingScopes.set(document, request);
      const functions = await functionsFor(document);
      if (pendingScopes.get(document) !== request) return;

      pendingScopes.delete(document);
      if (document.version !== request.version || vscode.window.activeTextEditor !== editor) return;
      range = enclosingFunction(functions, request.position);
      if (!range) {
        void vscode.window.showInformationMessage('VS Code 未识别到光标所在的函数。可先选中代码，再使用「注释选区」。');
        return;
      }
    }
    if (range.isEmpty) {
      void vscode.window.showInformationMessage('请先在编辑器里选中要注释的代码。');
      return;
    }

    clear(document);
    await show(editor, createState(editor, scope, range));
  }

  async function complete() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    pendingScopes.delete(editor.document);
    let state = states.get(editor.document);
    if (!state || (!state.visible && !state.failed)) return;

    if (state.scope !== 'file' && !state.failed) {
      clear(editor.document);
      state = createState(editor, 'file');
    }
    await show(editor, state);
  }

  function onContentChange({ document, contentChanges }) {
    if (contentChanges.length === 0) return;

    const previous = states.get(document);
    clear(document);
    if (previous?.scope !== 'file' || !previous.visible) return;

    const editor = vscode.window.visibleTextEditors.find(view => view.document === document);
    if (!editor) return;

    const state = createState(editor, 'file');
    state.visible = true;
    state.refreshTimer = setTimeout(() => void fill(editor, state), 250);
    settingsView.update();
  }

  context.subscriptions.push(
    decoration,
    vscode.commands.registerCommand(SETTINGS + '.toggle', () => toggle()),
    vscode.commands.registerCommand(SETTINGS + '.regenerate', () => toggle(true)),
    vscode.commands.registerCommand(SETTINGS + '.annotateFunction', () => annotateScope('function')),
    vscode.commands.registerCommand(SETTINGS + '.annotateSelection', () => annotateScope('selection')),
    vscode.commands.registerCommand(SETTINGS + '.complete', complete),
    vscode.commands.registerCommand(DEFINITION_COMMAND, (documentId, version, line, character, name) => {
      const editor = vscode.window.visibleTextEditors.find(view => states.get(view.document)?.documentId === documentId);
      const state = editor && states.get(editor.document);
      if (state?.visible && state.decorations.has(line + 1)) {
        return openDefinition(editor.document, version, line, character, name);
      }
    }),
    vscode.commands.registerCommand(SETTINGS + '.selectModel', selectModel),
    vscode.commands.registerCommand(SETTINGS + '.openSettings', () =>
      vscode.commands.executeCommand(SETTINGS_VIEW_ID + '.focus')),
    vscode.window.registerWebviewViewProvider(SETTINGS_VIEW_ID, settingsView),
    vscode.workspace.onDidChangeTextDocument(onContentChange),
    vscode.workspace.onDidCloseTextDocument(document => clear(document, false)),
    vscode.window.onDidChangeVisibleTextEditors(refreshVisible),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      hasSelection = editor?.selection.isEmpty === false;
      settingsView.update();
    }),
    vscode.window.onDidChangeTextEditorSelection(event => {
      const selected = !event.textEditor.selection.isEmpty;
      if (event.textEditor === vscode.window.activeTextEditor && selected !== hasSelection) {
        hasSelection = selected;
        settingsView.update();
      }
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration(SETTINGS)) return;

      const cliChanged = event.affectsConfiguration(SETTINGS + '.cliPath');
      if (cliChanged || event.affectsConfiguration(SETTINGS + '.model')) {
        for (const document of states.keys()) clear(document);
        refreshVisible(vscode.window.visibleTextEditors);
      } else if (event.affectsConfiguration(SETTINGS + '.density') || configuration().get('autoRestore', true)) {
        refreshVisible(vscode.window.visibleTextEditors);
      }
      settingsView.update();
      if (cliChanged) void settingsView.refreshModels();
    }),
    new vscode.Disposable(() => {
      for (const document of states.keys()) clear(document, false);
    })
  );
  refreshVisible(vscode.window.visibleTextEditors);
}

module.exports = { activate };
