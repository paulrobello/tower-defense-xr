interface Clip {
  file: string;
  duration_seconds: number;
  integrated_lufs: number;
  true_peak_dbtp: number;
}

const families = {
  'placement-ui': 'Placement & UI',
  turrets: 'Turrets',
  'rift-enemies': 'Rift & enemies',
  'core-waves': 'Core & waves',
} as const;

interface Cue {
  id: string;
  family: keyof typeof families;
  label: string;
  trigger: string;
  loop: boolean;
  source: Clip;
  derivatives: { ogg: Clip; mp3: Clip };
}

const assetPrefix = '../../assets-source/audio/sfx/';
const [metadata] = Object.values(
  import.meta.glob<{ cues: Cue[] }>('../../assets-source/audio/sfx/staging/catalog.json', {
    eager: true,
    import: 'default',
  }),
);
const clipUrls = import.meta.glob<string>(
  [
    '../../assets-source/audio/sfx/raw/*/take-*/response.mp3',
    '../../assets-source/audio/sfx/staging/*.{ogg,mp3}',
  ],
  { eager: true, query: '?url', import: 'default' },
);
const players = new Set<HTMLAudioElement>();
const playbackStatus = document.getElementById('playback-status');

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return node;
}

function announce(message: string): void {
  if (!playbackStatus) return;
  playbackStatus.textContent = message;
  playbackStatus.hidden = !message;
}

function readout(clip: Clip): string {
  return [
    `${clip.duration_seconds.toFixed(2)} s`,
    `${clip.integrated_lufs.toFixed(1)} LUFS`,
    `${clip.true_peak_dbtp.toFixed(1)} dBTP`,
  ].join(' · ');
}

function attachPlayer(player: HTMLAudioElement, name: string): void {
  players.add(player);
  player.controls = true;
  player.preload = 'none';
  player.setAttribute('aria-label', name);
  player.addEventListener('play', () => {
    announce('');
    for (const other of players) {
      if (other !== player) other.pause();
    }
  });
  player.addEventListener('error', () => announce(`Could not play ${name}.`));
}

function sourcePlayer(cue: Cue): { pane: HTMLElement; player: HTMLAudioElement } {
  const pane = element('div');
  pane.className = 'sample original';
  pane.append(element('p', 'Original MP3'));
  const player = element('audio');
  attachPlayer(player, `${cue.label}, original MP3`);
  player.src = clipUrls[assetPrefix + cue.source.file];
  pane.append(element('p', readout(cue.source)), player);
  return { pane, player };
}

function masteredPlayer(cue: Cue): { pane: HTMLElement; player: HTMLAudioElement } {
  const pane = element('div');
  pane.className = 'sample mastered';
  const player = element('audio');
  attachPlayer(player, `${cue.label}, mastered version`);

  const options = {
    ogg: { label: 'Opus', type: 'audio/ogg; codecs="opus"', clip: cue.derivatives.ogg },
    mp3: { label: 'MP3', type: 'audio/mpeg', clip: cue.derivatives.mp3 },
  } as const;
  const codec = element('select');
  codec.setAttribute('aria-label', `${cue.label}, mastered format`);
  const title = element('p', 'Mastered');
  const header = element('div');
  header.className = 'sample-header';
  header.append(title, codec);
  const info = element('p');

  for (const [key, { label, type }] of Object.entries(options)) {
    const option = element('option', label);
    option.value = key;
    option.disabled = player.canPlayType(type) === '';
    codec.append(option);
  }

  function load(): void {
    const key = codec.value === 'ogg' ? 'ogg' : 'mp3';
    const clip = options[key].clip;
    player.pause();
    player.src = clipUrls[`${assetPrefix}staging/${clip.file}`];
    info.textContent = readout(clip);
  }

  codec.value = player.canPlayType(options.ogg.type) ? 'ogg' : 'mp3';
  codec.addEventListener('change', load);
  load();
  pane.append(header, info, player);
  return { pane, player };
}

function renderCue(cue: Cue): HTMLElement {
  const row = element('article');
  row.id = cue.id;
  row.className = 'cue';
  const context = element('div');
  context.className = 'cue-context';
  context.append(element('h3', cue.label), element('p', cue.trigger));
  const original = sourcePlayer(cue);
  const mastered = masteredPlayer(cue);
  const comparison = element('div');
  comparison.className = 'comparison';
  if (cue.loop) {
    const loop = element('input');
    loop.type = 'checkbox';
    loop.checked = true;
    original.player.loop = true;
    mastered.player.loop = true;
    loop.addEventListener('change', () => {
      original.player.loop = loop.checked;
      mastered.player.loop = loop.checked;
    });
    const label = element('label');
    label.className = 'loop-control';
    label.append(loop, 'Repeat loop');
    context.append(label);
  }

  comparison.append(original.pane, mastered.pane);
  row.append(context, comparison);
  return row;
}

function renderCatalog(cues: Cue[], catalog: HTMLElement): void {
  for (const [id, label] of Object.entries(families)) {
    const group = element('section');
    group.className = 'cue-section';
    group.id = id;
    const header = element('header');
    header.className = 'section-header';
    const family = cues.filter((cue) => cue.family === id);
    header.append(element('h2', label), element('p', `${family.length} cues`));
    group.append(header, ...family.map(renderCue));
    catalog.append(group);
  }
}

document.getElementById('stop-all')?.addEventListener('click', () => {
  for (const player of players) {
    player.pause();
    if (player.readyState > HTMLMediaElement.HAVE_NOTHING) player.currentTime = 0;
  }
  announce('Playback stopped.');
});

const status = document.getElementById('catalog-status');
const catalog = document.getElementById('catalog');
const count = document.getElementById('cue-count');
if (metadata && catalog && status && count) {
  count.textContent = String(metadata.cues.length);
  renderCatalog(metadata.cues, catalog);
  status.hidden = true;
} else if (status) {
  status.textContent = 'The staged review files are unavailable in this checkout.';
}
