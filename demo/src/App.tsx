import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { animate, motion, useMotionValue, useTransform } from 'framer-motion';
import { Key } from './Key';
import { Landing } from './Landing';
import { Player, type PlayMode } from './Player';
import { ScrollRail } from './ScrollRail';
import { CHECK_NAME, D, PROBE_NAME, evaluate, label, ruleText, shortLabel, teamOf, type Decision } from './rules';
import { COL, RangeScene, type CamPreset } from './scene';
import type { Probe } from './types';
import { ScrollTrigger, gsap, reduced, scrollToId, wait } from './util';

// ---------- the tour ----------

type Row = { value: number; of?: number; label: string };
type Readout =
  | { kind: 'note'; text: string }
  | { kind: 'decision'; src: string; dst: string; probe: Probe; ev: Decision; pending: boolean }
  | { kind: 'counts'; status: 'run' | 'ok' | 'bad'; title: string; rows: Row[]; note?: string };

interface StepCtx {
  alive: () => boolean;
  say: (r: Readout) => void;
  send: (src: string, dst: string, permit: boolean, speed?: number) => Promise<void>;
  /** A pause-aware wait: it stops counting while the player is paused. */
  wait: (ms: number) => Promise<void>;
  progress: (fraction: number) => void;
  scene: RangeScene | null;
}
interface Step { title: string; text: string; cue: string; cam: CamPreset; focus: string[] | null; run: (c: StepCtx) => Promise<void> }

const OWN = D.run.compromised.segment;
const OWN_TEAM = teamOf(OWN);
const ATTEMPTS = D.run.attempts.map(([, target, segment, probe, , result]) => ({ target, segment, probe, blocked: result === 'blocked' }));
const OVERVIEW: CamPreset = { th: 0, ph: 42, r: 31, t: [0, 0, 0] };

async function show(c: StepCtx, src: string, dst: string, probe: Probe) {
  const ev = evaluate(src, dst, probe);
  c.say({ kind: 'decision', src, dst, probe, ev, pending: true });
  await c.send(src, dst, ev.permit);
  if (c.alive()) c.say({ kind: 'decision', src, dst, probe, ev, pending: false });
  await c.wait(700);
}

/** Show a list of packets one after another, filling the step's progress as each lands. */
async function series(c: StepCtx, list: [string, string, Probe][]) {
  for (let i = 0; i < list.length; i++) {
    if (!c.alive()) return;
    await show(c, ...list[i]);
    c.progress((i + 1) / list.length);
  }
}

/** Fire many packets on a fixed beat and report counts as they land. */
async function sweep<T>(c: StepCtx, items: T[], beat: number, fire: (item: T) => Promise<void>, landed: (item: T, done: number) => void) {
  let done = 0;
  const flights: Promise<void>[] = [];
  for (const item of items) {
    if (!c.alive()) return false;
    flights.push(fire(item).then(() => {
      if (!c.alive()) return;
      done += 1;
      landed(item, done);
      c.progress(done / items.length);
    }));
    await c.wait(c.scene ? beat : 1);
  }
  await Promise.all(flights);
  return c.alive();
}

