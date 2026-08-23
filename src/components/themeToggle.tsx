"use client";
import React, { useEffect, useState } from "react";
import LordIcon from "./ui/lordIcon";

type Theme = "dark" | "light";

const STORAGE_KEY = "8sleep-theme";

export const ThemeToggle: React.FC = () => {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const attribute = document.documentElement.getAttribute("data-theme");
    setTheme(attribute === "light" ? "light" : "dark");
  }, []);

  const flip = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    const root = document.documentElement;
    // Repainting every token at once looks like a glitch, so suppress
    // transitions for one frame while the attribute swaps.
    root.classList.add("theme-switching");
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode — the choice just does not persist */
    }
    setTheme(next);
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() =>
        root.classList.remove("theme-switching"),
      ),
    );
  };

  return (
    <button
      type="button"
      id="theme-toggle"
      onClick={flip}
      className="btn btn-ghost"
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Light mode" : "Dark mode"}
    >
      <LordIcon
        name={theme === "dark" ? "sun" : "moon"}
        size={20}
        trigger="hover"
        target="#theme-toggle"
        color="var(--text-muted)"
        colorSecondary="var(--accent)"
      />
    </button>
  );
};
