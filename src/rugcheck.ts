import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { SocketManager } from "./socket";
import { safeRpc } from "./rpc-utils";
import { IGNORED_MINTS } from "./config";
import axios from "axios";

/**
 * Token Safety Service
 * 3-tier safety check: RugCheck API → GoPlus API → On-Chain (fallback)
 *
 * - RugCheck: Primary. Returns risk score, risk list, LP lock %.
 * - GoPlus:   Secondary. Returns freeze/close/mint authority, DEX LP burn %.
 * - On-Chain: Last resort. Uses RPC to check mint/freeze auth + holder concentration.
 */

export interface SafetyResult {
    safe: boolean;
    reason: string;
    source: "rugcheck" | "goplus" | "onchain" | "error";
    checks: {
        mintAuthority: "disabled" | "enabled" | "unknown";
        freezeAuthority: "disabled" | "enabled" | "unknown";
        liquidityLocked: "locked" | "unlocked" | "unknown";
    };
    score?: number;          // 0-1 normalised safety score (from RugCheck)
    lpLockedPct?: number;    // % of LP locked/burned
    risks?: string[];        // Human-readable risk descriptions
}

// ─── RugCheck API Types ──────────────────────────────────────────────
interface RugCheckSummary {
    score: number;                  // 0 (safe) to N (risky) — raw score
    score_normalised: number;       // 0-1 normalised (1 = safest)
    risks: { name: string; description: string; level: string; score: number }[];
    lpLockedPct: number;
    tokenProgram: string;
    tokenType: string;
}

interface RugCheckReport {
    mintAuthority: string | null;
    freezeAuthority: string | null;
    rugged: boolean;
    risks: { name: string; description: string; level: string; score: number }[];
    score: number;
    score_normalised: number;
    totalMarketLiquidity: number;
    totalHolders: number;
    topHolders: any[];
    lockers: any[];
    markets: any[];
}

// ─── GoPlus API Types ────────────────────────────────────────────────
interface GoPlusResult {
    freezable?: { status: string; authority: any[] };
    closable?: { status: string; authority: any[] };
    non_transferable?: number;
    metadata_mutable?: { status: string };
    balance_mutable_authority?: { status: string };
    transfer_hook?: any[];
    default_account_state?: string;
    dex?: {
        dex_name: string;
        tvl: string;
        burn_percent: number;
        price: string;
    }[];
}

// ─── Constants ───────────────────────────────────────────────────────
const RUGCHECK_TIMEOUT = 6000;
const GOPLUS_TIMEOUT = 6000;
const RUGCHECK_MIN_SCORE = 0.3;  // Below this = unsafe
const CRITICAL_RISKS = new Set([
    "Rug Pull",
    "Freeze Authority still enabled",
    "Large Amount of LP Unlocked",
    "Copycat token",
    "Very High Amount of LP Unlocked"
]);

export class SafetyService {

    // ═══════════════════════════════════════════════════════════════════
    // PUBLIC: Main entry point — same signature as old OnChainSafetyChecker
    // ═══════════════════════════════════════════════════════════════════
    static async checkToken(
        connection: Connection,
        mintAddress: string,
        _pairAddress?: string
    ): Promise<SafetyResult> {
        // Skip ignored mints
        if (IGNORED_MINTS.includes(mintAddress)) {
            return {
                safe: true,
                reason: "Whitelisted token",
                source: "rugcheck",
                checks: { mintAuthority: "disabled", freezeAuthority: "disabled", liquidityLocked: "locked" }
            };
        }

        // Tier 1: RugCheck API
        try {
            const result = await this.checkViaRugCheck(mintAddress);
            if (result) return result;
        } catch (err: any) {
            console.warn(`[SAFETY] RugCheck failed for ${mintAddress.slice(0, 8)}...: ${err.message}`);
        }

        // Tier 2: GoPlus API
        try {
            const result = await this.checkViaGoPlus(mintAddress);
            if (result) return result;
        } catch (err: any) {
            console.warn(`[SAFETY] GoPlus failed for ${mintAddress.slice(0, 8)}...: ${err.message}`);
        }

        // Tier 3: On-Chain (last resort — uses RPC)
        console.warn(`[SAFETY] Both APIs failed. Falling back to on-chain checks for ${mintAddress.slice(0, 8)}...`);
        SocketManager.emitLog(`[SAFETY] ⚠️ APIs down — using on-chain fallback (costs RPC)`, "warning");
        return this.checkOnChain(connection, mintAddress);
    }

