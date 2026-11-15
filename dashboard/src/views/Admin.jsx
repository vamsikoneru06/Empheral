import { useState } from 'react';
import { api, ApiError } from '../api.js';
import { errorText, fmtTime } from '../format.js';
import Heatmap from '../components/Heatmap.jsx';

// Plain-language hints for the refusals an operator is most likely to hit.
const HINTS = {
  round_not_running: 'Reset is only allowed between rounds. Let the running round end first.',
  verification_required: 'A round cannot become ready without a passing verification run.',
  illegal_transition: 'The round is not in a state where this action is allowed. Check its status first.',
};

function explain(label, e) {
  if (!(e instanceof ApiError)) return `${label} failed: ${errorText(e)}`;
  const hint = HINTS[e.code];
  const verb = e.status === 409 ? 'refused' : 'failed';
  return `${label} ${verb}: HTTP ${e.status} ${e.code}. ${e.message}${hint ? ` ${hint}` : ''}`;
}

const emptyRound = { name: '', image_set: '', starts_at: '', duration_minutes: '180', team_ids: '1,2,3,4' };

export default function Admin() {
  const [token, setToken] = useState('');
  const [round, setRound] = useState(emptyRound);
  const [roundId, setRoundId] = useState('');
  const [log, setLog] = useState(null); // { kind: 'ok' | 'err', text }
  const [verification, setVerification] = useState(null);
  const [verError, setVerError] = useState('');

  async function act(label, fn) {
    setLog(null);
    try {
      const r = await fn();
      const job = r?.job_id ? ` (job ${r.job_id})` : '';
      setLog({ kind: 'ok', text: `${label} accepted${job}.` });
      return r;
    } catch (err) {
      setLog({ kind: 'err', text: explain(label, err) });
      return null;
    }
  }

  async function createRound(e) {
    e.preventDefault();
    const created = await act('Create round', () =>
      api.createRound(
        {
          name: round.name.trim(),
          image_set: round.image_set.trim(),
          starts_at: new Date(round.starts_at).toISOString(),
          duration_minutes: Number(round.duration_minutes),
          team_ids: round.team_ids.split(',').map((s) => Number(s.trim())).filter(Number.isFinite),
        },
        token,
      ),
    );
    if (created?.id != null) setRoundId(String(created.id));
  }

  async function loadVerification() {
    setVerError('');
    try {
      setVerification(await api.latestVerification(token));
    } catch (err) {
      setVerification(null);
      setVerError(explain('Load verification', err));
    }
  }

  const needsToken = !token ? 'Enter the admin token first.' : null;

  return (
    <section>
      <h2>Admin</h2>
      <label className="row">Admin token <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></label>
      {needsToken && <p className="muted">{needsToken}</p>}

      <h3>Create round</h3>
      <form className="stack" onSubmit={createRound}>
        <label>Name <input value={round.name} onChange={(e) => setRound({ ...round, name: e.target.value })} required /></label>
        <label>Image set <input value={round.image_set} onChange={(e) => setRound({ ...round, image_set: e.target.value })} required /></label>
        <label>Starts at (local time) <input type="datetime-local" value={round.starts_at} onChange={(e) => setRound({ ...round, starts_at: e.target.value })} required /></label>
        <label>Duration (minutes) <input value={round.duration_minutes} onChange={(e) => setRound({ ...round, duration_minutes: e.target.value })} inputMode="numeric" required /></label>
        <label>Team ids (comma separated) <input value={round.team_ids} onChange={(e) => setRound({ ...round, team_ids: e.target.value })} required /></label>
        <button type="submit" disabled={!token}>Create round</button>
      </form>

      <h3>Round actions</h3>
      <div className="row">
        <label>Round id <input value={roundId} onChange={(e) => setRoundId(e.target.value)} inputMode="numeric" /></label>
        <button type="button" disabled={!token || !roundId} onClick={() => act('Provision', () => api.provision(roundId, token))}>Provision</button>
        <button type="button" disabled={!token || !roundId} onClick={() => act('Reset', () => api.reset(roundId, token))}>Reset to baseline</button>
        <button type="button" disabled={!token} onClick={() => act('Verification run', () => api.runVerification(token))}>Run verification</button>
      </div>
      {log && <p className={log.kind === 'ok' ? 'ok' : 'error'}>{log.text}</p>}

      <h3>Latest verification</h3>
      <button type="button" disabled={!token} onClick={loadVerification}>Load latest</button>
      {verError && <p className="error">{verError}</p>}
      {verification && (
        <>
          <p>
            <span className={verification.passed ? 'badge ok' : 'badge bad'}>{verification.passed ? 'PASSED' : 'FAILED'}</span>{' '}
            {verification.round_id == null ? 'Ad-hoc run' : `Round ${verification.round_id}`}, {verification.pairs_tested} pairs, {verification.violations} violations, ran {fmtTime(verification.ran_at)}.
          </p>
          <ul className="assertions">
            {Object.entries(verification.assertions).map(([name, ok]) => (
              <li key={name} className={ok ? 'ok' : 'bad'}>{ok ? 'pass' : 'fail'}: {name}</li>
            ))}
          </ul>
          <h3>Containment matrix</h3>
          <Heatmap observed={verification.matrix} expected={verification.expected} />
        </>
      )}
    </section>
  );
}
