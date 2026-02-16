import axios from "axios";
import { PublicKey } from "@solana/web3.js";
import { ScanResult, ScannerCriteria } from "./scanner";
import { BIRDEYE_API_KEY } from "./config";

const BIRDEYE_BASE_URL = "https://public-api.birdeye.so/defi/v3/token/list/scroll";
const BIRDEYE_NEW_LISTING_URL = "https://public-api.birdeye.so/defi/v2/tokens/new_listing";

export class BirdeyeService {
    static isEnabled = true;

    /**
     * Fetches high-volume tokens from Birdeye API using the frontend's filter criteria.
     * Uses the /v3/token/list/scroll endpoint for pagination.
     */
    static async fetchHighVolumeTokens(criteria: ScannerCriteria): Promise<ScanResult[]> {
        if (!BIRDEYE_API_KEY || !this.isEnabled) {
            if (!this.isEnabled) return [];
            console.warn("[BIRDEYE] API Key missing. Skipping scan.");
            return [];
        }

        const apiKey: string = BIRDEYE_API_KEY as string;
        console.log(`[BIRDEYE] Starting market-wide scan... (API Key: ${apiKey.slice(0, 4)}****)`);

        const scanResults: ScanResult[] = [];
        let nextScrollId: string | null = null;
        const seenMints = new Set<string>();

        // Limit pages to stay within plan limits. Lite plan can handle much more.
        const MAX_PAGES = Number(process.env.BIRDEYE_MAX_PAGES) || 15;
        const REQUEST_DELAY = 200; // 200ms delay for Lite Tier (Safe & Fast)

        try {
            let page = 0;
            while (page < MAX_PAGES) {
                const headers = {
                    "X-API-KEY": apiKey,
                    "x-chain": "solana",
                    "accept": "application/json"
                };

                const queryParts: string[] = [
                    `sort_by=volume_24h_usd`,
                    `sort_type=desc`,
                    `offset=${page * 50}`, // Manual pagination if scroll is slow
                    `limit=50`
                ];

                if (criteria.volume1h.min > 0) queryParts.push(`min_volume_1h=${criteria.volume1h.min}`);
                if (criteria.volume24h.min > 0) queryParts.push(`min_volume_24h=${criteria.volume24h.min}`);
                if (criteria.liquidity.min > 0) queryParts.push(`min_liquidity=${criteria.liquidity.min}`);
                if (criteria.mcap.min > 0) queryParts.push(`min_market_cap=${criteria.mcap.min}`);

                const requestUrl: string = nextScrollId
                    ? `${BIRDEYE_BASE_URL}?scroll_id=${nextScrollId}`
                    : `https://public-api.birdeye.so/defi/v3/token/list?${queryParts.join("&")}`;

                let response;
                try {
                    response = await axios.get(requestUrl, { headers, timeout: 5000 });
                } catch (err: any) {
                    if (err.response?.status === 401 || err.response?.status === 403) {
                        console.error("[BIRDEYE] API Key Invalid/Suspended. Check Lite Plan status.");
                        this.isEnabled = false;
                        setTimeout(() => { this.isEnabled = true; }, 10 * 60 * 1000);
                    }
                    console.warn(`[BIRDEYE] Fetch error: ${err.message}`);
                    break;
                }

                if (!response || !response.data?.success) break;

                const tokens = response.data.data?.items || [];
                nextScrollId = response.data.data?.next_scroll_id;

                if (tokens.length > 0) {
                    console.log(`[BIRDEYE PRO] Page ${page + 1}: Found ${tokens.length} tokens.`);
                }

                for (const t of tokens) {
                    if (!t.address) continue;
                    if (seenMints.has(t.address)) continue;
                    seenMints.add(t.address);

                    scanResults.push({
                        mint: new PublicKey(t.address),
                        pairAddress: t.address,
                        dexId: "birdeye",
                        volume24h: t.volume_24h_usd || t.v24hUSD || 0,
                        liquidity: t.liquidity || 0,
                        mcap: t.mc || t.market_cap || t.fdv || 0,
                        symbol: t.symbol || "UNKNOWN",
                        priceUsd: t.price || 0
                    });
                }

                if (!nextScrollId && page > 5) break; // Exit if no more and we've searched deep enough

                // Stagger requests
                page++;
            }
            return scanResults;
        }
        catch (error: any) {
            console.warn(`[BIRDEYE] Fetch failed: ${error.message} - ${JSON.stringify(error.response?.data || {})}`);
            return [];
        }
    }

    /**
     * SCOUT ENGINE: Fetches newly listed tokens.
     * Target: /defi/v2/tokens/new_listing
     */
    static async fetchNewListings(criteria: ScannerCriteria): Promise<ScanResult[]> {
        if (!BIRDEYE_API_KEY || !this.isEnabled) return [];

        const apiKey: string = BIRDEYE_API_KEY as string;
        try {
            const headers = {
                "X-API-KEY": apiKey,
                "x-chain": "solana",
                "accept": "application/json"
            };

            // Birdeye V2 New Listing allows min_liquidity directly
            const params = new URLSearchParams({
                meme_platform_enabled: "true",
                min_liquidity: (criteria.liquidity.min || 100).toString(),
                limit: "50"
            });

            const response = await axios.get(`https://public-api.birdeye.so/defi/v2/tokens/new_listing?${params}`, { headers, timeout: 5000 });

            if (!response.data?.success) return [];

            const tokens = response.data.data?.items || [];
            return tokens.map((t: any) => ({
                mint: new PublicKey(t.address),
                pairAddress: t.address,
                dexId: "birdeye-new",
                volume24h: t.v24hUSD || t.volume_24h_usd || 0,
                liquidity: t.liquidity || 0,
                mcap: t.mc || t.market_cap || 0,
                symbol: t.symbol || "NEW",
                priceUsd: t.price || 0
            }));
        } catch (e: any) {
            console.warn(`[BIRDEYE-SCOUT] Error: ${e.message}`);
            return [];
        }
    }

    /**
     * ANALYST ENGINE: Fetches trending tokens based on market heat.
     * Target: /defi/token_trending
     */
    static async fetchTrendingTokens(criteria: ScannerCriteria): Promise<ScanResult[]> {
        if (!BIRDEYE_API_KEY || !this.isEnabled) return [];

        const apiKey: string = BIRDEYE_API_KEY as string;
        try {
            const headers = {
                "X-API-KEY": apiKey,
                "x-chain": "solana",
                "accept": "application/json"
            };

            const params = new URLSearchParams({
                sort_by: "rank",
                sort_type: "asc",
                limit: "20"
            });

            const response = await axios.get(`https://public-api.birdeye.so/defi/token_trending?${params}`, { headers, timeout: 5000 });

            if (!response.data?.success) return [];

            const tokens = response.data.data?.tokens || [];
            return tokens.map((t: any) => ({
                mint: new PublicKey(t.address),
                pairAddress: t.address,
                dexId: "birdeye-trending",
                volume24h: t.v24hUSD || 0,
                liquidity: t.liquidity || 0,
                mcap: t.mc || 0,
                symbol: t.symbol || "HOT",
                priceUsd: t.price || 0
            }));
        } catch (e: any) {
            console.warn(`[BIRDEYE-ANALYST] Error: ${e.message}`);
            return [];
        }
    }
}
