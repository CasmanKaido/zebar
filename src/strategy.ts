import { Connection, PublicKey, Transaction, SystemProgram, Keypair, LAMPORTS_PER_SOL, sendAndConfirmTransaction, VersionedTransaction } from "@solana/web3.js";
import { wallet, connection } from "./config";
import { PumpFunHandler } from "./pumpfun";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import BN from "bn.js";
import DLMM from "@meteora-ag/dlmm";
import axios from "axios";



export class StrategyManager {
    private connection: Connection;
    private wallet: Keypair;

    constructor(connection: Connection, wallet: Keypair) {
        this.connection = connection;
        this.wallet = wallet;
    }

    /**
     * Buys the token using Jupiter Aggregator (Market Buy).
     */
    async swapToken(mint: PublicKey, amountSol: number): Promise<{ success: boolean; amount: bigint }> {
        console.log(`[STRATEGY] Swapping ${amountSol} SOL for token: ${mint.toBase58()} via Jupiter`);

        try {
            const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

            // 1. Get Quote
            const quoteResponse = (
                await axios.get(
                    `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${mint.toBase58()}&amount=${amountLamports}&slippageBps=100`
                )
            ).data;

            if (!quoteResponse) {
                throw new Error("Could not get quote from Jupiter");
            }

            // 2. Get Swap Transaction
            const { swapTransaction } = (
                await axios.post('https://quote-api.jup.ag/v6/swap', {
                    quoteResponse,
                    userPublicKey: this.wallet.publicKey.toBase58(),
                    wrapAndUnwrapSol: true,
                })
            ).data;

            // 3. Deserialize and Sign
            const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
            transaction.sign([this.wallet]);

            // 4. Execute
            const rawTransaction = transaction.serialize();
            const txid = await this.connection.sendRawTransaction(rawTransaction, {
                skipPreflight: true,
                maxRetries: 2,
                preflightCommitment: 'confirmed'
            });

            console.log(`[TX] Sent Swap: https://solscan.io/tx/${txid}`);

            // 5. Wait for confirmation and check post-balance
            await this.connection.confirmTransaction(txid);

            // Fetch bought amount from transaction meta or current balance change
            // Simplified: return the outAmount from quote as an estimate, 
            // In production, we'd check actual postTokenBalances
            const outAmount = BigInt(quoteResponse.outAmount);

            return { success: true, amount: outAmount };

        } catch (error: any) {
            console.error(`[ERROR] Jupiter Swap failed:`, error.message);
            return { success: false, amount: BigInt(0) };
        }
    }






    /**
     * Creates a Meteora DLMM Pool for the given token and Base Token.
     */
    async createMeteoraPool(
        tokenMint: PublicKey,
        baseMint: PublicKey,
        tokenAmount: bigint,
        baseAmount: bigint
    ) {
        console.log(`[STRATEGY] Creating Meteora Pool for ${tokenMint.toBase58()} / ${baseMint.toBase58()}...`);

        try {
            // 1. Configure Pool Parameters for a High Volatility pair (New Token)
            // Bin Step: 100 basis points (1%) - allows for wider price ranges
            const binStep = new BN(100);
            // Base Fee: 25 basis points (0.25%)
            const baseFee = new BN(2500);

            // 2. Identify Token X and Token Y (sorted)
            let tokenX = tokenMint;
            let tokenY = baseMint;
            let amountX = tokenAmount;
            let amountY = baseAmount;

            // Simple buffer comparison for sort
            if (tokenMint.toBuffer().compare(baseMint.toBuffer()) > 0) {
                tokenX = baseMint;
                tokenY = tokenMint;
                amountX = baseAmount;
                amountY = tokenAmount;
            }

            // 3. Activation Point (Immediate)
            const slot = await this.connection.getSlot();
            const activationPoint = new BN(slot);

            console.log(`[ACTION] Initializing DLMM Pool...`);

            // 4. Create Pool using SDK
            // Note: Depending on SDK version, might return transaction or pool structure.
            // We assume modern SDK usage: DLMM.create returns the new pool instance or address.
            // We act as payer.



            // Creating via casting to any because SDK signatures vary by version
            const SDK = DLMM as any;
            const newPool = await SDK.create(
                this.connection,
                this.wallet, // payer
                tokenX,
                tokenY,
                baseFee,
                binStep,
                activationPoint
            );


            // `newPool` is a DLMM instance in the latest SDK
            // We need to get its address.
            console.log(`[SUCCESS] Meteora Pool Created: ${newPool.pubkey.toBase58()}`);

            // 5. Add Initial Liquidity
            console.log(`[ACTION] Please add liquidity to ${newPool.pubkey.toBase58()} manually or via next step.`);

            return { poolId: newPool.pubkey.toBase58(), protocol: "meteora" };


        } catch (error) {
            console.error(`[ERROR] Failed to create Meteora Pool:`, error);
            // Return null so the main loop knows it failed
            return null;
        }
    }



    /**
     * Monitors the position and exits if it hits the target (8x).
     */
    async monitorAndExit(poolId: string, entryPrice: number) {
        console.log(`[STRATEGY] Monitoring pool ${poolId} for 8x gain...`);

        // Interval check loop
        const interval = setInterval(async () => {
            // 1. Get current price/value of the LP position
            const currentPrice = await this.getPrice(poolId);

            console.log(`[CHECK] Current: ${currentPrice}, Entry: ${entryPrice}, Target: ${entryPrice * 8}`);

            if (currentPrice >= entryPrice * 8) {
                console.log(`[TRIGGER] 8x Hit! Removing 80% liquidity...`);
                await this.removeLiquidity(poolId, 0.8);
                clearInterval(interval);
            }
        }, 10000); // Check every 10 seconds
    }

    async getPrice(poolId: string): Promise<number> {
        // Mock price fetcher
        // In real implementation, fetch pool reserves and calculate price
        return Math.random() * 10; // Random mock
    }

    async removeLiquidity(poolId: string, percentage: number) {
        console.log(`[ACTION] Removing ${percentage * 100}% liquidity from ${poolId}`);
        // Implement Raydium remove liquidity
    }
}
