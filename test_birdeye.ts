
import dotenv from "dotenv";
dotenv.config();

import { BirdeyeService } from "./src/birdeye-service";
import { ScannerCriteria } from "./src/scanner";

async function testBirdeye() {
    console.log("Testing Birdeye API Connection...");

    if (!process.env.BIRDEYE_API_KEY) {
        console.error("❌ ERROR: BIRDEYE_API_KEY is missing from process.env!");
        process.exit(1);
    }
    console.log(`✅ API Key loaded: ${process.env.BIRDEYE_API_KEY.slice(0, 5)}...`);

    const criteria: ScannerCriteria = {
        volume5m: { min: 0, max: 0 },
        volume1h: { min: 1000, max: 0 }, // Very low filter to ensure we get results
        volume24h: { min: 0, max: 0 },
        liquidity: { min: 0, max: 0 },
        mcap: { min: 0, max: 0 }
    };

    try {
        const tokens = await BirdeyeService.fetchHighVolumeTokens(criteria);
        if (tokens.length > 0) {
            console.log(`✅ SUCCESS! Found ${tokens.length} tokens.`);
            console.log("Sample Token:", tokens[0].symbol, tokens[0].mint.toBase58());
        } else {
            console.log("⚠️  Connection successful, but no tokens found (Criteria might be too strict or API returned empty list).");
        }
    } catch (error: any) {
        console.error("❌ API Request Failed:", error.message);
    }
}

testBirdeye();
