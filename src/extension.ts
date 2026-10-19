import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import {
	findExecutables, findToolchains, findPythonEnvs, findConda, condaSetup, venvSetup,
	xheepVerilatorVersion, verilatorPrefix, verilatorInstallCommand, veriblePrefix, veribleInstallCommand,
	toolchainUrl, toolchainInstallCommand, packageInstallCommand, devcontainerJson, xheepImageTag,
} from './tools';
import { Mode, MODES, JTAG_ADAPTERS, Adapter, boardAdapters, pickAdapter, Options, Simulator, SIM_MODEL, buildCommand, simCommand, simModelBuildCommand, FLASH_COMMAND, mcuGenCommand, simSummary, incrementalBuildCommand, verilatorRunCommand,
	DEBUG_BUILD_ROOT, debugModelBuildCommand, debugSimCommand, openocdCommand,
	XHEEP_GIT, XHEEP_COMMIT_URL, isCommit, cloneCommand, changedFiles, isGenerated, updateCommand, writeMain, projectSource, configTemplate,
	Programmer, BOARDS, BitstreamInfo, fileSha1, builtBitstream, bitstreamBuildCommand, vivadoTcl, vivadoCommand, openocdFpgaCommand,
	EXIT_BREAKPOINT, gdbRunCommand, exitCode, regValue, pickSerialPort, serialReadCommand,
	linkerScript, memoryRegions, stackSize, explainBuild, stackProblems, uartException, exceptionCause, printable,
	SETUP_GUIDE, missingModulesCommand, condaEnvName, requiredVersions, verilatorVersion, veribleVersion,
	usbDevices, udevRule, EPFL_PROGRAMMER_USB, platformScriptCommand, largestFrame } from './xheep';
import { Platform, Catalog, PlatformForm, formFromPlatform, plainMemory, hardwareFingerprint, archFor, overlayConfig, overlayHeader } from './platform';
import { EditorState, openPlatformEditor, refreshPlatformEditor } from './platformEditor';

let extensionDir: string;
let extensionId: string;
let folder: vscode.WorkspaceFolder;
/** The X-HEEP repo: the workspace itself, or `x-heep/` inside a software project. */
let root: string;
/** The sw/ dir holding the user's apps: X-HEEP's own, or the software project's. */
let swRoot: string;
let state: vscode.Memento;
let output: vscode.OutputChannel;
let uart: vscode.OutputChannel;
let appItem: vscode.StatusBarItem;
let modeItem: vscode.StatusBarItem;
let configItem: vscode.StatusBarItem;
let apps: AppsProvider;
/** Kept across workspaces: what the extension knows of bitstreams (see BitstreamInfo). */
let globalState: vscode.Memento;
/** Build problems the extension explains itself (see reportBuildProblems). */
let buildProblems: vscode.DiagnosticCollection;

const cfg = () => vscode.workspace.getConfiguration('xheep');
const examplesDir = () => path.join(root, 'sw', 'applications');
const userAppsDir = () => path.join(swRoot, 'applications');
const isProject = () => swRoot !== path.join(root, 'sw');
const currentApp = () => state.get<string>('app', 'hello_world');
const currentMode = () => state.get<Mode>('mode', 'sim');

function listDir(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}
	return fs.readdirSync(dir, { withFileTypes: true })
		.filter(d => d.isDirectory())
		.map(d => d.name)
		.sort();
}

function userApps(): string[] {
	return isProject() ? listDir(userAppsDir()) : listDir(examplesDir()).filter(a => !examples.has(a));
}

function exampleApps(): string[] {
	return isProject() ? listDir(examplesDir()) : listDir(examplesDir()).filter(a => examples.has(a));
}

/** In a software project, a user app shadows an X-HEEP example with the same name. */
const isProjectApp = (app: string) => isProject() && fs.existsSync(path.join(userAppsDir(), app));
const appDir = (app: string) => path.join(isProjectApp(app) ? userAppsDir() : examplesDir(), app);

// shortcut: an app counts as an example while git tracks it, so a committed user app moves to Examples.
let examples = new Set<string>();

function loadExamples(): Promise<void> {
	return new Promise(resolve => execFile('git', ['ls-files', '-z', '--', 'sw/applications'], { cwd: root }, (err, out) => {
		examples = new Set(err ? [] : out.split('\0').map(f => f.split('/')[2]).filter(Boolean));
		resolve();
	}));
}

const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, os.homedir());

function toolchain(): string {
	return expandHome(cfg().get<string>('riscvToolchain') || process.env.RISCV_XHEEP || '~/.riscv');
}

/** A tool's executable: its `xheep.<key>` setting (the executable or its folder), else `name` from PATH. */
function toolExe(key: string, name: string): string {
	const p = expandHome(cfg().get<string>(key, ''));
	if (!p) {
		return name;
	}
	return fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, name) : p;
}

/** Folders of the tools set in the settings, put first in PATH for every command the extension runs. */
function toolDirs(): string[] {
	return [toolExe('verilatorPath', 'verilator'), toolExe('veriblePath', 'verible-verilog-format'), toolExe('openocdPath', 'openocd'), toolExe('picocomPath', 'picocom')]
		.filter(p => path.isAbsolute(p)).map(p => path.dirname(p)).concat(path.join(toolchain(), 'bin'));
}

function findTool(suffix: string): string | undefined {
	const bin = path.join(toolchain(), 'bin');
	const name = fs.existsSync(bin) ? fs.readdirSync(bin).find(f => f.endsWith(suffix)) : undefined;
	return name && path.join(bin, name);
}

function simBuilt(sim: Simulator): boolean {
	const build = path.join(root, 'build');
	return fs.existsSync(build) && fs.readdirSync(build).some(d =>
		d.startsWith('openhwgroup.org_systems_core-v-mini-mcu_') && fs.existsSync(path.join(build, d, SIM_MODEL[sim])));
}

function options(project = currentApp(), mode = currentMode()): Options {
	const simulator = cfg().get<Simulator>('simulator', 'verilator');
	return {
		project,
		mode,
		compiler: cfg().get<string>('compiler', 'gcc'),
		board: cfg().get<string>('fpgaBoard', 'pynq-z2'),
		simulator,
		source: isProjectApp(project) ? projectSource(root, swRoot) : undefined,
		arch: state.get<string>('platformArch'),
	};
}

// --- Platform configuration -------------------------------------------------

const projectDir = () => folder.uri.fsPath;
const userConfigsDir = () => path.join(projectDir(), 'configs');

/** The active config: `xheep.mcuConfig`, looked up in the project first, then in X-HEEP. */
function configPath(): string {
	const c = cfg().get<string>('mcuConfig', 'configs/general.py');
	return [projectDir(), root].map(d => path.resolve(d, c)).find(fs.existsSync) ?? path.resolve(root, c);
}

function listConfigs(dir: string): string[] {
	return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.(py|hjson)$/.test(f) && !f.startsWith('pad_cfg')).sort() : [];
}

const fileHash = (file: string) => fs.existsSync(file) ? createHash('sha1').update(fs.readFileSync(file)).digest('hex') : 'missing';

// shortcut: only the config file itself is hashed, so edits to files it imports or an X-HEEP update need "Regenerate Platform".
function platformStamp(): string {
	const file = configPath();
	return `${file}@${fileHash(file)}`;
}

const platformReady = () => state.get('platformStamp') === platformStamp()
	&& fs.existsSync(path.join(root, 'hw', 'core-v-mini-mcu', 'include', 'core_v_mini_mcu_pkg.sv'));
const modelKey = (sim: Simulator) => `modelStamp.${sim}`;
const modelReady = (sim: Simulator) => simBuilt(sim) && state.get(modelKey(sim)) === state.get('platformStamp');

/** Runs a task in the background with a status bar spinner; the terminal only shows up when it fails. */
async function runQuiet(title: string, task: vscode.Task, silent: boolean, report = true): Promise<boolean> {
	if (silent) {
		task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, clear: true };
	}
	const code = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, () => runTask(task));
	if (code !== 0 && report) {
		vscode.window.showErrorMessage(`X-HEEP: ${title} failed.`, 'Show Log').then(pick => pick && showTaskLog(task));
	}
	return code === 0;
}

const showTaskLog = (task: vscode.Task) => vscode.window.terminals.find(t => t.name.includes(task.name))?.show();

async function generatePlatform(silent: boolean): Promise<boolean> {
	const stamp = platformStamp();
	const config = configPath();
	const ok = await runQuiet(`Generating platform (${path.basename(config)})`, makeTask('mcu-gen', mcuGenCommand(config)), silent);
	if (ok) {
		await state.update('platformStamp', stamp);
		// Apps use what the platform offers, e.g. a hardware FPU.
		const read = await readPlatform(config);
		await state.update('platformArch', 'platform' in read ? archFor(read.platform) : undefined);
	}
	return ok;
}

/** What X-HEEP's generator reads from a configuration (media/platform.py), or why it cannot. */
async function readPlatform(config: string): Promise<{ platform: Platform; catalog: Catalog } | { error: string }> {
	return platformScript('read', config);
}

async function platformScript(cmd: 'read' | 'check', config: string): Promise<any> {
	const r = await shOut(platformScriptCommand(path.join(extensionDir, 'media', 'platform.py'), cmd, config));
	try {
		const out = JSON.parse(r.out.trim().split('\n').pop() ?? '');
		return out.ok ? out : { error: out.error };
	} catch {
		return { error: r.out.trim().split('\n').slice(-3).join(' ') || 'the Python environment did not run (see the environment check)' };
	}
}

async function buildModel(sim: Simulator, silent: boolean): Promise<boolean> {
	const ok = await runQuiet(`Building ${sim} model`, makeTask(`Build ${sim} model`, simModelBuildCommand(sim)), silent);
	if (ok) {
		await state.update(modelKey(sim), state.get('platformStamp'));
	}
	return ok;
}

/** Regenerates the platform and, for simulation, the RTL model when they are out of date. */
async function prepare(o: Options): Promise<boolean> {
	if (!platformReady() && !await generatePlatform(true)) {
		return false;
	}
	return o.mode !== 'sim' || modelReady(o.simulator) || buildModel(o.simulator, true);
}

/**
 * The configuration menu: pick one, or create one as Python code or with the editor (experimental). The ones the
 * editor wrote carry a button to edit them there.
 */
async function selectConfig() {
	type Item = vscode.QuickPickItem & { run?: () => unknown; file?: string };
	const edit: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Edit in the platform editor (experimental)' };
	const configs = allConfigs();
	const items: Item[] = [];
	for (const dir of ['Project', 'X-HEEP'] as const) {
		const mine = configs.filter(c => c.dir === dir);
		if (mine.length && isProject()) {
			items.push({ label: dir, kind: vscode.QuickPickItemKind.Separator });
		}
		items.push(...mine.map(c => ({ label: c.name, description: path.relative(projectDir(), c.file), file: c.file, buttons: overlayOf(c.file) ? [edit] : [] })));
	}
	items.push({ label: '', kind: vscode.QuickPickItemKind.Separator },
		{ label: '$(add) New configuration (Python)…', detail: 'Starts from X-HEEP\'s general.py, to edit as code', run: newConfig },
		{ label: '$(beaker) New configuration with the editor…', detail: 'Experimental: a form, saved as a Python configuration', run: () => openEditor() });
	const pick = vscode.window.createQuickPick<Item>();
	pick.items = items;
	pick.placeholder = `Platform configuration (now: ${path.relative(projectDir(), configPath())})`;
	const choose = async (item: Item, editIt: boolean) => {
		pick.hide();
		if (item.run) {
			return item.run();
		}
		await cfg().update('mcuConfig', path.relative(projectDir(), item.file!), vscode.ConfigurationTarget.Workspace);
		if (editIt) {
			openEditor(item.file);
		}
	};
	pick.onDidAccept(() => pick.selectedItems[0] && choose(pick.selectedItems[0], false));
	pick.onDidTriggerItemButton(e => choose(e.item, true));
	pick.onDidHide(() => pick.dispose());
	pick.show();
}

async function newConfig() {
	const name = await vscode.window.showInputBox({
		prompt: 'Name of the new platform configuration',
		placeHolder: 'my_soc',
		validateInput: v => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? 'Use letters, digits and _ (a Python module name)'
			: fs.existsSync(path.join(userConfigsDir(), `${v}.py`)) ? 'This configuration already exists' : undefined,
	});
	if (!name) {
		return;
	}
	const file = path.join(userConfigsDir(), `${name}.py`);
	fs.mkdirSync(userConfigsDir(), { recursive: true });
	fs.writeFileSync(file, configTemplate(root, name));
	await cfg().update('mcuConfig', path.relative(projectDir(), file), vscode.ConfigurationTarget.Workspace);
	await vscode.window.showTextDocument(vscode.Uri.file(file));
}

