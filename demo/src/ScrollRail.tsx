import { useLayoutEffect, useRef, useState } from 'react';
import { ScrollTrigger, gsap, scrollToId } from './util';

export const SECTIONS: [string, string][] = [
  ['top', 'Start'],
  ['model', 'The model'],
  ['numbers', 'The numbers'],
  ['matrix', 'Every case'],
  ['mistakes', 'Planted mistakes'],
  ['limits', 'Limits'],
];

/** The custom scroller: a progress bar along the top, and on wide screens a rail of section stops. */
export function ScrollRail() {
  const bar = useRef<HTMLSpanElement>(null);
  const fill = useRef<HTMLSpanElement>(null);
  const [active, setActive] = useState('top');

  useLayoutEffect(() => {
    const ctx = gsap.context(() => {
      ScrollTrigger.create({
        start: 0,
        end: 'max',
        onUpdate: self => {
          gsap.set(bar.current, { scaleX: self.progress });
          gsap.set(fill.current, { scaleY: self.progress });
        },
      });
      for (const [id] of SECTIONS) {
        const el = document.getElementById(id);
        if (el) ScrollTrigger.create({ trigger: el, start: 'top 55%', end: 'bottom 55%', onToggle: s => { if (s.isActive) setActive(id); } });
      }
    });
    return () => ctx.revert();
  }, []);

  return (
    <>
      <div className="topbar" aria-hidden="true"><span ref={bar} /></div>
      <nav className="rail" aria-label="Sections">
        <span className="rail-track" aria-hidden="true"><span ref={fill} /></span>
        {SECTIONS.map(([id, name]) => (
          <button key={id} className={`rail-stop${active === id ? ' on' : ''}`} aria-label={`Go to ${name}`}
            aria-current={active === id ? 'true' : undefined} onClick={() => scrollToId(id)}>
            <span className="rail-name">{name}</span>
          </button>
        ))}
      </nav>
    </>
  );
}
