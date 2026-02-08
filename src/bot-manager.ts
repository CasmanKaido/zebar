import { connection, wallet } from "./config";
import { MarketScanner, ScanResult, ScannerCriteria } from "./scanner";
import { StrategyManager } from "./strategy";
import { PublicKey } from "@solana/web3.js";
import { SocketManager } from "./socket";
import { RugChecker } from "./rugcheck";
import * as fs from "fs/promises";
import * as path from "path";

const POOL_DATA_FILE = path.join(__dirname, "../data/pools.json");

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
}




export interface BotSettings {
    buyAmount: number; // in SOL
    lpppAmount: number; // in units
    slippage: number; // in % (e.g. 10)
    minVolume1h: number;
    minLiquidity: number;
    minMcap: number;
}

export class BotManager {
    public isRunning: boolean = false;
    private scanner: MarketScanner | null = null;
    private strategy: StrategyManager;
    private settings: BotSettings = {
        buyAmount: 0.1,
        lpppAmount: 1000,
        slippage: 10,
        minVolume1h: 100000,
        minLiquidity: 60000,
        minMcap: 60000
    };

    constructor() {
        this.strategy = new StrategyManager(connection, wallet);
        this.loadPools();
        this.monitorPositions(); // Start monitoring loop
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
    private async updatePoolROI(poolId: string, newRoi: string, exited: boolean) {
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

                // Ensure directory exists
                await fs.mkdir(path.dirname(POOL_DATA_FILE), { recursive: true });

                await fs.writeFile(POOL_DATA_FILE, JSON.stringify(history, null, 2));
            }
        } catch (e) {
            console.error("[BOT] Failed to update pool ROI:", e);
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

        // Check Balance
        const balance = await connection.getBalance(wallet.publicKey);
        if (balance === 0) {
            SocketManager.emitLog(`[WARNING] Your wallet (${wallet.publicKey.toBase58().slice(0, 8)}...) has 0 SOL. Buys will fail.`, "error");
        } else {
            SocketManager.emitLog(`[WALLET] Active: ${wallet.publicKey.toBase58().slice(0, 8)}... | Balance: ${(balance / 1e9).toFixed(3)} SOL`, "success");
        }

        this.isRunning = true;
        SocketManager.emitStatus(true);
        SocketManager.emitLog(`ZEBAR Streamer Active (Vol1h > $${this.settings.minVolume1h}, Liq > $${this.settings.minLiquidity}, MCAP > $${this.settings.minMcap})...`, "info");

        const criteria: ScannerCriteria = {
            minVolume1h: this.settings.minVolume1h,
            minLiquidity: this.settings.minLiquidity,
            minMcap: this.settings.minMcap
        };

        this.scanner = new MarketScanner(criteria, async (result: ScanResult) => {
            if (!this.isRunning) return;

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
            const { success, amount, error } = await this.strategy.swapToken(result.mint, this.settings.buyAmount, this.settings.slippage, result.pairAddress, result.dexId);

            if (success) {
                SocketManager.emitLog(`Buy Transaction Sent! check Solscan/Wallet for incoming tokens.`, "success");

                // 2. Create LP (Restored)
                const LPPP_MINT = new PublicKey("44sHXMkPeciUpqhecfCysVs7RcaxeM24VPMauQouBREV");
                const tokenAmount = BigInt(amount.toString());
                const lpppAmountBase = BigInt(Math.floor(this.settings.lpppAmount * 1e6));

                // We try-catch the LP creation to prevent crashing the whole bot if SDK fails
                try {
                    const poolInfo = await this.strategy.createMeteoraPool(result.mint, tokenAmount, lpppAmountBase, LPPP_MINT);
                    if (poolInfo.success) {
                        SocketManager.emitLog(`Meteora Pool Created: ${poolInfo.poolAddress}`, "success");
                        // Emit structured pool event for frontend
                        // Emit structured pool event for frontend
                        const poolEvent = {
                            poolId: poolInfo.poolAddress || "",
                            token: result.symbol,
                            roi: "0%", // Initial ROI
                            created: new Date().toISOString()
                        };

                        // Calculate Initial Price (LPPP per Token)
                        // amount is BigInt. Standard decimals 9 for computation (approx).
                        const tokenAmtFloat = Number(amount) / 1e9;
                        const initialPrice = tokenAmtFloat > 0 ? this.settings.lpppAmount / tokenAmtFloat : 0;

                        const fullPoolData: PoolData = {
                            ...poolEvent,
                            mint: result.mint.toBase58(),
                            initialPrice,
                            initialTokenAmount: tokenAmtFloat,
                            initialLpppAmount: this.settings.lpppAmount,
                            exited: false
                        };

                        SocketManager.emitPool(poolEvent);
                        this.savePools(fullPoolData);

                    } else {
                        SocketManager.emitLog(`[LP ERROR] Pool Failed: ${poolInfo.error}`, "error");
                    }
                } catch (lpError) {
                    SocketManager.emitLog(`[LP ERROR] Failed to invoke SDK: ${lpError}`, "error");
                }

                // 3. Monitor (Optional - Future Implementation)
                // this.strategy.monitorAndExit(...)
            } else {
                // Log detailed error to frontend
                SocketManager.emitLog(`Buy Failed: ${error || "Unknown Error"}`, "error");
            }
        });

        this.scanner.start();
    }

