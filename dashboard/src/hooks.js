import { useEffect, useState } from 'react';

// Calls fn now and then every ms. Keeps the last good data when a poll fails, and records
// when that data arrived (local ms) so callers can line up server time.
export function usePoll(fn, ms) {
  const [state, setState] = useState({ data: null, error: null, at: null });
  useEffect(() => {
    let alive = true;
    const tick = () =>
      fn().then(
        (data) => alive && setState({ data, error: null, at: Date.now() }),
        (error) => alive && setState((s) => ({ ...s, error })),
      );
    tick();
    const id = setInterval(tick, ms);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return state;
}
