import axios from "axios";
import { PublicKey } from "@solana/web3.js";
import { SocketManager } from "./socket";
import { BirdeyeService } from "./birdeye-service";
import { connection, IGNORED_MINTS, SOL_MINT, USDC_MINT } from "./config";

export interface ScanResult {
    mint: PublicKey;
    pairAddress: string;
    dexId: string;
    volume24h: number;
    liquidity: number;
    mcap: number;
    symbol: string;
    priceUsd: number;
    source?: string;
}

export interface NumericRange {
    min: number;
    max: number; // 0 means no upper limit
}

export type ScannerMode = "SCOUT" | "ANALYST" | "DUAL";

export interface ScannerCriteria {
    volume5m: NumericRange;
    volume1h: NumericRange;
    volume24h: NumericRange;
    liquidity: NumericRange;
    mcap: NumericRange;
    mode?: ScannerMode;
}

export class MarketScanner {
    private connection: any;
    private isRunning: boolean = false;
    private criteria: ScannerCriteria;
    private callback: (result: ScanResult) => Promise<void>;
    private seenPairs: Map<string, number> = new Map(); // pairAddress -> timestamp
    private SEEN_COOLDOWN = 5 * 60 * 1000; // 5 minute cooldown
    private scanInterval: NodeJS.Timeout | null = null;
    private jupiterTokens: Map<string, any> = new Map(); // mint -> metadata
    private lastJupiterSync = 0;
    private JUPITER_SYNC_INTERVAL = 60 * 60 * 1000; // 1 hour
    private jupiterSyncFailed = false;
    private jupiterFailCooldown = 0; // timestamp when we can retry after failure

    constructor(criteria: ScannerCriteria, callback: (result: ScanResult) => Promise<void>, conn: any) {
        this.criteria = criteria;
        this.callback = callback;
        this.connection = conn;
    }

    setConnection(conn: any) {
        this.connection = conn;
        console.log(`[SCANNER] Connection Updated for Failover.`);
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;

        const startMsg = "LPPP BOT Sweeper Active: Scanning the Solana Market for top-performing tokens...";
        console.log(startMsg);
        SocketManager.emitLog(startMsg, "success");

        await this.syncJupiterTokens();
        this.runSweeper();
    }

    private async syncJupiterTokens() {
        if (Date.now() - this.lastJupiterSync < this.JUPITER_SYNC_INTERVAL) return;
        if (this.jupiterSyncFailed && Date.now() < this.jupiterFailCooldown) return;

        let attempts = 0;
        const maxAttempts = 4;

        while (attempts < maxAttempts) {
            try {
                const endpoints = [
                    "https://token.jup.ag/all",
                    "https://tokens.jup.ag/all",
                    "https://cache.jup.ag/tokens"
                ];

                let res: any;
                for (const url of endpoints) {
                    try {
                        res = await axios.get(url, { timeout: 15000 });
                        if (res.data && Array.isArray(res.data)) break;
                    } catch (urlErr) { }
                }

                if (res && Array.isArray(res.data)) {
                    this.jupiterTokens.clear();
                    res.data.forEach((t: any) => {
                        this.jupiterTokens.set(t.address, t);
                    });
                    this.lastJupiterSync = Date.now();
                    this.jupiterSyncFailed = false;
                    SocketManager.emitLog(`[JUPITER] Synced ${res.data.length} tokens for validation.`, "success");
                    return;
                }
            } catch (e: any) {
                attempts++;
                if (attempts < maxAttempts) {
                    await new Promise(r => setTimeout(r, attempts * 5000));
                } else {
                    this.jupiterSyncFailed = true;
                    this.jupiterFailCooldown = Date.now() + (10 * 60 * 1000);
                    if (this.jupiterTokens.size === 0) {
                        this.jupiterTokens.set(SOL_MINT.toBase58(), { symbol: "SOL", decimals: 9, name: "Solana" });
                        this.jupiterTokens.set(USDC_MINT.toBase58(), { symbol: "USDC", decimals: 6, name: "USD Coin" });
                    }
                }
            }
        }
    }

    private async runSweeper() {
        let sweepCount = 0;
        while (this.isRunning) {
            try {
                sweepCount++;
                if (sweepCount % 20 === 0) {
                    SocketManager.emitLog("[HEARTBEAT] LPPP BOT is actively scanning the market. All systems operational.", "success");
                }
                this.syncJupiterTokens().catch(() => { });
                await this.performMarketSweep();
                const now = Date.now();
                for (const [key, timestamp] of this.seenPairs) {
                    if (now - timestamp > this.SEEN_COOLDOWN) {
                        this.seenPairs.delete(key);
                    }
                }
            } catch (error: any) {
                console.error(`[SWEEPER ERROR] ${error.message}`);
            }
            await new Promise(resolve => setTimeout(resolve, 20000));
        }
    }

