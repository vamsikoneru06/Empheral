import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { ScrollToPlugin } from 'gsap/ScrollToPlugin';

gsap.registerPlugin(ScrollTrigger, ScrollToPlugin);

export { gsap, ScrollTrigger };

export const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Glide the page to a section by id. */
export function scrollToId(id: string, onComplete?: () => void) {
  gsap.to(window, { scrollTo: { y: `#${id}`, offsetY: 14, autoKill: true }, duration: reduced ? 0 : 1.1, ease: 'power3.inOut', onComplete });
}
