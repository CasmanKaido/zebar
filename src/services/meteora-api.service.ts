import axios from 'axios';

interface UnclaimedFee {
    onchain_timestamp: number;
    pair_address: string;
    position_address: string;
    token_x_amount: string;
    token_y_amount: string;
    token_x_usd_amount: string;
    token_y_usd_amount: string;
    tx_id: string;
}

export class MeteoraApiService {
    private static BASE_URL = 'https://dlmm-api.meteora.ag';

    /**
     * Fetch unclaimed fees for a specific position from Meteora DLMM API.
     * Endpoint: /position/{position_address}/claim_fees
     */
    static async getUnclaimedFees(positionAddress: string): Promise<{ feeX: number, feeY: number, feeXUsd: number, feeYUsd: number }> {
        if (!positionAddress) return { feeX: 0, feeY: 0, feeXUsd: 0, feeYUsd: 0 };

        try {
            const url = `${this.BASE_URL}/position/${positionAddress}/claim_fees`;
            // console.log(`[METEORA API] Fetching fees from: ${url}`);

            const response = await axios.get<UnclaimedFee[]>(url, { timeout: 5000 });

            if (response.data && Array.isArray(response.data) && response.data.length > 0) {
                // Sum up fees if multiple entries exist (though usually one per position)
                let totalFeeX = 0;
                let totalFeeY = 0;
                let totalFeeXUsd = 0;
                let totalFeeYUsd = 0;

                for (const fee of response.data) {
                    totalFeeX += Number(fee.token_x_amount || 0);
                    totalFeeY += Number(fee.token_y_amount || 0);
                    totalFeeXUsd += Number(fee.token_x_usd_amount || 0);
                    totalFeeYUsd += Number(fee.token_y_usd_amount || 0);
                }

                // API returns raw amounts? No, amount is likely decimal string?
                // Documentation says "token_x_amount". Let's assume it matches the UI (human readable)
                // Wait, typically APIs return RAW amounts (lamports) or decimal.
                // Given "token_x_usd_amount" is "5.20", it's likely human-readable decimals.
                // But let's verify. If token_x_amount is "1000000" for USDC (6 decimals), that's 1 USDC.
                // We will return pure numbers and let the strategy decide scaling if needed.
                // Actually, if we get USD, that's even better for ROI.

                return {
                    feeX: totalFeeX,
                    feeY: totalFeeY,
                    feeXUsd: totalFeeXUsd,
                    feeYUsd: totalFeeYUsd
                };
            }
            return { feeX: 0, feeY: 0, feeXUsd: 0, feeYUsd: 0 };
        } catch (error: any) {
            // console.warn(`[METEORA API] Failed to fetch fees for ${positionAddress}: ${error.message}`);
            return { feeX: 0, feeY: 0, feeXUsd: 0, feeYUsd: 0 };
        }
    }
}
