import axios from "axios";
import { PublicKey } from "@solana/web3.js";
import { SocketManager } from "./socket";
import { BirdeyeService } from "./birdeye-service";
export interface ScanResult {
    mint: PublicKey;
    pairAddress: string;
    dexId: string;
    volume24h: number;
    liquidity: number;
    mcap: number;
    symbol: string;
    priceUsd: number;
}

export interface ScannerCriteria {
    minVolume5m: number;
    minVolume1h: number;
    minVolume24h: number;
    minLiquidity: number;
    minMcap: number;
}

export class MarketScanner {
    private isRunning: boolean = false;
    private criteria: ScannerCriteria;
    private callback: (result: ScanResult) => Promise<void>;
    private seenPairs: Map<string, number> = new Map(); // pairAddress -> timestamp
    private SEEN_COOLDOWN = 5 * 60 * 1000; // 5 minute cooldown
    private scanInterval: NodeJS.Timeout | null = null;
    private jupiterTokens: Map<string, any> = new Map(); // mint -> metadata
    private lastJupiterSync = 0;
    private JUPITER_SYNC_INTERVAL = 60 * 60 * 1000; // 1 hour
    private jupiterSyncFailed = false;
    private jupiterFailCooldown = 0; // timestamp when we can retry after failure

    constructor(criteria: ScannerCriteria, callback: (result: ScanResult) => Promise<void>) {
        this.criteria = criteria;
        this.callback = callback;
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;

        const startMsg = "LPPP BOT Sweeper Active: Scanning the Solana Market for top-performing tokens...";
        console.log(startMsg);
        SocketManager.emitLog(startMsg, "success");

        // Initial Jupiter Sync
        await this.syncJupiterTokens();

        // Start the sweeping loop
        this.runSweeper();
    }

    private async syncJupiterTokens() {
        if (Date.now() - this.lastJupiterSync < this.JUPITER_SYNC_INTERVAL) return;
        // If we failed recently, don't retry for 10 minutes
        if (this.jupiterSyncFailed && Date.now() < this.jupiterFailCooldown) return;

        let attempts = 0;
        const maxAttempts = 2; // Reduced from 5: don't waste sweep time

        while (attempts < maxAttempts) {
            try {
                SocketManager.emitLog(`[JUPITER] Refreshing global token list (Attempt ${attempts + 1}/${maxAttempts})...`, "info");
                const res = await axios.get("https://token.jup.ag/all", { timeout: 15000 });
                if (Array.isArray(res.data)) {
                    this.jupiterTokens.clear();
                    res.data.forEach((t: any) => {
                        this.jupiterTokens.set(t.address, t);
                    });
                    this.lastJupiterSync = Date.now();
                    SocketManager.emitLog(`[JUPITER] Synced ${res.data.length} tokens for validation.`, "success");
                    return; // Success
                }
            } catch (e: any) {
                attempts++;
                const isDnsError = e.code === 'ENOTFOUND' || e.message.includes('getaddrinfo');
                const errMsg = isDnsError ? "DNS lookup failed (network glitch?)" : e.message;

                if (attempts < maxAttempts) {
                    const delay = attempts * 3000; // 3s, 6s
                    console.warn(`[JUPITER WARN] Sync attempt ${attempts} failed: ${errMsg}. Retrying in ${delay / 1000}s...`);
                    await new Promise(r => setTimeout(r, delay));
                } else {
                    this.jupiterSyncFailed = true;
                    this.jupiterFailCooldown = Date.now() + (10 * 60 * 1000); // 10 min cooldown
                    console.error(`[JUPITER ERROR] Sync failed after ${maxAttempts} attempts: ${errMsg}. Cooling down for 10 mins. On-chain fallback active.`);
                }
            }
        }
    }

