import { dbService } from './src/db-service';
async function run() {
    // try to fetch from history maybe?
    const pools = await dbService.getAllPools(); // this only gets active
    console.log("Active pools:", pools.length);
}
run();
