import { connection, wallet } from "./config";
import { MarketScanner, ScanResult, ScannerCriteria } from "./scanner";
import { StrategyManager } from "./strategy";
import { PublicKey } from "@solana/web3.js";
import { SocketManager } from "./socket";
import { RugChecker } from "./rugcheck";
import * as fs from "fs/promises";
import * as path from "path";
import { GeckoService } from "./gecko-service";
import axios from "axios";

const POOL_DATA_FILE = path.join(process.cwd(), "data/pools.json");

interface PoolData {
    poolId: string;
    token: string; // Symbol
    mint: string; // Token Mint Address
    roi: string;
    created: string;
    initialPrice: number;
    initialTokenAmount: number;
    initialLpppAmount: number;
    exited: boolean;
    takeProfitDone?: boolean; // Flag for the 8x TP strategy
    positionId?: string; // Meteora Position PDA
    unclaimedFees?: { sol: string; token: string };
}

export interface BotSettings {
    buyAmount: number; // in SOL
    lpppAmount: number; // in units
    meteoraFeeBps: number; // in Basis Points (e.g. 200 = 2%)
    autoSyncPrice: boolean; // Sync pairing amount with market price
    manualPrice: number; // Manual price context (Tokens per LPPP)
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
    private settings: BotSettings = {
        buyAmount: 0.1,
        lpppAmount: 1000,
        meteoraFeeBps: 200, // Default 2%
        autoSyncPrice: true, // Default ON
        manualPrice: 0, // Default 0 (disabled)
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
        this.loadPools();
    }

    private async loadPools() {
        try {
            const data = await fs.readFile(POOL_DATA_FILE, "utf-8");
            const history = JSON.parse(data);
            history.forEach((p: PoolData) => SocketManager.emitPool(p)); // Load into Socket History
            console.log(`[BOT] Loaded ${history.length} pools from history.`);
        } catch (e) {
            console.log("[BOT] No existing pool history found.");
        }
    }

    private async savePools(newPool: PoolData) {
        try {
            let history: PoolData[] = [];
            try {
                const data = await fs.readFile(POOL_DATA_FILE, "utf-8");
                history = JSON.parse(data);
            } catch (e) {
                // File likely doesn't exist, which is fine.
            }

            history.push(newPool);

            // Ensure directory exists
            await fs.mkdir(path.dirname(POOL_DATA_FILE), { recursive: true });

            await fs.writeFile(POOL_DATA_FILE, JSON.stringify(history, null, 2));
        } catch (e) {
            console.error("[BOT] Failed to save pool history:", e);
        }
    }

    // Update ROI in JSON file without appending
    private async updatePoolROI(poolId: string, newRoi: string, exited: boolean, takeProfitDone?: boolean) {
        try {
            let history: PoolData[] = [];
            try {
                const data = await fs.readFile(POOL_DATA_FILE, "utf-8");
                history = JSON.parse(data);
            } catch (e) {
                // Should not update if no history exists, but handle gracefully
                return;
            }

            const index = history.findIndex(p => p.poolId === poolId);

            if (index !== -1) {
                history[index].roi = newRoi;
                history[index].exited = exited;
                if (takeProfitDone !== undefined) {
                    history[index].takeProfitDone = takeProfitDone;
                }

                // Emit update to frontend so it can remove/archive the pool
                SocketManager.emitPoolUpdate({
                    poolId: poolId,
                    roi: newRoi,
                    exited: exited
                });

                // Ensure directory exists
                await fs.mkdir(path.dirname(POOL_DATA_FILE), { recursive: true });

                await fs.writeFile(POOL_DATA_FILE, JSON.stringify(history, null, 2));
            }
        } catch (e) {
            console.error("[BOT] Failed to update pool ROI:", e);
        }
    }

    private async getLpppPrice(): Promise<number> {
        try {
            const res = await fetch("https://api.dexscreener.com/latest/dex/tokens/44sHXMkPeciUpqhecfCysVs7RcaxeM24VPMauQouBREV");
            const data: any = await res.json();
            const price = parseFloat(data?.pairs?.[0]?.priceUsd || "0");
            // Reject suspiciously low prices (likely garbage data)
            if (price > 0 && price < 0.000001) {
                console.warn(`[BOT] LPPP price suspiciously low ($${price}). Treating as invalid.`);
                return 0;
            }
            return price;
        } catch (e) {
            console.warn("[BOT] Failed to fetch LPPP price:", e);
            return 0;
        }
    }

