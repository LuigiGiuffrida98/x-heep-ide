import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Platform, Catalog, formFromPlatform, plainMemory, hardwareFingerprint, archFor, hardwareChanges, formProblems, overlayConfig, overlayHeader, mapNodes, xalpForm, xalpOverlayConfig } from '../platform';

// What media/platform.py reads from X-HEEP's configs/general.py and configs/example_interleaved.hjson.
const general: Platform = {
	cpu: 'cv32e20', fpu: false, bus: 'onetoM', banks: [32, 32], interleaved: [],
	sections: [{ name: 'code', start: 0, end: 59392 }, { name: 'data', start: 59392, end: null }],
	stack: 2048, heap: 2048, userPeripherals: ['rv_plic', 'spi_host', 'gpio', 'i2c', 'rv_timer', 'spi2', 'i2s', 'uart'],
};
const customMemory: Platform = { ...general, banks: [64, 32, 32], interleaved: [{ num: 4, sizeKb: 16 }, { num: 2, sizeKb: 16 }] };
const catalog: Catalog = { cpus: ['cv32e20', 'cv32e40p'], userPeripherals: [{ name: 'pdm2pcm', cls: 'PDM2PCM', doc: '' }, { name: 'i2s', cls: 'I2S', doc: '' }] };

suite('Platform editor', () => {
	test('reads a configuration into the form', () => {
		assert.deepStrictEqual(formFromPlatform(general), {
			cpu: 'cv32e20', fpu: false, bus: 'onetoM', banks: 2, bankKb: 32, codeKb: 58, ilNum: 0, ilSizeKb: 16, stackKb: 2, heapKb: 2,
			peripherals: ['gpio', 'i2c', 'i2s', 'rv_plic', 'rv_timer', 'spi2', 'spi_host', 'uart'],
		});
		assert.ok(plainMemory(general));
		assert.ok(!plainMemory(customMemory)); // mixed sizes, two interleaved groups: shown, but left to their file
		assert.ok(plainMemory({ ...general, banks: [16, 16, 16] }));
		assert.strictEqual(formFromPlatform({ ...general, banks: [16, 16, 16] }).bankKb, 16);
	});

	test('a bitstream stays good across stack, heap and the code/data split', () => {
		const softwareOnly = { ...general, stack: 16384, heap: 4096, sections: [{ name: 'code', start: 0, end: 98304 }, { name: 'data', start: 98304, end: null }] };
		assert.strictEqual(hardwareFingerprint(softwareOnly), hardwareFingerprint(general));
		assert.notStrictEqual(hardwareFingerprint({ ...general, fpu: true }), hardwareFingerprint(general));
		assert.strictEqual(hardwareFingerprint({ ...general, userPeripherals: [...general.userPeripherals].reverse() }), hardwareFingerprint(general));
		const base = formFromPlatform(general);
		assert.deepStrictEqual(hardwareChanges(base, { ...base, stackKb: 16, codeKb: 96 }), []);
		assert.deepStrictEqual(hardwareChanges(base, { ...base, banks: 6, ilNum: 4 }), ['banks', 'ilNum']);
		assert.deepStrictEqual(hardwareChanges(base, { ...base, bankKb: 64 }), ['bankKb']);
	});

	test('apps use a hardware FPU', () => {
		assert.strictEqual(archFor({ fpu: true }), 'rv32imfc_zicsr');
		assert.strictEqual(archFor({ fpu: false }), undefined);
	});

	test('says what keeps a form from working', () => {
		const base = formFromPlatform(general);
		assert.deepStrictEqual(formProblems(base, true), []);
		assert.ok(formProblems({ ...base, codeKb: 60, stackKb: 4 }, true)[0].startsWith('Code, stack and heap (66 KB) do not fit in 64 KB'));
		assert.deepStrictEqual(formProblems({ ...base, fpu: true }, true), ['cv32e20 has no FPU.']);
		assert.deepStrictEqual(formProblems({ ...base, banks: 8, ilNum: 3 }, true), ['The number of interleaved banks must be a power of two.']);
	});

	test('writes only what changed, on top of the base', () => {
		const base = formFromPlatform(general);
		const src = overlayConfig('my_soc', '../x-heep/configs/general.py', base, { ...base, stackKb: 16 }, catalog, true);
		assert.ok(src.includes('BASE = PurePath(__file__).parent / "../x-heep/configs/general.py"'));
		assert.ok(src.includes('    system = load_cfg_file(BASE)\n    system.set_linker_script_config(LinkerScript(stack_size=0x4000, heap_size=0x800))\n    return system'));
		assert.ok(!src.includes('MemorySS') && !src.includes('set_cpu'));
	});

	test('writes the memory, the CPU and the peripherals as xheep_gen builds them', () => {
		const base = formFromPlatform(general);
		const form = { ...base, cpu: 'cv32e40p', fpu: true, bus: 'NtoM', banks: 6, bankKb: 16, codeKb: 48, ilNum: 4, ilSizeKb: 16,
			peripherals: [...base.peripherals.filter(p => p !== 'i2s'), 'pdm2pcm'].sort() };
		const src = overlayConfig('my_soc', 'general.py', base, form, catalog, true);
		for (const line of [
			'    system.set_cpu(cv32e40p(fpu=True))',
			'    system.set_bus_type(BusType.NtoM)',
			'    memory_ss.add_ram_banks([16] * 6)',
			'    memory_ss.add_ram_banks_il(4, 16, "interleaved_group_0")',
			'    memory_ss.add_linker_section(LinkerSection.by_size("code", 0, 0xc000))',
			'    memory_ss.add_linker_section_for_banks("data_interleaved", subsections=[LinkerSubsection("xheep_data_interleaved")],',
			'    peripherals = [p for p in user.get_peripherals() if p.get_name() not in ("i2s",)]',
			'    peripherals += [PDM2PCM()]  # placed by the generator',
			'from peripherals.user_peripherals import PDM2PCM',
		]) {
			assert.ok(src.includes(line), `missing: ${line}`);
		}
		// Custom memory stays as the base has it.
		assert.ok(!overlayConfig('x', 'b.hjson', base, form, catalog, false).includes('MemorySS'));
	});

	test('recognises its own files, and leaves hand-written ones alone', () => {
		const base = formFromPlatform(general);
		const src = overlayConfig('my_soc', 'general.py', base, { ...base, heapKb: 8 }, catalog, true);
		assert.deepStrictEqual(overlayHeader(src), { base: 'general.py', form: { ...base, heapKb: 8 } });
		assert.strictEqual(overlayHeader('from xheep import XHeep\ndef config():\n    ...\n'), undefined);
	});
});

