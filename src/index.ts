
import { BotManager } from "./bot-manager";

async function main() {
    console.log("ZEBAR CLI Runner Initializing...");

    const botManager = new BotManager();

    // Start with default settings
    // This allows running the scanner without the express server if needed
    botManager.start();

    // Handle process signals for graceful shutdown
    process.on('SIGINT', () => {
        console.log("\nShutting down ZEBAR...");
        botManager.stop();
        process.exit(0);
    });
}

main().catch(console.error);
