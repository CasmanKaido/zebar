import axios from "axios";
import { PublicKey } from "@solana/web3.js";
import { ScanResult } from "./scanner";
import { BIRDEYE_API_KEY } from "./config";

const BIRDEYE_BASE_URL = "https://public-api.birdeye.so/defi/v3/token/list/scroll";

export class BirdeyeService {
    /**
     * Fetches high-volume tokens from Birdeye API.
     * Uses the /v3/token/list/scroll endpoint for pagination.
     */
    static async fetchHighVolumeTokens(minVolume24h: number = 1000000): Promise<ScanResult[]> {
        if (!BIRDEYE_API_KEY) {
            console.warn("[BIRDEYE] API Key missing. Skipping scan.");
            return [];
        }

        const scanResults: ScanResult[] = [];
        let nextScrollId: string | null = null;
        const seenMints = new Set<string>();

        // We'll fetch up to 2 pages (100 tokens max) to stay within free tier limits
        // while getting good coverage. 50 tokens per page is standard.
        const MAX_PAGES = 2;

        try {
            for (let page = 0; page < MAX_PAGES; page++) {
                const params: any = {
                    sort_by: "volume_24h_usd",
                    sort_type: "desc",
                    min_volume_24h: minVolume24h,
                    offset: page * 50, // Birdeye uses offset/limit or scroll_id depending on endpoint version
                    limit: 50
                };

                // Use the correct header for Solana chain
                const headers = {
                    "X-API-KEY": BIRDEYE_API_KEY,
                    "x-chain": "solana",
                    "accept": "application/json"
                };

                // Using the specific endpoint found in research: /defi/v3/token/list/scroll
                // Note: Research suggested scroll_id usage. Let's try standard params for v3 scroll if available
                // or fallback to v1/v2 if needed. Documentation says v3 is robust.

                // Constructing URL for scroll endpoint requires scroll_id for subsequent requests
                // For the first request, we don't send scroll_id
                const requestUrl: string = nextScrollId
                    ? `${BIRDEYE_BASE_URL}?scroll_id=${nextScrollId}`
                    : `${BIRDEYE_BASE_URL}?sort_by=volume_24h_usd&sort_type=desc&min_volume_24h=${minVolume24h}`;

                const response = await axios.get(requestUrl, { headers, timeout: 5000 });

                if (!response.data?.success) break;

                const tokens = response.data.data?.items || [];
                nextScrollId = response.data.data?.next_scroll_id;

                for (const t of tokens) {
                    // Normalize to ScanResult
                    // Filter out stablecoins and wrapped SOL if not already handled by scanner
                    // Scanner does deduplication, but basic filtering here helps.
                    if (!t.address) continue;

                    if (seenMints.has(t.address)) continue;
                    seenMints.add(t.address);

                    scanResults.push({
                        mint: new PublicKey(t.address),
                        pairAddress: t.address, // Use mint as pairAddress for tracking purposes since Birdeye returns tokens not pairs
                        // Actually Scanner expects a pairAddress for the swap target. 
                        // Birdeye gives us the TOKEN. We can leave pairAddress empty and let the bot find the route via Jupiter.
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
