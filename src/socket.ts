import { Server as SocketIOServer } from "socket.io";
import { Server as HttpServer } from "http";

export class SocketManager {
    public static io: SocketIOServer;

    private static logHistory: any[] = [];
    private static MAX_LOGS = 50;

    static init(httpServer: HttpServer) {
        this.io = new SocketIOServer(httpServer, {
            cors: {
                origin: "*",
                methods: ["GET", "POST"]
            }
        });

        this.io.on("connection", (socket) => {
            console.log("Frontend connected");
            // Send existing log history to the new client
            socket.emit("logHistory", this.logHistory);
        });
    }

    static emitLog(message: string, type: "info" | "success" | "error" | "warning" = "info") {
        const logEntry = { message, type, timestamp: new Date().toISOString() };

        // Add to history
        this.logHistory.push(logEntry);
        if (this.logHistory.length > this.MAX_LOGS) {
            this.logHistory.shift();
        }

        if (this.io) {
            this.io.emit("log", logEntry);
        }
    }

    static emitStatus(running: boolean) {
        if (this.io) {
            this.io.emit("status", { running });
        }
    }

    static emitPool(pool: any) {
        if (this.io) {
            this.io.emit("pool", pool);
        }
    }
}
