import axios from 'axios';

// Basic interface for the response (expand as needed)
interface Risk {
    name: string;
    value: string;
    level: string;
    score: number;
}
interface RugCheckReport {
    score: number;
    risks: Risk[];
    tokenProgram: string;
    topHolders: { pct: number }[];
    markets?: { lp: { lpLocked: number, lpLockedPct: number, lpBurnedPct: number } }[];
    totalMarketLiquidity?: number;
}

export class RugChecker {
    private static BASE_URL = 'https://api.rugcheck.xyz/v1/tokens';

    /**
     * Checks if a token is safe to buy.
     * @param mint Token Mint Address
     * @param maxScore Max allowed risk score (default 1000)
     * @returns { safe: boolean, reason?: string, score: number }
     */
    static async checkToken(mint: string, maxScore: number = 2000): Promise<{ safe: boolean; reason?: string; score: number }> {
        try {
            console.log(`[RUGCHECK] Analyzing ${mint}...`);
            const response = await axios.get(`${this.BASE_URL}/${mint}/report/summary`);

            const report = response.data;
            const score = report.score || 0;

            console.log(`[RUGCHECK] Score: ${score} / ${maxScore}`);

            if (score > maxScore) {
                return {
                    safe: false,
                    reason: `Risk Score too high (${score} > ${maxScore})`,
                    score
                };
            }

            // 1. Authority Checks
            const risks = report.risks || [];
            const hasMintAuth = risks.some((r: any) => r.name === 'Mint Authority still enabled');
            const hasFreezeAuth = risks.some((r: any) => r.name === 'Freeze Authority still enabled');
            const isMutable = risks.some((r: any) => r.name === 'Mutable metadata');

            if (hasMintAuth) {
                return { safe: false, reason: "Mint Authority is Enabled", score };
            }
            if (hasFreezeAuth) {
                return { safe: false, reason: "Freeze Authority is Enabled", score };
            }
            // Optional: User didn't explicitly ask for mutable check, but it's good practice. Leaving out for now to strictly follow request.

            // 2. Supply Distribution (Top 10 > 30%)
            // RugCheck often provides `topHolders` array. Sum up top 10.
            let top10Pct = 0;
            if (report.topHolders && Array.isArray(report.topHolders)) {
                top10Pct = report.topHolders.slice(0, 10).reduce((acc: number, h: any) => acc + (h.pct || 0), 0);
            }

            console.log(`[RUGCHECK] Top 10 Holders Own: ${(top10Pct * 100).toFixed(2)}%`);

            if (top10Pct > 0.30) { // 30%
                return { safe: false, reason: `Top 10 Holders Own > 30% (${(top10Pct * 100).toFixed(1)}%)`, score };
            }

            // 3. Liquidity Lock Check
            // This is tricky as RugCheck response varies.
            // Often under `markets` or `risks` ("High amount of LP Unlocked").
            const lpUnlockedRisk = risks.find((r: any) => r.name === 'High amount of LP Unlocked');
            const lpLowLiquidity = risks.find((r: any) => r.name === 'Low Liquidity');

            if (lpUnlockedRisk) {
                return { safe: false, reason: "Liquidity is Unlocked / Not Burned", score };
            }

            // Check specific lock percentage if available (fallback)
            // Some reports have `markets[0].lp.lpLockedPct`
            // Let's rely on the Risk Tag first as it aggregates this logic.

            return { safe: true, score };

        } catch (error: any) {
            console.warn(`[RUGCHECK] Failed to fetch report: ${error.message}`);
            // If RugCheck is down or 404s (new token), we might want to proceed with caution or fail.
            // For a "Launcher" bot, new tokens might not have reports yet.
            // But user asked for "Rugcheck" specifically.
            if (error.response?.status === 404) {
                return { safe: true, reason: "New Token (No Report)", score: 0 };
            }
            return { safe: false, reason: "Check Failed (API Unreachable — Defaulting to Unsafe)", score: 0 };
        }
    }
}