const STEPS: Step[] = [
  {
    title: 'The range at a glance',
    text: 'Four teams compete. Each team has workstations (the solid white block) and its own identical copy of six target machines (the outlined stack). Every packet between networks must pass the checkpoint switch in the middle, and its rules decide what gets through.',
    cue: 'One switch, nine rule lists, all generated from one file: topology.yaml.',
    cam: OVERVIEW, focus: null,
    run: async c => {
      for (let k = 1; k <= 4 && c.alive(); k++) { c.scene?.pulse(`island-${k}`); c.progress(k / 5); await c.wait(450); }
      if (c.alive()) { c.scene?.flashShield(COL.gate); c.progress(1); await c.wait(600); }
    },
  },
  {
    title: 'Allowed: a team attacks its own targets',
    text: 'Teams attack only their own copy of the targets. The checkpoint lets Team 1’s workstations reach Team 1’s targets, and nothing else.',
    cue: 'Team 1 sends a ping, then opens a connection.',
    cam: { th: -28, ph: 34, r: 18, t: [-5, 0, -3] }, focus: ['pod-1', 'target-1'],
    run: c => series(c, [['pod-1', 'target-1', 'icmp'], ['pod-1', 'target-1', 'tcp-syn']]),
  },
  {
    title: 'Blocked: one team tries to reach another',
    text: 'A packet aimed at another team stops at the checkpoint. A team cannot attack another team, or even see it.',
    cue: 'Team 1 tries three networks that belong to other teams.',
    cam: { th: -20, ph: 40, r: 22, t: [-4, 0, 0] }, focus: ['pod-1', 'target-2', 'pod-3', 'target-4'],
    run: c => series(c, [['pod-1', 'target-2', 'tcp-syn'], ['pod-1', 'pod-3', 'icmp'], ['pod-1', 'target-4', 'udp']]),
  },
  {
    title: 'The scoring server checks every target',
    text: 'The scoring server checks each target to see which services are still running. It is the only machine allowed to reach every team.',
    cue: 'The scoring server contacts each team’s targets in turn.',
    cam: { th: 20, ph: 42, r: 24, t: [0, 0, -1] }, focus: ['scoring', 'target-1', 'target-2', 'target-3', 'target-4'],
    run: c => series(c, [1, 2, 3, 4].map(k => ['scoring', `target-${k}`, 'tcp-syn'] as [string, string, Probe])),
  },
  {
    title: 'One way only',
    text: 'A target can answer the scoring server, but it can never start a conversation with it. So an attacker who takes over a target cannot attack the scoring server.',
    cue: 'First a reply, then an attempt to start a connection.',
    cam: { th: 12, ph: 32, r: 19, t: [1, 0, -5] }, focus: ['target-1', 'scoring'],
    run: c => series(c, [['target-1', 'scoring', 'tcp-ack'], ['target-1', 'scoring', 'tcp-syn']]),
  },
  {
    title: 'The college and management networks stay out of reach',
    text: 'Nothing in the range can reach the college network or the network that manages the switches. The management network has no cable to the range at all.',
    cue: 'Three attempts at networks outside the range.',
    cam: { th: 32, ph: 34, r: 23, t: [3, 0, 1] }, focus: ['pod-2', 'target-3', 'institutional-a', 'management'],
    run: c => series(c, [['pod-2', 'institutional-a', 'icmp'], ['target-3', 'institutional-b', 'tcp-syn'], ['pod-2', 'management', 'udp']]),
  },
  {
    title: 'A breach: one target is taken over',
    text: `Say an attacker fully controls Team ${OWN_TEAM}’s web server (${D.run.compromised.ip}). The simulator makes it try every address in the range: a ping and eight connection attempts to each one, ${ATTEMPTS.length} tries in all. This replays a real simulator run.`,
    cue: `${ATTEMPTS.length} tries start in a moment.`,
    cam: { th: -8, ph: 48, r: 28, t: [-1, 0, 0] }, focus: null,
    run: async c => {
      let done = 0, blocked = 0;
      const inside = new Set<string>(), outside = new Set<string>();
      const report = (fin: boolean) => c.say({
        kind: 'counts',
        status: fin ? (outside.size ? 'bad' : 'ok') : 'run',
        title: fin ? (outside.size ? 'Breach escaped' : 'Breach contained') : 'Sweeping the range',
        rows: [
          { value: done, of: ATTEMPTS.length, label: 'tries finished' },
          { value: blocked, label: 'blocked at the checkpoint' },
          { value: inside.size, label: `machines reached inside Team ${OWN_TEAM}` },
          { value: outside.size, label: 'machines reached outside it' },
        ],
        note: fin ? `Simulator verdict: ${D.run.passed ? 'PASS' : 'FAIL'}. Every block names the rule that stopped it.` : undefined,
      });
      report(false);
      const finished = await sweep(c, ATTEMPTS, 22, a => c.send(OWN, a.segment, !a.blocked, 2.4), (a, n) => {
        done = n;
        if (a.blocked) blocked += 1;
        else (teamOf(a.segment) === OWN_TEAM ? inside : outside).add(a.target);
        if (n % 6 === 0 || n === ATTEMPTS.length) report(false);
      });
      if (finished) report(true);
    },
  },
  {
    title: 'Proof: all 396 cases checked',
    text: `The verifier asks the generated rules every question: ${D.sources.length} senders, every receiver, four kinds of traffic. Each answer must match the policy the compiler wrote down. This replay works out each answer from the rules and compares it with the verifier’s result.`,
    cue: `All ${D.probeCount} cases replay in a moment.`,
    cam: { th: 0, ph: 58, r: 30, t: [0, 0, 0] }, focus: null,
    run: async c => {
      const cases = D.sources.flatMap(s => Object.keys(D.matrix[s]).flatMap(d => D.probes.map(p => {
        const ev = evaluate(s, d, p);
        return { s, d, permit: ev.permit, ok: (ev.permit ? 'permit' : 'deny') === D.matrix[s][d][p] };
      })));
      const total = cases.length;
      let done = 0, match = 0;
      const report = (fin: boolean) => c.say({
        kind: 'counts',
        status: fin ? (match === total ? 'ok' : 'bad') : 'run',
        title: fin ? `${match} of ${total} match` : 'Checking every case',
        rows: [{ value: done, of: total, label: 'cases checked' }, { value: match, label: 'match the policy' }],
        note: fin ? 'Three deliberate mistakes were also planted, and the verifier caught all three. They are listed further down.' : undefined,
      });
      report(false);
      const finished = await sweep(c, cases, 14, k => c.send(k.s, k.d, k.permit, 3), (k, n) => {
        done = n;
        if (k.ok) match += 1;
        if (n % 8 === 0 || n === total) report(false);
      });
      if (finished) report(true);
    },
  },
];

