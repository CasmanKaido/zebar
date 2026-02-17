import { Connection } from "@solana/web3.js";
import { SocketManager } from "./socket";

/**
 * Global RPC Helper with exponential backoff and retry for 429/Deprioritized errors.
 */
export async function safeRpc<T>(fn: () => Promise<T>, desc: string, maxRetries = 8): Promise<T> {
    let retries = 0;
    while (true) {
        try {
            return await fn();
        } catch (err: any) {
            const errStr = (err.message || err.toString()).toLowerCase();
            const isRateLimit = errStr.includes("429") ||
                errStr.includes("too many requests") ||
                errStr.includes("deprioritized") ||
                errStr.includes("rate limited") ||
                errStr.includes("scout") || // Custom Helius errors
                errStr.includes("blocked");

            if (isRateLimit) {
                if (retries >= maxRetries) {
                    throw new Error(`[RPC-FAILURE] ${desc} failed after ${maxRetries} retries due to rate limits.`);
                }
                retries++;
                // Aggressive backoff for strict RPCs
                const backoff = Math.min(Math.pow(2, retries) * 1500, 30000);
                console.log(`[RPC-RETRY] ${desc} throttled. Retrying in ${backoff}ms... (Attempt ${retries}/${maxRetries})`);
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
