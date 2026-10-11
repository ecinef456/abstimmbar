import { createPreset } from "@basicbar/ui/tailwind-preset";

/**
 * Abstimmbar design tokens.
 *
 * Structure and conventions (shade semantics, dark mode, font, motion) come
 * from the shared @basicbar/ui preset; the OKLCH color ramps below are
 * Abstimmbar's identity and stay in the tool: a fresh green accent
 * (hue ≈ 150; decided July 2026) over slightly cool-tinted neutrals.
 * Values are tuned for WCAG AA — slate-400 (muted text) reaches ≥4.5:1 on
 * white/slate-50/100 and, lifted in dark mode, on the dark surfaces; CTAs use
 * brand-400 with dark ink text, brand-600 is the focus/selection color,
 * brand-700 is accent text on white. Adjusting the accent means editing only
 * this ramp.
 */

/** @type {import('tailwindcss').Config} */
export default {
  presets: [
    createPreset({
      colors: {
        // Keep the `/ <alpha-value>` placeholder on every token — without it
        // Tailwind's opacity modifier (e.g. `bg-slate-900/90`) renders
        // transparent.
        slate: {
          50: "oklch(0.985 0.002 220 / <alpha-value>)",
          100: "oklch(0.962 0.003 220 / <alpha-value>)",
          200: "oklch(0.922 0.005 220 / <alpha-value>)",
          300: "oklch(0.868 0.007 220 / <alpha-value>)",
          // Muted text in both themes: a CSS variable so dark mode can lift it
          // (index.css) — one value can't reach 4.5:1 on light and dark (#178).
          400: "oklch(var(--ab-slate-400) / <alpha-value>)",
          500: "oklch(0.498 0.013 220 / <alpha-value>)",
          600: "oklch(0.43 0.014 220 / <alpha-value>)",
          700: "oklch(0.36 0.013 220 / <alpha-value>)",
          800: "oklch(0.28 0.011 220 / <alpha-value>)",
          900: "oklch(0.215 0.011 220 / <alpha-value>)",
          950: "oklch(0.16 0.009 220 / <alpha-value>)",
        },
        brand: {
          50: "oklch(0.975 0.015 150 / <alpha-value>)",
          100: "oklch(0.945 0.04 150 / <alpha-value>)",
          200: "oklch(0.9 0.07 149 / <alpha-value>)",
          300: "oklch(0.865 0.1 148 / <alpha-value>)",
          400: "oklch(0.84 0.13 147 / <alpha-value>)",
          500: "oklch(0.78 0.13 146 / <alpha-value>)",
          600: "oklch(0.62 0.12 150 / <alpha-value>)",
          700: "oklch(0.5 0.1 152 / <alpha-value>)",
          800: "oklch(0.42 0.08 153 / <alpha-value>)",
          900: "oklch(0.35 0.065 154 / <alpha-value>)",
          950: "oklch(0.26 0.045 155 / <alpha-value>)",
        },
      },
    }),
  ],
  // The @basicbar/ui components carry Tailwind classes of their own — scan
  // the package dist so those classes reach the generated CSS.
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "./node_modules/@basicbar/ui/dist/**/*.js",
  ],
  plugins: [],
};
