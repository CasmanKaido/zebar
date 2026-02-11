import { connection, wallet, POOL_DATA_FILE, LPPP_MINT, SOL_MINT } from "./config";
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

const LPPP_MINT_ADDR = LPPP_MINT.toBase58();

export interface BotSettings {
    buyAmount: number; // in SOL
    lpppAmount: number; // in units (fallback only)
    meteoraFeeBps: number; // in Basis Points (e.g. 200 = 2%)
    maxPools: number; // Max pools to create before auto-stop
    slippage: number; // in % (e.g. 10)
    minVolume5m: number;
    minVolume1h: number;
    minVolume24h: number;
    minLiquidity: number;
    minMcap: number;
}

export class BotManager {
    public isRunning: boolean = false;
    private scanner: MarketScanner | null = null;
    private strategy: StrategyManager;
    private sessionPoolCount: number = 0;
    private monitorInterval: NodeJS.Timeout | null = null;
    private pendingMints: Set<string> = new Set(); // Guards against duplicate buys
    private activeTpSlActions: Set<string> = new Set(); // Guards against double TP/SL
    private healthCheckInterval: NodeJS.Timeout | null = null;
    private isUsingBackup: boolean = false;
    private settings: BotSettings = {
        buyAmount: 0.1,
        lpppAmount: 1000,
        meteoraFeeBps: 200, // Default 2%
        maxPools: 5, // Default 5 pools
        slippage: 10,
        minVolume5m: 10000, // Default 10k
        minVolume1h: 100000,
        minVolume24h: 1000000, // Default 1M
        minLiquidity: 60000,
        minMcap: 60000
    };

    constructor() {
        this.strategy = new StrategyManager(connection, wallet);
        this.initialize();
    }

    private async initialize() {
        // 1. Migrate if needed
        await this.migrateFromJsonToSqlite();

        // 2. Load and Monitor
        await this.loadAndMonitor();
    }

