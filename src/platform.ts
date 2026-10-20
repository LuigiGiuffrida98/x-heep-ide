// The platform editor's model: what X-HEEP's generator reads from a configuration (media/platform.py), the form
// the editor shows, and the Python overlay it writes. Free of the vscode API so the unit tests cover it.
//
// The editor never edits a configuration file: Apply writes a small Python "overlay" that loads the base
// configuration (Python or HJSON) through xheep_gen and changes only what differs in the form.

import { createHash } from 'crypto';
import { SocId } from './soc';

/** What media/platform.py reads from a configuration, as mcu-gen would build it. */
export interface Platform {
	cpu: string;
	fpu: boolean;
	bus: string;
	/** Contiguous RAM banks, in KB. */
	banks: number[];
	interleaved: { num: number; sizeKb: number }[];
	sections: { name: string; start: number; end: number | null }[];
	stack: number;
	heap: number;
	userPeripherals: string[];
}

/** Where everything is on the platform (media/platform.py map), with the peripherals' registers from regtool. */
export interface AddressMap {
	banks: AddressRange[];
	regions: AddressRange[];
	/** `ip`: the regtool IP a peripheral instantiates, prefix of its <ip>_regs.h defines (e.g. spi_host for spi_flash). */
	domains: (AddressRange & { peripherals: (AddressRange & { ip?: string; registers: Register[] })[] })[];
}

export interface AddressRange { name: string; start: number; length: number }

export interface Register {
	name: string;
	offset: number;
	desc: string;
	access?: string;
	reset?: number;
	/** A memory window (e.g. a FIFO) of this many bytes, not a register. */
	window?: number;
	fields: { name: string; msb: number; lsb: number; access: string; desc: string }[];
}

/** A row of the Memory Map view: `define` is what Copy Address copies, the C expression of `address`. */
export interface MapNode { label: string; description: string; tooltip?: string; address?: number; define?: string; children: MapNode[] }

/** Regions whose define (core_v_mini_mcu.h, X-ALP's core_v_mcu.h) is not named after them. */
const DEFINE_OF: Record<SocId, Record<string, string>> = {
	'x-heep': { ext_slaves: 'EXT_SLAVE', base_peripheral_domain: 'AO_PERIPHERAL', user_peripheral_domain: 'PERIPHERAL' },
	'x-alp': { spm: 'LLC' },
};

export const hexAddress = (n: number) => `0x${n.toString(16).padStart(8, '0')}`;
const size = (bytes: number) => bytes >= 1 << 20 ? `${bytes / (1 << 20)} MB` : bytes >= 1024 ? `${bytes / 1024} KB` : `${bytes} B`;

/** The Memory Map view's tree: RAM, then the address regions in address order, peripherals with registers and fields. */
export function mapNodes(map: AddressMap, soc: SocId = 'x-heep'): MapNode[] {
	const startDefine = (name: string) => `${DEFINE_OF[soc][name] ?? name.toUpperCase()}_START_ADDRESS`;
	const range = (r: AddressRange, children: MapNode[] = []): MapNode =>
		({ label: r.name, description: `${hexAddress(r.start)} · ${size(r.length)}`, address: r.start, define: startDefine(r.name), children });
	const register = (base: number, p: string, ip: string, r: Register): MapNode => ({
		label: r.name,
		description: `${hexAddress(base + r.offset)} · ${r.window ? `window, ${size(r.window)}` : r.access}`,
		tooltip: `${r.desc}${r.reset !== undefined && !r.window ? `\n\nReset: 0x${r.reset.toString(16)}` : ''}`,
		address: base + r.offset,
		define: `${startDefine(p)} + ${ip.toUpperCase()}_${r.name.toUpperCase()}_REG_OFFSET`,
		children: r.fields.map(f => ({ label: f.name, description: `[${f.msb === f.lsb ? f.msb : `${f.msb}:${f.lsb}`}] ${f.access}`, tooltip: f.desc, children: [] })),
	});
	const ram = map.banks.reduce((n, b) => n + b.length, 0);
	return [
		{ label: 'RAM', description: `${hexAddress(map.banks[0]?.start ?? 0)} · ${size(ram)}`, address: map.banks[0]?.start,
			define: map.banks[0] && startDefine(map.banks[0].name), children: map.banks.map(b => range(b)) },
		...[...map.regions.map(r => range(r)),
			...map.domains.map(d => range(d, d.peripherals.map(p => range(p, p.registers.map(r => register(p.start, p.name, p.ip ?? p.name, r))))))]
			.sort((a, b) => a.address! - b.address!),
	];
}

