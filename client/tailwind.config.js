/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                background: '#0f1111',
                foreground: '#e6f7f2',
                border: '#ffffff14',
                input: '#1a1a1a',
                primary: {
                    DEFAULT: '#10b981',
                    foreground: '#000000',
                },
                secondary: {
                    DEFAULT: '#1a1a1a',
                    foreground: '#ffffff',
                },
                muted: {
                    DEFAULT: '#262626',
                    foreground: '#a3a3a3',
                },
                accent: {
                    DEFAULT: '#10b981',
                    foreground: '#ffffff',
                },
                card: {
                    DEFAULT: '#0a0a0a',
                    foreground: '#ffffff',
                },
            },
            borderRadius: {
                lg: 'var(--radius-lg)',
                md: 'var(--radius-md)',
                sm: 'var(--radius-sm)',
            },
            fontFamily: {
                mono: ['SFMono-Regular', 'Consolas', 'Liberation Mono', 'Menlo', 'Courier', 'monospace'],
            },
        },
    },
    plugins: [],
}
