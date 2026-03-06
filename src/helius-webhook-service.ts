import { BotManager } from "./bot-manager";
import { SocketManager } from "./socket";
import { HELIUS_AUTH_SECRET, BASE_TOKENS } from "./config";
import { constantTimeSecretEqual, normalizeBearerToken } from "./auth-utils";
import { DexScreenerService } from "./dexscreener-service";

/**
 * Helius Webhook Service
 * Handles real-time transaction notifications from Helius.
 * Primarily used to detect new Liquidity Pools (Raydium, Meteora).
 */
export class HeliusWebhookService {
    private static readonly MAX_CONCURRENT_TX = 2;
    private static readonly MAX_QUEUE_DEPTH = 200;
    private static readonly SEEN_TX_TTL_MS = 5 * 60 * 1000;
    private static readonly STATS_LOG_INTERVAL_MS = 15000;
    private static activeTx = 0;
    private static txQueue: Array<{ tx: any; botManager: BotManager }> = [];
    private static seenSignatures = new Map<string, number>();
    private static stats = {
        receivedPayloads: 0,
        receivedTxs: 0,
        queuedTxs: 0,
        droppedTxs: 0
    };
    private static lastStatsLogAt = 0;

    /**
     * Processes an incoming webhook payload from Helius.
     * @param payload Array of transaction objects from Helius
     * @param botManager Instance of BotManager to trigger evaluations
     * @param authHeader (Optional) Authentication secret from Helius
     */
    static async handleWebhook(payload: any, botManager: BotManager, authHeader?: string): Promise<boolean> {
        if (!botManager.isRunning) return true; // Silently ignore if bot is stopped

        // 1. Security Check
        if (HELIUS_AUTH_SECRET) {
            const token = normalizeBearerToken(authHeader);
            if (!token || !constantTimeSecretEqual(token, HELIUS_AUTH_SECRET)) {
                console.warn("[HELIUS] Unauthorized webhook attempt (invalid secret).");
                return false;
            }
        }

        if (!Array.isArray(payload)) {
            console.warn("[HELIUS] Invalid payload format (expected array).");
            return false;
        }

        this.stats.receivedPayloads++;
        this.stats.receivedTxs += payload.length;
        this.pruneSeenSignatures();

        for (const tx of payload) {
            const signature = typeof tx?.signature === "string" ? tx.signature : "";
            if (signature) {
                const seenAt = this.seenSignatures.get(signature);
                if (seenAt && Date.now() - seenAt < this.SEEN_TX_TTL_MS) continue;
                this.seenSignatures.set(signature, Date.now());
            }
            if (this.txQueue.length >= this.MAX_QUEUE_DEPTH) {
                this.stats.droppedTxs++;
                continue;
            }
            this.txQueue.push({ tx, botManager });
            this.stats.queuedTxs++;
        }
        this.logStatsIfNeeded();
        this.pumpQueue().catch(err => console.warn(`[HELIUS] Queue pump failed: ${err.message}`));

        return true;
    }

    private static async pumpQueue() {
        while (this.activeTx < this.MAX_CONCURRENT_TX && this.txQueue.length > 0) {
            const next = this.txQueue.shift();
            if (!next) break;

            this.activeTx++;
            this.processTransaction(next.tx, next.botManager)
                .catch((err) => {
                    console.warn(`[HELIUS] Error processing transaction ${next.tx?.signature}:`, err);
                })
                .finally(() => {
                    this.activeTx--;
                    this.pumpQueue().catch(innerErr => console.warn(`[HELIUS] Queue pump failed: ${innerErr.message}`));
                });
        }
    }

