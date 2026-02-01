
import { PublicKey } from "@solana/web3.js";
try {
    const pubkey = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqryQMe5vxyHkiwdxIwdF");
    console.log("Success:", pubkey.toBase58());
} catch (e) {
    console.error("Error:", e);
}
