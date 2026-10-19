# X-HEEP IDE (Alpha)

VS Code extension for developing software on [X-HEEP](https://github.com/esl-epfl/x-heep), in simulation and on
FPGA. Open an X-HEEP clone in VS Code and the extension activates.

## Features

- **Applications view** (X-HEEP icon in the activity bar): your apps and the X-HEEP examples, with Build, Run and
  Debug.
- **Run modes** (status bar):
  - **Simulation**: runs the app on the Verilator (or Questasim) model. Debug uses GDB on a JTAG-enabled model.
  - **FPGA · JTAG**: loads the app into X-HEEP's RAM through the JTAG adapter that is plugged in. Run runs it,
    Debug opens GDB.
  - **FPGA · Flash**: writes the app to the SPI flash, and X-HEEP boots it by itself, as the chip would.
- **UART output** in the *X-HEEP UART* panel, closed by the program's exit code.
- **Errors explained**: memory overflows, functions that need an OS (`sleep`, `pthread_*`), stack overflows,
  exceptions, and programs stuck on the board.
- **Environment check**: Python environment, toolchain, Verilator and verible versions, FPGA hardware and
  permissions. Each problem comes with what to do about it.
- **Set Up Tools**: finds or installs the missing tools, or reopens the project in the X-HEEP container (Docker
  or WSL), where everything is preinstalled.

## Platform configurations

Click the configuration in the status bar to pick a configuration, or to create one as Python code or with the
experimental editor. The editor is a form for CPU, bus, memory and peripherals. It saves a small Python file on
top of the configuration you started from, and never edits the original.

## Hardware development

For changes to the X-HEEP RTL:

- **Model kept up to date**: saving an RTL file in `hw/` or `tb/` rebuilds the simulation model in the background
  (`xheep.rebuildModelOnSave`), and a run never uses a model older than the RTL. Verilator and Questasim errors,
  and warnings outside vendored IPs, go to the Problems panel.
- **Waveforms**: **Open Waveform** opens the `waveform.fst` of the last Verilator run in
  [Surfer](https://marketplace.visualstudio.com/items?itemName=surfer-project.surfer), or in GTKWave.
- **SystemVerilog editing** with the [Verible](https://marketplace.visualstudio.com/items?itemName=chipsalliance.verible)
  extension: lint, go to definition across modules (the extension writes `verible.filelist` from the model's
  files), and formatting on save as X-HEEP's `util/format-verible` does, only in the folders it covers
  (`xheep.formatRtlOnSave`).
- **Memory Map** view: RAM, address regions, peripherals, and their registers and fields from the regtool
  descriptions, with absolute addresses to copy.
- **App regression** in the Testing view: runs the apps on the simulation model of the active platform. An app
  passes when it exits with 0. Apps X-HEEP's own app test leaves out are skipped, unless you run them one by one.

## FPGA

Officially supported boards: **PYNQ-Z2** and **AUP-ZU3**.

On the PYNQ-Z2, OpenOCD loads the bitstream (no Vivado needed). Set `xheep.bitstream` to a `.bit` file, or build
one with **Build Bitstream**, which only appears when Vivado is installed. The extension warns when the active
configuration does not match the hardware of the bitstream.

## Software-only projects

Run **X-HEEP: New Software Project** in an empty folder to keep your apps in your own repo, with X-HEEP added
as a git submodule (or a link to an existing clone) in `x-heep/`.
**Update X-HEEP** moves that submodule to the latest X-HEEP commit tested with the extension, or to `main`.

## Settings

All under `xheep.*`. The defaults work for most setups. `envSetup`, `riscvToolchain`, `fpgaBoard`, `bitstream`
and `serialPort` are the ones you may need to set.

## Development

```sh
npm install
npm run compile   # or: npm run watch
npm test
```

Press F5 to open an Extension Development Host, then open an X-HEEP folder in it. `make e2e` runs the
software-project steps against a fresh X-HEEP clone (it needs the X-HEEP tools).

**Releasing**: add the version to `CHANGELOG.md`, then `make patch` (or `minor`, `major`). CI tests, publishes
to the Marketplace and creates the GitHub release.

**X-HEEP compatibility**: `XHEEP_COMMIT` pins the last X-HEEP commit the extension works with, and new projects
clone that commit. A nightly workflow tests each new X-HEEP `main` commit. It moves the pin when the commit
passes, and opens an issue labelled `xheep-canary` when it fails.

## Contributors

- [Luigi Giuffrida](https://github.com/LuigiGiuffrida98)
- [Alessandro Varaldi](https://github.com/AlessandroVaraldi)
