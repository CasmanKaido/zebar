import axios from "axios";

export interface JupiterPrice {
    usdPrice: number;
    decimals: number;
    priceChange24h?: number;
}

export type JupiterPriceResponse = Record<string, JupiterPrice> | { data: Record<string, JupiterPrice> };

export class JupiterPriceService {
    private static BASE_URL = "https://api.jup.ag/price/v3";
    private static cache = new Map<string, { price: number; timestamp: number }>();
    private static CACHE_TTL = 15000; // 15 seconds (reduced for more real-time prices)
    private static failureCount = 0;
    private static cooldownUntil = 0;
    private static MAX_IDS_PER_REQUEST = 80;

    /**
     * Fetches USD prices for multiple mints from Jupiter V2 API.
     * @param mints Array of mint addresses
     * @returns Map of mint address to USD price
     */
    static async getPrices(mints: string[]): Promise<Map<string, number>> {
        const results = new Map<string, number>();
        const now = Date.now();
        const toFetch: string[] = [];

        // 1. Check Cache
        for (const mint of mints) {
            const cached = this.cache.get(mint);
            if (cached && (now - cached.timestamp < this.CACHE_TTL)) {
                results.set(mint, cached.price);
            } else {
                toFetch.push(mint);
            }
        }

        if (toFetch.length === 0) return results;
        if (now < this.cooldownUntil) return results;

        try {
            const headers: Record<string, string> = {};
            if (process.env.JUPITER_API_KEY) {
                headers["x-api-key"] = process.env.JUPITER_API_KEY;
            }

            for (let i = 0; i < toFetch.length; i += this.MAX_IDS_PER_REQUEST) {
                const batch = toFetch.slice(i, i + this.MAX_IDS_PER_REQUEST);
                const response = await axios.get<any>(this.BASE_URL, {
                    params: {
                        ids: batch.join(",")
                    },
                    timeout: 5000,
                    headers
                });

                // Handle both { data: { ... } } and direct { ... } response formats
                const priceMap = response.data?.data || response.data;

                if (priceMap) {
                    for (const mint of batch) {
                        const priceData = priceMap[mint];
                        if (priceData) {
                            const priceVal = priceData.price ?? priceData.usdPrice;
                            if (priceVal !== undefined) {
                                const price = typeof priceVal === "string" ? parseFloat(priceVal) : priceVal;
                                results.set(mint, price);
                                this.cache.set(mint, { price, timestamp: now });
                            }
                        }
                    }
                }
            }
            this.failureCount = 0;
            this.cooldownUntil = 0;
        } catch (error: any) {
            console.error(`[JUPITER-PRICE-V3] Fetch failed: ${error.message} (URL: ${this.BASE_URL})`);
            this.failureCount++;
            const cooldownMs = Math.min(15000 * this.failureCount, 120000);
            this.cooldownUntil = Date.now() + cooldownMs;
        }

        return results;
    }

    /**
     * Single mint helper
     */
    static async getPrice(mint: string): Promise<number> {
        const prices = await this.getPrices([mint]);
        return prices.get(mint) || 0;
    }
}
