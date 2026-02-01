
import axios from "axios";
import { PublicKey } from "@solana/web3.js";

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
        console.log("[SCANNER] Scanning market for Golden Ratio pairs...");
        const response = await axios.get("https://api.dexscreener.com/latest/dex/search?q=solana");
        const pairs = response.data.pairs;

        if (!pairs) return;

        for (const pair of pairs) {
            if (pair.chainId !== "solana") continue;
            if (this.seenPairs.has(pair.pairAddress)) continue;

            const volume1h = pair.volume?.h1 || 0;
            const liquidity = pair.liquidity?.usd || 0;
            const mcap = pair.fdv || 0; // Fully Diluted Valuation is usually the mcap proxy

            // Check Criteria
            const meetsVolume = volume1h >= this.criteria.minVolume1h;
            const meetsLiquidity = liquidity >= this.criteria.minLiquidity;
            const meetsMcap = mcap >= this.criteria.minMcap;

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
