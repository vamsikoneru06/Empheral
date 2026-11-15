"""Console table, JSON and HTML output for V6."""

from __future__ import annotations

import html
import json
from pathlib import Path


def console_table(result: dict) -> str:
    comp = result["compromised"]
    lines = [
        f"V6 compromise run from {comp['ip']} ({comp['segment']}, {comp['role']}) "
        f"on {comp['device']} {comp['interface']}",
        f"backend {result['backend']}; ports {', '.join(str(p) for p in result['ports'])}",
        "",
        f"{'step':<5}{'what':<20}{'cand':>5}{'reach':>7}{'open':>6}{'blocked':>9}  {'blocked by (layer)':<48}{'result':>7}",
        "-" * 112,
    ]
    for st in result["steps"]:
        layers = ", ".join(f"{name} x{n}" for name, n in st["blocking_layers"].items()) or "-"
        lines.append(
            f"{st['step']:<5}{st['name']:<20}{st['candidates']:>5}{len(st['reachable']):>7}"
            f"{st['open_ports']:>6}{st['blocked']:>9}  {layers[:48]:<48}{'PASS' if st['passed'] else 'FAIL':>7}"
        )
    lines.append("")
    for st in result["steps"]:
        lines.append(f"  {st['step']}: {st['criterion']}")
    lines.append("")
    lines.append(f"V6 {'PASS' if result['passed'] else 'FAIL'}")
    return "\n".join(lines)


def write_json(result: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


_CSS = """
body{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:24px;color:#1b1b1b;background:#fff}
h1{font-size:20px;margin:0 0 6px} h2{font-size:15px;margin:22px 0 6px}
.meta{color:#555;font-size:13px;margin-bottom:12px}
.banner{display:inline-block;padding:6px 12px;border-radius:4px;font-weight:600;color:#fff}
.pass{background:#2e7d32} .fail{background:#c62828}
table{border-collapse:collapse;font-size:12px;margin-bottom:8px}
th,td{border:1px solid #ddd;padding:4px 7px;text-align:left;white-space:nowrap}
th{background:#f1f1f1}
.reach{background:#ffcdd2} .open{background:#ffe0b2} .blocked{background:#c8e6c9}
.note{font-size:12px;color:#555;max-width:900px}
"""


def render_html(result: dict) -> str:
    comp = result["compromised"]
    status = "PASS" if result["passed"] else "FAIL"
    parts = [
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
        "<title>V6 compromise report</title>",
        f"<style>{_CSS}</style></head><body>",
        "<h1>V6: full compromise stays bounded</h1>",
        f"<div class=\"meta\">compromised {html.escape(comp['ip'])} ({html.escape(comp['segment'])}, "
        f"{html.escape(comp['role'])}) &middot; ran_at {html.escape(result['ran_at'])}</div>",
        f"<span class=\"banner {'pass' if result['passed'] else 'fail'}\">V6 {status}</span>",
        "<p class=\"note\">Config-level evaluation of the compiled IOS in out/*.cfg. Not live traffic. "
        "Green cells are blocked, with the enforcement layer shown. Orange cells are open ports at the filter level. "
        "Red cells are reachable.</p>",
        "<h2>Steps</h2><table><tr><th>step</th><th>what</th><th>candidates</th><th>reachable</th>"
        "<th>open ports</th><th>blocked</th><th>blocking layers</th><th>criterion</th><th>result</th></tr>",
    ]
    for st in result["steps"]:
        layers = html.escape(", ".join(f"{k} x{v}" for k, v in st["blocking_layers"].items()) or "-")
        parts.append(
            f"<tr><td>{st['step']}</td><td>{html.escape(st['name'])}</td><td>{st['candidates']}</td>"
            f"<td>{len(st['reachable'])}</td><td>{st['open_ports']}</td><td>{st['blocked']}</td>"
            f"<td>{layers}</td><td>{html.escape(st['criterion'])}</td>"
            f"<td><b>{'PASS' if st['passed'] else 'FAIL'}</b></td></tr>"
        )
    parts.append("</table><h2>Attempts</h2><table><tr><th>step</th><th>target</th><th>role</th>"
                 "<th>segment</th><th>probe</th><th>port</th><th>result</th><th>blocked by</th></tr>")
    css = {"reachable": "reach", "open": "open", "blocked": "blocked"}
    for a in result["attempts"]:
        parts.append(
            f"<tr><td>{a['step']}</td><td>{html.escape(a['target'])}</td><td>{html.escape(a['role'])}</td>"
            f"<td>{html.escape(a['segment'])}</td><td>{a['probe']}</td><td>{a['port'] if a['port'] is not None else '-'}</td>"
            f"<td class=\"{css[a['result']]}\">{a['result']}</td><td>{html.escape(a['blocked_by'] or '-')}</td></tr>"
        )
    parts.append("</table></body></html>")
    return "\n".join(parts)
