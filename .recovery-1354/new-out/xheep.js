"use strict";
// Helpers that turn the user's choices into X-HEEP commands and files.
// Kept free of the vscode API so the unit tests and the end-to-end test (src/test/e2e.ts) share them.
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
exports.fileSha1 = exports.BOARDS = exports.FLASH_COMMAND = exports.exitBreakpoint = exports.DEBUG_BUILD_ROOT = exports.SIM_MODEL = exports.isCoreBuildDir = exports.printable = exports.veribleVersion = exports.verilatorVersion = exports.PYTHON_MODULES = exports.SETUP_GUIDE = exports.linkerScript = exports.EPFL_PROGRAMMER_USB = exports.JTAG_ADAPTERS = exports.MODES = exports.unbuildablePathChars = exports.isHwProjectName = exports.isGenerated = exports.isCommit = exports.XHEEP_COMMIT_URL = exports.GRHEEP_GIT = exports.XHEEP_GIT = void 0;
exports.cloneCommand = cloneCommand;
exports.changedFiles = changedFiles;
exports.updateCommand = updateCommand;
exports.hwProjectCloneCommand = hwProjectCloneCommand;
exports.renameGrHeep = renameGrHeep;
exports.renameHwProject = renameHwProject;
exports.platformState = platformState;
exports.writeMain = writeMain;
exports.projectSource = projectSource;
exports.configTemplate = configTemplate;
exports.boardAdapters = boardAdapters;
exports.pickAdapter = pickAdapter;
exports.appTarget = appTarget;
exports.builtStatus = builtStatus;
exports.appVars = appVars;
exports.missingModulesCommand = missingModulesCommand;
exports.platformScriptCommand = platformScriptCommand;
exports.condaEnvName = condaEnvName;
exports.requiredVersions = requiredVersions;
exports.usbDevices = usbDevices;
exports.udevRule = udevRule;
exports.memoryRegions = memoryRegions;
exports.stackSize = stackSize;
exports.explainBuild = explainBuild;
exports.stackProblems = stackProblems;
exports.largestFrame = largestFrame;
exports.uartException = uartException;
exports.exceptionCause = exceptionCause;
exports.buildCommand = buildCommand;
exports.simModelBuildCommand = simModelBuildCommand;
exports.incrementalBuildCommand = incrementalBuildCommand;
exports.verilatorRunCommand = verilatorRunCommand;
exports.debugModelBuildCommand = debugModelBuildCommand;
exports.debugSimCommand = debugSimCommand;
exports.openocdCommand = openocdCommand;
exports.gdbRunCommand = gdbRunCommand;
exports.regValue = regValue;
exports.exitCode = exitCode;
exports.pickSerialPort = pickSerialPort;
exports.serialReadCommand = serialReadCommand;
exports.simCommand = simCommand;
exports.mcuGenCommand = mcuGenCommand;
exports.builtBitstream = builtBitstream;
exports.bitstreamBuildCommand = bitstreamBuildCommand;
exports.vivadoTcl = vivadoTcl;
exports.vivadoCommand = vivadoCommand;
exports.openocdFpgaCommand = openocdFpgaCommand;
exports.hdlProblems = hdlProblems;
exports.veribleFileList = veribleFileList;
exports.formattedDirs = formattedDirs;
exports.appTestConfig = appTestConfig;
exports.simSummary = simSummary;
exports.explicitImports = explicitImports;
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const soc_1 = require("./soc");
exports.XHEEP_GIT = 'https://github.com/x-heep/x-heep.git';
/** Template of a hardware project extending X-HEEP, which it vendors in hw/vendor/x-heep. */
exports.GRHEEP_GIT = 'https://github.com/x-heep/gr-heep.git';
/**
 * The last X-HEEP commit the extension is known to work with. The X-HEEP canary workflow updates this file
 * in the extension's repo, so new projects get it without waiting for an extension release.
 */
exports.XHEEP_COMMIT_URL = 'https://raw.githubusercontent.com/LuigiGiuffrida98/x-heep-ide/main/XHEEP_COMMIT';
const isCommit = (s) => /^[0-9a-f]{40}$/.test(s);
exports.isCommit = isCommit;
/**
 * Adds the platform (X-HEEP by default) as a shallow submodule in `dir`, at `commit` if given;
 * on failure drops the half clone so a retry starts clean.
 */
function cloneCommand(url = exports.XHEEP_GIT, commit, dir = 'x-heep') {
    const pin = commit ? ` && git -C ${dir} fetch -q --depth 1 origin ${commit} && git -C ${dir} checkout -q ${commit} && git add ${dir}` : '';
    return `{ [ -d .git ] || git init; } && `
        + `{ git submodule add --progress --depth 1 ${url} ${dir} && git config -f .gitmodules submodule.${dir}.shallow true${pin}; } `
        + `|| { git rm -q --cached ${dir} 2>/dev/null; rm -rf ${dir} .git/modules/${dir}; exit 1; }`;
}
/** Paths changed in a work tree, from `git status --porcelain --untracked-files=no` (a rename gives its new path). */
function changedFiles(porcelain) {
    return porcelain.split('\n').filter(l => l.length > 3).map(l => l.slice(3).split(' -> ').pop());
}
/** Files mcu-gen writes from a template next to them (`<file>.tpl`): regenerated anyway, so safe to discard. */
const isGenerated = (xheep, file) => fs.existsSync(path.join(xheep, `${file}.tpl`));
exports.isGenerated = isGenerated;
/**
 * Moves an X-HEEP checkout (run inside it) to `ref`, a commit or a branch of origin, fetched shallow like the
 * submodule; `discard` are generated files to restore first, so the checkout does not refuse them.
 */
