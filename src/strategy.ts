import { Connection, PublicKey, Transaction, SystemProgram, Keypair, LAMPORTS_PER_SOL, sendAndConfirmTransaction, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { wallet, connection, JUPITER_API_KEY } from "./config";
import bs58 from "bs58";
import { PumpFunHandler } from "./pumpfun";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
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
            const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
            const slippageBps = Math.floor(slippagePercent * 100);

            // 0. Pre-Swap Balance Check (To calculate actual received amount)
            const ata = await getAssociatedTokenAddress(mint, this.wallet.publicKey);
            let preBalance = BigInt(0);
            try {
                const acc = await this.connection.getTokenAccountBalance(ata);
                preBalance = BigInt(acc.value.amount);
            } catch (ignore) { /* Account likely doesn't exist yet */ }

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

                // Capture actual amount
                let postBalance = BigInt(0);
                try {
                    const acc = await this.connection.getTokenAccountBalance(ata);
                    postBalance = BigInt(acc.value.amount);
                } catch (e) { console.warn(`[STRATEGY] Failed to fetch post-balance: ${e}`); }

                const outAmount = postBalance > preBalance ? (postBalance - preBalance) : BigInt(0);
                console.log(`[STRATEGY] Swap Complete. Received: ${outAmount.toString()} tokens.`);

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

                // Capture actual amount
                let postBalance = BigInt(0);
                try {
                    const acc = await this.connection.getTokenAccountBalance(ata);
                    postBalance = BigInt(acc.value.amount);
                } catch (e) { console.warn(`[STRATEGY] Failed to fetch post-balance: ${e}`); }

                const outAmount = postBalance > preBalance ? (postBalance - preBalance) : BigInt(0);
                return { success: true, amount: outAmount };
            }

        } catch (error: any) {
            let errMsg = error.message;
            if (axios.isAxiosError(error) && error.response?.data) {
                errMsg = `API Error: ${JSON.stringify(error.response.data)}`;
            }
            console.error(`[ERROR] Jupiter Swap failed:`, errMsg);

            // FALLBACK STRATEGY DISABLED (User: Full Jupiter/Metis Only)
            console.warn(`[STRATEGY] Jupiter Failed. Fallbacks are DISABLED (Jupiter Only Mode).`);
            SocketManager.emitLog("[STRATEGY] Jupiter Failed. Retrying next cycle...", "warning");

            return { success: false, amount: BigInt(0), error: `Jupiter Only Mode: ${errMsg}` };
        }
    }


    /**
     * Fallback: Swap directly via Raydium SDK if Jupiter fails.
     */
    async swapRaydium(mint: PublicKey, pairAddress: string, amountSol: number, slippagePercent: number): Promise<{ success: boolean; amount: bigint; error?: string }> {
        console.log(`[STRATEGY] Initiating Raydium Direct Swap for Pair: ${pairAddress} `);

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
     * Fallback: Swap directly via Meteora DAMM V2 SDK.
     */
    async swapMeteoraDLMM(mint: PublicKey, pairAddress: string, amountSol: number, slippagePercent: number): Promise<{ success: boolean; amount: bigint; error?: string }> {
        console.log(`[STRATEGY] Initiating Meteora DAMM V2 Swap for Pair: ${pairAddress}`);

        try {
            const { CpAmm } = require("@meteora-ag/cp-amm-sdk");

            // 1. Fetch Pool Instance
            const cpAmm = await CpAmm.create(this.connection, new PublicKey(pairAddress));

            // 2. Identify Input/Output
            const SOL_MINT = "So11111111111111111111111111111111111111112";
            let inputToken = cpAmm.tokenMintA;
            // Unused outputToken - keeping commented if needed for debug
            // let outputToken = cpAmm.tokenMintB;

            // We are Swapping SOL -> Token
            if (inputToken.toBase58() === SOL_MINT) {
                // Correct: A is SOL, B is Token
                inputToken = cpAmm.tokenMintA;
            } else if (cpAmm.tokenMintB.toBase58() === SOL_MINT) {
                // Swap: B is SOL, A is Token
                inputToken = cpAmm.tokenMintB;
            } else {
                // USDC or other base pair? Assume input is whatever matches our wallet balance logic?
                // For now, assume SOL is involved. If not, default to A->B.
            }

            const amountIn = new BN(amountSol * LAMPORTS_PER_SOL);

            // 3. Create Swap Instructions
            const swapResult = await cpAmm.swap(
                this.wallet.publicKey,
                inputToken,
                amountIn,
                new BN(0) // Min out (0 for now)
            );

            // 4. Execute (Jito or Standard)
            let swapTx: Transaction | VersionedTransaction;

            if (swapResult.instructions) {
                swapTx = new Transaction().add(...swapResult.instructions);
            } else {
                // Some SDK versions return tx directly
                swapTx = swapResult as unknown as Transaction;
            }

            if (process.env.USE_JITO !== 'false') {
                // Jito Logic
                const JITO_TIP_LAMPORTS = 100000;
                const tipTx = await JitoExecutor.createTipTransaction(this.connection, this.wallet, JITO_TIP_LAMPORTS);

                let b58Swap: string;
                if (swapTx instanceof VersionedTransaction) {
                    swapTx.sign([this.wallet]);
                    b58Swap = bs58.encode(swapTx.serialize());
                } else {
                    swapTx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
                    swapTx.feePayer = this.wallet.publicKey;
                    swapTx.sign(this.wallet);
                    b58Swap = bs58.encode(swapTx.serialize());
                }
                const b58Tip = bs58.encode(tipTx.serialize() as Uint8Array);

                console.log(`[METEORA] Sending Jito Bundle...`);
                const jitoResult = await JitoExecutor.sendBundle([b58Swap, b58Tip], "Meteora+Tip");
                if (jitoResult.success) {
                    return { success: true, amount: BigInt(0) };
                }
            }

            // Fallback Send
            const txSig = await sendAndConfirmTransaction(this.connection, swapTx as Transaction, [this.wallet], { skipPreflight: true, commitment: "confirmed" });
            console.log(`[METEORA] Swap Success: https://solscan.io/tx/${txSig}`);
            return { success: true, amount: BigInt(0) };

        } catch (e: any) {
            console.error(`[METEORA] Swap Failed:`, e);
            return { success: false, amount: BigInt(0), error: e.message };
        }
    }

    /**
     * Fallback: Swap on Pump.fun Bonding Curve
     * Used when the token is NOT on Raydium or Meteora yet.
     */
    async swapPumpFun(mint: PublicKey, amountSol: number, slippagePercent: number = 25): Promise<{ success: boolean; amount: bigint; error?: string }> {
        console.log(`[STRATEGY] Initializing Pump.fun Swap for ${mint.toBase58()}...`);
        try {
            const curveState = await PumpFunHandler.getBondingCurveState(this.connection, mint);
            if (!curveState) return { success: false, amount: BigInt(0), error: "Bonding Curve not found" };

            const { amountTokens, maxSolCost } = PumpFunHandler.calculateBuyAmount(curveState, amountSol, slippagePercent * 100);
            if (amountTokens === BigInt(0)) return { success: false, amount: BigInt(0), error: "Amount 0" };

            const { instruction, associatedUser, createAtaInstruction } = await PumpFunHandler.createBuyInstruction(
                this.wallet.publicKey,
                mint,
                new BN(amountTokens.toString()),
                new BN(maxSolCost.toString())
            );

            const transaction = new Transaction();
            if (createAtaInstruction) transaction.add(createAtaInstruction);
            transaction.add(instruction);

            const txid = await sendAndConfirmTransaction(this.connection, transaction, [this.wallet], { skipPreflight: true, commitment: "confirmed", maxRetries: 3 });
            console.log(`[PUMP] Swap Success! Tx: https://solscan.io/tx/${txid}`);
            return { success: true, amount: BigInt(amountTokens.toString()) };
        } catch (error: any) {
            console.error(`[PUMP] Swap Failed:`, error);
            return { success: false, amount: BigInt(0), error: error.message };
        }
    }

    /**
     * Creates a Meteora DAMM V2 Pool (Standard Constant Product) and seeds initial liquidity.
     * Expects RAW ATOMIC AMOUNTS (BigInt), not UI amounts.
     */
    /**
     * Creates a Meteora DAMM V2 Pool (Constant Product).
     * Uses Standard Static Config (Index 0) for 0.25% fee (Standard Volatile).
     */
    async createMeteoraPool(tokenMint: PublicKey, tokenAmount: bigint, baseAmount: bigint, baseMint: PublicKey = new PublicKey("So11111111111111111111111111111111111111112")): Promise<{ success: boolean; poolAddress?: string; error?: string }> {
        console.log(`[METEORA] Creating DAMM V2 Pool...`);

        try {
            // 1. Load SDK & Constants
            // We use require to ensure we get the JS module execution
            const { CpAmm, deriveConfigAddress, MIN_SQRT_PRICE, MAX_SQRT_PRICE } = require("@meteora-ag/cp-amm-sdk");

            // 2. Sort Tokens (A < B)
            // DAMM V2 uses strict token ordering
            const [tokenA, tokenB] = tokenMint.toBuffer().compare(baseMint.toBuffer()) < 0
                ? [tokenMint, baseMint]
                : [baseMint, tokenMint];

            const [amountA, amountB] = tokenMint.equals(tokenA)
                ? [tokenAmount, baseAmount]
                : [baseAmount, tokenAmount];

            console.log(`[METEORA] A: ${tokenA.toBase58()} (${amountA.toString()}) | B: ${tokenB.toBase58()} (${amountB.toString()})`);

            // 3. Initialize SDK Instance
            const cpAmm = new CpAmm(this.connection);

            // 4. Config & Parameters
            // User requested explicit Static Config Key support.
            // Index 0 is standard 0.25% fee (volatile).
            const configIndex = new BN(0);
            const configAddress = deriveConfigAddress(configIndex);

            // 5. Prepare Pool Params (Calculate SqrtPrice)
            const bnAmountA = new BN(amountA.toString());
            const bnAmountB = new BN(amountB.toString());

            const poolParams = cpAmm.preparePoolCreationParams({
                tokenAAmount: bnAmountA,
                tokenBAmount: bnAmountB,
                tokenAMint: tokenA,
                tokenBMint: tokenB,
                minSqrtPrice: MIN_SQRT_PRICE,
                maxSqrtPrice: MAX_SQRT_PRICE,
            });

            // 6. Create Transaction
            console.log(`[METEORA] Config: ${configAddress.toBase58()} | Init Price: ${poolParams.initSqrtPrice.toString()}`);

            const transaction = await cpAmm.createPool({
                creator: this.wallet.publicKey,
                payer: this.wallet.publicKey,
                config: configAddress,
                tokenAMint: tokenA,
                tokenBMint: tokenB,
                tokenAAmount: bnAmountA,
                tokenBAmount: bnAmountB,
                initSqrtPrice: poolParams.initSqrtPrice,
                liquidityDelta: poolParams.liquidityDelta,
                activationPoint: null, // Immediate
                tokenAProgram: TOKEN_PROGRAM_ID,
                tokenBProgram: TOKEN_PROGRAM_ID, // Assuming standard SPL tokens for now
            });

            // 7. Send & Confirm
            const txSig = await sendAndConfirmTransaction(this.connection, transaction, [this.wallet], {
                skipPreflight: true,
                commitment: "confirmed",
                maxRetries: 5
            });

            console.log(`[METEORA] DAMM V2 Pool Created: https://solscan.io/tx/${txSig}`);
            return { success: true, poolAddress: "Check TX" };

        } catch (e: any) {
            console.error(`[METEORA] Pool Creation Failed:`, e);
            return { success: false, error: e.message };
        }
    }
}