// ---------- small pieces ----------

function Num({ value }: { value: number }) {
  const mv = useMotionValue(value);
  const text = useTransform(mv, v => Math.round(v).toString());
  useEffect(() => {
    const ctl = animate(mv, value, { duration: reduced ? 0 : 0.35, ease: 'easeOut' });
    return () => ctl.stop();
  }, [mv, value]);
  return <motion.span>{text}</motion.span>;
}

function ReadoutView({ r }: { r: Readout }) {
  const key = r.kind === 'decision' ? `d-${r.src}-${r.dst}-${r.probe}-${r.pending}` : r.kind;
  return (
    <div className="readout" aria-live="polite">
      {/* Slide only, never fade from invisible: the text must stay readable even if animation frames pause. */}
      <motion.div key={key} initial={reduced ? false : { y: 8 }} animate={{ y: 0 }} transition={{ duration: 0.2, ease: 'easeOut' }}>
        {r.kind === 'note' && <span className="what">{r.text}</span>}
        {r.kind === 'decision' && <Decided r={r} />}
        {r.kind === 'counts' && (
          <>
            <motion.div className={`v ${r.status === 'run' ? 'wait' : r.status}`} key={r.title} initial={{ scale: 0.92 }} animate={{ scale: 1 }}>{r.title}</motion.div>
            <div className="counts">
              {r.rows.map(row => (
                <div key={row.label}>
                  <b><Num value={row.value} />{row.of !== undefined && <> / {row.of}</>}</b>
                  <span>{row.label}</span>
                </div>
              ))}
            </div>
            {r.note && <div className="what">{r.note}</div>}
          </>
        )}
      </motion.div>
    </div>
  );
}

function Decided({ r }: { r: Extract<Readout, { kind: 'decision' }> }) {
  return (
    <>
      {r.pending
        ? <div className="v wait">In transit</div>
        : <motion.div className={`v ${r.ev.permit ? 'ok' : 'bad'}`} initial={{ scale: 0.85 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 18 }}>
            {r.ev.permit ? 'Allowed' : 'Blocked at the checkpoint'}
          </motion.div>}
      <div className="what">{label(r.src)} to {label(r.dst)} · {PROBE_NAME[r.probe]}</div>
      {!r.pending && <code>{ruleText(r.ev)}</code>}
    </>
  );
}

