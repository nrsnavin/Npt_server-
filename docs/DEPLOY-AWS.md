# Hosting on a single AWS EC2 box

For the testing phase: one Ubuntu server running the API, MongoDB and Nginx, serving

- **`npt.baluelastics.com`** — the React app
- **`api2.baluelastics.com`** — the API

Roughly **$15–20/month**. You own patching, backups and uptime; that is the trade for the price
and the simplicity. Everything below is copy-paste in order, and takes about an hour the first
time.

> **Before you start.** The SMTP password for `info@baluelastics.com` was shared in plain text
> during development. Rotate it in Hostinger before it goes on a public server, and put the new
> one only in `.env` on the box — never in the repo.

**Which directory am I in?** If a block starts with `cd`, the directory matters and the block
says so. If it does not, the command is system-wide and works from anywhere — all of the apt
installs, the firewall, MongoDB, every Nginx command and certbot are in that second group.
Nginx is not "inside" the web repo: it reads the built files off disk by the path in its own
config, so nothing about it is run from the checkout.

---

## 1. Launch the instance

AWS console → **EC2 → Launch instance**.

| Field | Value |
|---|---|
| Name | `npt-erp` |
| AMI | **Ubuntu Server 24.04 LTS (64-bit x86)** |
| Instance type | **t3.small** (2 vCPU, 2 GB) |
| Key pair | Create one, download the `.pem`, keep it safe — it is the only way in |
| Storage | **60 GB gp3** — see *How much disk* below |

**Region:** pick `ap-south-1` (Mumbai). Every millisecond of latency is one your users in
Tiruppur pay on every click.

**How much disk.** Measured, not guessed (`tests/load/load-test.mjs` and a year of data loaded
into a real MongoDB):

| What | Year one | Grows by |
|---|---|---|
| Ubuntu, Node, MongoDB, Nginx | ~6 GB | — |
| The app, its `node_modules`, the web build | ~1.5 GB | — |
| Swap file (step 3) | 2 GB | — |
| **The database** — 100 queries a day with their threads, read markers and audit, plus quotes, orders, samples | **under 0.5 GB** | ~0.3 GB a year |
| Database backups kept on the box (14 nights, compressed) | ~1 GB | slowly |
| **Uploaded photos and documents** — about 30 a day at ~3 MB, a phone photo as taken | **~20–25 GB** | ~20–25 GB a year |
| Logs | ~1 GB | rotated |

So the files are nearly all of it, and 60 GB is year one with room to spare. The disk can be
made bigger later without stopping anything (EC2 → Volumes → Modify, then `sudo growpart
/dev/nvme0n1 1 && sudo resize2fs /dev/nvme0n1p1`). Set the alarm in *Disk alarm* below at 75% so
that is a planned change and not an outage: **a full disk stops MongoDB, and with it the whole
app.**

**Why t3.small, not t3.micro.** MongoDB, Node and Nginx on 1 GB will run until the first import
and then be killed by the OOM reaper — which looks like the app randomly dying, not like running
out of memory. 2 GB plus the swap file in step 3 is the smallest honest configuration.

### Security group

Create a new one, `npt-erp-sg`:

| Type | Port | Source | Why |
|---|---|---|---|
| SSH | 22 | **My IP** | Not `0.0.0.0/0` — an open SSH port is scanned within minutes |
| HTTP | 80 | `0.0.0.0/0` | Certbot needs it, and it redirects to HTTPS |
| HTTPS | 443 | `0.0.0.0/0` | The app |

**Do not open 27017.** MongoDB stays bound to localhost; nothing outside the box ever talks to
it directly.

### Elastic IP

EC2 → **Elastic IPs → Allocate**, then **Associate** it with the instance.

Without this the public IP changes on every stop/start, and your DNS quietly points at somebody
else's server. It is free while it is attached to a running instance.

Note the address — call it `<ELASTIC_IP>` below.

---

## 2. Point the domain at it

`baluelastics.com` is not managed in Route 53, so do this wherever its DNS lives — Hostinger's
control panel, most likely (**Domains → DNS / Nameservers**).

