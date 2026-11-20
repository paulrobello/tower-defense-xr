import { describe, expect, it, vi } from 'vitest';
import { createActionBus, type GameAction } from '../src/core/action-bus.ts';
import {
  canTransition,
  createGameStateMachine,
  GAME_PHASES,
  InvalidTransitionError,
  isGamePhase,
  PHASE_TRANSITIONS,
  type PhaseChange,
} from '../src/core/state.ts';

describe('game state machine', () => {
  it('starts at title and walks the full happy path to victory', () => {
    const machine = createGameStateMachine();
    expect(machine.phase).toBe('title');
    for (const phase of ['calibrate', 'prep', 'wave', 'intermission', 'wave', 'victory'] as const) {
      expect(machine.transition(phase)).toBe(true);
      expect(machine.phase).toBe(phase);
    }
    expect(machine.history.map((change) => change.to)).toEqual([
      'calibrate',
      'prep',
      'wave',
      'intermission',
      'wave',
      'victory',
    ]);
  });

  it('rejects invalid transitions without changing phase or notifying', () => {
    const machine = createGameStateMachine();
    const listener = vi.fn();
    machine.subscribe(listener);
    expect(machine.can('wave')).toBe(false);
    expect(machine.transition('wave')).toBe(false);
    expect(machine.transition('victory')).toBe(false);
    expect(machine.phase).toBe('title');
    expect(listener).not.toHaveBeenCalled();
    expect(() => machine.transitionOrThrow('defeat')).toThrow(InvalidTransitionError);
  });

  it('reaches defeat from wave and intermission and can retry via calibrate', () => {
    const machine = createGameStateMachine({ initial: 'wave' });
    expect(machine.transition('defeat', 'core destroyed')).toBe(true);
    expect(machine.history.at(-1)).toEqual({
      from: 'wave',
      to: 'defeat',
      reason: 'core destroyed',
    });
    expect(machine.transition('calibrate')).toBe(true);
    expect(canTransition('intermission', 'defeat')).toBe(true);
  });

  it('allows every phase except title to abort back to title, and terminal phases do not loop', () => {
    for (const phase of GAME_PHASES) {
      if (phase !== 'title') expect(PHASE_TRANSITIONS[phase]).toContain('title');
      expect(PHASE_TRANSITIONS[phase]).not.toContain(phase);
    }
    expect(canTransition('victory', 'wave')).toBe(false);
    expect(canTransition('defeat', 'wave')).toBe(false);
  });

  it('notifies listeners in order, isolates throwing listeners, and unsubscribes', () => {
    const errors: unknown[] = [];
    const machine = createGameStateMachine({ onListenerError: (error) => errors.push(error) });
    const seen: PhaseChange[] = [];
    machine.subscribe(() => {
      throw new Error('boom');
    });
    const unsubscribe = machine.subscribe((change) => seen.push(change));
    machine.transition('calibrate');
    expect(seen).toEqual([{ from: 'title', to: 'calibrate' }]);
    expect(errors).toHaveLength(1);
    unsubscribe();
    machine.transition('prep');
    expect(seen).toHaveLength(1);
  });

  it('queues transitions requested from inside a listener so order is preserved', () => {
    const machine = createGameStateMachine();
    const order: string[] = [];
    machine.subscribe((change) => {
      order.push(`a:${change.to}`);
      if (change.to === 'calibrate') machine.transition('prep');
    });
    machine.subscribe((change) => order.push(`b:${change.to}`));
    machine.transition('calibrate');
    expect(order).toEqual(['a:calibrate', 'b:calibrate', 'a:prep', 'b:prep']);
    expect(machine.phase).toBe('prep');
  });

  it('reset returns to title from anywhere and is a no-op at title', () => {
    const machine = createGameStateMachine({ initial: 'intermission' });
    const listener = vi.fn();
    machine.subscribe(listener);
    machine.reset();
    expect(machine.phase).toBe('title');
    expect(listener).toHaveBeenCalledWith({ from: 'intermission', to: 'title', reason: 'reset' });
    machine.reset();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('validates phase names', () => {
    expect(isGamePhase('wave')).toBe(true);
    expect(isGamePhase('lobby')).toBe(false);
    expect(isGamePhase(3)).toBe(false);
  });
});

describe('action bus', () => {
  it('delivers typed actions to matching handlers with source and sequence', () => {
    const bus = createActionBus();
    const build = vi.fn();
    const sell = vi.fn();
    bus.on('turret/build', build);
    bus.on('turret/sell', sell);
    const action: GameAction = {
      type: 'turret/build',
      kind: 'cryo-arc',
      position: { x: 1, y: 0.75, z: -0.5 },
    };
    const seq = bus.dispatch(action, 'xr');
    expect(seq).toBe(1);
    expect(build).toHaveBeenCalledWith(action, { action, source: 'xr', seq: 1 });
    expect(sell).not.toHaveBeenCalled();
  });

  it('treats desktop and XR dispatches identically (source defaults to desktop)', () => {
    const bus = createActionBus();
    const received: GameAction[] = [];
    bus.on('wave/launch', (action) => received.push(action));
    bus.dispatch({ type: 'wave/launch' });
    bus.dispatch({ type: 'wave/launch' }, 'xr');
    expect(received).toEqual([{ type: 'wave/launch' }, { type: 'wave/launch' }]);
  });

  it('runs onAny handlers after typed handlers for every action', () => {
    const bus = createActionBus();
    const order: string[] = [];
    bus.onAny((action, envelope) => order.push(`any:${action.type}:${envelope.source}`));
    bus.on('view/recenter', () => order.push('typed:view/recenter'));
    bus.dispatch({ type: 'view/recenter' }, 'automation');
    bus.dispatch({ type: 'xr/exit' }, 'system');
    expect(order).toEqual([
      'typed:view/recenter',
      'any:view/recenter:automation',
      'any:xr/exit:system',
    ]);
  });

  it('unsubscribes handlers, including from inside a dispatch', () => {
    const bus = createActionBus();
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = bus.on('turret/upgrade', first);
    let offSecond = (): void => {};
    offSecond = bus.on('turret/upgrade', () => {
      second();
      offSecond();
    });
    expect(bus.handlerCount('turret/upgrade')).toBe(2);
    bus.dispatch({ type: 'turret/upgrade', turretId: 't1' });
    bus.dispatch({ type: 'turret/upgrade', turretId: 't1' });
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
    offFirst();
    expect(bus.handlerCount('turret/upgrade')).toBe(0);
    bus.dispatch({ type: 'turret/upgrade', turretId: 't1' });
    expect(first).toHaveBeenCalledTimes(2);
  });

  it('queues nested dispatches FIFO after the current action', () => {
    const bus = createActionBus();
    const order: string[] = [];
    bus.on('calibrate/confirm', () => {
      order.push('confirm:start');
      bus.dispatch({ type: 'wave/launch' });
      order.push('confirm:end');
    });
    bus.on('wave/launch', (_action, envelope) => order.push(`launch:${envelope.seq}`));
    bus.dispatch({ type: 'calibrate/confirm' });
    expect(order).toEqual(['confirm:start', 'confirm:end', 'launch:2']);
  });

  it('isolates throwing handlers and reports them', () => {
    const errors: unknown[] = [];
    const bus = createActionBus({ onHandlerError: (error) => errors.push(error) });
    const after = vi.fn();
    bus.on('turret/set-priority', () => {
      throw new Error('bad handler');
    });
    bus.on('turret/set-priority', after);
    bus.dispatch({ type: 'turret/set-priority', turretId: 't2', priority: 'air' });
    expect(errors).toHaveLength(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('covers relocate, settings, navigation, and session actions and clears all handlers', () => {
    const bus = createActionBus();
    const all = vi.fn();
    bus.onAny(all);
    const actions: GameAction[] = [
      { type: 'turret/relocate', turretId: 't3', position: { x: 0, y: 1.5, z: 2 } },
      { type: 'settings/change', key: 'showFps', value: true },
      { type: 'menu/open-settings' },
      { type: 'menu/play-desktop' },
      { type: 'calibrate/set-play-arc', arc: 'front-180' },
      { type: 'xr/enter' },
    ];
    for (const action of actions) bus.dispatch(action);
    expect(all).toHaveBeenCalledTimes(actions.length);
    expect(bus.handlerCount()).toBe(1);
    bus.clear();
    expect(bus.handlerCount()).toBe(0);
    bus.dispatch({ type: 'xr/enter' });
    expect(all).toHaveBeenCalledTimes(actions.length);
  });
});
