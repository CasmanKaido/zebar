import { connection, monitorConnection, wallet, POOL_DATA_FILE, BASE_TOKENS, SOL_MINT, USDC_MINT, JUPITER_API_KEY } from "./config";
import { MarketScanner, ScanResult, ScannerCriteria } from "./scanner";
import { StrategyManager } from "./strategy";
import { PublicKey } from "@solana/web3.js";
import { SocketManager } from "./socket";
import { OnChainSafetyChecker } from "./rugcheck";
import * as fs from "fs/promises";
import * as path from "path";
import { GeckoService } from "./gecko-service";
import axios from "axios";
import { dbService } from "./db-service";
import { PoolData, TradeHistory, BotSettings } from "./types";
import { securityGuard } from "./security-guard";
import { TokenMetadataService } from "./token-metadata-service";
import { JupiterPriceService } from "./jupiter-price-service";
import { safeRpc } from "./rpc-utils";
import { DexScreenerService } from "./dexscreener-service";
import { BirdeyeService } from "./birdeye-service";




// Removed local BotSettings interface — now imported from types.ts

export class BotManager {
    public isRunning: boolean = false;
    private scanner: MarketScanner | null = null;
    private strategy: StrategyManager;
    private sessionPoolCount: number = 0;
    private monitorInterval: NodeJS.Timeout | null = null;
    private _runMonitor: (() => Promise<void>) | null = null; // Stored reference for immediate sweep triggers
    private pendingMints: Set<string> = new Set(); // Guards against duplicate buys
    private activeTpSlActions: Set<string> = new Set(); // Guards against double TP/SL
    private rejectedTokens: Map<string, { reason: string, expiry: number }> = new Map(); // Fix 5: Cache rejected tokens
    private lastMonitorHeartbeat: number = Date.now(); // Watchdog: Track monitor activity
    private healthCheckInterval: NodeJS.Timeout | null = null;
    private isUsingBackup: boolean = false;
    private _flashRetryCount: Map<string, number> = new Map(); // Track retry attempts for DexScreener resolution
    private _pumpfunWatchlist: Map<string, number> = new Map(); // Pump.fun tokens rejected on curve — re-evaluate on graduation
    private _wsSubscriptionIds: number[] = []; // WebSocket subscription IDs for cleanup
    private _wsIntervalIds: ReturnType<typeof setInterval>[] = []; // setInterval IDs for cleanup
    private evaluationQueue: ScanResult[] = [];
    private isProcessingQueue: boolean = false;
    private settings: BotSettings = {
        buyAmount: 0.1,
        lpppAmount: 0,
        meteoraFeeBps: 200,
        maxPools: 5,
        slippage: 10,
        volume5m: { min: 2000, max: 0 },
        volume1h: { min: 25000, max: 0 },
        volume24h: { min: 100000, max: 0 },
        liquidity: { min: 10000, max: 0 },
        mcap: { min: 100000, max: 0 },
        mode: "SCOUT",
        maxAgeMinutes: 0,
        baseToken: "LPPP",
        tp1Multiplier: 7,
        tp1WithdrawPct: 30,
        tp2Multiplier: 14,
        tp2WithdrawPct: 30,
        stopLossPct: -2,
        enableStopLoss: true,
        enableReputation: true,
        enableBundle: true,
        enableInvestment: true,
        enableSimulation: false,
        minDevTxCount: 50,
        enableAuthorityCheck: true,
        enableHolderAnalysis: true,
        enableScoring: false,
        maxTop5HolderPct: 50,
        minSafetyScore: 0.3,
        minTokenScore: 60,
        enablePrebond: false,
        prebondEnableReputation: true,
        prebondEnableBundle: true,
        prebondEnableSimulation: false,
        prebondEnableAuthority: true,
        prebondMinDevTxCount: 10,
        prebondMinMcap: 0,
        prebondMaxMcap: 0,
        prebondMinHolders: 0,
        prebondMinOrganicScore: 0,
        prebondMaxTopHolderPct: 0,
        prebondMaxAgeMinutes: 0,
        prebondMinVolume5m: 0,
        prebondMinVolume1h: 0,
        prebondMinVolume24h: 0
    };

    constructor() {
        this.strategy = new StrategyManager(connection, wallet);
        this.initialize();
    }

    public getSettings(): BotSettings {
        return this.settings;
    }

    public async loadSettings() {
        const saved = await dbService.getSettings();
        if (saved) {
            this.settings = saved;
            console.log("[BOT] Loaded persistent settings from DB.");
        }
    }

    private async initialize() {
        // 1. Load Persistent Settings
        await this.loadSettings();

        // 2. Migrate if needed
        await this.migrateFromJsonToSqlite();

        // 3. Load and Start Monitor (bot-created pools only)
        await this.loadAndMonitor();
    }

    private async loadAndMonitor() {
        try {
            const allPools = await dbService.getAllPools();
            const history = allPools.filter(p => p.isBotCreated);
            console.log(`[BOT] Loaded ${history.length} bot-managed pools from SQLite (${allPools.length - history.length} recovered pools ignored).`);
            history.forEach((p: PoolData) => SocketManager.emitPool(p));

            this.startHealthCheck();

            // Reconcile and Start Monitoring
            await this.reconcilePendingWithdrawals(history);

            // Kick off position monitor (only if not already running)
            if (!this.monitorInterval) {
                this.monitorPositions();
            }
        } catch (e: any) {
            console.error("[BOT] Initialization failed:", e.message);
        }
    }

    /**
     * Reconciles pools that were left in a 'withdrawalPending' state due to a crash (Issue 30).
     */
    private async reconcilePendingWithdrawals(pools: PoolData[]) {
        const pending = pools.filter(p => p.withdrawalPending && !p.exited);
        if (pending.length === 0) return;

        SocketManager.emitLog(`[RECOVERY] Found ${pending.length} pending withdrawals. Reconciling with chain...`, "warning");

        const { CpAmm } = require("@meteora-ag/cp-amm-sdk");
        const cpAmm = new CpAmm(connection);

        for (const pool of pending) {
            try {
                const poolPubkey = new PublicKey(pool.poolId);
                const positions = await cpAmm.getUserPositionByPool(poolPubkey, wallet.publicKey);

                if (positions.length === 0) {
                    SocketManager.emitLog(`[RECOVERY] Pool ${pool.poolId.slice(0, 8)}... position is gone. Marking as exited.`, "success");
                    await this.updatePoolROI(pool.poolId, "CLOSED", true, undefined, { withdrawalPending: false });
                } else {
                    SocketManager.emitLog(`[RECOVERY] Pool ${pool.poolId.slice(0, 8)}... position still exists. Clearing pending flag.`, "info");
                    // Just clear the flag so it can be re-tried manually if needed
                    await this.updatePoolROI(pool.poolId, pool.roi, false, undefined, { withdrawalPending: false });
                }
            } catch (err) {
                console.error(`[RECOVERY] Failed to reconcile pool ${pool.poolId}:`, err);
            }
        }
    }

    /**
     * Scans the blockchain and re-registers any active Meteora positions missing from the DB.
     */
    private startHealthCheck() {
        if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = setInterval(() => this.checkRpcHealth(), 60000); // Check every 60s
    }

    private async checkRpcHealth() {
        const { RPC_URL, BACKUP_RPC_URL, updateConnection } = require("./config");
        if (!BACKUP_RPC_URL) return;

        try {
            await connection.getSlot();
            // If primary was down and is now up, we could switch back, but staying on backup is safer for stability
        } catch (e) {
            console.error(`[HEALTH] Primary RPC unhealthy. Attempting failover...`);
            SocketManager.emitLog(`[RPC WARN] RPC Unhealthy. Failing over to backup...`, "warning");

            if (!this.isUsingBackup) {
                updateConnection(BACKUP_RPC_URL);
                this.strategy.setConnection(connection);
                if (this.scanner) this.scanner.setConnection(connection);
                this.isUsingBackup = true;
            } else {
                // If backup is also failing, try primary again
                updateConnection(RPC_URL);
                this.strategy.setConnection(connection);
                if (this.scanner) this.scanner.setConnection(connection);
                this.isUsingBackup = false;
            }
        }

        // Watchdog: Check if monitor loop is stuck (no heartbeat for 5 mins)
        if (this.isRunning) {
            const timeSinceLastMonitor = Date.now() - this.lastMonitorHeartbeat;
            if (timeSinceLastMonitor > 5 * 60 * 1000) { // 5 minutes
                console.warn(`[WATCHDOG] Monitor loop stuck for ${(timeSinceLastMonitor / 60000).toFixed(1)}m. Force restarting...`);
                SocketManager.emitLog(`[WATCHDOG] Monitor loop stuck. Force restarting...`, "error");

                // Clear existing timer if any (though likely lost in event loop limbo)
                if (this.monitorInterval) {
                    clearTimeout(this.monitorInterval);
                    this.monitorInterval = null;
                }

                // Restart monitor
                this.monitorPositions();
                this.lastMonitorHeartbeat = Date.now();
            }
        }

        // Periodic memory cleanup — evict expired entries from caches
        this.cleanupMemory();
    }

    private cleanupMemory() {
        const now = Date.now();

        // Evict expired rejected tokens
        let evicted = 0;
        for (const [mint, entry] of this.rejectedTokens) {
            if (entry.expiry <= now) {
                this.rejectedTokens.delete(mint);
                evicted++;
            }
        }

        // Cap _flashRetryCount (entries are deleted on success/max retries, but stale ones can linger)
        if (this._flashRetryCount.size > 500) {
            this._flashRetryCount.clear();
        }

        // Evict stale _pumpfunWatchlist entries (older than 30 minutes)
        const WATCHLIST_MAX_AGE = 30 * 60 * 1000;
        for (const [mint, ts] of this._pumpfunWatchlist) {
            if (now - ts > WATCHLIST_MAX_AGE) {
                this._pumpfunWatchlist.delete(mint);
            }
        }

        if (evicted > 0) {
            console.log(`[CLEANUP] Evicted ${evicted} expired rejections. Caches: rejected=${this.rejectedTokens.size} retry=${this._flashRetryCount.size} watchlist=${this._pumpfunWatchlist.size}`);
        }
    }

    /**
     * One-time migration from pools.json to SQLite.
     */
    private async migrateFromJsonToSqlite() {
        try {
            const data = await fs.readFile(POOL_DATA_FILE, "utf-8").catch(() => null);
            if (!data) return;

            const history: PoolData[] = JSON.parse(data);
            if (history.length === 0) return;

            SocketManager.emitLog(`[DB] Migrating ${history.length} pools from JSON to SQLite...`, "warning");

            for (const pool of history) {
                await dbService.savePool(pool);
            }

            // Rename the old file to .bak to prevent re-migration
            const bakPath = POOL_DATA_FILE + ".bak";
            await fs.rename(POOL_DATA_FILE, bakPath);
            SocketManager.emitLog(`[DB] Migration complete. Old file renamed to ${path.basename(bakPath)}`, "success");
        } catch (error: any) {
            console.error("[DB] Migration failed:", error.message);
        }
    }


    private async safeRename(src: string, dest: string, retries = 5, delay = 50) {
        for (let i = 0; i < retries; i++) {
            try {
                await fs.rename(src, dest);
                return;
            } catch (e: any) {
                if (e.code === 'EBUSY' && i < retries - 1) {
                    await new Promise(r => setTimeout(r, delay * Math.pow(2, i)));
                    continue;
                }
                throw e;
            }
        }
    }

    private async savePools(newPool: PoolData) {
        try {
            await dbService.savePool(newPool);
        } catch (error) {
            console.error("[DB] Failed to save pool:", error);
        }
    }

    /**
     * Updates the ROI of a pool in SQL and emits to socket.
     */
    async updatePoolROI(poolId: string, roi: string, exited: boolean = false, fees?: { sol: string; token: string; totalLppp?: string }, partial?: Partial<PoolData>, forceUpdate: boolean = false) {
        if (this.activeTpSlActions.has(poolId) && !forceUpdate) return;

        try {
            const pool = await dbService.getPool(poolId);
            if (!pool) return;

            const updatedPool: PoolData = {
                ...pool,
                roi,
                exited: exited || pool.exited,
                unclaimedFees: fees || pool.unclaimedFees,
                ...partial
            };

            await dbService.savePool(updatedPool);
            SocketManager.emitPoolUpdate({
                poolId,
                roi,
                netRoi: updatedPool.netRoi,
                exited,
                unclaimedFees: updatedPool.unclaimedFees,
                positionValue: updatedPool.positionValue,
                currentMcap: partial?.currentMcap,
                initialMcap: updatedPool.initialMcap,
                tp1Done: updatedPool.tp1Done,
                takeProfitDone: updatedPool.takeProfitDone,
                stopLossDone: updatedPool.stopLossDone
            });
        } catch (e) {
            console.error("[DB] Update ROI Failed:", e);
        }
    }

