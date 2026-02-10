import axios from "axios";
import { PublicKey } from "@solana/web3.js";
import { ScanResult, ScannerCriteria } from "./scanner";
import { BIRDEYE_API_KEY } from "./config";

const BIRDEYE_BASE_URL = "https://public-api.birdeye.so/defi/v3/token/list/scroll";

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

        // Fetch up to 2 pages (100 tokens max) to stay within free tier limits
        const MAX_PAGES = 2;

        try {
            for (let page = 0; page < MAX_PAGES; page++) {
                const headers = {
                    "X-API-KEY": BIRDEYE_API_KEY,
                    "x-chain": "solana",
                    "accept": "application/json"
                };

                // Build query params from frontend criteria
                // Birdeye supports: min_volume_1h, min_volume_24h, min_liquidity, min_market_cap
                const queryParts: string[] = [
                    `sort_by=volume_24h_usd`,
                    `sort_type=desc`,
                ];

                if (criteria.minVolume1h > 0) queryParts.push(`min_volume_1h=${criteria.minVolume1h}`);
                if (criteria.minVolume24h > 0) queryParts.push(`min_volume_24h=${criteria.minVolume24h}`);
                if (criteria.minLiquidity > 0) queryParts.push(`min_liquidity=${criteria.minLiquidity}`);
                if (criteria.minMcap > 0) queryParts.push(`min_market_cap=${criteria.minMcap}`);

                // For scroll: first request uses filters, subsequent use scroll_id only
                const requestUrl: string = nextScrollId
                    ? `${BIRDEYE_BASE_URL}?scroll_id=${nextScrollId}`
                    : `${BIRDEYE_BASE_URL}?${queryParts.join("&")}`;

                const response = await axios.get(requestUrl, { headers, timeout: 5000 });

                if (!response.data?.success) break;

                const tokens = response.data.data?.items || [];
                nextScrollId = response.data.data?.next_scroll_id;

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
            }
        } catch (error: any) {
            console.warn(`[BIRDEYE] Fetch failed: ${error.message}`);
        }

        return scanResults;
    }
}
