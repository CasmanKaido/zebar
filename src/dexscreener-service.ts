import axios from "axios";
import { SocketManager } from "./socket";

/**
 * DexScreener Service — Primary data source for ANALYST mode.
 * 
 * Advantages over Birdeye:
 * - Free (no API key)
 * - Always returns real pool/pair addresses (never just the token mint)
 * - Returns 5m, 1h, 6h, 24h volume in every response
 * - Includes liquidity, mcap, and DEX ID natively
 * 
 * Rate limits: ~300 req/min for pairs, ~60 req/min for profiles/boosts
 */

const DS_BASE = "https://api.dexscreener.com";
type DsPriority = "high" | "normal" | "low";
type DexPair = {
    pairAddress: string;
    baseToken: any;
    quoteToken: any;
    dexId: string;
    chainId: "solana";
    priceUsd: string;
    volume: { m5: number; h1: number; h6?: number; h24: number };
    liquidity: { usd: number };
    marketCap: number;
    source: string;
    pairCreatedAt?: number;
};

// Pagination state for rolling through the token profiles
let lastSeenProfileTimestamp = 0;

const DS_MIN_DELAY_MS = 900;
const DS_THROTTLE_DELAY_MS = 4000;
const DS_NEGATIVE_CACHE_MS = 20_000;
const DS_RESULT_CACHE_MS = 15_000;

interface QueueTask<T> {
    priority: DsPriority;
    run: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: any) => void;
}

class DexScreenerScheduler {
    private static queues: Record<DsPriority, QueueTask<any>[]> = { high: [], normal: [], low: [] };
    private static active = false;
    private static lastCallMs = 0;
    private static throttleUntil = 0;
    private static consecutive429s = 0;
    private static inFlightTokenLookups = new Map<string, Promise<DexPair[]>>();
    private static tokenResultCache = new Map<string, { ts: number; pairs: DexPair[] }>();
    private static negativeCache = new Map<string, number>();

    static isThrottled(): boolean {
        return Date.now() < this.throttleUntil;
    }

    static getThrottleState() {
        return {
            throttled: this.isThrottled(),
            throttleUntil: this.throttleUntil,
            queueDepth: this.queues.high.length + this.queues.normal.length + this.queues.low.length,
            consecutive429s: this.consecutive429s
        };
    }

    static getCachedTokenPairs(mint: string): DexPair[] | null {
        const cached = this.tokenResultCache.get(mint);
        if (cached && Date.now() - cached.ts < DS_RESULT_CACHE_MS) return cached.pairs;
        return null;
    }

    static markNegative(mint: string) {
        this.negativeCache.set(mint, Date.now() + DS_NEGATIVE_CACHE_MS);
    }

    static isNegativeCached(mint: string): boolean {
        const expiry = this.negativeCache.get(mint) || 0;
        if (expiry > Date.now()) return true;
        if (expiry) this.negativeCache.delete(mint);
        return false;
    }

    static getInflight(mint: string): Promise<DexPair[]> | null {
        return this.inFlightTokenLookups.get(mint) || null;
    }

    static setInflight(mint: string, promise: Promise<DexPair[]>) {
        this.inFlightTokenLookups.set(mint, promise);
        promise.finally(() => this.inFlightTokenLookups.delete(mint));
    }

    static cacheTokenResult(mint: string, pairs: DexPair[]) {
        this.tokenResultCache.set(mint, { ts: Date.now(), pairs });
        if (pairs.length > 0) this.negativeCache.delete(mint);
    }

