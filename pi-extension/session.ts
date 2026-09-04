import { createBridgeError, createMessage, parseBridgeMessage, type BridgeErrorCode, type BridgeMessage } from "./shared/protocol";
import type { BrowserToolName, HelloPayload, PeerHelloPayload } from "./shared/browser-types";
import { TOOL_TIMEOUT_MS } from "./shared/limits";
import type { BridgeSocket } from "./ws-transport";

interface PendingRequest {
  resolve: (message: BridgeMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ActiveClient {
  socket: BridgeSocket;
  connectedAt: number;
  lastHeartbeatAt: number;
  clientInfo?: HelloPayload;
  pending: Map<string, PendingRequest>;
}

export interface BridgeStatus {
  role: "leader" | "follower" | "idle";
  connected: boolean;
  ready: boolean;
  connectedAt?: number;
  lastHeartbeatAt?: number;
  clientInfo?: HelloPayload;
  peerCount: number;
}

export interface PeerClient {
  id: string;
  socket: BridgeSocket;
}

type ConnRole = "unknown" | "chrome" | "peer";

interface ConnState {
  role: ConnRole;
  peerId?: string;
}

/**
 * Manages the single Chrome connection plus any peer (follower-process)
 * connections. Every client connects to the same path and identifies itself
 * with the same hello envelope shape; payload.role decides whether the socket
 * is a Chrome bridge client or a follower peer.
 *
 * The leader owns the Chrome socket; follower-process peers relay their
 * browser_* requests through the leader via requestChrome.
 */
export class BridgeSessionManager {
  private client: ActiveClient | null = null;
  private peers = new Map<string, PeerClient>();

  attach(socket: BridgeSocket): void {
    const state: ConnState = { role: "unknown" };

    socket.on("message", (data: Buffer) => {
      this.route(socket, state, data.toString());
    });

    socket.on("close", () => {
      if (state.role === "peer" && state.peerId) {
        const current = this.peers.get(state.peerId);
        if (current?.socket === socket) {
          this.peers.delete(state.peerId);
        }
      } else if (state.role === "chrome" && this.client?.socket === socket) {
        this.rejectAll(this.client, new Error("Chrome connection closed"));
        this.client = null;
      }
    });

    socket.on("error", () => {
      if (state.role === "peer" && state.peerId) {
        const current = this.peers.get(state.peerId);
        if (current?.socket === socket) {
          this.peers.delete(state.peerId);
        }
      } else if (state.role === "chrome" && this.client?.socket === socket) {
        this.rejectAll(this.client, new Error("Chrome connection error"));
        this.client = null;
      }
    });
  }

  status(): BridgeStatus {
    return {
      role: "leader",
      connected: Boolean(this.client),
      ready: Boolean(this.client?.clientInfo),
      connectedAt: this.client?.connectedAt,
      lastHeartbeatAt: this.client?.lastHeartbeatAt,
      clientInfo: this.client?.clientInfo,
      peerCount: this.peers.size,
    };
  }

  /**
   * Send a browser_* request to Chrome and await its response. Used by the
   * leader's own dispatch and by peer request forwarding.
   */
  async requestChrome(tool: BrowserToolName, payload: unknown, timeoutMs: number, signal?: AbortSignal): Promise<BridgeMessage> {
    const client = this.client;
    if (!client?.clientInfo) {
      throw new Error(JSON.stringify(createBridgeError("CHROME_NOT_CONNECTED", "Chrome 未连接")));
    }

    const message = createMessage({
      kind: "request",
      source: "pi",
      tool,
      tabID: extractTabID(payload),
      payload,
    });

    return await new Promise<BridgeMessage>((resolve, reject) => {
      const onAbort = () => {
        if (client.pending.get(message.id) === pending) {
          reject(new Error(JSON.stringify(createBridgeError("BRIDGE_TIMEOUT", `${tool} aborted`, { tool }))));
          cleanup();
        }
      };

      const pending: PendingRequest = {
        resolve: (response) => {
          cleanup();
          resolve(response);
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
        const current = client.pending.get(message.id);
        if (current === pending) {
          client.pending.delete(message.id);
        }
        signal?.removeEventListener("abort", onAbort);
      };

      client.pending.set(message.id, pending);
      signal?.addEventListener("abort", onAbort, { once: true });
      client.socket.send(JSON.stringify(message));
    });
  }

  /**
   * Leader-side tool dispatch, mirroring the legacy `request` public API.
   */
  async request(tool: BrowserToolName, payload: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const response = await this.requestChrome(tool, payload, timeoutMs, signal);
    if (response.error) {
      throw new Error(JSON.stringify(response.error));
    }
    return response.payload;
  }

  close(): void {
    this.disposeClient();
    for (const peer of this.peers.values()) {
      try {
        peer.socket.close();
      } catch {
        // ignore
      }
    }
    this.peers.clear();
  }

  private route(socket: BridgeSocket, state: ConnState, raw: string): void {
    let message: BridgeMessage;
    try {
      message = parseBridgeMessage(raw);
    } catch {
      return;
    }

    if (state.role === "unknown") {
      const hello = parseHelloMessage(message);
      if (!hello) {
        socket.close();
        return;
      }
      if (hello.role === "peer") {
        state.role = "peer";
        state.peerId = hello.peerId;
        this.registerPeer({
          id: state.peerId,
          socket,
        });
        return;
      }

      state.role = "chrome";
      this.becomeChrome(socket);
      this.handleChromeMessage(this.client as ActiveClient, raw);
      return;
    }

    if (state.role === "chrome") {
      if (this.client?.socket === socket) {
        this.handleChromeMessage(this.client, raw);
      }
      return;
    }

    if (state.role === "peer" && state.peerId) {
      const peer = this.peers.get(state.peerId);
      if (peer && peer.socket === socket) {
        void this.handlePeerMessage(peer, raw);
      }
    }
  }

  private becomeChrome(socket: BridgeSocket): void {
    if (this.client) {
      this.disposeClient();
    }
    const client: ActiveClient = {
      socket,
      connectedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      pending: new Map(),
    };
    this.client = client;
  }

  private registerPeer(peer: PeerClient): void {
    const existing = this.peers.get(peer.id);
    if (existing && existing.socket !== peer.socket) {
      try {
        existing.socket.close();
      } catch {
        // ignore
      }
    }
    this.peers.set(peer.id, peer);
  }

  private handleChromeMessage(client: ActiveClient, raw: string): void {
    let message: BridgeMessage;

    try {
      message = parseBridgeMessage(raw);
    } catch {
      return;
    }

    client.lastHeartbeatAt = Date.now();

    if (message.kind === "hello") {
      client.clientInfo = message.payload as HelloPayload;
      return;
    }

    if (message.kind === "heartbeat") {
      client.socket.send(
        JSON.stringify(
          createMessage({
            kind: "heartbeat",
            source: "pi",
            replyTo: message.id,
            payload: message.payload,
          }),
        ),
      );
      return;
    }

    if (!message.replyTo) {
      return;
    }

    const pending = client.pending.get(message.replyTo);
    if (!pending) {
      return;
    }
    pending.resolve(message);
  }

  private async handlePeerMessage(peer: PeerClient, raw: string): Promise<void> {
    let message: BridgeMessage;

    try {
      message = parseBridgeMessage(raw);
    } catch {
      return;
    }

    if (message.kind !== "request") {
      return;
    }
    const tool = message.tool;
    if (!tool) {
      return;
    }

    let response: BridgeMessage;
    try {
      response = await this.requestChrome(tool, message.payload, TOOL_TIMEOUT_MS[tool]);
    } catch (error) {
      response = createMessage({
        kind: "response",
        source: "chrome-sw",
        replyTo: message.id,
        tool,
        tabID: message.tabID,
        error: parseBridgeError(error),
      });
    }

    // The Chrome response carries the leader-generated id; rewrite replyTo so the
    // peer can match it against its own request id.
    response.replyTo = message.id;
    peer.socket.send(JSON.stringify(response));
  }

  private disposeClient(): void {
    if (!this.client) {
      return;
    }
    const client = this.client;
    this.client = null;
    this.rejectAll(client, new Error("Chrome connection replaced"));
    client.socket.close();
  }

  private rejectAll(client: ActiveClient, error: Error): void {
    for (const pending of client.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    client.pending.clear();
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

function parseBridgeError(error: unknown): {
  code: BridgeErrorCode;
  message: string;
} {
  if (error instanceof Error) {
    try {
      const parsed = JSON.parse(error.message) as { code?: string; message?: string };
      if (parsed && typeof parsed.code === "string") {
        return { code: parsed.code as BridgeErrorCode, message: parsed.message ?? error.message };
      }
    } catch {
      // not a bridge error JSON
    }
    return { code: "INVALID_REQUEST", message: error.message };
  }
  return { code: "INVALID_REQUEST", message: String(error) };
}

function parseHelloMessage(message: BridgeMessage): HelloPayload | PeerHelloPayload | null {
  if (message.kind !== "hello") {
    return null;
  }
  const payload = message.payload;
  if (!payload || typeof payload !== "object" || !("role" in payload)) {
    return null;
  }
  const hello = payload as Record<string, unknown>;
  if (hello.role === "peer" && typeof hello.peerId === "string") {
    return hello as unknown as PeerHelloPayload;
  }
  if (
    hello.role === "chrome" &&
    typeof hello.extensionVersion === "string" &&
    typeof hello.wsUrl === "string" &&
    typeof hello.heartbeatMs === "number" &&
    typeof hello.tabsSummary === "object" &&
    hello.tabsSummary !== null
  ) {
    return hello as unknown as HelloPayload;
  }
  return null;
}
