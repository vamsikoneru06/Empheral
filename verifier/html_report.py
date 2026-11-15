"""Single self-contained HTML heatmap. Inline CSS only, no scripts, no external assets.

Green: permitted and expected. Grey: denied and expected. Red: any mismatch.
"""

from __future__ import annotations

import html

from .expected import ExpectedMatrix
from .report import status_text

_CSS = """
body{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:24px;color:#1b1b1b;background:#fff}
h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:22px 0 8px}
.meta{color:#555;font-size:13px;margin-bottom:12px}
.banner{display:inline-block;padding:6px 12px;border-radius:4px;font-weight:600;color:#fff}
.pass{background:#2e7d32} .fail{background:#c62828}
table{border-collapse:collapse;font-size:12px;margin-bottom:8px}
th,td{border:1px solid #fff;padding:5px 7px;text-align:center;white-space:nowrap}
th{background:#f1f1f1;font-weight:600} th.row{text-align:left}
.ok-permit{background:#66bb6a;color:#fff} .ok-deny{background:#cfd4d9;color:#333}
.bad{background:#e53935;color:#fff;font-weight:700}
ul.asserts{list-style:none;padding:0;font-size:13px} ul.asserts li{margin:3px 0}
.legend span{display:inline-block;padding:3px 8px;margin-right:8px;font-size:12px;border-radius:3px}
.note{font-size:12px;color:#555;max-width:900px}
"""


def _cell(src: str, dst: str, probe: str, observed: dict, expected: ExpectedMatrix, layers: dict) -> str:
    obs = observed[src][dst][probe]
    want = expected.matrix[src][dst][probe]
    layer = layers[src][dst][probe]
    tip = f"{src} -> {dst} [{probe}] observed {obs}, expected {want}"
    if layer:
        tip += f", blocked by {layer}"
    if obs != want:
        return f'<td class="bad" title="{html.escape(tip)}">{html.escape(obs)}<br>exp {html.escape(want)}</td>'
    css = "ok-permit" if obs == "permit" else "ok-deny"
    label = "permit" if obs == "permit" else "deny"
    return f'<td class="{css}" title="{html.escape(tip)}">{label}</td>'


def render_html(report: dict, expected: ExpectedMatrix) -> str:
    observed = report["matrix"]
    layers = report["blocking_layers"]
    sources = expected.sources()
    dests = sorted(seg.name for seg in expected.segments)
    status = "PASS" if report["passed"] else "FAIL"
    parts = [
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
        "<title>Containment matrix</title>",
        f"<style>{_CSS}</style></head><body>",
        "<h1>Containment matrix</h1>",
        f"<div class=\"meta\">ran_at {html.escape(report['ran_at'])} &middot; profile {html.escape(report['profile'])}"
        f" &middot; {report['pairs_tested']} pairs &middot; {report['probes']} probes"
        f" &middot; violations {report['violations']}</div>",
        f"<span class=\"banner {'pass' if report['passed'] else 'fail'}\">{status}</span>",
        "<p class=\"note\">Config-level evaluation of the compiled IOS in out/*.cfg. This is not live packet "
        "traffic. Rows are controlled sources. Columns are destinations. Institutional and management are "
        "destinations only.</p>",
        "<div class=\"legend\">"
        "<span class=\"ok-permit\">permit, expected</span>"
        "<span class=\"ok-deny\">deny, expected</span>"
        "<span class=\"bad\">mismatch</span></div>",
        "<h2>Assertions</h2><ul class=\"asserts\">",
    ]
    for name, ok in report["assertions"].items():
        parts.append(f"<li>{status_text(ok)} &mdash; {html.escape(name)}</li>")
    parts.append("</ul>")
    parts.append(
        f"<p class=\"note\">Management-deny lines watched: {report['mgmt_deny_lines']}. "
        f"Hits: {report['mgmt_acl_hits']}. They sit on the core, which no modelled packet reaches, so the "
        "count is zero by construction.</p>"
    )
    for probe in expected.probes:
        parts.append(f"<h2>Probe: {html.escape(probe)}</h2>")
        parts.append("<table><tr><th class=\"row\">source \\ destination</th>")
        parts.extend(f"<th>{html.escape(d)}</th>" for d in dests)
        parts.append("</tr>")
        for src in sources:
            parts.append(f"<tr><th class=\"row\">{html.escape(src)}</th>")
            for dst in dests:
                if dst == src:
                    parts.append("<td style=\"background:#fafafa\">&middot;</td>")
                else:
                    parts.append(_cell(src, dst, probe, observed, expected, layers))
            parts.append("</tr>")
        parts.append("</table>")
    if report["violation_details"]:
        parts.append("<h2>Violations</h2><table><tr><th>source</th><th>destination</th><th>probe</th>"
                     "<th>expected</th><th>observed</th><th>blocking layer</th></tr>")
        for v in report["violation_details"]:
            parts.append(
                "<tr>"
                + "".join(
                    f"<td>{html.escape(str(v[k] if v[k] is not None else '-'))}</td>"
                    for k in ("source", "destination", "probe", "expected", "observed", "blocking_layer")
                )
                + "</tr>"
            )
        parts.append("</table>")
    parts.append("</body></html>")
    return "\n".join(parts)
