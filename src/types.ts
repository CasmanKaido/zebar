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
    pendingSell?: string;    // Flag: withdrawal done but sell failed — value is the action (TP1/TP2/STOP LOSS)
    positionId?: string; // Meteora Position PDA
    unclaimedFees?: { sol: string; token: string; totalLppp?: string };
    positionValue?: { baseLp: string; tokenLp: string; totalLppp: string };
    netRoi?: string;     // Inventory-based ROI (Real Profit)
    initialSolValue?: number; // Total SOL value at start
    withdrawalPending?: boolean; // Flag for atomicity (Issue 30)
    priceReconstructed?: boolean; // Flag: Entry price audit complete
    isBotCreated?: boolean;      // Flag: Created by this bot (vs recovered from chain)
    entryUsdValue?: number;      // USD value at the time of entry (for TP/SL)
    baseToken?: string;          // The base token symbol (e.g., 'LPPP', 'USDC')
    totalSupply?: number;        // Total supply of the token
    initialMcap?: number;        // Market Cap at the time of entry
    currentMcap?: number;        // Real-time market cap value for UI passing
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