    private async runSweeper() {
        let sweepCount = 0;
        while (this.isRunning) {
            try {
                sweepCount++;
                // Log a heartbeat every 20 sweeps (~10 minutes)
                if (sweepCount % 20 === 0) {
                    SocketManager.emitLog("[HEARTBEAT] LPPP BOT is actively scanning the market. All systems operational.", "success");
                }

                // Fire-and-forget Jupiter sync (don't block the sweep)
                this.syncJupiterTokens().catch(() => { });

                await this.performMarketSweep();

                // Prune expired seenPairs to prevent memory leak
                const now = Date.now();
                for (const [key, timestamp] of this.seenPairs) {
                    if (now - timestamp > this.SEEN_COOLDOWN) {
                        this.seenPairs.delete(key);
                    }
                }
            } catch (error: any) {
                console.error(`[SWEEPER ERROR] ${error.message}`);
            }
            // Wait 30 seconds between sweeps to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 30000));
        }
    }

    private async performMarketSweep() {
        SocketManager.emitLog("[SWEEPER] Harvesting the whole Solana ecosystem for opportunities...", "info");

        try {
            let allPairs: any[] = [];

            // 1. HARVEST the "Whole Ecosystem" via GeckoTerminal Network Pools (Paginated)
            // This hits Raydium, Meteora, Orca, etc. and finds EVERYTHING with volume
            for (let page = 1; page <= 3; page++) { // Capped at 3 pages for rate limit safety
                try {
                    const geckoRes = await axios.get(`https://api.geckoterminal.com/api/v2/networks/solana/pools?page=${page}`, { timeout: 8000 });
                    if (geckoRes.data.data) {
                        const pagePairs = geckoRes.data.data.map((p: any) => ({
                            pairAddress: p.attributes.address,
                            chainId: "solana",
                            dexId: p.relationships.dex.data.id, // e.g. 'raydium', 'meteora'
                            baseToken: {
                                symbol: p.attributes.name.split(" / ")[0],
                                address: p.relationships.base_token.data.id.split("_")[1]
                            },
                            quoteToken: {
                                symbol: p.attributes.name.split(" / ")[1],
                                address: p.relationships.quote_token.data.id.split("_")[1]
                            },
                            priceUsd: p.attributes.base_token_price_usd,
                            volume: {
                                m5: Number(p.attributes.volume_usd.m5),
                                h1: Number(p.attributes.volume_usd.h1),
                                h24: Number(p.attributes.volume_usd.h24)
                            },
                            liquidity: { usd: Number(p.attributes.reserve_in_usd) },
                            marketCap: Number(p.attributes.fdv_usd) || 0
                        }));
                        allPairs = [...allPairs, ...pagePairs];
                    }
                } catch (e: any) {
                    if (e.response?.status === 429) {
                        console.error(`[GECKO CIRCUIT BREAKER] 429 detected on Page ${page}. Halting sweep to protect IP.`);
                        break; // Stop fetching more pages
                    }
                    console.error(`[GECKO ERROR] Page ${page} failed: ${e.message}`);
                }
                // Rate limit protection: Slow 5.0s between pages
                if (page < 3) await new Promise(r => setTimeout(r, 5000));
            }

            // 2. Add Broad DexScreener Search (Meteora specifically)
            const keywordQueries = ["meteora"];
            for (const query of keywordQueries) {
                try {
                    const searchRes = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${query}`, { timeout: 5000 });
                    if (searchRes.data.pairs) allPairs = [...allPairs, ...searchRes.data.pairs];
                } catch (e) { }
            }

            // 3. NEW: Birdeye High-Volume Tokens
            try {
                const birdeyeResults = await BirdeyeService.fetchHighVolumeTokens(this.criteria);
                if (birdeyeResults.length > 0) {
                    allPairs = [...allPairs, ...birdeyeResults];
                }
            } catch (e) {
                console.warn(`[BIRDEYE] Error: ${e}`);
            }



            // 4. NEW: DexScreener Boosted Tokens
            try {
                const boostedRes = await axios.get("https://api.dexscreener.com/token-boosts/latest/v1", { timeout: 5000 });
                if (Array.isArray(boostedRes.data)) {
                    // Filter for Solana tokens only and mark as high-priority
                    const solanaBoosted = boostedRes.data.filter((t: any) => t.chainId === "solana");
                    const boostedPairs = solanaBoosted.map((t: any) => ({ ...t, isBoosted: true }));
                    allPairs = [...allPairs, ...boostedPairs];
                }
            } catch (e: any) {
                // Not all endpoints are always stable, ignore failures
            }

            // Deduplicate pairs by address and FILTER FOR METEORA ONLY
            const uniquePairsMap = new Map();
            allPairs.forEach(p => {
                // Handle different response formats between Gecko and DexScreener
                const dexId = (p.dexId || p.relationships?.dex?.data?.id || "").toLowerCase();
                const chainId = (p.chainId || "solana").toLowerCase();
                const address = p.pairAddress || p.attributes?.address;

                if (chainId === "solana" && address && !uniquePairsMap.has(address)) {
                    // Normalize standard format for internal loop
                    uniquePairsMap.set(address, {
                        pairAddress: address,
                        dexId: dexId,
                        baseToken: p.baseToken || {
                            address: p.relationships?.base_token?.data?.id?.split("_")[1],
                            symbol: p.attributes?.name?.split(" / ")[0]
                        },
                        quoteToken: p.quoteToken || {
                            address: p.relationships?.quote_token?.data?.id?.split("_")[1],
                            symbol: p.attributes?.name?.split(" / ")[1]
                        },
                        priceUsd: p.priceUsd || p.attributes?.base_token_price_usd,
                        volume: p.volume || {
                            m5: Number(p.attributes?.volume_usd?.m5 || 0),
                            h1: Number(p.attributes?.volume_usd?.h1 || 0),
                            h24: Number(p.attributes?.volume_usd?.h24 || 0)
                        },
                        volume24h: p.volume24h, // Allow direct volume24h passing (Birdeye)
                        liquidity: p.liquidity || { usd: Number(p.attributes?.reserve_in_usd || 0) },
                        marketCap: p.marketCap || p.fdv || p.attributes?.fdv_usd || 0
                    });
                }
            });

            const pairs = Array.from(uniquePairsMap.values());

            if (pairs.length === 0) {
                SocketManager.emitLog("[SWEEPER] Ecosystem harvest came up empty. Retrying...", "warning");
                return;
            }

            console.log(`[SWEEPER] Evaluating ${pairs.length} unique assets from across the ecosystem...`);
            SocketManager.emitLog(`[SWEEPER] Evaluated ${pairs.length} assets. No caps applied.`, "info");

            let candidatesFound = 0;

            for (const pair of pairs) {
                // Check seenPairs with cooldown
                const lastSeen = this.seenPairs.get(pair.pairAddress);
                if (lastSeen && Date.now() - lastSeen < this.SEEN_COOLDOWN) continue;

                const SOL_MINT = "So11111111111111111111111111111111111111112";
                const IGNORED_MINTS = [
                    SOL_MINT,
                    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
                    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
                    "USDH1SM1ojwRrt3WoCkmq7i9DE2yMK77CXY7MvJ8TCe",   // USDH
                    "2b1fDQRsjtB2NYyQCneVr3TXuqcSFCvA13fnc7uxc8vi", // PYUSD
                    "7kbnYjS6zY7ndS9S2MvSdgS9z9S2MvSdgS9z9S2MvSdg", // UXD
                    "mSoLzYawRXYr3WvR86An1Ah6B1isS2nEv4tXQ7pA9Ym",   // mSOL
                    "7dHbS7zSToynF6L8abS2yz7iYit2tiX1XW1tH8YqXgH",   // stSOL
                    "J1tosoecvw9U96jrN17H8NfE59p5RST213R9RNoeWCH",   // jitoSOL
                    "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // RAY
                ];

                // Determine target
                let targetToken = pair.baseToken;
                let priceUSD = Number(pair.priceUsd || 0);

                if (IGNORED_MINTS.includes(targetToken.address)) {
                    targetToken = pair.quoteToken;
                }

                if (IGNORED_MINTS.includes(targetToken.address)) continue;
                if (priceUSD > 0.98 && priceUSD < 1.02) continue;

                // metadata Check / Fallback (Batch 2.0)
                let tokenInfo = this.jupiterTokens.get(targetToken.address);
                if (!tokenInfo) {
                    try {
                        const { connection } = require("./config");
                        const mintPubkey = new PublicKey(targetToken.address);
                        const info = await connection.getParsedAccountInfo(mintPubkey);
                        if (info.value && (info.value.data as any).parsed) {
                            const parsed = (info.value.data as any).parsed.info;
                            tokenInfo = {
                                symbol: targetToken.symbol || "Unknown",
                                decimals: parsed.decimals || 9,
                                name: "Discovery Token"
                            };
                        }
                    } catch (e) { }
                }

                const volume5m = pair.volume?.m5 || 0;
                const volume1h = pair.volume?.h1 || 0;
                const volume24h = pair.volume?.h24 || 0;
                const liquidity = pair.liquidity?.usd || 0;
                const mcap = pair.marketCap || pair.fdv || 0;

                // Check Criteria (Zero means disabled/bypassed)
                const meetsVol5m = Number(this.criteria.minVolume5m) === 0 || Number(volume5m) >= Number(this.criteria.minVolume5m);
                const meetsVol1h = Number(this.criteria.minVolume1h) === 0 || Number(volume1h) >= Number(this.criteria.minVolume1h);
                const meetsVol24h = Number(this.criteria.minVolume24h) === 0 || Number(volume24h) >= Number(this.criteria.minVolume24h);
                const meetsLiquidity = Number(this.criteria.minLiquidity) === 0 || Number(liquidity) >= Number(this.criteria.minLiquidity);
                const meetsMcap = Number(this.criteria.minMcap) === 0 || Number(mcap) >= Number(this.criteria.minMcap);

                if (meetsVol5m && meetsVol1h && meetsVol24h && meetsLiquidity && meetsMcap) {
                    const matchMsg = `[ECOSYSTEM MATCH] ${targetToken.symbol} passed all metrics!`;

                    console.log(matchMsg);
                    SocketManager.emitLog(matchMsg, "success");

                    this.seenPairs.set(pair.pairAddress, Date.now());

                    const result: ScanResult = {
                        mint: new PublicKey(targetToken.address),
                        pairAddress: pair.pairAddress,
                        dexId: pair.dexId || 'unknown',
                        volume24h: Number(volume24h),
                        liquidity: Number(liquidity),
                        mcap: Number(mcap),
                        symbol: targetToken.symbol,
                        priceUsd: priceUSD
                    };

                    await this.callback(result);
                    candidatesFound++;
                }
            }

            const summaryMsg = `[ECOSYSTEM SWEEP COMPLETE] Next harvest in 30s.`;
            console.log(summaryMsg);
            SocketManager.emitLog(summaryMsg, "info");

        } catch (err: any) {
            const errMsg = `[HARVESTER ERROR] ${err.message}`;
            console.error(errMsg);
            SocketManager.emitLog(errMsg, "error");
        }
    }


    /**
     * External trigger for token evaluation (e.g. from Webhooks)
     */
    async evaluateToken(result: ScanResult) {
        if (!this.isRunning) return;

        // Check cooldown
        const lastSeen = this.seenPairs.get(result.pairAddress);
        if (lastSeen && Date.now() - lastSeen < this.SEEN_COOLDOWN) return;

        SocketManager.emitLog(`[EVALUATOR] High-Priority Evaluation for ${result.symbol}...`, "info");
        this.seenPairs.set(result.pairAddress, Date.now());
        await this.callback(result);
    }

    stop() {
        this.isRunning = false;
        console.log("LPPP BOT Sweeper Service Stopped.");
    }
}