// --- Platform editor ----------------------------------------------------------
// A form over the active configuration; Apply writes a Python overlay on top of a base configuration (platform.ts).

/**
 * What the editor is doing: editing in place a configuration it wrote (an overlay), or creating a configuration,
 * starting from the values of another one.
 */
let editorMode: { edit: string } | { from: string } = { from: '' };

const editorSource = () => 'edit' in editorMode ? editorMode.edit : editorMode.from;
const overlayOf = (file: string) => file.endsWith('.py') ? overlayHeader(readText(file)) : undefined;
/** The configuration an overlay builds on; for any other configuration, itself. */
const baseOf = (file: string) => { const h = overlayOf(file); return h ? path.resolve(path.dirname(file), h.base) : file; };

async function loadEditor(): Promise<EditorState | { error: string }> {
	const source = editorSource();
	const read = await readPlatform(source);
	if ('error' in read) {
		return { error: `X-HEEP's generator cannot read ${path.basename(source)}: ${read.error}` };
	}
	const bitstream = bitstreamFile();
	const app = appDir(currentApp());
	const appReal = fs.existsSync(app) ? fs.realpathSync(app) : app;
	const frame = largestFrame(stackUsage(), f => { try { return fs.realpathSync(f).startsWith(appReal + path.sep); } catch { return false; } });
	const rel = (f: string) => path.relative(projectDir(), f);
	return {
		mode: 'edit' in editorMode ? 'edit' : 'create',
		name: path.basename(source).replace(/\.(py|hjson)$/, ''),
		file: rel(source),
		base: rel(baseOf(source)),
		form: formFromPlatform(read.platform),
		platform: read.platform,
		memoryEditable: plainMemory(read.platform),
		catalog: read.catalog,
		bitstreamMatches: bitstream ? await bitstreamMatches(bitstream) : undefined,
		largestFrame: frame && { ...frame, app: currentApp() },
		boardRamKb: BOARDS[fpgaBoard()]?.ramKb,
		board: fpgaBoard(),
	};
}

/**
 * Writes the form as an overlay on the base: in place when editing one, else under a new name, which becomes the
 * active configuration. xheep_gen checks it first; resolves with its complaint, if any.
 */
async function applyEditor(form: PlatformForm): Promise<{ error?: string; cancelled?: boolean }> {
	const source = editorSource();
	let target = source;
	if (!('edit' in editorMode)) {
		const stem = path.basename(source).replace(/\.(py|hjson)$/, '');
		const name = await vscode.window.showInputBox({
			prompt: 'Name of the new platform configuration',
			value: `${stem}_custom`,
			validateInput: v => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? 'Use letters, digits and _ (a Python module name)'
				: fs.existsSync(path.join(userConfigsDir(), `${v}.py`)) ? 'This configuration already exists' : undefined,
		});
		if (!name) {
			return { cancelled: true };
		}
		target = path.join(userConfigsDir(), `${name}.py`);
	}
	const base = baseOf(source);
	const read = await readPlatform(base);
	if ('error' in read) {
		return { error: `cannot read ${path.basename(base)}: ${read.error}` };
	}
	const src = overlayConfig(path.basename(target, '.py'), path.relative(path.dirname(target), base),
		formFromPlatform(read.platform), form, read.catalog, plainMemory(read.platform));
	// Checked in place, as mcu-gen would build it, so its path to the base resolves the same.
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const draft = path.join(path.dirname(target), `.${path.basename(target, '.py')}.check.py`);
	fs.writeFileSync(draft, src);
	const check = await platformScript('check', draft);
	fs.rmSync(draft, { force: true });
	if (check.error) {
		return { error: check.error };
	}
	fs.writeFileSync(target, src);
	editorMode = { edit: target };
	if (target !== configPath()) {
		await cfg().update('mcuConfig', path.relative(projectDir(), target), vscode.ConfigurationTarget.Workspace);
	}
	refreshUi();
	return {};
}

/** Opens the editor: on `file` in place when it wrote it, else to create a configuration starting from it. */
function openEditor(file = configPath()) {
	editorMode = overlayOf(file) ? { edit: file } : { from: file };
	openPlatformEditor({
		load: loadEditor,
		apply: applyEditor,
		startFrom: async () => {
			const picked = await vscode.window.showQuickPick(allConfigs().map(c => ({ label: c.name, description: path.relative(projectDir(), c.file), file: c.file })),
				{ placeHolder: 'Start the new configuration from' });
			if (picked) {
				editorMode = { from: picked.file };
			}
		},
		openFile: () => vscode.window.showTextDocument(vscode.Uri.file(editorSource())),
	});
	refreshPlatformEditor(); // already open: show the new subject
}

// --- FPGA bitstream ---------------------------------------------------------
// Loading a bitstream needs no Vivado where OpenOCD reaches the FPGA (see BOARDS); building one does, so that stays optional.

const fpgaBoard = () => cfg().get<string>('fpgaBoard', 'pynq-z2');

/** The bitstream to load: `xheep.bitstream` if set, else the one built in X-HEEP for the board. */
function bitstreamFile(): string | undefined {
	const set = cfg().get<string>('bitstream', '').trim();
	if (!set) {
		return builtBitstream(root, fpgaBoard());
	}
	const file = path.resolve(projectDir(), set.replace(/^~(?=$|\/)/, os.homedir()));
	return fs.existsSync(file) ? file : undefined;
}

/** `xheep.fpgaProgrammer`; on auto OpenOCD where it reaches the board's FPGA, else Vivado. */
async function programmer(): Promise<Programmer | undefined> {
	const board = BOARDS[fpgaBoard()];
	const pick = cfg().get<string>('fpgaProgrammer', 'auto');
	if (board?.openocd && pick !== 'vivado' && await sh(`command -v '${toolExe('openocdPath', 'openocd')}'`, false)) {
		return 'openocd';
	}
	return board?.part && pick !== 'openocd' && await sh('command -v vivado') ? 'vivado' : undefined;
}

/** The bitstream this window last loaded (path and mtime): the board keeps it until it is power cycled. */
let loadedBitstream: string | undefined;
const bitstreamKey = (bitstream: string) => `${bitstream}@${fs.statSync(bitstream).mtimeMs}`;

/** Configures the FPGA with `bitstream`, or clears its configuration (undefined) to free the SPI flash pins. */
async function loadFpga(tool: Programmer, bitstream?: string): Promise<boolean> {
	const board = BOARDS[fpgaBoard()];
	let cmd: string;
	if (tool === 'openocd') {
		cmd = openocdFpgaCommand(`'${toolExe('openocdPath', 'openocd')}'`, board.openocd!, bitstream);
	} else {
		const tcl = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xheep-ide-')), 'fpga.tcl');
		fs.writeFileSync(tcl, vivadoTcl(board.part!, bitstream));
		cmd = vivadoCommand(tcl);
	}
	const title = bitstream ? `Programming the FPGA (${tool})` : `Clearing the FPGA (${tool})`;
	const ok = await runQuiet(title, makeTask(bitstream ? 'Program FPGA' : 'Clear FPGA', cmd, true), true);
	loadedBitstream = ok && bitstream ? bitstreamKey(bitstream) : undefined;
	return ok;
}

/** sha1 of bitstreams by path and mtime: a bitstream is a few MB, read once per change. */
const bitstreamShas = new Map<string, string>();

function bitstreamSha(bitstream: string): string {
	const key = `${bitstream}@${fs.statSync(bitstream).mtimeMs}`;
	if (!bitstreamShas.has(key)) {
		bitstreamShas.set(key, fileSha1(bitstream));
	}
	return bitstreamShas.get(key)!;
}

/** What the extension knows of the bitstream; undefined when it never saw it. */
function bitstreamInfo(bitstream: string): BitstreamInfo | undefined {
	return globalState.get<Record<string, BitstreamInfo>>('bitstreams', {})[bitstreamSha(bitstream)];
}

function rememberBitstream(bitstream: string, info: BitstreamInfo) {
	return globalState.update('bitstreams', { ...globalState.get('bitstreams', {}), [bitstreamSha(bitstream)]: info });
}

/** Every configuration to pick from: the project's, then X-HEEP's. */
function allConfigs(): { name: string; file: string; dir: 'Project' | 'X-HEEP' }[] {
	const of = (dir: string, kind: 'Project' | 'X-HEEP') => listConfigs(dir).map(f => ({ name: f.replace(/\.(py|hjson)$/, ''), file: path.join(dir, f), dir: kind }));
	return [...of(userConfigsDir(), isProject() ? 'Project' : 'X-HEEP'), ...(isProject() ? of(path.join(root, 'configs'), 'X-HEEP') : [])];
}

/** For a bitstream from elsewhere, asks once which configuration it was built for; Escape asks again next time. */
async function askBitstreamPlatform(bitstream: string): Promise<void> {
	const picked = await vscode.window.showQuickPick([
		...allConfigs().map(c => ({ label: c.name, description: path.relative(projectDir(), c.file), file: c.file })),
		{ label: '', kind: vscode.QuickPickItemKind.Separator, file: '' },
		{ label: 'I don\'t know', detail: 'Skip the check that apps fit this bitstream', file: '' },
	], { placeHolder: `Which platform configuration was ${path.basename(bitstream)} built for? (asked once)`, ignoreFocusOut: true });
	if (!picked) {
		return;
	}
	const read = picked.file ? await readPlatform(picked.file) : undefined;
	await rememberBitstream(bitstream, picked.file
		? { config: picked.file, hardware: read && 'platform' in read ? hardwareFingerprint(read.platform) : undefined }
		: {});
}

/**
 * Apps must be generated from the platform the bitstream was built for (memory map, peripherals): on a mismatch,
 * offers to switch back to that configuration if it is still there. True to go on.
 */
async function bitstreamFitsPlatform(bitstream: string): Promise<boolean> {
	if (await bitstreamMatches(bitstream) !== false) {
		return true;
	}
	const info = bitstreamInfo(bitstream)!;
	const back = info.config && fs.existsSync(info.config) ? info.config : undefined;
	const use = back && `Use ${path.basename(back)}`;
	const pick = await vscode.window.showWarningMessage(
		`The FPGA bitstream was built for the platform "${path.basename(info.config ?? '?')}", but the active one, "${path.basename(configPath())}", `
		+ 'has other hardware. Apps generated for it may not run correctly.', { modal: true }, ...(use ? [use] : []), 'Continue Anyway');
	if (back && pick === use) {
		await cfg().update('mcuConfig', path.relative(projectDir(), back), vscode.ConfigurationTarget.Workspace);
	}
	return !!pick;
}

/**
 * Whether the bitstream was built for the active platform's hardware; undefined when that is not known. Stack,
 * heap and the code/data split only change the linker script, so they never call for a new bitstream.
 */
async function bitstreamMatches(bitstream: string): Promise<boolean | undefined> {
	const hardware = bitstreamInfo(bitstream)?.hardware;
	if (!hardware) {
		return undefined;
	}
	const read = await readPlatform(configPath());
	return 'platform' in read ? hardware === hardwareFingerprint(read.platform) : undefined;
}

/** Bitstream and tool for the FPGA modes, after the platform check; undefined fields when there is nothing to load. */
async function fpgaSetup(): Promise<{ bitstream?: string; tool?: Programmer } | undefined> {
	const bitstream = bitstreamFile();
	if (bitstream && !bitstreamInfo(bitstream)) {
		await askBitstreamPlatform(bitstream);
	}
	if (bitstream && !await bitstreamFitsPlatform(bitstream)) {
		return undefined;
	}
	return { bitstream, tool: bitstream ? await programmer() : undefined };
}

async function programFpga() {
	const bitstream = bitstreamFile();
	if (!bitstream) {
		const pick = await vscode.window.showErrorMessage(`X-HEEP: no bitstream for ${fpgaBoard()}. Set "xheep.bitstream" to the .bit file you were given`
			+ (hasVivado ? ', or build one with Vivado.' : '.'), 'Set Bitstream', ...(hasVivado ? ['Build Bitstream'] : []));
		if (pick === 'Set Bitstream') {
			vscode.commands.executeCommand('workbench.action.openSettings', 'xheep.bitstream');
		} else if (pick) {
			buildBitstream();
		}
		return;
	}
	const tool = await programmer();
	if (!tool) {
		vscode.window.showErrorMessage(`X-HEEP: the extension cannot program the ${fpgaBoard()}`
			+ (BOARDS[fpgaBoard()]?.part ? ' without Vivado.' : '. Program it with the board\'s own tools.'));
		return;
	}
	if (!bitstreamInfo(bitstream)) {
		await askBitstreamPlatform(bitstream);
	}
	if (await bitstreamFitsPlatform(bitstream) && await loadFpga(tool, bitstream)) {
		vscode.window.showInformationMessage(`X-HEEP: FPGA programmed with ${path.basename(bitstream)}.`);
	}
}

