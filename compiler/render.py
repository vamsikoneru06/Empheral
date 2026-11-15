"""Render every output file as text. Nothing here reads the clock, the environment or the file system."""

from __future__ import annotations

import csv
import io
import json
import re

from .model import Attachment, Device, Link, Model, Svi, access_ports
from .policy import Rule, acl_for_segment, acl_name, egress_lines, expected_matrix

EGRESS_ACL = "EXER-EGRESS"
NATIVE_NAME = "NATIVE-UNUSED"
BLACKHOLE_NAME = "BLACKHOLE"
MGMT_NAME = "MGMT"
MGMT_NOTE = "device management, out-of-band (VLAN not trunked)"


def _natural(name: str) -> tuple:
    """Sort key so that Gi1/0/9 comes before Gi1/0/10."""
    return tuple(int(p) if p.isdigit() else p for p in re.split(r"(\d+)", name))


def _vlan_name(model: Model, vid: int) -> str:
    owner = model.owner_of_vlan().get(vid)
    if owner is None:
        return f"VLAN{vid}"
    if owner.startswith("pod-"):
        return "POD-" + owner[4:]
    if owner.startswith("target-"):
        return "TGT-" + owner[7:]
    return {
        "scoring": "SCORING",
        "management": MGMT_NAME,
        "native": NATIVE_NAME,
        "blackhole": BLACKHOLE_NAME,
    }[owner]


def _my_port(link: Link, me: str) -> tuple[str, str, str]:
    """Return (my port, other device, other port) for a link endpoint on device `me`."""
    if link.a == me:
        return link.a_port, link.b, link.b_port
    return link.b_port, link.a, link.a_port


def _trunk_block(model: Model, link: Link, me: str) -> list[str]:
    port, other, other_port = _my_port(link, me)
    allowed = ",".join(str(v) for v in link.vlans)
    return [
        f"interface {port}",
        f" description TRUNK to {other} {other_port}",
        f" switchport trunk native vlan {model.native_vlan}",
        f" switchport trunk allowed vlan {allowed}",
        " switchport mode trunk",
        " switchport nonegotiate",
        " no shutdown",
    ]


def _access_block(att: Attachment) -> list[str]:
    return [
        f"interface {att.port}",
        f" description {att.segment} {att.role} {att.ip}",
        " switchport mode access",
        f" switchport access vlan {att.vlan}",
        " switchport port-security",
        " switchport port-security maximum 1",
        " spanning-tree portfast",
        " spanning-tree bpduguard enable",
        " no shutdown",
    ]


def _unused_block(model: Model, port: str) -> list[str]:
    return [
        f"interface {port}",
        " description UNUSED - blackhole",
        " switchport mode access",
        f" switchport access vlan {model.blackhole_vlan}",
        " switchport port-security",
        " switchport port-security maximum 1",
        " spanning-tree portfast",
        " spanning-tree bpduguard enable",
        " shutdown",
    ]


def _routed_block(att: Attachment, mask: str) -> list[str]:
    return [
        f"interface {att.port}",
        f" description {att.segment} {att.role} {att.ip}",
        " no switchport",
        f" ip address {att.ip} {mask}",
        f" ip access-group {EGRESS_ACL} out",
        " no shutdown",
    ]


def _svi_block(svi: Svi, mask: str) -> list[str]:
    return [
        f"interface Vlan{svi.vlan}",
        f" description {svi.segment} gateway",
        f" ip address {svi.address.ip} {mask}",
        f" ip access-group {acl_name(svi.segment)} in",
        " no shutdown",
    ]


def _acl_block(name: str, lines: list) -> list[str]:
    out = [f"ip access-list extended {name}"]
    out += [" " + line.text(10 * (i + 1)) for i, line in enumerate(lines)]
    return out


