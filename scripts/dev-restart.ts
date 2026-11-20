import { spawnSync } from 'node:child_process';

const stop = spawnSync('bun', ['run', 'dev-stop'], { stdio: 'inherit' });
if (stop.status !== 0) process.exit(stop.status ?? 1);
const start = spawnSync('bun', ['run', 'dev'], { stdio: 'inherit' });
process.exit(start.status ?? 1);
