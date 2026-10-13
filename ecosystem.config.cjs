/**
 * pm2's settings for the API — `pm2 start ecosystem.config.cjs` from this folder.
 *
 * Two API processes in cluster mode, one per vCPU: Node runs a request on one core, so a single
 * process leaves the second core to MongoDB alone. The 50-person load test
 * (`npm run load-test:50`) passes on one process or two; two give about 40% more capacity at
 * peak and halve the nine-o'clock sign-in wait (docs/DEPLOY-AWS.md §7 has the figures). Everything that has to happen once — reminders,
 * escalations, the IndiaMART pull, handover delivery — takes a lease first, so two processes run
 * each job once (docs/SCALING.md §3).
 *
 * Memory: each process is told to tidy up at 512 MB and is restarted cleanly past 800 MB. Two of
 * them beside MongoDB want a 4 GB server (t3.medium); on a 2 GB server set API_INSTANCES=1.
 * With more than one process, set REDIS_URL too, so rate limits and the signed-in-user cache are
 * shared rather than counted per process (docs/SCALING.md §4).
 */
module.exports = {
  apps: [
    {
      name: 'npt-api',
      script: 'src/server.js',
      exec_mode: 'cluster',
      instances: Number(process.env.API_INSTANCES) || 2,
      node_args: '--max-old-space-size=512',
      max_memory_restart: '800M',
      /* A reload starts the new process before stopping the old one: no dropped requests on deploy. */
      wait_ready: false,
      listen_timeout: 20000,
      kill_timeout: 15000,
      env: { NODE_ENV: 'production' },
    },
  ],
};
