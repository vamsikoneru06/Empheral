import { motion } from 'framer-motion';
import { Key } from './Key';
import { reduced } from './util';

export type PlayMode = 'idle' | 'playing' | 'paused';

const ICON: Record<string, string> = {
  prev: 'M6 5h2.4v14H6zM19 5v14L9 12z',
  next: 'M15.6 5H18v14h-2.4zM5 5v14l10-7z',
  play: 'M7 4.5v15L19.5 12z',
  pause: 'M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z',
  replay: 'M12 4.5V1.5L7 5.5l5 4v-3a5.5 5.5 0 1 1-5.5 5.5H4.5A7.5 7.5 0 1 0 12 4.5z',
};
const Icon = ({ name }: { name: string }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d={ICON[name]} fill="currentColor" /></svg>
);

interface Props {
  steps: string[];
  step: number;
  progress: number;
  mode: PlayMode;
  onPlay: () => void;
  onPause: () => void;
  onPrev: () => void;
  onNext: () => void;
  onReplay: () => void;
  onJump: (i: number) => void;
}

/** The tour player: transport keys, and one track segment per step that fills as the step runs. */
export function Player({ steps, step, progress, mode, onPlay, onPause, onPrev, onNext, onReplay, onJump }: Props) {
  const playing = mode === 'playing';
  return (
    <div className="player" role="group" aria-label="Tour player">
      <div className="player-keys">
        <Key aria-label="Previous step" disabled={step === 0} onClick={onPrev}><Icon name="prev" /></Key>
        <Key look="primary" className="play" aria-label={playing ? 'Pause the tour' : 'Play the tour'} onClick={playing ? onPause : onPlay}>
          <Icon name={playing ? 'pause' : 'play'} />
          <span>{playing ? 'Pause' : mode === 'paused' ? 'Resume' : 'Play'}</span>
        </Key>
        <Key aria-label="Next step" onClick={onNext}><Icon name="next" /></Key>
        <Key aria-label="Replay this step" onClick={onReplay}><Icon name="replay" /></Key>
      </div>
      <div className="player-track">
        <p className="player-now"><b>{step + 1}</b> of {steps.length}<span>{steps[step]}</span></p>
        <div className="track">
          {steps.map((title, i) => {
            const fill = i < step ? 1 : i === step ? progress : 0;
            return (
              <button key={title} className={`seg${i === step ? ' now' : ''}`} title={title}
                aria-label={`Step ${i + 1}: ${title}`} aria-current={i === step ? 'step' : undefined} onClick={() => onJump(i)}>
                <motion.i className="fill" initial={false} animate={{ scaleX: fill }}
                  transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 140, damping: 24 }} />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
