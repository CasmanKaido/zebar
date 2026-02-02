import axios from "axios";
import { PublicKey } from "@solana/web3.js";
import { SocketManager } from "./socket";

export interface ScanResult {
    mint: PublicKey;
    pairAddress: string;
    volume24h: number;
    liquidity: number;
    mcap: number;
    symbol: string;
}

export interface ScannerCriteria {
    minVolume24h: number;
    minLiquidity: number;
    minMcap: number;
}

export class MarketScanner {
    private isRunning: boolean = false;
    private criteria: ScannerCriteria;
    private callback: (result: ScanResult) => Promise<void>;
    private seenPairs: Set<string> = new Set();
    private scanInterval: NodeJS.Timeout | null = null;

    constructor(criteria: ScannerCriteria, callback: (result: ScanResult) => Promise<void>) {
        this.criteria = criteria;
        this.callback = callback;
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;

        const startMsg = "ZEBAR Sweeper Active: Scanning the Solana Market for top-performing tokens...";
        console.log(startMsg);
        SocketManager.emitLog(startMsg, "success");

        // Start the sweeping loop
        this.runSweeper();
    }

    private async runSweeper() {
        while (this.isRunning) {
            try {
                await this.performMarketSweep();
            } catch (error: any) {
                console.error(`[SWEEPER ERROR] ${error.message}`);
            }
            // Wait 30 seconds between sweeps to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 30000));
        }
    }

    private async performMarketSweep() {
        SocketManager.emitLog("[SWEEPER] Sweeping market for active opportunities...", "info");

        try {
            // Using a broad search for Solana tokens to catch all active pairs
            const SOL_MINT = "So11111111111111111111111111111111111111112";
            const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`, {
                timeout: 10000
            });

            const pairs = response.data.pairs;

            if (!pairs || pairs.length === 0) {
                SocketManager.emitLog("[SWEEPER] No active pairs found on the radar right now.", "warning");
                return;
            }

            console.log(`[SWEEPER] Evaluating ${pairs.length} active tokens...`);
            SocketManager.emitLog(`[SWEEPER] Evaluating ${pairs.length} active tokens...`, "info");

            let debugCount = 0;

            for (const pair of pairs) {
                if (pair.chainId !== "solana") continue;
                if (this.seenPairs.has(pair.pairAddress)) continue;
                if (pair.baseToken.address === SOL_MINT) continue;

                const volume24h = pair.volume?.h24 || 0;
                const liquidity = pair.liquidity?.usd || 0;
                const mcap = pair.marketCap || pair.fdv || 0;

                // Debug log for the first pair found each sweep to keep users informed
                if (debugCount < 1) {
                    const debugMsg = `[ANALYSIS] Top Token ${pair.baseToken.symbol}: 24h Vol: $${Math.floor(volume24h)} | Liq: $${Math.floor(liquidity)} | MCAP: $${Math.floor(mcap)}`;
                    console.log(debugMsg);
                    SocketManager.emitLog(debugMsg, "info");
                    debugCount++;
                }

                // Check Criteria
                const meetsVolume = Number(volume24h) >= Number(this.criteria.minVolume24h);
                const meetsLiquidity = Number(liquidity) >= Number(this.criteria.minLiquidity);
                const meetsMcap = Number(mcap) >= Number(this.criteria.minMcap);

                // FOR TESTING: If criteria are set to 100 or lower, force a match to show it works
                const isTesting = this.criteria.minVolume24h <= 100 && this.criteria.minMcap <= 100;

                if (meetsVolume && meetsLiquidity && meetsMcap || isTesting) {
                    const matchMsg = isTesting
                        ? `[TARGET FOUND] Force-loading ${pair.baseToken.symbol} for deployment testing!`
                        : `[TARGET FOUND] ${pair.baseToken.symbol} performance exceeds your criteria!`;

                    console.log(matchMsg);
                    SocketManager.emitLog(matchMsg, "success");

                    this.seenPairs.add(pair.pairAddress);

                    const result: ScanResult = {
                        mint: new PublicKey(pair.baseToken.address),
                        pairAddress: pair.pairAddress,
                        volume24h: Number(volume24h),
                        liquidity: Number(liquidity),
                        mcap: Number(mcap),
                        symbol: pair.baseToken.symbol
                    };

                    await this.callback(result);
                }
            }
        } catch (err: any) {
            const errMsg = `[SWEEPER API ERROR] ${err.message}`;
            console.error(errMsg);
            SocketManager.emitLog(errMsg, "error");
        }
    }

    stop() {
        this.isRunning = false;
        console.log("ZEBAR Sweeper Service Stopped.");
    }
}
