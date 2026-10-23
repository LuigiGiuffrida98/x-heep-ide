"use strict";
// Finds the tools X-HEEP needs (Python env, RISC-V toolchain, Verilator, OpenOCD, picocom) in the usual
// install locations, and the commands that install them. Free of the vscode API so it can be unit tested.
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
exports.veriblePrefix = exports.verilatorPrefix = exports.venvSetup = exports.condaSetup = exports.BIN_DIRS = void 0;
exports.expand = expand;
exports.findExecutables = findExecutables;
exports.findToolchains = findToolchains;
exports.findConda = findConda;
exports.findPythonEnvs = findPythonEnvs;
exports.toolchainUrl = toolchainUrl;
exports.toolchainInstallCommand = toolchainInstallCommand;
exports.xheepVerilatorVersion = xheepVerilatorVersion;
exports.verilatorInstallCommand = verilatorInstallCommand;
exports.veribleInstallCommand = veribleInstallCommand;
exports.packageInstallCommand = packageInstallCommand;
exports.xheepImageTag = xheepImageTag;
exports.devcontainerJson = devcontainerJson;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const HOME = os.homedir();
/** Expands `*` path segments (e.g. ~/tools/*\/bin) against the file system. */
function expand(pattern) {
    return pattern.split('/').reduce((bases, seg, i) => {
        if (i === 0) {
            return [seg || '/'];
        }
        return bases.flatMap(b => seg !== '*' ? [path.join(b, seg)]
            : fs.existsSync(b) && fs.statSync(b).isDirectory() ? fs.readdirSync(b).map(e => path.join(b, e)) : []);
    }, []).filter(p => fs.existsSync(p));
}
const isExecutable = (p) => {
    try {
        fs.accessSync(p, fs.constants.X_OK);
        return fs.statSync(p).isFile();
    }
    catch {
        return false;
    }
};
/** Drops paths that resolve to the same file, keeping the first spelling. */
const unique = (paths) => [...new Map(paths.reverse().map(p => [fs.realpathSync(p), p])).values()].reverse();
/** Where package managers and hand installs (like the X-HEEP docker image's /tools) put binaries. */
exports.BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', `${HOME}/.local/bin`,
    `${HOME}/tools/*/bin`, `${HOME}/tools/*/*/bin`, '/tools/*/bin', '/tools/*/*/bin', '/opt/*/bin'];
function findExecutables(name, dirs = exports.BIN_DIRS) {
    return unique(dirs.flatMap(expand).map(d => path.join(d, name)).filter(isExecutable));
}
/** Install dirs (RISCV_XHEEP) holding a bin/*-elf-gcc. */
function findToolchains(candidates = [process.env.RISCV_XHEEP, process.env.RISCV, `${HOME}/.riscv`,
    `${HOME}/tools/*`, '/opt/riscv', '/opt/*', '/tools/riscv', '/tools/*'].filter((c) => !!c)) {
    return unique(candidates.flatMap(expand).filter(d => {
        const bin = path.join(d, 'bin');
        return fs.existsSync(bin) && fs.readdirSync(bin).some(f => f.endsWith('-elf-gcc'));
    }));
}
const CONDA_BASES = [process.env.CONDA_EXE && path.dirname(path.dirname(process.env.CONDA_EXE)),
    `${HOME}/miniconda3`, `${HOME}/miniforge3`, `${HOME}/mambaforge`, `${HOME}/anaconda3`,
    '/opt/conda', '/opt/miniconda3', '/opt/homebrew/Caskroom/miniforge/base'].filter((c) => !!c);
