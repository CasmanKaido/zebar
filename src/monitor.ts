
import { Connection, PublicKey } from "@solana/web3.js";
import { PUMP_FUN_PROGRAM_ID } from "./config";

export interface NewTokenEvent {
    signature: string;
    mint: PublicKey;
    bondingCurve: PublicKey;
    user: PublicKey;
    timestamp: number;
}

export class PumpFunMonitor {
    private connection: Connection;
    private isRunning: boolean = false;
    private isProcessing: boolean = false;
    private callback: (event: NewTokenEvent) => Promise<void> | void;

    constructor(connection: Connection, callback: (event: NewTokenEvent) => Promise<void> | void) {
        this.connection = connection;
        this.callback = callback;
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log("Starting Pump.fun Monitor (Throttle Mode)...");

        this.connection.onLogs(
            PUMP_FUN_PROGRAM_ID,
            async (logs, ctx) => {
                if (!this.isRunning) return;
                if (logs.err) return;

                // 1. Strict Lock: If already busy with a token, ignore this one to save RPC credits
                if (this.isProcessing) return;

                // 2. Check for Create (Standard log for Pump.fun creation)
                const isCreate = logs.logs.some(log => log.includes("Instruction: Create"));

                if (isCreate) {
                    this.isProcessing = true;
                    console.log("Potential NEW TOKEN detected:", logs.signature);

                    try {
                        // Wait a moment for indexing
                        await new Promise(r => setTimeout(r, 2000));

                        const tx = await this.connection.getParsedTransaction(logs.signature, {
                            maxSupportedTransactionVersion: 0,
                            commitment: "confirmed"
                        });

                        if (!tx || !tx.meta) {
                            this.isProcessing = false;
                            return;
                        }

                        // Extract Mint Address
                        const feePayer = tx.transaction.message.accountKeys[0].pubkey;
                        const signers = tx.transaction.message.accountKeys.filter(k => k.signer);

                        // Heuristic: The Mint is a signer that is NOT the fee payer
                        const mintSigner = signers.find(s => s.pubkey.toBase58() !== feePayer.toBase58());

                        if (mintSigner) {
                            const event: NewTokenEvent = {
                                signature: logs.signature,
                                mint: mintSigner.pubkey,
                                bondingCurve: PublicKey.default,
                                user: feePayer,
                                timestamp: Date.now()
                            };

                            // Execute Strategy
                            await this.callback(event);

                            // Cooldown after a successful ape to let pending transactions settle
                            console.log("Cooling down for 10s...");
                            await new Promise(r => setTimeout(r, 10000));
                        } else {
                            console.log("Could not identify mint signer in transaction.");
                        }

                    } catch (err: any) {
                        if (err.message && err.message.includes("429")) {
                            console.error("Rate Limited (429) - Skipping this token.");
                        } else {
                            console.error("Error processing transaction:", err.message);
                        }
                    } finally {
                        this.isProcessing = false;
                    }
                }
            },
            "confirmed"
        );
    }

    async stop() {
        this.isRunning = false;
        console.log("Stopping Monitor...");
    }
}
