
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const API_KEY = process.env.BIRDEYE_API_KEY;

async function testNewListings() {
    try {
        console.log("Fetching New Listings...");
        const response = await axios.get("https://public-api.birdeye.so/defi/v3/token/new_listing", {
            headers: {
                "X-API-KEY": API_KEY,
                "x-chain": "solana",
                "accept": "application/json"
            },
            params: {
                limit: 10,
                meme_platform_enabled: true // Get pump.fun/moonshot tokens too
            }
        });

        if (response.data && response.data.success) {
            const items = response.data.data.items;
            console.log(`✅ Found ${items.length} new tokens.`);
            if (items.length > 0) {
                const first = items[0];
                console.log(`Sample: ${first.symbol} (${first.address}) - Liq: ${first.liquidity}`);
            }
        } else {
            console.log("❌ Response Error:", JSON.stringify(response.data));
        }

    } catch (e: any) {
        console.error("❌ Request Failed:", e.message);
        if (e.response) console.error("Data:", JSON.stringify(e.response.data));
    }
}

testNewListings();
