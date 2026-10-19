# Change Log

## 0.4.0

- Works with VS Code 1.92 and later (was 1.140), e.g. the older VS Code of Ubuntu's packages.

### Hardware development

- The simulation model is rebuilt in the background when an RTL file in `hw/` or `tb/` is saved, and a run never
  uses a model older than the RTL (`xheep.rebuildModelOnSave`).
- Verilator and Questasim errors of the model build go to the Problems panel, with warnings only outside vendored IPs.
- **Open Waveform**: the `waveform.fst` of the last Verilator run, in Surfer or GTKWave.
- SystemVerilog with the Verible extension: lint, go to definition across modules (from a `verible.filelist` of the
  model's files), and formatting on save as X-HEEP's `util/format-verible` does, only in the folders it covers
  (`xheep.formatRtlOnSave`).
- **Memory Map** view: RAM, address regions, peripherals and their registers and fields, with addresses to copy.
- App regression in the Testing view: the apps on the active platform's simulation model, skipping those X-HEEP's
  app test leaves out.

### Environment

- Check Environment and Set Up Tools share one list of checks: the report and its **Fix…** button always agree.
- Set Up Tools also handles verible (the version X-HEEP uses) and offers X-HEEP's Verilator version when another one
  is installed.
- With the environment OK, **Change a Tool…** switches a working tool (another toolchain, Verilator, the container).
- A disconnected FPGA board is a note, not an environment problem: simulation-only is the norm.

## 0.2.0

- Tested with X-HEEP [8759d1b](https://github.com/x-heep/x-heep/commit/8759d1b4760c95f7bcc0490afb27b7f41960aabd).

## 0.0.1 (preview)

- Applications view: your apps and the X-HEEP examples, new app and new file.
- Run modes: Simulation (Verilator/Questasim), FPGA JTAG debug (EPFL Programmer, on-board BSCAN, Digilent HS2), FPGA flash.
- Automatic platform generation (mcu-gen) and simulation model build when the configuration changes.
- Platform configurations kept in your project (`configs/*.py`), with a template from X-HEEP.
- Fast incremental builds and direct Verilator runs; UART output in its own panel.
- VS Code debugger (breakpoints, stepping) over OpenOCD, in simulation and on FPGA.
- Software-only projects with X-HEEP as a git submodule or a linked clone.
- Environment check with one-click fixes.
