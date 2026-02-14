import { Connection } from "@solana/web3.js";
import { SocketManager } from "./socket";

/**
 * Global RPC Helper with exponential backoff and retry for 429/Deprioritized errors.
 */
export async function safeRpc<T>(fn: () => Promise<T>, desc: string, maxRetries = 5): Promise<T> {
    let retries = 0;
    while (true) {
        try {
            return await fn();
        } catch (err: any) {
            const errStr = (err.message || err.toString()).toLowerCase();
            const isRateLimit = errStr.includes("429") ||
                errStr.includes("too many requests") ||
                errStr.includes("deprioritized") ||
                errStr.includes("rate limited");

            if (isRateLimit) {
                if (retries >= maxRetries) {
                    throw new Error(`[RPC-FAILURE] ${desc} failed after ${maxRetries} retries due to rate limits.`);
                }
                retries++;
                const backoff = Math.pow(2, retries) * 1000; // Increased base backoff to 1s
                console.log(`[RPC-RETRY] ${desc} throttled. Retrying in ${backoff}ms... (Attempt ${retries}/${maxRetries})`);
                await new Promise(r => setTimeout(r, backoff));
                continue;
            }
            throw err;
        }
    }
}
