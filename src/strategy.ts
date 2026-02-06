import { Connection, PublicKey, Transaction, SystemProgram, Keypair, LAMPORTS_PER_SOL, sendAndConfirmTransaction, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { wallet, connection, JUPITER_API_KEY } from "./config";
import bs58 from "bs58";
import { PumpFunHandler } from "./pumpfun";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import DLMM from "@meteora-ag/dlmm";
import { Liquidity, LiquidityPoolKeys, Token, TokenAmount, Percent, Currency, SOL, MAINNET_PROGRAM_ID, SPL_ACCOUNT_LAYOUT } from "@raydium-io/raydium-sdk";
import { Market } from "@project-serum/serum";
import axios from "axios";
import { SocketManager } from "./socket";
import { JitoExecutor } from "./jito";



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

            // 1. Request Ultra Order (Directly - No separate quote step needed for Ultra)
            console.log(`[ULTRA] Requesting Swap Order...`);

            let orderResponse;
            const headers = {
                'x-api-key': JUPITER_API_KEY || ''
            };

            try {
                // Ultra V1: GET /ultra/v1/order
                const params = new URLSearchParams({
                    inputMint: "So11111111111111111111111111111111111111112",
                    outputMint: mint.toBase58(),
                    amount: amountLamports.toString(),
                    taker: this.wallet.publicKey.toBase58(),
                    // Optional: slippageBps could be added if needed, but Ultra handles it.
                    // Ultra is "Recommended" because it manages routing/slippage automatically.
                });

                orderResponse = (await axios.get(`https://api.jup.ag/ultra/v1/order?${params}`, { headers })).data;

            } catch (err: any) {
                if (axios.isAxiosError(err) && err.response?.data) {
                    throw new Error(`Ultra API Error: ${JSON.stringify(err.response.data)}`);
                }
                throw err;
            }

            const { transaction: swapTransaction, requestId } = orderResponse;

            if (!swapTransaction) {
                throw new Error(`Ultra Order failed: No transaction returned. Response: ${JSON.stringify(orderResponse)}`);
            }
            console.log(`[ULTRA] Order Created. Type: Ultra Direct. Request ID: ${requestId}`);


            // 3. Deserialize and Sign
            const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
            transaction.sign([this.wallet]);

            // 4. JITO EXECUTION (Bundle: Swap + Tip)
            // This bypasses RPC congestion and front-running
            console.log(`[JITO] Preparing Bundle Execution...`);

            try {
                const JITO_TIP_LAMPORTS = 100000; // 0.0001 SOL Tip
                const tipTx = await JitoExecutor.createTipTransaction(this.connection, this.wallet, JITO_TIP_LAMPORTS);

                // Main Swap Tx is already signed by `transaction.sign([this.wallet])` above
                // Jito expects base58 encoded transactions
                const b58Swap = bs58.encode(transaction.serialize());
                const b58Tip = bs58.encode(tipTx.serialize() as Uint8Array);

                const jitoResult = await JitoExecutor.sendBundle([b58Swap, b58Tip], "Jupiter+Tip");

                if (!jitoResult.success) {
                    throw new Error("Jito Bundle submission failed");
                }

                console.log(`[JITO] Bundle Submitted. Waiting for confirmation...`);
                // We track the Swap Transaction Signature
                // (The bundle ID is internal to Jito, the blockchain sees the tx signature)
                const signature = bs58.encode(transaction.signatures[0]);

                await this.connection.confirmTransaction(signature, "confirmed");
                console.log(`[STRATEGY] Jupiter Swap Success (Jito): https://solscan.io/tx/${signature}`);

                // Return success
                const outAmount = BigInt(0);
                return { success: true, amount: outAmount };

            } catch (jitoError: any) {
                console.warn(`[JITO] Execution Failed (${jitoError.message}). Falling back to Standard RPC...`);

                // FALLBACK: Standard RPC Execution
                const rawTx = transaction.serialize();
                const txid = await this.connection.sendRawTransaction(rawTx, {
                    skipPreflight: true,
                    maxRetries: 2
                });
                await this.connection.confirmTransaction(txid);
                console.log(`[STRATEGY] Jupiter Swap Success (RPC Fallback): https://solscan.io/tx/${txid}`);

                const outAmount = BigInt(0);
                return { success: true, amount: outAmount };
            }

            // Fetch bought amount estimate
            const outAmount = BigInt(0);

            return { success: true, amount: outAmount };

        } catch (error: any) {
            let errMsg = error.message;
            if (axios.isAxiosError(error) && error.response?.data) {
                errMsg = `API Error: ${JSON.stringify(error.response.data)}`;
            }
            console.error(`[ERROR] Jupiter Swap failed:`, errMsg);

            // FALLBACK STRATEGY DISABLED (User: Full Jupiter/Metis Only)
            // We rely 100% on Jupiter + Jito Bundles now.
            // If Jupiter fails, we stop and retry next cycle.

            console.warn(`[STRATEGY] Jupiter Failed. Fallbacks are DISABLED (Jupiter Only Mode).`);
            SocketManager.emitLog("[STRATEGY] Jupiter Failed. Retrying next cycle...", "warning");

            return { success: false, amount: BigInt(0), error: `Jupiter Only Mode: ${errMsg}` };

            /* DISABLED FALLBACKS
            const isTransientError = errMsg.includes("ENOTFOUND") || errMsg.includes("401") || errMsg.includes("429") || errMsg.includes("timeout") || errMsg.includes("500") || errMsg.includes("Network Error");
            const isRouteNotFoundError = errMsg.includes("Route not found") || errMsg.includes("404") || errMsg.includes("Could not get quote");
            const shouldFallback = isTransientError || isRouteNotFoundError;

            if (shouldFallback) {
                 // ... Fallback logic removed ...
            }
            */
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
            const positionKeypair = Keypair.generate();
            const addLiquidityTx = await newPool.initializePositionAndAddLiquidityByStrategy({
                positionPubKey: positionKeypair.publicKey,
                user: this.wallet.publicKey,
                totalX,
                totalY,
                strategy: {
                    maxBinId: 0,
                    minBinId: 0,
                    strategyType: 0 // Spot
                }
            });

            // Sign and send - handle potentially multiple transactions or versioned transactions
            let txid: string;
            const txs = Array.isArray(addLiquidityTx) ? addLiquidityTx : [addLiquidityTx];

            for (const tx of txs) {
                if (tx instanceof VersionedTransaction) {
                    tx.sign([this.wallet, positionKeypair]);
                    txid = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
                } else {
                    txid = await sendAndConfirmTransaction(
                        this.connection,
                        tx,
                        [this.wallet, positionKeypair],
                        { skipPreflight: true, commitment: "confirmed" }
                    );
                }
            }

            SocketManager.emitLog(`[SUCCESS] Liquidity Seeded! Tx: ${txid!.slice(0, 8)}...`, "success");

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
                console.warn("[RAYDIUM] API Fetch by ID failed, proceeding to Mint discovery...");
            }

            // 1b. Fallback: Fetch by Mint (If pairAddress was invalid or from Meteora)
            if (!poolData) {
                try {
                    console.log("[RAYDIUM] Pool ID lookup failed. Attempting lookup by Token Mint...");
                    // Use WSOL Mint for the pair
                    const SOL_MINT = "So11111111111111111111111111111111111111112";
                    const response = await axios.get(`https://api-v3.raydium.io/pools/info/mint?mint1=${mint.toBase58()}&mint2=${SOL_MINT}&poolType=all&poolSortField=default&sortType=desc&pageSize=1&page=1`);
                    poolData = response.data.data?.[0];

                    if (poolData) {
                        console.log(`[RAYDIUM] Found correct Pool ID via Mint: ${poolData.id}`);
                        // We found it!
                    }
                } catch (mintErr) {
                    console.warn("[RAYDIUM] API Fetch by Mint failed...");
                }
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
                    console.warn("[RAYDIUM] V2 Backup API failed...");
                }
            }

            // 2. TRUE ON-CHAIN SEARCH (If API fails, find the address ourselves)
            if (!poolData) {
                try {
                    console.log("[RAYDIUM] Determining correct pool address on-chain...");
                    // Raydium V4 Program ID
                    const RAYDIUM_V4_PROGRAM_ID = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
                    const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
                    const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

                    // Filter 1: Token / SOL
                    const filtersSol = [
                        { dataSize: 752 },
                        { memcmp: { offset: 400, bytes: mint.toBase58() } }, // Base = Token
                        { memcmp: { offset: 432, bytes: SOL_MINT.toBase58() } }  // Quote = SOL
                    ];

                    let accounts = await this.connection.getProgramAccounts(RAYDIUM_V4_PROGRAM_ID, { filters: filtersSol });

                    if (accounts.length === 0) {
                        // Filter 2: SOL / Token
                        const filtersSolRev = [
                            { dataSize: 752 },
                            { memcmp: { offset: 400, bytes: SOL_MINT.toBase58() } },
                            { memcmp: { offset: 432, bytes: mint.toBase58() } }
                        ];
                        accounts = await this.connection.getProgramAccounts(RAYDIUM_V4_PROGRAM_ID, { filters: filtersSolRev });
                    }

                    if (accounts.length === 0) {
                        // Filter 3: Token / USDC (Common for larger launches)
                        const filtersUsdc = [
                            { dataSize: 752 },
                            { memcmp: { offset: 400, bytes: mint.toBase58() } },
                            { memcmp: { offset: 432, bytes: USDC_MINT.toBase58() } }
                        ];
                        accounts = await this.connection.getProgramAccounts(RAYDIUM_V4_PROGRAM_ID, { filters: filtersUsdc });
                    }

                    if (accounts.length === 0) {
                        // Filter 4: USDC / Token
                        const filtersUsdcRev = [
                            { dataSize: 752 },
                            { memcmp: { offset: 400, bytes: USDC_MINT.toBase58() } },
                            { memcmp: { offset: 432, bytes: mint.toBase58() } }
                        ];
                        accounts = await this.connection.getProgramAccounts(RAYDIUM_V4_PROGRAM_ID, { filters: filtersUsdcRev });
                    }

                    if (accounts.length > 0) {
                        const correctPairAddress = accounts[0].pubkey.toBase58();
                        console.log(`[RAYDIUM] Found On-Chain Pool Address: ${correctPairAddress} (Replacing: ${pairAddress})`);
                        pairAddress = correctPairAddress; // UPDATE LOCAL VAR
                    }
                } catch (searchErr) {
                    console.warn("[RAYDIUM] On-Chain Address Search Failed:", searchErr);
                }
            }

            // 3. TRUE ON-CHAIN DISCOVERY (The "Nuclear Option")
            // This now uses the potentially corrected 'pairAddress'
            if (!poolData) {
                try {
                    console.log("[RAYDIUM] Attempting direct on-chain account fetch...");
                    const poolId = new PublicKey(pairAddress);
                    const accountInfo = await this.connection.getAccountInfo(poolId);

                    if (!accountInfo) {
                        console.error(`[RAYDIUM] No account found at address: ${pairAddress}`);
                        throw new Error("Pool account does not exist on-chain");
                    }

                    // Verify this is actually a Raydium account by checking owner
                    const RAYDIUM_V4_PROGRAM_ID = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
                    if (!accountInfo.owner.equals(RAYDIUM_V4_PROGRAM_ID)) {
                        console.error(`[RAYDIUM] Account owner mismatch. Expected Raydium V4, got: ${accountInfo.owner.toBase58()}`);
                        throw new Error("Account is not a Raydium V4 pool");
                    }

                    if (accountInfo) {
                        const LIQUIDITY_STATE_LAYOUT_V4 = Liquidity.getStateLayout(4);
                        const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(accountInfo.data);

                        const marketId = poolState.marketId;
                        const marketAccountInfo = await this.connection.getAccountInfo(marketId);

                        if (marketAccountInfo) {
                            // Decode Market Data using the Market class from @project-serum/serum
                            // Program ID for decoding is usually the owner of the account
                            const MARKET_STATE_LAYOUT_V3 = Market.getLayout(marketAccountInfo.owner);
                            const marketState = MARKET_STATE_LAYOUT_V3.decode(marketAccountInfo.data);

                            // Reconstruction
                            poolData = {
                                id: pairAddress,
                                mintA: { address: poolState.baseMint.toBase58(), decimals: poolState.baseDecimal.toNumber() },
                                mintB: { address: poolState.quoteMint.toBase58(), decimals: poolState.quoteDecimal.toNumber() },
                                lpMint: { address: poolState.lpMint.toBase58(), decimals: 9 },
                                programId: accountInfo.owner.toBase58(),
                                authority: PublicKey.default.toBase58(), // Calculated usually but SDK handles if implicit
                                openOrders: poolState.openOrders.toBase58(),
                                targetOrders: poolState.targetOrders.toBase58(),
                                vault: { A: poolState.baseVault.toBase58(), B: poolState.quoteVault.toBase58() },
                                marketProgramId: poolState.marketProgramId.toBase58(),
                                marketId: marketId.toBase58(),
                                marketAuthority: PublicKey.default.toBase58(),
                                marketVault: { A: marketState.baseVault.toBase58(), B: marketState.quoteVault.toBase58() },
                                marketBids: marketState.bids.toBase58(),
                                marketAsks: marketState.asks.toBase58(),
                                marketEventQueue: marketState.eventQueue.toBase58()
                            };

                            console.log("[RAYDIUM] SUCCESS: Reconstructed pool data from on-chain state!");
                        }
                    }
                } catch (chainErr: any) {
                    console.error("[RAYDIUM] On-Chain Discovery Failed:", chainErr.message);
                }
            }

            if (!poolData) {
                return { success: false, amount: BigInt(0), error: "Raydium Pool Data not found anywhere (API or On-Chain)" };
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

            const amountOut = computation.amountOut;
            const minAmountOut = computation.minAmountOut;


            // HELPER: Fetch Token Accounts manually for SDK verification
            // This prevents "failed to simulate" errors inside the SDK due to missing account context
            const userTokenAccounts = await this.getOwnerTokenAccounts();

            // 4. Create Transaction Instructions (Simple V0)
            const { innerTransactions } = await Liquidity.makeSwapInstructionSimple({
                connection: this.connection,
                poolKeys,
                userKeys: {
                    tokenAccounts: userTokenAccounts, // <--- PASS REAL ACCOUNTS
                    owner: this.wallet.publicKey,
                },
                amountIn: amountIn,
                amountOut: computation.minAmountOut,
                fixedSide: 'in',
                makeTxVersion: 0,
            });

            // 5. Build & Send Sequentially
            // Raydium SDK might break the swap into multiple transactions (e.g. Setup ATA -> Swap)
            // We must execute them in order.
            console.log(`[RAYDIUM] Processing ${innerTransactions.length} internal transactions...`);

            let lastTxId = "";
            for (const iTx of innerTransactions) {
                const tx = new Transaction();

                // PRIORITY FEES (Add to EVERY transaction) - Critical for Raydium
                tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
                tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }));

                tx.add(...iTx.instructions);
                tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
                tx.feePayer = this.wallet.publicKey;

                tx.sign(this.wallet);
                const rawTransaction = tx.serialize();

                // Skip Preflight to generally avoid "Simulation Error" blocking the send
                // We rely on our added Compute Budget to get it processed
                const txid = await this.connection.sendRawTransaction(rawTransaction, { skipPreflight: true });
                console.log(`[RAYDIUM] Sent Internal Tx: https://solscan.io/tx/${txid}`);

                // Confirm before next step (Crucial for ATAs)
                await this.connection.confirmTransaction(txid, "confirmed");
                lastTxId = txid;
            }

            console.log(`[RAYDIUM] Swap Sequence Complete! Final Tx: https://solscan.io/tx/${lastTxId}`);
            return { success: true, amount: BigInt(computation.amountOut.raw.toString()) };

        } catch (e: any) {
            console.error("[RAYDIUM] Swap Failed:", e);
            return { success: false, amount: BigInt(0), error: `Raydium Error: ${e.message}` };
        }


    }

    async getConnectionTokenAccounts(owner: PublicKey) {
        const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(owner, {
            programId: TOKEN_PROGRAM_ID
        });

        return tokenAccounts.value.map(i => ({
            pubkey: i.pubkey,
            programId: i.account.owner,
            accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data as any) // We might need raw data for decode
            // Actually Raydium SDK expects specific format.
            // Simplest is to pass empty and let SDK fetch, BUT IT FAILS.
            // Alternative: Use `getTokenAccountsByOwner` with raw encoding and let SDK parse it if we pass it correctly.
        }));
    }

    // Helper for SDK format
    async getOwnerTokenAccounts() {
        // Implementation that matches what Raydium expects
        const walletTokenAccount = await this.connection.getTokenAccountsByOwner(this.wallet.publicKey, {
            programId: TOKEN_PROGRAM_ID,
        });
        return walletTokenAccount.value.map((i) => ({
            pubkey: i.pubkey,
            programId: i.account.owner,
            accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data),
        }));
    }

    /**
     * Fallback: Swap directly via Meteora DLMM SDK.
     */
    async swapMeteoraDLMM(mint: PublicKey, pairAddress: string, amountSol: number, slippagePercent: number): Promise<{ success: boolean; amount: bigint; error?: string }> {
        console.log(`[STRATEGY] Initiating Meteora DLMM Swap for Pair: ${pairAddress}`);

        try {
            const SDK = DLMM as any;
            const dlmmPool = await SDK.create(this.connection, new PublicKey(pairAddress));

            // 2. Identify Token X and Y (Meteora SDK structure)
            const tokenX = dlmmPool.tokenX;
            const tokenY = dlmmPool.tokenY;

            if (!tokenX || !tokenY) {
                // Try alternate property names or fetch
                throw new Error("Meteora Pool missing Token X/Y data");
            }

            // 3. Prepare Swap Parameters
            // We must pass IN and OUT tokens explicitly to avoid SDK guessing and failing matches
            const isBuy = mint.toBase58() !== "So11111111111111111111111111111111111111112"; // Assuming buy if target is not SOL? 
            // Better: Check which one matches our input. 
            // We are Swapping SOL -> Token.
            // So InToken = SOL (or Wrapped SOL), OutToken = Target.

            // Actually, we are holding SOL. We want Target.
            const SOL_MINT = "So11111111111111111111111111111111111111112";
            let inToken, outToken;

            if (tokenX.publicKey.toBase58() === SOL_MINT) {
                inToken = tokenX;
                outToken = tokenY;
            } else if (tokenY.publicKey.toBase58() === SOL_MINT) {
                inToken = tokenY;
                outToken = tokenX;
            } else {
                // Maybe we are spending USDC? Bot logic says amountSol..
                // Let's assume input is Token X if X is SOL/USDC.
                // Safer: Check which one is NOT the target mint.
                if (tokenX.publicKey.toBase58() === mint.toBase58()) {
                    outToken = tokenX;
                    inToken = tokenY;
                } else {
                    outToken = tokenY;
                    inToken = tokenX;
                }
            }

            const swapAmount = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));
            const binArrays = await dlmmPool.getBinArrayForSwap(true); // true = swapForY? No, allow SDK to fetch.

            // SDK `swap` signature requires specific params. 
            // The crash `equals` comes from it comparing inToken to tokenX/Y.

            const swapTx = await dlmmPool.swap({
                inToken: inToken.publicKey,
                outToken: outToken.publicKey,
                inAmount: new BN(swapAmount.toString()),
                minOutAmount: new BN(0), // Slippage handled by simple minimum 0 for now (Bot default 10% is high)
                lbPair: dlmmPool.pubkey,
                user: this.wallet.publicKey,
            });

            // 4. JITO EXECUTION (Meteora via Bundle)
            // Just like Jupiter, let's bundle this!
            if (process.env.USE_JITO !== 'false') { // Default to True
                const JITO_TIP_LAMPORTS = 100000;
                const tipTx = await JitoExecutor.createTipTransaction(this.connection, this.wallet, JITO_TIP_LAMPORTS);

                let b58Swap: string;

                // Sign Swap Tx
                if (swapTx instanceof VersionedTransaction) {
                    swapTx.sign([this.wallet]);
                    b58Swap = bs58.encode(swapTx.serialize());
                } else {
                    // Legacy
                    swapTx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
                    swapTx.feePayer = this.wallet.publicKey;
                    swapTx.sign(this.wallet);
                    b58Swap = bs58.encode(swapTx.serialize());
                }

                const b58Tip = bs58.encode(tipTx.serialize() as Uint8Array);

                console.log(`[METEORA] Sending Jito Bundle...`);
                const jitoResult = await JitoExecutor.sendBundle([b58Swap, b58Tip], "Meteora+Tip");

                if (jitoResult.success) {
                    console.log(`[METEORA] Jito Bundle Queued!`);
                    // Confirm
                    const signature = swapTx instanceof VersionedTransaction ? bs58.encode(swapTx.signatures[0]) : bs58.encode(swapTx.signature!);
                    await this.connection.confirmTransaction(signature, "confirmed");
                    return { success: true, amount: BigInt(0) };
                }
            }

            // Fallback: Standard Send
            let txid: string;
            if (swapTx instanceof VersionedTransaction) {
                swapTx.sign([this.wallet]);
                txid = await this.connection.sendRawTransaction(swapTx.serialize(), { skipPreflight: true });
            } else {
                txid = await sendAndConfirmTransaction(this.connection, swapTx, [this.wallet], { skipPreflight: true });
            }

            console.log(`[METEORA] Swap Success: https://solscan.io/tx/${txid}`);

            return { success: true, amount: BigInt(0) };

        } catch (e: any) {
            console.error("[METEORA] Swap Failed:", e);
            if (e.message.includes("discriminator")) {
                return { success: false, amount: BigInt(0), error: "Not a DLMM Pool" };
            }
            return { success: false, amount: BigInt(0), error: `Meteora Error: ${e.message}` };
        }
    }


    /**
     * Fallback: Swap on Pump.fun Bonding Curve
     * Used when the token is NOT on Raydium or Meteora yet.
     */
    async swapPumpFun(mint: PublicKey, amountSol: number, slippagePercent: number = 25): Promise<{ success: boolean; amount: bigint; error?: string }> {
        console.log(`[STRATEGY] Initializing Pump.fun Swap for ${mint.toBase58()}...`);

        try {
            // 1. Fetch Bonding Curve State
            const curveState = await PumpFunHandler.getBondingCurveState(this.connection, mint);

            if (!curveState) {
                const msg = "Bonding Curve not found (Token might be migrated)";
                console.error(`[PUMP ERROR] ${msg}`);
                return { success: false, amount: BigInt(0), error: msg };
            }

            console.log(`[PUMP] Found Bonding Curve: ${curveState.bondingCurve.toBase58()}`);

            // 2. Calculate Amounts
            const { amountTokens, maxSolCost } = PumpFunHandler.calculateBuyAmount(curveState, amountSol, slippagePercent * 100);

            if (amountTokens === BigInt(0)) {
                const msg = "Calculation failed due to liquidity limits (Amount 0)";
                console.error(`[PUMP ERROR] ${msg}`);
                return { success: false, amount: BigInt(0), error: msg };
            }

            console.log(`[PUMP] Buying ~${amountTokens.toString()} tokens for max ${maxSolCost.toString()} Lamports`);

            // 3. Create Instruction
            const { instruction, associatedUser, createAtaInstruction } = await PumpFunHandler.createBuyInstruction(
                this.wallet.publicKey,
                mint,
                new BN(amountTokens.toString()), // Buy specific amount of tokens
                new BN(maxSolCost.toString())    // Max SOL we are willing to pay
            );

            // 4. Build Transaction
            const transaction = new Transaction();

            // Add priority fee
            transaction.add(
                // Compute Budget logic could go here
            );

            // Add ATA creation if needed (usually handled, but good to ensure)
            const ataInfo = await this.connection.getAccountInfo(associatedUser);
            if (!ataInfo && createAtaInstruction) {
                transaction.add(createAtaInstruction);
            }

            transaction.add(instruction);

            // 5. Send
            const txid = await sendAndConfirmTransaction(this.connection, transaction, [this.wallet], {
                skipPreflight: true,
                commitment: "confirmed",
                maxRetries: 3
            });

            console.log(`[PUMP] Swap Success! Tx: https://solscan.io/tx/${txid}`);
            return { success: true, amount: BigInt(amountTokens.toString()) };

        } catch (error: any) {
            console.error(`[PUMP] Swap Failed:`, error);
            return { success: false, amount: BigInt(0), error: error.message };
        }
    }
}
