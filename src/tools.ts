// Finds the tools X-HEEP needs (Python env, RISC-V toolchain, Verilator, OpenOCD, picocom) in the usual
// install locations, and the commands that install them. Free of the vscode API so it can be unit tested.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HOME = os.homedir();

/** Expands `*` path segments (e.g. ~/tools/*\/bin) against the file system. */
export function expand(pattern: string): string[] {
	return pattern.split('/').reduce<string[]>((bases, seg, i) => {
		if (i === 0) {
			return [seg || '/'];
		}
		return bases.flatMap(b => seg !== '*' ? [path.join(b, seg)]
			: fs.existsSync(b) && fs.statSync(b).isDirectory() ? fs.readdirSync(b).map(e => path.join(b, e)) : []);
	}, []).filter(p => fs.existsSync(p));
}

const isExecutable = (p: string) => {
	try {
		fs.accessSync(p, fs.constants.X_OK);
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
};

/** Drops paths that resolve to the same file, keeping the first spelling. */
const unique = (paths: string[]) => [...new Map(paths.reverse().map(p => [fs.realpathSync(p), p])).values()].reverse();

/** Where package managers and hand installs (like the X-HEEP docker image's /tools) put binaries. */
export const BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', `${HOME}/.local/bin`,
	`${HOME}/tools/*/bin`, `${HOME}/tools/*/*/bin`, '/tools/*/bin', '/tools/*/*/bin', '/opt/*/bin'];

export function findExecutables(name: string, dirs = BIN_DIRS): string[] {
	return unique(dirs.flatMap(expand).map(d => path.join(d, name)).filter(isExecutable));
}

/** Install dirs (RISCV_XHEEP) holding a bin/*-elf-gcc. */
export function findToolchains(candidates = [process.env.RISCV_XHEEP, process.env.RISCV, `${HOME}/.riscv`,
	`${HOME}/tools/*`, '/opt/riscv', '/opt/*', '/tools/riscv', '/tools/*'].filter((c): c is string => !!c)): string[] {
	return unique(candidates.flatMap(expand).filter(d => {
		const bin = path.join(d, 'bin');
		return fs.existsSync(bin) && fs.readdirSync(bin).some(f => f.endsWith('-elf-gcc'));
	}));
}

const CONDA_BASES = [process.env.CONDA_EXE && path.dirname(path.dirname(process.env.CONDA_EXE)),
	`${HOME}/miniconda3`, `${HOME}/miniforge3`, `${HOME}/mambaforge`, `${HOME}/anaconda3`,
	'/opt/conda', '/opt/miniconda3', '/opt/homebrew/Caskroom/miniforge/base'].filter((c): c is string => !!c);

export function findConda(bases = CONDA_BASES): string | undefined {
	return bases.map(b => path.join(b, 'bin', 'conda')).find(isExecutable);
}

export const condaSetup = (conda: string, env: string) => `eval "$('${conda}' shell.bash hook)" && conda activate ${env}`;
export const venvSetup = (venv: string) => `source '${path.join(venv, 'bin', 'activate')}'`;

/** Python environments with fusesoc, as `xheep.envSetup` snippets: conda envs, then X-HEEP's own .venv. */
export function findPythonEnvs(xheep: string, bases = CONDA_BASES): { label: string; setup: string }[] {
	// CONDA_EXE usually points to one of the default bases: count each install once.
	const conda = unique(bases.filter(b => fs.existsSync(b))).flatMap(base => {
		const exe = path.join(base, 'bin', 'conda');
		return isExecutable(exe) ? expand(path.join(base, 'envs', '*'))
			.filter(env => isExecutable(path.join(env, 'bin', 'fusesoc')))
			.map(env => ({ label: `conda env "${path.basename(env)}" (${base})`, setup: condaSetup(exe, path.basename(env)) })) : [];
	});
	const venv = path.join(xheep, '.venv');
	return [...conda, ...(isExecutable(path.join(venv, 'bin', 'fusesoc')) ? [{ label: `X-HEEP virtualenv (${venv})`, setup: venvSetup(venv) }] : [])];
}

const EMBECOSM = 'https://buildbot.embecosm.com/job';

/** Embecosm's prebuilt CORE-V GCC 20240530 for this machine, the toolchain X-HEEP documents. */
export function toolchainUrl(platform = process.platform, arch = process.arch,
	osRelease = fs.existsSync('/etc/os-release') ? fs.readFileSync('/etc/os-release', 'utf8') : ''): string | undefined {
	if (platform === 'darwin') {
		return arch === 'arm64'
			? `${EMBECOSM}/corev-gcc-macos-arm64/8/artifact/corev-openhw-gcc-macos-20240530.dmg`
			: `${EMBECOSM}/corev-gcc-macos/48/artifact/corev-openhw-gcc-macos-20240530.dmg`;
	}
	if (platform !== 'linux' || arch !== 'x64') {
		return undefined;
	}
	const field = (k: string) => new RegExp(`^${k}="?([^"\n]*)`, 'm').exec(osRelease)?.[1] ?? '';
	const [id, major] = [field('ID'), field('VERSION_ID').split('.')[0]];
	const distro = id === 'ubuntu' && major === '18' ? ['ubuntu1804', 51]
		: id === 'ubuntu' && major === '20' ? ['ubuntu2004', 50]
		: ['rocky', 'rhel', 'almalinux', 'centos'].includes(id) && major === '7' ? ['centos7', 48]
		: ['rocky', 'rhel', 'almalinux', 'centos'].includes(id) && ['8', '9'].includes(major) ? [`rocky${major}`, 48]
		: ['ubuntu2204', 47]; // newer Ubuntu and Debian
	return `${EMBECOSM}/corev-gcc-${distro[0]}/${distro[1]}/artifact/corev-openhw-gcc-${distro[0]}-20240530.tar.gz`;
}

