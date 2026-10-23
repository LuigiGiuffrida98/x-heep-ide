"use strict";
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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const net = __importStar(require("net"));
const child_process_1 = require("child_process");
const tools_1 = require("./tools");
const soc_1 = require("./soc");
const xheep_1 = require("./xheep");
const platform_1 = require("./platform");
const console_1 = require("./console");
const platformEditor_1 = require("./platformEditor");
let extensionDir;
let extensionId;
let folder;
/** The X-HEEP repo: the workspace itself, `x-heep/` inside a software project, or hw/vendor/x-heep in a hardware project. */
let root;
/** Where the hardware is generated and built (make mcu-gen, fusesoc's build/): X-HEEP, or the hardware project (gr-heep). */
let hwRoot;
/** The platform at `root`: X-HEEP or X-ALP. */
let soc;
/** The sw/ dir holding the user's apps: X-HEEP's own, or the software project's. */
let swRoot;
let state;
let output;
let uart;
let appItem;
let modeItem;
/** Runs the app, and tells whether the simulation model is ready (refreshUi). */
let runItem;
let configItem;
let apps;
/** Kept across workspaces: what the extension knows of bitstreams (see BitstreamInfo). */
let globalState;
/** Build problems the extension explains itself (see reportBuildProblems). */
let buildProblems;
/** Verilator's and Questasim's problems of the last model build (see reportModelProblems). */
let hdlProblemsCollection;
const cfg = () => vscode.workspace.getConfiguration('xheep');
const examplesDir = () => path.join(root, 'sw', 'applications');
const userAppsDir = () => path.join(swRoot, 'applications');
const isProject = () => swRoot !== path.join(root, 'sw');
const isHwProject = () => hwRoot !== root;
const currentApp = () => state.get('app', 'hello_world');
const currentMode = () => state.get('mode', 'sim');
function listDir(dir) {
    if (!fs.existsSync(dir)) {
        return [];
    }
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort();
}
function userApps() {
    return isProject() ? listDir(userAppsDir()) : listDir(examplesDir()).filter(a => !examples.has(a));
}
function exampleApps() {
    return isProject() ? listDir(examplesDir()) : listDir(examplesDir()).filter(a => examples.has(a));
}
/** In a software project, a user app shadows an X-HEEP example with the same name. */
const isProjectApp = (app) => isProject() && fs.existsSync(path.join(userAppsDir(), app));
const appDir = (app) => path.join(isProjectApp(app) ? userAppsDir() : examplesDir(), app);
// shortcut: an app counts as an example while git tracks it, so a committed user app moves to Examples.
let examples = new Set();
function loadExamples() {
    return new Promise(resolve => (0, child_process_1.execFile)('git', ['ls-files', '-z', '--', 'sw/applications'], { cwd: root }, (err, out) => {
        examples = new Set(err ? [] : out.split('\0').map(f => f.split('/')[2]).filter(Boolean));
        resolve();
    }));
}
const expandHome = (p) => p.replace(/^~(?=$|\/)/, os.homedir());
function toolchain() {
    return expandHome(cfg().get('riscvToolchain') || process.env[soc?.toolchainVar ?? 'RISCV_XHEEP'] || process.env.RISCV_XHEEP || '~/.riscv');
}
/** A tool's executable: its `xheep.<key>` setting (the executable or its folder), else `name` from PATH. */
function toolExe(key, name) {
    const p = expandHome(cfg().get(key, ''));
    if (!p) {
        return name;
    }
    return fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, name) : p;
}
/** Folders of the tools set in the settings, put first in PATH for every command the extension runs. */
function toolDirs() {
    return [toolExe('verilatorPath', 'verilator'), toolExe('veriblePath', 'verible-verilog-format'), toolExe('openocdPath', 'openocd'), toolExe('picocomPath', 'picocom')]
        .filter(p => path.isAbsolute(p)).map(p => path.dirname(p)).concat(path.join(toolchain(), 'bin'));
}
function findTool(suffix) {
    const bin = path.join(toolchain(), 'bin');
    const name = fs.existsSync(bin) ? fs.readdirSync(bin).find(f => f.endsWith(suffix)) : undefined;
    return name && path.join(bin, name);
}
function simBuilt(sim) {
    const build = path.join(hwRoot, 'build');
    return fs.existsSync(build) && fs.readdirSync(build).some(d => (0, xheep_1.isCoreBuildDir)(d) && fs.existsSync(path.join(build, d, xheep_1.SIM_MODEL[sim])));
}
/** X-ALP: the memory apps are linked into and run from. */
const currentLinker = () => soc.linkers && state.get('linker', soc.linkers[0]);
function options(project = currentApp(), mode = currentMode()) {
    // X-ALP simulates with Verilator only.
    const simulator = soc.linkers ? 'verilator' : cfg().get('simulator', 'verilator');
    return {
        project,
        mode,
        compiler: cfg().get('compiler', 'gcc'),
        board: cfg().get('fpgaBoard', 'pynq-z2'),
        simulator,
        source: isProjectApp(project) ? (0, xheep_1.projectSource)(root, swRoot) : undefined,
        // The platform's needs as the extension read them; unknown for one generated by hand (X-HEEP's default then).
        arch: platformMode() === 'manual' ? undefined : state.get('platformArch'),
        linker: currentLinker(),
    };
}
// --- Platform configuration -------------------------------------------------
const projectDir = () => folder.uri.fsPath;
// gr-heep keeps its configuration in config/, as its Makefile's X_HEEP_CFG.
const userConfigsDir = () => path.join(projectDir(), isHwProject() ? 'config' : 'configs');
/** The active config: `xheep.mcuConfig`, looked up in the project first, then in X-HEEP. */
function configPath() {
    const set = cfg().inspect('mcuConfig');
    const c = set?.workspaceFolderValue ?? set?.workspaceValue ?? set?.globalValue
        ?? (isHwProject() ? 'config/mcu-gen-config.py' : soc.defaultConfig);
    return [projectDir(), root].map(d => path.resolve(d, c)).find(fs.existsSync) ?? path.resolve(root, c);
}
function listConfigs(dir) {
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.(py|hjson)$/.test(f) && !f.includes('pad_cfg')).sort() : [];
}
const mtime = (file) => { try {
    return fs.statSync(file).mtimeMs;
}
catch {
    return 0;
} };
const generatedFile = () => path.join(root, soc.generated);
/** See platformState: Build and Run generate only a 'stale' platform, never over one generated by hand. */
// shortcut: files a configuration imports, other than an overlay's base, and templates are not checked: edits there need "Regenerate Platform".
const platformMode = () => (0, xheep_1.platformState)(mtime(generatedFile()), [configPath(), baseOf(configPath())].map(mtime), configPath(), state.get('platformLast'));
const platformReady = () => platformMode() !== 'stale';
/** The user picked the configuration to use: the next Build generates it, also over a platform generated by hand. */
const configPicked = () => state.update('platformLast', { config: '', at: mtime(generatedFile()) });
async function useConfig(file) {
    await configPicked();
    await cfg().update('mcuConfig', path.relative(projectDir(), file), vscode.ConfigurationTarget.Workspace);
}
/**
 * Built for the platform as it is, by the extension or by hand (make <sim>-build): newer than every RTL file, the
 * generated ones included. Run rebuilds it only when not.
 */
const modelFresh = (file, model) => !!file && fs.existsSync(file) && platformReady()
    && mtime(file) >= rtlChangedAt() && !state.get(`modelStale.${model}`);
const modelReady = (sim) => modelFresh(simDir(sim) && path.join(simDir(sim), path.basename(xheep_1.SIM_MODEL[sim])), sim);
const RTL_FILE = /\.(sv|svh|v|vh|vlt|core)$/;
const isRtl = (file) => RTL_FILE.test(file) && ['hw', 'tb'].some(d => file.startsWith(path.join(hwRoot, d) + path.sep));
/** Newest change to the RTL (hw/, tb/), including what the model build itself writes there (the boot ROM). */
function rtlChangedAt() {
    return ['hw', 'tb'].map(d => path.join(hwRoot, d)).filter(fs.existsSync)
        .flatMap(d => fs.readdirSync(d, { recursive: true, withFileTypes: true }))
        .filter(e => e.isFile() && RTL_FILE.test(e.name))
        .reduce((t, e) => Math.max(t, fs.statSync(path.join(e.parentPath, e.name)).mtimeMs), 0);
}
/** Model builds in progress: one at a time per simulator, as they share the build dir. */
const modelBuilds = new Map();
/** Models whose build was running when an RTL file was saved: it may have read the file before the change. */
const savedDuringBuild = new Set();
/** Records whether the model may miss an RTL change: a file saved while it was building, older than the model itself. */
async function modelBuilt(model) {
    await state.update(`modelStale.${model}`, savedDuringBuild.delete(model));
}
/** Runs a task in the background with a status bar spinner; the terminal only shows up when it fails. */
async function runQuiet(title, task, silent, report = true) {
    if (silent) {
        task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, clear: true };
    }
    const code = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, () => runTask(task));
    if (code !== 0 && report) {
        vscode.window.showErrorMessage(`X-HEEP: ${title} failed.`, 'Show Log').then(pick => pick && showTaskLog(task));
    }
    return code === 0;
}
const showTaskLog = (task) => vscode.window.terminals.find(t => t.name.includes(task.name))?.show();
async function generatePlatform(silent) {
    const config = configPath();
    const ok = await runQuiet(`Generating platform (${path.basename(config)})`, makeTask('mcu-gen', (0, xheep_1.mcuGenCommand)(config, soc.id), false, {}, hwRoot), silent);
    if (ok) {
        await state.update('platformLast', { config, at: mtime(generatedFile()) });
        // Apps use what the platform offers, e.g. a hardware FPU.
        const read = await readPlatform(config);
        await state.update('platformArch', 'platform' in read ? (0, platform_1.archFor)(read.platform) : undefined);
        memoryMap.refresh(); // the registers of templated IPs (soc_ctrl, dma, ...) come from the generated descriptions
    }
    return ok;
}
/** What X-HEEP's generator reads from a configuration (media/platform.py), or why it cannot. */
async function readPlatform(config) {
    return platformScript('read', config);
}
async function platformScript(cmd, config) {
    const r = await shOut((0, xheep_1.platformScriptCommand)(path.join(extensionDir, 'media', 'platform.py'), cmd, config));
    try {
        const out = JSON.parse(r.out.trim().split('\n').pop() ?? '');
        return out.ok ? out : { error: out.error };
    }
    catch {
        return { error: r.out.trim().split('\n').slice(-3).join(' ') || 'the Python environment did not run (see the environment check)' };
    }
}
async function buildModel(sim, silent) {
    // A build already running (e.g. another Run): wait for it, and build again only if it missed a change.
    for (let running = modelBuilds.get(sim); running; running = modelBuilds.get(sim)) {
        await running;
        if (modelReady(sim)) {
            return true;
        }
    }
    const build = (async () => {
        savedDuringBuild.delete(sim);
        const task = makeTask(`Build ${sim} model`, (0, xheep_1.simModelBuildCommand)(sim, soc.linkers && soc.generated), false, {}, hwRoot);
        const ok = await runQuiet(`Building ${sim} model`, task, silent, false);
        if (ok) {
            await modelBuilt(sim);
            if (sim === 'verilator') {
                writeVeribleFileList();
            }
        }
        reportModelProblems(`${sim} model`, simDir(sim), ok, task);
        return ok;
    })();
    modelBuilds.set(sim, build);
    refreshUi();
    try {
        return await build;
    }
    finally {
        modelBuilds.delete(sim);
        refreshUi();
    }
}
/** Verilator's and Questasim's errors (and warnings outside vendored IPs) of the last model build, in the Problems panel. */
function reportModelProblems(what, workDir, ok, task) {
    const vendor = path.join(hwRoot, 'hw', 'vendor') + path.sep;
    const problems = workDir ? (0, xheep_1.hdlProblems)(readText(path.join(hwRoot, 'buildsim.log')), workDir, f => !f.startsWith(vendor)) : [];
    hdlProblemsCollection.clear();
    showProblems(hdlProblemsCollection, problems, path.join(hwRoot, 'buildsim.log'));
    if (!ok) {
        const error = problems.find(p => p.severity === 'error');
        vscode.window.showErrorMessage(`X-HEEP: building the ${what} failed${error ? `: ${error.message}` : '.'}`, ...(error ? ['Show Problems'] : []), 'Show Log').then(pick => pick === 'Show Problems'
            ? vscode.commands.executeCommand('workbench.actions.view.problems') : pick && showTaskLog(task));
    }
}
/**
 * Regenerates the platform and, for simulation, the RTL model, only when they are out of date: what was generated or
 * built by hand is kept, so mcu-gen and the model builds can also run outside the extension.
 */
