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

    /**
     * Fetches metadata for a token by its mint address (Solana contract).
     */
    static async getTokenMetadata(mint: string): Promise<GeckoMetadata | null> {
        try {
            // CoinGecko uses /coins/solana/contract/{contract_address} for Solana tokens
            const res = await axios.get(`${this.BASE_URL}/coins/solana/contract/${mint}`, { timeout: 10000 });

            if (res.data) {
                return {
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
            }
            return null;
        } catch (error: any) {
            // Frequently fails for brand new tokens not yet listed on CoinGecko (centralized)
            // This is expected behavior for many sniped tokens.
            return null;
        }
    }
}
