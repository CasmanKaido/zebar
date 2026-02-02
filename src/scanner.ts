
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
        SocketManager.emitLog("[SCANNER] Hunting for new Solana opportunities...", "info");
        const SOL_MINT = "So11111111111111111111111111111111111111112";
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${SOL_MINT}`);
        const pairs = response.data.pairs;

        if (!pairs) {
            SocketManager.emitLog("[SCANNER] No active pairs found in this cycle.", "warning");
            return;
        }

        SocketManager.emitLog(`[SCANNER] Evaluating ${pairs.length} potential targets...`, "info");

        let debugCount = 0;
        for (const pair of pairs) {
            if (pair.chainId !== "solana") continue;
            if (this.seenPairs.has(pair.pairAddress)) continue;

            // CRITICAL: Skip if the target token is actually just Native SOL
            if (pair.baseToken.address === SOL_MINT) continue;

            const volume1h = pair.volume?.m5 || pair.volume?.h1 || 0; // Fallback to 5m if 1h is missing
            const liquidity = pair.liquidity?.usd || 0;
            const mcap = pair.marketCap || pair.fdv || 0; // Try marketCap first, then FDV

            // Detailed debug for first 3 pairs each cycle
            if (debugCount < 1) {
                SocketManager.emitLog(`[DEBUG] Example Target ${pair.baseToken.symbol}: Vol=$${Math.floor(volume1h)}, Liq=$${Math.floor(liquidity)}, MCAP=$${Math.floor(mcap)}`, "info");
                debugCount++;
            }

            // Check Criteria
            const meetsVolume = Number(volume1h) >= Number(this.criteria.minVolume1h);
            const meetsLiquidity = Number(liquidity) >= Number(this.criteria.minLiquidity);
            const meetsMcap = Number(mcap) >= Number(this.criteria.minMcap);

            if (meetsVolume && meetsLiquidity && meetsMcap) {
                console.log(`[SCANNER] MATCH FOUND: ${pair.baseToken.symbol} (${pair.baseToken.address})`);
                console.log(`Vol: $${volume1h}, Liq: $${liquidity}, Mcap: $${mcap}`);

                this.seenPairs.add(pair.pairAddress);

                const result: ScanResult = {
                    mint: new PublicKey(pair.baseToken.address),
                    pairAddress: pair.pairAddress,
                    volume1h,
                    liquidity,
                    mcap,
                    symbol: pair.baseToken.symbol
                };

                await this.callback(result);
            }
        }
    }

    stop() {
        this.isRunning = false;
    }
}