Add two **A** records:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `npt` | `<ELASTIC_IP>` | 300 |
| A | `api2` | `<ELASTIC_IP>` | 300 |

Do this **now**, before step 6 — certificates cannot be issued until the names resolve, and DNS
takes a few minutes to propagate. Check with:

```bash
dig +short npt.baluelastics.com
dig +short api2.baluelastics.com
```

Both must print `<ELASTIC_IP>` before you run certbot.

> Leave the MX and any TXT/SPF records alone. Adding an A record for a subdomain does not touch
> email for the root domain, but deleting the wrong row does.

---

## 3. First login and base setup

```bash
chmod 400 ~/Downloads/npt-erp.pem
ssh -i ~/Downloads/npt-erp.pem ubuntu@<ELASTIC_IP>
```

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git nginx ufw
```

**Swap.** 2 GB of RAM with MongoDB on it has no headroom for a build. This is what stops a
`npm ci` from taking the whole box down:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

**Firewall**, as a second layer behind the security group:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
```

---

## 4. Node 22 and MongoDB 8

**Node 22** — the version the test suite runs on:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v22.x
```

**MongoDB 8**:

```bash
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | \
  sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor

echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" | \
  sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list

sudo apt update && sudo apt install -y mongodb-org
sudo systemctl enable --now mongod
```

### Lock MongoDB down

It listens on localhost only by default. Verify, then add a user — because "only localhost" stops
being true the day something else is installed on the box:

```bash
grep bindIp /etc/mongod.conf     # must be 127.0.0.1
```

```bash
mongosh
```

```javascript
use admin
db.createUser({
  user: "nptadmin",
  pwd: "PUT-A-LONG-RANDOM-PASSWORD-HERE",
  roles: [{ role: "root", db: "admin" }]
})
exit
```

```bash
sudo sed -i 's/^#security:/security:\n  authorization: enabled/' /etc/mongod.conf
grep -A1 '^security:' /etc/mongod.conf    # confirm it took
sudo systemctl restart mongod
```

---

## 5. The application

```bash
sudo mkdir -p /srv/npt && sudo chown ubuntu:ubuntu /srv/npt
cd /srv/npt
git clone https://github.com/nrsnavin/Npt_server-.git server
git clone https://github.com/nrsnavin/Npt_web-.git web
```

### API

```bash
cd /srv/npt/server
npm ci --omit=dev
nano .env
```

```ini
NODE_ENV=production
PORT=5000
MONGO_URI=mongodb://nptadmin:PUT-A-LONG-RANDOM-PASSWORD-HERE@127.0.0.1:27017/npt_erp?authSource=admin

# Anything long and random. Changing it signs everybody out.
JWT_SECRET=GENERATE-WITH-openssl-rand-base64-48
JWT_EXPIRES_IN=7d

# The browser origin. Exact scheme and host — a trailing slash or http:// breaks every request
# with a CORS error that looks like the API being down.
CORS_ORIGIN=https://npt.baluelastics.com

# Sign-in codes. Use the ROTATED password.
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_USER=info@baluelastics.com
SMTP_PASSWORD=THE-NEW-ONE
SMTP_FROM=Navin Hangers <info@baluelastics.com>