    stop() {
        this.isRunning = false;
        if (this.scanner) {
            this.scanner.stop();
        }
        SocketManager.emitStatus(false);
        SocketManager.emitLog("ZEBAR Scanning Service Stopped.", "warning");
    }

    async getPortfolio() {
        try {
            // 1. SOL Balance
            const solBalance = await connection.getBalance(wallet.publicKey);

            // 2. LPPP Balance
            const LPPP_MINT = new PublicKey("44sHXMkPeciUpqhecfCysVs7RcaxeM24VPMauQouBREV");
            const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: LPPP_MINT });

            let lpppBalance = 0;
            if (tokenAccounts.value.length > 0) {
                // Sum up directly from parsed uiAmount (handles decimals automatically)
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

    // Monitoring Loop (Runs every 30s)
    private async monitorPositions() {
        setInterval(async () => {
            if (!this.isRunning) return; // Only monitor when bot is "ON"? No, monitor always.
            // Actually, monitor should run always if there are positions.
        }, 30000);

        // Let's run it correctly:
        const LPPP_MINT_ADDR = "44sHXMkPeciUpqhecfCysVs7RcaxeM24VPMauQouBREV";

        setInterval(async () => {
            try {
                const data = await fs.readFile(POOL_DATA_FILE, "utf-8");
                const pools: PoolData[] = JSON.parse(data);

                for (const pool of pools) {
                    if (pool.exited) continue; // Skip exited pools

                    // Fetch Status
                    // Assume pool token A is the sniped token, B is LPPP (or vice versa? strategy created it).
                    // Logic in strategy: tokenA, tokenB sorting.
                    // We need to pass both mints.
                    // pool.mint is the sniped token. LPPP is the other.
                    const status = await this.strategy.getPoolStatus(pool.poolId, pool.mint, LPPP_MINT_ADDR);

                    if (status.success && status.price > 0) {
                        // Calculate ROI
                        // Status Price is B/A. If B is LPPP, then Price is LPPP per Token.
                        // Initial Price was LPPP per Token.
                        // ROI = (Current / Initial) * 100

                        // Check if order was flipped in strategy?
                        // Strategy sorts mints.
                        // getPoolStatus returns price as `amountB / amountA`.
                        // If `pool.mint` < `LPPP`, then A=Token, B=LPPP. Price = LPPP/Token. Correct.
                        // If `pool.mint` > `LPPP`, then A=LPPP, B=Token. Price = Token/LPPP.

                        // We need to Normalize price to always be LPPP per Token.
                        let normalizedPrice = status.price;
                        const mintBN = new PublicKey(pool.mint).toBuffer(); // simple compare via string
                        const lpppBN = new PublicKey(LPPP_MINT_ADDR).toBuffer();

                        if (pool.mint > LPPP_MINT_ADDR) {
                            // Token is B. LPPP is A.
                            // Status Price = Token / LPPP.
                            // We want LPPP / Token => 1 / Price.
                            if (status.price !== 0) normalizedPrice = 1 / status.price;
                        }

                        const roiVal = (normalizedPrice - pool.initialPrice) / pool.initialPrice * 100;
                        const roiString = `${roiVal.toFixed(2)}%`;

                        // Update JSON & Frontend
                        if (roiString !== pool.roi) {
                            await this.updatePoolROI(pool.poolId, roiString, false);
                            SocketManager.emitPoolUpdate({ poolId: pool.poolId, roi: roiString });
                        }

                        // Take Profit Logic (8x = 800% ROI)
                        if (roiVal >= 800) {
                            SocketManager.emitLog(`[TAKE PROFIT] ${pool.token} hit 8x! Withdrawing Liquidity...`, "success");
                            // TODO: Call withdrawLiquidity (Not implemented yet)
                            // Mark as exited to stop monitoring
                            await this.updatePoolROI(pool.poolId, roiString, true);
                        }
                    }
                }
            } catch (e) {
                // Ignore file not found or other errors
            }
        }, 30000); // Check every 30 seconds
    }
}