function updateCommand(ref, discard = []) {
    const restore = discard.length ? `git checkout -q -- ${discard.map(f => `'${f}'`).join(' ')} && ` : '';
    return `${restore}git fetch -q --depth 1 origin ${ref} && git checkout -q FETCH_HEAD`;
}
/** Copies the hardware project template into `name` (in the cwd) as a new repo, without its history; files staged. */
function hwProjectCloneCommand(name, url = exports.GRHEEP_GIT) {
    return `{ git clone --progress --depth 1 '${url}' '${name}' && rm -rf '${name}/.git' && git -C '${name}' init -q && git -C '${name}' add -A; } `
        + `|| { rm -rf '${name}'; exit 1; }`;
}
/** A hardware project name: a lowercase SystemVerilog identifier once - becomes _, and a folder and fusesoc core name. */
const isHwProjectName = (name) => /^[a-z][a-z0-9]*([-_][a-z0-9]+)*$/.test(name) && name !== 'x-heep';
exports.isHwProjectName = isHwProjectName;
/** `name` in place of gr-heep in `text`, in each spelling: gr_heep, gr-heep, GR_HEEP, GR-HEEP. */
function renameGrHeep(text, name) {
    const words = name.split(/[-_]/);
    return text.replace(/(g)r([-_])heep/gi, (_, g, sep) => g === 'G' ? words.join(sep).toUpperCase() : words.join(sep));
}
/**
 * Renames gr-heep to `name` in a fresh copy at `dir`: the tracked files' contents and paths. The vendored X-HEEP too:
 * its FPGA constraints (and the patch adding them) name the top instance gr_heep_i.
 */
function renameHwProject(dir, name) {
    const files = (0, child_process_1.execFileSync)('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8' }).split('\0').filter(Boolean);
    const oldDirs = new Set();
    for (const f of files) {
        const file = path.join(dir, f);
        const bytes = fs.lstatSync(file).isFile() ? fs.readFileSync(file) : undefined; // a symlink keeps its target
        if (bytes && !bytes.includes(0)) {
            // latin1: byte for byte, so files that are not UTF-8 come back unchanged around the (ASCII) name.
            const text = bytes.toString('latin1');
            const renamed = renameGrHeep(text, name);
            if (renamed !== text) {
                fs.writeFileSync(file, renamed, 'latin1');
            }
        }
        const to = path.join(dir, renameGrHeep(f, name));
        if (to !== file) {
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.renameSync(file, to);
            oldDirs.add(path.dirname(file));
        }
    }
    // The emptied folders (e.g. hw/gr-heep), deepest first.
    for (const d of [...oldDirs].sort((a, b) => b.length - a.length)) {
        if (d !== dir && fs.readdirSync(d).length === 0) {
            fs.rmdirSync(d);
        }
    }
}
/**
 * Characters in `dir` that break `make app`: make splits on whitespace, and X-HEEP's and X-ALP's sw/CMakeLists.txt
 * match paths as regular expressions (`MATCHES "${SOURCE_PATH}device/"`), so `prova?2` finds no sources.
 */
const unbuildablePathChars = (dir) => [...new Set(dir.match(/[\s?*+[\]()|^$\\]/g) ?? [])];
exports.unbuildablePathChars = unbuildablePathChars;
/**
 * The generated platform, against `last`. 'manual': generated by hand (mcu-gen outside the extension) with a
 * configuration the extension cannot know, so used as is and never regenerated on its own. 'fresh': generated here for
 * `config` and newer than its files. 'stale': to generate (missing, configuration edited or picked). Times in ms, 0 for
 * a missing file.
 */
function platformState(generatedMs, configMs, config, last) {
    if (!generatedMs) {
        return 'stale';
    }
    if (generatedMs !== last?.at) {
        return 'manual';
    }
    return last.config === config && configMs.every(t => generatedMs >= t) ? 'fresh' : 'stale';
}
/** Creates <dir>/main.c with a hello world for a new app. X-ALP's printf is its own (printf.h), not newlib's. */
function writeMain(dir, name, soc = 'x-heep') {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'main.c'), `${soc === 'x-alp' ? '#include "printf.h"\n' : ''}`
        + `#include <stdio.h>\n#include <stdlib.h>\n\nint main(void)\n{\n    printf("Hello from ${name}!\\n");\n    return EXIT_SUCCESS;\n}\n`);
}
/**
 * make SOURCE for apps in a software project's sw/ (relative to X-HEEP's sw/).
 * CMake only takes drivers from <SOURCE>/device, so it also links the project's sw/device to X-HEEP's.
 */
function projectSource(xheep, swRoot) {
    const device = path.join(swRoot, 'device');
    if (!fs.existsSync(device)) {
        fs.symlinkSync(path.relative(swRoot, path.join(xheep, 'sw', 'device')), device);
    }
    // realpath: the Makefile resolves its own location, so x-heep/ may be a symlink.
    return path.relative(fs.realpathSync(path.join(xheep, 'sw')), fs.realpathSync(swRoot));
}
/** A new platform configuration: the platform's `base` (X-HEEP's configs/general.py) with Pylance-friendly imports. */
function configTemplate(xheep, name, base = 'configs/general.py') {
    const findModule = (pkg, cls) => {
        const dir = path.join(xheep, 'util', 'xheep_gen', ...pkg.split('.'));
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.py') && f !== '__init__.py') : [];
        return files.find(f => new RegExp(`^class ${cls}\\b`, 'm').test(fs.readFileSync(path.join(dir, f), 'utf8')))?.replace(/\.py$/, '');
    };
    return `# Platform configuration "${name}", started from ${base}.\n`
        + '# Edit and save: the extension regenerates the platform before the next build.\n'
        + explicitImports(fs.readFileSync(path.join(xheep, base), 'utf8'), findModule);
}
exports.MODES = {
    'sim': { label: 'Simulation', detail: 'Run the app on the RTL model (Verilator or Questasim)' },
    'fpga-jtag': { label: 'FPGA · JTAG', detail: 'Load the app into X-HEEP\'s RAM over JTAG: Run runs it, Debug debugs it with GDB' },
    'fpga-flash': { label: 'FPGA · Flash', detail: 'Program the app into the SPI flash: X-HEEP boots it by itself, as the chip would (no debugger)' },
};
/**
 * JTAG adapters for FPGA debugging: OpenOCD config in X-HEEP's tb/, USB vendor:product id, and the boards they
 * fit (all if unset). The on-board one needs a bitstream with the Xilinx BSCAN JTAG.
 */
