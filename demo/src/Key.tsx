import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { motion, useSpring, useTransform, type HTMLMotionProps } from 'framer-motion';

const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const SPRING = { stiffness: 420, damping: 26, mass: 0.6 };

interface KeyProps extends Omit<HTMLMotionProps<'button'>, 'style'> {
  /** primary: navy face. plain: white face. */
  look?: 'primary' | 'plain';
  /** A selected toggle (tab, step, traffic kind) takes the navy face. */
  on?: boolean;
}

/**
 * A physical key: a face sitting on a visible edge. It tilts toward the pointer and rises on hover,
 * and sinks into its edge while pressed. The edge colour comes from --edge in CSS.
 */
export function Key({ look = 'plain', on = false, className = '', disabled, children, onKeyDown, onKeyUp, ...rest }: KeyProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const rx = useSpring(0, SPRING);
  const ry = useSpring(0, SPRING);
  const lift = useSpring(0, SPRING); // -1 pressed, 0 resting, 1 hovered
  const depth = useTransform(lift, [-1, 0, 1], [1, 5, 8]);
  const y = useTransform(lift, [-1, 0, 1], [4, 0, -3]);
  const boxShadow = useTransform(depth, d => `0 ${d}px 0 var(--edge), 0 ${d + 8}px ${8 + d * 2}px rgba(0, 0, 80, ${(0.06 + d * 0.02).toFixed(2)})`);
  const live = !disabled;

  const tilt = (e: PointerEvent<HTMLButtonElement>) => {
    if (!live || reduced || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    ry.set(((e.clientX - r.left) / r.width - 0.5) * 18);
    rx.set(-((e.clientY - r.top) / r.height - 0.5) * 24);
  };
  const settle = () => { lift.set(0); rx.set(0); ry.set(0); };
  const press = (e: KeyboardEvent<HTMLButtonElement>) => { if (live && (e.key === ' ' || e.key === 'Enter')) lift.set(-1); onKeyDown?.(e); };
  const release = (e: KeyboardEvent<HTMLButtonElement>) => { lift.set(0); onKeyUp?.(e); };

  return (
    <motion.button
      ref={ref}
      type="button"
      className={`key ${look === 'primary' || on ? 'key-solid' : 'key-plain'} ${className}`}
      disabled={disabled}
      style={{ rotateX: rx, rotateY: ry, y, boxShadow, transformPerspective: 520 }}
      onPointerEnter={() => { if (live) lift.set(1); }}
      onPointerMove={tilt}
      onPointerLeave={settle}
      onPointerDown={() => { if (live) lift.set(-1); }}
      onPointerUp={() => { if (live) lift.set(1); }}
      onKeyDown={press}
      onKeyUp={release}
      onBlur={settle}
      {...rest}
    >
      {children}
    </motion.button>
  );
}