    private static async processTransaction(tx: any, botManager: BotManager) {
        if (!botManager.isRunning || !tx || tx.transactionError) return;

        const isPumpFunTx = tx.instructions?.some((ix: any) => ix.programId === "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
        const isTypedPoolEvent = tx.type === "CREATE_POOL" || tx.type === "ADD_LIQUIDITY" || (tx.type === "TOKEN_MINT" && isPumpFunTx);
        const isRaydium = tx.instructions?.some((ix: any) => ix.programId === "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
        const isMeteora = tx.instructions?.some((ix: any) => ix.programId === "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");

        if (isTypedPoolEvent || isRaydium || isMeteora || isPumpFunTx) {
            await this.processPoolEvent(tx, botManager);
        }
    }

    private static pruneSeenSignatures() {
        const cutoff = Date.now() - this.SEEN_TX_TTL_MS;
        for (const [signature, ts] of this.seenSignatures) {
            if (ts < cutoff) this.seenSignatures.delete(signature);
        }
    }

    private static logStatsIfNeeded() {
        const now = Date.now();
        if (now - this.lastStatsLogAt < this.STATS_LOG_INTERVAL_MS && this.stats.droppedTxs === 0) return;

        this.lastStatsLogAt = now;
        console.log(
            `[HELIUS] Webhook stats: payloads=${this.stats.receivedPayloads} txs=${this.stats.receivedTxs} queued=${this.stats.queuedTxs} dropped=${this.stats.droppedTxs} queueDepth=${this.txQueue.length} active=${this.activeTx}`
        );
        this.stats = { receivedPayloads: 0, receivedTxs: 0, queuedTxs: 0, droppedTxs: 0 };
    }

    /**
     * Extracts token and pair details and notifies the bot.
     */
    private static async processPoolEvent(tx: any, botManager: BotManager) {
        // Token Transfers usually contain the new token
        // Filter: Exclude only obvious stablecoins and quotes (SOL, USDC, USDT)
        // Include our base tokens since pools PAIRED WITH them are valuable
        const SOL_MINT = "So11111111111111111111111111111111111111112";
        const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
        let dexId = "unknown";
        if (tx.instructions?.some((ix: any) => ix.programId === "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8")) dexId = "raydium";
        if (tx.instructions?.some((ix: any) => ix.programId === "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG")) dexId = "meteora";
        if (tx.instructions?.some((ix: any) => ix.programId === "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")) dexId = "pumpfun";

        // Also ignore base tokens (LPPP, HTP, etc.) — pool creation triggers webhooks for these
        const baseTokenMints = Object.values(BASE_TOKENS).map(m => m.toBase58());
        const ignoredMints = new Set([SOL_MINT, USDC_MINT, USDT_MINT, ...baseTokenMints]);

        const candidatePairAddresses = new Set<string>();
        const addIfAddress = (value: any) => {
            if (typeof value === "string" && value.length >= 32) candidatePairAddresses.add(value);
        };

        (tx.accounts || []).forEach((acc: any) => addIfAddress(typeof acc === "string" ? acc : acc?.account));
        (tx.instructions || []).forEach((ix: any) => {
            (ix.accounts || []).forEach((acc: any) => addIfAddress(typeof acc === "string" ? acc : acc?.account));
        });

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

        for (const pairAddress of candidatePairAddresses) {
            const pair = await DexScreenerService.fetchPairByAddress(pairAddress, "HELIUS_PAIR");
            if (!pair) continue;
            if (dexId !== "unknown" && !pair.dexId?.toLowerCase().includes(dexId)) continue;

            const candidateMints = [pair.baseToken?.address, pair.quoteToken?.address]
                .filter((m: string) => m && !ignoredMints.has(m));

            for (const mint of candidateMints) {
                SocketManager.emitLog(`[HELIUS] SCOUT EVENT: ${mint.slice(0, 8)}... paired on ${pairAddress.slice(0, 8)}...`, "info");
                const isGraduation = (tx.type === "CREATE_POOL" || tx.type === "ADD_LIQUIDITY") && dexId !== "pumpfun";
                botManager.triggerFlashScout(mint, pairAddress, dexId, isGraduation, tx.feePayer).catch(err => {
                    console.error(`[HELIUS ERROR] Failed to evaluate scout token ${mint}:`, err);
                });
            }
            return;
        }

        if (unconventionalTokens.length === 0) return;

        for (const mint of unconventionalTokens) {
            if (!mint || mint.length < 40) continue;

            SocketManager.emitLog(`[HELIUS] SCOUT EVENT: ${mint.slice(0, 8)}... detected in live block (fallback).`, "warning");

            const isGraduation = (tx.type === "CREATE_POOL" || tx.type === "ADD_LIQUIDITY") && dexId !== "pumpfun";
            botManager.triggerFlashScout(mint, "", dexId, isGraduation, tx.feePayer).catch(err => {
                console.error(`[HELIUS ERROR] Failed to evaluate scout token ${mint}:`, err);
            });
        }
    }
}
