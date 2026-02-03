const axios = require('axios');

async function test_dex() {
    try {
        const SOL_MINT = "So11111111111111111111111111111111111111112";

        const r1 = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`);
        console.log(`Tokens API (SOL) found ${r1.data.pairs?.length || 0} pairs`);

        const r2 = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=solana`);
        console.log(`Search API (solana) found ${r2.data.pairs?.length || 0} pairs`);

        // Get some symbols
        if (r1.data.pairs) {
            console.log("Top 3 pairs from Tokens API:");
            r1.data.pairs.slice(0, 3).forEach(p => console.log(` - ${p.baseToken.symbol}/${p.quoteToken.symbol} (${p.pairAddress})`));
        }

    } catch (err) {
        console.error(err.message);
    }
}

test_dex();
