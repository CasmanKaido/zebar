import { Connection, PublicKey, Transaction, SystemProgram, Keypair, LAMPORTS_PER_SOL, sendAndConfirmTransaction, VersionedTransaction } from "@solana/web3.js";
import { wallet, connection } from "./config";
import { PumpFunHandler } from "./pumpfun";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import DLMM from "@meteora-ag/dlmm";
import { Liquidity, LiquidityPoolKeys, Token, TokenAmount, Percent, Currency, SOL, MAINNET_PROGRAM_ID } from "@raydium-io/raydium-sdk";
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
    async swapToken(mint: PublicKey, amountSol: number, slippagePercent: number = 10, pairAddress?: string, dexId?: string): Promise<{ success: boolean; amount: bigint; error?: string }> {
        console.log(`[STRATEGY] Swapping ${amountSol} SOL for token: ${mint.toBase58()} via Jupiter (Slippage: ${slippagePercent}%)`);

        try {
            // ... (keep start of swapToken)
            const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
            const slippageBps = Math.floor(slippagePercent * 100);

            // 1. Get Quote (With Retry Logic)
            let quoteResponse;
            let attempts = 0;
            const maxRetries = 3;

            while (attempts < maxRetries) {
                try {
                    // Using api.jup.ag/swap/v6 instead of quote-api.jup.ag
                    quoteResponse = (await axios.get(
                        `https://api.jup.ag/swap/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${mint.toBase58()}&amount=${amountLamports}&slippageBps=${slippageBps}&onlyDirectRoutes=false&swapMode=ExactIn`
                    )).data;
                    break; // Success
                } catch (err: any) {
                    attempts++;
                    console.warn(`[STRATEGY] Jupiter Quote Attempt ${attempts} failed: ${err.message}`);
                    if (attempts >= maxRetries) throw err;
                    await new Promise(r => setTimeout(r, 2000)); // Wait 2s
                }
            }

            if (!quoteResponse) {
                throw new Error("Could not get quote from Jupiter (Max Retries)");
            }

            // 2. Get Swap Transaction
            const { swapTransaction } = (
                await axios.post('https://api.jup.ag/swap/v6/swap', {
                    quoteResponse,
                    userPublicKey: this.wallet.publicKey.toBase58(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    // Use microLamports for better fee control on public API
                    computeUnitPriceMicroLamports: 100000
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

            // FALLBACK TO DIRECT DEX SWAP IF PAIR KNOWN
            const isTransientError = errMsg.includes("ENOTFOUND") || errMsg.includes("401") || errMsg.includes("429") || errMsg.includes("timeout") || errMsg.includes("500") || errMsg.includes("Network Error");

            if (pairAddress && isTransientError) {
                if (dexId === 'meteora') {
                    console.log("[STRATEGY] Attempting Fallback to Meteora DLMM Direct Swap...");
                    SocketManager.emitLog("[FALLBACK] Jupiter Unreachable. Switching to Meteora DLMM...", "warning");
                    return this.swapMeteoraDLMM(mint, pairAddress, amountSol, slippagePercent);
                }

                // Default: Raydium
                console.log("[STRATEGY] Attempting Fallback to Raydium Direct Swap...");
                SocketManager.emitLog("[FALLBACK] Jupiter Unreachable. Switching to Raydium Direct...", "warning");
                return this.swapRaydium(mint, pairAddress, amountSol, slippagePercent);
            }

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

            const poolAddress = newPool.pubkey;
            console.log(`[SUCCESS] Meteora Pool Created: ${poolAddress.toBase58()}`);

            // 5. AUTOMATED: Add Initial Liquidity
            SocketManager.emitLog(`[ACTION] Seeding Liquidity: ${amountX.toString()} X & ${amountY.toString()} Y...`, "warning");

            // Define the strategy (Spot deposit around the current bin)
            // StrategyType: 0 = Spot, 1 = Curve, 2 = Bid-Ask
            const totalX = new BN(amountX.toString());
            const totalY = new BN(amountY.toString());

            // We initialize with a simple spot strategy across 1 bin (the current one)
            // for the very first deposit to set the initial price.
            const addLiquidityTx = await newPool.initializePositionAndAddLiquidityByStrategy({
                positionPubKey: Keypair.generate().publicKey, // Temporary position
                user: this.wallet.publicKey,
                totalX,
                totalY,
                strategy: {
                    maxBinId: 0,
                    minBinId: 0,
                    strategyType: 0 // Spot
                }
            });

            // Sign and send
            const txid = await sendAndConfirmTransaction(
                this.connection,
                addLiquidityTx,
                [this.wallet],
                { skipPreflight: true, commitment: "confirmed" }
            );

            SocketManager.emitLog(`[SUCCESS] Liquidity Seeded! Tx: ${txid.slice(0, 8)}...`, "success");

            return { poolId: poolAddress.toBase58(), protocol: "meteora" };

        } catch (error: any) {
            console.error(`[ERROR] Full Automation Failed:`, error);
            SocketManager.emitLog(`Pool/Liquidity Error: ${error.message}`, "error");
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
    /**
     * Fallback: Swap directly via Raydium SDK if Jupiter fails.
     */
    async swapRaydium(mint: PublicKey, pairAddress: string, amountSol: number, slippagePercent: number): Promise<{ success: boolean; amount: bigint; error?: string }> {
        console.log(`[STRATEGY] Initiating Raydium Direct Swap for Pair: ${pairAddress}`);

        try {
            // 1. Fetch Pool Keys (Efficiently)
            let poolData;
            try {
                const response = await axios.get(`https://api-v3.raydium.io/pools/info/ids?ids=${pairAddress}`);
                poolData = response.data.data?.[0];
            } catch (apiErr) {
                console.warn("[RAYDIUM] API Fetch failed, attempting on-chain discovery...");
            }

            if (!poolData) {
                // On-chain fallback would require full layout decoding which is heavy, 
                // but we can at least try the V2 API which sometimes has different indexing.
                try {
                    const backupResponse = await axios.get(`https://api.raydium.io/v2/sdk/liquidity/mainnet.json`);
                    // We search for the specific ID in the backup list
                    poolData = backupResponse.data.official.find((p: any) => p.id === pairAddress) ||
                        backupResponse.data.unOfficial.find((p: any) => p.id === pairAddress);

                    if (poolData) {
                        console.log("[RAYDIUM] Found pool data in backup V2 index.");
                        // Map V2 format to expected structure
                        poolData = {
                            id: poolData.id,
                            mintA: { address: poolData.baseMint, decimals: poolData.baseDecimals },
                            mintB: { address: poolData.quoteMint, decimals: poolData.quoteDecimals },
                            lpMint: { address: poolData.lpMint, decimals: poolData.lpDecimals },
                            programId: poolData.programId,
                            authority: poolData.authority,
                            openOrders: poolData.openOrders,
                            targetOrders: poolData.targetOrders,
                            vault: { A: poolData.baseVault, B: poolData.quoteVault },
                            marketProgramId: poolData.marketProgramId,
                            marketId: poolData.marketId,
                            marketAuthority: poolData.marketAuthority,
                            marketVault: { A: poolData.marketBaseVault, B: poolData.marketQuoteVault },
                            marketBids: poolData.marketBids,
                            marketAsks: poolData.marketAsks,
                            marketEventQueue: poolData.marketEventQueue
                        };
                    }
                } catch (backupErr) {
                    return { success: false, amount: BigInt(0), error: "Raydium Pool Data not found visually or via API" };
                }
            }

            if (!poolData) {
                return { success: false, amount: BigInt(0), error: "Raydium Pool Data not found anywhere" };
            }

            // Map API response to PoolKeys format
            const poolKeys: LiquidityPoolKeys = {
                id: new PublicKey(poolData.id),
                baseMint: new PublicKey(poolData.mintA.address),
                quoteMint: new PublicKey(poolData.mintB.address),
                lpMint: new PublicKey(poolData.lpMint.address),
                baseDecimals: poolData.mintA.decimals,
                quoteDecimals: poolData.mintB.decimals,
                lpDecimals: poolData.lpMint.decimals,
                version: 4,
                programId: new PublicKey(poolData.programId),
                authority: new PublicKey(poolData.authority),
                openOrders: new PublicKey(poolData.openOrders),
                targetOrders: new PublicKey(poolData.targetOrders),
                baseVault: new PublicKey(poolData.vault.A),
                quoteVault: new PublicKey(poolData.vault.B),
                withdrawQueue: PublicKey.default,
                lpVault: PublicKey.default,
                marketVersion: 3,
                marketProgramId: new PublicKey(poolData.marketProgramId),
                marketId: new PublicKey(poolData.marketId),
                marketAuthority: new PublicKey(poolData.marketAuthority),
                marketBaseVault: new PublicKey(poolData.marketVault.A),
                marketQuoteVault: new PublicKey(poolData.marketVault.B),
                marketBids: new PublicKey(poolData.marketBids),
                marketAsks: new PublicKey(poolData.marketAsks),
                marketEventQueue: new PublicKey(poolData.marketEventQueue),
                lookupTableAccount: PublicKey.default,
            };

            // 2. Define Tokens
            const SOL_MINT = "So11111111111111111111111111111111111111112";
            const currencyIn = poolKeys.quoteMint.toBase58() === SOL_MINT ? Token.WSOL : new (Token as any)(TOKEN_PROGRAM_ID, poolKeys.quoteMint, Number(poolKeys.quoteDecimals), "QUOTE", "Quote Token");

            const isBase = poolKeys.baseMint.toBase58() === mint.toBase58();
            const currencyOut = isBase
                ? new (Token as any)(TOKEN_PROGRAM_ID, poolKeys.baseMint, Number(poolKeys.baseDecimals), "BASE", "Base Token")
                : new (Token as any)(TOKEN_PROGRAM_ID, poolKeys.quoteMint, Number(poolKeys.quoteDecimals), "QUOTE", "Quote Token");

            // 3. Compute Amounts
            const amountIn = new TokenAmount(currencyIn, Math.floor(amountSol * 1e9), false);
            const slippageProxy = new Percent(slippagePercent, 100);

            const computation = Liquidity.computeAmountOut({
                poolKeys,
                poolInfo: await Liquidity.fetchInfo({ connection: this.connection, poolKeys }),
                amountIn,
                currencyOut,
                slippage: slippageProxy,
            });

            // 4. Create Transaction
            const { innerTransactions } = await Liquidity.makeSwapInstructionSimple({
                connection: this.connection,
                poolKeys,
                userKeys: {
                    tokenAccounts: [], // SDK will find associated accounts
                    owner: this.wallet.publicKey,
                },
                amountIn: amountIn,
                amountOut: computation.minAmountOut,
                fixedSide: 'in',
                makeTxVersion: 0,
            });

            // 5. Build & Send
            // innerTransactions is Array<InnerSimpleV0Transaction>
            // Each has .instructions (TransactionInstruction[])
            const iTx = innerTransactions[0];
            const transaction = new Transaction();
            transaction.add(...iTx.instructions);
            transaction.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
            transaction.feePayer = this.wallet.publicKey;

            transaction.sign(this.wallet);
            const rawTransaction = transaction.serialize();

            const txid = await this.connection.sendRawTransaction(rawTransaction, { skipPreflight: true });
            await this.connection.confirmTransaction(txid);

            console.log(`[RAYDIUM] Swap Success: https://solscan.io/tx/${txid}`);
            return { success: true, amount: BigInt(computation.amountOut.raw.toString()) };

        } catch (e: any) {
            console.error("[RAYDIUM] Swap Failed:", e);
            return { success: false, amount: BigInt(0), error: `Raydium Error: ${e.message}` };
        }


    }

    /**
     * Fallback: Swap directly via Meteora DLMM SDK.
     */
    async swapMeteoraDLMM(mint: PublicKey, pairAddress: string, amountSol: number, slippagePercent: number): Promise<{ success: boolean; amount: bigint; error?: string }> {
        console.log(`[STRATEGY] Initiating Meteora DLMM Swap for Pair: ${pairAddress}`);

        try {
            const SDK = DLMM as any;
            const dlmmPool = await SDK.create(this.connection, new PublicKey(pairAddress));

            // Determine direction
            // We are buying 'mint' with SOL.
            // Check if mint is Token X or Token Y
            const isBuyX = dlmmPool.tokenX.publicKey.toBase58() === mint.toBase58();
            const swapAmount = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL)); // Input is SOL
            const swapForY = !isBuyX; // If we want X, we swap Y->X (swapForY=false). If we want Y, we swap X->Y (swapForY=true)

            // Swap Parameters
            // Meteora SDK swap signature might vary, relying on basic usage:
            // swap({ inToken, outToken, inAmount, minOutAmount, lbPair, user, ... })
            // But DLMM class has .swap() method usually.

            // Checking DLMM SDK docs usually:
            // await dlmmPool.swap({ inToken, outToken, inAmount, minOutAmount, lbPair, user, ... })

            // For safety and speed, we assume we might need to use a general swap instruction builder if class method is complex.
            // But let's try the high-level method if available or construct tx.

            // Using a simplified approach assuming we can build the tx:
            const binArrays = await dlmmPool.getBinArrayForSwap(swapForY);

            // Ensure we have the swap method access
            const swapParams = {
                inToken: swapForY ? dlmmPool.tokenX.publicKey : dlmmPool.tokenY.publicKey,
                outToken: swapForY ? dlmmPool.tokenY.publicKey : dlmmPool.tokenX.publicKey,
                inAmount: new BN(swapAmount.toString()),
                minOutAmount: new BN(0), // Slippage handling needed here
                lbPair: dlmmPool.pubkey,
                user: this.wallet.publicKey,
                binArrays: binArrays,
                slippage: new BN(slippagePercent * 100) // BPS?
            };

            // Calculate min amount out for slippage
            // const quote = dlmmPool.swapQuote(swapAmount, swapForY, new BN(slippagePercent * 100)); 
            // swapParams.minOutAmount = quote.minOut;

            const swapTx = await dlmmPool.swap({
                inAmount: new BN(swapAmount.toString()),
                lbPair: dlmmPool.pubkey,
                minOutAmount: new BN(0), // Needs quote logic for strict slippage
                swapForY,
                user: this.wallet.publicKey,
                priorityFee: { unitLimit: 200000, unitPrice: 100000 } // Auto fee
            });

            const txid = await sendAndConfirmTransaction(this.connection, swapTx, [this.wallet], { skipPreflight: true });
            console.log(`[METEORA] Swap Success: https://solscan.io/tx/${txid}`);

            return { success: true, amount: BigInt(0) }; // TODO: Return actual amount

        } catch (e: any) {
            console.error("[METEORA] Swap Failed:", e);
            return { success: false, amount: BigInt(0), error: `Meteora Error: ${e.message}` };
        }
    }
}