    static enqueue<T>(priority: DsPriority, run: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.queues[priority].push({ priority, run, resolve, reject });
            this.pump().catch((err) => console.warn(`[DEXSCREENER] Scheduler pump failed: ${err.message}`));
        });
    }

    private static async pump() {
        if (this.active) return;
        this.active = true;

        try {
            while (true) {
                const task = this.nextTask();
                if (!task) break;

                await this.waitTurn();

                try {
                    const result = await task.run();
                    this.consecutive429s = 0;
                    task.resolve(result);
                } catch (err: any) {
                    if (err?.response?.status === 429) {
                        this.consecutive429s++;
                        const backoff = DS_THROTTLE_DELAY_MS * Math.min(this.consecutive429s, 5);
                        this.throttleUntil = Date.now() + backoff;
                        SocketManager.emitLog(`[DEXSCREENER] Rate limited. Backing off for ${(backoff / 1000).toFixed(0)}s.`, "warning");
                    }
                    task.reject(err);
                }
            }
        } finally {
            this.active = false;
        }
    }

    private static nextTask(): QueueTask<any> | undefined {
        return this.queues.high.shift() || this.queues.normal.shift() || this.queues.low.shift();
    }

    private static async waitTurn() {
        const now = Date.now();
        const minDelay = this.isThrottled() ? DS_THROTTLE_DELAY_MS : DS_MIN_DELAY_MS;
        const target = Math.max(this.lastCallMs + minDelay, this.throttleUntil);
        if (target > now) {
            await new Promise(r => setTimeout(r, target - now));
        }
        this.lastCallMs = Date.now();
        this.pruneCaches();
    }

    private static pruneCaches() {
        const now = Date.now();
        for (const [mint, cached] of this.tokenResultCache) {
            if (now - cached.ts > DS_RESULT_CACHE_MS) this.tokenResultCache.delete(mint);
        }
        for (const [mint, expiry] of this.negativeCache) {
            if (expiry <= now) this.negativeCache.delete(mint);
        }
    }
}

function normalizePair(pair: any, source: string): DexPair {
    return {
        pairAddress: pair.pairAddress,
        baseToken: pair.baseToken,
        quoteToken: pair.quoteToken,
        dexId: pair.dexId || "unknown",
        chainId: "solana",
        priceUsd: pair.priceUsd || "0",
        volume: {
            m5: pair.volume?.m5 || 0,
            h1: pair.volume?.h1 || 0,
            h6: pair.volume?.h6 || 0,
            h24: pair.volume?.h24 || 0
        },
        liquidity: {
            usd: pair.liquidity?.usd || 0
        },
        marketCap: pair.marketCap || pair.fdv || 0,
        source,
        pairCreatedAt: pair.pairCreatedAt || 0
    };
}

async function dsGet<T>(url: string, priority: DsPriority, options: { params?: any; timeout?: number } = {}): Promise<T> {
    return DexScreenerScheduler.enqueue(priority, async () => {
        const res = await axios.get(url, { timeout: options.timeout || 8000, params: options.params });
        return res.data as T;
    });
}

export class DexScreenerService {
    static isThrottled(): boolean {
        return DexScreenerScheduler.isThrottled();
    }

    static async fetchPairByAddress(pairAddress: string, source: string = "PAIR_LOOKUP"): Promise<DexPair | null> {
        if (!pairAddress) return null;

        try {
            const data = await dsGet<any>(`${DS_BASE}/latest/dex/pairs/solana/${pairAddress}`, "high", { timeout: 10000 });
            const pairs = data?.pair ? [data.pair] : Array.isArray(data?.pairs) ? data.pairs : [];
            const solanaPair = pairs.find((pair: any) => pair?.chainId === "solana" && pair?.pairAddress === pairAddress)
                || pairs.find((pair: any) => pair?.chainId === "solana");

            if (!solanaPair) return null;
            return normalizePair(solanaPair, source);
        } catch (err: any) {
            console.warn(`[DEXSCREENER] Pair lookup failed for ${pairAddress.slice(0, 8)}...: ${err.message}`);
            return null;
        }
    }

    /**
     * Fetch trending/boosted tokens on Solana.
     * These are tokens with active boost orders — high attention, potential movers.
     * Returns up to ~100 tokens.
     */
    static async fetchBoostedTokens(): Promise<any[]> {
        try {
            if (DexScreenerScheduler.isThrottled()) return [];
            const data = await dsGet<any[]>(`${DS_BASE}/token-boosts/top/v1`, "low");
            if (!data || !Array.isArray(data)) return [];

            // Filter to Solana only and normalize to our pair format
            const solanaTokens = data.filter((t: any) => t.chainId === "solana");

            // Now look up pair data for these tokens (batch of up to 30)
            const tokenAddresses = solanaTokens.map((t: any) => t.tokenAddress).slice(0, 30);
            if (tokenAddresses.length === 0) return [];

            return await DexScreenerService.batchLookupTokens(tokenAddresses, "TRENDING");
        } catch (err: any) {
            console.warn(`[DEXSCREENER] Boosted tokens fetch failed: ${err.message}`);
            return [];
        }
    }

