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
const assert = __importStar(require("assert"));
const tools_1 = require("../tools");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const xheep_1 = require("../xheep");
const soc_1 = require("../soc");
const base = { project: 'hello_world', mode: 'sim', compiler: 'gcc', board: 'pynq-z2', simulator: 'verilator' };
suite('X-HEEP make commands', () => {
    test('simulation builds for sim target with on-chip linker, then runs the hex', () => {
        assert.strictEqual((0, xheep_1.buildCommand)(base), 'make app PROJECT=hello_world TARGET=sim LINKER=on_chip COMPILER=gcc COMPILER_FLAGS=-fstack-usage');
        assert.strictEqual((0, xheep_1.simCommand)({ ...base, simulator: 'questasim' }), 'make questasim-run');
    });
    test('fast paths skip the clean rebuild and fusesoc', () => {
        assert.strictEqual((0, xheep_1.incrementalBuildCommand)(8), 'make -s -C sw/build -j8');
        assert.strictEqual((0, xheep_1.verilatorRunCommand)('/x/build/core/sim-verilator'), "cd '/x/build/core/sim-verilator' && ./Vtestharness +firmware=../../../sw/build/main.hex");
    });
    test('simulation debug uses its own JTAG-enabled model', () => {
        // Through make: the boot ROM generator needs COMPILER_PREFIX, which the Makefile exports.
        assert.ok((0, xheep_1.debugModelBuildCommand)().includes("make verilator-build FUSESOC_FLAGS='--build-root build/debug' FUSESOC_PARAM='--JTAG_DPI=1'"));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xheep-'));
        fs.mkdirSync(path.join(dir, 'build', 'debug', 'sim-verilator'), { recursive: true });
        const cmd = (0, xheep_1.debugModelBuildCommand)().replace(/make verilator-build [^&]*/, 'true ');
        assert.strictEqual((0, child_process_1.spawnSync)('/bin/bash', ['-c', cmd], { cwd: dir }).status, 1);
        assert.strictEqual((0, xheep_1.debugSimCommand)('/m', '/x/sw/build/main.hex'), "cd '/m' && ./Vtestharness +openOCD=true +firmware='/x/sw/build/main.hex'");
    });
    test('new projects clone X-HEEP at the pinned commit', () => {
        const sha = 'bf0748ac5d15a1c274a47e3a7b663e6153c34187';
        assert.ok((0, xheep_1.cloneCommand)('https://x', sha).includes(`git -C x-heep fetch -q --depth 1 origin ${sha} && git -C x-heep checkout -q ${sha} && git add x-heep;`));
        assert.ok(!(0, xheep_1.cloneCommand)('https://x').includes('checkout'));
    });
    test('simulation summary reads the testbench output', () => {
        assert.deepStrictEqual((0, xheep_1.simSummary)('Simulation finished after 12502 clock cycles\nProgram Finished with value 0\n'), { ok: true, text: 'exit 0 · 12502 cycles' });
        assert.deepStrictEqual((0, xheep_1.simSummary)('Program Finished with value 3\n'), { ok: false, text: 'exit 3' });
        assert.deepStrictEqual((0, xheep_1.simSummary)('%Error: ...'), { ok: false, text: 'simulation failed' });
    });
    test('mcu-gen takes the config by path, also outside X-HEEP', () => {
        assert.strictEqual((0, xheep_1.mcuGenCommand)('/home/me/proj/configs/my.py'), "make mcu-gen X_HEEP_CFG='/home/me/proj/configs/my.py'");
    });
    test('apps outside X-HEEP are built with SOURCE', () => {
        assert.strictEqual((0, xheep_1.buildCommand)({ ...base, source: '../../sw' }), 'make app PROJECT=hello_world TARGET=sim LINKER=on_chip COMPILER=gcc SOURCE=../../sw COMPILER_FLAGS=-fstack-usage');
    });
    test('model build fails when the model is missing even if make exits 0', () => {
        // A stale model from a previous build must not count: it is removed first.
        const cmd = (0, xheep_1.simModelBuildCommand)('verilator').replace('make verilator-build', 'true');
        const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'xheep-'));
        require('fs').mkdirSync(require('path').join(dir, 'build', 'core', 'sim-verilator'), { recursive: true });
        require('fs').writeFileSync(require('path').join(dir, 'build', 'core', 'sim-verilator', 'Vtestharness'), '');
        const run = require('child_process').spawnSync('/bin/bash', ['-c', cmd], { cwd: dir });
        assert.strictEqual(run.status, 1);
    });
    test('config template imports each peripheral class from its own module', () => {
        const src = 'from xheep import XHeep\nfrom peripherals.base_peripherals import (\n    SOC_ctrl,\n    Unknown,\n)\nfrom peripherals.user_peripherals import UART\n';
        const mods = { SOC_ctrl: 'SOC_ctrl', UART: 'uart' };
        assert.strictEqual((0, xheep_1.explicitImports)(src, (_pkg, n) => mods[n]), 'from xheep import XHeep\nfrom peripherals.base_peripherals.SOC_ctrl import SOC_ctrl\nfrom peripherals.base_peripherals import Unknown\n'
            + 'from peripherals.user_peripherals.uart import UART\n');
    });
    test('JTAG debug builds for the board with on-chip linker', () => {
        assert.strictEqual((0, xheep_1.buildCommand)({ ...base, mode: 'fpga-jtag', compiler: 'clang' }), 'make app PROJECT=hello_world TARGET=pynq-z2 LINKER=on_chip COMPILER=clang COMPILER_FLAGS=-fstack-usage');
    });
    test('flash mode builds with the flash_load linker', () => {
        assert.strictEqual((0, xheep_1.buildCommand)({ ...base, mode: 'fpga-flash', board: 'nexys-a7-100t' }), 'make app PROJECT=hello_world TARGET=nexys-a7-100t LINKER=flash_load COMPILER=gcc COMPILER_FLAGS=-fstack-usage');
    });
});
suite('FPGA bitstream', () => {
    const fakeXheep = () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xheep-'));
        fs.mkdirSync(path.join(dir, 'build', 'openhwgroup.org_systems_core-v-mini-mcu_1.0.6', 'pynq-z2-vivado'), { recursive: true });
        return dir;
    };
    test('finds the bitstream fusesoc built for the board', () => {
        const dir = fakeXheep();
        assert.strictEqual((0, xheep_1.builtBitstream)(dir, 'pynq-z2'), undefined);
        const bit = path.join(dir, 'build', 'openhwgroup.org_systems_core-v-mini-mcu_1.0.6', 'pynq-z2-vivado', 'core.bit');
        fs.writeFileSync(bit, '');
        assert.strictEqual((0, xheep_1.builtBitstream)(dir, 'pynq-z2'), bit);
        assert.strictEqual((0, xheep_1.builtBitstream)(dir, 'nexys-a7-100t'), undefined);
    });
    test('bitstream build fails when no bitstream comes out even if make exits 0', () => {
        // `make vivado-fpga` exits 0 also when Vivado fails; a stale bitstream must not count either.
        const dir = fakeXheep();
        fs.writeFileSync(path.join(dir, 'build', 'openhwgroup.org_systems_core-v-mini-mcu_1.0.6', 'pynq-z2-vivado', 'old.bit'), '');
        const cmd = (0, xheep_1.bitstreamBuildCommand)('pynq-z2', false).replace('make vivado-fpga FPGA_BOARD=pynq-z2', 'true');
        assert.strictEqual((0, child_process_1.spawnSync)('/bin/bash', ['-c', cmd], { cwd: dir }).status, 1);
    });
    test('the on-board USB adapter gets a BSCAN bitstream', () => {
        assert.ok((0, xheep_1.bitstreamBuildCommand)('pynq-z2', true).includes('make vivado-fpga FPGA_BOARD=pynq-z2 FUSESOC_FLAGS=--flag=use_bscane_xilinx'));
        assert.ok(!(0, xheep_1.bitstreamBuildCommand)('pynq-z2', false).includes('FUSESOC_FLAGS'));
    });
    test('loading and clearing the FPGA', () => {
        assert.strictEqual((0, xheep_1.openocdFpgaCommand)('openocd', 'SETUP', '/b/x.bit'), "openocd -c 'SETUP; pld device virtex2 fpga.tap; init; pld load 0 {/b/x.bit}; shutdown'");
        assert.ok((0, xheep_1.openocdFpgaCommand)('openocd', 'SETUP').includes('irscan fpga.tap 0x0b')); // JPROGRAM
        assert.ok((0, xheep_1.vivadoTcl)('xc7z020', '/b/x.bit').includes('set_property PROGRAM.FILE {/b/x.bit} $dev\nprogram_hw_devices $dev'));
        assert.ok((0, xheep_1.vivadoTcl)('xc7z020').includes('boot_hw_device $dev'));
        assert.ok((0, xheep_1.vivadoTcl)('xc7z020').includes('get_hw_devices xc7z020*'));
    });
    test('a bitstream is known by its content, wherever it is copied', () => {
        const dir = fakeXheep();
        fs.writeFileSync(path.join(dir, 'a.bit'), 'bits');
        fs.copyFileSync(path.join(dir, 'a.bit'), path.join(dir, 'copy.bit'));
        assert.strictEqual((0, xheep_1.fileSha1)(path.join(dir, 'copy.bit')), (0, xheep_1.fileSha1)(path.join(dir, 'a.bit')));
    });
});
suite('FPGA run over JTAG', () => {
    test('runs to the first instruction of _exit, where a0 still holds the exit code', () => {
        const cmd = (0, xheep_1.gdbRunCommand)('/t/gdb', '/x/main.elf');
        assert.ok(cmd.startsWith("'/t/gdb' -q -nx -batch '/x/main.elf' -ex 'set remotetimeout 2000' -ex 'target extended-remote :3333' -ex load"));
        assert.ok(cmd.includes("-ex 'break *_exit' -ex continue -ex 'printf \"XHEEP_EXIT %d\\n\", $a0'"));
        assert.strictEqual((0, xheep_1.exitCode)('Breakpoint 1, 0x00000dda in _exit ()\nXHEEP_EXIT 0\n'), 0);
        assert.strictEqual((0, xheep_1.exitCode)('XHEEP_EXIT -2\n'), -2);
        assert.strictEqual((0, xheep_1.exitCode)('Remote connection closed'), undefined);
    });
    test('picks the X-HEEP UART among the serial ports', () => {
        const byId = '/dev/serial/by-id/';
        const epfl = [0, 1, 2, 3].map(i => `${byId}usb-FTDI_Quad_RS232-HS-if0${i}-port0`);
        assert.strictEqual((0, xheep_1.pickSerialPort)([`${byId}usb-Xilinx_TUL_1234-tul-if01-port0`, ...epfl, '/dev/ttyUSB2']), epfl[2]);
        assert.strictEqual((0, xheep_1.pickSerialPort)(['/dev/ttyUSB0']), '/dev/ttyUSB0');
        assert.strictEqual((0, xheep_1.pickSerialPort)(['/dev/ttyUSB0', '/dev/ttyUSB1']), undefined);
        assert.strictEqual((0, xheep_1.pickSerialPort)([]), undefined);
    });
    test('tells a halted program from one hung on the bus', () => {
        // OpenOCD's replies on a PYNQ-Z2: a busy loop halts; a load nobody answers leaves the hart unhaltable.
        assert.strictEqual((0, xheep_1.regValue)('pc (/32): 0x00000a92\n'), 0xa92);
        assert.strictEqual((0, xheep_1.regValue)(''), undefined);
        assert.strictEqual((0, xheep_1.regValue)('mepc (/32): 0x00000214\n', 'mepc'), 0x214);
    });
    test('reads the UART raw', () => {
        assert.strictEqual((0, xheep_1.serialReadCommand)('/dev/ttyUSB2', 9600), "stty -F '/dev/ttyUSB2' 9600 raw -echo -crtscts cs8 -parenb -cstopb && exec cat '/dev/ttyUSB2'");
    });
});
suite('Explaining failures to newcomers', () => {
    // Lines from real builds of apps written for a PC, on the ci.hjson platform.
    const app = '/p/sw/applications';
    const isApp = (f) => f.startsWith(app);
    const ld = 'MEMORY\n{\n    ram0 (rwxa) : ORIGIN = 0x000000, LENGTH = 0x018000\n    ram1 (rwxa) : ORIGIN = 0x018000, LENGTH = 0x018000\n}\n'
        + '  __stack_size = DEFINED(__stack_size) ? __stack_size : 0x800;\n';
    test('reads the memory regions and the stack size of the platform', () => {
        assert.deepStrictEqual((0, xheep_1.memoryRegions)(ld), { ram0: 0x18000, ram1: 0x18000 });
        assert.strictEqual((0, xheep_1.stackSize)(ld), 0x800);
    });
    test('a memory overflow says how much is missing and what to do', () => {
        const log = "/t/riscv32-corev-elf/bin/ld: region `ram1' overflowed by 707136 bytes\ncollect2: error: ld returned 1 exit status\n";
        const [p] = (0, xheep_1.explainBuild)(log, (0, xheep_1.memoryRegions)(ld), isApp);
        assert.strictEqual(p.file, undefined);
        assert.ok(p.message.startsWith('The app does not fit in memory: it needs 707136 bytes more than ram1, which holds 96 KB.'));
        assert.ok(p.message.includes('Select Platform Configuration'));
    });
    test('functions that need an operating system say what to use instead', () => {
        const log = `${app}/sleep_app/main.c:4:(.text.startup.main+0x1e): undefined reference to \`sleep'\n`
            + "/build/libstdc++-v3/src/c++11/ext11-inst.cc:259:(.text._ZN9__gnu_cxx18stdio_sync_filebuf+0xa): undefined reference to `getwc'\n"
            + `${app}/pthread_app/main.c:6:5: error: implicit declaration of function 'pthread_create' [-Wimplicit-function-declaration]\n`;
        const ps = (0, xheep_1.explainBuild)(log, {}, isApp);
        assert.strictEqual(ps.length, 2); // nothing on the C++ library's own references
        assert.deepStrictEqual([ps[0].file, ps[0].line, ps[0].severity], [`${app}/sleep_app/main.c`, 4, 'error']);
        assert.ok(ps[0].message.startsWith('sleep() is not available on X-HEEP. X-HEEP has no operating system to sleep'));
        assert.deepStrictEqual([ps[1].line, ps[1].column, ps[1].severity], [6, 5, 'info']);
        assert.ok(ps[1].message.includes('FreeRTOS'));
    });
    test('functions too big for the stack are flagged where they are defined', () => {
        const su = `${app}/big_stack/main.c:4:5:process\t16400\tstatic\n${app}/big_stack/main.c:10:5:main\t16\tstatic\n`
            + `${app}/vla/main.c:3:5:filter\t32\tdynamic\n/x/sw/device/lib/runtime/syscalls.c:9:5:_write\t4096\tstatic\n`;
        const ps = (0, xheep_1.stackProblems)(su, 2048, isApp);
        assert.deepStrictEqual(ps.map(p => [p.file, p.line, p.column]), [[`${app}/big_stack/main.c`, 4, 5], [`${app}/vla/main.c`, 3, 5]]);
        assert.ok(ps[0].message.startsWith("process() needs 16400 bytes of stack, but X-HEEP's stack is 2048 bytes"));
        assert.ok(ps[1].message.includes('variable-length array'));
    });
    test('exceptions reported on the UART, and their causes', () => {
        assert.strictEqual((0, xheep_1.uartException)('before\nIllegal Instruction fault, mtval shows instruction content\nMTVAL value is '), 'illegal instruction');
        assert.strictEqual((0, xheep_1.uartException)('Load/Store fault, mtval shows the fault address\n'), 'load/store access fault');
        assert.strictEqual((0, xheep_1.uartException)('hello world!\n'), undefined);
        assert.strictEqual((0, xheep_1.uartException)('Illegal Instruction fault, mtval show'), undefined); // not until the line is complete
        assert.strictEqual((0, xheep_1.exceptionCause)(2), 'illegal instruction');
        assert.strictEqual((0, xheep_1.exceptionCause)(7), 'store access fault');
        assert.strictEqual((0, xheep_1.printable)('MTVAL value is \u0000\u0000\u0013\n'), 'MTVAL value is \n');
    });
    test('the simulator stopping on an address outside the memory map', () => {
        assert.deepStrictEqual((0, xheep_1.simSummary)('                   0 Out of bound memory access 0x5850006c\n%Error: system_bus.sv:254: Verilog $stop\n'), { ok: false, text: "memory access outside X-HEEP's memory map at 0x5850006c" });
    });
});
suite('Environment check', () => {
    test('finds the conda environment the setup activates', () => {
        assert.strictEqual((0, xheep_1.condaEnvName)('eval "$(conda shell.bash hook)" && conda activate x-heep'), 'x-heep');
        assert.strictEqual((0, xheep_1.condaEnvName)('source ~/miniconda3/bin/activate; conda activate core-v-mini-mcu && export X=1'), 'core-v-mini-mcu');
        assert.strictEqual((0, xheep_1.condaEnvName)('source .venv/bin/activate'), undefined);
    });
    test('reads the tool versions from the setup guide and from the tools', () => {
        assert.deepStrictEqual((0, xheep_1.requiredVersions)('export VERILATOR_VERSION=5.040\n...\nexport VERIBLE_VERSION=v0.0-4023-gc1271a00\n'), { verilator: '5.040', verible: 'v0.0-4023-gc1271a00' });
        assert.strictEqual((0, xheep_1.verilatorVersion)('Verilator 5.040 2025-08-30 rev v5.040\n'), '5.040');
        assert.strictEqual((0, xheep_1.veribleVersion)('Version\tv0.0-4023-gc1271a00\nCommit-Timestamp\t2025-08-29T09:25:59Z\n'), 'v0.0-4023-gc1271a00');
        assert.strictEqual((0, xheep_1.veribleVersion)('v0.0-1824-ga3b5bedf\nCommit\t2022-01-14 23:24:43 -0800\n'), 'v0.0-1824-ga3b5bedf');
        assert.ok((0, tools_1.veribleInstallCommand)('v0.0-4023-gc1271a00').includes('/v0.0-4023-gc1271a00/verible-v0.0-4023-gc1271a00-linux-static-x86_64.tar.gz'));
    });
    test('checks the Python packages in the environment python', () => {
        assert.ok((0, xheep_1.missingModulesCommand)().includes('hjson mako fusesoc edalize pkg_resources'));
        assert.ok((0, xheep_1.missingModulesCommand)().includes('.venv/bin/python'));
        assert.ok((0, xheep_1.missingModulesCommand)(['tabulate']).includes('pkg_resources tabulate'), 'X-ALP needs more');
    });
    test('lists USB devices from sysfs with their device node', () => {
        const sysfs = fs.mkdtempSync(path.join(os.tmpdir(), 'usb-'));
        const dev = (name, files) => {
            fs.mkdirSync(path.join(sysfs, name));
            Object.entries(files).forEach(([f, v]) => fs.writeFileSync(path.join(sysfs, name, f), `${v}\n`));
        };
        dev('1-3', { idVendor: '0403', idProduct: '6011', busnum: '1', devnum: '15', product: 'Quad RS232-HS' });
        dev('1-3:1.0', { bInterfaceNumber: '00' }); // interfaces have no ids
        assert.deepStrictEqual((0, xheep_1.usbDevices)(sysfs), [{ vid: '0403', pid: '6011', product: 'Quad RS232-HS', node: '/dev/bus/usb/001/015' }]);
        assert.strictEqual((0, xheep_1.udevRule)('0403', '6011'), 'ATTRS{idVendor}=="0403", ATTRS{idProduct}=="6011", MODE="666", GROUP="plugdev"');
    });
});
suite('JTAG adapter', () => {
    const labels = (as) => as.map(a => a.label);
    const plugged = (...ids) => (usb) => ids.includes(usb);
    test('only the adapters that fit the board and the bitstream', () => {
        assert.deepStrictEqual(labels((0, xheep_1.boardAdapters)('pynq-z2')), ['EPFL Programmer', 'On-board USB (BSCAN)', 'Digilent JTAG-HS2']);
        assert.deepStrictEqual(labels((0, xheep_1.boardAdapters)('aup-zu3')), ['EPFL Programmer', 'Digilent JTAG-HS2']);
        assert.deepStrictEqual(labels((0, xheep_1.boardAdapters)('pynq-z2', true)), ['On-board USB (BSCAN)']);
        assert.deepStrictEqual(labels((0, xheep_1.boardAdapters)('pynq-z2', false)), ['EPFL Programmer', 'Digilent JTAG-HS2']);
    });
    test('the one plugged in, the on-board USB only when no external adapter is', () => {
        const pynq = (0, xheep_1.boardAdapters)('pynq-z2');
        assert.strictEqual((0, xheep_1.pickAdapter)(pynq, plugged('0403:6011', '0403:6010')).adapter?.label, 'EPFL Programmer');
        assert.strictEqual((0, xheep_1.pickAdapter)(pynq, plugged('0403:6010')).adapter?.label, 'On-board USB (BSCAN)');
        assert.deepStrictEqual(labels((0, xheep_1.pickAdapter)(pynq, plugged('0403:6011', '0403:6014', '0403:6010')).choices), ['EPFL Programmer', 'Digilent JTAG-HS2']);
        assert.deepStrictEqual(labels((0, xheep_1.pickAdapter)(pynq, plugged()).choices), ['EPFL Programmer', 'On-board USB (BSCAN)', 'Digilent JTAG-HS2']);
        // A BSCAN bitstream leaves a single candidate: used even if not seen, OpenOCD then tells.
        assert.strictEqual((0, xheep_1.pickAdapter)((0, xheep_1.boardAdapters)('pynq-z2', true), plugged()).adapter?.label, 'On-board USB (BSCAN)');
    });
});
suite('Updating X-HEEP', () => {
    test('lists the changed files, generated ones apart', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xheep-'));
        fs.mkdirSync(path.join(dir, 'hw'));
        fs.writeFileSync(path.join(dir, 'hw', 'top.sv.tpl'), '');
        const files = (0, xheep_1.changedFiles)(' M hw/top.sv\nM  configs/general.py\nR  a.c -> b.c\n');
        assert.deepStrictEqual(files, ['hw/top.sv', 'configs/general.py', 'b.c']);
        assert.deepStrictEqual(files.filter(f => (0, xheep_1.isGenerated)(dir, f)), ['hw/top.sv']);
    });
    test('restores generated files, then fetches the ref shallow', () => {
        assert.strictEqual((0, xheep_1.updateCommand)('main'), 'git fetch -q --depth 1 origin main && git checkout -q FETCH_HEAD');
        assert.strictEqual((0, xheep_1.updateCommand)('abc', ['hw/top.sv']), "git checkout -q -- 'hw/top.sv' && git fetch -q --depth 1 origin abc && git checkout -q FETCH_HEAD");
    });
});
suite('Tool discovery', () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const tools = require('../tools');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xheep-tools-'));
    const exe = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); fs.chmodSync(p, 0o755); };
    test('finds executables in globbed install dirs', () => {
        exe(path.join(tmp, 'tools', 'verilator', 'v5', 'bin', 'verilator'));
        fs.writeFileSync(path.join(tmp, 'tools', 'verilator', 'v5', 'bin', 'picocom'), ''); // not executable
        assert.deepStrictEqual(tools.findExecutables('verilator', [`${tmp}/tools/*/*/bin`]), [path.join(tmp, 'tools', 'verilator', 'v5', 'bin', 'verilator')]);
        assert.deepStrictEqual(tools.findExecutables('picocom', [`${tmp}/tools/*/*/bin`]), []);
    });
    test('finds toolchains and conda envs with fusesoc', () => {
        exe(path.join(tmp, 'riscv', 'bin', 'riscv32-corev-elf-gcc'));
        assert.deepStrictEqual(tools.findToolchains([`${tmp}/*`]), [path.join(tmp, 'riscv')]);
        exe(path.join(tmp, 'mf', 'bin', 'conda'));
        exe(path.join(tmp, 'mf', 'envs', 'x-heep', 'bin', 'fusesoc'));
        fs.mkdirSync(path.join(tmp, 'mf', 'envs', 'other'), { recursive: true });
        const envs = tools.findPythonEnvs(path.join(tmp, 'nope'), [path.join(tmp, 'mf')]);
        assert.deepStrictEqual(envs.map(e => e.setup), [tools.condaSetup(path.join(tmp, 'mf', 'bin', 'conda'), 'x-heep')]);
    });
    test('picks the Embecosm toolchain for the platform', () => {
        assert.ok(tools.toolchainUrl('darwin', 'arm64').endsWith('corev-gcc-macos-arm64/8/artifact/corev-openhw-gcc-macos-20240530.dmg'));
        assert.ok(tools.toolchainUrl('linux', 'x64', 'ID=ubuntu\nVERSION_ID="20.04"\n').includes('ubuntu2004-20240530.tar.gz'));
        assert.ok(tools.toolchainUrl('linux', 'x64', 'ID="rocky"\nVERSION_ID="9.3"\n').includes('corev-gcc-rocky9/48/'));
        assert.ok(tools.toolchainUrl('linux', 'x64', 'ID=debian\nVERSION_ID="12"\n').includes('ubuntu2204-20240530.tar.gz'));
        assert.strictEqual(tools.toolchainUrl('linux', 'arm64', ''), undefined);
        assert.ok(tools.toolchainInstallCommand('https://x/t.dmg', '/d').includes('hdiutil attach'));
        assert.ok(tools.toolchainInstallCommand('https://x/t.tar.gz', '/d').includes("tar -xz -C '/d' --strip-components=1"));
    });
    test('Verilator is built as in the X-HEEP setup guide, at the version X-HEEP uses', () => {
        fs.mkdirSync(path.join(tmp, 'xh', 'util', 'docker'), { recursive: true });
        fs.writeFileSync(path.join(tmp, 'xh', 'util', 'docker', 'dockerfile'), 'ARG riscv=/tools/riscv\nARG verilator_version=v5.042\n');
        assert.strictEqual(tools.xheepVerilatorVersion(path.join(tmp, 'xh')), '5.042');
        assert.strictEqual(tools.xheepVerilatorVersion(path.join(tmp, 'none')), '5.040');
        const cmd = tools.verilatorInstallCommand('5.042');
        assert.ok(cmd.includes('--branch v5.042 https://github.com/verilator/verilator.git'));
        assert.ok(cmd.includes(`./configure --prefix='${path.join(os.homedir(), 'tools', 'verilator', '5.042')}'`));
        assert.ok(cmd.includes('autoconf') && cmd.includes('make install'));
    });
    test('dev container runs the X-HEEP image with this extension', () => {
        fs.writeFileSync(path.join(tmp, 'xh', 'core-v-mini-mcu.core'), 'CAPI=2:\n\nname: openhwgroup.org:systems:core-v-mini-mcu:1.0.6\n');
        assert.strictEqual(tools.xheepImageTag(path.join(tmp, 'xh')), 'v1.0.6');
        assert.strictEqual(tools.xheepImageTag(path.join(tmp, 'none')), 'latest');
        const dc = JSON.parse(tools.devcontainerJson('me.ext', 'v1.0.6'));
        assert.strictEqual(dc.image, 'ghcr.io/x-heep/x-heep/x-heep-toolchain:v1.0.6');
        assert.deepStrictEqual(dc.customizations.vscode.extensions, ['me.ext']);
    });
});
suite('Hardware development', () => {
    test('model build errors and own warnings reach the Problems panel', () => {
        const log = [
            "%Warning-WIDTHTRUNC: ../../../hw/ip/my/my.sv:2:12: Operator ASSIGNW expects 2 bits",
            "%Warning-UNUSED: ../../../hw/vendor/ip/x.sv:5:3: Signal is not used: 'a'",
            "ERROR: %Error: /x/hw/ip/my/my.sv:3:10: syntax error, unexpected '='",
            '%Error: Exiting due to 1 error(s)',
            "** Error: ../../../hw/ip/my/my.sv(7): (vlog-2730) Undefined variable: 'z'.",
            "** Error: (vlog-13069) ../../../hw/ip/my/my.sv(9): near \"endmodule\": syntax error.",
        ].join('\n');
        const problems = (0, xheep_1.hdlProblems)(log, '/x/build/core/sim-verilator', f => !f.startsWith('/x/hw/vendor/'));
        assert.deepStrictEqual(problems, [
            { file: '/x/hw/ip/my/my.sv', line: 2, column: 12, severity: 'warning', message: 'Operator ASSIGNW expects 2 bits' },
            { file: '/x/hw/ip/my/my.sv', line: 3, column: 10, severity: 'error', message: "syntax error, unexpected '='" },
            { file: '/x/hw/ip/my/my.sv', line: 7, column: undefined, severity: 'error', message: "Undefined variable: 'z'." },
            { file: '/x/hw/ip/my/my.sv', line: 9, column: undefined, severity: 'error', message: 'near "endmodule": syntax error.' },
        ]);
    });
    test('verible file list from the Verilator .vc', () => {
        const vc = '--Mdir .\n--cc\n+incdir+../../../tb\n-CFLAGS -I../../../tb\n../../../hw/a.vlt\n../../../hw/a.sv\n/abs/b.svh\n-Wno-fatal\n';
        assert.strictEqual((0, xheep_1.veribleFileList)(vc, '/x/build/core/sim-verilator'), '+incdir+/x/tb\n/x/hw/a.sv\n/abs/b.svh\n');
    });
    test('reads what X-HEEP formats and what its app test leaves out', () => {
        assert.deepStrictEqual((0, xheep_1.formattedDirs)("#!/bin/bash\nfind hw/ip tb -name '*.sv*' | xargs verible-verilog-format --inplace\n"), ['hw/ip', 'tb']);
        const cfg = (0, xheep_1.appTestConfig)('SIM_TIMEOUT_S = 120\n\nBLACKLIST = [\n    "example_spi_read",\n    "coremark",  # Times out\n]\n');
        assert.deepStrictEqual([...cfg.skip], [['example_spi_read', "left out by X-HEEP's app test"], ['coremark', 'Times out']]);
        assert.strictEqual(cfg.timeoutS, 120);
    });
});
suite('Hardware project', () => {
    test('renames gr-heep in each spelling', () => {
        assert.strictEqual((0, xheep_1.renameGrHeep)('module gr_heep; // GR-HEEP\nname: x-heep:systems:gr-heep\n#ifndef GR_HEEP_H', 'my-chip'), 'module my_chip; // MY-CHIP\nname: x-heep:systems:my-chip\n#ifndef MY_CHIP_H');
        assert.strictEqual((0, xheep_1.renameGrHeep)('hw/gr-heep/gr_heep_pkg.sv.tpl', 'soc'), 'hw/soc/soc_pkg.sv.tpl');
    });
    test('takes names that make SystemVerilog identifiers', () => {
        assert.deepStrictEqual(['my-chip', 'soc2', 'a_b', 'My-chip', '2soc', 'my--chip', 'my-', 'x-heep', 'my chip'].map(xheep_1.isHwProjectName), [true, true, true, false, false, false, false, false, false]);
    });
});
suite('X-ALP', () => {
    const xalp = { ...base, linker: 'spm' };
    test('told apart from X-HEEP, which it vendors the generator of', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xalp-'));
        fs.mkdirSync(path.join(dir, 'util', 'xheep_gen'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'util', 'xheep_gen', 'mcu_gen.py'), '');
        assert.strictEqual((0, soc_1.socOf)(dir), undefined);
        fs.writeFileSync(path.join(dir, 'xalp.core'), '');
        assert.strictEqual((0, soc_1.socOf)(dir)?.id, 'x-alp');
        fs.rmSync(path.join(dir, 'xalp.core'));
        fs.mkdirSync(path.join(dir, 'hw', 'core-v-mini-mcu'), { recursive: true });
        assert.strictEqual((0, soc_1.socOf)(dir)?.id, 'x-heep');
    });
    test('apps link into the memory chosen, with its own -mabi=lp64d flags', () => {
        assert.strictEqual((0, xheep_1.buildCommand)({ ...xalp, linker: 'dram', source: '../../sw' }), 'env -u ARCH -u COMPILER_PREFIX make app PROJECT=hello_world TARGET=sim LINKER=dram COMPILER=gcc SOURCE=../../sw');
        assert.strictEqual((0, xheep_1.linkerScript)(xalp), 'spm.ld');
        assert.strictEqual((0, xheep_1.linkerScript)(base), 'link.ld');
    });
    test('mcu-gen takes the configuration as X_ALP_CFG', () => {
        assert.strictEqual((0, xheep_1.mcuGenCommand)('/p/configs/soc.py', 'x-alp'), "make mcu-gen X_ALP_CFG='/p/configs/soc.py'");
    });
    test('the model is built with the configuration and without formatting the repo', () => {
        assert.ok((0, xheep_1.simModelBuildCommand)('verilator', '/p/c.py').includes("make -o format verilator-build X_ALP_CFG='/p/c.py'"));
        assert.ok((0, xheep_1.isCoreBuildDir)('x-heep_x-alp_x-alp_0.0.1') && (0, xheep_1.isCoreBuildDir)('openhwgroup.org_systems_core-v-mini-mcu_1.0.6') && !(0, xheep_1.isCoreBuildDir)('debug'));
    });
    test('the model loads the ELF named after its memory and exits with the app\'s code', () => {
        assert.strictEqual((0, xheep_1.verilatorRunCommand)('/m', 'dram'), "cd '/m' && ./Vtestharness +BINARY=../../../sw/build/main.dram.elf +BOOTMODE=force --trace=false --no_err=false");
        const out = '[ OK! ] Exit code: 0\n\n  Executed:          66524 cycles\n';
        assert.deepStrictEqual((0, xheep_1.simSummary)(out), { ok: true, text: 'exit 0 · 66524 cycles' });
        assert.deepStrictEqual((0, xheep_1.simSummary)('\x1b[1;33m[WARN ]\x1b[0m Exit code: 3\n'), { ok: false, text: 'exit 3' });
    });
    test('debugging builds a JTAG DPI model and boots it over JTAG', () => {
        const cmd = (0, xheep_1.debugModelBuildCommand)('x-alp');
        assert.ok(cmd.includes('--build-root build/debug --build x-heep:x-alp:x-alp:0.0.1 --USE_JTAG_DPI'));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xalp-'));
        assert.strictEqual((0, child_process_1.spawnSync)('/bin/bash', ['-c', cmd.replace(/\{ if \[.*?tee buildsim.log; \}/, 'true')], { cwd: dir }).status, 1);
        assert.strictEqual((0, xheep_1.debugSimCommand)('/m', '/x/sw/build/main.spm.elf', 'spm'), "cd '/m' && ./Vtestharness +openOCD=true +BOOTMODE=jtag +BINARY='/x/sw/build/main.spm.elf' --trace=false");
        // main returns into crt0, with the exit code in a0; _exit is only linked when the app calls exit().
        assert.ok((0, xheep_1.gdbRunCommand)('gdb', 'e', soc_1.SOCS['x-alp'].exitSymbol).includes("-ex 'break *_crt_return' -ex continue"));
    });
    test('paths make or CMake cannot build in are caught before the build', () => {
        assert.deepStrictEqual((0, xheep_1.unbuildablePathChars)('/Users/me/Desktop/prova?2/sw'), ['?']);
        assert.deepStrictEqual((0, xheep_1.unbuildablePathChars)('/Users/me/My Projects/a+b'), [' ', '+']);
        assert.deepStrictEqual((0, xheep_1.unbuildablePathChars)('/home/me/x-heep_proj.v2/sw'), []);
    });
    test('new projects and apps', () => {
        assert.ok((0, xheep_1.cloneCommand)('https://x', undefined, 'x-alp').includes('git submodule add --progress --depth 1 https://x x-alp'));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xalp-'));
        (0, xheep_1.writeMain)(dir, 'hi', 'x-alp');
        assert.ok(fs.readFileSync(path.join(dir, 'main.c'), 'utf8').startsWith('#include "printf.h"\n'), 'X-ALP printf is its own');
    });
});
//# sourceMappingURL=extension.test.js.map