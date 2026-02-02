
import axios from "axios";
import { PublicKey } from "@solana/web3.js";
import { SocketManager } from "./socket";

export interface ScanResult {
    mint: PublicKey;
    pairAddress: string;
    volume1h: number;
    liquidity: number;
    mcap: number;
    symbol: string;
}

export interface ScannerCriteria {
    minVolume1h: number;
    minLiquidity: number;
    minMcap: number;
}

export class MarketScanner {
    private isRunning: boolean = false;
    private criteria: ScannerCriteria;
    private callback: (result: ScanResult) => Promise<void>;
    private seenPairs: Set<string> = new Set();

    constructor(criteria: ScannerCriteria, callback: (result: ScanResult) => Promise<void>) {
        this.criteria = criteria;
        this.callback = callback;
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log("ZEBAR Market Scanner started...");
        this.scanLoop();
    }

    private async scanLoop() {
        while (this.isRunning) {
            try {
                await this.performScan();
            } catch (error) {
                console.error("Scan error:", error);
            }
            // Poll every 30 seconds to avoid spamming API but stay fresh
            await new Promise(r => setTimeout(r, 30000));
        }
    }

    private async performScan() {
        const statusMsg = "[SCANNER] Hunting for new Solana opportunities...";
        console.log(statusMsg);
        SocketManager.emitLog(statusMsg, "info");

        try {
            // Using the latest pairs endpoint for the SOL native token to find all related pairs
            const SOL_MINT = "So11111111111111111111111111111111111111112";
            const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`, {
                timeout: 10000
            });

            const pairs = response.data.pairs;

            if (!pairs || pairs.length === 0) {
                const noPairsMsg = "[SCANNER] No active pairs found on DexScreener right now.";
                console.log(noPairsMsg);
                SocketManager.emitLog(noPairsMsg, "warning");
                return;
            }

            console.log(`[SCANNER] Evaluating ${pairs.length} potential targets...`);
            SocketManager.emitLog(`[SCANNER] Evaluating ${pairs.length} potential targets...`, "info");

            let debugCount = 0;

            for (const pair of pairs) {
                if (pair.chainId !== "solana") continue;
                if (this.seenPairs.has(pair.pairAddress)) continue;
                if (pair.baseToken.address === SOL_MINT) continue;

                const volume1h = pair.volume?.m5 || pair.volume?.h1 || 0;
                const liquidity = pair.liquidity?.usd || 0;
                const mcap = pair.marketCap || pair.fdv || 0;

                // Debug log for the first pair found to verify data flow
                if (debugCount < 1) {
                    const debugMsg = `[DEBUG] Example: ${pair.baseToken.symbol} | Vol: $${Math.floor(volume1h)} | Liq: $${Math.floor(liquidity)} | MCAP: $${Math.floor(mcap)}`;
                    console.log(debugMsg);
                    SocketManager.emitLog(debugMsg, "info");
                    debugCount++;
                }

                // Check Criteria
                const meetsVolume = Number(volume1h) >= Number(this.criteria.minVolume1h);
                const meetsLiquidity = Number(liquidity) >= Number(this.criteria.minLiquidity);
                const meetsMcap = Number(mcap) >= Number(this.criteria.minMcap);

                if (meetsVolume && meetsLiquidity && meetsMcap) {
                    const matchMsg = `[MATCH] ${pair.baseToken.symbol} met all criteria!`;
                    console.log(matchMsg);
                    SocketManager.emitLog(matchMsg, "success");

                    this.seenPairs.add(pair.pairAddress);

                    const result: ScanResult = {
                        mint: new PublicKey(pair.baseToken.address),
                        pairAddress: pair.pairAddress,
                        volume1h: Number(volume1h),
                        liquidity: Number(liquidity),
                        mcap: Number(mcap),
                        symbol: pair.baseToken.symbol
                    };

                    await this.callback(result);
                }
            }
        } catch (err: any) {
            const errMsg = `[ERROR] Scan Request Failed: ${err.message}`;
            console.error(errMsg);
            SocketManager.emitLog(errMsg, "error");
        }
    }

    stop() {
        this.isRunning = false;
    }
}