    /**
     * Fetch latest token profiles on Solana.
     * These are newly created token profiles — similar to "just launched."
     */
    static async fetchLatestProfiles(): Promise<any[]> {
        try {
            if (DexScreenerScheduler.isThrottled()) return [];
            const data = await dsGet<any[]>(`${DS_BASE}/token-profiles/latest/v1`, "low");
            if (!data || !Array.isArray(data)) return [];

            const solanaTokens = data.filter((t: any) => t.chainId === "solana");
            const tokenAddresses = solanaTokens.map((t: any) => t.tokenAddress).slice(0, 30);
            if (tokenAddresses.length === 0) return [];

            return await DexScreenerService.batchLookupTokens(tokenAddresses, "PROFILES");
        } catch (err: any) {
            console.warn(`[DEXSCREENER] Latest profiles fetch failed: ${err.message}`);
            return [];
        }
    }

    /**
     * Batch lookup token pairs from DexScreener.
     * GET /latest/dex/tokens/{addr1,addr2,...} — up to 30 at once.
     * Returns full pair data with pairAddress, volume, liquidity, mcap.
     */
    static async batchLookupTokens(tokenAddresses: string[], source: string = "BASELINE"): Promise<any[]> {
        const results: any[] = [];
        const unique = [...new Set(tokenAddresses.filter(Boolean))];
        const cached: string[] = [];
        const needsFetch: string[] = [];

        for (const mint of unique) {
            const hit = DexScreenerScheduler.getCachedTokenPairs(mint);
            if (hit) {
                results.push(...hit.map(pair => ({ ...pair, source })));
                cached.push(mint);
                continue;
            }
            if (DexScreenerScheduler.isNegativeCached(mint)) continue;
            needsFetch.push(mint);
        }

        const singleInflight = unique.length === 1 ? DexScreenerScheduler.getInflight(unique[0]) : null;
        if (singleInflight) {
            const inflightPairs = await singleInflight;
            return inflightPairs.map(pair => ({ ...pair, source }));
        }

        // DexScreener allows comma-separated addresses, max ~30 per request
        const batchSize = 30;
        const priority: DsPriority = source.includes("HELIUS") || source.includes("FLASH") ? "high" : source.includes("SCOUT") ? "normal" : "low";

        for (let i = 0; i < needsFetch.length; i += batchSize) {
            const batch = needsFetch.slice(i, i + batchSize);
            const joined = batch.join(",");

            const lookupPromise = (async () => {
                try {
                    const data = await dsGet<any>(`${DS_BASE}/latest/dex/tokens/${joined}`, priority, { timeout: 10000 });
                    const pairs = data?.pairs || [];

                    // DexScreener returns ALL pairs for each token. We want the best Solana pair per token.
                    const bestByMint = new Map<string, DexPair>();

                    for (const pair of pairs) {
                        if (pair.chainId !== "solana") continue;

                        const mintAddr = pair.baseToken?.address;
                        if (!mintAddr) continue;

                        const existing = bestByMint.get(mintAddr);
                        const pairLiq = pair.liquidity?.usd || 0;
                        const existingLiq = existing?.liquidity?.usd || 0;

                        if (!existing || pairLiq > existingLiq) {
                            bestByMint.set(mintAddr, normalizePair(pair, source));
                        }
                    }

                    for (const mint of batch) {
                        const pair = bestByMint.get(mint);
                        if (pair) {
                            DexScreenerScheduler.cacheTokenResult(mint, [pair]);
                        } else {
                            DexScreenerScheduler.markNegative(mint);
                        }
                    }

                    return batch.flatMap((mint) => {
                        const cachedPair = DexScreenerScheduler.getCachedTokenPairs(mint) || [];
                        return cachedPair.map(pair => ({ ...pair, source }));
                    });
                } catch (err: any) {
                    if (batch.length === 1) DexScreenerScheduler.markNegative(batch[0]);
                    throw err;
                }
            })();

            if (batch.length === 1) {
                DexScreenerScheduler.setInflight(batch[0], lookupPromise as Promise<DexPair[]>);
            }

            try {
                const batchResults = await lookupPromise;
                results.push(...batchResults);
            } catch (err: any) {
                console.warn(`[DEXSCREENER] Batch lookup failed for ${batch.length} tokens: ${err.message}`);
            }
        }

        return results;
    }

