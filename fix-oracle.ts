// Try to grab ORACLE's creation data from the typescript db wrapper
import { dbService } from './src/db-service';
async function run() {
    const rawDb = (dbService as any).db;
    const stmt = rawDb.prepare("SELECT * FROM pools WHERE token = 'MOGA' OR token = 'HTP' OR token = 'ORACLE' OR token = 'neet' OR token = 'GOATSE'");
    const results = stmt.all();
    console.log(results);
}
run();