function gitHead(): Promise<string | undefined> {
	return new Promise(resolve => execFile('git', ['rev-parse', 'HEAD'], { cwd: root }, (err, out) => resolve(err ? undefined : out.trim())));
}

/** Builds the bitstream for the active platform with Vivado (optional: only offered when Vivado is installed). */
async function buildBitstream() {
	const board = fpgaBoard();
	// The on-board USB adapter needs the Xilinx BSCAN JTAG in the bitstream.
	const bscan = !!(await jtagAdapter(false))?.bscan;
	if (!platformReady() && !await generatePlatform(false)) {
		return;
	}
	const config = configPath();
	const read = await readPlatform(config);
	const info: BitstreamInfo = {
		board, config, bscan, xheepCommit: await gitHead(), hardware: 'platform' in read ? hardwareFingerprint(read.platform) : undefined,
	};
	if (!await runQuiet(`Building the ${board} bitstream with Vivado (this takes a while)`, makeTask('Build bitstream', bitstreamBuildCommand(board, bscan)), true)) {
		return;
	}
	const bitstream = builtBitstream(root, board)!;
	await rememberBitstream(bitstream, { ...info, builtAt: new Date().toISOString() });
	const elsewhere = !!cfg().get<string>('bitstream', '').trim();
	const pick = await vscode.window.showInformationMessage(`X-HEEP: bitstream ready (${path.basename(config)}).`
		+ (elsewhere ? ' "xheep.bitstream" points to another file.' : ''), elsewhere ? 'Use the New Bitstream' : 'Program FPGA');
	if (pick === 'Use the New Bitstream') {
		await cfg().update('bitstream', undefined, vscode.ConfigurationTarget.Workspace);
	}
	if (pick) {
		programFpga();
	}
}

// --- Running make ---------------------------------------------------------

function withEnvSetup(cmd: string): string {
	const setup = cfg().get<string>('envSetup', '').trim();
	return setup ? `${setup} && ${cmd}` : cmd;
}

function taskEnv(): Record<string, string> {
	// CMake reads this env var, so every app build drops sw/build/compile_commands.json for IntelliSense.
	return {
		RISCV_XHEEP: toolchain(), CMAKE_EXPORT_COMPILE_COMMANDS: 'ON',
		PATH: [...toolDirs(), process.env.PATH ?? ''].join(path.delimiter),
	};
}

function makeTask(name: string, cmd: string, rawShell = false, env: Record<string, string> = {}): vscode.Task {
	const exec = new vscode.ShellExecution(rawShell ? cmd : withEnvSetup(cmd), {
		executable: '/bin/bash', shellArgs: ['-c'], cwd: root, env: { ...taskEnv(), ...env },
	});
	const task = new vscode.Task({ type: 'xheep', command: cmd }, folder, name, 'X-HEEP', exec, ['$xheep-gcc']);
	task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true };
	return task;
}

async function runTask(task: vscode.Task): Promise<number | undefined> {
	const execution = await vscode.tasks.executeTask(task);
	return new Promise(resolve => {
		const sub = vscode.tasks.onDidEndTaskProcess(e => {
			if (e.execution === execution) {
				sub.dispose();
				resolve(e.exitCode);
			}
		});
	});
}

function sh(cmd: string, setup = true): Promise<boolean> {
	return new Promise(resolve => execFile('/bin/bash', ['-c', setup ? withEnvSetup(cmd) : cmd],
		{ cwd: root, env: { ...process.env, ...taskEnv() } }, err => resolve(!err)));
}

// --- Commands -------------------------------------------------------------

async function selectApp(app?: string) {
	app ??= await vscode.window.showQuickPick([...userApps(), ...exampleApps()], { placeHolder: 'Select the X-HEEP application' });
	if (!app) {
		return;
	}
	await state.update('app', app);
	refreshUi();
	const main = ['main.c', 'main.cpp', 'main.S'].map(f => path.join(appDir(app), f)).find(fs.existsSync);
	if (main) {
		vscode.window.showTextDocument(vscode.Uri.file(main), { preview: true });
	}
}

async function newApp() {
	const name = await vscode.window.showInputBox({
		prompt: 'Name of the new application',
		placeHolder: 'my_app',
		validateInput: v => !/^[A-Za-z0-9_-]+$/.test(v) ? 'Use letters, digits, _ or -'
			: [...userApps(), ...exampleApps()].includes(v) ? 'An application with this name already exists' : undefined,
	});
	if (!name) {
		return;
	}
	writeMain(path.join(userAppsDir(), name), name);
	await selectApp(name);
}

async function newFile(app = currentApp()) {
	const dir = appDir(app);
	const name = await vscode.window.showInputBox({
		prompt: `New file in ${app}`,
		placeHolder: 'utils.c',
		validateInput: v => !/^[\w.-]+(\/[\w.-]+)*$/.test(v) ? 'Use letters, digits, _ . - and / for folders'
			: fs.existsSync(path.join(dir, v)) ? 'This file already exists' : undefined,
	});
	if (!name) {
		return;
	}
	// The X-HEEP CMake picks up every source and header under the app folder, so no build file to edit.
	const file = path.join(dir, name);
	const guard = path.basename(name).toUpperCase().replace(/\W/g, '_') + '_';
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, name.endsWith('.h') ? `#ifndef ${guard}\n#define ${guard}\n\n#endif // ${guard}\n` : '');
	await vscode.window.showTextDocument(vscode.Uri.file(file));
}


function addToGitignore(dir: string, entry: string) {
	const file = path.join(dir, '.gitignore');
	const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
	if (!lines.includes(entry)) {
		fs.appendFileSync(file, `${lines.length && lines[lines.length - 1] !== '' ? '\n' : ''}${entry}\n`);
	}
}

/** Runs a bash script outside the task system (works with no folder open), logging to the X-HEEP output. */
function runLogged(title: string, script: string, cwd: string): Thenable<number | null> {
	output.show(true);
	output.appendLine(`$ ${script}`);
	return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () => new Promise(resolve => {
		const proc = spawn('/bin/bash', ['-c', script], { cwd });
		proc.stdout.on('data', d => output.append(d.toString()));
		proc.stderr.on('data', d => output.append(d.toString()));
		proc.on('close', resolve);
	}));
}

/** The last X-HEEP commit the extension is known to work with: the live pin on GitHub, else the bundled one. */
async function pinnedCommit(): Promise<string | undefined> {
	try {
		const live = (await (await fetch(XHEEP_COMMIT_URL, { signal: AbortSignal.timeout(5000) })).text()).trim();
		if (isCommit(live)) {
			return live;
		}
	} catch { /* offline: fall back to the pin shipped with the extension */ }
	try {
		const bundled = fs.readFileSync(path.join(extensionDir, 'XHEEP_COMMIT'), 'utf8').trim();
		return isCommit(bundled) ? bundled : undefined;
	} catch {
		return undefined;
	}
}

/** X-HEEP is the submodule the extension added to a software project (not the user's own clone, opened or linked). */
const managedXheep = () => isProject() && !fs.lstatSync(root).isSymbolicLink()
	&& /path\s*=\s*x-heep\s*$/m.test(readText(path.join(projectDir(), '.gitmodules')));

const short = (sha?: string) => sha?.slice(0, 7) ?? '?';

/**
 * Moves the project's X-HEEP submodule to the latest commit tested with the extension, or to main. Refuses local
 * changes other than generated files (mcu-gen rewrites those in place), then makes the next build regenerate the
 * platform and the simulation model, which belong to the previous X-HEEP.
 */
async function updateXheep() {
	const head = await gitHead();
	const pin = await pinnedCommit();
	if (!managedXheep()) {
		vscode.window.showInformationMessage(`X-HEEP here is your own clone (${root}): update it with git. It is at ${short(head)}`
			+ (pin ? `; the extension is tested with ${short(pin)}.` : '.'));
		return;
	}
	const changed = changedFiles((await shOut('git status --porcelain --untracked-files=no', true)).out);
	const own = changed.filter(f => !isGenerated(root, f));
	if (own.length) {
		vscode.window.showErrorMessage(`X-HEEP has local changes: ${own.slice(0, 5).join(', ')}${own.length > 5 ? ', …' : ''}. Commit or discard them in x-heep/ first.`);
		return;
	}
	const picked = await vscode.window.showQuickPick([
		...(pin ? [{ label: `Latest tested commit (${short(pin)})`, description: pin === head ? 'current' : 'recommended', detail: 'The newest X-HEEP the extension is known to work with', ref: pin }] : []),
		{ label: 'main', description: 'untested', detail: 'The newest X-HEEP: it may not work with this version of the extension yet', ref: 'main' },
	], { placeHolder: `Update X-HEEP (now at ${short(head)})` });
	if (!picked || !await runQuiet('Updating X-HEEP', makeTask('Update X-HEEP', updateCommand(picked.ref, changed), true), true)) {
		return;
	}
	// The generated platform, the models and the CMake tree come from the previous X-HEEP.
	for (const key of ['platformStamp', 'modelStamp.verilator', 'modelStamp.questasim', 'modelStamp.debug', 'lastBuildKey']) {
		await state.update(key, undefined);
	}
	await state.update('xheepOnMain', picked.ref === 'main');
	apps.refresh();
	refreshUi();
	const bitstream = bitstreamFile();
	vscode.window.showInformationMessage(`X-HEEP is now at ${short(await gitHead())}. The next build regenerates the platform and the simulation model.`
		+ ' Commit x-heep in your project to keep this version.'
		+ (bitstream?.startsWith(root + path.sep) ? ' Rebuild the FPGA bitstream too if your app needs the new hardware.' : ''));
}

/** Sets up a software project in a chosen folder: own apps in sw/applications, X-HEEP in x-heep/. */
async function newProject() {
	const ws = vscode.workspace.workspaceFolders?.[0];
	const dir = (await vscode.window.showOpenDialog({
		canSelectFolders: true, canSelectFiles: false, defaultUri: ws?.uri,
		title: 'Folder of the new software project (an empty one is fine)', openLabel: 'Create Project Here',
	}))?.[0]?.fsPath;
	if (!dir) {
		return;
	}
	if (isXheep(dir)) {
		vscode.window.showErrorMessage('This is the X-HEEP repository itself: pick the folder of your own project.');
		return;
	}
	const xheep = path.join(dir, 'x-heep');
	if (fs.existsSync(xheep) && !isXheep(xheep)) {
		vscode.window.showErrorMessage(`${xheep} exists but is not an X-HEEP repository. Remove it and run this command again.`);
		return;
	}
	if (!fs.existsSync(xheep)) {
		const how = await vscode.window.showQuickPick([
			{ id: 'submodule', label: 'Add X-HEEP as a git submodule', detail: `Clones ${XHEEP_GIT} into x-heep/ at the latest commit this extension is tested with` },
			{ id: 'link', label: 'Link an existing X-HEEP clone', detail: 'Symlinks x-heep/ to a clone you already have (kept out of git)' },
		], { placeHolder: 'Where does X-HEEP come from?' });
		if (!how) {
			return;
		}
		if (how.id === 'link') {
			const src = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use this X-HEEP' }))?.[0]?.fsPath;
			if (!src) {
				return;
			}
			if (!fs.existsSync(path.join(src, 'util', 'xheep_gen', 'mcu_gen.py'))) {
				vscode.window.showErrorMessage(`${src} is not an X-HEEP repository.`);
				return;
			}
			fs.symlinkSync(src, xheep);
			addToGitignore(dir, 'x-heep');
		} else {
			const commit = await pinnedCommit();
			output.appendLine(commit ? `X-HEEP commit known to work with this extension: ${commit}` : 'No pinned X-HEEP commit found: using the latest main.');
			const code = await runLogged('Cloning X-HEEP…', cloneCommand(XHEEP_GIT, commit), dir);
			if (code !== 0) {
				vscode.window.showErrorMessage('Cloning X-HEEP failed, see the X-HEEP output. Nothing was left behind: you can retry.');
				return;
			}
		}
	}
	const hello = path.join(dir, 'sw', 'applications', 'hello');
	if (!fs.existsSync(hello)) {
		writeMain(hello, 'hello');
	}
	// Recreated before each build (see projectSource), so it stays out of git.
	addToGitignore(dir, 'sw/device');
	await (ws?.uri.fsPath === dir
		? vscode.commands.executeCommand('workbench.action.reloadWindow')
		: vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir)));
}

/** A known adapter, or a custom OpenOCD config set in `xheep.openocdConfig`. */
type JtagAdapter = Pick<Adapter, 'label' | 'config'> & Partial<Adapter>;

/** The JTAG adapter last used or found, for the status bar. */
let lastAdapter: JtagAdapter | undefined;

/**
 * The JTAG adapter for the FPGA: `xheep.openocdConfig` when set, else the one plugged in among those fitting the
 * board and the bitstream. When that is not clear, asks if `ask` (and remembers the answer in the setting).
 */
