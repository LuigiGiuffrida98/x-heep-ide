// Helpers that turn the user's choices into X-HEEP commands and files.
// Kept free of the vscode API so the unit tests and the end-to-end test (src/test/e2e.ts) share them.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const XHEEP_GIT = 'https://github.com/x-heep/x-heep.git';

/**
 * The last X-HEEP commit the extension is known to work with. The X-HEEP canary workflow updates this file
 * in the extension's repo, so new projects get it without waiting for an extension release.
 */
export const XHEEP_COMMIT_URL = 'https://raw.githubusercontent.com/LuigiGiuffrida98/x-heep-ide/main/XHEEP_COMMIT';
export const isCommit = (s: string) => /^[0-9a-f]{40}$/.test(s);

/**
 * Adds X-HEEP as a shallow submodule in x-heep/, at `commit` if given;
 * on failure drops the half clone so a retry starts clean.
 */
export function cloneCommand(url = XHEEP_GIT, commit?: string): string {
	const pin = commit ? ` && git -C x-heep fetch -q --depth 1 origin ${commit} && git -C x-heep checkout -q ${commit} && git add x-heep` : '';
	return `{ [ -d .git ] || git init; } && `
		+ `{ git submodule add --progress --depth 1 ${url} x-heep && git config -f .gitmodules submodule.x-heep.shallow true${pin}; } `
		+ `|| { git rm -q --cached x-heep 2>/dev/null; rm -rf x-heep .git/modules/x-heep; exit 1; }`;
}

/** Paths changed in a work tree, from `git status --porcelain --untracked-files=no` (a rename gives its new path). */
export function changedFiles(porcelain: string): string[] {
	return porcelain.split('\n').filter(l => l.length > 3).map(l => l.slice(3).split(' -> ').pop()!);
}

/** Files mcu-gen writes from a template next to them (`<file>.tpl`): regenerated anyway, so safe to discard. */
export const isGenerated = (xheep: string, file: string) => fs.existsSync(path.join(xheep, `${file}.tpl`));

/**
 * Moves an X-HEEP checkout (run inside it) to `ref`, a commit or a branch of origin, fetched shallow like the
 * submodule; `discard` are generated files to restore first, so the checkout does not refuse them.
 */
export function updateCommand(ref: string, discard: string[] = []): string {
	const restore = discard.length ? `git checkout -q -- ${discard.map(f => `'${f}'`).join(' ')} && ` : '';
	return `${restore}git fetch -q --depth 1 origin ${ref} && git checkout -q FETCH_HEAD`;
}

/** Creates <dir>/main.c with a hello world for a new app. */
export function writeMain(dir: string, name: string) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'main.c'),
		`#include <stdio.h>\n#include <stdlib.h>\n\nint main(void)\n{\n    printf("Hello from ${name}!\\n");\n    return EXIT_SUCCESS;\n}\n`);
}

/**
 * make SOURCE for apps in a software project's sw/ (relative to X-HEEP's sw/).
 * CMake only takes drivers from <SOURCE>/device, so it also links the project's sw/device to X-HEEP's.
 */
export function projectSource(xheep: string, swRoot: string): string {
	const device = path.join(swRoot, 'device');
	if (!fs.existsSync(device)) {
		fs.symlinkSync(path.relative(swRoot, path.join(xheep, 'sw', 'device')), device);
	}
	// realpath: the Makefile resolves its own location, so x-heep/ may be a symlink.
	return path.relative(fs.realpathSync(path.join(xheep, 'sw')), fs.realpathSync(swRoot));
}

