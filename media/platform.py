# Reads and checks X-HEEP (and X-ALP) platform configurations for the X-HEEP IDE platform editor, with X-HEEP's own
# generator (util/xheep_gen), so the editor shows what mcu-gen would build and never reimplements it.
#
#   python platform.py read  <x-heep root> <config>   -> JSON: effective values and what can be chosen
#   python platform.py check <x-heep root> <config>   -> JSON: whether mcu-gen would accept it
#   python platform.py map   <x-heep root> <config>   -> JSON: memory map, peripherals and their registers
#   python platform.py generated <x-heep root> -           -> JSON: the same, from the platform as generated (by hand too)
#
# Runs in X-HEEP's Python environment. Prints one JSON object on its last line.

import contextlib
import inspect
import io
import json
import re
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


def read_xalp(soc):
    """X-ALP's knobs: the last-level cache (its geometry sizes the SPM, it caches the DRAM) and the peripherals."""
    llc = soc.get_cache()
    return {
        "cpu": soc.cpu().get_name(),
        "llc": {
            "ways": llc.get_set_assoc(),
            "lines": llc.get_num_lines(),
            "blocks": llc.get_num_blocks(),
            "dataWidth": llc._data_width,
            "dramSize": llc._cached_size,
        },
        "peripherals": soc.get_configured_peripheral_names(),
    }


def catalog_xalp(soc):
    """The peripherals an X-ALP configuration may leave out, with the module defining each."""
    import peripherals.base_peripherals as bp
    import peripherals.user_peripherals as up

    optional = set(soc.AVAILABLE_PERIPHERALS) - set(soc.MINIMUM_PERIPHERALS) - {"axi_llc"}
    found = {
        obj._name: {"name": obj._name, "cls": name, "pkg": pkg.__name__, "doc": (inspect.getdoc(obj) or "").split("\n")[0].strip()}
        for pkg in (bp, up)
        for name, obj in vars(pkg).items()
        if inspect.isclass(obj) and getattr(obj, "_name", None) in optional
    }
    return {"peripherals": sorted(found.values(), key=lambda p: p["name"])}


# Peripherals that are instances of an IP with another name. Bootrom and ext_peripheral have no registers.
IP_OF = {"gpio_ao": "gpio", "rv_timer_ao": "rv_timer", "spi_flash": "spi_host", "spi2": "spi_host"}


