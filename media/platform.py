# Reads and checks X-HEEP platform configurations for the X-HEEP IDE platform editor, with X-HEEP's own
# generator (util/xheep_gen), so the editor shows what mcu-gen would build and never reimplements it.
#
#   python platform.py read  <x-heep root> <config>   -> JSON: effective values and what can be chosen
#   python platform.py check <x-heep root> <config>   -> JSON: whether mcu-gen would accept it
#   python platform.py map   <x-heep root> <config>   -> JSON: memory map, peripherals and their registers
#
# Runs in X-HEEP's Python environment. Prints one JSON object on its last line.

import contextlib
import inspect
import io
import json
import sys
from pathlib import PurePath


def catalog():
    """CPUs and user peripherals xheep_gen knows, with their first doc line."""
    import peripherals.user_peripherals as up
    from peripherals.abstractions import UserPeripheral

    def doc(cls):
        return (inspect.getdoc(cls) or "").split("\n")[0].strip()

    periph = sorted(
        {
            obj._name: {"name": obj._name, "cls": name, "doc": doc(obj)}
            for name, obj in vars(up).items()
            if inspect.isclass(obj) and issubclass(obj, UserPeripheral) and obj is not UserPeripheral and getattr(obj, "_name", None)
        }.values(),
        key=lambda p: p["name"],
    )
    return {"cpus": ["cv32e20", "cv32e40p", "cv32e40x", "cv32e40px"], "userPeripherals": periph}


def read(xheep):
    mem = xheep.memory_ss()
    cpu = xheep.cpu()
    il_groups = list(mem.iter_il_groups()) if mem.has_il_ram() else []
    il_idx = {b.name() for g in il_groups for b in g.banks} if il_groups else set()
    return {
        "cpu": cpu.get_name(),
        "fpu": bool(getattr(cpu, "params", {}).get("fpu", False)) if hasattr(cpu, "params") else bool(getattr(cpu, "fpu", False)),
        "bus": xheep.bus_type().value if hasattr(xheep.bus_type(), "value") else str(xheep.bus_type()),
        "banks": [b.size() // 1024 for b in mem.iter_ram_banks() if b.name() not in il_idx],
        "interleaved": [{"num": g.n, "sizeKb": g.size // g.n // 1024} for g in il_groups],
        "sections": [{"name": s.name, "start": s.start, "end": s.end} for s in mem.iter_linker_sections()],
        "stack": xheep.stack_size(),
        "heap": xheep.heap_size(),
        "userPeripherals": [p.get_name() for p in xheep.get_user_peripheral_domain().get_peripherals()],
    }


# Peripherals that are instances of an IP with another name. Bootrom and ext_peripheral have no registers.
IP_OF = {"gpio_ao": "gpio", "rv_timer_ao": "rv_timer", "spi_flash": "spi_host", "spi2": "spi_host"}


def register_files(root):
    """The regtool descriptions in X-HEEP, by IP name. mcu-gen writes the templated ones (soc_ctrl, dma, ...)."""
    import re
    from pathlib import Path

    files = {}
    for f in sorted(Path(root, "hw").rglob("*.hjson")):
        if any(s in f.name for s in ("testplan", ".prj.", ".lock.", ".vendor.", "secded")):
            continue
        text = f.read_text(errors="ignore")
        name = re.search(r'^\s*\{?\s*name\s*:\s*"?(\w+)', text, re.M)
        if name and "registers" in text:
            files.setdefault(name.group(1).lower(), f)
    return files


def registers(path):
    """Registers of a regtool description, with offsets as regtool computes them (multiregs expanded)."""
    from reggen.ip_block import IpBlock

    block = IpBlock.from_path(str(path), [])
    out = []
    for rb in block.reg_blocks.values():
        out += [
            {
                "name": r.name,
                "offset": r.offset,
                "desc": r.desc,
                "access": r.swaccess.key,
                "reset": r.resval,
                "fields": [
                    {"name": f.name, "msb": f.bits.msb, "lsb": f.bits.lsb, "access": f.swaccess.key, "desc": f.desc or ""}
                    for f in r.fields
                ],
            }
            for r in rb.flat_regs
        ]
        out += [{"name": w.name, "offset": w.offset, "desc": w.desc, "window": w.size_in_bytes, "fields": []} for w in rb.windows]
    return sorted(out, key=lambda r: r["offset"])


def build(xheep, root):
    """As mcu-gen does: pads, then build (fills the gaps, e.g. peripheral addresses)."""
    import load_config

    xheep.set_padring(load_config.load_pad_cfg(PurePath(f"{root}/configs/pad_cfg.py"), xheep))
    xheep.build()


def address_map(xheep, root):
    """Where everything is, as mcu-gen builds it: RAM banks, address regions, peripheral domains."""
    build(xheep, root)
    sys.path.insert(0, f"{root}/hw/vendor/pulp_platform/register_interface/vendor/lowrisc_opentitan/util")
    files = register_files(root)

    def regs(name):
        f = files.get(IP_OF.get(name, name))
        try:
            return registers(f) if f else []
        except Exception:  # a description reggen cannot read: the peripheral is still on the map
            return []

    # The domains' regions of the address map: older X-HEEPs (e.g. vendored by gr-heep) give domains no name or address.
    domains = {"base_peripheral_domain": xheep.get_base_peripheral_domain(), "user_peripheral_domain": xheep.get_user_peripheral_domain()}
    regions = xheep.address_map().get_regions()
    return {
        "banks": [{"name": f"ram{b.name()}", "start": b.start_address(), "length": b.size()} for b in xheep.memory_ss().iter_ram_banks()],
        "regions": [{"name": r.get_name(), "start": r.get_start_address(), "length": r.get_length()} for r in regions if r.get_name() not in domains],
        "domains": [
            {
                "name": r.get_name(),
                "start": r.get_start_address(),
                "length": r.get_length(),
                "peripherals": [
                    {
                        "name": p.get_name(),
                        "start": r.get_start_address() + p.get_address(),
                        "length": p.get_length(),
                        "registers": regs(p.get_name()),
                        "ip": IP_OF.get(p.get_name(), p.get_name()),  # prefix of its <ip>_regs.h defines
                    }
                    for p in domains[r.get_name()].get_peripherals()
                ],
            }
            for r in regions
            if r.get_name() in domains
        ],
    }


def main():
    cmd, root, config = sys.argv[1:4]
    sys.path.insert(0, f"{root}/util/xheep_gen")
    out = {"ok": True}
    log = io.StringIO()
    try:
        # xheep_gen prints its own messages: keep stdout for the JSON.
        with contextlib.redirect_stdout(log):
            import load_config

            xheep = load_config.load_cfg_file(PurePath(config))
            if cmd == "read":
                out["platform"] = read(xheep)
                out["catalog"] = catalog()
            elif cmd == "map":
                out["map"] = address_map(xheep, root)
            else:
                build(xheep, root)
                xheep.validate()  # mcu-gen's sanity checks
    except Exception as e:  # any failure is the user's to read, as mcu-gen would print it
        out = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    out["log"] = log.getvalue()[-2000:]
    print(json.dumps(out))


if __name__ == "__main__":
    main()
