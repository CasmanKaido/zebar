# PRD: ZEBAR – Advanced Market Sweeper & Auto-LP Engine

## 1. Project Overview
**ZEBAR** is a high-performance Solana trading bot designed to bridge the gap between aggressive market sweeping and strategic liquidity provisioning. It automates the lifecycle of a high-growth token play: from ecosystem-wide detection to optimal entry, and finally, seeding a high-yield **2% Fee** liquidity pool on Meteora CP-AMM.

---

## 2. Core Operational Pillars

### 2.1. Intelligent Market Sweeping
- **Broad Harvest**: Scans the entire Solana ecosystem (GeckoTerminal & DexScreener APIs) to identify trending tokens across Raydium, Meteora, and Orca.
- **Performance Filtering**:
    - **Min 1h Volume**: Targets tokens with active trading momentum.
    - **Liquidity/MCAP Throttling**: Ensures entry into tokens with established depth.
- **RugCheck Integration**: Automatic risk scoring via RugCheck API to filter out honey-pots and high-risk contracts.

### 2.2. Precision Execution (The Sniper)
- **Jupiter Ultra**: Utilizes Jupiter’s Ultra-routing for the best possible price impact and automatic slippage management.
- **Jito-Bundle Guaranteed**: Every buy is wrapped in a Jito Flashbot-style bundle with an automated tip (0.0001 SOL) to prevent front-running and guarantee landing the transaction during congestion.

### 2.3. Strategic Liquidity Provisioning (LP)
- **Meteora CP-AMM Integration**: Automatically transforms sniped positions into yield-bearing liquidity pools.
- **Dynamic Fee Config**: Selectable fee tiers (0.25%, 1%, **2%**, 4%) via the dashboard.
- **Market-Price Auto-Sync**: 
    - Real-time price correlation between the target Token and **$LPPP** (`44sHXM...BREV`).
    - Dynamically calculates the exact $LPPP amount needed to initialize the pool at the "Estimated Market Price."
- **Custom SDK Logic**: Uses specialized `createCustomPool` implementation to enable precise fee management and price alignment.

---

## 3. Risk & Capital Management

### 3.1. Take-Profit (TP) Strategy
- **Position Tracking**: Real-time ROI monitoring of all created bot-pools.
- **8x Exit Goal**: Automatic triggers for profit taking when the target multiplier is reached.
- **Strategy**: 80% withdrawal for capital protection + 20% "Moonbag" retention for exponential upside.

### 3.2. Session Safety (Batch Sniper)
- **Session Pool Limit**: Definable limit (e.g., 5 pools). The bot tracks its performance in real-time and executes a **Hard Stop** once the target number of plays is achieved.
- **Wallet Protection**: Ensures the bot never over-allocates capital in a single volatile window.

---

## 4. User Interface (The Command Center)
- **Architecture**: Unified React (Vite) + Node.js (Express) + Socket.io.
- **Control Panel**:
    - Toggle between USD/SOL/LPPP units for all inputs.
    - On-the-fly adjustment of scanner criteria and LP fees.
    - **Live Dashboard**: Real-time terminal logs, active pool tracking, and ROI updates.
- **Live Market Intel**: Integrated price feeds for SOL and $LPPP to monitor portfolio health in real-time.

---

## 5. Technology Stack
- **Languages**: TypeScript, JavaScript.
- **SDKs**: `@meteora-ag/cp-amm-sdk`, `@solana/web3.js`, `@solana/spl-token`.
- **Infrastructure**: WebSockets (Socket.io), Jito (Bundles), Jupiter (Swaps), Express.
- **Persistence**: Local history tracking with `pools.json` for persistence across restarts.

---

## 6. Security Architecture
- **Environment Isolation**: Private keys managed strictly via `.env`.
- **Dedicated Bot Wallet**: Designed for "Hot Wallet" usage with minimal permissions to safeguard primary assets.
- **RPC Resilience**: Automatic fallback logic between Jito Bundles and standard RPC execution.
