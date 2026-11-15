import { heatmapGrid } from '../lib/matrix.js';

const LETTER = { green: 'P', grey: 'D', red: 'X', blank: '' };
const WORDS = { green: 'permitted and expected', grey: 'denied and expected', red: 'mismatch', blank: 'no policy' };

// Containment matrix: rows are sources, columns are destinations. Colour is not the only cue:
// each cell also carries P (permitted), D (denied) or X (mismatch).
export default function Heatmap({ observed, expected }) {
  if (!expected) return <p className="muted">The verification response has no expected matrix.</p>;
  if (!observed) return <p className="muted">The verification response has no observed matrix.</p>;
  const { cols, rows } = heatmapGrid(observed, expected);
  const reds = rows.reduce((n, r) => n + r.cells.filter((c) => c.colour === 'red').length, 0);
  return (
    <div>
      <p>
        <strong>{reds === 0 ? 'No mismatches' : `${reds} mismatched cell(s)`}</strong>
        {` across ${rows.length} sources and ${cols.length} destinations.`}
      </p>
      <ul className="legend">
        <li><span className="swatch c-green" /> permitted and expected</li>
        <li><span className="swatch c-grey" /> denied and expected</li>
        <li><span className="swatch c-red" /> mismatch</li>
      </ul>
      <div className="scroll">
        <table className="heat">
          <thead>
            <tr>
              <th>src / dst</th>
              {cols.map((c) => <th key={c} scope="col">{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.src}>
                <th scope="row">{r.src}</th>
                {r.cells.map((c) => (
                  <td
                    key={c.dst}
                    className={`c-${c.colour}`}
                    title={c.title}
                    aria-label={`${c.dst}: ${WORDS[c.colour]}`}
                  >
                    {LETTER[c.colour]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        Each cell covers the probes for one pair (icmp, tcp-syn, tcp-ack, udp). This is a
        config-level evaluation of the compiled device configs, not live packets.
      </p>
    </div>
  );
}
