# ZEBAR Master/Worker Architecture (Non-Custodial Sniper)

This document outlines the architecture for integrating **WalletConnect** into the ZEBAR bot while maintaining the speed required for sniping and removing the "approval bottleneck."

---

## 1. The Core Concept

Instead of the bot acting as a "Wallet Viewer" that needs a signature for every move, it acts as a **Managed Fund**.

### **The Master (You / WalletConnect)**
- **Role:** The ultimate owner and profit target.
- **Connection:** Via your phone or browser extension (Phantom, Solflare).
- **Control:** You connect once to "Top Up" the bot or "Drain" profits.
- **Security:** Your seed phrase and private key NEVER touch the server.

### **The Worker (The Bot / Server Key)**
- **Role:** The high-speed execution agent.
- **Connection:** A local `worker-key.json` generated on the server.
- **Control:** Autonomous 24/7 scanning, sniping, and LP management.
- **Security:** Holds only the "Trading Capital" you allocate (Risk is capped).

---

## 2. Interactive Workflow

### **Phase A: Onboarding**
1. User connects their **Master Wallet** via the ZEBAR Dashboard (WalletConnect).
2. The Dashboard displays:
   - **Master Balance:** (e.g., 50.5 SOL)
   - **Worker Balance:** (e.g., 0.0 SOL)
   - **Worker Address:** `Work...7x8y`
3. User clicks **"SYNC WORKER"** and approves a 2 SOL transfer on their phone.

### **Phase B: Autonomous Trading (The Path of No Bottlenecks)**
1. The Bot (using Worker Key) detects a high-volume token on the scanner.
2. Bot buys token using the 2 SOL worker balance.
3. Bot creates a Meteora LP pool.
4. **No Popups:** Because the bot has the *Worker Private Key* locally, it doesn't ask the Master for permission. It moves at the speed of the blockchain.

### **Phase C: Profit Sweeping**
1. The Bot detects a pool reached **8x ROI**.
2. **Automated Exit:** The Worker withdraws 80% liquidity.
3. **The Sweep:** The code executes an automatic transfer:
   ```typescript
   // Internal Logic
   const profit = totalProceeds - initialInvestment;
   await connection.transfer(profit, workerWallet, masterAddress);
   ```
4. **Security Check:** Even if someone compromises the server, they only get the current trading capital (the Worker balance), but they cannot touch your Master Wallet.

---

## 3. Technical Components

### **A. UI (React)**
- Integration of `@web3modal/solana` for the "Connect Wallet" button.
- A "Deposit to Worker" input field.
- A "Withdraw to Master" (Panic Button) that instantly drains the worker wallet to the connected master.

### **B. Backend (Node.js)**
- **Worker Management:** Auto-generates a keypair if one doesn't exist.
- **Authorization Logic:** The server only accepts commands (Start/Stop) if the request is signed by the Master Wallet (prevents unauthorized access to the bot control).
- **Sweep Logic:** A background task that ensures the Worker wallet Nunca exceeds a specific SOL limit (e.g., any balance > 5 SOL is auto-forwarded to Master).

---

## 4. Why this is better than "WalletConnect Only"

1. **Zero Latency:** Snipe trades execute in < 2 seconds. In a pure WalletConnect model, you would lose 10-20 seconds waiting for the user to unlock their phone.
2. **24/7 Operation:** You can go to sleep, and the bot continues to trade. WalletConnect requires the browser tab and phone to stay awake.
3. **Risk Containment:** You decide exactly how much SOL the bot is "allowed" to lose in a worst-case scenario.
4. **Clean Accounting:** Your master wallet history stays clean (only Deposits/Withdrawals), while the high-frequency "spam" stays in the worker wallet history.

---

## 5. UI Preview (Concept)

```text
+-------------------------------------------------+
|  [ MASTER: Work...7x8y ] [ BALANCE: 50.5 SOL ]  |
+-------------------------------------------------+
|                                                 |
|  BOT WORKER STATUS: ACTIVE                      |
|  WORKER BALANCE: 1.25 SOL                       |
|                                                 |
|  [ DEPOSIT 1 SOL ]  [ DRAIN TO MASTER ]         |
|                                                 |
|  [ CURRENT POOLS: 3 ] [ NET PROFIT: +4.2 SOL ]  |
+-------------------------------------------------+
```