/** A new platform configuration: X-HEEP's configs/general.py with Pylance-friendly imports. */
export function configTemplate(xheep: string, name: string): string {
	const findModule = (pkg: string, cls: string) => {
		const dir = path.join(xheep, 'util', 'xheep_gen', ...pkg.split('.'));
		const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.py') && f !== '__init__.py') : [];
		return files.find(f => new RegExp(`^class ${cls}\\b`, 'm').test(fs.readFileSync(path.join(dir, f), 'utf8')))?.replace(/\.py$/, '');
	};
	return `# Platform configuration "${name}", started from X-HEEP configs/general.py.\n`
		+ '# Edit and save: the extension regenerates the platform before the next build.\n'
		+ explicitImports(fs.readFileSync(path.join(xheep, 'configs', 'general.py'), 'utf8'), findModule);
}

export type Mode = 'sim' | 'fpga-jtag' | 'fpga-flash';
export type Simulator = 'verilator' | 'questasim';

export const MODES: Record<Mode, { label: string; detail: string }> = {
	'sim': { label: 'Simulation', detail: 'Run the app on the RTL model (Verilator or Questasim)' },
	'fpga-jtag': { label: 'FPGA · JTAG', detail: 'Load the app into X-HEEP\'s RAM over JTAG: Run runs it, Debug debugs it with GDB' },
	'fpga-flash': { label: 'FPGA · Flash', detail: 'Program the app into the SPI flash: X-HEEP boots it by itself, as the chip would (no debugger)' },
};

/**
 * JTAG adapters for FPGA debugging: OpenOCD config in X-HEEP's tb/, USB vendor:product id, and the boards they
 * fit (all if unset). The on-board one needs a bitstream with the Xilinx BSCAN JTAG.
 */
export const JTAG_ADAPTERS: { label: string; detail: string; config: string; usb: string; boards?: string[]; bscan?: boolean }[] = [
	{ label: 'EPFL Programmer', detail: 'EPFL programmer (FT4232) on the PMOD JTAG pins', config: 'tb/core-v-mini-mcu-esl-programmer.cfg', usb: '0403:6011' },
	{ label: 'On-board USB (BSCAN)', detail: 'PYNQ-Z2 USB port; needs a bitstream built with FUSESOC_FLAGS=--flag=use_bscane_xilinx', config: 'tb/core-v-mini-mcu-pynq-z2-bscan.cfg', usb: '0403:6010', boards: ['pynq-z2'], bscan: true },
	{ label: 'Digilent JTAG-HS2', detail: 'Digilent JTAG-HS2 cable on the PMOD JTAG pins', config: 'tb/core-v-mini-mcu-nexsys-hs2.cfg', usb: '0403:6014' },
];

export type Adapter = typeof JTAG_ADAPTERS[number];

/** Adapters that fit the board; with a known bitstream, only the on-board one for a BSCAN bitstream, only the others otherwise. */
export function boardAdapters(board: string, bscanBitstream?: boolean): Adapter[] {
	return JTAG_ADAPTERS.filter(a => (!a.boards || a.boards.includes(board)) && (bscanBitstream === undefined || !!a.bscan === bscanBitstream));
}

/**
 * The adapter to use among `candidates`, from what is plugged in; else the ones to ask among. The on-board
 * adapter is the board's own USB, always there with the board, so it only counts when no external one is.
 */
