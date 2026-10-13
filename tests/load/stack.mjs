/**
 * A throwaway database and a real API process, for the load and volume tests.
 *
 * Seeded with the demo data, on a random port, never pointed at a real deployment. The API and
 * its database are pinned to two CPU cores where `taskset` exists, to stand in for the t3.small
 * the deploy guide recommends.
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
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
export async function startStack({ prepare, env: extra = {}, replSet = false, instances = 1 } = {}) {
  const port = 5400 + Math.floor(Math.random() * 400);
  /* `replSet`: a one-node replica set, so every transaction in the code really runs as one — the
     way the plant's database is deployed. */
  const mongo = replSet
    ? await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
    : await MongoMemoryServer.create({ instance: { storageEngine: 'wiredTiger' } });
  for (const server of mongo.servers || [mongo]) pin(server.instanceInfo.instance.mongodProcess.pid);
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

  /*
   * `instances`: several API processes on one database, as `pm2 start -i N` runs them in
   * production — each on its own port, the client spreading calls across them as a load
   * balancer does.
   */
  let log = '';
  const exits = [];
  const apis = [];
  /* `LOAD_PROFILE_DIR=…` writes a CPU profile of the API, for finding what a slow run spent its time on. */
  const profile = process.env.LOAD_PROFILE_DIR ? ['--cpu-prof', `--cpu-prof-dir=${process.env.LOAD_PROFILE_DIR}`] : [];
  for (let i = 0; i < instances; i++) {
    const api = spawn(process.execPath, [...profile, 'src/server.js'], { cwd: ROOT, env: { ...env, PORT: String(port + i) }, stdio: ['ignore', 'pipe', 'pipe'] });
    api.stdout.on('data', (chunk) => (log += chunk));
    api.stderr.on('data', (chunk) => (log += chunk));
    api.on('exit', (code, signal) => exits.push({ code, signal }));
    pin(api.pid);
    apis.push(api);
  }
  const listening = () => (log.match(/listening on port/g) || []).length;
  for (let i = 0; i < 300 && listening() < instances; i++) await new Promise((r) => setTimeout(r, 200));
  if (listening() < instances) throw new Error(`API did not start:\n${log}`);
  const bases = apis.map((_, i) => `http://127.0.0.1:${port + i}`);

  return {
    base: bases[0],
    bases,
    db,
    log: () => log,
    exited: () => exits[0] || null,
    rss: () => apis.reduce((sum, api) => sum + Math.round(Number(spawnSync('ps', ['-o', 'rss=', '-p', String(api.pid)], { encoding: 'utf8' }).stdout.trim() || 0) / 1024), 0),
    async stop() {
      for (const api of apis) api.kill('SIGTERM');
      await mongoose.disconnect();
      await mongo.stop();
    },
  };
}

/** Timed HTTP against the stack, keeping every timing and status by name. */
export function client(base) {
  /* One address, or several API processes taken in turn. */
  const bases = Array.isArray(base) ? base : [base];
  let turn = 0;
  const timings = new Map();
  const statuses = new Map();
  const reasons = new Map();
  const call = async (path, { method = 'GET', body, token, name } = {}) => {
    const label = name || `${method} ${path.split('?')[0].replace(/[0-9a-f]{24}/g, ':id')}`;
    const started = performance.now();
    let status = 0;
    let json = {};
    let bytes = 0;
    try {
      const response = await fetch(`${bases[turn++ % bases.length]}${path}`, {
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
    /* The first few things each refusal said, so a run can show why it was refused. */
    if (status >= 400) {
      const said = reasons.get(`${label} ${status}`) || new Set();
      if (said.size < 3 && json?.message) said.add(String(json.message).slice(0, 140));
      reasons.set(`${label} ${status}`, said);
    }
    return { status, json, ms, bytes };
  };
  return { call, timings, statuses, reasons };
}

export const pct = (list, p) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};
