# Hostinger VPS Deployment Guide (24/7 Hosting)

This guide is tailored for deploying your ZEBAR bot on a **Hostinger VPS** (Virtual Private Server). This runs your bot 24/7 for about **$5.99/mo** (KVM 1 Plan).

## Step 1: Buy & Set Up Hostinger VPS
1.  Go to **Hostinger** -> **VPS**.
2.  Choose the **KVM 1** plan (1 vCPU, 4GB RAM is plenty).
3.  **Operating System**: Select **Ubuntu 22.04 64bit**.
4.  Finish the purchase.
5.  Go to the **VPS Dashboard** and set a **Root Password**.
    *   *Note: Save this password! You will need it to login.*

## Step 2: Connect to Your Server
You can use the "Browser Terminal" in Hostinger, but it's better to use your own terminal (Command Prompt/PowerShell).

1.  Find your **VPS IP Address** in the Hostinger Dashboard (e.g., `123.45.67.89`).
2.  Open **Command Prompt** (Windows) or **Terminal** (Mac).
3.  Type this command:
    ```bash
    ssh root@<YOUR_VPS_IP>
    ```
    *(Replace `<YOUR_VPS_IP>` with the actual numbers).*
4.  Type `yes` if asked about authenticity.
5.  Enter the **Root Password** you set in Step 1.
    *(Note: You won't see the characters while typing the password. Just type it and press Enter).*

## Step 2.5: PREVENT CRASHES (Create Swap File)
**Crucial Step:** Small servers (1GB RAM) will crash during build without this. Run these commands to add 2GB of "fake RAM" (swap):

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' | tee -a /etc/fstab
```

## Step 3: Install Docker (One-Time Setup)
Copy and paste this entire block into your VPS terminal to install Docker:

```bash
# Update and install Docker & Compose
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

## Step 4: Deploy Your Bot
Now, download your bot code and run it.

```bash
# 1. Clone your repository
git clone https://github.com/CasmanKaido/zebar.git
cd zebar

# 2. Create your .env file
nano .env
# -> PASTE your .env contents here inside the window
# -> Press Ctrl+X, then Y, then Enter to save.

# 3. Start the bot (in the background)
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
    git pull
    docker compose up -d --build
    ```
*   **Stop Bot**: `docker compose down`