// ---------- the app ----------

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<RangeScene | null>(null);
  const gen = useRef(0);
  const modeRef = useRef<PlayMode>('idle');
  const pausedRef = useRef(false);
  const startedRef = useRef(false);
  const doneRef = useRef(false);
  const [noGL, setNoGL] = useState(false);
  const [tab, setTab] = useState<'tour' | 'try'>('tour');
  const [step, setStep] = useState(0);
  const [progress, setProgress] = useState(0);
  const [mode, setModeState] = useState<PlayMode>('idle');
  const [readout, setReadout] = useState<Readout>({ kind: 'note', text: 'Press Play to start the guided tour, or step through it with the arrow keys below the model.' });

  const setMode = (m: PlayMode) => { modeRef.current = m; setModeState(m); };

  const send = useCallback((src: string, dst: string, permit: boolean, speed = 1) =>
    sceneRef.current ? sceneRef.current.send(src, dst, permit, speed) : wait(speed > 1 ? 1 : 400), []);

  const pwait = useCallback(async (ms: number) => {
    let left = ms;
    while (left > 0) {
      const slice = Math.min(left, 40);
      await wait(slice);
      if (!pausedRef.current) left -= slice;
    }
  }, []);

  const unpause = () => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    sceneRef.current?.resume();
  };

  const runStep = useCallback(async (i: number): Promise<void> => {
    const my = ++gen.current;
    const alive = () => my === gen.current;
    startedRef.current = true;
    doneRef.current = false;
    if (pausedRef.current) {
      pausedRef.current = false;
      sceneRef.current?.resume();
      if (modeRef.current === 'paused') setMode('idle');
    }
    const sc = sceneRef.current;
    sc?.clear();
    const s = STEPS[i];
    setStep(i);
    setProgress(0);
    setReadout({ kind: 'note', text: s.cue });
    sc?.focus(s.focus);
    sc?.camTo(s.cam);
    await pwait(reduced ? 100 : 900);
    if (!alive()) return;
    await s.run({
      alive, send, scene: sc, wait: pwait,
      say: r => { if (alive()) setReadout(r); },
      progress: f => { if (alive()) setProgress(f); },
    });
    if (!alive()) return;
    doneRef.current = true;
    setProgress(1);
    if (modeRef.current !== 'playing') return;
    if (i === STEPS.length - 1) { setMode('idle'); return; }
    await pwait(2600);
    if (alive() && modeRef.current === 'playing') void runStep(i + 1);
  }, [send, pwait]);

  useEffect(() => {
    let cancelled = false;
    // The 3D labels are drawn with the page fonts, so give the fonts a moment to load first.
    const fonts = document.fonts ? Promise.race([document.fonts.ready, wait(1500)]) : Promise.resolve();
    void fonts.then(() => {
      if (cancelled) return;
      try {
        sceneRef.current = new RangeScene(canvasRef.current as HTMLCanvasElement, hostRef.current as HTMLDivElement, reduced);
        sceneRef.current.camTo(OVERVIEW);
      } catch {
        setNoGL(true);
      }
      ScrollTrigger.refresh();
    });
    return () => { cancelled = true; gen.current += 1; sceneRef.current?.dispose(); sceneRef.current = null; };
  }, []);

  // ---- player ----
  const play = () => {
    if (tab !== 'tour') setTab('tour');
    if (pausedRef.current) { unpause(); setMode('playing'); return; }
    setMode('playing');
    if (!startedRef.current) void runStep(step);
    else if (doneRef.current) void runStep(step < STEPS.length - 1 ? step + 1 : 0);
  };
  const pause = () => { pausedRef.current = true; sceneRef.current?.pause(); setMode('paused'); };
  const jump = (i: number) => { if (tab !== 'tour') setTab('tour'); void runStep(i); };

  const enter = () => scrollToId('model', () => { setMode('playing'); void runStep(0); });

  const selectTab = (t: 'tour' | 'try') => {
    setTab(t);
    if (t === 'try') {
      gen.current += 1;
      unpause();
      setMode('idle');
      sceneRef.current?.clear();
      sceneRef.current?.focus(null);
      sceneRef.current?.camTo(OVERVIEW);
    } else {
      void runStep(step);
    }
  };

  return (
    <>
      <ScrollRail />
      <div className="wrap">
        <Landing onEnter={enter} />

        <section className="model" id="model">
          <div className="model-head">
            <h2 className="reveal">The model</h2>
            <p className="small">Press Play, or drag the model to turn it.</p>
          </div>
          <div className="stage">
            <div className="scene" ref={hostRef}>
              <canvas ref={canvasRef} aria-label="3D model of the range network" hidden={noGL} />
              {noGL && <div className="nogl">This browser cannot show the 3D model. The tour text, the results and everything below still work.</div>}
              <div className="legend" aria-hidden="true">
                <span><i className="k-solid" />Workstations</span>
                <span><i className="k-outline" />Targets</span>
                <span><i className="k-ring" />Checkpoint</span>
                <span><i className="k-allow" />Allowed</span>
                <span><i className="k-block" />Blocked</span>
              </div>
              {!noGL && <p className="hint">Drag to turn</p>}
              {mode === 'paused' && <p className="paused-tag">Paused</p>}
            </div>

            <aside className="panel">
              <div className="tabs" role="tablist">
                <Key role="tab" on={tab === 'tour'} aria-selected={tab === 'tour'} onClick={() => selectTab('tour')}>Guided tour</Key>
                <Key role="tab" on={tab === 'try'} aria-selected={tab === 'try'} onClick={() => selectTab('try')}>Try it yourself</Key>
              </div>
              {tab === 'tour' ? (
                <div className="pane" role="tabpanel">
                  <motion.div key={step} className="pane" initial={reduced ? false : { x: 18 }} animate={{ x: 0 }} transition={{ duration: 0.25, ease: 'easeOut' }}>
                    <p className="stepno">Step {step + 1} of {STEPS.length}</p>
                    <h3 className="step-title">{STEPS[step].title}</h3>
                    <p>{STEPS[step].text}</p>
                  </motion.div>
                  <ReadoutView r={readout} />
                </div>
              ) : (
                <TryPane sceneRef={sceneRef} gen={gen} send={send} />
              )}
            </aside>

            <Player
              steps={STEPS.map(s => s.title)} step={step} progress={progress} mode={mode}
              onPlay={play} onPause={pause}
              onPrev={() => jump(Math.max(0, step - 1))}
              onNext={() => jump(step < STEPS.length - 1 ? step + 1 : 0)}
              onReplay={() => jump(step)}
              onJump={jump}
            />
          </div>
        </section>

        <Evidence />
      </div>
    </>
  );
}