    private async loadAndMonitor() {
        try {
            const history = await dbService.getAllPools();
            console.log(`[BOT] Loaded ${history.length} pools from SQLite.`);
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
                if (mint === LPPP_MINT.toBase58() || mint === SOL_MINT.toBase58()) continue;

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
    async updatePoolROI(poolId: string, roi: string, exited: boolean = false, fees?: { sol: string; token: string }, partial?: Partial<PoolData>) {
        if (this.activeTpSlActions.has(poolId)) return;

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
            SocketManager.emitPoolUpdate({ poolId, roi, exited, unclaimedFees: updatedPool.unclaimedFees });
        } catch (e) {
            console.error("[DB] Update ROI Failed:", e);
        }
    }

    private async getLpppPrice(): Promise<number> {
        try {
            const res = await fetch("https://api.dexscreener.com/latest/dex/tokens/44sHXMkPeciUpqhecfCysVs7RcaxeM24VPMauQouBREV");
            const data: any = await res.json();
            const price = parseFloat(data?.pairs?.[0]?.priceUsd || "0");
            // No floor check — LPPP is a micro-cap token that can legitimately trade at very low prices.
            // parseFloat already returns 0 for invalid data, which is the only case we reject.
            return price;
        } catch (e) {
            console.warn("[BOT] Failed to fetch LPPP price:", e);
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

        // Run Stabilization Guards (Issue 28 & 30)
        await this.checkOrphanTokens();

        this.sessionPoolCount = 0; // Reset session counter
        this.pendingMints.clear(); // Reset pending buys

        // Start position monitor (only if not already running)
        if (!this.monitorInterval) {
            this.monitorPositions();
        }

        // Check Balance
        const balance = await connection.getBalance(wallet.publicKey);
        if (balance === 0) {
            SocketManager.emitLog(`[WARNING] Your wallet (${wallet.publicKey.toBase58().slice(0, 8)}...) has 0 SOL. Buys will fail.`, "error");
        } else {
            SocketManager.emitLog(`[WALLET] Active: ${wallet.publicKey.toBase58().slice(0, 8)}... | Balance: ${(balance / 1e9).toFixed(3)} SOL`, "success");
        }

        this.isRunning = true;
        SocketManager.emitStatus(true);
        SocketManager.emitLog(`LPPP BOT Streamer Active (Vol5m > $${this.settings.minVolume5m}, Vol1h > $${this.settings.minVolume1h}, Vol24h > $${this.settings.minVolume24h}, Liq > $${this.settings.minLiquidity}, MCAP > $${this.settings.minMcap})...`, "info");

        const criteria: ScannerCriteria = {
            minVolume5m: this.settings.minVolume5m,
            minVolume1h: this.settings.minVolume1h,
            minVolume24h: this.settings.minVolume24h,
            minLiquidity: this.settings.minLiquidity,
            minMcap: this.settings.minMcap
        };

        this.scanner = new MarketScanner(criteria, async (result: ScanResult) => {
            if (!this.isRunning) return;

            const mintAddress = result.mint.toBase58();

            // Guard: Skip if already being processed (prevents race condition duplicate buys)
            if (this.pendingMints.has(mintAddress)) return;

            // Exclusion Logic: Don't buy if already active in portfolio
            const activePools: PoolData[] = await this.getPortfolio();
            if (activePools.some((p: PoolData) => p.mint === mintAddress && !p.exited)) {
                // Silently skip to keep logs clean
                return;
            }

            // Lock this mint to prevent duplicate buys during processing
            this.pendingMints.add(mintAddress);

            SocketManager.emitLog(`[TARGET ACQUIRED] ${result.symbol} met all criteria!`, "success");
            SocketManager.emitLog(`Mint: ${result.mint.toBase58()}`, "warning");
            SocketManager.emitLog(`- 24h Vol: $${Math.floor(result.volume24h)} | Liq: $${Math.floor(result.liquidity)} | MCAP: $${Math.floor(result.mcap)}`, "info");

            try {
                const safety = await OnChainSafetyChecker.checkToken(connection, mintAddress, result.pairAddress);
                if (!safety.safe) {
                    SocketManager.emitLog(`[SAFETY] ❌ Skipped ${result.symbol}: ${safety.reason}`, "error");
                    return;
                }
            } catch (safetyErr: any) {
                console.warn("[SAFETY] Check failed:", safetyErr.message);
                SocketManager.emitLog(`[SAFETY] ⚠️ Could not verify ${result.symbol} — skipping for safety`, "warning");
                return;
            }

            // 1. Swap (Buy)
            SocketManager.emitLog(`Executing Market Buy (${this.settings.buyAmount} SOL, Slippage: ${this.settings.slippage}%)...`, "warning");
            try {
                const { success, amount, uiAmount, error } = await this.strategy.swapToken(result.mint, this.settings.buyAmount, this.settings.slippage, result.pairAddress, result.dexId);

                if (success) {
                    SocketManager.emitLog(`Buy Transaction Sent! check Solscan/Wallet for incoming tokens.`, "success");

                    // 2. Refresh Balance & Create LP (Dynamic Fee & Price)
                    const LPPP_MINT_ADDR = LPPP_MINT;

                    // Wait 1.5s for chain to reflect balance
                    await new Promise(r => setTimeout(r, 1500));

                    // Fetch ACTUAL balance instead of relying on swap output
                    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: result.mint });
                    const actualAmountRaw = tokenAccounts.value.reduce((acc, account) => acc + BigInt(account.account.data.parsed.info.tokenAmount.amount), 0n);
                    const actualUiAmount = tokenAccounts.value.reduce((acc, account) => acc + (account.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);

                    if (actualAmountRaw === 0n) {
                        SocketManager.emitLog(`[LP ERROR] No token balance found for ${result.symbol} after swap. Skipping pool creation.`, "error");
                        return;
                    }

                    // Use 99% of balance to avoid "Custom: 0" (Insufficient Balance)
                    // CRITICAL: We scale BOTH sides to 99% to maintain the exact PRICE RATIO.
                    const tokenAmount = (actualAmountRaw * 99n) / 100n;
                    const tokenUiAmountChecked = (actualUiAmount * 99) / 100;

                    let targetLpppAmount = this.settings.lpppAmount;

                    // Dynamic Price Calculation (always auto-sync)
                    if (result.priceUsd > 0) {
                        const lpppPrice = await this.getLpppPrice();
                        if (lpppPrice > 0) {
                            const tokenPriceLppp = result.priceUsd / lpppPrice;
                            targetLpppAmount = (tokenUiAmountChecked * tokenPriceLppp);
                            SocketManager.emitLog(`[AUTO-PRICE] Token: $${result.priceUsd} | LPPP: $${lpppPrice.toFixed(6)} | Target LPPP: ${targetLpppAmount.toFixed(2)}`, "info");
                        } else {
                            SocketManager.emitLog(`[AUTO-PRICE] LPPP price unavailable. Cannot create pool.`, "error");
                            return;
                        }
                    }

                    // Final guard: never create a pool with 0 LPPP
                    if (targetLpppAmount <= 0) {
                        SocketManager.emitLog(`[LP ERROR] Cannot seed pool: LPPP amount is 0. Aborting.`, "error");
                        return;
                    }

                    // Apply the same 99% buffer to LPPP side to preserve ratio
                    const lpppAmountBase = BigInt(Math.floor(targetLpppAmount * 1e6));
                    let finalLpppAmountBase = (lpppAmountBase * 99n) / 100n;
                    let finalLpppUiAmount = (targetLpppAmount * 99) / 100;

                    // ═══ CRITICAL: Pre-Flight LPPP Balance Check (Batch 2.1) ═══
                    // The LPPP token is Token-2022, which has transfer fees.
                    // We MUST verify the wallet has enough LPPP before creating the pool.
                    let effectiveTokenAmount = tokenAmount;
                    const LPPP_DECIMALS = 6;
                    try {
                        const lpppAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: LPPP_MINT });
                        const lpppBalanceRaw = lpppAccounts.value.reduce(
                            (acc, account) => acc + BigInt(account.account.data.parsed.info.tokenAmount.amount), 0n
                        );
                        const lpppBalanceUi = Number(lpppBalanceRaw) / (10 ** LPPP_DECIMALS);

                        // Apply 5% buffer for Token-2022 transfer fees
                        const maxUsableLppp = (lpppBalanceRaw * 95n) / 100n;
                        const maxUsableLpppUi = lpppBalanceUi * 0.95;

                        if (lpppBalanceRaw < 100n * BigInt(10 ** LPPP_DECIMALS)) {
                            SocketManager.emitLog(`[LP ERROR] LPPP balance too low (${lpppBalanceUi.toFixed(2)} LPPP). Need at least 100 LPPP to seed pool. Skipping.`, "error");
                            return;
                        }

                        if (finalLpppAmountBase > maxUsableLppp) {
                            SocketManager.emitLog(`[LP WARN] Required LPPP (${finalLpppUiAmount.toFixed(2)}) exceeds wallet balance (${lpppBalanceUi.toFixed(2)}). Capping to ${maxUsableLpppUi.toFixed(2)} LPPP.`, "warning");
                            finalLpppAmountBase = maxUsableLppp;
                            finalLpppUiAmount = maxUsableLpppUi;

                            // Recalculate token amount to maintain price ratio
                            if (targetLpppAmount > 0) {
                                const ratio = maxUsableLpppUi / targetLpppAmount;
                                const adjustedTokenRaw = BigInt(Math.floor(Number(tokenAmount) * ratio));
                                // Use the smaller of the two to be safe
                                effectiveTokenAmount = adjustedTokenRaw < tokenAmount ? adjustedTokenRaw : tokenAmount;
                            }
                        }
                    } catch (balErr: any) {
                        SocketManager.emitLog(`[LP WARN] Could not verify LPPP balance: ${balErr.message}. Proceeding with calculated amount.`, "warning");
                    }

                    // ═══ DIAGNOSTIC LOGGING ═══
                    SocketManager.emitLog(`[POOL DIAG] LPPP Sending: ${finalLpppUiAmount.toFixed(2)} | Token Sending: ${Number(effectiveTokenAmount)} raw | Ratio: ${(finalLpppUiAmount / tokenUiAmountChecked).toFixed(4)} LPPP/Token`, "info");

                    // We try-catch the LP creation to prevent crashing the whole bot if SDK fails
                    try {
                        const poolInfo = await this.strategy.createMeteoraPool(result.mint, effectiveTokenAmount, finalLpppAmountBase, LPPP_MINT, this.settings.meteoraFeeBps);

                        if (poolInfo.success) {
                            SocketManager.emitLog(`Meteora Pool Created: ${poolInfo.poolAddress}`, "success");
                            const poolEvent = {
                                poolId: poolInfo.poolAddress || "",
                                token: result.symbol,
                                roi: "0%", // Initial ROI
                                created: new Date().toISOString()
                            };

                            const initialPrice = tokenUiAmountChecked > 0 ? finalLpppUiAmount / tokenUiAmountChecked : 0;

                            const fullPoolData: PoolData = {
                                ...poolEvent,
                                mint: result.mint.toBase58(),
                                initialPrice,
                                initialTokenAmount: tokenUiAmountChecked,
                                initialLpppAmount: finalLpppUiAmount,
                                exited: false,
                                positionId: poolInfo.positionAddress,
                                unclaimedFees: { sol: "0", token: "0" }
                            };

                            SocketManager.emitPool(fullPoolData);
                            await this.savePools(fullPoolData); // Ensure awaited (Issue 33)

                            this.sessionPoolCount++;
                            SocketManager.emitLog(`[SESSION] Pool Created: ${this.sessionPoolCount} / ${this.settings.maxPools}`, "info");

                            if (this.sessionPoolCount >= this.settings.maxPools) {
                                SocketManager.emitLog(`[LIMIT REACHED] Session limit of ${this.settings.maxPools} pools reached. Shutting down...`, "warning");
                                this.stop();
                            }
                        } else {
                            SocketManager.emitLog(`[LP ERROR] Pool Failed: ${poolInfo.error}`, "error");
                        }
                    } catch (lpError: any) {
                        console.error("[BOT] LP Creation Critical Failure:", lpError);
                        SocketManager.emitLog(`[ERROR] Failed to seed pool: ${lpError.message}`, "error");
                    }
                } else {
                    SocketManager.emitLog(`Buy Failed: ${error || "Unknown Error"}`, "error");
                }
            } catch (swapError: any) {
                console.error("[BOT] Swap Execution Failure:", swapError);
                SocketManager.emitLog(`[ERROR] Swap execution failed: ${swapError.message}`, "error");
            } finally {
                // Release the mint lock so it can be re-evaluated in future sweeps
                this.pendingMints.delete(mintAddress);
            }
        }, connection);