async function jtagAdapter(ask: boolean): Promise<JtagAdapter | undefined> {
	const remember = (a?: JtagAdapter) => { lastAdapter = a ?? lastAdapter; return a; };
	const set = cfg().get<string>('openocdConfig', '').trim();
	if (set) {
		return remember(JTAG_ADAPTERS.find(a => a.config === set) ?? { label: path.basename(set), config: set });
	}
	const bitstream = bitstreamFile();
	const plugged = new Set(usbDevices().map(d => `${d.vid}:${d.pid}`));
	const { adapter, choices } = pickAdapter(boardAdapters(fpgaBoard(), bitstream ? bitstreamInfo(bitstream)?.bscan : undefined), usb => plugged.has(usb));
	if (adapter || !ask) {
		return remember(adapter);
	}
	const picked = await vscode.window.showQuickPick(choices.map(a => ({ label: a.label, detail: a.detail, adapter: a })),
		{ placeHolder: 'Which JTAG adapter connects to X-HEEP?' });
	if (picked) {
		await cfg().update('openocdConfig', picked.adapter.config, vscode.ConfigurationTarget.Workspace);
	}
	return remember(picked?.adapter);
}

/** Picks the run mode; `mode` (e.g. from a keybinding's args) skips the pick. */
async function selectMode(mode?: Mode) {
	const picked = mode && MODES[mode] ? { id: mode } : await vscode.window.showQuickPick(
		(Object.keys(MODES) as Mode[]).map(id => ({ id, label: MODES[id].label, detail: MODES[id].detail })), { placeHolder: 'How should the app run?' });
	if (picked) {
		await state.update('mode', picked.id);
		refreshUi();
		// The FPGA modes need hardware the simulation does not: say now if something is missing.
		if (picked.id !== 'sim') {
			checkEnv(true);
		}
	}
}

type BuildStatus = 'ok' | 'fail' | 'running';
const buildStatus = (app: string) => state.get<Record<string, BuildStatus>>('buildStatus', {})[app];

async function setBuildStatus(app: string, status: BuildStatus) {
	await state.update('buildStatus', { ...state.get('buildStatus', {}), [app]: status });
	refreshUi();
}

function listFiles(dir: string): string[] {
	return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter(e => e.isFile()).map(e => path.relative(dir, path.join(e.parentPath, e.name))).sort() : [];
}

/** Compiles the app quietly: the result shows as a tick or cross, the terminal only on failure. */
async function compile(o: Options): Promise<boolean> {
	await setBuildStatus(o.project, 'running');
	// CMake globs the sources at configure time, so a new or removed file needs the full `make app`.
	const key = JSON.stringify([buildCommand(o), state.get('platformStamp'), listFiles(appDir(o.project))]);
	const jobs = os.cpus().length;
	const incremental = state.get('lastBuildKey') === key && fs.existsSync(path.join(root, 'sw', 'build', 'Makefile'));
	// The log is kept to explain what the problem matcher cannot (see reportBuildProblems).
	const logged = (cmd: string) => `set -o pipefail; { ${cmd}; } 2>&1 | tee '${buildLog()}'`;
	const task = incremental
		? makeTask(`Build ${o.project}`, logged(incrementalBuildCommand(jobs)), true)
		: makeTask(`Build ${o.project}`, logged(withEnvSetup(buildCommand(o))), true, { MAKEFLAGS: `-j${jobs}` });
	buildProblems.clear();
	const ok = await runQuiet(`Build of ${o.project}`, task, true, false);
	// A compile error keeps the configured tree valid; a failed full build may leave it half done.
	await state.update('lastBuildKey', ok || incremental ? key : undefined);
	await setBuildStatus(o.project, ok ? 'ok' : 'fail');
	const explained = reportBuildProblems(o, ok);
	if (!ok) {
		vscode.window.showErrorMessage(`X-HEEP: build of ${o.project} failed.${explained ? ` ${explained}` : ''}`,
			...(explained ? ['Show Problems'] : []), 'Show Log').then(pick => pick === 'Show Problems'
			? vscode.commands.executeCommand('workbench.actions.view.problems') : pick && showTaskLog(task));
	}
	return ok;
}

const buildLog = () => path.join(os.tmpdir(), `xheep-ide-build-${process.pid}.log`);
const readText = (file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

/** GCC's stack usage files (-fstack-usage) of the last build, concatenated. */
function stackUsage(): string {
	const dir = path.join(root, 'sw', 'build', 'CMakeFiles', 'main.elf.dir');
	return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter(e => e.isFile() && e.name.endsWith('.su')).map(e => readText(path.join(e.parentPath, e.name))).join('') : '';
}

/**
 * Puts in the Problems panel what a newcomer needs and the problem matcher misses: linker failures explained
 * (memory overflow, functions that need an OS) and functions too big for X-HEEP's stack. Returns the first
 * error's explanation, for the failure message.
 */
function reportBuildProblems(o: Options, ok: boolean): string | undefined {
	const app = appDir(o.project);
	const appReal = fs.realpathSync(app);
	const isAppFile = (file: string) => { try { return fs.realpathSync(file).startsWith(appReal + path.sep); } catch { return false; } };
	const ld = readText(path.join(root, 'sw', 'linker', linkerScript(o.mode)));
	const stack = stackSize(ld);
	const problems = [
		...(ok ? [] : explainBuild(readText(buildLog()), memoryRegions(ld), isAppFile)),
		...(stack ? stackProblems(stackUsage(), stack, isAppFile) : []),
	];
	// Whole-app problems (memory) go on the app's main file.
	const main = ['main.c', 'main.cpp', 'main.S'].map(f => path.join(app, f)).find(fs.existsSync) ?? path.join(app, 'main.c');
	const byFile = new Map<string, vscode.Diagnostic[]>();
	for (const p of problems) {
		const line = Math.max((p.line ?? 1) - 1, 0);
		const d = new vscode.Diagnostic(new vscode.Range(line, Math.max((p.column ?? 1) - 1, 0), line, 1000), p.message,
			{ error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information }[p.severity]);
		d.source = 'X-HEEP';
		const file = p.file ?? main;
		byFile.set(file, [...byFile.get(file) ?? [], d]);
	}
	byFile.forEach((ds, file) => buildProblems.set(vscode.Uri.file(file), ds));
	return problems.find(p => p.severity === 'error')?.message;
}

async function build(app?: string) {
	const o = options(app);
	// No RTL model needed just to compile.
	return await prepare({ ...o, mode: o.mode === 'sim' ? 'fpga-jtag' : o.mode }) && compile(o);
}

function simDir(sim: Simulator): string | undefined {
	const build = path.join(root, 'build');
	const core = fs.existsSync(build) ? fs.readdirSync(build).find(d => d.startsWith('openhwgroup.org_systems_core-v-mini-mcu_')) : undefined;
	return core && path.join(build, core, path.dirname(SIM_MODEL[sim]));
}

/** Whether "X-HEEP UART" ends with a newline: program output may stop mid-line (e.g. halted in a handler). */
let uartAtLineStart = true;

function uartAppend(text: string) {
	if (text) {
		uart.append(text);
		uartAtLineStart = text.endsWith('\n');
	}
}

/** Closes a run in "X-HEEP UART" with its result line, on a line of its own, and a blank line. */
function uartClose(line: string) {
	uart.appendLine(`${uartAtLineStart ? '' : '\n'}── ${line}`);
	uart.appendLine('');
	uartAtLineStart = true;
}

/** Streams a simulator's UART log into "X-HEEP UART" under a header; the returned function flushes and stops. */
function tailUart(uartLog: string, title: string, onText: (text: string) => void = () => { }): () => void {
	fs.rmSync(uartLog, { force: true }); // else the first poll would replay the previous run
	let offset = 0;
	const pump = () => {
		const size = fs.existsSync(uartLog) ? fs.statSync(uartLog).size : 0;
		if (size > offset) {
			const fd = fs.openSync(uartLog, 'r');
			const buf = Buffer.alloc(size - offset);
			fs.readSync(fd, buf, 0, buf.length, offset);
			fs.closeSync(fd);
			const text = printable(buf.toString());
			uartAppend(text);
			onText(text);
			offset = size;
		}
	};
	uart.appendLine(`${uartAtLineStart ? '' : '\n'}── ${title} · ${new Date().toLocaleTimeString()} ${'─'.repeat(30)}`);
	uartAtLineStart = true;
	uart.show(true);
	const poll = setInterval(pump, 250);
	return () => { clearInterval(poll); pump(); };
}

/** Starts a shell command in its own process group with its output logged to "X-HEEP". */
function startJob(cmd: string, cwd: string, env: Record<string, string> = {}) {
	output.appendLine(`\n$ ${cmd}`);
	const proc = spawn('/bin/bash', ['-c', cmd], { cwd, env: { ...process.env, ...taskEnv(), ...env }, detached: true });
	let log = '';
	const onData = (d: Buffer) => { log += d; output.append(d.toString()); };
	proc.stdout.on('data', onData);
	proc.stderr.on('data', onData);
	return {
		log: () => log,
		done: new Promise<number | null>(resolve => proc.on('close', resolve)),
		// detached: the negative pid also stops what the shell started (make, fusesoc, the simulator).
		kill: () => { try { process.kill(-proc.pid!, 'SIGTERM'); } catch { /* already gone */ } },
	};
}

/** Sends a command to OpenOCD's Tcl server (port 6666); resolves with its reply, '' if unreachable. */
function openocdTcl(cmd: string): Promise<string> {
	return new Promise(resolve => {
		let reply = '';
		const sock = net.connect(6666, 'localhost', () => sock.write(`${cmd}\x1a`));
		sock.setTimeout(10_000, () => sock.destroy());
		sock.on('data', d => {
			reply += d;
			if (reply.includes('\x1a')) {
				sock.end();
			}
		});
		sock.on('close', () => resolve(reply.replace('\x1a', '')));
		sock.on('error', () => { /* reported by 'close' with what came so far */ });
	});
}

/** Polls `test` until it holds (true), the timeout passes or `abort` settles (false). */
async function waitUntil(test: () => boolean, timeoutMs: number, abort?: Promise<unknown>): Promise<boolean> {
	let aborted = false;
	abort?.then(() => { aborted = true; });
	for (const end = Date.now() + timeoutMs; Date.now() < end && !aborted; await new Promise(r => setTimeout(r, 250))) {
		if (test()) {
			return true;
		}
	}
	return test();
}

/** Runs the simulation in the background: its log goes to "X-HEEP", only the app's UART to "X-HEEP UART". */
async function simulate(o: Options): Promise<{ ok: boolean; text: string } | undefined> {
	// shortcut: Questasim's UART log is assumed to be uart0.log in sim-modelsim/ like Verilator's, unverified.
	const dir = simDir(o.simulator);
	let job: Job | undefined;
	let seen = '';
	let exception: string | undefined;
	// After an exception X-HEEP spins in its handler and the simulation would never end.
	const stopUart = tailUart(dir ? path.join(dir, 'uart0.log') : '', o.project, text => {
		seen += text;
		exception ??= uartException(seen);
		if (exception) {
			job?.kill();
		}
	});
	job = startJob(o.simulator === 'verilator' && dir ? verilatorRunCommand(dir) : withEnvSetup(simCommand(o)), root);
	const sim = job;
	const code = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Simulating ${o.project}…`, cancellable: true },
		(_progress, token) => { token.onCancellationRequested(sim.kill); return sim.done; });
	stopUart();
	const summary = exception ? { ok: false, text: `exception: ${exception}` } : simSummary(sim.log());
	const stopped = code === null && !exception;
	uartClose(stopped ? 'stopped' : `${summary.ok ? '✓' : '✗'} ${summary.text}`);
	if (exception) {
		vscode.window.showWarningMessage(`X-HEEP: ${o.project} hit an exception (${exception}) and stopped. Run it in Debug to see where.`);
	} else if (!stopped && summary.text.startsWith('memory access outside')) {
		vscode.window.showWarningMessage(`X-HEEP: ${o.project} accessed an address outside X-HEEP's memory map. `
			+ 'This is usually a NULL or wrong pointer, e.g. after a failed fopen or malloc, or a register address from another board.');
	} else if (!stopped && summary.text === 'simulation failed') {
		vscode.window.showErrorMessage(`X-HEEP: simulation of ${o.project} failed.`, 'Show Log').then(pick => pick && output.show());
	}
	return stopped ? undefined : summary;
}

/** Runs the app in the current mode; for simulation and JTAG, resolves with the result shown in "X-HEEP UART". */
async function run(app?: string): Promise<{ ok: boolean; text: string } | undefined> {
	const o = options(app);
	// Before prepare: the platform check may switch the configuration.
	const fpga = o.mode !== 'sim' ? await fpgaSetup() : {};
	if (!fpga || !await prepare(o) || !await compile(o)) {
		return;
	}
	switch (o.mode) {
		case 'sim':
			return simulate(o);
		case 'fpga-jtag':
			return runJtag(o, fpga);
		case 'fpga-flash':
			await flash(o, fpga);
			return;
	}
}

