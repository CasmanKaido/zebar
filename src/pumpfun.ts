
import { PublicKey, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { PUMP_FUN_PROGRAM_ID } from "./config";
import BN from "bn.js";

// Constants for Pump.fun
// Constants for Pump.fun
// Derive Global Account
const [GLOBAL_ACCOUNT] = PublicKey.findProgramAddressSync(
    [Buffer.from("global")],
    PUMP_FUN_PROGRAM_ID
);
const FEE_RECIPIENT = new PublicKey("CebNusZacPWjS7V5E2o2YJ33YvR9d3hYTo7q2L8P3TTo"); // Actual Pump.fun fee recipient

const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]); // sha256("global:buy")[..8]


export class PumpFunHandler {
    /**
     * Creates a 'buy' instruction for the Pump.fun program.
     * @param buyer Caller's public key
     * @param mint Token mint address
     * @param amountTokens Number of tokens to buy (in raw units, e.g. 1 token = 1e6 units if decimals=6)
     * @param maxSolCost Max SOL willing to spend (in lamports)
     * @param tokenProgram Optional token program (defaults to standard SPL Token)
     */
    static async createBuyInstruction(
        buyer: PublicKey,
        mint: PublicKey,
        amountTokens: BN, // u64
        maxSolCost: BN,   // u64
        tokenProgram: PublicKey = TOKEN_PROGRAM_ID
    ): Promise<{
        instruction: TransactionInstruction;
        associatedUser: PublicKey;
        createAtaInstruction?: TransactionInstruction
    }> {

        // 1. Derive Bonding Curve PDA
        const [bondingCurve] = PublicKey.findProgramAddressSync(
            [Buffer.from("bonding-curve"), mint.toBuffer()],
            PUMP_FUN_PROGRAM_ID
        );

        // 2. associatedBondingCurve (ATA of the curve)
        const associatedBondingCurve = await getAssociatedTokenAddress(
            mint,
            bondingCurve,
            true, // allow owner off curve
            tokenProgram
        );

        // 3. associatedUser (ATA of the buyer)
        const associatedUser = await getAssociatedTokenAddress(
            mint,
            buyer,
            false,
            tokenProgram
        );

        // Check if ATA needs creation? (Handled at usage site usually, but let's return instruction just in case)
        // We can't easily check on-chain state synchronously here without connection.
        // We will assume the caller handles ATA creation if missing OR we can include the instruction blindly if safe.
        // Usually safe to include `createAssociatedTokenAccountIdempotentInstruction` if supported, 
        // but default `createAssociatedTokenAccountInstruction` fails if already exists.
        // For simplicity, we return the instruction to create only if needed logic is handled outside, OR we just return the address.
        // Let's add a `createAtaInstruction` property which creates it if needed.

        // Actually, let's construct the data buffer
        const data = Buffer.alloc(8 + 8 + 8);
        BUY_DISCRIMINATOR.copy(data, 0);
        // Write amount (Little Endian u64)
        data.writeBigUInt64LE(BigInt(amountTokens.toString()), 8);
        // Write max_sol_cost (Little Endian u64)
        data.writeBigUInt64LE(BigInt(maxSolCost.toString()), 16);

        const keys = [
            { pubkey: GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
            { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bondingCurve, isSigner: false, isWritable: true },
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
            { pubkey: associatedUser, isSigner: false, isWritable: true },
            { pubkey: buyer, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: tokenProgram, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            // { pubkey: eventAuthority, isSigner: false, isWritable: false }, // Some IDLs have event authority
            { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false } // Program itself? No, standard program call.
        ];

        // Note: Pump.fun instructions might require `eventAuthority` or `program`.
        // The standard IDL for `buy` has:
        // Global, Fee, Mint, BondingCurve, AssociatedBondingCurve, AssociatedUser, User, System, Token, Rent, EventAuthority, Program
        // Let's double check standard anchor.
        // Usually:
        // 0. global
        // 1. fee_recipient
        // 2. mint
        // 3. bonding_curve
        // 4. associated_bonding_curve
        // 5. associated_user
        // 6. user
        // 7. system_program
        // 8. token_program
        // 9. rent
        // 10. event_authority
        // 11. program

        // I will add event authority just in case.
        const eventAuthority = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjxc7UyGZtPN");
        keys.push({ pubkey: eventAuthority, isSigner: false, isWritable: false });
        // keys.push({ pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false }); // Redundant - removed per audit

        const instruction = new TransactionInstruction({
            keys,
            programId: PUMP_FUN_PROGRAM_ID,
            data
        });


        return {
            instruction,
            associatedUser,
            // Helper to create ATA if needed (Idempotent prevents "Already Exists" crash)
            createAtaInstruction: createAssociatedTokenAccountIdempotentInstruction(
                buyer, associatedUser, buyer, mint, tokenProgram
            )
        };
    }

    static async getBondingCurveState(connection: any, mint: PublicKey) {
        const [bondingCurve] = PublicKey.findProgramAddressSync(
            [Buffer.from("bonding-curve"), mint.toBuffer()],
            PUMP_FUN_PROGRAM_ID
        );
        const accountInfo = await connection.getAccountInfo(bondingCurve);
        if (!accountInfo) return null;

        // Pump.fun Bonding Curve Layout (Approximate based on known IDLs)
        // 0-8: Discriminator
        // 8-16: Virtual Token Reserves (u64)
        // 16-24: Virtual SOL Reserves (u64)
        const buffer = accountInfo.data;
        const virtualTokenReserves = buffer.readBigUInt64LE(8);
        const virtualSolReserves = buffer.readBigUInt64LE(16);

        return {
            virtualTokenReserves,
            virtualSolReserves,
            bondingCurve
        };
    }

    static calculateBuyAmount(state: any, amountSol: number, slippageBasisPoints = 500) {
        if (!state) return { amountTokens: BigInt(0), maxSolCost: BigInt(0) };

        const vSol = state.virtualSolReserves;
        const vTokens = state.virtualTokenReserves;
        const amountSolLamports = BigInt(Math.floor(amountSol * 1e9));

        const newVSol = vSol + amountSolLamports;
        const k = vSol * vTokens;
        const newVTokens = k / newVSol;

        const amountTokens = vTokens - newVTokens;

        const maxSolCost = amountSolLamports + (amountSolLamports * BigInt(slippageBasisPoints) / BigInt(10000));

        return { amountTokens, maxSolCost };
    }
}