exports.JTAG_ADAPTERS = [
    { label: 'EPFL Programmer', detail: 'EPFL programmer (FT4232) on the PMOD JTAG pins', config: 'tb/core-v-mini-mcu-esl-programmer.cfg', usb: '0403:6011' },
    { label: 'On-board USB (BSCAN)', detail: 'PYNQ-Z2 USB port; needs a bitstream built with FUSESOC_FLAGS=--flag=use_bscane_xilinx', config: 'tb/core-v-mini-mcu-pynq-z2-bscan.cfg', usb: '0403:6010', boards: ['pynq-z2'], bscan: true },
    { label: 'Digilent JTAG-HS2', detail: 'Digilent JTAG-HS2 cable on the PMOD JTAG pins', config: 'tb/core-v-mini-mcu-nexsys-hs2.cfg', usb: '0403:6014' },
];
/** Adapters that fit the board; with a known bitstream, only the on-board one for a BSCAN bitstream, only the others otherwise. */
function boardAdapters(board, bscanBitstream) {
    return exports.JTAG_ADAPTERS.filter(a => (!a.boards || a.boards.includes(board)) && (bscanBitstream === undefined || !!a.bscan === bscanBitstream));
}
/**
 * The adapter to use among `candidates`, from what is plugged in; else the ones to ask among. The on-board
 * adapter is the board's own USB, always there with the board, so it only counts when no external one is.
 */
function pickAdapter(candidates, connected) {
    const external = candidates.filter(a => !a.bscan && connected(a.usb));
    const onBoard = candidates.filter(a => a.bscan && connected(a.usb));
    const plugged = external.length ? external : onBoard;
    if (plugged.length === 1) {
        return { adapter: plugged[0], choices: [] };
    }
    if (!plugged.length && candidates.length === 1) {
        return { adapter: candidates[0], choices: [] }; // OpenOCD then says it is not there
    }
    return { choices: plugged.length ? plugged : candidates };
}
/** The EPFL programmer (FT4232): JTAG, the SPI flash through iceprog, and the UART. */
exports.EPFL_PROGRAMMER_USB = '0403:6011';
/** make TARGET and LINKER for the mode (X-ALP: the memory chosen). */
function appTarget(o) {
    return { target: o.mode === 'sim' ? 'sim' : o.board, linker: o.linker ?? (o.mode === 'fpga-flash' ? 'flash_load' : 'on_chip') };
}
/**
 * An app's build as sw/build has it, by the extension or by hand (make app): 'ok' when CMake was configured as `want`
 * says (PROJECT, TARGET, LINKER, COMPILER, SOURCE_PATH) and the ELF is newer than the app's sources; 'fail' when
 * configured so but with no ELF (the build failed); undefined otherwise (not built, or for another app or mode).
 * Times in ms, 0 for a missing file.
 */
