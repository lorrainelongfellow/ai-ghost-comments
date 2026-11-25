const path = require('node:path');
const vscode = require('vscode');

const DEFINITION_COMMAND = 'aiGhostComments.openDefinition';
const MAX_INLINE_LENGTH = 60;
const KEYWORDS = new Set((
  'alignas and as auto bool break byte case catch char class const continue def default do double elif else ' +
  'enum export false float for from func function goto if import include inline int let long namespace new ' +
  'None null nullptr private protected public raise return self short signed sizeof static struct switch ' +
  'template this throw true try typedef uint8_t uint16_t uint32_t uint64_t union unsigned using var void ' +
  'volatile while with yield define endif ifdef ifndef'
).split(' '));

function relatedSymbols(source, explanation) {
  const mentioned = new Set(explanation.match(/[A-Za-z_]\w*/g));
  const code = source.replace(
    /\/\/.*|\/\*.*?(?:\*\/|$)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    literal => ' '.repeat(literal.length)
  );
  const symbols = new Map();
  for (const match of code.matchAll(/\b[A-Za-z_]\w*\b/g)) {
    const name = match[0];
    if (KEYWORDS.has(name)) continue;

    const call = /^\s*\(/.test(code.slice(match.index + name.length));
    const score = (mentioned.has(name) ? 4 : 0) + (call || /^[A-Z][A-Z0-9_]+$/.test(name) ? 2 : 0);
    if (!symbols.has(name) || symbols.get(name).score < score) {
      symbols.set(name, { name, character: match.index, score });
    }
  }
  return [...symbols.values()].sort((a, b) => b.score - a.score).slice(0, 3);
}

function makeDecoration(document, documentId, note) {
  const row = document.lineAt(note.line - 1);
  const hoverMessage = new vscode.MarkdownString().appendText(note.text);
  const symbols = relatedSymbols(row.text, note.text);
  if (symbols.length > 0) {
    hoverMessage.isTrusted = { enabledCommands: [DEFINITION_COMMAND] };
    const links = symbols.map(symbol => {
      const argumentsJson = JSON.stringify([documentId, document.version, row.lineNumber, symbol.character, symbol.name]);
      const query = encodeURIComponent(argumentsJson);
      return '[`' + symbol.name + '`](command:' + DEFINITION_COMMAND + '?' + query + ')';
    });
    hoverMessage.appendMarkdown('\n\n跳转定义  ' + links.join(' · '));
  }

  const inlineText = note.text.length > MAX_INLINE_LENGTH
    ? note.text.slice(0, MAX_INLINE_LENGTH - 1) + '…'
    : note.text;
  return {
    important: typeof note.important === 'boolean' ? note.important :
      /^\s*(?:[}]\s*)?(?:if|else|elif|switch|case|throw|raise)\b/.test(row.text) ||
      /limit|clamp|saturat|fault|protect|限幅|故障|保护|状态切换/i.test(row.text + ' ' + note.text),
    options: {
      range: row.range,
      hoverMessage,
      renderOptions: { after: { contentText: '-> ' + inlineText } }
    }
  };
}

async function openDefinition(document, version, line, character, name) {
  if (document.version !== version || !Number.isInteger(line) || line < 0 || line >= document.lineCount ||
      !Number.isInteger(character) || character < 0 || typeof name !== 'string') return;

  const position = new vscode.Position(line, character);
  const word = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
  if (word?.start.character !== character || document.getText(word) !== name) return;

  try {
    const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, position);
    if (document.isClosed || document.version !== version) return;

    const destinations = new Map();
    for (const definition of definitions ?? []) {
      const uri = definition.targetUri ?? definition.uri;
      const range = definition.targetSelectionRange ?? definition.targetRange ?? definition.range;
      const key = uri.toString() + '#' + range.start.line + ':' + range.start.character;
      destinations.set(key, {
        label: path.basename(uri.path) + ':' + (range.start.line + 1),
        description: vscode.workspace.asRelativePath(uri),
        uri,
        range
      });
    }
    const choices = [...destinations.values()];
    if (choices.length === 0) {
      void vscode.window.showInformationMessage('VS Code 未找到 ' + name + ' 的定义。');
      return;
    }

    const destination = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices, {
      placeHolder: '选择 ' + name + ' 的定义'
    });
    if (destination) {
      await vscode.window.showTextDocument(destination.uri, { selection: destination.range, preview: true });
    }
  } catch {
    void vscode.window.showErrorMessage('无法打开 ' + name + ' 的定义。');
  }
}

module.exports = { DEFINITION_COMMAND, makeDecoration, openDefinition };
