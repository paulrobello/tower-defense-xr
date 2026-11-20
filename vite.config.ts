import { defineConfig } from 'vite';
import { currentBuildId, versionManifestPlugin } from './scripts/build-version.ts';

export default defineConfig(({ command, mode }) => ({
  resolve: { dedupe: ['three', 'troika-three-text'] },
  plugins: [versionManifestPlugin()],
  define: {
    __APP_BUILD: JSON.stringify(command === 'build' ? currentBuildId() : 'dev'),
    __RIFT_BASTION_IWER__: JSON.stringify(mode === 'iwer'),
  },
  server: { host: '0.0.0.0', port: 4272, strictPort: true },
  preview: { host: '0.0.0.0', port: 4273, strictPort: true },
  build: {
    rollupOptions: { input: { game: 'index.html' } },
    target: 'es2023',
    sourcemap: false,
    outDir: mode === 'iwer' ? 'dist-iwer' : 'dist',
  },
}));
