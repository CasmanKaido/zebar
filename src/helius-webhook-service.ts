import { BotManager } from "./bot-manager";
import { SocketManager } from "./socket";
import { HELIUS_AUTH_SECRET } from "./config";

/**
 * Helius Webhook Service
 * Handles real-time transaction notifications from Helius.
 * Primarily used to detect new Liquidity Pools (Raydium, Meteora).
 */
export class HeliusWebhookService {
    /**
     * Processes an incoming webhook payload from Helius.
     * @param payload Array of transaction objects from Helius
     * @param botManager Instance of BotManager to trigger evaluations
     * @param authHeader (Optional) Authentication secret from Helius
     */
    static async handleWebhook(payload: any, botManager: BotManager, authHeader?: string): Promise<boolean> {
        if (!botManager.isRunning) return true; // Silently ignore if bot is stopped

        console.log(`[HELIUS] Webhook received at ${new Date().toISOString()}`);
        // 1. Security Check
        if (HELIUS_AUTH_SECRET) {
            // Normalize header (handle potential "Bearer " prefix from Helius or proxies)
            const token = authHeader?.replace("Bearer ", "").trim();
            if (token !== HELIUS_AUTH_SECRET) {
                console.warn("[HELIUS] Unauthorized webhook attempt (invalid secret).");
                return false;
            }
        }

        if (!Array.isArray(payload)) {
            console.warn("[HELIUS] Invalid payload format (expected array).");
            return false;
        }

        for (const tx of payload) {
            try {
                // Ignore failed transactions
                if (tx.transactionError) continue;

                // Detect pool/liquidity events and Pump.fun bonding curve creations.
                // Pump.fun tokens appear as TOKEN_MINT — this is the earliest signal before graduation.
                const isPumpFunTx = tx.instructions?.some((ix: any) => ix.programId === "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

                if (tx.type === "CREATE_POOL" || tx.type === "ADD_LIQUIDITY" || (tx.type === "TOKEN_MINT" && isPumpFunTx)) {
                    this.processPoolEvent(tx, botManager);
                } else {
                    // Fallback: Check instructions for DEX Program IDs
                    // Many pool creations don't get typed properly, check program IDs instead
                    const isRaydium = tx.instructions?.some((ix: any) => ix.programId === "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
                    const isMeteora = tx.instructions?.some((ix: any) => ix.programId === "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");

                    if (isRaydium || isMeteora || isPumpFunTx) {
                        this.processPoolEvent(tx, botManager);
                    }
                }
            } catch (err) {
                console.warn(`[HELIUS] Error processing transaction ${tx.signature}:`, err);
            }
        }

        return true;
    }

    /**
     * Extracts token and pair details and notifies the bot.
     */
    private static processPoolEvent(tx: any, botManager: BotManager) {
        // Token Transfers usually contain the new token
        // Filter: Exclude only obvious stablecoins and quotes (SOL, USDC, USDT)
        // Include our base tokens since pools PAIRED WITH them are valuable
        const SOL_MINT = "So11111111111111111111111111111111111111112";
        const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

        const ignoredMints = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

        let unconventionalTokens = tx.tokenTransfers
            ?.map((t: any) => t.mint)
            .filter((m: string) => m && !ignoredMints.has(m)) || [];

        // Fallback: For Pump.fun TOKEN_MINT txs, tokenTransfers may be empty.
        // Extract mints from accountData (token account creations) instead.
        if (unconventionalTokens.length === 0 && tx.accountData) {
            const accountMints = tx.accountData
                .filter((a: any) => a.tokenBalanceChanges?.length > 0)
                .flatMap((a: any) => a.tokenBalanceChanges.map((tbc: any) => tbc.mint))
                .filter((m: string) => m && m.length >= 40 && !ignoredMints.has(m));
            unconventionalTokens = [...new Set(accountMints)];
        }

        if (unconventionalTokens.length === 0) {
            console.log(`[HELIUS] Skipped tx ${tx.signature?.slice(0, 8)}: No tradeable tokens found`);
            return;
        }

        // Process ALL unconventional tokens, not just first
        // (Multiple new tokens can be created in a single tx)
        for (const mint of unconventionalTokens) {
            if (!mint || mint.length < 40) continue;

            console.log(`[HELIUS] 🚀 New Pool Detected via Webhook! Mint: ${mint}`);
            SocketManager.emitLog(`[HELIUS] SCOUT EVENT: ${mint.slice(0, 8)}... detected in live block.`, "info");

            // Trigger Flash Evaluation in BotManager
            // We set dexId based on program ID if possible
            let dexId = "unknown";
            if (tx.instructions?.some((ix: any) => ix.programId === "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8")) dexId = "raydium";
            if (tx.instructions?.some((ix: any) => ix.programId === "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG")) dexId = "meteora";
            if (tx.instructions?.some((ix: any) => ix.programId === "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")) dexId = "pumpfun";

            // Pass graduation flag when a Pump.fun token creates a Raydium/Meteora pool
            const isGraduation = (tx.type === "CREATE_POOL" || tx.type === "ADD_LIQUIDITY") && dexId !== "pumpfun";
            botManager.triggerFlashScout(mint, "", dexId, isGraduation).catch(err => {
                console.error(`[HELIUS ERROR] Failed to evaluate scout token ${mint}:`, err);
            });
        }
    }
}