    private async getBaseTokenPrice(baseMintAddr: string): Promise<number> {
        // Primary: Jupiter Price API
        const jupPrice = await JupiterPriceService.getPrice(baseMintAddr);
        if (jupPrice > 0) return jupPrice;

        // Fallback: DexScreener
        try {
            const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${baseMintAddr}`);
            const data: any = res.data;
            const price = parseFloat(data?.pairs?.[0]?.priceUsd || "0");
            return price;
        } catch (e) {
            console.warn(`[BOT] Failed to fetch price for ${baseMintAddr} from DexScreener:`, e);
            if (baseMintAddr === USDC_MINT.toBase58()) return 1.0;
            return 0;
        }
    }

    async start(config?: Partial<BotSettings>) {
        if (this.isRunning) return;

        // Final Safety Check: Ensure API keys are configured (Issue 27)
        if (!process.env.BIRDEYE_API_KEY || process.env.BIRDEYE_API_KEY === "your_birdeye_api_key_here") {
            SocketManager.emitLog("[CRITICAL] BIRDEYE_API_KEY is missing or using placeholder! Discovery limited.", "warning");
        }
        // Apply settings if provided, otherwise use defaults
        if (config) {
            this.settings = { ...this.settings, ...config };
            await dbService.saveSettings(this.settings);
            console.log("[BOT] Using and persisting provided settings:", this.settings);
        } else {
            console.log("[BOT] Using current settings:", this.settings);
        }

        // Validation: Log Warning if 0 Buy Amount, but do not override
        if (this.settings.buyAmount <= 0) {
            SocketManager.emitLog(`[CONFIG WARNING] Buy Amount received was ${this.settings.buyAmount} SOL.`, "warning");
        }

        this.sessionPoolCount = 0; // Reset session counter
        this.pendingMints.clear(); // Reset pending buys

        // Start position monitor (only if not already running)
        if (!this.monitorInterval) {
            this.monitorPositions();
        }

        // Check Balance
        const balance = await safeRpc(() => monitorConnection.getBalance(wallet.publicKey), "getWalletBalance");
        if (balance === 0) {
            SocketManager.emitLog(`[WARNING] Your wallet (${wallet.publicKey.toBase58().slice(0, 8)}...) has 0 SOL. Buys will fail.`, "error");
        } else {
            SocketManager.emitLog(`[WALLET] Active: ${wallet.publicKey.toBase58().slice(0, 8)}... | Balance: ${(balance / 1e9).toFixed(3)} SOL`, "success");
        }

        this.isRunning = true;
        SocketManager.emitStatus(true);

        const mode = this.settings.mode;
        const isPrebondOnly = mode === "PREBOND";
        const includesPoolScanning = mode === "SCOUT" || mode === "ANALYST" || mode === "ALL";
        const includesPrebond = mode === "PREBOND" || mode === "ALL";

        if (isPrebondOnly) {
            SocketManager.emitLog(`LPPP BOT [PREBOND MODE] — Sniping Pump.fun bonding curve tokens → Meteora pool (Buy: ${this.settings.buyAmount} SOL, Max: ${this.settings.maxPools})`, "info");
        } else {
            SocketManager.emitLog(`LPPP BOT [${mode}] Active (Vol5m: $${this.settings.volume5m.min}-$${this.settings.volume5m.max}, Vol1h: $${this.settings.volume1h.min}-$${this.settings.volume1h.max}, Vol24h: $${this.settings.volume24h.min}-$${this.settings.volume24h.max}, Liq: $${this.settings.liquidity.min}-$${this.settings.liquidity.max}, MCAP: $${this.settings.mcap.min}-$${this.settings.mcap.max})...`, "info");
        }

        // Derive enablePrebond from mode — mode is the single source of truth
        this.settings.enablePrebond = includesPrebond;
        if (includesPrebond) {
            SocketManager.emitLog(`[PREBOND] Bonding curve sniping active (${this.settings.buyAmount} SOL/buy → Meteora pool, max ${this.settings.maxPools} pools)`, "info");
        }

        // Start pool-based scanner (SCOUT, ANALYST, ALL — but NOT PREBOND-only)
        if (includesPoolScanning) {
            const scannerMode = mode === "ALL" ? "SCOUT" : mode as "SCOUT" | "ANALYST";
            const criteria: ScannerCriteria = {
                volume5m: this.settings.volume5m,
                volume1h: this.settings.volume1h,
                volume24h: this.settings.volume24h,
                liquidity: this.settings.liquidity,
                mcap: this.settings.mcap,
                mode: scannerMode,
                maxAgeMinutes: this.settings.maxAgeMinutes
            };

            this.scanner = new MarketScanner(criteria, async (result: ScanResult) => {
                if (!this.isRunning) return;
                this.enqueueToken(result);
            }, connection);

            this.scanner.start();
        }

        // Start real-time WebSocket listeners
        // SCOUT/ALL: detect new pool creations (Raydium + Meteora)
        if (includesPoolScanning) {
            this.startPoolWebSocket();
        }

        // PREBOND/ALL: direct Pump.fun program subscription for bonding curve token detection
        if (includesPrebond) {
            this.startPrebondWebSocket();
        }
    }

    /**
     * FASTEST DETECTION: WebSocket subscription to Raydium & Meteora program logs.
     * Fires ~0.4s after block confirmation — faster than Helius webhooks.
     * ONLY processes pool creation events (initialize/create), not swaps or other actions.
     */
    private _wsSeenSignatures = new Set<string>();

    private startPoolWebSocket() {
        const RAYDIUM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
        const METEORA_CPMM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";

        const SOL = "So11111111111111111111111111111111111111112";
        const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
        const stables = new Set([SOL, USDC, USDT]);

        // Keywords in log messages that indicate pool CREATION (not swaps/claims)
        const POOL_CREATION_KEYWORDS = [
            "initialize", "Initialize", "init_pool", "create_pool",
            "CreatePool", "InitializePool", "AddLiquidity"
        ];

        const handleLogs = (logs: any, dexId: string) => {
            if (!this.isRunning) return;
            if (logs.err) return;

            const signature = logs.signature;
            if (!signature) return;

            // Dedup: skip if we already processed this signature
            if (this._wsSeenSignatures.has(signature)) return;
            this._wsSeenSignatures.add(signature);

            // Only process pool creation events — skip swaps, fee claims, etc.
            const logMessages: string[] = logs.logs || [];
            const isPoolCreation = logMessages.some((msg: string) =>
                POOL_CREATION_KEYWORDS.some(kw => msg.includes(kw))
            );
            if (!isPoolCreation) return;

            this.resolveWsMint(signature, stables, dexId).catch(() => { });
        };

        // Clean up seen signatures periodically (every 60s, keep last 5 minutes)
        this._wsIntervalIds.push(setInterval(() => {
            if (this._wsSeenSignatures.size > 500) {
                this._wsSeenSignatures.clear();
            }
        }, 60000));

        try {
            const raySub = connection.onLogs(
                new PublicKey(RAYDIUM_V4),
                (logs) => handleLogs(logs, "raydium"),
                "confirmed"
            );
            this._wsSubscriptionIds.push(raySub);

            const metSub = connection.onLogs(
                new PublicKey(METEORA_CPMM),
                (logs) => handleLogs(logs, "meteora"),
                "confirmed"
            );
            this._wsSubscriptionIds.push(metSub);

            SocketManager.emitLog(`[WS] Real-time WebSocket listeners active on Raydium + Meteora (pool creation only).`, "success");
        } catch (err: any) {
            console.warn(`[WS] Failed to start WebSocket listeners: ${err.message}`);
        }
    }

    /**
     * Direct Pump.fun program WebSocket subscription for PREBOND mode.
     * Listens for new token mints on the Pump.fun bonding curve program.
     * Only fires on token CREATION events — not buys/sells on existing tokens.
     */
    private _pumpfunSeenMints = new Set<string>(); // Mint-level dedup (signatures differ per tx, mints repeat)

    private startPrebondWebSocket() {
        const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

        const SOL = "So11111111111111111111111111111111111111112";
        const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
        const stables = new Set([SOL, USDC, USDT]);

        // Pump.fun CREATION-ONLY keywords.
        // IMPORTANT: "MintTo" is deliberately excluded — it fires on every BUY (minting tokens from curve).
        // Only "Create"/"Initialize" indicate actual new token creation.
        const CREATION_KEYWORDS = ["Create", "create", "Initialize", "initialize"];

        // Clean up seen mints periodically (every 5 minutes)
        this._wsIntervalIds.push(setInterval(() => {
            if (this._pumpfunSeenMints.size > 200) {
                this._pumpfunSeenMints.clear();
            }
        }, 300000));

        try {
            const sub = connection.onLogs(
                new PublicKey(PUMPFUN_PROGRAM),
                (logs) => {
                    if (!this.isRunning) return;
                    if (logs.err) return;

                    const signature = logs.signature;
                    if (!signature) return;

                    // Dedup with the shared signature set
                    if (this._wsSeenSignatures.has(signature)) return;
                    this._wsSeenSignatures.add(signature);

                    // Filter for token creation events only (skip buys/sells on existing tokens)
                    const logMessages: string[] = logs.logs || [];
                    const isCreation = logMessages.some((msg: string) =>
                        CREATION_KEYWORDS.some(kw => msg.includes(kw))
                    );
                    if (!isCreation) return;

                    // Resolve the mint from the transaction (pass dexId as "pumpfun_new" to distinguish from graduations)
                    this.resolveWsMint(signature, stables, "pumpfun").catch(() => { });
                },
                "confirmed"
            );
            this._wsSubscriptionIds.push(sub);

            SocketManager.emitLog(`[WS] Pump.fun bonding curve WebSocket active — listening for new token mints.`, "success");
        } catch (err: any) {
            console.warn(`[WS] Failed to start Pump.fun WebSocket: ${err.message}`);
        }
    }

    /**
     * Resolve a WebSocket-detected pool creation transaction to extract token mints.
     */
    private async resolveWsMint(signature: string, stables: Set<string>, dexId: string) {
        try {
            await new Promise(r => setTimeout(r, 500));

            const tx = await safeRpc(
                () => connection.getParsedTransaction(signature, {
                    maxSupportedTransactionVersion: 0,
                    commitment: "confirmed"
                }),
                "getWsTx"
            );

            if (!tx || !tx.meta || tx.meta.err) return;

            // Extract token mints from post-token balances
            const mints = new Set<string>();
            const postBalances = tx.meta.postTokenBalances || [];
            for (const bal of postBalances) {
                const mint = bal.mint;
                if (mint && mint.length >= 40 && !stables.has(mint)) {
                    mints.add(mint);
                }
            }

            for (const mint of mints) {
                if (this.pendingMints.has(mint)) continue;
                const cached = this.rejectedTokens.get(mint);
                if (cached && cached.expiry > Date.now()) continue;

                // Mint-level dedup for Pump.fun: same token can fire many WebSocket events
                // (different signatures for create, first buy, second buy, etc.)
                if (dexId === "pumpfun") {
                    if (this._pumpfunSeenMints.has(mint)) continue;
                    this._pumpfunSeenMints.add(mint);
                }

                // For Pump.fun WebSocket: these are NEW token creations, not graduations.
                // Graduations are detected by Raydium/Meteora WebSocket (pool creation on DEX).
                const isGraduation = dexId !== "pumpfun";

                SocketManager.emitLog(`[WS] ⚡ New pool detected! ${mint.slice(0, 8)}... (${dexId})`, "info");
                this.triggerFlashScout(mint, "", dexId, isGraduation).catch(() => { });
            }
        } catch {
            // Silent
        }
    }

    private enqueueToken(result: ScanResult) {
        this.evaluationQueue.push(result);
        if (!this.isProcessingQueue) {
            this.processQueue();
        }
    }

    private static readonly MAX_CONCURRENT_QUEUE = 2;
    private activeQueueWorkers = 0;
    private _queueScheduled = false;

    private async processQueue() {
        this._queueScheduled = false;

        if (this.evaluationQueue.length === 0 && this.activeQueueWorkers === 0) {
            this.isProcessingQueue = false;
            return;
        }

        // STOP GUARD: If bot was stopped, drain the queue immediately
        if (!this.isRunning) {
            this.evaluationQueue = [];
            this.isProcessingQueue = false;
            console.log("[QUEUE] Bot stopped. Flushed evaluation queue.");
            return;
        }

        this.isProcessingQueue = true;

        // Launch workers up to limit
        while (this.evaluationQueue.length > 0 && this.activeQueueWorkers < BotManager.MAX_CONCURRENT_QUEUE) {
            const result = this.evaluationQueue.shift()!;
            const mintAddress = result.mint.toBase58();

            // Guard: Skip if already being processed
            if (this.pendingMints.has(mintAddress)) continue;

            this.activeQueueWorkers++;
            this.processQueueItem(result, mintAddress).finally(() => {
                this.activeQueueWorkers--;
                this.scheduleQueueCheck();
            });
        }

        // If no workers launched (all skipped), schedule retry
        if (this.activeQueueWorkers === 0 && this.evaluationQueue.length > 0) {
            this.scheduleQueueCheck();
        }
    }

    private scheduleQueueCheck() {
        if (!this._queueScheduled) {
            this._queueScheduled = true;
            setTimeout(() => this.processQueue(), 1000);
        }
    }

    private async processQueueItem(result: ScanResult, mintAddress: string) {
        try {

            // Exclusion Logic: Don't buy if we already have ANY pool for this token (active OR exited)
            const activePools: PoolData[] = await this.getPortfolio();
            if (activePools.some((p: PoolData) => p.mint === mintAddress)) {
                return;
            }

            // Check rejected token cache
            const cached = this.rejectedTokens.get(mintAddress);
            if (cached && cached.expiry > Date.now()) {
                return;
            }
            this.rejectedTokens.delete(mintAddress);

            this.pendingMints.add(mintAddress);


            SocketManager.emitLog(`[TARGET] ${result.symbol} (MCAP: $${Math.floor(result.mcap)})`, "info");

            // 1. Safety Check (Now very fast since pairAddress is pre-resolved)
            const safety = await OnChainSafetyChecker.checkToken(connection, mintAddress, result.pairAddress, this.settings);
            if (!safety.safe) {
                SocketManager.emitLog(`[SAFETY] ❌ ${result.symbol}: ${safety.reason}`, "error");
                this.rejectedTokens.set(mintAddress, { reason: safety.reason, expiry: Date.now() + 30 * 60 * 1000 });
                return;
            }

            // 1b. Token Scoring (if enabled)
            if (this.settings.enableScoring) {
                const { score, breakdown } = this.scoreToken(safety, {
                    liquidity: result.liquidity,
                    pairCreatedAt: result.pairCreatedAt,
                    volume5m: (result as any).volume5m,
                    volume1h: (result as any).volume1h,
                });
                SocketManager.emitLog(`[SCORE] ${result.symbol}: ${score}/100 [${breakdown.join(', ')}]`, score >= this.settings.minTokenScore ? "info" : "warning");
                if (score < this.settings.minTokenScore) {
                    this.rejectedTokens.set(mintAddress, { reason: `Low confidence score: ${score}/100 (min: ${this.settings.minTokenScore})`, expiry: Date.now() + 5 * 60 * 1000 });
                    return;
                }
            }

            // 2. Pool Check (Avoid duplicate pools)
            if (this.settings.baseToken && !BASE_TOKENS[this.settings.baseToken]) {
                console.warn(`[CONFIG] Unknown baseToken "${this.settings.baseToken}" — falling back to LPPP.`);
            }
            const activeBaseMint = BASE_TOKENS[this.settings.baseToken] || BASE_TOKENS["LPPP"];
            const existingPool = await this.strategy.checkMeteoraPoolExists(result.mint, activeBaseMint);
            if (existingPool) {
                SocketManager.emitLog(`[SKIP] Pool exists on-chain: ${existingPool.slice(0, 8)}...`, "warning");
                return;
            }

            // PRE-BUY GUARDS: Re-check after safety checks (which can take seconds)
            if (!this.isRunning) {
                SocketManager.emitLog(`[QUEUE] Bot stopped during safety check. Aborting ${result.symbol}.`, "warning");
                return;
            }
            if (this.sessionPoolCount >= this.settings.maxPools) {
                SocketManager.emitLog(`[QUEUE] Max pools (${this.settings.maxPools}) reached. Skipping ${result.symbol}.`, "warning");
                return;
            }

            // 3. Execution (Swap + LP)
            SocketManager.emitLog(`[EXEC] Buying ${this.settings.buyAmount} SOL of ${result.symbol}...`, "warning");
            const { success, error } = await this.strategy.swapToken(result.mint, this.settings.buyAmount, this.settings.slippage, result.pairAddress, result.dexId);

            if (success) {
                SocketManager.emitLog(`[EXEC] Buy Success! Seeding Liquidity...`, "success");
                await new Promise(r => setTimeout(r, 2000)); // Wait for settlement

                const tokenAccounts = await safeRpc(() => monitorConnection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: result.mint }), "getPostSwapBalance");
                const actualAmountRaw = tokenAccounts.value.reduce((acc, account) => acc + BigInt(account.account.data.parsed.info.tokenAmount.amount), 0n);
                const actualUiAmount = tokenAccounts.value.reduce((acc, account) => acc + (account.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);

                if (actualAmountRaw === 0n) {
                    SocketManager.emitLog(`[LP] No balance found. Aborting.`, "error");
                    return;
                }

                const tokenAmount = (actualAmountRaw * 99n) / 100n;
                const tokenUiAmountChecked = (actualUiAmount * 99) / 100;

                const solPrice = await this.getBaseTokenPrice(SOL_MINT.toBase58());
                if (solPrice <= 0) {
                    SocketManager.emitLog(`[LP] SOL price error.`, "error");
                    return;
                }

                const basePrice = await this.getBaseTokenPrice(activeBaseMint.toBase58());
                if (basePrice <= 0) {
                    SocketManager.emitLog(`[LP] Base token price error.`, "error");
                    return;
                }

                // ── THE TRUE FIX: BASE TOKENS & EXECUTION PRICE ──
                // Previously, this used `buyAmount` directly, assuming buyAmount was in `activeBaseMint` units.
                // However, `buyAmount` is the amount spent in Native SOL.
                // We must convert the SOL spent into the exactly equivalent amount of the explicitly selected Base Token!
                const usdValueSpent = this.settings.buyAmount * solPrice;
                const equivalentBaseTokenAmount = usdValueSpent / basePrice;

                // Pair the equivalent base amount, minus the 1% we hold back.
                const targetBaseAmount = equivalentBaseTokenAmount * 0.99;

                // Dynamically fetch base token decimals to support Base Tokens that don't use 9 decimals (e.g. USDC has 6)
                const baseMintAccountInfo = await safeRpc(() => monitorConnection.getParsedAccountInfo(activeBaseMint), "getBaseMintInfo");
                const baseDecimals = (baseMintAccountInfo?.value?.data as any)?.parsed?.info?.decimals || 9;
                const baseScale = Math.pow(10, baseDecimals);
                const lpppAmountBase = BigInt(Math.floor(targetBaseAmount * baseScale));

                const poolInfo = await this.strategy.createMeteoraPool(result.mint, tokenAmount, lpppAmountBase, activeBaseMint, this.settings.meteoraFeeBps);

                if (poolInfo.success) {
                    SocketManager.emitLog(`[SUCCESS] Pool Created: ${poolInfo.poolAddress}`, "success");

                    // Now, initialPrice is perfectly synced to our true Jupiter execution price.
                    const initialPrice = tokenUiAmountChecked > 0 ? (Number(lpppAmountBase) / baseScale) / tokenUiAmountChecked : 0;

                    const supplyRes = await safeRpc(() => monitorConnection.getTokenSupply(result.mint), "getTokenSupply");
                    const totalSupply = supplyRes.value.uiAmount || 0;
                    const trueInitialUsdPrice = initialPrice * basePrice;
                    const initialMcap = totalSupply * (trueInitialUsdPrice > 0 ? trueInitialUsdPrice : result.priceUsd);

                    const fullPoolData: PoolData = {
                        poolId: poolInfo.poolAddress || "",
                        token: result.symbol,
                        mint: result.mint.toBase58(),
                        roi: "0%",
                        netRoi: "0%",
                        created: new Date().toISOString(),
                        initialPrice,
                        initialTokenAmount: tokenUiAmountChecked,
                        initialLpppAmount: Number(lpppAmountBase) / baseScale,
                        initialSolValue: (Number(lpppAmountBase) / baseScale),
                        exited: false,
                        positionId: poolInfo.positionAddress,
                        unclaimedFees: { sol: "0", token: "0" },
                        isBotCreated: true,
                        entryUsdValue: 0, // Will be populated in first monitor tick
                        baseToken: this.settings.baseToken,
                        totalSupply,
                        initialMcap
                    };

                    await this.savePools(fullPoolData);
                    SocketManager.emitPool(fullPoolData);
                    this.sessionPoolCount++;
                    this.triggerImmediateSweep(); // First SL/TP check ASAP

                    if (this.sessionPoolCount >= this.settings.maxPools) {
                        SocketManager.emitLog(`[SESSION] Limit reached. Stopping scanner.`, "warning");
                        this.stop();
                    }
                } else {
                    SocketManager.emitLog(`[LP ERROR] ${poolInfo.error}`, "error");
                }
            } else {
                SocketManager.emitLog(`[BUY FAIL] ${error}`, "error");
            }

        } catch (err: any) {
            console.error(`[QUEUE ERROR] ${err.message}`);
        } finally {
            this.pendingMints.delete(mintAddress);
        }
    }

    /**
     * High-priority evaluation for tokens discovered via real-time webhooks or manual triggers.
     */
    async evaluateDiscovery(mint: string, source: string = "Manual") {
        // Issue 36: Early Deduplication (Skip API calls for tokens already in flight)
        if (this.pendingMints.has(mint)) {
            console.log(`[DISCOVERY] Skipping ${mint.slice(0, 8)}: Already pending.`);
            return;
        }

        try {
            const mintPubkey = new PublicKey(mint);

            // 1. Fetch Basic Metadata
            const pairs = await DexScreenerService.batchLookupTokens([mint], source);

            if (!pairs || pairs.length === 0) {
                SocketManager.emitLog(`[${source}] No pool data found for ${mint}. indexing delay?`, "warning");
                return;
            }

            const bestPair = pairs[0];

            // 2. Fetch Deep Metadata (CoinGecko)
            const geckoMeta = await GeckoService.getTokenMetadata(mint);

            const result: ScanResult = {
                mint: mintPubkey,
                pairAddress: bestPair.pairAddress,
                dexId: bestPair.dexId,
                volume24h: bestPair.volume?.h24 || 0,
                liquidity: bestPair.liquidity?.usd || 0,
                mcap: bestPair.fdv || 0,
                symbol: bestPair.baseToken.symbol,
                priceUsd: Number(bestPair.priceUsd)
            };

            SocketManager.emitLog(`[${source}] Real-time validation for ${result.symbol}...`, "info");
            if (geckoMeta?.links.twitter_screen_name) {
                SocketManager.emitLog(`[${source}] Socials Detected: Twitter @${geckoMeta.links.twitter_screen_name}`, "success");
            }

            if (this.isRunning && this.scanner) {
                // High-priority evaluation (ignores standard sweep interval)
                await this.scanner.evaluateToken(result);
            }

        } catch (error: any) {
            console.error(`[DISCOVERY ERROR] ${error.message}`);
        }
    }

    stop() {
        this.isRunning = false;
        if (this.scanner) {
            this.scanner.stop();
        }

        // Flush the evaluation queue to prevent post-stop buys
        const flushed = this.evaluationQueue.length;
        this.evaluationQueue = [];
        this.pendingMints.clear();
        this._flashRetryCount.clear();
        this._pumpfunWatchlist.clear();
        this._pumpfunSeenMints.clear();

        // Unsubscribe WebSocket listeners
        for (const subId of this._wsSubscriptionIds) {
            connection.removeOnLogsListener(subId).catch(() => { });
        }
        this._wsSubscriptionIds = [];

        // Clear WebSocket cleanup intervals
        for (const id of this._wsIntervalIds) {
            clearInterval(id);
        }
        this._wsIntervalIds = [];

        if (flushed > 0) {
            console.log(`[BOT] Flushed ${flushed} pending tokens from evaluation queue.`);
        }

        // ONLY stop the monitor if we have no positions left to watch.
        // Otherwise, keep monitoring ROI/Fees/SL/TP for existing money.
        // Note: runMonitor already has logic to self-terminate if !isRunning && pools.length === 0
        console.log("[BOT] Scanning stopped. Monitor will continue if active pools exist.");

        SocketManager.emitStatus(false);
        SocketManager.emitLog("LPPP BOT Scanning Service Stopped.", "warning");
    }

    private portfolioCache: { data: any; ts: number } = { data: null, ts: 0 };
    private static PORTFOLIO_CACHE_MS = 30_000; // 30s cache — no point refetching faster than frontend polls

    async getWalletBalance() {
        // Return cached result if fresh
        const now = Date.now();
        if (this.portfolioCache.data && now - this.portfolioCache.ts < BotManager.PORTFOLIO_CACHE_MS) {
            return this.portfolioCache.data;
        }

        // Try monitorConnection first, fall back to main
        const rpcs = [monitorConnection, connection];
        for (const rpc of rpcs) {
            try {
                const solBalance = await safeRpc(() => rpc.getBalance(wallet.publicKey), "getSolBalance");

                const baseTokenBalances: Record<string, number> = {};
                for (const [symbol, mint] of Object.entries(BASE_TOKENS)) {
                    const accounts = await safeRpc(() => rpc.getParsedTokenAccountsByOwner(wallet.publicKey, { mint }), "getPortfolio");
                    const uiAmount = accounts.value.reduce((acc, account) => acc + (account.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
                    baseTokenBalances[symbol] = uiAmount;
                }

                const result = { sol: solBalance / 1e9, baseTokens: baseTokenBalances };
                this.portfolioCache = { data: result, ts: now };
                return result;
            } catch (_) { /* try next RPC */ }
        }

        // All RPCs failed — return stale cache if available, otherwise zeros
        if (this.portfolioCache.data) return this.portfolioCache.data;
        return { sol: 0, baseTokens: {} };
    }

    private async monitorPositions() {
        // Monitor loop
        let sweepCount = 0;
        const runMonitor = async () => {
            this._runMonitor = runMonitor; // Store reference for immediate sweep triggers
            this.lastMonitorHeartbeat = Date.now(); // Watchdog: I'm alive!

            let pools: PoolData[] = [];
            let activePools: PoolData[] = [];
            try {
                pools = await dbService.getAllPools();
                activePools = pools.filter(p => !p.exited && p.isBotCreated);

                if (activePools.length === 0) {
                    if (sweepCount % 10 === 0) console.log(`[MONITOR DEBUG] No active bot pools found.`);
                    this.monitorInterval = setTimeout(runMonitor, 30000);
                    return;
                }

                // ═══ JUPITER BATCH PRICING Integration ═══
                const baseMints = Object.values(BASE_TOKENS).map(m => m.toBase58());
                const activeMints = activePools.map(p => p.mint);
                const mintsToFetch = [...new Set([...baseMints, ...activeMints])];

                const jupPrices = await JupiterPriceService.getPrices(mintsToFetch);

                // Validate that at least one base token has a price (synchronous check against
                // the already-fetched jupPrices map — async callbacks in .some() don't await).
                const anyBaseOk = Object.values(BASE_TOKENS).some(mint => (jupPrices.get(mint.toBase58()) || 0) > 0);

                if (!anyBaseOk) {
                    console.warn("[MONITOR] All price sources failed for base tokens. Skipping this sweep.");
                    this.monitorInterval = setTimeout(runMonitor, 30000);
                    return;
                }

                // Parallel fetch all position values, then process sequentially for TP/SL
                const now = Date.now();
                const eligiblePools = activePools.filter(p => {
                    if (p.withdrawalPending || p.exited || this.activeTpSlActions.has(p.poolId)) return false;

                    // ── TIERED MONITOR FREQUENCY ──
                    // Prioritizes RPC for pools that need active monitoring.

                    // Tier 1: Pending sell — must retry ASAP
                    if (p.pendingSell) return true;

                    // Tier 2: Completed pools — no automatic monitoring, refresh on-demand only
                    if (p.stopLossDone) return false;
                    if (p.tp1Done && p.takeProfitDone) return false;

                    // Tier 4: TP1 done, watching for TP2 — check every 2 sweeps (~16s)
                    if (p.tp1Done) return sweepCount % 2 === 0;

                    // Tier 5: Age-based backoff for active pools
                    const ageMs = now - (p.created ? new Date(p.created).getTime() : 0);
                    if (ageMs > 60 * 60 * 1000) {
                        return sweepCount % 4 === 0; // > 1 hour old: every 4 sweeps (~60s)
                    } else if (ageMs > 10 * 60 * 1000) {
                        return sweepCount % 2 === 0; // > 10 min old: every 2 sweeps (~30s)
                    }
                    return true; // < 10 min old: every sweep (~15s)
                });

                // ── BATCHED RPC FETCHING (2-3 RPC calls total instead of 7 per pool) ──
                // Uses Meteora SDK's getMultiplePools + getMultiplePositions
                // and getMultipleAccountsInfo for vault balances.
                const batchInput = eligiblePools.map(pool => ({
                    poolAddress: pool.poolId,
                    tokenMint: pool.mint,
                    positionId: pool.positionId
                }));
                const posValueMap = await this.strategy.getPositionValuesBatch(batchInput, monitorConnection);

                for (let i = 0; i < eligiblePools.length; i++) {
                    const pool = eligiblePools[i];
                    try {
                        const posValue = posValueMap.get(pool.poolId) || { totalSol: 0, feesBase: 0, feesToken: 0, spotPrice: 0, userBaseInLp: 0, userTokenInLp: 0, success: false };

                        if (posValue.success && posValue.spotPrice > 0) {
                            // ── Dead pools with zero position value + SL done: skip this tick ──
                            if (posValue.totalSol <= 0 && pool.stopLossDone) {
                                continue;
                            }

                            // ═══ SANITY GUARD: Reject zero-value responses from RPC glitches ═══
                            if (posValue.totalSol <= 0 && pool.initialSolValue && pool.initialSolValue > 0) {
                                console.log(`[MONITOR] ⚠️ ${pool.token}: RPC returned 0 value (likely 429/lag). Keeping last known ROI: ${pool.roi}`);
                                await new Promise(r => setTimeout(r, 1000));
                                continue;
                            }

                            // 1. Update Fees (pass both base + token fees for frontend display)
                            const totalFeesLppp = posValue.feesBase + (posValue.feesToken * posValue.spotPrice);
                            pool.unclaimedFees = {
                                sol: posValue.feesBase.toString(),
                                token: posValue.feesToken.toString(),
                                totalLppp: totalFeesLppp.toString()
                            };

                            // 1b. Update Position Value (LP tokens only, no fees)
                            const posValueLppp = posValue.userBaseInLp + (posValue.userTokenInLp * posValue.spotPrice);
                            pool.positionValue = {
                                baseLp: posValue.userBaseInLp.toString(),
                                tokenLp: posValue.userTokenInLp.toString(),
                                totalLppp: posValueLppp.toString()
                            };

                            /* ═══ DEBUG: Position Value + Fees breakdown ═══
                            if (sweepCount < 10 || sweepCount % 5 === 0) {
                                console.log(`[POS-VALUE] ${pool.token} | baseLp: ${posValue.userBaseInLp.toFixed(6)} | tokenLp: ${posValue.userTokenInLp.toFixed(6)} | spotPrice: ${posValue.spotPrice.toFixed(8)} | posLppp: ${posValueLppp.toFixed(6)}`);
                                console.log(`[FEES-DBG]  ${pool.token} | feesBase: ${posValue.feesBase.toFixed(6)} | feesToken: ${posValue.feesToken.toFixed(6)} | feesLppp: ${totalFeesLppp.toFixed(6)}`);
                            } */

                            // ═══ LEGACY 1-SOL SIZING BUG FIX ═══
                            // If initialSolValue looks like Native SOL (e.g., 0.5, 1.0) but the pool actually holds Base Tokens
                            // (totalSol > 100), it's a corrupted legacy entry that used `buyAmount` directly.
                            // Guard: only apply to pools created BEFORE the patch that fixed the sizing bug (2026-02-21).
                            // Without this guard, valid small new pools (<10 base tokens deposited) would be incorrectly
                            // converted, corrupting their initialPrice and causing wrong TP/SL.
                            const LEGACY_BUG_PATCH_DATE = new Date("2026-02-21T19:00:00Z").getTime();
                            const poolCreatedAt = pool.created ? new Date(pool.created).getTime() : 0;
                            const isLegacyPool = poolCreatedAt > 0 && poolCreatedAt < LEGACY_BUG_PATCH_DATE;
                            if (isLegacyPool && pool.initialSolValue && pool.initialSolValue < 10 && posValue.totalSol > 100) {
                                const activeBaseMintForPool = BASE_TOKENS[pool.baseToken || "LPPP"]?.toBase58() || BASE_TOKENS["LPPP"].toBase58();
                                const solp = jupPrices.get(SOL_MINT.toBase58()) || await this.getBaseTokenPrice(SOL_MINT.toBase58());
                                const baseP = jupPrices.get(activeBaseMintForPool) || await this.getBaseTokenPrice(activeBaseMintForPool);

                                if (solp > 0 && baseP > 0) {
                                    const conversionRate = solp / baseP;
                                    pool.initialSolValue = pool.initialSolValue * conversionRate;
                                    pool.initialPrice = pool.initialPrice * conversionRate;

                                    console.log(`[REPAIR] Converted legacy SOL-sized entry for ${pool.token} to Base metric (Rate: ${conversionRate.toFixed(2)}x)`);
                                    await dbService.updatePoolLegacyCalibration(pool.poolId, pool.initialSolValue, pool.initialPrice);

                                    // Corrupted entryUsdValue will be automatically fixed by the block below!
                                }
                            }

                            // 2. Spot ROI (Price-based)
                            const normalizedPrice = posValue.spotPrice;
                            let roiVal = (normalizedPrice - pool.initialPrice) / pool.initialPrice * 100;

                            // ═══ AUTO-RECALIBRATION ═══
                            // Legacy upside-down price calibration removed. The createMeteoraPool logic is now mathematically
                            // accurate and synced to Jupiter execution prices. If a pool drops 99%, it is a real crash, not a math error.

                            const cappedRoi = isFinite(roiVal) ? roiVal : 99999;
                            const roiString = cappedRoi > 10000 ? "MOON" : `${cappedRoi.toFixed(2)}%`;
                            pool.roi = roiString;

                            const poolBaseTokenKey = pool.baseToken || "LPPP";
                            let activeBaseMintStr = BASE_TOKENS["LPPP"].toBase58();

                            if (poolBaseTokenKey === "SOL") {
                                activeBaseMintStr = SOL_MINT.toBase58();
                            } else if (poolBaseTokenKey === "USDC") {
                                activeBaseMintStr = USDC_MINT.toBase58();
                            } else if (BASE_TOKENS[poolBaseTokenKey]) {
                                activeBaseMintStr = BASE_TOKENS[poolBaseTokenKey].toBase58();
                            }

                            let basePrice = jupPrices.get(activeBaseMintStr) || 0;
                            if (basePrice === 0) {
                                basePrice = await this.getBaseTokenPrice(activeBaseMintStr);
                            }

                            // 3. USD STRATEGY (TP/SL)
                            // For prebond pools: Jupiter Price API tracks the real bonding curve price.
                            // The Meteora pool spotPrice is static (only the bot's liquidity, no external trades).
                            let tokenPrice = jupPrices.get(pool.mint) || 0;
                            if (tokenPrice <= 0 && pool.isPrebond) {
                                // Fallback: fetch directly from Jupiter for prebond tokens
                                const jupDirect = await JupiterPriceService.getPrice(pool.mint);
                                if (jupDirect > 0) tokenPrice = jupDirect;
                            }
                            if (tokenPrice <= 0) {
                                tokenPrice = posValue.spotPrice * basePrice;
                            }

                            // Initialize entryUsdValue if missing (or fix corrupted HTP fallbacks)
                            const expectedEntryUsd = (pool.initialSolValue || 0) * basePrice;
                            if (!pool.entryUsdValue || pool.entryUsdValue <= 0 || (expectedEntryUsd > 0 && Math.abs(pool.entryUsdValue - expectedEntryUsd) / expectedEntryUsd > 0.80)) {
                                pool.entryUsdValue = expectedEntryUsd;
                                console.log(`[STRATEGY] Backfilled/Repaired entryUsdValue for ${pool.token}: $${pool.entryUsdValue.toFixed(4)}`);
                            }

                            // ── MCAP STRATEGY ──
                            // Backfill totalSupply if it was 0 at creation (failed RPC call).
                            // Without a supply the multiplier always stays 1 and TP/SL never triggers.
                            if (!pool.totalSupply || pool.totalSupply <= 0) {
                                try {
                                    const supplyRes = await safeRpc(() => monitorConnection.getTokenSupply(new (require("@solana/web3.js").PublicKey)(pool.mint)), "backfillTotalSupply");
                                    const fetched = supplyRes?.value?.uiAmount || 0;
                                    if (fetched > 0) {
                                        pool.totalSupply = fetched;
                                        await dbService.savePool(pool); // persist so we don't re-fetch every sweep
                                        console.log(`[MONITOR] Backfilled totalSupply for ${pool.token}: ${fetched.toLocaleString()}`);
                                    }
                                } catch (_) { /* non-fatal — try again next sweep */ }
                            }

                            let currentMcap = 0;
                            if (pool.totalSupply && pool.totalSupply > 0) {
                                currentMcap = tokenPrice * pool.totalSupply;
                            }

                            // ═══ LEGACY DB BACKFILL (one-time only) ═══
                            // Only write initialMcap if it is missing (zero or null).
                            // NEVER overwrite an existing initialMcap using current prices — doing so
                            // shifts the baseline every sweep, causing the multiplier to spike or drop
                            // whenever Jupiter's token price lags behind a base-token price move,
                            // which triggers false TP/SL. The entry MCAP must stay fixed at creation.
                            if ((!pool.initialMcap || pool.initialMcap <= 0) && pool.totalSupply && pool.totalSupply > 0 && pool.initialPrice) {
                                const poolBaseTokenKey = pool.baseToken || "LPPP";
                                let poolBaseMint = BASE_TOKENS["LPPP"].toBase58();

                                if (poolBaseTokenKey === "SOL") {
                                    poolBaseMint = SOL_MINT.toBase58();
                                } else if (poolBaseTokenKey === "USDC") {
                                    poolBaseMint = USDC_MINT.toBase58();
                                } else if (BASE_TOKENS[poolBaseTokenKey]) {
                                    poolBaseMint = BASE_TOKENS[poolBaseTokenKey].toBase58();
                                }

                                let poolBasePrice = jupPrices.get(poolBaseMint) || 0;
                                if (poolBasePrice === 0) {
                                    poolBasePrice = await this.getBaseTokenPrice(poolBaseMint);
                                }

                                if (poolBasePrice > 0) {
                                    const trueInitialUsdPrice = pool.initialPrice * poolBasePrice;
                                    pool.initialMcap = pool.totalSupply * trueInitialUsdPrice;
                                    console.log(`[MONITOR] Backfilled missing initialMcap for ${pool.token} (base: ${poolBaseTokenKey}): $${pool.initialMcap.toFixed(2)}`);
                                }
                            }

                            // Strictly enforce MCAP multiplier, NO USD fallback
                            const mcapMultiplier = (currentMcap > 0 && pool.initialMcap && pool.initialMcap > 0)
                                ? (currentMcap / pool.initialMcap)
                                : 1; // Default to 1 (neutral) if MCAP can't be calculated to avoid false Stop Losses

                            // Keep Net ROI for UI display only
                            const netProfit = posValue.totalSol - (pool.initialSolValue || 0);
                            const netRoiVal = (pool.initialSolValue && pool.initialSolValue > 0) ? (netProfit / pool.initialSolValue) * 100 : 0;
                            pool.netRoi = `${netRoiVal.toFixed(2)}%`;

                            // Log state for visibility (Reduced frequency)
                            if (sweepCount % 20 === 0 || mcapMultiplier >= 3.5 || mcapMultiplier <= 0.75) {
                                console.log(`[STRATEGY] ${pool.token} | MCAP Multiplier: ${mcapMultiplier.toFixed(3)}x | Net ROI: ${pool.netRoi}`);
                                // console.log(`[MONITOR]  ${pool.token} | Spot: ${roiString} | Net: ${pool.netRoi} | Curr: ${posValue.totalSol.toFixed(4)} LPPP`);
                            }

                            // Update local state and emit
                            await this.updatePoolROI(pool.poolId, roiString, false, pool.unclaimedFees, {
                                netRoi: pool.netRoi,
                                initialSolValue: pool.initialSolValue,
                                initialPrice: pool.initialPrice,
                                positionValue: pool.positionValue,
                                entryUsdValue: pool.entryUsdValue,
                                currentMcap: currentMcap,
                                initialMcap: pool.initialMcap
                            });

                            // ── DUST MCAP: Mark stopLossDone so tiered monitoring deprioritizes ──
                            if (mcapMultiplier <= 0.05 && mcapMultiplier !== 1 && !pool.stopLossDone) {
                                const reason = "legacy (no SL)";
                                SocketManager.emitLog(`[DUST] ${pool.token} is dead (${mcapMultiplier.toFixed(3)}x MCAP, ${reason}). Deprioritizing.`, "warning");
                                await this.updatePoolROI(pool.poolId, roiString, false, undefined, { stopLossDone: true });
                                continue;
                            }

                            // ── Retry pending sell (withdrawal succeeded but sell failed on previous tick) ──
                            if (pool.pendingSell) {
                                SocketManager.emitLog(`[${pool.pendingSell}] Retrying sell for ${pool.token}...`, "warning");
                                const sold = await this.liquidatePoolToSol(pool.mint);
                                if (sold) {
                                    const flagUpdate: any = { pendingSell: null };
                                    if (pool.pendingSell === "TP1") flagUpdate.tp1Done = true;
                                    else if (pool.pendingSell === "TP2") flagUpdate.takeProfitDone = true;
                                    else if (pool.pendingSell === "STOP LOSS") {
                                        flagUpdate.stopLossDone = true;
                                        if (mcapMultiplier <= 0.05) {
                                            SocketManager.emitLog(`[CLEANUP] ${pool.token} value is dead (0.05x MCAP). Marking as EXITED.`, "warning");
                                            await this.updatePoolROI(pool.poolId, "DEAD", true, undefined, flagUpdate);
                                            continue;
                                        }
                                    }
                                    await this.updatePoolROI(pool.poolId, roiString, false, undefined, flagUpdate);
                                    SocketManager.emitLog(`[${pool.pendingSell}] ${pool.token} sell retry succeeded.`, "success");
                                }
                                continue; // skip TP/SL checks this tick — either sold or will retry next tick
                            }

                            // ── Take Profit Stage 1 ──
                            if (mcapMultiplier >= this.settings.tp1Multiplier && !pool.tp1Done) {
                                this.activeTpSlActions.add(pool.poolId);
                                SocketManager.emitLog(`[TP1] ${pool.token} reached ${this.settings.tp1Multiplier}x MCAP! Withdrawing ${this.settings.tp1WithdrawPct}%...`, "success");
                                const result = await this.withdrawLiquidity(pool.poolId, this.settings.tp1WithdrawPct, "TP1");
                                this.activeTpSlActions.delete(pool.poolId);
                                if (result.success) {
                                    const sold = await this.liquidatePoolToSol(pool.mint);
                                    if (sold) {
                                        await this.updatePoolROI(pool.poolId, roiString, false, undefined, { tp1Done: true });
                                    } else {
                                        await this.updatePoolROI(pool.poolId, roiString, false, undefined, { pendingSell: "TP1" });
                                    }
                                } else {
                                    SocketManager.emitLog(`[TP1] ${pool.token} withdrawal failed. Will retry next tick.`, "warning");
                                }
                            }

                            // ── Take Profit Stage 2 ──
                            if (mcapMultiplier >= this.settings.tp2Multiplier && pool.tp1Done && !pool.takeProfitDone) {
                                this.activeTpSlActions.add(pool.poolId);
                                SocketManager.emitLog(`[TP2] ${pool.token} reached ${this.settings.tp2Multiplier}x MCAP! Withdrawing ${this.settings.tp2WithdrawPct}%...`, "success");
                                const result = await this.withdrawLiquidity(pool.poolId, this.settings.tp2WithdrawPct, "TP2");
                                this.activeTpSlActions.delete(pool.poolId);
                                if (result.success) {
                                    const sold = await this.liquidatePoolToSol(pool.mint);
                                    if (sold) {
                                        await this.updatePoolROI(pool.poolId, roiString, false, undefined, { takeProfitDone: true });
                                    } else {
                                        await this.updatePoolROI(pool.poolId, roiString, false, undefined, { pendingSell: "TP2" });
                                    }
                                } else {
                                    SocketManager.emitLog(`[TP2] ${pool.token} withdrawal failed. Will retry next tick.`, "warning");
                                }
                            }

                            // ── Stop Loss: Dynamic threshold based on settings ──
                            const createdTs = pool.created ? new Date(pool.created).getTime() : 0;
                            const poolAgeMs = createdTs > 0 ? Date.now() - createdTs : Infinity;
                            const SL_COOLDOWN_MS = 60 * 1000;
                            const slThreshold = 1 + (this.settings.stopLossPct / 100);
                            const slWithdrawPct = 100;

                            if (this.settings.enableStopLoss && mcapMultiplier <= slThreshold && !pool.stopLossDone && poolAgeMs > SL_COOLDOWN_MS) {
                                this.activeTpSlActions.add(pool.poolId);
                                SocketManager.emitLog(`[STOP LOSS] ${pool.token} hit ${this.settings.stopLossPct}% threshold! Atomic exit via Jito...`, "error");
                                const atomicResult = await this.strategy.executeAtomicStopLoss(pool.poolId, pool.mint, slWithdrawPct, pool.positionId);
                                this.activeTpSlActions.delete(pool.poolId);
                                if (atomicResult.success) {
                                    SocketManager.emitLog(`[STOP LOSS] ${pool.token} atomic exit sent! Bundle: ${atomicResult.bundleId}`, "success");
                                    await this.updatePoolROI(pool.poolId, roiString, false, undefined, { stopLossDone: true });

                                    if (mcapMultiplier <= 0.05) {
                                        SocketManager.emitLog(`[CLEANUP] ${pool.token} value is dead (0.05x MCAP). Marking as EXITED.`, "warning");
                                        await this.updatePoolROI(pool.poolId, "DEAD", true, undefined, { stopLossDone: true });
                                    }
                                } else if (atomicResult.bundleAccepted) {
                                    // Bundle was accepted by Jito but not confirmed — do NOT fall back or we'll double-withdraw
                                    SocketManager.emitLog(`[STOP LOSS] ${pool.token} bundle accepted but unconfirmed (${atomicResult.error}). Marking stopLossDone to prevent double withdrawal.`, "warning");
                                    await this.updatePoolROI(pool.poolId, roiString, false, undefined, { stopLossDone: true });
                                } else {
                                    // Bundle was rejected by Jito — safe to fall back
                                    SocketManager.emitLog(`[STOP LOSS] ${pool.token} atomic exit rejected: ${atomicResult.error}. Falling back to standard...`, "warning");
                                    const result = await this.withdrawLiquidity(pool.poolId, slWithdrawPct, "STOP LOSS");
                                    if (result.success) {
                                        const sold = await this.liquidatePoolToSol(pool.mint);
                                        if (sold) {
                                            await this.updatePoolROI(pool.poolId, roiString, false, undefined, { stopLossDone: true });
                                        } else {
                                            await this.updatePoolROI(pool.poolId, roiString, false, undefined, { pendingSell: "STOP LOSS" });
                                        }
                                    } else {
                                        SocketManager.emitLog(`[STOP LOSS] ${pool.token} fallback withdrawal also failed. Will retry next tick.`, "warning");
                                    }
                                }
                            }
                        }
                    } catch (poolErr: any) {
                        console.error(`[MONITOR] Error monitoring pool ${pool.poolId}:`, poolErr.message);
                    }
                }
            } catch (e: any) {
                console.error("[MONITOR] Global Loop Error:", e.message);
            } finally {
                sweepCount++;

                // Schedule next iteration (recursive timeout).
                // Use activePools (non-exited, bot-created) not pools (all historical records),
                // so the monitor self-terminates once all active positions are closed.
                if (this.isRunning || activePools.length > 0) {
                    const monitorableCount = activePools.filter(p => !p.stopLossDone && !(p.tp1Done && p.takeProfitDone)).length;
                    const nextInterval = monitorableCount > 50 ? 15000 : 8000;
                    this.monitorInterval = setTimeout(runMonitor, nextInterval);
                } else {
                    this.monitorInterval = null; // Nothing left to watch — stop the loop
                }
            }
        };

        // Kick off first run
        await runMonitor();
    }

    /** Cancel pending sweep timer and run monitor immediately (e.g. after new pool creation) */
    triggerImmediateSweep() {
        if (this._runMonitor) {
            if (this.monitorInterval) {
                clearTimeout(this.monitorInterval);
                this.monitorInterval = null;
            }
            SocketManager.emitLog(`[MONITOR] Immediate sweep triggered for new pool.`, "info");
            this._runMonitor();
        }
    }

    /**
     * Token confidence scoring — rates a token 0-100 based on multiple safety signals.
     * Only runs when enableScoring is on. Returns score + breakdown.
     */
    private scoreToken(
        safetyResult: { score?: number; checks: { mintAuthority: string; freezeAuthority: string; liquidityLocked: string } },
        scanResult: { liquidity: number; pairCreatedAt?: number; volume5m?: number; volume1h?: number },
    ): { score: number; breakdown: string[] } {
        let score = 0;
        const breakdown: string[] = [];

        // 1. RugCheck score (0-15 pts) — higher is safer
        const rugScore = safetyResult.score ?? 0;
        const rugPts = Math.min(15, Math.round(rugScore * 15));
        score += rugPts;
        breakdown.push(`RugCheck: ${rugPts}/15`);

        // 2. LP lock verified (0 or 15 pts)
        const lpPts = safetyResult.checks.liquidityLocked === "locked" ? 15 : 0;
        score += lpPts;
        breakdown.push(`LP Lock: ${lpPts}/15`);

        // 3. Authority checks (0-10 pts)
        let authPts = 0;
        if (safetyResult.checks.mintAuthority === "disabled") authPts += 5;
        if (safetyResult.checks.freezeAuthority === "disabled") authPts += 5;
        score += authPts;
        breakdown.push(`Authority: ${authPts}/10`);

        // 4. Liquidity depth (0-15 pts) — more liquidity = safer
        const liq = scanResult.liquidity || 0;
        let liqPts = 0;
        if (liq >= 100000) liqPts = 15;
        else if (liq >= 50000) liqPts = 12;
        else if (liq >= 20000) liqPts = 9;
        else if (liq >= 10000) liqPts = 6;
        else if (liq >= 5000) liqPts = 3;
        score += liqPts;
        breakdown.push(`Liquidity: ${liqPts}/15`);

        // 5. Volume authenticity (0-10 pts) — healthy 5m/1h ratio suggests organic trading
        const v5m = (scanResult as any).volume5m || 0;
        const v1h = (scanResult as any).volume1h || 0;
        let volPts = 0;
        if (v1h > 0 && v5m > 0) {
            const ratio = v5m / v1h;
            // A healthy ratio is 0.05-0.3 (5m is a fraction of 1h)
            // Ratios near 1.0 or > 1 suggest wash trading (all volume in last 5 min)
            if (ratio >= 0.03 && ratio <= 0.4) volPts = 10;
            else if (ratio > 0.4 && ratio <= 0.7) volPts = 6;
            else volPts = 2; // Suspicious ratio
        }
        score += volPts;
        breakdown.push(`Volume Auth: ${volPts}/10`);

        // 6. Token age (0-10 pts) — very new tokens are riskier
        const agePts = (() => {
            if (!scanResult.pairCreatedAt) return 5; // Unknown age — neutral
            const ageMin = (Date.now() - scanResult.pairCreatedAt) / 60000;
            if (ageMin >= 60) return 10;    // > 1hr old, survived
            if (ageMin >= 30) return 8;
            if (ageMin >= 10) return 6;
            if (ageMin >= 5) return 4;
            return 2;                        // < 5min old, very risky
        })();
        score += agePts;
        breakdown.push(`Age: ${agePts}/10`);

        return { score, breakdown };
    }

    async withdrawLiquidity(poolId: string, percent: number = 80, source: string = "MANUAL") {
        SocketManager.emitLog(`[${source}] Withdrawing ${percent}% liquidity from ${poolId.slice(0, 8)}...`, "warning");

        // 1. Mark as Pending (Issue 30 - Atomicity)
        await this.updatePoolROI(poolId, "PENDING...", false, undefined, { withdrawalPending: true });

        // Look up stored positionId for this pool
        let positionId: string | undefined;
        try {
            const pool = await dbService.getPool(poolId);
            positionId = pool?.positionId;
        } catch (e) { /* proceed without positionId stack trace */ }

        try {
            const result = await this.strategy.removeMeteoraLiquidity(poolId, percent, positionId);
            if (result.success) {
                SocketManager.emitLog(`[SUCCESS] Withdrew ${percent}% liquidity.`, "success");

                // 2. Clear pending and update state
                const isFull = percent >= 100;

                // CRITICAL FIX: Update initialSolValue proportionally for partial withdrawals.
                // Otherwise ROI = (Remaining Value - Full Entry Cost) / Full Entry Cost => Massive Fake Loss
                if (!isFull) {
                    try {
                        const pool = await dbService.getPool(poolId);
                        if (pool && pool.initialSolValue) {
                            // If we withdrew 40%, we have 60% left. So new cost basis is 60% of original.
                            const remainingRatio = 1 - (percent / 100);
                            const newInitialVal = pool.initialSolValue * remainingRatio;

                            // Update DB with new "Entry Price" for the remaining bag
                            await dbService.updatePoolEntryValue(poolId, newInitialVal);

                            await this.updatePoolROI(poolId, isFull ? "CLOSED" : "PARTIAL", false, undefined, {
                                withdrawalPending: false
                            });

                            SocketManager.emitLog(`[ROI FIX] Adjusted Entry Value: ${pool.initialSolValue.toFixed(4)} -> ${newInitialVal.toFixed(4)} LPPP`, "info");
                        } else {
                            await this.updatePoolROI(poolId, isFull ? "CLOSED" : "PARTIAL", false, undefined, { withdrawalPending: false });
                        }
                    } catch (e) {
                        console.error("[ROI FIX] Failed to update initialSolValue:", e);
                        await this.updatePoolROI(poolId, isFull ? "CLOSED" : "PARTIAL", false, undefined, { withdrawalPending: false });
                    }
                } else {
                    await this.updatePoolROI(poolId, isFull ? "CLOSED" : "PARTIAL", isFull, undefined, { withdrawalPending: false });
                }

                if (isFull) {
                    // Try to liquidate remnants if any
                    try {
                        const pool = await dbService.getPool(poolId);
                        if (pool) await this.liquidatePoolToSol(pool.mint);
                    } catch (_) { }
                }
                return result;
            } else {
                SocketManager.emitLog(`[ERROR] Withdrawal failed: ${result.error}`, "error");

                // Issue: Ghost Positions (Position gone from chain but in our JSON)
                // If the error specifically says "No active position found", it means we can't manage this anymore.
                // We should mark it as exited so the bot stops spamming SL/TP checks.
                if (result.error?.includes("No active position found")) {
                    SocketManager.emitLog(`[RECOVERY] Pool position is gone from chain. Marking ${poolId.slice(0, 8)}... as EXITED.`, "warning");
                    await this.updatePoolROI(poolId, "GONE", true, undefined, { withdrawalPending: false });
                } else {
                    // Clear pending flag so it can be re-tried for other errors
                    await this.updatePoolROI(poolId, "FAILED", false, undefined, { withdrawalPending: false });
                }
                return result;
            }
        } catch (err: any) {
            console.error("[WITHDRAW] Critical Error:", err);
            await this.updatePoolROI(poolId, "ERROR", false, undefined, { withdrawalPending: false });
            return { success: false, error: err.message };
        }
    }

    async increaseLiquidity(poolId: string, amountSol: number) {
        SocketManager.emitLog(`[MANUAL] Increasing liquidity by ${amountSol} SOL in ${poolId.slice(0, 8)}...`, "warning");
        const result = await this.strategy.addMeteoraLiquidity(poolId, amountSol);
        if (result.success) {
            SocketManager.emitLog(`[SUCCESS] Added more liquidity!`, "success");
        } else {
            SocketManager.emitLog(`[ERROR] Failed to add liquidity: ${result.error}`, "error");
        }
        return result;
    }

    async claimFees(poolId: string) {
        const { FEE_RECIPIENT_WALLET } = require("./config");

        if (FEE_RECIPIENT_WALLET && FEE_RECIPIENT_WALLET.length > 30) {
            SocketManager.emitLog(`[FEE-FUNNEL] Initiating Jito-Atomic payout to ${FEE_RECIPIENT_WALLET.slice(0, 8)}...`, "warning");
            const result = await this.strategy.executeAtomicFeeFunnel(poolId, FEE_RECIPIENT_WALLET);
            if (result.success) {
                SocketManager.emitLog(`[SUCCESS] Fee funnel bundle accepted!`, "success");
                await this.refreshPool(poolId);
                return result;
            } else {
                SocketManager.emitLog(`[ERROR] Funnel failed: ${result.error}. Falling back to standard claim...`, "error");
            }
        }

        SocketManager.emitLog(`[MANUAL] Claiming fees from ${poolId.slice(0, 8)} to Hot Wallet...`, "warning");
        const result = await this.strategy.claimMeteoraFees(poolId);
        if (result.success) {
            SocketManager.emitLog(`[SUCCESS] Fees harvested to Hot Wallet!`, "success");
            await this.refreshPool(poolId);
        } else {
            SocketManager.emitLog(`[ERROR] Fee claim failed: ${result.error}`, "error");
        }
        return result;
    }

    async refreshPool(poolId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const pool = await dbService.getPool(poolId);
            if (!pool) return { success: false, error: "Pool not found" };

            const posValue = await this.strategy.getPositionValue(pool.poolId, pool.mint, pool.positionId, monitorConnection);
            if (!posValue.success) return { success: false, error: "Failed to fetch position value" };

            // Update fees
            const totalFeesLppp = posValue.feesBase + (posValue.feesToken * posValue.spotPrice);
            const fees = { sol: posValue.feesBase.toString(), token: posValue.feesToken.toString(), totalLppp: totalFeesLppp.toString() };

            // Update position value
            const posValueLppp = posValue.userBaseInLp + (posValue.userTokenInLp * posValue.spotPrice);
            const positionValue = { baseLp: posValue.userBaseInLp.toString(), tokenLp: posValue.userTokenInLp.toString(), totalLppp: posValueLppp.toString() };

            // Calculate ROI
            const roiVal = (posValue.spotPrice - pool.initialPrice) / pool.initialPrice * 100;
            const cappedRoi = isFinite(roiVal) ? roiVal : 99999;
            const roiString = cappedRoi > 10000 ? "MOON" : `${cappedRoi.toFixed(2)}%`;

            // Calculate Net ROI
            const netProfit = posValue.totalSol - (pool.initialSolValue || 0);
            const netRoiVal = (pool.initialSolValue && pool.initialSolValue > 0) ? (netProfit / pool.initialSolValue) * 100 : 0;
            const netRoi = `${netRoiVal.toFixed(2)}%`;

            // MCAP
            let currentMcap = 0;
            if (pool.totalSupply && pool.totalSupply > 0) {
                const poolBaseTokenKey = pool.baseToken || "LPPP";
                let activeBaseMintStr = BASE_TOKENS["LPPP"].toBase58();
                if (poolBaseTokenKey === "SOL") activeBaseMintStr = SOL_MINT.toBase58();
                else if (poolBaseTokenKey === "USDC") activeBaseMintStr = USDC_MINT.toBase58();
                else if (BASE_TOKENS[poolBaseTokenKey]) activeBaseMintStr = BASE_TOKENS[poolBaseTokenKey].toBase58();

                const basePrice = await this.getBaseTokenPrice(activeBaseMintStr);
                const tokenPrice = posValue.spotPrice * basePrice;
                currentMcap = tokenPrice * pool.totalSupply;
            }

            await this.updatePoolROI(pool.poolId, roiString, false, fees, {
                netRoi, positionValue, currentMcap, initialMcap: pool.initialMcap
            }, true);

            return { success: true };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    private async liquidatePoolToSol(tokenMint: string): Promise<boolean> {
        // Only sell the sniped token back to SOL.
        // IMPORTANT: Do NOT sell LPPP here. LPPP is a reserve asset used to seed
        // future pools. Selling it would drain the entire wallet balance.
        const getRawBalance = async (mintStr: string) => {
            try {
                const accounts = await monitorConnection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mintStr) });
                return accounts.value.reduce((acc, account) => acc + BigInt(account.account.data.parsed.info.tokenAmount.amount), 0n);
            } catch (e) { return 0n; }
        };

        // Wait for RPC to reflect the withdrawal before checking balance
        await new Promise(r => setTimeout(r, 2000));

        const tokenBal = await getRawBalance(tokenMint);
        SocketManager.emitLog(`[LIQUIDATE] ${tokenMint.slice(0, 6)} balance: ${tokenBal.toString()} units`, "info");
        if (tokenBal > 0n) {
            SocketManager.emitLog(`[LIQUIDATE] Selling ${tokenMint.slice(0, 6)} to SOL via Jupiter...`, "warning");
            try {
                const result = await this.strategy.sellToken(new PublicKey(tokenMint), tokenBal);
                if (!result.success) {
                    SocketManager.emitLog(`[LIQUIDATE] Sell failed for ${tokenMint.slice(0, 6)}: ${result.error || "unknown"}. Will retry next tick.`, "error");
                    return false;
                }
                SocketManager.emitLog(`[LIQUIDATE] Sold ${tokenMint.slice(0, 6)} for ${result.amountSol.toFixed(6)} SOL`, "success");
                return true;
            } catch (e: any) {
                SocketManager.emitLog(`[LIQUIDATE] Sell failed for ${tokenMint.slice(0, 6)}: ${e.message}. Will retry next tick.`, "error");
                return false;
            }
        } else {
            SocketManager.emitLog(`[LIQUIDATE] No ${tokenMint.slice(0, 6)} balance to sell.`, "info");
            return true; // nothing to sell = complete
        }
    }

    async getPortfolio(): Promise<PoolData[]> {
        return await dbService.getAllPools();
    }

    async updateWallet(privateKeyBs58: string) {
        try {
            const { Keypair } = require("@solana/web3.js");
            const bs58 = require("bs58");
            const newWallet = Keypair.fromSecretKey(bs58.decode(privateKeyBs58));

            this.strategy.setKey(newWallet);
            SocketManager.emitLog(`[WALLET] Updated to: ${newWallet.publicKey.toBase58()}`, "success");
            return { success: true, publicKey: newWallet.publicKey.toBase58() };
        } catch (error: any) {
            console.error("[BOT] Wallet Update Failed:", error);
            return { success: false, error: error.message };
        }
    }

    /**
     * SCOUT UPGRADE: Flash Evaluation for real-time webhooks.
     * Resolves token and enqueues for immediate safety check.
     */
    async triggerFlashScout(mint: string, pairAddress: string, dexId: string, isGraduation: boolean = false, creator?: string) {
        if (!this.isRunning) return;

        // 1. Quick Guard
        if (this.pendingMints.has(mint)) return;

        // Graduation re-evaluation: If a watched Pump.fun token graduates to Raydium,
        // clear its rejection cache and watchlist so it gets a fresh evaluation with real pool data.
        if (isGraduation && this._pumpfunWatchlist.has(mint)) {
            this._pumpfunWatchlist.delete(mint);
            this.rejectedTokens.delete(mint);
            SocketManager.emitLog(`[HELIUS] Pump.fun graduation detected for ${mint.slice(0, 8)}... Re-evaluating with pool data.`, "info");
        }

        const cached = this.rejectedTokens.get(mint);
        if (cached && cached.expiry > Date.now()) return;

        // 2. Forensic Audit (main safety settings — NOT for prebond, which has its own gates)
        // Skip for graduations (already passed the Pump.fun curve) and prebond pumpfun tokens
        const isPrebondPumpfun = dexId === "pumpfun" && this.settings.enablePrebond;
        if (creator && !isGraduation && !isPrebondPumpfun) {
            const audit = await securityGuard.runForensicAudit(mint, creator, this.settings);
            if (!audit.passed) {
                const reason = audit.report.join(", ");
                this.rejectedTokens.set(mint, { reason, expiry: Date.now() + 10 * 60 * 1000 }); // Reject for 10 mins
                SocketManager.emitLog(`[SECURITY] 🛡️ Token ${mint.slice(0, 8)}... rejected: ${reason}`, "warning");
                return;
            }
        }

        // PREBOND fast path: Skip DexScreener/Birdeye entirely for Pump.fun tokens.
        // Bonding curve tokens don't need volume/liquidity/mcap data — go straight to buyPrebond.
        if (dexId === "pumpfun" && this.settings.enablePrebond) {
            this._flashRetryCount.delete(mint);
            const bought = await this.buyPrebond(mint, creator || "");
            if (!bought) {
                this._pumpfunWatchlist.set(mint, Date.now());
            }
            return;
        }

        try {
            let result: ScanResult | null = null;

            // ── RESOLUTION CHAIN: DexScreener → Birdeye → On-Chain ──

            // Attempt 1: DexScreener (best data quality — has pair address, all volume buckets)
            const resolved = await DexScreenerService.batchLookupTokens([mint], "HELIUS_FLASH");
            if (resolved.length > 0) {
                this._flashRetryCount.delete(mint);
                const data = resolved[0];
                result = {
                    mint: new PublicKey(data.baseToken.address),
                    pairAddress: data.pairAddress,
                    dexId: data.dexId,
                    volume24h: data.volume.h24,
                    liquidity: data.liquidity.usd,
                    mcap: data.marketCap,
                    symbol: data.baseToken.symbol,
                    priceUsd: parseFloat(data.priceUsd),
                    source: "HELIUS_LIVE",
                    pairCreatedAt: data.pairCreatedAt || 0
                };
                (result as any).volume5m = data.volume.m5;
                (result as any).volume1h = data.volume.h1;
                SocketManager.emitLog(`[HELIUS] Flash Scout via DexScreener: ${result.symbol} (MCAP: $${Math.floor(result.mcap)})`, "info");
            }

            // Attempt 2: Birdeye token overview (indexes faster than DexScreener for new tokens)
            if (!result) {
                const birdeye = await BirdeyeService.fetchTokenOverview(mint);
                if (birdeye && birdeye.price > 0 && birdeye.liquidity > 0) {
                    this._flashRetryCount.delete(mint);
                    result = {
                        mint: new PublicKey(mint),
                        pairAddress: "", // Birdeye doesn't give pair address
                        dexId: dexId || "unknown",
                        volume24h: birdeye.volume24h,
                        liquidity: birdeye.liquidity,
                        mcap: birdeye.mcap,
                        symbol: birdeye.symbol,
                        priceUsd: birdeye.price,
                        source: "HELIUS_LIVE_BE"
                    };
                    (result as any).volume5m = birdeye.volume5m;
                    (result as any).volume1h = birdeye.volume1h;
                    SocketManager.emitLog(`[HELIUS] Flash Scout via Birdeye fallback: ${result.symbol} (MCAP: $${Math.floor(result.mcap)})`, "info");
                }
            }

            // If we resolved data from any source, run through scanner criteria filters
            if (result && this.scanner) {
                const passed = await this.scanner.evaluateToken(result);
                if (!passed) {
                    // Cache rejection for 3 minutes to prevent repeated lookups from Helius/WS spam
                    this.rejectedTokens.set(mint, { reason: "criteria_fail", expiry: Date.now() + 3 * 60 * 1000 });
                    // If a Pump.fun token failed criteria, also add to watchlist for graduation re-evaluation
                    if (dexId === "pumpfun") {
                        this._pumpfunWatchlist.set(mint, Date.now());
                    }
                }
            } else if (!result) {
                // Pump.fun bonding curve tokens: DexScreener/Birdeye won't have data until graduation.
                if (dexId === "pumpfun") {
                    this._flashRetryCount.delete(mint);

                    // Prebond sniping: buy directly on the bonding curve if enabled
                    if (this.settings.enablePrebond) {
                        const bought = await this.buyPrebond(mint, creator || "");
                        if (!bought) {
                            // Buy failed or filtered — add to watchlist for graduation fallback
                            this._pumpfunWatchlist.set(mint, Date.now());
                        }
                    } else {
                        // Legacy behavior: just watch for graduation
                        this._pumpfunWatchlist.set(mint, Date.now());
                        SocketManager.emitLog(`[HELIUS] Pump.fun ${mint.slice(0, 8)}... on bonding curve. Watching for graduation.`, "info");
                    }
                } else {
                    // Non-Pump.fun tokens: retry with increasing delays (pool may be indexing)
                    const RETRY_DELAYS = [5000, 15000, 30000, 60000, 120000];
                    const attempt = this._flashRetryCount.get(mint) ?? 0;

                    if (attempt < RETRY_DELAYS.length) {
                        this._flashRetryCount.set(mint, attempt + 1);
                        const delay = RETRY_DELAYS[attempt];
                        SocketManager.emitLog(`[HELIUS] Token ${mint.slice(0, 8)}... not resolved. Retry ${attempt + 1}/${RETRY_DELAYS.length} in ${delay / 1000}s`, "info");
                        setTimeout(() => {
                            this.triggerFlashScout(mint, pairAddress, dexId).catch(err => {
                                console.warn(`[HELIUS] Flash retry ${attempt + 1} failed for ${mint}:`, err);
                            });
                        }, delay);
                    } else {
                        this._flashRetryCount.delete(mint);
                        // Block this token for 30 minutes so WebSocket re-fires don't restart the retry cycle
                        this.rejectedTokens.set(mint, { reason: "unresolvable", expiry: Date.now() + 30 * 60 * 1000 });
                        SocketManager.emitLog(`[HELIUS] Token ${mint.slice(0, 8)}... unresolvable after ${RETRY_DELAYS.length} retries. Blocked for 30m.`, "warning");
                    }
                }
            }
        } catch (e) {
            console.warn(`[HELIUS] Flash Scout resolution failed for ${mint}:`, e);
        }
    }

    // ═══════════════════════════════════════════════
    // ═══ PREBOND SNIPING ══════════════════════════
    // ═══════════════════════════════════════════════

    /**
     * Buy a token on the Pump.fun bonding curve via Jupiter, then immediately create a Meteora pool.
     * Flow mirrors SCOUT/ANALYST: swapToken → settle → createMeteoraPool → save as PoolData.
     */
    private async buyPrebond(mint: string, creator: string): Promise<boolean> {
        // Concurrent buy guard — prevents double buys from rapid webhook duplicates
        if (this.pendingMints.has(mint)) return false;
        this.pendingMints.add(mint);

        try {
            // Guard: session max pools (same as SCOUT/ANALYST — per-session, resets on start)
            if (this.sessionPoolCount >= this.settings.maxPools) {
                SocketManager.emitLog(`[PREBOND] Max pools (${this.settings.maxPools}) reached. Skipping ${mint.slice(0, 8)}...`, "warning");
                return false;
            }

            // Guard: already holding this token (check all pools, not just prebond)
            const allPools = await dbService.getAllPools();
            if (allPools.some(p => p.mint === mint && !p.exited)) {
                return false;
            }

            // --- Prebond-specific safety gates (independent from main forensic settings) ---

            // Creator reputation check
            if (creator && this.settings.prebondEnableReputation) {
                const rep = await securityGuard.checkDevReputation(creator, this.settings.prebondMinDevTxCount);
                if (!rep.safe) {
                    SocketManager.emitLog(`[PREBOND] ${mint.slice(0, 8)} rejected: ${rep.reason}`, "warning");
                    this.rejectedTokens.set(mint, { reason: rep.reason || "bad_creator", expiry: Date.now() + 10 * 60 * 1000 });
                    return false;
                }
            }

            // Bundle detection
            if (this.settings.prebondEnableBundle) {
                const bundle = await securityGuard.detectBundle(mint);
                if (bundle.bundled) {
                    SocketManager.emitLog(`[PREBOND] ${mint.slice(0, 8)} rejected: ${bundle.reason}`, "warning");
                    this.rejectedTokens.set(mint, { reason: bundle.reason || "bundled", expiry: Date.now() + 10 * 60 * 1000 });
                    return false;
                }
            }

            // Honeypot simulation (Jupiter sell quote)
            if (this.settings.prebondEnableSimulation) {
                const sim = await securityGuard.simulateExecution(mint);
                if (!sim.success) {
                    SocketManager.emitLog(`[PREBOND] ${mint.slice(0, 8)} rejected: ${sim.error}`, "warning");
                    this.rejectedTokens.set(mint, { reason: sim.error || "honeypot", expiry: Date.now() + 10 * 60 * 1000 });
                    return false;
                }
            }

            // Mint/Freeze authority check (on-chain)
            if (this.settings.prebondEnableAuthority) {
                const auth = await securityGuard.checkMintAuthority(mint);
                if (!auth.safe) {
                    SocketManager.emitLog(`[PREBOND] ${mint.slice(0, 8)} rejected: ${auth.reason}`, "warning");
                    this.rejectedTokens.set(mint, { reason: auth.reason || "authority_active", expiry: Date.now() + 10 * 60 * 1000 });
                    return false;
                }
            }

            // --- Prebond Discovery Filters (Jupiter Token API V2) ---
            const hasFilters = this.settings.prebondMinMcap > 0 ||
                               this.settings.prebondMaxMcap > 0 ||
                               this.settings.prebondMinHolders > 0 ||
                               this.settings.prebondMinOrganicScore > 0 ||
                               this.settings.prebondMaxTopHolderPct > 0 ||
                               this.settings.prebondMaxAgeMinutes > 0 ||
                               this.settings.prebondMinVolume5m > 0 ||
                               this.settings.prebondMinVolume1h > 0 ||
                               this.settings.prebondMinVolume24h > 0;

            if (hasFilters) {
                const tokenData = await this.fetchJupiterTokenData(mint);

                // Start with Jupiter data (may be 0 for unindexed tokens)
                let mcap = tokenData?.mcap || 0;
                let holders = tokenData?.holderCount || 0;
                let organicScore = tokenData?.organicScore || 0;
                let topHolderPct = tokenData?.audit?.topHoldersPercentage || 0;
                let vol5m = tokenData?.stats5m?.volume || 0;
                let vol1h = tokenData?.stats1h?.volume || 0;
                let vol24h = tokenData?.stats24h?.volume || 0;
                let dataSource = "jupiter";

                // Tier 1 Fallback: On-chain bonding curve for MCap when Jupiter returns 0
                if (mcap <= 0 && (this.settings.prebondMinMcap > 0 || this.settings.prebondMaxMcap > 0)) {
                    const curveData = await this.fetchPumpfunBondingCurveData(mint);
                    if (curveData) {
                        if (curveData.complete) {
                            // Token already graduated — skip prebond buy
                            return false;
                        }
                        mcap = curveData.mcap;
                        dataSource = "on-chain";
                    }
                }

                // Tier 2 Fallback: Pump.fun API for volume when Jupiter returns 0
                const needsVolume = (this.settings.prebondMinVolume5m > 0 || this.settings.prebondMinVolume1h > 0 || this.settings.prebondMinVolume24h > 0);
                if (needsVolume && vol5m <= 0 && vol1h <= 0 && vol24h <= 0) {
                    const pumpData = await this.fetchPumpfunApiData(mint);
                    if (pumpData) {
                        // Pump.fun API returns aggregate volume — use as vol5m proxy
                        if (pumpData.volume > 0) vol5m = pumpData.volume;
                        if (mcap <= 0 && pumpData.mcap > 0) mcap = pumpData.mcap;
                        if (dataSource === "jupiter") dataSource = "pumpfun-api";
                    }
                }

                if (dataSource !== "jupiter") {
                    SocketManager.emitLog(`[PREBOND] ${mint.slice(0, 8)} using ${dataSource} data (Jupiter not indexed). MCap:$${Math.floor(mcap).toLocaleString()}`, "info");
                }

                // --- Apply filters ---
                if (this.settings.prebondMinMcap > 0 && mcap < this.settings.prebondMinMcap) {
                    SocketManager.emitLog(`[PREBOND] ${mint.slice(0, 8)} rejected: MCap $${mcap.toLocaleString()} < min $${this.settings.prebondMinMcap.toLocaleString()}`, "warning");
                    return false;
                }
                if (this.settings.prebondMaxMcap > 0 && mcap > this.settings.prebondMaxMcap) {
                    SocketManager.emitLog(`[PREBOND] ${mint.slice(0, 8)} rejected: MCap $${mcap.toLocaleString()} > max $${this.settings.prebondMaxMcap.toLocaleString()}`, "warning");
                    return false;
                }
                if (this.settings.prebondMinHolders > 0 && holders < this.settings.prebondMinHolders) {
                    SocketManager.emitLog(`[PREBOND] ${mint.slice(0, 8)} rejected: ${holders} holders < min ${this.settings.prebondMinHolders}`, "warning");
                    return false;
                }
                if (this.settings.prebondMinOrganicScore > 0 && organicScore < this.settings.prebondMinOrganicScore) {
                    SocketManager.emitLog(`[PREBOND] ${mint.slice(0, 8)} rejected: organic score ${organicScore} < min ${this.settings.prebondMinOrganicScore}`, "warning");
                    return false;
                }
                if (this.settings.prebondMaxTopHolderPct > 0 && topHolderPct > this.settings.prebondMaxTopHolderPct) {
                    SocketManager.emitLog(`[PREBOND] ${mint.slice(0, 8)} rejected: top holders ${topHolderPct.toFixed(1)}% > max ${this.settings.prebondMaxTopHolderPct}%`, "warning");
                    return false;
                }

                // Age filter: reject tokens older than maxAgeMinutes
                if (this.settings.prebondMaxAgeMinutes > 0 && tokenData?.createdAt) {
                    const createdMs = new Date(tokenData.createdAt).getTime();
                    const ageMinutes = (Date.now() - createdMs) / 60000;
                    if (ageMinutes > this.settings.prebondMaxAgeMinutes) {
                        SocketManager.emitLog(`[PREBOND] ${mint.slice(0, 8)} rejected: age ${ageMinutes.toFixed(1)}m > max ${this.settings.prebondMaxAgeMinutes}m`, "warning");
                        return false;
                    }
                }

                // Volume filters
                if (this.settings.prebondMinVolume5m > 0 && vol5m < this.settings.prebondMinVolume5m) {
                    SocketManager.emitLog(`[PREBOND] ${mint.slice(0, 8)} rejected: vol5m $${vol5m.toLocaleString()} < min $${this.settings.prebondMinVolume5m.toLocaleString()}`, "warning");
                    return false;
                }
                if (this.settings.prebondMinVolume1h > 0 && vol1h < this.settings.prebondMinVolume1h) {
                    SocketManager.emitLog(`[PREBOND] ${mint.slice(0, 8)} rejected: vol1h $${vol1h.toLocaleString()} < min $${this.settings.prebondMinVolume1h.toLocaleString()}`, "warning");
                    return false;
                }
                if (this.settings.prebondMinVolume24h > 0 && vol24h < this.settings.prebondMinVolume24h) {
                    SocketManager.emitLog(`[PREBOND] ${mint.slice(0, 8)} rejected: vol24h $${vol24h.toLocaleString()} < min $${this.settings.prebondMinVolume24h.toLocaleString()}`, "warning");
                    return false;
                }

                SocketManager.emitLog(`[PREBOND] ${mint.slice(0, 8)} passed filters (MCap:$${Math.floor(mcap).toLocaleString()} Holders:${holders} Vol5m:$${Math.floor(vol5m).toLocaleString()} src:${dataSource})`, "info");
            }

            // --- Buy on bonding curve ---
            SocketManager.emitLog(`[PREBOND] Buying ${mint.slice(0, 8)}... on bonding curve (${this.settings.buyAmount} SOL)`, "info");

            const mintPubkey = new PublicKey(mint);
            const { success, error } = await this.strategy.swapToken(
                mintPubkey,
                this.settings.buyAmount,
                this.settings.slippage
            );

            if (!success) {
                SocketManager.emitLog(`[PREBOND] Buy failed for ${mint.slice(0, 8)}: ${error}`, "error");
                return false;
            }

            SocketManager.emitLog(`[PREBOND] Buy Success! Creating Meteora pool...`, "success");
            await new Promise(r => setTimeout(r, 2000)); // Wait for settlement

            // --- Create Meteora Pool (same flow as SCOUT) ---
            const tokenAccounts = await safeRpc(() => monitorConnection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: mintPubkey }), "getPrebondPostSwapBalance");
            const actualAmountRaw = tokenAccounts.value.reduce((acc: bigint, account: any) => acc + BigInt(account.account.data.parsed.info.tokenAmount.amount), 0n);
            const actualUiAmount = tokenAccounts.value.reduce((acc: number, account: any) => acc + (account.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);

            if (actualAmountRaw === 0n) {
                SocketManager.emitLog(`[PREBOND] No token balance found after buy. Aborting pool creation.`, "error");
                return false;
            }

            const tokenAmount = (actualAmountRaw * 99n) / 100n;
            const tokenUiAmountChecked = (actualUiAmount * 99) / 100;

            const activeBaseMint = BASE_TOKENS[this.settings.baseToken] || BASE_TOKENS["LPPP"];
            const solPrice = await this.getBaseTokenPrice(SOL_MINT.toBase58());
            if (solPrice <= 0) {
                SocketManager.emitLog(`[PREBOND] SOL price error. Aborting pool creation.`, "error");
                return false;
            }

            const basePrice = await this.getBaseTokenPrice(activeBaseMint.toBase58());
            if (basePrice <= 0) {
                SocketManager.emitLog(`[PREBOND] Base token price error. Aborting pool creation.`, "error");
                return false;
            }

            // Convert SOL spent to equivalent base token amount
            const usdValueSpent = this.settings.buyAmount * solPrice;
            const equivalentBaseTokenAmount = usdValueSpent / basePrice;
            const targetBaseAmount = equivalentBaseTokenAmount * 0.99;

            // Get base token decimals
            const baseMintAccountInfo = await safeRpc(() => monitorConnection.getParsedAccountInfo(activeBaseMint), "getPrebondBaseMintInfo");
            const baseDecimals = (baseMintAccountInfo?.value?.data as any)?.parsed?.info?.decimals || 9;
            const baseScale = Math.pow(10, baseDecimals);
            const lpppAmountBase = BigInt(Math.floor(targetBaseAmount * baseScale));

            const poolInfo = await this.strategy.createMeteoraPool(mintPubkey, tokenAmount, lpppAmountBase, activeBaseMint, this.settings.meteoraFeeBps);

            if (!poolInfo.success) {
                SocketManager.emitLog(`[PREBOND] Pool creation failed: ${poolInfo.error}`, "error");
                return false;
            }

            SocketManager.emitLog(`[PREBOND] Pool Created: ${poolInfo.poolAddress}`, "success");

            // Get symbol from metadata service
            let symbol = mint.slice(0, 6);
            try {
                const resolved = await TokenMetadataService.getSymbol(mint);
                if (resolved) symbol = resolved;
            } catch (_) { }

            // Calculate initial price (base tokens per token)
            const initialPrice = tokenUiAmountChecked > 0 ? (Number(lpppAmountBase) / baseScale) / tokenUiAmountChecked : 0;

            let totalSupply = 0;
            for (let attempt = 0; attempt < 3; attempt++) {
                const supplyRes = await safeRpc(() => monitorConnection.getTokenSupply(mintPubkey), "getPrebondTokenSupply");
                totalSupply = supplyRes?.value?.uiAmount || 0;
                if (totalSupply > 0) break;
                await new Promise(r => setTimeout(r, 1000));
            }
            if (totalSupply <= 0) {
                console.warn(`[PREBOND] Failed to fetch totalSupply for ${mint.slice(0, 8)} after 3 attempts — SL/TP may not trigger until backfilled.`);
            }
            const trueInitialUsdPrice = initialPrice * basePrice;
            const initialMcap = totalSupply * (trueInitialUsdPrice > 0 ? trueInitialUsdPrice : 0);

            // Save as PoolData — enters the standard monitor loop for TP/SL
            const fullPoolData: PoolData = {
                poolId: poolInfo.poolAddress || "",
                token: symbol,
                mint,
                roi: "0%",
                netRoi: "0%",
                created: new Date().toISOString(),
                initialPrice,
                initialTokenAmount: tokenUiAmountChecked,
                initialLpppAmount: Number(lpppAmountBase) / baseScale,
                initialSolValue: (Number(lpppAmountBase) / baseScale),
                exited: false,
                positionId: poolInfo.positionAddress,
                unclaimedFees: { sol: "0", token: "0" },
                isBotCreated: true,
                isPrebond: true,
                entryUsdValue: 0,
                baseToken: this.settings.baseToken,
                totalSupply,
                initialMcap
            };

            await this.savePools(fullPoolData);
            SocketManager.emitPool(fullPoolData);
            this.sessionPoolCount++;
            this.triggerImmediateSweep();

            SocketManager.emitLog(`[PREBOND] ${symbol} — Pool live! TP/SL handled by main monitor.`, "success");

            if (this.sessionPoolCount >= this.settings.maxPools) {
                SocketManager.emitLog(`[SESSION] Max pools limit reached (${this.settings.maxPools}). Stopping bot.`, "warning");
                this.stop();
            }

            return true;
        } catch (error: any) {
            console.error(`[PREBOND] Buy+Pool error for ${mint}:`, error.message);
            SocketManager.emitLog(`[PREBOND] Error: ${error.message}`, "error");
            return false;
        } finally {
            this.pendingMints.delete(mint);
        }
    }

    /**
     * Fetch token data from Jupiter Token API V2 for prebond discovery filters.
     */
    private async fetchJupiterTokenData(mint: string): Promise<any | null> {
        try {
            const headers: Record<string, string> = {};
            if (JUPITER_API_KEY) headers["x-api-key"] = JUPITER_API_KEY;
            const res = await axios.get("https://api.jup.ag/tokens/v2/search", {
                params: { query: mint },
                headers,
                timeout: 5000
            });
            if (Array.isArray(res.data)) {
                return res.data.find((t: any) => t.id === mint || t.mint === mint) || null;
            }
            return null;
        } catch (err: any) {
            console.warn(`[PREBOND] Jupiter Token API lookup failed for ${mint.slice(0, 8)}: ${err.message}`);
            return null;
        }
    }

    /**
     * Reads the Pump.fun bonding curve account on-chain to calculate real-time MCap.
     * Fallback for when Jupiter Token API hasn't indexed the token yet.
     */
    private async fetchPumpfunBondingCurveData(mint: string): Promise<{ mcap: number; priceUsd: number; complete: boolean } | null> {
        try {
            const PUMPFUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
            const mintPubkey = new PublicKey(mint);
            const [bondingCurvePda] = PublicKey.findProgramAddressSync(
                [Buffer.from("bonding-curve"), mintPubkey.toBuffer()],
                PUMPFUN_PROGRAM_ID
            );

            const accountInfo = await safeRpc(
                () => monitorConnection.getAccountInfo(bondingCurvePda),
                "getPumpfunBondingCurve"
            );
            if (!accountInfo || !accountInfo.data || accountInfo.data.length < 49) return null;

            const data = accountInfo.data;
            // Layout: 8-byte discriminator, then u64 LE fields
            const virtualTokenReserves = data.readBigUInt64LE(8);
            const virtualSolReserves = data.readBigUInt64LE(16);
            const complete = data[48] === 1;

            if (virtualTokenReserves === 0n) return null;

            // Price in SOL per token (both in raw units, SOL in lamports, token in raw 6-decimal)
            // price = (virtualSolReserves / 1e9) / (virtualTokenReserves / 1e6)
            const priceSol = (Number(virtualSolReserves) / 1e9) / (Number(virtualTokenReserves) / 1e6);

            // Get SOL price in USD
            const solPriceUsd = await this.getBaseTokenPrice(SOL_MINT.toBase58());
            if (solPriceUsd <= 0) return null;

            const priceUsd = priceSol * solPriceUsd;
            // Pump.fun total supply = 1 billion tokens
            const mcap = priceUsd * 1_000_000_000;

            return { mcap, priceUsd, complete };
        } catch (err: any) {
            console.warn(`[PREBOND] Bonding curve read failed for ${mint.slice(0, 8)}: ${err.message}`);
            return null;
        }
    }

    /**
     * Fetches token data from Pump.fun's frontend API (volume, mcap, etc.).
     * Fallback for when Jupiter volume data returns $0.
     */
    private async fetchPumpfunApiData(mint: string): Promise<{ mcap: number; volume: number } | null> {
        try {
            const res = await axios.get(`https://frontend-api-v3.pump.fun/coins/${mint}`, { timeout: 3000 });
            if (!res.data) return null;
            return {
                mcap: res.data.usd_market_cap || 0,
                volume: res.data.volume || 0
            };
        } catch {
            return null;
        }
    }

}