/**
 * Programs the app into the SPI flash. With a bitstream to load, the FPGA is cleared first (a configured X-HEEP
 * drives the flash pins too) and reloaded after, so X-HEEP boots the new app straight away.
 */
async function flash(o: Options, { bitstream, tool }: { bitstream?: string; tool?: Programmer }) {
	if (bitstream && tool && !await loadFpga(tool)) {
		return;
	}
	if (await runTask(makeTask(`Flash ${o.project}`, FLASH_COMMAND)) !== 0) {
		return;
	}
	// Before X-HEEP boots, so its first output is not lost. No end to wait for here: it streams until the next run.
	await streamSerial(`${o.project} · from flash`);
	if (!bitstream || !tool) {
		vscode.window.showInformationMessage('Flash programmed. Press RESET on the FPGA to start the program.'
			+ (bitstream ? '' : ' Set "xheep.bitstream" to have the FPGA restarted for you.'));
	} else if (await loadFpga(tool, bitstream)) {
		vscode.window.showInformationMessage(`X-HEEP: ${o.project} is booting from flash (the boot select switch must be set to flash).`);
	}
}

type Job = ReturnType<typeof startJob>;

/**
 * Gets OpenOCD talking to X-HEEP on the board: loads the bitstream if this window has not yet, reloads it once
 * when OpenOCD cannot reach the debug module, then resets X-HEEP. The OpenOCD job is pushed to `jobs`.
 */
async function connectFpga({ bitstream, tool }: { bitstream?: string; tool?: Programmer }, jobs: Job[], cancelled: () => boolean): Promise<boolean> {
	const adapter = await jtagAdapter(true);
	if (!adapter) {
		return false; // no adapter picked
	}
	refreshUi();
	const reload = bitstream && tool ? () => loadFpga(tool, bitstream) : undefined;
	// What the board holds is unknown until this window loads it once.
	if (reload && loadedBitstream !== bitstreamKey(bitstream!) && !await reload()) {
		return false; // reported by loadFpga
	}
	const openocd = toolExe('openocdPath', 'openocd');
	/** 'ok', or 'no-dm' when OpenOCD (which opens the GDB port anyway) cannot reach the RISC-V debug module. */
	const connect = async () => {
		const ocd = startJob(openocdCommand(openocd, path.resolve(root, adapter.config)), root);
		jobs.push(ocd);
		const up = await waitUntil(() => ocd.log().includes('Listening on port 3333'), 20_000, ocd.done);
		return !up ? 'down' : /examination failed|dtmcontrol is 0/.test(ocd.log()) ? 'no-dm' : 'ok';
	};
	let link = await connect();
	// An unconfigured FPGA (power cycled) or another bitstream: reload it once and retry.
	if (link === 'no-dm' && reload && !cancelled()) {
		const stale = jobs.pop()!;
		stale.kill();
		await stale.done;
		link = await reload() ? await connect() : 'down';
	}
	if (cancelled()) {
		return false;
	}
	if (link !== 'ok') {
		const bscan = adapter.bscan;
		vscode.window.showErrorMessage(link === 'down' ? `X-HEEP: OpenOCD did not come up: is the ${adapter.label} connected?`
			: 'X-HEEP: OpenOCD sees the JTAG chain but not the X-HEEP debug module. ' + (bscan
				? 'The on-board USB adapter needs a bitstream built with FUSESOC_FLAGS=--flag=use_bscane_xilinx; to use an external adapter, plug it in or set "xheep.openocdConfig".'
				: reload ? 'Check that the JTAG adapter is wired to X-HEEP.'
					: 'Check that the bitstream is loaded (set "xheep.bitstream" to have it loaded for you) and the JTAG adapter is wired to X-HEEP.'),
		'Show Log').then(pick => pick && output.show());
		return false;
	}
	// ndmreset: every run starts from a fresh X-HEEP, also when the hart hung on a bus access and no longer halts.
	await openocdTcl('reset halt');
	return true;
}

/** A code address as `function (file:line)`, through addr2line; undefined when the ELF has nothing there. */
async function locate(elf: string, addr: number): Promise<{ fn: string; text: string } | undefined> {
	const addr2line = findTool('-elf-addr2line');
	if (!addr2line) {
		return undefined;
	}
	const out = await new Promise<string>(resolve => execFile(addr2line, ['-f', '-s', '-e', elf, `0x${addr.toString(16)}`], (err, o) => resolve(err ? '' : o)));
	const [fn, line] = out.trim().replace(/ \(discriminator \d+\)$/, '').split('\n');
	return fn && fn !== '??' ? { fn, text: `${fn}${line && !line.startsWith('??') ? ` (${line})` : ''}` } : undefined;
}

/** The exception X-HEEP is handling (halted), with where it happened: `illegal instruction in main (main.c:5)`. */
async function exceptionSite(elf: string): Promise<string> {
	const cause = regValue(await openocdTcl('reg mcause'), 'mcause');
	const epc = regValue(await openocdTcl('reg mepc'), 'mepc');
	const at = epc === undefined ? undefined : await locate(elf, epc);
	return `${cause === undefined ? 'exception' : exceptionCause(cause)}${at ? ` in ${at.text}` : ''}`;
}

/** X-HEEP's exception handlers (sw/device/lib/runtime/handler.c), where a faulting program ends up spinning. */
const EXCEPTION_HANDLER = /^(print_exc_msg|handler_exception|handler_\w+_fault|handler_bkpt|handler_ecall)$/;

/**
 * Where a program stopped with Cancel is: halts X-HEEP and maps its pc to a function and line, or to the
 * exception it is stuck in. When the hart does not halt, it hangs on a bus access nobody answers; it is then
 * reset, so the next run needs no bitstream reload.
 */
async function whereStopped(elf: string): Promise<{ text: string; hung: boolean }> {
	await openocdTcl('halt');
	const pc = regValue(await openocdTcl('reg pc'));
	if (pc === undefined) {
		await openocdTcl('reset halt');
		return { text: 'X-HEEP was stuck on a memory access nobody answers', hung: true };
	}
	const at = await locate(elf, pc);
	if (at && EXCEPTION_HANDLER.test(at.fn)) {
		return { text: `exception: ${await exceptionSite(elf)}`, hung: false };
	}
	if (at?.fn === 'vector_table') {
		// A NULL pointer write lands at address 0: the vector table, which then sends every trap astray.
		return { text: 'stuck in the interrupt vector table at address 0, probably overwritten through a NULL pointer '
			+ '(e.g. a failed malloc) or by a stack overflow', hung: false };
	}
	return { text: at ? `stopped in ${at.text}` : `stopped at pc 0x${pc.toString(16)}`, hung: false };
}

/** Runs the app on the FPGA over JTAG without the debugger UI, like a simulation: UART in "X-HEEP UART", then the exit code. */
async function runJtag(o: Options, fpga: { bitstream?: string; tool?: Programmer }): Promise<{ ok: boolean; text: string } | undefined> {
	const gdb = findTool('-elf-gdb');
	if (!gdb) {
		vscode.window.showErrorMessage(`No *-elf-gdb found in ${toolchain()}/bin. Set "xheep.riscvToolchain".`);
		return;
	}
	const elf = path.join(root, 'sw', 'build', 'main.elf');
	const jobs: Job[] = [];
	let gdbJob: Job | undefined;
	let stopUart: (() => void) | undefined;
	let cancelled = false;
	let seen = '';
	let exception: string | undefined;
	const code = await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification, cancellable: true, title: `Running ${o.project} on the FPGA`,
	}, async (progress, token) => {
		// Once the program runs, OpenOCD stays up a moment longer to tell where it was.
		token.onCancellationRequested(() => { cancelled = true; (gdbJob ? [gdbJob] : jobs).forEach(j => j.kill()); });
		progress.report({ message: 'connecting over JTAG…' });
		if (!await connectFpga(fpga, jobs, () => cancelled)) {
			return undefined;
		}
		// After an exception X-HEEP spins in its handler and would never reach _exit: stop and say where it was.
		stopUart = await streamSerial(o.project, text => {
			seen += text;
			exception ??= uartException(seen);
			if (exception) {
				gdbJob?.kill();
			}
		});
		progress.report({ message: 'running…' });
		gdbJob = startJob(gdbRunCommand(gdb, elf), root);
		jobs.push(gdbJob);
		// Nothing tells a long computation from a hang: after a while, say how to find out.
		const start = Date.now();
		const tick = setInterval(() => {
			const s = Math.round((Date.now() - start) / 1000);
			if (s >= 20) {
				progress.report({ message: `still running after ${s} s · Cancel stops it and shows where it is` });
			}
		}, 5000);
		await gdbJob.done;
		clearInterval(tick);
		return exitCode(gdbJob.log());
	});
	const where = cancelled && gdbJob ? await whereStopped(elf) : undefined;
	// The handler is still printing its message (mtval): let it finish before halting.
	const site = exception && !cancelled ? (await new Promise(r => setTimeout(r, 500)), await openocdTcl('halt'), await exceptionSite(elf)) : undefined;
	jobs.forEach(j => j.kill());
	if (!stopUart) {
		return; // never got to run: reported already, or cancelled
	}
	await new Promise(r => setTimeout(r, 300)); // the last UART bytes
	stopUart();
	const result = cancelled ? undefined : site ? { ok: false, text: `exception: ${site}` }
		: code === undefined ? { ok: false, text: 'the program did not reach exit' } : { ok: code === 0, text: `exit ${code}` };
	uartClose(result ? `${result.ok ? '✓' : '✗'} ${result.text}` : `stopped${where ? `: ${where.text}` : ''}`);
	if (where?.hung) {
		vscode.window.showWarningMessage(`X-HEEP: ${o.project} was stuck on a memory access nobody answers. Typical causes: a NULL or `
			+ 'wrong pointer (e.g. after a failed fopen or malloc), a stack overflow, a register address from another board, or a '
			+ 'peripheral this bitstream does not have (e.g. one that only exists in the simulation testbench).');
	} else if (site) {
		vscode.window.showWarningMessage(`X-HEEP: ${o.project} hit an exception: ${site}.`);
	} else if (result && code === undefined) {
		vscode.window.showErrorMessage(`X-HEEP: ${o.project} did not run to the end on the FPGA.`, 'Show Log').then(pick => pick && output.show());
	}
	return result;
}

const debugSimDir = () => path.join(root, DEBUG_BUILD_ROOT, 'sim-verilator');
const debugModelReady = () => fs.existsSync(path.join(debugSimDir(), 'Vtestharness'))
	&& state.get('modelStamp.debug') === state.get('platformStamp');

async function buildDebugModel(): Promise<boolean> {
	const ok = await runQuiet('Building verilator debug model', makeTask('Build debug model', debugModelBuildCommand()), true);
	if (ok) {
		await state.update('modelStamp.debug', state.get('platformStamp'));
	}
	return ok;
}

/** Debug sessions to end when the program reaches `_exit`, by session name, with what to do with the exit code. */
const exitWatchers = new Map<string, (code: number) => void>();

/** Ends an X-HEEP debug session when it stops at `_exit` (EXIT_BREAKPOINT), as the simulator does on its own. */
function exitTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker | undefined {
	const onExit = exitWatchers.get(session.name);
	return onExit && {
		onDidSendMessage: async (m: { type?: string; event?: string; body?: { threadId?: number } }) => {
			if (m.type !== 'event' || m.event !== 'stopped') {
				return;
			}
			try {
				const top = (await session.customRequest('stackTrace', { threadId: m.body?.threadId, startFrame: 0, levels: 1 })).stackFrames?.[0];
				if (!top?.name?.startsWith('_exit')) {
					return;
				}
				const a0 = await session.customRequest('evaluate', { expression: '$a0', frameId: top.id, context: 'watch' });
				onExit(Number(a0.result));
				vscode.debug.stopDebugging(session);
			} catch { /* the session went away meanwhile */ }
		},
	};
}

/**
 * Debugs the app with the VS Code debugger (cppdbg + GDB) through OpenOCD: on the simulated X-HEEP
 * in Simulation mode, on the FPGA board otherwise. The extension owns OpenOCD and the simulator,
 * and stops them when the debug session ends, at the latest when the program reaches `_exit`.
 */
