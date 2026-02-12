import axios from "axios";
import { Connection, PublicKey } from "@solana/web3.js";
import { GeckoService } from "./gecko-service";

export interface TokenMetadata {
    symbol: string;
    name: string;
    mint: string;
}

export class TokenMetadataService {
    private static jupiterCache: Map<string, any> = new Map();
    private static lastSync = 0;
    private static SYNC_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

    private static async syncJupiter() {
        if (Date.now() - this.lastSync < this.SYNC_INTERVAL && this.jupiterCache.size > 0) return;
        try {
            const res = await axios.get("https://token.jup.ag/all", { timeout: 10000 });
            if (Array.isArray(res.data)) {
                res.data.forEach((token: any) => {
                    this.jupiterCache.set(token.address, token);
                });
                this.lastSync = Date.now();
                console.log(`[METADATA] Initialized Jupiter Token List (${this.jupiterCache.size} tokens)`);
            }
        } catch (e) {
            console.error("[METADATA] Jupiter sync failed:", e);
        }
    }

    static async getSymbol(mint: string, connection: Connection): Promise<string> {
        // 1. Jupiter Cache
        await this.syncJupiter();
        const jupToken = this.jupiterCache.get(mint);
        if (jupToken) return jupToken.symbol;

        // 2. DexScreener (Very fast, covers new tokens)
        try {
            const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 5000 });
            const pair = dexRes.data.pairs?.[0];
            if (pair?.baseToken?.symbol) return pair.baseToken.symbol;
        } catch (e) { }

        // 3. Gecko (Deep Metadata)
        const gecko = await GeckoService.getTokenMetadata(mint);
        if (gecko) return gecko.symbol;

        // 4. On-Chain (Slowest, but works for everything)
        try {
            const info = await connection.getParsedAccountInfo(new PublicKey(mint));
            if (info.value?.data && "parsed" in info.value.data) {
                const parsed: any = info.value.data.parsed;
                // This usually requires the Metadata program, but some tokens have it parsed if they use Token2022
                if (parsed.info?.symbol) return parsed.info.symbol;
            }
        } catch (e) { }

        return "UNKNOWN";
    }
}
