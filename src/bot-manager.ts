
import { connection, wallet } from "./config";
import { MarketScanner, ScanResult, ScannerCriteria } from "./scanner";
import { StrategyManager } from "./strategy";
import { PublicKey } from "@solana/web3.js";
import { SocketManager } from "./socket";


export interface BotSettings {
    buyAmount: number; // in SOL
    lpppAmount: number; // in units
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
        SocketManager.emitLog(`ZEBAR Streamer Active (Vol > $${this.settings.minVolume1h}, Liq > $${this.settings.minLiquidity}, MCAP > $${this.settings.minMcap})...`, "info");

        const criteria: ScannerCriteria = {
            minVolume1h: this.settings.minVolume1h,
            minLiquidity: this.settings.minLiquidity,
            minMcap: this.settings.minMcap
        };

        this.scanner = new MarketScanner(criteria, async (result: ScanResult) => {
            if (!this.isRunning) return;

            SocketManager.emitLog(`[TARGET ACQUIRED] ${result.symbol} met all criteria!`, "success");
            SocketManager.emitLog(`Mint: ${result.mint.toBase58()}`, "warning");
            SocketManager.emitLog(`- Vol: $${Math.floor(result.volume1h)} | Liq: $${Math.floor(result.liquidity)} | MCAP: $${Math.floor(result.mcap)}`, "info");

            // 1. Swap (Buy)
            SocketManager.emitLog(`Executing Market Buy (${this.settings.buyAmount} SOL)...`, "warning");
            const { success, amount } = await this.strategy.swapToken(result.mint, this.settings.buyAmount);

            if (success) {
                SocketManager.emitLog(`Buy Successful! Swapped for ${amount.toString()} units.`, "success");

                // 2. Create LP
                const LPPP_MINT = new PublicKey("44sHXMkPeciUpqhecfCysVs7RcaxeM24VPMauQouBREV");
                const tokenAmount = BigInt(amount.toString());
                const lpppAmountBase = BigInt(Math.floor(this.settings.lpppAmount * 1e6));

                const poolInfo = await this.strategy.createMeteoraPool(result.mint, LPPP_MINT, tokenAmount, lpppAmountBase);

                if (poolInfo) {
                    SocketManager.emitLog(`Meteora Pool Created: ${poolInfo.poolId}`, "success");
                    SocketManager.emitPool({
                        poolId: poolInfo.poolId,
                        token: result.symbol,
                        created: new Date().toISOString(),
                        roi: "1.0x"
                    });

                    this.strategy.monitorAndExit(poolInfo.poolId, 1);
                }
            } else {
                SocketManager.emitLog(`Buy Failed or Token Error. Skipping...`, "error");
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
}