async function debug(app?: string) {
	const sim = currentMode() === 'sim';
	const o = options(app, sim ? 'sim' : 'fpga-jtag');
	const gdb = findTool('-elf-gdb');
	if (!gdb) {
		vscode.window.showErrorMessage(`No *-elf-gdb found in ${toolchain()}/bin. Set "xheep.riscvToolchain".`);
		return;
	}
	// Before prepare: the platform check may switch the configuration.
	const fpga = sim ? {} : await fpgaSetup();
	// Platform only: simulation debugging uses its own JTAG-enabled model, not the regular one.
	if (!fpga || !await prepare({ ...o, mode: 'fpga-jtag' }) || !await compile(o) || (sim && !debugModelReady() && !await buildDebugModel())) {
		return;
	}
	const openocd = toolExe('openocdPath', 'openocd');
	const jobs: Job[] = [];
	let stopUart = () => { };
	let cancelled = false;
	const cleanup = () => { jobs.forEach(j => j.kill()); stopUart(); };
	const ready = await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification, cancellable: true,
		title: sim ? `Starting the simulated X-HEEP for ${o.project}…` : 'Connecting to the FPGA over JTAG…',
	}, async (_progress, token) => {
		token.onCancellationRequested(() => { cancelled = true; cleanup(); });
		if (!sim) {
			if (!await connectFpga(fpga, jobs, () => cancelled)) {
				cancelled = true; // reported by connectFpga
				return false;
			}
			stopUart = await streamSerial(`${o.project} · debug`);
			return true;
		}
		const dir = debugSimDir();
		stopUart = tailUart(path.join(dir, 'uart0.log'), `${o.project} · debug`);
		const simJob = startJob(debugSimCommand(dir, path.join(root, 'sw', 'build', 'main.hex')), dir);
		jobs.push(simJob);
		// The bitbang server accepts a single client, so wait for its banner instead of probing the port.
		if (!await waitUntil(() => simJob.log().includes('Listening on port 4567'), 30_000, simJob.done)) {
			return false;
		}
		const ocdLog = path.join(dir, 'openocd.log'); // tb/core-v-mini-mcu.cfg logs there, not to stderr
		fs.rmSync(ocdLog, { force: true });
		const ocd = startJob(openocdCommand(openocd, path.join(root, 'tb', 'core-v-mini-mcu.cfg')), dir, { JTAG_VPI_PORT: '4567' });
		jobs.push(ocd);
		return waitUntil(() => fs.existsSync(ocdLog) && fs.readFileSync(ocdLog, 'utf8').includes('Listening on port 3333'), 60_000, ocd.done);
	});
	if (!ready) {
		cleanup();
		if (!cancelled) {
			vscode.window.showErrorMessage('X-HEEP: OpenOCD did not come up.', 'Show Log').then(pick => pick && output.show());
		}
		return;
	}
	const name = `X-HEEP: ${o.project}`;
	let exit: number | undefined;
	exitWatchers.set(name, code => { exit = code; });
	const ended = vscode.debug.onDidTerminateDebugSession(s => {
		if (s.name === name) {
			ended.dispose();
			exitWatchers.delete(name);
			cleanup();
			const summary = exit !== undefined ? { ok: exit === 0, text: `exit ${exit}` } : sim ? simSummary(jobs[0].log()) : undefined;
			uartClose(!summary || summary.text === 'simulation failed' ? 'debug session ended' : `${summary.ok ? '✓' : '✗'} ${summary.text}`);
		}
	});
	// When the simulator (or OpenOCD) stops, end the session with it.
	jobs[0].done.then(() => {
		const session = vscode.debug.activeDebugSession;
		if (session?.name === name) {
			vscode.debug.stopDebugging(session);
		}
	});
	const started = await vscode.debug.startDebugging(folder, {
		name,
		type: 'cppdbg',
		request: 'launch',
		program: path.join(root, 'sw', 'build', 'main.elf'),
		cwd: root,
		MIMode: 'gdb',
		miDebuggerPath: gdb,
		miDebuggerArgs: '-q', // no GDB banner in the Debug Console
		// cppdbg fails on GDB's "riscv:rv32" ('arch' out of range); any 32-bit value skips that detection.
		targetArchitecture: 'arm',
		// Exactly sw/gdbInit: cppdbg's own remote launch uses plain `target remote` and its own steps.
		// Breakpoints set in the editor are inserted after these commands, before the final continue.
		setupCommands: [{ text: 'set remotetimeout 2000' }],
		// With custom launch commands cppdbg no longer loads the ELF into GDB itself, hence `file`.
		customLaunchSetupCommands: [
			{ text: `file '${path.join(root, 'sw', 'build', 'main.elf')}'` },
			{ text: 'target extended-remote :3333' },
			{ text: 'load' },
			// Not in the Breakpoints view: exitTracker ends the session there.
			{ text: EXIT_BREAKPOINT },
		],
		launchCompleteCommand: 'exec-continue',
	});
	if (!started) {
		ended.dispose();
		exitWatchers.delete(name);
		cleanup();
	}
}

function serialCandidates(): string[] {
	const byId = '/dev/serial/by-id';
	return [
		...(fs.existsSync(byId) ? fs.readdirSync(byId).map(f => path.join(byId, f)) : []),
		...fs.readdirSync('/dev').filter(f => /^(tty\.usbserial|ttyUSB)/.test(f)).map(f => path.join('/dev', f)),
	];
}

/** `xheep.serialPort`, else the X-HEEP UART if connected (see pickSerialPort), else the user's pick (then saved). */
async function serialPort(): Promise<string | undefined> {
	const set = cfg().get<string>('serialPort', '');
	if (set && fs.existsSync(set)) {
		return set;
	}
	const candidates = serialCandidates();
	const auto = pickSerialPort(candidates);
	if (auto || !candidates.length) {
		if (!auto) {
			vscode.window.showWarningMessage('No serial port found: connect the FPGA UART or set "xheep.serialPort".');
		}
		return auto;
	}
	const port = await vscode.window.showQuickPick(candidates, { placeHolder: 'Select the X-HEEP UART port' });
	if (port) {
		await cfg().update('serialPort', port, vscode.ConfigurationTarget.Workspace);
	}
	return port;
}

/** The serial port reader feeding "X-HEEP UART" (one at a time: two readers would split the bytes). */
let serialJob: { kill: () => void } | undefined;
const stopSerial = () => { serialJob?.kill(); serialJob = undefined; };

/**
 * Streams the board's UART into "X-HEEP UART" under a header, as for simulations; the returned function stops it.
 * Left running, it stops at the next stream or serial monitor.
 */
async function streamSerial(title: string, onText: (text: string) => void = () => { }): Promise<() => void> {
	const port = await serialPort();
	stopSerial();
	vscode.window.terminals.find(t => t.name === 'X-HEEP UART')?.dispose(); // a serial monitor holds the port too
	uart.appendLine(`${uartAtLineStart ? '' : '\n'}── ${title} · ${new Date().toLocaleTimeString()} ${'─'.repeat(30)}`);
	uartAtLineStart = true;
	uart.show(true);
	if (!port) {
		return () => { };
	}
	const proc = spawn('/bin/bash', ['-c', serialReadCommand(port, cfg().get<number>('serialBaud', 9600))], { detached: true });
	proc.stdout.on('data', (d: Buffer) => {
		const text = printable(d.toString());
		uartAppend(text);
		onText(text);
	});
	proc.stderr.on('data', (d: Buffer) => output.append(d.toString()));
	const job = { kill: () => { try { process.kill(-proc.pid!, 'SIGTERM'); } catch { /* already gone */ } } };
	serialJob = job;
	return () => {
		if (serialJob === job) {
			stopSerial();
		}
	};
}

/** Interactive serial monitor (picocom) in a terminal, for apps that read from the UART. */
async function openSerial() {
	const port = await serialPort();
	if (!port) {
		return;
	}
	stopSerial();
	vscode.window.terminals.find(t => t.name === 'X-HEEP UART')?.dispose();
	vscode.window.createTerminal({
		name: 'X-HEEP UART',
		// Not revived on window reload: a revived picocom is no longer found by name and keeps reading the port.
		isTransient: true,
		shellPath: toolExe('picocomPath', 'picocom'),
		shellArgs: ['-b', String(cfg().get<number>('serialBaud', 9600)), '-r', '-l', '--imap', 'lfcrlf', port],
	}).show(true);
}

async function buildSimModel() {
	const sim = cfg().get<Simulator>('simulator', 'verilator');
	return (platformReady() || await generatePlatform(false)) && buildModel(sim, false);
}

function mcuGen() {
	return generatePlatform(false);
}

// --- Environment check ----------------------------------------------------

type ToolId = 'python' | 'toolchain' | 'verilator' | 'verible' | 'openocd' | 'picocom';

/** One tool, as the environment check reports it and Set Up Tools fixes it. */
interface Check {
	id: ToolId;
	label: string;
	usedBy: string;
	state: 'ok' | 'warn' | 'fail';
	/** What was found, e.g. "Verilator 5.040". */
	text: string;
	/** What is wrong and what to do, when not ok. */
	hint?: string;
	/** Needed in the current mode: OpenOCD only on the FPGA, picocom never (the UART panel does without). */
	needed: boolean;
}

/**
 * The tools X-HEEP needs, checked in depth: the Python environment runs and has X-HEEP's packages, Verilator and
 * verible are the versions X-HEEP's setup guide uses. The environment check reports them; Set Up Tools fixes them.
 */
async function toolChecks(): Promise<Check[]> {
	const fpga = currentMode() !== 'sim';
	const found = async (cmd: string) => (await shOut(`command -v ${cmd}`, true)).ok;
	const wanted = requiredVersions(readText(path.join(root, 'docs', 'source', 'GettingStarted', 'Setup.md')));
	const version = (what: string, got: string | undefined, want: string | undefined, why: string): Pick<Check, 'state' | 'text' | 'hint'> =>
		!got ? { state: 'fail', text: what, hint: `not found: install ${what} ${want ?? ''}`.trim() }
			: want && got !== want ? { state: 'warn', text: `${what} ${got}`, hint: `X-HEEP uses ${want}: ${why}` }
				: { state: 'ok', text: `${what} ${got}` };

	const questa = cfg().get<Simulator>('simulator', 'verilator') === 'questasim';
	const sim: Pick<Check, 'label' | 'state' | 'text' | 'hint'> = questa
		? { label: 'Questasim', ...(await found('vsim') ? { state: 'ok', text: 'Questasim (vsim)' } : { state: 'fail', text: 'Questasim (vsim)', hint: 'vsim is not on PATH' }) }
		: { label: 'Verilator', ...version('Verilator', verilatorVersion((await shOut(`'${toolExe('verilatorPath', 'verilator')}' --version`, true)).out), wanted.verilator, 'others may fail to build the simulation model') };
	const gcc = findTool('-elf-gcc'), gdb = findTool('-elf-gdb');
	return [
		{ id: 'python', label: 'Python environment', usedBy: 'every build', needed: true, ...await pythonCheck() },
		{
			id: 'toolchain', label: 'RISC-V toolchain', usedBy: 'compiling and debugging apps', needed: true,
			...(gcc && gdb ? { state: 'ok', text: `RISC-V toolchain in ${toolchain()}` }
				: { state: 'fail', text: `RISC-V toolchain in ${toolchain()}`, hint: gcc ? 'no GDB in it' : 'no *-elf-gcc in it' }),
		},
		{ id: 'verilator', usedBy: 'Simulation', needed: true, ...sim },
		{
			id: 'verible', label: 'verible', usedBy: 'generating the platform', needed: true,
			...version('verible', veribleVersion((await shOut(`'${toolExe('veriblePath', 'verible-verilog-format')}' --version`, true)).out), wanted.verible,
				'platform generation would reformat X-HEEP\'s own files differently (they show as modified)'),
		},
		{
			id: 'openocd', label: 'OpenOCD', usedBy: 'the FPGA modes', needed: fpga,
			...(await found(`'${toolExe('openocdPath', 'openocd')}'`) ? { state: 'ok', text: 'OpenOCD' } : { state: 'fail', text: 'OpenOCD', hint: 'not found' }),
		},
		{
			id: 'picocom', label: 'picocom', usedBy: 'Open Serial Monitor (optional)', needed: false,
			...(await found(`'${toolExe('picocomPath', 'picocom')}'`) ? { state: 'ok', text: 'picocom' } : { state: 'fail', text: 'picocom', hint: 'not found' }),
		},
	];
}

/** The Python environment: that `xheep.envSetup` runs, and why not (no conda, no such environment), then X-HEEP's packages. */
async function pythonCheck(): Promise<Pick<Check, 'state' | 'text' | 'hint'>> {
	const setup = cfg().get<string>('envSetup', '').trim();
	const text = `Python environment: ${setup || 'the repository .venv'}`;
	const env = await shOut('true');
	if (!env.ok) {
		const name = condaEnvName(setup);
		const conda = !name || (await shOut('command -v conda', true)).ok;
		const envs = conda && name ? (await shOut('conda env list', true)).out.split('\n').map(l => l.split(/\s+/)[0]) : [];
		return {
			state: 'fail', text, hint: !conda ? 'conda is not on PATH'
				: name && !envs.includes(name) ? `there is no conda environment "${name}"` : `it fails: ${env.out.trim().split('\n').pop()}`,
		};
	}
	const missing = (await shOut(missingModulesCommand())).out.trim().split('\n').pop()?.trim();
	return missing ? { state: 'fail', text, hint: `it lacks X-HEEP's Python packages (${missing.split(' ').join(', ')})` }
		: { state: 'ok', text: `${text} (X-HEEP's packages present)` };
}