async function prepare(o) {
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
    const edit = { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Edit in the platform editor (experimental)' };
    const configs = allConfigs();
    const items = [];
    for (const dir of ['Project', 'X-HEEP']) {
        const mine = configs.filter(c => c.dir === dir);
        if (mine.length && isProject()) {
            items.push({ label: dir, kind: vscode.QuickPickItemKind.Separator });
        }
        items.push(...mine.map(c => ({ label: c.name, description: path.relative(projectDir(), c.file), file: c.file, buttons: overlayOf(c.file) ? [edit] : [] })));
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(add) New configuration (Python)…', detail: `Starts from ${soc.name}'s ${path.basename(soc.defaultConfig)}, to edit as code`, run: newConfig }, { label: '$(beaker) New configuration with the editor…', detail: 'Experimental: a form, saved as a Python configuration', run: () => openEditor() });
    const pick = vscode.window.createQuickPick();
    pick.items = items;
    pick.placeholder = `Platform configuration (now: ${path.relative(projectDir(), configPath())})`;
    const choose = async (item, editIt) => {
        pick.hide();
        if (item.run) {
            return item.run();
        }
        await useConfig(item.file);
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
    fs.writeFileSync(file, (0, xheep_1.configTemplate)(root, name, soc.defaultConfig));
    await useConfig(file);
    await vscode.window.showTextDocument(vscode.Uri.file(file));
}
// --- Platform editor ----------------------------------------------------------
// A form over the active configuration; Apply writes a Python overlay on top of a base configuration (platform.ts).
/**
 * What the editor is doing: editing in place a configuration it wrote (an overlay), or creating a configuration,
 * starting from the values of another one.
 */
let editorMode = { from: '' };
const editorSource = () => 'edit' in editorMode ? editorMode.edit : editorMode.from;
const overlayOf = (file) => file.endsWith('.py') ? (0, platform_1.overlayHeader)(readText(file)) : undefined;
/** The configuration an overlay builds on; for any other configuration, itself. */
const baseOf = (file) => { const h = overlayOf(file); return h ? path.resolve(path.dirname(file), h.base) : file; };
async function loadEditor() {
    const source = editorSource();
    const read = await readPlatform(source);
    if ('error' in read) {
        return { error: `${soc.name}'s generator cannot read ${path.basename(source)}: ${read.error}` };
    }
    const rel = (f) => path.relative(projectDir(), f);
    const mode = 'edit' in editorMode ? 'edit' : 'create';
    const name = path.basename(source).replace(/\.(py|hjson)$/, '');
    if (soc.id === 'x-alp') {
        const { platform, catalog } = read;
        return { xalp: true, mode, name, file: rel(source), base: rel(baseOf(source)), form: (0, platform_1.xalpForm)(platform, catalog), platform, catalog };
    }
    const bitstream = bitstreamFile();
    const app = appDir(currentApp());
    const appReal = fs.existsSync(app) ? fs.realpathSync(app) : app;
    const frame = (0, xheep_1.largestFrame)(stackUsage(), f => { try {
        return fs.realpathSync(f).startsWith(appReal + path.sep);
    }
    catch {
        return false;
    } });
    return {
        mode,
        name,
        file: rel(source),
        base: rel(baseOf(source)),
        form: (0, platform_1.formFromPlatform)(read.platform),
        platform: read.platform,
        memoryEditable: (0, platform_1.plainMemory)(read.platform),
        catalog: read.catalog,
        bitstreamMatches: bitstream ? await bitstreamMatches(bitstream) : undefined,
        largestFrame: frame && { ...frame, app: currentApp() },
        boardRamKb: xheep_1.BOARDS[fpgaBoard()]?.ramKb,
        board: fpgaBoard(),
    };
}
/**
 * Writes the form as an overlay on the base: in place when editing one, else under a new name, which becomes the
 * active configuration. xheep_gen checks it first; resolves with its complaint, if any.
 */
async function applyEditor(form) {
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
    const [stem, baseRel] = [path.basename(target, '.py'), path.relative(path.dirname(target), base)];
    const xalp = read;
    const src = soc.id === 'x-alp'
        ? (0, platform_1.xalpOverlayConfig)(stem, baseRel, (0, platform_1.xalpForm)(xalp.platform, xalp.catalog), form, xalp.catalog)
        : (0, platform_1.overlayConfig)(stem, baseRel, (0, platform_1.formFromPlatform)(read.platform), form, read.catalog, (0, platform_1.plainMemory)(read.platform));
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
    // Applied in the editor: the user's choice, also over a platform generated by hand.
    await useConfig(target);
    refreshUi();
    return {};
}
/** Opens the editor: on `file` in place when it wrote it, else to create a configuration starting from it. */
function openEditor(file = configPath()) {
    editorMode = overlayOf(file) ? { edit: file } : { from: file };
    (0, platformEditor_1.openPlatformEditor)({
        load: loadEditor,
        apply: applyEditor,
        startFrom: async () => {
            const picked = await vscode.window.showQuickPick(allConfigs().map(c => ({ label: c.name, description: path.relative(projectDir(), c.file), file: c.file })), { placeHolder: 'Start the new configuration from' });
            if (picked) {
                editorMode = { from: picked.file };
            }
        },
        openFile: () => vscode.window.showTextDocument(vscode.Uri.file(editorSource())),
    }, soc.id === 'x-alp');
    (0, platformEditor_1.refreshPlatformEditor)(); // already open: show the new subject
}
// --- FPGA bitstream ---------------------------------------------------------
// Loading a bitstream needs no Vivado where OpenOCD reaches the FPGA (see BOARDS); building one does, so that stays optional.
const fpgaBoard = () => cfg().get('fpgaBoard', 'pynq-z2');
/** The bitstream to load: `xheep.bitstream` if set, else the one built in X-HEEP for the board. */
function bitstreamFile() {
    const set = cfg().get('bitstream', '').trim();
    if (!set) {
        return (0, xheep_1.builtBitstream)(hwRoot, fpgaBoard());
    }
    const file = path.resolve(projectDir(), set.replace(/^~(?=$|\/)/, os.homedir()));
    return fs.existsSync(file) ? file : undefined;
}
/** `xheep.fpgaProgrammer`; on auto OpenOCD where it reaches the board's FPGA, else Vivado. */
async function programmer() {
    const board = xheep_1.BOARDS[fpgaBoard()];
    const pick = cfg().get('fpgaProgrammer', 'auto');
    if (board?.openocd && pick !== 'vivado' && await sh(`command -v '${toolExe('openocdPath', 'openocd')}'`, false)) {
        return 'openocd';
    }
    return board?.part && pick !== 'openocd' && await sh('command -v vivado') ? 'vivado' : undefined;
}
/** The bitstream this window last loaded (path and mtime): the board keeps it until it is power cycled. */
let loadedBitstream;
const bitstreamKey = (bitstream) => `${bitstream}@${fs.statSync(bitstream).mtimeMs}`;
/** Configures the FPGA with `bitstream`, or clears its configuration (undefined) to free the SPI flash pins. */
async function loadFpga(tool, bitstream) {
    const board = xheep_1.BOARDS[fpgaBoard()];
    let cmd;
    if (tool === 'openocd') {
        cmd = (0, xheep_1.openocdFpgaCommand)(`'${toolExe('openocdPath', 'openocd')}'`, board.openocd, bitstream);
    }
    else {
        const tcl = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xheep-ide-')), 'fpga.tcl');
        fs.writeFileSync(tcl, (0, xheep_1.vivadoTcl)(board.part, bitstream));
        cmd = (0, xheep_1.vivadoCommand)(tcl);
    }
    const title = bitstream ? `Programming the FPGA (${tool})` : `Clearing the FPGA (${tool})`;
    const ok = await runQuiet(title, makeTask(bitstream ? 'Program FPGA' : 'Clear FPGA', cmd, true), true);
    loadedBitstream = ok && bitstream ? bitstreamKey(bitstream) : undefined;
    return ok;
}
/** sha1 of bitstreams by path and mtime: a bitstream is a few MB, read once per change. */
const bitstreamShas = new Map();
function bitstreamSha(bitstream) {
    const key = `${bitstream}@${fs.statSync(bitstream).mtimeMs}`;
    if (!bitstreamShas.has(key)) {
        bitstreamShas.set(key, (0, xheep_1.fileSha1)(bitstream));
    }
    return bitstreamShas.get(key);
}
/** What the extension knows of the bitstream; undefined when it never saw it. */
function bitstreamInfo(bitstream) {
    return globalState.get('bitstreams', {})[bitstreamSha(bitstream)];
}
function rememberBitstream(bitstream, info) {
    return globalState.update('bitstreams', { ...globalState.get('bitstreams', {}), [bitstreamSha(bitstream)]: info });
}
/** Every configuration to pick from: the project's, then X-HEEP's. */
function allConfigs() {
    const of = (dir, kind) => listConfigs(dir).map(f => ({ name: f.replace(/\.(py|hjson)$/, ''), file: path.join(dir, f), dir: kind }));
    return [...of(userConfigsDir(), isProject() ? 'Project' : 'X-HEEP'), ...(isProject() ? of(path.join(root, 'configs'), 'X-HEEP') : [])];
}
/** For a bitstream from elsewhere, asks once which configuration it was built for; Escape asks again next time. */
async function askBitstreamPlatform(bitstream) {
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
        ? { config: picked.file, hardware: read && 'platform' in read ? (0, platform_1.hardwareFingerprint)(read.platform) : undefined }
        : {});
}
/**
 * Apps must be generated from the platform the bitstream was built for (memory map, peripherals): on a mismatch,
 * offers to switch back to that configuration if it is still there. True to go on.
 */
async function bitstreamFitsPlatform(bitstream) {
    if (await bitstreamMatches(bitstream) !== false) {
        return true;
    }
    const info = bitstreamInfo(bitstream);
    const back = info.config && fs.existsSync(info.config) ? info.config : undefined;
    const use = back && `Use ${path.basename(back)}`;
    const pick = await vscode.window.showWarningMessage(`The FPGA bitstream was built for the platform "${path.basename(info.config ?? '?')}", but the active one, "${path.basename(configPath())}", `
        + 'has other hardware. Apps generated for it may not run correctly.', { modal: true }, ...(use ? [use] : []), 'Continue Anyway');
    if (back && pick === use) {
        await useConfig(back);
    }
    return !!pick;
}
/**
 * Whether the bitstream was built for the active platform's hardware; undefined when that is not known. Stack,
 * heap and the code/data split only change the linker script, so they never call for a new bitstream.
 */
