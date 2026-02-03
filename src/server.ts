
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
            console.error("SOL Price fetch failed:", e);
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

// Portfolio Endpoint
app.get("/api/portfolio", async (req, res) => {
    const portfolio = await botManager.getPortfolio();
    res.json(portfolio);
});

// Catch-all to serve React's index.html
app.use((req, res) => {
    res.sendFile(path.join(clientPath, "index.html"));
});

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
    console.log(`ZEBAR Unified Server running on port ${PORT}`);
});
