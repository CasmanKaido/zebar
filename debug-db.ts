
import { dbService } from "./src/db-service";

async function debug() {
    try {
        const pools = await dbService.getAllPools();
        console.log("--- DB PEEK ---");
        console.log(`Pools Count: ${pools.length}`);
        pools.forEach(p => {
            console.log(`Pool: ${p.token} | ID: ${p.poolId.slice(0, 8)} | ROI: ${p.roi} | NetROI: ${p.netRoi} | Exited: ${p.exited}`);
        });
        console.log("---------------");
        process.exit(0);
    } catch (e) {
        console.error("Debug failed", e);
        process.exit(1);
    }
}

debug();
