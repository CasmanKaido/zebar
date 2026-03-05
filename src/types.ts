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
    isPrebond?: boolean;         // true if created from prebond sniping (Pump.fun bonding curve)
}

export interface BotSettings {
    buyAmount: number; // in SOL
    lpppAmount: number; // in units (fallback only)
    meteoraFeeBps: number; // in Basis Points (e.g. 200 = 2%)
    maxPools: number; // Max pools to create before auto-stop
    slippage: number; // in % (e.g. 10)
    liquiditySlippage: number; // in Basis Points (e.g. 100 = 1%)
    volume5m: { min: number; max: number };
    volume1h: { min: number; max: number };
    volume24h: { min: number; max: number };
    liquidity: { min: number; max: number };
    mcap: { min: number; max: number };
    mode: "SCOUT" | "ANALYST" | "PREBOND" | "ALL";
    maxAgeMinutes: number;
    baseToken: string;
    // Take Profit / Stop Loss
    tp1Multiplier: number;             // MCAP multiplier to trigger TP1 (e.g. 7 = 7x)
    tp1WithdrawPct: number;            // % of liquidity to withdraw at TP1
    tp2Multiplier: number;             // MCAP multiplier to trigger TP2 (e.g. 14 = 14x)
    tp2WithdrawPct: number;            // % of liquidity to withdraw at TP2
    stopLossPct: number;
    enableStopLoss: boolean;
    enableReputation: boolean;
    enableBundle: boolean;
    enableInvestment: boolean;
    enableSimulation: boolean;
    minDevTxCount: number;
    // Advanced Safety
    enableAuthorityCheck: boolean;    // Reject tokens with mint/freeze authority enabled
    enableHolderAnalysis: boolean;    // Check top 5 holder concentration
    enableScoring: boolean;           // Token confidence scoring system
    maxTop5HolderPct: number;         // Max combined % for top 5 holders
    minSafetyScore: number;           // Min RugCheck score 0-1 to pass
    minTokenScore: number;            // Min confidence score 0-100 to buy
    // Prebond Sniping
    enablePrebond: boolean;           // Master toggle for prebond sniping
    // Prebond Safety (independent from main forensic settings)
    prebondEnableReputation: boolean;  // Check creator wallet tx history
    prebondEnableBundle: boolean;      // Detect slot-0 bundled launches
    prebondEnableSimulation: boolean;  // Jupiter sell simulation (honeypot check)
    prebondEnableAuthority: boolean;   // Reject tokens with mint/freeze authority
    prebondMinDevTxCount: number;      // Min creator wallet transactions
    // Prebond Discovery Filters (Jupiter Token API V2)
    prebondMinMcap: number;            // Min market cap on bonding curve (0 = disabled)
    prebondMaxMcap: number;            // Max market cap on bonding curve (0 = no max)
    prebondMinHolders: number;         // Min holder count (0 = disabled)
    prebondMinOrganicScore: number;    // Min Jupiter organic score 0-100 (0 = disabled)
    prebondMaxTopHolderPct: number;    // Max top holder % (0 = no max)
    prebondMaxAgeMinutes: number;      // Max token age in minutes (0 = no max)
    prebondMinVolume5m: number;        // Min 5-minute volume in USD (0 = disabled)
    prebondMaxVolume5m: number;        // Max 5-minute volume in USD (0 = no max)
    prebondMinVolume1h: number;        // Min 1-hour volume in USD (0 = disabled)
    prebondMaxVolume1h: number;        // Max 1-hour volume in USD (0 = no max)
    prebondMinVolume24h: number;       // Min 24-hour volume in USD (0 = disabled)
    prebondMaxVolume24h: number;       // Max 24-hour volume in USD (0 = no max)
    enableFullSilentFee: boolean;     // true = trades + pool creation, false = pool creation only
    breakEvenMinutes: number;         // Minutes to wait before auto-exiting at break-even (0 = disabled)
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
