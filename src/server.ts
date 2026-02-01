
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

// app.use(express.static(path.join(__dirname, "../client/dist")));

const httpServer = createServer(app);

// Initialize Socket
SocketManager.init(httpServer);

// Bot Controller
const botManager = new BotManager();

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

const PORT = 3001;

httpServer.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
