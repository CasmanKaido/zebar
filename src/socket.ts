import { Server as SocketIOServer } from "socket.io";
import { Server as HttpServer } from "http";

export class SocketManager {
    public static io: SocketIOServer;

    static init(httpServer: HttpServer) {
        this.io = new SocketIOServer(httpServer, {
            cors: {
                origin: "*", // Allow all for local dev
                methods: ["GET", "POST"]
            }
        });

        this.io.on("connection", (socket) => {
            console.log("Frontend connected");
            // Status will be handled by the specific manager in server.ts
        });
    }

    static emitLog(message: string, type: "info" | "success" | "error" | "warning" = "info") {
        if (this.io) {
            this.io.emit("log", { message, type, timestamp: new Date().toISOString() });
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
