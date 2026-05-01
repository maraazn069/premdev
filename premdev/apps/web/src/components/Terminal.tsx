import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

export function TerminalPane({ workspaceId }: { workspaceId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!ref.current) return;

    const term = new Terminal({
      fontFamily: "JetBrains Mono, Fira Code, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: {
        background: "#0a0a0f",
        foreground: "#e6e6f0",
        cursor: "#7c5cff",
        selectionBackground: "#7c5cff44",
        black: "#16161f",
        brightBlack: "#606070",
        red: "#ef4444",
        brightRed: "#ff6b6b",
        green: "#22c55e",
        brightGreen: "#4ade80",
        yellow: "#f59e0b",
        brightYellow: "#fbbf24",
        blue: "#7c5cff",
        brightBlue: "#9b80ff",
        magenta: "#d946ef",
        brightMagenta: "#e879f9",
        cyan: "#06b6d4",
        brightCyan: "#22d3ee",
        white: "#e6e6f0",
        brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(ref.current);
    fit.fit();
    termRef.current = term;

    // --- Connection management with exponential backoff. Production
    // proxies, network blips, even a laptop sleep can drop the WS; without
    // reconnect, the terminal stays bricked and users have to refresh the
    // whole IDE. Cap at 8 attempts (~2 min) before giving up so we don't
    // spin forever on a real outage.
    let attempt = 0;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let activeWs: WebSocket | null = null;
    let hasEverConnected = false;

    const connect = () => {
      if (cancelled) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${proto}//${window.location.host}/ws/terminal/${workspaceId}?cols=${term.cols}&rows=${term.rows}`;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      activeWs = ws;

      ws.onopen = () => {
        const wasReconnect = hasEverConnected;
        hasEverConnected = true;
        attempt = 0;
        term.writeln(wasReconnect
          ? "\x1b[2;32m[Reconnected]\x1b[0m"
          : "\x1b[2;90m[Connected]\x1b[0m");
        // Re-sync size with the server so the new shell session matches the
        // current xterm dimensions (otherwise vim renders at 80x24 garbage).
        try {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        } catch {}
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          term.write(ev.data);
        } else {
          term.write(new Uint8Array(ev.data) as any);
        }
      };
      ws.onerror = () => {
        // onerror always fires before onclose, the actual reconnect is wired
        // in onclose so we don't double-schedule.
      };
      ws.onclose = (ev) => {
        if (cancelled) return;
        // 1008 = auth failure; reconnecting won't fix that, and the server
        // already wrote the error message into the terminal stream.
        if (ev.code === 1008) {
          term.writeln(`\r\n\x1b[31m[Disconnected: ${ev.reason || "unauthorized"}]\x1b[0m`);
          return;
        }
        attempt += 1;
        if (attempt > 8) {
          term.writeln("\r\n\x1b[31m[Connection lost — press Enter or refresh to retry]\x1b[0m");
          return;
        }
        const delay = Math.min(15_000, 500 * Math.pow(1.7, attempt - 1));
        term.writeln(`\r\n\x1b[2;90m[Disconnected — retrying in ${(delay / 1000).toFixed(1)}s…]\x1b[0m`);
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    // Manual retry on Enter when the auto-retry budget is used up.
    const dispDisposable = term.onData((data) => {
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify({ type: "input", data }));
      } else if (data === "\r" && attempt > 8) {
        attempt = 0;
        connect();
      }
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        if (activeWs && activeWs.readyState === WebSocket.OPEN) {
          activeWs.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      } catch {}
    });
    ro.observe(ref.current);

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ro.disconnect();
      dispDisposable.dispose();
      try { activeWs?.close(); } catch {}
      term.dispose();
    };
  }, [workspaceId]);

  return <div ref={ref} className="h-full w-full bg-bg" />;
}
