import { Connection, PublicKey, Transaction, SystemProgram, Keypair, LAMPORTS_PER_SOL, sendAndConfirmTransaction, VersionedTransaction, ComputeBudgetProgram, TransactionExpiredBlockheightExceededError, TransactionMessage } from "@solana/web3.js";
import bs58 from "bs58";
import { wallet, connection, JUPITER_API_KEY, DRY_RUN, SOL_MINT, USDC_MINT, BASE_TOKENS, JITO_TIP_ADDRESSES, JITO_BLOCK_ENGINE_URL, JITO_TIP_LAMPORTS } from "./config";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MINT_SIZE, getMint } from "@solana/spl-token";
import BN from "bn.js";
import { deriveTokenVaultAddress, derivePositionAddress } from "@meteora-ag/cp-amm-sdk";
import { Liquidity, LiquidityPoolKeys, Token, TokenAmount, Percent, Currency, SOL, MAINNET_PROGRAM_ID, SPL_ACCOUNT_LAYOUT } from "@raydium-io/raydium-sdk";
import { Market } from "@project-serum/serum";
import axios from "axios";
import { SocketManager } from "./socket";
import { safeRpc } from "./rpc-utils";
import { JupiterPriceService } from "./jupiter-price-service";

// ── Mint Metadata Cache (decimals + programId never change on-chain) ──
interface MintMeta { decimals: number; programId: PublicKey }
const mintMetaCache = new Map<string, MintMeta>();

export class StrategyManager {
    private connection: Connection;
    private wallet: Keypair;

    constructor(connection: Connection, wallet: Keypair) {
        this.connection = connection;
        this.wallet = wallet;
    }

    /**
     * Returns cached mint metadata (decimals + programId).
     * Fetches from chain on first call, then serves from memory forever.
     */
    private async getCachedMintMeta(mint: PublicKey, conn: Connection): Promise<MintMeta> {
        const key = mint.toBase58();
        const cached = mintMetaCache.get(key);
        if (cached) return cached;

        const info = await safeRpc(() => conn.getAccountInfo(mint), "getMintInfo");
        if (!info) throw new Error(`Mint not found: ${key}`);
        const programId = info.owner;
        const mintData = await safeRpc(() => getMint(conn, mint, "confirmed", programId), "getMintData");
        const meta: MintMeta = { decimals: mintData.decimals, programId };
        mintMetaCache.set(key, meta);
        return meta;
    }

    /**
     * Helper to confirm transactions with Blockheight Expiry handling (Issue 35).
     */
    async confirmOrRetry(signature: string): Promise<boolean> {
        try {
            const latestBlockhash = await safeRpc(() => this.connection.getLatestBlockhash(), "getLatestBlockhash");
            await this.connection.confirmTransaction({
                signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
            }, "confirmed");
            return true;
        } catch (e) {
            if (e instanceof TransactionExpiredBlockheightExceededError) {
                console.warn(`[STRATEGY] Transaction Expired (Blockheight Exceeded): ${signature}`);
                return false;
            }
            throw e;
        }
    }

    /**
     * Updates the connection instance for failover.
     */
    setConnection(conn: Connection) {
        this.connection = conn;
        console.log(`[STRATEGY] Connection Updated for Failover.`);
    }

    /**
     * Updates the active wallet keypair at runtime.
     */
    setKey(newKey: Keypair) {
        this.wallet = newKey;
        console.log(`[STRATEGY] Wallet Key Updated: ${this.wallet.publicKey.toBase58()}`);
    }

    /**
     * Helper to fetch mint decimals dynamically.
     */
    async getMintDecimals(mint: PublicKey): Promise<number> {
        try {
            const accInfo = await safeRpc(() => this.connection.getAccountInfo(mint), "getMintAccountInfo");
            if (!accInfo) return 6; // Fallback to 6
            const programId = accInfo.owner;
            const mintInfo = await safeRpc(() => getMint(this.connection, mint, "confirmed", programId), "getMintInfo");
            return mintInfo.decimals;
        } catch (e) {
            console.warn(`[STRATEGY] Could not fetch decimals for ${mint.toBase58()}, defaulting to 6.`);
            return 6;
        }
    }

    /**
     * Fetches current priority fees from RPC.
     */
    async getPriorityFee(): Promise<number> {
        try {
            const response = await safeRpc(() => this.connection.getRecentPrioritizationFees(), "getRecentPrioritizationFees");
            if (response.length === 0) return 100000; // Default 0.0001 SOL/CU if no data

            // Get median of the last 100 slots
            const sorted = response.map(f => f.prioritizationFee).sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)];

