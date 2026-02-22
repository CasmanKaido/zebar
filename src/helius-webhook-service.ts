import { BotManager } from "./bot-manager";
import { SocketManager } from "./socket";
import { HELIUS_AUTH_SECRET, BASE_TOKENS } from "./config";
import { PublicKey } from "@solana/web3.js";

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

                // Detect "Liquidity Add" or "Pool Creation" events
                // Helius 'type' field often identifies these
                if (tx.type === "CREATE_POOL" || tx.type === "ADD_LIQUIDITY") {
                    this.processPoolEvent(tx, botManager);
                } else if (tx.type !== "SWAP") {
                    // Fallback: Check instructions for Raydium or Meteora Program IDs
                    // Exclude "SWAP" type explicitly to prevent swap-bombing rate limit death.
                    // Raydium V4: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
                    // Meteora CP-AMM: cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG
                    const isRaydium = tx.instructions?.some((ix: any) => ix.programId === "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
                    const isMeteora = tx.instructions?.some((ix: any) => ix.programId === "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");

                    if (isRaydium || isMeteora) {
                        // We still process it broadly — the processPoolEvent will verify if it's new
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
        // We look for a transfer that isn't SOL, USDC, USDT, or our custom Base Tokens
        const SOL_MINT = "So11111111111111111111111111111111111111112";
        const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
        const baseMints = Object.values(BASE_TOKENS).map(m => m.toBase58());

        const ignoredMints = new Set([SOL_MINT, USDC_MINT, USDT_MINT, ...baseMints]);

        const unconventionalTokens = tx.tokenTransfers
            ?.map((t: any) => t.mint)
            .filter((m: string) => m && !ignoredMints.has(m));

        if (!unconventionalTokens || unconventionalTokens.length === 0) return;

        // Use the first one as the candidate
        const mint = unconventionalTokens[0];

        // Pass a safely empty pair rather than guessing fragile account indices,
        // letting DexScreener natively resolve the verified pair inside `bot-manager.ts`
        const possiblePair = "";

        console.log(`[HELIUS] 🚀 New Pool Detected via Webhook! Mint: ${mint}`);
        SocketManager.emitLog(`[HELIUS] SCOUT EVENT: ${mint.slice(0, 8)}... detected in live block.`, "info");

        // Trigger Flash Evaluation in BotManager
        // We set dexId based on program ID if possible
        let dexId = "unknown";
        if (tx.instructions?.some((ix: any) => ix.programId === "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8")) dexId = "raydium";
        if (tx.instructions?.some((ix: any) => ix.programId === "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG")) dexId = "meteora";

        botManager.triggerFlashScout(mint, possiblePair, dexId).catch(err => {
            console.error(`[HELIUS ERROR] Failed to evaluate scout token ${mint}:`, err);
        });
    }
}
