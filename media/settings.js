const vscode = acquireVsCodeApi();
const model = document.querySelector('#model');
const modelStatus = document.querySelector('#model-status');
const refresh = document.querySelector('#refresh');
const autoRestore = document.querySelector('#auto-restore');
const density = document.querySelector('#density');
const fileName = document.querySelector('#file-name');
const fileStatus = document.querySelector('#file-status');
const shortcut = document.querySelector('#shortcut');
const toggle = document.querySelector('#toggle');
const regenerate = document.querySelector('#regenerate');
const complete = document.querySelector('#complete');
const annotateFunction = document.querySelector('#annotate-function');
const annotateSelection = document.querySelector('#annotate-selection');
const cliPath = document.querySelector('#cli-path');
const notice = document.querySelector('#notice');
let savedPath;

function send(type, value) {
  notice.hidden = true;
  vscode.postMessage({ type, value });
}

function option(value, label) {
  const item = document.createElement('option');
  item.value = value;
  item.textContent = label;
  return item;
}

function renderModels(current, inventory) {
  const options = [option('', '跟随 Antigravity 当前模型')];
  for (const item of inventory.models) {
    const suffix = item.id === 'gemini-4-neon-xhigh' ? ' · 复杂代码推荐' : '';
    options.push(option(item.id, item.label + suffix));
  }
  if (current && !inventory.models.some(item => item.id === current)) {
    options.push(option(current, current));
  }
  const signature = JSON.stringify(options.map(item => [item.value, item.textContent]));
  if (model.dataset.options !== signature) {
    model.replaceChildren(...options);
    model.dataset.options = signature;
  }
  model.value = current;
  model.disabled = inventory.status === 'idle' || inventory.status === 'loading';
  refresh.disabled = inventory.status === 'loading';
  modelStatus.classList.toggle('error', inventory.status === 'error');
  if (inventory.status === 'loading') {
    modelStatus.textContent = '正在读取可用模型…';
  } else if (inventory.status === 'ready') {
    modelStatus.textContent = inventory.models.length + ' 个可用模型';
  } else {
    modelStatus.textContent = inventory.error ?? '';
  }
}

function renderFile(file) {
  fileName.textContent = file?.name ?? '请先打开代码文件';
  fileName.title = file?.name ?? '';
  toggle.disabled = !file;
  toggle.textContent = file?.visible ? '隐藏注释' : '显示全文';
  regenerate.disabled = !file || file.running;
  complete.hidden = !file?.canComplete;
  complete.textContent = file?.scoped && !file.failed ? '显示全文' : '补齐注释';
  annotateFunction.disabled = !file;
  annotateSelection.disabled = !file?.hasSelection;

  if (!file) {
    fileStatus.textContent = '';
  } else if (file.preparing) {
    fileStatus.textContent = file.scope + ' · 正在读取缓存和源码范围…';
  } else if (file.running) {
    fileStatus.textContent = file.visible
      ? file.scope + ' · 正在生成 · 已显示 ' + file.annotationCount + ' 条'
      : '已隐藏，正在完成当前批次';
  } else if (file.failed) {
    fileStatus.textContent = file.scope + ' · 已显示 ' + file.annotationCount + ' 条。点击「补齐注释」继续。';
  } else if (file.hasAnnotations || file.visible) {
    fileStatus.textContent = file.scope + (file.visible ? ' · 已显示 ' : ' · 已隐藏 ') + file.annotationCount + ' 条注释';
  } else {
    fileStatus.textContent = '尚未显示注释';
  }
}

window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'state') {
    const { settings, inventory, file } = message;
    renderModels(settings.model, inventory);
    shortcut.textContent = message.shortcut;
    autoRestore.checked = settings.autoRestore;
    autoRestore.disabled = false;
    density.value = settings.density;
    density.disabled = false;
    if (settings.cliPath !== savedPath) {
      savedPath = settings.cliPath;
      cliPath.value = savedPath;
    }
    renderFile(file);
  } else if (message.type === 'notice') {
    notice.textContent = message.text;
    notice.classList.toggle('error', message.error);
    notice.hidden = false;
  } else if (message.type === 'cliPathDraft') {
    cliPath.value = message.value;
    cliPath.focus();
  }
});

model.addEventListener('change', () => send('chooseModel', model.value));
refresh.addEventListener('click', () => send('refreshModels'));
autoRestore.addEventListener('change', () => send('setAutoRestore', autoRestore.checked));
density.addEventListener('change', () => send('setDensity', density.value));
toggle.addEventListener('click', () => send('toggle'));
regenerate.addEventListener('click', () => send('regenerate'));
complete.addEventListener('click', () => send('complete'));
annotateFunction.addEventListener('click', () => send('annotateFunction'));
annotateSelection.addEventListener('click', () => send('annotateSelection'));
document.querySelector('#browse').addEventListener('click', () => send('browseCliPath'));
document.querySelector('#cli-form').addEventListener('submit', event => {
  event.preventDefault();
  send('saveCliPath', cliPath.value);
});

send('ready');