async function bitstreamMatches(bitstream) {
    const hardware = bitstreamInfo(bitstream)?.hardware;
    // Generated by hand: the active platform's hardware is unknown too.
    if (!hardware || platformMode() === 'manual') {
        return undefined;
    }
    const read = await readPlatform(configPath());
    return 'platform' in read ? hardware === (0, platform_1.hardwareFingerprint)(read.platform) : undefined;
}
/** Bitstream and tool for the FPGA modes, after the platform check; undefined fields when there is nothing to load. */
async function fpgaSetup() {
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
        }
        else if (pick) {
            buildBitstream();
        }
        return;
    }
    const tool = await programmer();
    if (!tool) {
        vscode.window.showErrorMessage(`X-HEEP: the extension cannot program the ${fpgaBoard()}`
            + (xheep_1.BOARDS[fpgaBoard()]?.part ? ' without Vivado.' : '. Program it with the board\'s own tools.'));
        return;
    }
    if (!bitstreamInfo(bitstream)) {
        await askBitstreamPlatform(bitstream);
    }
    if (await bitstreamFitsPlatform(bitstream) && await loadFpga(tool, bitstream)) {
        vscode.window.showInformationMessage(`X-HEEP: FPGA programmed with ${path.basename(bitstream)}.`);
    }
}
function gitHead() {
    return new Promise(resolve => (0, child_process_1.execFile)('git', ['rev-parse', 'HEAD'], { cwd: root }, (err, out) => resolve(err ? undefined : out.trim())));
}
/** Builds the bitstream for the active platform with Vivado (optional: only offered when Vivado is installed). */
async function buildBitstream() {
    const board = fpgaBoard();
    // The on-board USB adapter needs the Xilinx BSCAN JTAG in the bitstream.
    const bscan = !!(await jtagAdapter(false))?.bscan;
    if (!platformReady() && !await generatePlatform(false)) {
        return;
    }
    // Generated by hand: what it was built for is unknown, so it is not checked against the configuration later.
    const config = platformMode() === 'manual' ? undefined : configPath();
    const read = config ? await readPlatform(config) : { error: 'generated by hand' };
    const info = {
        board, config, bscan, xheepCommit: await gitHead(), hardware: 'platform' in read ? (0, platform_1.hardwareFingerprint)(read.platform) : undefined,
    };
    if (!await runQuiet(`Building the ${board} bitstream with Vivado (this takes a while)`, makeTask('Build bitstream', (0, xheep_1.bitstreamBuildCommand)(board, bscan), false, {}, hwRoot), true)) {
        return;
    }
    const bitstream = (0, xheep_1.builtBitstream)(hwRoot, board);
    await rememberBitstream(bitstream, { ...info, builtAt: new Date().toISOString() });
    const elsewhere = !!cfg().get('bitstream', '').trim();
    const pick = await vscode.window.showInformationMessage(`X-HEEP: bitstream ready (${config ? path.basename(config) : 'platform generated by hand'}).`
        + (elsewhere ? ' "xheep.bitstream" points to another file.' : ''), elsewhere ? 'Use the New Bitstream' : 'Program FPGA');
    if (pick === 'Use the New Bitstream') {
        await cfg().update('bitstream', undefined, vscode.ConfigurationTarget.Workspace);
    }
    if (pick) {
        programFpga();
    }
}
// --- Running make ---------------------------------------------------------
function withEnvSetup(cmd) {
    const setup = cfg().get('envSetup', '').trim();
    return setup ? `${setup} && ${cmd}` : cmd;
}
function taskEnv() {
    // CMake reads this env var, so every app build drops sw/build/compile_commands.json for IntelliSense.
    return {
        RISCV_XHEEP: toolchain(), RISCV_XALP: toolchain(), CMAKE_EXPORT_COMPILE_COMMANDS: 'ON',
        PATH: [...toolDirs(), process.env.PATH ?? ''].join(path.delimiter),
    };
}
/** Where each task's output is copied for the X-HEEP log (runTask follows it). */
const taskLogs = new WeakMap();
let taskCount = 0;
function makeTask(name, cmd, rawShell = false, env = {}, cwd = root) {
    const log = path.join(os.tmpdir(), `xheep-ide-task-${process.pid}-${++taskCount}.log`);
    // Into the terminal as before (problem matchers), and a copy for the log; pipefail keeps the command's exit code.
    // The command on lines of its own: a # in it cannot comment out the closing brace.
    const exec = new vscode.ShellExecution(`set -o pipefail; {\n${rawShell ? cmd : withEnvSetup(cmd)}\n} 2>&1 | tee '${log}'`, {
        executable: '/bin/bash', shellArgs: ['-c'], cwd, env: { ...taskEnv(), ...env },
    });
    const task = new vscode.Task({ type: 'xheep', command: cmd }, folder, name, 'X-HEEP', exec, ['$xheep-gcc']);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true };
    taskLogs.set(task, log);
    return task;
}
async function runTask(task) {
    const log = taskLogs.get(task);
    output.appendLine(`\n$ ${task.name}: ${task.definition.command}`);
    const stop = log ? followFile(log, text => output.append((0, console_1.plain)(text)), true) : () => { };
    const execution = await vscode.tasks.executeTask(task);
    return new Promise(resolve => {
        const sub = vscode.tasks.onDidEndTaskProcess(e => {
            if (e.execution === execution) {
                sub.dispose();
                stop();
                if (log) {
                    fs.rmSync(log, { force: true });
                }
                output.appendLine(`── ${task.name}: ${e.exitCode === 0 ? 'done' : `failed (exit ${e.exitCode})`}`);
                resolve(e.exitCode);
            }
        });
    });
}
function sh(cmd, setup = true) {
    return new Promise(resolve => (0, child_process_1.execFile)('/bin/bash', ['-c', setup ? withEnvSetup(cmd) : cmd], { cwd: root, env: { ...process.env, ...taskEnv() } }, err => resolve(!err)));
}
// --- Commands -------------------------------------------------------------
async function selectApp(app) {
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
    (0, xheep_1.writeMain)(path.join(userAppsDir(), name), name, soc.id);
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
const addToGitignore = (dir, entry) => addLine(path.join(dir, '.gitignore'), entry);
/** Runs a bash script outside the task system (works with no folder open), logging to the X-HEEP output. */
function runLogged(title, script, cwd) {
    output.show(true);
    output.appendLine(`$ ${script}`);
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () => new Promise(resolve => {
        const proc = (0, child_process_1.spawn)('/bin/bash', ['-c', script], { cwd });
        proc.stdout.on('data', d => output.append(d.toString()));
        proc.stderr.on('data', d => output.append(d.toString()));
        proc.on('close', resolve);
    }));
}
/** The last X-HEEP commit the extension is known to work with: the live pin on GitHub, else the bundled one. */
async function pinnedCommit() {
    try {
        const live = (await (await fetch(xheep_1.XHEEP_COMMIT_URL, { signal: AbortSignal.timeout(5000) })).text()).trim();
        if ((0, xheep_1.isCommit)(live)) {
            return live;
        }
    }
    catch { /* offline: fall back to the pin shipped with the extension */ }
    try {
        const bundled = fs.readFileSync(path.join(extensionDir, 'XHEEP_COMMIT'), 'utf8').trim();
        return (0, xheep_1.isCommit)(bundled) ? bundled : undefined;
    }
    catch {
        return undefined;
    }
}
/** The platform is the submodule the extension added to a software project (not the user's own clone, opened or linked). */
const managedXheep = () => isProject() && !isHwProject() && !fs.lstatSync(root).isSymbolicLink()
    && new RegExp(`path\\s*=\\s*${soc.id}\\s*$`, 'm').test(readText(path.join(projectDir(), '.gitmodules')));
const short = (sha) => sha?.slice(0, 7) ?? '?';
/**
 * Moves the project's X-HEEP submodule to the latest commit tested with the extension, or to main. Refuses local
 * changes other than generated files (mcu-gen rewrites those in place), then makes the next build regenerate the
 * platform and the simulation model, which belong to the previous X-HEEP.
 */
async function updateXheep() {
    const head = await gitHead();
    // The pinned commit is X-HEEP's.
    const pin = soc.id === 'x-heep' ? await pinnedCommit() : undefined;
    if (isHwProject()) {
        vscode.window.showInformationMessage(`X-HEEP is vendored in ${path.relative(projectDir(), root)}: update it with make vendor-update.`);
        return;
    }
    if (!managedXheep()) {
        vscode.window.showInformationMessage(`${soc.name} here is your own clone (${root}): update it with git. It is at ${short(head)}`
            + (pin ? `; the extension is tested with ${short(pin)}.` : '.'));
        return;
    }
    const changed = (0, xheep_1.changedFiles)((await shOut('git status --porcelain --untracked-files=no', true)).out);
    const own = changed.filter(f => !(0, xheep_1.isGenerated)(root, f));
    if (own.length) {
        vscode.window.showErrorMessage(`${soc.name} has local changes: ${own.slice(0, 5).join(', ')}${own.length > 5 ? ', …' : ''}. Commit or discard them in ${soc.id}/ first.`);
        return;
    }
    const picked = await vscode.window.showQuickPick([
        ...(pin ? [{ label: `Latest tested commit (${short(pin)})`, description: pin === head ? 'current' : 'recommended', detail: `The newest ${soc.name} the extension is known to work with`, ref: pin }] : []),
        { label: 'main', description: 'untested', detail: `The newest ${soc.name}: it may not work with this version of the extension yet`, ref: 'main' },
    ], { placeHolder: `Update ${soc.name} (now at ${short(head)})` });
    if (!picked || !await runQuiet(`Updating ${soc.name}`, makeTask(`Update ${soc.name}`, (0, xheep_1.updateCommand)(picked.ref, changed), true), true)) {
        return;
    }
    // The generated platform, the models and the CMake tree come from the previous X-HEEP.
    await configPicked();
    await state.update('lastBuildKey', undefined);
    await state.update('xheepOnMain', picked.ref === 'main');
    apps.refresh();
    refreshUi();
    const bitstream = bitstreamFile();
    vscode.window.showInformationMessage(`${soc.name} is now at ${short(await gitHead())}. The next build regenerates the platform and the simulation model.`
        + ` Commit ${soc.id} in your project to keep this version.`
        + (bitstream?.startsWith(root + path.sep) ? ' Rebuild the FPGA bitstream too if your app needs the new hardware.' : ''));
}
/** Sets up a software project in a chosen folder: own apps in sw/applications, the platform in x-heep/ or x-alp/. */
async function newProject(p = soc_1.SOCS['x-heep']) {
    const ws = vscode.workspace.workspaceFolders?.[0];
    const dir = (await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, defaultUri: ws?.uri,
        title: `Folder of the new ${p.name} software project (an empty one is fine)`, openLabel: 'Create Project Here',
    }))?.[0]?.fsPath;
    if (!dir) {
        return;
    }
    if ((0, xheep_1.unbuildablePathChars)(dir).length) {
        vscode.window.showErrorMessage(`${p.name} cannot build in a folder whose path has ${(0, xheep_1.unbuildablePathChars)(dir).map(c => `"${c}"`).join(' ')}: pick another one.`);
        return;
    }
    if ((0, soc_1.socOf)(dir)) {
        vscode.window.showErrorMessage(`This is the ${(0, soc_1.socOf)(dir).name} repository itself: pick the folder of your own project.`);
        return;
    }
    // The folder is named after the platform (SocId), where activate() looks for it.
    const sub = path.join(dir, p.id);
    if (fs.existsSync(sub) && (0, soc_1.socOf)(sub) !== p) {
        vscode.window.showErrorMessage(`${sub} exists but is not an ${p.name} repository. Remove it and run this command again.`);
        return;
    }
    if (!fs.existsSync(sub)) {
        // Only X-HEEP has a commit pinned as tested (XHEEP_COMMIT).
        const tested = p.id === 'x-heep' ? 'the latest commit this extension is tested with' : 'its latest commit';
        const how = await vscode.window.showQuickPick([
            { id: 'submodule', label: `Add ${p.name} as a git submodule`, detail: `Clones ${p.git} into ${p.id}/ at ${tested}` },
            { id: 'link', label: `Link an existing ${p.name} clone`, detail: `Symlinks ${p.id}/ to a clone you already have (kept out of git)` },
        ], { placeHolder: `Where does ${p.name} come from?` });
        if (!how) {
            return;
        }
        if (how.id === 'link') {
            const src = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: `Use this ${p.name}` }))?.[0]?.fsPath;
            if (!src) {
                return;
            }
            if ((0, soc_1.socOf)(src) !== p) {
                vscode.window.showErrorMessage(`${src} is not an ${p.name} repository.`);
                return;
            }
            fs.symlinkSync(src, sub);
            addToGitignore(dir, p.id);
        }
        else {
            const commit = p.id === 'x-heep' ? await pinnedCommit() : undefined;
            output.appendLine(commit ? `${p.name} commit known to work with this extension: ${commit}` : `No pinned ${p.name} commit: using the latest main.`);
            const code = await runLogged(`Cloning ${p.name}…`, (0, xheep_1.cloneCommand)(p.git, commit, p.id), dir);
            if (code !== 0) {
                vscode.window.showErrorMessage(`Cloning ${p.name} failed, see the X-HEEP output. Nothing was left behind: you can retry.`);
                return;
            }
        }
    }
    const hello = path.join(dir, 'sw', 'applications', 'hello');
    if (!fs.existsSync(hello)) {
        (0, xheep_1.writeMain)(hello, 'hello', p.id);
    }
    // Recreated before each build (see projectSource), so it stays out of git.
    addToGitignore(dir, 'sw/device');
    await (ws?.uri.fsPath === dir
        ? vscode.commands.executeCommand('workbench.action.reloadWindow')
        : vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir)));
}
/**
 * Copies gr-heep into a new repo, a hardware project extending X-HEEP (vendored in hw/vendor/x-heep), renamed after
 * the folder (files, SystemVerilog modules, fusesoc core), commits it and opens it.
 */
async function newHwProject() {
    const parent = (await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        title: 'Folder to create the hardware project in', openLabel: 'Create Project Here',
    }))?.[0]?.fsPath;
    if (!parent) {
        return;
    }
    if ((0, xheep_1.unbuildablePathChars)(parent).length) {
        vscode.window.showErrorMessage(`X-HEEP cannot build in a folder whose path has ${(0, xheep_1.unbuildablePathChars)(parent).map(c => `"${c}"`).join(' ')}: pick another one.`);
        return;
    }
    const name = await vscode.window.showInputBox({
        prompt: `Name of the hardware project: a new folder in ${parent}, cloned from gr-heep and renamed (my_heep.sv, x-heep:systems:my-heep, ...)`,
        value: 'my-heep',
        validateInput: v => !(0, xheep_1.isHwProjectName)(v) ? 'Lowercase letters and digits, starting with a letter, words separated by - or _ (not x-heep)'
            : fs.existsSync(path.join(parent, v)) ? 'This folder already exists' : undefined,
    });
    if (!name) {
        return;
    }
    if (await runLogged('Cloning gr-heep…', (0, xheep_1.hwProjectCloneCommand)(name), parent) !== 0) {
        vscode.window.showErrorMessage(`Cloning ${xheep_1.GRHEEP_GIT} failed, see the X-HEEP output. Nothing was left behind: you can retry.`);
        return;
    }
    const dir = path.join(parent, name);
    if (name !== 'gr-heep') {
        (0, xheep_1.renameHwProject)(dir, name);
    }
    if (await runLogged(`Committing ${name}…`, `git add -A && git commit -q -m 'Initial commit, from ${xheep_1.GRHEEP_GIT}'`, dir) !== 0) {
        vscode.window.showWarningMessage(`${name} is ready, but its first commit failed (see the X-HEEP output): commit it yourself.`);
    }
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir));
}
/** The JTAG adapter last used or found, for the status bar. */
let lastAdapter;
/**
 * The JTAG adapter for the FPGA: `xheep.openocdConfig` when set, else the one plugged in among those fitting the
 * board and the bitstream. When that is not clear, asks if `ask` (and remembers the answer in the setting).
 */
