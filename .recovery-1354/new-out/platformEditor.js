"use strict";
// The platform editor panel: a webview form over the active configuration (see platform.ts for the model).
// The extension feeds it what X-HEEP's generator reads and does the writing; the page only edits a form.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.openPlatformEditor = openPlatformEditor;
exports.refreshPlatformEditor = refreshPlatformEditor;
const vscode = __importStar(require("vscode"));
let panel;
/** `xalp`: X-ALP's page, with its own knobs. */
function openPlatformEditor(host, xalp = false) {
    if (panel) {
        panel.reveal();
        return;
    }
    panel = vscode.window.createWebviewPanel('xheep.platform', xalp ? 'X-ALP Platform' : 'X-HEEP Platform', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    const nonce = Math.random().toString(36).slice(2);
    panel.webview.html = (xalp ? xalpHtml : html)(nonce, panel.webview.cspSource);
    const post = (m) => panel?.webview.postMessage(m);
    const load = async () => {
        post({ type: 'busy', text: 'Reading the configuration…' });
        const state = await host.load();
        if (panel && 'name' in state) {
            panel.title = state.mode === 'create' ? 'New Platform Configuration' : `Platform: ${state.name}`;
        }
        post('error' in state ? { type: 'error', text: state.error } : { type: 'load', state });
    };
    panel.webview.onDidReceiveMessage(async (m) => {
        switch (m.type) {
            case 'ready': return load();
            case 'apply': {
                post({ type: 'busy', text: 'Checking with X-HEEP\'s generator…' });
                const { error, cancelled } = await host.apply(m.form);
                return cancelled ? post({ type: 'idle' }) : error ? post({ type: 'error', text: error, keep: true }) : load();
            }
            case 'start':
                await host.startFrom();
                return load();
            case 'open': return host.openFile();
        }
    });
    panel.onDidDispose(() => { panel = undefined; });
}
/** Reloads the editor after the active configuration changed elsewhere. */
function refreshPlatformEditor() {
    panel?.webview.postMessage({ type: 'reload' });
}
const STYLE = /* css */ `
:root {
	--fg: var(--vscode-foreground); --muted: var(--vscode-descriptionForeground); --line: var(--vscode-panel-border, var(--vscode-widget-border, #8884));
	--bg: var(--vscode-editor-background); --accent: var(--vscode-button-background); --accent-fg: var(--vscode-button-foreground);
	--warn: var(--vscode-editorWarning-foreground); --warn-bg: var(--vscode-inputValidation-warningBackground, #cca70022);
	--err: var(--vscode-errorForeground); --ok: var(--vscode-testing-iconPassed, #388a34);
	--seg-code: var(--vscode-charts-blue); --seg-data: var(--vscode-charts-green); --seg-heap: var(--vscode-charts-purple);
	--seg-stack: var(--vscode-charts-orange); --seg-il: var(--vscode-charts-red); --seg-free: var(--vscode-input-background);
	--mono: var(--vscode-editor-font-family);
}
[hidden] { display: none !important; }
body { color: var(--fg); background: var(--bg); font: var(--vscode-font-size) / 1.5 var(--vscode-font-family); padding: 0 16px 0; margin: 0; }
.wrap { max-width: 760px; margin: 0 auto; }
header { padding: 18px 0 6px; display: grid; gap: 4px; }
h1 { font-size: 1.4em; font-weight: 600; margin: 0; }
.sub { color: var(--muted); display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: center; }
code, .num { font-family: var(--mono); }
.num { font-variant-numeric: tabular-nums; }
a, .link { color: var(--vscode-textLink-foreground); cursor: pointer; background: none; border: 0; padding: 0; font: inherit; }
.tag { font-size: .85em; padding: 0 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 0 8px; border-radius: 10px; border: 1px solid var(--line); }
.chip::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); }
.chip.warn::before { background: var(--warn); }
section { padding: 16px 0; border-top: 1px solid var(--line); display: grid; gap: 12px; }
h2 { font-size: .85em; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 0; font-weight: 600; }
.row { display: grid; grid-template-columns: 150px 1fr; gap: 8px 16px; align-items: start; }
.row > .lab { padding-top: 4px; }
.hint { color: var(--muted); margin-top: 4px; }
@media (max-width: 560px) { .row { grid-template-columns: 1fr; } .row > .lab { padding-top: 0; font-weight: 600; } }
select, input[type=number] { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--line)); border-radius: 2px; padding: 3px 6px; }
select { max-width: 100%; }
input[type=number] { width: 80px; font-family: var(--mono); }
:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--line); border-radius: 2px; overflow: hidden; }
.seg button { font: inherit; color: var(--fg); background: transparent; border: 0; padding: 3px 12px; cursor: pointer; }
.seg button + button { border-left: 1px solid var(--line); }
.seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-fg); }
.seg button:disabled { opacity: .5; cursor: default; }
.toggle { display: inline-flex; align-items: center; gap: 8px; }
.stepper { display: inline-flex; align-items: center; gap: 6px; }
.stepper button { font: inherit; width: 24px; height: 24px; border: 1px solid var(--line); background: transparent; color: var(--fg); border-radius: 2px; cursor: pointer; }
.mem { display: grid; gap: 10px; }
.mrow { display: grid; grid-template-columns: 92px 1fr; gap: 2px 12px; align-items: center; }
.mrow > b { font-weight: 600; }
.track { display: flex; align-items: center; gap: 8px; min-width: 0; }
.fill { display: flex; height: 20px; border-radius: 3px; overflow: hidden; gap: 2px; min-width: 4px; }
.fill > div { min-width: 0; height: 100%; }
.track .v { font-family: var(--mono); color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.mrow .cap { grid-column: 2; color: var(--muted); }
.c-code { background: var(--seg-code); } .c-heap { background: var(--seg-heap); } .c-stack { background: var(--seg-stack); }
.c-room { background: color-mix(in srgb, var(--seg-data) 35%, var(--seg-free)); } .c-full { background: var(--warn); } .c-il { background: var(--seg-il); }
@media (max-width: 560px) { .mrow { grid-template-columns: 1fr; } .mrow .cap { grid-column: 1; } }
.periph { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px; }
.periph label { display: flex; gap: 8px; align-items: flex-start; padding: 6px 8px; border: 1px solid var(--line); border-radius: 3px; cursor: pointer; }
.periph small { display: block; color: var(--muted); }
.note { padding: 8px 10px; border-radius: 3px; background: var(--warn-bg); }
.note b { color: var(--warn); }
.note.err b { color: var(--err); }
footer { position: sticky; bottom: 0; background: var(--bg); border-top: 1px solid var(--line); padding: 10px 0; display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; }
footer .cost { color: var(--muted); flex: 1 1 260px; min-width: 0; }
.btn { font: inherit; border-radius: 2px; padding: 4px 14px; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent);
	background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn.primary { background: var(--accent); color: var(--accent-fg); }
.btn:disabled { opacity: .5; cursor: default; }
#status { padding: 24px 0; color: var(--muted); }
`;
function html(nonce, csp) {
    return /* html */ `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${STYLE}</style></head>
<body><div class="wrap">
<div id="status">Reading the configuration…</div>
<div id="editor" hidden>
	<header>
		<h1 id="name"></h1>
		<div class="sub"><span id="where"></span><button class="link" id="start">Start from another configuration</button><button class="link" id="open">Open as code</button><span class="tag">Experimental</span><span id="chip" class="chip" hidden></span></div>
	</header>
	<section>
		<h2>Core</h2>
		<div class="row">
			<label class="lab" for="cpu">CPU</label>
			<div><select id="cpu"></select><div class="hint" id="cpu-hint"></div></div>
			<div class="lab">Floating point</div>
			<div><label class="toggle"><input type="checkbox" id="fpu"> Hardware FPU (F extension)</label><div class="hint" id="fpu-hint"></div></div>
			<div class="lab">Bus</div>
			<div><div class="seg" role="group" aria-label="Bus"><button id="bus-onetoM">One master at a time</button><button id="bus-NtoM">Parallel (N to M)</button></div>
				<div class="hint">Parallel lets the DMA and accelerators use memory while the CPU runs. It takes more FPGA area.</div></div>
		</div>
	</section>
	<section>
		<h2>Memory</h2>
		<div class="mem" id="mem"></div>
		<div class="hint" id="mem-custom" hidden></div>
		<div class="row">
			<div class="lab mem-edit">Contiguous RAM</div>
			<div class="mem-edit"><div style="display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center;">
				<div class="stepper"><button id="banks-dn" aria-label="Fewer banks">−</button><span class="num" id="banks"></span><button id="banks-up" aria-label="More banks">+</button></div>
				<label class="toggle" for="bank-size">of <select id="bank-size"><option value="8">8 KB</option><option value="16">16 KB</option><option value="32">32 KB</option><option value="64">64 KB</option></select></label></div>
				<div class="hint" id="banks-hint"></div></div>
			<label class="lab mem-edit" for="code">Code</label>
			<div class="mem-edit"><input type="number" id="code" min="8" step="2"> KB<div class="hint">Program instructions and constants, at the start of the contiguous RAM.</div></div>
			<div class="lab mem-edit">Data</div>
			<div class="mem-edit"><span class="num" id="data-kb"></span><div class="hint">Contiguous RAM minus code: global variables, heap and stack. Change it through the RAM or the code size.</div></div>
			<label class="lab" for="heap">Heap</label>
			<div><input type="number" id="heap" min="0" step="1"> KB<div class="hint">Memory for <code>malloc</code>.</div></div>
			<label class="lab" for="stack">Stack</label>
			<div><input type="number" id="stack" min="1" step="1"> KB<div class="hint" id="stack-hint"></div></div>
			<div class="lab mem-edit">Interleaved</div>
			<div class="mem-edit"><div style="display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center;"><div class="seg" role="group" aria-label="Interleaved banks" id="il-num"></div>
				<label class="toggle" for="il-size">of <select id="il-size"><option value="8">8 KB</option><option value="16">16 KB</option><option value="32">32 KB</option><option value="64">64 KB</option></select></label></div>
				<div class="hint">Consecutive words alternate across these banks, so the DMA and accelerators read them in parallel. Put data there with <code>__attribute__((section(".xheep_data_interleaved")))</code>.</div></div>
		</div>
	</section>
	<section>
		<h2>Peripherals</h2>
		<div class="periph" id="periph"></div>
		<div class="hint">Always included: SoC control, boot ROM, SPI flash, DMA, power manager, always-on timer and GPIO, pad control.</div>
	</section>
	<div id="notes" style="display:grid; gap:6px; padding-bottom:12px"></div>
	<footer><span class="cost" id="cost"></span><button class="btn" id="revert">Revert</button><button class="btn primary" id="apply">Apply</button></footer>
</div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const CPU_DOC = { cv32e20: 'small, RV32IMC. The default.', cv32e40p: 'larger and faster, optional FPU, PULP DSP instructions.',
	cv32e40x: 'X-interface for custom coprocessors.', cv32e40px: 'cv32e40p with the X-interface.' };
const FPU_CPUS = ['cv32e40p', 'cv32e40px'];
const HW = ['cpu', 'fpu', 'bus', 'banks', 'bankKb', 'ilNum', 'ilSizeKb', 'peripherals'];
let st, f, error;

window.addEventListener('message', ({ data: m }) => {
	if (m.type === 'busy') { $('cost').textContent = m.text; $('apply').disabled = true; if (!st) { $('status').textContent = m.text; } }
	if (m.type === 'error') { if (m.keep && st) { error = m.text; render(); } else { $('status').hidden = false; $('editor').hidden = true; $('status').textContent = m.text; } }
	if (m.type === 'load') { st = m.state; f = structuredClone(st.form); error = undefined; $('status').hidden = true; $('editor').hidden = false; render(); }
	if (m.type === 'reload') { vscode.postMessage({ type: 'ready' }); }
	if (m.type === 'idle' && st) { render(); }
});

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const kb = n => n + ' KB';

function render() {
	const creating = st.mode === 'create';
	$('name').textContent = creating ? 'New platform configuration' : st.name;
	$('where').innerHTML = creating ? 'Starting from <code></code>' : 'On top of <code></code>';
	$('where').querySelector('code').textContent = creating ? st.file : st.base;
	$('start').hidden = !creating;
	$('open').hidden = creating;
	$('apply').textContent = creating ? 'Save as…' : 'Apply';
	$('cpu').innerHTML = st.catalog.cpus.map(c => '<option value="' + c + '">' + c + ' · ' + (CPU_DOC[c] || '') + '</option>').join('');
	$('cpu').value = f.cpu;
	const fpuOk = FPU_CPUS.includes(f.cpu);
	if (!fpuOk) f.fpu = false;
	$('fpu').checked = f.fpu; $('fpu').disabled = !fpuOk;
	$('fpu-hint').textContent = !fpuOk ? 'Only cv32e40p and cv32e40px have an FPU.' : f.fpu ? 'Apps are built with ARCH=rv32imfc_zicsr to use it.' : 'Floats are computed in software.';
	$('cpu-hint').textContent = 'Changing the CPU resets its other options to their defaults.';
	for (const b of ['onetoM', 'NtoM']) $('bus-' + b).setAttribute('aria-pressed', String(f.bus === b));

	// Memory: one row per use (code, data, interleaved) on one scale, from the form, or from the configuration as
	// is when the form cannot represent it. The form below follows the same order.
	const edit = st.memoryEditable, p = st.platform;
	const banksKb = edit ? f.banks * f.bankKb : p.banks.reduce((a, b) => a + b, 0);
	const groups = edit ? (f.ilNum ? [{ num: f.ilNum, sizeKb: f.ilSizeKb }] : []) : p.interleaved;
	const il = groups.reduce((a, g) => a + g.num * g.sizeKb, 0);
	document.querySelectorAll('.mem-edit').forEach(el => { el.hidden = !edit; });
	$('mem-custom').hidden = edit;
	$('mem-custom').textContent = 'This configuration has its own memory layout: change it in its Python or HJSON file.';
	$('banks').textContent = f.banks + (f.banks > 1 ? ' banks' : ' bank');
	$('bank-size').value = String(f.bankKb);
	$('banks-hint').textContent = 'All the RAM for code and data: the code size takes its share, the rest is data.' + (st.boardRamKb ? ' The ' + st.board + ' holds about ' + kb(st.boardRamKb) + ' of RAM in all.' : '');
	$('il-num').innerHTML = [0, 1, 2, 4, 8].map(n => '<button data-n="' + n + '" aria-pressed="' + (f.ilNum === n) + '">' + (n || 'None') + '</button>').join('');
	$('il-num').querySelectorAll('button').forEach(b => b.onclick = () => { f.ilNum = Number(b.dataset.n); render(); });
	$('il-size').value = String(f.ilSizeKb); $('il-size').disabled = !f.ilNum;
	$('code').value = f.codeKb; $('stack').value = f.stackKb; $('heap').value = f.heapKb;
	const dataKb = Math.max(banksKb - f.codeKb, 0);
	const room = dataKb - f.heapKb - f.stackKb;
	$('data-kb').textContent = kb(f.banks * f.bankKb) + ' − ' + kb(f.codeKb) + ' = ' + kb(dataKb);
	const scale = Math.max(f.codeKb, dataKb, ...groups.map(g => g.num * g.sizeKb), 1);
	const seg = (cls, k) => k > 0 ? '<div class="' + cls + '" style="flex:' + k + ' 0 0"></div>' : '';
	const row = (label, k, inner, cap) => '<div class="mrow"><b>' + label + '</b><div class="track"><div class="fill" style="width:' + (k / scale * 82)
		+ '%">' + inner + '</div><span class="v">' + kb(k) + '</span></div><div class="cap">' + cap + '</div></div>';
	const banksText = edit ? f.banks + ' × ' + kb(f.bankKb) : p.banks.map(kb).join(' + ');
	$('mem').innerHTML = '<div class="hint">Contiguous RAM: ' + banksText + ' = ' + kb(banksKb) + ', shared by code and data</div>'
		+ row('Code', f.codeKb, seg('c-code', f.codeKb), 'Instructions and constants.')
		+ row('Data', dataKb, room >= 0 ? seg('c-heap', f.heapKb) + seg('c-stack', f.stackKb) + seg('c-room', room) : seg('c-full', dataKb),
			room >= 0 ? 'Heap ' + kb(f.heapKb) + ' · stack ' + kb(f.stackKb) + ' · ' + kb(room) + ' left for global variables.'
				: 'Heap and stack need ' + kb(f.heapKb + f.stackKb) + ', but only ' + kb(dataKb) + ' is left after the code.')
		+ groups.map(g => row('Interleaved', g.num * g.sizeKb, Array.from({ length: g.num }, () => seg('c-il', g.sizeKb)).join(''),
			g.num + ' × ' + kb(g.sizeKb) + ', after the contiguous RAM. Only the data you place there.')).join('');
	const all = banksKb + il;
	const frame = st.largestFrame;
	$('stack-hint').innerHTML = 'Local variables of all the functions running at once.';
	if (frame && frame.bytes > f.stackKb * 1024) {
		$('stack-hint').innerHTML += ' <b style="color:var(--warn)"></b>';
		$('stack-hint').querySelector('b').textContent = frame.fn + '() in ' + frame.app + ' alone needs ' + Math.ceil(frame.bytes / 1024) + ' KB.';
	}

	const names = st.catalog.userPeripherals;
	$('periph').innerHTML = names.map(p => '<label><input type="checkbox" data-p="' + p.name + '"' + (f.peripherals.includes(p.name) ? ' checked' : '') + '><span>' + p.name + '<small></small></span></label>').join('');
	$('periph').querySelectorAll('input').forEach((el, i) => {
		el.parentElement.querySelector('small').textContent = names[i].doc;
		el.onchange = () => { f.peripherals = el.checked ? [...f.peripherals, el.dataset.p].sort() : f.peripherals.filter(x => x !== el.dataset.p); render(); };
	});

	const notes = [];
	if (st.memoryEditable && f.codeKb + f.stackKb + f.heapKb >= f.banks * f.bankKb) notes.push(['err', 'Does not fit:', 'code, stack and heap take more than the RAM. Add banks or shrink them.']);
	if (st.boardRamKb && all > st.boardRamKb) notes.push(['', 'Too big for the ' + st.board + ':', 'more than about ' + kb(st.boardRamKb) + ' of RAM does not fit its FPGA. Simulation still works.']);
	if (il && f.bus !== 'NtoM') notes.push(['', 'Interleaved banks with a one-master bus:', 'the DMA cannot read them while the CPU runs, so they bring little. Pick the parallel bus.']);
	if (!f.peripherals.includes('uart')) notes.push(['', 'No UART:', 'printf output goes nowhere.']);
	if (error) notes.push(['err', 'X-HEEP\\'s generator rejects this configuration:', error]);
	$('notes').innerHTML = notes.map(([c]) => '<div class="note ' + c + '"><b></b> <span></span></div>').join('');
	$('notes').querySelectorAll('.note').forEach((n, i) => { n.querySelector('b').textContent = notes[i][1]; n.querySelector('span').textContent = notes[i][2]; });

	const changed = Object.keys(f).filter(k => !same(f[k], st.form[k]));
	const hw = changed.filter(k => HW.includes(k));
	const chip = $('chip');
	chip.hidden = st.bitstreamMatches === undefined;
	chip.className = st.bitstreamMatches && !hw.length ? 'chip' : 'chip warn';
	chip.textContent = st.bitstreamMatches && !hw.length ? 'Matches the loaded bitstream' : 'Needs a new bitstream for the FPGA';
	$('cost').textContent = !changed.length ? 'No changes.' : changed.length + ' change' + (changed.length > 1 ? 's' : '') + '. '
		+ (hw.length ? 'The next build regenerates the platform and the simulation model (a few minutes); the FPGA needs a new bitstream.'
			: 'The next build regenerates the platform (seconds). No new hardware needed.')
		+ (creating ? ' Save as… creates the configuration and makes it the active one.' : '');
	$('apply').disabled = !changed.length || notes.some(n => n[0] === 'err' && n[1] !== 'X-HEEP\\'s generator rejects this configuration:');
	$('revert').disabled = !changed.length;
}

$('cpu').onchange = e => { f.cpu = e.target.value; render(); };
$('fpu').onchange = e => { f.fpu = e.target.checked; render(); };
for (const b of ['onetoM', 'NtoM']) $('bus-' + b).onclick = () => { f.bus = b; render(); };
$('banks-dn').onclick = () => { f.banks = Math.max(1, f.banks - 1); render(); };
$('banks-up').onclick = () => { f.banks = Math.min(32, f.banks + 1); render(); };
$('il-size').onchange = e => { f.ilSizeKb = Number(e.target.value); render(); };
$('bank-size').onchange = e => { f.bankKb = Number(e.target.value); render(); };
for (const [id, k] of [['code', 'codeKb'], ['stack', 'stackKb'], ['heap', 'heapKb']]) $(id).onchange = e => { f[k] = Math.max(0, Number(e.target.value) || 0); render(); };
$('revert').onclick = () => { f = structuredClone(st.form); error = undefined; render(); };
$('apply').onclick = () => { error = undefined; vscode.postMessage({ type: 'apply', form: f }); };
$('start').onclick = () => vscode.postMessage({ type: 'start' });
$('open').onclick = () => vscode.postMessage({ type: 'open' });
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
/** X-ALP's page: the last-level cache (its geometry sizes the SPM), the DRAM it caches, and the peripherals. */
function xalpHtml(nonce, csp) {
    return /* html */ `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${STYLE}</style></head>
<body><div class="wrap">
<div id="status">Reading the configuration…</div>
<div id="editor" hidden>
	<header>
		<h1 id="name"></h1>
		<div class="sub"><span id="where"></span><button class="link" id="start">Start from another configuration</button><button class="link" id="open">Open as code</button><span class="tag">Experimental</span></div>
	</header>
	<section>
		<h2>Core</h2>
		<div class="row"><div class="lab">CPU</div><div><code id="cpu"></code><div class="hint">X-ALP's only CPU: RV64GC, apps are built for it.</div></div></div>
	</section>
	<section>
		<h2>Memory</h2>
		<div class="mem" id="mem"></div>
		<div class="row">
			<label class="lab" for="ways">Cache ways</label>
			<div><select id="ways"></select></div>
			<label class="lab" for="lines">Lines per way</label>
			<div><select id="lines"></select></div>
			<label class="lab" for="blocks">Blocks per line</label>
			<div><select id="blocks"></select><div class="hint" id="geo-hint"></div></div>
			<label class="lab" for="dram">DRAM</label>
			<div><select id="dram"></select><div class="hint">Behind the cache. Apps linked into the DRAM (Simulation · DRAM) run from it.</div></div>
		</div>
	</section>
	<section>
		<h2>Peripherals</h2>
		<div class="periph" id="periph"></div>
		<div class="hint">Always included: SoC control, boot ROM, the cache's configuration registers.</div>
	</section>
	<div id="notes" style="display:grid; gap:6px; padding-bottom:12px"></div>
	<footer><span class="cost" id="cost"></span><button class="btn" id="revert">Revert</button><button class="btn primary" id="apply">Apply</button></footer>
</div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const CHOICES = { ways: [1, 2, 4, 8, 16, 32], lines: [64, 128, 256, 512, 1024, 2048], blocks: [2, 4, 8, 16], dramMb: [64, 128, 256, 512, 1024] };
let st, f, error;

window.addEventListener('message', ({ data: m }) => {
	if (m.type === 'busy') { $('cost').textContent = m.text; $('apply').disabled = true; if (!st) { $('status').textContent = m.text; } }
	if (m.type === 'error') { if (m.keep && st) { error = m.text; render(); } else { $('status').hidden = false; $('editor').hidden = true; $('status').textContent = m.text; } }
	if (m.type === 'load') { st = m.state; f = structuredClone(st.form); error = undefined; $('status').hidden = true; $('editor').hidden = false; render(); }
	if (m.type === 'reload') { vscode.postMessage({ type: 'ready' }); }
	if (m.type === 'idle' && st) { render(); }
});

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const size = kb => kb >= 1024 ? kb / 1024 + ' MB' : kb + ' KB';
// The configuration's own value stays pickable even when it is not among the usual ones.
const fill = (id, k, label) => { $(id).innerHTML = [...new Set([...CHOICES[k], st.form[k], f[k]])].sort((a, b) => a - b).map(v => '<option value="' + v + '">' + label(v) + '</option>').join(''); $(id).value = String(f[k]); };

function render() {
	const creating = st.mode === 'create';
	$('name').textContent = creating ? 'New platform configuration' : st.name;
	$('where').innerHTML = creating ? 'Starting from <code></code>' : 'On top of <code></code>';
	$('where').querySelector('code').textContent = creating ? st.file : st.base;
	$('start').hidden = !creating;
	$('open').hidden = creating;
	$('apply').textContent = creating ? 'Save as…' : 'Apply';
	$('cpu').textContent = st.platform.cpu;
	fill('ways', 'ways', String); fill('lines', 'lines', String); fill('blocks', 'blocks', String);
	fill('dram', 'dramMb', v => size(v * 1024));
	const bytes = st.platform.llc.dataWidth / 8, spm = f.ways * f.lines * f.blocks * bytes / 1024;
	$('geo-hint').textContent = f.ways + ' × ' + f.lines + ' × ' + f.blocks + ' blocks of ' + bytes + ' bytes = ' + size(spm) + '. Every way is usable as scratchpad: this is the SPM size.';
	$('mem').innerHTML = '<div class="mrow"><b>SPM</b><div class="track"><span class="v">' + size(spm) + '</span></div><div class="cap">On-chip, the cache used as scratchpad (Simulation · SPM).</div></div>'
		+ '<div class="mrow"><b>DRAM</b><div class="track"><span class="v">' + size(f.dramMb * 1024) + '</span></div><div class="cap">Off-chip, through the cache.</div></div>';

	const names = st.catalog.peripherals;
	$('periph').innerHTML = names.map(p => '<label><input type="checkbox" data-p="' + p.name + '"' + (f.peripherals.includes(p.name) ? ' checked' : '') + '><span>' + p.name + '<small></small></span></label>').join('');
	$('periph').querySelectorAll('input').forEach((el, i) => {
		el.parentElement.querySelector('small').textContent = names[i].doc;
		el.onchange = () => { f.peripherals = el.checked ? [...f.peripherals, el.dataset.p].sort() : f.peripherals.filter(x => x !== el.dataset.p); render(); };
	});

	const notes = [];
	if (!f.peripherals.includes('uart')) notes.push(['', 'No UART:', 'printf output goes nowhere.']);
	if (error) notes.push(['err', 'The generator rejects this configuration:', error]);
	$('notes').innerHTML = notes.map(([c]) => '<div class="note ' + c + '"><b></b> <span></span></div>').join('');
	$('notes').querySelectorAll('.note').forEach((n, i) => { n.querySelector('b').textContent = notes[i][1]; n.querySelector('span').textContent = notes[i][2]; });

	const changed = Object.keys(f).filter(k => !same(f[k], st.form[k]));
	$('cost').textContent = !changed.length ? 'No changes.' : changed.length + ' change' + (changed.length > 1 ? 's' : '') + '. '
		+ 'The next build regenerates the platform and the simulation model (a few minutes).'
		+ (creating ? ' Save as… creates the configuration and makes it the active one.' : '');
	$('apply').disabled = !changed.length;
	$('revert').disabled = !changed.length;
}

for (const [id, k] of [['ways', 'ways'], ['lines', 'lines'], ['blocks', 'blocks'], ['dram', 'dramMb']]) $(id).onchange = e => { f[k] = Number(e.target.value); render(); };
$('revert').onclick = () => { f = structuredClone(st.form); error = undefined; render(); };
$('apply').onclick = () => { error = undefined; vscode.postMessage({ type: 'apply', form: f }); };
$('start').onclick = () => vscode.postMessage({ type: 'start' });
$('open').onclick = () => vscode.postMessage({ type: 'open' });
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
//# sourceMappingURL=platformEditor.js.map