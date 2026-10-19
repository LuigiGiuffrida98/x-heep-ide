import * as assert from 'assert';
import { Platform, Catalog, formFromPlatform, plainMemory, hardwareFingerprint, archFor, hardwareChanges, formProblems, overlayConfig, overlayHeader, mapNodes } from '../platform';

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
				name: 'uart', start: 0x30080000, length: 65536, registers: [{
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
		assert.deepStrictEqual(ctrl.children.map(f => f.description), ['[0] rw', '[31:16] rw']);
	});
});