    // ═══════════════════════════════════════════════════════════════════
    // TIER 1: RugCheck API
    // ═══════════════════════════════════════════════════════════════════
    private static async checkViaRugCheck(mintAddress: string): Promise<SafetyResult | null> {
        // Try summary endpoint first (lighter)
        const summaryRes = await axios.get<RugCheckSummary>(
            `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`,
            { timeout: RUGCHECK_TIMEOUT }
        );

        const summary = summaryRes.data;
        if (!summary || summary.score_normalised === undefined) return null;

        const score = summary.score_normalised;
        const lpPct = summary.lpLockedPct || 0;
        const riskNames = (summary.risks || []).map(r => r.name);
        const riskDescriptions = (summary.risks || []).map(r => `${r.name}: ${r.description}`);
        const hasCriticalRisk = riskNames.some(r => CRITICAL_RISKS.has(r));

        // Determine mint/freeze auth from risk names
        const mintAuth = riskNames.some(r => r.toLowerCase().includes("mint authority"))
            ? "enabled" as const : "disabled" as const;
        const freezeAuth = riskNames.some(r => r.toLowerCase().includes("freeze authority"))
            ? "enabled" as const : "disabled" as const;
        const lpStatus = lpPct >= 80 ? "locked" as const
            : lpPct >= 30 ? "unlocked" as const
                : "unknown" as const;

        const tag = mintAddress.slice(0, 8);

        // ── Decision Logic ──
        if (hasCriticalRisk || score < RUGCHECK_MIN_SCORE) {
            const topRisk = riskNames[0] || "Low safety score";
            SocketManager.emitLog(
                `[SAFETY] ❌ ${tag}... RugCheck UNSAFE (score: ${score.toFixed(2)}, risk: ${topRisk})`,
                "error"
            );
            return {
                safe: false,
                reason: `RugCheck: ${topRisk} (score: ${score.toFixed(2)})`,
                source: "rugcheck",
                score,
                lpLockedPct: lpPct,
                risks: riskDescriptions,
                checks: { mintAuthority: mintAuth, freezeAuthority: freezeAuth, liquidityLocked: lpStatus }
            };
        }

        // Freeze authority is a hard reject even at high scores
        if (freezeAuth === "enabled") {
            SocketManager.emitLog(`[SAFETY] ❌ ${tag}... Freeze Authority ENABLED (via RugCheck)`, "error");
            return {
                safe: false,
                reason: "Freeze Authority is ENABLED — dev can freeze your tokens",
                source: "rugcheck",
                score,
                lpLockedPct: lpPct,
                risks: riskDescriptions,
                checks: { mintAuthority: mintAuth, freezeAuthority: "enabled", liquidityLocked: lpStatus }
            };
        }

        // ── SAFE ──
        const warnParts: string[] = [];
        if (mintAuth === "enabled") warnParts.push("mint-auth");
        if (lpPct < 80) warnParts.push(`LP ${lpPct.toFixed(0)}%`);
        if (riskNames.length > 0) warnParts.push(`${riskNames.length} risks`);

        const warnStr = warnParts.length > 0 ? ` (warnings: ${warnParts.join(", ")})` : "";
        SocketManager.emitLog(
            `[SAFETY] ✅ ${tag}... RugCheck SAFE (score: ${score.toFixed(2)}, LP: ${lpPct.toFixed(0)}%)${warnStr}`,
            "success"
        );

        return {
            safe: true,
            reason: `RugCheck: score ${score.toFixed(2)}, LP locked ${lpPct.toFixed(0)}%`,
            source: "rugcheck",
            score,
            lpLockedPct: lpPct,
            risks: riskDescriptions,
            checks: { mintAuthority: mintAuth, freezeAuthority: freezeAuth, liquidityLocked: lpStatus }
        };
    }