        this.scanner.start();
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
            const pairRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
            const pairs = pairRes.data.pairs;

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
        // ONLY stop the monitor if we have no positions left to watch.
        // Otherwise, keep monitoring ROI/Fees/SL/TP for existing money.
        // Note: runMonitor already has logic to self-terminate if !isRunning && pools.length === 0
        console.log("[BOT] Scanning stopped. Monitor will continue if active pools exist.");

        SocketManager.emitStatus(false);
        SocketManager.emitLog("LPPP BOT Scanning Service Stopped.", "warning");
    }

    async getWalletBalance() {
        try {
            const solBalance = await connection.getBalance(wallet.publicKey);

            const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: LPPP_MINT });

            let lpppBalance = 0;
            if (tokenAccounts.value.length > 0) {
                lpppBalance = tokenAccounts.value.reduce((acc, account) => {
                    return acc + (account.account.data.parsed.info.tokenAmount.uiAmount || 0);
                }, 0);
            }

            return {
                sol: solBalance / 1e9,
                lppp: lpppBalance
            };
        } catch (error) {
            console.error("Portfolio Fetch Error:", error);
            return { sol: 0, lppp: 0 };
        }
    }

    private async monitorPositions() {
        const LPPP_MINT_ADDR = LPPP_MINT.toBase58();

        // Monitor loop
        let sweepCount = 0;
        const runMonitor = async () => {
            let pools: PoolData[] = [];
            try {
                pools = await dbService.getAllPools();
                if (pools.length > 0) {
                    console.log(`[MONITOR DEBUG] Checking ${pools.length} pools from SQLite...`);
                } else {
                    if (sweepCount % 10 === 0) {
                        console.log(`[MONITOR DEBUG] No active pools found.`);
                    }
                }

                for (const pool of pools) {
                    try {
                        if (pool.exited) continue;
                        console.log(`[MONITOR DEBUG] Checking pool: ${pool.token} (${pool.poolId.slice(0, 8)}...)`);
                        if (pool.withdrawalPending) continue; // Skip if withdrawal in progress (Issue 30)
                        if (this.activeTpSlActions.has(pool.poolId)) continue; // Skip if TP/SL in flight

                        // Sort mints to match Meteora's on-chain vault derivation order
                        const sortedMintA = new PublicKey(pool.mint).toBuffer().compare(LPPP_MINT.toBuffer()) < 0 ? pool.mint : LPPP_MINT_ADDR;
                        const sortedMintB = sortedMintA === pool.mint ? LPPP_MINT_ADDR : pool.mint;
                        const lpppIsMintA = LPPP_MINT_ADDR === sortedMintA;

                        const status = await this.strategy.getPoolStatus(pool.poolId, sortedMintA, sortedMintB);
                        const fees = await this.strategy.getMeteoraFees(pool.poolId);

                        console.log(`[MONITOR DEBUG] Status: ${JSON.stringify(status)}`);
                        console.log(`[MONITOR DEBUG] Fees: A=${fees.feeA}, B=${fees.feeB}`);

                        const feeTokenRaw = pool.mint === sortedMintA ? fees.feeA : fees.feeB;
                        const feeLpppRaw = LPPP_MINT_ADDR === sortedMintA ? fees.feeA : fees.feeB;

                        // Display raw fee amounts (no scaling needed — SDK returns atomic units)
                        const adjustedLpppFee = feeLpppRaw.toString();
                        const adjustedTokenFee = feeTokenRaw.toString();

                        pool.unclaimedFees = { sol: adjustedLpppFee, token: adjustedTokenFee };
                        SocketManager.emitPoolUpdate({ poolId: pool.poolId, unclaimedFees: pool.unclaimedFees });

                        if (status.success && status.price > 0) {
                            const lpppIsMintA = LPPP_MINT_ADDR === sortedMintA;
                            const normalizedPrice = lpppIsMintA ? (1 / status.price) : status.price;

                            let roiVal = (normalizedPrice - pool.initialPrice) / pool.initialPrice * 100;

                            // ═══ AUTO-RECALIBRATION (Simplified) ═══
                            if (roiVal < -90) {
                                if (roiVal < -95 && pool.roi === "0%") {
                                    const invertedInitial = 1 / pool.initialPrice;
                                    const newRoi = (normalizedPrice - invertedInitial) / invertedInitial * 100;
                                    if (Math.abs(newRoi) < 50) {
                                        console.log(`[MONITOR] Recalibrating inverted initial price for ${pool.token}: ${pool.initialPrice} -> ${invertedInitial}`);
                                        pool.initialPrice = invertedInitial;
                                        roiVal = newRoi;
                                    } else {
                                        // If inversion doesn't fix it, reset initial to current to stop the bleed
                                        console.log(`[MONITOR] Resetting broken initial price for ${pool.token} to current: ${normalizedPrice}`);
                                        pool.initialPrice = normalizedPrice;
                                        roiVal = 0;
                                    }
                                }
                            }

                            const cappedRoi = isFinite(roiVal) ? roiVal : 99999;
                            const roiString = cappedRoi > 10000 ? "MOON" : `${cappedRoi.toFixed(2)}%`;

                            console.log(`[MONITOR DEBUG] NormPrice: ${normalizedPrice}, Initial: ${pool.initialPrice}, ROI: ${roiString}`);

                            // Update local state and emit
                            pool.roi = roiString;
                            await this.updatePoolROI(pool.poolId, roiString, false, pool.unclaimedFees);

                            // ── Take Profit Stage 1: +300% (3x) → Close 40% ──
                            if (roiVal >= 300 && !pool.tp1Done) {
                                this.activeTpSlActions.add(pool.poolId);
                                SocketManager.emitLog(`[TP1] ${pool.token} hit 3x (+${roiVal.toFixed(0)}%)! Withdrawing 40%...`, "success");
                                const result = await this.withdrawLiquidity(pool.poolId, 40, "TP1");
                                if (result.success) {
                                    await this.liquidatePoolToSol(pool.mint);
                                    await this.updatePoolROI(pool.poolId, roiString, false, undefined, { tp1Done: true });
                                }
                                this.activeTpSlActions.delete(pool.poolId);
                            }

                            // ── Take Profit Stage 2: +600% (6x) → Close another 40% ──
                            if (roiVal >= 600 && pool.tp1Done && !pool.takeProfitDone) {
                                this.activeTpSlActions.add(pool.poolId);
                                SocketManager.emitLog(`[TP2] ${pool.token} hit 6x (+${roiVal.toFixed(0)}%)! Withdrawing 40%...`, "success");
                                const result = await this.withdrawLiquidity(pool.poolId, 40, "TP2");
                                if (result.success) {
                                    await this.liquidatePoolToSol(pool.mint);
                                    await this.updatePoolROI(pool.poolId, roiString, false, undefined, { takeProfitDone: true });
                                }
                                this.activeTpSlActions.delete(pool.poolId);
                            }

                            // ── Stop Loss: -30% → Close 80% (keep 20% running) ──
                            if (roiVal <= -30 && !pool.stopLossDone) {
                                this.activeTpSlActions.add(pool.poolId);
                                SocketManager.emitLog(`[STOP LOSS] ${pool.token} hit ${roiVal.toFixed(0)}%! Withdrawing 80%...`, "error");
                                const result = await this.withdrawLiquidity(pool.poolId, 80, "STOP LOSS");
                                if (result.success) {
                                    await this.liquidatePoolToSol(pool.mint);
                                    await this.updatePoolROI(pool.poolId, roiString, false, undefined, { stopLossDone: true });
                                }
                                this.activeTpSlActions.delete(pool.poolId);
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
                await this.updatePoolROI(poolId, isFull ? "CLOSED" : "PARTIAL", isFull, undefined, { withdrawalPending: false });

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

}
