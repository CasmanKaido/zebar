import { Connection, PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";
dotenv.config();
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

async function main() {
    const conn = new Connection(RPC_URL);
    const pumpFun = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    console.log("Fetching recent signatures for pump.fun...");
    const sigs = await conn.getSignaturesForAddress(pumpFun, { limit: 10 });

    // Find one that looks like a creation (not sure, let's just fetch the first 5 parsed txs)
    const txs = await conn.getParsedTransactions(sigs.slice(0, 5).map(s => s.signature), { maxSupportedTransactionVersion: 0 });

    for (let i = 0; i < txs.length; i++) {
        const tx = txs[i];
        if (!tx) continue;

        // Let's see if this is a token creation
        const hasMint = tx.transaction.message.instructions.some((ix: any) => ix.programId.toBase58() === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" && ix.parsed?.type === "initializeMint");

        if (hasMint) {
            console.log("\nFound Pump.fun Creation Tx:", sigs[i].signature);
            console.log("Instructions:", tx.transaction.message.instructions.map((ix: any) => ix.parsed?.type || "unknown"));

            // Look for token balances change
            const preBalances = tx.meta?.preTokenBalances || [];
            const postBalances = tx.meta?.postTokenBalances || [];
            console.log("Pre Balances:", preBalances.length, "Post Balances:", postBalances.length);

            // Check if there are actual new tokens
            for (const post of postBalances) {
                const mint = post.mint;
                const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
                const preAmount = pre ? pre.uiTokenAmount.uiAmount : 0;
                const postAmount = post.uiTokenAmount.uiAmount;
                if (preAmount !== postAmount) {
                    console.log(`Balance change for ${mint}: ${preAmount} -> ${postAmount}`);
                }
            }
        } else {
            console.log("Tx", sigs[i].signature, "is not a mint initialization.");
        }
    }
}

main().catch(console.error);
