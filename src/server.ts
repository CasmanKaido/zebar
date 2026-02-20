import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { createServer } from "http";
import cors from "cors";
import path from "path";
import { BotManager } from "./bot-manager";
import { SocketManager } from "./socket";
import { GeckoService } from "./gecko-service";
import { SOL_MINT, LPPP_MINT } from "./config";
import { JupiterPriceService } from "./jupiter-price-service";
import { HeliusWebhookService } from "./helius-webhook-service";

const app = express();
app.use(cors());
app.use(express.json());

// ═══ API Authentication Middleware ═══
// Protects all /api/* routes (except webhooks) with an API key.
// Set API_SECRET in .env. If not set, access is allowed with a warning.
const API_SECRET = process.env.API_SECRET?.trim();
if (!API_SECRET) {
    console.warn("[SECURITY WARNING] API_SECRET is not set in .env. API endpoints are UNPROTECTED. Set API_SECRET to enable authentication.");
}

app.use("/api", (req, res, next) => {
    // console.log(`[API] ${req.method} ${req.path}`);

    // Skip auth for webhook endpoints (they use their own auth)
    if (req.path.startsWith("/webhooks")) return next();

    // PUBLIC ENDPOINTS: Allow access without API Key
    const publicEndpoints = ["/status", "/price", "/portfolio", "/wallet"];
    // Strip trailing slash if present for robustness
    const cleanPath = req.path.replace(/\/$/, "");
    if (publicEndpoints.includes(cleanPath)) return next();

    // Skip auth if no API_SECRET is configured (backward compatible)
    if (!API_SECRET) return next();

    const providedKey = req.headers["x-api-key"];
    if (providedKey !== API_SECRET) {
        return res.status(401).json({ error: "Unauthorized. Provide valid x-api-key header." });
    }
    next();
});

// Serve static frontend in production
const clientPath = path.join(__dirname, "../client/dist");
app.use(express.static(clientPath));

const httpServer = createServer(app);

// Initialize Socket
SocketManager.init(httpServer);

// Bot Controller
const botManager = new BotManager();

// Sync Status on connection
SocketManager.io.on("connection", (socket) => {
    socket.emit("status", { running: botManager.isRunning });
});

// API Endpoints
app.get("/api/status", (req, res) => {
    res.json({ running: botManager.isRunning });
});

app.get("/api/settings", (req, res) => {
    res.json(botManager.getSettings());
});

