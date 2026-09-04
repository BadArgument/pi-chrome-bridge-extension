import type { HelloPayload } from "../shared/browser-types";
import { createMessage, parseBridgeMessage, type BridgeMessage } from "../shared/protocol";
import { RECONNECT_DELAYS_MS } from "../shared/limits";
import type { BridgeConfig, ConnectionSnapshot, ConnectionState } from "./config";

interface BridgeWebSocketClientOptions {
  getHelloPayload(): HelloPayload;
  onRequest(message: BridgeMessage): Promise<BridgeMessage>;
}

export class BridgeWebSocketClient {
  private socket: WebSocket | null = null;
  private heartbeatTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private heartbeatSeq = 0;
  private lastPongAt = 0;
  private lastConnectedAt: number | undefined;
  private lastError: string | undefined;
  private lastInfo: string | undefined;
  private state: ConnectionState = "idle";
  private stopped = false;

  constructor(
    private config: BridgeConfig,
    private readonly options: BridgeWebSocketClientOptions,
  ) {}

  start(): void {
    this.stopped = false;
    void this.connect(false);
  }

  stop(): void {
    this.stopped = true;
    this.clearHeartbeat();
    this.clearReconnect();
    this.socket?.close();
    this.socket = null;
    this.state = "idle";
  }

  updateConfig(config: BridgeConfig): void {
    this.config = config;
    this.stop();
    this.start();
  }

  snapshot(): ConnectionSnapshot {
    return {
      state: this.state,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
      lastInfo: this.lastInfo,
    };
  }

  private async connect(reconnecting: boolean): Promise<void> {
    this.clearReconnect();
    this.state = reconnecting ? "reconnecting" : "connecting";
    this.lastError = undefined;
    this.lastInfo = reconnecting ? `reconnecting ${this.config.wsUrl}` : `connecting ${this.config.wsUrl}`;

    const reachable = await this.probeBridge();
    if (!reachable) {
      if (this.stopped) {
        this.state = "idle";
        return;
      }
      this.state = "disconnected";
      this.lastError = undefined;
      this.lastInfo = `bridge unavailable at ${this.config.wsUrl}; retrying`;
      this.scheduleReconnect();
      return;
    }

    const socket = new WebSocket(this.config.wsUrl);
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) {
        return;
      }
      this.state = "connected";
      this.lastConnectedAt = Date.now();
      this.lastPongAt = Date.now();
      this.lastError = undefined;
      this.lastInfo = undefined;
      this.reconnectAttempt = 0;
      socket.send(
        JSON.stringify(
          createMessage({
            kind: "hello",
            source: "chrome-sw",
            payload: this.options.getHelloPayload(),
          }),
        ),
      );
      this.startHeartbeat();
    });

    socket.addEventListener("message", (event) => {
      void this.handleMessage(String(event.data));
    });

    socket.addEventListener("error", () => {
      this.lastError = "websocket transport error";
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.clearHeartbeat();
      if (this.stopped) {
        this.state = "idle";
        return;
      }
      this.state = "disconnected";
      this.lastInfo = `bridge unavailable at ${this.config.wsUrl}; retrying`;
      this.scheduleReconnect();
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    let message: BridgeMessage;

    try {
      message = parseBridgeMessage(raw);
    } catch {
      return;
    }

    if (message.kind === "heartbeat") {
      this.lastPongAt = Date.now();
      if (!message.replyTo) {
        this.socket?.send(
          JSON.stringify(
            createMessage({
              kind: "heartbeat",
              source: "chrome-sw",
              replyTo: message.id,
              payload: message.payload,
            }),
          ),
        );
      }
      return;
    }

    if (message.kind !== "request") {
      return;
    }

    const response = await this.options.onRequest(message);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(response));
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = self.setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (Date.now() - this.lastPongAt > this.config.heartbeatMs * 3) {
        this.socket.close();
        return;
      }
      this.socket.send(
        JSON.stringify(
          createMessage({
            kind: "heartbeat",
            source: "chrome-sw",
            payload: {
              seq: ++this.heartbeatSeq,
              sentAt: Date.now(),
            },
          }),
        ),
      );
    }, this.config.heartbeatMs);
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = self.setTimeout(() => {
      void this.connect(true);
    }, delay);
  }

  private async probeBridge(): Promise<boolean> {
    let probeUrl: string;

    try {
      const url = new URL(this.config.wsUrl);
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      url.pathname = "/";
      url.search = "";
      url.hash = "";
      probeUrl = url.toString();
    } catch {
      this.lastError = `invalid websocket url: ${this.config.wsUrl}`;
      this.lastInfo = undefined;
      return false;
    }

    const controller = new AbortController();
    const timeout = self.setTimeout(() => controller.abort(), 1000);

    try {
      const response = await fetch(probeUrl, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
