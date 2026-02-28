
import { useEffect, useState, useRef } from 'react';
import axios from 'axios';
import io from 'socket.io-client';
import {
    Terminal,
    Activity,
    Zap,
    ShieldAlert,
    Power,
    Settings2,
    Droplets,
    BarChart3,
    LineChart,
    Search,
    Wallet,
    ExternalLink,
    RefreshCw
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Modal } from './Modal';
// Use environment variable or default to empty string for unified same-host deployment
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || '';
const socket = io(BACKEND_URL);

interface Log {
    message: string;
    type: 'info' | 'success' | 'error' | 'warning';
    timestamp: string;
}

interface Pool {
    poolId: string;
    mint?: string;
    token: string;
    roi: string;
    netRoi?: string;     // Inventory-based ROI
    created: string;
    unclaimedFees?: { sol: string; token: string; totalLppp?: string };
    positionValue?: { baseLp: string; tokenLp: string; totalLppp: string };
    exited?: boolean;
    isBotCreated?: boolean;
    baseToken?: string;
    totalSupply?: number;
    initialMcap?: number;
    currentMcap?: number;
    tp1Done?: boolean;
    takeProfitDone?: boolean;
    stopLossDone?: boolean;
}

interface PoolUpdate {
    poolId: string;
    roi?: string;
    netRoi?: string;
    unclaimedFees?: { sol: string; token: string; totalLppp?: string };
    positionValue?: { baseLp: string; tokenLp: string; totalLppp: string };
    exited?: boolean;
    currentMcap?: number;
    initialMcap?: number;
    tp1Done?: boolean;
    takeProfitDone?: boolean;
    stopLossDone?: boolean;
}

interface SettingInputProps {
    label: string;
    value: number;
    onChange: (val: number) => void;
    disabled?: boolean;
    prefix?: string;
    unit?: string;
    subtext?: string;
}

const SettingInput = ({ label, value, onChange, disabled, prefix, unit, subtext }: SettingInputProps) => {
    const [displayValue, setDisplayValue] = useState<string>(value.toString());

    // Sync display value when external prop changes (e.g. unit toggle or reset)
    useEffect(() => {
        if (value !== Number(displayValue)) {
            setDisplayValue(value.toString());
        }
    }, [value]);

    return (
        <div className="flex flex-col gap-1.5 last:mb-0">
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider truncate">{label}</label>
            <div className="relative">
                {prefix && (
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-[10px]">{prefix}</span>
                )}
                <input
                    type="text"
                    inputMode="decimal"
                    value={displayValue}
                    onChange={(e) => {
                        const val = e.target.value;
                        // Allow only numbers and decimals
                        if (val === "" || /^[0-9]*\.?[0-9]*$/.test(val)) {
                            setDisplayValue(val);
                            if (val !== "" && val !== ".") {
                                onChange(Number(val));
                            }
                        }
                    }}
                    onBlur={() => {
                        // Reset to 0 if empty on blur
                        if (displayValue === "" || displayValue === ".") {
                            setDisplayValue("0");
                            onChange(0);
                        }
                    }}
                    onWheel={(e) => (e.target as HTMLInputElement).blur()}
                    onKeyDown={(e) => {
                        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.preventDefault();
                    }}
                    disabled={disabled}
                    className={`w-full bg-input border border-border text-foreground px-2.5 py-1.5 rounded-xl font-mono text-[12px] focus:outline-none focus:border-primary/50 transition-colors ${prefix ? 'pl-6' : ''} ${unit ? 'pr-9' : ''}`}
                />
                {unit && (
                    <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[9px] font-bold text-primary/60">{unit}</span>
                )}
            </div>
            {subtext && (
                <span className="text-[9px] text-muted-foreground/60 italic truncate">{subtext}</span>
            )}
        </div>
    );
};

