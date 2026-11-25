const fs = require('node:fs');
const vscode = require('vscode');
const { listModels, resolveCli } = require('./gemini');

const SETTINGS_VIEW_ID = 'aiGhostComments.settings';

class SettingsView {
  constructor(extensionUri, cliDirectory, configuration, currentFile) {
    this.media = vscode.Uri.joinPath(extensionUri, 'media');
    this.cliDirectory = cliDirectory;
    this.configuration = configuration;
    this.currentFile = currentFile;
    this.shortcut = process.platform === 'darwin' ? '⌘ ⌥ G' : 'Alt + G';
  }

  resolveWebviewView(view) {
    this.view = view;
    this.ready = false;
    const webview = view.webview;
    webview.options = { enableScripts: true, localResourceRoots: [this.media] };

    const subscription = webview.onDidReceiveMessage(message => {
      if (this.view === view) void this.receive(view, message);
    });
    view.onDidDispose(() => {
      subscription.dispose();
      if (this.view === view) {
        this.view = undefined;
        this.ready = false;
      }
    });

    const resource = name => webview.asWebviewUri(vscode.Uri.joinPath(this.media, name)).toString();
    webview.html = fs.readFileSync(vscode.Uri.joinPath(this.media, 'settings.html').fsPath, 'utf8')
      .replaceAll('{{cspSource}}', webview.cspSource)
      .replace('{{stylesheet}}', resource('settings.css'))
      .replace('{{script}}', resource('settings.js'));
  }

  update() {
    if (!this.view || !this.ready) return;

    const configuration = this.configuration();
    const cliPath = configuration.get('cliPath', '');
    const inventory = this.inventory?.cliPath === cliPath ? this.inventory : undefined;
    void this.view.webview.postMessage({
      type: 'state',
      settings: {
        model: configuration.get('model', ''),
        cliPath,
        autoRestore: configuration.get('autoRestore', true),
        density: configuration.get('density', 'all')
      },
      inventory: inventory ?? { status: 'idle', models: [] },
      file: this.currentFile(),
      shortcut: this.shortcut
    });
  }

  async refreshModels() {
    if (!this.view || !this.ready) return;

    const cliPath = this.configuration().get('cliPath', '');
    if (this.inventory?.cliPath === cliPath && this.inventory.status === 'loading') return;

    const inventory = { cliPath, status: 'loading', models: [] };
    this.inventory = inventory;
    this.update();
    try {
      const models = await listModels(cliPath, this.cliDirectory);
      if (this.inventory !== inventory) return;

      inventory.models = models;
      inventory.status = 'ready';
    } catch (error) {
      if (this.inventory !== inventory) return;

      inventory.status = 'error';
      inventory.error = error.message;
    }
    this.update();
  }

  async receive(view, message) {
    try {
      switch (message?.type) {
        case 'ready':
          this.ready = true;
          this.update();
          if (this.inventory?.cliPath !== this.configuration().get('cliPath', '')) {
            await this.refreshModels();
          }
          break;
        case 'refreshModels':
          await this.refreshModels();
          break;
        case 'chooseModel':
          await this.chooseModel(view, message.value);
          break;
        case 'setAutoRestore':
          if (typeof message.value === 'boolean') {
            await this.configuration().update('autoRestore', message.value, vscode.ConfigurationTarget.Global);
          }
          break;
        case 'setDensity':
          if (message.value === 'all' || message.value === 'key') {
            await this.configuration().update('density', message.value, vscode.ConfigurationTarget.Global);
          }
          break;
        case 'saveCliPath':
          await this.saveCliPath(view, message.value);
          break;
        case 'browseCliPath': {
          const files = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            openLabel: '选择 Antigravity CLI',
            filters: process.platform === 'win32' ? { '可执行文件': ['exe'] } : undefined
          });
          if (files?.[0] && this.view === view) {
            void view.webview.postMessage({ type: 'cliPathDraft', value: files[0].fsPath });
          }
          break;
        }
        case 'toggle':
          await vscode.commands.executeCommand('aiGhostComments.toggle');
          break;
        case 'regenerate':
          await vscode.commands.executeCommand('aiGhostComments.regenerate');
          break;
        case 'annotateFunction':
          await vscode.commands.executeCommand('aiGhostComments.annotateFunction');
          break;
        case 'annotateSelection':
          await vscode.commands.executeCommand('aiGhostComments.annotateSelection');
          break;
        case 'complete':
          await vscode.commands.executeCommand('aiGhostComments.complete');
          break;
      }
    } catch (error) {
      this.notice(view, error.message, true);
    } finally {
      this.update();
    }
  }

  async chooseModel(view, value) {
    const configuration = this.configuration();
    if (typeof value !== 'string' || value === configuration.get('model', '')) return;

    const inventory = this.inventory;
    if (value && (inventory?.cliPath !== configuration.get('cliPath', '') ||
        !inventory.models.some(model => model.id === value))) return;

    await configuration.update('model', value, vscode.ConfigurationTarget.Global);
    this.notice(view, '模型已保存。');
  }

  async saveCliPath(view, value) {
    if (typeof value !== 'string') return;

    const cliPath = value.trim();
    if (cliPath) await resolveCli(cliPath);
    await this.configuration().update('cliPath', cliPath, vscode.ConfigurationTarget.Global);
    this.notice(view, 'CLI 路径已保存。');
  }

  notice(view, text, error = false) {
    if (this.view !== view) return;
    void view.webview.postMessage({ type: 'notice', text, error });
  }
}

module.exports = { SETTINGS_VIEW_ID, SettingsView };
