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

// Pagination state for rolling through the token profiles
let lastSeenProfileTimestamp = 0;

// Global rate limiter: enforce minimum 500ms between any two DexScreener API calls.
// DexScreener limits pairs endpoint to ~300 req/min; 500ms gap = max 120 req/min (well within limit).
let lastDsCallMs = 0;
const DS_MIN_DELAY_MS = 500;

async function dsRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - lastDsCallMs;
    if (elapsed < DS_MIN_DELAY_MS) {
        await new Promise(r => setTimeout(r, DS_MIN_DELAY_MS - elapsed));
    }
    lastDsCallMs = Date.now();
}

export class DexScreenerService {

    /**
     * Fetch trending/boosted tokens on Solana.
     * These are tokens with active boost orders — high attention, potential movers.
     * Returns up to ~100 tokens.
     */
    static async fetchBoostedTokens(): Promise<any[]> {
        try {
            await dsRateLimit();
            const res = await axios.get(`${DS_BASE}/token-boosts/top/v1`, { timeout: 8000 });
            if (!res.data || !Array.isArray(res.data)) return [];

            // Filter to Solana only and normalize to our pair format
            const solanaTokens = res.data.filter((t: any) => t.chainId === "solana");

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
            await dsRateLimit();
            const res = await axios.get(`${DS_BASE}/token-profiles/latest/v1`, { timeout: 8000 });
            if (!res.data || !Array.isArray(res.data)) return [];

            const solanaTokens = res.data.filter((t: any) => t.chainId === "solana");
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
        // DexScreener allows comma-separated addresses, max ~30 per request
        const batchSize = 30;

        for (let i = 0; i < tokenAddresses.length; i += batchSize) {
            const batch = tokenAddresses.slice(i, i + batchSize);
            const joined = batch.join(",");

            try {
                await dsRateLimit();
                const res = await axios.get(`${DS_BASE}/latest/dex/tokens/${joined}`, { timeout: 10000 });
                const pairs = res.data?.pairs || [];

                // DexScreener returns ALL pairs for each token. We want the best Solana pair per token.
                const bestByMint = new Map<string, any>();

                for (const pair of pairs) {
                    if (pair.chainId !== "solana") continue;

                    const mintAddr = pair.baseToken?.address;
                    if (!mintAddr) continue;

                    const existing = bestByMint.get(mintAddr);
                    const pairLiq = pair.liquidity?.usd || 0;
                    const existingLiq = existing?.liquidity?.usd || 0;

                    // Keep the pair with highest liquidity (more reliable pricing)
                    if (!existing || pairLiq > existingLiq) {
                        bestByMint.set(mintAddr, pair);
                    }
                }

                for (const pair of bestByMint.values()) {
                    results.push({
                        // Native DexScreener pair format — pairAddress is ALWAYS correct
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
                    });
                }
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
            await dsRateLimit();
            const res = await axios.get(`${DS_BASE}/latest/dex/search`, {
                params: { q: query },
                timeout: 8000
            });

            const pairs = res.data?.pairs || [];
            return pairs
                .filter((p: any) => p.chainId === "solana")
                .map((pair: any) => ({
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
                    liquidity: { usd: pair.liquidity?.usd || 0 },
                    marketCap: pair.marketCap || pair.fdv || 0,
                    source: "SEARCH"
                }));
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
            const res = await axios.get(`${DS_BASE}/latest/dex/tokens/${mintAddress}`, { timeout: 5000 });
            const pairs = res.data?.pairs || [];
            const solanaPair = pairs.find((p: any) => p.chainId === "solana" && (p.dexId === "raydium" || p.dexId === "orca"))
                || pairs.find((p: any) => p.chainId === "solana");
            return solanaPair?.pairAddress || null;
        } catch {
            return null;
        }
    }
}
