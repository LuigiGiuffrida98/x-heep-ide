// The X-HEEP tab of the bottom panel: the app's UART on the left, the extension's log (commands, mcu-gen, model and
// app builds, simulator, OpenOCD) on the right. Both also stay in their Output channels, with its filter and search.

import * as vscode from 'vscode';

export type Side = 'uart' | 'log';

/** Kept for a view opened later, or reloaded: this much per side, the newest. */
const KEEP = 200_000;

let view: vscode.WebviewView | undefined;
const text: Record<Side, string> = { uart: '', log: '' };

export const CONSOLE_VIEW = 'xheep.console';

export function registerConsole(): vscode.Disposable {
	return vscode.window.registerWebviewViewProvider(CONSOLE_VIEW, {
		resolveWebviewView(v) {
			view = v;
			v.webview.options = { enableScripts: true };
			const nonce = Math.random().toString(36).slice(2);
			v.webview.html = html(nonce, v.webview.cspSource);
			v.webview.onDidReceiveMessage(m => {
				if (m.type === 'ready') {
					v.webview.postMessage({ type: 'set', text });
				} else if (m.type === 'clear') {
					text[m.side as Side] = '';
				}
			});
			v.onDidDispose(() => { view = undefined; });
		},
	}, { webviewOptions: { retainContextWhenHidden: true } });
}

/** Colors and cursor moves from make and fusesoc: the tab and the Output channels show plain text. */
export const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n');

function write(side: Side, s: string) {
	const t = plain(s);
	text[side] = (text[side] + t).slice(-KEEP);
	view?.webview.postMessage({ type: 'write', side, text: t });
}

function clear(side: Side) {
	text[side] = '';
	view?.webview.postMessage({ type: 'clear', side });
}

/** Brings the tab up, without taking the focus once it was opened. */
export function revealConsole() {
	if (view) {
		view.show(true);
	} else {
		vscode.commands.executeCommand(`${CONSOLE_VIEW}.focus`);
	}
}

/** An Output channel whose text also goes to the tab, in `side`; show() brings up the tab. */
export function mirroredChannel(name: string, side: Side): vscode.OutputChannel {
	const channel = vscode.window.createOutputChannel(name);
	return {
		name: channel.name,
		append: s => { channel.append(s); write(side, s); },
		appendLine: s => { channel.appendLine(s); write(side, `${s}\n`); },
		replace: s => { channel.replace(s); clear(side); write(side, s); },
		clear: () => { channel.clear(); clear(side); },
		show: () => revealConsole(),
		hide: () => channel.hide(),
		dispose: () => channel.dispose(),
	};
}

function html(nonce: string, csp: string): string {
	return /* html */ `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
html, body { height: 100%; margin: 0; }
body { color: var(--vscode-foreground); background: var(--vscode-panel-background); font: var(--vscode-font-size) var(--vscode-font-family); }
.cols { display: grid; grid-template-columns: 1fr 1fr; height: 100%; }
@media (max-width: 600px) { .cols { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; } }
section { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
section + section { border-left: 1px solid var(--vscode-panel-border, #8884); }
@media (max-width: 600px) { section + section { border-left: 0; border-top: 1px solid var(--vscode-panel-border, #8884); } }
header { display: flex; align-items: center; gap: 8px; padding: 2px 8px; color: var(--vscode-descriptionForeground);
	font-size: .85em; text-transform: uppercase; letter-spacing: .06em; }
header span { flex: 1; }
button { font: inherit; text-transform: none; letter-spacing: 0; color: var(--vscode-foreground); background: transparent;
	border: 1px solid transparent; border-radius: 2px; padding: 0 6px; cursor: pointer; }
button:hover { background: var(--vscode-toolbar-hoverBackground); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
pre { flex: 1; margin: 0; padding: 4px 8px 8px; overflow: auto; white-space: pre-wrap; word-break: break-word;
	font: var(--vscode-editor-font-size) var(--vscode-editor-font-family); }
.empty { color: var(--vscode-descriptionForeground); }
</style></head>
<body><div class="cols">
	<section><header><span>UART</span><button data-clear="uart" title="Clear the UART output">Clear</button></header>
		<pre id="uart" tabindex="0" aria-label="UART output" aria-live="polite"></pre></section>
	<section><header><span>Log</span><button data-clear="log" title="Clear the log">Clear</button></header>
		<pre id="log" tabindex="0" aria-label="X-HEEP log"></pre></section>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const HINT = { uart: 'The app\\'s UART output shows here when it runs.', log: 'Commands, builds and the simulator show here.' };
const pre = side => document.getElementById(side);
function show(side, text, append) {
	const el = pre(side);
	// Follow the end only when it was already there: scrolling up to read stays put.
	const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
	if (!append || el.classList.contains('empty')) { el.textContent = ''; el.classList.remove('empty'); }
	el.textContent += text;
	if (!el.textContent) { el.textContent = HINT[side]; el.classList.add('empty'); }
	if (atEnd) el.scrollTop = el.scrollHeight;
}
window.addEventListener('message', ({ data: m }) => {
	if (m.type === 'set') { show('uart', m.text.uart, false); show('log', m.text.log, false); }
	if (m.type === 'write') show(m.side, m.text, true);
	if (m.type === 'clear') show(m.side, '', false);
});
document.querySelectorAll('[data-clear]').forEach(b => b.onclick = () => { show(b.dataset.clear, '', false); vscode.postMessage({ type: 'clear', side: b.dataset.clear }); });
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
