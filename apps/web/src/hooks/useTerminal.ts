import { useCallback, useEffect, useRef, type RefObject } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";

export interface TerminalSize {
  cols: number;
  rows: number;
}

interface UseTerminalOptions {
  terminalNodeRef: RefObject<HTMLDivElement | null>;
  onData: (data: string) => void;
  onResize: (size: TerminalSize) => void;
}

const TERMINAL_THEMES: readonly ITheme[] = [
  {
    background: "#0d1117",
    foreground: "#c9d1d9",
    cursor: "#58a6ff",
    cursorAccent: "#0d1117",
    selectionBackground: "#264f78",
    black: "#484f58",
    red: "#ff7b72",
    green: "#7ee787",
    yellow: "#d29922",
    blue: "#58a6ff",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#f0f6fc"
  },
  {
    background: "#2f343b",
    foreground: "#d5dbe3",
    cursor: "#8fb6ff",
    cursorAccent: "#2f343b",
    selectionBackground: "#4a5a72",
    black: "#262b31",
    red: "#f08c8c",
    green: "#9ad38e",
    yellow: "#d6bd73",
    blue: "#8fb6ff",
    magenta: "#c5a3ff",
    cyan: "#7bc9d1",
    white: "#c2c9d2",
    brightBlack: "#5f6772",
    brightRed: "#f6a5a5",
    brightGreen: "#b0de9f",
    brightYellow: "#e2cb8b",
    brightBlue: "#a8c7ff",
    brightMagenta: "#d7bcff",
    brightCyan: "#97d6dd",
    brightWhite: "#e9edf2"
  },
  {
    background: "#f6f8fa",
    foreground: "#24292f",
    cursor: "#0969da",
    cursorAccent: "#f6f8fa",
    selectionBackground: "#cfe5ff",
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#4d2d00",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#633c01",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f"
  }
];

function applyPageBackground(theme: ITheme) {
  if (typeof document === "undefined") {
    return;
  }
  const background = theme.background ?? "#0f1420";
  document.documentElement.style.backgroundColor = background;
  document.body.style.backgroundColor = background;
}

export function useTerminal(options: UseTerminalOptions) {
  const { terminalNodeRef, onData, onResize } = options;
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const themeIndexRef = useRef(0);
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);

  useEffect(() => {
    onDataRef.current = onData;
  }, [onData]);

  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  const getDimensions = useCallback((): TerminalSize | null => {
    const dimensions = fitRef.current?.proposeDimensions();
    if (!dimensions) {
      return null;
    }
    return { cols: dimensions.cols, rows: dimensions.rows };
  }, []);

  const fit = useCallback(() => {
    fitRef.current?.fit();
  }, []);

  useEffect(() => {
    if (!terminalNodeRef.current || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      allowProposedApi: true,
      fontFamily:
        '"JetBrains Mono", "Sarasa Mono TC", "Noto Sans Mono CJK TC", "Noto Sans Mono CJK SC", "SF Mono", Menlo, monospace',
      fontSize: 14,
      cursorBlink: true,
      scrollback: 5000,
      // Keep ANSI color combos readable across dark/light themes.
      minimumContrastRatio: 4.5,
      // Reduce visual drift when fallback glyphs overlap cell boundaries.
      rescaleOverlappingGlyphs: true,
      theme: TERMINAL_THEMES[themeIndexRef.current]
    });
    const unicode11Addon = new Unicode11Addon();
    const fitAddon = new FitAddon();
    terminal.loadAddon(unicode11Addon);
    terminal.unicode.activeVersion = "11";
    terminal.loadAddon(fitAddon);
    terminal.open(terminalNodeRef.current);
    try {
      const webglAddon = new WebglAddon();
      terminal.loadAddon(webglAddon);
      webglRef.current = webglAddon;
    } catch {
      webglRef.current = null;
    }
    fitAddon.fit();
    applyPageBackground(TERMINAL_THEMES[themeIndexRef.current]);

    terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type === "keydown" && event.altKey && event.shiftKey && event.code === "KeyT") {
        event.preventDefault();
        themeIndexRef.current = (themeIndexRef.current + 1) % TERMINAL_THEMES.length;
        const nextTheme = TERMINAL_THEMES[themeIndexRef.current];
        terminal.options.theme = nextTheme;
        applyPageBackground(nextTheme);
        return false;
      }
      return true;
    });

    terminalRef.current = terminal;
    fitRef.current = fitAddon;

    const onWindowResize = () => {
      fitAddon.fit();
      const dimensions = fitAddon.proposeDimensions();
      if (!dimensions) {
        return;
      }
      onResizeRef.current({ cols: dimensions.cols, rows: dimensions.rows });
    };
    window.addEventListener("resize", onWindowResize);

    const dataSubscription = terminal.onData((data) => {
      onDataRef.current(data);
    });

    return () => {
      window.removeEventListener("resize", onWindowResize);
      dataSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      webglRef.current = null;
    };
  }, [terminalNodeRef]);

  return {
    terminalRef,
    getDimensions,
    fit
  };
}
