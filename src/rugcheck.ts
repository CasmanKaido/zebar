import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { SocketManager } from "./socket";

/**
 * On-chain token safety checker.
 * Replaces the external RugCheck API with direct Solana RPC calls.
 * Checks: Mint Authority, Freeze Authority, and Liquidity Lock status.
 */

// Known LP locker program IDs on Solana
const KNOWN_LOCKERS = new Set([
    // UNCX Network (V4, Smart, CP, CLMM)
    "GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo",
    "BzKincxjgFQjj4FmhaWrwHES1ekBGN73YesA7JwJJo7X",
    "UNCX77nZrA3TdAxMEggqG18xxpgiNGT6iqyynPwpoxN",
    "DAtFFs2mhQFvrgNLA29vEDeTLLN8vHknAaAhdLEc4SQH",
    "UNCXdvMRxvz91g3HqFmpZ5NgmL77UH4QRM4NfeL4mQB",
    "FEmGEWdxCBSJ1QFKeX5B6k7VTDPwNU3ZLdfgJkvGYrH5",
    "UNCXrB8cZXnmtYM1aSo1Wx3pQaeSZYuF2jCTesXvECs",
    "GAYWATob4bqCj3fhVm8ZxoMSqUW2fb6e6SBQ7kk5qyps",

    // Team Finance / Fluxbeam
    "Lock7kBijGCQLEFAmXcengzXKA88iDNQPriQ7TbgJFj",

    // Streamflow
    "FLockVVhmdNhRDHH48LoGadGSxPSABYh5hE8UGRjpVGT",
    "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m",

    // PinkSale
    "FASGwdWxPjZ655g67idpSwiavigorgB9L7p6Y4qG6Pc5",

    // Other (Metaplex, Raydium, Tally, SOLOCKER)
    "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
    "1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix",
    "A5vz72a5ipKUJZxmGUjGtS7uhWfzr6jhDgV2q73YhD8A", // Tally-Pay
    "DLxB9dSQtA4WJ49hWFhxqiQkD9v6m67Yfk9voxpxrBs4", // SOLOCKER
]);

// Burn address (tokens sent here = permanently locked)
const BURN_ADDRESS = "1111111111111111111111111111111111111111111";

export interface SafetyResult {
    safe: boolean;
    reason: string;
    checks: {
        mintAuthority: "disabled" | "enabled" | "unknown";
        freezeAuthority: "disabled" | "enabled" | "unknown";
        liquidityLocked: "locked" | "unlocked" | "unknown";
    };
}

