
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
    ExternalLink
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
    token: string;
    roi: string;
    netRoi?: string;     // Inventory-based ROI
    created: string;
    unclaimedFees?: { sol: string; token: string; totalLppp?: string };
    positionValue?: { baseLp: string; tokenLp: string; totalLppp: string };
    exited?: boolean;
    isBotCreated?: boolean;
}

interface PoolUpdate {
    poolId: string;
    roi?: string;
    netRoi?: string;
    unclaimedFees?: { sol: string; token: string; totalLppp?: string };
    positionValue?: { baseLp: string; tokenLp: string; totalLppp: string };
    exited?: boolean;
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
                    className={`w-full bg-input border border-border text-foreground px-2.5 py-1.5 rounded-md font-mono text-[12px] focus:outline-none focus:border-primary/50 transition-colors ${prefix ? 'pl-6' : ''} ${unit ? 'pr-9' : ''}`}
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

const PoolCard = ({ pool, isBot, claimFees, increaseLiquidity, withdrawLiquidity, lpppPrice }: {
    pool: Pool;
    isBot: boolean;
    claimFees: (id: string) => void;
    increaseLiquidity: (id: string) => void;
    withdrawLiquidity: (id: string, pct: number) => void;
    lpppPrice: number | null;
}) => (
    <div key={pool.poolId} className={`bg-secondary border p-4 rounded-md flex flex-col gap-4 group transition-all duration-300 ${isBot ? 'hover:border-pink-500/50 border-border shadow-[0_4px_12px_rgba(236,72,153,0.05)]' : 'hover:border-primary/50 border-border opacity-90'}`}>
        <div className="flex justify-between items-start">
            <div>
                <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider mb-1">Pair Address</p>
                <div className="flex items-center gap-2">
                    <a
                        href={`https://solscan.io/account/${pool.poolId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`font-mono text-[13px] hover:underline flex items-center gap-1.5 transition-colors ${isBot ? 'text-pink-400' : 'text-primary'}`}
                    >
                        {pool.poolId.slice(0, 12)}...
                        <ExternalLink size={10} className="opacity-50" />
                    </a>
                </div>
                <div className="flex items-center gap-2 mt-2">
                    <span className={`px-1.5 py-0.5 text-[10px] rounded font-bold ${isBot ? 'bg-pink-500/10 text-pink-500 border border-pink-500/20' : 'bg-primary/10 text-primary'}`}>{pool.token}</span>
                    {isBot && (
                        <span className="px-1.5 py-0.5 bg-pink-500/20 text-pink-500 text-[8px] rounded font-black border border-pink-500/30 flex items-center gap-1 animate-pulse">
                            <Zap size={8} /> LIVE SNIPE
                        </span>
                    )}
                    <span className="text-[10px] text-muted-foreground">{new Date(pool.created).toLocaleTimeString()}</span>
                </div>
            </div>
        </div>

        {/* ═══ Position value ═══ */}
        <div className="py-3 px-3 bg-card/30 rounded-lg border border-border/50">
            <p className="text-[10px] text-muted-foreground/70 mb-1">Position value</p>
            <p className="text-lg font-bold text-white">
                ${((Number(pool.positionValue?.totalLppp || 0)) * (lpppPrice || 0)).toFixed(6)}
            </p>
            <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                {Number(pool.positionValue?.baseLp || 0).toFixed(9)} LPPP
                <span className="mx-1 text-muted-foreground/30">+</span>
                {Number(pool.positionValue?.tokenLp || 0).toFixed(6)} {pool.token}
            </p>
        </div>

        {/* ═══ Fees from position ═══ */}
        <div className="py-3 px-3 bg-card/30 rounded-lg border border-border/50">
            <p className="text-[10px] text-muted-foreground/70 mb-1">Fees from position</p>
            <div className="flex justify-between items-center">
                <div>
                    <p className="text-lg font-bold text-white">
                        ${((Number(pool.unclaimedFees?.totalLppp || 0)) * (lpppPrice || 0)).toFixed(6)}
                    </p>
                    <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                        {Number(pool.unclaimedFees?.sol || 0).toFixed(6)} LPPP
                        <span className="mx-1 text-muted-foreground/30">+</span>
                        {Number(pool.unclaimedFees?.token || 0).toFixed(6)} {pool.token}
                    </p>
                </div>
                <button
                    onClick={() => claimFees(pool.poolId)}
                    className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-white text-[11px] font-bold rounded-lg transition-all shadow-lg shadow-emerald-500/20"
                >
                    Claim fees
                </button>
            </div>
        </div>

        <div className="flex flex-col gap-2 mt-auto">
            <div className="grid grid-cols-2 gap-2">
                <button
                    onClick={() => increaseLiquidity(pool.poolId)}
                    className="py-1.5 bg-primary/10 hover:bg-primary/20 text-primary text-[10px] font-black rounded border border-primary/20 transition-all flex items-center justify-center gap-1"
                >
                    <Droplets size={10} /> ADD LIQ
                </button>
                <button
                    onClick={() => withdrawLiquidity(pool.poolId, 100)}
                    className={`py-1.5 text-white text-[10px] font-black rounded shadow-lg transition-all ${isBot ? 'bg-pink-600 hover:bg-pink-700' : 'bg-red-600 hover:bg-red-700'}`}
                >
                    FULL CLOSE
                </button>
            </div>
        </div>
    </div>
);

function App() {
    const [running, setRunning] = useState(false);
    const [logs, setLogs] = useState<Log[]>([]);
    const [pools, setPools] = useState<Pool[]>([]);
    const [activeTab, setActiveTab] = useState<'terminal' | 'chart'>('terminal');

    // Live Prices
    const [solPrice, setSolPrice] = useState<number | null>(null);
    const [lpppPrice, setLpppPrice] = useState<number | null>(null);
    const [portfolio, setPortfolio] = useState<{ sol: number, lppp: number }>({ sol: 0, lppp: 0 });

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
                    lppp: res.data.lppp || 0
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
                exited: update.exited !== undefined ? update.exited : p.exited
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
                    if (data.lppp !== undefined && data.lppp !== null) setLpppPrice(Number(data.lppp));
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
                    maxAgeMinutes
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
                            headers: { 'Content-Type': 'application/json' },
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
            {/* Header */}
            <header className="p-6 border-b border-border bg-card">
                <div className="max-w-[1440px] mx-auto flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-12 h-12 flex items-center justify-center bg-pink-500/20 rounded-full border-2 border-white overflow-hidden shadow-[0_0_15px_rgba(236,72,153,0.3)] relative group">
                            <img
                                src="/logo.jpg"
                                alt="LPPP Logo"
                                className="w-full h-full object-cover transform transition-transform group-hover:scale-110"
                                onError={(e) => {
                                    (e.target as HTMLImageElement).src = 'https://ui-avatars.com/api/?name=LPPP&background=ec4899&color=fff';
                                }}
                            />
                        </div>
                        <div>
                            <h1 className="text-2xl font-bold glow-text leading-none tracking-wider text-pink-500">LPPP BOT</h1>
                            <span className="text-[12px] text-muted-foreground block mt-1">Pool Party Liquidity Master</span>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${running ? 'bg-primary shadow-[0_0_8px_rgba(16,185,129,0.8)]' : 'bg-muted-foreground'}`}></span>
                        <span className="text-sm font-medium text-muted-foreground">
                            {running ? 'Scanner Active' : 'System Offline'}
                        </span>
                    </div>
                </div>
            </header>

            <main className="grid grid-cols-1 lg:grid-cols-[320px_1fr_400px] gap-6 p-6 max-w-[1440px] mx-auto w-full flex-1">

                {/* Left Column: Controls */}
                <div className="flex flex-col gap-6">
                    {/* Configuration Card */}
                    <div className="bg-card border border-border rounded-lg p-5 flex flex-col">
                        <div className="flex items-center justify-between mb-5">
                            <div className="flex items-center gap-2">
                                <Settings2 size={18} className="text-muted-foreground" />
                                <h2 className="text-sm font-semibold">Configuration</h2>
                            </div>
                            <div className="flex gap-2">
                                {solPrice && <span className="text-[10px] text-muted-foreground font-mono bg-white/5 px-2 py-0.5 rounded border border-border">SOL: ${solPrice.toFixed(2)}</span>}
                                {lpppPrice && <span className="text-[10px] text-emerald-400/80 font-mono bg-emerald-900/10 px-2 py-0.5 rounded border border-emerald-500/20">LPPP: ${lpppPrice.toFixed(4)}</span>}
                            </div>
                        </div>

                        <div className="mb-4">
                            <button
                                onClick={toggleBuyUnit}
                                className="text-[9px] font-bold text-primary/80 hover:text-primary transition-colors flex items-center gap-1 bg-primary/5 px-2 py-1 rounded border border-primary/20 mb-2"
                            >
                                <Zap size={8} />
                                SWITCH TO {isBuyUsd ? 'SOL' : 'USD'}
                            </button>

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

                        <div className="mb-4">
                            <div className="flex flex-col gap-1.5">
                                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">LP Match (LPPP) — Auto</label>
                                <div className="relative">
                                    <input
                                        type="text"
                                        readOnly
                                        value={solPrice && lpppPrice && lpppPrice > 0 ? `≈ ${((isBuyUsd ? buyAmount : buyAmount * solPrice) / lpppPrice).toLocaleString(undefined, { maximumFractionDigits: 1 })} LPPP` : 'Fetching prices...'}
                                        className="w-full bg-input/50 border border-border/50 text-muted-foreground px-2.5 py-1.5 rounded-md font-mono text-[12px] cursor-not-allowed"
                                    />
                                </div>
                                {solPrice && lpppPrice && lpppPrice > 0 && (
                                    <span className="text-[9px] text-muted-foreground/70">≈ ${(isBuyUsd ? buyAmount : buyAmount * solPrice).toFixed(2)} USD equivalent</span>
                                )}
                            </div>
                        </div>

                        {/* Discovery Engine Selection */}
                        <div className="mb-6 pt-4 border-t border-border">
                            <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-3 block">Discovery Engine</label>
                            <div className="grid grid-cols-2 gap-1.5 p-1 bg-secondary rounded-lg border border-border">
                                {['SCOUT', 'ANALYST'].map((m) => (
                                    <button
                                        key={m}
                                        onClick={() => setDiscoveryMode(m as any)}
                                        disabled={running}
                                        className={`py-2 rounded-md text-[10px] font-black transition-all border flex flex-col items-center gap-0.5 ${discoveryMode === m
                                            ? 'bg-primary/20 border-primary text-primary shadow-[0_0_10px_rgba(16,185,129,0.1)] scale-[1.02]'
                                            : 'bg-transparent border-transparent text-muted-foreground/60 hover:text-muted-foreground'
                                            }`}
                                    >
                                        <span className="tracking-tighter">{m}</span>
                                        {m === 'SCOUT' && <span className="text-[7px] opacity-60">New</span>}
                                        {m === 'ANALYST' && <span className="text-[7px] opacity-60">Hot</span>}
                                    </button>
                                ))}
                            </div>
                            <div className="mt-2 text-[9px] text-muted-foreground/60 italic px-1">
                                {discoveryMode === 'SCOUT' && "• Real-time sniping via Helius + Birdeye"}
                                {discoveryMode === 'ANALYST' && "• Targeting high-rank trending momentum"}
                            </div>
                        </div>

                        <div className="mt-4">
                            <SettingInput label="Max Pair Age (Minutes)" value={maxAgeMinutes} onChange={setMaxAgeMinutes} disabled={running} unit="min" subtext="0 = No limit. Rejects older pools." />
                        </div>

                        <div className="mt-4 pt-4 border-t border-border">
                            <p className="text-[10px] text-muted-foreground font-bold tracking-widest uppercase mb-4">Scanner Criteria</p>
                            <div className="space-y-4">
                                <div className="grid grid-cols-2 gap-4">
                                    <SettingInput label="Slippage" value={slippage} onChange={setSlippage} disabled={running} unit="%" />
                                    <SettingInput label="Session Limits" value={maxPools} onChange={setMaxPools} disabled={running} unit="POOLS" />
                                </div>

                                <div className="h-[1px] bg-border/40 my-2"></div>

                                {/* 5m Volume Range */}
                                <div className="grid grid-cols-2 gap-4">
                                    <SettingInput label="5m Vol Min ($)" value={minVolume5m} onChange={setMinVolume5m} disabled={running} prefix="$" />
                                    <SettingInput label="5m Vol Max ($)" value={maxVolume5m} onChange={setMaxVolume5m} disabled={running} prefix="$" subtext="0 = No limit" />
                                </div>

                                {/* 1h Volume Range */}
                                <div className="grid grid-cols-2 gap-4">
                                    <SettingInput label="1h Vol Min ($)" value={minVolume} onChange={setMinVolume} disabled={running} prefix="$" />
                                    <SettingInput label="1h Vol Max ($)" value={maxVolume} onChange={setMaxVolume} disabled={running} prefix="$" subtext="0 = No limit" />
                                </div>

                                {/* 24h Volume Range */}
                                <div className="grid grid-cols-2 gap-4">
                                    <SettingInput label="24h Vol Min ($)" value={minVolume24h} onChange={setMinVolume24h} disabled={running} prefix="$" />
                                    <SettingInput label="24h Vol Max ($)" value={maxVolume24h} onChange={setMaxVolume24h} disabled={running} prefix="$" subtext="0 = No limit" />
                                </div>

                                {/* Liquidity Range */}
                                <div className="grid grid-cols-2 gap-4">
                                    <SettingInput label="Liquidity Min ($)" value={minLiquidity} onChange={setMinLiquidity} disabled={running} prefix="$" />
                                    <SettingInput label="Liquidity Max ($)" value={maxLiquidity} onChange={setMaxLiquidity} disabled={running} prefix="$" subtext="0 = No limit" />
                                </div>

                                {/* Mcap Range */}
                                <div className="grid grid-cols-2 gap-4">
                                    <SettingInput label="Mcap Min ($)" value={minMcap} onChange={setMinMcap} disabled={running} prefix="$" />
                                    <SettingInput label="Mcap Max ($)" value={maxMcap} onChange={setMaxMcap} disabled={running} prefix="$" subtext="0 = No limit" />
                                </div>

                            </div>
                        </div>

                        {/* Meteora Specific UI */}
                        <div className="mt-4 pt-4 border-t border-border space-y-4">
                            <p className="text-[10px] text-muted-foreground font-bold tracking-widest uppercase mb-1">Meteora Config</p>

                            <div className="flex flex-col gap-2">
                                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Fee Tier (%)</label>
                                <div className="grid grid-cols-4 gap-1">
                                    {[25, 100, 200, 400].map((bps) => (
                                        <button
                                            key={bps}
                                            onClick={() => setMeteoraFeeBps(bps)}
                                            disabled={running}
                                            className={`py-1.5 rounded text-[10px] font-bold border transition-all ${meteoraFeeBps === bps
                                                ? 'bg-primary/20 border-primary text-primary'
                                                : 'bg-input border-border text-muted-foreground hover:border-muted-foreground/50'
                                                }`}
                                        >
                                            {bps / 100}%
                                        </button>
                                    ))}
                                </div>
                                <span className="text-[9px] text-muted-foreground/60 italic">
                                    {meteoraFeeBps / 100}% LP fee for optimized routing
                                </span>
                            </div>
                        </div>

                        <div className="mt-4 pt-4 border-t border-border">
                            <div className="flex items-center justify-between mb-2">
                                <p className="text-[10px] text-muted-foreground font-bold tracking-widest uppercase">Security & API Access</p>
                                <ShieldAlert size={12} className="text-amber-500" />
                            </div>

                            <div className="flex flex-col gap-1.5 mb-4">
                                <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">API Secret Key</label>
                                <div className="relative">
                                    <input
                                        type={isSecretVisible ? "text" : "password"}
                                        value={apiSecret}
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            setApiSecret(val);
                                            localStorage.setItem('API_SECRET', val);
                                        }}
                                        placeholder="Enter your API_SECRET"
                                        className="w-full bg-input border border-border text-foreground px-2.5 py-1.5 rounded-md font-mono text-[11px] focus:outline-none focus:border-primary/50 transition-colors pr-8"
                                    />
                                    <button
                                        onClick={() => setIsSecretVisible(!isSecretVisible)}
                                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                                    >
                                        <Activity size={12} />
                                    </button>
                                </div>
                                <p className="text-[8px] text-muted-foreground/60 leading-tight"> Required to Lauch Bot or close positions. Match your .env file.</p>
                            </div>

                            <button
                                onClick={updatePrivateKey}
                                className="w-full flex items-center justify-center gap-2 py-2.5 bg-secondary hover:bg-secondary/80 text-muted-foreground hover:text-foreground text-[10px] font-bold rounded border border-border transition-all"
                            >
                                <Wallet size={12} />
                                UPDATE BOT WALLET
                            </button>
                            <p className="text-[9px] text-amber-500/60 mt-2 text-center leading-tight">
                                ⚠️ <b>WARNING:</b> Key swap is volatile and resets on server restart. Use a low-balance hot wallet.
                            </p>
                        </div>

                        <div className="mt-6 p-3 bg-white/5 rounded-md border border-dashed border-border flex items-center gap-3">
                            <Activity size={20} className={running ? "text-primary animate-pulse" : "text-muted-foreground"} />
                            <span className="text-[12px] text-muted-foreground">
                                {running ? "Monitoring market conditions..." : "Waiting for parameters..."}
                            </span>
                        </div>
                    </div>

                    {/* Action Card */}
                    <div className="bg-card border border-border rounded-lg p-5 flex flex-col items-center text-center gap-4">
                        <div className={`w-12 h-12 rounded-full flex items-center justify-center border transition-all ${running ? 'bg-primary/10 border-primary text-primary shadow-[0_0_15px_rgba(16,185,129,0.2)]' : 'bg-secondary border-border text-muted-foreground'}`}>
                            <Power size={24} />
                        </div>
                        <div>
                            <h3 className="text-sm font-semibold mb-1">System Status</h3>
                            <span className="text-[12px] text-muted-foreground">
                                {running ? "LPPP BOT Is Active" : "Ready to initialize"}
                            </span>
                        </div>
                        <button
                            onClick={toggleBot}
                            className={`w-full py-3 rounded-md font-bold flex items-center justify-center gap-2 transition-all text-sm
                                ${running
                                    ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/30'
                                    : 'bg-primary text-primary-foreground hover:opacity-90'
                                }`}
                        >
                            <Power size={16} />
                            {running ? 'STOP SCANNER' : 'LAUNCH LPPP BOT'}
                        </button>
                    </div>

                </div>

                {/* Middle Column: Stats & Display */}
                <div className="flex flex-col gap-6">
                    <div className="grid grid-cols-2 gap-6">
                        {/* Active Pools Stat */}
                        <div className="bg-card border border-border rounded-lg p-6 flex flex-col justify-between">
                            <div className="flex justify-between items-start">
                                <span className="text-[13px] text-muted-foreground font-medium">Active Pools</span>
                                <Droplets size={16} className="text-muted-foreground" />
                            </div>
                            <div className="text-3xl font-bold mt-3 font-mono">
                                {pools.filter(p => !p.exited).length}
                            </div>
                        </div>

                        {/* Wallet Portfolio */}
                        <div className="bg-card border border-border rounded-lg p-5 flex flex-col justify-between">
                            <div className="flex justify-between items-start mb-2">
                                <span className="text-[13px] text-muted-foreground font-medium">My Portfolio</span>
                                <Wallet size={16} className="text-muted-foreground" />
                            </div>
                            <div className="flex flex-col gap-2">
                                <div className="flex justify-between items-end">
                                    <span className="text-xs font-mono text-muted-foreground font-bold">SOL</span>
                                    <div className="text-right leading-none">
                                        <div className="font-bold text-base">{portfolio.sol.toFixed(3)}</div>
                                        <div className="text-[10px] text-muted-foreground mt-0.5">
                                            {solPrice ? `≈ $${(portfolio.sol * solPrice).toFixed(2)}` : '$-.--'}
                                        </div>
                                    </div>
                                </div>
                                <div className="h-[1px] bg-border/40"></div>
                                <div className="flex justify-between items-end">
                                    <span className="text-xs font-mono text-emerald-400 font-bold">LPPP</span>
                                    <div className="text-right leading-none">
                                        <div className="font-bold text-base text-emerald-400">{portfolio.lppp.toLocaleString()}</div>
                                        <div className="text-[10px] text-emerald-500/60 mt-0.5">
                                            {lpppPrice ? `≈ $${(portfolio.lppp * lpppPrice).toFixed(2)}` : '$-.--'}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Chart / Performance Area */}
                    <div className="bg-card border border-border rounded-lg p-5 flex-1 min-h-[300px] flex flex-col">
                        <div className="flex items-center justify-between mb-5">
                            <div className="flex items-center gap-2">
                                <LineChart size={18} className="text-muted-foreground" />
                                <h2 className="text-sm font-semibold">Performance</h2>
                            </div>
                            <div className="flex gap-1">
                                <button className="px-2 py-1 text-[10px] rounded border border-border text-muted-foreground hover:text-foreground">1H</button>
                                <button className="px-2 py-1 text-[10px] rounded border border-primary/50 text-primary bg-primary/10 font-bold">24H</button>
                            </div>
                        </div>

                        <div className="flex-1 border border-dashed border-border rounded-md bg-white/[0.01] flex items-center justify-center">
                            <div className="text-center">
                                <Activity size={32} className="text-muted mb-2 mx-auto" />
                                <p className="text-[13px] text-muted-foreground">Real-time stats coming soon</p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Right Column: Terminal */}
                <div className="bg-[#050505] border border-border rounded-lg flex flex-col h-[600px] overflow-hidden shadow-2xl relative">
                    <div className="bg-secondary p-2 px-4 border-b border-border flex items-center justify-between shrink-0">
                        <div className="flex gap-2">
                            <button
                                onClick={() => setActiveTab('terminal')}
                                className={`px-3 py-1 text-[11px] rounded transition-all font-bold ${activeTab === 'terminal' ? 'bg-primary/10 text-primary border border-primary/30' : 'text-muted-foreground hover:text-foreground border border-transparent'}`}
                            >
                                TERMINAL
                            </button>
                            <button
                                onClick={() => setActiveTab('chart')}
                                className={`px-3 py-1 text-[11px] rounded transition-all font-bold ${activeTab === 'chart' ? 'bg-primary/10 text-primary border border-primary/30' : 'text-muted-foreground hover:text-foreground border border-transparent'}`}
                            >
                                LIVE_CHART
                            </button>
                        </div>
                        <button onClick={clearLogs} className="text-[11px] text-muted-foreground hover:text-foreground px-2 py-1">CLEAR</button>
                    </div>

                    <div className="flex-1 relative overflow-hidden bg-black/40">
                        <AnimatePresence mode="wait">
                            {activeTab === 'terminal' ? (
                                <motion.div
                                    key="terminal"
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    className="absolute inset-0 p-4 overflow-y-auto font-mono text-[13px] text-primary space-y-2 leading-relaxed custom-scrollbar"
                                >
                                    {logs.length === 0 && (
                                        <div className="h-full flex flex-col items-center justify-center text-muted-foreground/30 gap-2">
                                            <Search size={24} />
                                            <span>Waiting for signals...</span>
                                        </div>
                                    )}
                                    {logs.map((log, i) => (
                                        <div key={i} className="flex gap-2 break-words">
                                            <span className="opacity-40 shrink-0 select-none">[{log.timestamp.split('T')[1].split('.')[0]}]</span>
                                            <span className={`flex-1 ${log.type === 'error' ? 'text-red-400' : log.type === 'warning' ? 'text-yellow-400' : log.type === 'success' ? 'text-emerald-400' : 'text-primary/90'}`}>
                                                {formatMessage(log.message)}
                                            </span>
                                        </div>
                                    ))}
                                    {running && (
                                        <div className="w-2 h-4 bg-primary/60 cursor-blink inline-block ml-1 align-middle"></div>
                                    )}
                                    <div ref={logsEndRef} />
                                </motion.div>
                            ) : (
                                <motion.div
                                    key="chart"
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    className="h-full w-full"
                                >
                                    <iframe
                                        src="https://dexscreener.com/solana/44sHXMkPeciUpqhecfCysVs7RcaxeM24VPMauQouBREV?embed=1&theme=dark"
                                        className="w-full h-full border-none"
                                        title="LPPP Chart"
                                    />
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </div>

                {/* Bottom Section: Active Snipes (Bot-Created Only) */}
                <div className="lg:col-span-3">
                    <div className="flex items-center gap-3 mb-6 px-2">
                        <Zap size={18} className="text-pink-500" />
                        <h2 className="text-sm font-black tracking-widest uppercase text-pink-500">Active Snipes</h2>
                        <span className="bg-pink-500/10 text-pink-400 text-[10px] px-2 py-0.5 rounded-full border border-pink-500/20 font-bold">
                            {pools.filter(p => !p.exited && p.isBotCreated).length}
                        </span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {pools.filter(p => !p.exited && p.isBotCreated).map(pool => (
                            <PoolCard
                                key={pool.poolId}
                                pool={pool}
                                isBot={true}
                                claimFees={claimFees}
                                increaseLiquidity={increaseLiquidity}
                                withdrawLiquidity={withdrawLiquidity}
                                lpppPrice={lpppPrice}
                            />
                        ))}
                        {pools.filter(p => !p.exited && p.isBotCreated).length === 0 && (
                            <div className="col-span-full py-16 text-center bg-pink-500/[0.02] border border-dashed border-pink-500/10 rounded-lg flex flex-col items-center gap-3">
                                <Zap size={40} className="opacity-15 text-pink-500" />
                                <p className="text-sm font-medium text-muted-foreground/50">Waiting for bot to snipe...</p>
                                <p className="text-[10px] text-muted-foreground/30">Pools will appear here when the bot creates them</p>
                            </div>
                        )}
                    </div>
                </div>
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
