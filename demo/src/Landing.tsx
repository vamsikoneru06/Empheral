import { useLayoutEffect, useRef } from 'react';
import { Key } from './Key';
import { D, label, teamOf } from './rules';
import { gsap, reduced } from './util';

const OWN_TEAM = teamOf(D.run.compromised.segment);
const ESCAPES = new Set(
  D.run.attempts.filter(a => a[5] !== 'blocked' && teamOf(a[2]) !== OWN_TEAM).map(a => a[1]),
).size;

/** The first screen: what the project is, three figures, and the real policy drawn as a mosaic. */
export function Landing({ onEnter }: { onEnter: () => void }) {
  const ref = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    if (reduced || !ref.current) return;
    const ctx = gsap.context(() => {
      gsap.from('.land-rise', { y: 40, duration: 0.9, stagger: 0.08, ease: 'power3.out' });
      gsap.from('.mosaic i', { scale: 0.25, duration: 0.55, ease: 'back.out(2.2)', stagger: { grid: [D.sources.length, D.dests.length], from: 'center', amount: 0.9 } });
      gsap.to('.cue-line', { scaleY: 0.35, transformOrigin: 'top center', duration: 0.9, repeat: -1, yoyo: true, ease: 'sine.inOut' });
      // Leaving the page: the copy drifts up and the policy mosaic tips back into the floor.
      const leave = { trigger: ref.current, start: 'top top', end: 'bottom top', scrub: true };
      gsap.to('.land-copy', { yPercent: -16, ease: 'none', scrollTrigger: leave });
      gsap.to('.mosaic', { rotateX: 42, rotateZ: -8, scale: 0.84, ease: 'none', scrollTrigger: leave });
    }, ref);
    return () => ctx.revert();
  }, []);

  return (
    <section className="landing" id="top" ref={ref}>
      <div className="land-copy">
        <p className="kicker land-rise">CyberRange-Net, Computer Network Laboratory, SRMIST</p>
        <h1 className="land-rise">Every <span className="nowrap">break-in</span> stays in <span className="red-word">its own box</span></h1>
        <p className="lede land-rise">A practice range where students attack real machines on purpose. One switch keeps every team inside its own network. Its rules are generated from a single file and checked automatically.</p>
        <div className="land-actions land-rise">
          <Key look="primary" className="enter" onClick={onEnter}>Enter the range</Key>
          <span className="small">The guided tour starts on entry.</span>
        </div>
        <dl className="land-facts land-rise">
          <div><dt>teams, each in its own network</dt><dd>4</dd></div>
          <div><dt>cases checked by the verifier</dt><dd>{D.probeCount}</dd></div>
          <div><dt>machines a hacked target reached outside its team</dt><dd className={ESCAPES ? 'red' : undefined}>{ESCAPES}</dd></div>
        </dl>
      </div>

      <figure className="mosaic-wrap land-rise">
        <div className="mosaic" role="img" aria-label="The policy for new connections between every pair of networks: allowed pairs are blue, blocked pairs are red.">
          {D.sources.map(s => D.dests.map(d => {
            const v = s === d ? 's' : D.matrix[s][d]['tcp-syn'] === 'permit' ? 'p' : 'd';
            return <i key={`${s}-${d}`} className={v} title={s === d ? undefined : `${label(s)} to ${label(d)}: ${v === 'p' ? 'allowed' : 'blocked'}`} />;
          }))}
        </div>
        <figcaption>The real policy for new connections. Each square is one sender and receiver. Blue is allowed. Red is blocked.</figcaption>
      </figure>

      <div className="scroll-cue" aria-hidden="true"><span className="cue-line" />Scroll</div>
    </section>
  );
}
