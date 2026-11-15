import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { errorText, fmtTime } from '../format.js';
import { mergeEvents, nextSinceSeq } from '../lib/timeline.js';

export default function Judge() {
  const [token, setToken] = useState('');
  const [roundId, setRoundId] = useState('');
  const [session, setSession] = useState(null); // { roundId, token } once the timeline is started
  const [events, setEvents] = useState([]);
  const [pollError, setPollError] = useState('');
  const cursor = useRef(0);
  const [adjust, setAdjust] = useState({ team_id: '', points: '', note: '' });
  const [adjustMsg, setAdjustMsg] = useState(null);

  // Default the round to the current one (public endpoint).
  useEffect(() => {
    api.currentRound().then((r) => setRoundId(String(r.id)), () => {});
  }, []);

  // Poll the ledger every 5 s. Each request asks for events after the highest seq held.
  useEffect(() => {
    if (!session) return undefined;
    let alive = true;
    cursor.current = 0;
    setEvents([]);
    const tick = () =>
      api.timeline(session.roundId, cursor.current, session.token).then(
        (page) => {
          if (!alive) return;
          cursor.current = nextSinceSeq(cursor.current, page.events);
          setEvents((held) => mergeEvents(held, page.events));
          setPollError('');
        },
        (err) => alive && setPollError(errorText(err)),
      );
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [session]);

  function start(e) {
    e.preventDefault();
    setAdjustMsg(null);
    setSession({ roundId: roundId.trim(), token });
  }

  async function submitAdjust(e) {
    e.preventDefault();
    const note = adjust.note.trim();
    const points = Number(adjust.points);
    if (!note) return setAdjustMsg({ kind: 'err', text: 'A note is required.' });
    if (!Number.isFinite(points) || points === 0) return setAdjustMsg({ kind: 'err', text: 'Points must be a non-zero number.' });
    try {
      await api.adjust({ round_id: Number(session.roundId), team_id: Number(adjust.team_id), points, note }, session.token);
      setAdjustMsg({ kind: 'ok', text: 'Adjustment recorded. It appears in the timeline on the next poll.' });
      setAdjust((a) => ({ ...a, points: '', note: '' }));
    } catch (err) {
      setAdjustMsg({ kind: 'err', text: errorText(err) });
    }
  }

  return (
    <section>
      <h2>Judge</h2>
      <form className="row" onSubmit={start}>
        <label>Round id <input value={roundId} onChange={(e) => setRoundId(e.target.value)} inputMode="numeric" required /></label>
        <label>Token <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required /></label>
        <button type="submit">Load timeline</button>
      </form>
      {pollError && <p className="error">Timeline: {pollError}</p>}

      {session && (
        <>
          <p className="muted">Round {session.roundId}, {events.length} events, newest first. Polls every 5 s from seq {cursor.current}.</p>
          <div className="scroll">
            <table>
              <thead><tr><th>Seq</th><th>Team</th><th>Kind</th><th>Points</th><th>Time</th><th>Note</th></tr></thead>
              <tbody>
                {[...events].reverse().map((ev) => (
                  <tr key={ev.seq}>
                    <td>{ev.seq}</td>
                    <td>{ev.team_id}</td>
                    <td>{ev.kind}</td>
                    <td className={ev.points < 0 ? 'bad' : 'ok'}>{ev.points > 0 ? `+${ev.points}` : ev.points}</td>
                    <td>{fmtTime(ev.occurred_at)}</td>
                    <td>{ev.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3>Manual adjustment</h3>
      {!session && <p className="muted">Load the timeline first. Adjustments use the round and token from there.</p>}
      <form className="stack" onSubmit={submitAdjust}>
        <label>Team id <input value={adjust.team_id} onChange={(e) => setAdjust({ ...adjust, team_id: e.target.value })} inputMode="numeric" required /></label>
        <label>Points (negative to deduct) <input value={adjust.points} onChange={(e) => setAdjust({ ...adjust, points: e.target.value })} inputMode="decimal" required /></label>
        <label>Note (required) <textarea value={adjust.note} onChange={(e) => setAdjust({ ...adjust, note: e.target.value })} rows={2} required /></label>
        <button type="submit" disabled={!session}>Record adjustment</button>
      </form>
      {adjustMsg && <p className={adjustMsg.kind === 'ok' ? 'ok' : 'error'}>{adjustMsg.text}</p>}
    </section>
  );
}
