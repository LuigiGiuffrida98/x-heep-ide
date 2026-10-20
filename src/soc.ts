// The platforms the extension works with. X-HEEP and X-ALP share the generator (xheep_gen) and the software layout
// (sw/applications, sw/build, SOURCE for apps outside), but differ in CPU, configuration, linking and testbench.
// Free of the vscode API so the unit tests and the end-to-end test share it.

import * as fs from 'fs';
import * as path from 'path';

export type SocId = 'x-heep' | 'x-alp';

export interface Soc {
	id: SocId;
	/** As the user reads it. */
	name: string;
	git: string;
	/** Files of a checkout, together telling the platforms apart (X-ALP vendors util/xheep_gen too). */
	marks: string[];
	/** make variable naming the platform configuration, and the configuration used when none is set. */
	configVar: string;
	defaultConfig: string;
	/** A file mcu-gen writes: present once the platform was generated. */
	generated: string;
	/** Toolchain folder variable its Makefiles read. */
	toolchainVar: string;
	/** Memories an app can be linked into (make LINKER), X-ALP only: X-HEEP's follow the run mode. */
	linkers?: string[];
	/** Where a program ends, with its exit code in a0: X-ALP's main returns into crt0 (_exit is only linked by exit()). */
	exitSymbol: string;
	/** Python modules its mcu-gen needs beyond X-HEEP's environment (X-ALP's reggen writes Markdown docs with tabulate). */
	pythonModules?: string[];
}

export const SOCS: Record<SocId, Soc> = {
	'x-heep': {
		id: 'x-heep', name: 'X-HEEP', git: 'https://github.com/x-heep/x-heep.git',
		marks: ['util/xheep_gen/mcu_gen.py', 'hw/core-v-mini-mcu'],
		configVar: 'X_HEEP_CFG', defaultConfig: 'configs/general.py',
		generated: 'hw/core-v-mini-mcu/include/core_v_mini_mcu_pkg.sv',
		toolchainVar: 'RISCV_XHEEP',
		exitSymbol: '_exit',
	},
	'x-alp': {
		id: 'x-alp', name: 'X-ALP', git: 'https://github.com/x-heep/x-alp.git',
		marks: ['util/xheep_gen/mcu_gen.py', 'xalp.core'],
		configVar: 'X_ALP_CFG', defaultConfig: 'configs/soc.py',
		generated: 'hw/x_alp.sv',
		toolchainVar: 'RISCV_XALP',
		linkers: ['spm', 'dram'],
		exitSymbol: '_crt_return',
		pythonModules: ['tabulate'],
	},
};

/** The platform checked out in `dir`, if any. */
export const socOf = (dir: string): Soc | undefined =>
	Object.values(SOCS).find(s => s.marks.every(f => fs.existsSync(path.join(dir, f))));