# Optional. Leave INDIAMART_CRM_KEY empty and that feed stays off.
INDIAMART_CRM_KEY=
```

```bash
chmod 600 .env
openssl rand -base64 48        # paste into JWT_SECRET
```

Run the tests once on the box. If they pass, Node and Mongo are both healthy:

```bash
npm test
```

### Web

The API base URL is baked in **at build time** — it is not read at runtime, so this must be right
before you build:

```bash
cd /srv/npt/web
npm ci
echo 'VITE_API_URL=https://api2.baluelastics.com/api' > .env.production
npm run build      # produces dist/
```

---

## 6. Nginx

Run these from anywhere — they edit `/etc/nginx/`, not either repo.

```bash
sudo nano /etc/nginx/sites-available/npt
```

```nginx
# The React app.
server {
    listen 80;
    server_name npt.baluelastics.com;

    root /srv/npt/web/dist;
    index index.html;

    # A single-page app: every unknown path is a route, not a missing file. Without this,
    # reloading on /leads/123 returns a 404 from Nginx rather than the app.
    location / {
        try_files $uri $uri/ /index.html;
    }

    # index.html is the list of which hashed files this release uses, so it must never be held
    # by a browser. A cached copy asks for chunks the last deploy deleted, and the person gets
    # "This screen's code could not be fetched" on whichever screen they open next.
    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    # Hashed filenames, so they can be cached hard.
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";

        # A tab that was already open when a deploy landed is holding the *previous*
        # index.html, and asks for chunk names this build renamed. `on-box.sh` keeps the
        # previous build as dist.old, so serve it from there rather than 404.
        #
        # This is what makes a deploy invisible to somebody mid-shift. Without it the app
        # recovers by reloading the tab (see src/utils/lazyPage.js in the web repo), which
        # works but costs them the screen they were on.
        try_files $uri @previous;
    }

    location @previous {
        root /srv/npt/web/dist.old;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
}