const Toggle = ({ label, enabled, onChange, disabled }: { label: string; enabled: boolean; onChange: (val: boolean) => void; disabled?: boolean }) => (
    <div className="flex items-center justify-between py-2 mb-1 last:mb-0">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{label}</span>
        <button
            onClick={() => !disabled && onChange(!enabled)}
            disabled={disabled}
            className={`w-9 h-5 rounded-full transition-all relative ${enabled ? 'bg-primary shadow-[0_0_10px_rgba(205,255,0,0.3)]' : 'bg-zinc-800 border border-white/5'} ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
        >
            <motion.div
                animate={{ x: enabled ? 18 : 2 }}
                initial={false}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
                className={`absolute top-1 w-3 h-3 rounded-full ${enabled ? 'bg-black' : 'bg-zinc-500'}`}
            />
        </button>
    </div>
);

const PoolCard = ({ pool, isBot, claimFees, increaseLiquidity, withdrawLiquidity, refreshPool, basePrice }: {
    pool: Pool;
    isBot: boolean;
    claimFees: (id: string) => void;
    increaseLiquidity: (id: string) => void;
    withdrawLiquidity: (id: string, percent: number) => void;
    refreshPool: (id: string) => void;
    basePrice: number | null;
}) => {
    const isProfit = pool.initialMcap && pool.currentMcap ? (pool.currentMcap / pool.initialMcap) >= 1 : false;
    const multiplier = pool.initialMcap && pool.currentMcap ? (pool.currentMcap / pool.initialMcap).toFixed(2) : "0.00";
    const posValue = ((Number(pool.positionValue?.totalLppp || 0)) * (basePrice || 0)).toFixed(2);
    const feesValue = ((Number(pool.unclaimedFees?.totalLppp || 0)) * (basePrice || 0)).toFixed(3);

    return (
        <div key={pool.poolId} className={`relative glass-card p-5 group transition-all duration-300 overflow-hidden ${isBot ? 'hover:bg-card/60 shadow-[0_8px_30px_rgba(0,0,0,0.4)]' : 'opacity-90'}`}>

            {/* Action-Oriented Top Status Bar */}
            <div className={`absolute top-0 left-0 right-0 h-1.5 ${isProfit ? 'bg-primary shadow-[0_0_10px_rgba(205,255,0,0.5)]' : 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]'}`}></div>

            <div className="flex justify-between items-start mb-4 gap-2">
                <div className="flex flex-col gap-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap text-left">
                        <h3 className="text-2xl font-black tracking-widest text-white uppercase drop-shadow-md truncate max-w-[120px] sm:max-w-[160px]" title={pool.token}>
                            {pool.token}
                        </h3>
                        {isBot && (
                            <span className="px-1.5 py-0.5 bg-primary/20 text-primary text-[8px] rounded font-black flex items-center gap-1 shrink-0">
                                <Zap size={8} className="animate-pulse" /> LIVE
                            </span>
                        )}
                        {/* Milestone Tags Moved Inline */}
                        {pool.tp1Done && <span className="px-1.5 py-0.5 bg-zinc-900 border border-emerald-500/50 text-emerald-400 text-[8px] rounded font-bold shrink-0">TP1</span>}
                        {pool.takeProfitDone && <span className="px-1.5 py-0.5 bg-zinc-900 border border-emerald-500/50 text-emerald-400 text-[8px] rounded font-bold shrink-0">TP2</span>}
                        {pool.stopLossDone && <span className="px-1.5 py-0.5 bg-zinc-900 border border-red-500/50 text-red-500 text-[8px] rounded font-bold shrink-0">SL</span>}
                    </div>
                    <a
                        href={`https://solscan.io/account/${pool.poolId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-[10px] hover:underline flex items-center gap-1 transition-colors text-muted-foreground hover:text-white truncate"
                    >
                        {pool.poolId.slice(0, 16)}...
                        <ExternalLink size={8} className="shrink-0" />
                    </a>
                </div>

                {/* Minimal Header Actions - Circular */}
                <div className="flex gap-2 shrink-0">
                    <a
                        href={`https://gmgn.ai/sol/token/${pool.mint || pool.poolId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-8 h-8 rounded-full bg-green-500/10 hover:bg-green-500/20 border border-green-500/30 flex items-center justify-center transition-all shrink-0"
                        title="View on GMGN"
                    >
                        <ExternalLink size={14} className="text-green-400" />
                    </a>
                    <a
                        href={`https://dexscreener.com/solana/${pool.mint || pool.poolId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-8 h-8 rounded-full bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 flex items-center justify-center transition-all shrink-0"
                        title="View on DexScreener"
                    >
                        <BarChart3 size={14} className="text-blue-400" />
                    </a>
                    <button
                        onClick={() => refreshPool(pool.poolId)}
                        className="w-8 h-8 rounded-full bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 flex items-center justify-center transition-all shrink-0"
                        title="Refresh Data"
                    >
                        <RefreshCw size={14} className="text-blue-400" />
                    </button>
                    <button
                        onClick={() => increaseLiquidity(pool.poolId)}
                        className="w-8 h-8 rounded-full bg-border/40 hover:bg-white/10 flex items-center justify-center transition-colors border border-border shrink-0"
                        title="Add Liquidity"
                    >
                        <Droplets size={14} className="text-white opacity-80" />
                    </button>
                    <button
                        onClick={() => withdrawLiquidity(pool.poolId, 100)}
                        className="w-8 h-8 rounded-full bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 flex items-center justify-center transition-all group/close shadow-[0_0_15px_rgba(239,68,68,0.1)] hover:shadow-[0_0_20px_rgba(239,68,68,0.3)] shrink-0"
                        title="FULL CLOSE"
                    >
                        <Power size={14} className="text-red-500 group-hover/close:animate-pulse" />
                    </button>
                </div>
            </div>

            {/* ═══ ROI Central Focus Stage ═══ */}
            <div className="flex items-center justify-between bg-black/40 border border-border/30 rounded-2xl p-4 my-6 shadow-inner relative overflow-hidden">
                <div className={`absolute inset-0 opacity-10 ${isProfit ? 'bg-gradient-to-r from-transparent via-primary to-transparent' : 'bg-gradient-to-r from-transparent via-red-500 to-transparent'}`}></div>

                {/* Entry Point */}
                <div className="flex flex-col items-center flex-1 z-10 w-1/3">
                    <span className="text-[8px] font-bold text-muted-foreground uppercase tracking-widest mb-1 opacity-60">Entry Mcap</span>
                    <span className="text-[11px] sm:text-sm font-mono font-bold text-muted-foreground truncate w-full text-center">
                        ${pool.initialMcap ? (pool.initialMcap >= 1000000 ? (pool.initialMcap / 1000000).toFixed(2) + 'M' : (pool.initialMcap / 1000).toFixed(1) + 'K') : '---'}
                    </span>
                </div>

                {/* The Hero Multiplier */}
                <div className="flex flex-col items-center flex-[1.5] px-2 sm:px-4 border-x border-border/40 z-10">
                    <div className={`text-3xl sm:text-4xl font-black tracking-tighter ${isProfit ? 'text-primary drop-shadow-[0_0_15px_rgba(205,255,0,0.4)]' : 'text-red-500 drop-shadow-[0_0_15px_rgba(239,68,68,0.4)]'}`}>
                        {multiplier}x
                    </div>
                </div>

                {/* Current Point */}
                <div className="flex flex-col items-center flex-1 z-10 w-1/3">
                    <span className="text-[8px] font-bold text-muted-foreground uppercase tracking-widest mb-1 opacity-60">Live Mcap</span>
                    <span className={`text-[11px] sm:text-sm font-mono font-bold truncate w-full text-center ${isProfit ? 'text-white' : 'text-red-400'}`}>
                        ${pool.currentMcap ? (pool.currentMcap >= 1000000 ? (pool.currentMcap / 1000000).toFixed(2) + 'M' : (pool.currentMcap / 1000).toFixed(1) + 'K') : '---'}
                    </span>
                </div>
            </div>

            {/* ═══ Condensed Summary Row ═══ */}
            <div className="flex items-end justify-between px-1">
                <div className="flex flex-col min-w-0 pr-2">
                    <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-widest mb-0.5">Pos Value</span>
                    <span className="text-xl font-bold text-white font-mono truncate" title={`$${posValue}`}>${posValue}</span>
                </div>

                <div className="flex flex-col items-end text-right shrink-0">
                    <div className="flex items-center gap-2 sm:gap-3">
                        {Number(feesValue) > 0 && (
                            <div className="flex flex-col items-end">
                                <span className="text-[9px] text-emerald-500/80 uppercase font-bold tracking-wider mb-0.5 flex items-center gap-1">
                                    <Zap size={8} /> Pending Fees
                                </span>
                                <span className="text-sm font-bold text-emerald-400 font-mono">+${feesValue}</span>
                            </div>
                        )}
                        <button
                            onClick={() => claimFees(pool.poolId)}
                            className="h-10 px-3 sm:px-4 bg-emerald-500/10 hover:bg-emerald-500 text-emerald-500 hover:text-black hover:font-black text-[9px] sm:text-[10px] font-bold rounded-xl border border-emerald-500/30 transition-all flex items-center justify-center gap-1.5 sm:gap-2 group/claim"
                        >
                            <Wallet size={12} className="group-hover/claim:-translate-y-0.5 transition-transform" />
                            <span>CLAIM</span>
                        </button>
                    </div>
                </div>
            </div>

        </div>
    );
};

function App() {
    const [running, setRunning] = useState(false);
    const [activeView, setActiveView] = useState<'dashboard' | 'settings'>('dashboard');
    const [logs, setLogs] = useState<Log[]>([]);
    const [pools, setPools] = useState<Pool[]>([]);
    const [activeTab, setActiveTab] = useState<'terminal' | 'chart'>('terminal');
    const [activePoolTab, setActivePoolTab] = useState<'NEW' | 'LEGACY' | 'STOPPED' | 'LPPP' | 'HTP'>('NEW');

    // Live Prices
    const [solPrice, setSolPrice] = useState<number | null>(null);
    const [baseTokenPrices, setBaseTokenPrices] = useState<Record<string, number>>({});
    const [selectedBaseToken, setSelectedBaseToken] = useState<string>("LPPP");
    const [portfolio, setPortfolio] = useState<{ sol: number, baseTokens: Record<string, number> }>({ sol: 0, baseTokens: {} });

    // Scan Criteria
    const [buyAmount, setBuyAmount] = useState(0.1);
    const [slippage, setSlippage] = useState(10); // Default 10%

    const [minVolume5m, setMinVolume5m] = useState(10000);
    const [maxVolume5m, setMaxVolume5m] = useState(0);

    const [minVolume, setMinVolume] = useState(100000);
    const [maxVolume, setMaxVolume] = useState(0);

    const [minVolume24h, setMinVolume24h] = useState(1000000);
    const [maxVolume24h, setMaxVolume24h] = useState(0);

    const [minLiquidity, setMinLiquidity] = useState(60000);
    const [maxLiquidity, setMaxLiquidity] = useState(0);

    const [minMcap, setMinMcap] = useState(60000);
    const [maxMcap, setMaxMcap] = useState(0);
    const [maxAgeMinutes, setMaxAgeMinutes] = useState(0);

    // Meteora Specific
    const [meteoraFeeBps, setMeteoraFeeBps] = useState(200); // 2% Default
    const [maxPools, setMaxPools] = useState(5); // Default 5 pools
    const [discoveryMode, setDiscoveryMode] = useState<'SCOUT' | 'ANALYST'>('SCOUT');

    // Forensic & Risk Guard
    const [stopLossPct, setStopLossPct] = useState(-2);
    const [enableStopLoss, setEnableStopLoss] = useState(true);
    const [enableReputation, setEnableReputation] = useState(true);
    const [enableBundle, setEnableBundle] = useState(true);
    const [enableInvestment, setEnableInvestment] = useState(true);
    const [enableSimulation, setEnableSimulation] = useState(false);
    const [minDevTxCount, setMinDevTxCount] = useState(50);

    // API Security
    const [apiSecret, setApiSecret] = useState(localStorage.getItem('API_SECRET') || '');
    const [isSecretVisible, setIsSecretVisible] = useState(false);

    // Modal State
    const [modalConfig, setModalConfig] = useState<{
        isOpen: boolean;
        title: string;
        message: string;
        type: 'info' | 'success' | 'error' | 'warning';
        showInput?: boolean;
        inputPlaceholder?: string;
        defaultValue?: string;
        onConfirm?: (val?: string) => void;
        onCancel?: () => void;
    }>({
        isOpen: false,
        title: '',
        message: '',
        type: 'info'
    });

    const showModal = (config: Omit<typeof modalConfig, 'isOpen'>) => {
        setModalConfig({ ...config, isOpen: true });
    };

    const closeModal = () => setModalConfig(prev => ({ ...prev, isOpen: false }));

    const [isBuyUsd, setIsBuyUsd] = useState(false);

    const logsEndRef = useRef<HTMLDivElement>(null);

    // Auto-Refresh Wallet Balance
    const refreshBalance = async () => {
        try {
            const res = await axios.get(`${BACKEND_URL}/api/portfolio`, {
                headers: { 'x-api-key': apiSecret }
            });
            if (res.data && !res.data.error) {
                setPortfolio({
                    sol: res.data.sol || 0,
                    baseTokens: res.data.baseTokens || {}
                });
            }
        } catch (e) {
            console.error("Failed to refresh portfolio", e);
        }
    };

    useEffect(() => {
        refreshBalance(); // Initial fetch
        const interval = setInterval(refreshBalance, 30000); // Poll every 30s
        socket.on('log', (data) => {
            if (data.type === 'success' || data.message.includes('Swap Success') || data.message.includes('Liquidity Removed')) {
                setTimeout(refreshBalance, 2000); // Slight delay for chain indexing
            }
        });
        return () => {
            clearInterval(interval);
            socket.off('log');
        };
    }, []);

    useEffect(() => {
        socket.on('connect', () => console.log('Connected to Backend'));
        socket.on('status', (data) => setRunning(data.running));
        socket.on('log', (log: Log) => {
            setLogs((prev) => [...prev.slice(-49), log]);
        });
        socket.on('logHistory', (history: Log[]) => {
            setLogs(history);
        });
        socket.on('poolHistory', (history: Pool[]) => {
            setPools(history);
        });
        socket.on('poolUpdate', (update: PoolUpdate) => {
            setPools(prev => prev.map(p => p.poolId === update.poolId ? {
                ...p,
                roi: update.roi || p.roi,
                netRoi: update.netRoi || p.netRoi,
                unclaimedFees: update.unclaimedFees || p.unclaimedFees,
                positionValue: update.positionValue || p.positionValue,
                exited: update.exited !== undefined ? update.exited : p.exited,
                currentMcap: update.currentMcap !== undefined ? update.currentMcap : p.currentMcap,
                initialMcap: update.initialMcap !== undefined ? update.initialMcap : p.initialMcap,
                tp1Done: update.tp1Done !== undefined ? update.tp1Done : p.tp1Done,
                takeProfitDone: update.takeProfitDone !== undefined ? update.takeProfitDone : p.takeProfitDone,
                stopLossDone: update.stopLossDone !== undefined ? update.stopLossDone : p.stopLossDone
            } : p));
        });
        socket.on('pool', (pool: Pool) => {
            setPools(prev => {
                const exists = prev.find(p => p.poolId === pool.poolId);
                if (exists) return prev;
                return [...prev, pool];
            });
        });
        return () => {
            socket.off('connect');
            socket.off('status');
            socket.off('log');
            socket.off('logHistory');
            socket.off('pool');
            socket.off('poolHistory');
            socket.off('poolUpdate');
        };
    }, []);

    // Fetch Prices (SOL + LPPP)
    useEffect(() => {
        const fetchPrices = async () => {
            // Skip if tab is hidden to save API/CPU (Issue 31)
            if (document.visibilityState !== 'visible') return;

            try {
                const res = await fetch(`${BACKEND_URL}/api/price`); // Headers optional for public endpoint
                const data = await res.json();
                if (data && !data.error) {
                    // Use !== undefined and !== null to allow 0.0 values to be set
                    if (data.sol !== undefined && data.sol !== null) setSolPrice(Number(data.sol));
                    if (data.baseTokens) setBaseTokenPrices(data.baseTokens);
                }
            } catch (e) {
                console.error("Price fetch error:", e);
            }
        };

        fetchPrices();
        const intervalTime = running ? 30000 : 90000; // 30s active, 90s idle
        const interval = setInterval(fetchPrices, intervalTime);
        return () => clearInterval(interval);
    }, [running]); // Re-run effect when 'running' state changes

    // Fetch Initial Settings from SQLite on Mount
    useEffect(() => {
        const fetchSettings = async () => {
            try {
                const res = await axios.get(`${BACKEND_URL}/api/settings`, {
                    headers: { 'x-api-key': apiSecret }
                });
                if (res.data) {
                    const s = res.data;
                    if (s.buyAmount !== undefined) setBuyAmount(s.buyAmount);
                    if (s.meteoraFeeBps !== undefined) setMeteoraFeeBps(s.meteoraFeeBps);
                    if (s.maxPools !== undefined) setMaxPools(s.maxPools);
                    if (s.slippage !== undefined) setSlippage(s.slippage);
                    if (s.volume5m?.min !== undefined) setMinVolume5m(s.volume5m.min);
                    if (s.volume5m?.max !== undefined) setMaxVolume5m(s.volume5m.max);
                    if (s.volume1h?.min !== undefined) setMinVolume(s.volume1h.min);
                    if (s.volume1h?.max !== undefined) setMaxVolume(s.volume1h.max);
                    if (s.volume24h?.min !== undefined) setMinVolume24h(s.volume24h.min);
                    if (s.volume24h?.max !== undefined) setMaxVolume24h(s.volume24h.max);
                    if (s.liquidity?.min !== undefined) setMinLiquidity(s.liquidity.min);
                    if (s.liquidity?.max !== undefined) setMaxLiquidity(s.liquidity.max);
                    if (s.mcap?.min !== undefined) setMinMcap(s.mcap.min);
                    if (s.mcap?.max !== undefined) setMaxMcap(s.mcap.max);
                    if (s.mode !== undefined) setDiscoveryMode(s.mode);
                    if (s.maxAgeMinutes !== undefined) setMaxAgeMinutes(s.maxAgeMinutes);
                    if (s.baseToken !== undefined) setSelectedBaseToken(s.baseToken);

                    // Forensic Settings
                    if (s.stopLossPct !== undefined) setStopLossPct(s.stopLossPct);
                    if (s.enableStopLoss !== undefined) setEnableStopLoss(s.enableStopLoss);
                    if (s.enableReputation !== undefined) setEnableReputation(s.enableReputation);
                    if (s.enableBundle !== undefined) setEnableBundle(s.enableBundle);
                    if (s.enableInvestment !== undefined) setEnableInvestment(s.enableInvestment);
                    if (s.enableSimulation !== undefined) setEnableSimulation(s.enableSimulation);
                    if (s.minDevTxCount !== undefined) setMinDevTxCount(s.minDevTxCount);
                }
            } catch (e) {
                console.warn("Failed to fetch settings from DB, using defaults.");
            }
        };
        fetchSettings();
    }, [apiSecret]);

    // Fetch Portfolio (Duplicate removed, use refreshBalance)
    useEffect(() => {
        refreshBalance();
    }, []);

    const toggleBot = async () => {
        const endpoint = running ? '/api/stop' : '/api/start';
        const finalBuy = isBuyUsd && solPrice ? buyAmount / solPrice : buyAmount;

        try {
            const res = await fetch(`${BACKEND_URL}${endpoint}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiSecret
                },
                body: JSON.stringify({
                    buyAmount: finalBuy,
                    lpppAmount: 0,
                    meteoraFeeBps,
                    maxPools,
                    slippage,
                    volume5m: { min: minVolume5m, max: maxVolume5m },
                    volume1h: { min: minVolume, max: maxVolume },
                    volume24h: { min: minVolume24h, max: maxVolume24h },
                    liquidity: { min: minLiquidity, max: maxLiquidity },
                    mcap: { min: minMcap, max: maxMcap },
                    mode: discoveryMode,
                    maxAgeMinutes,
                    baseToken: selectedBaseToken,
                    stopLossPct,
                    enableStopLoss,
                    enableReputation,
                    enableBundle,
                    enableInvestment,
                    enableSimulation,
                    minDevTxCount
                })
            });

            if (res.status === 401) {
                showModal({
                    title: "Authentication Failed",
                    message: "The API Secret provided is invalid. Please check your Security settings.",
                    type: 'error'
                });
                return;
            }

            if (res.ok) {
                setRunning(!running);
            }
        } catch (e) {
            console.error("Bot toggle error:", e);
        }
    };

    const saveSettings = async () => {
        const finalBuy = isBuyUsd && solPrice ? buyAmount / solPrice : buyAmount;
        try {
            const res = await fetch(`${BACKEND_URL}/api/settings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiSecret
                },
                body: JSON.stringify({
                    buyAmount: finalBuy,
                    lpppAmount: 0,
                    meteoraFeeBps,
                    maxPools,
                    slippage,
                    volume5m: { min: minVolume5m, max: maxVolume5m },
                    volume1h: { min: minVolume, max: maxVolume },
                    volume24h: { min: minVolume24h, max: maxVolume24h },
                    liquidity: { min: minLiquidity, max: maxLiquidity },
                    mcap: { min: minMcap, max: maxMcap },
                    mode: discoveryMode,
                    maxAgeMinutes,
                    baseToken: selectedBaseToken,
                    stopLossPct,
                    enableStopLoss,
                    enableReputation,
                    enableBundle,
                    enableInvestment,
                    enableSimulation,
                    minDevTxCount
                })
            });

            if (res.ok) {
                showModal({
                    title: "Settings Saved",
                    message: "Bot configuration has been persisted to the database.",
                    type: 'success',
                });
            }
        } catch (e) {
            console.error("Save settings error:", e);
        }
    };

    const withdrawLiquidity = async (poolId: string, percent: number) => {
        const isFull = percent >= 100;
        showModal({
            title: isFull ? "Confirm Full Close" : "Confirm Withdrawal",
            message: isFull
                ? "Are you sure you want to withdraw ALL liquidity and CLOSE this position?"
                : `Are you sure you want to withdraw ${percent}% of the liquidity from this pool?`,
            type: 'warning',
            onCancel: closeModal,
            onConfirm: async () => {
                const res = await fetch(`${BACKEND_URL}/api/pool/withdraw`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': apiSecret
                    },
                    body: JSON.stringify({ poolId, percent })
                });

                if (res.status === 401) {
                    showModal({
                        title: "Failed",
                        message: "Invalid API Secret. Could not withdraw.",
                        type: 'error'
                    });
                }
            }
        });
    };

    const claimFees = async (poolId: string) => {
        const res = await fetch(`${BACKEND_URL}/api/pool/claim`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiSecret
            },
            body: JSON.stringify({ poolId })
        });

        if (res.status === 401) {
            showModal({
                title: "Failed",
                message: "Invalid API Secret. Could not claim fees.",
                type: 'error'
            });
        }
    };

    const increaseLiquidity = async (poolId: string) => {
        showModal({
            title: "Increase Liquidity",
            message: "How much SOL would you like to add to this pool?",
            type: 'info',
            showInput: true,
            inputPlaceholder: "0.1",
            defaultValue: "0.1",
            onCancel: closeModal,
            onConfirm: async (amount) => {
                if (!amount || isNaN(Number(amount))) return;
                const res = await fetch(`${BACKEND_URL}/api/pool/increase`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': apiSecret
                    },
                    body: JSON.stringify({ poolId, amountSol: Number(amount) })
                });

                if (res.status === 401) {
                    showModal({
                        title: "Failed",
                        message: "Invalid API Secret. Could not increase liquidity.",
                        type: 'error'
                    });
                }
            }
        });
    };

    const refreshPool = async (poolId: string) => {
        await fetch(`${BACKEND_URL}/api/pool/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiSecret },
            body: JSON.stringify({ poolId })
        });
    };

    const updatePrivateKey = async () => {
        showModal({
            title: "Security Check",
            message: "Please enter the admin password to update the wallet configuration.",
            type: 'warning',
            showInput: true,
            inputPlaceholder: "Password",
            onCancel: closeModal,
            onConfirm: async (pass) => {
                if (pass !== "lppp-admin") {
                    showModal({
                        title: "Access Denied",
                        message: "The password you entered is incorrect.",
                        type: 'error'
                    });
                    return;
                }

                showModal({
                    title: "Update Private Key",
                    message: "Paste your new base58 Private Key below. This will update the bot's runtime wallet.",
                    type: 'info',
                    showInput: true,
                    inputPlaceholder: "base58 Private Key",
                    onCancel: closeModal,
                    onConfirm: async (newKey) => {
                        if (!newKey) return;
                        const res = await fetch(`${BACKEND_URL}/api/config/key`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'x-api-key': apiSecret },
                            body: JSON.stringify({ privateKey: newKey, adminPassword: pass })
                        });
                        const data = await res.json();
                        if (data.success) {
                            showModal({
                                title: "Wallet Updated",
                                message: `Successfully updated the wallet! New Public Key: ${data.publicKey}`,
                                type: 'success'
                            });
                        } else {
                            showModal({
                                title: "Update Failed",
                                message: `Failed to update the wallet: ${data.error}`,
                                type: 'error'
                            });
                        }
                    }
                });
            }
        });
    };

    const clearLogs = () => setLogs([]);

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
    };

    const formatMessage = (msg: string) => {
        // Regex for Solana Address
        // eslint-disable-next-line
        const solanaRegex = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
        const match = msg.match(solanaRegex);

        if (!match) return msg;

        const address = match[0];
        const parts = msg.split(address);

        return (
            <>
                {parts[0]}
                <span
                    onClick={() => copyToClipboard(address)}
                    className="bg-primary/20 px-1 rounded cursor-pointer hover:bg-primary/40 transition-all underline decoration-dotted inline-flex items-center gap-1 group"
                    title="Click to copy CA"
                >
                    {address}
                    <Zap size={10} className="group-hover:animate-pulse" />
                </span>
                {parts[1]}
            </>
        );
    };

    const toggleBuyUnit = () => {
        if (!solPrice || solPrice <= 0) {
            console.warn("SOL Price not ready yet");
            setIsBuyUsd(!isBuyUsd);
            return;
        }

        const currentIsUsd = isBuyUsd;
        let newAmount = buyAmount;

        if (currentIsUsd) {
            // USD -> SOL
            newAmount = buyAmount / solPrice;
            newAmount = Math.round(newAmount * 10000) / 10000; // Round to 4 decimals
        } else {
            // SOL -> USD
            newAmount = buyAmount * solPrice;
            newAmount = Math.round(newAmount * 100) / 100; // Round to 2 decimals
        }

        console.log(`Converting: ${buyAmount} ${currentIsUsd ? 'USD' : 'SOL'} -> ${newAmount} ${!currentIsUsd ? 'USD' : 'SOL'} (Price: ${solPrice})`);

        setBuyAmount(newAmount);
        setIsBuyUsd(!currentIsUsd);
    };


    return (
        <div className="min-h-screen bg-background text-foreground flex flex-col font-sans">
            <header className="sticky top-0 z-50 bg-black/80 backdrop-blur-xl border-b border-white/5 py-4">
                <div className="max-w-[1440px] mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
                    <div className="flex items-center gap-4 w-full sm:w-auto">
                        <div className="w-12 h-12 flex items-center justify-center bg-primary/20 rounded-2xl border border-white/10 overflow-hidden shadow-[0_0_20px_rgba(196,240,0,0.15)] relative group shrink-0">
                            <img
                                src="/logo.png"
                                alt="Logo"
                                className="w-full h-full object-cover transform transition-transform duration-500 group-hover:scale-110 opacity-90"
                                onError={(e) => {
                                    (e.target as HTMLImageElement).src = 'https://ui-avatars.com/api/?name=BOT&background=c4f000&color=000';
                                }}
                            />
                        </div>
                        <div>
                            <h1 className="text-2xl font-black tracking-widest text-primary drop-shadow-[0_0_10px_rgba(196,240,0,0.3)] leading-none">LPPP BOT</h1>
                            <span className="text-[11px] font-medium text-muted-foreground block mt-0.5 tracking-wider uppercase">Finance Revolution Execution</span>
                        </div>
                    </div>
                    <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-6 w-full sm:w-auto">
                        <nav className="flex items-center gap-1 bg-white/5 p-1 rounded-xl border border-white/10 w-full sm:w-auto">
                            <button
                                onClick={() => setActiveView('dashboard')}
                                className={`flex-1 sm:flex-none px-4 py-2 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all ${activeView === 'dashboard' ? 'bg-primary text-black shadow-[0_0_15px_rgba(196,240,0,0.3)]' : 'text-muted-foreground hover:text-foreground hover:bg-white/5'}`}
                            >
                                Dashboard
                            </button>
                            <button
                                onClick={() => setActiveView('settings')}
                                className={`flex-1 sm:flex-none px-4 py-2 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all ${activeView === 'settings' ? 'bg-primary text-black shadow-[0_0_15px_rgba(196,240,0,0.3)]' : 'text-muted-foreground hover:text-foreground hover:bg-white/5'}`}
                            >
                                Settings
                            </button>
                        </nav>
                        <div className="flex items-center gap-2 bg-white/5 sm:bg-transparent px-4 py-2 sm:p-0 rounded-xl border border-white/10 sm:border-none w-full sm:w-auto justify-center">
                            <span className={`w-2 h-2 rounded-full ${running ? 'bg-primary shadow-[0_0_8px_rgba(16,185,129,0.8)]' : 'bg-muted-foreground'}`}></span>
                            <span className="text-sm font-medium text-muted-foreground uppercase tracking-tighter">
                                {running ? 'Scanner Active' : 'System Offline'}
                            </span>
                        </div>
                    </div>
                </div>
            </header>

            <main className="max-w-[1440px] mx-auto w-full flex-1 p-6">
                {activeView === 'dashboard' ? (
                    <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-6">
                        {/* Dashboard Left: Pools */}
                        <div className="flex flex-col gap-6">
                            {/* Stats Bar */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div className="glass-card p-4 flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                                            <Wallet size={20} />
                                        </div>
                                        <div>
                                            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">SOL Balance</p>
                                            <p className="text-lg font-black font-mono leading-none">{portfolio.sol.toFixed(3)}</p>
                                            {solPrice && (
                                                <p className="text-[10px] font-medium text-muted-foreground/60 mt-0.5">≈ ${(portfolio.sol * solPrice).toFixed(2)}</p>
                                            )}
                                        </div>
                                    </div>
                                    <button onClick={refreshBalance} className="text-muted-foreground hover:text-primary transition-colors">
                                        <RefreshCw size={14} />
                                    </button>
                                </div>
                                <div className="glass-card p-4 flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center text-emerald-500">
                                        <Zap size={20} />
                                    </div>
                                    <div>
                                        <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">{selectedBaseToken} Portfolio</p>
                                        <p className="text-lg font-black font-mono leading-none">{(portfolio.baseTokens[selectedBaseToken] || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}</p>
                                        {baseTokenPrices[selectedBaseToken] && (
                                            <p className="text-[10px] font-medium text-muted-foreground/60 mt-0.5">≈ ${((portfolio.baseTokens[selectedBaseToken] || 0) * baseTokenPrices[selectedBaseToken]).toFixed(2)}</p>
                                        )}
                                    </div>
                                </div>
                                <div className="glass-card p-4 flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                                            <Activity size={20} />
                                        </div>
                                        <div>
                                            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">System Status</p>
                                            <p className={`text-sm font-black uppercase tracking-tight ${running ? 'text-primary' : 'text-muted-foreground'}`}>
                                                {running ? 'Scanner Live' : 'Scanner Idle'}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex gap-2">
                                        <button
                                            onClick={toggleBot}
                                            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${running ? 'bg-red-500/20 text-red-500 border border-red-500/30' : 'bg-primary text-black'}`}
                                        >
                                            <Power size={14} />
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Pools Container */}
                            <div className="glass-card min-h-[500px] flex flex-col">
                                <div className="p-4 border-b border-white/5 flex items-center justify-between">
                                    <div className="flex items-center gap-4">
                                        <div className="flex items-center gap-2">
                                            <Droplets size={18} className="text-primary" />
                                            <h2 className="text-sm font-bold uppercase tracking-widest">Active Snipes</h2>
                                        </div>
                                        <div className="flex gap-1 bg-white/5 p-1 rounded-lg border border-white/5">
                                            {['NEW', 'LEGACY', 'STOPPED', 'LPPP', 'HTP'].map((tab) => (
                                                <button
                                                    key={tab}
                                                    onClick={() => setActivePoolTab(tab as any)}
                                                    className={`px-3 py-1 rounded-md text-[9px] font-bold transition-all ${activePoolTab === tab ? 'bg-white/10 text-white shadow-sm' : 'text-muted-foreground hover:text-white'}`}
                                                >
                                                    {tab}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                    <span className="text-[10px] font-mono text-muted-foreground bg-white/5 px-2 py-1 rounded border border-white/5 uppercase">
                                        {pools.filter(p => !p.exited && p.isBotCreated).length} ACTIVE
                                    </span>
                                </div>

                                <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4 flex-1">
                                    {pools.filter(p => {
                                        if (activePoolTab === 'NEW') return !p.exited && p.isBotCreated;
                                        if (activePoolTab === 'LEGACY') return !p.exited && !p.isBotCreated;
                                        if (activePoolTab === 'STOPPED') return p.exited;
                                        if (activePoolTab === 'LPPP') return p.baseToken === 'LPPP' && !p.exited;
                                        if (activePoolTab === 'HTP') return false;
                                        return true;
                                    }).sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime()).map(pool => (
                                        <PoolCard
                                            key={pool.poolId}
                                            pool={pool}
                                            isBot={pool.isBotCreated || false}
                                            claimFees={claimFees}
                                            increaseLiquidity={increaseLiquidity}
                                            withdrawLiquidity={withdrawLiquidity}
                                            refreshPool={refreshPool}
                                            basePrice={baseTokenPrices[pool.baseToken || 'LPPP']}
                                        />
                                    ))}

                                    {pools.length === 0 && Object.keys(baseTokenPrices).length === 0 && (
                                        <div className="col-span-full py-16 text-center bg-primary/[0.02] border border-dashed border-primary/10 rounded-2xl flex flex-col items-center gap-3">
                                            <Zap size={40} className="opacity-15 text-primary" />
                                            <p className="text-sm font-medium text-muted-foreground/50">Fetching Base Tokens...</p>
                                        </div>
                                    )}

                                    {pools.filter(p => !p.exited && p.isBotCreated).length === 0 && Object.keys(baseTokenPrices).length > 0 && activePoolTab === 'NEW' && (
                                        <div className="col-span-full py-16 text-center bg-primary/[0.02] border border-dashed border-primary/10 rounded-2xl flex flex-col items-center gap-3">
                                            <Zap size={40} className="opacity-15 text-primary" />
                                            <p className="text-sm font-medium text-muted-foreground/50">Waiting for bot to snipe...</p>
                                            <p className="text-[10px] text-muted-foreground/30">Pools will appear here when the bot creates them</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Dashboard Right: Terminal */}
                        <div className="flex flex-col gap-6">
                            <div className="glass-card flex-1 flex flex-col min-h-[600px] overflow-hidden">
                                <div className="p-4 border-b border-white/5 flex items-center justify-between shrink-0">
                                    <div className="flex items-center gap-2">
                                        <Terminal size={18} className="text-primary" />
                                        <h2 className="text-sm font-bold uppercase tracking-widest">Bot Execution Log</h2>
                                    </div>
                                    <button onClick={clearLogs} className="text-[9px] font-black text-muted-foreground hover:text-white transition-colors uppercase tracking-widest bg-white/5 px-2 py-1 rounded">Clear</button>
                                </div>
                                <div className="flex-1 p-4 font-mono text-[11px] overflow-y-auto space-y-1 bg-black/40">
                                    {logs.map((log, i) => (
                                        <div key={i} className={`flex gap-3 animate-in fade-in slide-in-from-left-2 duration-300 py-0.5 border-b border-white/[0.02] last:border-0`}>
                                            <span className="text-muted-foreground/30 shrink-0 font-bold select-none">[{new Date(log.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}]</span>
                                            <span className={`break-words leading-relaxed ${log.type === 'error' ? 'text-red-400 font-bold' : log.type === 'success' ? 'text-primary font-bold' : log.type === 'warning' ? 'text-amber-400 italic' : 'text-zinc-300'}`}>
                                                {formatMessage(log.message)}
                                            </span>
                                        </div>
                                    ))}
                                    <div ref={logsEndRef} />
                                </div>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                        <div className="flex items-center justify-between">
                            <div>
                                <h1 className="text-2xl font-black text-white uppercase tracking-widest">Bot Configuration</h1>
                                <p className="text-muted-foreground text-sm mt-1">Manage parameters, forensic guard, and safety thresholds.</p>
                            </div>
                            <div className="flex gap-3">
                                <button
                                    onClick={saveSettings}
                                    className="px-6 py-3 bg-white/5 hover:bg-white/10 text-white rounded-2xl border border-white/10 font-black text-[11px] uppercase tracking-widest transition-all flex items-center gap-2"
                                >
                                    <Settings2 size={16} /> Save Settings
                                </button>
                                <button
                                    onClick={toggleBot}
                                    className={`px-6 py-3 rounded-2xl font-black text-[11px] uppercase tracking-widest transition-all flex items-center gap-2 shadow-lg ${running ? 'bg-red-500/20 text-red-500 border border-red-500/30' : 'bg-primary text-black'}`}
                                >
                                    <Power size={16} /> {running ? 'Stop Scanner' : 'Launch Bot'}
                                </button>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                            {/* Trading Parameters */}
                            <div className="space-y-6">
                                <div className="glass-card p-6 space-y-6">
                                    <div className="flex items-center gap-2 pb-4 border-b border-white/5">
                                        <Zap size={18} className="text-primary" />
                                        <h2 className="text-sm font-bold uppercase tracking-widest">Trading Parameters</h2>
                                    </div>

                                    <div className="space-y-4">
                                        <div className="flex items-center justify-between mb-2">
                                            <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Base Asset</label>
                                            <select
                                                value={selectedBaseToken}
                                                onChange={(e) => setSelectedBaseToken(e.target.value)}
                                                className="bg-zinc-900 text-primary font-bold border border-primary/20 rounded px-2 py-1 text-[10px] outline-none"
                                                disabled={running}
                                            >
                                                {Object.keys(baseTokenPrices).length > 0 ? Object.keys(baseTokenPrices).map(t => (
                                                    <option key={t} value={t}>{t}</option>
                                                )) : <option value="LPPP">LPPP</option>}
                                            </select>
                                        </div>

                                        <div className="p-4 bg-primary/5 rounded-2xl border border-primary/10">
                                            <div className="flex items-center justify-between mb-3">
                                                <span className="text-[10px] font-bold text-primary/80 uppercase">Position Size</span>
                                                <button onClick={toggleBuyUnit} className="text-[9px] font-black text-muted-foreground hover:text-white transition-colors uppercase tracking-tighter">Swap to {isBuyUsd ? 'SOL' : 'USD'}</button>
                                            </div>
                                            <SettingInput
                                                label={`Buy Size (${isBuyUsd ? 'USD' : 'SOL'})`}
                                                value={buyAmount}
                                                onChange={setBuyAmount}
                                                disabled={running}
                                                prefix={isBuyUsd ? "$" : ""}
                                                unit={isBuyUsd ? "USD" : "SOL"}
                                                subtext={!isBuyUsd && solPrice ? `≈ $${(buyAmount * solPrice).toFixed(2)}` : (isBuyUsd && solPrice ? `≈ ${(buyAmount / solPrice).toFixed(4)} SOL` : undefined)}
                                            />
                                        </div>

                                        <div className="grid grid-cols-2 gap-4">
                                            <SettingInput label="Slippage" value={slippage} onChange={setSlippage} disabled={running} unit="%" />
                                            <SettingInput label="Max Pools" value={maxPools} onChange={setMaxPools} disabled={running} unit="LMT" />
                                        </div>
                                    </div>
                                </div>

                                <div className="glass-card p-6 space-y-6">
                                    <div className="flex items-center gap-2 pb-4 border-b border-white/5">
                                        <Search size={18} className="text-primary" />
                                        <h2 className="text-sm font-bold uppercase tracking-widest">Discovery Filters</h2>
                                    </div>
                                    <div className="space-y-4">
                                        <div className="grid grid-cols-2 gap-4">
                                            <SettingInput label="5m Vol Min ($)" value={minVolume5m} onChange={setMinVolume5m} disabled={running} prefix="$" />
                                            <SettingInput label="5m Vol Max ($)" value={maxVolume5m} onChange={setMaxVolume5m} disabled={running} prefix="$" />
                                        </div>
                                        <div className="grid grid-cols-2 gap-4">
                                            <SettingInput label="Liquidity Min ($)" value={minLiquidity} onChange={setMinLiquidity} disabled={running} prefix="$" />
                                            <SettingInput label="Liquidity Max ($)" value={maxLiquidity} onChange={setMaxLiquidity} disabled={running} prefix="$" />
                                        </div>
                                        <div className="grid grid-cols-2 gap-4">
                                            <SettingInput label="Mcap Min ($)" value={minMcap} onChange={setMinMcap} disabled={running} prefix="$" />
                                            <SettingInput label="Mcap Max ($)" value={maxMcap} onChange={setMaxMcap} disabled={running} prefix="$" />
                                        </div>
                                        <SettingInput label="Max Pair Age (Minutes)" value={maxAgeMinutes} onChange={setMaxAgeMinutes} disabled={running} unit="MIN" />
                                    </div>
                                </div>
                            </div>

                            {/* Risk & Security */}
                            <div className="space-y-6">
                                <div className="glass-card p-6 space-y-6 border-primary/20 bg-primary/[0.02]">
                                    <div className="flex items-center gap-2 pb-4 border-b border-primary/10">
                                        <ShieldAlert size={18} className="text-primary" />
                                        <h2 className="text-sm font-bold uppercase tracking-widest text-primary">Forensic Guard & Risk</h2>
                                    </div>
                                    <div className="space-y-4">
                                        <Toggle label="Enable Stop Loss" enabled={enableStopLoss} onChange={setEnableStopLoss} disabled={running} />
                                        {enableStopLoss && (
                                            <div className="animate-in fade-in slide-in-from-top-2 duration-200">
                                                <SettingInput label="Global Stop Loss (%)" value={stopLossPct} onChange={setStopLossPct} disabled={running} unit="%" subtext="Triggers full liquidity withdrawal" />
                                            </div>
                                        )}
                                        <div className="h-px bg-white/5 my-2"></div>
                                        <div className="bg-black/20 p-4 rounded-2xl border border-white/5 space-y-1">
                                            <Toggle label="Dev Reputation Scan" enabled={enableReputation} onChange={setEnableReputation} disabled={running} />
                                            {enableReputation && (
                                                <div className="pt-2 animate-in fade-in zoom-in-95 duration-200">
                                                    <SettingInput label="Min Dev TXs" value={minDevTxCount} onChange={setMinDevTxCount} disabled={running} subtext="Rejects fresh/burner wallets" />
                                                </div>
                                            )}
                                            <Toggle label="Live Bundle Detection" enabled={enableBundle} onChange={setEnableBundle} disabled={running} />
                                            <Toggle label="Market Investment Audit" enabled={enableInvestment} onChange={setEnableInvestment} disabled={running} />
                                            <Toggle label="Sell-Ability Simulation" enabled={enableSimulation} onChange={setEnableSimulation} disabled={running} />
                                        </div>
                                    </div>
                                </div>

                                <div className="glass-card p-6 space-y-6">
                                    <div className="flex items-center gap-2 pb-4 border-b border-white/5">
                                        <Wallet size={18} className="text-muted-foreground" />
                                        <h2 className="text-sm font-bold uppercase tracking-widest">System & API</h2>
                                    </div>
                                    <div className="space-y-4">
                                        <div className="flex flex-col gap-1.5">
                                            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Access Secret Key</label>
                                            <div className="relative">
                                                <input
                                                    type={isSecretVisible ? "text" : "password"}
                                                    value={apiSecret}
                                                    onChange={(e) => {
                                                        const val = e.target.value;
                                                        setApiSecret(val);
                                                        localStorage.setItem('API_SECRET', val);
                                                    }}
                                                    className="w-full bg-input border border-border text-foreground px-3 py-2 rounded-xl font-mono text-[12px] pr-10"
                                                />
                                                <button onClick={() => setIsSecretVisible(!isSecretVisible)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-white transition-colors">
                                                    <Activity size={14} />
                                                </button>
                                            </div>
                                        </div>
                                        <button
                                            onClick={updatePrivateKey}
                                            className="w-full py-3 bg-secondary hover:bg-white/5 text-muted-foreground hover:text-white rounded-xl border border-white/5 font-bold text-[10px] uppercase tracking-widest transition-all flex items-center justify-center gap-2"
                                        >
                                            <RefreshCw size={14} /> Update Bot Hot-Wallet
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </main>

            <Modal
                isOpen={modalConfig.isOpen}
                onClose={closeModal}
                title={modalConfig.title}
                message={modalConfig.message}
                type={modalConfig.type}
                showInput={modalConfig.showInput}
                inputPlaceholder={modalConfig.inputPlaceholder}
                defaultValue={modalConfig.defaultValue}
                onConfirm={modalConfig.onConfirm}
                onCancel={modalConfig.onCancel}
            />
        </div>
    );
}

export default App;
