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
| Storage | **30 GB gp3** |

**Region:** pick `ap-south-1` (Mumbai). Every millisecond of latency is one your users in
Tiruppur pay on every click.

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

    # Hashed filenames, so they can be cached hard. index.html must not be.
    location /assets/ {
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

> `npm run seed` loads demo data — customers, leads, sample enquiries. Useful for a testing phase,
> and `npm run reset-data -- --keep=rsnavin1@gmail.com --confirm` clears it again when you want to
> start clean. Do not seed a database that has real work in it.

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

# The attachments. These live inside the repo checkout and are NOT in git — a clean clone
# would lose every drawing and signed approval on the system.
tar czf "$OUT/uploads-$STAMP.tar.gz" -C /srv/npt/server uploads 2>/dev/null || true

# Keep a fortnight.
find "$OUT" -type f -mtime +14 -delete
```

```bash
chmod +x /srv/npt/backup.sh && chmod 600 /srv/npt/backup.sh
crontab -e
```

```
0 2 * * * /srv/npt/backup.sh >> /srv/npt/backups/backup.log 2>&1
```

**A backup on the same disk as the database is not a backup.** Once this works, push the archives
off the box — an S3 bucket with versioning is about $1/month:

```bash
sudo snap install aws-cli --classic
aws configure                      # an IAM user with write access to one bucket, nothing more
# add to backup.sh:
# aws s3 sync "$OUT" s3://npt-erp-backups/ --exclude '*.log'
```

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
| Uploads fail around 1 MB | `client_max_body_size` missing from the API block |
| API restarts in a loop | `pm2 logs npt-api` — usually `MONGO_URI` auth, or a missing `.env` |
| Whole box unresponsive after a deploy | Out of memory. Confirm swap is on with `free -m` |
| Sign-in codes never arrive | SMTP. `pm2 logs` names the variable that is wrong |

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
