import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import { PoolData, TradeHistory } from "./types";

const DB_PATH = path.join(process.cwd(), "data", "zebar.db");

export class DatabaseService {
    private db: Database.Database;

    constructor() {
        // Ensure data directory exists
        const dataDir = path.dirname(DB_PATH);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        this.db = new Database(DB_PATH);
        this.db.pragma("journal_mode = WAL");
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS pools (
                poolId TEXT PRIMARY KEY,
                token TEXT NOT NULL,
                mint TEXT NOT NULL,
                roi TEXT NOT NULL,
                created TEXT NOT NULL,
                initialPrice REAL NOT NULL,
                initialTokenAmount REAL NOT NULL,
                initialLpppAmount REAL NOT NULL,
                exited INTEGER NOT NULL DEFAULT 0,
                tp1Done INTEGER NOT NULL DEFAULT 0,
                takeProfitDone INTEGER NOT NULL DEFAULT 0,
                stopLossDone INTEGER NOT NULL DEFAULT 0,
                positionId TEXT,
                fee_sol TEXT,
                fee_token TEXT,
                withdrawalPending INTEGER NOT NULL DEFAULT 0,
                priceReconstructed INTEGER NOT NULL DEFAULT 0,
                netRoi TEXT,
                initialSolValue REAL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                poolId TEXT NOT NULL,
                action TEXT NOT NULL,
                amountSol REAL NOT NULL,
                amountToken REAL NOT NULL,
                txSignature TEXT NOT NULL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (poolId) REFERENCES pools (poolId)
            );
        `);
    }

    // --- Pools Methods ---

    async getAllPools(): Promise<PoolData[]> {
        const rows = this.db.prepare("SELECT * FROM pools").all() as any[];
        return rows.map(r => this.mapRowToPool(r));
    }

    async getPool(poolId: string): Promise<PoolData | null> {
        const row = this.db.prepare("SELECT * FROM pools WHERE poolId = ?").get(poolId) as any;
        return row ? this.mapRowToPool(row) : null;
    }

    async savePool(pool: PoolData): Promise<void> {
        const stmt = this.db.prepare(`
            INSERT INTO pools (
                poolId, token, mint, roi, created, initialPrice, 
                initialTokenAmount, initialLpppAmount, exited, 
                tp1Done, takeProfitDone, stopLossDone, positionId, 
                fee_sol, fee_token, withdrawalPending, priceReconstructed,
                netRoi, initialSolValue
            ) VALUES (
                @poolId, @token, @mint, @roi, @created, @initialPrice,
                @initialTokenAmount, @initialLpppAmount, @exited,
                @tp1Done, @takeProfitDone, @stopLossDone, @positionId,
                @fee_sol, @fee_token, @withdrawalPending, @priceReconstructed,
                @netRoi, @initialSolValue
            ) ON CONFLICT(poolId) DO UPDATE SET
                roi = excluded.roi,
                exited = excluded.exited,
                tp1Done = excluded.tp1Done,
                takeProfitDone = excluded.takeProfitDone,
                stopLossDone = excluded.stopLossDone,
                positionId = excluded.positionId,
                fee_sol = excluded.fee_sol,
                fee_token = excluded.fee_token,
                withdrawalPending = excluded.withdrawalPending,
                priceReconstructed = excluded.priceReconstructed,
                netRoi = excluded.netRoi,
                initialSolValue = excluded.initialSolValue,
                updated_at = CURRENT_TIMESTAMP
        `);

        stmt.run({
            poolId: pool.poolId,
            token: pool.token,
            mint: pool.mint,
            roi: pool.roi || "0%",
            created: pool.created,
            initialPrice: pool.initialPrice,
            initialTokenAmount: pool.initialTokenAmount,
            initialLpppAmount: pool.initialLpppAmount,
            exited: pool.exited ? 1 : 0,
            tp1Done: pool.tp1Done ? 1 : 0,
            takeProfitDone: pool.takeProfitDone ? 1 : 0,
            stopLossDone: pool.stopLossDone ? 1 : 0,
            positionId: pool.positionId || null,
            fee_sol: pool.unclaimedFees?.sol || "0",
            fee_token: pool.unclaimedFees?.token || "0",
            withdrawalPending: pool.withdrawalPending ? 1 : 0,
            priceReconstructed: pool.priceReconstructed ? 1 : 0,
            netRoi: pool.netRoi || "0%",
            initialSolValue: pool.initialSolValue || 0
        });
    }

    // --- Trades Methods ---

    async recordTrade(trade: TradeHistory): Promise<void> {
        const stmt = this.db.prepare(`
            INSERT INTO trades (poolId, action, amountSol, amountToken, txSignature)
            VALUES (@poolId, @action, @amountSol, @amountToken, @txSignature)
        `);
        stmt.run(trade);
    }

    async getTradeHistory(poolId?: string): Promise<TradeHistory[]> {
        let rows;
        if (poolId) {
            rows = this.db.prepare("SELECT * FROM trades WHERE poolId = ? ORDER BY timestamp DESC").all(poolId) as any[];
        } else {
            rows = this.db.prepare("SELECT * FROM trades ORDER BY timestamp DESC").all() as any[];
        }
        return rows.map(r => ({
            id: r.id,
            poolId: r.poolId,
            action: r.action,
            amountSol: r.amountSol,
            amountToken: r.amountToken,
            txSignature: r.txSignature,
            timestamp: r.timestamp
        }));
    }

    // --- Helpers ---

    private mapRowToPool(row: any): PoolData {
        return {
            poolId: row.poolId,
            token: row.token,
            mint: row.mint,
            roi: row.roi,
            created: row.created,
            initialPrice: row.initialPrice,
            initialTokenAmount: row.initialTokenAmount,
            initialLpppAmount: row.initialLpppAmount,
            exited: !!row.exited,
            tp1Done: !!row.tp1Done,
            takeProfitDone: !!row.takeProfitDone,
            stopLossDone: !!row.stopLossDone,
            positionId: row.positionId,
            unclaimedFees: {
                sol: row.fee_sol || "0",
                token: row.fee_token || "0"
            },
            withdrawalPending: !!row.withdrawalPending,
            priceReconstructed: !!row.priceReconstructed,
            netRoi: row.netRoi,
            initialSolValue: row.initialSolValue
        };
    }

    close() {
        this.db.close();
    }
}

export const dbService = new DatabaseService();
