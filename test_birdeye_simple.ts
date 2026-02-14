
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const API_KEY = process.env.BIRDEYE_API_KEY;

if (!API_KEY) {
    console.error("❌ ERROR: BIRDEYE_API_KEY is missing from .env!");
    process.exit(1);
}

console.log(`✅ API Key loaded: ${API_KEY.slice(0, 5)}...`);

async function test() {
    try {
        console.log("Sending request to Birdeye...");
        const response = await axios.get("https://public-api.birdeye.so/defi/v3/token/list/scroll", {
            headers: {
                "X-API-KEY": API_KEY,
                "x-chain": "solana",
                "accept": "application/json"
            },
            params: {
                sort_by: "volume_24h_usd",
                sort_type: "desc",
                min_volume_24h: 1000 // Simple filter
            }
        });

        if (response.data && response.data.success) {
            const count = response.data.data.items.length;
            console.log(`✅ SUCCESS! Found ${count} tokens.`);
            if (count > 0) {
                const first = response.data.data.items[0];
                console.log(`Sample: ${first.symbol} (${first.address}) - Vol: $${first.volume_24h_usd}`);
            }
        } else {
            console.error("❌ API Response Error:", JSON.stringify(response.data));
        }

    } catch (e: any) {
        console.error("❌ Request Failed:", e.message);
        if (e.response) {
            console.error("Status:", e.response.status);
            console.error("Data:", JSON.stringify(e.response.data));
        }
    }
}

test();
