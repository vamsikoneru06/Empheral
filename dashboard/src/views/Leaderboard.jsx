import { api } from '../api.js';
import { usePoll } from '../hooks.js';
import { errorText, fmtTime } from '../format.js';

export default function Leaderboard() {
  const { data, error } = usePoll(() => api.leaderboard(), 5000);
  if (!data) return error ? <p className="error">Leaderboard: {errorText(error)}</p> : <p>Loading...</p>;
  const teams = [...data.teams].sort((a, b) => a.rank - b.rank);
  return (
    <section>
      <h2>
        Leaderboard {data.frozen && <span className="badge">frozen</span>}
      </h2>
      <p className="muted">
        Round {data.round_id}, as of {fmtTime(data.as_of)}. Refreshes every 5 s.
        {error && <span className="error"> Last refresh failed: {errorText(error)}</span>}
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr><th>Rank</th><th>Team</th><th>Score</th><th>Services up</th></tr>
          </thead>
          <tbody>
            {teams.map((t) => (
              <tr key={t.team_id}>
                <td>{t.rank}</td>
                <td>{t.name}</td>
                <td>{t.score.toFixed(1)}</td>
                <td className={t.services_up === t.services_total ? 'ok' : 'warn'}>
                  {t.services_up}/{t.services_total}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
