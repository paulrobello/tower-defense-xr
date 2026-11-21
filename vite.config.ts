import { existsSync } from 'node:fs';
import { defineConfig, type UserConfig } from 'vite';
import { currentBuildId, versionManifestPlugin } from './scripts/build-version.ts';

const reviewDir = '.local/rift-sfx/audition-dist';

export default defineConfig(({ command, mode }): UserConfig => {
  if (mode === 'audition') {
    if (command === 'build' && !existsSync('assets-source/audio/sfx/staging/rift-ambient.ogg')) {
      throw new Error('The private SFX review audio must be staged before building the audition.');
    }
    return {
      base: './',
      publicDir: false,
      server: { host: '127.0.0.1', strictPort: true },
      preview: { host: '127.0.0.1', strictPort: true },
      build: {
        outDir: reviewDir,
        assetsInlineLimit: 0,
        rollupOptions: { input: { audition: 'audition.html' } },
      },
    };
  }
  return {
    resolve: { dedupe: ['three', 'troika-three-text'] },
    plugins: [versionManifestPlugin()],
    define: {
      __APP_BUILD: JSON.stringify(command === 'build' ? currentBuildId() : 'dev'),
      __RIFT_BASTION_IWER__: JSON.stringify(mode === 'iwer'),
    },
    server: {
      host: '0.0.0.0',
      port: 4272,
      strictPort: true,
      fs: {
        deny: [
          '.env',
          '.env.*',
          '*.{crt,pem,key,p12,pfx,cer,der}',
          '.npmrc',
          '.yarnrc.yml',
          '**/.git/**',
          '**/assets-source/audio/sfx/**',
          '**/audition.html',
          '**/scripts/audition/**',
          '**/.local/rift-sfx/**',
        ],
      },
    },
    preview: { host: '0.0.0.0', port: 4273, strictPort: true },
    build: {
      rollupOptions: { input: { game: 'index.html' } },
      target: 'es2023',
      sourcemap: false,
      outDir: mode === 'iwer' ? 'dist-iwer' : 'dist',
    },
  };
});
