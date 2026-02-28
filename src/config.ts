
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


// Helius Configuration
export const HELIUS_AUTH_SECRET = (process.env.HELIUS_AUTH_SECRET || "").trim();
export const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL;
export const MONITOR_RPC_URL = process.env.MONITOR_RPC_URL;

// Paths
import * as path from "path";
export const POOL_DATA_FILE = path.join(process.cwd(), "data/pools.json");

// DRY RUN MODE: Simulate transactions without spending SOL
export const DRY_RUN = process.env.DRY_RUN === 'true';



// Token Constants
export const BASE_TOKENS: Record<string, PublicKey> = {
    "LPPP": new PublicKey("44sHXMkPeciUpqhecfCysVs7RcaxeM24VPMauQouBREV"),
    "HTP": new PublicKey("2JnYVAeY4gYjRSmGRPQi9EudJm88AT6LgVKeKvxeb9Qp")
};

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
// Falls back to Helius RPC, then main RPC
const SECONDARY_URL = BACKUP_RPC_URL || HELIUS_RPC_URL;
export const secondaryConnection = SECONDARY_URL
    ? new Connection(SECONDARY_URL, { commitment: "confirmed" })
    : connection;

// Dedicated Monitor Connection (isolated from scanner/buyer traffic)
// Falls back to Helius RPC, then main RPC
const MONITOR_URL = MONITOR_RPC_URL || HELIUS_RPC_URL;
export const monitorConnection = MONITOR_URL
    ? new Connection(MONITOR_URL, { commitment: "confirmed" })
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

// Jito Configuration
export const JITO_BLOCK_ENGINE_URL = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";
export const JITO_TIP_LAMPORTS = parseInt(process.env.JITO_TIP_LAMPORTS || "100000"); // 0.0001 SOL
export const JITO_TIP_ADDRESSES = [
    "96g9sGbShQC97vY6QK663Y84W51nruXKj4M96c26fCgE",
    "HFqU5x63VTqvQss8hp5X206rU96hVn8vSpzVRnwCHXi",
    "Cw8CFyMvGrnC7APhShtNoRBhAbSC3H7sRLCfJv9C5B7h",
    "ADaUMid9yfUytqMBmgrZ9iSgqsU9Zq2pB3Vqto7X28p6",
    "ADuUk9ZbeL22Sreak4q2Xpzti3S9XAXUXG6U4qH29XmN",
    "DfXygSm4j9vPRp3asR96m7qfB2EitTfey8idKTrUnuBq",
    "DttWaMuVv6tiduHkhfbL2A76Bxzp9qAyK9H699vG2Y7K",
    "3AV99v7yJpS9nS92f1Yrdz4NfBkkd7A9qP1n8S9r3Wv8"
];

// Fee Recipient Wallet (Automation Funnel)
export const FEE_RECIPIENT_WALLET = (process.env.FEE_RECIPIENT_WALLET || "").trim();
