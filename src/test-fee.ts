import { Connection, Keypair, SystemProgram, TransactionMessage, VersionedTransaction, PublicKey } from "@solana/web3.js";
import { JupiterPriceService } from "./jupiter-price-service";

async function test() {
    console.log("Starting test...");
    try {
        const { FEE_WALLET_ADDRESS, FEE_USD_AMOUNT } = require("./config");
        console.log("FEE_WALLET_ADDRESS:", FEE_WALLET_ADDRESS);
        console.log("FEE_USD_AMOUNT:", FEE_USD_AMOUNT);

        if (!FEE_WALLET_ADDRESS) {
            console.log("No config address");
            return;
        }

        const SOL_MINT = "So11111111111111111111111111111111111111112";
        const solPrice = await JupiterPriceService.getPrice(SOL_MINT);
        console.log("SOL Price via Jupiter:", solPrice);
        if (!solPrice) {
            console.log("No SOL price");
            return;
        }

        const feeSol = FEE_USD_AMOUNT / solPrice;
        const LAMPORTS_PER_SOL = 1e9;
        const lamports = Math.floor(feeSol * LAMPORTS_PER_SOL);
        console.log("Lamports calculated:", lamports);

        const wallet = Keypair.generate();
        const recentBlockhash = "11111111111111111111111111111111";

        const instruction = SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: new PublicKey(FEE_WALLET_ADDRESS),
            lamports: lamports,
        });
        const messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: recentBlockhash,
            instructions: [instruction],
        }).compileToV0Message();

        const feeTx = new VersionedTransaction(messageV0);
        feeTx.sign([wallet]);

        console.log(`[FEE] Generated silent fee transaction: ${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL ($${FEE_USD_AMOUNT})`);
        console.log("Success! Serialized length:", feeTx.serialize().length);
    } catch (e) {
        console.error("Test Error:", e);
    }
}

test();
