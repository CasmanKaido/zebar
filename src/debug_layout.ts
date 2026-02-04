
import { Liquidity } from "@raydium-io/raydium-sdk";
import { Connection } from "@solana/web3.js";

async function main() {
    console.log("Checking Raydium V4 Layout Offsets...");

    // Get the V4 state layout
    const layout = Liquidity.getStateLayout(4);

    // @ts-ignore
    if (layout && layout.fields) {
        // @ts-ignore
        layout.fields.forEach((field: any) => {
            // Check for key properties
            if (['baseMint', 'quoteMint', 'lpMint', 'marketId'].includes(field.property)) {
                // @ts-ignore
                console.log(`${field.property}: Offset ${layout.offsetOf(field.property)}`);
            }
        });
    } else {
        console.log("Could not access layout fields directy.");
    }
}

main().catch(console.error);