function TryPane({ sceneRef, gen, send }: {
  sceneRef: React.MutableRefObject<RangeScene | null>;
  gen: React.MutableRefObject<number>;
  send: (src: string, dst: string, permit: boolean, speed?: number) => Promise<void>;
}) {
  const [src, setSrc] = useState('pod-1');
  const [dst, setDst] = useState('target-1');
  const [probe, setProbe] = useState<Probe>('tcp-syn');
  const [out, setOut] = useState<Readout>({ kind: 'note', text: 'The result and the rule that decided it appear here.' });
  const dests = Object.keys(D.matrix[src]);

  const changeSrc = (s: string) => {
    setSrc(s);
    const opts = Object.keys(D.matrix[s]);
    if (!opts.includes(dst)) setDst(opts.includes('target-1') ? 'target-1' : opts[0]);
  };
  const fire = async () => {
    const ev = evaluate(src, dst, probe);
    sceneRef.current?.focus([src, dst]);
    setOut({ kind: 'decision', src, dst, probe, ev, pending: true });
    const my = gen.current;
    await send(src, dst, ev.permit);
    if (my === gen.current) setOut({ kind: 'decision', src, dst, probe, ev, pending: false });
  };

  return (
    <motion.div className="pane" role="tabpanel" initial={reduced ? false : { x: 18 }} animate={{ x: 0 }}>
      <h3 className="step-title">Send your own packet</h3>
      <p className="small">Pick who sends, who receives, and what kind of traffic. The checkpoint applies its real rules.</p>
      <label className="field">From
        <select value={src} onChange={e => changeSrc(e.target.value)}>{D.sources.map(s => <option key={s} value={s}>{label(s)}</option>)}</select>
      </label>
      <label className="field">To
        <select value={dst} onChange={e => setDst(e.target.value)}>{dests.map(d => <option key={d} value={d}>{label(d)}</option>)}</select>
      </label>
      <label className="field">Kind of traffic
        <select value={probe} onChange={e => setProbe(e.target.value as Probe)}>{D.probes.map(p => <option key={p} value={p}>{PROBE_NAME[p]}</option>)}</select>
      </label>
      <Key look="primary" onClick={() => void fire()}>Send packet</Key>
      <ReadoutView r={out} />
    </motion.div>
  );
}

// ---------- evidence below the model ----------

