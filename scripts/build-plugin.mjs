// Build a plugin as one file that FlowState loads at run time (Plugins > Load plugin file), without rebuilding the app:
//
//   npm run build:plugin -- <id>        src/plugins/<id>/index.ts(x)  ->  dist-plugins/<id>.flowstate-plugin.js
//
// The file is a plain script: it registers its plugin with the loader (FlowStateHost.register) and uses the app's React
// (src/plugins/host/*). Plugins reach the app only through the PluginContext (`fs`): app modules that hold state
// (store, engine, UI, I/O) cannot be bundled into a plugin; pure helpers (src/core/stats.ts, transforms.ts ...) can.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

// a production build whatever the caller's environment (NODE_ENV=test would make JSX use React's development runtime)
process.env.NODE_ENV = 'production';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = process.argv[2];
if (!id || !/^[a-z][a-z0-9-]{0,39}$/.test(id)) {
  console.error('Usage: npm run build:plugin -- <id>   (the folder name in src/plugins, e.g. "example")');
  process.exit(1);
}
const dir = path.join(root, 'src', 'plugins', id);
const main = ['index.tsx', 'index.ts'].map((f) => path.join(dir, f)).find((f) => existsSync(f));
if (!main) {
  console.error(`No src/plugins/${id}/index.tsx (or index.ts)`);
  process.exit(1);
}

const out = path.join(root, 'dist-plugins');
const tmp = path.join(out, '.entry');
mkdirSync(tmp, { recursive: true });
const entry = path.join(tmp, `${id}.ts`);
writeFileSync(
  entry,
  `import plugin from ${JSON.stringify(main.replace(/\\/g, '/'))};\n` +
    `const host = (globalThis as { FlowStateHost?: { register(p: unknown): void } }).FlowStateHost;\n` +
    `if (!host) throw new Error('This is a FlowState plugin: load it in FlowState (Plugins > Load plugin file).');\n` +
    `host.register(plugin);\n`,
);

const host = (f) => path.join(root, 'src', 'plugins', 'host', f);
const src = path.join(root, 'src') + path.sep;
const allowed = [path.join(root, 'src', 'plugins') + path.sep, path.join(root, 'src', 'core') + path.sep];
const stateful = /[\\/]src[\\/]core[\\/](engine|demo)\.ts$/;

try {
  await build({
    configFile: false,
    root,
    mode: 'production',
    logLevel: 'warn',
    plugins: [
      react(),
      {
        name: 'flowstate-plugin-boundary',
        load(file) {
          if (!file.startsWith(src)) return null;
          if (!allowed.some((a) => file.startsWith(a)) || stateful.test(file))
            this.error(`${path.relative(root, file)} cannot be part of a plugin: plugins reach the app through fs (the PluginContext), see docs/PLUGINS.md`);
          return null;
        },
      },
    ],
    resolve: {
      alias: [
        { find: /^react$/, replacement: host('react.ts') },
        { find: /^react\/jsx-runtime$/, replacement: host('jsx-runtime.ts') },
        { find: /^react\/jsx-dev-runtime$/, replacement: host('jsx-runtime.ts') },
      ],
    },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      outDir: out,
      emptyOutDir: false,
      target: 'es2021',
      minify: false,
      sourcemap: false,
      lib: { entry, formats: ['iife'], name: 'FlowStatePlugin', fileName: () => `${id}.flowstate-plugin.js` },
    },
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`Built dist-plugins/${id}.flowstate-plugin.js: load it in FlowState with Plugins > Load plugin file.`);
