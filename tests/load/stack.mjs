/**
 * A throwaway database and a real API process, for the load and volume tests.
 *
 * Seeded with the demo data, on a random port, never pointed at a real deployment. The API and
 * its database are pinned to two CPU cores where `taskset` exists, to stand in for the t3.small
 * the deploy guide recommends.
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const pin = (pid) => {
  if (spawnSync('which', ['taskset']).status === 0) spawnSync('taskset', ['-a', '-p', '-c', '0,1', String(pid)]);
};

const run = (script, env) =>
  new Promise((resolve, reject) => {
    /* Asynchronously: the database's log is read through this process, and blocking it stalls the database. */
    let output = '';
    const child = spawn(process.execPath, [script], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} failed:\n${output.slice(-2000)}`))));
  });

/**
 * `prepare(db)` runs after the seed and before the API starts — the place to load volume, so the
 * API boots onto the data the way a restarted server would.
 */
export async function startStack({ prepare, env: extra = {} } = {}) {
  const port = 5400 + Math.floor(Math.random() * 400);
  const mongo = await MongoMemoryServer.create({ instance: { storageEngine: 'wiredTiger' } });
  pin(mongo.instanceInfo.instance.mongodProcess.pid);
  const uri = mongo.getUri('npt_load');
  const env = {
    ...process.env,
    MONGO_URI: uri,
    PORT: String(port),
    NODE_ENV: 'development',
    JWT_SECRET: 'load-test-only-secret-value',
    CORS_ORIGIN: 'http://127.0.0.1',
    RATE_LIMIT_MAX: '',
    ANTHROPIC_API_KEY: '',
    ...extra,
  };

  await run('src/seed/index.js', env);
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (prepare) await prepare(db);

  let log = '';
  const api = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  api.stdout.on('data', (chunk) => (log += chunk));
  api.stderr.on('data', (chunk) => (log += chunk));
  let exited = null;
  api.on('exit', (code, signal) => (exited = { code, signal }));
  pin(api.pid);
  for (let i = 0; i < 300 && !/listening on port/.test(log); i++) await new Promise((r) => setTimeout(r, 200));
  if (!/listening on port/.test(log)) throw new Error(`API did not start:\n${log}`);

  return {
    base: `http://127.0.0.1:${port}`,
    db,
    log: () => log,
    exited: () => exited,
    rss: () => Math.round(Number(spawnSync('ps', ['-o', 'rss=', '-p', String(api.pid)], { encoding: 'utf8' }).stdout.trim()) / 1024),
    async stop() {
      api.kill('SIGTERM');
      await mongoose.disconnect();
      await mongo.stop();
    },
  };
}

/** Timed HTTP against the stack, keeping every timing and status by name. */
export function client(base) {
  const timings = new Map();
  const statuses = new Map();
  const call = async (path, { method = 'GET', body, token, name } = {}) => {
    const label = name || `${method} ${path.split('?')[0].replace(/[0-9a-f]{24}/g, ':id')}`;
    const started = performance.now();
    let status = 0;
    let json = {};
    let bytes = 0;
    try {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      status = response.status;
      const buffer = Buffer.from(await response.arrayBuffer());
      bytes = buffer.length;
      if ((response.headers.get('content-type') || '').includes('json')) json = JSON.parse(buffer.toString() || '{}');
    } catch (error) {
      json = { message: error.message };
    }
    const ms = performance.now() - started;
    if (!timings.has(label)) timings.set(label, []);
    timings.get(label).push(ms);
    statuses.set(`${label} ${status}`, (statuses.get(`${label} ${status}`) || 0) + 1);
    return { status, json, ms, bytes };
  };
  return { call, timings, statuses };
}

export const pct = (list, p) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};