/** Downloads and unpacks the toolchain into `dest` (macOS: copies it out of the .dmg). */
export function toolchainInstallCommand(url: string, dest: string): string {
	return url.endsWith('.dmg')
		? `d=$(mktemp -d) && curl -fL --progress-bar -o "$d/tc.dmg" '${url}' && hdiutil attach -nobrowse -readonly -mountpoint "$d/mnt" "$d/tc.dmg" `
			+ `&& mkdir -p '${dest}' && cp -R "$d"/mnt/*/. '${dest}/'; s=$?; hdiutil detach "$d/mnt" >/dev/null 2>&1; rm -rf "$d"; exit $s`
		: `mkdir -p '${dest}' && curl -fL --progress-bar '${url}' | tar -xz -C '${dest}' --strip-components=1`;
}

/** The Verilator version X-HEEP uses, from its docker image definition (the docs pin the same one). */
export function xheepVerilatorVersion(xheep: string): string {
	const dockerfile = path.join(xheep, 'util', 'docker', 'dockerfile');
	const m = fs.existsSync(dockerfile) ? /^ARG verilator_version=v?(\S+)/m.exec(fs.readFileSync(dockerfile, 'utf8')) : null;
	return m?.[1] ?? '5.040';
}

/** Where X-HEEP's setup guide installs Verilator. */
export const verilatorPrefix = (version: string) => path.join(HOME, 'tools', 'verilator', version);

/** X-HEEP's setup guide (GettingStarted/Setup.md, "Install Verilator"): build the tagged release from source. */
export function verilatorInstallCommand(version: string): string {
	return `d=$(mktemp -d) && git clone --depth 1 --branch v${version} https://github.com/verilator/verilator.git "$d/verilator" && cd "$d/verilator" `
		+ `&& autoconf && ./configure --prefix='${verilatorPrefix(version)}' && make -j"$(getconf _NPROCESSORS_ONLN)" && make install; `
		+ 's=$?; rm -rf "$d"; exit $s';
}

/** Where X-HEEP's setup guide installs verible. */
export const veriblePrefix = (version: string) => path.join(HOME, 'tools', 'verible', version);

/** Downloads verible's static Linux release into veriblePrefix, as X-HEEP's setup guide does. */
export function veribleInstallCommand(version: string): string {
	const dir = `verible-${version}`;
	return `d=$(mktemp -d) && cd "$d" && wget -q https://github.com/chipsalliance/verible/releases/download/${version}/${dir}-linux-static-x86_64.tar.gz `
		+ `&& tar -xf ${dir}-linux-static-x86_64.tar.gz && mkdir -p '${veriblePrefix(version)}' && cp -r ${dir}/* '${veriblePrefix(version)}/'; `
		+ 's=$?; rm -rf "$d"; exit $s';
}

/** Shell command installing a system tool with the platform's package manager, if there is one. */
export function packageInstallCommand(pkg: string, platform = process.platform, brew = findExecutables('brew')[0]): string | undefined {
	if (platform === 'darwin') {
		return brew ? `'${brew}' install ${pkg}` : undefined;
	}
	return platform === 'linux' && fs.existsSync('/usr/bin/apt-get') ? `sudo apt-get install -y ${pkg}` : undefined;
}

/**
 * Tag of X-HEEP's toolchain image matching a checkout: X-HEEP tags it v<version>, the version in
 * core-v-mini-mcu.core (its CI does the same). `latest` lags behind the releases, so it is only the fallback.
 */
export function xheepImageTag(xheep: string): string {
	const core = path.join(xheep, 'core-v-mini-mcu.core');
	const m = fs.existsSync(core) ? /^name: \S*core-v-mini-mcu:(\S+)/m.exec(fs.readFileSync(core, 'utf8')) : null;
	return m ? `v${m[1]}` : 'latest';
}

/**
 * Dev container on X-HEEP's toolchain image (the one its CI uses), with this extension inside.
 * The image is amd64 only: Apple Silicon runs it emulated, hence the explicit platform.
 */
export function devcontainerJson(extensionId: string, imageTag = 'latest'): string {
	return JSON.stringify({
		name: 'X-HEEP',
		image: `ghcr.io/x-heep/x-heep/x-heep-toolchain:${imageTag}`,
		runArgs: ['--platform=linux/amd64'],
		customizations: {
			vscode: {
				extensions: [extensionId],
				// The image sets up conda and the tools in a login profile script.
				settings: { 'xheep.envSetup': 'source /etc/profile.d/env.sh' },
			},
		},
	}, null, '\t') + '\n';
}
