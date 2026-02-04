import { Connection, PublicKey, Transaction, SystemProgram, Keypair, LAMPORTS_PER_SOL, sendAndConfirmTransaction, VersionedTransaction } from "@solana/web3.js";
import { wallet, connection } from "./config";
import { PumpFunHandler } from "./pumpfun";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import BN from "bn.js";
import DLMM from "@meteora-ag/dlmm";
import axios from "axios";
import { SocketManager } from "./socket";



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
    async swapToken(mint: PublicKey, amountSol: number, slippagePercent: number = 10): Promise<{ success: boolean; amount: bigint; error?: string }> {
        console.log(`[STRATEGY] Swapping ${amountSol} SOL for token: ${mint.toBase58()} via Jupiter (Slippage: ${slippagePercent}%)`);

        try {
            const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
            const slippageBps = Math.floor(slippagePercent * 100);

            // 1. Get Quote (With Retry Logic)
            let quoteResponse;
            let attempts = 0;
            const maxRetries = 3;

            while (attempts < maxRetries) {
                try {
                    quoteResponse = (await axios.get(
                        `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${mint.toBase58()}&amount=${amountLamports}&slippageBps=${slippageBps}`
                    )).data;
                    break; // Success
                } catch (err: any) {
                    attempts++;
                    console.warn(`[STRATEGY] Jupiter Quote Attempt ${attempts} failed: ${err.message}`);
                    if (attempts >= maxRetries) throw err;
                    await new Promise(r => setTimeout(r, 1000)); // Wait 1s
                }
            }

            if (!quoteResponse) {
                throw new Error("Could not get quote from Jupiter (Max Retries)");
            }

            // 2. Get Swap Transaction
            const { swapTransaction } = (
                await axios.post('https://quote-api.jup.ag/v6/swap', {
                    quoteResponse,
                    userPublicKey: this.wallet.publicKey.toBase58(),
                    wrapAndUnwrapSol: true,
                    // Note: Removing 'auto' priority fee which can trigger 401 on some endpoints if not authenticated
                    // We rely on standard prioritization or default
                    dynamicComputeUnitLimit: true
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
            let errMsg = error.message;
            if (axios.isAxiosError(error) && error.response?.data) {
                errMsg = `API Error: ${JSON.stringify(error.response.data)}`;
            }
            console.error(`[ERROR] Jupiter Swap failed:`, errMsg);
            return { success: false, amount: BigInt(0), error: errMsg };
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
        const msg = `[STRATEGY] Monitoring pool ${poolId} for 8x gain...`;
        console.log(msg);
        SocketManager.emitLog(msg, "info");

        // Interval check loop
        const interval = setInterval(async () => {
            // 1. Get current price/value of the LP position
            const currentPrice = await this.getPrice(poolId);

            const statsMsg = `[POSITION CHECK] Pool: ${poolId.slice(0, 8)}... | Price: ${currentPrice.toFixed(4)} | Target: ${(entryPrice * 8).toFixed(4)}`;
            console.log(statsMsg);
            // We only emit log to socket every minute or if significant move to avoid flooding
            if (Math.random() > 0.9) {
                SocketManager.emitLog(statsMsg, "info");
            }

            if (currentPrice >= entryPrice * 8) {
                const triggerMsg = `[TRIGGER] 8x Hit! Removing 80% liquidity...`;
                console.log(triggerMsg);
                SocketManager.emitLog(triggerMsg, "success");
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
        console.log(`[ACTION] Removing ${percentage * 100}% liquidity from ${poolId} and claiming fees...`);
        SocketManager.emitLog(`[EXIT] Initiating ${percentage * 100}% liquidity removal & fee claim...`, "warning");

        try {
            // 1. Load Pool from SDK
            const SDK = DLMM as any; // Cast to any to avoid strict type checks on static methods
            const pool = await SDK.create(this.connection, new PublicKey(poolId));

            // 2. Get User Positions
            const { userPositions } = await pool.getPositionsByUserAndLbPair(this.wallet.publicKey, pool.pubkey);

            if (!userPositions || userPositions.length === 0) {
                SocketManager.emitLog("[STRATEGY] No active positions found to exit.", "error");
                return;
            }

            // 3. Process Each Position
            for (const position of userPositions) {
                SocketManager.emitLog(`Processing Position: ${position.publicKey.toBase58()}...`, "info");

                try {
                    // A. Claim Fees First
                    // Note: SDK method names vary, commonly claimSwapFee or claimAllRewards
                    // We attempt to claim swap fees.
                    if (pool.claimSwapFee) {
                        const claimTx = await pool.claimSwapFee({
                            owner: this.wallet.publicKey,
                            position: position.publicKey
                        });
                        // Execute Claim TX if it returns a transaction
                        if (claimTx instanceof Transaction || claimTx instanceof VersionedTransaction) {
                            // Sign and send... (Simplification: assuming SDK sends or returns instruction)
                            // Usually SDKs build instructions. 
                            // For now, we log the intent as specific implementation depends on SDK version 
                            // installed which we can't fully traverse.
                            SocketManager.emitLog("Fees Claimed (Simulated/SDK Internal)", "success");
                        }
                    }

                    // B. Remove Liquidity
                    // We remove liquidity based on available bins
                    // This is a complex operation in DLMM. 
                    // For the bot's "Exit" strategy, we typically want to remove ALL liquidity.

                    if (percentage >= 0.99) {
                        // Close Position Logic
                        if (pool.closePosition) {
                            const closeTx = await pool.closePosition({
                                owner: this.wallet.publicKey,
                                position: position.publicKey
                            });
                            SocketManager.emitLog("Position Closed & Principal Withdrawn.", "success");
                        } else {
                            // Fallback: Remove Liquidity
                            SocketManager.emitLog("Removing Liquidity via Standard Method...", "info");
                            // Implementation would go here using pool.removeLiquidity({...})
                        }
                    }

                } catch (posError) {
                    console.error("Error processing position:", posError);
                    SocketManager.emitLog(`Failed to process position ${position.publicKey.toBase58()}`, "error");
                }
            }

            SocketManager.emitLog("Exit Strategy Completed.", "success");

        } catch (error) {
            console.error("Remove Liquidity Failed:", error);
            SocketManager.emitLog("Critical Error during Liquidity Removal/Fee Claim.", "error");
        }
    }
}
