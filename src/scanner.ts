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
    volume5m?: number;
    volume1h?: number;
    volume24h: number;
    liquidity: number;
    mcap: number;
    symbol: string;
    priceUsd: number;
    source?: string;
    pairCreatedAt?: number;
}

export interface NumericRange {
    min: number;
    max: number; // 0 means no upper limit
}

export type ScannerMode = "SCOUT" | "ANALYST";

export interface ScannerCriteria {
    volume5m: NumericRange;
    volume1h: NumericRange;
    volume24h: NumericRange;
    liquidity: NumericRange;
    mcap: NumericRange;
    mode?: ScannerMode;
    maxAgeMinutes?: number;
    enableRunnerMode?: boolean;
    runnerMinScore?: number;
    runnerMin5mToLiquidityPct?: number;
    runnerMin5mTo1hPct?: number;
    runnerMinPriceChangePct?: number;
    runnerMinLiquidityChangePct?: number;
    runnerMinPairAgeMinutes?: number;
    runnerTopCandidates?: number;
}

interface TokenSnapshot {
    volume5m: number;
    liquidity: number;
    priceUsd: number;
    mcap: number;
    ts: number;
}

interface RunnerAssessment {
    score: number;
    reasons: string[];
    meets: boolean;
}

export class MarketScanner {
    private connection: any;
    private isRunning: boolean = false;
    private criteria: ScannerCriteria;
    private callback: (result: ScanResult) => Promise<void>;
    private isTickerUsed?: (ticker: string) => boolean;
    private seenPairs: Map<string, number> = new Map(); // mintAddress -> timestamp
    private _processingMutex: Set<string> = new Set(); // Prevent concurrent webhook duplicate buys
    private SEEN_COOLDOWN = 3 * 60 * 1000; // 3 minute cooldown
    private scanInterval: NodeJS.Timeout | null = null;
    private jupiterTokens: Map<string, any> = new Map(); // mint -> metadata
    private lastJupiterSync = 0;
    private JUPITER_SYNC_INTERVAL = 60 * 60 * 1000; // 1 hour
    private jupiterSyncFailed = false;
    private jupiterFailCooldown = 0;
    private geckoPage = 1;
    private readonly GECKO_PAGES_PER_SWEEP = 6;
    private readonly GECKO_MAX_PAGE = 10;
    private tokenSnapshots: Map<string, TokenSnapshot> = new Map();