suite('Memory map', () => {
	test('RAM first, then regions by address, registers at their absolute address', () => {
		const nodes = mapNodes({
			banks: [{ name: 'ram0', start: 0, length: 32768 }, { name: 'ram1', start: 32768, length: 32768 }],
			regions: [{ name: 'flash_mem', start: 0x40000000, length: 1 << 24 }, { name: 'debug', start: 0x10000000, length: 1 << 20 }],
			domains: [{ name: 'user_peripheral_domain', start: 0x30000000, length: 1 << 20, peripherals: [{
				name: 'spi_flash', ip: 'spi_host', start: 0x30080000, length: 65536, registers: [{
					name: 'CTRL', offset: 0xc, desc: 'UART control register', access: 'rw', reset: 0,
					fields: [{ name: 'TX', msb: 0, lsb: 0, access: 'rw', desc: 'TX enable' }, { name: 'NCO', msb: 31, lsb: 16, access: 'rw', desc: '' }],
				}],
			}] }],
		});
		assert.deepStrictEqual(nodes.map(n => [n.label, n.description]), [['RAM', '0x00000000 · 64 KB'], ['debug', '0x10000000 · 1 MB'],
			['user_peripheral_domain', '0x30000000 · 1 MB'], ['flash_mem', '0x40000000 · 16 MB']]);
		const ctrl = nodes[2].children[0].children[0];
		assert.strictEqual(ctrl.description, '0x3008000c · rw');
		assert.strictEqual(ctrl.address, 0x3008000c);
		assert.strictEqual(ctrl.define, 'SPI_FLASH_START_ADDRESS + SPI_HOST_CTRL_REG_OFFSET');
		assert.deepStrictEqual([nodes[0].define, nodes[2].define], ['RAM0_START_ADDRESS', 'PERIPHERAL_START_ADDRESS']);
		assert.deepStrictEqual(ctrl.children.map(f => f.description), ['[0] rw', '[31:16] rw']);
	});
});

