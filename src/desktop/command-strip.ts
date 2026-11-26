import type { TurretKind } from '../content/turrets.ts';
import type { TacticalAtlasResource, TacticalIconAtlas } from '../ui/tactical-atlas.ts';
import {
  buildBuildWheelItems,
  buildTurretCommandWheelItems,
  type RadialActionId,
  type RadialBuildStateSnapshot,
  type RadialTurretTarget,
} from '../xr/radial-controls.ts';
import './command-strip.css';

export function createDesktopCommandStrip(
  container: HTMLElement,
  atlas: TacticalAtlasResource,
  activate: (id: RadialActionId) => void,
) {
  const doc = container.ownerDocument;
  const bar = doc.createElement('div');
  bar.className = 'bastion-command-strip';
  bar.setAttribute('role', 'group');
  bar.hidden = true;
  container.append(bar);
  let lastSnapshot: RadialBuildStateSnapshot | undefined;
  let lastTarget: RadialTurretTarget | null = null;
  let lastSelected: TurretKind | null = null;
  let ready: TacticalIconAtlas | null = null;
  let started = false;
  let disposed = false;
  let renderedIcons: { node: HTMLElement; id: string }[] = [];
  function showIcons() {
    if (!ready) return;
    for (const { id, node } of renderedIcons) {
      const cell = ready.icons[id];
      if (!cell) continue;
      const [x, y, w, h] = cell.rect;
      node.style.backgroundImage = `url("${ready.url}")`;
      node.style.backgroundSize = `${(100 * ready.width) / w}% ${(100 * ready.height) / h}%`;
      node.style.backgroundPosition = `${(100 * x) / (ready.width - w)}% ${(100 * y) / (ready.height - h)}%`;
      node.hidden = false;
    }
  }
  return {
    hide() {
      if (!bar.hidden) bar.hidden = true;
    },
    update(
      snapshot: RadialBuildStateSnapshot,
      target: RadialTurretTarget | null,
      selected: TurretKind | null,
    ) {
      if (bar.hidden) bar.hidden = false;
      if (!started) {
        started = true;
        void atlas.get().then((value) => {
          if (!disposed) {
            ready = value;
            showIcons();
          }
        });
      }
      if (
        lastSnapshot?.credits === snapshot.credits &&
        lastSnapshot.activeTurretCount === snapshot.activeTurretCount &&
        lastSnapshot.phase === snapshot.phase &&
        lastSnapshot.canLaunchWave === snapshot.canLaunchWave &&
        lastSnapshot.hardTurretCap === snapshot.hardTurretCap &&
        lastTarget?.id === target?.id &&
        lastTarget?.tier === target?.tier &&
        lastTarget?.upgradeTargetTier === target?.upgradeTargetTier &&
        lastTarget?.investedCredits === target?.investedCredits &&
        lastTarget?.priority === target?.priority &&
        lastSelected === selected
      )
        return;
      lastSnapshot = snapshot;
      lastTarget = target ? { ...target } : null;
      lastSelected = selected;
      const items = target
        ? buildTurretCommandWheelItems(target, snapshot.credits)
        : buildBuildWheelItems(snapshot);
      const keys = target ? ['U', 'T', 'R', 'X'] : ['1', '2', '3', '4', 'Space'];
      const focused =
        doc.activeElement instanceof HTMLElement
          ? doc.activeElement.dataset.tacticalAction
          : undefined;
      bar.setAttribute('aria-label', target ? 'Turret commands' : 'Quick build');
      renderedIcons = [];
      bar.replaceChildren(
        ...items.map((item, i) => {
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.disabled = item.disabled;
          btn.dataset.tacticalAction = item.id;
          if (item.id.startsWith('build:'))
            btn.setAttribute('aria-pressed', String(item.id === `build:${selected}`));
          const hotkey = doc.createElement('kbd');
          hotkey.textContent = keys[i] ?? '';
          hotkey.setAttribute('aria-hidden', 'true');
          const icon = doc.createElement('span');
          icon.className = 'tactical-icon';
          icon.hidden = true;
          icon.setAttribute('aria-hidden', 'true');
          const [name, detail] = item.label.split('\n');
          const label = doc.createElement('span');
          label.textContent = name ?? '';
          const sub = doc.createElement('small');
          sub.textContent = detail ?? '';
          btn.title = item.disabledReason ?? item.label.replace('\n', ' · ');
          btn.setAttribute('aria-keyshortcuts', keys[i] ?? '');
          btn.append(hotkey, icon, label, sub);
          btn.addEventListener('click', () => activate(item.id));
          renderedIcons.push({ id: item.icon, node: icon });
          return btn;
        }),
      );
      showIcons();
      if (focused)
        bar
          .querySelector<HTMLButtonElement>(`[data-tactical-action="${focused}"]`)
          ?.focus({ preventScroll: true });
    },
    dispose() {
      disposed = true;
      bar.remove();
      renderedIcons = [];
    },
  };
}
