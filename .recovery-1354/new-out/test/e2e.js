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
// End-to-end check against a real X-HEEP (or X-ALP with XHEEP_SOC=x-alp): runs, in the same order and with the same
// helpers, what the extension does for a software project: clone the platform as a submodule, create an app and a
// platform configuration, mcu-gen, full and incremental build, Verilator model, simulation (X-ALP: from each memory).
// Needs the platform's tools on PATH (CI uses the x-heep-toolchain image). Usage: node out/test/e2e.js [workdir]
const assert = __importStar(require("assert"));
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const xheep_1 = require("../xheep");
const soc_1 = require("../soc");
const soc = soc_1.SOCS[(process.env.XHEEP_SOC ?? 'x-heep')];
assert.ok(soc, `unknown XHEEP_SOC ${process.env.XHEEP_SOC}`);
const project = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), `${soc.id}-e2e-`)));
const xheep = path.join(project, soc.id);
const sw = path.join(project, 'sw');
const app = 'e2e_app';
// As the extension's tasks: every build also writes compile_commands.json for IntelliSense.
const env = { ...process.env, CMAKE_EXPORT_COMPILE_COMMANDS: 'ON' };
// Only app builds run parallel, as in the extension: X-ALP's boot ROM (built by mcu-gen) breaks with -j.
const parallel = { MAKEFLAGS: `-j${os.cpus().length}` };
function run(cmd, cwd, capture = false, extra = {}) {
    console.log(`\n::group::$ ${cmd}`);
    try {
        return (0, child_process_1.execSync)(cmd, { cwd, env: { ...env, ...extra }, shell: '/bin/bash', encoding: 'utf8', maxBuffer: 1 << 28, stdio: capture ? 'pipe' : 'inherit' }) ?? '';
    }
    finally {
        console.log('::endgroup::');
    }
}
fs.mkdirSync(project, { recursive: true });
console.log(`Project: ${project} (${soc.name})`);
// XHEEP_COMMIT: the commit to test (the pinned one in CI, the platform's latest main in the canary).
const commit = process.env.XHEEP_COMMIT || undefined;
run((0, xheep_1.cloneCommand)(process.env.XHEEP_URL ?? soc.git, commit, soc.id), project);
assert.strictEqual((0, soc_1.socOf)(xheep), soc, `${soc.name} was not cloned into ${soc.id}/`);
if (commit) {
    assert.strictEqual(run('git rev-parse HEAD', xheep, true).trim(), commit, `${soc.id}/ is not at the requested commit`);
}
(0, xheep_1.writeMain)(path.join(sw, 'applications', app), app, soc.id);
const config = path.join(project, 'configs', 'e2e.py');
fs.mkdirSync(path.dirname(config), { recursive: true });
fs.writeFileSync(config, (0, xheep_1.configTemplate)(xheep, 'e2e', soc.defaultConfig));
run((0, xheep_1.mcuGenCommand)(config, soc.id), xheep);
// X-HEEP runs from on-chip RAM; X-ALP from each memory it links into.
for (const linker of soc.linkers ?? [undefined]) {
    const o = { project: app, mode: 'sim', compiler: 'gcc', board: 'pynq-z2', simulator: 'verilator', source: (0, xheep_1.projectSource)(xheep, sw), linker };
    run((0, xheep_1.buildCommand)(o), xheep, false, parallel);
    const build = path.join(xheep, 'sw', 'build');
    const firmware = linker ? `main.${linker}.elf` : 'main.hex';
    assert.ok(fs.existsSync(path.join(build, firmware)), `make app did not produce ${firmware}`);
    assert.ok(fs.readFileSync(path.join(build, 'compile_commands.json'), 'utf8').includes(`applications/${app}/main.c`), 'compile_commands.json does not list the app');
    fs.utimesSync(path.join(sw, 'applications', app, 'main.c'), new Date(), new Date());
    run((0, xheep_1.incrementalBuildCommand)(os.cpus().length), xheep);
    // X-ALP has no build/ before its first model build.
    const models = fs.existsSync(path.join(xheep, 'build')) ? fs.readdirSync(path.join(xheep, 'build')) : [];
    if (!models.some(d => (0, xheep_1.isCoreBuildDir)(d) && fs.existsSync(path.join(xheep, 'build', d, 'sim-verilator', 'Vtestharness')))) {
        run((0, xheep_1.simModelBuildCommand)('verilator', linker && soc.generated), xheep);
    }
    const core = fs.readdirSync(path.join(xheep, 'build')).find(xheep_1.isCoreBuildDir);
    assert.ok(core, 'no fusesoc build directory');
    const simDir = path.join(xheep, 'build', core, 'sim-verilator');
    const out = run((0, xheep_1.verilatorRunCommand)(simDir, linker), xheep, true);
    console.log(out);
    const summary = (0, xheep_1.simSummary)(out);
    assert.ok(summary.ok, `simulation${linker ? ` (${linker})` : ''}: ${summary.text}`);
    const uart = fs.readFileSync(path.join(simDir, 'uart0.log'), 'utf8');
    assert.ok(uart.includes(`Hello from ${app}!`), `unexpected UART output: ${uart}`);
    console.log(`\nE2E OK${linker ? ` (${linker})` : ''}: ${summary.text}, UART: ${uart.trim()}`);
}
//# sourceMappingURL=e2e.js.map