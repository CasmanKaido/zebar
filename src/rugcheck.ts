import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { SocketManager } from "./socket";
import { safeRpc } from "./rpc-utils";
import { IGNORED_MINTS } from "./config";

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

    // Other (Metaplex, Raydium, Tally, SOLOCKER, SolMint)
    "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
    "1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix",
    "A5vz72a5ipKUJZxmGUjGtS7uhWfzr6jhDgV2q73YhD8A", // Tally-Pay
    "DLxB9dSQtA4WJ49hWFhxqiQkD9v6m67Yfk9voxpxrBs4", // SOLOCKER
    "B46UV19XGvWf8xXbKThVqH7A7fD8J9T1mP", // Raydium Authority
]);

// DEX Program IDs to detect
const DEX_PROGRAMS = {
    RAYDIUM_V4: "675k1S2AYp7jkS6GMBv6mUeBBSyitjGatE2Gf2n4jGvP",
    METEORA_CP: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
    ORCA_WHIRLPOOL: "whir9iKR7ndbm3gUak6Z6uHXYsc2FcyGAFGcMjg7uVL",
    RAYDIUM_CLMM: "CAMMCzo5YL8w4VFF8KVHrpeWCsC2vG96itstCxsK7o",
};

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
    // (rpc method was here, now replaced by safeRpc import)
    /**
     * Performs on-chain safety checks for a token.
     * 1. Mint Authority — Can more tokens be minted?
     * 2. Freeze Authority — Can token accounts be frozen?
     * 3. Liquidity Lock — Are LP tokens locked/burned?
     */
    static async checkToken(
        connection: Connection,
        mintAddress: string,
        pairAddress?: string
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
            let mintInfo;
            try {
                mintInfo = await safeRpc(() => getMint(connection, mint, "confirmed", TOKEN_PROGRAM_ID), "getMint-v1");
            } catch (e1: any) {
                try {
                    mintInfo = await safeRpc(() => getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID), "getMint-v2");
                } catch (e2: any) {
                    // Neither standard nor Token-2022 program owns this mint
                    const errMsg = e2.message || String(e2);
                    if (errMsg.includes("TokenInvalidAccountOwner")) {
                        result.safe = false;
                        result.reason = "Unsupported token program (not SPL Token or Token-2022)";
                        SocketManager.emitLog(`[SAFETY] ⚠️ ${mintAddress.slice(0, 8)}... Unsupported token program`, "warning");
                        return result;
                    }
                    throw e2; // Re-throw other errors to outer catch
                }
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
            const errMsg = err.message || String(err);
            console.warn(`[SAFETY] Failed to fetch mint info: ${errMsg}`);
            result.safe = false;
            result.reason = `Could not verify mint info: ${errMsg}`;
            return result;
        }

        // ═══ 3. Liquidity Lock Check ═══
        try {
            // Priority: Check LP Mint if pairAddress is provided
            let lpLocked = false;
            if (pairAddress) {
                try {
                    lpLocked = await this.checkLpLock(connection, pairAddress);
                } catch (lpErr) {
                    console.warn(`[SAFETY] Dedicated LP lock check failed: ${lpErr}`);
                }
            }

            if (lpLocked) {
                result.checks.liquidityLocked = "locked";
                SocketManager.emitLog(`[SAFETY] ✅ LP Tokens verified LOCKED/BURNED`, "success");
            }

            // Always perform following checks: Bundle Check, Concentration Check, and Token-level Lock heuristic (if not already locked)

            // Fallback: Check largest accounts of the token itself (Heuristic)
            let largestAccounts;
            try {
                largestAccounts = await safeRpc(
                    () => connection.getTokenLargestAccounts(mint),
                    "largestAccounts",
                    3 // Less retries for large accounts to avoid hanging
                );
            } catch (accErr: any) {
                console.warn(`[SAFETY] Too many accounts or RPC limit for ${mintAddress}: ${accErr.message}`);
                // If it fails, we can't do concentration checks, but if it's whitelisted we might still pass?
                // Deciding: If it fails, and NOT whitelisted, fail the safety check for caution.
                if (accErr.message.includes("Too many accounts requested")) {
                    result.safe = false;
                    result.reason = "RPC Limit: Too many accounts for holder analysis";
                    return result;
                }
                largestAccounts = { value: [] };
            }

            const topAccounts = largestAccounts.value.slice(0, 20);

            if (topAccounts.length > 0) {
                const accountInfos = await safeRpc(
                    () => connection.getMultipleAccountsInfo(topAccounts.map(a => a.address)),
                    "accountInfos"
                );

                let lockedAmount = 0;
                let totalSupplyChecked = 0;
                let devConcentration = 0;

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

                    if (info?.owner) {
                        const ownerStr = info.owner.toBase58();
                        if (KNOWN_LOCKERS.has(ownerStr) || account.address.toBase58() === BURN_ADDRESS) {
                            lockedAmount += amount;
                        } else {
                            devConcentration += amount;
                        }
                    }
                    totalSupplyChecked += amount;
                }

                // ═══ 4. BUNDLE CHECK (Reactivated) ═══
                // High probability of "Wash Trading" or "Dump Bundles" if multiple top accounts have identical balances.
                if (maxDuplicates >= 3) {
                    result.safe = false;
                    result.reason = `Bundled Wallets Detected (${maxDuplicates} accounts with identical balances)`;
                    SocketManager.emitLog(`[SAFETY] ❌ ${mintAddress.slice(0, 8)}... BUNDLED WALLETS DETECTED`, "error");
                    return result;
                }

                const mintInfo = await safeRpc(() => getMint(connection, mint), "getMint-Supply");
                const totalSupply = Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals);
                const divisor = totalSupply > 0 ? totalSupply : totalSupplyChecked;
                const concentrationRatio = devConcentration / divisor;

                if (concentrationRatio > 0.8 && devConcentration > 0) {
                    result.safe = false;
                    result.reason = `Extreme supply concentration detected (${(concentrationRatio * 100).toFixed(1)}% of total supply)`;
                    SocketManager.emitLog(`[SAFETY] ❌ ${mintAddress.slice(0, 8)}... High holder concentration!`, "error");
                    return result;
                }

                if (lockedAmount > 0) {
                    result.checks.liquidityLocked = "locked";
                    // If we found locked supply at the token level, we consider it a 'soft' lock pass
                    if (!lpLocked) SocketManager.emitLog(`[SAFETY] ✅ Supply appears locked/burned (token level check)`, "success");
                } else if (!lpLocked) {
                    result.checks.liquidityLocked = "unlocked";
                    result.safe = false;
                    result.reason = "Unverified Liquidity: No locked LP tokens or burned supply detected";
                    SocketManager.emitLog(`[SAFETY] ❌ ${mintAddress.slice(0, 8)}... LIQUIDITY UNLOCKED`, "error");
                    return result;
                }
            }
        } catch (err: any) {
            const errMsg = err.message || String(err);
            console.warn(`[SAFETY] Safety scan failed: ${errMsg}`);
            result.safe = false;
            result.reason = `Safety check failed: ${errMsg}`;
            result.checks.liquidityLocked = "unknown";
            return result;
        }

        return result;
    }

    /**
     * Checks if the LP tokens for a given pool are locked or burned.
     */
    private static async checkLpLock(connection: Connection, pairAddress: string): Promise<boolean> {
        const pairPubkey = new PublicKey(pairAddress);
        const info = await safeRpc(() => connection.getAccountInfo(pairPubkey), "getPairInfo");
        if (!info) return false;

        const owner = info.owner.toBase58();
        let lpMint: string | null = null;

        // Raydium V4
        if (owner === DEX_PROGRAMS.RAYDIUM_V4) {
            // lpMint is at offset 328 in Raydium V4 AMM layout
            lpMint = new PublicKey(info.data.slice(328, 328 + 32)).toBase58();
        }
        // Meteora CP-AMM
        else if (owner === DEX_PROGRAMS.METEORA_CP) {
            // lpMint is at offset 168 in Meteora CP-AMM PoolState
            lpMint = new PublicKey(info.data.slice(168, 168 + 32)).toBase58();
        }
        // Raydium CLMM or Orca (LP is an NFT, check the owner directly for locked status)
        else if (owner === DEX_PROGRAMS.RAYDIUM_CLMM || owner === DEX_PROGRAMS.ORCA_WHIRLPOOL) {
            SocketManager.emitLog(`[SAFETY] Detected ${owner === DEX_PROGRAMS.ORCA_WHIRLPOOL ? 'Orca' : 'CLMM'} Pool. Checking NFT-based lock status...`, "info");
            // For these, we don't have a simple 'lpMint' to check holders.
            // But we can check if the largest position accounts are owned by trackers.
            // Placeholder: Returning true for now if owner is recognized, but ideally we'd scan positions.
            // For now, let's treat it as "unknown" to be safe.
            return false;
        }

        if (!lpMint || lpMint === "11111111111111111111111111111111") return false;

        // Check holders of the LP Mint
        const largestLpAccounts = await safeRpc(
            () => connection.getTokenLargestAccounts(new PublicKey(lpMint!)),
            "largestLpAccounts"
        );
        const topLpAccounts = largestLpAccounts.value.slice(0, 5);
        const lpAccountInfos = await safeRpc(
            () => connection.getMultipleAccountsInfo(topLpAccounts.map((a: any) => a.address)),
            "lpAccounts"
        );

        let lockedLpAmount = 0;
        let totalLpChecked = 0;

        for (let i = 0; i < topLpAccounts.length; i++) {
            const acc = topLpAccounts[i];
            const meta = lpAccountInfos[i];
            const amount = Number(acc.uiAmount || 0);
            totalLpChecked += amount;

            if (meta?.owner) {
                const ownerStr = meta.owner.toBase58();
                if (KNOWN_LOCKERS.has(ownerStr) || acc.address.toBase58() === BURN_ADDRESS || ownerStr === BURN_ADDRESS) {
                    lockedLpAmount += amount;
                }
            }
        }

        // Consider locked if >95% is in lockers or burned
        return (lockedLpAmount / totalLpChecked) > 0.95;
    }
}
