import axios from "axios";

export interface GeckoMetadata {
    id: string;
    symbol: string;
    name: string;
    description: string;
    links: {
        homepage: string[];
        twitter_screen_name: string;
        telegram_channel_identifier: string;
    };
    market_data: {
        current_price: { usd: number };
        market_cap: { usd: number };
        total_volume: { usd: number };
    };
}
export class GeckoService {
    private static BASE_URL = "https://api.coingecko.com/api/v3";
    private static cache = new Map<string, { data: GeckoMetadata; timestamp: number }>();
    private static CACHE_TTL = 60000; // 60 seconds

    /**
     * Fetches metadata for a token by its mint address (Solana contract).
     */
    static async getTokenMetadata(mint: string): Promise<GeckoMetadata | null> {
        const now = Date.now();
        const cached = this.cache.get(mint);
        if (cached && (now - cached.timestamp < this.CACHE_TTL)) {
            return cached.data;
        }

        try {
            // CoinGecko uses /coins/solana/contract/{contract_address} for Solana tokens
            const res = await axios.get(`${this.BASE_URL}/coins/solana/contract/${mint}`, { timeout: 10000 });

            if (res.data) {
                const metadata: GeckoMetadata = {
                    id: res.data.id,
                    symbol: res.data.symbol,
                    name: res.data.name,
                    description: res.data.description?.en || "",
                    links: {
                        homepage: res.data.links?.homepage || [],
                        twitter_screen_name: res.data.links?.twitter_screen_name || "",
                        telegram_channel_identifier: res.data.links?.telegram_channel_identifier || ""
                    },
                    market_data: {
                        current_price: res.data.market_data?.current_price || { usd: 0 },
                        market_cap: res.data.market_data?.market_cap || { usd: 0 },
                        total_volume: res.data.market_data?.total_volume || { usd: 0 }
                    }
                };

                // Update cache
                this.cache.set(mint, { data: metadata, timestamp: Date.now() });
                return metadata;
            }
            return null;
        } catch (error: any) {
            // Frequently fails for brand new tokens not yet listed on CoinGecko (centralized)
            // This is expected behavior for many sniped tokens.
            return null;
        }
    }
}
