import { JupiterPriceService } from "./jupiter-price-service";
import { SOL_MINT, FEE_WALLET_ADDRESS, FEE_USD_AMOUNT } from "./config";

async function test() {
    console.log("--- Silent Fee Diagnostic ---");
    console.log("Configured Fee Wallet:", FEE_WALLET_ADDRESS || "NOT SET");
    console.log("Configured Fee USD:", FEE_USD_AMOUNT);

    try {
        const solPrice = await JupiterPriceService.getPrice(SOL_MINT.toBase58());
        console.log("Current SOL Price:", solPrice);

        if (solPrice > 0) {
            const feeSol = FEE_USD_AMOUNT / solPrice;
            console.log("Calculated Fee (SOL):", feeSol.toFixed(9));
            console.log("Status: ✅ Price fetch working.");
        } else {
            console.log("Status: ❌ SOL Price is 0 or fetch failed.");
        }
    } catch (e) {
        console.error("Diagnostic Failed:", e);
    }
}

test();
