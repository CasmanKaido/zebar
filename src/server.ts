
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

app.post("/api/start", (req, res) => {
    botManager.start(req.body);
    res.json({ success: true, running: true });
});

app.post("/api/stop", (req, res) => {
    botManager.stop();
    res.json({ success: true, running: false });
});

// Catch-all to serve React's index.html
app.use((req, res) => {
    res.sendFile(path.join(clientPath, "index.html"));
});

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
    console.log(`ZEBAR Unified Server running on port ${PORT}`);
});