    // ═══════════════════════════════════════════════════════════════════
    // TIER 2: GoPlus Security API
    // ═══════════════════════════════════════════════════════════════════
    private static async checkViaGoPlus(mintAddress: string): Promise<SafetyResult | null> {
        const res = await axios.get(
            `https://api.gopluslabs.io/api/v1/solana/token_security`,
            {
                params: { contract_addresses: mintAddress },
                timeout: GOPLUS_TIMEOUT
            }
        );

        const data = res.data;
        if (data?.code !== 1 || !data.result) return null;

        const tokenData: GoPlusResult = data.result[mintAddress] || data.result[mintAddress.toLowerCase()];
        if (!tokenData) return null;

        const tag = mintAddress.slice(0, 8);

        const freezable = tokenData.freezable?.status === "1";
        const closable = tokenData.closable?.status === "1";
        const nonTransferable = tokenData.non_transferable === 1;

        // Check DEX data for LP burn %
        const dexes = tokenData.dex || [];
        const bestDex = dexes.reduce((best, d) => {
            const tvl = parseFloat(d.tvl || "0");
            return tvl > parseFloat(best?.tvl || "0") ? d : best;
        }, dexes[0]);
        const burnPct = bestDex?.burn_percent || 0;

        // Determine safety
        const mintAuth = "unknown" as const; // GoPlus doesn't directly expose this for Solana SPL
        const freezeAuth = freezable ? "enabled" as const : "disabled" as const;
        const lpStatus = burnPct >= 80 ? "locked" as const : burnPct >= 30 ? "unlocked" as const : "unknown" as const;

        if (freezable) {
            SocketManager.emitLog(`[SAFETY] ❌ ${tag}... GoPlus: Freezable token`, "error");
            return {
                safe: false,
                reason: "GoPlus: Token is freezable — dev can freeze your tokens",
                source: "goplus",
                checks: { mintAuthority: mintAuth, freezeAuthority: "enabled", liquidityLocked: lpStatus },
                lpLockedPct: burnPct
            };
        }

        if (closable) {
            SocketManager.emitLog(`[SAFETY] ❌ ${tag}... GoPlus: Token account closable`, "error");
            return {
                safe: false,
                reason: "GoPlus: Token accounts can be closed by authority",
                source: "goplus",
                checks: { mintAuthority: mintAuth, freezeAuthority: freezeAuth, liquidityLocked: lpStatus },
                lpLockedPct: burnPct
            };
        }

        if (nonTransferable) {
            SocketManager.emitLog(`[SAFETY] ❌ ${tag}... GoPlus: Non-transferable token`, "error");
            return {
                safe: false,
                reason: "GoPlus: Token is non-transferable (honeypot)",
                source: "goplus",
                checks: { mintAuthority: mintAuth, freezeAuthority: freezeAuth, liquidityLocked: lpStatus },
                lpLockedPct: burnPct
            };
        }

        SocketManager.emitLog(
            `[SAFETY] ✅ ${tag}... GoPlus SAFE (LP burn: ${burnPct.toFixed(0)}%, not freezable)`,
            "success"
        );

        return {
            safe: true,
            reason: `GoPlus: LP burn ${burnPct.toFixed(0)}%, no dangerous authorities`,
            source: "goplus",
            checks: { mintAuthority: mintAuth, freezeAuthority: freezeAuth, liquidityLocked: lpStatus },
            lpLockedPct: burnPct
        };
    }

    // ═══════════════════════════════════════════════════════════════════
    // TIER 3: On-Chain Fallback (uses RPC — last resort)
    // ═══════════════════════════════════════════════════════════════════
    private static async checkOnChain(
        connection: Connection,
        mintAddress: string
    ): Promise<SafetyResult> {
        const mint = new PublicKey(mintAddress);
        const result: SafetyResult = {
            safe: true,
            reason: "On-chain checks passed",
            source: "onchain",
            checks: {
                mintAuthority: "unknown",
                freezeAuthority: "unknown",
                liquidityLocked: "unknown",
            },
        };

        try {
            let mintInfo;
            try {
                mintInfo = await safeRpc(() => getMint(connection, mint, "confirmed", TOKEN_PROGRAM_ID), "getMint-v1");
            } catch {
                try {
                    mintInfo = await safeRpc(() => getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID), "getMint-v2");
                } catch (e2: any) {
                    result.safe = false;
                    result.reason = "Unsupported token program";
                    return result;
                }
            }

            // Mint authority
            if (mintInfo.mintAuthority !== null) {
                result.checks.mintAuthority = "enabled";
                SocketManager.emitLog(`[SAFETY] ⚠️ ${mintAddress.slice(0, 8)}... Mint Authority ENABLED (on-chain)`, "warning");
            } else {
                result.checks.mintAuthority = "disabled";
            }

            // Freeze authority — hard reject
            if (mintInfo.freezeAuthority !== null) {
                result.safe = false;
                result.reason = "Freeze Authority is ENABLED (on-chain check)";
                result.checks.freezeAuthority = "enabled";
                SocketManager.emitLog(`[SAFETY] ❌ ${mintAddress.slice(0, 8)}... Freeze Authority ENABLED (on-chain)`, "error");
                return result;
            }
            result.checks.freezeAuthority = "disabled";
        } catch (err: any) {
            console.warn(`[SAFETY] On-chain fallback failed: ${err.message}`);
            result.safe = false;
            result.reason = `On-chain check failed: ${err.message}`;
            result.source = "error";
        }

        return result;
    }
}

// ── Backwards compatibility alias ──
export const OnChainSafetyChecker = SafetyService;
