export const APP_NAME = 'Rift Bastion';

if (typeof document !== 'undefined') {
  const root = document.getElementById('app');
  if (root) {
    root.textContent = `${APP_NAME} (${typeof __APP_BUILD === 'string' ? __APP_BUILD : 'dev'})`;
  }
}
