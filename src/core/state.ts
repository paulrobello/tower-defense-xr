/**
 * Top-level game state machine: `title → calibrate → prep → wave → intermission → victory | defeat`.
 *
 * Transitions are validated against a fixed table. Listeners hear every accepted transition in
 * order. Pure TypeScript with no DOM or Three.js dependencies.
 */

export const GAME_PHASES = [
  'title',
  'calibrate',
  'prep',
  'wave',
  'intermission',
  'victory',
  'defeat',
] as const;
export type GamePhase = (typeof GAME_PHASES)[number];

/** Allowed next phases for each phase. Every phase can abort back to `title`. */
export const PHASE_TRANSITIONS: Readonly<Record<GamePhase, readonly GamePhase[]>> = {
  title: ['calibrate'],
  calibrate: ['prep', 'title'],
  prep: ['wave', 'calibrate', 'title'],
  wave: ['intermission', 'victory', 'defeat', 'title'],
  intermission: ['wave', 'defeat', 'title'],
  victory: ['title', 'calibrate'],
  defeat: ['title', 'calibrate'],
};

export interface PhaseChange {
  from: GamePhase;
  to: GamePhase;
  reason?: string;
}

export type PhaseListener = (change: PhaseChange) => void;

export class InvalidTransitionError extends Error {
  readonly from: GamePhase;
  readonly to: GamePhase;
  constructor(from: GamePhase, to: GamePhase) {
    super(`Invalid game phase transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function isGamePhase(value: unknown): value is GamePhase {
  return typeof value === 'string' && (GAME_PHASES as readonly string[]).includes(value);
}

export function canTransition(from: GamePhase, to: GamePhase): boolean {
  return PHASE_TRANSITIONS[from].includes(to);
}

export interface GameStateMachine {
  readonly phase: GamePhase;
  /** Accepted transitions so far, oldest first. */
  readonly history: readonly PhaseChange[];
  can(to: GamePhase): boolean;
  /** Applies a valid transition and returns `true`; returns `false` and changes nothing otherwise. */
  transition(to: GamePhase, reason?: string): boolean;
  /** Like `transition`, but throws `InvalidTransitionError` on an invalid transition. */
  transitionOrThrow(to: GamePhase, reason?: string): void;
  /** Subscribes to accepted transitions. Returns the unsubscribe function. */
  subscribe(listener: PhaseListener): () => void;
  /** Returns to `title` without validation (for a hard reset), notifying listeners if it moved. */
  reset(reason?: string): void;
}

export interface GameStateOptions {
  initial?: GamePhase;
  /** Called when a listener throws. Defaults to `console.error`. */
  onListenerError?(error: unknown): void;
}

export function createGameStateMachine(options: GameStateOptions = {}): GameStateMachine {
  let phase: GamePhase = options.initial ?? 'title';
  const history: PhaseChange[] = [];
  const listeners = new Set<PhaseListener>();
  const reportError = options.onListenerError ?? ((error: unknown) => console.error(error));
  // Transitions requested from inside a listener are queued so every listener sees changes in order.
  const queue: PhaseChange[] = [];
  let notifying = false;

  function notify(change: PhaseChange): void {
    queue.push(change);
    if (notifying) return;
    notifying = true;
    try {
      for (let next = queue.shift(); next; next = queue.shift()) {
        for (const listener of [...listeners]) {
          try {
            listener(next);
          } catch (error) {
            reportError(error);
          }
        }
      }
    } finally {
      notifying = false;
    }
  }

  function apply(to: GamePhase, reason?: string): void {
    const change: PhaseChange =
      reason === undefined ? { from: phase, to } : { from: phase, to, reason };
    phase = to;
    history.push(change);
    notify(change);
  }

  return {
    get phase() {
      return phase;
    },
    get history() {
      return history;
    },
    can(to) {
      return canTransition(phase, to);
    },
    transition(to, reason) {
      if (!canTransition(phase, to)) return false;
      apply(to, reason);
      return true;
    },
    transitionOrThrow(to, reason) {
      if (!canTransition(phase, to)) throw new InvalidTransitionError(phase, to);
      apply(to, reason);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset(reason) {
      if (phase === 'title') return;
      apply('title', reason ?? 'reset');
    },
  };
}