async function jtagAdapter(ask) {
    const remember = (a) => { lastAdapter = a ?? lastAdapter; return a; };
    const set = cfg().get('openocdConfig', '').trim();
    if (set) {
        return remember(xheep_1.JTAG_ADAPTERS.find(a => a.config === set) ?? { label: path.basename(set), config: set });
    }
    const bitstream = bitstreamFile();
    const plugged = new Set((0, xheep_1.usbDevices)().map(d => `${d.vid}:${d.pid}`));
    const { adapter, choices } = (0, xheep_1.pickAdapter)((0, xheep_1.boardAdapters)(fpgaBoard(), bitstream ? bitstreamInfo(bitstream)?.bscan : undefined), usb => plugged.has(usb));
    if (adapter || !ask) {
        return remember(adapter);
    }
    const picked = await vscode.window.showQuickPick(choices.map(a => ({ label: a.label, detail: a.detail, adapter: a })), { placeHolder: 'Which JTAG adapter connects to X-HEEP?' });
    if (picked) {
        await cfg().update('openocdConfig', picked.adapter.config, vscode.ConfigurationTarget.Workspace);
    }
    return remember(picked?.adapter);
}
/** Picks the run mode; `mode` (e.g. from a keybinding's args) skips the pick. */
async function selectMode(mode) {
    if (soc.linkers) {
        // X-ALP: simulation only, from the memory the app is linked into.
        const linker = await vscode.window.showQuickPick(soc.linkers.map(l => ({ label: `Simulation · ${l.toUpperCase()}`, detail: `Linked into and run from the ${l.toUpperCase()}`, l })), { placeHolder: 'Where should the app run?' });
        if (linker) {
            await state.update('linker', linker.l);
            refreshUi();
        }
        return;
    }
    const picked = mode && xheep_1.MODES[mode] ? { id: mode } : await vscode.window.showQuickPick(Object.keys(xheep_1.MODES).map(id => ({ id, label: xheep_1.MODES[id].label, detail: xheep_1.MODES[id].detail })), { placeHolder: 'How should the app run?' });
    if (picked) {
        await state.update('mode', picked.id);
        refreshUi();
        // The FPGA modes need hardware the simulation does not: say now if something is missing.
        if (picked.id !== 'sim') {
            checkEnv(true);
        }
    }
}
const buildStatus = (app) => state.get('buildStatus', {})[app];
/**
 * The app's build as shown: running or failed here, else what sw/build has, so a `make app` run by hand counts too.
 * One app at a time is built: sw/build is shared.
 */
function appStatus(app) {
    const recorded = buildStatus(app);
    if (recorded === 'running') {
        return recorded;
    }
    const { target, linker } = (0, xheep_1.appTarget)({ mode: currentMode(), board: fpgaBoard(), linker: currentLinker() });
    const sources = isProjectApp(app) ? swRoot : path.join(root, 'sw');
    const want = { PROJECT: app, TARGET: target, LINKER: linker, COMPILER: cfg().get('compiler', 'gcc'),
        SOURCE_PATH: `${fs.existsSync(sources) ? fs.realpathSync(sources) : sources}/` };
    const build = path.join(root, 'sw', 'build');
    // Its sources, and the platform: generated again, the app needs a new build.
    const newest = Math.max(mtime(generatedFile()), ...listFiles(appDir(app)).map(f => mtime(path.join(appDir(app), f))));
    const disk = (0, xheep_1.builtStatus)(readText(path.join(build, 'CMakeCache.txt')), want, mtime(path.join(build, 'main.elf')), newest);
    return disk === 'ok' ? 'ok' : recorded === 'fail' ? 'fail' : disk;
}
/**
 * The simulation model for the run button: building, ready, failed (its last build's log, newer than the model, has
 * errors: here or a `make <sim>-build` by hand), or to build.
 */
function modelStatus() {
    const sim = soc.linkers ? 'verilator' : cfg().get('simulator', 'verilator');
    if (modelBuilds.has(sim)) {
        return 'running';
    }
    if (modelReady(sim)) {
        return 'ok';
    }
    const log = path.join(hwRoot, 'buildsim.log');
    const dir = simDir(sim);
    const model = dir ? mtime(path.join(dir, path.basename(xheep_1.SIM_MODEL[sim]))) : 0;
    // Verilator's %Error (fusesoc prefixes some with ERROR:), Questasim's ** Error, fusesoc's own ERROR: Failed to build.
    return mtime(log) > model && /%Error|\*\* Error|^ERROR: /m.test(readText(log)) ? 'fail' : undefined;
}
/** The app whose folder holds `file`: the project's before an X-HEEP example of the same name. */
function appOf(file) {
    for (const dir of [userAppsDir(), examplesDir()]) {
        const [app, ...rest] = path.relative(dir, file).split(path.sep);
        if (rest.length && listDir(dir).includes(app)) {
            return app;
        }
    }
    return undefined;
}
async function setBuildStatus(app, status) {
    await state.update('buildStatus', { ...state.get('buildStatus', {}), [app]: status });
    refreshUi();
}
function listFiles(dir) {
    return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter(e => e.isFile()).map(e => path.relative(dir, path.join(e.parentPath, e.name))).sort() : [];
}
/** Compiles the app quietly: the result shows as a tick or cross, the terminal only on failure (unless `quiet`). */
async function compile(o, quiet = false) {
    const bad = (0, xheep_1.unbuildablePathChars)(`${fs.realpathSync(root)}${fs.realpathSync(swRoot)}`);
    if (bad.length) {
        vscode.window.showErrorMessage(`${soc.name}: the project's path has ${bad.map(c => `"${c}"`).join(' ')}, which ${soc.name}'s build cannot handle. `
            + 'Rename or move the folder (letters, digits, -, _ and . are fine).');
        return false;
    }
    await setBuildStatus(o.project, 'running');
    // CMake globs the sources at configure time, so a new or removed file needs the full `make app`.
    // A platform generated again, here or by hand, needs the full build.
    const key = JSON.stringify([(0, xheep_1.buildCommand)(o), mtime(path.join(root, soc.generated)), listFiles(appDir(o.project))]);
    const jobs = os.cpus().length;
    const incremental = state.get('lastBuildKey') === key && fs.existsSync(path.join(root, 'sw', 'build', 'Makefile'));
    // The log is kept to explain what the problem matcher cannot (see reportBuildProblems).
    const logged = (cmd) => `set -o pipefail; { ${cmd}; } 2>&1 | tee '${buildLog()}'`;
    const task = incremental
        ? makeTask(`Build ${o.project}`, logged((0, xheep_1.incrementalBuildCommand)(jobs)), true)
        : makeTask(`Build ${o.project}`, logged(withEnvSetup((0, xheep_1.buildCommand)(o))), true, { MAKEFLAGS: `-j${jobs}` });
    buildProblems.clear();
    const ok = await runQuiet(`Build of ${o.project}`, task, true, false);
    // A compile error keeps the configured tree valid; a failed full build may leave it half done.
    await state.update('lastBuildKey', ok || incremental ? key : undefined);
    await setBuildStatus(o.project, ok ? 'ok' : 'fail');
    const explained = reportBuildProblems(o, ok);
    if (!ok && !quiet) {
        vscode.window.showErrorMessage(`X-HEEP: build of ${o.project} failed.${explained ? ` ${explained}` : ''}`, ...(explained ? ['Show Problems'] : []), 'Show Log').then(pick => pick === 'Show Problems'
            ? vscode.commands.executeCommand('workbench.actions.view.problems') : pick && showTaskLog(task));
    }
    return ok;
}
const buildLog = () => path.join(os.tmpdir(), `xheep-ide-build-${process.pid}.log`);
const readText = (file) => { try {
    return fs.readFileSync(file, 'utf8');
}
catch {
    return '';
} };
/** GCC's stack usage files (-fstack-usage) of the last build, concatenated. */
function stackUsage() {
    const dir = path.join(root, 'sw', 'build', 'CMakeFiles', 'main.elf.dir');
    return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.su')).map(e => readText(path.join(e.parentPath, e.name))).join('') : '';
}
/**
 * Puts in the Problems panel what a newcomer needs and the problem matcher misses: linker failures explained
 * (memory overflow, functions that need an OS) and functions too big for X-HEEP's stack. Returns the first
 * error's explanation, for the failure message.
 */
function reportBuildProblems(o, ok) {
    const app = appDir(o.project);
    const appReal = fs.realpathSync(app);
    const isAppFile = (file) => { try {
        return fs.realpathSync(file).startsWith(appReal + path.sep);
    }
    catch {
        return false;
    } };
    const ld = readText(path.join(root, 'sw', 'linker', (0, xheep_1.linkerScript)(o)));
    const stack = (0, xheep_1.stackSize)(ld);
    const problems = [
        ...(ok ? [] : (0, xheep_1.explainBuild)(readText(buildLog()), (0, xheep_1.memoryRegions)(ld), isAppFile)),
        ...(stack ? (0, xheep_1.stackProblems)(stackUsage(), stack, isAppFile) : []),
    ];
    // Whole-app problems (memory) go on the app's main file.
    const main = ['main.c', 'main.cpp', 'main.S'].map(f => path.join(app, f)).find(fs.existsSync) ?? path.join(app, 'main.c');
    showProblems(buildProblems, problems, main);
    return problems.find(p => p.severity === 'error')?.message;
}
/** Puts problems in the Problems panel; those of no file in particular go on `fallback`. */
function showProblems(collection, problems, fallback) {
    const byFile = new Map();
    for (const p of problems) {
        const line = Math.max((p.line ?? 1) - 1, 0);
        const d = new vscode.Diagnostic(new vscode.Range(line, Math.max((p.column ?? 1) - 1, 0), line, 1000), p.message, { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information }[p.severity]);
        d.source = 'X-HEEP';
        const file = p.file ?? fallback;
        byFile.set(file, [...byFile.get(file) ?? [], d]);
    }
    byFile.forEach((ds, file) => collection.set(vscode.Uri.file(file), ds));
}
async function build(app) {
    const o = options(app);
    // No RTL model needed just to compile.
    return await prepare({ ...o, mode: o.mode === 'sim' ? 'fpga-jtag' : o.mode }) && compile(o);
}
function simDir(sim) {
    const build = path.join(hwRoot, 'build');
    const core = fs.existsSync(build) ? fs.readdirSync(build).find(xheep_1.isCoreBuildDir) : undefined;
    return core && path.join(build, core, path.dirname(xheep_1.SIM_MODEL[sim]));
}
/** Whether "X-HEEP UART" ends with a newline: program output may stop mid-line (e.g. halted in a handler). */
let uartAtLineStart = true;
function uartAppend(text) {
    if (text) {
        uart.append(text);
        uartAtLineStart = text.endsWith('\n');
    }
}
/** Closes a run in "X-HEEP UART" with its result line, on a line of its own, and a blank line. */
function uartClose(line) {
    uart.appendLine(`${uartAtLineStart ? '' : '\n'}── ${line}`);
    uart.appendLine('');
    uartAtLineStart = true;
}
/** Opens a run in "X-HEEP UART" with a header line. */
function uartHeader(title) {
    uart.appendLine(`${uartAtLineStart ? '' : '\n'}── ${title} · ${new Date().toLocaleTimeString()} ${'─'.repeat(30)}`);
    uartAtLineStart = true;
    uart.show(true);
}
/**
 * Follows a simulator's UART log (or a task's output: `raw`, kept as it is) as it grows, passing on new text; the
 * returned function flushes and stops.
 */
function followFile(file, onText, raw = false) {
    fs.rmSync(file, { force: true }); // else the first poll would replay the previous run
    let offset = 0;
    const pump = () => {
        const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
        if (size > offset) {
            const fd = fs.openSync(file, 'r');
            const buf = Buffer.alloc(size - offset);
            fs.readSync(fd, buf, 0, buf.length, offset);
            fs.closeSync(fd);
            onText(raw ? buf.toString() : (0, xheep_1.printable)(buf.toString()));
            offset = size;
        }
    };
    const poll = setInterval(pump, 250);
    return () => { clearInterval(poll); pump(); };
}
/** Streams a simulator's UART log into "X-HEEP UART" under a header; the returned function flushes and stops. */
function tailUart(uartLog, title) {
    uartHeader(title);
    return followFile(uartLog, uartAppend);
}
/** Starts a shell command in its own process group with its output logged to "X-HEEP". */
function startJob(cmd, cwd, env = {}) {
    output.appendLine(`\n$ ${cmd}`);
    const proc = (0, child_process_1.spawn)('/bin/bash', ['-c', cmd], { cwd, env: { ...process.env, ...taskEnv(), ...env }, detached: true });
    let log = '';
    const onData = (d) => { log += d; output.append(d.toString()); };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    return {
        log: () => log,
        done: new Promise(resolve => proc.on('close', resolve)),
        // detached: the negative pid also stops what the shell started (make, fusesoc, the simulator).
        kill: () => { try {
            process.kill(-proc.pid, 'SIGTERM');
        }
        catch { /* already gone */ } },
    };
}
/** Sends a command to OpenOCD's Tcl server (port 6666); resolves with its reply, '' if unreachable. */
function openocdTcl(cmd) {
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
        sock.on('error', () => { });
    });
}
/** Polls `test` until it holds (true), the timeout passes or `abort` settles (false). */
async function waitUntil(test, timeoutMs, abort) {
    let aborted = false;
    abort?.then(() => { aborted = true; });
    for (const end = Date.now() + timeoutMs; Date.now() < end && !aborted; await new Promise(r => setTimeout(r, 250))) {
        if (test()) {
            return true;
        }
    }
    return test();
}
/**
 * Runs the built app on the RTL model, its log to "X-HEEP" and its UART text to `onText`. Stops it on an exception
 * (X-HEEP then spins in its handler forever), on `token` or after `timeoutMs`; undefined when stopped by `token`.
 */