    async start(config?: Partial<BotSettings>) {
        if (this.isRunning) return;
        if (config) {
            this.settings = { ...this.settings, ...config };

            // Validation: Log Warning if 0 Buy Amount, but do not override
            if (this.settings.buyAmount <= 0) {
                SocketManager.emitLog(`[CONFIG WARNING] Buy Amount received was ${this.settings.buyAmount} SOL.`, "warning");
            }
        }

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

            // 0. Safety Check (RugCheck)
            try {
                const safety = await RugChecker.checkToken(result.mint.toBase58());
                if (!safety.safe && safety.reason !== "New Token (No Report)") {
                    SocketManager.emitLog(`[RUGCHECK] Skipped: ${safety.reason}`, "error");
                    return;
                }
                if (safety.score > 0) {
                    SocketManager.emitLog(`[RUGCHECK] Passed Risk Score: ${safety.score}`, "success");
                }
            } catch (rcError) {
                console.warn("[RUGCHECK] Error:", rcError);
            }

            // 1. Swap (Buy)
            SocketManager.emitLog(`Executing Market Buy (${this.settings.buyAmount} SOL, Slippage: ${this.settings.slippage}%)...`, "warning");
            try {
                const { success, amount, uiAmount, error } = await this.strategy.swapToken(result.mint, this.settings.buyAmount, this.settings.slippage, result.pairAddress, result.dexId);

                if (success) {
                    SocketManager.emitLog(`Buy Transaction Sent! check Solscan/Wallet for incoming tokens.`, "success");

                    // 2. Refresh Balance & Create LP (Dynamic Fee & Price)
                    const LPPP_MINT = new PublicKey("44sHXMkPeciUpqhecfCysVs7RcaxeM24VPMauQouBREV");

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

                    // Dynamic Price Calculation
                    if (this.settings.autoSyncPrice && result.priceUsd > 0) {
                        const lpppPrice = await this.getLpppPrice();
                        if (lpppPrice > 0) {
                            const tokenPriceLppp = result.priceUsd / lpppPrice;
                            targetLpppAmount = (tokenUiAmountChecked * tokenPriceLppp);
                            SocketManager.emitLog(`[AUTO-PRICE] Token: $${result.priceUsd} | LPPP: $${lpppPrice.toFixed(6)} | Target LPPP: ${targetLpppAmount.toFixed(2)}`, "info");
                        } else {
                            SocketManager.emitLog(`[AUTO-PRICE] LPPP price unavailable. Using manual fallback: ${this.settings.lpppAmount} LPPP.`, "warning");
                        }
                    } else if (!this.settings.autoSyncPrice && this.settings.manualPrice > 0) {
                        targetLpppAmount = (tokenUiAmountChecked * this.settings.manualPrice);
                        SocketManager.emitLog(`[MANUAL-PRICE] Context: ${this.settings.manualPrice} LPPP/Token | Target LPPP: ${targetLpppAmount.toFixed(2)}`, "info");
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
                            this.savePools(fullPoolData);

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
        });

        this.scanner.start();
    }

    /**
     * High-priority evaluation for tokens discovered via real-time webhooks or manual triggers.
     */
    async evaluateDiscovery(mint: string, source: string = "Manual") {
        try {
            const mintPubkey = new PublicKey(mint);

            // 1. Fetch Basic Metadata (Jupiter or DexScreener)
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
        // Stop the position monitor to prevent ghost intervals
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
        this.pendingMints.clear();
        SocketManager.emitStatus(false);
        SocketManager.emitLog("LPPP BOT Scanning Service Stopped.", "warning");
    }

    async getWalletBalance() {
        try {
            const solBalance = await connection.getBalance(wallet.publicKey);
            const LPPP_MINT = new PublicKey("44sHXMkPeciUpqhecfCysVs7RcaxeM24VPMauQouBREV");
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
        const LPPP_MINT_ADDR = "44sHXMkPeciUpqhecfCysVs7RcaxeM24VPMauQouBREV";

        this.monitorInterval = setInterval(async () => {
            try {
                const data = await fs.readFile(POOL_DATA_FILE, "utf-8");
                const pools: PoolData[] = JSON.parse(data);

                for (const pool of pools) {
                    if (pool.exited) continue;

                    const status = await this.strategy.getPoolStatus(pool.poolId, pool.mint, LPPP_MINT_ADDR);
                    const fees = await this.strategy.getMeteoraFees(pool.poolId);

                    const [mintA, mintB] = new PublicKey(pool.mint).toBuffer().compare(new PublicKey(LPPP_MINT_ADDR).toBuffer()) < 0
                        ? [pool.mint, LPPP_MINT_ADDR]
                        : [LPPP_MINT_ADDR, pool.mint];

                    const feeTokenRaw = pool.mint === mintA ? fees.feeA : fees.feeB;
                    const feeLpppRaw = LPPP_MINT_ADDR === mintA ? fees.feeA : fees.feeB;

                    const adjustedLpppFee = (feeLpppRaw * 1000n).toString();
                    const adjustedTokenFee = (feeTokenRaw * 1000n).toString();

                    pool.unclaimedFees = { sol: adjustedLpppFee, token: adjustedTokenFee };
                    SocketManager.emitPoolUpdate({ poolId: pool.poolId, unclaimedFees: pool.unclaimedFees });

                    if (status.success && status.price > 0) {
                        // Normalize price direction: initialPrice is always LPPP/Token.
                        // If LPPP is mintA, pool price = reserveA/reserveB = LPPP/Token (correct).
                        // If LPPP is mintB, pool price = reserveA/reserveB = Token/LPPP (need to invert).
                        const lpppIsMintA = LPPP_MINT_ADDR === mintA;
                        const normalizedPrice = lpppIsMintA ? status.price : (1 / status.price);
                        const roiVal = (normalizedPrice - pool.initialPrice) / pool.initialPrice * 100;
                        const roiString = `${roiVal.toFixed(2)}%`;

                        // Sanity check: extreme negative ROI on first check likely means price inversion issue
                        if (roiVal < -50 && pool.roi === "0%") {
                            SocketManager.emitLog(`[MONITOR WARN] ${pool.token} ROI is ${roiString} on first check — possible price inversion. Skipping action.`, "warning");
                            continue;
                        }
                        if (roiString !== pool.roi) {
                            await this.updatePoolROI(pool.poolId, roiString, false);
                            SocketManager.emitPoolUpdate({ poolId: pool.poolId, roi: roiString });
                        }

                        if (roiVal >= 700 && !pool.takeProfitDone) {
                            SocketManager.emitLog(`[TAKE PROFIT] ${pool.token} hit 8x! Withdrawing 80%...`, "success");
                            const result = await this.withdrawLiquidity(pool.poolId, 80, "TAKE PROFIT");
                            if (result.success) {
                                await this.liquidatePoolToSol(pool.mint);
                                pool.takeProfitDone = true;
                                await this.updatePoolROI(pool.poolId, roiString, false, true);
                            }
                        }

                        if (roiVal <= -20) {
                            SocketManager.emitLog(`[STOP LOSS] ${pool.token} hit -20%! Full Close...`, "error");
                            const result = await this.withdrawLiquidity(pool.poolId, 100, "STOP LOSS");
                            if (result.success) {
                                await this.liquidatePoolToSol(pool.mint);
                            }
                            await this.updatePoolROI(pool.poolId, roiString, true);
                        }
                    }
                }
            } catch (e) {
                // Ignore
            }
        }, 30000);
    }

    async withdrawLiquidity(poolId: string, percent: number = 80, source: string = "MANUAL") {
        SocketManager.emitLog(`[${source}] Withdrawing ${percent}% liquidity from ${poolId.slice(0, 8)}...`, "warning");
        // Look up stored positionId for this pool
        let positionId: string | undefined;
        try {
            const pools: PoolData[] = await this.getPortfolio();
            const pool = pools.find(p => p.poolId === poolId);
            positionId = pool?.positionId;
        } catch (e) { /* proceed without positionId */ }
        const result = await this.strategy.removeMeteoraLiquidity(poolId, percent, positionId);
        if (result.success) {
            SocketManager.emitLog(`[SUCCESS] Withdrew ${percent}% liquidity.`, "success");
            if (percent >= 100) {
                await this.updatePoolROI(poolId, "CLOSED", true);
            }
        } else {
            SocketManager.emitLog(`[ERROR] Withdrawal failed: ${result.error}`, "error");
        }
        return result;
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

    async getPortfolio() {
        try {
            const data = await fs.readFile(POOL_DATA_FILE, "utf-8");
            return JSON.parse(data);
        } catch (e) {
            return [];
        }
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
