
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
    Search
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
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
    <div className="flex flex-col gap-1.5 mb-4 last:mb-0">
        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{label}</label>
        <div className="relative">
            {prefix && (
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">{prefix}</span>
            )}
            <input
                type="number"
                value={value}
                onChange={(e) => onChange(Number(e.target.value))}
                disabled={disabled}
                className={`w-full bg-input border border-border text-foreground px-3 py-2 rounded-md font-mono text-sm focus:outline-none focus:border-primary/50 transition-colors ${prefix ? 'pl-7' : ''} ${unit ? 'pr-12' : ''}`}
            />
            {unit && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-bold text-primary/60">{unit}</span>
            )}
        </div>
        {subtext && (
            <span className="text-[10px] text-muted-foreground/60 italic">{subtext}</span>
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

    // Scan Criteria
    const [buyAmount, setBuyAmount] = useState(0.1);
    const [lpppAmount, setLpppAmount] = useState(1000);
    const [minVolume, setMinVolume] = useState(100000);
    const [minLiquidity, setMinLiquidity] = useState(60000);
    const [minMcap, setMinMcap] = useState(60000);

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
        socket.on('pool', (pool: Pool) => {
            setPools(prev => [...prev.slice(-19), pool]);
        });
        return () => {
            socket.off('connect');
            socket.off('status');
            socket.off('log');
            socket.off('logHistory');
            socket.off('pool');
        };
    }, []);

    // Fetch SOL Price periodically
    useEffect(() => {
        const fetchPrice = async () => {
            try {
                // Fallback to CoinGecko if Jupiter fails (Jupiter V2 requires Key)
                const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
                const data = await res.json();

                if (data && data.solana && data.solana.usd) {
                    setSolPrice(data.solana.usd);
                } else {
                    // Critical Fallback to keep UI working
                    console.warn("API Error, using fallback price");
                    setSolPrice(190.00);
                }
            } catch (e) {
                console.error("Price fetch error, using fallback:", e);
                setSolPrice(190.00);
            }
        };

        fetchPrice();
        const interval = setInterval(fetchPrice, 60000);
        return () => clearInterval(interval);
    }, []);

    const toggleBot = async () => {
        // Prepare units for backend (must be native)
        const finalBuy = isBuyUsd && solPrice ? buyAmount / solPrice : buyAmount;

        const endpoint = running ? '/api/stop' : '/api/start';
        const body = running ? {} : {
            buyAmount: finalBuy,
            lpppAmount,
            minVolume1h: minVolume,
            minLiquidity,
            minMcap
        };

        await fetch(`${BACKEND_URL}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
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
                            {solPrice && (
                                <span className="text-[10px] text-muted-foreground font-mono bg-white/5 px-2 py-0.5 rounded border border-border">SOL: ${solPrice.toFixed(2)}</span>
                            )}
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

                        <SettingInput
                            label="LP Size ($LPPP)"
                            value={lpppAmount}
                            onChange={setLpppAmount}
                            disabled={running}
                            unit="LPPP"
                        />

                        <div className="mt-4 pt-4 border-t border-border space-y-4">
                            <p className="text-[10px] text-muted-foreground font-bold tracking-widest uppercase">Scanner Criteria</p>
                            <SettingInput label="Min 1h Vol ($)" value={minVolume} onChange={setMinVolume} disabled={running} prefix="$" />
                            <SettingInput label="Min Liquidity ($)" value={minLiquidity} onChange={setMinLiquidity} disabled={running} prefix="$" />
                            <SettingInput label="Min Mcap ($)" value={minMcap} onChange={setMinMcap} disabled={running} prefix="$" />
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

                        {/* Total Volume Stat */}
                        <div className="bg-card border border-border rounded-lg p-6 flex flex-col justify-between">
                            <div className="flex justify-between items-start">
                                <span className="text-[13px] text-muted-foreground font-medium">Total Volume</span>
                                <BarChart3 size={16} className="text-muted-foreground" />
                            </div>
                            <div className="text-3xl font-bold mt-3 font-mono">
                                $0.00
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
                        {pools.map(pool => (
                            <div key={pool.poolId} className="bg-secondary border border-border p-4 rounded-md flex justify-between items-center group hover:border-primary/50 transition-colors">
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
                                    <p className="text-xl font-bold text-white group-hover:text-primary transition-colors">{pool.roi}</p>
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
        </div>
    );
}

export default App;
