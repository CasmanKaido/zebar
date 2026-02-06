import axios from "axios";
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";

export class JitoExecutor {
    // Jito Mainnet Block Engine
    private static BLOCK_ENGINE_URL = "https://mainnet.block-engine.jito.wtf/api/v1";

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
     * Send a Bundle directly to Jito Block Engine
     * @param transactions Array of serialized transactions (base58 strings)
     */
    static async sendBundle(transactions: string[], description: string = "Bundle") {
        console.log(`[JITO] Sending ${description} Bundle to Jito Block Engine...`);

        try {
            const response = await axios.post(`${this.BLOCK_ENGINE_URL}/bundles`, {
                jsonrpc: "2.0",
                id: 1,
                method: "sendBundle",
                params: [transactions]
            });

            if (response.data.error) {
                console.error(`[JITO ERROR] Bundle Rejected:`, response.data.error);
                return { success: false, error: response.data.error };
            }

            const bundleId = response.data.result;
            console.log(`[JITO] Bundle Sent! ID: ${bundleId}`);
            return { success: true, bundleId };

        } catch (e: any) {
            console.error(`[JITO ERROR] Request Failed:`, e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * Helper: Create a Tip Transaction
     * Jito requires a separate instruction or transaction purely for the tip.
     * We typically bundle: [Main_Swap_Tx, Tip_Tx]
     */
    static async createTipTransaction(
        connection: Connection,
        payer: Keypair,
        tipAmountLamports: number
    ): Promise<VersionedTransaction | Transaction> {
        const tipAccount = this.getRandomTipAccount();

        const instruction = SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: tipAccount,
            lamports: tipAmountLamports,
        });

        // Use legacy transaction for simplicity of tip, or Versioned if needed.
        // Legacy is fine for simple transfers.
        const transaction = new Transaction().add(instruction);
        transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        transaction.feePayer = payer.publicKey;

        transaction.sign(payer);

        return transaction;
    }
}
