
import express from "express";
import { createServer } from "http";
import { SocketManager } from "./socket";
import cors from "cors";
import path from "path";
import { BotManager } from "./bot-manager";

const app = express();
app.use(cors());
app.use(express.json());

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
    await botManager.start(req.body);
    res.json({ success: true, running: true });
});

app.post("/api/stop", (req, res) => {
    botManager.stop();
    res.json({ success: true, running: false });
});

// Proxy for Real-Time Price (Server-side fetch avoids CORS/Rate limits)
app.get("/api/price", async (req, res) => {
    const prices = { sol: 0, lppp: 0 };

    try {
        // 1. Fetch SOL Price (CoinGecko)
        try {
            const solRes = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
            const solData = await solRes.json();
            if (solData?.solana?.usd) prices.sol = solData.solana.usd;
        } catch (e) {
            console.error("SOL Price fetch failed (CoinGecko):", e);
        }

        // Fallback: Fetch SOL Price (Jupiter V2 - Real Data)
        if (!prices.sol) {
            try {
                const jupRes = await fetch("https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112");
                const jupData = await jupRes.json();
                if (jupData?.data?.['So11111111111111111111111111111111111111112']?.price) {
                    prices.sol = parseFloat(jupData.data['So11111111111111111111111111111111111111112'].price);
                }
            } catch (e) {
                console.error("SOL Price fetch failed (Jupiter):", e);
            }
        }

        // 2. Fetch LPPP Price (DexScreener)
        try {
            const lpppRes = await fetch("https://api.dexscreener.com/latest/dex/tokens/44sHXMkPeciUpqhecfCysVs7RcaxeM24VPMauQouBREV");
            const lpppData = await lpppRes.json();
            if (lpppData?.pairs?.[0]?.priceUsd) {
                prices.lppp = parseFloat(lpppData.pairs[0].priceUsd);
            }
        } catch (e) {
            console.error("LPPP Price fetch failed:", e);
        }

        return res.json(prices);
    } catch (error) {
        console.error("Price Proxy Critical Error:", error);
        res.status(500).json({ error: "Failed to fetch prices" });
    }
});

// Portfolio Endpoint (SOL/LPPP Balances)
app.get("/api/portfolio", async (req, res) => {
    const portfolio = await botManager.getWalletBalance();
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
    const { privateKey } = req.body;
    if (!privateKey) return res.status(400).json({ error: "Missing privateKey" });
    const result = await botManager.updateWallet(privateKey);
    res.json(result);
});

// Helius Webhook Endpoint for Real-Time Discovery
app.post("/api/webhooks/helius", async (req, res) => {
    try {
        const events = req.body;
        if (!Array.isArray(events)) {
            return res.status(400).json({ error: "Invalid webhook payload" });
        }

        for (const event of events) {
            // Helius "Enhanced" events parsing
            // Check for Meteora CP-AMM Program ID: CAMMCzo5YL8w4VFF8KVHrM5qHsc86KAt5wUGrEnf9V
            const isMeteora = event.instructions?.some((i: any) => i.programId === "CAMMCzo5YL8w4VFF8KVHrM5qHsc86KAt5wUGrEnf9V");

            if (isMeteora) {
                // Try to find a mint address in the account array
                // Usually the first few accounts in a "Pool Created" instruction
                const mint = event.accountData?.[0]?.account; // This is a heuristic, needs actual testing with real payload
                if (mint) {
                    SocketManager.emitLog(`[WEBHOOK] Real-time Meteora Discovery: ${mint}`, "success");
                    botManager.evaluateDiscovery(mint, "Meteora Webhook");
                }
            }
        }
        res.status(200).send("OK");
    } catch (error) {
        console.error("Webhook Error:", error);
        res.status(500).json({ error: "Webhook processing failed" });
    }
});

// Catch-all to serve React's index.html
app.use((req, res) => {
    res.sendFile(path.join(clientPath, "index.html"));
});

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
    console.log(`LPPP BOT Unified Server running on port ${PORT}`);
    console.log(`LPPP BOT Version: v1.4.0 (Jupiter Only + Jito)`);
});