/** Scroll-driven entrances. Every effect moves or scales; nothing starts invisible. */
function useScrollFx(scope: React.RefObject<HTMLElement>) {
  useLayoutEffect(() => {
    if (reduced || !scope.current) return;
    const ctx = gsap.context(() => {
      gsap.fromTo('.stage', { scale: 0.93 }, { scale: 1, ease: 'none', scrollTrigger: { trigger: '.stage', start: 'top bottom', end: 'top 40%', scrub: true } });
      gsap.utils.toArray<HTMLElement>('.reveal').forEach(el => {
        gsap.from(el, { y: 46, skewY: 3, duration: 0.8, ease: 'power3.out', scrollTrigger: { trigger: el, start: 'top 88%' } });
      });
      gsap.utils.toArray<HTMLElement>('.figure').forEach((el, i) => {
        const b = el.querySelector('b') as HTMLElement;
        const n = Number(b.dataset.n), suffix = b.dataset.suffix ?? '';
        gsap.from(el, { y: 50, duration: 0.7, delay: i * 0.06, ease: 'power3.out', scrollTrigger: { trigger: '.figures', start: 'top 85%' } });
        const counter = { v: 0 };
        gsap.to(counter, {
          v: n, duration: 1.3, delay: i * 0.06, ease: 'power2.out',
          scrollTrigger: { trigger: '.figures', start: 'top 85%' },
          onUpdate: () => { b.textContent = `${Math.round(counter.v)}${suffix}`; },
        });
      });
      gsap.from('table.heat tbody td', {
        scale: 0.3, duration: 0.5, ease: 'back.out(2)',
        stagger: { grid: [D.sources.length, D.dests.length], from: 'start', amount: 0.8 },
        scrollTrigger: { trigger: 'table.heat', start: 'top 82%' },
      });
      gsap.utils.toArray<HTMLElement>('.rows').forEach(list => {
        gsap.from(list.querySelectorAll(':scope > li, :scope > .tamper'), { x: -56, duration: 0.6, stagger: 0.07, ease: 'power3.out', scrollTrigger: { trigger: list, start: 'top 85%' } });
      });
      gsap.from('.two > div', { y: 60, duration: 0.7, stagger: 0.12, ease: 'power3.out', scrollTrigger: { trigger: '.two', start: 'top 85%' } });
    }, scope);
    return () => ctx.revert();
  }, [scope]);
}

