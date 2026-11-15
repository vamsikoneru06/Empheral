// Containment colour rule (validation-plan.md, "Report format"):
//   green = permitted and expected, grey = denied and expected, red = any mismatch.
// Pure functions only: no React, no import.meta, so node:test can load this file.

const VERDICTS = new Set(['permit', 'deny']);

// One probe: an observed verdict against its expected verdict.
// Returns 'permitted' | 'denied' | 'mismatch'. A missing or unknown observation is a mismatch.
export function probeState(observed, expected) {
  if (!VERDICTS.has(observed) || observed !== expected) return 'mismatch';
  return observed === 'permit' ? 'permitted' : 'denied';
}

// One cell covers every probe for one source -> destination pair.
// Any mismatch makes the cell red, and so does a cell with no probes (nothing was verified).
// Otherwise it is green when any probe is permitted (mixed but matching cells are green),
// and grey when every probe is denied.
export function cellColour(states) {
  if (states.length === 0 || states.includes('mismatch')) return 'red';
  return states.includes('permitted') ? 'green' : 'grey';
}

// observedCell and expectedCell are { probe: verdict } objects for one pair.
// Probes are read from the expected cell: the expected matrix defines what must be tested.
export function cellStates(observedCell, expectedCell) {
  const obs = observedCell ?? {};
  return Object.keys(expectedCell).map((p) => probeState(obs[p], expectedCell[p]));
}

// Grid for the heatmap. Rows are the expected matrix's sources. Columns are every destination
// any source names, sorted. A pair with no expected entry (for example a segment to itself)
// is 'blank'. Matrix shape: matrix[src][dst][probe] = 'permit' | 'deny'.
export function heatmapGrid(observed, expected) {
  const srcs = Object.keys(expected);
  const cols = [...new Set(srcs.flatMap((src) => Object.keys(expected[src])))].sort();
  const rows = srcs.map((src) => ({
    src,
    cells: cols.map((dst) => {
      const exp = expected[src][dst];
      if (!exp) return { dst, colour: 'blank', title: '' };
      const obs = observed?.[src]?.[dst] ?? {};
      const detail = Object.keys(exp)
        .map((p) => `${p} expected ${exp[p]}, observed ${obs[p] ?? 'none'}`)
        .join('; ');
      return { dst, colour: cellColour(cellStates(obs, exp)), title: `${src} to ${dst}: ${detail}` };
    }),
  }));
  return { cols, rows };
}