async function runSim(o, onText, token, timeoutMs) {
    // shortcut: Questasim's UART log is assumed to be uart0.log in sim-modelsim/ like Verilator's, unverified.
    const dir = simDir(o.simulator);
    let job;
    let seen = '';
    let exception;
    let timedOut = false;
    const stopUart = followFile(dir ? path.join(dir, 'uart0.log') : '', text => {
        onText(text);
        seen += text;
        exception ??= (0, xheep_1.uartException)(seen);
        if (exception) {
            job?.kill();
        }
    });
    job = startJob(o.simulator === 'verilator' && dir ? (0, xheep_1.verilatorRunCommand)(dir, o.linker) : withEnvSetup((0, xheep_1.simCommand)(o)), hwRoot);
    const sim = job;
    const cancel = token.onCancellationRequested(sim.kill);
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; sim.kill(); }, timeoutMs) : undefined;
    const code = await sim.done;
    clearTimeout(timer);
    cancel.dispose();
    stopUart();
    if (exception) {
        return { ok: false, text: `exception: ${exception}`, exception };
    }
    if (timedOut) {
        return { ok: false, text: `no exit after ${timeoutMs / 1000} s` };
    }
    return code === null ? undefined : (0, xheep_1.simSummary)(sim.log());
}
/** Runs the simulation in the background: its log goes to "X-HEEP", only the app's UART to "X-HEEP UART". */
async function simulate(o) {
    uartHeader(o.project);
    const summary = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Simulating ${o.project}…`, cancellable: true }, (_progress, token) => runSim(o, uartAppend, token));
    uartClose(summary ? `${summary.ok ? '✓' : '✗'} ${summary.text}` : 'stopped');
    if (summary?.exception) {
        vscode.window.showWarningMessage(`X-HEEP: ${o.project} hit an exception (${summary.exception}) and stopped. Run it in Debug to see where.`);
    }
    else if (summary?.text.startsWith('memory access outside')) {
        vscode.window.showWarningMessage(`X-HEEP: ${o.project} accessed an address outside X-HEEP's memory map. `
            + 'This is usually a NULL or wrong pointer, e.g. after a failed fopen or malloc, or a register address from another board.');
    }
    else if (summary?.text === 'simulation failed') {
        vscode.window.showErrorMessage(`X-HEEP: simulation of ${o.project} failed.`, 'Show Log').then(pick => pick && output.show());
    }
    return summary;
}
/** Runs the app in the current mode; for simulation and JTAG, resolves with the result shown in "X-HEEP UART". */
async function run(app) {
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
async function flash(o, { bitstream, tool }) {
    if (bitstream && tool && !await loadFpga(tool)) {
        return;
    }
    if (await runTask(makeTask(`Flash ${o.project}`, xheep_1.FLASH_COMMAND)) !== 0) {
        return;
    }
    // Before X-HEEP boots, so its first output is not lost. No end to wait for here: it streams until the next run.
    await streamSerial(`${o.project} · from flash`);
    if (!bitstream || !tool) {
        vscode.window.showInformationMessage('Flash programmed. Press RESET on the FPGA to start the program.'
            + (bitstream ? '' : ' Set "xheep.bitstream" to have the FPGA restarted for you.'));
    }
    else if (await loadFpga(tool, bitstream)) {
        vscode.window.showInformationMessage(`X-HEEP: ${o.project} is booting from flash (the boot select switch must be set to flash).`);
    }
}
/**
 * Gets OpenOCD talking to X-HEEP on the board: loads the bitstream if this window has not yet, reloads it once
 * when OpenOCD cannot reach the debug module, then resets X-HEEP. The OpenOCD job is pushed to `jobs`.
 */
async function connectFpga({ bitstream, tool }, jobs, cancelled) {
    const adapter = await jtagAdapter(true);
    if (!adapter) {
        return false; // no adapter picked
    }
    refreshUi();
    const reload = bitstream && tool ? () => loadFpga(tool, bitstream) : undefined;
    // What the board holds is unknown until this window loads it once.
    if (reload && loadedBitstream !== bitstreamKey(bitstream) && !await reload()) {
        return false; // reported by loadFpga
    }
    const openocd = toolExe('openocdPath', 'openocd');
    /** 'ok', or 'no-dm' when OpenOCD (which opens the GDB port anyway) cannot reach the RISC-V debug module. */
    const connect = async () => {
        const ocd = startJob((0, xheep_1.openocdCommand)(openocd, path.resolve(root, adapter.config)), root);
        jobs.push(ocd);
        const up = await waitUntil(() => ocd.log().includes('Listening on port 3333'), 20_000, ocd.done);
        return !up ? 'down' : /examination failed|dtmcontrol is 0/.test(ocd.log()) ? 'no-dm' : 'ok';
    };
    let link = await connect();
    // An unconfigured FPGA (power cycled) or another bitstream: reload it once and retry.
    if (link === 'no-dm' && reload && !cancelled()) {
        const stale = jobs.pop();
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
                    : 'Check that the bitstream is loaded (set "xheep.bitstream" to have it loaded for you) and the JTAG adapter is wired to X-HEEP.'), 'Show Log').then(pick => pick && output.show());
        return false;
    }
    // ndmreset: every run starts from a fresh X-HEEP, also when the hart hung on a bus access and no longer halts.
    await openocdTcl('reset halt');
    return true;
}
/** A code address as `function (file:line)`, through addr2line; undefined when the ELF has nothing there. */
async function locate(elf, addr) {
    const addr2line = findTool('-elf-addr2line');
    if (!addr2line) {
        return undefined;
    }
    const out = await new Promise(resolve => (0, child_process_1.execFile)(addr2line, ['-f', '-s', '-e', elf, `0x${addr.toString(16)}`], (err, o) => resolve(err ? '' : o)));
    const [fn, line] = out.trim().replace(/ \(discriminator \d+\)$/, '').split('\n');
    return fn && fn !== '??' ? { fn, text: `${fn}${line && !line.startsWith('??') ? ` (${line})` : ''}` } : undefined;
}
/** The exception X-HEEP is handling (halted), with where it happened: `illegal instruction in main (main.c:5)`. */
async function exceptionSite(elf) {
    const cause = (0, xheep_1.regValue)(await openocdTcl('reg mcause'), 'mcause');
    const epc = (0, xheep_1.regValue)(await openocdTcl('reg mepc'), 'mepc');
    const at = epc === undefined ? undefined : await locate(elf, epc);
    return `${cause === undefined ? 'exception' : (0, xheep_1.exceptionCause)(cause)}${at ? ` in ${at.text}` : ''}`;
}
/** X-HEEP's exception handlers (sw/device/lib/runtime/handler.c), where a faulting program ends up spinning. */
const EXCEPTION_HANDLER = /^(print_exc_msg|handler_exception|handler_\w+_fault|handler_bkpt|handler_ecall)$/;
/**
 * Where a program stopped with Cancel is: halts X-HEEP and maps its pc to a function and line, or to the
 * exception it is stuck in. When the hart does not halt, it hangs on a bus access nobody answers; it is then
 * reset, so the next run needs no bitstream reload.
 */
async function whereStopped(elf) {
    await openocdTcl('halt');
    const pc = (0, xheep_1.regValue)(await openocdTcl('reg pc'));
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
async function runJtag(o, fpga) {
    const gdb = findTool('-elf-gdb');
    if (!gdb) {
        vscode.window.showErrorMessage(`No *-elf-gdb found in ${toolchain()}/bin. Set "xheep.riscvToolchain".`);
        return;
    }
    const elf = path.join(root, 'sw', 'build', 'main.elf');
    const jobs = [];
    let gdbJob;
    let stopUart;
    let cancelled = false;
    let seen = '';
    let exception;
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
            exception ??= (0, xheep_1.uartException)(seen);
            if (exception) {
                gdbJob?.kill();
            }
        });
        progress.report({ message: 'running…' });
        gdbJob = startJob((0, xheep_1.gdbRunCommand)(gdb, elf), root);
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
        return (0, xheep_1.exitCode)(gdbJob.log());
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
    }
    else if (site) {
        vscode.window.showWarningMessage(`X-HEEP: ${o.project} hit an exception: ${site}.`);
    }
    else if (result && code === undefined) {
        vscode.window.showErrorMessage(`X-HEEP: ${o.project} did not run to the end on the FPGA.`, 'Show Log').then(pick => pick && output.show());
    }
    return result;
}
const debugSimDir = () => path.join(hwRoot, xheep_1.DEBUG_BUILD_ROOT, 'sim-verilator');
const debugModelReady = () => modelFresh(path.join(debugSimDir(), 'Vtestharness'), 'debug');
// shortcut: saves during a debug model build are not tracked (savedDuringBuild), so such an edit waits for the next one.
async function buildDebugModel() {
    const task = makeTask('Build debug model', (0, xheep_1.debugModelBuildCommand)(soc.id), false, {}, hwRoot);
    const ok = await runQuiet('Building verilator debug model', task, true, false);
    if (ok) {
        await modelBuilt('debug');
    }
    reportModelProblems('verilator debug model', debugSimDir(), ok, task);
    return ok;
}
/** Debug sessions to end when the program reaches its exit (Soc.exitSymbol), by session name, with what to do with the exit code. */
const exitWatchers = new Map();
/** Ends a debug session when it stops at the exit (exitBreakpoint), as the simulator does on its own. */
function exitTracker(session) {
    const onExit = exitWatchers.get(session.name);
    return onExit && {
        onDidSendMessage: async (m) => {
            if (m.type !== 'event' || m.event !== 'stopped') {
                return;
            }
            try {
                const top = (await session.customRequest('stackTrace', { threadId: m.body?.threadId, startFrame: 0, levels: 1 })).stackFrames?.[0];
                if (!top?.name?.startsWith(soc.exitSymbol)) {
                    return;
                }
                const a0 = await session.customRequest('evaluate', { expression: '$a0', frameId: top.id, context: 'watch' });
                onExit(Number(a0.result));
                vscode.debug.stopDebugging(session);
            }
            catch { /* the session went away meanwhile */ }
        },
    };
}
/**
 * Debugs the app with the VS Code debugger (cppdbg + GDB) through OpenOCD: on the simulated X-HEEP
 * in Simulation mode, on the FPGA board otherwise. The extension owns OpenOCD and the simulator,
 * and stops them when the debug session ends, at the latest when the program reaches `_exit`.
 */
