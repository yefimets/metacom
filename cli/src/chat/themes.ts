import type { Theme } from "@/components/ui/types";
import { catppuccinTheme } from "@/lib/terminal-themes/catppuccin";
import { defaultTheme } from "@/lib/terminal-themes/default";
import { draculaTheme } from "@/lib/terminal-themes/dracula";
import { githubTheme } from "@/lib/terminal-themes/github";
import { gruvboxTheme } from "@/lib/terminal-themes/gruvbox";
import { nordTheme } from "@/lib/terminal-themes/nord";
import { oneDarkTheme } from "@/lib/terminal-themes/one-dark";
import { rosepineTheme } from "@/lib/terminal-themes/rosepine";
import { solarizedTheme } from "@/lib/terminal-themes/solarized";
import { tokyoNightTheme } from "@/lib/terminal-themes/tokyo-night";

/// termcn themes bundled with the chat. Pick with --theme, MC_THEME or /theme.
export const THEMES: Record<string, Theme> = {
  default: defaultTheme,
  catppuccin: catppuccinTheme,
  dracula: draculaTheme,
  github: githubTheme,
  gruvbox: gruvboxTheme,
  nord: nordTheme,
  "one-dark": oneDarkTheme,
  "rose-pine": rosepineTheme,
  solarized: solarizedTheme,
  "tokyo-night": tokyoNightTheme,
};

export const themeNames = (): string[] => Object.keys(THEMES);
export const themeByName = (name?: string | null): Theme | null => (name ? THEMES[name.toLowerCase()] ?? null : null);
