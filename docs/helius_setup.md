# Helius Webhook Setup Guide

To enable real-time **Scout Mode**, you need to link your Helius account to your bot's new webhook endpoint.

## 1. Get Your Webhook URL
Your bot's endpoint is:
`https://your-coolify-app-url.com/api/webhooks/helius`

> [!IMPORTANT]
> Ensure your app is reachable from the public internet (Coolify handles this by default).

## 2. Generate a Security Secret
1. Pick a random password or secret string (e.g., `my_helius_pass_123`).
2. Add it to your **Coolify Environment Variables** as:
   `HELIUS_AUTH_SECRET=your_secret_here`
3. Restart your Coolify deployment.

## 3. Configure Helius Dashboard
1. Log in to [Helius.dev](https://helius.dev).
2. Go to **Webhooks** -> **New Webhook**.
3. **Webhook URL:** Paste your URL from Step 1.
4. **Webhook Type:** Select `Enhanced`.
5. **Transaction Type:** Select **`Any`** (This ensures we catch both initialization and first liquidity adds).
6. **Transaction Status:** Select `Success`.
7. **Auth Token:** In the "Auth Token" or "Authentication" box, simply paste your secret (e.g., `my_helius_pass_123`).
   > [!NOTE]
   > The bot will automatically handle the header mapping. You do NOT need to manually add an "Authorization" key if there is only one box; Helius sends the token in that header by default.

## 4. Select What to Monitor (Addresses)
Add these Program IDs to the "Account Addresses" list (one per line):
- **Raydium V4:** `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`
- **Meteora CPMM:** `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`
- **Pump.fun:** `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`

## 5. Save & Test
1. Click **Test Webhook**. You should see a `200 OK` in Helius and `[HELIUS] Authorized webhook attempt` (or an array warning) in your Coolify logs.
2. Click **Create Webhook**.

Your bot is now a real-time Sniper! 🚀