export class OnChainSafetyChecker {
    /**
     * Performs on-chain safety checks for a token.
     * 1. Mint Authority — Can more tokens be minted?
     * 2. Freeze Authority — Can token accounts be frozen?
     * 3. Liquidity Lock — Are LP tokens locked/burned?
     */
    static async checkToken(
        connection: Connection,
        mintAddress: string
    ): Promise<SafetyResult> {
        const mint = new PublicKey(mintAddress);
        const result: SafetyResult = {
            safe: true,
            reason: "All checks passed",
            checks: {
                mintAuthority: "unknown",
                freezeAuthority: "unknown",
                liquidityLocked: "unknown",
            },
        };

        // ═══ 1. Mint Authority Check ═══
        try {
            // Try standard SPL Token first, then Token-2022
            let mintInfo;
            try {
                mintInfo = await getMint(connection, mint, "confirmed", TOKEN_PROGRAM_ID);
            } catch {
                mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
            }

            if (mintInfo.mintAuthority !== null) {
                result.safe = false;
                result.reason = "Mint Authority is ENABLED — dev can print unlimited tokens";
                result.checks.mintAuthority = "enabled";
                SocketManager.emitLog(`[SAFETY] ❌ ${mintAddress.slice(0, 8)}... Mint Authority ENABLED`, "error");
                return result;
            }
            result.checks.mintAuthority = "disabled";
            SocketManager.emitLog(`[SAFETY] ✅ Mint Authority disabled`, "success");

            // ═══ 2. Freeze Authority Check ═══
            if (mintInfo.freezeAuthority !== null) {
                result.safe = false;
                result.reason = "Freeze Authority is ENABLED — dev can freeze your tokens";
                result.checks.freezeAuthority = "enabled";
                SocketManager.emitLog(`[SAFETY] ❌ ${mintAddress.slice(0, 8)}... Freeze Authority ENABLED`, "error");
                return result;
            }
            result.checks.freezeAuthority = "disabled";
            SocketManager.emitLog(`[SAFETY] ✅ Freeze Authority disabled`, "success");
        } catch (err: any) {
            console.warn(`[SAFETY] Failed to fetch mint info: ${err.message}`);
            result.safe = false;
            result.reason = "Could not verify mint info (defaulting to unsafe)";
            return result;
        }

        // ═══ 3. Liquidity Lock Check ═══
        // Strategy: Find the largest token accounts for this mint.
        // If the top holders are known locker programs or burn addresses,
        // we consider liquidity locked.
        try {
            const largestAccounts = await connection.getTokenLargestAccounts(mint);
            const topAccounts = largestAccounts.value.slice(0, 20); // Check top 20 holders for bundling

            if (topAccounts.length === 0) {
                result.checks.liquidityLocked = "unknown";
                SocketManager.emitLog(`[SAFETY] ⚠️ No token accounts found for LP lock check`, "warning");
            } else {
                // Get owner info for the top accounts
                const accountInfos = await connection.getMultipleAccountsInfo(
                    topAccounts.map(a => a.address)
                );

                let lockedAmount = 0;
                let totalSupplyChecked = 0;
                let devConcentration = 0;

                // Heuristic: Bundle Detection (Identical Balances)
                const balanceCounts = new Map<number, number>();
                let maxDuplicates = 0;

                for (let i = 0; i < topAccounts.length; i++) {
                    const account = topAccounts[i];
                    const info = accountInfos[i];
                    const amount = Number(account.uiAmount || 0);

                    if (amount > 0) {
                        const count = (balanceCounts.get(amount) || 0) + 1;
                        balanceCounts.set(amount, count);
                        maxDuplicates = Math.max(maxDuplicates, count);
                    }

                    // Only count concentration for non-lockers
                    if (info?.owner) {
                        const ownerStr = info.owner.toBase58();
                        // Check if the owner is a known locker or the token is burned
                        if (KNOWN_LOCKERS.has(ownerStr) || account.address.toBase58() === BURN_ADDRESS) {
                            lockedAmount += amount;
                        } else {
                            // Non-locker account — track concentration
                            devConcentration += amount;
                        }
                    }
                    totalSupplyChecked += amount;
                }

                if (maxDuplicates >= 3) {
                    result.safe = false;
                    result.reason = `Bundle Detected! ${maxDuplicates} wallets have identical balances.`;
                    SocketManager.emitLog(`[SAFETY] ❌ ${mintAddress.slice(0, 8)}... Bundle Detected (${maxDuplicates} identical wallets)`, "error");
                    return result;
                }

                // Strategy: Get actual total supply (Issue 35)
                const mintInfo = await getMint(connection, mint);
                const totalSupply = Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals);

                // If supply is extremely low or 0, avoid division by zero
                const divisor = totalSupply > 0 ? totalSupply : totalSupplyChecked;
                const concentrationRatio = devConcentration / divisor;

                if (concentrationRatio > 0.8 && devConcentration > 0) {
                    result.safe = false;
                    result.reason = `Extreme supply concentration detected (${(concentrationRatio * 100).toFixed(1)}% of total supply)`;
                    SocketManager.emitLog(`[SAFETY] ❌ ${mintAddress.slice(0, 8)}... High holder concentration!`, "error");
                    return result;
                }

                // We consider it "locked" if we can't determine (most tokens don't lock LP this way)
                if (lockedAmount > 0) {
                    result.checks.liquidityLocked = "locked";
                    SocketManager.emitLog(`[SAFETY] ✅ Liquidity appears locked/burned`, "success");
                } else {
                    result.checks.liquidityLocked = "unlocked";
                    // Log warning but don't block — many legitimate tokens don't use lockers
                    SocketManager.emitLog(`[SAFETY] ⚠️ No locked LP detected (not blocking)`, "warning");
                }
            }
        } catch (err: any) {
            console.warn(`[SAFETY] LP lock check failed: ${err.message}`);
            result.checks.liquidityLocked = "unknown";
            // Don't fail the entire check for LP lock issues
        }

        return result;
    }
}
