/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class', // 启用 class 策略，通过 dark: 类名控制深色模式
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 参考 macOS QuickTime 的配色
        'player-bg': '#1a1a1a',
        'player-sidebar': '#2a2a2a',
        'player-accent': '#007AFF', // macOS 蓝色
      },
      backdropBlur: {
        'xl': '16px',
      },
      borderRadius: {
        '2xl': '16px',
        '3xl': '24px',
      },
      animation: {
        'spin-slow': 'rotate 20s linear infinite',
      }
    },
  },
  plugins: [],
}