export interface Catalog {
	cpus: string[];
	userPeripherals: { name: string; cls: string; doc: string }[];
}

/** The editor's form. Memory is only editable when the contiguous banks share one size and there is at most one interleaved group. */
export interface PlatformForm {
	cpu: string;
	fpu: boolean;
	bus: string;
	banks: number;
	/** Size of each contiguous bank: a power of two, as xheep_gen requires. */
	bankKb: number;
	codeKb: number;
	ilNum: number;
	ilSizeKb: number;
	stackKb: number;
	heapKb: number;
	peripherals: string[];
}

/** Bank sizes the form offers, contiguous and interleaved (xheep_gen takes any power of two from 1 KB). */
export const BANK_SIZES_KB = [8, 16, 32, 64];
export const FPU_CPUS = ['cv32e40p', 'cv32e40px'];

/** Whether the editor can represent the configuration's memory (else it shows it, and Python keeps it). */
export function plainMemory(p: Platform): boolean {
	return p.banks.every(b => b === p.banks[0] && BANK_SIZES_KB.indexOf(b) >= 0) && p.interleaved.length <= 1;
}

export function formFromPlatform(p: Platform): PlatformForm {
	const code = p.sections.find(s => s.name === 'code');
	return {
		cpu: p.cpu, fpu: p.fpu, bus: p.bus,
		banks: p.banks.length,
		bankKb: p.banks[0] ?? 32,
		codeKb: code?.end ? (code.end - code.start) / 1024 : 0,
		ilNum: p.interleaved[0]?.num ?? 0,
		ilSizeKb: p.interleaved[0]?.sizeKb ?? 16,
		stackKb: p.stack / 1024, heapKb: p.heap / 1024,
		peripherals: [...p.userPeripherals].sort(),
	};
}

/**
 * The hardware a configuration describes: what a bitstream is built from. Code/data split, stack and heap only
 * change the linker script, so a bitstream stays good across them, and across files describing the same hardware.
 */
export function hardwareFingerprint(p: Platform): string {
	const hw = { cpu: p.cpu, fpu: p.fpu, bus: p.bus, banks: p.banks, interleaved: p.interleaved, peripherals: [...p.userPeripherals].sort() };
	return createHash('sha1').update(JSON.stringify(hw)).digest('hex');
}

/** make app ARCH for apps on the platform: with a hardware FPU, apps use it. */
export const archFor = (p: Pick<Platform, 'fpu'>) => p.fpu ? 'rv32imfc_zicsr' : undefined;

/** Form fields that change the hardware (needing a new simulation model and bitstream), not just the linker script. */
export function hardwareChanges(base: PlatformForm, form: PlatformForm): string[] {
	return (['cpu', 'fpu', 'bus', 'banks', 'bankKb', 'ilNum', 'ilSizeKb', 'peripherals'] as const)
		.filter(k => JSON.stringify(base[k]) !== JSON.stringify(form[k]));
}

export function changes(base: PlatformForm, form: PlatformForm): (keyof PlatformForm)[] {
	return (Object.keys(form) as (keyof PlatformForm)[]).filter(k => JSON.stringify(base[k]) !== JSON.stringify(form[k]));
}

/** What would keep mcu-gen or the apps from working, in the user's words. Empty when the form is fine. */
export function formProblems(f: PlatformForm, memoryEditable: boolean): string[] {
	const problems: string[] = [];
	if (FPU_CPUS.indexOf(f.cpu) < 0 && f.fpu) {
		problems.push(`${f.cpu} has no FPU.`);
	}
	if (memoryEditable) {
		const total = f.banks * f.bankKb;
		if (f.codeKb + f.stackKb + f.heapKb >= total) {
			problems.push(`Code, stack and heap (${f.codeKb + f.stackKb + f.heapKb} KB) do not fit in ${total} KB of RAM: add banks or shrink them.`);
		}
		if (f.ilNum && (f.ilNum & (f.ilNum - 1))) {
			problems.push('The number of interleaved banks must be a power of two.');
		}
	}
	return problems;
}

const hex = (n: number) => `0x${n.toString(16)}`;

