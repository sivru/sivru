/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "sivru-bg": "#0f1115",
        "sivru-panel": "#161a21",
        "sivru-border": "#262b35",
        "sivru-text": "#d6d8dd",
        "sivru-mute": "#7a8390",
        // Brand accent — soft warm gold. Used for active / positive states
        // (sivru.search rows, latest pulse, the search amber chip).
        "sivru-amber": "#d4a056",
        // Warning amber — slightly brighter than the brand accent so it
        // reads distinctly when both appear on the same row (e.g. a search
        // chip next to an interrupted-turn dot). Used for missed-opportunity
        // chips and interrupted-turn outcome dots.
        "sivru-warn": "#fbbf24",
      },
      fontFamily: {
        sans: ["Geist", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["Geist Mono", "ui-monospace", "Menlo", "monospace"],
      },
      borderRadius: {
        sivru: "4px",
      },
    },
  },
  plugins: [],
};
