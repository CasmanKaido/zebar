export interface PoolData {
    poolId: string;
    token: string; // Symbol
    mint: string; // Token Mint Address
    roi: string;
    created: string;
    initialPrice: number;
    initialTokenAmount: number;
    initialLpppAmount: number;
    exited: boolean;
    tp1Done?: boolean;       // Flag: TP Stage 1 (3x) completed
    takeProfitDone?: boolean; // Flag: TP Stage 2 (6x) completed
    stopLossDone?: boolean;  // Flag: Stop Loss (-30%) completed
    positionId?: string; // Meteora Position PDA
    unclaimedFees?: { sol: string; token: string };
    netRoi?: string;     // Inventory-based ROI (Real Profit)
    initialSolValue?: number; // Total SOL value at start
    withdrawalPending?: boolean; // Flag for atomicity (Issue 30)
    priceReconstructed?: boolean; // Flag: Entry price audit complete
    isBotCreated?: boolean;      // Flag: Created by this bot (vs recovered from chain)
}

export interface TradeHistory {
    id?: number;
    poolId: string;
    action: string; // 'BUY', 'SELL', 'TP1', 'TP2', 'STOP_LOSS'
    amountSol: number;
    amountToken: number;
    txSignature: string;
    timestamp?: string;
}