def register_files(root):
    """The regtool descriptions in X-HEEP, by IP name. mcu-gen writes the templated ones (soc_ctrl, dma, ...)."""
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
    # reggen, where X-HEEP and X-ALP (from its vendored X-HEEP IPs) keep it.
    for vendor in ("hw/vendor", "hw/vendor/x-heep"):
        sys.path.insert(0, f"{root}/{vendor}/pulp_platform/register_interface/vendor/lowrisc_opentitan/util")
    files = register_files(root)

    def regs(name):
        f = files.get(IP_OF.get(name, name))
        try:
            return registers(f) if f else []
        except Exception:  # a description reggen cannot read: the peripheral is still on the map
            return []

    # The domains' regions of the address map: older X-HEEPs (e.g. vendored by gr-heep) give domains no name or address.
    if hasattr(xheep, "get_domains"):  # X-ALP: any number of domains, each a region of the address map
        domains = {d.get_name(): d for d in xheep.get_domains()}
    else:
        domains = {"base_peripheral_domain": xheep.get_base_peripheral_domain(), "user_peripheral_domain": xheep.get_user_peripheral_domain()}
    regions = xheep.address_map().get_regions()
    if hasattr(xheep, "get_cache"):  # X-ALP: the last-level cache's scratchpad, and the DRAM it caches
        llc = xheep.get_cache()
        banks = [
            {"name": "spm", "start": llc._spm_start, "length": llc.get_spm_size()},
            {"name": "dram", "start": llc._cached_start, "length": llc._cached_size},
        ]
    else:
        banks = [{"name": f"ram{b.name()}", "start": b.start_address(), "length": b.size()} for b in xheep.memory_ss().iter_ram_banks()]
    return {
        "banks": banks,
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


# The C header mcu-gen writes with every address: X-HEEP's, X-ALP's.
HEADERS = ("sw/device/lib/runtime/core_v_mini_mcu.h", "sw/device/lib/runtime/core_v_mcu.h")
# Memories among its blocks: X-HEEP's RAM banks, X-ALP's scratchpad (the cache) and DRAM.
MEMORIES = re.compile(r"^(RAM\d+|LLC|DRAM)$")


def generated_map(root):
    """address_map() of the platform as generated, from its header: whatever configuration made it, by hand too."""
    from pathlib import Path

    header = next((Path(root, h) for h in HEADERS if Path(root, h).exists()), None)
    if not header:
        raise RuntimeError("the platform is not generated yet (no core_v_mini_mcu.h or core_v_mcu.h)")
    defines = dict(re.findall(r"^#define[ \t]+(\w+)[ \t]+(.+?)[ \t]*$", header.read_text(), re.M))

    def value(name, depth=0):
        if name not in defines or depth > 10:
            return None
        expr = re.sub(r"\b[A-Za-z_]\w*", lambda m: str(value(m.group(0), depth + 1)), defines[name])
        # Only numbers and + - ( ) remain: the header's address expressions.
        return eval(expr) if re.fullmatch(r"[\s()+\-0-9a-fA-FxX]+", expr) else None

    blocks = []
    for name in defines:
        base = name[: -len("_START_ADDRESS")] if name.endswith("_START_ADDRESS") else None
        if not base:
            continue
        start = value(name)
        end = value(base + "_END_ADDRESS") if base + "_END_ADDRESS" in defines else None
        length = value(base + "_SIZE") if base + "_SIZE" in defines else (end - start if end is not None and start is not None else None)
        if start is not None and length:  # absent peripherals are defined as 0, without a size
            blocks.append({"name": base.lower(), "start": start, "length": length})

    inside = lambda b, d: b is not d and d["start"] <= b["start"] and b["start"] + b["length"] <= d["start"] + d["length"] and b["length"] < d["length"]
    banks = [b for b in blocks if MEMORIES.match(b["name"].upper())]
    domains = [d for d in blocks if d not in banks and any(inside(b, d) for b in blocks)]
    peripherals = [b for b in blocks if any(inside(b, d) for d in domains)]
    regions = [b for b in blocks if b not in banks and b not in domains and b not in peripherals]
    for vendor in ("hw/vendor", "hw/vendor/x-heep"):
        sys.path.insert(0, f"{root}/{vendor}/pulp_platform/register_interface/vendor/lowrisc_opentitan/util")
    files = register_files(root)

    def regs(name):
        f = files.get(IP_OF.get(name, name))
        try:
            return registers(f) if f else []
        except Exception:  # a description reggen cannot read: the peripheral is still on the map
            return []

    return {
        "banks": banks,
        "regions": regions,
        "domains": [
            {**d, "peripherals": [{**p, "registers": regs(p["name"]), "ip": IP_OF.get(p["name"], p["name"])} for p in peripherals if inside(p, d)]}
            for d in domains
        ],
    }


def main():
    cmd, root, config = sys.argv[1:4]
    if cmd == "generated":  # no configuration: the one that made it may be unknown
        sys.path.insert(0, f"{root}/util/xheep_gen")
        try:
            out = {"ok": True, "map": generated_map(root)}
        except Exception as e:
            out = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        print(json.dumps(out))
        return
    sys.path.insert(0, f"{root}/util/xheep_gen")
    out = {"ok": True}
    log = io.StringIO()
    try:
        # xheep_gen prints its own messages: keep stdout for the JSON.
        with contextlib.redirect_stdout(log):
            import load_config

            xheep = load_config.load_cfg_file(PurePath(config))
            if cmd == "read" and hasattr(xheep, "get_cache"):  # X-ALP
                out["platform"] = read_xalp(xheep)
                out["catalog"] = catalog_xalp(xheep)
            elif cmd == "read":
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
