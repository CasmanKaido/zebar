
import { Connection, PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";

dotenv.config();

async function main() {
    const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
    console.log(`Connecting to ${rpcUrl}...`);
    const connection = new Connection(rpcUrl, "confirmed");

    const RAYDIUM_V4_PROGRAM_ID = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
    const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
    const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

    console.log("Searching for SOL/USDC Pool...");

    const filters = [
        { dataSize: 752 },
        { memcmp: { offset: 400, bytes: USDC_MINT.toBase58() } }, // Base Mint = USDC
        { memcmp: { offset: 432, bytes: SOL_MINT.toBase58() } }  // Quote Mint = SOL
    ];

    const filtersRev = [
        { dataSize: 752 },
        { memcmp: { offset: 400, bytes: SOL_MINT.toBase58() } }, // Base Mint = SOL
        { memcmp: { offset: 432, bytes: USDC_MINT.toBase58() } }  // Quote Mint = USDC
    ];

    try {
        let accounts = await connection.getProgramAccounts(RAYDIUM_V4_PROGRAM_ID, { filters });
        console.log(`Direction 1 (USDC/SOL) found ${accounts.length} accounts.`);
        accounts.forEach(acc => console.log(` - ${acc.pubkey.toBase58()}`));

        let accountsRev = await connection.getProgramAccounts(RAYDIUM_V4_PROGRAM_ID, { filters: filtersRev });
        console.log(`Direction 2 (SOL/USDC) found ${accountsRev.length} accounts.`);
        accountsRev.forEach(acc => console.log(` - ${acc.pubkey.toBase58()}`));

        if (accounts.length === 0 && accountsRev.length === 0) {
            console.error("FAIL: Could not find SOL/USDC pool with these filters!");
        } else {
            console.log("SUCCESS: Found pool(s)!");
        }

    } catch (err) {
        console.error("Error searching:", err);
    }
}

main();
