
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import dotenv from "dotenv";

dotenv.config();

export const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
export const BACKUP_RPC_URL = process.env.BACKUP_RPC_URL;
export const WSS_URL = process.env.WSS_URL || "wss://api.mainnet-beta.solana.com";

// Jupiter API Key (Ultra/V6)
export const JUPITER_API_KEY = (process.env.JUPITER_API_KEY || "").trim();
export const JUPITER_API_URL = "https://api.jup.ag/ultra/v1/order";

// Birdeye API Key
export const BIRDEYE_API_KEY = (process.env.BIRDEYE_API_KEY || "").trim();

// Service Fee Configuration
export const FEE_WALLET_ADDRESS = (process.env.FEE_WALLET_ADDRESS || "").trim();
export const FEE_USD_AMOUNT = parseFloat(process.env.FEE_USD_AMOUNT || "0.5");

// Helius Configuration
export const HELIUS_AUTH_SECRET = (process.env.HELIUS_AUTH_SECRET || "").trim();
export const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL;

// Paths
import * as path from "path";
export const POOL_DATA_FILE = path.join(process.cwd(), "data/pools.json");

// DRY RUN MODE: Simulate transactions without spending SOL
export const DRY_RUN = process.env.DRY_RUN === 'true';



// Token Constants (Strict ENV only)
export const BASE_TOKENS: Record<string, PublicKey> = {};

if (!process.env.BASE_TOKENS || process.env.BASE_TOKENS.trim() === "") {
    throw new Error("CRITICAL ERROR: BASE_TOKENS environment variable is missing or empty. Please define at least one base token in your .env file.");
}

try {
    const raw = process.env.BASE_TOKENS;
    let parsed: any;
    try {
        parsed = JSON.parse(raw);
    } catch (_err) {
        // Fallback robust parser for varying dotenv quotes/stripping behaviors
        parsed = (new Function("return " + raw))();
    }

    if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
        throw new Error("BASE_TOKENS JSON is empty.");
    }

    for (const [symbol, address] of Object.entries(parsed)) {
        BASE_TOKENS[symbol] = new PublicKey(address as string);
    }
    console.log(`[CONFIG] Loaded ${Object.keys(BASE_TOKENS).length} Base Tokens from .env:`, Object.keys(BASE_TOKENS).join(", "));
} catch (e: any) {
    throw new Error(`CRITICAL ERROR: Failed to parse BASE_TOKENS from .env. Ensure it is a valid JSON string. Error: ${e.message}`);
}

export const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

export const IGNORED_MINTS = [
    ...Object.values(BASE_TOKENS).map(m => m.toBase58()),
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

// Low-Priority Connection for Informational Tasks (Metadata/Prices)
export const secondaryConnection = BACKUP_RPC_URL
    ? new Connection(BACKUP_RPC_URL, { commitment: "confirmed" })
    : connection;

// Load wallet from private key in .env
// WARNING: NEVER COMMIT REAL PRIVATE KEYS
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
    throw new Error("CRITICAL ERROR: PRIVATE_KEY is missing from .env. Please provide a valid private key to use the bot.");
}

export const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));

console.log("Wallet Public Key:", wallet.publicKey.toBase58());

// Meteora Pool Fee in Basis Points (100 bps = 1%)
// Standard is 20 (0.2%)
export const METEORA_POOL_FEE_BPS = parseInt(process.env.METEORA_POOL_FEE_BPS || "20");
