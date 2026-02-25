import { connection, monitorConnection, wallet, POOL_DATA_FILE, BASE_TOKENS, SOL_MINT, USDC_MINT } from "./config";
import { MarketScanner, ScanResult, ScannerCriteria } from "./scanner";
import { StrategyManager } from "./strategy";
import { PublicKey } from "@solana/web3.js";
import { SocketManager } from "./socket";
import { OnChainSafetyChecker } from "./rugcheck";
import * as fs from "fs/promises";
import * as path from "path";
import { GeckoService } from "./gecko-service";
import axios from "axios";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { dbService } from "./db-service";
import { PoolData, TradeHistory } from "./types";
import { TokenMetadataService } from "./token-metadata-service";
import { JupiterPriceService } from "./jupiter-price-service";
import { safeRpc } from "./rpc-utils";
import { DexScreenerService } from "./dexscreener-service";
import { BirdeyeService } from "./birdeye-service";



export interface BotSettings {
    buyAmount: number; // in SOL
    lpppAmount: number; // in units (fallback only)
    meteoraFeeBps: number; // in Basis Points (e.g. 200 = 2%)
    maxPools: number; // Max pools to create before auto-stop
    slippage: number; // in % (e.g. 10)
    volume5m: { min: number; max: number };
    volume1h: { min: number; max: number };
    volume24h: { min: number; max: number };
    liquidity: { min: number; max: number };
    mcap: { min: number; max: number };
    mode?: "SCOUT" | "ANALYST";
    maxAgeMinutes?: number;
    baseToken: string;
}

export class BotManager {
    public isRunning: boolean = false;
    private scanner: MarketScanner | null = null;
    private strategy: StrategyManager;
    private sessionPoolCount: number = 0;
    private monitorInterval: NodeJS.Timeout | null = null;
    private pendingMints: Set<string> = new Set(); // Guards against duplicate buys
    private activeTpSlActions: Set<string> = new Set(); // Guards against double TP/SL
    private rejectedTokens: Map<string, { reason: string, expiry: number }> = new Map(); // Fix 5: Cache rejected tokens
    private lastMonitorHeartbeat: number = Date.now(); // Watchdog: Track monitor activity
    private healthCheckInterval: NodeJS.Timeout | null = null;
    private isUsingBackup: boolean = false;
    private _flashRetryCount: Map<string, number> = new Map(); // Track retry attempts for DexScreener resolution
    private _pumpfunWatchlist: Map<string, number> = new Map(); // Pump.fun tokens rejected on curve — re-evaluate on graduation
    private _wsSubscriptionIds: number[] = []; // WebSocket subscription IDs for cleanup
    private evaluationQueue: ScanResult[] = [];
    private isProcessingQueue: boolean = false;
    private settings: BotSettings = {
        buyAmount: 0.1,
        lpppAmount: 1000,
        meteoraFeeBps: 200, // Default 2%
        maxPools: 5, // Default 5 pools
        slippage: 10,
        volume5m: { min: 2000, max: 0 },
        volume1h: { min: 25000, max: 0 },
        volume24h: { min: 100000, max: 0 },
        liquidity: { min: 10000, max: 0 },
        mcap: { min: 100000, max: 0 },
        mode: "SCOUT",
        maxAgeMinutes: 0,
        baseToken: "LPPP"
    };

    constructor() {
        this.strategy = new StrategyManager(connection, wallet);
        this.initialize();
    }

    public getSettings(): BotSettings {
        return this.settings;
    }