export function pickAdapter(candidates: Adapter[], connected: (usb: string) => boolean): { adapter?: Adapter; choices: Adapter[] } {
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
export const EPFL_PROGRAMMER_USB = '0403:6011';

export interface Options {
	project: string;
	mode: Mode;
	compiler: string;
	board: string;
	simulator: Simulator;
	/** sw dir of an app living outside X-HEEP, relative to X-HEEP's sw/ (make SOURCE). */
	source?: string;
	/** make ARCH, when the platform needs other than X-HEEP's default (e.g. a hardware FPU). */
	arch?: string;
}

export function appVars(o: Options): string {
	const target = o.mode === 'sim' ? 'sim' : o.board;
	const linker = o.mode === 'fpga-flash' ? 'flash_load' : 'on_chip';
	const source = o.source ? ` SOURCE=${o.source}` : '';
	// -fstack-usage: a .su file per object, read by stackProblems (X-HEEP builds with -w, so no -Wstack-usage).
	return `PROJECT=${o.project} TARGET=${target} LINKER=${linker} COMPILER=${o.compiler}${source}${o.arch ? ` ARCH=${o.arch}` : ''} COMPILER_FLAGS=-fstack-usage`;
}

/** The linker script `make app` uses for the mode, in X-HEEP's sw/linker/. */
export const linkerScript = (mode: Mode) => mode === 'fpga-flash' ? 'link_flash_load.ld' : 'link.ld';

// --- Environment check ----------------------------------------------------------

export const SETUP_GUIDE = 'https://x-heep.readthedocs.io/en/latest/GettingStarted/Setup.html';

/** Python modules `make mcu-gen` and fusesoc need from X-HEEP's environment (util/python-requirements.txt). */
export const PYTHON_MODULES = ['hjson', 'mako', 'fusesoc', 'edalize', 'pkg_resources'];

/** Picks the environment's Python into $py as X-HEEP's Makefile does: conda's `python`, else the repo's .venv. */
const PICK_PYTHON = 'if [ -n "$CONDA_DEFAULT_ENV" ]; then py=python; else py=.venv/bin/python; fi; ';

/** Prints the modules of PYTHON_MODULES the environment's Python cannot import. */
export function missingModulesCommand(): string {
	return PICK_PYTHON + `"$py" -W ignore -c 'import importlib.util as u, sys; print(" ".join(m for m in sys.argv[1:] if u.find_spec(m) is None))' ${PYTHON_MODULES.join(' ')}`;
}

/** Runs the extension's media/platform.py (`read` or `check`) on a configuration, in X-HEEP's root. */
export function platformScriptCommand(script: string, cmd: 'read' | 'check', config: string): string {
	return PICK_PYTHON + `"$py" '${script}' ${cmd} . '${config}'`;
}

/** The conda environment an `xheep.envSetup` snippet activates, if it does. */
export function condaEnvName(envSetup: string): string | undefined {
	return /conda activate\s+([^\s;&|]+)/.exec(envSetup)?.[1];
}

/** Tool versions X-HEEP is tested with, from its setup guide (docs/source/GettingStarted/Setup.md). */
export function requiredVersions(setupGuide: string): { verilator?: string; verible?: string } {
	return {
		verilator: /VERILATOR_VERSION=(\S+)/.exec(setupGuide)?.[1],
		verible: /VERIBLE_VERSION=(\S+)/.exec(setupGuide)?.[1],
	};
}

/** `verilator --version`: "Verilator 5.040 2025-08-30 rev v5.040" -> 5.040. */
export const verilatorVersion = (out: string) => /Verilator (\d+\.\d+)/.exec(out)?.[1];

/** `verible-verilog-format --version`: "Version v0.0-4023-gc1271a00 ..." -> v0.0-4023-gc1271a00. */
export const veribleVersion = (out: string) => /v\d+\.\d+-\d+-g[0-9a-f]+/.exec(out)?.[0];

export interface UsbDevice { vid: string; pid: string; product?: string; node: string }

/** USB devices from sysfs (no lsusb needed), with their /dev/bus/usb node, whose permissions OpenOCD and iceprog need. */
export function usbDevices(sysfs = '/sys/bus/usb/devices'): UsbDevice[] {
	const read = (dir: string, f: string) => { try { return fs.readFileSync(path.join(dir, f), 'utf8').trim(); } catch { return undefined; } };
	return (fs.existsSync(sysfs) ? fs.readdirSync(sysfs) : []).flatMap(d => {
		const dir = path.join(sysfs, d);
		const [vid, pid, bus, dev] = ['idVendor', 'idProduct', 'busnum', 'devnum'].map(f => read(dir, f));
		return vid && pid && bus && dev ? [{ vid, pid, product: read(dir, 'product'), node: `/dev/bus/usb/${bus.padStart(3, '0')}/${dev.padStart(3, '0')}` }] : [];
	});
}

/** The udev rule giving users access to a USB device, as in X-HEEP's ProgramFlash and Debug guides. */
export function udevRule(vid: string, pid: string): string {
	return `ATTRS{idVendor}=="${vid}", ATTRS{idProduct}=="${pid}", MODE="666", GROUP="plugdev"`;
}

// --- Explaining build failures ------------------------------------------------
// X-HEEP is bare metal with little memory: errors that are plain to a firmware developer (a linker region,
// an undefined `sleep`) are not to someone coming from a PC. These turn them into what to do.

export interface BuildProblem {
	/** Absolute source file, or undefined for problems of the whole app (memory). */
	file?: string;
	/** 1-based, as in compiler output. */
	line?: number;
	column?: number;
	severity: 'error' | 'warning' | 'info';
	message: string;
}

/** Sizes of the RAM regions in a linker script's MEMORY block, by name (ram0, ram1, ...). */
export function memoryRegions(linkerScript: string): Record<string, number> {
	return Object.fromEntries([...linkerScript.matchAll(/^\s*(\w+)\s*\([^)]*\)\s*:\s*ORIGIN\s*=\s*\w+\s*,\s*LENGTH\s*=\s*(0x[0-9a-fA-F]+|\d+)/gm)]
		.map(m => [m[1], Number(m[2])]));
}

