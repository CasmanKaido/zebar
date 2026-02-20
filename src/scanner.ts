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

export type ScannerMode = "SCOUT" | "ANALYST";

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
    private geckoPage = 1;
    private readonly GECKO_PAGES_PER_SWEEP = 6;
    private readonly GECKO_MAX_PAGE = 10;

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

            // ── Track rejection reasons ──
            const rejectReasons = { noMint: 0, dedup: 0, stablecoin: 0, vol5m: 0, vol1h: 0, vol24h: 0, liquidity: 0, mcap: 0, jupiter: 0, accepted: 0 };

            for (const pair of pairs) {
                const mintAddress = pair.baseToken?.address;
                if (!mintAddress || IGNORED_MINTS.includes(mintAddress)) { rejectReasons.noMint++; continue; }

                const sym = pair.baseToken?.symbol || mintAddress.slice(0, 6);
                const dex = pair.dexId || "?";

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

                if (!meetsVol5m) { rejectReasons.vol5m++; console.log(`[EVAL] ${tag} | ❌ VOL5M`); continue; }
                if (!meetsVol1h) { rejectReasons.vol1h++; console.log(`[EVAL] ${tag} | ❌ VOL1H`); continue; }
                if (!meetsVol24h) { rejectReasons.vol24h++; console.log(`[EVAL] ${tag} | ❌ VOL24H`); continue; }
                if (!meetsLiquidity) { rejectReasons.liquidity++; console.log(`[EVAL] ${tag} | ❌ LIQUIDITY`); continue; }
                if (!meetsMcap) { rejectReasons.mcap++; console.log(`[EVAL] ${tag} | ❌ MCAP`); continue; }

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
                console.log(`[EVAL] ${tag} | ✅ QUALIFIED`);
                SocketManager.emitLog(`⚡ [PASS] ${sym} | Liq: ${this.fmtK(liquidity)} | Vol24h: ${this.fmtK(volume24h)}`, "success");
                qualified.push({ pair, mintAddress, volume5m, volume1h, volume24h, liquidity, mcap, priceUSD });
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
                        `  ⚡ ${sym} | Liq: $${fmt(q.liquidity)} | MCap: $${fmt(q.mcap)} | Vol1h: $${fmt(q.volume1h)} | Vol24h: $${fmt(q.volume24h)} | DEX: ${dex}`,
                        "info"
                    );
                }
            }

            // ═══════════════════════════════════════════════════════
            // EXECUTE — send all qualified to safety pipeline
            // Safety checks now use free APIs (RugCheck + GoPlus),
            // so there's no RPC cost limit.
            // ═══════════════════════════════════════════════════════
            const toExecute = qualified;

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
                    priceUsd: q.priceUSD,
                    source: q.pair.isMomentumPlay ? "SCOUT_MOMENTUM" : q.pair.source
                });
            }

            // Remaining tokens are NOT marked as seen — they re-qualify next sweep for their turn

            const summaryMsg = qualified.length > 0
                ? `[SWEEP] ${qualified.length} matches found, ${toExecute.length} sent to safety check. Next sweep in 20s.`
                : `[ECOSYSTEM SWEEP COMPLETE] Next harvest in 20s.`;
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
        const mintAddress = result.mint.toBase58();
        const lastSeen = this.seenPairs.get(mintAddress);
        if (lastSeen && Date.now() - lastSeen < this.SEEN_COOLDOWN) return;

        SocketManager.emitLog(`[FLASH-EVAL] Real-time check for ${result.symbol}...`, "info");

        // Use more lenient criteria for High-Priority Flash Evaluation
        const liquidity = result.liquidity || 0;
        const mcap = result.mcap || 0;
        const vol5m = (result as any).volume5m || 0;

        const meetsLiq = this.inRange(liquidity, this.criteria.liquidity);
        const meetsMcap = this.inRange(mcap, { min: this.criteria.mcap.min * 0.5, max: this.criteria.mcap.max }); // 50% discount on min mcap for fresh tokens
        const meetsMomentum = vol5m >= (this.criteria.volume5m.min * 2); // Must show immediate velocity

        if (meetsLiq && meetsMcap && (meetsMomentum || (result as any).volume1h > this.criteria.volume1h.min)) {
            SocketManager.emitLog(`[FLASH-PASS] ${result.symbol} qualified via Flash Scout!`, "success");
            this.seenPairs.set(mintAddress, Date.now());
            await this.callback(result);
        } else {
            console.log(`[FLASH-REJECT] ${result.symbol} failed real-time criteria (Liq:${meetsLiq}, Mcap:${meetsMcap}, Momentum:${meetsMomentum})`);
        }
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