/** Marks a file the editor owns; its JSON says what the form held, and which base it applies to. */
const HEADER = '# xheep-ide: ';

export interface OverlayHeader { base: string; form: PlatformForm }

/** The editor's header of an overlay, or undefined for a configuration written by hand. */
export function overlayHeader(source: string): OverlayHeader | undefined {
	const line = source.split('\n').find(l => l.startsWith(HEADER));
	try {
		return line ? JSON.parse(line.slice(HEADER.length)) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The overlay configuration for `form` on top of the base at `baseRel` (relative to the overlay's folder), which
 * reads as `base`: only differences are written, so the file stays short and says what was changed.
 */
export function overlayConfig(name: string, baseRel: string, base: PlatformForm, form: PlatformForm, catalog: Catalog, memoryEditable: boolean): string {
	const changed = new Set(changes(base, form));
	const imports = new Set(['from pathlib import PurePath', 'from load_config import load_cfg_file']);
	const body: string[] = [];
	if (changed.has('cpu') || changed.has('fpu')) {
		imports.add(`from cpu.${form.cpu} import ${form.cpu}`);
		body.push(`    system.set_cpu(${form.cpu}(${FPU_CPUS.indexOf(form.cpu) >= 0 && form.fpu ? 'fpu=True' : ''}))`);
	}
	if (changed.has('bus')) {
		imports.add('from bus_type import BusType');
		body.push(`    system.set_bus_type(BusType.${form.bus})`);
	}
	if (memoryEditable && ['banks', 'bankKb', 'codeKb', 'ilNum', 'ilSizeKb'].some(k => changed.has(k as keyof PlatformForm))) {
		imports.add('from memory_ss.memory_ss import MemorySS').add('from memory_ss.linker_section import LinkerSection');
		const code = hex(form.codeKb * 1024);
		body.push('    memory_ss = MemorySS()', `    memory_ss.add_ram_banks([${form.bankKb}] * ${form.banks})`);
		if (form.ilNum) {
			body.push(`    memory_ss.add_ram_banks_il(${form.ilNum}, ${form.ilSizeKb}, "interleaved_group_0")`);
		}
		body.push(`    memory_ss.add_linker_section(LinkerSection.by_size("code", 0, ${code}))`, `    memory_ss.add_linker_section(LinkerSection("data", ${code}, None))`);
		if (form.ilNum) {
			imports.add('from memory_ss.linker_subsection import LinkerSubsection');
			// Apps place data there with __attribute__((section(".xheep_data_interleaved"))).
			body.push('    memory_ss.add_linker_section_for_banks("data_interleaved", subsections=[LinkerSubsection("xheep_data_interleaved")],',
				'                                           interleaved=True, il_group_name="interleaved_group_0")');
		}
		body.push('    system.set_memory_ss(memory_ss)');
	}
	if (changed.has('stackKb') || changed.has('heapKb')) {
		imports.add('from linker_script.linker_script import LinkerScript');
		body.push(`    system.set_linker_script_config(LinkerScript(stack_size=${hex(form.stackKb * 1024)}, heap_size=${hex(form.heapKb * 1024)}))`);
	}
	if (changed.has('peripherals')) {
		// A new user domain replaces the base's: its getters hand out copies, which remove_peripheral() does not match.
		const removed = base.peripherals.filter(p => form.peripherals.indexOf(p) < 0);
		const added = form.peripherals.map(p => catalog.userPeripherals.find(c => c.name === p))
			.filter((c): c is Catalog['userPeripherals'][number] => !!c && base.peripherals.indexOf(c.name) < 0);
		imports.add('from peripherals.peripheral_domain import PeripheralDomain');
		added.forEach(c => imports.add(`from peripherals.user_peripherals import ${c.cls}`));
		body.push('    user = system.get_user_peripheral_domain()');
		body.push(`    peripherals = ${removed.length ? `[p for p in user.get_peripherals() if p.get_name() not in (${removed.map(r => JSON.stringify(r)).join(', ')},)]` : 'user.get_peripherals()'}`);
		if (added.length) {
			body.push(`    peripherals += [${added.map(c => `${c.cls}()`).join(', ')}]  # placed by the generator`);
		}
		body.push('    system.add_peripheral_domain(PeripheralDomain("user_peripheral_domain", user.get_power_domain(), user.has_clock_gating(), peripherals))');
	}
	return overlayFile(name, baseRel, form, imports, body);
}

/** An overlay: loads the base at `baseRel`, then runs `body` on it (as `system`). */
function overlayFile(name: string, baseRel: string, form: unknown, imports: Set<string>, body: string[]): string {
	return [
		`# Platform "${name}", from the X-HEEP IDE platform editor, on top of ${baseRel}.`,
		'# Apply in the editor rewrites this file. To take it over by hand, delete the xheep-ide line.',
		`${HEADER}${JSON.stringify({ base: baseRel, form })}`,
		...imports,
		'',
		`BASE = PurePath(__file__).parent / ${JSON.stringify(baseRel)}`,
		'',
		'',
		'def config():',
		'    system = load_cfg_file(BASE)',
		...body,
		'    return system',
		'',
	].join('\n');
}

// --- X-ALP --------------------------------------------------------------------
// Its knobs: the last-level cache, whose geometry sizes the SPM and which caches the DRAM, and the peripherals.

/** What media/platform.py reads from an X-ALP configuration. */
export interface XalpPlatform {
	cpu: string;
	llc: { ways: number; lines: number; blocks: number; dataWidth: number; dramSize: number };
	peripherals: string[];
}

/** Peripherals a configuration may leave out, with the module defining each. */
export interface XalpCatalog { peripherals: { name: string; cls: string; pkg: string; doc: string }[] }

/** The X-ALP editor's form. Geometry values are powers of two, as xheep_gen requires. */
export interface XalpForm { ways: number; lines: number; blocks: number; dramMb: number; peripherals: string[] }

export const xalpForm = (p: XalpPlatform, catalog: XalpCatalog): XalpForm => ({
	ways: p.llc.ways, lines: p.llc.lines, blocks: p.llc.blocks, dramMb: p.llc.dramSize / (1 << 20),
	peripherals: p.peripherals.filter(n => catalog.peripherals.some(c => c.name === n)).sort(),
});

/** The overlay for `form` on top of the X-ALP configuration at `baseRel`, which reads as `base`. */
export function xalpOverlayConfig(name: string, baseRel: string, base: XalpForm, form: XalpForm, catalog: XalpCatalog): string {
	const changed = new Set(Object.keys(form).filter(k => JSON.stringify(base[k as keyof XalpForm]) !== JSON.stringify(form[k as keyof XalpForm])));
	const imports = new Set(['from pathlib import PurePath', 'from load_config import load_cfg_file']);
	const body: string[] = [];
	const cache = ['ways', 'lines', 'blocks', 'dramMb'].some(k => changed.has(k));
	if (cache) {
		imports.add('from peripherals.base_peripherals.llc import LLC');
		body.push('    old = system.get_cache()',
			`    llc = LLC(old.get_address(), old.get_length(), set_assoc=${form.ways}, num_lines=${form.lines}, num_blocks=${form.blocks},`,
			`              data_width=old._data_width, spm_start=old._spm_start, cached_start=old._cached_start, cached_size=${hex(form.dramMb << 20)})`,
			'    system.set_memory_ss(llc)');
	}
	if (cache || changed.has('peripherals')) {
		// Domains hand out copies of their peripherals, which remove_peripheral() does not match: each is rebuilt.
		const removed = base.peripherals.filter(p => !form.peripherals.includes(p));
		const added = catalog.peripherals.filter(c => form.peripherals.includes(c.name) && !base.peripherals.includes(c.name));
		imports.add('from peripherals.peripheral_domain import PeripheralDomain');
		added.forEach(c => imports.add(`from ${c.pkg} import ${c.cls}`));
		body.push('    for d in system.get_domains():',
			`        peripherals = [${cache ? 'llc if p.get_name() == "axi_llc" else p' : 'p'} for p in d.get_peripherals()${removed.length ? ` if p.get_name() not in (${removed.map(r => JSON.stringify(r)).join(', ')},)` : ''}]`);
		if (added.length) {
			body.push('        if d.contains_peripheral("soc_ctrl"):',
				`            peripherals += [${added.map(c => `${c.cls}()`).join(', ')}]  # placed by the generator`);
		}
		body.push('        system.remove_domain(d.get_name())',
			'        system.add_domain(PeripheralDomain(d.get_name(), d.get_power_domain(), d.has_clock_gating(), peripherals))');
	}
	return overlayFile(name, baseRel, form, imports, body);
}