function findConda(bases = CONDA_BASES) {
    return bases.map(b => path.join(b, 'bin', 'conda')).find(isExecutable);
}
const condaSetup = (conda, env) => `eval "$('${conda}' shell.bash hook)" && conda activate ${env}`;
exports.condaSetup = condaSetup;
const venvSetup = (venv) => `source '${path.join(venv, 'bin', 'activate')}'`;
exports.venvSetup = venvSetup;
/** Python environments with fusesoc, as `xheep.envSetup` snippets: conda envs, then X-HEEP's own .venv. */
function findPythonEnvs(xheep, bases = CONDA_BASES) {
    // CONDA_EXE usually points to one of the default bases: count each install once.
    const conda = unique(bases.filter(b => fs.existsSync(b))).flatMap(base => {
        const exe = path.join(base, 'bin', 'conda');
        return isExecutable(exe) ? expand(path.join(base, 'envs', '*'))
            .filter(env => isExecutable(path.join(env, 'bin', 'fusesoc')))
            .map(env => ({ label: `conda env "${path.basename(env)}" (${base})`, setup: (0, exports.condaSetup)(exe, path.basename(env)) })) : [];
    });
    const venv = path.join(xheep, '.venv');
    return [...conda, ...(isExecutable(path.join(venv, 'bin', 'fusesoc')) ? [{ label: `X-HEEP virtualenv (${venv})`, setup: (0, exports.venvSetup)(venv) }] : [])];
}
const EMBECOSM = 'https://buildbot.embecosm.com/job';
/** Embecosm's prebuilt CORE-V GCC 20240530 for this machine, the toolchain X-HEEP documents. */
function toolchainUrl(platform = process.platform, arch = process.arch, osRelease = fs.existsSync('/etc/os-release') ? fs.readFileSync('/etc/os-release', 'utf8') : '') {
    if (platform === 'darwin') {
        return arch === 'arm64'
            ? `${EMBECOSM}/corev-gcc-macos-arm64/8/artifact/corev-openhw-gcc-macos-20240530.dmg`
            : `${EMBECOSM}/corev-gcc-macos/48/artifact/corev-openhw-gcc-macos-20240530.dmg`;
    }
    if (platform !== 'linux' || arch !== 'x64') {
        return undefined;
    }
    const field = (k) => new RegExp(`^${k}="?([^"\n]*)`, 'm').exec(osRelease)?.[1] ?? '';
    const [id, major] = [field('ID'), field('VERSION_ID').split('.')[0]];
    const distro = id === 'ubuntu' && major === '18' ? ['ubuntu1804', 51]
        : id === 'ubuntu' && major === '20' ? ['ubuntu2004', 50]
            : ['rocky', 'rhel', 'almalinux', 'centos'].includes(id) && major === '7' ? ['centos7', 48]
                : ['rocky', 'rhel', 'almalinux', 'centos'].includes(id) && ['8', '9'].includes(major) ? [`rocky${major}`, 48]
                    : ['ubuntu2204', 47]; // newer Ubuntu and Debian
    return `${EMBECOSM}/corev-gcc-${distro[0]}/${distro[1]}/artifact/corev-openhw-gcc-${distro[0]}-20240530.tar.gz`;
}
/** Downloads and unpacks the toolchain into `dest` (macOS: copies it out of the .dmg). */
function toolchainInstallCommand(url, dest) {
    return url.endsWith('.dmg')
        ? `d=$(mktemp -d) && curl -fL --progress-bar -o "$d/tc.dmg" '${url}' && hdiutil attach -nobrowse -readonly -mountpoint "$d/mnt" "$d/tc.dmg" `
            + `&& mkdir -p '${dest}' && cp -R "$d"/mnt/*/. '${dest}/'; s=$?; hdiutil detach "$d/mnt" >/dev/null 2>&1; rm -rf "$d"; exit $s`
        : `mkdir -p '${dest}' && curl -fL --progress-bar '${url}' | tar -xz -C '${dest}' --strip-components=1`;
}
/** The Verilator version X-HEEP uses, from its docker image definition (the docs pin the same one). */
function xheepVerilatorVersion(xheep) {
    const dockerfile = path.join(xheep, 'util', 'docker', 'dockerfile');
    const m = fs.existsSync(dockerfile) ? /^ARG verilator_version=v?(\S+)/m.exec(fs.readFileSync(dockerfile, 'utf8')) : null;
    return m?.[1] ?? '5.040';
}
/** Where X-HEEP's setup guide installs Verilator. */
const verilatorPrefix = (version) => path.join(HOME, 'tools', 'verilator', version);
exports.verilatorPrefix = verilatorPrefix;
/** X-HEEP's setup guide (GettingStarted/Setup.md, "Install Verilator"): build the tagged release from source. */
function verilatorInstallCommand(version) {
    return `d=$(mktemp -d) && git clone --depth 1 --branch v${version} https://github.com/verilator/verilator.git "$d/verilator" && cd "$d/verilator" `
        + `&& autoconf && ./configure --prefix='${(0, exports.verilatorPrefix)(version)}' && make -j"$(getconf _NPROCESSORS_ONLN)" && make install; `
        + 's=$?; rm -rf "$d"; exit $s';
}
/** Where X-HEEP's setup guide installs verible. */
const veriblePrefix = (version) => path.join(HOME, 'tools', 'verible', version);
exports.veriblePrefix = veriblePrefix;
/** Downloads verible's static Linux release into veriblePrefix, as X-HEEP's setup guide does. */
function veribleInstallCommand(version) {
    const dir = `verible-${version}`;
    return `d=$(mktemp -d) && cd "$d" && wget -q https://github.com/chipsalliance/verible/releases/download/${version}/${dir}-linux-static-x86_64.tar.gz `
        + `&& tar -xf ${dir}-linux-static-x86_64.tar.gz && mkdir -p '${(0, exports.veriblePrefix)(version)}' && cp -r ${dir}/* '${(0, exports.veriblePrefix)(version)}/'; `
        + 's=$?; rm -rf "$d"; exit $s';
}
/** Shell command installing a system tool with the platform's package manager, if there is one. */
function packageInstallCommand(pkg, platform = process.platform, brew = findExecutables('brew')[0]) {
    if (platform === 'darwin') {
        return brew ? `'${brew}' install ${pkg}` : undefined;
    }
    return platform === 'linux' && fs.existsSync('/usr/bin/apt-get') ? `sudo apt-get install -y ${pkg}` : undefined;
}
/**
 * Tag of X-HEEP's toolchain image matching a checkout: X-HEEP tags it v<version>, the version in
 * core-v-mini-mcu.core (its CI does the same). `latest` lags behind the releases, so it is only the fallback.
 */
function xheepImageTag(xheep) {
    const core = path.join(xheep, 'core-v-mini-mcu.core');
    const m = fs.existsSync(core) ? /^name: \S*core-v-mini-mcu:(\S+)/m.exec(fs.readFileSync(core, 'utf8')) : null;
    return m ? `v${m[1]}` : 'latest';
}
/**
 * Dev container on X-HEEP's toolchain image (the one its CI uses), with this extension inside.
 * The image is amd64 only: Apple Silicon runs it emulated, hence the explicit platform.
 */
function devcontainerJson(extensionId, imageTag = 'latest') {
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
//# sourceMappingURL=tools.js.map