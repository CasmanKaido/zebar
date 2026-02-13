import axios from "axios";

export interface JupiterPrice {
    usdPrice: number;
    decimals: number;
    liquidity?: number;
}

export type JupiterPriceResponse = Record<string, JupiterPrice>;

export class JupiterPriceService {
    private static BASE_URL = "https://lite-api.jup.ag/price/v3";
    private static cache = new Map<string, { price: number; timestamp: number }>();
    private static CACHE_TTL = 30000; // 30 seconds

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

        try {
            // 2. Fetch from Jupiter
            const ids = toFetch.join(",");
            const headers: Record<string, string> = {};
            if (process.env.JUPITER_API_KEY) {
                headers["x-api-key"] = process.env.JUPITER_API_KEY;
            }

            const response = await axios.get<JupiterPriceResponse>(`${this.BASE_URL}?ids=${ids}`, {
                timeout: 5000,
                headers
            });

            if (response.data) {
                for (const mint of toFetch) {
                    const priceData = response.data[mint];
                    if (priceData && priceData.usdPrice !== undefined) {
                        const price = priceData.usdPrice;
                        results.set(mint, price);
                        this.cache.set(mint, { price, timestamp: now });
                    }
                }
            }
        } catch (error: any) {
            console.error(`[JUPITER-PRICE-V3] Fetch failed: ${error.message}`);
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
