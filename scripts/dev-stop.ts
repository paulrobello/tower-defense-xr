import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const PORT = 4272;
const project = realpathSync(resolve(import.meta.dirname, '..'));

function listeners(): string[] {
  const p = spawnSync('lsof', ['-nP', '-t', '-a', `-iTCP:${PORT}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  });
  if (p.error || (p.status !== 0 && p.status !== 1)) {
    throw p.error ?? new Error(p.stderr);
  }
  return p.stdout.trim().split(/\s+/).filter(Boolean);
}

function ownedPids(pids: string[]): number[] {
  const owned: number[] = [];
  for (const pid of pids) {
    const cwd = spawnSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
      .stdout.split('\n')
      .find((line) => line.startsWith('n'))
      ?.slice(1);
    const command = spawnSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' }).stdout;
    if (!cwd || realpathSync(cwd) !== project || !/(?:^|\/)vite(?:\.js)?(?:\s|$)/.test(command)) {
      throw new Error(`Port ${PORT} belongs to another process (pid ${pid})`);
    }
    owned.push(Number(pid));
  }
  return owned;
}

function signalAll(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') throw error;
    }
  }
}

const initial = ownedPids(listeners());
if (initial.length > 0) {
  signalAll(initial, 'SIGTERM');
  for (let i = 0; i < 15 && listeners().length > 0; i++) {
    await Bun.sleep(100);
  }
  const remaining = listeners();
  if (remaining.length > 0) {
    signalAll(ownedPids(remaining), 'SIGKILL');
    for (let i = 0; i < 5 && listeners().length > 0; i++) {
      await Bun.sleep(100);
    }
  }
  if (listeners().length > 0) {
    throw new Error(`Port ${PORT} is still busy after SIGTERM/SIGKILL escalation`);
  }
}
