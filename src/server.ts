import express from "express";
import { createServer } from "http";
import cors from "cors";
import path from "path";
import { BotManager } from "./bot-manager";
import { SocketManager } from "./socket";
import { GeckoService } from "./gecko-service";
import { POOL_DATA_FILE, SOL_MINT, LPPP_MINT, BONK_MINT } from "./config";
import { JupiterPriceService } from "./jupiter-price-service";

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
    // Skip auth for webhook endpoints (they use their own auth)
    if (req.path.startsWith("/webhooks")) return next();

    // PUBLIC ENDPOINTS: Allow access without API Key
    const publicEndpoints = ["/status", "/price", "/portfolio", "/wallet"];
    if (publicEndpoints.includes(req.path)) return next();

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
let priceCache: { sol: number; lppp: number; bonk: number } | null = null;
let priceCacheTime = 0;
const PRICE_CACHE_TTL = 15000;

app.get("/api/price", async (req, res) => {
    if (priceCache && Date.now() - priceCacheTime < PRICE_CACHE_TTL) {
        return res.json(priceCache);
    }
    const prices = { sol: 0, lppp: 0, bonk: 0 };

    try {
        // 1. Fetch Prices via Jupiter Service
        const jupPrices = await JupiterPriceService.getPrices([
            SOL_MINT.toBase58(),
            LPPP_MINT.toBase58(),
            BONK_MINT.toBase58()
        ]);

        prices.sol = jupPrices.get(SOL_MINT.toBase58()) || 0;
        prices.lppp = jupPrices.get(LPPP_MINT.toBase58()) || 0;
        prices.bonk = jupPrices.get(BONK_MINT.toBase58()) || 0;

        // 2. Fallbacks
        if (!prices.sol) {
            try {
                const solRes = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
                const solData = await solRes.json();
                if (solData?.solana?.usd) prices.sol = solData.solana.usd;
            } catch (e) { console.error("SOL Price CG Fallback failed"); }
        }

        if (!prices.lppp) {
            try {
                const dexRes = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + LPPP_MINT.toBase58());
                const dexData = await dexRes.json();
                if (dexData?.pairs?.[0]?.priceUsd) prices.lppp = parseFloat(dexData.pairs[0].priceUsd);
            } catch (e) { console.error("LPPP Price DexScreener Fallback failed"); }
        }

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
    const portfolio = await botManager.getPortfolio(); // Use correct method
    res.json(portfolio);
});

// Alias for client compatibility (Issue 44)
app.get("/api/wallet", async (req, res) => {
    const portfolio = await botManager.getPortfolio();
    res.json(portfolio);
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
// Handler removed per audit cleanup.

// Catch-all to serve React's index.html
app.use((req, res) => {
    res.sendFile(path.join(clientPath, "index.html"));
});

const PORT = Number(process.env.PORT) || 3000;

httpServer.listen(PORT, () => {
    console.log(`LPPP BOT Unified Server running on port ${PORT}`);
    console.log(`LPPP BOT Version: v1.5.7 (Ultra-Throttled Recovery + ROI Fix)`);
    console.log(`[CONFIG] API_SECRET Status: ${API_SECRET ? "CONFIGURED (Locked)" : "UNSET (Public Access Mode)"}`);
    console.log(`[CONFIG] RPC_URL: ${process.env.RPC_URL ? "OK" : "MISSING"}`);
});
