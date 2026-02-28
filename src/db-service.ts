import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import { PoolData, TradeHistory, BotSettings } from "./types";

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
                isBotCreated INTEGER NOT NULL DEFAULT 0,
                entryUsdValue REAL,
                fee_total_lppp TEXT,
                totalSupply REAL,
                initialMcap REAL,
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

            CREATE TABLE IF NOT EXISTS global_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                buyAmount REAL NOT NULL DEFAULT 0.1,
                lpppAmount REAL NOT NULL DEFAULT 0,
                meteoraFeeBps INTEGER NOT NULL DEFAULT 200,
                maxPools INTEGER NOT NULL DEFAULT 5,
                slippage REAL NOT NULL DEFAULT 10,
                minVolume5m REAL NOT NULL DEFAULT 2000,
                maxVolume5m REAL NOT NULL DEFAULT 0,
                minVolume1h REAL NOT NULL DEFAULT 25000,
                maxVolume1h REAL NOT NULL DEFAULT 0,
                minVolume24h REAL NOT NULL DEFAULT 100000,
                maxVolume24h REAL NOT NULL DEFAULT 0,
                minLiquidity REAL NOT NULL DEFAULT 10000,
                maxLiquidity REAL NOT NULL DEFAULT 0,
                minMcap REAL NOT NULL DEFAULT 100000,
                maxMcap REAL NOT NULL DEFAULT 0,
                mode TEXT NOT NULL DEFAULT 'SCOUT',
                maxAgeMinutes INTEGER NOT NULL DEFAULT 0,
                baseToken TEXT NOT NULL DEFAULT 'LPPP',
                stopLossPct REAL NOT NULL DEFAULT -2,
                enableReputation INTEGER NOT NULL DEFAULT 1,
                enableBundle INTEGER NOT NULL DEFAULT 1,
                enableInvestment INTEGER NOT NULL DEFAULT 1,
                enableSimulation INTEGER NOT NULL DEFAULT 0,
                enableStopLoss INTEGER NOT NULL DEFAULT 1,
                minDevTxCount INTEGER NOT NULL DEFAULT 50
            );

            -- Initial settings if not exists
            INSERT OR IGNORE INTO global_settings (id) VALUES (1);
        `);

        // Migration helpers: Safely add columns if missing
        try {
            this.db.exec("ALTER TABLE pools ADD COLUMN isBotCreated INTEGER NOT NULL DEFAULT 0");
            console.log("[DB] Migrated: Added isBotCreated column to pools table.");
        } catch (e) { }

        try {
            this.db.exec("ALTER TABLE pools ADD COLUMN fee_total_lppp TEXT");
            console.log("[DB] Migrated: Added fee_total_lppp column to pools table.");
        } catch (e) { }

        try {
            this.db.exec("ALTER TABLE pools ADD COLUMN pos_base_lp TEXT");
            this.db.exec("ALTER TABLE pools ADD COLUMN pos_token_lp TEXT");
            this.db.exec("ALTER TABLE pools ADD COLUMN pos_total_lppp TEXT");
            console.log("[DB] Migrated: Added positionValue columns to pools table.");
        } catch (e) { }

        try {
            this.db.exec("ALTER TABLE pools ADD COLUMN baseToken TEXT DEFAULT 'LPPP'");
            console.log("[DB] Migrated: Added baseToken column to pools table.");
        } catch (e) { }

        try {
            this.db.exec("ALTER TABLE pools ADD COLUMN totalSupply REAL");
            this.db.exec("ALTER TABLE pools ADD COLUMN initialMcap REAL");
            console.log("[DB] Migrated: Added totalSupply and initialMcap columns to pools table.");
        } catch (e) { }

        try {
            this.db.exec("ALTER TABLE global_settings ADD COLUMN enableStopLoss INTEGER NOT NULL DEFAULT 1");
            console.log("[DB] Migrated: Added enableStopLoss column to global_settings table.");
        } catch (e) { }

        // Advanced Safety migrations
        try {
            this.db.exec("ALTER TABLE global_settings ADD COLUMN enableAuthorityCheck INTEGER NOT NULL DEFAULT 1");
            this.db.exec("ALTER TABLE global_settings ADD COLUMN enableHolderAnalysis INTEGER NOT NULL DEFAULT 1");
            this.db.exec("ALTER TABLE global_settings ADD COLUMN enableScoring INTEGER NOT NULL DEFAULT 0");
            this.db.exec("ALTER TABLE global_settings ADD COLUMN maxTop5HolderPct REAL NOT NULL DEFAULT 50");
            this.db.exec("ALTER TABLE global_settings ADD COLUMN minSafetyScore REAL NOT NULL DEFAULT 0.3");
            this.db.exec("ALTER TABLE global_settings ADD COLUMN minTokenScore REAL NOT NULL DEFAULT 60");
            console.log("[DB] Migrated: Added advanced safety columns to global_settings table.");
        } catch (e) { }
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
                fee_sol, fee_token, fee_total_lppp, withdrawalPending, priceReconstructed,
                netRoi, initialSolValue, isBotCreated, entryUsdValue,
                pos_base_lp, pos_token_lp, pos_total_lppp, baseToken,
                totalSupply, initialMcap
            ) VALUES (
                @poolId, @token, @mint, @roi, @created, @initialPrice,
                @initialTokenAmount, @initialLpppAmount, @exited,
                @tp1Done, @takeProfitDone, @stopLossDone, @positionId,
                @fee_sol, @fee_token, @fee_total_lppp, @withdrawalPending, @priceReconstructed,
                @netRoi, @initialSolValue, @isBotCreated, @entryUsdValue,
                @pos_base_lp, @pos_token_lp, @pos_total_lppp, @baseToken,
                @totalSupply, @initialMcap
            ) ON CONFLICT(poolId) DO UPDATE SET
                roi = excluded.roi,
                exited = excluded.exited,
                tp1Done = excluded.tp1Done,
                takeProfitDone = excluded.takeProfitDone,
                stopLossDone = excluded.stopLossDone,
                positionId = excluded.positionId,
                fee_sol = excluded.fee_sol,
                fee_token = excluded.fee_token,
                fee_total_lppp = excluded.fee_total_lppp,
                withdrawalPending = excluded.withdrawalPending,
                priceReconstructed = excluded.priceReconstructed,
                netRoi = excluded.netRoi,
                initialSolValue = excluded.initialSolValue,
                isBotCreated = excluded.isBotCreated,
                entryUsdValue = excluded.entryUsdValue,
                pos_base_lp = excluded.pos_base_lp,
                pos_token_lp = excluded.pos_token_lp,
                pos_total_lppp = excluded.pos_total_lppp,
                baseToken = excluded.baseToken,
                totalSupply = excluded.totalSupply,
                initialMcap = excluded.initialMcap,
                updated_at = CURRENT_TIMESTAMP
        `);

        // Use retry wrapper for the main insert
        this.runWithRetry(stmt, {
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
            fee_total_lppp: pool.unclaimedFees?.totalLppp || "0",
            withdrawalPending: pool.withdrawalPending ? 1 : 0,
            priceReconstructed: pool.priceReconstructed ? 1 : 0,
            netRoi: pool.netRoi || "0%",
            initialSolValue: pool.initialSolValue || 0,
            isBotCreated: pool.isBotCreated ? 1 : 0,
            entryUsdValue: pool.entryUsdValue || 0,
            pos_base_lp: pool.positionValue?.baseLp || "0",
            pos_token_lp: pool.positionValue?.tokenLp || "0",
            pos_total_lppp: pool.positionValue?.totalLppp || "0",
            baseToken: pool.baseToken || "LPPP",
            totalSupply: pool.totalSupply || 0,
            initialMcap: pool.initialMcap || 0
        });
    }

    // Helper to handle SQLITE_BUSY errors during high concurrency
    private runWithRetry(stmt: Database.Statement, params: any, maxRetries = 5, delayMs = 100) {
        let retries = 0;
        while (true) {
            try {
                return stmt.run(params);
            } catch (err: any) {
                if (err.code === 'SQLITE_BUSY' && retries < maxRetries) {
                    retries++;
                    // Basic sleep function for busy loops
                    const start = Date.now();
                    while (Date.now() - start < delayMs * retries) { /* wait */ }
                    continue;
                }
                throw err;
            }
        }
    }

    // Secure numerical update for partial withdrawals
    async updatePoolEntryValue(poolId: string, newSolValue: number): Promise<void> {
        const stmt = this.db.prepare(`UPDATE pools SET initialSolValue = @newSolValue, updated_at = CURRENT_TIMESTAMP WHERE poolId = @poolId`);
        this.runWithRetry(stmt, { poolId, newSolValue });
    }

    // Auto-calibration update for corrupted legacy databases storing SOL quantities instead of LPPP quantities
    async updatePoolLegacyCalibration(poolId: string, newSolValue: number, newInitialPrice: number): Promise<void> {
        const stmt = this.db.prepare(`UPDATE pools SET initialSolValue = @newSolValue, initialPrice = @newInitialPrice, updated_at = CURRENT_TIMESTAMP WHERE poolId = @poolId`);
        this.runWithRetry(stmt, { poolId, newSolValue, newInitialPrice });
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

    // --- Settings Methods ---

    async getSettings(): Promise<BotSettings | null> {
        const row = this.db.prepare("SELECT * FROM global_settings WHERE id = 1").get() as any;
        if (!row) return null;

        return {
            buyAmount: row.buyAmount,
            lpppAmount: row.lpppAmount,
            meteoraFeeBps: row.meteoraFeeBps,
            maxPools: row.maxPools,
            slippage: row.slippage,
            volume5m: { min: row.minVolume5m, max: row.maxVolume5m },
            volume1h: { min: row.minVolume1h, max: row.maxVolume1h },
            volume24h: { min: row.minVolume24h, max: row.maxVolume24h },
            liquidity: { min: row.minLiquidity, max: row.maxLiquidity },
            mcap: { min: row.minMcap, max: row.maxMcap },
            mode: row.mode,
            maxAgeMinutes: row.maxAgeMinutes,
            baseToken: row.baseToken,
            stopLossPct: row.stopLossPct,
            enableReputation: !!row.enableReputation,
            enableBundle: !!row.enableBundle,
            enableInvestment: !!row.enableInvestment,
            enableSimulation: !!row.enableSimulation,
            enableStopLoss: !!row.enableStopLoss,
            minDevTxCount: row.minDevTxCount,
            enableAuthorityCheck: row.enableAuthorityCheck !== undefined ? !!row.enableAuthorityCheck : true,
            enableHolderAnalysis: row.enableHolderAnalysis !== undefined ? !!row.enableHolderAnalysis : true,
            enableScoring: row.enableScoring !== undefined ? !!row.enableScoring : false,
            maxTop5HolderPct: row.maxTop5HolderPct ?? 50,
            minSafetyScore: row.minSafetyScore ?? 0.3,
            minTokenScore: row.minTokenScore ?? 60
        };
    }

    async saveSettings(settings: BotSettings): Promise<void> {
        const stmt = this.db.prepare(`
            UPDATE global_settings SET
                buyAmount = @buyAmount,
                lpppAmount = @lpppAmount,
                meteoraFeeBps = @meteoraFeeBps,
                maxPools = @maxPools,
                slippage = @slippage,
                minVolume5m = @minVolume5m,
                maxVolume5m = @maxVolume5m,
                minVolume1h = @minVolume1h,
                maxVolume1h = @maxVolume1h,
                minVolume24h = @minVolume24h,
                maxVolume24h = @maxVolume24h,
                minLiquidity = @minLiquidity,
                maxLiquidity = @maxLiquidity,
                minMcap = @minMcap,
                maxMcap = @maxMcap,
                mode = @mode,
                maxAgeMinutes = @maxAgeMinutes,
                baseToken = @baseToken,
                stopLossPct = @stopLossPct,
                enableReputation = @enableReputation,
                enableBundle = @enableBundle,
                enableInvestment = @enableInvestment,
                enableSimulation = @enableSimulation,
                enableStopLoss = @enableStopLoss,
                minDevTxCount = @minDevTxCount,
                enableAuthorityCheck = @enableAuthorityCheck,
                enableHolderAnalysis = @enableHolderAnalysis,
                enableScoring = @enableScoring,
                maxTop5HolderPct = @maxTop5HolderPct,
                minSafetyScore = @minSafetyScore,
                minTokenScore = @minTokenScore
            WHERE id = 1
        `);

        stmt.run({
            buyAmount: settings.buyAmount,
            lpppAmount: settings.lpppAmount,
            meteoraFeeBps: settings.meteoraFeeBps,
            maxPools: settings.maxPools,
            slippage: settings.slippage,
            minVolume5m: settings.volume5m.min,
            maxVolume5m: settings.volume5m.max,
            minVolume1h: settings.volume1h.min,
            maxVolume1h: settings.volume1h.max,
            minVolume24h: settings.volume24h.min,
            maxVolume24h: settings.volume24h.max,
            minLiquidity: settings.liquidity.min,
            maxLiquidity: settings.liquidity.max,
            minMcap: settings.mcap.min,
            maxMcap: settings.mcap.max,
            mode: settings.mode,
            maxAgeMinutes: settings.maxAgeMinutes,
            baseToken: settings.baseToken,
            stopLossPct: settings.stopLossPct,
            enableReputation: settings.enableReputation ? 1 : 0,
            enableBundle: settings.enableBundle ? 1 : 0,
            enableInvestment: settings.enableInvestment ? 1 : 0,
            enableSimulation: settings.enableSimulation ? 1 : 0,
            enableStopLoss: settings.enableStopLoss ? 1 : 0,
            minDevTxCount: settings.minDevTxCount,
            enableAuthorityCheck: settings.enableAuthorityCheck ? 1 : 0,
            enableHolderAnalysis: settings.enableHolderAnalysis ? 1 : 0,
            enableScoring: settings.enableScoring ? 1 : 0,
            maxTop5HolderPct: settings.maxTop5HolderPct,
            minSafetyScore: settings.minSafetyScore,
            minTokenScore: settings.minTokenScore
        });
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
                token: row.fee_token || "0",
                totalLppp: row.fee_total_lppp || "0"
            },
            positionValue: {
                baseLp: row.pos_base_lp || "0",
                tokenLp: row.pos_token_lp || "0",
                totalLppp: row.pos_total_lppp || "0"
            },
            withdrawalPending: !!row.withdrawalPending,
            priceReconstructed: !!row.priceReconstructed,
            netRoi: row.netRoi,
            initialSolValue: row.initialSolValue,
            isBotCreated: !!row.isBotCreated,
            entryUsdValue: row.entryUsdValue,
            baseToken: row.baseToken || "LPPP",
            totalSupply: row.totalSupply,
            initialMcap: row.initialMcap
        };
    }

    close() {
        this.db.close();
    }
}

export const dbService = new DatabaseService();
