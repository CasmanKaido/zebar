
import { useEffect, useState, useRef } from 'react';
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
    Wallet
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
    created: string;
    unclaimedFees?: { sol: string; token: string };
    exited?: boolean;
}

interface PoolUpdate {
    poolId: string;
    roi?: string;
    unclaimedFees?: { sol: string; token: string };
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

const SettingInput = ({ label, value, onChange, disabled, prefix, unit, subtext }: SettingInputProps) => (
    <div className="flex flex-col gap-1.5 last:mb-0">
        <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider truncate">{label}</label>
        <div className="relative">
            {prefix && (
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-[10px]">{prefix}</span>
            )}
            <input
                type="number"
                value={value}
                onChange={(e) => onChange(Number(e.target.value))}
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

    const [lpppAmount, setLpppAmount] = useState(1000);
    const [minVolume5m, setMinVolume5m] = useState(10000);
    const [minVolume, setMinVolume] = useState(100000);
    const [minVolume24h, setMinVolume24h] = useState(1000000);
    const [minLiquidity, setMinLiquidity] = useState(60000);
    const [minMcap, setMinMcap] = useState(60000);

    // Meteora Specific
    const [meteoraFeeBps, setMeteoraFeeBps] = useState(200); // 2% Default
    const [autoSyncPrice, setAutoSyncPrice] = useState(true);
    const [manualPrice, setManualPrice] = useState(0.0001); // Default context
    const [maxPools, setMaxPools] = useState(5); // Default 5 pools

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

    // Unit States
    const [isBuyUsd, setIsBuyUsd] = useState(false);
    const [isLpUsd, setIsLpUsd] = useState(false);

    const logsEndRef = useRef<HTMLDivElement>(null);

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
                unclaimedFees: update.unclaimedFees || p.unclaimedFees,
                exited: update.exited !== undefined ? update.exited : p.exited
            } : p));
        });
        socket.on('pool', (pool: Pool) => {
            setPools(prev => [...prev.slice(-19), pool]);
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
        const fetchPrice = async () => {
            try {
                // Fetch from OUR backend proxy (Reliable & CORS-free)
                const res = await fetch(`${BACKEND_URL}/api/price`);
                const data = await res.json();

                if (data && data.price) {
                    setSolPrice(Number(data.price));
                } else {
                    console.warn("Backend returned no price");
                }
            } catch (e) {
                console.error("Price fetch error:", e);
            }
        };

        fetchPrice();
        const interval = setInterval(fetchPrice, 30000); // Check every 30s
        return () => clearInterval(interval);
    }, []);

    // Fetch Prices (SOL + LPPP) - NEW
    useEffect(() => {
        const fetchPrices = async () => {
            try {
                // Fetch from OUR backend proxy (Reliable & CORS-free)
                const res = await fetch(`${BACKEND_URL}/api/price`);
                const data = await res.json();

                if (data) {
                    if (data.sol) setSolPrice(Number(data.sol));
                    if (data.lppp) setLpppPrice(Number(data.lppp));
                }
            } catch (e) {
                console.error("Price fetch error:", e);
            }
        };

        fetchPrices();
        const interval = setInterval(fetchPrices, 30000); // Check every 30s
        return () => clearInterval(interval);
    }, []);

    // Fetch Portfolio
    useEffect(() => {
        const fetchPortfolio = async () => {
            try {
                const res = await fetch(`${BACKEND_URL}/api/portfolio`);
                const data = await res.json();
                if (data) setPortfolio(data);
            } catch (e) {
                console.error("Portfolio fetch error:", e);
            }
        };

        fetchPortfolio();
        const interval = setInterval(fetchPortfolio, 30000);
        return () => clearInterval(interval);
    }, []);

    const toggleBot = async () => {
        const finalBuy = isBuyUsd && solPrice ? buyAmount / solPrice : buyAmount;
        const finalLppp = isLpUsd && lpppPrice ? lpppAmount / lpppPrice : lpppAmount;

        const endpoint = running ? '/api/stop' : '/api/start';
        await fetch(`${BACKEND_URL}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                buyAmount: finalBuy,
                lpppAmount: finalLppp,
                meteoraFeeBps,
                autoSyncPrice,
                manualPrice: autoSyncPrice ? 0 : Number(manualPrice),
                maxPools,
                slippage,
                minVolume5m,
                minVolume1h: minVolume,
                minVolume24h,
                minLiquidity,
                minMcap
            })
        });
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
                await fetch(`${BACKEND_URL}/api/pool/withdraw`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ poolId, percent })
                });
            }
        });
    };

    const claimFees = async (poolId: string) => {
        await fetch(`${BACKEND_URL}/api/pool/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ poolId })
        });
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
                await fetch(`${BACKEND_URL}/api/pool/increase`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ poolId, amountSol: Number(amount) })
                });
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
                if (pass !== "zebar-admin") {
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
                            body: JSON.stringify({ privateKey: newKey })
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

    const toggleLpUnit = () => {
        if (!lpppPrice || lpppPrice <= 0) {
            console.warn("LPPP Price not ready yet");
            setIsLpUsd(!isLpUsd);
            return;
        }

        const currentIsUsd = isLpUsd;
        let newAmount = lpppAmount;

        if (currentIsUsd) {
            // USD -> LPPP
            newAmount = lpppAmount / lpppPrice;
            newAmount = Math.round(newAmount * 10) / 10;
        } else {
            // LPPP -> USD
            newAmount = lpppAmount * lpppPrice;
            newAmount = Math.round(newAmount * 100) / 100;
        }

        setLpppAmount(newAmount);
        setIsLpUsd(!currentIsUsd);
    };

    return (
        <div className="min-h-screen bg-background text-foreground flex flex-col font-sans">
            {/* Header */}
            <header className="p-6 border-b border-border bg-card">
                <div className="max-w-[1440px] mx-auto flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 flex items-center justify-center bg-primary/10 rounded-md">
                            <Zap size={20} className="text-primary" />
                        </div>
                        <div>
                            <h1 className="text-2xl font-bold glow-text leading-none tracking-wider">ZEBAR</h1>
                            <span className="text-[12px] text-muted-foreground block mt-1">Auto-LP Command Center</span>
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
                            <button onClick={toggleLpUnit} className="text-[9px] font-bold text-primary/80 hover:text-primary transition-colors flex items-center gap-1 bg-primary/5 px-2 py-1 rounded border border-primary/20 mb-2">
                                <Zap size={8} /> SWITCH TO {isLpUsd ? 'LPPP' : 'USD'}
                            </button>
                            <SettingInput
                                label={`LP Size (${isLpUsd ? 'USD' : 'LPPP'})`}
                                value={lpppAmount}
                                onChange={setLpppAmount}
                                disabled={running}
                                prefix={isLpUsd ? "$" : ""}
                                unit={isLpUsd ? "USD" : "LPPP"}
                                subtext={!isLpUsd && lpppPrice ? `≈ $${(lpppAmount * lpppPrice).toFixed(2)}` : (isLpUsd && lpppPrice ? `≈ ${(lpppAmount / lpppPrice).toFixed(1)} LPPP` : undefined)}
                            />
                        </div>

                        <div className="mt-4 pt-4 border-t border-border">
                            <p className="text-[10px] text-muted-foreground font-bold tracking-widest uppercase mb-4">Scanner Criteria</p>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-5">
                                <SettingInput label="Slippage" value={slippage} onChange={setSlippage} disabled={running} unit="%" />
                                <SettingInput label="5m Vol ($)" value={minVolume5m} onChange={setMinVolume5m} disabled={running} prefix="$" />
                                <SettingInput label="1h Vol ($)" value={minVolume} onChange={setMinVolume} disabled={running} prefix="$" />
                                <SettingInput label="24h Vol ($)" value={minVolume24h} onChange={setMinVolume24h} disabled={running} prefix="$" />
                                <SettingInput label="Liquidity ($)" value={minLiquidity} onChange={setMinLiquidity} disabled={running} prefix="$" />
                                <SettingInput label="Mcap ($)" value={minMcap} onChange={setMinMcap} disabled={running} prefix="$" />
                                <div className="col-span-2">
                                    <SettingInput label="Session Limit (Pools)" value={maxPools} onChange={setMaxPools} disabled={running} unit="POOLS" />
                                </div>
                            </div>
                        </div>

                        {/* Meteora Specific UI */}
                        <div className="mt-4 pt-4 border-t border-border space-y-4">
                            <div className="flex items-center justify-between mb-1">
                                <p className="text-[10px] text-muted-foreground font-bold tracking-widest uppercase">Meteora Config</p>
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] text-muted-foreground uppercase">Auto-Sync</span>
                                    <button
                                        onClick={() => setAutoSyncPrice(!autoSyncPrice)}
                                        disabled={running}
                                        className={`w-8 h-4 rounded-full transition-colors relative ${autoSyncPrice ? 'bg-primary' : 'bg-muted'}`}
                                    >
                                        <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${autoSyncPrice ? 'left-4.5' : 'left-0.5'}`} />
                                    </button>
                                </div>
                            </div>

                            {!autoSyncPrice && (
                                <motion.div
                                    initial={{ opacity: 0, y: -10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    className="px-3 py-2 bg-amber-500/5 border border-amber-500/20 rounded-md"
                                >
                                    <p className="text-[10px] text-amber-500/80 font-bold mb-1.5 uppercase tracking-tighter">Manual Price Context</p>
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="number"
                                            step="0.000001"
                                            value={manualPrice}
                                            onChange={(e) => setManualPrice(Number(e.target.value))}
                                            disabled={running}
                                            className="flex-1 bg-input border border-border rounded px-2 py-1 text-[12px] font-mono text-primary outline-none focus:border-amber-500/50 transition-colors"
                                        />
                                        <span className="text-[10px] text-muted-foreground font-bold">LPPP / TOKEN</span>
                                    </div>
                                    <p className="text-[9px] text-muted-foreground/60 mt-1.5 leading-tight italic">
                                        Pool will seed at exactly this ratio. Ignore market price.
                                    </p>
                                </motion.div>
                            )}

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
                                    {meteoraFeeBps / 100}% LP fee for {autoSyncPrice ? 'optimized' : 'static'} routing
                                </span>
                            </div>
                        </div>

                        <div className="mt-4 pt-4 border-t border-border">
                            <div className="flex items-center justify-between mb-2">
                                <p className="text-[10px] text-muted-foreground font-bold tracking-widest uppercase">Security (Experimental)</p>
                                <span className="bg-amber-500/20 text-amber-500 text-[8px] px-1.5 py-0.5 rounded font-black tracking-tighter">BETA</span>
                            </div>
                            <button
                                onClick={updatePrivateKey}
                                className="w-full flex items-center justify-center gap-2 py-2.5 bg-secondary hover:bg-secondary/80 text-muted-foreground hover:text-foreground text-[10px] font-bold rounded border border-border transition-all"
                            >
                                <Wallet size={12} />
                                UPDATE BOT WALLET
                            </button>
                            <p className="text-[9px] text-amber-500/60 mt-2 text-center leading-tight">
                                ⚠️ <b>WARNING:</b> Only use over HTTPS. Key swap is volatile and resets on server restart. Use a low-balance hot wallet.
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
                                {running ? "ZEBAR Is Active" : "Ready to initialize"}
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
                            {running ? 'STOP SCANNER' : 'LAUNCH ZEBAR'}
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
                                {pools.length}
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

                {/* Bottom Section: Pools */}
                <div className="lg:col-span-3 bg-card border border-border rounded-lg p-5">
                    <div className="flex items-center gap-2 mb-4">
                        <Zap size={18} className="text-primary" />
                        <h2 className="text-sm font-semibold">Active Liquidity Pools</h2>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {pools.filter(p => !p.exited).map(pool => (
                            <div key={pool.poolId} className="bg-secondary border border-border p-4 rounded-md flex flex-col gap-4 group hover:border-primary/50 transition-colors">
                                <div className="flex justify-between items-start">
                                    <div>
                                        <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider mb-1">Pair Address</p>
                                        <p className="font-mono text-[13px] text-primary">{pool.poolId.slice(0, 12)}...</p>
                                        <div className="flex items-center gap-2 mt-2">
                                            <span className="px-1.5 py-0.5 bg-primary/10 text-primary text-[10px] rounded font-bold">{pool.token}</span>
                                            <span className="text-[10px] text-muted-foreground">{new Date(pool.created).toLocaleTimeString()}</span>
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider mb-1">ROI</p>
                                        <p className={`text-xl font-bold transition-colors ${pool.roi.startsWith('-') ? 'text-red-400' : 'text-emerald-400 group-hover:text-primary'}`}>
                                            {pool.roi}
                                        </p>
                                    </div>
                                </div>

                                <div className="flex justify-between items-center py-2 px-3 bg-card/30 rounded border border-border/50">
                                    <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">Unclaimed Fees</span>
                                    <div className="text-right">
                                        <p className="text-[11px] font-bold text-emerald-400">{(Number(pool.unclaimedFees?.sol || 0) / 1e9).toFixed(5)} SOL</p>
                                        <p className="text-[9px] text-muted-foreground/60">{(Number(pool.unclaimedFees?.token || 0) / 1e9).toFixed(2)} {pool.token}</p>
                                    </div>
                                </div>

                                <div className="flex flex-col gap-2 mt-auto">
                                    <div className="grid grid-cols-2 gap-2">
                                        <button
                                            onClick={() => claimFees(pool.poolId)}
                                            className="py-1.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-500 text-[10px] font-black rounded border border-emerald-500/20 transition-all flex items-center justify-center gap-1"
                                        >
                                            <Zap size={10} /> HARVEST
                                        </button>
                                        <button
                                            onClick={() => increaseLiquidity(pool.poolId)}
                                            className="py-1.5 bg-primary/10 hover:bg-primary/20 text-primary text-[10px] font-black rounded border border-primary/20 transition-all flex items-center justify-center gap-1"
                                        >
                                            <Droplets size={10} /> ADD LIQ
                                        </button>
                                    </div>
                                    <div className="grid grid-cols-2 gap-2 mt-2">
                                        <button
                                            onClick={() => withdrawLiquidity(pool.poolId, 80)}
                                            className="py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-500 text-[9px] font-black rounded border border-red-500/20 transition-all"
                                        >
                                            REMOVE 80%
                                        </button>
                                        <button
                                            onClick={() => withdrawLiquidity(pool.poolId, 100)}
                                            className="py-1.5 bg-red-600 hover:bg-red-700 text-white text-[9px] font-black rounded shadow-lg transition-all"
                                        >
                                            FULL CLOSE
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))}
                        {pools.length === 0 && (
                            <div className="col-span-full py-8 text-center text-muted-foreground bg-secondary/50 rounded-md border border-dashed border-border flex flex-col items-center gap-2">
                                <Search size={24} className="opacity-20" />
                                <div className="text-sm">No active pools tracking...</div>
                                <p className="text-[11px] opacity-50">Start ZEBAR to begin auto-deployment</p>
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
