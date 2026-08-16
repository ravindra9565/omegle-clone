GlobeChat — Deploy to Oracle Cloud (Always Free) - Quickstart

Overview
- This guide sets up a proof-of-concept GlobeChat deployment using an Oracle Cloud Always Free VM + Always Free Autonomous Database.
- The repo contains: docker-compose.yml, a minimal signaling server (Socket.IO), coturn config, Redis, and nginx to serve static frontend.
- Oracle Autonomous DB is optional for user accounts; the signaling server works with Redis only for matchmaking. If you want persistent user/account features, configure the server to use the Autonomous DB and the node-oracledb driver.

High-level steps
1) Create an Oracle Cloud account and provision Always Free resources:
   - Compute (VM instance) running Ubuntu 22.04
   - Autonomous Database (Autonomous Transaction Processing) — note the wallet download step
2) Configure a public domain and DNS A record pointing to your VM IP (recommended)
3) SSH into the VM, install Docker & Docker Compose
4) Clone this repo on the VM
5) Place Oracle wallet and (optionally) Oracle Instant Client zip into server/ if you plan to enable DB features
6) Update .env (copy .env.sample -> .env) with your domain, TURN creds, etc.
7) Obtain TLS certs (certbot) and place them under ./certs or use certbot with nginx
8) Start services: docker-compose up -d

Detailed commands (run on the VM)
# 1. Update & install docker
sudo apt-get update && sudo apt-get install -y docker.io docker-compose git
sudo systemctl enable --now docker

# 2. Clone repo (on the VM)
cd /opt
sudo git clone <COPY_YOUR_REPO_URL_HERE> globechat
cd globechat
sudo chown -R $USER:$USER .

# 3. Prepare .env
cp .env.sample .env
# Edit .env: set DOMAIN, TURN_URL (e.g. turn:your-vm-ip), TURN_USER, TURN_PASS

# 4. (Optional) Autonomous DB wallet
# In OCI Console, download the DB wallet (zip) for the Autonomous Database.
# Upload the wallet.zip to the server and unzip into server/oracle_wallet
# Example (on your local machine): scp wallet_<db>.zip opc@<vm-ip>:/opt/globechat/server/
# Then on VM:
# unzip server/wallet_<db>.zip -d server/oracle_wallet

# 5. (Optional) Oracle Instant Client
# If you want the signaling server to talk to Autonomous DB directly, download the Oracle Instant Client Basic and SDK zip files from Oracle (requires accepting license) and place them in server/ as oracle-instantclient.zip before building the signaling image.

# 6. TLS certificates (recommended)
# Install certbot and get certs for your domain. Example with nginx installed in the compose stack: run certbot on the host and place cert files under ./certs with names fullchain.pem and privkey.pem.

# 7. Edit coturn/turnserver.conf
# Set static-auth-secret to a long random value and external-ip to "PUBLIC_IP/PRIVATE_IP"

# 8. Build & start
docker compose build
docker compose up -d

# 9. Firewall (OCI): open ports
# - 80/tcp, 443/tcp (nginx)
# - 3478/tcp and 3478/udp (coturn)
# - 5349/tcp and 5349/udp (coturn TLS)
# - UDP range 49152-65535 (coturn relay)

Testing from remote machine
- Open your domain in browser: https://your-domain
- From two different networks (or two browsers with separate devices), click to start random pairing. The client uses /turn to fetch TURN URL and credentials.

Notes, security and production considerations
- TURN bandwidth is the primary cost for video relay. Oracle Always Free VM has limited egress — for heavy production consider managed TURN providers or higher-capacity instances.
- Use lt-cred-mech (long-term credential mechanism) with HMAC-based TURN credentials (recommended) rather than static credentials.
- Run multiple signaling instances behind a load balancer; use Redis for coordination.
- Replace in-memory matchmaking with Redis-backed queues for multi-instance scaling.
- Implement moderation (reporting, real-time voice moderation) and rate limits.

If you want, next steps I can produce now:
- A deploy script (PowerShell / Bash) that provisions the server, installs Docker, and launches docker-compose for Oracle VM
- A more complete signaling server that stores users/reports into Oracle Autonomous DB (requires wallet details)
- A Kubernetes/OCI OKE version for production