async function debug(app) {
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
    const jobs = [];
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
        const firmware = path.join(root, 'sw', 'build', o.linker ? `main.${o.linker}.elf` : 'main.hex');
        const simJob = startJob((0, xheep_1.debugSimCommand)(dir, firmware, o.linker), dir);
        jobs.push(simJob);
        // The bitbang server accepts a single client, so wait for its banner instead of probing the port.
        if (!await waitUntil(() => simJob.log().includes('Listening on port 4567'), 30_000, simJob.done)) {
            return false;
        }
        const ocdLog = path.join(dir, 'openocd.log'); // X-HEEP's tb/core-v-mini-mcu.cfg logs there, X-ALP's to stderr
        fs.rmSync(ocdLog, { force: true });
        const ocd = startJob((0, xheep_1.openocdCommand)(openocd, path.join(root, 'tb', 'core-v-mini-mcu.cfg')), dir, { JTAG_VPI_PORT: '4567' });
        jobs.push(ocd);
        return waitUntil(() => `${readText(ocdLog)}${ocd.log()}`.includes('Listening on port 3333'), 60_000, ocd.done);
    });
    if (!ready) {
        cleanup();
        if (!cancelled) {
            vscode.window.showErrorMessage('X-HEEP: OpenOCD did not come up.', 'Show Log').then(pick => pick && output.show());
        }
        return;
    }
    const name = `X-HEEP: ${o.project}`;
    let exit;
    exitWatchers.set(name, code => { exit = code; });
    const ended = vscode.debug.onDidTerminateDebugSession(s => {
        if (s.name === name) {
            ended.dispose();
            exitWatchers.delete(name);
            cleanup();
            const summary = exit !== undefined ? { ok: exit === 0, text: `exit ${exit}` } : sim ? (0, xheep_1.simSummary)(jobs[0].log()) : undefined;
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
        // cppdbg fails on GDB's "riscv:rv32" ('arch' out of range); any value of the same width skips that detection.
        targetArchitecture: soc.linkers ? 'arm64' : 'arm',
        // Exactly sw/gdbInit: cppdbg's own remote launch uses plain `target remote` and its own steps.
        // Breakpoints set in the editor are inserted after these commands, before the final continue.
        setupCommands: [{ text: 'set remotetimeout 2000' }],
        // With custom launch commands cppdbg no longer loads the ELF into GDB itself, hence `file`.
        customLaunchSetupCommands: [
            { text: `file '${path.join(root, 'sw', 'build', 'main.elf')}'` },
            { text: 'target extended-remote :3333' },
            { text: 'load' },
            // Not in the Breakpoints view: exitTracker ends the session there.
            { text: (0, xheep_1.exitBreakpoint)(soc.exitSymbol) },
        ],
        launchCompleteCommand: 'exec-continue',
    });
    if (!started) {
        ended.dispose();
        exitWatchers.delete(name);
        cleanup();
    }
}
function serialCandidates() {
    const byId = '/dev/serial/by-id';
    return [
        ...(fs.existsSync(byId) ? fs.readdirSync(byId).map(f => path.join(byId, f)) : []),
        ...fs.readdirSync('/dev').filter(f => /^(tty\.usbserial|ttyUSB)/.test(f)).map(f => path.join('/dev', f)),
    ];
}
/** `xheep.serialPort`, else the X-HEEP UART if connected (see pickSerialPort), else the user's pick (then saved). */
async function serialPort() {
    const set = cfg().get('serialPort', '');
    if (set && fs.existsSync(set)) {
        return set;
    }
    const candidates = serialCandidates();
    const auto = (0, xheep_1.pickSerialPort)(candidates);
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
let serialJob;
const stopSerial = () => { serialJob?.kill(); serialJob = undefined; };
/**
 * Streams the board's UART into "X-HEEP UART" under a header, as for simulations; the returned function stops it.
 * Left running, it stops at the next stream or serial monitor.
 */
async function streamSerial(title, onText = () => { }) {
    const port = await serialPort();
    stopSerial();
    vscode.window.terminals.find(t => t.name === 'X-HEEP UART')?.dispose(); // a serial monitor holds the port too
    uartHeader(title);
    if (!port) {
        return () => { };
    }
    const proc = (0, child_process_1.spawn)('/bin/bash', ['-c', (0, xheep_1.serialReadCommand)(port, cfg().get('serialBaud', 9600))], { detached: true });
    proc.stdout.on('data', (d) => {
        const text = (0, xheep_1.printable)(d.toString());
        uartAppend(text);
        onText(text);
    });
    proc.stderr.on('data', (d) => output.append(d.toString()));
    const job = { kill: () => { try {
            process.kill(-proc.pid, 'SIGTERM');
        }
        catch { /* already gone */ } } };
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
        shellArgs: ['-b', String(cfg().get('serialBaud', 9600)), '-r', '-l', '--imap', 'lfcrlf', port],
    }).show(true);
}
async function buildSimModel() {
    const sim = cfg().get('simulator', 'verilator');
    return (platformReady() || await generatePlatform(false)) && buildModel(sim, false);
}
function mcuGen() {
    return generatePlatform(false);
}
// --- Hardware development ---------------------------------------------------
// For whoever changes the RTL: waveforms, SystemVerilog editing through the Verible extension, the memory map,
// and every app run on the changed model (Testing view).
const SURFER = 'surfer-project.surfer';
const VERIBLE = 'chipsalliance.verible';
/** Opens the newest waveform Verilator wrote (its testbench always dumps waveform.fst), in Surfer or else GTKWave. */
async function openWaves() {
    const fst = [simDir('verilator'), debugSimDir()].flatMap(d => d ? [path.join(d, 'waveform.fst')] : []).filter(fs.existsSync)
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (!fst) {
        vscode.window.showInformationMessage('X-HEEP: no waveform yet. Run an app in Simulation with Verilator: it writes waveform.fst.');
        return;
    }
    if (!vscode.extensions.getExtension(SURFER) && await sh('command -v gtkwave', false)) {
        (0, child_process_1.spawn)('gtkwave', [fst], { cwd: path.dirname(fst), detached: true, stdio: 'ignore', env: { ...process.env, ...taskEnv() } }).unref();
        return;
    }
    if (await ensureExtension(SURFER, 'Viewing waveforms in VS Code')) {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fst));
    }
}
/** Adds a line to a file if missing (a .gitignore, git's info/exclude). */
function addLine(file, entry) {
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
    if (!lines.includes(entry)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${lines.length && lines[lines.length - 1] !== '' ? '\n' : ''}${entry}\n`);
    }
}
/**
 * Writes verible.filelist in the project, the files of the Verilator model, so verible-verilog-ls finds modules,
 * packages and includes across files. Kept out of git in .git/info/exclude: X-HEEP's own .gitignore stays as is.
 */
function writeVeribleFileList() {
    const dir = simDir('verilator');
    const vc = dir && fs.existsSync(dir) ? fs.readdirSync(dir).find(f => f.endsWith('.vc')) : undefined;
    if (!dir || !vc) {
        return;
    }
    fs.writeFileSync(path.join(projectDir(), 'verible.filelist'), (0, xheep_1.veribleFileList)(readText(path.join(dir, vc)), dir));
    (0, child_process_1.execFile)('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: projectDir() }, (err, out) => {
        if (!err) {
            addLine(path.resolve(projectDir(), out.trim()), 'verible.filelist');
        }
    });
}
/**
 * Sets the Verible extension up for X-HEEP (where the user has not): its language server from the verible install
 * X-HEEP uses, so formatting matches X-HEEP's, and as the SystemVerilog formatter. Offers it once when missing.
 */
async function setupVerible(offer) {
    if (!vscode.extensions.getExtension(VERIBLE)) {
        if (offer && !state.get('veribleOffered')) {
            await state.update('veribleOffered', true);
            await ensureExtension(VERIBLE, 'SystemVerilog lint, formatting as X-HEEP does it and go to definition across modules');
        }
        return;
    }
    const verible = vscode.workspace.getConfiguration('verible', folder.uri);
    const ls = (await shOut('command -v verible-verilog-ls')).out.trim().split('\n').pop();
    if (verible.inspect('path')?.workspaceValue === undefined && ls && path.isAbsolute(ls)) {
        await verible.update('path', ls, vscode.ConfigurationTarget.Workspace);
    }
    if (verible.inspect('arguments')?.workspaceValue === undefined) {
        // A project's own .rules.verible_lint applies, as for verible-verilog-lint.
        await verible.update('arguments', ['--rules_config_search'], vscode.ConfigurationTarget.Workspace);
    }
    for (const language of ['systemverilog', 'verilog']) {
        const editor = vscode.workspace.getConfiguration('editor', { uri: folder.uri, languageId: language });
        if (editor.inspect('defaultFormatter')?.workspaceLanguageValue === undefined) {
            await editor.update('defaultFormatter', VERIBLE, vscode.ConfigurationTarget.Workspace, true);
        }
    }
}
/** Formats an RTL file on save as X-HEEP's util/format-verible would, only in the folders it covers (not vendored IPs). */
function formatOnSave(e) {
    const file = e.document.uri.fsPath;
    const dirs = (0, xheep_1.formattedDirs)(readText(path.join(root, 'util', 'format-verible'))).map(d => path.join(root, d) + path.sep);
    // Another formatter (e.g. of a Verilog extension) would not format as X-HEEP's CI checks.
    if (cfg().get('formatRtlOnSave', true) && vscode.extensions.getExtension(VERIBLE)
        && /\.sv/.test(path.basename(file)) && dirs.some(d => file.startsWith(d))) {
        e.waitUntil(Promise.resolve(vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', e.document.uri, { tabSize: 2, insertSpaces: true })).then(edits => edits ?? []));
    }
}
class MemoryMapProvider {
    nodes;
    emitter = new vscode.EventEmitter();
    onDidChangeTreeData = this.emitter.event;
    refresh() { this.nodes = undefined; this.emitter.fire(); }
    getChildren(node) {
        return node ? node.children : this.nodes ??= platformScript(platformMode() === 'manual' ? 'generated' : 'map', configPath()).then(r => r.error
            ? [{ label: 'The platform cannot be read', description: '', tooltip: r.error, children: [] }] : (0, platform_1.mapNodes)(r.map, soc.id));
    }
    getTreeItem(node) {
        const item = new vscode.TreeItem(node.label, node.children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.description = node.description;
        item.tooltip = node.tooltip && new vscode.MarkdownString(node.tooltip);
        item.contextValue = node.address !== undefined ? 'address' : undefined;
        return item;
    }
}
let memoryMap;
let appTests;
/** The apps in the Testing view, as in the Applications view: yours, then X-HEEP's examples. */
function loadAppTests() {
    const item = (app) => appTests.createTestItem(app, app, vscode.Uri.file(appDir(app)));
    // Test ids cannot hold \0 (EXAMPLES): a / cannot appear in an app's folder name either.
    const examples = appTests.createTestItem('examples/', 'Examples');
    examples.children.replace(exampleApps().map(item));
    appTests.items.replace([...userApps().map(item), examples]);
}
/**
 * Runs apps on the simulation model of the active platform, as X-HEEP's app test does: an app passes when it
 * exits with 0. Apps that test leaves out are skipped (with its reason), unless picked one by one.
 */
async function runAppTests(req, token) {
    const run = appTests.createTestRun(req);
    const leaves = (items) => items.flatMap(i => {
        const children = [];
        i.children.forEach(c => children.push(c));
        return children.length ? leaves(children) : [i];
    });
    const top = [];
    appTests.items.forEach(i => top.push(i));
    const items = leaves([...req.include ?? top]).filter(i => !req.exclude?.includes(i) && i.id !== 'examples/');
    const { skip, timeoutS } = (0, xheep_1.appTestConfig)(readText(path.join(root, 'test', 'test_apps', 'test_apps.py')));
    items.forEach(i => run.enqueued(i));
    if (!await prepare(options(undefined, 'sim'))) {
        items.forEach(i => run.errored(i, new vscode.TestMessage('The platform or the simulation model did not build.')));
        run.end();
        return;
    }
    for (const item of items) {
        const reason = skip.get(item.id);
        if (token.isCancellationRequested || (reason && !req.include?.includes(item))) {
            if (reason && !token.isCancellationRequested) {
                run.appendOutput(`${item.id}: skipped, ${reason}\r\n`);
            }
            run.skipped(item);
            continue;
        }
        run.started(item);
        const start = Date.now();
        const o = options(item.id, 'sim');
        if (!await compile(o, true)) {
            run.failed(item, new vscode.TestMessage('The app does not build: see the Problems panel.'), Date.now() - start);
            continue;
        }
        const result = await runSim(o, text => run.appendOutput(text.replace(/\r?\n/g, '\r\n'), undefined, item), token, timeoutS * 1000);
        if (!result) {
            run.skipped(item);
        }
        else if (result.ok) {
            run.passed(item, Date.now() - start);
        }
        else {
            run.failed(item, new vscode.TestMessage(result.text), Date.now() - start);
        }
    }
    run.end();
}
/**
 * The tools X-HEEP needs, checked in depth: the Python environment runs and has X-HEEP's packages, Verilator and
 * verible are the versions X-HEEP's setup guide uses. The environment check reports them; Set Up Tools fixes them.
 */
async function toolChecks() {
    const fpga = currentMode() !== 'sim';
    const found = async (cmd) => (await shOut(`command -v ${cmd}`, true)).ok;
    const wanted = (0, xheep_1.requiredVersions)(readText(path.join(root, 'docs', 'source', 'GettingStarted', 'Setup.md')));
    const version = (what, got, want, why) => !got ? { state: 'fail', text: what, hint: `not found: install ${what} ${want ?? ''}`.trim() }
        : want && got !== want ? { state: 'warn', text: `${what} ${got}`, hint: `X-HEEP uses ${want}: ${why}` }
            : { state: 'ok', text: `${what} ${got}` };
    const questa = cfg().get('simulator', 'verilator') === 'questasim';
    const sim = questa
        ? { label: 'Questasim', ...(await found('vsim') ? { state: 'ok', text: 'Questasim (vsim)' } : { state: 'fail', text: 'Questasim (vsim)', hint: 'vsim is not on PATH' }) }
        : { label: 'Verilator', ...version('Verilator', (0, xheep_1.verilatorVersion)((await shOut(`'${toolExe('verilatorPath', 'verilator')}' --version`, true)).out), wanted.verilator, 'others may fail to build the simulation model') };
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
            ...version('verible', (0, xheep_1.veribleVersion)((await shOut(`'${toolExe('veriblePath', 'verible-verilog-format')}' --version`, true)).out), wanted.verible, 'platform generation would reformat X-HEEP\'s own files differently (they show as modified)'),
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
async function pythonCheck() {
    const setup = cfg().get('envSetup', '').trim();
    const text = `Python environment: ${setup || 'the repository .venv'}`;
    const env = await shOut('true');
    if (!env.ok) {
        const name = (0, xheep_1.condaEnvName)(setup);
        const conda = !name || (await shOut('command -v conda', true)).ok;
        const envs = conda && name ? (await shOut('conda env list', true)).out.split('\n').map(l => l.split(/\s+/)[0]) : [];
        return {
            state: 'fail', text, hint: !conda ? 'conda is not on PATH'
                : name && !envs.includes(name) ? `there is no conda environment "${name}"` : `it fails: ${env.out.trim().split('\n').pop()}`,
        };
    }
    const missing = (await shOut((0, xheep_1.missingModulesCommand)(soc.pythonModules))).out.trim().split('\n').pop()?.trim();
    return missing ? { state: 'fail', text, hint: `it lacks ${soc.name}'s Python packages (${missing.split(' ').join(', ')})` }
        : { state: 'ok', text: `${text} (${soc.name}'s packages present)` };
}
/** Vivado is on PATH and starts: enables "Build Bitstream", which is the only thing that needs it. */
let hasVivado = false;
/** Runs a command in X-HEEP's root, after `xheep.envSetup` unless `raw`, with its output. */
function shOut(cmd, raw = false) {
    return new Promise(resolve => (0, child_process_1.execFile)('/bin/bash', ['-c', raw ? cmd : withEnvSetup(cmd)], { cwd: root, env: { ...process.env, ...taskEnv() } }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}` })));
}
const canUse = (node) => { try {
    fs.accessSync(node, fs.constants.R_OK | fs.constants.W_OK);
    return true;
}
catch {
    return false;
} };
/**
 * What the FPGA modes need from the hardware: the JTAG adapter, the flash programmer and the board's USB usable
 * (udev), the UART (dialout), iceprog buildable for the flash. Hardware that is not plugged in is a note, not a
 * problem: working in simulation only is the norm, and a run on the board says itself what is missing.
 */
async function checkHardware(report, note) {
    const mode = currentMode();
    const needed = new Map(); // USB id -> what for
    if (mode === 'fpga-jtag') {
        const adapter = await jtagAdapter(false);
        if (adapter?.usb) {
            needed.set(adapter.usb, `${adapter.label} (JTAG)`);
        }
        else if (!adapter) {
            const bitstream = bitstreamFile();
            const fit = (0, xheep_1.boardAdapters)(fpgaBoard(), bitstream ? bitstreamInfo(bitstream)?.bscan : undefined).filter(a => !a.bscan);
            note(`JTAG adapter: none connected (for the FPGA: ${fit.map(a => a.label).join(' or ')} on X-HEEP's PMOD JTAG pins)`);
        }
    }
    if (mode === 'fpga-flash') {
        needed.set(xheep_1.EPFL_PROGRAMMER_USB, 'EPFL Programmer (SPI flash)');
    }
    const board = xheep_1.BOARDS[fpgaBoard()];
    if (board?.usb && bitstreamFile() && (await programmer()) === 'openocd') {
        needed.set(board.usb, needed.has(board.usb) ? `${needed.get(board.usb)} and ${fpgaBoard()} USB (bitstream)` : `${fpgaBoard()} USB (loads the bitstream)`);
    }
    const devices = (0, xheep_1.usbDevices)();
    for (const [id, what] of needed) {
        const [vid, pid] = id.split(':');
        const dev = devices.find(d => d.vid === vid && d.pid === pid);
        if (!dev) {
            note(`${what}: not connected (USB ${id})`);
        }
        else if (!canUse(dev.node)) {
            report('fail', `${what}: no permission on ${dev.node}`, `allow users to open it: echo '${(0, xheep_1.udevRule)(vid, pid)}' | sudo tee /etc/udev/rules.d/60-xheep.rules`
                + ' && sudo udevadm control --reload && sudo udevadm trigger, then plug it in again');
        }
        else {
            report('ok', `${what}: connected`);
        }
    }
    const set = cfg().get('serialPort', '');
    const port = set && fs.existsSync(set) ? set : (0, xheep_1.pickSerialPort)(serialCandidates());
    if (!port) {
        note('UART: no serial port found (the EPFL programmer has it, or set "xheep.serialPort")');
    }
    else if (!canUse(port)) {
        report('fail', `UART: no permission on ${port}`, 'join the dialout group: sudo usermod -aG dialout $USER, then log out and in');
    }
    else {
        report('ok', `UART: ${port}`);
    }
    if (mode === 'fpga-flash' && !fs.existsSync(path.join(root, 'sw', 'vendor', 'yosyshq_icestorm', 'iceprog', 'iceprog'))
        && !(await shOut('pkg-config --exists libftdi1 || pkg-config --exists libftdi', true)).ok) {
        report('fail', 'iceprog (programs the flash): cannot be built', 'libftdi is missing: sudo apt install libftdi1-dev pkg-config');
    }
}
async function checkEnv(quiet = false) {
    const fixes = [];
    const lines = [];
    const counts = { fail: 0, warn: 0 };
    const report = (state, what, hint = '') => {
        lines.push(`${{ ok: '✓', fail: '✗', warn: '⚠' }[state]} ${what}${state === 'ok' || !hint ? '' : `  -> ${hint}`}`);
        if (state !== 'ok') {
            counts[state]++;
        }
    };
    const note = (text) => lines.push(`  ${text}`);
    const addFix = (label, run) => { if (!fixes.some(f => f.label === label)) {
        fixes.push({ label, run });
    } };
    const tools = await toolChecks();
    for (const c of tools) {
        if (c.state === 'ok') {
            report('ok', c.text);
        }
        else if (c.needed) {
            report(c.state, c.text, c.hint);
        }
        else {
            note(`${c.text}: ${c.hint} (needed for ${c.usedBy})`);
        }
    }
    const envOk = tools.find(c => c.id === 'python')?.state === 'ok';
    // Set Up Tools finds, installs or replaces the tools that need it.
    if (tools.some(c => c.state !== 'ok' && c.needed)) {
        addFix('Fix…', () => fixTools(false));
        addFix('Open Setup Guide', () => vscode.env.openExternal(vscode.Uri.parse(xheep_1.SETUP_GUIDE)));
    }
    if (managedXheep() && soc.id === 'x-heep') { // the pinned commit is X-HEEP's
        const [head, pin] = await Promise.all([gitHead(), pinnedCommit()]);
        if (pin && head !== pin && !state.get('xheepOnMain')) {
            report('warn', `X-HEEP is at ${short(head)}, not at the commit tested with the extension (${short(pin)})`, 'run Update X-HEEP');
            addFix('Update X-HEEP', updateXheep);
        }
        else {
            note(`X-HEEP: ${short(head)}${head === pin ? ' (tested with the extension)' : state.get('xheepOnMain') ? ' (main, untested)' : ''}`);
        }
    }
    note(`Platform config: ${platformMode() === 'manual' ? `generated by hand, kept as it is (the selected one is ${configPath()})`
        : `${configPath()} (${platformReady() ? 'generated' : 'regenerated on the next build'})`}`);
    if (envOk) {
        // Vivado is optional (building bitstreams), but a broken install would fail every FPGA load through it.
        const vivadoOnPath = await sh('command -v vivado');
        hasVivado = vivadoOnPath && await sh('vivado -version');
        vscode.commands.executeCommand('setContext', 'xheep.hasVivado', hasVivado);
        if (vivadoOnPath && !hasVivado) {
            report('fail', 'Vivado is on PATH but does not start', 'run "vivado -version" in a terminal (recent Ubuntu releases need libtinfo5)');
        }
        else {
            note(`Vivado (optional, Build Bitstream): ${hasVivado ? 'found' : 'not found'}`);
        }
        note(`Verible extension (optional, SystemVerilog lint, formatting, go to definition): ${vscode.extensions.getExtension(VERIBLE) ? 'installed' : `not installed (${VERIBLE})`}`);
    }
    if (envOk && soc.id === 'x-heep') { // the FPGA flow is X-HEEP's only, for now
        const fpga = currentMode() !== 'sim';
        // Loading bitstreams only matters in the FPGA modes: elsewhere a missing tool is a note, not a problem.
        const tool = await programmer();
        if (tool || fpga) {
            report(tool ? 'ok' : 'fail', `FPGA programmer: ${tool ?? 'none'} (FPGA modes)`, xheep_1.BOARDS[fpgaBoard()]?.part ? 'install Vivado, or OpenOCD on boards it supports' : 'the extension cannot program this board');
        }
        else {
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
    }
    else if (!quiet) {
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
    for (;;) {
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
const setGlobal = (key, value) => cfg().update(key, value, vscode.ConfigurationTarget.Global);
/** Offers the found candidates, a manual pick, an install and the container for one tool; false if dismissed. */
async function fixTool(c) {
    const sep = (label) => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const settingFor = { verilator: 'verilatorPath', verible: 'veriblePath', openocd: 'openocdPath', picocom: 'picocomPath' };
    const exe = c.id === 'verible' ? 'verible-verilog-format' : c.id;
    let found = [];
    let locate;
    let install;
    if (c.id === 'python') {
        found = (0, tools_1.findPythonEnvs)(root).map(e => ({ label: e.label, detail: e.setup, run: () => setGlobal('envSetup', e.setup) }));
        locate = {
            label: '$(terminal) Use a setup script or command…', detail: 'e.g. a lab script or "module load", run before every command',
            run: async () => {
                const v = await vscode.window.showInputBox({ prompt: 'Shell command that activates the X-HEEP Python environment', value: cfg().get('envSetup') });
                return v !== undefined && setGlobal('envSetup', v);
            },
        };
        const conda = (0, tools_1.findConda)();
        install = conda
            ? { cmd: `PATH='${path.dirname(conda)}':$PATH make conda`, done: () => setGlobal('envSetup', (0, tools_1.condaSetup)(conda, 'x-heep')) }
            : { cmd: 'make venv', done: () => setGlobal('envSetup', (0, tools_1.venvSetup)(path.join(root, '.venv'))) };
    }
    else if (c.id === 'toolchain') {
        found = (0, tools_1.findToolchains)().map(d => ({ label: d, run: () => setGlobal('riscvToolchain', d) }));
        locate = {
            label: '$(folder-opened) Locate…', detail: 'The folder that contains bin/riscv32-…-elf-gcc',
            run: async () => {
                const d = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use this toolchain' }))?.[0]?.fsPath;
                return d && setGlobal('riscvToolchain', d);
            },
        };
        const url = (0, tools_1.toolchainUrl)();
        const dest = path.join(os.homedir(), '.riscv');
        if (url) {
            install = { cmd: (0, tools_1.toolchainInstallCommand)(url, dest), done: () => setGlobal('riscvToolchain', dest) };
        }
    }
    else if (settingFor[c.id]) {
        const key = settingFor[c.id];
        found = (0, tools_1.findExecutables)(exe).map(p => ({ label: p, run: () => setGlobal(key, p) }));
        locate = {
            label: '$(folder-opened) Locate…', detail: `The ${exe} executable`,
            run: async () => {
                const p = (await vscode.window.showOpenDialog({ canSelectFiles: true, openLabel: `Use this ${exe}` }))?.[0]?.fsPath;
                return p && setGlobal(key, p);
            },
        };
        if (c.id === 'verilator') {
            // Package managers ship other versions: build the one X-HEEP uses, as its setup guide does.
            const version = (0, tools_1.xheepVerilatorVersion)(root);
            install = {
                cmd: (0, tools_1.verilatorInstallCommand)(version),
                done: () => setGlobal(key, path.join((0, tools_1.verilatorPrefix)(version), 'bin', 'verilator')),
                note: `Builds Verilator ${version} from source into ${(0, tools_1.verilatorPrefix)(version)}, as in X-HEEP's setup guide. `
                    + 'Needs git, autoconf, flex, bison and g++ 13 or newer, and takes several minutes.',
            };
        }
        else if (c.id === 'verible') {
            // The release X-HEEP formats its sources with: another one reformats them differently.
            const version = (0, xheep_1.requiredVersions)(readText(path.join(root, 'docs', 'source', 'GettingStarted', 'Setup.md'))).verible;
            if (version) {
                install = {
                    cmd: (0, tools_1.veribleInstallCommand)(version),
                    done: () => setGlobal(key, path.join((0, tools_1.veriblePrefix)(version), 'bin', 'verible-verilog-format')),
                    note: `Downloads verible ${version} into ${(0, tools_1.veriblePrefix)(version)}, as in X-HEEP's setup guide.`,
                };
            }
        }
        else {
            const cmd = (0, tools_1.packageInstallCommand)(c.id);
            if (cmd) {
                install = { cmd, done: () => Promise.resolve() };
            }
        }
    }
    const items = [
        ...(found.length ? [sep('Found on this computer'), ...found] : []),
        sep('Other options'),
        ...(locate ? [locate] : []),
        ...(install ? [{
                label: '$(cloud-download) Install…', detail: install.cmd,
                run: async () => {
                    const ok = await vscode.window.showWarningMessage(`Install ${c.label}?`, { modal: true, detail: `${install.note ? install.note + '\n\n' : ''}This runs in a terminal:\n${install.cmd}` }, 'Install');
                    if (ok && await runTask(makeTask(`Install ${c.label}`, install.cmd, true)) === 0) {
                        await install.done();
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
async function ensureExtension(id, why) {
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
        fs.writeFileSync(file, (0, tools_1.devcontainerJson)(extensionId, (0, tools_1.xheepImageTag)(root)));
    }
    return await ensureExtension('ms-vscode-remote.remote-containers', 'The X-HEEP container')
        && vscode.commands.executeCommand('remote-containers.reopenInContainer');
}
// --- UI ---------------------------------------------------------------------
// Tree elements are app names, plus these two (\0 cannot appear in a folder name).
const EXAMPLES = '\0examples';
const NEW_APP = '\0new';
class AppsProvider {
    exampleCount = 0;
    emitter = new vscode.EventEmitter();
    onDidChangeTreeData = this.emitter.event;
    refresh() { loadExamples().then(() => { this.emitter.fire(); loadAppTests(); }); }
    getChildren(el) {
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
    getTreeItem(app) {
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
        item.iconPath = statusIcon(appStatus(app));
        if (app === currentApp()) {
            item.label = { label: app, highlights: [[0, app.length]] };
            item.description = 'active';
        }
        item.tooltip = appDir(app);
        item.command = { command: 'xheep.selectApp', title: 'Select App', arguments: [app] };
        return item;
    }
}
function statusIcon(status) {
    switch (status) {
        case 'ok': return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
        case 'fail': return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
        case 'running': return new vscode.ThemeIcon('sync~spin');
        default: return new vscode.ThemeIcon('circle-large-outline');
    }
}
function refreshUi() {
    apps.refresh();
    const app = currentApp();
    // The app's build, here or by hand (appStatus).
    const status = appStatus(app);
    const icon = status === 'ok' ? '$(pass)' : status === 'fail' ? '$(error)' : status === 'running' ? '$(sync~spin)' : '$(chip)';
    appItem.text = `${icon} ${app}`;
    appItem.tooltip = `${soc.name} application, the one whose file is open${status === 'ok' ? ' (built)' : status === 'fail' ? ' (build failed)' : ''}`;
    appItem.backgroundColor = status === 'fail' ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    // The run button tells the simulation model, built apart from the app: Run builds it first when it is not ready.
    const model = currentMode() === 'sim' ? modelStatus() : 'fpga';
    runItem.text = model === 'ok' || model === 'fpga' ? '$(play)' : model === 'fail' ? '$(error)' : model === 'running' ? '$(sync~spin)' : '$(tools)';
    runItem.color = model === 'ok' ? new vscode.ThemeColor('testing.iconPassed') : model === 'fail' ? new vscode.ThemeColor('testing.iconFailed') : undefined;
    runItem.tooltip = model === 'fpga' ? `Build and run ${app} on the FPGA`
        : model === 'ok' ? `Simulation model ready: build and run ${app}`
            : model === 'fail' ? `The simulation model failed to build (see buildsim.log): build it again, then build and run ${app}`
                : model === 'running' ? 'Building the simulation model…' : `Build the simulation model, then build and run ${app}`;
    modeItem.text = soc.linkers ? `$(target) Simulation · ${currentLinker().toUpperCase()}`
        : `$(target) ${xheep_1.MODES[currentMode()].label}${currentMode() === 'fpga-jtag' && lastAdapter ? ` (${lastAdapter.label})` : ''}`;
    // Generated by hand: the user's configuration, not the extension's, until one is picked.
    const manual = platformMode() === 'manual';
    configItem.text = `$(settings) ${manual ? 'manual' : path.basename(configPath()).replace(/\.(py|hjson)$/, '')}`;
    configItem.backgroundColor = manual ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    configItem.tooltip = manual ? `${soc.name} platform generated by hand (mcu-gen outside the extension): Build and Run use it as it is and never `
        + `regenerate it. Pick a configuration to have the extension generate it. The Memory Map shows the platform as generated, the editor ${path.basename(configPath())}.`
        : `${soc.name} platform configuration`;
}
function setupIntelliSense() {
    const rel = path.relative(folder.uri.fsPath, root).split(path.sep).join('/');
    const xheepDir = `\${workspaceFolder}${rel ? '/' + rel : ''}`;
    const defaults = [
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
const isXheep = (dir) => (0, soc_1.socOf)(dir)?.id === 'x-heep';
/**
 * Where the platform is in a workspace folder: the folder itself, a software project's x-heep/ or x-alp/, a hardware
 * project's hw/vendor/x-heep.
 */
const platformIn = (dir) => [dir, ...Object.keys(soc_1.SOCS).map(d => path.join(dir, d)), path.join(dir, 'hw', 'vendor', 'x-heep')].find(d => (0, soc_1.socOf)(d));
function activate(context) {
    extensionDir = context.extensionPath;
    extensionId = context.extension.id;
    // Both also in the X-HEEP tab of the panel (console.ts).
    output = (0, console_1.mirroredChannel)('X-HEEP', 'log');
    uart = (0, console_1.mirroredChannel)('X-HEEP UART', 'uart');
    buildProblems = vscode.languages.createDiagnosticCollection('xheep');
    hdlProblemsCollection = vscode.languages.createDiagnosticCollection('xheep-rtl');
    context.subscriptions.push(output, uart, buildProblems, hdlProblemsCollection, (0, console_1.registerConsole)(), vscode.commands.registerCommand('xheep.newProject', () => newProject(soc_1.SOCS['x-heep'])), vscode.commands.registerCommand('xheep.newXalpProject', () => newProject(soc_1.SOCS['x-alp'])), vscode.commands.registerCommand('xheep.newHwProject', newHwProject), vscode.commands.registerCommand('xheep.openInContainer', openInContainer));
    // X-HEEP or X-ALP itself is open, a software project with it in x-heep/ or x-alp/, or a hardware project (gr-heep).
    const found = vscode.workspace.workspaceFolders?.find(f => platformIn(f.uri.fsPath));
    if (!found) {
        // Empty view, so its welcome content (package.json viewsWelcome) offers to create a project.
        context.subscriptions.push(vscode.window.registerTreeDataProvider('xheep.apps', { getChildren: () => [], getTreeItem: (x) => new vscode.TreeItem(x) }));
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
    root = platformIn(dir);
    soc = (0, soc_1.socOf)(root);
    hwRoot = root.endsWith(path.join('hw', 'vendor', 'x-heep')) ? dir : root;
    swRoot = path.join(dir, 'sw');
    vscode.commands.executeCommand('setContext', 'xheep.active', true);
    // FPGA and flash are X-HEEP's only, for now.
    vscode.commands.executeCommand('setContext', 'xheep.isXheep', soc.id === 'x-heep');
    state = context.workspaceState;
    globalState = context.globalState;
    // 0.5.0 recorded its mcu-gen as "<config>@<sha1>": that platform is the extension's, not one generated by hand.
    const stamp = state.get('platformStamp');
    if (stamp && !state.get('platformLast')) {
        state.update('platformLast', { config: stamp.slice(0, stamp.lastIndexOf('@')), at: mtime(generatedFile()) });
    }
    // A build cut short by closing the window would otherwise spin forever.
    state.update('buildStatus', Object.fromEntries(Object.entries(state.get('buildStatus', {})).filter(([, v]) => v !== 'running')));
    apps = new AppsProvider();
    memoryMap = new MemoryMapProvider();
    appTests = vscode.tests.createTestController('xheep.apps', 'X-HEEP Apps');
    appTests.refreshHandler = () => loadAppTests();
    appTests.createRunProfile('Simulation', vscode.TestRunProfileKind.Run, runAppTests, true);
    loadAppTests();
    appItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    appItem.command = 'xheep.selectApp';
    appItem.tooltip = 'X-HEEP application';
    modeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9);
    modeItem.command = 'xheep.selectMode';
    modeItem.tooltip = 'X-HEEP run mode';
    configItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 7);
    configItem.command = 'xheep.selectConfig';
    configItem.tooltip = 'X-HEEP platform configuration';
    runItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 8);
    runItem.command = 'xheep.run';
    [appItem, modeItem, runItem, configItem].forEach(i => i.show());
    // The next Run rebuilds the model after an RTL change; a save during a build may be missed by it (modelBuilt).
    const onSave = (doc) => {
        const sim = cfg().get('simulator', 'verilator');
        if (isRtl(doc.uri.fsPath) && modelBuilds.has(sim)) {
            savedDuringBuild.add(sim);
        }
        if (appOf(doc.uri.fsPath) || isRtl(doc.uri.fsPath)) {
            refreshUi(); // newer than the app's build, or the model's
        }
    };
    // The open app is the one Run builds and runs.
    const onEditor = (e) => {
        const app = e && appOf(e.document.uri.fsPath);
        if (app && app !== currentApp()) {
            state.update('app', app).then(refreshUi);
        }
    };
    // A make app run by hand: the run button follows it.
    const builds = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.join(root, 'sw'), 'build/{main.elf,CMakeCache.txt}'));
    [builds.onDidCreate, builds.onDidChange, builds.onDidDelete].forEach(on => on(() => refreshUi()));
    // And a model built by hand (make <sim>-build), or its failure in buildsim.log.
    const models = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(hwRoot, '{buildsim.log,build/*/sim-verilator/Vtestharness}'));
    [models.onDidCreate, models.onDidChange, models.onDidDelete].forEach(on => on(() => refreshUi()));
    const onOpen = (doc) => isRtl(doc.uri.fsPath) && setupVerible(true);
    const watchers = [...new Set([examplesDir(), userAppsDir()])].map(d => vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(d, '*')));
    watchers.forEach(w => { w.onDidCreate(() => apps.refresh()); w.onDidDelete(() => apps.refresh()); });
    // mcu-gen run in a terminal: the configuration in the status bar turns to "manual".
    const generated = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, soc.generated));
    [generated.onDidCreate, generated.onDidChange, generated.onDidDelete].forEach(on => on(() => { refreshUi(); memoryMap.refresh(); }));
    context.subscriptions.push(appItem, modeItem, runItem, configItem, ...watchers, generated, builds, models, appTests, vscode.window.onDidChangeActiveTextEditor(onEditor), 
    // A configuration set by hand in the settings is picked too.
    vscode.workspace.onDidChangeConfiguration(async (e) => { if (e.affectsConfiguration('xheep.mcuConfig')) {
        await configPicked();
        refreshUi();
        (0, platformEditor_1.refreshPlatformEditor)();
        memoryMap.refresh();
    } }), vscode.workspace.onDidSaveTextDocument(onSave), vscode.workspace.onWillSaveTextDocument(formatOnSave), vscode.workspace.onDidOpenTextDocument(onOpen), vscode.extensions.onDidChange(() => setupVerible(false)), vscode.window.registerTreeDataProvider('xheep.apps', apps), vscode.window.registerTreeDataProvider('xheep.memoryMap', memoryMap), vscode.debug.registerDebugAdapterTrackerFactory('cppdbg', { createDebugAdapterTracker: exitTracker }), vscode.commands.registerCommand('xheep.selectApp', selectApp), vscode.commands.registerCommand('xheep.selectMode', selectMode), vscode.commands.registerCommand('xheep.newApp', newApp), vscode.commands.registerCommand('xheep.newFile', newFile), vscode.commands.registerCommand('xheep.updateXheep', updateXheep), vscode.commands.registerCommand('xheep.openDocs', () => vscode.env.openExternal(vscode.Uri.parse('https://x-heep.readthedocs.io/en/latest/'))), vscode.commands.registerCommand('xheep.build', build), vscode.commands.registerCommand('xheep.run', run), vscode.commands.registerCommand('xheep.debug', debug), vscode.commands.registerCommand('xheep.openSerial', openSerial), vscode.commands.registerCommand('xheep.mcuGen', mcuGen), vscode.commands.registerCommand('xheep.selectConfig', selectConfig), vscode.commands.registerCommand('xheep.newConfig', newConfig), vscode.commands.registerCommand('xheep.editPlatform', () => openEditor()), vscode.commands.registerCommand('xheep.buildSimModel', buildSimModel), vscode.commands.registerCommand('xheep.programFpga', programFpga), vscode.commands.registerCommand('xheep.buildBitstream', buildBitstream), vscode.commands.registerCommand('xheep.checkEnv', () => checkEnv()), vscode.commands.registerCommand('xheep.fixTools', fixTools), vscode.commands.registerCommand('xheep.refreshApps', () => apps.refresh()), vscode.commands.registerCommand('xheep.openWaves', openWaves), vscode.commands.registerCommand('xheep.refreshMemoryMap', () => memoryMap.refresh()), vscode.commands.registerCommand('xheep.copyAddress', (node) => vscode.env.clipboard.writeText(node.define ?? (0, platform_1.hexAddress)(node.address))));
    refreshUi();
    jtagAdapter(false).then(refreshUi); // for the status bar
    setupIntelliSense();
    setupVerible(vscode.workspace.textDocuments.some(d => isRtl(d.uri.fsPath)));
    checkEnv(true);
}
function deactivate() {
    stopSerial();
}
//# sourceMappingURL=extension.js.map