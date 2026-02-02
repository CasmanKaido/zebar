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

            let foundInThisSweep = 0;

            for (const pair of pairs) {
                if (pair.chainId !== "solana") continue;
                if (this.seenPairs.has(pair.pairAddress)) continue;

                // WRAPPED SOL or STABLES we might want to ignore as targets
                const IGNORED_MINTS = [
                    SOL_MINT,
                    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
                    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
                    "USDH1SM1ojwRrt3WoCkmq7i9DE2yMK77CXY7MvJ8TCe",   // USDH
                    "2b1fDQRsjtB2NYyQCneVr3TXuqcSFCvA13fnc7uxc8vi", // PYUSD
                    "7kbnYjS6zY7ndS9S2MvSdgS9z9S2MvSdgS9z9S2MvSdg", // UXD
                    "mSoLzYawRXYr3WvR86An1Ah6B1isS2nEv4tXQ7pA9Ym",   // mSOL
                    "7dHbS7zSToynF6L8abS2yz7iYit2tiX1XW1tH8YqXgH",   // stSOL
                    "J1tosoecvw9U96jrN17H8NfE59p5RST213R9RNoeWCH",   // jitoSOL
                ];

                // Determine which token is our "Target" (the one that isn't SOL or a Stable)
                let targetToken = pair.baseToken;
                let priceUSD = Number(pair.priceUsd || 0);

                if (IGNORED_MINTS.includes(targetToken.address)) {
                    targetToken = pair.quoteToken;
                }

                // If both are ignored (e.g. SOL/USDC), then skip this pair entirely
                if (IGNORED_MINTS.includes(targetToken.address)) continue;

                // Skip tokens that look like stables (price very close to $1.00)
                // This helps avoid things like USDH or other pegged tokens the list missed.
                if (priceUSD > 0.98 && priceUSD < 1.02) continue;

                const volume24h = pair.volume?.h24 || 0;
                const liquidity = pair.liquidity?.usd || 0;
                const mcap = pair.marketCap || pair.fdv || 0;

                // Log the first few tokens we see for debugging
                if (foundInThisSweep < 3) {
                    console.log(`[ANALYSIS] Candidate: ${targetToken.symbol} | Vol: $${Math.floor(volume24h)} | Liq: $${Math.floor(liquidity)} | MCAP: $${Math.floor(mcap)}`);
                    foundInThisSweep++;
                }

                // Check Criteria
                const meetsVolume = Number(volume24h) >= Number(this.criteria.minVolume24h);
                const meetsLiquidity = Number(liquidity) >= Number(this.criteria.minLiquidity);
                const meetsMcap = Number(mcap) >= Number(this.criteria.minMcap);

                // FOR TESTING: If filters are all 100, we force pick the FIRST valid non-ignored token
                const isTesting = this.criteria.minVolume24h <= 100 && this.criteria.minMcap <= 100;

                if (meetsVolume && meetsLiquidity && meetsMcap || isTesting) {
                    const matchMsg = isTesting
                        ? `[TARGET FOUND] Test Match: ${targetToken.symbol} (Criteria Bypassed)`
                        : `[TARGET FOUND] ${targetToken.symbol} passed all metrics!`;

                    console.log(matchMsg);
                    SocketManager.emitLog(matchMsg, "success");

                    this.seenPairs.add(pair.pairAddress);

                    const result: ScanResult = {
                        mint: new PublicKey(targetToken.address),
                        pairAddress: pair.pairAddress,
                        volume24h: Number(volume24h),
                        liquidity: Number(liquidity),
                        mcap: Number(mcap),
                        symbol: targetToken.symbol
                    };

                    await this.callback(result);
                }
            }

            const summaryMsg = `[SCAN COMPLETE] Evaluated ${pairs.length} tokens. Next scan in 30s.`;
            console.log(summaryMsg);
            SocketManager.emitLog(summaryMsg, "info");
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
