import type { Config } from "tailwindcss";

import { fontFamily } from "tailwindcss/defaultTheme";

const config = {
  darkMode: ["class"],
  content: [
    "./pages/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./app/**/*.{ts,tsx}",
    "./src/**/*.{ts,tsx}",
  ],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        // Semantic tokens (see src/styles/globals.css). Components reference
        // these, never a raw hex.
        ink: {
          DEFAULT: "var(--text)",
          headline: "var(--text-headline)",
          muted: "var(--text-muted)",
          faint: "var(--text-faint)",
        },
        surface: {
          DEFAULT: "var(--surface)",
          raised: "var(--surface-raised)",
          hover: "var(--surface-hover)",
          sunken: "var(--surface-sunken)",
        },
        line: {
          DEFAULT: "var(--border)",
          strong: "var(--border-strong)",
        },
        brand: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-hover)",
          ink: "var(--accent-ink)",
          soft: "var(--accent-soft)",
        },
        warm: { DEFAULT: "var(--warm)", soft: "var(--warm-soft)" },
        cool: { DEFAULT: "var(--cool)", soft: "var(--cool-soft)" },
        good: { DEFAULT: "var(--success)", soft: "var(--success-soft)" },
        warn: { DEFAULT: "var(--warning)", soft: "var(--warning-soft)" },
        bad: { DEFAULT: "var(--danger)", soft: "var(--danger-soft)" },
        stage: {
          awake: "var(--stage-awake)",
          rem: "var(--stage-rem)",
          light: "var(--stage-light)",
          deep: "var(--stage-deep)",
        },

        // shadcn compatibility (Button variants keep working).
        border: "hsl(var(--input))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", ...fontFamily.sans],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 4px)",
        sm: "calc(var(--radius) - 7px)",
      },
      // Motion canon §1-2 tokens, usable as Tailwind utilities.
      transitionDuration: {
        instant: "var(--motion-instant)",
        fast: "var(--motion-fast)",
        base: "var(--motion-base)",
        slow: "var(--motion-slow)",
        expressive: "var(--motion-expressive)",
      },
      transitionTimingFunction: {
        snap: "var(--ease-out-snap)",
        quart: "var(--ease-out-quart)",
        expo: "var(--ease-out-expo)",
        "in-out": "var(--ease-in-out)",
        "in-soft": "var(--ease-in-soft)",
      },
      boxShadow: {
        card: "var(--shadow-card)",
        pop: "var(--shadow-pop)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0", opacity: "0" },
          to: { height: "var(--radix-accordion-content-height)", opacity: "1" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)", opacity: "1" },
          to: { height: "0", opacity: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down var(--motion-base) var(--ease-out-snap)",
        "accordion-up": "accordion-up var(--motion-fast) var(--ease-in-soft)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;

export default config;