    private async initialize() {
        // 1. Migrate if needed
        await this.migrateFromJsonToSqlite();

        // 2. Recovery scan DISABLED — bot only tracks its own created pools.
        // await this.syncActivePositions();

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
    private async syncActivePositions() {
        SocketManager.emitLog("[RECOVERY] Scanning blockchain for lost positions...", "info");
        try {
            const onChainPositions = await this.strategy.fetchAllUserPositions();
            const dbPools = await dbService.getAllPools();
            const dbIds = new Set(dbPools.map(p => p.poolId));

            let recoveredCount = 0;
            for (const pos of onChainPositions) {
                if (!dbIds.has(pos.poolAddress)) {
                    SocketManager.emitLog(`[RECOVERY] Found untracked pool: ${pos.poolAddress.slice(0, 8)}...`, "warning");

                    // Fetch pool details to reconstruct entry
                    const poolInfo = await this.strategy.getPoolMints(pos.poolAddress);
                    if (!poolInfo) continue;

                    const mintA = poolInfo.tokenA;
                    const mintB = poolInfo.tokenB;
                    const targetMint = Object.values(BASE_TOKENS).some(m => m.toBase58() === mintA) ? mintB : mintA;

                    // Fetch token metadata (name) - Use the new robust service
                    const tokenSymbol = await TokenMetadataService.getSymbol(targetMint, connection);

                    const posValue = await this.strategy.getPositionValue(pos.poolAddress, targetMint);

                    if (!posValue.success) {
                        SocketManager.emitLog(`[RECOVERY] Could not fetch value for ${pos.poolAddress.slice(0, 8)}. Moving to next.`, "warning");
                        continue;
                    }

                    const recoveredPool: PoolData = {
                        poolId: pos.poolAddress,
                        token: tokenSymbol,
                        mint: targetMint,
                        roi: "0.00%",
                        netRoi: "0.00%",
                        created: new Date().toISOString(),
                        initialPrice: posValue.spotPrice, // Using current as baseline to track from here
                        initialTokenAmount: 0,
                        initialLpppAmount: 0,
                        initialSolValue: posValue.totalSol, // Set baseline to current position value
                        exited: false,
                        positionId: pos.positionId,
                        isBotCreated: false, // Recovered pools are not created by the bot
                        baseToken: Object.keys(BASE_TOKENS).find(k => BASE_TOKENS[k].toBase58() === (mintA === targetMint ? mintB : mintA)) || "LPPP"
                    };

                    await dbService.savePool(recoveredPool);
                    SocketManager.emitPool(recoveredPool);
                    recoveredCount++;

                    // Throttling to prevent 429 (Too Many Requests) - Be aggressive for DRPC
                    await new Promise(r => setTimeout(r, 1500));
                }
            }

            if (recoveredCount > 0) {
                SocketManager.emitLog(`[RECOVERY] Successfully restored ${recoveredCount} pools to dashboard.`, "success");
            } else {
                SocketManager.emitLog("[RECOVERY] Scan complete. Database is already in sync.", "info");
            }
        } catch (e: any) {
            console.error("[RECOVERY] Sync failed:", e.message);
        }
    }

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


    /**
     * Scans the wallet for tokens purchased by the bot but never pooled (Issue 28).
     */
    private async checkOrphanTokens() {
        SocketManager.emitLog("[ORPHAN-CHECK] Scanning wallet for un-pooled tokens...", "info");
        try {
            const pools = await dbService.getAllPools();
            const pooledMints = new Set(pools.map(p => p.mint));

            // Get all token accounts with balance > 0
            const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
                programId: TOKEN_PROGRAM_ID
            });
            const accounts2022 = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
                programId: TOKEN_2022_PROGRAM_ID
            });

            const allAccounts = [...accounts.value, ...accounts2022.value];

            for (const acc of allAccounts) {
                const info = acc.account.data.parsed.info;
                const mint = info.mint;
                const balance = info.tokenAmount.uiAmount || 0;

                // Skip LPPP and SOL
                if (Object.values(BASE_TOKENS).some(m => m.toBase58() === mint) || mint === SOL_MINT.toBase58()) continue;

                if (balance > 0 && !pooledMints.has(mint)) {
                    SocketManager.emitLog(`[ORPHAN] Detected un-pooled tokens: ${balance.toFixed(2)} units of ${mint.slice(0, 8)}...`, "warning");
                    SocketManager.emitLog(`[RECOVERY] Tip: You can manually swap these to SOL or wait for future auto-recovery.`, "info");
                }
            }
        } catch (e) {
            console.warn("[ORPHAN-CHECK] Skip: No pool data file yet.");
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
        if (config) {
            this.settings = { ...this.settings, ...config };

            // Validation: Log Warning if 0 Buy Amount, but do not override
            if (this.settings.buyAmount <= 0) {
                SocketManager.emitLog(`[CONFIG WARNING] Buy Amount received was ${this.settings.buyAmount} SOL.`, "warning");
            }
        }

        // Orphan check DISABLED — focused on bot-created pools only.
        // await this.checkOrphanTokens();

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
        SocketManager.emitLog(`LPPP BOT Streamer Active (Vol5m: $${this.settings.volume5m.min}-$${this.settings.volume5m.max}, Vol1h: $${this.settings.volume1h.min}-$${this.settings.volume1h.max}, Vol24h: $${this.settings.volume24h.min}-$${this.settings.volume24h.max}, Liq: $${this.settings.liquidity.min}-$${this.settings.liquidity.max}, MCAP: $${this.settings.mcap.min}-$${this.settings.mcap.max})...`, "info");

        const criteria: ScannerCriteria = {
            volume5m: this.settings.volume5m,
            volume1h: this.settings.volume1h,
            volume24h: this.settings.volume24h,
            liquidity: this.settings.liquidity,
            mcap: this.settings.mcap,
            mode: this.settings.mode,
            maxAgeMinutes: this.settings.maxAgeMinutes
        };

        this.scanner = new MarketScanner(criteria, async (result: ScanResult) => {
            if (!this.isRunning) return;
            this.enqueueToken(result);
        }, connection);

        this.scanner.start();

        // Start real-time WebSocket listeners for instant pool detection
        this.startPoolWebSocket();
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
        setInterval(() => {
            if (this._wsSeenSignatures.size > 500) {
                this._wsSeenSignatures.clear();
            }
        }, 60000);

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

                SocketManager.emitLog(`[WS] ⚡ New pool detected! ${mint.slice(0, 8)}... (${dexId})`, "info");
                this.triggerFlashScout(mint, "", dexId, true).catch(() => { });
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
            const safety = await OnChainSafetyChecker.checkToken(connection, mintAddress, result.pairAddress);
            if (!safety.safe) {
                SocketManager.emitLog(`[SAFETY] ❌ ${result.symbol}: ${safety.reason}`, "error");
                this.rejectedTokens.set(mintAddress, { reason: safety.reason, expiry: Date.now() + 30 * 60 * 1000 });
                return;
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

        // Unsubscribe WebSocket listeners
        for (const subId of this._wsSubscriptionIds) {
            connection.removeOnLogsListener(subId).catch(() => { });
        }
        this._wsSubscriptionIds = [];

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

                    // Tier 4: TP1 done, watching for TP2 — check every 3 sweeps (~45s)
                    if (p.tp1Done) return sweepCount % 3 === 0;

                    // Tier 5: Age-based backoff for active pools
                    const ageMs = now - (p.created ? new Date(p.created).getTime() : 0);
                    if (ageMs > 60 * 60 * 1000) {
                        return sweepCount % 4 === 0; // > 1 hour old: every 4 sweeps (~60s)
                    } else if (ageMs > 10 * 60 * 1000) {
                        return sweepCount % 2 === 0; // > 10 min old: every 2 sweeps (~30s)
                    }
                    return true; // < 10 min old: every sweep (~15s)
                });

                // ── BATCHED RPC FETCHING (CRITICAL FIX FOR 429 LIMITS) ──
                // Replaces unbounded Promise.all which crashed the RPC with 1000s of requests at once.
                const posValueResults: any[] = [];
                const BATCH_SIZE = 5;
                for (let i = 0; i < eligiblePools.length; i += BATCH_SIZE) {
                    const batch = eligiblePools.slice(i, i + BATCH_SIZE);
                    const batchResults = await Promise.all(
                        batch.map(pool =>
                            this.strategy.getPositionValue(pool.poolId, pool.mint, pool.positionId, monitorConnection)
                                .catch(() => ({ totalSol: 0, feesSol: 0, feesToken: 0, spotPrice: 0, userBaseInLp: 0, userTokenInLp: 0, success: false }))
                        )
                    );
                    posValueResults.push(...batchResults);
                    if (i + BATCH_SIZE < eligiblePools.length) {
                        await new Promise(r => setTimeout(r, 800)); // 800ms buffer between batches
                    }
                }

                for (let i = 0; i < eligiblePools.length; i++) {
                    const pool = eligiblePools[i];
                    try {
                        const posValue = posValueResults[i];

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
                            const totalFeesLppp = posValue.feesSol + (posValue.feesToken * posValue.spotPrice);
                            pool.unclaimedFees = {
                                sol: posValue.feesSol.toString(),
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
                                console.log(`[FEES-DBG]  ${pool.token} | feesSol: ${posValue.feesSol.toFixed(6)} | feesToken: ${posValue.feesToken.toFixed(6)} | feesLppp: ${totalFeesLppp.toFixed(6)}`);
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

                            // 3. USD STRATEGY (4x/7x Take Profit, 0.7x Stop Loss)
                            const tokenPrice = jupPrices.get(pool.mint) || (posValue.spotPrice * basePrice);

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

                            // ── Take Profit Stage 1: 5x Value → Close 30% ──
                            if (mcapMultiplier >= 5.0 && !pool.tp1Done) {
                                this.activeTpSlActions.add(pool.poolId);
                                SocketManager.emitLog(`[TP1] ${pool.token} reached 5x MCAP! Withdrawing 30%...`, "success");
                                const result = await this.withdrawLiquidity(pool.poolId, 30, "TP1");
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

                            // ── Take Profit Stage 2: 10x Value → Close another 30% ──
                            if (mcapMultiplier >= 10.0 && pool.tp1Done && !pool.takeProfitDone) {
                                this.activeTpSlActions.add(pool.poolId);
                                SocketManager.emitLog(`[TP2] ${pool.token} reached 10x MCAP! Withdrawing 30%...`, "success");
                                const result = await this.withdrawLiquidity(pool.poolId, 30, "TP2");
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

                            // ── Stop Loss: SCOUT uses 0.92x (-8%), ANALYST uses 0.7x (-30%) ──
                            // SCOUT: withdraw 30% at -8% MCAP drop, ANALYST: withdraw 80% at -30% MCAP drop
                            // 1-minute cooldown: don't trigger SL in the exact launch minute due to violent volatility
                            const createdTs = pool.created ? new Date(pool.created).getTime() : 0;
                            const poolAgeMs = createdTs > 0 ? Date.now() - createdTs : Infinity;
                            const SL_COOLDOWN_MS = 60 * 1000;
                            const slThreshold = this.settings.mode === "SCOUT" ? 0.92 : 0.7;
                            const slWithdrawPct = 80;

                            if (mcapMultiplier <= slThreshold && !pool.stopLossDone && poolAgeMs > SL_COOLDOWN_MS) {
                                this.activeTpSlActions.add(pool.poolId);
                                SocketManager.emitLog(`[STOP LOSS] ${pool.token} hit ${slThreshold}x MCAP! Withdrawing ${slWithdrawPct}%...`, "error");
                                const result = await this.withdrawLiquidity(pool.poolId, slWithdrawPct, "STOP LOSS");
                                this.activeTpSlActions.delete(pool.poolId);
                                if (result.success) {
                                    const sold = await this.liquidatePoolToSol(pool.mint);
                                    if (sold) {
                                        await this.updatePoolROI(pool.poolId, roiString, false, undefined, { stopLossDone: true });

                                        if (mcapMultiplier <= 0.05) {
                                            SocketManager.emitLog(`[CLEANUP] ${pool.token} value is dead (0.05x MCAP). Marking as EXITED.`, "warning");
                                            await this.updatePoolROI(pool.poolId, "DEAD", true, undefined, { stopLossDone: true });
                                        }
                                    } else {
                                        await this.updatePoolROI(pool.poolId, roiString, false, undefined, { pendingSell: "STOP LOSS" });
                                    }
                                } else {
                                    SocketManager.emitLog(`[STOP LOSS] ${pool.token} withdrawal failed. Will retry next tick.`, "warning");
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
                    const nextInterval = activePools.length > 50 ? 30000 : 15000;
                    this.monitorInterval = setTimeout(runMonitor, nextInterval);
                } else {
                    this.monitorInterval = null; // Nothing left to watch — stop the loop
                }
            }
        };

        // Kick off first run
        await runMonitor();
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
        SocketManager.emitLog(`[MANUAL] Claiming fees from ${poolId.slice(0, 8)}...`, "warning");
        const result = await this.strategy.claimMeteoraFees(poolId);
        if (result.success) {
            SocketManager.emitLog(`[SUCCESS] Fees harvested!`, "success");
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
            const totalFeesLppp = posValue.feesSol + (posValue.feesToken * posValue.spotPrice);
            const fees = { sol: posValue.feesSol.toString(), token: posValue.feesToken.toString(), totalLppp: totalFeesLppp.toString() };

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

        const tokenBal = await getRawBalance(tokenMint);
        if (tokenBal > 0n) {
            SocketManager.emitLog(`[LIQUIDATE] Closing $${tokenMint.slice(0, 6)} and converting to SOL...`, "warning");
            try {
                const result = await this.strategy.sellToken(new PublicKey(tokenMint), tokenBal);
                if (!result.success) {
                    SocketManager.emitLog(`[LIQUIDATE] Sell failed for ${tokenMint.slice(0, 6)}: ${result.error || "unknown"}. Will retry next tick.`, "error");
                    return false;
                }
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
    async triggerFlashScout(mint: string, pairAddress: string, dexId: string, isGraduation: boolean = false) {
        if (!this.isRunning) return;

        // 1. Quick Guard
        if (this.pendingMints.has(mint)) return;

        // Graduation re-evaluation: If a watched Pump.fun token graduates to Raydium,
        // clear its rejection cache and watchlist so it gets a fresh evaluation with real pool data.
        if (isGraduation && this._pumpfunWatchlist.has(mint)) {
            this._pumpfunWatchlist.delete(mint);
            this.rejectedTokens.delete(mint);
            SocketManager.emitLog(`[HELIUS] 🎓 Pump.fun graduation detected for ${mint.slice(0, 8)}... Re-evaluating with pool data.`, "info");
        }

        const cached = this.rejectedTokens.get(mint);
        if (cached && cached.expiry > Date.now()) return;

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
                // Skip retries — just add to watchlist and wait for CREATE_POOL event.
                if (dexId === "pumpfun") {
                    this._pumpfunWatchlist.set(mint, Date.now());
                    SocketManager.emitLog(`[HELIUS] Pump.fun ${mint.slice(0, 8)}... on bonding curve. Watching for graduation.`, "info");
                    this._flashRetryCount.delete(mint);
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
                        SocketManager.emitLog(`[HELIUS] Token ${mint.slice(0, 8)}... unresolvable after ${RETRY_DELAYS.length} retries. Dropping.`, "warning");
                    }
                }
            }
        } catch (e) {
            console.warn(`[HELIUS] Flash Scout resolution failed for ${mint}:`, e);
        }
    }

}
