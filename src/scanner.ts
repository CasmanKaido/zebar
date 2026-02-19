import axios from "axios";
import { PublicKey } from "@solana/web3.js";
import { SocketManager } from "./socket";
import { BirdeyeService } from "./birdeye-service";
import { DexScreenerService } from "./dexscreener-service";
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
    private seenPairs: Map<string, number> = new Map(); // mintAddress -> timestamp
    private SEEN_COOLDOWN = 5 * 60 * 1000; // 5 minute cooldown
    private scanInterval: NodeJS.Timeout | null = null;
    private jupiterTokens: Map<string, any> = new Map(); // mint -> metadata
    private lastJupiterSync = 0;
    private JUPITER_SYNC_INTERVAL = 60 * 60 * 1000; // 1 hour
    private jupiterSyncFailed = false;
    private jupiterFailCooldown = 0;

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
        const sourceLabel = mode === "SCOUT" ? "Birdeye New Listings" : mode === "ANALYST" ? "DexScreener Pro" : "DexScreener + Birdeye";
        SocketManager.emitLog(`[SWEEPER] Mode: ${mode} | Source: ${sourceLabel}`, "info");

        try {
            let allPairs: any[] = [];

            // ═══════════════════════════════════════════════════════
            // ANALYST: DexScreener boosted/trending tokens (FREE)
            // ═══════════════════════════════════════════════════════
            if (mode === "ANALYST" || mode === "DUAL") {
                try {
                    const boosted = await DexScreenerService.fetchBoostedTokens();
                    if (boosted.length > 0) {
                        allPairs = [...allPairs, ...boosted];
                        SocketManager.emitLog(`[DEXSCREENER] Found ${boosted.length} boosted/trending tokens.`, "info");
                    }
                } catch (e: any) {
                    console.warn(`[DEXSCREENER] Boosted fetch error: ${e.message}`);
                }

                try {
                    const profiles = await DexScreenerService.fetchLatestProfiles();
                    if (profiles.length > 0) {
                        allPairs = [...allPairs, ...profiles];
                    }
                } catch (e: any) {
                    console.warn(`[DEXSCREENER] Profiles fetch error: ${e.message}`);
                }
            }

            // ═══════════════════════════════════════════════════════
            // ANALYST: Birdeye high-volume scan (rolling pagination)
            // Still useful — Birdeye's volume-sorted list has no DexScreener equivalent.
            // But now we batch-resolve mints through DexScreener for real pair addresses.
            // ═══════════════════════════════════════════════════════
            if (mode === "ANALYST" || mode === "DUAL") {
                try {
                    const birdeyeTokens = await BirdeyeService.fetchHighVolumeTokens(this.criteria);
                    if (birdeyeTokens.length > 0) {
                        // Extract mint addresses from Birdeye results
                        const mints = birdeyeTokens
                            .map((t: any) => t.mint ? (typeof t.mint === 'string' ? t.mint : t.mint.toBase58()) : "")
                            .filter((m: string) => m.length > 10);

                        if (mints.length > 0) {
                            // Batch resolve through DexScreener to get real pair addresses
                            const resolved = await DexScreenerService.batchLookupTokens(mints, "BIRDEYE_VOLUME");
                            allPairs = [...allPairs, ...resolved];
                            SocketManager.emitLog(`[BIRDEYE→DS] Resolved ${resolved.length}/${mints.length} tokens via DexScreener.`, "info");
                        }
                    }
                } catch (e: any) {
                    console.warn(`[BIRDEYE→DS] Volume scan error: ${e.message}`);
                }
            }

            // ═══════════════════════════════════════════════════════
            // SCOUT: Birdeye new listings (Birdeye's unique strength)
            // Also batch-resolve through DexScreener for pair addresses
            // ═══════════════════════════════════════════════════════
            if (mode === "SCOUT" || mode === "DUAL") {
                try {
                    const newListings = await BirdeyeService.fetchNewListings(this.criteria);
                    if (newListings.length > 0) {
                        const mints = newListings
                            .map((t: any) => t.mint ? (typeof t.mint === 'string' ? t.mint : t.mint.toBase58()) : "")
                            .filter((m: string) => m.length > 10);

                        if (mints.length > 0) {
                            const resolved = await DexScreenerService.batchLookupTokens(mints, "SCOUT");
                            allPairs = [...allPairs, ...resolved];
                            SocketManager.emitLog(`[SCOUT] Resolved ${resolved.length}/${mints.length} new listings via DexScreener.`, "info");
                        }

                        // Also include raw Birdeye data for tokens DexScreener doesn't know about yet
                        for (const t of newListings) {
                            const mintStr = t.mint ? (typeof t.mint === 'string' ? t.mint : t.mint.toBase58()) : "";
                            if (mintStr && !allPairs.some((p: any) => p.baseToken?.address === mintStr)) {
                                allPairs.push({
                                    pairAddress: mintStr, // Fallback: mint as pair (will be resolved during safety check)
                                    baseToken: { address: mintStr, symbol: t.symbol || "NEW" },
                                    quoteToken: { address: SOL_MINT.toBase58(), symbol: "SOL" },
                                    dexId: "birdeye-new",
                                    chainId: "solana",
                                    priceUsd: t.priceUsd || "0",
                                    volume: { m5: 0, h1: 0, h24: t.volume24h || 0 },
                                    liquidity: { usd: t.liquidity || 0 },
                                    marketCap: t.mcap || 0,
                                    source: "SCOUT_RAW"
                                });
                            }
                        }
                    }
                } catch (e: any) {
                    console.warn(`[SCOUT] New listings error: ${e.message}`);
                }
            }

            // ═══════════════════════════════════════════════════════
            // DEDUPLICATION — by mint address
            // ═══════════════════════════════════════════════════════
            const uniqueByMint = new Map<string, any>();
            for (const pair of allPairs) {
                const mintAddr = pair.baseToken?.address;
                if (!mintAddr || IGNORED_MINTS.includes(mintAddr)) continue;

                const existing = uniqueByMint.get(mintAddr);
                const pairLiq = pair.liquidity?.usd || 0;
                const existingLiq = existing?.liquidity?.usd || 0;

                // Keep the pair with highest liquidity
                if (!existing || pairLiq > existingLiq) {
                    uniqueByMint.set(mintAddr, pair);
                }
            }

            const pairs = Array.from(uniqueByMint.values());
            if (pairs.length === 0) {
                SocketManager.emitLog("[SWEEPER] Ecosystem harvest came up empty. Retrying...", "warning");
                return;
            }

            SocketManager.emitLog(`[SWEEPER] Evaluated ${pairs.length} assets. Mode: ${mode}`, "info");

            // ═══════════════════════════════════════════════════════
            // FILTER — apply user criteria, collect all matches
            // ═══════════════════════════════════════════════════════
            const qualified: { pair: any; mintAddress: string; volume5m: number; volume1h: number; volume24h: number; liquidity: number; mcap: number; priceUSD: number }[] = [];

            for (const pair of pairs) {
                const mintAddress = pair.baseToken?.address;
                if (!mintAddress || IGNORED_MINTS.includes(mintAddress)) continue;

                // Dedup cooldown
                const lastSeen = this.seenPairs.get(mintAddress);
                if (lastSeen && Date.now() - lastSeen < this.SEEN_COOLDOWN) continue;

                const priceUSD = Number(pair.priceUsd || 0);
                if (priceUSD > 0.98 && priceUSD < 1.02) continue;

                const volume5m = pair.volume?.m5 || 0;
                const volume1h = pair.volume?.h1 || 0;
                const volume24h = pair.volume?.h24 || 0;
                const liquidity = pair.liquidity?.usd || 0;
                const mcap = pair.marketCap || 0;

                const MCAP_HARD_CEILING = 50_000_000;
                if (mcap > MCAP_HARD_CEILING && Number(this.criteria.mcap.max) === 0) continue;

                const inRange = (val: number, range: NumericRange) => {
                    const minMatch = Number(range.min) === 0 || val >= Number(range.min);
                    const hasMax = Number(range.max) > 0;
                    const maxMatch = !hasMax || val <= Number(range.max);
                    return minMatch && maxMatch;
                };

                const meetsVol5m = volume5m === 0 ? true : inRange(volume5m, this.criteria.volume5m);
                const meetsVol1h = volume1h === 0 ? true : inRange(volume1h, this.criteria.volume1h);
                const meetsVol24h = inRange(volume24h, this.criteria.volume24h);
                const meetsLiquidity = inRange(liquidity, this.criteria.liquidity);
                const meetsMcap = inRange(mcap, this.criteria.mcap);

                if (meetsVol5m && meetsVol1h && meetsVol24h && meetsLiquidity && meetsMcap) {
                    if (this.jupiterTokens.size > 0 && !this.jupiterTokens.has(mintAddress)) continue;
                    qualified.push({ pair, mintAddress, volume5m, volume1h, volume24h, liquidity, mcap, priceUSD });
                }
            }

            // ═══════════════════════════════════════════════════════
            // DISPLAY ALL MATCHES (FREE — no RPC, just DexScreener data)
            // ═══════════════════════════════════════════════════════
            if (qualified.length > 0) {
                // Sort by liquidity descending (best opportunities first)
                qualified.sort((a, b) => b.liquidity - a.liquidity);

                const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(0)}K` : `${n.toFixed(0)}`;

                SocketManager.emitLog(`[MATCHES] ${qualified.length} tokens meet criteria:`, "info");
                for (const q of qualified) {
                    const sym = q.pair.baseToken?.symbol || "???";
                    const dex = q.pair.dexId || "?";
                    SocketManager.emitLog(
                        `  ⚡ ${sym} | Liq: $${fmt(q.liquidity)} | MCap: $${fmt(q.mcap)} | Vol1h: $${fmt(q.volume1h)} | Vol24h: $${fmt(q.volume24h)} | DEX: ${dex}`,
                        "info"
                    );
                }
            }

            // ═══════════════════════════════════════════════════════
            // EXECUTE — only send top 3 to safety pipeline per sweep
            // This conserves RPC: ~15 calls max instead of ~60+
            // ═══════════════════════════════════════════════════════
            const MAX_SAFETY_CHECKS_PER_SWEEP = 3;
            const toExecute = qualified.slice(0, MAX_SAFETY_CHECKS_PER_SWEEP);

            for (const q of toExecute) {
                this.seenPairs.set(q.mintAddress, Date.now());
                await this.callback({
                    mint: new PublicKey(q.mintAddress),
                    pairAddress: q.pair.pairAddress,
                    dexId: q.pair.dexId || 'unknown',
                    volume24h: Number(q.volume24h),
                    liquidity: Number(q.liquidity),
                    mcap: Number(q.mcap),
                    symbol: q.pair.baseToken?.symbol || "TOKEN",
                    priceUsd: q.priceUSD
                });
            }

            // Mark remaining as seen so they get picked up next sweep if still qualifying
            for (let i = MAX_SAFETY_CHECKS_PER_SWEEP; i < qualified.length; i++) {
                // Don't mark as seen — let them re-qualify next sweep for their turn
            }

            const summaryMsg = qualified.length > 0
                ? `[SWEEP] ${qualified.length} matches found, ${toExecute.length} sent to safety check. Next sweep in 30s.`
                : `[ECOSYSTEM SWEEP COMPLETE] Next harvest in 30s.`;
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