/** Vivado is on PATH and starts: enables "Build Bitstream", which is the only thing that needs it. */
let hasVivado = false;

/** Runs a command in X-HEEP's root, after `xheep.envSetup` unless `raw`, with its output. */
function shOut(cmd: string, raw = false): Promise<{ ok: boolean; out: string }> {
	return new Promise(resolve => execFile('/bin/bash', ['-c', raw ? cmd : withEnvSetup(cmd)],
		{ cwd: root, env: { ...process.env, ...taskEnv() } }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}` })));
}

const canUse = (node: string) => { try { fs.accessSync(node, fs.constants.R_OK | fs.constants.W_OK); return true; } catch { return false; } };

type Report = (state: 'ok' | 'fail' | 'warn', what: string, hint?: string) => void;
type AddFix = (label: string, run: () => unknown) => void;

/**
 * What the FPGA modes need from the hardware: the JTAG adapter, the flash programmer and the board's USB usable
 * (udev), the UART (dialout), iceprog buildable for the flash. Hardware that is not plugged in is a note, not a
 * problem: working in simulation only is the norm, and a run on the board says itself what is missing.
 */
async function checkHardware(report: Report, note: (text: string) => void) {
	const mode = currentMode();
	const needed = new Map<string, string>(); // USB id -> what for
	if (mode === 'fpga-jtag') {
		const adapter = await jtagAdapter(false);
		if (adapter?.usb) {
			needed.set(adapter.usb, `${adapter.label} (JTAG)`);
		} else if (!adapter) {
			const bitstream = bitstreamFile();
			const fit = boardAdapters(fpgaBoard(), bitstream ? bitstreamInfo(bitstream)?.bscan : undefined).filter(a => !a.bscan);
			note(`JTAG adapter: none connected (for the FPGA: ${fit.map(a => a.label).join(' or ')} on X-HEEP's PMOD JTAG pins)`);
		}
	}
	if (mode === 'fpga-flash') {
		needed.set(EPFL_PROGRAMMER_USB, 'EPFL Programmer (SPI flash)');
	}
	const board = BOARDS[fpgaBoard()];
	if (board?.usb && bitstreamFile() && (await programmer()) === 'openocd') {
		needed.set(board.usb, needed.has(board.usb) ? `${needed.get(board.usb)} and ${fpgaBoard()} USB (bitstream)` : `${fpgaBoard()} USB (loads the bitstream)`);
	}
	const devices = usbDevices();
	for (const [id, what] of needed) {
		const [vid, pid] = id.split(':');
		const dev = devices.find(d => d.vid === vid && d.pid === pid);
		if (!dev) {
			note(`${what}: not connected (USB ${id})`);
		} else if (!canUse(dev.node)) {
			report('fail', `${what}: no permission on ${dev.node}`, `allow users to open it: echo '${udevRule(vid, pid)}' | sudo tee /etc/udev/rules.d/60-xheep.rules`
				+ ' && sudo udevadm control --reload && sudo udevadm trigger, then plug it in again');
		} else {
			report('ok', `${what}: connected`);
		}
	}
	const set = cfg().get<string>('serialPort', '');
	const port = set && fs.existsSync(set) ? set : pickSerialPort(serialCandidates());
	if (!port) {
		note('UART: no serial port found (the EPFL programmer has it, or set "xheep.serialPort")');
	} else if (!canUse(port)) {
		report('fail', `UART: no permission on ${port}`, 'join the dialout group: sudo usermod -aG dialout $USER, then log out and in');
	} else {
		report('ok', `UART: ${port}`);
	}
	if (mode === 'fpga-flash' && !fs.existsSync(path.join(root, 'sw', 'vendor', 'yosyshq_icestorm', 'iceprog', 'iceprog'))
		&& !(await shOut('pkg-config --exists libftdi1 || pkg-config --exists libftdi', true)).ok) {
		report('fail', 'iceprog (programs the flash): cannot be built', 'libftdi is missing: sudo apt install libftdi1-dev pkg-config');
	}
}

async function checkEnv(quiet = false) {
	const fixes: { label: string; run: () => unknown }[] = [];
	const lines: string[] = [];
	const counts = { fail: 0, warn: 0 };
	const report: Report = (state, what, hint = '') => {
		lines.push(`${{ ok: '✓', fail: '✗', warn: '⚠' }[state]} ${what}${state === 'ok' || !hint ? '' : `  -> ${hint}`}`);
		if (state !== 'ok') {
			counts[state]++;
		}
	};
	const note = (text: string) => lines.push(`  ${text}`);
	const addFix: AddFix = (label, run) => { if (!fixes.some(f => f.label === label)) { fixes.push({ label, run }); } };

	const tools = await toolChecks();
	for (const c of tools) {
		if (c.state === 'ok') {
			report('ok', c.text);
		} else if (c.needed) {
			report(c.state, c.text, c.hint);
		} else {
			note(`${c.text}: ${c.hint} (needed for ${c.usedBy})`);
		}
	}
	const envOk = tools.find(c => c.id === 'python')?.state === 'ok';
	// Set Up Tools finds, installs or replaces the tools that need it.
	if (tools.some(c => c.state !== 'ok' && c.needed)) {
		addFix('Fix…', () => fixTools(false));
		addFix('Open Setup Guide', () => vscode.env.openExternal(vscode.Uri.parse(SETUP_GUIDE)));
	}

	if (managedXheep()) {
		const [head, pin] = await Promise.all([gitHead(), pinnedCommit()]);
		if (pin && head !== pin && !state.get('xheepOnMain')) {
			report('warn', `X-HEEP is at ${short(head)}, not at the commit tested with the extension (${short(pin)})`, 'run Update X-HEEP');
			addFix('Update X-HEEP', updateXheep);
		} else {
			note(`X-HEEP: ${short(head)}${head === pin ? ' (tested with the extension)' : state.get('xheepOnMain') ? ' (main, untested)' : ''}`);
		}
	}
	note(`Platform config: ${configPath()} (${platformReady() ? 'generated' : 'regenerated on the next build'})`);

	if (envOk) {
		const fpga = currentMode() !== 'sim';
		// Vivado is optional (building bitstreams), but a broken install would fail every FPGA load through it.
		const vivadoOnPath = await sh('command -v vivado');
		hasVivado = vivadoOnPath && await sh('vivado -version');
		vscode.commands.executeCommand('setContext', 'xheep.hasVivado', hasVivado);
		if (vivadoOnPath && !hasVivado) {
			report('fail', 'Vivado is on PATH but does not start', 'run "vivado -version" in a terminal (recent Ubuntu releases need libtinfo5)');
		} else {
			note(`Vivado (optional, Build Bitstream): ${hasVivado ? 'found' : 'not found'}`);
		}
		// Loading bitstreams only matters in the FPGA modes: elsewhere a missing tool is a note, not a problem.
		const tool = await programmer();
		if (tool || fpga) {
			report(tool ? 'ok' : 'fail', `FPGA programmer: ${tool ?? 'none'} (FPGA modes)`, BOARDS[fpgaBoard()]?.part ? 'install Vivado, or OpenOCD on boards it supports' : 'the extension cannot program this board');
		} else {
			note('FPGA programmer: none, needed in the FPGA modes (OpenOCD on the PYNQ-Z2, Vivado elsewhere)');
		}
		const bitstream = bitstreamFile();
		const built = bitstream ? bitstreamInfo(bitstream)?.config : undefined;
		note(`Bitstream: ${bitstream ? `${bitstream}${built ? ` (built for ${path.basename(built)})` : ''}`
			: `none for ${fpgaBoard()}: set "xheep.bitstream"${hasVivado ? ' or run Build Bitstream' : ''}`}`);
		if (fpga) {
			await checkHardware(report, note);
		}
	}

	output.appendLine(`X-HEEP environment check (${root})`);
	lines.forEach(l => output.appendLine(l));
	if (counts.fail || counts.warn) {
		const found = [counts.fail && `${counts.fail} problem(s)`, counts.warn && `${counts.warn} warning(s)`].filter(Boolean).join(' and ');
		const choice = await vscode.window.showWarningMessage(`X-HEEP: ${found} in the environment.`, 'Show Details', ...fixes.map(f => f.label));
		if (choice === 'Show Details') {
			output.show();
		}
		fixes.find(f => f.label === choice)?.run();
	} else if (!quiet) {
		if (await vscode.window.showInformationMessage('X-HEEP: environment OK.', 'Change a Tool…')) {
			fixTools(true);
		}
	}
}

/**
 * Walks the user through the tools that need it, until all are fine or they give up; with `all`, offers every
 * tool, to change one that works (another toolchain, another Verilator, the container).
 */
async function fixTools(all = false) {
	for (; ;) {
		const tools = await toolChecks();
		const pending = all ? tools : tools.filter(c => c.state !== 'ok' && c.needed);
		if (!pending.length) {
			vscode.window.showInformationMessage('X-HEEP: all tools found.');
			return;
		}
		const icon = { ok: '$(pass)', warn: '$(warning)', fail: '$(error)' };
		const picked = await vscode.window.showQuickPick(pending.map(c => ({
			label: `${icon[c.state]} ${c.label}`, description: c.state === 'ok' ? c.text : c.hint, detail: `Needed for ${c.usedBy}`, c,
		})), { placeHolder: all ? 'X-HEEP: which tool do you want to change?' : 'X-HEEP: which tool do you want to set up?' });
		if (!picked || !await fixTool(picked.c) || all) {
			return;
		}
	}
}

const setGlobal = (key: string, value: string) => cfg().update(key, value, vscode.ConfigurationTarget.Global);

/** Offers the found candidates, a manual pick, an install and the container for one tool; false if dismissed. */
async function fixTool(c: Check): Promise<boolean> {
	type Action = vscode.QuickPickItem & { run?: () => Thenable<unknown> | Promise<unknown> };
	const sep = (label: string): Action => ({ label, kind: vscode.QuickPickItemKind.Separator });
	const settingFor: Partial<Record<ToolId, string>> = { verilator: 'verilatorPath', verible: 'veriblePath', openocd: 'openocdPath', picocom: 'picocomPath' };
	const exe = c.id === 'verible' ? 'verible-verilog-format' : c.id;
	let found: Action[] = [];
	let locate: Action | undefined;
	let install: { cmd: string; done: () => Thenable<unknown>; note?: string } | undefined;

	if (c.id === 'python') {
		found = findPythonEnvs(root).map(e => ({ label: e.label, detail: e.setup, run: () => setGlobal('envSetup', e.setup) }));
		locate = {
			label: '$(terminal) Use a setup script or command…', detail: 'e.g. a lab script or "module load", run before every command',
			run: async () => {
				const v = await vscode.window.showInputBox({ prompt: 'Shell command that activates the X-HEEP Python environment', value: cfg().get('envSetup') });
				return v !== undefined && setGlobal('envSetup', v);
			},
		};
		const conda = findConda();
		install = conda
			? { cmd: `PATH='${path.dirname(conda)}':$PATH make conda`, done: () => setGlobal('envSetup', condaSetup(conda, 'x-heep')) }
			: { cmd: 'make venv', done: () => setGlobal('envSetup', venvSetup(path.join(root, '.venv'))) };
	} else if (c.id === 'toolchain') {
		found = findToolchains().map(d => ({ label: d, run: () => setGlobal('riscvToolchain', d) }));
		locate = {
			label: '$(folder-opened) Locate…', detail: 'The folder that contains bin/riscv32-…-elf-gcc',
			run: async () => {
				const d = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use this toolchain' }))?.[0]?.fsPath;
				return d && setGlobal('riscvToolchain', d);
			},
		};
		const url = toolchainUrl();
		const dest = path.join(os.homedir(), '.riscv');
		if (url) {
			install = { cmd: toolchainInstallCommand(url, dest), done: () => setGlobal('riscvToolchain', dest) };
		}
	} else if (settingFor[c.id]) {
		const key = settingFor[c.id]!;
		found = findExecutables(exe).map(p => ({ label: p, run: () => setGlobal(key, p) }));
		locate = {
			label: '$(folder-opened) Locate…', detail: `The ${exe} executable`,
			run: async () => {
				const p = (await vscode.window.showOpenDialog({ canSelectFiles: true, openLabel: `Use this ${exe}` }))?.[0]?.fsPath;
				return p && setGlobal(key, p);
			},
		};
		if (c.id === 'verilator') {
			// Package managers ship other versions: build the one X-HEEP uses, as its setup guide does.
			const version = xheepVerilatorVersion(root);
			install = {
				cmd: verilatorInstallCommand(version),
				done: () => setGlobal(key, path.join(verilatorPrefix(version), 'bin', 'verilator')),
				note: `Builds Verilator ${version} from source into ${verilatorPrefix(version)}, as in X-HEEP's setup guide. `
					+ 'Needs git, autoconf, flex, bison and g++ 13 or newer, and takes several minutes.',
			};
		} else if (c.id === 'verible') {
			// The release X-HEEP formats its sources with: another one reformats them differently.
			const version = requiredVersions(readText(path.join(root, 'docs', 'source', 'GettingStarted', 'Setup.md'))).verible;
			if (version) {
				install = {
					cmd: veribleInstallCommand(version),
					done: () => setGlobal(key, path.join(veriblePrefix(version), 'bin', 'verible-verilog-format')),
					note: `Downloads verible ${version} into ${veriblePrefix(version)}, as in X-HEEP's setup guide.`,
				};
			}
		} else {
			const cmd = packageInstallCommand(c.id);
			if (cmd) {
				install = { cmd, done: () => Promise.resolve() };
			}
		}
	}

	const items: Action[] = [
		...(found.length ? [sep('Found on this computer'), ...found] : []),
		sep('Other options'),
		...(locate ? [locate] : []),
		...(install ? [{
			label: '$(cloud-download) Install…', detail: install.cmd,
			run: async () => {
				const ok = await vscode.window.showWarningMessage(`Install ${c.label}?`, { modal: true, detail: `${install!.note ? install!.note + '\n\n' : ''}This runs in a terminal:\n${install!.cmd}` }, 'Install');
				if (ok && await runTask(makeTask(`Install ${c.label}`, install!.cmd, true)) === 0) {
					await install!.done();
				}
			},
		}] : []),
		{ label: '$(vm) Use the X-HEEP container instead…', detail: 'All tools preinstalled, via Docker or WSL; simulation only, no FPGA', run: openInContainer },
	];
	const action = await vscode.window.showQuickPick(items, { placeHolder: `${c.label}: how do you want to set it up?` });
	if (!action?.run) {
		return false;
	}
	await action.run();
	return true;
}

