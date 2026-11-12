// Bundles the server (and the shared engine and contract in shared/)
// into dist/server.js. npm packages stay external.
import * as esbuild from 'esbuild';
import { spawn } from 'node:child_process';

const watch = process.argv.includes('--watch');
const options = {
  // jobs.js runs the scheduled jobs once (npm run jobs).
  entryPoints: { server: 'src/server.ts', jobs: 'scripts/run-jobs.ts', worker: 'scripts/worker.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  outdir: 'dist',
  tsconfig: 'tsconfig.json',
  logLevel: 'warning',
};

if (!watch) {
  await esbuild.build(options);
  console.log('Built dist/server.js and dist/jobs.js');
} else {
  // Development: rebuild on change and restart the server.
  let child;
  const restart = () => {
    child?.kill();
    child = spawn(process.execPath, ['--enable-source-maps', 'dist/server.js'], { stdio: 'inherit' });
  };
  const ctx = await esbuild.context({
    ...options,
    plugins: [{ name: 'restart', setup: (b) => b.onEnd((r) => { if (!r.errors.length) restart(); }) }],
  });
  await ctx.watch();
}
