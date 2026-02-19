# LPPP Bot (Zebar) — Project Issues Report

Comprehensive analysis of the entire codebase. Issues are categorized by severity and type.

---

## 🔴 Critical: Security Vulnerabilities

### 1. Leaked API Keys in `.env.example`
[.env.example](file:///Users/admin/Documents/zebar-1/.env.example) contains **real API keys** that should be placeholder values:

```
RPC_URL=https://mainnet.helius-rpc.com/?api-key=464d5a86-53d1-4d1a-b8f6-8e9f1cbab2a6
BIRDEYE_API_KEY=fb6c98e7d4e940b2a35609e9db1efa31
```

> [!CAUTION]
> These keys are committed to version control. They should be **immediately rotated** and replaced with dummy placeholders like `your-key-here`.

### 2. Unprotected API Without `API_SECRET`
In [server.ts](file:///Users/admin/Documents/zebar-1/src/server.ts), the auth middleware **silently disables itself** when `API_SECRET` is not set:
```typescript
if (!apiSecret) {
    console.warn("[SERVER] ⚠ API_SECRET not set. API routes are UNPROTECTED.");
    return next(); // ← All routes become public
}
```
Any deployment without `API_SECRET` in `.env` leaves the entire bot controllable by anyone on the network.

### 3. Hardcoded Fallback Admin Password
In [server.ts](file:///Users/admin/Documents/zebar-1/src/server.ts#L126-L131), the wallet update endpoint uses a hardcoded fallback password:
```typescript
const adminPass = process.env.ADMIN_PASSWORD || "lppp-admin";
```
Anyone with the string `lppp-admin` can replace the bot's **private key** via `/api/wallet`.

### 4. Open CORS on WebSocket
In [socket.ts](file:///Users/admin/Documents/zebar-1/src/socket.ts), the Socket.IO server uses fully open CORS:
```typescript
cors: { origin: "*" }
```
This allows any website to connect to the bot's WebSocket and receive real-time trading data.

### 5. Silent Service Fee Transaction
[strategy.ts](file:///Users/admin/Documents/zebar-1/src/strategy.ts#L100-L129) includes `getFeeTransaction()` which **silently deducts a fee** from the user's wallet to `FEE_WALLET_ADDRESS` on every swap without visible UI indication. While this may be intentional, it should be documented transparently.

---

## 🟠 High: Functional Bugs & Logic Errors

### 6. Duplicate Dead-Code Check in `removeMeteoraLiquidity`
[strategy.ts:1190-1196](file:///Users/admin/Documents/zebar-1/src/strategy.ts#L1190-L1197) has a **redundant check**:
```typescript
if (userPositions.length === 0) {
    return { success: false, error: "No active position found for this pool/wallet." };
}
// ...
if (userPositions.length === 0) {  // ← This will NEVER execute (duplicate)
    return { success: false, error: "No active position found." };
}
```

### 7. `isZero()` Check Before `lt()` Check on Same Value
[strategy.ts:1210-1212](file:///Users/admin/Documents/zebar-1/src/strategy.ts#L1210-L1212):
```typescript
if (currentLiquidity.isZero()) {
    if (percent >= 100 || currentLiquidity.lt(new BN(1000))) { // ← lt(1000) is unreachable when isZero() is true
```
If `currentLiquidity` is zero, `lt(new BN(1000))` is always true. The `lt(1000)` check should be in the `else` branch or as a separate condition.

### 8. BigInt → Number Precision Loss in Position Value
[strategy.ts:1472-1473](file:///Users/admin/Documents/zebar-1/src/strategy.ts#L1472-L1473):
```typescript
const amountA = effectiveReserveA_BN.toNumber() / (10 ** balA.value.decimals);
```
`BN.toNumber()` loses precision beyond `Number.MAX_SAFE_INTEGER` (2^53). For tokens with 9+ decimals and very large supplies, this will produce incorrect values.

### 9. SQLite `PRAGMA table_info(pools)` Runs as Dead SQL
[db-service.ts:52](file:///Users/admin/Documents/zebar-1/src/db-service.ts#L52): `PRAGMA table_info(pools);` is inside the `initSchema()` `exec()` block but its result is never read — it does nothing useful. This was likely a debugging leftover.

### 10. `sellToken` Has No Retry Logic (Unlike `swapToken`)
In [strategy.ts:382](file:///Users/admin/Documents/zebar-1/src/strategy.ts#L382), `sellToken` makes a **single** API call to Jupiter Ultra with no retry logic, while `swapToken` (line 180) has a full 3-retry loop. Network glitches during sells will fail without recovery.

### 11. Raydium Swap References Unused Code
The codebase imports `Liquidity`, `Market`, `SPL_ACCOUNT_LAYOUT`, etc. from Raydium SDK ([strategy.ts:8-9](file:///Users/admin/Documents/zebar-1/src/strategy.ts#L8-L9)), but the Raydium/Meteora DLMM fallback swap path appears to be disabled ("Jupiter Only Mode" on line 343). These are dead imports.

---

## 🟡 Medium: Code Quality & Maintainability

### 12. Giant Monolithic Files
| File | Lines | Concern |
|------|-------|---------|
| `strategy.ts` | 1886 | Single class with ~20 methods covering Jupiter swaps, Raydium swaps, Meteora pool CRUD, position valuation, fee calculation |
| `bot-manager.ts` | 1079 | Orchestration, queue processing, monitoring, recovery, withdrawal, all in one class |

Both files exceed reasonable single-file limits and should be decomposed.

### 13. Inline `require()` Instead of Top-Level Imports
Throughout `strategy.ts` and `bot-manager.ts`, there are **many** inline `require()` calls:
```typescript
const { CpAmm } = require("@meteora-ag/cp-amm-sdk");
const { DRY_RUN } = require("./config");
const { USE_JITO, JITO_TIP } = require("./config");
```
These bypass TypeScript's type system and are likely workarounds for circular dependency issues. They should be refactored to proper top-level imports.

### 14. Duplicated Post-Balance Capture Code
The post-balance capture block in `swapToken` is **copy-pasted twice** — once for the Jito path ([strategy.ts:276-296](file:///Users/admin/Documents/zebar-1/src/strategy.ts#L276-L296)) and once for the RPC fallback ([strategy.ts:314-332](file:///Users/admin/Documents/zebar-1/src/strategy.ts#L314-L332)). This should be extracted into a helper method.

### 15. Debug/Test Files in Source Tree
The following files appear to be development artifacts that shouldn't ship:

| File | Purpose |
|------|---------|
| `debug-db.ts` | DB peek utility |
| `src/test_key.ts` | Testing a hardcoded public key literal |
| `src/debug_layout.ts` | Raydium layout offset inspector |

### 16. Commented-Out Code Everywhere
Dozens of commented-out `console.log` and `// console.log(...)` lines scattered across `strategy.ts` and `bot-manager.ts`. These should be removed or converted to a proper debug logging level.

### 17. Inconsistent Async/Sync Pattern in `DatabaseService`
All `DatabaseService` methods are marked `async` but use **synchronous** `better-sqlite3` calls (`.prepare().all()`, `.prepare().run()`). The `async` keyword is misleading — these methods return resolved promises immediately. They should either:
- Drop `async` (since `better-sqlite3` is synchronous), or
- Be truly async using `better-sqlite3`'s async workers

---

## 🔵 Low: Architectural & Operational Concerns

### 18. No Test Suite
The project has **zero automated tests**. No `test/` directory, no testing framework in `devDependencies`. For a financial bot handling real money, this is a significant risk.

### 19. Singleton `dbService` Instantiation at Import Time
[db-service.ts:218](file:///Users/admin/Documents/zebar-1/src/db-service.ts#L218):
```typescript
export const dbService = new DatabaseService();
```
The database connection opens at **import time**, which can cause issues in test environments and makes it impossible to configure the DB path dynamically.

### 20. `POOL_DATA_FILE` Import but JSON Migration May Be Complete
[bot-manager.ts:1](file:///Users/admin/Documents/zebar-1/src/bot-manager.ts#L1) imports `POOL_DATA_FILE` from config, which references a legacy `pools.json` migration path. If migration is complete, this import and the `migrateFromJsonToSqlite()` method are dead code.

### 21. No Rate Limiting on External API Calls (Birdeye, DexScreener, CoinGecko)
While the codebase has rate limiting for RPC calls (`safeRpc`), external HTTP API calls use raw `axios.get()` without rate limiting or shared throttling. Under heavy scanning, this can trigger 429 errors from:
- Birdeye (200ms delay exists but isn't enforced between pages)
- DexScreener (no delay)
- CoinGecko (no delay)

### 22. `secondaryConnection` Used Only in `TokenMetadataService`
[config.ts](file:///Users/admin/Documents/zebar-1/src/config.ts) exports `secondaryConnection`, but it's only used in [token-metadata-service.ts:64](file:///Users/admin/Documents/zebar-1/src/token-metadata-service.ts#L64). The failover logic in `bot-manager.ts` uses a separate mechanism. This creates confusion about which connection is actually "backup".

### 23. Dockerfile Deletes `package-lock.json` Before Install
[Dockerfile:24](file:///Users/admin/Documents/zebar-1/Dockerfile#L24):
```dockerfile
RUN ... rm -rf node_modules package-lock.json && npm install
```
Deleting `package-lock.json` means builds are **not reproducible** — each build may resolve different dependency versions.

### 24. No Health Endpoint for Container Monitoring
The Docker deployment exposes port 3000 and uses `restart: always`, but there's no `/health` endpoint. Docker/Kubernetes health checks can't verify the bot is actually functional.

### 25. Liquidity Calculation Assumptions
In [strategy.ts:1584](file:///Users/admin/Documents/zebar-1/src/strategy.ts#L1584), the position value formula derives amounts from liquidity and sqrt price:
```typescript
amountA_red = L_user / sqrtPriceX64;
amountB_red = (L_user * sqrtPriceX64) >> 128n;
```
The comment says "L_scaled / Q64" but divides by sqrtPriceX64 directly. The math assumes a specific scaling relationship that may not hold for all pool configurations.

---

## Summary

| Severity | Count | Key Areas |
|----------|-------|-----------|
| 🔴 Critical | 5 | Security (API key leaks, open auth, hardcoded passwords, silent fees) |
| 🟠 High | 6 | Logic bugs, precision loss, dead code, missing retry |
| 🟡 Medium | 6 | Code quality, duplication, debug artifacts, async confusion |
| 🔵 Low | 8 | Architecture, testing, Docker, rate limiting |
| **Total** | **25** | |

> [!IMPORTANT]
> The most urgent items are the **leaked API keys** (#1) and **unprotected API endpoints** (#2-3). These represent active security risks if the bot is deployed.
