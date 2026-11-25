/// <reference types="vitest/config" />
// The web UI's build (web/ → web/dist, which the Go binary embeds), dev server and tests.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, transformWithOxc, type Plugin, type ResolvedConfig } from 'vite';

export default defineConfig(({ command, mode }) => ({
  root: 'web',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // One JS and one CSS file, no chunks: an open PWA that outlives a deploy would
    // otherwise ask for an old chunk by its hash and get the 404 back from the
    // network-first SW (embed_test.go checks it).
    cssCodeSplit: false,
    rolldownOptions: { output: { codeSplitting: false } },
  },
  plugins: [react(), sw()],
  server: {
    port: 5174,
    strictPort: true,
    allowedHosts: ['.ts.net'],
    // Vitest reads this config as command=serve, mode=test: no bridge needed there.
    proxy: command === 'serve' && mode !== 'test' ? bridgeProxy() : undefined,
  },
  test: { include: ['test/**/*.test.{ts,tsx}'] },
}));

// npm run dev talks to a running bridge: /api and /ws go to YOICKS_DEV_BRIDGE.
function bridgeProxy() {
  const target = process.env.YOICKS_DEV_BRIDGE;
  if (!target) {
    throw new Error('npm run dev needs YOICKS_DEV_BRIDGE, the bridge to proxy /api and /ws to (e.g. YOICKS_DEV_BRIDGE=http://127.0.0.1:8394)');
  }
  return { '/api': target, '/ws': { target, ws: true } };
}

// sw() emits sw.js from web/src/sw.ts with what the build produced: STATIC_ASSETS = every
// output and public file, CACHE_VERSION = 'herdr-yoicks-' + 8 hex of a sha256 over their
// sorted names and contents (and sw.ts's own code). A change to any served file renames
// the cache, so a phone picks the new build up; an identical build keeps it.
function sw(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'yoicks-sw',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    generateBundle: {
      order: 'post',
      async handler(_options, bundle) {
        const files = new Map<string, string | Uint8Array>();
        for (const [name, out] of Object.entries(bundle)) {
          files.set(name, out.type === 'chunk' ? out.code : out.source);
        }
        for (const entry of readdirSync(config.publicDir, { recursive: true, withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const path = join(entry.parentPath, entry.name);
          files.set(relative(config.publicDir, path), readFileSync(path));
        }
        const source = readFileSync(join(config.root, 'src/sw.ts'), 'utf8');
        const { code } = await transformWithOxc(source, 'sw.ts');
        const names = [...files.keys()].sort();
        const hash = createHash('sha256').update(code);
        for (const name of names) hash.update(`${name}\0`).update(files.get(name)!).update('\0');
        const version = 'herdr-yoicks-' + hash.digest('hex').slice(0, 8);
        const assets = ['/', ...names.map((name) => `/${name}`)];
        this.emitFile({
          type: 'asset',
          fileName: 'sw.js',
          source: code
            .replace(/\b__SW_VERSION__\b/g, JSON.stringify(version))
            .replace(/\b__SW_ASSETS__\b/g, JSON.stringify(assets)),
        });
      },
    },
  };
}
