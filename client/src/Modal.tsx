import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ShieldAlert, CheckCircle2, Info, AlertTriangle } from 'lucide-react';

interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm?: (inputValue?: string) => void;
    onCancel?: () => void;
    title: string;
    message: string;
    type?: 'info' | 'success' | 'error' | 'warning';
    showInput?: boolean;
    inputPlaceholder?: string;
    defaultValue?: string;
}

export const Modal = ({
    isOpen,
    onClose,
    onConfirm,
    onCancel,
    title,
    message,
    type = 'info',
    showInput = false,
    inputPlaceholder = "Enter value...",
    defaultValue = ""
}: ModalProps) => {
    const [localInput, setLocalInput] = useState(defaultValue);

    useEffect(() => {
        if (isOpen) setLocalInput(defaultValue);
    }, [isOpen, defaultValue]);

    const icons = {
        info: <Info className="text-blue-400 w-6 h-6" />,
        success: <CheckCircle2 className="text-emerald-400 w-6 h-6" />,
        error: <ShieldAlert className="text-rose-400 w-6 h-6" />,
        warning: <AlertTriangle className="text-amber-400 w-6 h-6" />
    };

    const colors = {
        info: 'border-blue-500/20 shadow-blue-500/10',
        success: 'border-emerald-500/20 shadow-emerald-500/10',
        error: 'border-rose-500/20 shadow-rose-500/10',
        warning: 'border-amber-500/20 shadow-amber-500/10'
    };

    const accentColors = {
        info: 'blue',
        success: 'emerald',
        error: 'rose',
        warning: 'amber'
    };

    const handleConfirm = () => {
        if (onConfirm) onConfirm(localInput);
        onClose();
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onCancel || onClose}
                        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                    />

                    {/* Modal Content */}
                    <motion.div
                        initial={{ opacity: 0, scale: 0.95, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 10 }}
                        className={`relative w-full max-w-md bg-[#0f1111]/90 border ${colors[type]} rounded-2xl p-6 shadow-2xl backdrop-blur-md overflow-hidden`}
                    >
                        {/* Accent Glow */}
                        <div className={`absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-${accentColors[type]}-500/50 to-transparent`} />

                        <div className="flex items-start justify-between mb-4">
                            <div className="flex items-center gap-3">
                                <div className={`p-2 rounded-xl bg-${accentColors[type]}-500/10`}>
                                    {icons[type]}
                                </div>
                                <h3 className="text-lg font-semibold text-foreground tracking-tight">{title}</h3>
                            </div>
                            <button
                                onClick={onCancel || onClose}
                                className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/5 transition-all"
                            >
                                <X size={18} />
                            </button>
                        </div>

                        <div className="mb-6">
                            <p className="text-sm text-muted-foreground leading-relaxed">
                                {message}
                            </p>
                        </div>

                        {showInput && (
                            <div className="mb-6">
                                <input
                                    type="text"
                                    value={localInput}
                                    onChange={(e) => setLocalInput(e.target.value)}
                                    placeholder={inputPlaceholder}
                                    className="w-full bg-input border border-border text-foreground px-4 py-3 rounded-xl font-mono text-sm focus:outline-none focus:border-primary/50 transition-colors"
                                    autoFocus
                                />
                            </div>
                        )}

                        <div className="flex justify-end gap-3">
                            {onCancel && (
                                <button
                                    onClick={onCancel}
                                    className="px-6 py-2.5 border border-border text-foreground text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-white/5 transition-all"
                                >
                                    Cancel
                                </button>
                            )}
                            <button
                                onClick={handleConfirm}
                                className={`px-6 py-2.5 bg-foreground text-background text-xs font-bold uppercase tracking-widest rounded-lg hover:opacity-90 active:scale-95 transition-all shadow-lg shadow-black/20`}
                            >
                                {onCancel ? 'Continue' : 'Confirm'}
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};
