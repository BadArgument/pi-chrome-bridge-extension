import type { BrowserToolName } from "./shared/browser-types";
import { DEFAULT_WS_HOST, DEFAULT_WS_PATH, DEFAULT_WS_PORT, TOOL_TIMEOUT_MS } from "./shared/limits";
import { createID } from "./shared/protocol";
import { RemoteBridgeClient } from "./bridge-client";
import { BrowserBridgeServer } from "./server";

interface StartupIssue {
  code?: string;
  message: string;
}

export interface RemoteBridgeClientLike {
  connect(host: string, port: number, path: string): Promise<void>;
  request(tool: BrowserToolName, payload: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown>;
  close(): void;
  setDisconnectHandler?(handler: () => void): void;
  readonly connected: boolean;
}

function isAddrInUseError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "EADDRINUSE");
}

export class BrowserBridgeRuntime {
  private server: BrowserBridgeServer | null = null;
  private remoteClient: RemoteBridgeClientLike | null = null;
  private starting: Promise<void> | null = null;
  private startupIssue: StartupIssue | null = null;
  private stopped = false;

  constructor(
    private readonly createServer = () => new BrowserBridgeServer(),
    private readonly createRemoteClient = (peerId: string): RemoteBridgeClientLike => new RemoteBridgeClient(peerId),
    private readonly peerId = createID(),
    private readonly recoveryRetryMs = 250,
  ) {}

  async ensureStarted(options?: { force?: boolean; leaderOnly?: boolean }): Promise<void> {
    this.stopped = false;
    if (this.server || this.remoteClient?.connected) {
      return;
    }
    if (this.starting) {
      await this.starting;
      return;
    }

    const bootstrap = this.bootstrap(false, options?.leaderOnly ?? false);
    this.starting = bootstrap;
    try {
      await bootstrap;
    } finally {
      if (this.starting === bootstrap) {
        this.starting = null;
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const server = this.server;
    const remoteClient = this.remoteClient;
    this.server = null;
    this.remoteClient = null;
    if (server) {
      await server.stop();
    }
    remoteClient?.close();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.ensureStarted({ force: true });
  }

  async call<T>(tool: BrowserToolName, payload: Record<string, unknown>, signal?: AbortSignal, timeoutMs = TOOL_TIMEOUT_MS[tool]): Promise<T> {
    await this.ensureStarted();
    if (this.server) {
      return (await this.server.dispatch(tool, payload, timeoutMs, signal)) as T;
    }
    if (this.remoteClient?.connected) {
      return (await this.remoteClient.request(tool, payload, timeoutMs, signal)) as T;
    }
    throw new Error(this.startupIssue?.message ?? "Bridge server not available");
  }

  getStatus() {
    if (this.server) {
      return {
        running: true,
        startupIssue: this.startupIssue,
        peerId: this.peerId,
        ...this.server.status(),
        role: "leader" as const,
      };
    }
    if (this.remoteClient?.connected) {
      return {
        running: true,
        role: "follower" as const,
        wsUrl: `ws://${DEFAULT_WS_HOST}:${DEFAULT_WS_PORT}${DEFAULT_WS_PATH}`,
        connected: true,
        ready: true,
        peerCount: 0,
        startupIssue: this.startupIssue,
        peerId: this.peerId,
      };
    }
    return {
      running: false,
      role: "idle" as const,
      wsUrl: `ws://${DEFAULT_WS_HOST}:${DEFAULT_WS_PORT}${DEFAULT_WS_PATH}`,
      startupIssue: this.startupIssue,
      peerId: this.peerId,
    };
  }

  private async bootstrap(retry: boolean, leaderOnly: boolean): Promise<void> {
    do {
      const ready = await this.bootstrapOnce(leaderOnly);
      if (ready || !retry || this.stopped) {
        return;
      }
      await sleep(this.recoveryRetryMs);
    } while (!this.stopped);
  }

  private async bootstrapOnce(leaderOnly: boolean): Promise<boolean> {
    if (this.server || this.remoteClient?.connected) {
      return true;
    }

    const server = this.createServer();
    try {
      await server.start();
      if (this.stopped) {
        await server.stop();
        return false;
      }
      this.server = server;
      this.startupIssue = null;
      return true;
    } catch (error) {
      if (!isAddrInUseError(error)) {
        throw error;
      }
      if (leaderOnly) {
        this.startupIssue = {
          code: error.code,
          message: "leader already running",
        };
        return false;
      }

      const remoteClient = this.createRemoteClient(this.peerId);
      this.bindRemoteClient(remoteClient);
      try {
        await remoteClient.connect(DEFAULT_WS_HOST, DEFAULT_WS_PORT, DEFAULT_WS_PATH);
        if (this.stopped) {
          remoteClient.close();
          return false;
        }
        this.remoteClient = remoteClient;
        this.startupIssue = null;
        return true;
      } catch (remoteError) {
        remoteClient.close();
        this.startupIssue = {
          code: error.code,
          message: remoteError instanceof Error ? remoteError.message : String(remoteError),
        };
        return false;
      }
    }
  }

  private bindRemoteClient(remoteClient: RemoteBridgeClientLike): void {
    remoteClient.setDisconnectHandler?.(() => {
      if (this.remoteClient !== remoteClient) {
        return;
      }
      this.remoteClient = null;
      this.startupIssue = { message: "leader bridge connection closed" };
      if (this.stopped || this.starting) {
        return;
      }
      const recovery = this.bootstrap(true, false);
      this.starting = recovery;
      void recovery.finally(() => {
        if (this.starting === recovery) {
          this.starting = null;
        }
      });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
