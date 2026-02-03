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
    private seenPairs: Map<string, number> = new Map(); // pairAddress -> timestamp
    private SEEN_COOLDOWN = 60 * 60 * 1000; // 1 hour cooldown
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
        let sweepCount = 0;
        while (this.isRunning) {
            try {
                sweepCount++;
                // Log a heartbeat every 20 sweeps (~10 minutes)
                if (sweepCount % 20 === 0) {
                    SocketManager.emitLog("[HEARTBEAT] ZEBAR is actively scanning the market. All systems operational.", "success");
                }
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
            // Using multiple discovery points to expand the search beyond just the top 30 SOL pairs
            const DISCOVERY_MINTS = [
                "So11111111111111111111111111111111111111112", // SOL
                "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
                "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
            ];

            let allPairs: any[] = [];

            // 1. Get tokens from base mints
            for (const mint of DISCOVERY_MINTS) {
                try {
                    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 5000 });
                    if (res.data.pairs) allPairs = [...allPairs, ...res.data.pairs];
                } catch (e) { }
            }

            // 2. Get tokens from broad search
            try {
                const searchRes = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=solana`, { timeout: 5000 });
                if (searchRes.data.pairs) allPairs = [...allPairs, ...searchRes.data.pairs];
            } catch (e) { }

            // Deduplicate pairs by address
            const uniquePairsMap = new Map();
            allPairs.forEach(p => {
                if (p.chainId === "solana" && !uniquePairsMap.has(p.pairAddress)) {
                    uniquePairsMap.set(p.pairAddress, p);
                }
            });

            const pairs = Array.from(uniquePairsMap.values());

            if (pairs.length === 0) {
                SocketManager.emitLog("[SWEEPER] No active pairs found on the radar right now.", "warning");
                return;
            }

            console.log(`[SWEEPER] Evaluating ${pairs.length} unique records...`);
            SocketManager.emitLog(`[SWEEPER] Evaluating ${pairs.length} unique records...`, "info");

            let candidatesFound = 0;

            for (const pair of pairs) {
                // Check seenPairs with cooldown
                const lastSeen = this.seenPairs.get(pair.pairAddress);
                if (lastSeen && Date.now() - lastSeen < this.SEEN_COOLDOWN) continue;

                // WRAPPED SOL or STABLES we might want to ignore as targets
                const SOL_MINT = "So11111111111111111111111111111111111111112";
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
                    "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // RAY (often high liq but maybe not target)
                ];

                // Determine which token is our "Target"
                let targetToken = pair.baseToken;
                let priceUSD = Number(pair.priceUsd || 0);

                if (IGNORED_MINTS.includes(targetToken.address)) {
                    targetToken = pair.quoteToken;
                }

                if (IGNORED_MINTS.includes(targetToken.address)) continue;
                if (priceUSD > 0.98 && priceUSD < 1.02) continue;

                const volume1h = pair.volume?.h1 || 0;
                const liquidity = pair.liquidity?.usd || 0;
                const mcap = pair.marketCap || pair.fdv || 0;

                // Check Criteria
                const meetsVolume = Number(volume1h) >= Number(this.criteria.minVolume24h); // Note: keeping criteria name for compatibility
                const meetsLiquidity = Number(liquidity) >= Number(this.criteria.minLiquidity);
                const meetsMcap = Number(mcap) >= Number(this.criteria.minMcap);

                // FOR TESTING: If filters are low, we force pick
                const isTesting = this.criteria.minVolume24h <= 100 && this.criteria.minMcap <= 100;

                if (meetsVolume && meetsLiquidity && meetsMcap || isTesting) {
                    const matchMsg = isTesting
                        ? `[TARGET FOUND] Test Match: ${targetToken.symbol} (Criteria Bypassed)`
                        : `[TARGET FOUND] ${targetToken.symbol} passed all metrics!`;

                    console.log(matchMsg);
                    SocketManager.emitLog(matchMsg, "success");

                    // We mark it with a timestamp for cooldown
                    this.seenPairs.set(pair.pairAddress, Date.now());

                    const result: ScanResult = {
                        mint: new PublicKey(targetToken.address),
                        pairAddress: pair.pairAddress,
                        volume24h: Number(volume1h), // We use 1h vol but map to this field for now
                        liquidity: Number(liquidity),
                        mcap: Number(mcap),
                        symbol: targetToken.symbol
                    };

                    await this.callback(result);
                    candidatesFound++;
                }
            }

            const summaryMsg = `[SCAN COMPLETE] Found ${candidatesFound} candidates. Next scan in 30s.`;
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

