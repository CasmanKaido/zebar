
import { PUMP_FUN_PROGRAM_ID } from "./config";
import { PublicKey } from "@solana/web3.js";

console.log("Program ID:", PUMP_FUN_PROGRAM_ID.toBase58());

const FEE_RECIPIENT = new PublicKey("CebN5WGQ4jyDrN4mLKzQ2F5wDkDnW3D7X4s4O8p6m8P");
console.log("Fee Recipient:", FEE_RECIPIENT.toBase58());

const [GLOBAL_ACCOUNT] = PublicKey.findProgramAddressSync(
    [Buffer.from("global")],
    PUMP_FUN_PROGRAM_ID
);
console.log("Global Account:", GLOBAL_ACCOUNT.toBase58());