// --- Containers -------------------------------------------------------------

async function ensureExtension(id: string, why: string): Promise<boolean> {
	if (vscode.extensions.getExtension(id)) {
		return true;
	}
	if (await vscode.window.showInformationMessage(`${why} needs the ${id} extension.`, 'Install') !== 'Install') {
		return false;
	}
	await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
	return true;
}

/**
 * Reopens the project where the X-HEEP tools are ready: WSL (Windows) or a Dev Container on X-HEEP's
 * toolchain image. VS Code and this extension then run in Linux, unchanged.
 */
async function openInContainer() {
	const ws = vscode.workspace.workspaceFolders?.[0];
	if (!ws) {
		return;
	}
	const wsl = process.platform === 'win32' && (await vscode.window.showQuickPick([
		{ label: 'WSL', detail: 'Reopen in your Linux distribution; then set the tools up there (recommended)', wsl: true },
		{ label: 'Docker container', detail: 'X-HEEP toolchain image, everything preinstalled; needs Docker Desktop', wsl: false },
	], { placeHolder: 'Where should X-HEEP run?' }))?.wsl;
	if (wsl === undefined && process.platform === 'win32') {
		return;
	}
	if (wsl) {
		return await ensureExtension('ms-vscode-remote.remote-wsl', 'Opening in WSL')
			&& vscode.commands.executeCommand('remote-wsl.reopenInWSL');
	}
	const file = path.join(ws.uri.fsPath, '.devcontainer', 'devcontainer.json');
	if (!fs.existsSync(file)) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, devcontainerJson(extensionId, xheepImageTag(root)));
	}
	return await ensureExtension('ms-vscode-remote.remote-containers', 'The X-HEEP container')
		&& vscode.commands.executeCommand('remote-containers.reopenInContainer');
}

// --- UI ---------------------------------------------------------------------

// Tree elements are app names, plus these two (\0 cannot appear in a folder name).
const EXAMPLES = '\0examples';
const NEW_APP = '\0new';

class AppsProvider implements vscode.TreeDataProvider<string> {
	private exampleCount = 0;
	private emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;
	refresh() { loadExamples().then(() => this.emitter.fire()); }
	getChildren(el?: string) {
		if (el === EXAMPLES) {
			return exampleApps();
		}
		if (el) {
			return [];
		}
		this.exampleCount = exampleApps().length;
		const mine = userApps();
		return [...(mine.length ? mine : [NEW_APP]), EXAMPLES];
	}
	getTreeItem(app: string) {
		if (app === EXAMPLES) {
			const item = new vscode.TreeItem('Examples', vscode.TreeItemCollapsibleState.Collapsed);
			item.iconPath = new vscode.ThemeIcon('library');
			item.description = String(this.exampleCount);
			return item;
		}
		if (app === NEW_APP) {
			const item = new vscode.TreeItem('New application…');
			item.iconPath = new vscode.ThemeIcon('add');
			item.command = { command: 'xheep.newApp', title: 'New Application' };
			return item;
		}
		const item = new vscode.TreeItem(app);
		item.contextValue = userApps().includes(app) ? 'userApp' : 'app';
		item.iconPath = statusIcon(buildStatus(app));
		if (app === currentApp()) {
			item.label = { label: app, highlights: [[0, app.length]] };
			item.description = 'active';
		}
		item.tooltip = appDir(app);
		item.command = { command: 'xheep.selectApp', title: 'Select App', arguments: [app] };
		return item;
	}
}

function statusIcon(status?: BuildStatus): vscode.ThemeIcon {
	switch (status) {
		case 'ok': return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
		case 'fail': return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
		case 'running': return new vscode.ThemeIcon('sync~spin');
		default: return new vscode.ThemeIcon('circle-large-outline');
	}
}

function refreshUi() {
	apps.refresh();
	const status = buildStatus(currentApp());
	const icon = { ok: '$(pass)', fail: '$(error)', running: '$(sync~spin)' }[status ?? 'ok'] ?? '$(chip)';
	appItem.text = `${status ? icon : '$(chip)'} ${currentApp()}`;
	appItem.tooltip = `X-HEEP application${status && status !== 'running' ? ` (last build: ${status === 'ok' ? 'succeeded' : 'failed'})` : ''}`;
	appItem.backgroundColor = status === 'fail' ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
	modeItem.text = `$(target) ${MODES[currentMode()].label}${currentMode() === 'fpga-jtag' && lastAdapter ? ` (${lastAdapter.label})` : ''}`;
	configItem.text = `$(settings) ${path.basename(configPath()).replace(/\.(py|hjson)$/, '')}`;
}

function setupIntelliSense() {
	const rel = path.relative(folder.uri.fsPath, root).split(path.sep).join('/');
	const xheepDir = `\${workspaceFolder}${rel ? '/' + rel : ''}`;
	const defaults: [string, string, unknown][] = [
		['C_Cpp.default', 'compileCommands', `${xheepDir}/sw/build/compile_commands.json`],
		// Lets Pylance resolve the X-HEEP classes imported by the platform configs.
		['python.analysis', 'extraPaths', [`${xheepDir}/util/xheep_gen`]],
	];
	for (const [section, key, value] of defaults) {
		const conf = vscode.workspace.getConfiguration(section, folder.uri);
		if (conf.inspect(key)?.workspaceValue === undefined) {
			// Rejected when the extension owning the setting (e.g. Python) is not installed: nothing to set up then.
			conf.update(key, value, vscode.ConfigurationTarget.Workspace).then(undefined, () => { });
		}
	}
}

const isXheep = (dir: string) => fs.existsSync(path.join(dir, 'util', 'xheep_gen', 'mcu_gen.py'));

export function activate(context: vscode.ExtensionContext) {
	extensionDir = context.extensionPath;
	extensionId = context.extension.id;
	output = vscode.window.createOutputChannel('X-HEEP');
	uart = vscode.window.createOutputChannel('X-HEEP UART');
	buildProblems = vscode.languages.createDiagnosticCollection('xheep');
	context.subscriptions.push(output, uart, buildProblems,
		vscode.commands.registerCommand('xheep.newProject', newProject),
		vscode.commands.registerCommand('xheep.openInContainer', openInContainer));
	// Either X-HEEP itself is open, or a software project with X-HEEP in x-heep/.
	const found = vscode.workspace.workspaceFolders?.find(f => isXheep(f.uri.fsPath) || isXheep(path.join(f.uri.fsPath, 'x-heep')));
	if (!found) {
		// Empty view, so its welcome content (package.json viewsWelcome) offers to create a project.
		context.subscriptions.push(vscode.window.registerTreeDataProvider('xheep.apps', { getChildren: () => [], getTreeItem: (x: string) => new vscode.TreeItem(x) }));
		return;
	}
	folder = found;
	// The tools and every command assume Linux or macOS: on Windows, offer WSL or the container.
	if (process.platform === 'win32') {
		vscode.window.showWarningMessage('X-HEEP needs Linux tools: reopen this folder in WSL or in the X-HEEP container.', 'Reopen…')
			.then(pick => pick && openInContainer());
		return;
	}
	const dir = folder.uri.fsPath;
	root = isXheep(dir) ? dir : path.join(dir, 'x-heep');
	swRoot = path.join(dir, 'sw');
	vscode.commands.executeCommand('setContext', 'xheep.active', true);
	state = context.workspaceState;
	globalState = context.globalState;
	// A build cut short by closing the window would otherwise spin forever.
	state.update('buildStatus', Object.fromEntries(Object.entries(state.get<Record<string, BuildStatus>>('buildStatus', {})).filter(([, v]) => v !== 'running')));
	apps = new AppsProvider();

	appItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
	appItem.command = 'xheep.selectApp';
	appItem.tooltip = 'X-HEEP application';
	modeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9);
	modeItem.command = 'xheep.selectMode';
	modeItem.tooltip = 'X-HEEP run mode';
	configItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 7);
	configItem.command = 'xheep.selectConfig';
	configItem.tooltip = 'X-HEEP platform configuration';
	const runItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 8);
	runItem.command = 'xheep.run';
	runItem.text = '$(play)';
	runItem.tooltip = 'Run the X-HEEP application';
	[appItem, modeItem, runItem, configItem].forEach(i => i.show());

	const watchers = [...new Set([examplesDir(), userAppsDir()])].map(d => vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(d, '*')));
	watchers.forEach(w => { w.onDidCreate(() => apps.refresh()); w.onDidDelete(() => apps.refresh()); });

	context.subscriptions.push(
		appItem, modeItem, runItem, configItem, ...watchers,
		vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('xheep.mcuConfig')) { refreshUi(); refreshPlatformEditor(); } }),
		vscode.window.registerTreeDataProvider('xheep.apps', apps),
		vscode.debug.registerDebugAdapterTrackerFactory('cppdbg', { createDebugAdapterTracker: exitTracker }),
		vscode.commands.registerCommand('xheep.selectApp', selectApp),
		vscode.commands.registerCommand('xheep.selectMode', selectMode),
		vscode.commands.registerCommand('xheep.newApp', newApp),
		vscode.commands.registerCommand('xheep.newFile', newFile),
		vscode.commands.registerCommand('xheep.updateXheep', updateXheep),
		vscode.commands.registerCommand('xheep.openDocs', () => vscode.env.openExternal(vscode.Uri.parse('https://x-heep.readthedocs.io/en/latest/'))),
		vscode.commands.registerCommand('xheep.build', build),
		vscode.commands.registerCommand('xheep.run', run),
		vscode.commands.registerCommand('xheep.debug', debug),
		vscode.commands.registerCommand('xheep.openSerial', openSerial),
		vscode.commands.registerCommand('xheep.mcuGen', mcuGen),
		vscode.commands.registerCommand('xheep.selectConfig', selectConfig),
		vscode.commands.registerCommand('xheep.newConfig', newConfig),
		vscode.commands.registerCommand('xheep.editPlatform', () => openEditor()),
		vscode.commands.registerCommand('xheep.buildSimModel', buildSimModel),
		vscode.commands.registerCommand('xheep.programFpga', programFpga),
		vscode.commands.registerCommand('xheep.buildBitstream', buildBitstream),
		vscode.commands.registerCommand('xheep.checkEnv', () => checkEnv()),
		vscode.commands.registerCommand('xheep.fixTools', fixTools),
		vscode.commands.registerCommand('xheep.refreshApps', () => apps.refresh()),
	);

	refreshUi();
	jtagAdapter(false).then(refreshUi); // for the status bar
	setupIntelliSense();
	checkEnv(true);
}

export function deactivate() {
	stopSerial();
}
