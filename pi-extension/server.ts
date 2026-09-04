import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { BrowserToolName } from "./shared/browser-types";
import { DEFAULT_WS_HOST, DEFAULT_WS_PATH, DEFAULT_WS_PORT } from "./shared/limits";
import { BridgeSessionManager, type BridgeStatus } from "./session";
import { upgradeToWebSocket } from "./ws-transport";

export class BrowserBridgeServer {
  private readonly httpServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("browser-bridge\n");
  });

  private readonly sessions = new BridgeSessionManager();
  private listening = false;

  constructor(
    private readonly host = DEFAULT_WS_HOST,
    private readonly port = DEFAULT_WS_PORT,
    private readonly path = DEFAULT_WS_PATH,
  ) {
    this.httpServer.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
  }

  async start(): Promise<void> {
    if (this.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onListening = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.httpServer.off("listening", onListening);
        this.httpServer.off("error", onError);
      };

      this.httpServer.once("listening", onListening);
      this.httpServer.once("error", onError);
      this.httpServer.listen(this.port, this.host);
    });
    this.listening = true;
  }

  async stop(): Promise<void> {
    if (!this.listening) {
      return;
    }
    this.sessions.close();
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    this.listening = false;
  }

  status(): BridgeStatus & { wsUrl: string } {
    return {
      wsUrl: `ws://${this.host}:${this.port}${this.path}`,
      ...this.sessions.status(),
    };
  }

  async dispatch(tool: BrowserToolName, payload: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    return this.sessions.request(tool, payload, timeoutMs, signal);
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${this.host}:${this.port}`}`);
    if (url.pathname !== this.path) {
      socket.destroy();
      return;
    }

    try {
      const webSocket = upgradeToWebSocket(request, socket, head);
      this.sessions.attach(webSocket);
    } catch {
      socket.destroy();
    }
  }
}
