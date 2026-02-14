# LPPP Bot: Automated Liquidity & Volume Bot

**LPPP Bot** is a high-performance Solana trading and liquidity bot designed to maximize the utility of **$LPPP**. It uses advanced market scanning to identify tokens meeting a specific "Golden Ratio" of volume, liquidity, and market cap, immediately provides dual-sided liquidity on Meteora DLMM, and manages positions for automated profit-taking.

## 🚀 Core Strategy
LPPP Bot pivots away from high-risk sniping and focuses on "Validated Momentum" tokens.

1. **Market Scanning**: Polls Solana DEX pairs (Raydium/Meteora) via DexScreener API.
2. **Golden Ratio Filters**:
   - **1h Volume**: > $100,000 (Rolling demand)
   - **Liquidity**: > $60,000 (Stability)
   - **Market Cap**: > $60,000 (Validated growth)
3. **Execution**: Performs an instant market buy via **Jupiter v6 API**.
4. **Liquidity Provisioning**: Automatically creates a **Meteora DLMM** pool (Newly Bought Token + $LPPP).
5. **Position Management**: Monitors the position for target ROI (e.g., 8x) and executes automated exits.

## 🖥️ Command Center
LPPP Bot features a premium, cyberpunk-themed dashboard built with **React**, **Tailwind CSS v4**, and **Framer Motion**.

- **Real-time Terminal**: Live log stream of scanner activity and transaction status.
- **Dynamic Configuration**: Tune scan parameters (buy size, thresholds) on the fly without restarts.
- **Active Pool Tracking**: Grid view of all auto-deployed pools with ROI monitoring.
- **Live Chart**: Integrated DexScreener iframe for tracking **$LPPP** price action.

## 🛠️ Setup & Installation

### Prerequisites
- Node.js (v18+)
- A Solana Wallet (Private Key)
- RPC & WSS URLs (Mainnet)

### Configuration
Create a `.env` file in the root directory:
```env
RPC_URL=your_solana_rpc_url
WSS_URL=your_solana_wss_url
PRIVATE_KEY=your_base58_private_key
```

### Running the Bot
1. **Install Dependencies**:
   ```bash
   npm install
   cd client && npm install
   ```
2. **Start Backend & Scanner**:
   ```bash
   npm start
   ```
3. **Start Dashboard (React)**:
   ```bash
   npm run client
   ```

## ⚠️ Security WARNING
**PRIVATE_KEY**: Your private key is stored locally in `.env`. **NEVER** share your `.env` file or commit it to GitHub. ZEBAR is configured to ignore `.env` by default via `.gitignore`.

## 📜 License
ISC License. For Educational and Promotional purposes only. Use at your own risk.
