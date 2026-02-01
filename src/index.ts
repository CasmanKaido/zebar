
import { connection, wallet } from "./config";
import { PumpFunMonitor, NewTokenEvent } from "./monitor";
import { StrategyManager } from "./strategy";
import { PublicKey } from "@solana/web3.js";

async function main() {
    console.log("Zebar Auto-LP Bot Initializing...");
    console.log("Wallet:", wallet.publicKey.toBase58());

    const monitor = new PumpFunMonitor(connection, async (event: NewTokenEvent) => {
        console.log(`[NEW TOKEN] Found token: ${event.mint.toBase58()}`);

        const strategy = new StrategyManager(connection, wallet);

        // 1. Ape into the token (Buy on Pump.fun bonding curve)
        // Spend 0.1 SOL (example amount, strictly controlled)
        await strategy.apeToken(event.mint, 0.1);


        // 2. Create LP (New Token + LPPP)
        // Your LPPP token mint
        // TODO: move this to config
        const LPPP_MINT = new PublicKey("44sHXMkPeciUpqhecfCysVs7RcaxeM24VPMauQouBREV");


        // Create the pool with 10k of the new token and 1k LPPP (Example Ratios)
        const tokenAmount = BigInt(10000); // Add decimals logic
        const lpppAmount = BigInt(1000);   // Add decimals logic

        const poolInfo = await strategy.createMeteoraPool(event.mint, LPPP_MINT, tokenAmount, lpppAmount);

        if (poolInfo) {
            // 3. Start Monitoring for Exit
            // Assuming entry price is 1 (mock)
            strategy.monitorAndExit(poolInfo.poolId, 1);
        }

    });

    await monitor.start();
}

main().catch(console.error);