function Evidence() {
  const ref = useRef<HTMLDivElement>(null);
  useScrollFx(ref);
  const held = Object.values(D.assertions).filter(v => v === true).length;
  const reached = new Set(ATTEMPTS.filter(a => !a.blocked).map(a => `${a.target}|${a.segment}`));
  const outside = [...reached].filter(k => teamOf(k.split('|')[1]) !== OWN_TEAM).length;
  const caught = D.mutants.filter(m => !m.passed).length;
  const figures: { n: number; suffix?: string; label: string; red?: boolean }[] = [
    { n: D.probeCount, label: 'cases checked by the verifier' },
    { n: D.violations, label: 'cases that break the policy' },
    { n: held, suffix: `/${Object.keys(D.assertions).length}`, label: 'safety checks passed' },
    { n: ATTEMPTS.length, label: 'attack tries from a hacked target' },
    { n: outside, label: 'machines it reached outside its team' },
    { n: caught, suffix: `/${D.mutants.length}`, label: 'planted mistakes caught', red: true },
  ];
  return (
    <div ref={ref}>
      <section className="ev" id="numbers">
        <h2 className="reveal">The numbers</h2>
        <p>Each figure comes from the project’s own tools, run on the compiled switch configuration.</p>
        <div className="figures">
          {figures.map(f => (
            <div className="figure" key={f.label}>
              <b className={f.red ? 'red' : undefined} data-n={f.n} data-suffix={f.suffix ?? ''}>{f.n}{f.suffix}</b>
              <span>{f.label}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="ev" id="matrix">
        <h2 className="reveal">Every case, checked</h2>
        <p>Rows are senders and columns are receivers. Blue means the rules allow it. Red means they block it. Choose a kind of traffic, then pick a square to see the rule behind it.</p>
        <Heatmap />
        <div className="box">
          <h3>The checks the verifier runs</h3>
          <ul className="rows">
            {Object.entries(D.assertions).map(([k, v]) => (
              <li key={k}><span>{CHECK_NAME[k] ?? k}</span><span className={`stamp ${v === true ? 'pass' : 'caught'}`}>{v === true ? 'PASS' : 'FAIL'}</span></li>
            ))}
          </ul>
        </div>
      </section>

      <section className="ev" id="mistakes">
        <h2 className="reveal">Planted mistakes</h2>
        <p>Would the check notice a broken rule? Each mistake below was planted in a copy of the configuration, and the real verifier ran on that copy.</p>
        <div className="box rows">
          {D.mutants.map(m => {
            const what = m.trunk_violations ? `${m.trunk_violations} cable check failed` : `${m.violations} cases changed`;
            const fails = m.failing.map(k => CHECK_NAME[k] ?? k).join('; ');
            return (
              <div className="tamper" key={m.change}>
                <span className={`stamp ${m.passed ? 'pass' : 'caught'}`}>{m.passed ? 'MISSED' : 'CAUGHT'}</span>
                <p>{m.change}</p>
                <p className="what">{what}{fails ? `. Failed check: ${fails}` : ''}. The verifier exits with code 1.</p>
              </div>
            );
          })}
        </div>
        <details>
          <summary>Show the rules on the checkpoint switch</summary>
          <p className="small">These lines are generated from one file, topology.yaml. Nobody types them by hand.</p>
          <div className="acls">
            {Object.keys(D.acl).sort().map(n => <div key={n}><h4>{n}</h4><pre>{D.acl[n].join('\n')}</pre></div>)}
          </div>
        </details>
      </section>

      <section className="ev" id="limits">
        <h2 className="reveal">What this demo proves, and what it does not</h2>
        <div className="two">
          <div>
            <h3>Proven here</h3>
            <ul>
              <li>The generated switch rules keep each team inside its own network, in all {D.probeCount} cases.</li>
              <li>A fully compromised machine reaches nothing outside its own team.</li>
              <li>Breaking a rule makes the check fail, and the failure names the problem.</li>
              <li>Asked to attack 8.8.8.8, a real internet address, the simulator refuses and exits with code {D.run.refusedCode}. It has no setting to override this.</li>
            </ul>
          </div>
          <div className="no">
            <h3>Not proven here</h3>
            <ul>
              <li>The animation replays recorded results. It is not live network traffic.</li>
              <li>The checks read the switch configuration. Proving that real switches run it needs a lab test in Packet Tracer, which the verifier can import as a CSV.</li>
              <li>Virtual machines for the targets are not built yet. The orchestrator uses a stand-in.</li>
            </ul>
          </div>
        </div>
      </section>

      <footer>Data snapshot: compiler output, verifier and simulator runs on the 4-team simulation profile, {D.generated}. Built with TypeScript, React, Three.js, GSAP and Motion for the Computer Network Laboratory, SRMIST.</footer>
    </div>
  );
}

function Heatmap() {
  const [probe, setProbe] = useState<Probe>('tcp-syn');
  const [sel, setSel] = useState<{ s: string; d: string } | null>(null);
  const ev = sel ? evaluate(sel.s, sel.d, probe) : null;
  return (
    <div className="box">
      <div className="probes">
        {D.probes.map(p => <Key key={p} on={p === probe} aria-pressed={p === probe} onClick={() => setProbe(p)}>{PROBE_NAME[p]}</Key>)}
      </div>
      <div className="scroll">
        <table className="heat">
          <thead>
            <tr><th />{D.dests.map(d => <th key={d} className="v" scope="col">{shortLabel(d)}</th>)}</tr>
          </thead>
          <tbody>
            {D.sources.map(s => (
              <tr key={s}>
                <th scope="row">{label(s)}</th>
                {D.dests.map(d => {
                  if (s === d) return <td key={d} className="s" aria-label="Same network" />;
                  const v = D.matrix[s][d][probe];
                  const on = sel?.s === s && sel?.d === d;
                  return (
                    <td key={d} className={`${v === 'permit' ? 'p' : 'd'}${on ? ' sel' : ''}`}>
                      <motion.button key={`${probe}-${v}`} initial={reduced ? false : { scale: 0.7 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 22 }}
                        aria-label={`${label(s)} to ${label(d)}: ${v === 'permit' ? 'allowed' : 'blocked'}`} onClick={() => setSel({ s, d })}>
                        {v === 'permit' ? '✓' : '✕'}
                      </motion.button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="cellinfo">
        {sel && ev ? `${label(sel.s)} to ${label(sel.d)}, ${PROBE_NAME[probe]}: ${ev.permit ? 'allowed' : 'blocked'} by ${ruleText(ev)}.` : 'Pick a square.'}
      </p>
    </div>
  );
}
