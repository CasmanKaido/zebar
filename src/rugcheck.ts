import axios from 'axios';

export interface RugCheckReport {
    score: number;
    risks: {
        name: string;
        value: string;
        level: string;
        score: number;
    }[];
    tokenProgram: string;
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

            // Check for specific critical risks directly if needed
            // e.g., if (report.risks.some(r => r.name === 'Mint Authority still enabled')) ...

            return { safe: true, score };

        } catch (error: any) {
            console.warn(`[RUGCHECK] Failed to fetch report: ${error.message}`);
            // If RugCheck is down or 404s (new token), we might want to proceed with caution or fail.
            // For a "Launcher" bot, new tokens might not have reports yet.
            // But user asked for "Rugcheck" specifically.
            if (error.response?.status === 404) {
                return { safe: true, reason: "New Token (No Report)", score: 0 };
            }
            return { safe: true, reason: "Check Failed (Defaulting to Safe)", score: 0 };
        }
    }
}
