# ZEBAR Deployment Guide 🚀

This guide explains how to deploy **ZEBAR** with a persistent 24/7 backend and a high-performance frontend.

## 1. Backend (The Bot) - Railway.app
Railway is the best place to run the ZEBAR engine.

### Steps:
1.  **Fork/Push to GitHub**: Ensure your latest code is on GitHub.
2.  **Create Railway Project**: 
    - Go to [Railway.app](https://railway.app/).
    - Click **New Project** > **Deploy from GitHub repo**.
    - Select your `zebar` repository.
3.  **Variables (CRITICAL)**:
    In the Railway dashboard, go to the **Variables** tab and add:
    - `RPC_URL`: Your Solana RPC (Helius/QuickNode recommended).
    - `WSS_URL`: Your Solana WSS URL.
    - `PRIVATE_KEY`: Your Solana wallet private key (Base58).
    - `PORT`: `3001`
4.  **Wait for Build**: Railway will detect the `Dockerfile` I created and build the environment automatically.

---

## 2. Frontend (The Dashboard) - Vercel
Vercel hosts the UI where you control the bot.

### Steps:
1.  **New Vercel Project**:
    - Go to [Vercel.com](https://vercel.com/).
    - Click **Add New** > **Project**.
    - Import your `zebar` repository.
2.  **Project Configuration**:
    - **Framework Preset**: `Vite`.
    - **Root Directory**: `client`.
    - **Build Command**: `npm run build`.
    - **Output Directory**: `dist`.
3.  **Variables**:
    Add the following environment variable:
    - `VITE_BACKEND_URL`: The **Public URL** provided by Railway (e.g., `https://zebar-production.up.railway.app`). 
4.  **Deploy**: Click deploy and wait 1 minute.

---

## 3. Post-Deployment Check
1.  Open your Vercel URL.
2.  Check the **Terminal** window in the dashboard.
3.  If it says "Connected to Backend," you are live!
4.  Click **INITIALIZE SYSTEM** to start scanning.

---

## 🛠 Troubleshooting
- **Dashboard says "System Offline"**: Double-check that your `VITE_BACKEND_URL` on Vercel matches your Railway Public URL exactly (no trailing slash).
- **Bot crashes**: Check Railway logs. Usually, this is due to an invalid RPC URL or an empty wallet.
