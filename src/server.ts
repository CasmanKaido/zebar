
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
    try {
        // Fetch from Jupiter (V2 or V1) or CoinGecko
        // Using CoinGecko Simple Price as Primary for reliability without API Key
        const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
        const data = await response.json();

        if (data && data.solana && data.solana.usd) {
            return res.json({ price: data.solana.usd });
        }

        throw new Error("Invalid price data");
    } catch (error) {
        console.error("Price Proxy Error:", error);
        // Fallback to a hardcoded logic or previous known price could go here, 
        // but user requested REAL data, so we return error if we can't get it.
        res.status(500).json({ error: "Failed to fetch price" });
    }
});

// Catch-all to serve React's index.html
app.use((req, res) => {
    res.sendFile(path.join(clientPath, "index.html"));
});

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
    console.log(`ZEBAR Unified Server running on port ${PORT}`);
});
