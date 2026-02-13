
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import dotenv from "dotenv";

dotenv.config();

export const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
export const BACKUP_RPC_URL = process.env.BACKUP_RPC_URL;
export const WSS_URL = process.env.WSS_URL || "wss://api.mainnet-beta.solana.com";

// Jupiter API Key (Ultra/V6)
export const JUPITER_API_KEY = process.env.JUPITER_API_KEY;
export const JUPITER_API_URL = "https://api.jup.ag/ultra/v1/order";

// Birdeye API Key
export const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || "";

// Paths
import * as path from "path";
export const POOL_DATA_FILE = path.join(process.cwd(), "data/pools.json");

// DRY RUN MODE: Simulate transactions without spending SOL
export const DRY_RUN = process.env.DRY_RUN === 'true';

// Pump.fun Program ID
export const PUMP_FUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

// Token Constants
export const LPPP_MINT = new PublicKey("44sHXMkPeciUpqhecfCysVs7RcaxeM24VPMauQouBREV");
export const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const BONK_MINT = new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");

export const IGNORED_MINTS = [
    SOL_MINT.toBase58(),
    USDC_MINT.toBase58(),
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
    "USDH1SM1ojwRrt3WoCkmq7i9DE2yMK77CXY7MvJ8TCe",   // USDH
    "2b1fDQRsjtB2NYyQCneVr3TXuqcSFCvA13fnc7uxc8vi", // PYUSD
    "7kbnYjS6zY7ndS9S2MvSdgS9z9S2MvSdgS9z9S2MvSdg", // UXD
    "mSoLzYawRXYr3WvR86An1Ah6B1isS2nEv4tXQ7pA9Ym",   // mSOL
    "7dHbS7zSToynF6L8abS2yz7iYit2tiX1XW1tH8YqXgH",   // stSOL
    "J1tosoecvw9U96jrN17H8NfE59p5RST213R9RNoeWCH",   // jitoSOL
    "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // RAY
];

export let connection = new Connection(RPC_URL, {
    wsEndpoint: WSS_URL,
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000 // 60s timeout to reduce 408 errors
});

export function updateConnection(newUrl: string) {
    console.log(`[CONFIG] Switching RPC to: ${newUrl}`);
    connection = new Connection(newUrl, {
        commitment: "confirmed",
        confirmTransactionInitialTimeout: 60000
    });
}

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
