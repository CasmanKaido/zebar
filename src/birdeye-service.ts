import axios from "axios";
import { PublicKey } from "@solana/web3.js";
import { ScanResult, ScannerCriteria } from "./scanner";
import { BIRDEYE_API_KEY } from "./config";

const BIRDEYE_BASE_URL = "https://public-api.birdeye.so/defi/v3/token/list/scroll";
const BIRDEYE_NEW_LISTING_URL = "https://public-api.birdeye.so/defi/v2/tokens/new_listing";

export class BirdeyeService {
    /**
     * Fetches high-volume tokens from Birdeye API using the frontend's filter criteria.
     * Uses the /v3/token/list/scroll endpoint for pagination.
     */
    static async fetchHighVolumeTokens(criteria: ScannerCriteria): Promise<ScanResult[]> {
        if (!BIRDEYE_API_KEY) {
            console.warn("[BIRDEYE] API Key missing. Skipping scan.");
            return [];
        }

        const scanResults: ScanResult[] = [];
        let nextScrollId: string | null = null;
        const seenMints = new Set<string>();

        // Limit pages to stay within free tier limits. 0 = Infinite.
        const MAX_PAGES = Number(process.env.BIRDEYE_MAX_PAGES) || 0;
        const REQUEST_DELAY = 1500; // 1.5s delay to avoid rate limits

        try {
            let page = 0;
            while (MAX_PAGES === 0 || page < MAX_PAGES) {
                const headers = {
                    "X-API-KEY": BIRDEYE_API_KEY,
                    "x-chain": "solana",
                    "accept": "application/json"
                };

                const queryParts: string[] = [
                    `sort_by=volume_24h_usd`,
                    `sort_type=desc`,
                ];

                if (criteria.volume1h.min > 0) queryParts.push(`min_volume_1h=${criteria.volume1h.min}`);
                if (criteria.volume24h.min > 0) queryParts.push(`min_volume_24h=${criteria.volume24h.min}`);
                if (criteria.liquidity.min > 0) queryParts.push(`min_liquidity=${criteria.liquidity.min}`);
                if (criteria.mcap.min > 0) queryParts.push(`min_market_cap=${criteria.mcap.min}`);

                const requestUrl: string = nextScrollId
                    ? `${BIRDEYE_BASE_URL}?scroll_id=${nextScrollId}`
                    : `${BIRDEYE_BASE_URL}?${queryParts.join("&")}`;

                let response;
                let retries = 0;
                const maxRetries = 5;

                // Retry loop for Rate Limits (429)
                while (retries < maxRetries) {
                    try {
                        response = await axios.get(requestUrl, { headers, timeout: 5000 });
                        break; // Success!
                    } catch (err: any) {
                        if (err.response?.status === 429) {
                            retries++;
                            const backoff = Math.pow(2, retries) * 2000; // 4s, 8s, 16s...
                            console.warn(`[BIRDEYE] Rate limited (429). Retrying in ${backoff / 1000}s... (Attempt ${retries}/${maxRetries})`);
                            await new Promise(r => setTimeout(r, backoff));
                            continue;
                        }
                        throw err; // Real error
                    }
                }

                if (!response || !response.data?.success) break;

                const tokens = response.data.data?.items || [];
                nextScrollId = response.data.data?.next_scroll_id;

                if (tokens.length > 0) {
                    console.log(`[BIRDEYE] Page ${page + 1}: Found ${tokens.length} tokens.`);
                }

                for (const t of tokens) {
                    if (!t.address) continue;
                    if (seenMints.has(t.address)) continue;
                    seenMints.add(t.address);

                    scanResults.push({
                        mint: new PublicKey(t.address),
                        pairAddress: t.address,
                        dexId: "birdeye",
                        volume24h: t.volume_24h_usd || 0,
                        liquidity: t.liquidity || 0,
                        mcap: t.mc || t.fdv || 0,
                        symbol: t.symbol || "UNKNOWN",
                        priceUsd: t.price || 0
                    });
                }

                if (!nextScrollId) break;

                // Stagger requests
                page++;
                await new Promise(r => setTimeout(r, REQUEST_DELAY));
            }
        } catch (error: any) {
            console.warn(`[BIRDEYE] Fetch failed: ${error.message} - ${JSON.stringify(error.response?.data || {})}`);
        }

        return scanResults;
    }

    /**
     * Fetches brand new token listings (inc. Pump.fun, Moonshot).
     * This captures tokens that might not have high volume yet but are "fresh".
     */
    static async fetchNewTokenListings(limit: number = 20): Promise<ScanResult[]> {
        if (!BIRDEYE_API_KEY) return [];

        const scanResults: ScanResult[] = [];
        try {
            const response = await axios.get(BIRDEYE_NEW_LISTING_URL, {
                headers: {
                    "X-API-KEY": BIRDEYE_API_KEY,
                    "x-chain": "solana",
                    "accept": "application/json"
                },
                params: {
                    limit,
                    meme_platform_enabled: true // Explicitly enable meme platforms
                },
                timeout: 5000
            });

            if (response.data?.success) {
                const items = response.data.data.items || [];
                for (const t of items) {
                    if (!t.address) continue;
                    scanResults.push({
                        mint: new PublicKey(t.address),
                        pairAddress: t.address, // New listings might not have a pair yet, use mint as placeholder
                        dexId: "birdeye-new",
                        volume24h: t.volume_24h_usd || 0,
                        liquidity: t.liquidity || 0,
                        mcap: t.fdv || 0, // FDV often better proxy for new tokens
                        symbol: t.symbol || "NEW",
                        priceUsd: t.price || 0
                    });
                }
                if (items.length > 0) {
                    console.log(`[BIRDEYE] Found ${items.length} NEWLY LISTED tokens.`);
                }
            }

        } catch (error: any) {
            console.warn(`[BIRDEYE] New Listing Fetch failed: ${error.message} - ${JSON.stringify(error.response?.data || {})}`);
        }
        return scanResults;
    }
}
