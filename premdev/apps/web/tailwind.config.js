/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#0a0a0f",
          subtle: "#11111a",
          panel: "#16161f",
          hover: "#1d1d28",
          border: "#252532",
        },
        text: {
          DEFAULT: "#e6e6f0",
          muted: "#9090a0",
          subtle: "#606070",
        },
        accent: {
          DEFAULT: "#7c5cff",
          hover: "#9b80ff",
          muted: "#5b3fd9",
        },
        success: "#22c55e",
        warning: "#f59e0b",
        danger: "#ef4444",
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "Fira Code",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      boxShadow: {
        glow: "0 0 24px rgba(124, 92, 255, 0.35)",
      },
    },
  },
  plugins: [],
};