    constructor(criteria: ScannerCriteria, callback: (result: ScanResult) => Promise<void>, conn: any, tickerChecker?: (ticker: string) => boolean) {
        this.criteria = criteria;
        this.callback = callback;
        this.connection = conn;
        this.isTickerUsed = tickerChecker;
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
            const sweepInterval = (this.criteria.mode === "SCOUT") ? 10000 : 20000;
            await new Promise(resolve => setTimeout(resolve, sweepInterval));
        }
    }

    private async performMarketSweep() {
        const mode = this.criteria.mode || "SCOUT";
        const sourceLabel = mode === "SCOUT" ? "Birdeye New Listings + Helius" : "GeckoTerminal + Birdeye";
        SocketManager.emitLog(`[SWEEPER] Mode: ${mode} | Source: ${sourceLabel} | Next Gecko Page: ${this.geckoPage}`, "info");

        try {
            let allPairs: any[] = [];

            // ═══════════════════════════════════════════════════════
            // ANALYST: GeckoTerminal Solana Pools (rolling pagination)
            // Returns complete pair data: pairAddress, volume, liq, mcap
            // No resolution step needed — data is ready to filter.
            // ═══════════════════════════════════════════════════════
            if (mode === "ANALYST") {
                const startPage = this.geckoPage;
                let pagesThisSweep = 0;

                while (pagesThisSweep < this.GECKO_PAGES_PER_SWEEP) {
                    try {
                        const geckoRes = await axios.get(
                            `https://api.geckoterminal.com/api/v2/networks/solana/pools?page=${this.geckoPage}`,
                            { timeout: 8000 }
                        );

                        if (geckoRes.data?.data && geckoRes.data.data.length > 0) {
                            const pagePairs = geckoRes.data.data.map((p: any) => ({
                                pairAddress: p.attributes?.address || "",
                                chainId: "solana",
                                dexId: p.relationships?.dex?.data?.id || "unknown",
                                baseToken: {
                                    symbol: (p.attributes?.name || "?").split(" / ")[0],
                                    address: (p.relationships?.base_token?.data?.id || "").split("_")[1] || ""
                                },
                                quoteToken: {
                                    symbol: (p.attributes?.name || "?").split(" / ")[1] || "?",
                                    address: (p.relationships?.quote_token?.data?.id || "").split("_")[1] || ""
                                },
                                priceUsd: p.attributes?.base_token_price_usd || "0",
                                volume: {
                                    m5: Number(p.attributes?.volume_usd?.m5 || 0),
                                    h1: Number(p.attributes?.volume_usd?.h1 || 0),
                                    h24: Number(p.attributes?.volume_usd?.h24 || 0)
                                },
                                liquidity: { usd: Number(p.attributes?.reserve_in_usd || 0) },
                                marketCap: Number(p.attributes?.fdv_usd || 0),
                                source: "GECKO"
                            }));
                            allPairs = [...allPairs, ...pagePairs];
                        } else {
                            // No data on this page — reset to page 1
                            this.geckoPage = 1;
                            break;
                        }
                    } catch (e: any) {
                        if (e.response?.status === 429) {
                            console.warn(`[GECKO] Rate limited on page ${this.geckoPage}. Pausing.`);
                            break;
                        }
                        console.warn(`[GECKO] Page ${this.geckoPage} error: ${e.message}`);
                    }

                    this.geckoPage++;
                    pagesThisSweep++;

                    // Reset pagination when we've gone deep enough
                    if (this.geckoPage > this.GECKO_MAX_PAGE) {
                        this.geckoPage = 1;
                    }

                    // Rate limit between pages
                    if (pagesThisSweep < this.GECKO_PAGES_PER_SWEEP) {
                        await new Promise(r => setTimeout(r, 2000));
                    }
                }

                if (allPairs.length > 0) {
                    SocketManager.emitLog(`[GECKO] Pages ${startPage}-${startPage + pagesThisSweep - 1} | Found ${allPairs.length} pools.`, "info");
                }
            }

            // ═══════════════════════════════════════════════════════
            // ANALYST: Birdeye high-volume scan (rolling pagination)
            // Still useful — Birdeye's volume-sorted list has no DexScreener equivalent.
            // But now we batch-resolve mints through DexScreener for real pair addresses.
            // ═══════════════════════════════════════════════════════
            if (mode === "ANALYST") {
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
            if (mode === "SCOUT") {
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
            // SCOUT: Multi-source new token discovery
            // Fires all sources in parallel for maximum coverage
            // ═══════════════════════════════════════════════════════
            if (mode === "SCOUT") {
                try {
                    const [latestProfiles, boostedTokens, geckoNewPools, raydiumMints] = await Promise.all([
                        DexScreenerService.fetchLatestProfiles().catch(() => []),
                        DexScreenerService.fetchBoostedTokens().catch(() => []),
                        DexScreenerService.fetchGeckoNewPools().catch(() => []),
                        DexScreenerService.fetchRaydiumNewMints().catch(() => [])
                    ]);

                    // Direct pair data sources (already have volume/liq/mcap)
                    const directPairs = [...latestProfiles, ...boostedTokens, ...geckoNewPools];
                    allPairs = [...allPairs, ...directPairs];

                    // Raydium returns mint addresses only — batch resolve via DexScreener
                    if (raydiumMints.length > 0) {
                        const existingMints = new Set(allPairs.map((p: any) => p.baseToken?.address).filter(Boolean));
                        const newRayMints = raydiumMints.filter(m => !existingMints.has(m) && !this.seenPairs.has(m));
                        if (newRayMints.length > 0) {
                            const resolved = await DexScreenerService.batchLookupTokens(newRayMints.slice(0, 30), "RAYDIUM_SCOUT");
                            allPairs = [...allPairs, ...resolved];
                        }
                    }

                    SocketManager.emitLog(
                        `[SCOUT] Sources: DS-Profiles:${latestProfiles.length} Boosted:${boostedTokens.length} Gecko-New:${geckoNewPools.length} Raydium:${raydiumMints.length}`,
                        "info"
                    );
                } catch (e: any) {
                    console.warn(`[SCOUT] Multi-source error: ${e.message}`);
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
            const qualified: { pair: any; mintAddress: string; volume5m: number; volume1h: number; volume24h: number; liquidity: number; mcap: number; priceUSD: number; runnerScore: number; runnerReasons: string[] }[] = [];

            // ── Track rejection reasons ──
            const rejectReasons = { noMint: 0, dedup: 0, stablecoin: 0, vol5m: 0, vol1h: 0, vol24h: 0, liquidity: 0, mcap: 0, jupiter: 0, accepted: 0 };

            for (const pair of pairs) {
                const mintAddress = pair.baseToken?.address;
                if (!mintAddress || IGNORED_MINTS.includes(mintAddress)) { rejectReasons.noMint++; continue; }

                const sym = pair.baseToken?.symbol || mintAddress.slice(0, 6);
                const dex = pair.dexId || "?";

                if (this.isTickerUsed && this.isTickerUsed(sym)) {
                    rejectReasons.dedup++; // Reuse dedup count or add tickerSpecific one
                    console.log(`[EVAL] ${sym} | ❌ DUPLICATE TICKER (Already traded)`);
                    continue;
                }

                // Dedup cooldown
                const lastSeen = this.seenPairs.get(mintAddress);
                if (lastSeen && Date.now() - lastSeen < this.SEEN_COOLDOWN) {
                    rejectReasons.dedup++;
                    console.log(`[EVAL] ${sym} | ⏳ COOLDOWN (seen ${Math.round((Date.now() - lastSeen) / 1000)}s ago)`);
                    continue;
                }

                const priceUSD = Number(pair.priceUsd || 0);
                if (priceUSD > 0.98 && priceUSD < 1.02) {
                    rejectReasons.stablecoin++;
                    console.log(`[EVAL] ${sym} | ❌ STABLECOIN ($${priceUSD.toFixed(4)})`);
                    continue;
                }

                const volume5m = pair.volume?.m5 || 0;
                const volume1h = pair.volume?.h1 || 0;
                const volume24h = pair.volume?.h24 || 0;
                const liquidity = pair.liquidity?.usd || 0;
                const mcap = pair.marketCap || pair.fdv || 0;

                // MOMENTUM FILTERS for SCOUT Mode
                // If token is < 15m old (estimated by low h1/h24 volume), prioritize 5m velocity.
                const isVeryNew = volume1h < (this.criteria.volume1h.min * 0.5) || volume24h < (this.criteria.volume24h.min * 0.5);
                const isScoutMode = this.criteria.mode === "SCOUT";

                let meetsVol5m = volume5m === 0 ? (this.criteria.volume5m.min === 0) : this.inRange(volume5m, this.criteria.volume5m);
                let meetsVol1h = volume1h === 0 ? (this.criteria.volume1h.min === 0) : this.inRange(volume1h, this.criteria.volume1h);
                let meetsVol24h = volume24h === 0 ? (this.criteria.volume24h.min === 0) : this.inRange(volume24h, this.criteria.volume24h);

                // Scout Momentum Override: If 5m volume is 3x the minimum, bypass min but still enforce max.
                if (isScoutMode && isVeryNew && volume5m >= (this.criteria.volume5m.min * 3)) {
                    const vol1hMaxOk = this.criteria.volume1h.max === 0 || volume1h <= this.criteria.volume1h.max;
                    const vol24hMaxOk = this.criteria.volume24h.max === 0 || volume24h <= this.criteria.volume24h.max;
                    meetsVol1h = vol1hMaxOk;
                    meetsVol24h = vol24hMaxOk;
                    // Tag it as a momentum play
                    (pair as any).isMomentumPlay = true;
                }

                const meetsLiquidity = this.inRange(liquidity, this.criteria.liquidity);
                const meetsMcap = mcap === 0 ? (this.criteria.mcap.min === 0) : this.inRange(mcap, this.criteria.mcap);

                const tag = `${sym} | ${dex} | Vol5m:${this.fmtK(volume5m)} Vol1h:${this.fmtK(volume1h)} Vol24h:${this.fmtK(volume24h)} Liq:${this.fmtK(liquidity)} MCap:${this.fmtK(mcap)}`;

                if (this.criteria.maxAgeMinutes && this.criteria.maxAgeMinutes > 0 && pair.pairCreatedAt) {
                    const ageMs = Date.now() - pair.pairCreatedAt;
                    const ageMinutes = ageMs / (1000 * 60);
                    if (ageMinutes > this.criteria.maxAgeMinutes) {
                        console.log(`[EVAL] ${sym} | ❌ REJECTED: Token is ${ageMinutes.toFixed(1)}m old (Max allowed: ${this.criteria.maxAgeMinutes}m)`);
                        continue;
                    }
                }

                if (!meetsVol5m) { rejectReasons.vol5m++; console.log(`[EVAL] ${tag} | ❌ VOL5M`); continue; }
                if (!meetsVol1h) { rejectReasons.vol1h++; console.log(`[EVAL] ${tag} | ❌ VOL1H`); continue; }
                if (!meetsVol24h) { rejectReasons.vol24h++; console.log(`[EVAL] ${tag} | ❌ VOL24H`); continue; }
                if (!meetsLiquidity) { rejectReasons.liquidity++; console.log(`[EVAL] ${tag} | ❌ LIQUIDITY`); continue; }
                if (!meetsMcap) { rejectReasons.mcap++; console.log(`[EVAL] ${tag} | ❌ MCAP`); continue; }

                const runnerAssessment = this.assessRunnerCandidate(
                    mintAddress,
                    volume5m,
                    volume1h,
                    liquidity,
                    mcap,
                    priceUSD,
                    pair.pairCreatedAt
                );
                if (this.criteria.enableRunnerMode && !runnerAssessment.meets) {
                    console.log(`[EVAL] ${tag} | ❌ RUNNER (${runnerAssessment.score}/100) ${runnerAssessment.reasons.join(", ")}`);
                    this.updateTokenSnapshot(mintAddress, volume5m, liquidity, priceUSD, mcap);
                    continue;
                }

                if (this.jupiterTokens.size > 0 && !this.jupiterTokens.has(mintAddress)) {
                    // High-liquidity tokens bypass Jupiter check — they're clearly established
                    if (liquidity >= 500_000) {
                        console.log(`[EVAL] ${tag} | ⚠️ NOT ON JUPITER (bypassed: high liq)`);
                    } else {
                        rejectReasons.jupiter++;
                        console.log(`[EVAL] ${tag} | ❌ NOT ON JUPITER`);
                        continue;
                    }
                }

                rejectReasons.accepted++;
                console.log(`[EVAL] ${tag} | ✅ QUALIFIED${this.criteria.enableRunnerMode ? ` | RUNNER ${runnerAssessment.score}/100` : ""}`);
                qualified.push({ pair, mintAddress, volume5m, volume1h, volume24h, liquidity, mcap, priceUSD, runnerScore: runnerAssessment.score, runnerReasons: runnerAssessment.reasons });
                this.updateTokenSnapshot(mintAddress, volume5m, liquidity, priceUSD, mcap);
            }

            // ── Log filter summary (to both console and frontend) ──
            const filterSummary = `[FILTER-SUMMARY] ${rejectReasons.accepted} qualified out of ${pairs.length}. Rejections: ${JSON.stringify(rejectReasons)}`;
            console.log(filterSummary);
            SocketManager.emitLog(filterSummary, "info");

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
                        `  ⚡ ${sym} | Vol5m: $${fmt(q.volume5m)} | Vol1h: $${fmt(q.volume1h)} | Vol24h: $${fmt(q.volume24h)} | Liq: $${fmt(q.liquidity)} | MCap: $${fmt(q.mcap)}${this.criteria.enableRunnerMode ? ` | Runner:${q.runnerScore}` : ""} | DEX: ${dex}`,
                        "info"
                    );
                }
            }

            // ═══════════════════════════════════════════════════════
            // EXECUTE — send all qualified to safety pipeline
            // Safety checks now use free APIs (RugCheck + GoPlus),
            // so there's no RPC cost limit.
            // ═══════════════════════════════════════════════════════
            const toExecute = this.criteria.enableRunnerMode
                ? [...qualified]
                    .sort((a, b) => b.runnerScore - a.runnerScore || b.liquidity - a.liquidity)
                    .slice(0, this.criteria.runnerTopCandidates || 3)
                : qualified;

            if (this.criteria.enableRunnerMode && toExecute.length > 0) {
                SocketManager.emitLog(`[RUNNER] Executing top ${toExecute.length}/${qualified.length} ranked candidates.`, "info");
            }

            for (const q of toExecute) {
                this.seenPairs.set(q.mintAddress, Date.now());
                await this.callback({
                    mint: new PublicKey(q.mintAddress),
                    pairAddress: q.pair.pairAddress,
                    dexId: q.pair.dexId || 'unknown',
                    volume5m: Number(q.volume5m),
                    volume1h: Number(q.volume1h),
                    volume24h: Number(q.volume24h),
                    liquidity: Number(q.liquidity),
                    mcap: Number(q.mcap),
                    symbol: q.pair.baseToken?.symbol || "TOKEN",
                    priceUsd: q.priceUSD,
                    source: q.pair.isMomentumPlay ? "SCOUT_MOMENTUM" : q.pair.source,
                    pairCreatedAt: q.pair.pairCreatedAt
                });
            }

            // Remaining tokens are NOT marked as seen — they re-qualify next sweep for their turn

            const nextIn = this.criteria.mode === "SCOUT" ? "10s" : "20s";
            const summaryMsg = qualified.length > 0
                ? `[SWEEP] ${qualified.length} matches found, ${toExecute.length} sent to safety check. Next sweep in ${nextIn}.`
                : `[ECOSYSTEM SWEEP COMPLETE] Next harvest in ${nextIn}.`;
            console.log(summaryMsg);
            SocketManager.emitLog(summaryMsg, "info");

        } catch (err: any) {
            const errMsg = `[HARVESTER ERROR] ${err.message}`;
            console.error(errMsg);
            SocketManager.emitLog(errMsg, "error");
        }
    }

    async evaluateToken(result: ScanResult): Promise<boolean> {
        if (!this.isRunning) return false;
        const mintAddress = result.mint.toBase58();

        // ── CONCURRENCY MUTEX ──
        // Webhooks often fire 3-4 times in the exact same millisecond from different nodes for the same pool.
        // We must lock the mint synchronously in memory before doing any async `this.seenPairs.get()` or DB calls.
        if (!this._processingMutex) this._processingMutex = new Set<string>();
        if (this._processingMutex.has(mintAddress)) {
            // Drop duplicate identical webhook instantly
            return false;
        }

        // Lock it
        this._processingMutex.add(mintAddress);

        try {
            const lastSeen = this.seenPairs.get(mintAddress);
            if (lastSeen && Date.now() - lastSeen < this.SEEN_COOLDOWN) return false;

            SocketManager.emitLog(`[FLASH-EVAL] Real-time check for ${result.symbol}...`, "info");

            if (this.isTickerUsed && this.isTickerUsed(result.symbol)) {
                SocketManager.emitLog(`[FLASH-REJECT] ${result.symbol} failed criteria: Duplicate Ticker`, "warning");
                return false;
            }

            // Max Age filter — reject tokens older than maxAgeMinutes
            if (this.criteria.maxAgeMinutes && this.criteria.maxAgeMinutes > 0 && result.pairCreatedAt) {
                const ageMinutes = (Date.now() - result.pairCreatedAt) / (1000 * 60);
                if (ageMinutes > this.criteria.maxAgeMinutes) {
                    console.log(`[FLASH-REJECT] ${result.symbol} too old: ${ageMinutes.toFixed(1)}m (max: ${this.criteria.maxAgeMinutes}m)`);
                    return false;
                }
            }

            // Flash evaluation should respect the same filters the frontend sends.
            const liquidity = result.liquidity || 0;
            const mcap = result.mcap || 0;
            const vol5m = result.volume5m || 0;
            const vol1h = result.volume1h || 0;

            const hasVol5mFilter = this.criteria.volume5m.min > 0 || this.criteria.volume5m.max > 0;
            const hasVol1hFilter = this.criteria.volume1h.min > 0 || this.criteria.volume1h.max > 0;

            const meetsLiq = this.inRange(liquidity, this.criteria.liquidity);
            const meetsMcap = this.inRange(mcap, { min: this.criteria.mcap.min * 0.5, max: this.criteria.mcap.max });
            const meetsVol5m = hasVol5mFilter ? this.inRange(vol5m, this.criteria.volume5m) : true;
            const meetsVol1h = hasVol1hFilter ? this.inRange(vol1h, this.criteria.volume1h) : true;
            const runnerAssessment = this.assessRunnerCandidate(
                mintAddress,
                vol5m,
                vol1h,
                liquidity,
                mcap,
                result.priceUsd || 0,
                result.pairCreatedAt
            );
            this.updateTokenSnapshot(mintAddress, vol5m, liquidity, result.priceUsd || 0, mcap);

            if (meetsLiq && meetsMcap && meetsVol5m && meetsVol1h && (!this.criteria.enableRunnerMode || runnerAssessment.meets)) {
                SocketManager.emitLog(`[FLASH-PASS] ${result.symbol} qualified via Flash Scout${this.criteria.enableRunnerMode ? ` | Runner ${runnerAssessment.score}/100` : ""}!`, "success");
                this.seenPairs.set(mintAddress, Date.now());
                await this.callback(result);
                return true;
            } else {
                console.log(`[FLASH-REJECT] ${result.symbol} failed real-time criteria (Vol5m:${meetsVol5m}, Vol1h:${meetsVol1h}, Liq:${meetsLiq}, Mcap:${meetsMcap}${this.criteria.enableRunnerMode ? `, Runner:${runnerAssessment.score}/100` : ""})`);
                return false;
            }
        } finally {
            // Always release the lock so the token can be re-evaluated later if needed
            this._processingMutex.delete(mintAddress);
        }
    }

    private updateTokenSnapshot(mintAddress: string, volume5m: number, liquidity: number, priceUsd: number, mcap: number) {
        this.tokenSnapshots.set(mintAddress, {
            volume5m,
            liquidity,
            priceUsd,
            mcap,
            ts: Date.now()
        });
    }

    private assessRunnerCandidate(
        mintAddress: string,
        volume5m: number,
        volume1h: number,
        liquidity: number,
        mcap: number,
        priceUsd: number,
        pairCreatedAt?: number
    ): RunnerAssessment {
        if (!this.criteria.enableRunnerMode) {
            return { score: 0, reasons: [], meets: true };
        }

        const reasons: string[] = [];
        let score = 0;

        const v5mToLiquidityPct = liquidity > 0 ? (volume5m / liquidity) * 100 : 0;
        const v5mTo1hPct = volume1h > 0 ? (volume5m / volume1h) * 100 : 0;

        if (v5mToLiquidityPct >= (this.criteria.runnerMin5mToLiquidityPct || 0)) score += 20;
        else reasons.push(`5m/liquidity ${v5mToLiquidityPct.toFixed(1)}%`);

        if (v5mTo1hPct >= (this.criteria.runnerMin5mTo1hPct || 0)) score += 20;
        else reasons.push(`5m/1h ${v5mTo1hPct.toFixed(1)}%`);

        if (liquidity >= Math.max(10000, this.criteria.liquidity.min)) score += 15;
        else reasons.push(`liq ${liquidity.toFixed(0)}`);

        if (mcap > 0 && (this.criteria.mcap.max === 0 || mcap <= this.criteria.mcap.max)) score += 10;

        if (pairCreatedAt) {
            const ageMinutes = (Date.now() - pairCreatedAt) / 60000;
            if (ageMinutes >= (this.criteria.runnerMinPairAgeMinutes || 0)) score += 10;
            else reasons.push(`age ${ageMinutes.toFixed(1)}m`);
        }

        const previous = this.tokenSnapshots.get(mintAddress);
        if (previous) {
            const priceChangePct = previous.priceUsd > 0 ? ((priceUsd - previous.priceUsd) / previous.priceUsd) * 100 : 0;
            const liquidityChangePct = previous.liquidity > 0 ? ((liquidity - previous.liquidity) / previous.liquidity) * 100 : 0;
            const volumeGrowthPct = previous.volume5m > 0 ? ((volume5m - previous.volume5m) / previous.volume5m) * 100 : 0;

            if (priceChangePct >= (this.criteria.runnerMinPriceChangePct || 0)) score += 15;
            else if ((this.criteria.runnerMinPriceChangePct || 0) > 0) reasons.push(`price ${priceChangePct.toFixed(1)}%`);

            if (liquidityChangePct >= (this.criteria.runnerMinLiquidityChangePct || 0)) score += 10;
            else if ((this.criteria.runnerMinLiquidityChangePct || 0) > 0) reasons.push(`liq change ${liquidityChangePct.toFixed(1)}%`);

            if (volumeGrowthPct > 0) score += 10;
            else reasons.push(`5m growth ${volumeGrowthPct.toFixed(1)}%`);
        } else {
            score += 10; // allow first-seen tokens to compete on raw structure
        }

        const meets = score >= (this.criteria.runnerMinScore || 0);
        return { score: Math.max(0, Math.min(100, Math.round(score))), reasons, meets };
    }

    private inRange(val: number, range: NumericRange) {
        const minMatch = Number(range.min) === 0 || val >= Number(range.min);
        const hasMax = Number(range.max) > 0;
        const maxMatch = !hasMax || val <= Number(range.max);
        return minMatch && maxMatch;
    }

    private fmtK(v: number) {
        return v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `$${(v / 1_000).toFixed(1)}K` : `$${v.toFixed(0)}`;
    }

    stop() {
        this.isRunning = false;
        console.log("LPPP BOT Sweeper Service Stopped.");
    }
}
