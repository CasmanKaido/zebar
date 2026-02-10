import axios from "axios";
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction, SystemProgram, TransactionMessage } from "@solana/web3.js";
import bs58 from "bs58";

export class JitoExecutor {
    // Jito Block Engine Endpoints (Regional + Main)
    private static BLOCK_ENGINE_URLS = [
        "https://mainnet.block-engine.jito.wtf/api/v1",
        "https://amsterdam.mainnet.block-engine.jito.wtf/api/v1",
        "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1",
        "https://ny.mainnet.block-engine.jito.wtf/api/v1",
        "https://tokyo.mainnet.block-engine.jito.wtf/api/v1",
    ];

    private static FAILED_ENDPOINTS = new Map<string, number>(); // endpoint -> cooldown_timestamp
    private static COOLDOWN_DURATION = 5 * 60 * 1000; // 5 minute cooldown for 429s

    // Known Jito Tip Accounts (Randomly select one to avoid contention)
    private static TIP_ACCOUNTS = [
        "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
        "HFqU5x63VTqvQss8hp11i4wVV8bD44PuwqVjRokwAwqV",
        "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
        "ADaUMid9yfUytqMBgopXSjbCpNSxD3cTiC7uhqdJY567",
        "DfXygSm4jCyNCyb3qzK6967lsFEx5U56yEbL4ff4jpls",
        "DttWaMuVvTiduZRNguLF7jNxTgiMBZ1hyAumKUiL2KRL",
        "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnIzKZ6jJ",
        "ADuUkR4ykGytmZ5xJw046dU2jM257AeH6TpmjWuFk5mc"
    ];

    /**
     * Get a random Jito Tip Account
     */
    static getRandomTipAccount(): PublicKey {
        const randomIndex = Math.floor(Math.random() * this.TIP_ACCOUNTS.length);
        return new PublicKey(this.TIP_ACCOUNTS[randomIndex]);
    }

    /**
     * Send a Bundle directly to Jito Block Engine with failover
     * @param transactions Array of serialized transactions (base58 strings)
     */
    static async sendBundle(transactions: string[], description: string = "Bundle") {
        console.log(`[JITO] Sending ${description} Bundle to Jito Block Engine...`);

        // Filter out endpoints on cooldown
        const now = Date.now();
        const availableEndpoints = this.BLOCK_ENGINE_URLS.filter(url => {
            const cooldownUntil = this.FAILED_ENDPOINTS.get(url) || 0;
            return now >= cooldownUntil;
        });

        // Use all if everyone is on cooldown (last resort)
        const endpointsToTry = availableEndpoints.length > 0
            ? [...availableEndpoints].sort(() => Math.random() - 0.5)
            : [...this.BLOCK_ENGINE_URLS].sort(() => Math.random() - 0.5);

        for (const endpoint of endpointsToTry) {
            try {
                // console.log(`[JITO DEBUG] Trying Endpoint: ${endpoint}`);
                const response = await axios.post(`${endpoint}/bundles`, {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "sendBundle",
                    params: [transactions]
                }, { timeout: 2000 }); // Quick 2s timeout per endpoint

                if (response.data.error) {
                    console.warn(`[JITO WARN] Bundle Rejected by ${endpoint}:`, response.data.error);
                    continue; // Try next endpoint
                }

                const bundleId = response.data.result;
                console.log(`[JITO] Bundle Sent! ID: ${bundleId} (via ${endpoint})`);
                return { success: true, bundleId };

            } catch (e: any) {
                const status = e.response?.status;
                if (status === 429) {
                    console.warn(`[JITO RATE LIMIT] 429 from ${endpoint}. Adding to 5m cooldown.`);
                    this.FAILED_ENDPOINTS.set(endpoint, Date.now() + this.COOLDOWN_DURATION);
                } else {
                    console.warn(`[JITO ERROR] Request Failed on ${endpoint}:`, e.message);
                }
                // Try next endpoint
            }
        }

        console.error("[JITO ERROR] All endpoints failed.");
        return { success: false, error: "All Jito Endpoints Failed" };
    }

    /**
     * Helper: Create a Tip Transaction
     * Jito requires a separate instruction or transaction purely for the tip.
     * We typically bundle: [Main_Swap_Tx, Tip_Tx]
     */
    static async createTipTransaction(
        connection: Connection,
        payer: Keypair,
        tipAmountLamports: number,
        recentBlockhash?: string
    ): Promise<VersionedTransaction> {
        const tipAccount = this.getRandomTipAccount();

        const instruction = SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: tipAccount,
            lamports: tipAmountLamports,
        });

        const blockhash = recentBlockhash || (await connection.getLatestBlockhash()).blockhash;

        const messageV0 = new TransactionMessage({
            payerKey: payer.publicKey,
            recentBlockhash: blockhash,
            instructions: [instruction],
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([payer]);

        return transaction;
    }
}