            // Limit to max 1,000,000 (0.001 SOL per 1M CU) to prevent drain
            return Math.min(Math.max(median, 100000), 1000000);
        } catch (e) {
            return 100000;
        }
    }

    /**
     * Sends an array of transactions as a Jito Bundle.
     * Adds a dedicated tip transaction to the end of the bundle.
     */
    async sendJitoBundle(txs: (Transaction | VersionedTransaction)[]): Promise<{ success: boolean; bundleId?: string; signatures?: string[]; error?: string }> {
        try {
            if (DRY_RUN) {
                console.log(`[JITO] Dry run: Simulating bundle with ${txs.length} transactions.`);
                return { success: true, bundleId: "DRY_RUN_BUNDLE" };
            }

            const tipAccount = new PublicKey(JITO_TIP_ADDRESSES[Math.floor(Math.random() * JITO_TIP_ADDRESSES.length)]);
            const recentBlockhash = await this.connection.getLatestBlockhash();

            // Create a dedicated tip transaction and add it to the bundle
            const tipTransaction = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: this.wallet.publicKey,
                    toPubkey: tipAccount,
                    lamports: JITO_TIP_LAMPORTS
                })
            );
            tipTransaction.recentBlockhash = recentBlockhash.blockhash;
            tipTransaction.feePayer = this.wallet.publicKey;
            tipTransaction.sign(this.wallet);

            // Add to the bundle list
            const finalTxs = [...txs, tipTransaction];

            // Jito Limit: Max 5 transactions per bundle
            if (finalTxs.length > 5) {
                throw new Error(`Bundle too large: ${finalTxs.length} transactions. Jito limit is 5. Please reduce the number of positions.`);
            }

            // Extract signatures for tracking
            const signatures = finalTxs.map(tx => {
                const sig = tx.signatures?.[0];
                if (!sig) return "unknown";

                if (tx instanceof Transaction) {
                    const signature = (sig as any).signature;
                    return signature ? bs58.encode(signature) : "unknown";
                } else {
                    return bs58.encode(sig as Uint8Array);
                }
            });

            // Serialize all transactions for Jito
            const serializedTxs = finalTxs.map(tx => {
                return bs58.encode(tx.serialize());
            });

            // Send to Jito Block Engine
            const response = await axios.post(JITO_BLOCK_ENGINE_URL, {
                jsonrpc: "2.0",
                id: 1,
                method: "sendBundle",
                params: [serializedTxs]
            });

            if (response.data.error) {
                console.error(`[JITO] Block Engine Error:`, response.data.error);
                throw new Error(response.data.error.message || "Jito Error");
            }

            const bundleId = response.data.result;
            console.log(`[JITO] Bundle Sent Content-ID: ${bundleId}`);
            return { success: true, bundleId, signatures };

        } catch (error: any) {
            console.error(`[JITO] Bundle Failed:`, error.message);
            return { success: false, error: error.message };
        }
    }


    /**
     * Gets the current price of a token via Jupiter Quote API (read-only, no tx).
     * Used by prebond monitor to check current value of bonding curve tokens.
     */
    async getPrebondPrice(mint: string): Promise<{ pricePerToken: number; success: boolean }> {
        try {
            const headers: Record<string, string> = {};
            if (JUPITER_API_KEY) headers["x-api-key"] = JUPITER_API_KEY;

            // Quote a small SOL amount to get the exchange rate
            const testLamports = Math.floor(0.001 * LAMPORTS_PER_SOL); // 0.001 SOL
            const res = await axios.get("https://api.jup.ag/quote/v1", {
                params: {
                    inputMint: SOL_MINT.toBase58(),
                    outputMint: mint,
                    amount: testLamports.toString(),
                    slippageBps: 1000,
                },
                headers,
                timeout: 5000,
            });

            if (res.data && res.data.outAmount) {
                const solIn = testLamports / LAMPORTS_PER_SOL; // 0.001
                const tokensOut = Number(res.data.outAmount);
                if (tokensOut > 0) {
                    // Price = SOL per token
                    const pricePerToken = solIn / tokensOut;
                    return { pricePerToken, success: true };
                }
            }
            return { pricePerToken: 0, success: false };
        } catch (err: any) {
            console.warn(`[STRATEGY] getPrebondPrice failed for ${mint.slice(0, 8)}: ${err.message}`);
            return { pricePerToken: 0, success: false };
        }
    }

    /**
     * Buys the token using Jupiter Aggregator (Market Buy).
     */
    async swapToken(mint: PublicKey, amountSol: number, slippagePercent: number = 10, pairAddress?: string, dexId?: string): Promise<{ success: boolean; amount: bigint; uiAmount: number; error?: string }> {

        console.log(`[STRATEGY] Swapping ${amountSol} SOL for token: ${mint.toBase58()} via Jupiter (Slippage: ${slippagePercent}%) ${DRY_RUN ? '[DRY RUN]' : ''}`);

        if (DRY_RUN) {
            console.log(`[DRY RUN] Simulating Jupiter Swap...`);
            console.log(`[DRY RUN] Would send ${amountSol} SOL to Jupiter.`);
            const simulatedAmount = BigInt(Math.floor((amountSol * 1e9) * 100)); // Fake 100x price
            const simulatedUi = (amountSol * 100);
            console.log(`[DRY RUN] Success! Received fake ${simulatedAmount} tokens (${simulatedUi} UI).`);
            return { success: true, amount: simulatedAmount, uiAmount: simulatedUi };
        }

        try {
            const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
            const slippageBps = Math.floor(slippagePercent * 100);

            // 0. Pre-Swap Balance Check (To calculate actual received amount)
            const ata = await getAssociatedTokenAddress(mint, this.wallet.publicKey);
            let preBalance = BigInt(0);
            let preUiAmount = 0;
            try {
                const acc = await safeRpc(() => this.connection.getTokenAccountBalance(ata), "getPreBalance");
                preBalance = BigInt(acc.value.amount);
                preUiAmount = acc.value.uiAmount || 0;
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
                    inputMint: SOL_MINT.toBase58(),
                    outputMint: mint.toBase58(),
                    amount: amountLamports.toString(),
                    taker: this.wallet.publicKey.toBase58(),
                });

                // Issue Fix: Add retry logic for DNS/Network Glitches (Jupiter Ultra API)
                let retryCount = 0;
                while (retryCount < 3) {
                    try {
                        const response = await axios.get(`https://api.jup.ag/ultra/v1/order?${params}`, {
                            headers,
                            timeout: 10000 // 10s timeout
                        });
                        orderResponse = response.data;
                        break;
                    } catch (err: any) {
                        retryCount++;
                        if (retryCount >= 3) {
                            if (axios.isAxiosError(err) && err.response?.data) {
                                throw new Error(`Ultra API Error (Attempt ${retryCount}): ${JSON.stringify(err.response.data)}`);
                            }
                            throw err;
                        }
                        console.warn(`[JUPITER] Ultra Sync retry ${retryCount}/3 due to glitch: ${err.message}`);
                        await new Promise(resolve => setTimeout(resolve, 2000)); // 2s backoff
                    }
                }

            } catch (err: any) {
                if (err.message.includes('Ultra API Error')) throw err;
                throw new Error(`Jupiter Ultra Connection Failed: ${err.message}`);
            }

            const { transaction: swapTransaction, requestId } = orderResponse;

            if (!swapTransaction) {
                throw new Error(`Ultra Order failed: No transaction returned. Response: ${JSON.stringify(orderResponse)}`);
            }
            // Silent direct order log


            // 3. Deserialize and Sign
            const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
            transaction.sign([this.wallet]);

            // 4. Pre-flight simulation
            const sim = await safeRpc(() => this.connection.simulateTransaction(transaction), "simulateSwap");
            if (sim.value.err) {
                throw new Error(`Jupiter Swap Simulation Failed: ${JSON.stringify(sim.value.err)}`);
            }

            // 5. Standard RPC Execution
            const rawTx = transaction.serialize();
            const txid = await safeRpc(() => this.connection.sendRawTransaction(rawTx, {
                skipPreflight: true,
                maxRetries: 2
            }), "sendSwapRaw");
            const confirmed = await this.confirmOrRetry(txid);
            if (!confirmed) {
                return { success: false, amount: BigInt(0), uiAmount: 0, error: "Transaction expired" };
            }
            console.log(`[STRATEGY] Jupiter Swap Success: https://solscan.io/tx/${txid}`);

            // 6. Capture actual received amount
            let postBalance = BigInt(0);
            let postUiAmount = 0;
            try {
                const acc = await safeRpc(() => this.connection.getTokenAccountBalance(ata), "getTokenBalance");
                postBalance = BigInt(acc.value.amount);
                postUiAmount = acc.value.uiAmount || 0;
            } catch (e) {
                try {
                    const ata2022 = await getAssociatedTokenAddress(mint, this.wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
                    const acc2 = await safeRpc(() => this.connection.getTokenAccountBalance(ata2022), "getTokenBalance2022");
                    postBalance = BigInt(acc2.value.amount);
                    postUiAmount = acc2.value.uiAmount || 0;
                } catch (e2) { console.warn(`[STRATEGY] Failed to fetch post-balance (both programs): ${e2}`); }
            }

            const outAmount = postBalance > preBalance ? (postBalance - preBalance) : BigInt(0);
            const outUiAmount = postUiAmount > preUiAmount ? (postUiAmount - preUiAmount) : 0;
            console.log(`[STRATEGY] Swap Complete. Received: ${outAmount.toString()} tokens (${outUiAmount} UI).`);


            return { success: true, amount: outAmount, uiAmount: outUiAmount };

        } catch (error: any) {
            let errMsg = error.message;
            if (axios.isAxiosError(error) && error.response?.data) {
                errMsg = `API Error: ${JSON.stringify(error.response.data)}`;
            }
            console.error(`[ERROR] Jupiter Swap failed:`, errMsg);

            // FALLBACK STRATEGY DISABLED (User: Full Jupiter/Metis Only)
            console.warn(`[STRATEGY] Jupiter Failed. Fallbacks are DISABLED (Jupiter Only Mode).`);
            SocketManager.emitLog("[STRATEGY] Jupiter Failed. Retrying next cycle...", "warning");

            return { success: false, amount: BigInt(0), uiAmount: 0, error: `Jupiter Only Mode: ${errMsg}` };
        }
    }

    /**
     * Sells a token for SOL using Jupiter Aggregator.
     */
    async sellToken(mint: PublicKey, amountUnits: bigint, slippagePercent: number = 10, skipExecution: boolean = false): Promise<{ success: boolean; amountSol: number; transaction?: VersionedTransaction; error?: string }> {
        const { DRY_RUN } = require("./config");
        console.log(`[STRATEGY] Selling ${amountUnits.toString()} units of ${mint.toBase58()} for SOL via Jupiter ${DRY_RUN ? '[DRY RUN]' : ''}`);

        if (DRY_RUN) {
            console.log(`[DRY RUN] Simulating Jupiter Sell...`);
            const fakeSol = Number(amountUnits) / 1e12; // Just a dummy conversion
            return { success: true, amountSol: fakeSol };
        }

        if (amountUnits === BigInt(0)) return { success: false, amountSol: 0, error: "Amount is zero" };

        try {
            // Pre-sell SOL balance check
            let preSolBalance = 0;
            try {
                preSolBalance = await safeRpc(() => this.connection.getBalance(this.wallet.publicKey), "preSellSolBalance");
            } catch (e) { /* ignore */ }

            const headers = { 'x-api-key': JUPITER_API_KEY || '' };

            // Ultra V1: GET /ultra/v1/order
            const params = new URLSearchParams({
                inputMint: mint.toBase58(),
                outputMint: SOL_MINT.toBase58(),
                amount: amountUnits.toString(),
                taker: this.wallet.publicKey.toBase58(),
                slippageBps: (slippagePercent * 100).toString()
            });

            const orderResponse = (await axios.get(`https://api.jup.ag/ultra/v1/order?${params}`, { headers })).data;
            const { transaction: swapTransaction } = orderResponse;

            if (!swapTransaction) throw new Error("No transaction returned from Jupiter Ultra");

            const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
            transaction.sign([this.wallet]);

            if (skipExecution) {
                // Extract estimated SOL output from Jupiter order response
                const estimatedSol = orderResponse.outAmount
                    ? Number(orderResponse.outAmount) / LAMPORTS_PER_SOL
                    : 0;
                return { success: true, amountSol: estimatedSol, transaction };
            }

            // Helper to calculate SOL received
            const getSolReceived = async (): Promise<number> => {
                try {
                    const postSolBalance = await safeRpc(() => this.connection.getBalance(this.wallet.publicKey), "postSellSolBalance");
                    const diff = (postSolBalance - preSolBalance) / LAMPORTS_PER_SOL;
                    return diff > 0 ? diff : 0;
                } catch (e) { return 0; }
            };

            // Pre-flight simulation
            const sim = await safeRpc(() => this.connection.simulateTransaction(transaction), "simulateSell");
            if (sim.value.err) {
                throw new Error(`Sell Simulation Failed: ${JSON.stringify(sim.value.err)}`);
            }

            // Standard RPC Execution
            const txid = await safeRpc(() => this.connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true }), "sendSellRaw");
            const confirmed = await this.confirmOrRetry(txid);
            if (!confirmed) return { success: false, amountSol: 0, error: "Sell transaction expired" };

            console.log(`[STRATEGY] Sell Success: https://solscan.io/tx/${txid}`);
            const solReceived = await getSolReceived();
            console.log(`[STRATEGY] Sell Proceeds: ${solReceived.toFixed(6)} SOL`);


            return { success: true, amountSol: solReceived };
        } catch (error: any) {
            console.error(`[STRATEGY] Sell failed:`, error.message);
            return { success: false, amountSol: 0, error: error.message };
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
                    const SOL_MINT_ADDR = SOL_MINT.toBase58();
                    const response = await axios.get(`https://api-v3.raydium.io/pools/info/mint?mint1=${mint.toBase58()}&mint2=${SOL_MINT_ADDR}&poolType=all&poolSortField=default&sortType=desc&pageSize=1&page=1`);
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
                    // Raydium V4 Program ID
                    // Raydium V4 Program ID
                    const RAYDIUM_V4_PROGRAM_ID = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");

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
                                authority: Liquidity.getAssociatedAuthority({ programId: RAYDIUM_V4_PROGRAM_ID }).publicKey.toBase58(),
                                openOrders: poolState.openOrders.toBase58(),
                                targetOrders: poolState.targetOrders.toBase58(),
                                vault: { A: poolState.baseVault.toBase58(), B: poolState.quoteVault.toBase58() },
                                marketProgramId: poolState.marketProgramId.toBase58(),
                                marketId: marketId.toBase58(),
                                marketAuthority: Liquidity.getAssociatedAuthority({ programId: poolState.marketProgramId }).publicKey.toBase58(),
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
            // 2. Define Tokens
            const currencyIn = poolKeys.quoteMint.equals(SOL_MINT) ? Token.WSOL : new (Token as any)(TOKEN_PROGRAM_ID, poolKeys.quoteMint, Number(poolKeys.quoteDecimals), "QUOTE", "Quote Token");

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

                const priorityFee = await this.getPriorityFee();
                tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
                tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));

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
                await this.confirmOrRetry(txid);
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
            const cpAmm = new CpAmm(this.connection);
            const poolPubkey = new PublicKey(pairAddress);
            const poolState = await cpAmm.fetchPoolState(poolPubkey);

            // 2. Identify Input Token (SOL)
            const SOL_MINT = "So11111111111111111111111111111111111111112";
            let inputToken = poolState.tokenAMint;

            if (poolState.tokenAMint.toBase58() === SOL_MINT) {
                inputToken = poolState.tokenAMint;
            } else if (poolState.tokenBMint.toBase58() === SOL_MINT) {
                inputToken = poolState.tokenBMint;
            }

            const amountIn = new BN(amountSol * LAMPORTS_PER_SOL);

            // 3. Create Swap Instructions
            const swapResult = await cpAmm.swap(
                this.wallet.publicKey,
                inputToken,
                amountIn,
                new BN(0) // Min out (0 for now)
            );

            // 0. Pre-Swap Balance Check (To calculate actual received amount)
            const ata = await getAssociatedTokenAddress(mint, this.wallet.publicKey);
            let preBalance = BigInt(0);
            try {
                const acc = await this.connection.getTokenAccountBalance(ata);
                preBalance = BigInt(acc.value.amount);
            } catch (ignore) { /* Account likely doesn't exist yet */ }

            // 4. Execute (Jito or Standard)
            let swapTx: Transaction | VersionedTransaction;

            if (swapResult.instructions) {
                swapTx = new Transaction().add(...swapResult.instructions);
            } else {
                // Some SDK versions return tx directly
                swapTx = swapResult as unknown as Transaction;
            }

            // Helper to calculate tokens received
            const getAmountReceived = async (): Promise<bigint> => {
                try {
                    const acc = await this.connection.getTokenAccountBalance(ata);
                    const postBalance = BigInt(acc.value.amount);
                    return postBalance > preBalance ? (postBalance - preBalance) : BigInt(0);
                } catch (e) { return BigInt(0); }
            };

            // Add priority fee
            const priorityFee = await this.getPriorityFee();
            if (swapTx instanceof Transaction) {
                swapTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));
            }

            // Standard RPC Execution
            const txSig = await sendAndConfirmTransaction(this.connection, swapTx as Transaction, [this.wallet], { skipPreflight: true, commitment: "confirmed" });
            console.log(`[METEORA] Swap Success: https://solscan.io/tx/${txSig}`);
            const outAmount = await getAmountReceived();
            return { success: true, amount: outAmount };

        } catch (e: any) {
            console.error(`[METEORA] Swap Failed:`, e);
            return { success: false, amount: BigInt(0), error: e.message };
        }
    }



    /**
     * Checks if a Meteora DAMM V2 pool already exists for a given token pair.
     * Checks BOTH standard pool (seed "pool") and customizable pool (seed "cpool") PDAs.
     * Returns the pool address if it exists, null otherwise.
     */
    async checkMeteoraPoolExists(tokenMint: PublicKey, baseMint: PublicKey = BASE_TOKENS["LPPP"]): Promise<string | null> {
        try {
            const { deriveConfigAddress, derivePoolAddress, deriveCustomizablePoolAddress } = require("@meteora-ag/cp-amm-sdk");
            const BN = require("bn.js");

            // Sort tokens exactly like createMeteoraPool does
            const [tokenA, tokenB] = tokenMint.toBuffer().compare(baseMint.toBuffer()) < 0
                ? [tokenMint, baseMint]
                : [baseMint, tokenMint];

            // 1. Check customizable pool (seed "cpool") — this is what the bot creates with 200bps fee
            const customPoolAddress = deriveCustomizablePoolAddress(tokenA, tokenB);
            const customInfo = await this.connection.getAccountInfo(customPoolAddress);
            if (customInfo) return customPoolAddress.toBase58();

            // 2. Check standard pool (seed "pool" + config index 0) — for completeness
            const configIndex = new BN(0);
            const configAddress = deriveConfigAddress(configIndex);
            const stdPoolAddress = derivePoolAddress(configAddress, tokenA, tokenB);
            const stdInfo = await this.connection.getAccountInfo(stdPoolAddress);
            if (stdInfo) return stdPoolAddress.toBase58();

            return null;
        } catch (err: any) {
            console.warn(`[METEORA] Pool existence check failed: ${err.message}`);
            return null;
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
    async createMeteoraPool(tokenMint: PublicKey, tokenAmount: bigint, baseAmount: bigint, baseMint: PublicKey = SOL_MINT, feeBps?: number): Promise<{ success: boolean; poolAddress?: string; positionAddress?: string; error?: string }> {
        const { DRY_RUN } = require("./config");
        console.log(`[METEORA] Creating DAMM V2 Pool... ${DRY_RUN ? '[DRY RUN]' : ''}`);

        if (DRY_RUN) {
            console.log(`[DRY RUN] Simulating Meteora Pool Creation...`);
            console.log(`[METEORA] Config: 8CNy9goNQNLM4wtgRw528tUQGMKD3vSuFRZY2gLGLLvF (Standard Volatile)`);
            console.log(`[METEORA] Init Price (Simulated): 0.000001 SOL`);
            console.log(`[METEORA] DAMM V2 Pool Created: https://solscan.io/tx/DRY_RUN_SIMULATION`);
            return { success: true, poolAddress: "DRY_RUN_POOL" };
        }

        try {
            // 1. Load SDK & Constants
            const { CpAmm, deriveConfigAddress, MIN_SQRT_PRICE, MAX_SQRT_PRICE, getFeeTimeSchedulerParams, getDynamicFeeParams, FEE_PADDING } = require("@meteora-ag/cp-amm-sdk");
            const { METEORA_POOL_FEE_BPS } = require("./config");

            // 2. Sort Tokens (A < B)
            const [tokenA, tokenB] = tokenMint.toBuffer().compare(baseMint.toBuffer()) < 0
                ? [tokenMint, baseMint]
                : [baseMint, tokenMint];

            const [amountA, amountB] = tokenMint.equals(tokenA)
                ? [tokenAmount, baseAmount]
                : [baseAmount, tokenAmount];

            // 3. Detect Token Programs (Token vs Token2022) with Retry
            const fetchAccountInfoWithRetry = async (pubkey: PublicKey, retries = 3): Promise<any> => {
                for (let i = 0; i < retries; i++) {
                    try {
                        const info = await this.connection.getAccountInfo(pubkey);
                        if (info) return info;
                    } catch (err: any) {
                        console.warn(`[METEORA] Retry ${i + 1}/${retries} fetching info for ${pubkey.toBase58()}: ${err.message}`);
                        if (i === retries - 1) throw err;
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }
                return null;
            };

            const tokenAInfo = await fetchAccountInfoWithRetry(tokenA);
            const tokenBInfo = await fetchAccountInfoWithRetry(tokenB);

            if (!tokenAInfo || !tokenBInfo) {
                throw new Error("Failed to fetch token mint info (after retries) for program detection.");
            }

            const tokenAProgram = tokenAInfo.owner;
            const tokenBProgram = tokenBInfo.owner;

            console.log(`[METEORA] A: ${tokenA.toBase58()} (Prog: ${tokenAProgram.toBase58()})`);
            console.log(`[METEORA] B: ${tokenB.toBase58()} (Prog: ${tokenBProgram.toBase58()})`);

            // 4. Initialize SDK Instance
            const cpAmm = new CpAmm(this.connection);

            // 5. Config & Parameters (Standard Volatile Index 0)
            const configIndex = new BN(0);
            const configAddress = deriveConfigAddress(configIndex);

            // 6. Generate Position NFT Keypair (REQUIRED)
            const positionNftMint = Keypair.generate();

            // 7. Prepare Pool Params
            const bnAmountA = new BN(amountA.toString());
            const bnAmountB = new BN(amountB.toString());

            // Get Epoch for Fee Calculation
            const epochInfo = await this.connection.getEpochInfo();
            const currentEpoch = new BN(epochInfo.epoch);

            // Fetch Mint Info for Transfer Fee Support (required for Token-2022)
            let tokenAInfoStruct = undefined;
            if (tokenAProgram.equals(TOKEN_2022_PROGRAM_ID)) {
                try {
                    const mintA = await getMint(this.connection, tokenA, "confirmed", TOKEN_2022_PROGRAM_ID);
                    tokenAInfoStruct = { mint: mintA, currentEpoch };
                    console.log(`[METEORA] Loaded Token-2022 Fee Info for A: ${tokenA.toBase58()}`);
                } catch (e) { console.warn("[METEORA] Failed to load Mint A info:", e); }
            }

            let tokenBInfoStruct = undefined;
            if (tokenBProgram.equals(TOKEN_2022_PROGRAM_ID)) {
                try {
                    const mintB = await getMint(this.connection, tokenB, "confirmed", TOKEN_2022_PROGRAM_ID);
                    tokenBInfoStruct = { mint: mintB, currentEpoch };
                    console.log(`[METEORA] Loaded Token-2022 Fee Info for B: ${tokenB.toBase58()}`);
                } catch (e) { console.warn("[METEORA] Failed to load Mint B info:", e); }
            }

            const poolParams = cpAmm.preparePoolCreationParams({
                tokenAAmount: bnAmountA,
                tokenBAmount: bnAmountB,
                tokenAMint: tokenA,
                tokenBMint: tokenB,
                minSqrtPrice: MIN_SQRT_PRICE,
                maxSqrtPrice: MAX_SQRT_PRICE,
                tokenAInfo: tokenAInfoStruct,
                tokenBInfo: tokenBInfoStruct,
            });

            console.log(`[METEORA] Config: ${configAddress.toBase58()} | Init Price: ${poolParams.initSqrtPrice.toString()}`);

            // 8. Create Transaction
            let transaction;
            let poolAddress: PublicKey = PublicKey.default;
            let positionAddress: PublicKey = PublicKey.default;
            const targetBps = feeBps || METEORA_POOL_FEE_BPS;

            if (targetBps === 20) {
                // Use Standard Permissionless Pool (Config Index 0 - 0.2%)
                transaction = await cpAmm.createPool({
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
                    tokenAProgram: tokenAProgram,
                    tokenBProgram: tokenBProgram,
                    positionNft: positionNftMint.publicKey,
                });

                // Derive addresses for permissionless pool
                const { derivePoolAddress, derivePositionAddress } = require("@meteora-ag/cp-amm-sdk");
                poolAddress = derivePoolAddress(configAddress, tokenA, tokenB);
                positionAddress = derivePositionAddress(positionNftMint.publicKey);
            } else {
                console.log(`[METEORA] Creating Custom Pool with ${targetBps} bps fee tier...`);
                // Use Customizable Pool to set specific fee (e.g. 2% = 200 bps)
                const poolFees = {
                    baseFee: getFeeTimeSchedulerParams(targetBps, targetBps, 0, 0, 0), // Static floor fee
                    dynamicFee: getDynamicFeeParams(targetBps), // Enable volatility-based bonus fee
                    padding: FEE_PADDING
                };

                const result = await cpAmm.createCustomPool({
                    creator: this.wallet.publicKey,
                    payer: this.wallet.publicKey,
                    tokenAMint: tokenA,
                    tokenBMint: tokenB,
                    tokenAAmount: bnAmountA,
                    tokenBAmount: bnAmountB,
                    initSqrtPrice: poolParams.initSqrtPrice,
                    liquidityDelta: poolParams.liquidityDelta,
                    sqrtMinPrice: MIN_SQRT_PRICE,
                    sqrtMaxPrice: MAX_SQRT_PRICE,
                    poolFees: poolFees,
                    hasAlphaVault: false,
                    activationType: 0, // Slot
                    collectFeeMode: 0,
                    activationPoint: null,
                    tokenAProgram: tokenAProgram,
                    tokenBProgram: tokenBProgram,
                    positionNft: positionNftMint.publicKey,
                    isLockLiquidity: false
                });
                transaction = result.tx;
                poolAddress = result.pool;
                positionAddress = result.position;
            }

            // 9. Send & Confirm (MUST SIGN WITH POSITION NFT MINT)
            const priorityFee = await this.getPriorityFee();
            transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));

            const txSig = await sendAndConfirmTransaction(this.connection, transaction, [this.wallet, positionNftMint], {
                skipPreflight: false,
                commitment: "confirmed",
                maxRetries: 3
            });
            console.log(`[METEORA] DAMM V2 Pool Created: https://solscan.io/tx/${txSig}`);
            return { success: true, poolAddress: poolAddress.toBase58(), positionAddress: positionAddress.toBase58() };


        } catch (e: any) {
            console.error(`[METEORA] Pool Creation Failed:`, e.message);

            // Try to get logs from the error object
            let logs = e.logs;

            // If no logs on error, try getLogs() method
            if (!logs && typeof e.getLogs === 'function') {
                try { logs = await e.getLogs(); } catch (_) { }
            }

            // If still no logs, try fetching from the transaction signature
            if (!logs && e.signature) {
                try {
                    const txResult = await this.connection.getTransaction(e.signature, {
                        commitment: 'confirmed',
                        maxSupportedTransactionVersion: 0
                    });
                    logs = txResult?.meta?.logMessages;
                } catch (_) { }
            }

            if (logs && logs.length > 0) {
                console.error(`[METEORA ERROR LOGS]`, logs);
                SocketManager.emitLog(`[LP ERROR] Logs: ${logs.join(' | ').slice(0, 500)}`, "error");
            } else {
                SocketManager.emitLog(`[LP ERROR] No on-chain logs available. Error: ${e.message?.slice(0, 200)}`, "error");
            }
            return { success: false, error: e.message };
        }
    }

    /**
     * Removes a percentage of liquidity from a Meteora CP-AMM pool.
     */
    async removeMeteoraLiquidity(poolAddress: string, percent: number = 80, positionId?: string, skipExecution: boolean = false): Promise<{ success: boolean; txSig?: string; transactions?: Transaction[]; error?: string }> {
        const { CpAmm, getTokenProgram } = require("@meteora-ag/cp-amm-sdk");
        const BN = require("bn.js");

        console.log(`[STRATEGY] Removing ${percent}% liquidity from pool: ${poolAddress}${positionId ? ` (position: ${positionId.slice(0, 8)}...)` : ''}`);
        try {
            const cpAmm = new CpAmm(this.connection);
            const poolPubkey = new PublicKey(poolAddress);
            const userPositions = await cpAmm.getUserPositionByPool(poolPubkey, this.wallet.publicKey);

            if (userPositions.length === 0) {
                return { success: false, error: "No active position found for this pool/wallet." };
            }

            // Use stored positionId to find the correct position, or fall back to first
            if (userPositions.length === 0) {
                return { success: false, error: "No active position found." };
            }

            // Issue 44: Bin Shift Logic - Iterate over ALL positions, not just the first one
            // This handles cases where liquidity might be spread across multiple bins due to price movement
            console.log(`[METEORA] Found ${userPositions.length} positions. Processing removal...`);

            const poolState = await cpAmm.fetchPoolState(poolPubkey);
            const transactions: Transaction[] = [];

            const { blockhash } = skipExecution ? await this.connection.getLatestBlockhash() : { blockhash: null };

            for (const pos of userPositions) {
                let tx: Transaction | null = null;
                const unlocked = new BN(pos.positionState.unlockedLiquidity.toString());
                const vested = new BN(pos.positionState.vestedLiquidity.toString());
                const locked = new BN(pos.positionState.permanentLockedLiquidity.toString());
                const totalLiquidity = unlocked.add(vested).add(locked);

                if (unlocked.isZero()) {
                    // Clean up empty position if confirmed empty OR dust (< 1000 units)
                    if (percent >= 100 || totalLiquidity.lt(new BN(1000))) {
                        console.log(`[METEORA] Cleaning up empty/dust position: ${pos.position.toBase58()}`);
                        tx = await cpAmm.removeAllLiquidityAndClosePosition({
                            owner: this.wallet.publicKey,
                            poolState,
                            positionState: pos.positionState,
                            position: pos.position,
                            positionNftAccount: pos.positionNftAccount,
                            tokenAAmountThreshold: new BN(0),
                            tokenBAmountThreshold: new BN(0),
                            vestings: [],
                            currentPoint: new BN(0)
                        });
                    }
                } else if (percent >= 100) {
                    console.log(`[METEORA] Closing position (100%): ${pos.position.toBase58()}`);
                    tx = await cpAmm.removeAllLiquidityAndClosePosition({
                        owner: this.wallet.publicKey,
                        poolState,
                        positionState: pos.positionState,
                        position: pos.position,
                        positionNftAccount: pos.positionNftAccount,
                        tokenAAmountThreshold: new BN(0),
                        tokenBAmountThreshold: new BN(0),
                        vestings: [],
                        currentPoint: new BN(0)
                    });
                } else {
                    // Calculate removal amount: percent of total, capped at unlocked
                    const targetAmount = totalLiquidity.mul(new BN(percent)).div(new BN(100));
                    const liquidityDelta = targetAmount.gt(unlocked) ? unlocked : targetAmount;

                    if (!liquidityDelta.isZero()) {
                        console.log(`[METEORA] Removing ${percent}% | unlocked: ${unlocked.toString()} | vested: ${vested.toString()} | locked: ${locked.toString()} | target: ${targetAmount.toString()} | actual: ${liquidityDelta.toString()} | position: ${pos.position.toBase58()}`);
                        tx = await cpAmm.removeLiquidity({
                            owner: this.wallet.publicKey,
                            pool: poolPubkey,
                            position: pos.position,
                            positionNftAccount: pos.positionNftAccount,
                            liquidityDelta,
                            tokenAMint: poolState.tokenAMint,
                            tokenBMint: poolState.tokenBMint,
                            tokenAVault: poolState.tokenAVault,
                            tokenBVault: poolState.tokenBVault,
                            tokenAProgram: getTokenProgram(poolState.tokenAFlag),
                            tokenBProgram: getTokenProgram(poolState.tokenBFlag),
                            tokenAAmountThreshold: new BN(0),
                            tokenBAmountThreshold: new BN(0),
                            vestings: [],
                            currentPoint: new BN(0)
                        });
                    }
                }

                if (tx) {
                    const priorityFee = await this.getPriorityFee();
                    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));

                    if (skipExecution && blockhash) {
                        tx.recentBlockhash = blockhash;
                        tx.feePayer = this.wallet.publicKey;
                        tx.sign(this.wallet);
                    }

                    transactions.push(tx);
                }
            }

            if (transactions.length === 0) {
                return { success: false, error: "No executable transactions generated." };
            }

            if (skipExecution) {
                return { success: true, transactions };
            }

            // Execute all transactions sequentially (to avoid nonce issues)
            let lastSig = "";
            for (const tx of transactions) {
                lastSig = await sendAndConfirmTransaction(this.connection, tx, [this.wallet], {
                    skipPreflight: true,
                    commitment: "confirmed"
                });
            }

            console.log(`[METEORA] Liquidity Removed. Last Sig: https://solscan.io/tx/${lastSig}`);
            return { success: true, txSig: lastSig };

        } catch (error: any) {
            console.error(`[METEORA] Liquidity Removal Error:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Increases liquidity in a Meteora CP-AMM pool.
     */
    async addMeteoraLiquidity(poolAddress: string, amountSol: number): Promise<{ success: boolean; txSig?: string; error?: string }> {
        const { CpAmm, getTokenProgram } = require("@meteora-ag/cp-amm-sdk");
        const { PublicKey, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require("@solana/web3.js");
        const BN = require("bn.js");

        console.log(`[STRATEGY] Increasing liquidity by ${amountSol} SOL in pool: ${poolAddress}`);
        try {
            const cpAmm = new CpAmm(this.connection);
            const poolPubkey = new PublicKey(poolAddress);
            const userPositions = await cpAmm.getUserPositionByPool(poolPubkey, this.wallet.publicKey);

            if (userPositions.length === 0) {
                return { success: false, error: "No active position found. Use createPosition first." };
            }

            const pos = userPositions[0];
            const amountLamports = new BN(Math.floor(amountSol * LAMPORTS_PER_SOL));

            const poolState = await cpAmm.fetchPoolState(poolPubkey);
            const isTokenASOL = poolState.tokenAMint.equals(SOL_MINT);

            const depositQuote = cpAmm.getDepositQuote({
                inAmount: amountLamports,
                isTokenA: isTokenASOL,
                minSqrtPrice: poolState.sqrtMinPrice,
                maxSqrtPrice: poolState.sqrtMaxPrice,
                sqrtPrice: poolState.sqrtPrice
            });

            // Map quote to max amounts with 1% slippage
            const slippageMult = new BN(101);
            const slippageDiv = new BN(100);

            const maxAmountA = isTokenASOL
                ? depositQuote.consumedInputAmount.mul(slippageMult).div(slippageDiv)
                : depositQuote.outputAmount.mul(slippageMult).div(slippageDiv);

            const maxAmountB = isTokenASOL
                ? depositQuote.outputAmount.mul(slippageMult).div(slippageDiv)
                : depositQuote.consumedInputAmount.mul(slippageMult).div(slippageDiv);

            const tx = await cpAmm.addLiquidity({
                owner: this.wallet.publicKey,
                pool: new PublicKey(poolAddress),
                position: pos.position,
                positionNftAccount: pos.positionNftAccount,
                liquidityDelta: depositQuote.liquidityDelta,
                maxAmountTokenA: maxAmountA,
                maxAmountTokenB: maxAmountB,
                tokenAAmountThreshold: new BN(0),
                tokenBAmountThreshold: new BN(0),
                tokenAMint: poolState.tokenAMint,
                tokenBMint: poolState.tokenBMint,
                tokenAVault: poolState.tokenAVault,
                tokenBVault: poolState.tokenBVault,
                tokenAProgram: getTokenProgram(poolState.tokenAFlag),
                tokenBProgram: getTokenProgram(poolState.tokenBFlag),
            });

            const priorityFee = await this.getPriorityFee();
            tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));

            const txSig = await sendAndConfirmTransaction(this.connection, tx, [this.wallet], {
                skipPreflight: true,
                commitment: "confirmed"
            });
            console.log(`[METEORA] Liquidity Increased: https://solscan.io/tx/${txSig}`);
            return { success: true, txSig };

        } catch (error: any) {
            console.error(`[METEORA] Increase Liquidity Error:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Gets total pool liquidity status.
     */
    async getPoolStatus(poolAddress: string, tokenAMint: string, tokenBMint: string): Promise<{ tokenAmount: number; baseAmount: number; price: number; success: boolean; metrics?: any }> {
        try {
            const { deriveTokenVaultAddress } = require("@meteora-ag/cp-amm-sdk");
            const poolPubkey = new PublicKey(poolAddress);
            const tokenAPubkey = new PublicKey(tokenAMint);
            const tokenBPubkey = new PublicKey(tokenBMint);

            // 1. Derive Vault Addresses
            const vaultA = deriveTokenVaultAddress(tokenAPubkey, poolPubkey);
            const vaultB = deriveTokenVaultAddress(tokenBPubkey, poolPubkey);

            // 2. Fetch Balances
            const balanceA = await this.connection.getTokenAccountBalance(vaultA);
            const balanceB = await this.connection.getTokenAccountBalance(vaultB);

            const amountA = balanceA.value.uiAmount || 0;
            const amountB = balanceB.value.uiAmount || 0;

            if (amountA === 0) return { price: amountB > 0 ? Infinity : 0, tokenAmount: 0, baseAmount: amountB, success: amountB > 0 };

            const price = amountB / amountA;
            return { price, tokenAmount: amountA, baseAmount: amountB, success: true };
        } catch (error) {
            console.warn(`[STRATEGY] Failed to fetch pool status for ${poolAddress}:`, error);
            return { price: 0, tokenAmount: 0, baseAmount: 0, success: false };
        }
    }

    /**
     * Helper to fetch token mints for a pool.
     */
    async getPoolMints(poolAddress: string): Promise<{ tokenA: string; tokenB: string } | null> {
        try {
            const { CpAmm } = require("@meteora-ag/cp-amm-sdk");
            const cpAmm = new CpAmm(this.connection);
            const poolState = await safeRpc(() => cpAmm.fetchPoolState(new PublicKey(poolAddress)), "fetchPoolMintsRecovery") as any;
            return {
                tokenA: poolState.tokenAMint.toBase58(),
                tokenB: poolState.tokenBMint.toBase58()
            };
        } catch (e) {
            console.error(`[STRATEGY] Failed to fetch pool mints for ${poolAddress}:`, e);
            return null;
        }
    }

    /**
     * Calculates the total value of a Meteora position in SOL (Net Position Value).
     * SUM(TokenValueInSOL + SolValue + FeesInSol)
     */
    async getPositionValue(poolAddress: string, tokenMint: string, positionId?: string, connectionOverride?: Connection): Promise<{ totalSol: number; feesBase: number; feesToken: number; feesBaseRaw: bigint; feesTokenRaw: bigint; mint: string; baseMint: string; spotPrice: number; userBaseInLp: number; userTokenInLp: number; userTokenRaw: bigint; success: boolean }> {
        try {
            const conn = connectionOverride || this.connection;
            const { CpAmm, deriveTokenVaultAddress } = require("@meteora-ag/cp-amm-sdk");
            const cpAmm = new CpAmm(conn);
            const poolPubkey = new PublicKey(poolAddress);

            // 1. Fetch Pool State & Sorted Mints
            const poolState = await safeRpc(() => cpAmm.fetchPoolState(poolPubkey), "fetchPoolState") as any;
            const mintA = poolState.tokenAMint;
            const mintB = poolState.tokenBMint;

            // 2. Fetch mint metadata (cached — decimals/programId never change)
            const [mintAMeta, mintBMeta] = await Promise.all([
                this.getCachedMintMeta(mintA, conn),
                this.getCachedMintMeta(mintB, conn)
            ]);

            // 2. Fetch Reserves from Pool State via Vaults (Fallback as tokenAAmount is missing)
            // We must subtract protocol/partner fees from the vault balance to get "effective" LP reserves.
            const vaultA = poolState.tokenAVault;
            const vaultB = poolState.tokenBVault;

            const [balA, balB] = await Promise.all([
                safeRpc(() => conn.getTokenAccountBalance(vaultA), "getVaultABalance"),
                safeRpc(() => conn.getTokenAccountBalance(vaultB), "getVaultBBalance")
            ]);

            const protocolAFee = poolState.protocolAFee ? new BN(poolState.protocolAFee) : new BN(0);
            const partnerAFee = poolState.partnerAFee ? new BN(poolState.partnerAFee) : new BN(0);
            const protocolBFee = poolState.protocolBFee ? new BN(poolState.protocolBFee) : new BN(0);
            const partnerBFee = poolState.partnerBFee ? new BN(poolState.partnerBFee) : new BN(0);

            // Vault Amount (UI) -> BN
            // Note: getTokenAccountBalance returns uiAmount. We need raw amount for BN subtraction.
            // Using value.amount which is the string representation of u64
            const vaultAmountA_BN = new BN(balA.value.amount);
            const vaultAmountB_BN = new BN(balB.value.amount);

            const effectiveReserveA_BN = vaultAmountA_BN.sub(protocolAFee).sub(partnerAFee);
            const effectiveReserveB_BN = vaultAmountB_BN.sub(protocolBFee).sub(partnerBFee);

            // Convert to UI Amount (Safe string parsing to bypass BN.js 53-bit integer limit for massive memecoin supplies)
            const amountA = Number(effectiveReserveA_BN.toString()) / (10 ** balA.value.decimals);
            const amountB = Number(effectiveReserveB_BN.toString()) / (10 ** balB.value.decimals);

            // Define decimals for fee calculation later
            const decimalsA = balA.value.decimals;
            const decimalsB = balB.value.decimals;

            // 3. Determine Side (Which one is SOL/LPPP/Base?)
            const baseMints = Object.values(BASE_TOKENS).map(m => m.toBase58());
            const isBaseA = baseMints.includes(mintA.toBase58());

            // If neither is a known base, default to Mint A as base
            const baseIsA = isBaseA || !baseMints.includes(mintB.toBase58());

            const baseAmountTotal = baseIsA ? amountA : amountB;
            const tokenAmountTotal = baseIsA ? amountB : amountA;

            // 4. Spot Price (Base per Token)
            let spotPrice = 0;

            if (poolState.sqrtPrice) {
                const sqrtPriceX64 = BigInt(poolState.sqrtPrice.toString());
                const Q64 = BigInt(1) << BigInt(64);

                const scale = Number(sqrtPriceX64) / Number(Q64);
                const priceRatio = scale * scale; // Result is B_raw / A_raw (approx)

                // We want "How many Base tokens (LPPP) per 1 Target token (Snowball)".
                // Price = A_ui / B_ui = (A_raw / B_raw) * 10^(decimalsB - decimalsA)
                // Since priceRatio = B_raw / A_raw, A_raw / B_raw = 1 / priceRatio.
                spotPrice = (1 / priceRatio) * (10 ** (decimalsB - decimalsA));

                /* Logging for verification (Spammy)
                console.log(`[SPOT-PRICE] sqrtPriceX64: ${sqrtPriceX64}, priceRatio: ${priceRatio}, spotPrice: ${spotPrice}`);
                */
            }

            // Fallback if sqrtPrice processing failed or yielded NaN
            if (!spotPrice || isNaN(spotPrice)) {
                spotPrice = (tokenAmountTotal > 0) ? (baseAmountTotal / tokenAmountTotal) : 0;
            } else {
                // Adjust for Base/Token assignment
                // We calculated spotPrice as A / B (Price of B in terms of A, assuming A is Base)
                // If Base is B?
                if (!baseIsA) {
                    spotPrice = 1 / spotPrice;
                }
            }

            // 5. Fetch User Position (Directly via positionId or via scan)
            let pos: any;
            if (positionId) {
                try {
                    const posPubkey = new PublicKey(positionId);
                    const posState = await cpAmm.fetchPositionState(posPubkey);
                    pos = { position: posPubkey, positionState: posState };
                } catch (e) {
                    // console.warn(`[STRATEGY] Direct fetch failed for ${positionId}, falling back to scan.`);
                }
            }

            if (!pos) {
                const userPositions = await cpAmm.getUserPositionByPool(poolPubkey, this.wallet.publicKey);
                if (userPositions.length === 0) {
                    // console.warn(`[STRATEGY] No position found for pool ${poolPubkey.toBase58()}. Marking as fetch failure.`);
                    return { totalSol: 0, feesBase: 0, feesToken: 0, feesBaseRaw: 0n, feesTokenRaw: 0n, mint: "", baseMint: "", spotPrice, userBaseInLp: 0, userTokenInLp: 0, userTokenRaw: 0n, success: false };
                }
                pos = userPositions[0];
            }

            const userLiquidity = BigInt(pos.positionState.unlockedLiquidity.toString()) +
                BigInt(pos.positionState.vestedLiquidity.toString()) +
                BigInt(pos.positionState.permanentLockedLiquidity.toString());

            // 6. User's Principal Value (Derived strictly from Liquidity & Price)
            // We do NOT use vault balances here to avoid "Ghost Value" from unclaimed fees.
            // For CP-AMM (xy=k), Liquidity L = sqrt(x * y) and Price P = y / x.
            // Therefore:
            // x (Base) = L / sqrt(P)
            // y (Token) = L * sqrt(P)

            // We use the calculated 'spotPrice' as P (Token/Base or Base/Token).
            // spotPrice is derived from sqrtPriceX64.

            // Let's rely on the ratio.
            // derivedAmountA = Liquidity / sqrtPrice (if P = B/A) ?
            // Let's use the BigInt sqrtPriceX64 directly for precision.
            // sqrtPriceX64 = sqrt(B/A) * 2^64.

            // Amount A (Base) = L * 2^64 / sqrtPriceX64
            // Amount B (Token) = L * sqrtPriceX64 / 2^64

            // Note: We need to adjust for decimals if sqrtPriceX64 includes them? 
            // Standard CP-AMM SDK "constant_product_curve.rs":
            // new_token_a_amount = new_liquidity.checked_div(sqrt_price_x64).unwrap().checked_mul(u128::from(Q64)).unwrap();
            // new_token_b_amount = new_liquidity.checked_mul(sqrt_price_x64).unwrap().checked_div(u128::from(Q64)).unwrap();

            const L_user = userLiquidity; // BigInt
            const sqrtPriceX64 = BigInt(poolState.sqrtPrice.toString()); // BigInt
            const Q64 = BigInt(1) << BigInt(64);

            // Calculate Raw Token Amounts (u64)
            // baseIsA determines if Mint A is Base. 
            // If baseIsA: Base = AmountA, Token = AmountB.
            // Assuming sqrtPriceX64 = sqrt(B/A) * Q64.

            let amountA_red: bigint;
            let amountB_red: bigint;

            if (sqrtPriceX64 > 0n) {
                // Corrected Formula: L_user is already Q64 scaled.
                // Amount A = (L_scaled / Q64) / sqrt(P) = L_scaled / sqrtPX64
                amountA_red = L_user / sqrtPriceX64;

                // Amount B = (L_scaled / Q64) * sqrt(P) = (L_scaled * sqrtPX64) / Q128
                amountB_red = (L_user * sqrtPriceX64) >> 128n;
            } else {
                amountA_red = 0n;
                amountB_red = 0n;
            }

            // Convert to UI Amounts
            const userAmountA = Number(amountA_red) / (10 ** mintAMeta.decimals);
            const userAmountB = Number(amountB_red) / (10 ** mintBMeta.decimals);

            /* console.log(`[DEBUG-MATH] L_user: ${L_user}, sqrtPriceX64: ${sqrtPriceX64}, AmtA_raw: ${amountA_red}, AmtB_raw: ${amountB_red}`);
            console.log(`[DEBUG-MATH] UserAmtA: ${userAmountA}, UserAmtB: ${userAmountB}`); */

            // Assign to Base/Token
            // Note: This logic assumes sqrtPrice direction matches (B/A).
            // If it is A/B, the formulas flip.
            // Given we observed "Undervalued Snowball" (Token B) using Vaults:
            // Vault Implied Price (A/B) was LOW.
            // This means B was HIGH (denominator).
            // If sqrtPrice is standard, it should be correct.

            const userBaseInLp = baseIsA ? userAmountA : userAmountB;
            const userTokenInLp = baseIsA ? userAmountB : userAmountA;
            const userTokenRaw = baseIsA ? amountB_red : amountA_red;


            // 7. User's Pending Fees (Manual Calculation for DAMM v2)
            // DLMM API does not work for DAMM (Dynamic AMM). Using on-chain state.

            // Manual Calculation Helper: Convert byte array to LE BigInt
            const parseBigIntLE = (arr: number[]): bigint => {
                let res = 0n;
                for (let i = 0; i < arr.length; i++) {
                    res += BigInt(arr[i]) << BigInt(i * 8);
                }
                return res;
            };

            // Read Global Accumulators from Pool State (feeAPerLiquidity / feeBPerLiquidity)
            const globalFeeA_Array = (poolState as any).feeAPerLiquidity || [];
            const globalFeeB_Array = (poolState as any).feeBPerLiquidity || [];

            // Read Checkpoints from Position State
            const checkpointA_Array = (pos.positionState as any).feeAPerTokenCheckpoint || [];
            const checkpointB_Array = (pos.positionState as any).feeBPerTokenCheckpoint || [];

            let feeA = 0;
            let feeB = 0;

            try {
                if (globalFeeA_Array.length > 0 && checkpointA_Array.length > 0) {
                    const globalA = parseBigIntLE(globalFeeA_Array);
                    const checkA = parseBigIntLE(checkpointA_Array);

                    const liquidity = BigInt(pos.positionState.unlockedLiquidity.toString()) +
                        BigInt(pos.positionState.vestedLiquidity.toString()) +
                        BigInt(pos.positionState.permanentLockedLiquidity.toString());

                    // Calculate Pending Fees: (Global - Checkpoint) * Liquidity
                    // Both deltaA and liquidity (L_user) are scaled by 2^64 in DAMM v2.
                    // Product is scaled by 2^128. Shift by 128 to get raw units.
                    const deltaA = globalA > checkA ? globalA - checkA : 0n;
                    const pendingA_Raw = (deltaA * liquidity) >> 128n;

                    feeA = Number(pendingA_Raw) / Math.pow(10, decimalsA);
                }

                if (globalFeeB_Array.length > 0 && checkpointB_Array.length > 0) {
                    const globalB = parseBigIntLE(globalFeeB_Array);
                    const checkB = parseBigIntLE(checkpointB_Array);

                    const liquidity = BigInt(pos.positionState.unlockedLiquidity.toString()) +
                        BigInt(pos.positionState.vestedLiquidity.toString()) +
                        BigInt(pos.positionState.permanentLockedLiquidity.toString());

                    const deltaB = globalB > checkB ? globalB - checkB : 0n;
                    const pendingB_Raw = (deltaB * liquidity) >> 128n;

                    feeB = Number(pendingB_Raw) / Math.pow(10, decimalsB);
                }
            } catch (err) {
                console.warn(`[STRATEGY] Manual fee calculation failed:`, err);
            }

            // Fallback to direct read if calculation yielded 0 (or failed)
            if (feeA === 0) {
                feeA = Number(
                    pos.positionState.feeAPending?.toString() ||
                    pos.positionState.feeAAmount?.toString() ||
                    pos.positionState.feeA?.toString() ||
                    "0"
                ) / Math.pow(10, decimalsA);
            }
            if (feeB === 0) {
                feeB = Number(
                    pos.positionState.feeBPending?.toString() ||
                    pos.positionState.feeBAmount?.toString() ||
                    pos.positionState.feeB?.toString() ||
                    "0"
                ) / Math.pow(10, decimalsB);
            }

            /* // Log calculation results for verification
            if (feeA > 0 || feeB > 0) {
                console.log(`[FEES] Calculated Pending Fees: A=${feeA.toFixed(6)}, B=${feeB.toFixed(6)}`);
            } */

            const feesBase = baseIsA ? feeA : feeB;
            const feesToken = baseIsA ? feeB : feeA;

            // 7. Net Position (Active Liquidity only, excluding fees)
            // Correction: userBaseInLp / userTokenInLp derived from Active Liquidity 
            // ALREADY represent the Principal (net of fees). 
            // Subtracting fees again was causing Snowball principal to hit 0.
            const netBaseInLp = userBaseInLp;
            const netTokenInLp = userTokenInLp;

            // 8. Total Position Value in SOL units (Equity + Fees)
            const totalSol = ((netTokenInLp + feesToken) * spotPrice) + netBaseInLp + feesBase;

            return {
                totalSol,
                feesBase: feesBase,
                feesToken: feesToken,
                feesBaseRaw: baseIsA ? BigInt(pos.positionState.feeAPending?.toString() || "0") : BigInt(pos.positionState.feeBPending?.toString() || "0"),
                feesTokenRaw: baseIsA ? BigInt(pos.positionState.feeBPending?.toString() || "0") : BigInt(pos.positionState.feeAPending?.toString() || "0"),
                mint: baseIsA ? mintB.toBase58() : mintA.toBase58(),
                baseMint: baseIsA ? mintA.toBase58() : mintB.toBase58(),
                spotPrice,
                userBaseInLp: netBaseInLp,   // Now strictly Principal
                userTokenInLp: netTokenInLp, // Now strictly Principal
                userTokenRaw,
                success: true
            };
        } catch (error) {
            console.error(`[STRATEGY] getPositionValue Failed:`, error);
            return { totalSol: 0, feesBase: 0, feesToken: 0, feesBaseRaw: 0n, feesTokenRaw: 0n, mint: "", baseMint: "", spotPrice: 0, userBaseInLp: 0, userTokenInLp: 0, userTokenRaw: 0n, success: false };
        }
    }

    /**
     * Batched version of getPositionValue — fetches ALL pools in 2-3 RPC calls
     * instead of 7 per pool. Uses Meteora SDK's getMultiplePools + getMultiplePositions
     * and batches vault balance reads via getMultipleAccountsInfo.
     *
     * Returns a Map<poolAddress, positionValueResult> in the same shape as getPositionValue.
     */
    async getPositionValuesBatch(
        pools: { poolAddress: string; tokenMint: string; positionId?: string }[],
        connectionOverride?: Connection
    ): Promise<Map<string, { totalSol: number; feesBase: number; feesToken: number; feesBaseRaw: bigint; feesTokenRaw: bigint; mint: string; baseMint: string; spotPrice: number; userBaseInLp: number; userTokenInLp: number; userTokenRaw: bigint; success: boolean }>> {
        const FAIL = { totalSol: 0, feesBase: 0, feesToken: 0, feesBaseRaw: 0n, feesTokenRaw: 0n, mint: "", baseMint: "", spotPrice: 0, userBaseInLp: 0, userTokenInLp: 0, userTokenRaw: 0n, success: false };
        const results = new Map<string, typeof FAIL>();
        if (pools.length === 0) return results;

        try {
            const conn = connectionOverride || this.connection;
            const { CpAmm } = require("@meteora-ag/cp-amm-sdk");
            const cpAmm = new CpAmm(conn);

            const poolPubkeys = pools.map(p => new PublicKey(p.poolAddress));

            // ── STEP 1: Batch fetch all pool states (1 RPC call) ──
            let poolStates: any[];
            try {
                poolStates = await safeRpc(() => cpAmm.getMultiplePools(poolPubkeys), "getMultiplePools");
            } catch (e) {
                console.warn("[BATCH] getMultiplePools failed, falling back to individual fetches");
                // Fallback: individual fetches (old behavior)
                for (const p of pools) {
                    const result = await this.getPositionValue(p.poolAddress, p.tokenMint, p.positionId, connectionOverride)
                        .catch(() => FAIL);
                    results.set(p.poolAddress, result);
                }
                return results;
            }

            // ── STEP 2: Collect all unique mints + vault addresses from pool states ──
            const mintSet = new Set<string>();
            const vaultAddresses: PublicKey[] = [];
            const poolVaultMap: { vaultA: PublicKey; vaultB: PublicKey; mintA: PublicKey; mintB: PublicKey }[] = [];

            for (let i = 0; i < poolStates.length; i++) {
                const ps = poolStates[i];
                if (!ps) {
                    poolVaultMap.push({ vaultA: PublicKey.default, vaultB: PublicKey.default, mintA: PublicKey.default, mintB: PublicKey.default });
                    continue;
                }
                const mintA = ps.tokenAMint;
                const mintB = ps.tokenBMint;
                const vaultA = ps.tokenAVault;
                const vaultB = ps.tokenBVault;
                mintSet.add(mintA.toBase58());
                mintSet.add(mintB.toBase58());
                vaultAddresses.push(vaultA, vaultB);
                poolVaultMap.push({ vaultA, vaultB, mintA, mintB });
            }

            // ── STEP 3: Warm mint cache (only fetches unknown mints — usually 0 RPC after first run) ──
            const uncachedMints = [...mintSet].filter(m => !mintMetaCache.has(m));
            if (uncachedMints.length > 0) {
                await Promise.all(uncachedMints.map(m => this.getCachedMintMeta(new PublicKey(m), conn)));
            }

            // ── STEP 4: Batch fetch all vault balances (1 RPC call) ──
            const vaultInfos = await safeRpc(
                () => conn.getMultipleAccountsInfo(vaultAddresses),
                "getMultipleVaultBalances"
            );

            // ── STEP 5: Batch fetch positions ──
            // Collect positionIds that we can batch-fetch
            const positionPubkeys: (PublicKey | null)[] = pools.map(p =>
                p.positionId ? new PublicKey(p.positionId) : null
            );
            const batchablePositionKeys = positionPubkeys.filter((p): p is PublicKey => p !== null);

            let batchedPositionStates: any[] = [];
            if (batchablePositionKeys.length > 0) {
                try {
                    batchedPositionStates = await safeRpc(
                        () => cpAmm.getMultiplePositions(batchablePositionKeys),
                        "getMultiplePositions"
                    );
                } catch {
                    // Will fall back to individual fetches per pool below
                }
            }

            // Build a map from positionId → positionState for quick lookup
            const positionMap = new Map<string, any>();
            let batchIdx = 0;
            for (const pk of positionPubkeys) {
                if (pk) {
                    if (batchIdx < batchedPositionStates.length && batchedPositionStates[batchIdx]) {
                        positionMap.set(pk.toBase58(), {
                            position: pk,
                            positionState: batchedPositionStates[batchIdx]
                        });
                    }
                    batchIdx++;
                }
            }

            // ── STEP 6: Process each pool using the pre-fetched data ──
            const baseMints = Object.values(BASE_TOKENS).map(m => m.toBase58());

            for (let i = 0; i < pools.length; i++) {
                const pool = pools[i];
                const poolState = poolStates[i];
                if (!poolState) {
                    results.set(pool.poolAddress, FAIL);
                    continue;
                }

                try {
                    const { mintA, mintB } = poolVaultMap[i];
                    const mintAMeta = mintMetaCache.get(mintA.toBase58());
                    const mintBMeta = mintMetaCache.get(mintB.toBase58());
                    if (!mintAMeta || !mintBMeta) {
                        results.set(pool.poolAddress, FAIL);
                        continue;
                    }

                    // Parse vault balances from raw account data
                    const vaultAIdx = i * 2;
                    const vaultBIdx = i * 2 + 1;
                    const vaultAInfo = vaultInfos[vaultAIdx];
                    const vaultBInfo = vaultInfos[vaultBIdx];
                    if (!vaultAInfo || !vaultBInfo || vaultAInfo.data.length < 72 || vaultBInfo.data.length < 72) {
                        results.set(pool.poolAddress, FAIL);
                        continue;
                    }

                    // Parse SPL token account balance from raw data (offset 64, 8 bytes LE = amount)
                    const vaultAmountA_BN = new BN(vaultAInfo.data.subarray(64, 72), undefined, "le");
                    const vaultAmountB_BN = new BN(vaultBInfo.data.subarray(64, 72), undefined, "le");

                    const protocolAFee = poolState.protocolAFee ? new BN(poolState.protocolAFee) : new BN(0);
                    const partnerAFee = poolState.partnerAFee ? new BN(poolState.partnerAFee) : new BN(0);
                    const protocolBFee = poolState.protocolBFee ? new BN(poolState.protocolBFee) : new BN(0);
                    const partnerBFee = poolState.partnerBFee ? new BN(poolState.partnerBFee) : new BN(0);

                    const effectiveReserveA_BN = vaultAmountA_BN.sub(protocolAFee).sub(partnerAFee);
                    const effectiveReserveB_BN = vaultAmountB_BN.sub(protocolBFee).sub(partnerBFee);

                    const decimalsA = mintAMeta.decimals;
                    const decimalsB = mintBMeta.decimals;
                    const amountA = Number(effectiveReserveA_BN.toString()) / (10 ** decimalsA);
                    const amountB = Number(effectiveReserveB_BN.toString()) / (10 ** decimalsB);

                    // Determine Base/Token side
                    const isBaseA = baseMints.includes(mintA.toBase58());
                    const baseIsA = isBaseA || !baseMints.includes(mintB.toBase58());

                    const baseAmountTotal = baseIsA ? amountA : amountB;
                    const tokenAmountTotal = baseIsA ? amountB : amountA;

                    // Spot Price
                    let spotPrice = 0;
                    if (poolState.sqrtPrice) {
                        const sqrtPriceX64 = BigInt(poolState.sqrtPrice.toString());
                        const Q64 = BigInt(1) << BigInt(64);
                        const scale = Number(sqrtPriceX64) / Number(Q64);
                        const priceRatio = scale * scale;
                        spotPrice = (1 / priceRatio) * (10 ** (decimalsB - decimalsA));
                    }
                    if (!spotPrice || isNaN(spotPrice)) {
                        spotPrice = (tokenAmountTotal > 0) ? (baseAmountTotal / tokenAmountTotal) : 0;
                    } else if (!baseIsA) {
                        spotPrice = 1 / spotPrice;
                    }

                    // Position
                    let pos: any = null;
                    if (pool.positionId) {
                        pos = positionMap.get(pool.positionId) || null;
                        // Fallback: individual fetch if batch missed it
                        if (!pos) {
                            try {
                                const posPubkey = new PublicKey(pool.positionId);
                                const posState = await cpAmm.fetchPositionState(posPubkey);
                                pos = { position: posPubkey, positionState: posState };
                            } catch {}
                        }
                    }
                    if (!pos) {
                        const userPositions = await cpAmm.getUserPositionByPool(new PublicKey(pool.poolAddress), this.wallet.publicKey);
                        if (userPositions.length === 0) {
                            results.set(pool.poolAddress, { ...FAIL, spotPrice });
                            continue;
                        }
                        pos = userPositions[0];
                    }

                    // Liquidity + user amounts
                    const userLiquidity = BigInt(pos.positionState.unlockedLiquidity.toString()) +
                        BigInt(pos.positionState.vestedLiquidity.toString()) +
                        BigInt(pos.positionState.permanentLockedLiquidity.toString());

                    const L_user = userLiquidity;
                    const sqrtPriceX64 = BigInt(poolState.sqrtPrice.toString());

                    let amountA_red: bigint, amountB_red: bigint;
                    if (sqrtPriceX64 > 0n) {
                        amountA_red = L_user / sqrtPriceX64;
                        amountB_red = (L_user * sqrtPriceX64) >> 128n;
                    } else {
                        amountA_red = 0n;
                        amountB_red = 0n;
                    }

                    const userAmountA = Number(amountA_red) / (10 ** decimalsA);
                    const userAmountB = Number(amountB_red) / (10 ** decimalsB);

                    const userBaseInLp = baseIsA ? userAmountA : userAmountB;
                    const userTokenInLp = baseIsA ? userAmountB : userAmountA;
                    const userTokenRaw = baseIsA ? amountB_red : amountA_red;

                    // Fees (same logic as getPositionValue)
                    const parseBigIntLE = (arr: number[]): bigint => {
                        let res = 0n;
                        for (let k = 0; k < arr.length; k++) {
                            res += BigInt(arr[k]) << BigInt(k * 8);
                        }
                        return res;
                    };

                    const globalFeeA_Array = (poolState as any).feeAPerLiquidity || [];
                    const globalFeeB_Array = (poolState as any).feeBPerLiquidity || [];
                    const checkpointA_Array = (pos.positionState as any).feeAPerTokenCheckpoint || [];
                    const checkpointB_Array = (pos.positionState as any).feeBPerTokenCheckpoint || [];

                    let feeA = 0, feeB = 0;
                    try {
                        if (globalFeeA_Array.length > 0 && checkpointA_Array.length > 0) {
                            const globalA = parseBigIntLE(globalFeeA_Array);
                            const checkA = parseBigIntLE(checkpointA_Array);
                            const deltaA = globalA > checkA ? globalA - checkA : 0n;
                            const pendingA_Raw = (deltaA * L_user) >> 128n;
                            feeA = Number(pendingA_Raw) / Math.pow(10, decimalsA);
                        }
                        if (globalFeeB_Array.length > 0 && checkpointB_Array.length > 0) {
                            const globalB = parseBigIntLE(globalFeeB_Array);
                            const checkB = parseBigIntLE(checkpointB_Array);
                            const deltaB = globalB > checkB ? globalB - checkB : 0n;
                            const pendingB_Raw = (deltaB * L_user) >> 128n;
                            feeB = Number(pendingB_Raw) / Math.pow(10, decimalsB);
                        }
                    } catch (feeErr: any) {
                        console.warn(`[BATCH] Fee calc error for ${pool.poolAddress.slice(0, 8)}: ${feeErr.message}`);
                    }

                    if (feeA === 0) {
                        feeA = Number(pos.positionState.feeAPending?.toString() || pos.positionState.feeAAmount?.toString() || pos.positionState.feeA?.toString() || "0") / Math.pow(10, decimalsA);
                    }
                    if (feeB === 0) {
                        feeB = Number(pos.positionState.feeBPending?.toString() || pos.positionState.feeBAmount?.toString() || pos.positionState.feeB?.toString() || "0") / Math.pow(10, decimalsB);
                    }

                    const feesBase = baseIsA ? feeA : feeB;
                    const feesToken = baseIsA ? feeB : feeA;
                    const totalSol = ((userTokenInLp + feesToken) * spotPrice) + userBaseInLp + feesBase;

                    results.set(pool.poolAddress, {
                        totalSol,
                        feesBase,
                        feesToken,
                        feesBaseRaw: baseIsA ? BigInt(pos.positionState.feeAPending?.toString() || "0") : BigInt(pos.positionState.feeBPending?.toString() || "0"),
                        feesTokenRaw: baseIsA ? BigInt(pos.positionState.feeBPending?.toString() || "0") : BigInt(pos.positionState.feeAPending?.toString() || "0"),
                        mint: baseIsA ? mintB.toBase58() : mintA.toBase58(),
                        baseMint: baseIsA ? mintA.toBase58() : mintB.toBase58(),
                        spotPrice,
                        userBaseInLp,
                        userTokenInLp,
                        userTokenRaw,
                        success: true
                    });
                } catch (poolErr: any) {
                    console.warn(`[BATCH] Pool ${pool.poolAddress.slice(0, 8)} processing error: ${poolErr.message}`);
                    results.set(pool.poolAddress, FAIL);
                }
            }
        } catch (error: any) {
            console.error(`[BATCH] Batch fetch failed, falling back to individual:`, error.message);
            // Full fallback
            for (const p of pools) {
                if (!results.has(p.poolAddress)) {
                    const result = await this.getPositionValue(p.poolAddress, p.tokenMint, p.positionId, connectionOverride)
                        .catch(() => ({ totalSol: 0, feesBase: 0, feesToken: 0, feesBaseRaw: 0n, feesTokenRaw: 0n, mint: "", baseMint: "", spotPrice: 0, userBaseInLp: 0, userTokenInLp: 0, userTokenRaw: 0n, success: false }));
                    results.set(p.poolAddress, result);
                }
            }
        }

        return results;
    }

    /**
     * Scans the blockchain for all active CP-AMM positions owned by the wallet.
     */
    async fetchAllUserPositions(): Promise<{ poolAddress: string; positionId: string }[]> {
        try {
            const CP_AMM_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
            const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

            // 1. DLMM scan (Owner is at offset 40)
            const dlmmAccounts = await safeRpc(() => this.connection.getProgramAccounts(DLMM_PROGRAM_ID, {
                filters: [
                    { memcmp: { offset: 40, bytes: this.wallet.publicKey.toBase58() } }
                ]
            }), "getProgramAccountsRecovery");

            // 2. CP-AMM (DAMM v2) scan
            // Since CP-AMM positions are NFT-based, the owner is the NFT holder.
            // We fetch all Token-2022 accounts owned by the user.
            let potentialMints: PublicKey[] = [];
            try {
                const token2022Accounts = await safeRpc(() => this.connection.getParsedTokenAccountsByOwner(
                    this.wallet.publicKey,
                    { programId: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") }
                ), "getParsedTokenAccountsByOwnerRecovery");
                potentialMints = token2022Accounts.value
                    .filter(acc => acc.account.data.parsed.info.tokenAmount.amount === "1")
                    .map(acc => new PublicKey(acc.account.data.parsed.info.mint));
            } catch (err) {
                console.error("[RECOVERY] Failed to scan Token-2022 accounts:", err);
            }

            const results: { poolAddress: string; positionId: string }[] = [];

            // Process DLMM Results
            dlmmAccounts.forEach(acc => {
                const poolAddress = new PublicKey(acc.account.data.slice(8, 40)).toBase58();
                results.push({ poolAddress, positionId: acc.pubkey.toBase58() });
            });

            // Process Potential CP-AMM positions (PDA derivation)
            // This is MUCH faster and avoids "Large Dataset" RPC errors.
            for (let i = 0; i < potentialMints.length; i += 10) {
                const batch = potentialMints.slice(i, i + 10);
                await Promise.all(batch.map(async (mint) => {
                    try {
                        const positionAddress = derivePositionAddress(mint);
                        const accountInfo = await safeRpc(() => this.connection.getAccountInfo(positionAddress), "getAccountInfoRecovery");

                        if (accountInfo) {
                            // Pool address is at offset 8 (32 bytes)
                            const poolAddress = new PublicKey(accountInfo.data.slice(8, 40)).toBase58();
                            results.push({
                                poolAddress,
                                positionId: positionAddress.toBase58()
                            });
                        }
                    } catch (e) {
                        // Skip if one failed
                    }
                }));
            }

            return results;
        } catch (e) {
            console.error("[RECOVERY] Failed to fetch user positions:", e);
            return [];
        }
    }

    async getMeteoraFees(poolAddress: string): Promise<{ feeA: bigint; feeB: bigint }> {
        const { CpAmm } = require("@meteora-ag/cp-amm-sdk");
        const { PublicKey } = require("@solana/web3.js");

        try {
            const cpAmm = new CpAmm(this.connection);
            const userPositions = await cpAmm.getUserPositionByPool(new PublicKey(poolAddress), this.wallet.publicKey);

            if (userPositions.length === 0) return { feeA: 0n, feeB: 0n };

            const pos = userPositions[0];
            return {
                feeA: BigInt(pos.positionState.feeAPending.toString()),
                feeB: BigInt(pos.positionState.feeBPending.toString())
            };
        } catch (error) {
            return { feeA: 0n, feeB: 0n };
        }
    }

    /**
     * Claims accumulated fees from a Meteora position.
     */
    /**
     * Claims accumulated fees from a Meteora position.
     * @param poolAddress The pool address.
     * @param bundleMode If true, returns the transaction instead of sending it.
     */
    async claimMeteoraFees(poolAddress: string, bundleMode: boolean = false): Promise<{ success: boolean; txSig?: string; transaction?: Transaction; error?: string }> {
        const { CpAmm, getTokenProgram } = require("@meteora-ag/cp-amm-sdk");
        const { PublicKey, sendAndConfirmTransaction } = require("@solana/web3.js");

        console.log(`[STRATEGY] Claiming fees from pool: ${poolAddress}${bundleMode ? " (BUNDLE MODE)" : ""}`);
        try {
            const cpAmm = new CpAmm(this.connection);
            const poolPubkey = new PublicKey(poolAddress);
            const userPositions = await cpAmm.getUserPositionByPool(poolPubkey, this.wallet.publicKey);

            if (userPositions.length === 0) {
                return { success: false, error: "No active position found." };
            }

            const pos = userPositions[0];

            // Safety check: Don't claim if fees are 0
            if (pos.positionState.feeAPending.isZero() && pos.positionState.feeBPending.isZero()) {
                console.log(`[METEORA] Skipping claim: No pending fees found.`);
                return { success: false, error: "No pending fees to claim." };
            }

            const poolState = await cpAmm.fetchPoolState(poolPubkey);

            const tx = await cpAmm.claimPositionFee({
                owner: this.wallet.publicKey,
                position: pos.position,
                pool: poolPubkey,
                positionNftAccount: pos.positionNftAccount,
                tokenAMint: poolState.tokenAMint,
                tokenBMint: poolState.tokenBMint,
                tokenAVault: poolState.tokenAVault,
                tokenBVault: poolState.tokenBVault,
                tokenAProgram: getTokenProgram(poolState.tokenAFlag),
                tokenBProgram: getTokenProgram(poolState.tokenBFlag)
            });

            if (bundleMode) {
                return { success: true, transaction: tx };
            }

            const priorityFee = await this.getPriorityFee();
            tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));

            const txSig = await sendAndConfirmTransaction(this.connection, tx, [this.wallet], {
                skipPreflight: true,
                commitment: "confirmed"
            });
            console.log(`[METEORA] Fees Claimed: https://solscan.io/tx/${txSig}`);
            return { success: true, txSig };

        } catch (error: any) {
            console.error(`[METEORA] Claim Fees Error:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Executes an Atomic Fee Funnel by bundling [Claim] + [Swap] + [Transfer] into a single Jito Bundle.
     */
    async executeAtomicFeeFunnel(poolAddress: string, recipient: string): Promise<{ success: boolean; bundleId?: string; signatures?: string[]; error?: string }> {
        console.log(`[FEE-FUNNEL] Initiating atomic harvest for ${poolAddress.slice(0, 8)}...`);
        try {
            const recipientPubkey = new PublicKey(recipient);

            // 1. Prepare Claim Transaction
            const claimRes = await this.claimMeteoraFees(poolAddress, true);
            if (!claimRes.success || !claimRes.transaction) {
                return { success: false, error: `Claim prep failed: ${claimRes.error}` };
            }

            // 2. Estimate fees to determine swap/transfer amounts
            const posValue = await this.getPositionValue(poolAddress, "", undefined);
            if (!posValue.success) {
                return { success: false, error: "Could not fetch position value for bundling." };
            }

            const allTxs: (Transaction | VersionedTransaction)[] = [claimRes.transaction];
            let estimatedTotalSolOutput = 0;

            // 3a. Prepare Swap for TARGET token fees → SOL (if Token fees > 0)
            if (posValue.feesTokenRaw > 0n) {
                const swapRes = await this.sellToken(new PublicKey(posValue.mint), posValue.feesTokenRaw, 10, true);
                if (swapRes.success && swapRes.transaction) {
                    allTxs.push(swapRes.transaction);
                    estimatedTotalSolOutput += swapRes.amountSol;
                }
            }

            // 3b. Prepare Swap for BASE token fees → SOL (if base is NOT SOL)
            const isBaseSol = posValue.baseMint === SOL_MINT.toBase58();
            if (isBaseSol) {
                // Base IS SOL — fees are already in lamports, add directly
                estimatedTotalSolOutput += Number(posValue.feesBaseRaw) / LAMPORTS_PER_SOL;
            } else if (posValue.feesBaseRaw > 0n) {
                // Base is LPPP/HTP — need to swap base token → SOL
                const swapBaseRes = await this.sellToken(new PublicKey(posValue.baseMint), posValue.feesBaseRaw, 10, true);
                if (swapBaseRes.success && swapBaseRes.transaction) {
                    allTxs.push(swapBaseRes.transaction);
                    estimatedTotalSolOutput += swapBaseRes.amountSol;
                }
            }

            // 4. Calculate total SOL to transfer (from Jupiter-estimated swap outputs)
            const totalSolToDistributeRaw = BigInt(Math.floor(estimatedTotalSolOutput * LAMPORTS_PER_SOL));

            // We subtract a buffer for tips and gas (0.005 SOL is safe)
            const BUFFER_LAMPORTS = BigInt(Math.floor(0.005 * LAMPORTS_PER_SOL));
            const transferAmountLamports = totalSolToDistributeRaw > BUFFER_LAMPORTS ? totalSolToDistributeRaw - BUFFER_LAMPORTS : 0n;

            if (transferAmountLamports > BigInt(Math.floor(0.001 * LAMPORTS_PER_SOL))) {
                const transferTx = new Transaction().add(
                    SystemProgram.transfer({
                        fromPubkey: this.wallet.publicKey,
                        toPubkey: recipientPubkey,
                        lamports: transferAmountLamports
                    })
                );
                allTxs.push(transferTx);
            }

            // 5. Send Bundle
            const bundleRes = await this.sendJitoBundle(allTxs);
            if (bundleRes.success) {
                const solValue = Number(transferAmountLamports) / Number(LAMPORTS_PER_SOL);
                SocketManager.emitLog(`[FEE-FUNNEL] Bundle accepted. Payout: ~${solValue.toFixed(4)} SOL`, "success");
                return bundleRes;
            } else {
                return { success: false, error: bundleRes.error };
            }

        } catch (error: any) {
            console.error(`[FEE-FUNNEL] Execution Failed:`, error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Discovers all active Meteora CP-AMM positions for the wallet.
     */
    async syncPositions(): Promise<any[]> {
        const { CpAmm } = require("@meteora-ag/cp-amm-sdk");
        try {
            const cpAmm = new CpAmm(this.connection);
            const positions = await cpAmm.getPositionsByUser(this.wallet.publicKey);
            return positions.map((p: any) => ({
                publicKey: p.publicKey.toBase58(),
                pool: p.account.pool.toBase58(),
                nftMint: p.account.positionNftMint.toBase58(),
                liquidity: p.account.unlockedLiquidity.toString()
            }));
        } catch (error) {
            console.error("[STRATEGY] Sync Positions Error:", error);
            return [];
        }
    }

    /**
     * Executes an Atomic Stop Loss by bundling Liquidity Removal and Token Swap into a single Jito Bundle.
     */
    async executeAtomicStopLoss(poolAddress: string, tokenMint: string, percent: number = 80, positionId?: string): Promise<{ success: boolean; bundleAccepted?: boolean; bundleId?: string; signatures?: string[]; error?: string }> {
        console.log(`[ATOMIC-SL] Initiating bundled exit for ${tokenMint.slice(0, 8)}...`);
        try {
            // 1. Get position value to estimate swap amount
            const posValue = await this.getPositionValue(poolAddress, tokenMint, positionId);
            if (!posValue.success || (posValue.userTokenInLp <= 0 && posValue.userTokenRaw <= 0n)) {
                return { success: false, error: "Could not fetch position value for bundling." };
            }

            // Use raw units for precision
            const atomicAmount = posValue.userTokenRaw * BigInt(percent) / 100n;

            if (atomicAmount <= 0n) {
                return { success: false, error: "Estimated swap amount is zero." };
            }

            // 2. Prepare Withdrawal Transactions (But don't send)
            const withdrawRes = await this.removeMeteoraLiquidity(poolAddress, percent, positionId, true);
            if (!withdrawRes.success || !withdrawRes.transactions || withdrawRes.transactions.length === 0) {
                return { success: false, error: `Withdrawal prep failed: ${withdrawRes.error}` };
            }

            // 3. Prepare Swap Transaction (But don't send)
            const swapRes = await this.sellToken(new PublicKey(tokenMint), atomicAmount, 10, true);
            if (!swapRes.success || !swapRes.transaction) {
                return { success: false, error: `Swap prep failed: ${swapRes.error}` };
            }

            // 4. Bundle and Send!
            const allTxs = [...withdrawRes.transactions, swapRes.transaction];
            const bundleRes = await this.sendJitoBundle(allTxs);

            if (bundleRes.success) {
                SocketManager.emitLog(`[ATOMIC-SL] Bundle accepted by Jito. Confirming on-chain...`, "warning");

                // Wait for on-chain confirmation (poll every 2s, max 30s)
                const sigToConfirm = bundleRes.signatures?.find(s => s !== "unknown");
                if (sigToConfirm) {
                    const MAX_POLLS = 15;
                    for (let i = 0; i < MAX_POLLS; i++) {
                        await new Promise(r => setTimeout(r, 2000));
                        const statusRes = await this.connection.getSignatureStatuses([sigToConfirm]);
                        const status = statusRes.value?.[0];
                        if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
                            SocketManager.emitLog(`[ATOMIC-SL] Bundle confirmed on-chain! Bundle: ${bundleRes.bundleId}`, "success");
                            return { success: true, bundleId: bundleRes.bundleId, signatures: bundleRes.signatures };
                        }
                        if (status?.err) {
                            return { success: false, error: `Bundle tx failed on-chain: ${JSON.stringify(status.err)}` };
                        }
                    }
                    return { success: false, bundleAccepted: true, bundleId: bundleRes.bundleId, error: "Bundle not confirmed after 30s" };
                } else {
                    return { success: false, bundleAccepted: true, bundleId: bundleRes.bundleId, error: "No valid signature to confirm" };
                }
            } else {
                return { success: false, error: bundleRes.error };
            }

        } catch (error: any) {
            console.error(`[ATOMIC-SL] Execution Failed:`, error.message);
            return { success: false, error: error.message };
        }
    }
}