app.post("/api/start", async (req, res) => {
    try {
        await botManager.start(req.body);
        res.json({ success: true, running: true });
    } catch (error: any) {
        console.error("[API] Start failed:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post("/api/stop", (req, res) => {
    botManager.stop();
    res.json({ success: true, running: false });
});

// Proxy for Real-Time Price (Server-side fetch avoids CORS/Rate limits)
// Price cache to prevent rate limiting (15s TTL)
let priceCache: { sol: number; lppp: number } | null = null;
let priceCacheTime = 0;
const PRICE_CACHE_TTL = 15000;

app.get("/api/price", async (req, res) => {
    // console.log(`[DEBUG] Fetching Prices...`);
    if (priceCache && Date.now() - priceCacheTime < PRICE_CACHE_TTL) {
        console.log(`[DEBUG] Serving Prices from Cache: SOL=${priceCache.sol}, LPPP=${priceCache.lppp}`);
        return res.json(priceCache);
    }

    const prices = { sol: 0, lppp: 0 };

    try {
        // 1. Fetch Prices via Jupiter Service
        const jupPrices = await JupiterPriceService.getPrices([
            SOL_MINT.toBase58(),
            LPPP_MINT.toBase58()
        ]);

        prices.sol = jupPrices.get(SOL_MINT.toBase58()) || 0;
        prices.lppp = jupPrices.get(LPPP_MINT.toBase58()) || 0;

        // 2. Fallbacks (only if primary Jupiter fails)
        if (!prices.sol) {
            try {
                // Secondary check: CoinGecko
                const solRes = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
                const solData = await solRes.json();
                const cgPrice = solData?.solana?.usd;

                if (cgPrice) {
                    prices.sol = cgPrice;
                    console.log(`[DEBUG] CoinGecko SOL Live: $${prices.sol}`);
                } else {
                    // Tertiary check: DexScreener for SOL/USDC
                    console.log(`[DEBUG] CoinGecko failed. Trying DexScreener...`);
                    const solDexRes = await fetch("https://api.dexscreener.com/latest/dex/pairs/solana/8sc7wj9eay6zm4pjrfsff2vmsvwwxuz2j6be6sqmjd6w"); // SOL/USDC Pair
                    const solDexData = await solDexRes.json();
                    const dexPrice = parseFloat(solDexData?.pair?.priceUsd || "0");

                    if (dexPrice > 0) {
                        prices.sol = dexPrice;
                        console.log(`[DEBUG] DexScreener SOL Live: $${prices.sol}`);
                    }
                }
            } catch (fallbackErr) {
                console.error("[ERROR] All live price sources for SOL failed.");
            }
        }

        // 4. Fallback for LPPP
        if (!prices.lppp) {
            try {
                const dexRes = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + LPPP_MINT.toBase58());
                const dexData = await dexRes.json();
                if (dexData?.pairs?.[0]?.priceUsd) prices.lppp = parseFloat(dexData.pairs[0].priceUsd);
                console.log(`[DEBUG] DexScreener LPPP Fallback: ${prices.lppp}`);
            } catch (e) {
                console.error("LPPP Price DexScreener Fallback failed", e);
            }
        }

        console.log(`[DEBUG] Final Price Sync: SOL=$${prices.sol.toFixed(2)}, LPPP=$${prices.lppp.toFixed(6)}`);

        priceCache = prices;
        priceCacheTime = Date.now();
        return res.json(prices);
    } catch (error) {
        console.error("Price Proxy Critical Error:", error);
        res.status(500).json({ error: "Failed to fetch prices" });
    }
});

// Portfolio Endpoint (SOL/LPPP Balances)
app.get("/api/portfolio", async (req, res) => {
    const balance = await botManager.getWalletBalance(); // Correct method for UI widget
    res.json(balance);
});

// Alias for client compatibility (Issue 44)
app.get("/api/wallet", async (req, res) => {
    const balance = await botManager.getWalletBalance();
    res.json(balance);
});

// Liquidity Management Endpoints
app.post("/api/pool/withdraw", async (req, res) => {
    const { poolId, percent } = req.body;
    if (!poolId) return res.status(400).json({ error: "Missing poolId" });
    const result = await botManager.withdrawLiquidity(poolId, percent || 80);
    res.json(result);
});

app.post("/api/pool/increase", async (req, res) => {
    const { poolId, amountSol } = req.body;
    if (!poolId || !amountSol) return res.status(400).json({ error: "Missing poolId or amountSol" });
    const result = await botManager.increaseLiquidity(poolId, amountSol);
    res.json(result);
});

app.post("/api/pool/claim", async (req, res) => {
    const { poolId } = req.body;
    if (!poolId) return res.status(400).json({ error: "Missing poolId" });
    const result = await botManager.claimFees(poolId);
    res.json(result);
});

// Config Endpoints
app.post("/api/config/key", async (req, res) => {
    const { privateKey, adminPassword } = req.body;
    if (!privateKey) return res.status(400).json({ error: "Missing privateKey" });

    // Security: Add password protection (Issue 34)
    const REQUIRED_PASSWORD = process.env.ADMIN_PASSWORD || "lppp-admin";
    if (adminPassword !== REQUIRED_PASSWORD) {
        return res.status(401).json({ error: "Invalid admin password" });
    }

    const result = await botManager.updateWallet(privateKey);
    res.json(result);
});

// Helius Webhook Endpoint for Real-Time Discovery
app.post("/api/webhooks/helius", async (req, res) => {
    try {
        const authHeader = req.headers["authorization"] as string;
        const success = await HeliusWebhookService.handleWebhook(req.body, botManager, authHeader);
        if (success) {
            res.status(200).send("OK");
        } else {
            res.status(401).send("Unauthorized");
        }
    } catch (error) {
        console.error("[SERVER] Webhook Error:", error);
        res.status(500).send("Internal Server Error");
    }
});

// Catch-all to serve React's index.html
app.use((req, res) => {
    res.sendFile(path.join(clientPath, "index.html"));
});

const PORT = Number(process.env.PORT) || 3000;

httpServer.listen(PORT, () => {
    console.log(`LPPP BOT Unified Server running on port ${PORT}`);
    console.log(`LPPP BOT Version: v1.5.9 (Birdeye Sync + Optimized)`);
    console.log(`[CONFIG] API_SECRET Status: ${API_SECRET ? "CONFIGURED (Locked)" : "UNSET (Public Access Mode)"}`);
    console.log(`[CONFIG] RPC_URL: ${process.env.RPC_URL ? "OK" : "MISSING"}`);
    const birdKey = process.env.BIRDEYE_API_KEY;
    console.log(`[CONFIG] BIRDEYE_API_KEY: ${birdKey ? birdKey.substring(0, 4) + "****" : "MISSING/UNSET"}`);
});
