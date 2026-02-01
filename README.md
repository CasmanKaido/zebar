# ZEBAR: Automated Liquidity & Volume Bot

**ZEBAR** is a high-performance Solana bot designed to automate the lifecycle of new token launches. It monitors Pump.fun for new creations, performs an immediate "Ape" buy, and then creates a Meteora DLMM liquidity pool paired with your token (e.g., **$LPPP**).
 It then manages the position to exit 80% upon hitting an 8x target.

## Setup

1.  **Install Dependencies**
    ```bash
    npm install
    ```

2.  **Configuration**
    *   Rename `.env.example` to `.env` (if applicable) or create `.env`:
        ```env
        RPC_URL=https://api.mainnet-beta.solana.com
        PRIVATE_KEY=[YOUR_PRIVATE_KEY_ARRAY_OR_BASE58]
        ```
    *   Update `src/index.ts`:
        *   Replace `RHIVA_MINT` with your actual token's Mint Address.
        *   Adjust `apeToken` amount (currently 0.1 SOL).

3.  **Run**
    ```bash
    npm start
    ```
    (Or `npx ts-node src/index.ts`)

## Architecture

*   `src/monitor.ts`: Listens to Solana logs for Pump.fun "Create" events.
*   `src/strategy.ts`:
    *   `apeToken`: Handles the buy transaction on Pump.fun.
    *   `createRaydiumPool`: Interactions with Raydium SDK to create the LP.
    *   `monitorAndExit`: Tracks price and removes liquidity.
*   `src/index.ts`: Main entry point.

## Important Notes

*   **Cost**: Creating a Raydium Pool (Market ID) costs ~3 SOL per pool. Ensure your wallet is funded.
*   **Safety**: The current code contains **MOCK** implementations for the actual Buy and Pool Creation to prevent accidental spending during testing. You must implement the specific SDK calls for production.