/** The default stack size in a linker script (`__stack_size = DEFINED(__stack_size) ? __stack_size : 0x800;`). */
export function stackSize(linkerScript: string): number | undefined {
	const size = /__stack_size\s*=\s*DEFINED\(__stack_size\)\s*\?\s*__stack_size\s*:\s*(0x[0-9a-fA-F]+|\d+)/.exec(linkerScript)?.[1];
	return size === undefined ? undefined : Number(size);
}

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

/** Why a function from a PC's C library is missing, and what to use instead. */
function missingFunctionHint(name: string): string | undefined {
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
export function explainBuild(log: string, regions: Record<string, number>, isAppFile: (file: string) => boolean): BuildProblem[] {
	const problems: BuildProblem[] = [];
	for (const m of new Map([...log.matchAll(/region [`'](\w+)' overflowed by (\d+) bytes/g)].map(m => [m[1], m])).values()) {
		const size = regions[m[1]];
		problems.push({
			severity: 'error',
			message: `The app does not fit in memory: it needs ${m[2]} bytes more than ${m[1]}${size ? `, which holds ${kb(size)}` : ''}. `
				+ 'Shrink large arrays and buffers, avoid heavy libraries (C++ iostream alone takes about 300 KB), '
				+ 'or switch to a platform configuration with more memory (X-HEEP: Select Platform Configuration).',
		});
	}
	const seen = new Set<string>();
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
export function stackProblems(su: string, stack: number, isAppFile: (file: string) => boolean): BuildProblem[] {
	return [...su.matchAll(/^(.+?):(\d+):(\d+):([^\t]+)\t(\d+)\t(\S+)/gm)].flatMap(([, file, line, column, fn, bytes, kind]) => {
		const unbounded = kind.includes('dynamic') && !kind.includes('bounded');
		if (!isAppFile(file) || (Number(bytes) <= stack && !unbounded)) {
			return [];
		}
		return [{
			file, line: Number(line), column: Number(column), severity: 'warning' as const,
			message: `${fn}() ${unbounded ? 'allocates stack at run time (variable-length array or alloca)' : `needs ${bytes} bytes of stack`}, `
				+ `but X-HEEP's stack is ${stack} bytes: the program would overwrite its own data. Make large arrays static or global, `
				+ 'or raise the stack size (linker_script stack_size in the platform configuration).',
		}];
	});
}

/** The app's largest stack frame, from GCC's .su files (see stackProblems). */
export function largestFrame(su: string, isAppFile: (file: string) => boolean): { fn: string; bytes: number } | undefined {
	let best: { fn: string; bytes: number } | undefined;
	for (const [, file, fn, bytes] of su.matchAll(/^(.+?):\d+:\d+:([^\t]+)\t(\d+)\t/gm)) {
		if (isAppFile(file) && (!best || Number(bytes) > best.bytes)) {
			best = { fn, bytes: Number(bytes) };
		}
	}
	return best;
}

// --- Explaining run failures ---------------------------------------------------

/** X-HEEP's exception handler messages (sw/device/lib/runtime/handler.c), as a reader would name them. */
const EXCEPTIONS: [RegExp, string][] = [
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
export function uartException(uart: string): string | undefined {
	return EXCEPTIONS.find(([re]) => new RegExp(`${re.source}[^\n]*\n`).test(uart))?.[1];
}

/** RISC-V mcause of a synchronous exception, as a reader would name it. */
export function exceptionCause(mcause: number): string {
	return ['misaligned instruction', 'instruction access fault', 'illegal instruction', 'breakpoint (ebreak)',
		'misaligned load', 'load access fault', 'misaligned store', 'store access fault', 'ecall from U-mode',
		'ecall from S-mode', 'reserved exception', 'ecall'][mcause] ?? `exception ${mcause}`;
}

/** Bytes a terminal would not show: X-HEEP's exception handler prints mtval as raw bytes. */
export const printable = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f�]/g, '');

export function buildCommand(o: Options): string {
	return `make app ${appVars(o)}`;
}

/** Compiled model inside build/<fusesoc core dir>/; mcu-gen's `fusesoc --setup` creates the dirs empty. */
export const SIM_MODEL: Record<Simulator, string> = {
	verilator: 'sim-verilator/Vtestharness',
	questasim: 'sim-modelsim/work',
};

export function simModelBuildCommand(sim: Simulator): string {
	// `make <sim>-build` pipes fusesoc into tee, so its exit code is always 0: drop the old model and check it came back.
	return `rm -rf build/*/${SIM_MODEL[sim]} && make ${sim}-build && `
		+ `{ ls build/*/${SIM_MODEL[sim]} >/dev/null 2>&1 || { echo "Simulation model build failed, see buildsim.log"; exit 1; }; }`;
}

/** Recompiles only what changed in the CMake tree `make app` configured (it would wipe it and start over). */
export function incrementalBuildCommand(jobs: number): string {
	return `make -s -C sw/build -j${jobs}`;
}

/**
 * Runs the compiled Verilator model directly, the same step `make verilator-run` does after fusesoc,
 * which first spends seconds resolving cores and rerunning generators.
 */
export function verilatorRunCommand(simDir: string): string {
	return `cd '${simDir}' && ./Vtestharness +firmware=../../../sw/build/main.hex`;
}

/** Separate fusesoc build root for the JTAG-enabled model, so the regular one stays untouched. */
export const DEBUG_BUILD_ROOT = 'build/debug';

/**
 * Builds a Verilator model with the remote bitbang JTAG server (JTAG_DPI=1) for GDB in simulation.
 * Through make, not fusesoc directly: the boot ROM generator needs the toolchain prefix the Makefile exports.
 * Like `verilator-build` the exit code is always 0, hence the check on the model.
 */
export function debugModelBuildCommand(): string {
	const exe = `${DEBUG_BUILD_ROOT}/sim-verilator/Vtestharness`;
	return `rm -f ${exe} && make verilator-build FUSESOC_FLAGS='--build-root ${DEBUG_BUILD_ROOT}' FUSESOC_PARAM='--JTAG_DPI=1' && `
		+ `{ test -x ${exe} || { echo "Debug model build failed, see buildsim.log"; exit 1; }; }`;
}

/** Starts the debug model waiting for OpenOCD on port 4567; GDB then loads the firmware over JTAG. */
export function debugSimCommand(simDir: string, hex: string): string {
	return `cd '${simDir}' && ./Vtestharness +openOCD=true +firmware='${hex}'`;
}

export function openocdCommand(openocd: string, config: string): string {
	return `${openocd} -f '${config}'`;
}

/**
 * Where the program ends: `_exit` gets the exit code in a0. `*_exit` is its first instruction, before a0 is reused;
 * a plain `_exit` breakpoint may land after the prologue.
 */
export const EXIT_BREAKPOINT = 'break *_exit';

/** Loads the ELF over OpenOCD's GDB port, runs it to `_exit` and prints `XHEEP_EXIT <code>`. */
export function gdbRunCommand(gdb: string, elf: string): string {
	return `'${gdb}' -q -nx -batch '${elf}' -ex 'set remotetimeout 2000' -ex 'target extended-remote :3333' -ex load `
		+ `-ex '${EXIT_BREAKPOINT}' -ex continue -ex 'printf "XHEEP_EXIT %d\\n", $a0'`;
}

/**
 * A register from OpenOCD's reply to `reg <name>` ("pc (/32): 0x00000a92"); undefined when the hart could not be
 * halted, as when it hangs on a bus access nobody answers (the reply is then empty).
 */
export function regValue(reply: string, name = 'pc'): number | undefined {
	const value = new RegExp(`^${name} \\(/32\\): (0x[0-9a-f]+)`, 'm').exec(reply)?.[1];
	return value === undefined ? undefined : Number(value);
}

export function exitCode(gdbOutput: string): number | undefined {
	const code = /XHEEP_EXIT (-?\d+)/.exec(gdbOutput)?.[1];
	return code === undefined ? undefined : Number(code);
}

/** The EPFL programmer's UART (FT4232 interface 2), also the AUP-ZU3 on-board one. */
const XHEEP_UART = /FTDI_Quad_RS232-HS-if02/;

/** The UART to use among the serial ports: the X-HEEP one if connected, else the only port there is. */
export function pickSerialPort(candidates: string[]): string | undefined {
	return candidates.find(p => XHEEP_UART.test(p)) ?? (candidates.length === 1 ? candidates[0] : undefined);
}

/** Streams a serial port to stdout, raw (no echo, no line discipline). */
export function serialReadCommand(port: string, baud: number): string {
	return `stty -F '${port}' ${baud} raw -echo -crtscts cs8 -parenb -cstopb && exec cat '${port}'`;
}

/** Runs the already built firmware (sw/build/main.hex) on the RTL model. */
export function simCommand(o: Options): string {
	return `make ${o.simulator}-run`;
}

export function mcuGenCommand(config: string): string {
	return `make mcu-gen X_HEEP_CFG='${config}'`;
}

/** Programs the already built firmware into the FPGA board's SPI flash. */
export const FLASH_COMMAND = 'make flash-prog';

// --- FPGA bitstream -----------------------------------------------------------
// Loading a bitstream needs no Vivado: OpenOCD, already needed for JTAG debugging, does it. Building one does.

export type Programmer = 'openocd' | 'vivado';

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
export const BOARDS: Record<string, { official: boolean; part?: string; openocd?: string; usb?: string; ramKb?: number }> = {
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
export function builtBitstream(xheep: string, board: string): string | undefined {
	const build = path.join(xheep, 'build');
	for (const core of fs.existsSync(build) ? fs.readdirSync(build).filter(d => d.startsWith('openhwgroup.org_systems_core-v-mini-mcu_')) : []) {
		const dir = path.join(build, core, `${board}-vivado`);
		const bit = fs.existsSync(dir) ? fs.readdirSync(dir).find(f => f.endsWith('.bit')) : undefined;
		if (bit) {
			return path.join(dir, bit);
		}
	}
	return undefined;
}

/**
 * What the extension knows of a bitstream, kept in its own storage under the bitstream's sha1: nothing goes next
 * to the file or into X-HEEP. Recorded when the extension builds one; for one from elsewhere, asked once.
 */
export interface BitstreamInfo {
	/** The platform configuration it was built for, to name it and to switch back to it. */
	config?: string;
	/** The hardware it was built for (platform.ts hardwareFingerprint); undefined when nobody knows. */
	hardware?: string;
	/** Built with the Xilinx BSCAN JTAG (FUSESOC_FLAGS=--flag=use_bscane_xilinx), for the on-board USB adapter. */
	bscan?: boolean;
	board?: string;
	xheepCommit?: string;
	builtAt?: string;
}

/** A file's sha1: what identifies a bitstream wherever it is copied. */
export const fileSha1 = (file: string) => createHash('sha1').update(fs.readFileSync(file)).digest('hex');

/**
 * Builds the bitstream with Vivado for the current platform. `make vivado-fpga` pipes fusesoc into tee,
 * so its exit code is always 0: drop the old bitstream and check a new one came out.
 */
export function bitstreamBuildCommand(board: string, bscan: boolean): string {
	const bit = `build/*/${board}-vivado/*.bit`;
	return `rm -f ${bit} && make vivado-fpga FPGA_BOARD=${board}${bscan ? ' FUSESOC_FLAGS=--flag=use_bscane_xilinx' : ''} && `
		+ `{ ls ${bit} >/dev/null 2>&1 || { echo "Bitstream build failed, see buildvivado.log"; exit 1; }; }`;
}

/** Vivado batch script that configures the board's FPGA with `bitstream`, or clears its configuration if undefined. */
export function vivadoTcl(part: string, bitstream?: string): string {
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
export function vivadoCommand(tclFile: string): string {
	return `cd '${path.dirname(tclFile)}' && vivado -mode batch -nolog -nojournal -notrace -source '${tclFile}'`;
}

/**
 * OpenOCD configuring the FPGA with `bitstream` (virtex2 PLD driver, 7-series), or clearing its configuration if
 * undefined: JPROGRAM (IR 0x0b), as Vivado's boot_hw_device. Exits non-zero on failure.
 */
export function openocdFpgaCommand(openocd: string, setup: string, bitstream?: string): string {
	const action = bitstream ? `pld load 0 {${bitstream}}` : 'irscan fpga.tap 0x0b; runtest 1000';
	return `${openocd} -c '${setup}; pld device virtex2 fpga.tap; init; ${action}; shutdown'`;
}

/** Summary of an RTL simulation from its console output, e.g. `exit 0 · 12502 cycles`. */
export function simSummary(out: string): { ok: boolean; text: string } {
	// The system bus stops the simulation on an address outside the memory map (the FPGA hangs there instead).
	const outOfBound = /Out of bound memory access (0x[0-9a-fA-F]+)/.exec(out)?.[1];
	if (outOfBound) {
		return { ok: false, text: `memory access outside X-HEEP's memory map at ${outOfBound}` };
	}
	const cycles = /Simulation finished after (\d+) clock cycles/.exec(out)?.[1];
	const value = /Program Finished with value (-?\d+)/.exec(out)?.[1];
	const text = value === undefined ? 'simulation failed' : `exit ${value}${cycles ? ` · ${cycles} cycles` : ''}`;
	return { ok: value === '0', text };
}

/**
 * Rewrites `from peripherals.<pkg> import (A, B)` into one import per class from its own module.
 * X-HEEP's peripheral packages re-export classes at runtime via globals(), which Pylance cannot follow.
 * `findModule(pkg, name)` returns the module (file stem) defining class `name`, or undefined to keep it as is.
 */
export function explicitImports(src: string, findModule: (pkg: string, name: string) => string | undefined): string {
	return src.replace(/^from (peripherals\.\w+) import (\(([^)]*)\)|[^\n(]+)$/gm, (line: string, pkg: string, all: string, group?: string) => {
		const names = (group ?? all).split(',').map(n => n.trim()).filter(Boolean);
		const kept: string[] = [];
		const lines = names.flatMap(n => {
			const mod = findModule(pkg, n);
			return mod ? [`from ${pkg}.${mod} import ${n}`] : (kept.push(n), []);
		});
		return [...lines, ...(kept.length ? [`from ${pkg} import ${kept.join(', ')}`] : [])].join('\n') || line;
	});
}
