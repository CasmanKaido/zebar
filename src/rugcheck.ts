import { Connection } from "@solana/web3.js";
import { SocketManager } from "./socket";
import { IGNORED_MINTS } from "./config";
import axios from "axios";

/**
 * Token Safety Service
 * RugCheck API with retry → hard reject on failure.
 * LP lock verification cannot be done on-chain, so if RugCheck is unavailable
 * we reject the token rather than bypassing the LP lock check.
 */

export interface SafetyResult {
    safe: boolean;
    reason: string;
    source: "rugcheck" | "onchain" | "error";
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
interface RugCheckReport {
    mintAuthority: string | null;
    freezeAuthority: string | null;
    rugged: boolean;
    risks: { name: string; description: string; level: string; score: number }[];
    score: number;
    score_normalised: number;
    totalMarketLiquidity: number;
    totalHolders: number;
    topHolders: { address: string; percent: number; amount: number }[];
    lockers: any[];
    markets: any[];
}


// ─── Constants ───────────────────────────────────────────────────────
const RUGCHECK_TIMEOUT = 6000;
const RUGCHECK_RETRY_DELAY = 3000; // 3s delay before retry
const MAX_BUNDLE_PCT = 20;  // Helius webhook: max 20% in top holder (80% must be distributed)

export class SafetyService {

    // ═══════════════════════════════════════════════════════════════════
    // PUBLIC: Main entry point — same signature as old OnChainSafetyChecker
    // ═══════════════════════════════════════════════════════════════════
    static async checkToken(
        _connection: Connection,
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

        // Attempt 1: RugCheck API
        try {
            const result = await this.checkViaRugCheck(mintAddress);
            if (result) return result;
        } catch (err: any) {
            console.warn(`[SAFETY] RugCheck attempt 1 failed for ${mintAddress.slice(0, 8)}...: ${err.message}`);
        }

        // Attempt 2: Retry after short delay (transient failures / rate limits)
        await new Promise(r => setTimeout(r, RUGCHECK_RETRY_DELAY));
        try {
            const result = await this.checkViaRugCheck(mintAddress);
            if (result) return result;
        } catch (err: any) {
            console.warn(`[SAFETY] RugCheck attempt 2 failed for ${mintAddress.slice(0, 8)}...: ${err.message}`);
        }

        // Hard reject — cannot verify LP lock status without RugCheck
        SocketManager.emitLog(`[SAFETY] ❌ ${mintAddress.slice(0, 8)}... RugCheck unavailable. Rejecting (LP lock unverifiable).`, "error");
        return {
            safe: false,
            reason: "RugCheck unavailable — cannot verify LP lock status",
            source: "error",
            checks: { mintAuthority: "unknown", freezeAuthority: "unknown", liquidityLocked: "unknown" }
        };
    }

    // ═══════════════════════════════════════════════════════════════════
    // TIER 1: RugCheck API (includes bundle % check for Helius)
    // ═══════════════════════════════════════════════════════════════════
    private static async checkViaRugCheck(mintAddress: string): Promise<SafetyResult | null> {
        // Need full report to get topHolders for bundle % check
        const reportRes = await axios.get<RugCheckReport>(
            `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report`,
            { timeout: RUGCHECK_TIMEOUT }
        );

        const report = reportRes.data;
        if (!report || report.score_normalised === undefined) return null;

        const score = report.score_normalised;
        const tag = mintAddress.slice(0, 8);

        // Check 1: Bundle % (top holder concentration)
        const topHolder = report.topHolders?.[0];
        const bundlePct = topHolder?.percent || 0;
        if (bundlePct > MAX_BUNDLE_PCT) {
            SocketManager.emitLog(
                `[SAFETY] ❌ ${tag}... Bundle too concentrated: ${bundlePct.toFixed(1)}% in top holder (max ${MAX_BUNDLE_PCT}%)`,
                "error"
            );
            return {
                safe: false,
                reason: `Bundle concentration too high: ${bundlePct.toFixed(1)}% (max ${MAX_BUNDLE_PCT}%)`,
                source: "rugcheck",
                score,
                lpLockedPct: bundlePct,
                risks: [`Top holder owns ${bundlePct.toFixed(1)}%`],
                checks: { mintAuthority: "unknown", freezeAuthority: "unknown", liquidityLocked: "unknown" }
            };
        }

        // Check 2: Locked Liquidity (from lockers array)
        const hasLockedLP = report.lockers && report.lockers.length > 0;

        // Meteora/Pump.fun: Only bypass locker requirement if LP is actually locked (>90%)
        const isSafeCurve = report.markets?.some((m: any) =>
            (m.marketType === "pump_fun_amm" && m.lp?.lpLockedPct > 90) ||
            (m.marketType === "meteora" && m.lp?.lpLockedPct > 90)
        );

        if (!hasLockedLP && !isSafeCurve) {
            SocketManager.emitLog(
                `[SAFETY] ❌ ${tag}... LP not locked (no lockers detected)`,
                "error"
            );
            return {
                safe: false,
                reason: `Liquidity is not locked - dev can withdraw anytime`,
                source: "rugcheck",
                score,
                lpLockedPct: 0,
                risks: [`LP not locked`],
                checks: { mintAuthority: "unknown", freezeAuthority: "unknown", liquidityLocked: "unlocked" }
            };
        }

        // ── PASS: Bundle % OK + LP Locked ──
        const lpReason = isSafeCurve && !hasLockedLP ? 'Curve/Meteora Locked' : 'Locked';
        SocketManager.emitLog(
            `[SAFETY] ✅ ${tag}... Safety PASS (Bundle: ${bundlePct.toFixed(1)}%, LP: ${lpReason})`,
            "success"
        );

        return {
            safe: true,
            reason: `RugCheck: Bundle ${bundlePct.toFixed(1)}% + LP: ${lpReason}`,
            source: "rugcheck",
            score,
            lpLockedPct: bundlePct,
            risks: [],
            checks: { mintAuthority: "unknown", freezeAuthority: "unknown", liquidityLocked: "locked" }
        };
    }

}

// ── Backwards compatibility alias ──
export const OnChainSafetyChecker = SafetyService;
