import { Connection } from "@solana/web3.js";
import { SocketManager } from "./socket";

/**
 * Global RPC Header / Pacer for 15 RPS limit
 */
class RPCPacer {
    private static lastRequest = 0;
    private static MIN_DELAY = 70; // ~14.2 requests per second to be safe

    static async wait() {
        const now = Date.now();
        const elapsed = now - this.lastRequest;
        if (elapsed < this.MIN_DELAY) {
            const delay = this.MIN_DELAY - elapsed;
            await new Promise(r => setTimeout(r, delay));
        }
        this.lastRequest = Date.now();
    }
}

/**
 * RPC Credit Tracker — logs Helius credit usage per hour/day.
 * Helps diagnose credit drain and enforce daily budgets.
 */
export class RpcCreditTracker {
    private static hourlyCount = 0;
    private static dailyCount = 0;
    private static lastHourReset = Date.now();
    private static lastDayReset = Date.now();
    private static dailyBudget = parseInt(process.env.RPC_DAILY_BUDGET || "0"); // 0 = unlimited
    private static budgetExhausted = false;
    private static callsByDesc: Map<string, number> = new Map();

    static track(desc: string) {
        const now = Date.now();

        // Reset hourly counter
        if (now - this.lastHourReset > 3600_000) {
            if (this.hourlyCount > 0) {
                console.log(`[RPC-CREDITS] Hourly: ${this.hourlyCount} calls | Daily: ${this.dailyCount} | Top: ${this.topCallers()}`);
                SocketManager.emitLog(`[RPC-CREDITS] Last hour: ${this.hourlyCount} calls | Today: ${this.dailyCount}`, "info");
            }
            this.hourlyCount = 0;
            this.callsByDesc.clear();
            this.lastHourReset = now;
        }

        // Reset daily counter
        if (now - this.lastDayReset > 86400_000) {
            console.log(`[RPC-CREDITS] Daily total: ${this.dailyCount} calls`);
            this.dailyCount = 0;
            this.budgetExhausted = false;
            this.lastDayReset = now;
        }

        this.hourlyCount++;
        this.dailyCount++;
        this.callsByDesc.set(desc, (this.callsByDesc.get(desc) || 0) + 1);

        // Budget enforcement
        if (this.dailyBudget > 0 && this.dailyCount >= this.dailyBudget && !this.budgetExhausted) {
            this.budgetExhausted = true;
            console.warn(`[RPC-CREDITS] ⚠️ Daily budget exhausted (${this.dailyBudget} calls). Non-critical RPC calls will be throttled.`);
            SocketManager.emitLog(`[RPC-CREDITS] ⚠️ Daily RPC budget (${this.dailyBudget}) exhausted!`, "error");
        }
    }

    static isBudgetExhausted(): boolean {
        return this.budgetExhausted;
    }

    static getStats() {
        return {
            hourly: this.hourlyCount,
            daily: this.dailyCount,
            budget: this.dailyBudget,
            exhausted: this.budgetExhausted
        };
    }

    private static topCallers(): string {
        return [...this.callsByDesc.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([k, v]) => `${k}:${v}`)
            .join(", ");
    }
}

/**
 * Global RPC Helper with exponential backoff and retry for 429/Deprioritized errors.
 */
export async function safeRpc<T>(fn: () => Promise<T>, desc: string, maxRetries = 8): Promise<T> {
    let retries = 0;
    while (true) {
        // Enforce Pacing
        await RPCPacer.wait();

        // Track credit usage
        RpcCreditTracker.track(desc);

        try {
            return await fn();
        } catch (err: any) {
            const errStr = (err.message || err.toString()).toLowerCase();
            const isRateLimit = errStr.includes("429") ||
                errStr.includes("too many requests") ||
                errStr.includes("deprioritized") ||
                errStr.includes("rate limited") ||
                errStr.includes("blocked");

            if (isRateLimit) {
                if (retries >= maxRetries) {
                    throw new Error(`[RPC-FAILURE] ${desc} failed after ${maxRetries} retries due to rate limits.`);
                }
                retries++;
                // Aggressive backoff for strict RPCs
                const backoff = Math.min(Math.pow(2, retries) * 1500, 30000);
                console.log(`[RPC] Throttled. Retrying in ${Math.round(backoff / 100) / 10}s... (${retries}/${maxRetries})`);
                await new Promise(r => setTimeout(r, backoff));
                continue;
            }

            // Connection reset / Timeout / DNS
            const isNetworkError = errStr.includes("econnreset") ||
                errStr.includes("timeout") ||
                errStr.includes("dns") ||
                errStr.includes("eai_again");

            if (isNetworkError && retries < maxRetries) {
                retries++;
                const backoff = 2000;
                console.log(`[RPC-NETWORK] ${desc} failed (${err.message}). Retrying in ${backoff}ms...`);
                await new Promise(r => setTimeout(r, backoff));
                continue;
            }

            throw err;
        }
    }
}