def render_device(model: Model, dev: Device, rules: list[Rule]) -> str:
    segs = model.segment_by_name()
    atts = [a for a in model.attachments if a.device == dev.name]
    svis = [s for s in model.svis if s.device == dev.name]
    links = [l for l in model.links if dev.name in (l.a, l.b)]
    trunks = [l for l in links if l.kind == "trunk"]

    used_ports = {a.port for a in atts}
    for l in links:
        used_ports.add(_my_port(l, dev.name)[0])
    unused = [p for p in access_ports(dev.model) if p not in used_ports] \
        if dev.role in ("access", "mgmt") else []

    vlans: dict[int, str] = {model.management_vlan: MGMT_NAME}
    if trunks:
        vlans[model.native_vlan] = NATIVE_NAME
    if unused:
        vlans[model.blackhole_vlan] = BLACKHOLE_NAME
    for a in atts:
        if a.vlan is not None:
            vlans[a.vlan] = _vlan_name(model, a.vlan)
    for s in svis:
        vlans[s.vlan] = _vlan_name(model, s.vlan)
    for l in trunks:
        for v in l.vlans:
            vlans[v] = _vlan_name(model, v)

    out: list[str] = [
        "! CyberRange-Net generated configuration. Do not edit: change topology.yaml and rebuild.",
        f"hostname {dev.name}",
        "!",
    ]
    for vid in sorted(vlans):
        out += [f"vlan {vid}", f" name {vlans[vid]}"]
    out.append("!")
    if dev.role in ("core", "dist"):
        out += ["ip routing", "!"]

    blocks: list[tuple[tuple, list[str]]] = []
    for l in trunks:
        blocks.append(((0, _natural(_my_port(l, dev.name)[0])), _trunk_block(model, l, dev.name)))
    for a in atts:
        if a.routed:
            blocks.append(((0, _natural(a.port)), _routed_block(a, str(segs[a.segment].cidr.netmask))))
        else:
            blocks.append(((0, _natural(a.port)), _access_block(a)))
    for p in unused:
        blocks.append(((0, _natural(p)), _unused_block(model, p)))
    for s in svis:
        blocks.append(((1, _natural(f"Vlan{s.vlan}")), _svi_block(s, str(segs[s.segment].cidr.netmask))))
    blocks.append(((1, _natural(f"Vlan{model.management_vlan}")), [
        f"interface Vlan{model.management_vlan}",
        f" description {MGMT_NOTE}",
        f" ip address {dev.mgmt} 255.255.255.0",
        " no shutdown",
    ]))
    for _, block in sorted(blocks, key=lambda b: b[0]):
        out += block + ["!"]

    acl_blocks: list[list[str]] = []
    for s in svis:
        acl_blocks.append(_acl_block(acl_name(s.segment), acl_for_segment(model, rules, s.segment)))
    if any(a.routed for a in atts):
        acl_blocks.append(_acl_block(EGRESS_ACL, egress_lines(model)))
    for block in sorted(acl_blocks, key=lambda b: b[0]):
        out += block + ["!"]
    out.append("end")
    return "\n".join(out) + "\n"


def render_csv(model: Model) -> str:
    segs = model.segment_by_name()
    rows: list[tuple[str, str, str, str, str, str, str]] = []
    for d in model.devices:
        rows.append((d.name, f"Vlan{model.management_vlan}", "management", "device-mgmt", str(d.mgmt),
                     str(model.addressing["management"]), str(model.management_vlan)))
    for s in model.svis:
        rows.append((s.device, f"Vlan{s.vlan}", s.segment, "gateway", str(s.address.ip),
                     str(segs[s.segment].cidr), str(s.vlan)))
    for a in model.attachments:
        rows.append((a.device, a.port, a.segment, a.role, str(a.ip), str(segs[a.segment].cidr),
                     "" if a.vlan is None else str(a.vlan)))
    rows.sort(key=lambda r: (r[0], _natural(r[1]), r[4]))
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(["device", "interface", "segment", "role", "ip", "cidr", "vlan"])
    writer.writerows(rows)
    return buf.getvalue()


def render_matrix(model: Model, rules: list[Rule]) -> str:
    return json.dumps(expected_matrix(model, rules), indent=2, sort_keys=True) + "\n"


def render_fallback_notice(model: Model) -> str:
    segs = model.segment_by_name()
    scoring = segs["scoring"].cidr
    lines = [
        "PACKET TRACER FALLBACK NOTICE",
        "",
        "This build was made with --packet-tracer-safe. Rule R8 uses a port-based substitute for",
        "the 'established' keyword, which Packet Tracer does not support. The one-way property is",
        "then enforced by destination port rather than by the TCP ACK flag. That is weaker.",
        "",
        "Substitution, one per team, on the target ingress ACL (SW-DIST-EXER):",
    ]
    for n in range(1, model.teams + 1):
        t = segs[f"target-{n}"].cidr
        src = f"{t.network_address} {t.hostmask}"
        dst = f"{scoring.network_address} {scoring.hostmask}"
        lines.append(f"  team {n}: normal   permit tcp {src} {dst} established")
        lines.append(f"  team {n}: fallback permit tcp {src} {dst} eq 80")
    lines += [
        "",
        "Effect: a SYN to TCP/80 on the scoring subnet is now permitted from each target.",
        "expected-matrix.json records target-N -> scoring tcp-syn as permit on the assumption that the",
        "verifier's tcp-syn probe to scoring uses TCP/80. Record this substitution in the lab report.",
    ]
    return "\n".join(lines) + "\n"
