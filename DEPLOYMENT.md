# LPPP Bot Unified Deployment Guide (Railway) 🚀

You can now host **both** the LPPP Bot and the Command Center on a single Railway service. This is cheaper, easier to manage, and more stable.

## 1. Prepare your Repository
Ensure your latest code is pushed to GitHub. I have already updated the project to:
- Automatically serve the frontend dashboard from the backend server.
- Handle websocket connections on the same port.
- Bundle everything into one container.

## 2. Deploy to Railway.app
1.  **Create a New Project**: 
    - Go to [Railway.app](https://railway.app/).
    - Click **New Project** > **Deploy from GitHub repo**.
    - Select your `lppp-bot` repository.
2.  **Add Environment Variables**:
    In the Railway dashboard, go to the **Variables** tab and add your secure credentials:
    - `RPC_URL`: Your Solana RPC.
    - `WSS_URL`: Your Solana WSS.
    - `PRIVATE_KEY`: Your Solana wallet private key.
3.  **Generate a Domain**:
    - Go to **Settings** > **Networking**.
    - Click **"Generate Domain"**.
    - This will be the only URL you need for both the Dashboard and the Bot!

## 3. How to Access
- **Dashboard**: Visit the URL Railway gave you (e.g., `https://lppp-bot.up.railway.app`).
- **Bot Control**: Everything is already linked. Just click **INITIALIZE SYSTEM** in the dashboard.

---

## 💡 Why this is better:
- **Zero Configuration**: No need to manually link Vercel and Railway URLs.
- **Lower Cost**: You only run one service.
- **No CORS Issues**: The frontend and backend talk to each other on the same host.
- **Persistent Logic**: The scanner runs 24/7 in the background while you monitor it from the UI.
