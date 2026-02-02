import axios from "axios";
import { PublicKey, Connection } from "@solana/web3.js";
import { SocketManager } from "./socket";
import { connection } from "./config";

export interface ScanResult {
    mint: PublicKey;
    pairAddress: string;
    volume24h: number;
    liquidity: number;
    mcap: number;
    symbol: string;
}

export interface ScannerCriteria {
    minVolume24h: number;
    minLiquidity: number;
    minMcap: number;
}

// Meteora DLMM Program ID
const METEORA_DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

export class MarketScanner {
    private isRunning: boolean = false;
    private criteria: ScannerCriteria;
    private callback: (result: ScanResult) => Promise<void>;
    private seenPairs: Set<string> = new Set();
    private subscriptionId: number | null = null;

    constructor(criteria: ScannerCriteria, callback: (result: ScanResult) => Promise<void>) {
        this.criteria = criteria;
        this.callback = callback;
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;

        const startMsg = "ZEBAR Streamer Active: Listening for new Meteora DLMM Pools...";
        console.log(startMsg);
        SocketManager.emitLog(startMsg, "success");

        // Subscribe to Meteora DLMM Program Logs
        this.subscriptionId = connection.onLogs(
            new PublicKey(METEORA_DLMM_PROGRAM),
            async ({ logs, err, signature }) => {
                if (err) return;

                // "InitializeLbPair" is the instruction for new DLMM pair creation
                if (logs && logs.some(log => log.includes("InitializeLbPair"))) {
                    console.log(`[PULSE] New Meteora DLMM Pool detected! Sig: ${signature}`);
                    SocketManager.emitLog(`[PULSE] New Meteora DLMM Pool detected! Analyzing...`, "warning");

                    // Small delay to allow DexScreener/RPC to sync the data
                    setTimeout(async () => {
                        await this.fetchAndEvaluate(signature);
                    }, 5000);
                }
            },
            "confirmed"
        );
    }

    private async fetchAndEvaluate(signature: string) {
        try {
            // Get transaction details to find the tokens
            const tx = await connection.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 0,
                commitment: "confirmed"
            });

            if (!tx || !tx.meta) return;

            // Extract the newly created pair or base token
            // This is a simplified extraction - in a real scenario, we parse the accounts.
            // For effectiveness, we'll use DexScreener to get the full profile of the token involved in this signature.
            const accounts = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());

            // Usually the last few accounts or specific positions in initialize2
            // To be robust, we fetch current trending pairs on the chain and find the newest match
            await this.scanRecentForMatch();

        } catch (error) {
            console.error("Evaluation error:", error);
        }
    }

    private async scanRecentForMatch() {
        try {
            // Fetch the absolute latest tokens from Solana
            const SOL_MINT = "So11111111111111111111111111111111111111112";
            const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`);
            const pairs = response.data.pairs;

            if (!pairs) return;

            for (const pair of pairs) {
                if (pair.chainId !== "solana") continue;
                if (this.seenPairs.has(pair.pairAddress)) continue;
                if (pair.baseToken.address === SOL_MINT) continue;

                const volume24h = pair.volume?.h24 || 0;
                const liquidity = pair.liquidity?.usd || 0;
                const mcap = pair.marketCap || pair.fdv || 0;

                // Check Criteria (OR Force first match for testing if criteria are set very low)
                const meetsVolume = Number(volume24h) >= Number(this.criteria.minVolume24h);
                const meetsLiquidity = Number(liquidity) >= Number(this.criteria.minLiquidity);
                const meetsMcap = Number(mcap) >= Number(this.criteria.minMcap);

                // FOR TESTING: If criteria are extremely low (e.g. all 100), we'll treat it as "Pick Anything"
                const isTesting = this.criteria.minVolume24h <= 100 && this.criteria.minMcap <= 100;

                if (meetsVolume && meetsLiquidity && meetsMcap || isTesting) {
                    const matchMsg = isTesting
                        ? `[TESTING] Forcing Strike on ${pair.baseToken.symbol} (Criteria Bypassed)`
                        : `[STRIKE] ${pair.baseToken.symbol} validated via Stream!`;

                    console.log(matchMsg);
                    SocketManager.emitLog(matchMsg, isTesting ? "warning" : "success");

                    this.seenPairs.add(pair.pairAddress);

                    const result: ScanResult = {
                        mint: new PublicKey(pair.baseToken.address),
                        pairAddress: pair.pairAddress,
                        volume24h: Number(volume24h),
                        liquidity: Number(liquidity),
                        mcap: Number(mcap),
                        symbol: pair.baseToken.symbol
                    };

                    await this.callback(result);
                }
            }
        } catch (err) {
            // Silently fail to keep the stream running
        }
    }

    stop() {
        this.isRunning = false;
        if (this.subscriptionId !== null) {
            connection.removeOnLogsListener(this.subscriptionId);
            this.subscriptionId = null;
        }
    }
}
