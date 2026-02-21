import { useCallback, useEffect, useRef, type RefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export interface TerminalSize {
  cols: number;
  rows: number;
}

interface UseTerminalOptions {
  terminalNodeRef: RefObject<HTMLDivElement | null>;
  onData: (data: string) => void;
  onResize: (size: TerminalSize) => void;
}

export function useTerminal(options: UseTerminalOptions) {
  const { terminalNodeRef, onData, onResize } = options;
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
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
      fontFamily: "JetBrains Mono, SF Mono, Menlo, monospace",
      fontSize: 14,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: "#0f1420",
        foreground: "#d4def8",
        cursor: "#f4b942",
        selectionBackground: "#214575"
      }
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalNodeRef.current);
    fitAddon.fit();

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
    };
  }, [terminalNodeRef]);

  return {
    terminalRef,
    getDimensions,
    fit
  };
}