# The API.
server {
    listen 80;
    server_name api2.baluelastics.com;

    # Attachments are photographs off a phone. The default 1 MB rejects most of them, and the
    # failure shows up in the browser as a generic network error.
    client_max_body_size 25M;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/npt /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### HTTPS

Only once `dig` shows both names pointing at the box:

```bash
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/bin/certbot
sudo certbot --nginx -d npt.baluelastics.com -d api2.baluelastics.com
```

Choose **redirect** when asked. Certbot rewrites the config for 443 and installs a renewal timer.
Check it will actually renew:

```bash
sudo certbot renew --dry-run
```

---

## 7. Keep the API running

`pm2 start` takes a *relative* path, so this one does need the `cd`. `pm2 status` and
`pm2 logs` afterwards do not.

```bash
sudo npm install -g pm2
cd /srv/npt/server
pm2 start src/server.js --name npt-api
pm2 save
pm2 startup systemd -u ubuntu --hp /home/ubuntu    # run the line it prints
```

```bash
pm2 status
pm2 logs npt-api --lines 50
```

The log should end with `NPT ERP API listening on port 5000`, `MongoDB connected`, and — if you
left the IndiaMART key empty — `IndiaMART: no key configured — the feed is off`.

---

## 8. First user

The database is empty, so nothing can sign in yet:

```bash
cd /srv/npt/server
npm run create-user -- rsnavin1@gmail.com 'a-real-password' --role=admin --name="Navin R"
```

Open **https://npt.baluelastics.com** and sign in.

> `npm run seed` loads demo data — three or four rows per model, which is enough to open every
> screen and work every board. `SEED_FULL=true npm run seed` loads the whole catalogue and the
> entire 26-27 quote sheet instead, which is the set to use when showing the system to somebody.
> Either way it **deletes the users first** and creates its own, including the admin above with
> the password printed in its own output — so seeding after you have created real accounts takes
> them with it. `npm run reset-data -- --keep=rsnavin1@gmail.com --confirm` clears the demo data
> again. Do not seed a database that has real work in it.

---

## 9. Backups

The two things that cannot be rebuilt from git:

```bash
mkdir -p /srv/npt/backups
nano /srv/npt/backup.sh
```

```bash
#!/bin/bash
set -euo pipefail
STAMP=$(date +%F-%H%M)
OUT=/srv/npt/backups

# The database.
mongodump --uri="mongodb://nptadmin:THE-PASSWORD@127.0.0.1:27017/npt_erp?authSource=admin" \
  --archive="$OUT/npt-$STAMP.archive" --gzip

# Keep a fortnight of database dumps. They are small — tens of MB.
find "$OUT" -type f -name '*.archive' -mtime +14 -delete

# The attachments are NOT copied here. They live inside the repo checkout and are not in git,
# so they must be backed up — but a nightly tar of the whole folder, kept for a fortnight, is
# fifteen copies of every photo on the same disk, and it fills the disk within months. They go
# to S3 instead, below, which copies only what is new each night.
```

```bash
chmod +x /srv/npt/backup.sh && chmod 600 /srv/npt/backup.sh
crontab -e
```

```
0 2 * * * /srv/npt/backup.sh >> /srv/npt/backups/backup.log 2>&1
```

**A backup on the same disk as the database is not a backup.** Push both off the box, to an S3
bucket in the same region with **versioning on** (so a file deleted or overwritten on the box
is still in S3). Only new files travel each night:

```bash
sudo snap install aws-cli --classic
aws configure                      # an IAM user with write access to one bucket, nothing more
# add to backup.sh:
aws s3 sync "$OUT" s3://npt-erp-backups/db/ --exclude '*.log'
aws s3 sync /srv/npt/server/uploads s3://npt-erp-backups/uploads/
```

S3 for this is roughly 25 GB after a year — well under $1 a month in Mumbai. Add a lifecycle
rule that moves `uploads/` to *Standard-IA* after 30 days and expires old versions after 90.

### Disk alarm

CloudWatch does not see disk usage on its own. Install the agent and alarm at 75%:

```bash
sudo apt install -y amazon-cloudwatch-agent   # or the .deb from AWS if apt lacks it
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-config-wizard   # choose disk used_percent for /
```

Then CloudWatch → Alarms → `disk_used_percent` for `/` ≥ 75 for 5 minutes → email. The instance
needs a role with `CloudWatchAgentServerPolicy`. Until that is in place, `df -h /` weekly.

Restore, when you need it:

```bash
mongorestore --uri="mongodb://nptadmin:THE-PASSWORD@127.0.0.1:27017/?authSource=admin" \
  --archive=/srv/npt/backups/npt-2026-08-28-0200.archive --gzip --drop
```

Test that command once, on purpose, before you need it.

---

## 10. Deploying an update

```bash
nano /srv/npt/deploy.sh
```

```bash
#!/bin/bash
set -euo pipefail

echo "→ API"
cd /srv/npt/server
git pull origin main
npm ci --omit=dev
npm test                       # stop here if anything fails
pm2 reload npt-api

echo "→ Web"
cd /srv/npt/web
git pull origin main
npm ci
npm run build                  # VITE_API_URL comes from .env.production

echo "✓ deployed"
```

```bash
chmod +x /srv/npt/deploy.sh
/srv/npt/deploy.sh
```

`pm2 reload` starts the new process before stopping the old one, so a deploy does not drop
requests. `npm ci` on the web side needs the swap file from step 3 — a Vite build on 2 GB with
MongoDB running is exactly what it is there for.

This is the floor, and it keeps working whatever else breaks. Step 11 makes it happen by itself.

### 10.1 Migrations, which a deploy never runs

Nothing above runs a migration and neither does the runner in step 11, deliberately: a script
that rewrites user records or reshapes documents should be watched by somebody who can read the
dry run, not fired by a merge at 11pm. **Back the database up first** (step 9), then run what the
release needs, in this order, each one dry by default:

```bash
cd /srv/npt/server

npm run migrate:task-departments     # tasks get a department
npm run migrate:grants               # quotations folded into pricing
npm run migrate:moulds               # the catalogue becomes moulds
npm run migrate:grant-modules        # people created before a module existed
npm run backfill:addresses           # consignments get a delivery address

# each prints what it would do and changes nothing. Then, one at a time:
npm run migrate:grant-modules -- --confirm
```

Only then `pm2 reload npt-api`.

**`migrate:grant-modules` is the one to run after any release that adds a module.** A department's
default access is read once, when a user is created, and never again — which is right, because an
admin who takes a module away from somebody should not have it handed back on the next deploy. The
cost is that a new module reaches nobody who already exists: the feature ships, the screens are
there, and the whole department gets a 403 with nothing explaining why. It only ever adds, only
what that person's own department already suggests, and it never touches a module somebody already
holds at any level. Running it twice finds nobody.

It takes module names, so a later release is `npm run migrate:grant-modules -- <module> --confirm`.

---

## 11. Deploying by itself: a runner on the box

An agent on the EC2 instance that pulls and builds when something lands on `main`, so a merge
reaches the plant without anybody opening a terminal.

**What it is.** A **GitHub Actions self-hosted runner** — a small service on the box that dials
out to GitHub, waits for work, and runs it locally. Both repos already run their tests on
GitHub's own machines on every push; the runner adds one more job at the end of that, which only
starts if those tests went green.

**Why this rather than the alternatives.** No inbound port is opened and no SSH key is stored at
GitHub — the runner makes an outbound connection and nothing on the internet can reach it. A
deploy key at GitHub is a key that can log into your server, held somewhere you do not control.
AWS CodeDeploy is the other obvious answer and is the wrong size for one box: it wants S3 or
CodePipeline, IAM roles and an `appspec.yml` to do what forty lines of bash does here.

> **Private repositories only.** A self-hosted runner on a public repo lets anyone who opens a
> pull request run code on your server — GitHub says so in its own documentation. Both of these
> repos are private. If either is ever made public, take the runner off it the same day.

### 11.1 Two runners, because there are two repositories

A personal account cannot share one runner across repositories, so the box runs one per repo.
They are small — idle, a runner is a few MB of RAM.

```bash
sudo mkdir -p /srv/runners/{server,web}
sudo chown -R ubuntu:ubuntu /srv/runners
```

Get the download line and the token from GitHub, per repo:

**`nrsnavin/Npt_server-` → Settings → Actions → Runners → New self-hosted runner → Linux x64.**

It shows a `curl` for the current release and a `./config.sh` line carrying a token that expires
in an hour. Use *its* URLs rather than the ones written here, which age.

```bash
cd /srv/runners/server
# the curl + tar lines GitHub showed you, then:
./config.sh --url https://github.com/nrsnavin/Npt_server- \
            --token <THE-TOKEN-GITHUB-SHOWED> \
            --name npt-box-server \
            --labels npt \
            --work _work \
            --unattended
```

The **`npt` label matters** — it is what `runs-on: [self-hosted, npt]` in the workflow matches. A
runner without it never picks the job up, and the job sits queued forever with no error.

Install it as a service so it survives a reboot:

```bash
sudo ./svc.sh install ubuntu
sudo ./svc.sh start
```

Then the same again for the web repo, from **`nrsnavin/Npt_web-` → Settings → Actions → Runners**:

```bash
cd /srv/runners/web
# its own curl + tar, then:
./config.sh --url https://github.com/nrsnavin/Npt_web- \
            --token <ITS-OWN-TOKEN> \
            --name npt-box-web \
            --labels npt \
            --work _work \
            --unattended
sudo ./svc.sh install ubuntu
sudo ./svc.sh start
```

Both should now read **Idle** on their repo's Runners page.

### 11.2 What runs

Each repo carries its own `deploy/on-box.sh`, and the workflow's `deploy` job runs it. Nothing
is configured at GitHub: the scripts are in the repos, reviewed like any other code, and the
same file deploys by hand over SSH when the runner is down.

| | `Npt_server-` | `Npt_web-` |
|---|---|---|
| Waits for | the test job | the checks job |
| Pulls into | `/srv/npt/server` | `/srv/npt/web` |
| Then | `npm ci --omit=dev`, `pm2 reload npt-api` | `npm ci`, builds, renames into `dist/` |
| Proves it worked | `/health/ready` answers within 20s | the site answers, and `dist/index.html` is not empty |
| If it did not | **resets to the previous commit and reloads** | leaves the previous build in `dist.old` |

Two things the scripts deliberately do **not** do:

**They do not run the tests again.** Those ran on GitHub against this exact commit on a machine
with room for them. Running them on 2 GB beside MongoDB buys nothing and is the step most likely
to die for want of memory. The health check is the protection that matters here, because it asks
the process actually serving traffic whether it can reach the database — which no test can.

**They never run a migration.** Migrations rewrite existing rows, several are not reversible, and
every one of them comes with "take a dump first". A deploy that ran them unattended could lose
the plant's data at three in the afternoon with nobody watching. When a release carries one, the
API's script says so at the end and stops:

```
→ THIS RELEASE CARRIES DATA SCRIPTS — none of them have been run
  scripts/backfill-delivery-addresses.js
```

That is your cue to do §9's dump and then run it by hand.

### 11.3 Turning it on

Merge to `main` in either repo. The Actions tab shows tests, then `deploy` on `npt-box-server`
or `npt-box-web`.

There is also a button: **Actions → the workflow → Run workflow**. Use it when the box was down
while something merged — catching up should not require inventing a commit.

### 11.4 Watching it

```bash
sudo journalctl -u 'actions.runner.*' -f     # both runners, live
pm2 logs npt-api --lines 50                  # what the API did on reload
ls -la /srv/npt/web/dist.old                 # the build before this one
```

Rolling the web back by hand, if a build is bad in a way the checks did not catch:

```bash
cd /srv/npt/web && mv dist dist.bad && mv dist.old dist
```

The API rolls itself back on a failed health check, so the manual equivalent is rarely needed:

```bash
cd /srv/npt/server && git reset --hard <previous-sha> && npm ci --omit=dev && pm2 reload npt-api
```

### 11.5 What this does not give you

Honest limits, so they are not discovered later:

- **The box still deploys to itself.** There is one instance, so a deploy that takes the API down
  takes it down for everybody. The health check shortens that to seconds; it cannot remove it.
- **Both runners share 2 GB with MongoDB.** The `concurrency` blocks in the workflows stop two
  deploys of the same repo overlapping, but an API deploy and a web build *can* run at once. That
  is what the swap file from step 3 is for.
- **A runner is a machine with your code on it.** Anyone who can merge to `main` can run commands
  on this server. That is the same trust as a deploy key, and it is why branch protection on
  `main` is worth turning on before this is.

---

## Checks and common failures

```bash
# /health sits outside the /api mount, so a probe never trips the rate limiter.
curl -s https://api2.baluelastics.com/health         # live
curl -s https://api2.baluelastics.com/health/ready   # live + the database
pm2 status                                          # online, low restarts
sudo systemctl status mongod nginx
df -h && free -m
```

| Symptom | Cause |
|---|---|
| Every API call fails, console says CORS | `CORS_ORIGIN` does not match the browser's origin exactly. No trailing slash, `https://` not `http://` |
| App loads, all requests 404 | `VITE_API_URL` was wrong at build time. Fix `.env.production` and **rebuild** — it is baked in |
| Reloading `/leads/123` gives Nginx's 404 | The `try_files` line is missing from the app's server block |
| "This screen's code could not be fetched", naming a file under `/assets/` | A tab was open across a deploy and is asking for a chunk this release renamed. The app reloads itself once to recover, so this message means that did not help: check `dist.old` exists and that the `@previous` fallback is in the server block |
| Uploads fail around 1 MB | `client_max_body_size` missing from the API block |
| API restarts in a loop | `pm2 logs npt-api` — usually `MONGO_URI` auth, or a missing `.env` |
| Whole box unresponsive after a deploy | Out of memory. Confirm swap is on with `free -m` |
| Sign-in codes never arrive | SMTP. `pm2 logs` names the variable that is wrong |
| The `deploy` job sits queued and never starts | No runner with the `npt` label is online. `sudo ./svc.sh status` in `/srv/runners/*` |
| Deploy ran, site unchanged | The web build failed its check and left `dist` alone. Read the job log; `dist.old` is the previous one |

---

## When this box stops being enough

The single-server shape is right for a testing phase and for a plant of this size. Move when one
of these becomes true, not before:

- **You cannot afford to lose an afternoon.** One box means one thing to lose. MongoDB Atlas
  (from ~$9/month) takes the database off it and backs itself up.
- **Deploys during working hours are a problem.** Two small instances behind an ALB let you
  update one at a time.
- **Attachments outgrow the disk.** They are on the instance's own volume; S3 is the answer, and
  `storage.service.js` is the only file that has to change.
