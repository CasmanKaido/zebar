# ZEBAR: Automated Liquidity & Volume Bot - PRD

## 1. Executive Summary
**ZEBAR** is a specialized Solana trading bot designed to bootstrap liquidity and volume for the **$LPPP** token. It automates the process of "aping" into new high-potential launches on Pump.fun and immediately creating dual-sided liquidity pools on Meteora DLMM, pairing the new token with $LPPP.

## 2. Technical Objective
The primary goal is to create a seamless, high-speed pipeline from token discovery to liquidity provisioning, thereby increasing $LPPP's utility, holder count, and market presence.

## 3. Core Features

### 3.1. Market Scanning & Filtering
- **Source**: Solana DEX Pairs (Raydium, Meteora) via DexScreener/Birdeye API.
- **Trigger Criteria**:
    - **1h Volume**: Minimum $100,000.
    - **Liquidity**: Minimum $60,000 (Locked status preferred).
    - **Market Cap**: Minimum $60,000 (No upper limit).
- **Mechanism**: Periodic scanning (Polling) for tokens meeting these "Golden Ratios" of liquidity-to-mcap.

### 3.2. Automated Trading (Ape Strategy)
- **Calculation**: Real-time bonding curve state fetching to calculate optimal buy amounts.
- **Slippage**: Configurable slippage protection (Default: 10%).
- **Parameters**: Adjustable **Buy Size (SOL)** via the frontend dashboard.

### 3.3. Liquidity Provisioning (LP)
- **DEX**: Meteora DLMM (Dynamic Liquidity Market Maker).
- **Pairing**: All sniped tokens are paired with **$LPPP** (`44sHXMkPeciUpqhecfCysVs7RcaxeM24VPMauQouBREV`).
- **Amounts**: Automatically uses the full amount of tokens bought, paired with a user-specified amount of $LPPP.

### 3.4. Risk Management & Exit
- **Position Monitoring**: Real-time price tracking of the created pools.
- **TP (Take Profit)**: 8x Gain target.
- **Strategy**: Automatically withdraw **80%** of liquidity upon reaching the price target, leaving a **20% "Moonbag"** to capture further upside.

## 4. User Interface (Command Center)
- **Control Panel**: Modular Start/Stop bot controls.
- **Live Settings**: On-the-fly adjustment of Buy amounts and LP ratios.
- **Real-time Logs**: WebSocket-driven system terminal for monitoring blockchain interactions.
- **Market Intel**: Integrated Live Chart for $LPPP via DexScreener.
- **Stats**: Active pool tracking and ROI monitoring.

## 5. Technology Stack
- **Languages**: TypeScript, JavaScript.
- **Frameworks**: Node.js (Express), React (Vite).
- **Blockchain Libraries**: `@solana/web3.js`, `@meteora-ag/dlmm`, `@solana/spl-token`.
- **Aesthetics**: Cyberpunk Dark UI, Framer Motion, Vanilla CSS.

## 6. Security Architecture
- **Environment Isolation**: Sensitive keys stored in `.env`.
- **Hot Wallet System**: Designed to run with a dedicated bot wallet to minimize risk to primary assets.
- **Safety Fallbacks**: Base58 validation for all keys and automatic RPC backoff logic.
