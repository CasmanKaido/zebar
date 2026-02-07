import { connection, wallet } from "./config";
import { MarketScanner, ScanResult, ScannerCriteria } from "./scanner";
import { StrategyManager } from "./strategy";
import { PublicKey } from "@solana/web3.js";
import { SocketManager } from "./socket";
import { RugChecker } from "./rugcheck";




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
    }

    async start(config?: Partial<BotSettings>) {
        if (this.isRunning) return;
        if (config) {
            this.settings = { ...this.settings, ...config };
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
                    const poolInfo = await this.strategy.createMeteoraPool(result.mint, LPPP_MINT, tokenAmount, lpppAmountBase);
                    if (poolInfo) {
                        SocketManager.emitLog(`Meteora Pool Created: ${poolInfo.poolId}`, "success");
                    }
                } catch (lpError) {
                    SocketManager.emitLog(`[LP ERROR] Failed to create pool: ${lpError}`, "error");
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
}
