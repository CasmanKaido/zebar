import axios from "axios";
import { PublicKey } from "@solana/web3.js";
import { SocketManager } from "./socket";
import { BirdeyeService } from "./birdeye-service";
import { connection, IGNORED_MINTS, SOL_MINT } from "./config";
export interface ScanResult {
    mint: PublicKey;
    pairAddress: string;
    dexId: string;
    volume24h: number;
    liquidity: number;
    mcap: number;
    symbol: string;
    priceUsd: number;
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

        // Initial Jupiter Sync
        await this.syncJupiterTokens();

        // Start the sweeping loop
        this.runSweeper();
    }

    private async syncJupiterTokens() {
        if (Date.now() - this.lastJupiterSync < this.JUPITER_SYNC_INTERVAL) return;
        // If we failed recently, don't retry for 10 minutes
        if (this.jupiterSyncFailed && Date.now() < this.jupiterFailCooldown) return;

        let attempts = 0;
        const maxAttempts = 4; // Increased from 2 for better resilience

        while (attempts < maxAttempts) {
            try {
                SocketManager.emitLog(`[JUPITER] Refreshing global token list (Attempt ${attempts + 1}/${maxAttempts})...`, "info");
                const res = await axios.get("https://token.jup.ag/all", { timeout: 20000 });
                if (Array.isArray(res.data)) {
                    this.jupiterTokens.clear();
                    res.data.forEach((t: any) => {
                        this.jupiterTokens.set(t.address, t);
                    });
                    this.lastJupiterSync = Date.now();
                    this.jupiterSyncFailed = false; // Reset failure flag on success
                    SocketManager.emitLog(`[JUPITER] Synced ${res.data.length} tokens for validation.`, "success");
                    return; // Success
                }
            } catch (e: any) {
                attempts++;
                const isDnsError = e.code === 'ENOTFOUND' || e.message.includes('getaddrinfo');
                const errMsg = isDnsError ? "DNS lookup failed (network glitch?)" : e.message;

                if (attempts < maxAttempts) {
                    const delay = attempts * 5000; // 5s, 10s, 15s
                    console.warn(`[JUPITER WARN] Sync attempt ${attempts} failed: ${errMsg}. Retrying in ${delay / 1000}s...`);
                    await new Promise(r => setTimeout(r, delay));
                } else {
                    this.jupiterSyncFailed = true;
                    this.jupiterFailCooldown = Date.now() + (10 * 60 * 1000); // 10 min cooldown
                    console.error(`[JUPITER ERROR] Sync failed after ${maxAttempts} attempts: ${errMsg}. Cooling down for 10 mins. On-chain fallback active.`);
                }
            }
        }
    }

    private async runSweeper() {
        let sweepCount = 0;
        while (this.isRunning) {
            try {
                sweepCount++;
                // Log a heartbeat every 20 sweeps (~10 minutes)
                if (sweepCount % 20 === 0) {
                    SocketManager.emitLog("[HEARTBEAT] LPPP BOT is actively scanning the market. All systems operational.", "success");
                }

                // Fire-and-forget Jupiter sync (don't block the sweep)
                this.syncJupiterTokens().catch(() => { });

                await this.performMarketSweep();

                // Prune expired seenPairs to prevent memory leak
                const now = Date.now();
                for (const [key, timestamp] of this.seenPairs) {
                    if (now - timestamp > this.SEEN_COOLDOWN) {
                        this.seenPairs.delete(key);
                    }
                }
            } catch (error: any) {
                console.error(`[SWEEPER ERROR] ${error.message}`);
            }
            // Wait 20 seconds between sweeps (Optimized for Helius Developer + Birdeye Lite)
            await new Promise(resolve => setTimeout(resolve, 20000));
        }
    }

    private async performMarketSweep() {
        const mode = this.criteria.mode || "DUAL";
        SocketManager.emitLog(`[SWEEPER] Mode: ${mode} | Targeting Birdeye Pro feeds...`, "info");

        try {
            let allPairs: any[] = [];

            // 1. PRIMARY: Birdeye Engine Selection
            try {
                if (mode === "ANALYST" || mode === "DUAL") {
                    const trending = await BirdeyeService.fetchTrendingTokens(this.criteria);
                    allPairs = [...allPairs, ...trending];
                }

                if (mode === "SCOUT" || mode === "DUAL") {
                    const newListings = await BirdeyeService.fetchNewListings(this.criteria);
                    allPairs = [...allPairs, ...newListings];
                }

                // Fallback / High-Volume Baseline (Always good to have)
                if (mode === "ANALYST" || mode === "DUAL") {
                    const highVolume = await BirdeyeService.fetchHighVolumeTokens(this.criteria);
                    allPairs = [...allPairs, ...highVolume];
                }
            } catch (e) {
                console.warn(`[BIRDEYE-SCAN] Error: ${e}`);
            }

            /* 
            // 2. SECONDARY: DexScreener Search (Meteora focus)
            const keywordQueries = ["meteora"];
            for (const query of keywordQueries) {
                try {
                    const searchRes = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${query}`, { timeout: 5000 });
                    if (searchRes.data.pairs) allPairs = [...allPairs, ...searchRes.data.pairs];
                } catch (e) { }
            }
            */

            /*
            // 3. TERTIARY: GeckoTerminal Network Pools (Paginated Backup)
            for (let page = 1; page <= 8; page++) {
                try {
                    const geckoRes = await axios.get(`https://api.geckoterminal.com/api/v2/networks/solana/pools?page=${page}`, { timeout: 8000 });
                    if (geckoRes.data?.data) {
                        const pagePairs = geckoRes.data.data.map((p: any) => ({
                            pairAddress: p.attributes.address,
                            chainId: "solana",
                            dexId: p.relationships.dex.data.id,
                            baseToken: {
                                symbol: p.attributes.name.split(" / ")[0],
                                address: p.relationships.base_token.data.id.split("_")[1]
                            },
                            quoteToken: {
                                symbol: p.attributes.name.split(" / ")[1],
                                address: p.relationships.quote_token.data.id.split("_")[1]
                            },
                            priceUsd: p.attributes.base_token_price_usd,
                            volume: {
                                m5: Number(p.attributes.volume_usd.m5),
                                h1: Number(p.attributes.volume_usd.h1),
                                h24: Number(p.attributes.volume_usd.h24)
                            },
                            liquidity: { usd: Number(p.attributes.reserve_in_usd) },
                            marketCap: Number(p.attributes.fdv_usd) || 0
                        }));
                        allPairs = [...allPairs, ...pagePairs];
                    }
                } catch (e: any) {
                    if (e.response?.status === 429) {
                        console.error(`[GECKO] 429 on Page ${page}. IP throttled.`);
                        break;
                    }
                }
                // Faster 5s delay for backup source
                if (page < 8) await new Promise(r => setTimeout(r, 5000));
            }
            */

            /*
            // 4. DexScreener Boosted Tokens (Trending)
            try {
                const boostedRes = await axios.get("https://api.dexscreener.com/token-boosts/latest/v1", { timeout: 5000 });
                if (Array.isArray(boostedRes.data)) {
                    const solanaBoosted = boostedRes.data.filter((t: any) => t.chainId === "solana");
                    const boostedPairs = solanaBoosted.map((t: any) => ({ ...t, isBoosted: true }));
                    allPairs = [...allPairs, ...boostedPairs];
                }
            } catch (e: any) { }
            */

            // Deduplicate pairs by address and FILTER FOR METEORA ONLY
            const uniquePairsMap = new Map();
            allPairs.forEach(p => {
                // Handle different response formats between Gecko and DexScreener
                const dexId = (p.dexId || p.relationships?.dex?.data?.id || "").toLowerCase();
                const chainId = (p.chainId || "solana").toLowerCase();
                const address = p.pairAddress || p.attributes?.address || p.tokenAddress;

                if (chainId === "solana" && address && !uniquePairsMap.has(address)) {
                    // Normalize standard format for internal loop
                    uniquePairsMap.set(address, {
                        pairAddress: address,
                        dexId: dexId,
                        baseToken: p.baseToken || {
                            address: p.mint ? p.mint.toBase58() : p.relationships?.base_token?.data?.id?.split("_")[1],
                            symbol: p.symbol || p.attributes?.name?.split(" / ")[0]
                        },
                        quoteToken: p.quoteToken || {
                            address: p.relationships?.quote_token?.data?.id?.split("_")[1],
                            symbol: p.attributes?.name?.split(" / ")[1]
                        },
                        priceUsd: p.priceUsd || Number(p.attributes?.base_token_price_usd || 0),
                        volume: p.volume || {
                            m5: Number(p.attributes?.volume_usd?.m5 || 0),
                            h1: Number(p.attributes?.volume_usd?.h1 || 0),
                            h24: Number(p.volume24h || p.attributes?.volume_usd?.h24 || 0)
                        },
                        volume24h: p.volume24h || Number(p.attributes?.volume_usd?.h24 || 0),
                        liquidity: p.liquidity ? (typeof p.liquidity === 'object' ? p.liquidity : { usd: p.liquidity }) : { usd: Number(p.attributes?.reserve_in_usd || 0) },
                        marketCap: p.mcap || p.marketCap || p.fdv || Number(p.attributes?.fdv_usd || 0)
                    });
                }
            });

            const pairs = Array.from(uniquePairsMap.values());

            if (pairs.length === 0) {
                SocketManager.emitLog("[SWEEPER] Ecosystem harvest came up empty. Retrying...", "warning");
                return;
            }

            console.log(`[SWEEPER] Evaluating ${pairs.length} unique assets from across the ecosystem...`);
            SocketManager.emitLog(`[SWEEPER] Evaluated ${pairs.length} assets. No caps applied.`, "info");

            let candidatesFound = 0;

            for (const pair of pairs) {
                // Check seenPairs with cooldown (DISABLED PER USER REQUEST)
                // const lastSeen = this.seenPairs.get(pair.pairAddress);
                // if (lastSeen && Date.now() - lastSeen < this.SEEN_COOLDOWN) continue;
                let targetToken = pair.baseToken;
                let priceUSD = Number(pair.priceUsd || 0);

                if (IGNORED_MINTS.includes(targetToken.address)) {
                    targetToken = pair.quoteToken;
                }

                if (IGNORED_MINTS.includes(targetToken.address)) continue;
                if (priceUSD > 0.98 && priceUSD < 1.02) continue;

                // metadata Check / Fallback (Batch 2.0)
                let tokenInfo = this.jupiterTokens.get(targetToken.address);
                if (!tokenInfo) {
                    try {
                        const mintPubkey = new PublicKey(targetToken.address);
                        const info = await connection.getParsedAccountInfo(mintPubkey);
                        if (info.value && (info.value.data as any).parsed) {
                            const parsed = (info.value.data as any).parsed.info;
                            tokenInfo = {
                                symbol: targetToken.symbol || "Unknown",
                                decimals: parsed.decimals || 9,
                                name: "Discovery Token"
                            };
                        }
                    } catch (e) { }
                }

                const volume5m = pair.volume?.m5 || 0;
                const volume1h = pair.volume?.h1 || 0;
                const volume24h = pair.volume?.h24 || 0;
                const liquidity = pair.liquidity?.usd || 0;
                const mcap = pair.marketCap || pair.fdv || 0;

                // Range validation helper
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
                    const matchMsg = `[ECOSYSTEM MATCH] ${targetToken.symbol} passed all metrics!`;

                    console.log(matchMsg);
                    SocketManager.emitLog(matchMsg, "success");

                    this.seenPairs.set(pair.pairAddress, Date.now());

                    const result: ScanResult = {
                        mint: new PublicKey(targetToken.address),
                        pairAddress: pair.pairAddress,
                        dexId: pair.dexId || 'unknown',
                        volume24h: Number(volume24h),
                        liquidity: Number(liquidity),
                        mcap: Number(mcap),
                        symbol: targetToken.symbol,
                        priceUsd: priceUSD
                    };

                    await this.callback(result);
                    candidatesFound++;
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


    /**
     * External trigger for token evaluation (e.g. from Webhooks)
     */
    async evaluateToken(result: ScanResult) {
        if (!this.isRunning) return;

        // Check cooldown
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

