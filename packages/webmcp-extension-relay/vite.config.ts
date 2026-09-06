import type { Options } from 'vite-plus/pack';
import { defineConfig } from 'vite-plus';

// Node-only build: the embed iframe route was removed; the expected browser
// client is the WebMCP Chrome extension (packages/chrome-extension), which
// speaks the wire protocol directly — no browser IIFE bundles are shipped.
const nodeConfig: Options = {
  entry: ['src/index.ts', 'src/cli.ts'],
  dts: true,
  format: ['esm'],
  splitting: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  target: 'node22',
  platform: 'node',
  tsconfig: './tsconfig.json',
};

export default defineConfig({
  pack: [nodeConfig],
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['dist', 'node_modules'],
    globals: true,
  },
});
