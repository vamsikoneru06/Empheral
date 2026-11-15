import { useEffect, useState } from 'react';
import { api, MOCK } from './api.js';
import { usePoll } from './hooks.js';
import { errorText, fmtDuration } from './format.js';
import Leaderboard from './views/Leaderboard.jsx';
import Competitor from './views/Competitor.jsx';
import Judge from './views/Judge.jsx';
import Admin from './views/Admin.jsx';

const TABS = [
  ['leaderboard', 'Leaderboard', Leaderboard],
  ['competitor', 'Competitor', Competitor],
  ['judge', 'Judge', Judge],
  ['admin', 'Admin', Admin],
];

// Round name, status and countdowns. Server time sets the clock, so a skewed laptop
// still shows the right remaining time.
function RoundClock() {
  const { data, error, at } = usePoll(() => api.currentRound(), 5000);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!data) return <span className="clock">{error ? `Round clock: ${errorText(error)}` : 'Round clock: loading'}</span>;
  const serverNow = now + (Date.parse(data.server_time) - at);
  const left = (iso) => Date.parse(iso) - serverNow;
  return (
    <span className="clock">
      <strong>{data.name}</strong> ({data.status}), ends in {fmtDuration(left(data.ends_at))}
      {left(data.freeze_at) > 0 && <>, freezes in {fmtDuration(left(data.freeze_at))}</>}
    </span>
  );
}

export default function App() {
  const [tab, setTab] = useState('leaderboard');
  return (
    <>
      <header>
        <h1>CyberRange-Net</h1>
        <RoundClock />
        {MOCK && <span className="badge">MOCK DATA</span>}
      </header>
      <nav>
        {TABS.map(([id, label]) => (
          <button key={id} type="button" className={tab === id ? 'active' : ''} aria-pressed={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      <main>
        {/* Views stay mounted so a typed token survives a tab switch. */}
        {TABS.map(([id, , View]) => (
          <div key={id} hidden={tab !== id}>
            <View />
          </div>
        ))}
      </main>
    </>
  );
}
