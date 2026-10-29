// Utilidades comunes de los scripts e2e (servidor Next + Playwright).
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

const require = createRequire(import.meta.url);
export const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const shots = path.join(root, 'e2e', 'screenshots');
mkdirSync(shots, { recursive: true });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createChecker() {
  const state = { failures: 0 };
  const check = (ok, msg) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
    if (!ok) state.failures++;
  };
  return { state, check };
}

export async function pollUntil(fn, timeoutMs, everyMs = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  return null;
}

function waitForServer(base, timeoutMs = 60_000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      http
        .get(base, (res) => {
          res.resume();
          resolve();
        })
        .on('error', () => (Date.now() - t0 > timeoutMs ? reject(new Error('server timeout')) : setTimeout(probe, 400)));
    };
    probe();
  });
}

/** `next build` (salvo SKIP_BUILD=1) + `next start` en modo demo. Devuelve { base, server }. */
export async function startApp(port) {
  const nextBin = path.join(root, 'node_modules/next/dist/bin/next');
  const env = { ...process.env, NEXT_PUBLIC_MOCK: '1' };
  if (!process.env.SKIP_BUILD) {
    const b = spawnSync(process.execPath, [nextBin, 'build'], { cwd: root, stdio: 'inherit', env });
    if (b.status !== 0) process.exit(b.status ?? 1);
  }
  const server = spawn(process.execPath, [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(base);
  return { base, server };
}

export const launchBrowser = () =>
  chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  });
