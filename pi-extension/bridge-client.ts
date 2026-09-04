import { createBridgeError, createMessage, parseBridgeMessage, type BridgeMessage } from "./shared/protocol";
import type { BrowserToolName, PeerHelloPayload } from "./shared/browser-types";
import { connectToWebSocket, type BridgeSocket } from "./ws-transport";

interface PendingRemoteRequest {
  resolve: (message: BridgeMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RemoteBridgeClient {
  private socket: BridgeSocket | null = null;
  private readonly pending = new Map<string, PendingRemoteRequest>();
  private disconnectHandler: (() => void) | null = null;

  constructor(private readonly peerId: string) {}

  setDisconnectHandler(handler: () => void): void {
    this.disconnectHandler = handler;
  }

  async connect(host: string, port: number, path: string): Promise<void> {
    if (this.socket) {
      return;
    }
    const socket = await connectToWebSocket({ host, port, path, timeoutMs: 5000 });
    this.socket = socket;

    socket.on("message", (data: Buffer) => {
      this.handleMessage(data.toString());
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.rejectAll(new Error("leader bridge connection closed"));
      this.disconnectHandler?.();
    });
    socket.on("error", (error: Error) => {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.rejectAll(error);
      this.disconnectHandler?.();
    });

    const payload: PeerHelloPayload = {
      peerId: this.peerId,
      role: "peer",
    };
    socket.send(
      JSON.stringify(
        createMessage({
          kind: "hello",
          source: "pi",
          payload,
        }),
      ),
    );
  }

  async request(tool: BrowserToolName, payload: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const socket = this.socket;
    if (!socket) {
      throw new Error(JSON.stringify(createBridgeError("CHROME_NOT_CONNECTED", "leader bridge not connected")));
    }

    const message = createMessage({
      kind: "request",
      source: "pi",
      tool,
      tabID: extractTabID(payload),
      payload,
    });

    return await new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        if (this.pending.get(message.id) === pending) {
          reject(new Error(JSON.stringify(createBridgeError("BRIDGE_TIMEOUT", `${tool} aborted`, { tool }))));
          cleanup();
        }
      };

      const pending: PendingRemoteRequest = {
        resolve: (response) => {
          cleanup();
          if (response.error) {
            reject(new Error(JSON.stringify(response.error)));
            return;
          }
          resolve(response.payload);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timer: setTimeout(() => {
          cleanup();
          reject(new Error(JSON.stringify(createBridgeError("BRIDGE_TIMEOUT", `${tool} timed out`, { tool, timeoutMs }))));
        }, timeoutMs),
      };

      const cleanup = () => {
        clearTimeout(pending.timer);
        const current = this.pending.get(message.id);
        if (current === pending) {
          this.pending.delete(message.id);
        }
        signal?.removeEventListener("abort", onAbort);
      };

      this.pending.set(message.id, pending);
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.send(JSON.stringify(message));
    });
  }

  close(): void {
    try {
      this.socket?.close();
    } finally {
      this.socket = null;
      this.rejectAll(new Error("leader bridge connection closed"));
    }
  }

  get connected(): boolean {
    return Boolean(this.socket);
  }

  private handleMessage(raw: string): void {
    let message: BridgeMessage;
    try {
      message = parseBridgeMessage(raw);
    } catch {
      return;
    }
    if (!message.replyTo) {
      return;
    }
    const pending = this.pending.get(message.replyTo);
    if (!pending) {
      return;
    }
    pending.resolve(message);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function extractTabID(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object" || !("tabID" in payload)) {
    return undefined;
  }
  const value = (payload as { tabID?: string }).tabID;
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
