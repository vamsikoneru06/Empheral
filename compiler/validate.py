"""Validation table from config-compiler.md. Every failure is fatal; all failures are reported at once."""

from __future__ import annotations

from collections import Counter

from .model import REQUIRED_ROLES, Model, port_exists
from .policy import SOURCE_KINDS, acl_for_segment, build_rules, egress_lines, find_shadowed

BLOCK_OF_KIND = {
    "pod": "pods",
    "target": "targets",
    "scoring": "institutional",
    "institutional": "institutional",
    "management": "management",
}


def validate(model: Model) -> list[str]:
    errors: list[str] = []
    err = errors.append

    segs = model.segments
    seg_by_name = {s.name: s for s in segs}
    devices = {d.name: d for d in model.devices}

    # No duplicate VLAN id
    for vid, count in sorted(Counter(v for v, _ in model.vlan_claims).items()):
        if count > 1:
            owners = [o for v, o in model.vlan_claims if v == vid]
            err(f"duplicate VLAN {vid} claimed by {', '.join(owners)}")

    # No overlapping subnet; every segment inside its address block
    for i, a in enumerate(segs):
        for b in segs[i + 1:]:
            if a.cidr.overlaps(b.cidr):
                err(f"subnets overlap: {a.name} {a.cidr} and {b.name} {b.cidr}")
    for s in segs:
        block = model.addressing[BLOCK_OF_KIND[s.kind]]
        if not s.cidr.subnet_of(block):
            err(f"{s.name} {s.cidr} is outside its address block {block}")

    # Every team has identical target roles
    if set(model.roles) != set(REQUIRED_ROLES):
        err(f"target_roles must define exactly {', '.join(REQUIRED_ROLES)}; got {', '.join(sorted(model.roles))}")
    offsets = list(model.roles.values())
    if len(set(offsets)) != len(offsets):
        err("target_roles offsets must be unique")
    for s in segs:
        if s.kind == "target":
            for role, off in model.roles.items():
                if not 1 <= off <= s.cidr.num_addresses - 2:
                    err(f"target role {role} offset {off} is outside usable range of {s.name} {s.cidr}")
    roles_on_team: dict[str, set[str]] = {}
    for a in model.attachments:
        if a.segment.startswith("target-"):
            roles_on_team.setdefault(a.segment, set()).add(a.role)
    for s in segs:
        if s.kind == "target" and roles_on_team.get(s.name, set()) != set(model.roles):
            err(f"{s.name} does not carry the full target role set {sorted(model.roles)}")

    # Team structure: exactly one pod switch and one target switch per team
    for n in range(1, model.teams + 1):
        for kind in ("pod", "target"):
            found = [d for d in model.devices if d.kind == kind and d.team == n]
            if len(found) != 1:
                err(f"team {n} needs exactly one {kind} switch, found {len(found)}")
    for d in model.devices:
        if d.kind is not None and (d.team is None or not 1 <= d.team <= model.teams):
            err(f"device {d.name} has team {d.team} outside 1..{model.teams}")

    # Unique device names and management IPs; management IP in the management block
    names = [d.name for d in model.devices]
    for name, count in Counter(names).items():
        if count > 1:
            err(f"duplicate device name {name}")
    mgmt_block = model.addressing["management"]
    mgmt_seen: Counter = Counter(d.mgmt for d in model.devices)
    for d in model.devices:
        if d.mgmt not in mgmt_block:
            err(f"device {d.name} management IP {d.mgmt} is outside {mgmt_block}")
        if mgmt_seen[d.mgmt] > 1:
            err(f"management IP {d.mgmt} used more than once")

    # Management switch has no uplink (architecture rule 6)
    for l in model.links:
        for end in (l.a, l.b):
            if end in devices and devices[end].role == "mgmt":
                err(f"management switch {end} has an uplink ({l.a} {l.a_port} <-> {l.b} {l.b_port}); it must have none")

    # Every trunk: explicit allowed list, known VLANs, no native VLAN, ports exist, R2 uplink rule
    known_vlans = {v for v, _ in model.vlan_claims}
    for l in model.links:
        label = f"{l.a} {l.a_port} <-> {l.b} {l.b_port}"
        if l.kind != "trunk":
            err(f"link {label} has unsupported kind {l.kind!r}")
        if not l.vlans:
            err(f"trunk {label} has no explicit allowed VLAN list")
        for v in l.vlans:
            if v not in known_vlans:
                err(f"trunk {label} allows unknown VLAN {v}")
        if model.native_vlan in l.vlans:
            err(f"trunk {label} allows the native VLAN {model.native_vlan}")
        for end, port in ((l.a, l.a_port), (l.b, l.b_port)):
            if end not in devices:
                err(f"link {label} references unknown device {end}")
            elif not port_exists(devices[end].model, port):
                err(f"{end} has no port {port}")
        for end in (l.a, l.b):
            d = devices.get(end)
            if d is not None and d.kind in ("pod", "target") and d.team in range(1, model.teams + 1):
                seg = seg_by_name[f"{d.kind}-{d.team}"]
                if tuple(sorted(l.vlans)) != (seg.vlan,):
                    err(f"R2: uplink of {end} must carry only VLAN {seg.vlan}, got {list(l.vlans)}")

    # Port attachments: device exists, port exists, no port used twice, native carries no hosts
    used: Counter = Counter()
    for l in model.links:
        used[(l.a, l.a_port)] += 1
        used[(l.b, l.b_port)] += 1
    for a in model.attachments:
        d = devices.get(a.device)
        if d is None:
            err(f"attachment {a.segment} {a.role} references unknown device {a.device}")
            continue
        if not port_exists(d.model, a.port):
            err(f"{a.device} has no port {a.port}")
        used[(a.device, a.port)] += 1
        if a.vlan == model.native_vlan:
            err(f"native VLAN {model.native_vlan} carries host {a.segment} {a.role} on {a.device} {a.port}")
    for (dev, port), count in sorted(used.items()):
        if count > 1:
            err(f"{dev} {port} is used {count} times")

    # Native VLAN is not 1 and carries no SVI
    if model.native_vlan == 1:
        err("native VLAN must not be 1")
    for s in model.svis:
        if s.vlan == model.native_vlan:
            err(f"native VLAN {model.native_vlan} has an SVI on {s.device}")

    # Every host address inside its segment; no address collisions across hosts, SVIs and management
    for a in model.attachments:
        seg = seg_by_name.get(a.segment)
        if seg is not None and a.ip not in seg.cidr:
            err(f"{a.ip} for {a.segment} {a.role} is outside {seg.cidr}")
    addresses = [str(s.address.ip) for s in model.svis] + [str(a.ip) for a in model.attachments] \
        + [str(d.mgmt) for d in model.devices]
    for addr, count in sorted(Counter(addresses).items()):
        if count > 1:
            err(f"address {addr} is assigned {count} times")
    scoring_svis = [s for s in model.svis if s.segment == "scoring"]
    dist_names = {d.name for d in model.devices if d.role == "dist" and d.zone == "exercise"}
    for s in scoring_svis:
        if s.device not in dist_names:
            err(f"scoring SVI must sit on the exercise distribution switch, not {s.device}")

    # No ACL line shadowed by an earlier line
    rules = build_rules(model)
    for seg in segs:
        if seg.kind in SOURCE_KINDS:
            lines = acl_for_segment(model, rules, seg.name)
            for i, j in find_shadowed(lines):
                err(f"ACL for {seg.name}: line {j + 1} is shadowed by line {i + 1}")
    for i, j in find_shadowed(egress_lines(model)):
        err(f"core egress ACL: line {j + 1} is shadowed by line {i + 1}")

    return errors
