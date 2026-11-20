/**
 * Typed action bus shared identically by XR (controllers, radial menu, spatial panels) and desktop
 * (mouse, keyboard, DOM overlay) inputs. Every game-affecting intent is a plain serializable action
 * so automated walks and replays can drive the game exactly like a player.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const TURRET_KINDS = ['autocannon', 'plasma-mortar', 'cryo-arc', 'rail-sniper'] as const;
export type TurretKind = (typeof TURRET_KINDS)[number];

export const TARGET_PRIORITIES = ['first', 'strongest', 'closest', 'air'] as const;
export type TargetPriority = (typeof TARGET_PRIORITIES)[number];

export const PLAY_ARCS = ['front-180', 'full-360'] as const;
export type PlayArc = (typeof PLAY_ARCS)[number];

export type MenuScreen = 'title' | 'settings' | 'pause' | 'results';

export type SettingValue = string | number | boolean;

/** Where an action came from. Handlers must not branch gameplay on this; it is for telemetry/tests. */
export type ActionSource = 'desktop' | 'xr' | 'automation' | 'system';

export type GameAction =
  // Navigation / menus
  | { type: 'menu/play-desktop' }
  | { type: 'menu/open'; screen: MenuScreen }
  | { type: 'menu/back' }
  | { type: 'menu/open-settings' }
  | { type: 'menu/close-settings' }
  // Calibration / Core Anchor
  | { type: 'calibrate/begin' }
  | { type: 'calibrate/move-core'; position: Vec3 }
  | { type: 'calibrate/set-play-arc'; arc: PlayArc }
  | { type: 'calibrate/confirm' }
  // Turrets
  | { type: 'turret/build'; kind: TurretKind; position: Vec3; surfaceId?: string }
  | { type: 'turret/upgrade'; turretId: string }
  | { type: 'turret/relocate'; turretId: string; position: Vec3; surfaceId?: string }
  | { type: 'turret/sell'; turretId: string }
  | { type: 'turret/set-priority'; turretId: string; priority: TargetPriority }
  // Waves
  | { type: 'wave/launch' }
  // Settings
  | { type: 'settings/change'; key: string; value: SettingValue }
  // View / session
  | { type: 'view/recenter' }
  | { type: 'xr/enter' }
  | { type: 'xr/exit' };

export type ActionType = GameAction['type'];
export type ActionOf<T extends ActionType> = Extract<GameAction, { type: T }>;

export interface ActionEnvelope<A extends GameAction = GameAction> {
  action: A;
  source: ActionSource;
  /** Monotonic dispatch sequence number, starting at 1. */
  seq: number;
}

export type ActionHandler<T extends ActionType> = (
  action: ActionOf<T>,
  envelope: ActionEnvelope<ActionOf<T>>,
) => void;
export type AnyActionHandler = (action: GameAction, envelope: ActionEnvelope) => void;

export interface ActionBus {
  /**
   * Delivers an action to its typed handlers, then to `onAny` handlers. Actions dispatched from
   * inside a handler are queued and delivered after the current one, preserving FIFO order.
   * Returns the envelope sequence number.
   */
  dispatch(action: GameAction, source?: ActionSource): number;
  /** Subscribes to one action type. Returns the unsubscribe function. */
  on<T extends ActionType>(type: T, handler: ActionHandler<T>): () => void;
  /** Subscribes to every action. Returns the unsubscribe function. */
  onAny(handler: AnyActionHandler): () => void;
  /** Number of handlers registered for a type (or every handler when omitted). */
  handlerCount(type?: ActionType): number;
  /** Removes every handler. */
  clear(): void;
}

export interface ActionBusOptions {
  /** Called when a handler throws; the remaining handlers still run. Defaults to `console.error`. */
  onHandlerError?(error: unknown, envelope: ActionEnvelope): void;
}

export function createActionBus(options: ActionBusOptions = {}): ActionBus {
  const typed = new Map<ActionType, Set<AnyActionHandler>>();
  const any = new Set<AnyActionHandler>();
  const reportError =
    options.onHandlerError ?? ((error: unknown) => console.error('[action-bus]', error));
  const queue: ActionEnvelope[] = [];
  let seq = 0;
  let draining = false;

  function deliver(envelope: ActionEnvelope): void {
    // Snapshot handlers so (un)subscribing during delivery affects only later actions.
    const handlers = [...(typed.get(envelope.action.type) ?? []), ...any];
    for (const handler of handlers) {
      try {
        handler(envelope.action, envelope);
      } catch (error) {
        reportError(error, envelope);
      }
    }
  }

  return {
    dispatch(action, source = 'desktop') {
      seq += 1;
      queue.push({ action, source, seq });
      if (!draining) {
        draining = true;
        try {
          for (let next = queue.shift(); next; next = queue.shift()) deliver(next);
        } finally {
          draining = false;
        }
      }
      return seq;
    },
    on(type, handler) {
      let set = typed.get(type);
      if (!set) {
        set = new Set();
        typed.set(type, set);
      }
      const wrapped = handler as unknown as AnyActionHandler;
      set.add(wrapped);
      return () => {
        set.delete(wrapped);
      };
    },
    onAny(handler) {
      any.add(handler);
      return () => {
        any.delete(handler);
      };
    },
    handlerCount(type) {
      if (type) return typed.get(type)?.size ?? 0;
      let total = any.size;
      for (const set of typed.values()) total += set.size;
      return total;
    },
    clear() {
      typed.clear();
      any.clear();
    },
  };
}