function builtStatus(cmakeCache, want, elfMs, sourcesMs) {
    const vars = Object.fromEntries([...cmakeCache.matchAll(/^(\w+):\w+=(.*)$/gm)].map(m => [m[1], m[2]]));
    if (!Object.entries(want).every(([k, v]) => vars[k] === v)) {
        return undefined;
    }
    return !elfMs ? 'fail' : elfMs >= sourcesMs ? 'ok' : undefined;
}
function appVars(o) {
    const { target, linker } = appTarget(o);
    const source = o.source ? ` SOURCE=${o.source}` : '';
    // -fstack-usage: a .su file per object, read by stackProblems (X-HEEP builds with -w, so no -Wstack-usage).
    // shortcut: none for X-ALP, whose COMPILER_FLAGS must stay -mabi=lp64d and whose Makefile splits a second flag off;
    // its stack checks wait for a way to pass one.
    const flags = o.linker ? '' : ' COMPILER_FLAGS=-fstack-usage';
    return `PROJECT=${o.project} TARGET=${target} LINKER=${linker} COMPILER=${o.compiler}${source}${o.arch ? ` ARCH=${o.arch}` : ''}${flags}`;
}
/** The linker script `make app` uses, in the platform's sw/linker/. */
const linkerScript = (o) => o.linker ? `${o.linker}.ld` : o.mode === 'fpga-flash' ? 'link_flash_load.ld' : 'link.ld';
exports.linkerScript = linkerScript;
// --- Environment check ----------------------------------------------------------
exports.SETUP_GUIDE = 'https://x-heep.readthedocs.io/en/latest/GettingStarted/Setup.html';
/** Python modules `make mcu-gen` and fusesoc need from X-HEEP's environment (util/python-requirements.txt). */
exports.PYTHON_MODULES = ['hjson', 'mako', 'fusesoc', 'edalize', 'pkg_resources'];
/** Picks the environment's Python into $py as X-HEEP's Makefile does: conda's `python`, else the repo's .venv. */
const PICK_PYTHON = 'if [ -n "$CONDA_DEFAULT_ENV" ]; then py=python; else py=.venv/bin/python; fi; ';
/** Prints the modules of PYTHON_MODULES (and `extra`) the environment's Python cannot import. */
function missingModulesCommand(extra = []) {
    return PICK_PYTHON + `"$py" -W ignore -c 'import importlib.util as u, sys; print(" ".join(m for m in sys.argv[1:] if u.find_spec(m) is None))' ${[...exports.PYTHON_MODULES, ...extra].join(' ')}`;
}
/** Runs the extension's media/platform.py (`read` or `check`) on a configuration, in X-HEEP's root. */
function platformScriptCommand(script, cmd, config) {
    return PICK_PYTHON + `"$py" '${script}' ${cmd} . '${config}'`;
}
/** The conda environment an `xheep.envSetup` snippet activates, if it does. */
function condaEnvName(envSetup) {
    return /conda activate\s+([^\s;&|]+)/.exec(envSetup)?.[1];
}
/** Tool versions X-HEEP is tested with, from its setup guide (docs/source/GettingStarted/Setup.md). */
function requiredVersions(setupGuide) {
    return {
        verilator: /VERILATOR_VERSION=(\S+)/.exec(setupGuide)?.[1],
        verible: /VERIBLE_VERSION=(\S+)/.exec(setupGuide)?.[1],
    };
}
/** `verilator --version`: "Verilator 5.040 2025-08-30 rev v5.040" -> 5.040. */
const verilatorVersion = (out) => /Verilator (\d+\.\d+)/.exec(out)?.[1];
exports.verilatorVersion = verilatorVersion;
/** `verible-verilog-format --version`: "Version v0.0-4023-gc1271a00 ..." -> v0.0-4023-gc1271a00. */
const veribleVersion = (out) => /v\d+\.\d+-\d+-g[0-9a-f]+/.exec(out)?.[0];
exports.veribleVersion = veribleVersion;
/** USB devices from sysfs (no lsusb needed), with their /dev/bus/usb node, whose permissions OpenOCD and iceprog need. */
function usbDevices(sysfs = '/sys/bus/usb/devices') {
    const read = (dir, f) => { try {
        return fs.readFileSync(path.join(dir, f), 'utf8').trim();
    }
    catch {
        return undefined;
    } };
    return (fs.existsSync(sysfs) ? fs.readdirSync(sysfs) : []).flatMap(d => {
        const dir = path.join(sysfs, d);
        const [vid, pid, bus, dev] = ['idVendor', 'idProduct', 'busnum', 'devnum'].map(f => read(dir, f));
        return vid && pid && bus && dev ? [{ vid, pid, product: read(dir, 'product'), node: `/dev/bus/usb/${bus.padStart(3, '0')}/${dev.padStart(3, '0')}` }] : [];
    });
}
/** The udev rule giving users access to a USB device, as in X-HEEP's ProgramFlash and Debug guides. */
function udevRule(vid, pid) {
    return `ATTRS{idVendor}=="${vid}", ATTRS{idProduct}=="${pid}", MODE="666", GROUP="plugdev"`;
}
/** Sizes of the RAM regions in a linker script's MEMORY block, by name (ram0, ram1, ...). */
function memoryRegions(linkerScript) {
    return Object.fromEntries([...linkerScript.matchAll(/^\s*(\w+)\s*\([^)]*\)\s*:\s*ORIGIN\s*=\s*\w+\s*,\s*LENGTH\s*=\s*(0x[0-9a-fA-F]+|\d+)/gm)]
        .map(m => [m[1], Number(m[2])]));
}
/** The default stack size in a linker script (`__stack_size = DEFINED(__stack_size) ? __stack_size : 0x800;`). */
function stackSize(linkerScript) {
    const size = /__stack_size\s*=\s*DEFINED\(__stack_size\)\s*\?\s*__stack_size\s*:\s*(0x[0-9a-fA-F]+|\d+)/.exec(linkerScript)?.[1];
    return size === undefined ? undefined : Number(size);
}
const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
/** Why a function from a PC's C library is missing, and what to use instead. */
function missingFunctionHint(name) {
    if (/^(u|nano)?sleep$/.test(name)) {
        return 'X-HEEP has no operating system to sleep: wait with a timer (see example_timer_sdk) or a busy loop.';
    }
    if (/^pthread_/.test(name)) {
        return 'X-HEEP has no threads without an operating system: use FreeRTOS tasks (see example_freertos_blinky).';
    }
    if (/^(fork|vfork|execv?p?e?|wait|waitpid|system|popen|kill|signal)$/.test(name)) {
        return 'X-HEEP has no operating system to run processes or signals.';
    }
    return undefined;
}
/**
 * Explains the linker failures (and calls to OS functions) in a `make app` log: the compiler errors themselves
 * already reach the Problems panel through the problem matcher, the linker's have no line:column. Only problems
 * in the app's own files are kept: undefined references inside the C++ library follow from the memory overflow.
 */
