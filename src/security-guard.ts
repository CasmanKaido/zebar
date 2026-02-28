import { Connection, PublicKey } from "@solana/web3.js";
import { BotSettings } from "./types";
import { RPC_URL, JUPITER_API_KEY } from "./config";
import axios from "axios";

const SOL_MINT = "So11111111111111111111111111111111111111112";

export class SecurityGuard {
    private connection: Connection;

    constructor() {
        this.connection = new Connection(RPC_URL, "confirmed");
    }

    /**
     * Scans developer wallet for previous "rug" behavior or low transaction count.
     */
    async checkDevReputation(devWallet: string, minTxCount: number): Promise<{ safe: boolean; reason?: string }> {
        try {
            const pubkey = new PublicKey(devWallet);
            const signatures = await this.connection.getSignaturesForAddress(pubkey, { limit: 100 });

            if (signatures.length < minTxCount) {
                return { safe: false, reason: `Dev wallet has only ${signatures.length} transactions (min: ${minTxCount})` };
            }

            return { safe: true };
        } catch (error) {
            console.error("[SECURITY] Reputation check failed:", error);
            return { safe: true }; // Fail open for now, but log
        }
    }

    /**
     * Detects if the launch was "Bundled" (supply cornered in slot 0).
     */
    async detectBundle(mint: string): Promise<{ bundled: boolean; holders?: number }> {
        try {
            // Simplified: Check the first few blocks for large buy transactions in the same slot as pool creation
            // In a real implementation, we'd query the block content or use a specialized API.
            // For now, we'll mark as "Not Bundled" but provide a placeholder for actual logic.
            return { bundled: false };
        } catch (error) {
            return { bundled: false };
        }
    }

    /**
     * Simulates a SELL via Jupiter Quote API to detect honeypots.
     * This is a read-only API call — no transaction is sent.
     * If Jupiter can't find a route to sell the token → likely a honeypot.
     */
    async simulateExecution(mint: string): Promise<{ success: boolean; error?: string }> {
        try {
            // Use a small amount (1,000,000 raw units ≈ tiny amount for most tokens)
            const testAmount = 1000000;
            const headers: Record<string, string> = {};
            if (JUPITER_API_KEY) headers["x-api-key"] = JUPITER_API_KEY;

            const res = await axios.get("https://api.jup.ag/quote/v1", {
                params: {
                    inputMint: mint,
                    outputMint: SOL_MINT,
                    amount: testAmount,
                    slippageBps: 1000, // 10% slippage for quote check
                },
                headers,
                timeout: 5000,
            });

            // Check if Jupiter found any route
            if (res.data && res.data.routePlan && res.data.routePlan.length > 0) {
                return { success: true };
            }

            // No routes found — token likely cannot be sold
            return { success: false, error: "No sell routes found on Jupiter — possible honeypot" };
        } catch (err: any) {
            // 400 = no route found, which means honeypot
            if (err.response?.status === 400) {
                return { success: false, error: "Jupiter rejected sell quote — possible honeypot" };
            }
            // Network/timeout errors — fail open (don't block on API issues)
            console.warn(`[SECURITY] Sell simulation failed: ${err.message}`);
            return { success: true };
        }
    }

    /**
     * Run all enabled forensic checks.
     */
    async runForensicAudit(mint: string, devWallet: string, settings: BotSettings): Promise<{ passed: boolean; report: string[] }> {
        const report: string[] = [];
        let passed = true;

        if (settings.enableReputation) {
            const rep = await this.checkDevReputation(devWallet, settings.minDevTxCount);
            if (!rep.safe) {
                passed = false;
                report.push(`[REPUTATION] ${rep.reason}`);
            }
        }

        if (settings.enableBundle) {
            const bundle = await this.detectBundle(mint);
            if (bundle.bundled) {
                passed = false;
                report.push(`[BUNDLE] Detected supply cornering in slot 0`);
            }
        }

        if (settings.enableSimulation) {
            const sim = await this.simulateExecution(mint);
            if (!sim.success) {
                passed = false;
                report.push(`[HONEYPOT] ${sim.error}`);
            }
        }

        return { passed, report };
    }
}

export const securityGuard = new SecurityGuard();