    /**
     * Search DexScreener for Solana pairs matching a query.
     * Useful for finding specific tokens or categories.
     * Returns up to 30 pairs per call.
     */
    static async searchPairs(query: string): Promise<any[]> {
        try {
            const data = await dsGet<any>(`${DS_BASE}/latest/dex/search`, "low", {
                params: { q: query },
                timeout: 8000
            });

            const pairs = data?.pairs || [];
            return pairs
                .filter((p: any) => p.chainId === "solana")
                .map((pair: any) => normalizePair(pair, "SEARCH"));
        } catch (err: any) {
            console.warn(`[DEXSCREENER] Search failed: ${err.message}`);
            return [];
        }
    }

    /**
     * Resolve a single token mint to its best DexScreener pair.
     * Used when we only have a mint address from Birdeye.
     */
    static async resolvePair(mintAddress: string): Promise<string | null> {
        try {
            const pairs = await DexScreenerService.batchLookupTokens([mintAddress], "RESOLVE_PAIR");
            const solanaPair = pairs.find((p: any) => p.chainId === "solana" && (p.dexId === "raydium" || p.dexId === "orca"))
                || pairs.find((p: any) => p.chainId === "solana");
            return solanaPair?.pairAddress || null;
        } catch {
            return null;
        }
    }

    /**
     * GeckoTerminal: Fetch brand new pools on Solana.
     * /api/v2/networks/solana/new_pools — returns pools sorted by creation time (newest first).
     * Great for catching Pump.fun graduations and fresh launches.
     */
    static async fetchGeckoNewPools(): Promise<any[]> {
        try {
            const res = await axios.get(
                "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1",
                { timeout: 8000 }
            );

            if (!res.data?.data || !Array.isArray(res.data.data)) return [];

            return res.data.data.map((p: any) => ({
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
                pairCreatedAt: p.attributes?.pool_created_at ? new Date(p.attributes.pool_created_at).getTime() : 0,
                source: "GECKO_NEW"
            }));
        } catch (err: any) {
            console.warn(`[GECKO] New pools fetch failed: ${err.message}`);
            return [];
        }
    }

    /**
     * Raydium API: Fetch standard AMM pools sorted by liquidity.
     * Useful for catching recently graduated Pump.fun tokens on Raydium.
     * Returns mint addresses for batch resolution via DexScreener.
     */
    static async fetchRaydiumNewMints(): Promise<string[]> {
        try {
            const res = await axios.get(
                "https://api-v3.raydium.io/pools/info/list?poolType=standard&poolSortField=liquidity&sortType=desc&pageSize=50&page=1",
                { timeout: 8000 }
            );

            if (!res.data?.success) return [];

            const pools = res.data.data?.data || [];
            const SOL = "So11111111111111111111111111111111111111112";
            const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
            const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
            const stables = new Set([SOL, USDC, USDT]);

            const mints: string[] = [];
            for (const p of pools) {
                const mintA = p.mintA?.address;
                const mintB = p.mintB?.address;
                // Extract the non-SOL/stablecoin side
                if (mintA && !stables.has(mintA)) mints.push(mintA);
                else if (mintB && !stables.has(mintB)) mints.push(mintB);
            }
            return [...new Set(mints)];
        } catch (err: any) {
            console.warn(`[RAYDIUM] Pool list fetch failed: ${err.message}`);
            return [];
        }
    }
}
