import { connection, wallet, POOL_DATA_FILE, BASE_TOKENS, SOL_MINT } from "./config";
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
    private slStrikeCount: Map<string, number> = new Map(); // Track consecutive SL hits (glitch protection)
    private evaluationQueue: ScanResult[] = [];
    private isProcessingQueue: boolean = false;
    // Fix #4: DexScreener rate limiter + pair cache
    private lastDexScreenerCall: number = 0;
    private readonly DEXSCREENER_MIN_DELAY = 500; // 500ms between calls
    private dexPairCache: Map<string, { pairAddress: string; expiry: number }> = new Map();
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
                currentMcap: partial?.currentMcap
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
            if (baseMintAddr === BASE_TOKENS["USDC"].toBase58()) return 1.0;
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
        const balance = await safeRpc(() => connection.getBalance(wallet.publicKey), "getWalletBalance");
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
            mode: this.settings.mode
        };

        this.scanner = new MarketScanner(criteria, async (result: ScanResult) => {
            if (!this.isRunning) return;
            this.enqueueToken(result);
        }, connection);

        this.scanner.start();
    }

    private enqueueToken(result: ScanResult) {
        this.evaluationQueue.push(result);
        if (!this.isProcessingQueue) {
            this.processQueue();
        }
    }

    private async processQueue() {
        if (this.evaluationQueue.length === 0) {
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
        const result = this.evaluationQueue.shift()!;
        const mintAddress = result.mint.toBase58();

        // Guard: Skip if already being processed (prevents race condition duplicate buys)
        if (this.pendingMints.has(mintAddress)) {
            // Skip directly without entering try/finally (which would delete the other call's guard)
            setTimeout(() => this.processQueue(), 500);
            return;
        }

        try {

            // Exclusion Logic: Don't buy if we already have ANY pool for this token (active OR exited)
            const activePools: PoolData[] = await this.getPortfolio();
            if (activePools.some((p: PoolData) => p.mint === mintAddress)) {
                // SocketManager.emitLog(`[QUEUE] Skipping ${result.symbol}: Already in portfolio.`, "info");
                return;
            }

            // Check rejected token cache
            const cached = this.rejectedTokens.get(mintAddress);
            if (cached && cached.expiry > Date.now()) {
                // console.log(`[QUEUE] Skipping ${result.symbol}: Recently rejected (${cached.reason}).`);
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

                const tokenAccounts = await safeRpc(() => connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: result.mint }), "getPostSwapBalance");
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
                const baseMintAccountInfo = await safeRpc(() => connection.getParsedAccountInfo(activeBaseMint), "getBaseMintInfo");
                const baseDecimals = (baseMintAccountInfo?.value?.data as any)?.parsed?.info?.decimals || 9;
                const baseScale = Math.pow(10, baseDecimals);
                const lpppAmountBase = BigInt(Math.floor(targetBaseAmount * baseScale));

                const poolInfo = await this.strategy.createMeteoraPool(result.mint, tokenAmount, lpppAmountBase, activeBaseMint, this.settings.meteoraFeeBps);

                if (poolInfo.success) {
                    SocketManager.emitLog(`[SUCCESS] Pool Created: ${poolInfo.poolAddress}`, "success");

                    // Now, initialPrice is perfectly synced to our true Jupiter execution price.
                    const initialPrice = tokenUiAmountChecked > 0 ? (Number(lpppAmountBase) / baseScale) / tokenUiAmountChecked : 0;

                    const supplyRes = await safeRpc(() => connection.getTokenSupply(result.mint), "getTokenSupply");
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
            // Wait 1 second between processing queue items to be very safe on RPC
            setTimeout(() => this.processQueue(), 1000);
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

    async getWalletBalance() {
        try {
            const solBalance = await safeRpc(() => connection.getBalance(wallet.publicKey), "getSolBalance");

            const baseTokenBalances: Record<string, number> = {};
            for (const [symbol, mint] of Object.entries(BASE_TOKENS)) {
                const accounts = await safeRpc(() => connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint }), "getPortfolio");
                const uiAmount = accounts.value.reduce((acc, account) => acc + (account.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
                baseTokenBalances[symbol] = uiAmount;
            }

            return {
                sol: solBalance / 1e9,
                baseTokens: baseTokenBalances
            };
        } catch (error) {
            console.error("Portfolio Fetch Error:", error);
            return { sol: 0, lppp: 0 };
        }
    }

    private async monitorPositions() {
        // Monitor loop
        let sweepCount = 0;
        const runMonitor = async () => {
            this.lastMonitorHeartbeat = Date.now(); // Watchdog: I'm alive!

            let pools: PoolData[] = [];
            try {
                pools = await dbService.getAllPools();
                const activePools = pools.filter(p => !p.exited && p.isBotCreated);

                if (activePools.length === 0) {
                    if (sweepCount % 10 === 0) console.log(`[MONITOR DEBUG] No active bot pools found.`);
                    this.monitorInterval = setTimeout(runMonitor, 60000);
                    return;
                }

                // ═══ JUPITER BATCH PRICING Integration ═══
                const baseMints = Object.values(BASE_TOKENS).map(m => m.toBase58());
                const activeMints = activePools.map(p => p.mint);
                const mintsToFetch = [...new Set([...baseMints, ...activeMints])];

                const jupPrices = await JupiterPriceService.getPrices(mintsToFetch);

                // Keep the price validation logic using dynamic values inside checking array
                const anyBaseOk = Object.values(BASE_TOKENS).some(async mint => {
                    let val = jupPrices.get(mint.toBase58()) || 0;
                    if (val === 0) val = await this.getBaseTokenPrice(mint.toBase58());
                    return val > 0;
                });

                if (!anyBaseOk) {
                    console.warn("[MONITOR] All price sources failed for base tokens. Skipping this sweep.");
                    this.monitorInterval = setTimeout(runMonitor, 30000);
                    return;
                }

                for (const pool of activePools) {
                    try {
                        if (pool.withdrawalPending) continue;
                        if (this.activeTpSlActions.has(pool.poolId)) continue;

                        const posValue = await this.strategy.getPositionValue(pool.poolId, pool.mint, pool.positionId);

                        if (posValue.success) {
                            /* ═══ DEBUG: Show raw values for diagnosis ═══
                            if (sweepCount < 10 || sweepCount % 5 === 0) {
                                console.log(`[MONITOR RAW] ${pool.token} | totalSol: ${posValue.totalSol.toFixed(6)} | spotPrice: ${posValue.spotPrice.toFixed(8)} | fees: ${posValue.feesSol.toFixed(6)} | initialSolValue: ${pool.initialSolValue?.toFixed(6) || 'N/A'}`);
                            } */

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

                            // 2. Spot ROI (Price-based)
                            const normalizedPrice = posValue.spotPrice;
                            let roiVal = (normalizedPrice - pool.initialPrice) / pool.initialPrice * 100;

                            // ═══ AUTO-RECALIBRATION (Simplified) ═══
                            if (roiVal < -90 && !pool.priceReconstructed) {
                                if (roiVal < -95 && (pool.roi === "0%" || pool.roi === "0.00%")) {
                                    const invertedInitial = 1 / pool.initialPrice;
                                    const newRoi = (normalizedPrice - invertedInitial) / invertedInitial * 100;
                                    if (Math.abs(newRoi) < 50) {
                                        console.log(`[MONITOR] Recalibrating inverted initial price for ${pool.token}: ${pool.initialPrice} -> ${invertedInitial}`);
                                        pool.initialPrice = invertedInitial;
                                        roiVal = newRoi;
                                        pool.priceReconstructed = true;
                                    } else {
                                        console.log(`[MONITOR] Resetting broken initial price for ${pool.token} to current: ${normalizedPrice}`);
                                        pool.initialPrice = normalizedPrice;
                                        roiVal = 0;
                                        pool.priceReconstructed = true;
                                    }

                                    // Recalibrate initial MCAP if tracking
                                    if (pool.totalSupply && pool.totalSupply > 0) {
                                        let bPrice = jupPrices.get(BASE_TOKENS[this.settings.baseToken]?.toBase58() || BASE_TOKENS["LPPP"].toBase58()) || 0;
                                        if (bPrice > 0) {
                                            pool.initialMcap = pool.totalSupply * (pool.initialPrice * bPrice);
                                            console.log(`[MONITOR] Recalibrated initialMcap to $${pool.initialMcap.toFixed(2)}`);
                                        }
                                    }
                                }
                            }

                            const cappedRoi = isFinite(roiVal) ? roiVal : 99999;
                            const roiString = cappedRoi > 10000 ? "MOON" : `${cappedRoi.toFixed(2)}%`;
                            pool.roi = roiString;

                            const activeBaseMintStr = BASE_TOKENS[this.settings.baseToken]?.toBase58() || BASE_TOKENS["LPPP"].toBase58();
                            let basePrice = jupPrices.get(activeBaseMintStr) || 0;
                            if (basePrice === 0) {
                                basePrice = await this.getBaseTokenPrice(activeBaseMintStr);
                            }

                            // 3. USD STRATEGY (4x/7x Take Profit, 0.7x Stop Loss)
                            const tokenPrice = jupPrices.get(pool.mint) || (posValue.spotPrice * basePrice);

                            // Initialize entryUsdValue if missing
                            if (!pool.entryUsdValue || pool.entryUsdValue <= 0) {
                                pool.entryUsdValue = (pool.initialSolValue || 0) * basePrice;
                                console.log(`[STRATEGY] Backfilled entryUsdValue for ${pool.token}: $${pool.entryUsdValue.toFixed(4)}`);
                            }

                            // Calculate Total Position USD matching Meteora UI strategy
                            // Total = (Token Principal + Token Fees) * Price + (Base Principal + Base Fees) * LPPP_Price
                            const totalTokenAmount = posValue.userTokenInLp + posValue.feesToken;
                            const totalBaseAmount = posValue.userBaseInLp + posValue.feesSol;

                            const currentUsdValue = (totalTokenAmount * tokenPrice) + (totalBaseAmount * basePrice);
                            const usdMultiplier = pool.entryUsdValue > 0 ? (currentUsdValue / pool.entryUsdValue) : 1;

                            // ── MCAP STRATEGY ──
                            let currentMcap = 0;
                            if (pool.totalSupply && pool.totalSupply > 0) {
                                currentMcap = tokenPrice * pool.totalSupply;
                            }

                            // ═══ LEGACY DB AUTO-CORRECTION ═══
                            // If the initialMcap in the DB was saved using delayed DexScreener pricing (bug prior to patch), 
                            // we force it to recalibrate using the exact `initialPrice` constraint to sync with Net ROI.
                            if (pool.totalSupply && pool.totalSupply > 0 && pool.initialPrice && basePrice > 0) {
                                // If the token used LPPP injection, initialPrice is in LPPP base units, so * basePrice
                                // If it was a pure native swap, initialPrice is in native SOL units, and IS the basePrice equivalent.
                                let trueInitialUsdPrice = pool.initialPrice;

                                // Detect if LPPP was used vs SOL based on the bot configuration at the time of purchase
                                if (pool.baseToken && pool.baseToken !== "SOL") {
                                    trueInitialUsdPrice = pool.initialPrice * basePrice;
                                } else {
                                    // For Native SOL snipes, initialPrice is exactly SolAmount / TokenAmount
                                    // So true USD price is the SOL per token * current Price of SOL
                                    trueInitialUsdPrice = pool.initialPrice * basePrice;
                                }

                                const expectedInitialMcap = pool.totalSupply * trueInitialUsdPrice;

                                // If missing or off by more than 10%, rewrite the database constraint
                                if (!pool.initialMcap || pool.initialMcap <= 0 || Math.abs(pool.initialMcap - expectedInitialMcap) / expectedInitialMcap > 0.10) {
                                    pool.initialMcap = expectedInitialMcap;
                                    console.log(`[MONITOR] Auto-calibrated corrupted initialMcap for ${pool.token}: $${pool.initialMcap.toFixed(2)}`);
                                }
                            }

                            // Use MCAP multiplier if available, otherwise fallback to position USD multiplier
                            const mcapMultiplier = (currentMcap > 0 && pool.initialMcap && pool.initialMcap > 0)
                                ? (currentMcap / pool.initialMcap)
                                : usdMultiplier;

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
                                priceReconstructed: pool.priceReconstructed,
                                positionValue: pool.positionValue,
                                entryUsdValue: pool.entryUsdValue,
                                currentMcap: currentMcap
                            });

                            // Small delay to prevent 429s in big loops - Be aggressive for DRPC
                            await new Promise(r => setTimeout(r, 1000));

                            // ── Take Profit Stage 1: 4x Value → Close 40% ──
                            if (mcapMultiplier >= 4.0 && !pool.tp1Done) {
                                this.activeTpSlActions.add(pool.poolId);
                                SocketManager.emitLog(`[TP1] ${pool.token} reached 4x MCAP! Withdrawing 40%...`, "success");
                                const result = await this.withdrawLiquidity(pool.poolId, 40, "TP1");
                                if (result.success) {
                                    await this.liquidatePoolToSol(pool.mint);
                                }
                                this.activeTpSlActions.delete(pool.poolId);
                                await this.updatePoolROI(pool.poolId, roiString, false, undefined, { tp1Done: true });
                            }

                            // ── Take Profit Stage 2: 7x Value → Close another 40% ──
                            if (mcapMultiplier >= 7.0 && pool.tp1Done && !pool.takeProfitDone) {
                                this.activeTpSlActions.add(pool.poolId);
                                SocketManager.emitLog(`[TP2] ${pool.token} reached 7x MCAP! Withdrawing 40%...`, "success");
                                const result = await this.withdrawLiquidity(pool.poolId, 40, "TP2");
                                if (result.success) {
                                    await this.liquidatePoolToSol(pool.mint);
                                }
                                this.activeTpSlActions.delete(pool.poolId);
                                await this.updatePoolROI(pool.poolId, roiString, false, undefined, { takeProfitDone: true });
                            }

                            // ── Stop Loss: 0.7x Value (-30%) → Close 80% ──
                            // 3-minute cooldown: don't trigger SL on pools younger than 3 minutes
                            const poolAgeMs = Date.now() - new Date(pool.created).getTime();
                            const SL_COOLDOWN_MS = 3 * 60 * 1000;

                            if (mcapMultiplier <= 0.7 && !pool.stopLossDone && poolAgeMs > SL_COOLDOWN_MS) {
                                // 1. Internal Math Check (Glitch Protection Layer A)
                                // If the token-to-lppp ratio (spotPrice) hasn't dropped but USD has, it's an LPPP price glitch.
                                const priceRatioMultiplier = pool.initialPrice > 0 ? (posValue.spotPrice / pool.initialPrice) : 1;

                                if (priceRatioMultiplier > 0.8 && basePrice < 0.00001) {
                                    console.warn(`[GLITCH PREVENT] ${pool.token} MCAP dropped but Internal Math is healthy (Ratio: ${priceRatioMultiplier.toFixed(2)}x). Possible Base Token Price Glitch. Skipping SL strike.`);
                                } else {
                                    // 2. Wait and See (Glitch Protection Layer B - 3 consecutive strikes)
                                    const strikes = (this.slStrikeCount.get(pool.poolId) || 0) + 1;
                                    this.slStrikeCount.set(pool.poolId, strikes);

                                    if (strikes < 3) {
                                        console.warn(`[STOP LOSS STRIKE] ${pool.token} hit ${strikes}/3 strikes (Value: ${mcapMultiplier.toFixed(2)}x). Waiting for confirmation...`);
                                    } else {
                                        this.activeTpSlActions.add(pool.poolId);
                                        SocketManager.emitLog(`[STOP LOSS] ${pool.token} confirmed 0.7x MCAP drop! Withdrawing 80%...`, "error");
                                        const result = await this.withdrawLiquidity(pool.poolId, 80, "STOP LOSS");
                                        if (result.success) {
                                            await this.liquidatePoolToSol(pool.mint);
                                        }
                                        this.activeTpSlActions.delete(pool.poolId);
                                        await this.updatePoolROI(pool.poolId, roiString, false, undefined, { stopLossDone: true });

                                        if (usdMultiplier <= 0.05) {
                                            SocketManager.emitLog(`[CLEANUP] ${pool.token} value is dead (0.05x). Marking as EXITED.`, "warning");
                                            await this.updatePoolROI(pool.poolId, "DEAD", true, undefined, { stopLossDone: true });
                                        }
                                    }
                                }
                            } else {
                                // Reset strikes if we recover above 0.7x
                                if (this.slStrikeCount.has(pool.poolId)) {
                                    this.slStrikeCount.delete(pool.poolId);
                                }

                                // Visibility: Why didn't it strike? 
                                // Helps user understand that a -76% ROI pool is skipped because SL already happened.
                                if (usdMultiplier <= 0.7 && pool.stopLossDone) {
                                    if (sweepCount % 10 === 0) console.log(`[SL-SKIP] ${pool.token} is at ${usdMultiplier.toFixed(2)}x but SL was already completed.`);
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
                // Schedule next iteration (recursive timeout)
                if (this.isRunning || pools.length > 0) {
                    this.monitorInterval = setTimeout(runMonitor, 60000); // Check every 60s
                } else {
                    this.monitorInterval = null; // Clear interval if not running and no pools
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
                            // We use a dedicated update for this property to ensure it sticks
                            // Note: We don't have a direct "updateInitialValue" method, so we use updatePool
                            // But updatePool usually takes an ROI string. We need to persist this change effectively.
                            // The easiest way is to update the IN-MEMORY pool object that next monitor loop will use?
                            // No, memory is refreshed from DB every loop (dbService.getAllPools).
                            // So we MUST update DB.

                            // Since dbService doesn't expose a clean "update property" method, we rely on the loop to re-calc?
                            // No, the loop only SETS initialSolValue if it's missing (lines 833).
                            // It does NOT update it down.

                            // We need to implement a DB update here.
                            // Assuming dbService has `updatePool(poolId, { initialSolValue: ... })` support?
                            // Checking db-service.ts would be ideal, but standard pattern suggests `updatePool` might just confirm activity.
                            // Let's manually trigger the `updatePoolROI` with the new value.

                            await this.updatePoolROI(poolId, isFull ? "CLOSED" : "PARTIAL", false, undefined, {
                                withdrawalPending: false,
                                initialSolValue: newInitialVal
                            }, true);

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

    private async liquidatePoolToSol(tokenMint: string) {
        // Only sell the sniped token back to SOL.
        // IMPORTANT: Do NOT sell LPPP here. LPPP is a reserve asset used to seed
        // future pools. Selling it would drain the entire wallet balance.
        const getRawBalance = async (mintStr: string) => {
            try {
                const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mintStr) });
                return accounts.value.reduce((acc, account) => acc + BigInt(account.account.data.parsed.info.tokenAmount.amount), 0n);
            } catch (e) { return 0n; }
        };

        const tokenBal = await getRawBalance(tokenMint);
        if (tokenBal > 0n) {
            SocketManager.emitLog(`[LIQUIDATE] Closing $${tokenMint.slice(0, 6)} and converting to SOL...`, "warning");
            await this.strategy.sellToken(new PublicKey(tokenMint), tokenBal);
        } else {
            SocketManager.emitLog(`[LIQUIDATE] No ${tokenMint.slice(0, 6)} balance to sell.`, "info");
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
    async triggerFlashScout(mint: string, pairAddress: string, dexId: string) {
        if (!this.isRunning) return;

        // 1. Quick Guard
        if (this.pendingMints.has(mint)) return;
        const cached = this.rejectedTokens.get(mint);
        if (cached && cached.expiry > Date.now()) return;

        try {
            // 2. Resolve full data via DexScreener
            // (We use batchLookup even for one to reuse normalization logic)
            const resolved = await DexScreenerService.batchLookupTokens([mint], "HELIUS_FLASH");

            if (resolved.length > 0) {
                const data = resolved[0];
                const result: ScanResult = {
                    mint: new PublicKey(data.baseToken.address),
                    pairAddress: data.pairAddress,
                    dexId: data.dexId,
                    volume24h: data.volume.h24,
                    liquidity: data.liquidity.usd,
                    mcap: data.marketCap,
                    symbol: data.baseToken.symbol,
                    priceUsd: parseFloat(data.priceUsd),
                    source: "HELIUS_LIVE"
                };

                // Add 5m and 1h volume specifically for Scout logic
                (result as any).volume5m = data.volume.m5;
                (result as any).volume1h = data.volume.h1;

                SocketManager.emitLog(`[HELIUS] Flash Scout filtering: ${result.symbol} (MCAP: $${Math.floor(result.mcap)})`, "info");
                if (this.scanner) {
                    await this.scanner.evaluateToken(result);
                }
            } else {
                // If DexScreener doesn't have it yet, it might be EXTREMELY new.
                // We could fallback to RPC metadata but we wouldn't have volume/liq.
                // For now, we wait for the next sweep or a slight delay.
                // SocketManager.emitLog(`[HELIUS] Token ${mint.slice(0, 8)} too new for DexScreener resolution. Skipping flash.`, "info");
            }
        } catch (e) {
            console.warn(`[HELIUS] Flash Scout resolution failed for ${mint}:`, e);
        }
    }

}