suite('X-ALP memory map', () => {
	test('SPM and DRAM, then the regions; defines as in core_v_mcu.h', () => {
		const nodes = mapNodes({
			banks: [{ name: 'spm', start: 0x10000000, length: 1 << 18 }, { name: 'dram', start: 0x80000000, length: 1 << 28 }],
			regions: [{ name: 'debug', start: 0, length: 1 << 20 }, { name: 'ext_slaves', start: 0xf0000000, length: 1 << 24 }],
			domains: [{ name: 'peripheral_domain', start: 0x20000000, length: 1 << 20, peripherals: [{
				name: 'axi_llc', ip: 'axi_llc', start: 0x20050000, length: 65536, registers: [{ name: 'CFG_SPM_LOW', offset: 0, desc: '', access: 'rw', fields: [] }],
			}] }],
		}, 'x-alp');
		assert.deepStrictEqual(nodes[0].children.map(n => n.define), ['LLC_START_ADDRESS', 'DRAM_START_ADDRESS']);
		assert.deepStrictEqual(nodes.slice(1).map(n => n.define), ['DEBUG_START_ADDRESS', 'PERIPHERAL_DOMAIN_START_ADDRESS', 'EXT_SLAVES_START_ADDRESS']);
		assert.strictEqual(nodes[2].children[0].children[0].define, 'AXI_LLC_START_ADDRESS + AXI_LLC_CFG_SPM_LOW_REG_OFFSET');
	});
});

suite('X-ALP platform editor', () => {
	const catalog = { peripherals: [
		{ name: 'pad_control', cls: 'Pad_control', pkg: 'peripherals.base_peripherals', doc: '' },
		{ name: 'uart', cls: 'UART', pkg: 'peripherals.user_peripherals', doc: '' },
	] };
	const base = xalpForm({ cpu: 'cva6', llc: { ways: 16, lines: 256, blocks: 8, dataWidth: 64, dramSize: 1 << 28 },
		peripherals: ['soc_ctrl', 'bootrom', 'uart', 'axi_llc'] }, catalog);

	test('the form holds the cache geometry, the DRAM in MB and the optional peripherals', () => {
		assert.deepStrictEqual(base, { ways: 16, lines: 256, blocks: 8, dramMb: 256, peripherals: ['uart'] });
	});

	test('the overlay writes only what changed', () => {
		assert.ok(!xalpOverlayConfig('x', 'soc.py', base, base, catalog).includes('system.get_cache()'), 'no change, no new cache');
		const cache = xalpOverlayConfig('x', 'soc.py', base, { ...base, ways: 8, dramMb: 512 }, catalog);
		assert.ok(cache.includes('set_assoc=8, num_lines=256, num_blocks=8') && cache.includes('cached_size=0x20000000'));
		// The cache is also a peripheral: its domain gets the new one.
		assert.ok(cache.includes('llc if p.get_name() == "axi_llc" else p'));
	});

	test('peripherals: removed by name, added to the domain of soc_ctrl', () => {
		const src = xalpOverlayConfig('x', 'soc.py', base, { ...base, peripherals: ['pad_control'] }, catalog);
		assert.ok(src.includes('if p.get_name() not in ("uart",)'));
		assert.ok(src.includes('from peripherals.base_peripherals import Pad_control') && src.includes('peripherals += [Pad_control()]'));
		assert.ok(!src.includes('LLC('), 'the cache is kept as is');
	});
});

suite('Memory map of a platform generated by hand', () => {
	test('read from the generated C header, whatever configuration made it', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xheep-gen-'));
		const header = path.join(root, 'sw', 'device', 'lib', 'runtime', 'core_v_mini_mcu.h');
		fs.mkdirSync(path.dirname(header), { recursive: true });
		fs.writeFileSync(header, [
			'#define CORE_V_MINI_MCU_H_', // no value: must not swallow the next line
			'#define RAM0_START_ADDRESS 0x00000000', '#define RAM0_END_ADDRESS 0x00008000',
			'#define DEBUG_START_ADDRESS 0x10000000', '#define DEBUG_SIZE 0x00100000',
			'#define PERIPHERAL_START_ADDRESS 0x30000000', '#define PERIPHERAL_SIZE 0x00100000',
			'#define UART_START_ADDRESS (PERIPHERAL_START_ADDRESS + 0x80000)', '#define UART_SIZE 0x10000',
			'#define PDM2PCM_START_ADDRESS 0', // absent
			'',
		].join('\n'));
		const r = spawnSync('python3', [path.join(__dirname, '..', '..', 'media', 'platform.py'), 'generated', root, '-'], { encoding: 'utf8' });
		const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
		assert.ok(out.ok, out.error);
		assert.deepStrictEqual(out.map.banks, [{ name: 'ram0', start: 0, length: 0x8000 }]);
		assert.deepStrictEqual(out.map.regions, [{ name: 'debug', start: 0x10000000, length: 0x100000 }]);
		assert.deepStrictEqual(out.map.domains.map((d: { name: string; peripherals: { name: string; start: number }[] }) => [d.name, d.peripherals.map(p => [p.name, p.start])]),
			[['peripheral', [['uart', 0x30080000]]]]);
	});
});
