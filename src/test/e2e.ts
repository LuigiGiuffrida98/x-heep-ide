// End-to-end check against a real X-HEEP (or X-ALP with XHEEP_SOC=x-alp): runs, in the same order and with the same
// helpers, what the extension does for a software project: clone the platform as a submodule, create an app and a
// platform configuration, mcu-gen, full and incremental build, Verilator model, simulation (X-ALP: from each memory).
// Needs the platform's tools on PATH (CI uses the x-heep-toolchain image). Usage: node out/test/e2e.js [workdir]
import * as assert from 'assert';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	Options, cloneCommand, writeMain, projectSource, configTemplate, mcuGenCommand, buildCommand,
	incrementalBuildCommand, simModelBuildCommand, verilatorRunCommand, simSummary, isCoreBuildDir,
} from '../xheep';
import { SOCS, SocId, socOf } from '../soc';

const soc = SOCS[(process.env.XHEEP_SOC ?? 'x-heep') as SocId];
assert.ok(soc, `unknown XHEEP_SOC ${process.env.XHEEP_SOC}`);
const project = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), `${soc.id}-e2e-`)));
const xheep = path.join(project, soc.id);
const sw = path.join(project, 'sw');
const app = 'e2e_app';
// As the extension's tasks: every build also writes compile_commands.json for IntelliSense.
const env = { ...process.env, CMAKE_EXPORT_COMPILE_COMMANDS: 'ON' };
// Only app builds run parallel, as in the extension: X-ALP's boot ROM (built by mcu-gen) breaks with -j.
const parallel = { MAKEFLAGS: `-j${os.cpus().length}` };

function run(cmd: string, cwd: string, capture = false, extra = {}): string {
	console.log(`\n::group::$ ${cmd}`);
	try {
		return execSync(cmd, { cwd, env: { ...env, ...extra }, shell: '/bin/bash', encoding: 'utf8', maxBuffer: 1 << 28, stdio: capture ? 'pipe' : 'inherit' }) ?? '';
	} finally {
		console.log('::endgroup::');
	}
}

fs.mkdirSync(project, { recursive: true });
console.log(`Project: ${project} (${soc.name})`);

// XHEEP_COMMIT: the commit to test (the pinned one in CI, the platform's latest main in the canary).
const commit = process.env.XHEEP_COMMIT || undefined;
run(cloneCommand(process.env.XHEEP_URL ?? soc.git, commit, soc.id), project);
assert.strictEqual(socOf(xheep), soc, `${soc.name} was not cloned into ${soc.id}/`);
if (commit) {
	assert.strictEqual(run('git rev-parse HEAD', xheep, true).trim(), commit, `${soc.id}/ is not at the requested commit`);
}

writeMain(path.join(sw, 'applications', app), app, soc.id);
const config = path.join(project, 'configs', 'e2e.py');
fs.mkdirSync(path.dirname(config), { recursive: true });
fs.writeFileSync(config, configTemplate(xheep, 'e2e', soc.defaultConfig));

run(mcuGenCommand(config, soc.id), xheep);

// X-HEEP runs from on-chip RAM; X-ALP from each memory it links into.
for (const linker of soc.linkers ?? [undefined]) {
	const o: Options = { project: app, mode: 'sim', compiler: 'gcc', board: 'pynq-z2', simulator: 'verilator', source: projectSource(xheep, sw), linker };
	run(buildCommand(o), xheep, false, parallel);
	const build = path.join(xheep, 'sw', 'build');
	const firmware = linker ? `main.${linker}.elf` : 'main.hex';
	assert.ok(fs.existsSync(path.join(build, firmware)), `make app did not produce ${firmware}`);
	assert.ok(fs.readFileSync(path.join(build, 'compile_commands.json'), 'utf8').includes(`applications/${app}/main.c`),
		'compile_commands.json does not list the app');

	fs.utimesSync(path.join(sw, 'applications', app, 'main.c'), new Date(), new Date());
	run(incrementalBuildCommand(os.cpus().length), xheep);

	// X-ALP has no build/ before its first model build.
	const models = fs.existsSync(path.join(xheep, 'build')) ? fs.readdirSync(path.join(xheep, 'build')) : [];
	if (!models.some(d => isCoreBuildDir(d) && fs.existsSync(path.join(xheep, 'build', d, 'sim-verilator', 'Vtestharness')))) {
		run(simModelBuildCommand('verilator', linker && config), xheep);
	}
	const core = fs.readdirSync(path.join(xheep, 'build')).find(isCoreBuildDir);
	assert.ok(core, 'no fusesoc build directory');
	const simDir = path.join(xheep, 'build', core, 'sim-verilator');
	const out = run(verilatorRunCommand(simDir, linker), xheep, true);
	console.log(out);
	const summary = simSummary(out);
	assert.ok(summary.ok, `simulation${linker ? ` (${linker})` : ''}: ${summary.text}`);
	const uart = fs.readFileSync(path.join(simDir, 'uart0.log'), 'utf8');
	assert.ok(uart.includes(`Hello from ${app}!`), `unexpected UART output: ${uart}`);
	console.log(`\nE2E OK${linker ? ` (${linker})` : ''}: ${summary.text}, UART: ${uart.trim()}`);
}
