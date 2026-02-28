import { Connection } from "@solana/web3.js";
import { SocketManager } from "./socket";
import { IGNORED_MINTS } from "./config";
import { BotSettings } from "./types";
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
        _pairAddress?: string,
        settings?: BotSettings
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
            const result = await this.checkViaRugCheck(mintAddress, settings);
            if (result) return result;
        } catch (err: any) {
            console.warn(`[SAFETY] RugCheck attempt 1 failed for ${mintAddress.slice(0, 8)}...: ${err.message}`);
        }

        // Attempt 2: Retry after short delay (transient failures / rate limits)
        await new Promise(r => setTimeout(r, RUGCHECK_RETRY_DELAY));
        try {
            const result = await this.checkViaRugCheck(mintAddress, settings);
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
    private static async checkViaRugCheck(mintAddress: string, settings?: BotSettings): Promise<SafetyResult | null> {
        // Need full report to get topHolders for bundle % check
        const reportRes = await axios.get<RugCheckReport>(
            `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report`,
            { timeout: RUGCHECK_TIMEOUT }
        );

        const report = reportRes.data;
        if (!report || report.score_normalised === undefined) return null;

        const score = report.score_normalised;
        const tag = mintAddress.slice(0, 8);

        // Resolve authority status from report (used in checks + returned in result)
        const mintAuthStatus: "enabled" | "disabled" = report.mintAuthority ? "enabled" : "disabled";
        const freezeAuthStatus: "enabled" | "disabled" = report.freezeAuthority ? "enabled" : "disabled";

        // Helper to build a rejection result
        const reject = (reason: string, risks: string[], liquidityLocked: "locked" | "unlocked" | "unknown" = "unknown"): SafetyResult => {
            SocketManager.emitLog(`[SAFETY] ❌ ${tag}... ${reason}`, "error");
            return {
                safe: false, reason, source: "rugcheck", score,
                risks,
                checks: { mintAuthority: mintAuthStatus, freezeAuthority: freezeAuthStatus, liquidityLocked }
            };
        };

        // Check 1: Bundle % (top holder concentration)
        const topHolder = report.topHolders?.[0];
        const bundlePct = topHolder?.percent || 0;
        if (bundlePct > MAX_BUNDLE_PCT) {
            return reject(
                `Bundle too concentrated: ${bundlePct.toFixed(1)}% in top holder (max ${MAX_BUNDLE_PCT}%)`,
                [`Top holder owns ${bundlePct.toFixed(1)}%`]
            );
        }

        // Check 2: Locked Liquidity (from lockers array)
        const hasLockedLP = report.lockers && report.lockers.length > 0;
        const isSafeCurve = report.markets?.some((m: any) =>
            (m.marketType === "pump_fun_amm" && m.lp?.lpLockedPct > 90) ||
            (m.marketType === "meteora" && m.lp?.lpLockedPct > 90)
        );

        if (!hasLockedLP && !isSafeCurve) {
            return reject(`LP not locked (no lockers detected)`, [`LP not locked`], "unlocked");
        }

        // Check 3: Mint Authority (toggleable)
        if (settings?.enableAuthorityCheck && report.mintAuthority) {
            return reject(
                `Mint authority enabled — dev can inflate supply`,
                [`Mint authority: ${report.mintAuthority.slice(0, 8)}...`]
            );
        }

        // Check 4: Freeze Authority (toggleable)
        if (settings?.enableAuthorityCheck && report.freezeAuthority) {
            return reject(
                `Freeze authority enabled — tokens can be frozen`,
                [`Freeze authority: ${report.freezeAuthority.slice(0, 8)}...`]
            );
        }

        // Check 5: Top 5 Holder Concentration (toggleable)
        if (settings?.enableHolderAnalysis && report.topHolders?.length > 1) {
            const maxTop5 = settings.maxTop5HolderPct || 50;
            const top5 = report.topHolders.slice(0, 5);
            const top5Pct = top5.reduce((sum, h) => sum + (h.percent || 0), 0);
            if (top5Pct > maxTop5) {
                return reject(
                    `Top 5 holders own ${top5Pct.toFixed(1)}% (max ${maxTop5}%)`,
                    top5.map(h => `${h.address.slice(0, 6)}... owns ${h.percent.toFixed(1)}%`)
                );
            }
        }

        // Check 6: RugCheck Score Threshold (toggleable)
        if (settings?.enableScoring) {
            const minScore = settings.minSafetyScore || 0.3;
            if (score < minScore) {
                return reject(
                    `RugCheck safety score too low: ${score.toFixed(2)} (min ${minScore})`,
                    report.risks?.map(r => `${r.level}: ${r.name}`) || []
                );
            }
        }

        // ── PASS: All checks passed ──
        const lpReason = isSafeCurve && !hasLockedLP ? 'Curve/Meteora Locked' : 'Locked';
        SocketManager.emitLog(
            `[SAFETY] ✅ ${tag}... Safety PASS (Bundle: ${bundlePct.toFixed(1)}%, LP: ${lpReason}, Auth: ${mintAuthStatus}/${freezeAuthStatus}, Score: ${score.toFixed(2)})`,
            "success"
        );

        return {
            safe: true,
            reason: `RugCheck: Bundle ${bundlePct.toFixed(1)}% + LP: ${lpReason}`,
            source: "rugcheck",
            score,
            lpLockedPct: bundlePct,
            risks: [],
            checks: { mintAuthority: mintAuthStatus, freezeAuthority: freezeAuthStatus, liquidityLocked: "locked" }
        };
    }

}

// ── Backwards compatibility alias ──
export const OnChainSafetyChecker = SafetyService;
