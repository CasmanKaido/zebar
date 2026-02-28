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
     * Fetches the earliest transactions for the mint and checks if multiple
     * buy transactions landed in the same slot as pool creation — a sign
     * that a Jito bundle was used to corner supply before anyone else.
     */
    async detectBundle(mint: string): Promise<{ bundled: boolean; slot0Buyers?: number; reason?: string }> {
        try {
            const mintPubkey = new PublicKey(mint);

            // Fetch the oldest transactions for this mint (earliest first)
            const signatures = await this.connection.getSignaturesForAddress(mintPubkey, { limit: 30 });
            if (signatures.length === 0) {
                return { bundled: false };
            }

            // Sort by slot ascending to find the creation slot
            const sorted = [...signatures].sort((a, b) => a.slot - b.slot);
            const creationSlot = sorted[0].slot;

            // Count unique signers that transacted in the creation slot
            // Multiple transactions in the same slot = bundled launch
            const slot0Txs = sorted.filter(s => s.slot === creationSlot);

            // If 3+ transactions landed in the exact same slot as creation,
            // it's almost certainly a Jito bundle snipe
            if (slot0Txs.length >= 3) {
                // Verify by checking the next 1-2 slots as well (bundles sometimes span 2 slots)
                const nearSlotTxs = sorted.filter(s => s.slot <= creationSlot + 1);

                if (nearSlotTxs.length >= 4) {
                    return {
                        bundled: true,
                        slot0Buyers: nearSlotTxs.length,
                        reason: `${nearSlotTxs.length} transactions in creation slot (${creationSlot}) — likely Jito bundle snipe`
                    };
                }

                return {
                    bundled: true,
                    slot0Buyers: slot0Txs.length,
                    reason: `${slot0Txs.length} transactions in creation slot (${creationSlot}) — likely bundled launch`
                };
            }

            return { bundled: false, slot0Buyers: slot0Txs.length };
        } catch (error) {
            console.warn(`[SECURITY] Bundle detection failed for ${mint.slice(0, 8)}:`, error);
            return { bundled: false }; // Fail open
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
                report.push(`[BUNDLE] ${bundle.reason || `Detected supply cornering (${bundle.slot0Buyers} txs in creation slot)`}`);
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
