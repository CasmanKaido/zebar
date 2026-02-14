# Cheapest 24/7 Deployment Guide (VPS + Docker)

Since you have exhausted the free tiers of PaaS providers like Vercel and Railway, the most cost-effective and reliable way to host your bot 24/7 is using a **Virtual Private Server (VPS)**.

**Estimated Cost: $4 - $6 / month**

## Recommended Providers
*   **Hostinger VPS** (Great for beginners, often has one-click Docker setup)
*   **Hetzner Cloud** (Cheapest reliable option, ~€4-5/mo)
*   **DigitalOcean** (Basic Droplet, $4/mo)

### Special Note for Hostinger Users:
*   **Template**: When setting up, choose **"Ubuntu 22.04 with Docker"** (Found in OS & Templates -> Applications). It skips the Docker installation step!
*   **Firewall**: Hostinger blocks ports by default. Go to your **hPanel -> VPS -> Settings -> Security -> Firewall** and create a New Firewall Configuration. Add an "Allow" rule for **Port 3000** (TCP) so you can access your bot's website.

## Step 1: Prepare Your Code
I have already added the necessary Docker files to your project:
*   `Dockerfile`: Instructions to build your bot and frontend.
*   `docker-compose.yml`: Script to run the bot with one command.

Ensure you push these changes to GitHub:
```bash
git add .
git commit -m "Added Docker deployment files"
git push
```

## Step 2: Get a VPS
1.  Sign up for one of the providers above.
2.  Create a **Ubuntu 22.04** or **Debian 12** server.
3.  Choose the smallest size (1 vCPU, 512MB or 1GB RAM is enough for this bot).
4.  Copy the **IP Address** and **root password** (or add your SSH key).

## Step 3: Setup the Server
Open a terminal on your computer and SSH into your new server:
```bash
ssh root@<YOUR_SERVER_IP>
# Enter password if asked
```

Run these commands to install Docker (copy-paste the whole block):
```bash
# Update and install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# Install Docker Compose
apt-get install -y docker-compose-plugin
```

## Step 4: Deploy Your Bot
On the server, clone your repo and run it:

```bash
# 1. Clone your repository
git clone https://github.com/CasmanKaido/zebar.git
cd zebar

# 2. Create your .env file
nano .env
# PASTE your .env contents here (from your local machine)
# Press Ctrl+X, then Y, then Enter to save.

# 3. Start the bot
docker compose up -d --build
```

**That's it!** 
*   Your bot is now running in the background.
*   It will automatically restart if the server reboots.
*   You can access the frontend at `http://<YOUR_SERVER_IP>:3000`

## Useful Commands
*   **View Logs**: `docker compose logs -f`
*   **Update Bot**: 
    ```bash
cd ~/zebar
git pull
npm install  # <--- Triggers 'postinstall' which builds frontend + backend automatically
npm run start:prod
```
*   **Stop Bot**: `docker compose down`