    private async performMarketSweep() {
        const mode = this.criteria.mode || "DUAL";
        SocketManager.emitLog(`[SWEEPER] Mode: ${mode} | Targeting Birdeye Pro feeds...`, "info");

        try {
            let allPairs: any[] = [];
            try {
                if (mode === "ANALYST" || mode === "DUAL") {
                    const trending = await BirdeyeService.fetchTrendingTokens(this.criteria);
                    allPairs = [...allPairs, ...trending];
                }
                if (mode === "SCOUT" || mode === "DUAL") {
                    const newListings = await BirdeyeService.fetchNewListings(this.criteria);
                    allPairs = [...allPairs, ...newListings];
                }
                if (mode === "ANALYST" || mode === "DUAL") {
                    const highVolume = await BirdeyeService.fetchHighVolumeTokens(this.criteria);
                    allPairs = [...allPairs, ...highVolume];
                }
            } catch (e) {
                console.warn(`[BIRDEYE-SCAN] Error: ${e}`);
            }

            const uniquePairsMap = new Map();
            allPairs.forEach(p => {
                const dexId = (p.dexId || "").toLowerCase();
                const chainId = (p.chainId || "solana").toLowerCase();
                const address = p.pairAddress || p.tokenAddress;

                if (chainId === "solana" && address && !uniquePairsMap.has(address)) {
                    const baseToken = p.baseToken || {
                        address: p.mint ? (typeof p.mint === 'string' ? p.mint : p.mint.toBase58()) : (p.address || address),
                        symbol: p.symbol || "TOKEN"
                    };
                    const quoteToken = p.quoteToken || {
                        address: SOL_MINT.toBase58(),
                        symbol: "SOL"
                    };

                    uniquePairsMap.set(address, {
                        ...p,
                        pairAddress: address,
                        dexId,
                        baseToken,
                        quoteToken,
                        priceUsd: p.priceUsd || 0,
                        volume: p.volume || { m5: 0, h1: 0, h24: p.volume24h || 0 },
                        liquidity: p.liquidity ? (typeof p.liquidity === 'object' ? p.liquidity : { usd: p.liquidity }) : { usd: 0 },
                        marketCap: p.mcap || p.marketCap || 0,
                        source: p.source || "BASELINE"
                    });
                }
            });

            const pairs = Array.from(uniquePairsMap.values());
            if (pairs.length === 0) {
                SocketManager.emitLog("[SWEEPER] Ecosystem harvest came up empty. Retrying...", "warning");
                return;
            }

            SocketManager.emitLog(`[SWEEPER] Evaluated ${pairs.length} assets. Mode: ${mode}`, "info");

            for (const pair of pairs) {
                let targetToken = pair.baseToken;
                let priceUSD = Number(pair.priceUsd || 0);

                if (!targetToken?.address || IGNORED_MINTS.includes(targetToken.address)) {
                    targetToken = pair.quoteToken;
                }

                if (!targetToken?.address || IGNORED_MINTS.includes(targetToken.address)) continue;
                if (priceUSD > 0.98 && priceUSD < 1.02) continue;

                const volume5m = pair.volume?.m5 || 0;
                const volume1h = pair.volume?.h1 || 0;
                const volume24h = pair.volume?.h24 || 0;
                const liquidity = pair.liquidity?.usd || 0;
                const mcap = pair.marketCap || 0;

                // Quick reject: mega-cap tokens are not targets for LP creation
                const MCAP_HARD_CEILING = 50_000_000;
                if (mcap > MCAP_HARD_CEILING && Number(this.criteria.mcap.max) === 0) {
                    continue;
                }

                const inRange = (val: number, range: NumericRange) => {
                    const minMatch = Number(range.min) === 0 || val >= Number(range.min);
                    const maxMatch = Number(range.max) === 0 || val <= Number(range.max);
                    return minMatch && maxMatch;
                };

                const meetsVol5m = (volume5m === 0 && pair.dexId.startsWith('birdeye')) ? true : inRange(volume5m, this.criteria.volume5m);
                const meetsVol1h = (volume1h === 0 && pair.dexId.startsWith('birdeye')) ? true : inRange(volume1h, this.criteria.volume1h);
                const meetsVol24h = inRange(volume24h, this.criteria.volume24h);
                const meetsLiquidity = inRange(liquidity, this.criteria.liquidity);
                const meetsMcap = inRange(mcap, this.criteria.mcap);

                if (meetsVol5m && meetsVol1h && meetsVol24h && meetsLiquidity && meetsMcap) {
                    SocketManager.emitLog(`[ECOSYSTEM MATCH] ${targetToken.symbol} passed all metrics! (Source: ${pair.source})`, "success");

                    this.seenPairs.set(pair.pairAddress, Date.now());
                    await this.callback({
                        mint: new PublicKey(targetToken.address),
                        pairAddress: pair.pairAddress,
                        dexId: pair.dexId || 'unknown',
                        volume24h: Number(volume24h),
                        liquidity: Number(liquidity),
                        mcap: Number(mcap),
                        symbol: targetToken.symbol,
                        priceUsd: priceUSD
                    });
                }
            }

            const summaryMsg = `[ECOSYSTEM SWEEP COMPLETE] Next harvest in 30s.`;
            console.log(summaryMsg);
            SocketManager.emitLog(summaryMsg, "info");

        } catch (err: any) {
            const errMsg = `[HARVESTER ERROR] ${err.message}`;
            console.error(errMsg);
            SocketManager.emitLog(errMsg, "error");
        }
    }

    async evaluateToken(result: ScanResult) {
        if (!this.isRunning) return;
        const lastSeen = this.seenPairs.get(result.pairAddress);
        if (lastSeen && Date.now() - lastSeen < this.SEEN_COOLDOWN) return;

        SocketManager.emitLog(`[EVALUATOR] High-Priority Evaluation for ${result.symbol}...`, "info");
        this.seenPairs.set(result.pairAddress, Date.now());
        await this.callback(result);
    }

    stop() {
        this.isRunning = false;
        console.log("LPPP BOT Sweeper Service Stopped.");
    }
}
