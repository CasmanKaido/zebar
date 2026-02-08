
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import dotenv from "dotenv";

dotenv.config();

export const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
export const WSS_URL = process.env.WSS_URL || "wss://api.mainnet-beta.solana.com";

// Jupiter API Key (Ultra/V6)
export const JUPITER_API_KEY = process.env.JUPITER_API_KEY;
export const JUPITER_API_URL = "https://api.jup.ag/ultra/v1/order";

// DRY RUN MODE: Simulate transactions without spending SOL
export const DRY_RUN = process.env.DRY_RUN === 'true';

// Pump.fun Program ID
export const PUMP_FUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

export const connection = new Connection(RPC_URL, {
    wsEndpoint: WSS_URL,
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000 // 60s timeout to reduce 408 errors
});

// Load wallet from private key in .env or a default dummy
// WARNING: NEVER COMMIT REAL PRIVATE KEYS
const PRIVATE_KEY = process.env.PRIVATE_KEY;
export const wallet = PRIVATE_KEY
    ? Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY))
    : Keypair.generate(); // fallback to random wallet for safety if env missing

console.log("Wallet Public Key:", wallet.publicKey.toBase58());

// Meteora Pool Fee in Basis Points (100 bps = 1%)
// Standard is 20 (0.2%)
export const METEORA_POOL_FEE_BPS = parseInt(process.env.METEORA_POOL_FEE_BPS || "20");
