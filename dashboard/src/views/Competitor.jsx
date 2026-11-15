import { useState } from 'react';
import { api } from '../api.js';
import { errorText } from '../format.js';

const VERDICT_TEXT = {
  accepted: 'Accepted.',
  wrong: 'Wrong: no such flag this round.',
  duplicate: 'Duplicate: your team has already submitted this flag.',
  self_submit: 'Rejected: that flag was planted on your own team.',
  expired: 'Expired: the round is frozen or closed.',
};

export default function Competitor() {
  const [token, setToken] = useState('');
  const [teamId, setTeamId] = useState('');
  const [team, setTeam] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [flag, setFlag] = useState('');
  const [result, setResult] = useState(null);

  async function load(e) {
    e.preventDefault();
    setLoadError('');
    setResult(null);
    try {
      setTeam(await api.team(teamId.trim(), token));
    } catch (err) {
      setTeam(null);
      setLoadError(errorText(err));
    }
  }

  async function submit(e) {
    e.preventDefault();
    setResult(null);
    try {
      const r = await api.submit(flag.trim(), token);
      setResult(r);
      setTeam((t) => (t ? { ...t, score: r.new_score ?? t.score } : t));
      if (r.verdict === 'accepted') setFlag('');
    } catch (err) {
      setResult({ error: errorText(err) });
    }
  }

  return (
    <section>
      <h2>Competitor</h2>
      <form className="row" onSubmit={load}>
        <label>Team id <input value={teamId} onChange={(e) => setTeamId(e.target.value)} inputMode="numeric" required /></label>
        <label>Token <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required /></label>
        <button type="submit">Load team</button>
      </form>
      {loadError && <p className="error">{loadError}</p>}

      {team && (
        <>
          <h3>{team.name} <span className="muted">score {team.score.toFixed(1)}</span></h3>
          <p className="muted">Pod {team.pod_subnet}, targets {team.target_subnet}</p>
          <div className="scroll">
            <table>
              <thead><tr><th>Role</th><th>IP</th><th>Status</th></tr></thead>
              <tbody>
                {team.targets.map((t) => (
                  <tr key={t.ip}>
                    <td>{t.role}</td>
                    <td>{t.ip}</td>
                    <td className={t.status === 'up' ? 'ok' : 'bad'}>{t.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3>Submit a flag</h3>
      <form className="row" onSubmit={submit}>
        <label>
          Flag (64 hex)
          <input
            value={flag}
            onChange={(e) => setFlag(e.target.value)}
            pattern="[0-9a-fA-F]{64}"
            title="64 hexadecimal characters"
            className="wide"
            required
          />
        </label>
        <button type="submit" disabled={!token}>Submit</button>
      </form>
      {result?.error && <p className="error">{result.error}</p>}
      {result && !result.error && (
        <p className={result.verdict === 'accepted' ? 'ok' : 'warn'}>
          {VERDICT_TEXT[result.verdict] ?? result.verdict}
          {result.verdict === 'accepted' && ` +${result.points} points${result.first_blood ? ', first blood' : ''}.`}
        </p>
      )}
    </section>
  );
}