function explainBuild(log, regions, isAppFile) {
    const problems = [];
    for (const m of new Map([...log.matchAll(/region [`'](\w+)' overflowed by (\d+) bytes/g)].map(m => [m[1], m])).values()) {
        const size = regions[m[1]];
        problems.push({
            severity: 'error',
            message: `The app does not fit in memory: it needs ${m[2]} bytes more than ${m[1]}${size ? `, which holds ${kb(size)}` : ''}. `
                + 'Shrink large arrays and buffers, avoid heavy libraries (C++ iostream alone takes about 300 KB), '
                + 'or switch to a platform configuration with more memory (X-HEEP: Select Platform Configuration).',
        });
    }
    const seen = new Set();
    for (const m of log.matchAll(/^(.+?):(\d+):\(.*?\): undefined reference to [`'](\w+)'/gm)) {
        const [, file, line, name] = m;
        if (!isAppFile(file) || seen.has(`${file}:${line}:${name}`)) {
            continue;
        }
        seen.add(`${file}:${line}:${name}`);
        problems.push({
            file, line: Number(line), severity: 'error',
            message: `${name}() is not available on X-HEEP. ${missingFunctionHint(name)
                ?? 'No library or source file of the app defines it: check the name, or add the file that defines it to the app folder.'}`,
        });
    }
    // GCC already reports these, but as an implicit declaration: say why the function is missing.
    for (const m of log.matchAll(/^(.+?):(\d+):(\d+): error: implicit declaration of function '(\w+)'/gm)) {
        const hint = missingFunctionHint(m[4]);
        if (hint && isAppFile(m[1])) {
            problems.push({ file: m[1], line: Number(m[2]), column: Number(m[3]), severity: 'info', message: `${m[4]}(): ${hint}` });
        }
    }
    return problems;
}
/**
 * Functions of the app whose own stack frame does not fit in X-HEEP's small stack, from GCC's .su files
 * (`/abs/main.c:4:5:process<TAB>16400<TAB>static`): past the stack, a program overwrites its data and hangs.
 */
function stackProblems(su, stack, isAppFile) {
    return [...su.matchAll(/^(.+?):(\d+):(\d+):([^\t]+)\t(\d+)\t(\S+)/gm)].flatMap(([, file, line, column, fn, bytes, kind]) => {
        const unbounded = kind.includes('dynamic') && !kind.includes('bounded');
        if (!isAppFile(file) || (Number(bytes) <= stack && !unbounded)) {
            return [];
        }
        return [{
                file, line: Number(line), column: Number(column), severity: 'warning',
                message: `${fn}() ${unbounded ? 'allocates stack at run time (variable-length array or alloca)' : `needs ${bytes} bytes of stack`}, `
                    + `but X-HEEP's stack is ${stack} bytes: the program would overwrite its own data. Make large arrays static or global, `
                    + 'or raise the stack size (linker_script stack_size in the platform configuration).',
            }];
    });
}
/** The app's largest stack frame, from GCC's .su files (see stackProblems). */
function largestFrame(su, isAppFile) {
    let best;
    for (const [, file, fn, bytes] of su.matchAll(/^(.+?):\d+:\d+:([^\t]+)\t(\d+)\t/gm)) {
        if (isAppFile(file) && (!best || Number(bytes) > best.bytes)) {
            best = { fn, bytes: Number(bytes) };
        }
    }
    return best;
}
// --- Explaining run failures ---------------------------------------------------
/** X-HEEP's exception handler messages (sw/device/lib/runtime/handler.c), as a reader would name them. */
const EXCEPTIONS = [
    [/Illegal Instruction fault/, 'illegal instruction'],
    [/Instruction access fault/, 'instruction access fault'],
    [/Load\/Store fault/, 'load/store access fault'],
    [/Breakpoint triggerd/, 'breakpoint (ebreak)'],
    [/ecall exception handler entered/, 'ecall'],
];
/**
 * The exception X-HEEP reported on its UART, once its message line is complete, if any: after it, the program
 * spins in the handler forever.
 */
function uartException(uart) {
    return EXCEPTIONS.find(([re]) => new RegExp(`${re.source}[^\n]*\n`).test(uart))?.[1];
}
/** RISC-V mcause of a synchronous exception, as a reader would name it. */
function exceptionCause(mcause) {
    return ['misaligned instruction', 'instruction access fault', 'illegal instruction', 'breakpoint (ebreak)',
        'misaligned load', 'load access fault', 'misaligned store', 'store access fault', 'ecall from U-mode',
        'ecall from S-mode', 'reserved exception', 'ecall'][mcause] ?? `exception ${mcause}`;
}
/** Bytes a terminal would not show: X-HEEP's exception handler prints mtval as raw bytes. */
const printable = (text) => text.replace(/[\x00-\x08\x0b-\x1f\x7f�]/g, '');
exports.printable = printable;
function buildCommand(o) {
    // X-ALP (`linker`): ARCH and COMPILER_PREFIX in the environment are X-HEEP's (its container exports them), and
    // its Makefile takes them over its own RV64 defaults.
    return `${o.linker ? 'env -u ARCH -u COMPILER_PREFIX ' : ''}make app ${appVars(o)}`;
}
/**
 * A fusesoc build dir of the top-level system: X-HEEP's (openhwgroup.org_systems_core-v-mini-mcu_*), a hardware
 * project's (x-heep_systems_gr-heep_*, renamed in its forks) or X-ALP's (x-heep_x-alp_x-alp_*); not build/debug
 * (DEBUG_BUILD_ROOT).
 */
const isCoreBuildDir = (d) => d.includes('_systems_') || d.startsWith('x-heep_x-alp_x-alp_');
exports.isCoreBuildDir = isCoreBuildDir;
/** Compiled model inside build/<fusesoc core dir>/; mcu-gen's `fusesoc --setup` creates the dirs empty. */
exports.SIM_MODEL = {
    verilator: 'sim-verilator/Vtestharness',
    questasim: 'sim-modelsim/work',
};
/**
 * `xalpGenerated`: X-ALP's main generated file, which its verilator-build would regenerate (mcu-gen with its default
 * configuration) when a template is newer: -o keeps it, as the platform is generated beforehand, or by hand. -o format
 * skips formatting the whole repo.
 */
function simModelBuildCommand(sim, xalpGenerated) {
    const make = xalpGenerated ? `make -o format -o ${xalpGenerated} ${sim}-build` : `make ${sim}-build`;
    // `make <sim>-build` pipes fusesoc into tee, so its exit code is always 0: drop the old model and check it came back.
    return `rm -rf build/*/${exports.SIM_MODEL[sim]} && ${make} && `
        + `{ ls build/*/${exports.SIM_MODEL[sim]} >/dev/null 2>&1 || { echo "Simulation model build failed, see buildsim.log"; exit 1; }; }`;
}
/** Recompiles only what changed in the CMake tree `make app` configured (it would wipe it and start over). */
function incrementalBuildCommand(jobs) {
    return `make -s -C sw/build -j${jobs}`;
}
/**
 * Runs the compiled Verilator model directly, the same step `make verilator-run` does after fusesoc,
 * which first spends seconds resolving cores and rerunning generators. X-ALP's (`linker` given) loads the ELF
 * into that memory, named by its suffix, and exits with the app's exit code.
 */
function verilatorRunCommand(simDir, linker) {
    return linker
        ? `cd '${simDir}' && ./Vtestharness +BINARY=../../../sw/build/main.${linker}.elf +BOOTMODE=force --trace=false --no_err=false`
        : `cd '${simDir}' && ./Vtestharness +firmware=../../../sw/build/main.hex`;
}
/** Separate fusesoc build root for the JTAG-enabled model, so the regular one stays untouched. */
exports.DEBUG_BUILD_ROOT = 'build/debug';
/**
 * Builds a Verilator model with the remote bitbang JTAG server (JTAG_DPI=1) for GDB in simulation.
 * Through make, not fusesoc directly: the boot ROM generator needs the toolchain prefix the Makefile exports.
 * Like `verilator-build` the exit code is always 0, hence the check on the model.
 */
function debugModelBuildCommand(soc = 'x-heep') {
    const exe = `${exports.DEBUG_BUILD_ROOT}/sim-verilator/Vtestharness`;
    // X-ALP's Makefile passes its fusesoc arguments after the core, where --build-root is not taken: fusesoc directly,
    // picked as its Makefile does. mcu-gen already made what verilator-build depends on (boot ROM, registers).
    const build = soc === 'x-alp'
        ? `{ if [ -n "$CONDA_DEFAULT_ENV" ]; then f=fusesoc; else f=.venv/bin/fusesoc; fi; "$f" --cores-root . run --no-export --target sim `
            + `--tool verilator --build-root ${exports.DEBUG_BUILD_ROOT} --build x-heep:x-alp:x-alp:0.0.1 --USE_JTAG_DPI 2>&1 | tee buildsim.log; }`
        : `make verilator-build FUSESOC_FLAGS='--build-root ${exports.DEBUG_BUILD_ROOT}' FUSESOC_PARAM='--JTAG_DPI=1'`;
    return `rm -f ${exe} && ${build} && { test -x ${exe} || { echo "Debug model build failed, see buildsim.log"; exit 1; }; }`;
}
/**
 * Starts the debug model waiting for OpenOCD on port 4567; GDB then loads the firmware over JTAG.
 * X-ALP's (`linker` given) takes the ELF, named after the memory it is linked into, and preloads it.
 */
function debugSimCommand(simDir, firmware, linker) {
    return linker
        ? `cd '${simDir}' && ./Vtestharness +openOCD=true +BOOTMODE=jtag +BINARY='${firmware}' --trace=false`
        : `cd '${simDir}' && ./Vtestharness +openOCD=true +firmware='${firmware}'`;
}
function openocdCommand(openocd, config) {
    return `${openocd} -f '${config}'`;
}
/**
 * Where the program ends, with the exit code in a0 (Soc.exitSymbol: X-HEEP's `_exit`). `*sym` is its first
 * instruction, before a0 is reused; a plain `sym` breakpoint may land after the prologue.
 */
const exitBreakpoint = (symbol = '_exit') => `break *${symbol}`;
exports.exitBreakpoint = exitBreakpoint;
/** Loads the ELF over OpenOCD's GDB port, runs it to its exit and prints `XHEEP_EXIT <code>`. */
function gdbRunCommand(gdb, elf, exitSymbol = '_exit') {
    return `'${gdb}' -q -nx -batch '${elf}' -ex 'set remotetimeout 2000' -ex 'target extended-remote :3333' -ex load `
        + `-ex '${(0, exports.exitBreakpoint)(exitSymbol)}' -ex continue -ex 'printf "XHEEP_EXIT %d\\n", $a0'`;
}
/**
 * A register from OpenOCD's reply to `reg <name>` ("pc (/32): 0x00000a92"); undefined when the hart could not be
 * halted, as when it hangs on a bus access nobody answers (the reply is then empty).
 */
function regValue(reply, name = 'pc') {
    const value = new RegExp(`^${name} \\(/32\\): (0x[0-9a-f]+)`, 'm').exec(reply)?.[1];
    return value === undefined ? undefined : Number(value);
}
function exitCode(gdbOutput) {
    const code = /XHEEP_EXIT (-?\d+)/.exec(gdbOutput)?.[1];
    return code === undefined ? undefined : Number(code);
}
/** The EPFL programmer's UART (FT4232 interface 2), also the AUP-ZU3 on-board one. */
const XHEEP_UART = /FTDI_Quad_RS232-HS-if02/;
/** The UART to use among the serial ports: the X-HEEP one if connected, else the only port there is. */
function pickSerialPort(candidates) {
    return candidates.find(p => XHEEP_UART.test(p)) ?? (candidates.length === 1 ? candidates[0] : undefined);
}
/** Streams a serial port to stdout, raw (no echo, no line discipline). */
function serialReadCommand(port, baud) {
    return `stty -F '${port}' ${baud} raw -echo -crtscts cs8 -parenb -cstopb && exec cat '${port}'`;
}
/** Runs the already built firmware (sw/build/main.hex) on the RTL model. */
function simCommand(o) {
    return `make ${o.simulator}-run`;
}
function mcuGenCommand(config, soc = 'x-heep') {
    return `make mcu-gen ${soc_1.SOCS[soc].configVar}='${config}'`;
}
/** Programs the already built firmware into the FPGA board's SPI flash. */
exports.FLASH_COMMAND = 'make flash-prog';
/**
 * OpenOCD setup reaching the PYNQ-Z2's FPGA through its on-board USB JTAG (FT2232 channel A), as in X-HEEP's
 * tb/core-v-mini-mcu-pynq-z2-bscan.cfg; the FPGA's configuration TAP is `fpga.tap`.
 */
const PYNQ_Z2_JTAG = 'adapter driver ftdi; ftdi vid_pid 0x0403 0x6010; ftdi channel 0; ftdi layout_init 0x0088 0x008b; '
    + 'transport select jtag; adapter speed 10000; '
    + 'jtag newtap fpga tap -irlen 6 -expected-id 0x23727093; jtag newtap arm_dap tap -irlen 4 -expected-id 0x4ba00477';
/**
 * FPGA boards X-HEEP has bitstreams for: `official` ones are the boards the extension is tested on. `part` is the
 * Vivado hw device name prefix (e.g. xc7z020_1, xczu3_0); `openocd` reaches the FPGA without Vivado.
 */
// shortcut: the AUP-ZU3 (Zynq UltraScale+) and the unofficial boards load through Vivado only; OpenOCD setups for them are untested.
exports.BOARDS = {
    // ramKb: about what its block RAM holds next to the rest of X-HEEP (an estimate from 140 BRAM36 of 4.5 KB).
    'pynq-z2': { official: true, part: 'xc7z020', openocd: PYNQ_Z2_JTAG, usb: '0403:6010', ramKb: 512 },
    'aup-zu3': { official: true, part: 'xczu3' },
    'nexys-a7-100t': { official: false, part: 'xc7a100t' },
    'genesys2': { official: false, part: 'xc7k325t' },
    'zcu102': { official: false, part: 'xczu9' },
    'zcu104': { official: false, part: 'xczu7' },
    'vpk180': { official: false }, // .pdi images, loaded from its processing system
};
/** Bitstream built for the board inside build/<fusesoc core dir>/<board>-vivado/ (fusesoc's own copy, top level). */
function builtBitstream(hwRoot, board) {
    const build = path.join(hwRoot, 'build');
    for (const core of fs.existsSync(build) ? fs.readdirSync(build).filter(exports.isCoreBuildDir) : []) {
        const dir = path.join(build, core, `${board}-vivado`);
        const bit = fs.existsSync(dir) ? fs.readdirSync(dir).find(f => f.endsWith('.bit')) : undefined;
        if (bit) {
            return path.join(dir, bit);
        }
    }
    return undefined;
}
/** A file's sha1: what identifies a bitstream wherever it is copied. */
const fileSha1 = (file) => (0, crypto_1.createHash)('sha1').update(fs.readFileSync(file)).digest('hex');
exports.fileSha1 = fileSha1;
/**
 * Builds the bitstream with Vivado for the current platform. `make vivado-fpga` pipes fusesoc into tee,
 * so its exit code is always 0: drop the old bitstream and check a new one came out.
 */
function bitstreamBuildCommand(board, bscan) {
    const bit = `build/*/${board}-vivado/*.bit`;
    return `rm -f ${bit} && make vivado-fpga FPGA_BOARD=${board}${bscan ? ' FUSESOC_FLAGS=--flag=use_bscane_xilinx' : ''} && `
        + `{ ls ${bit} >/dev/null 2>&1 || { echo "Bitstream build failed, see buildvivado.log"; exit 1; }; }`;
}
/** Vivado batch script that configures the board's FPGA with `bitstream`, or clears its configuration if undefined. */
function vivadoTcl(part, bitstream) {
    return [
        'open_hw_manager',
        'connect_hw_server',
        'open_hw_target',
        `set dev [lindex [get_hw_devices ${part}*] 0]`,
        'if {$dev eq ""} { puts "ERROR: no ' + part + ' device on the JTAG chain"; exit 1 }',
        'current_hw_device $dev',
        ...(bitstream
            ? [`set_property PROGRAM.FILE {${bitstream}} $dev`, 'program_hw_devices $dev']
            // JPROGRAM: the FPGA drops its configuration, so its pins (e.g. the SPI flash ones) float.
            : ['boot_hw_device $dev']),
        'close_hw_target',
        'disconnect_hw_server',
    ].join('\n') + '\n';
}
/** Runs a Vivado batch script from its own folder, where Vivado leaves its .Xil scratch dir. */
function vivadoCommand(tclFile) {
    return `cd '${path.dirname(tclFile)}' && vivado -mode batch -nolog -nojournal -notrace -source '${tclFile}'`;
}
/**
 * OpenOCD configuring the FPGA with `bitstream` (virtex2 PLD driver, 7-series), or clearing its configuration if
 * undefined: JPROGRAM (IR 0x0b), as Vivado's boot_hw_device. Exits non-zero on failure.
 */
function openocdFpgaCommand(openocd, setup, bitstream) {
    const action = bitstream ? `pld load 0 {${bitstream}}` : 'irscan fpga.tap 0x0b; runtest 1000';
    return `${openocd} -c '${setup}; pld device virtex2 fpga.tap; init; ${action}; shutdown'`;
}
// --- Hardware development -------------------------------------------------------
/**
 * Errors and warnings of an RTL model build (buildsim.log) with a source location: Verilator's
 * `%Warning-WIDTH: file.sv:12:5: msg` and Questasim's `** Error: file.sv(12): msg`. Paths are relative to the
 * simulator's work dir `cwd`. Warnings are only kept where `ownFile` holds: vendored IPs have plenty.
 */
function hdlProblems(log, cwd, ownFile) {
    const problems = new Map();
    const add = (sev, file, line, column, message) => {
        const severity = /error/i.test(sev) ? 'error' : 'warning';
        const abs = path.resolve(cwd, file);
        if (severity === 'warning' && !ownFile(abs)) {
            return;
        }
        const p = { file: abs, line: Number(line), column: column ? Number(column) : undefined, severity, message: message.trim() };
        problems.set(`${abs}:${line}:${column}:${p.message}`, p);
    };
    // fusesoc prefixes the first line of a failing tool's output with `ERROR: `.
    for (const m of log.matchAll(/^(?:ERROR: )?%(Error|Warning)(?:-\w+)?: ([^\s:]+):(\d+):(?:(\d+):)? (.*)$/gm)) {
        add(m[1], m[2], m[3], m[4], m[5]);
    }
    for (const m of log.matchAll(/^\*\* (Error|Warning)(?: \(suppressible\))?: (?:\(\w+-\d+\) )?([^\s(]+)\((\d+)\): (.*)$/gm)) {
        add(m[1], m[2], m[3], undefined, m[4].replace(/^\(\w+-\d+\) /, ''));
    }
    return [...problems.values()];
}
/**
 * A Verible file list (verible.filelist, read by verible-verilog-ls for cross-file navigation) from the
 * `.vc` file fusesoc writes for Verilator: its `+incdir+` lines and source files, made absolute.
 */
function veribleFileList(vc, cwd) {
    return vc.split('\n').map(l => l.trim()).flatMap(l => {
        const inc = /^\+incdir\+(.+)$/.exec(l)?.[1];
        return inc ? [`+incdir+${path.resolve(cwd, inc)}`] : /^[^-+].*\.(sv|svh|v|vh)$/.test(l) ? [path.resolve(cwd, l)] : [];
    }).join('\n') + '\n';
}
/** The folders X-HEEP keeps verible-formatted, from its util/format-verible (`find <dirs> -name '*.sv*'`). */
function formattedDirs(formatScript) {
    return /^find (.+?) -name/m.exec(formatScript)?.[1].split(/\s+/) ?? [];
}
/** Apps X-HEEP's own app test (test/test_apps/test_apps.py) leaves out, with the reason given there, and its timeout. */
function appTestConfig(testApps) {
    const list = /^BLACKLIST = \[([\s\S]*?)^\]/m.exec(testApps)?.[1] ?? '';
    const skip = new Map([...list.matchAll(/^\s*"([^"]+)",?[ \t]*(?:#[ \t]*(.*))?$/gm)].map(m => [m[1], m[2]?.trim() || 'left out by X-HEEP\'s app test']));
    return { skip, timeoutS: Number(/^SIM_TIMEOUT_S = (\d+)/m.exec(testApps)?.[1] ?? 180) };
}
/** Summary of an RTL simulation from its console output, e.g. `exit 0 · 12502 cycles`. */
function simSummary(out) {
    // The system bus stops the simulation on an address outside the memory map (the FPGA hangs there instead).
    const outOfBound = /Out of bound memory access (0x[0-9a-fA-F]+)/.exec(out)?.[1];
    if (outOfBound) {
        return { ok: false, text: `memory access outside X-HEEP's memory map at ${outOfBound}` };
    }
    // X-HEEP's testbench, then X-ALP's.
    const cycles = /Simulation finished after (\d+) clock cycles/.exec(out)?.[1] ?? /Executed:\s+(\d+) cycles/.exec(out)?.[1];
    const value = /Program Finished with value (-?\d+)/.exec(out)?.[1] ?? /Exit code: (-?\d+)/.exec(out)?.[1];
    const text = value === undefined ? 'simulation failed' : `exit ${value}${cycles ? ` · ${cycles} cycles` : ''}`;
    return { ok: value === '0', text };
}
/**
 * Rewrites `from peripherals.<pkg> import (A, B)` into one import per class from its own module.
 * X-HEEP's peripheral packages re-export classes at runtime via globals(), which Pylance cannot follow.
 * `findModule(pkg, name)` returns the module (file stem) defining class `name`, or undefined to keep it as is.
 */
function explicitImports(src, findModule) {
    return src.replace(/^from (peripherals\.\w+) import (\(([^)]*)\)|[^\n(]+)$/gm, (line, pkg, all, group) => {
        const names = (group ?? all).split(',').map(n => n.trim()).filter(Boolean);
        const kept = [];
        const lines = names.flatMap(n => {
            const mod = findModule(pkg, n);
            return mod ? [`from ${pkg}.${mod} import ${n}`] : (kept.push(n), []);
        });
        return [...lines, ...(kept.length ? [`from ${pkg} import ${kept.join(', ')}`] : [])].join('\n') || line;
    });
}
//# sourceMappingURL=xheep.js.map