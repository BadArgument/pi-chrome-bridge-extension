import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface BridgeSocketEvents {
  close: [];
  error: [Error];
  message: [Buffer];
}

export interface BridgeSocketOptions {
  /** True when this socket is the server side (receives masked client frames). */
  expectMaskedInput?: boolean;
  /** True when this socket is the client side (must mask its outgoing frames). */
  maskOutgoing?: boolean;
}

export class BridgeSocket extends EventEmitter {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentedOpcode: number | null = null;
  private closed = false;
  private readonly expectMasked: boolean;
  private readonly maskOutgoing: boolean;

  constructor(
    private readonly socket: Duplex,
    options: BridgeSocketOptions = {},
  ) {
    super();
    this.expectMasked = options.expectMaskedInput !== false;
    this.maskOutgoing = options.maskOutgoing === true;

    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flushFrames();
    });
    socket.on("close", () => {
      this.closed = true;
      this.emit("close");
    });
    socket.on("end", () => {
      if (!this.closed) {
        this.closed = true;
        this.emit("close");
      }
    });
    socket.on("error", (error: Error) => {
      this.emit("error", error);
    });
  }

  override on(event: "close", listener: () => void): this;
  override on(event: "error", listener: (error: Error) => void): this;
  override on(event: "message", listener: (data: Buffer) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  send(data: string): void {
    if (this.closed) {
      return;
    }
    const payload = Buffer.from(data);
    let mask: Buffer | undefined;
    if (this.maskOutgoing) {
      mask = randomBytes(4);
    }
    this.socket.write(encodeFrame(0x1, payload, mask));
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.socket.write(encodeFrame(0x8, Buffer.alloc(0), this.maskOutgoing ? randomBytes(4) : undefined));
    } finally {
      this.socket.end();
    }
  }

  feedHead(head: Buffer): void {
    if (!head.length) {
      return;
    }
    this.buffer = Buffer.concat([this.buffer, head]);
    this.flushFrames();
  }

  private flushFrames(): void {
    while (true) {
      let frame: DecodedFrame | null;
      try {
        frame = decodeFrame(this.buffer, this.expectMasked);
      } catch {
        this.emit("error", new Error("Invalid websocket frame"));
        this.close();
        return;
      }
      if (!frame) {
        return;
      }
      this.buffer = this.buffer.subarray(frame.bytesRead);
      this.handleFrame(frame.opcode, frame.fin, frame.payload);
    }
  }

  private handleFrame(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode === 0x8) {
      this.close();
      return;
    }
    if (opcode === 0x9) {
      this.socket.write(encodeFrame(0xA, payload, this.maskOutgoing ? randomBytes(4) : undefined));
      return;
    }
    if (opcode === 0xA) {
      return;
    }

    if (opcode === 0x1) {
      if (fin) {
        this.emit("message", payload);
        return;
      }
      this.fragmentedOpcode = opcode;
      this.fragments = [payload];
      return;
    }

    if (opcode === 0x0 && this.fragmentedOpcode === 0x1) {
      this.fragments.push(payload);
      if (fin) {
        const message = Buffer.concat(this.fragments);
        this.fragments = [];
        this.fragmentedOpcode = null;
        this.emit("message", message);
      }
      return;
    }

    this.emit("error", new Error(`Unsupported websocket opcode: ${opcode}`));
    this.close();
  }
}

interface DecodedFrame {
  bytesRead: number;
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

function decodeFrame(buffer: Buffer, expectMasked: boolean): DecodedFrame | null {
  if (buffer.length < 2) {
    return null;
  }

  const firstByte = buffer[0];
  const secondByte = buffer[1];
  const fin = (firstByte & 0x80) !== 0;
  const opcode = firstByte & 0x0f;
  const masked = (secondByte & 0x80) !== 0;
  let payloadLength = secondByte & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    const longLength = buffer.readBigUInt64BE(offset);
    if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Websocket frame too large");
    }
    payloadLength = Number(longLength);
    offset += 8;
  }

  if (expectMasked) {
    if (!masked) {
      throw new Error("Client websocket frame must be masked");
    }
    if (buffer.length < offset + 4 + payloadLength) {
      return null;
    }
    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;

    const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }

    return {
      bytesRead: offset + payloadLength,
      fin,
      opcode,
      payload,
    };
  }

  if (masked) {
    throw new Error("Server websocket frame must not be masked");
  }

  if (buffer.length < offset + payloadLength) {
    return null;
  }
  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
  return {
    bytesRead: offset + payloadLength,
    fin,
    opcode,
    payload,
  };
}

function encodeFrame(opcode: number, payload: Buffer, mask?: Buffer): Buffer {
  const header: number[] = [0x80 | opcode];

  const maskedBit = mask ? 0x80 : 0;
  if (payload.length < 126) {
    header.push(maskedBit | payload.length);
    const body = mask ? applyMask(payload, mask) : payload;
    return Buffer.concat([Buffer.from(header), mask ?? Buffer.alloc(0), body]);
  }

  if (payload.length <= 0xffff) {
    const prefix = Buffer.alloc(4);
    prefix[0] = header[0];
    prefix[1] = 126 | maskedBit;
    prefix.writeUInt16BE(payload.length, 2);
    const body = mask ? applyMask(payload, mask) : payload;
    return Buffer.concat([prefix, mask ?? Buffer.alloc(0), body]);
  }

  const prefix = Buffer.alloc(10);
  prefix[0] = header[0];
  prefix[1] = 127 | maskedBit;
  prefix.writeBigUInt64BE(BigInt(payload.length), 2);
  const body = mask ? applyMask(payload, mask) : payload;
  return Buffer.concat([prefix, mask ?? Buffer.alloc(0), body]);
}

function applyMask(payload: Buffer, mask: Buffer): Buffer {
  const out = Buffer.from(payload);
  for (let index = 0; index < out.length; index += 1) {
    out[index] ^= mask[index % 4];
  }
  return out;
}

export function upgradeToWebSocket(request: IncomingMessage, socket: Duplex, head: Buffer): BridgeSocket {
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string" || !key) {
    throw new Error("Missing Sec-WebSocket-Key header");
  }

  const accept = createHash("sha1")
    .update(`${key}${WS_GUID}`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));

  const bridgeSocket = new BridgeSocket(socket, { expectMaskedInput: true, maskOutgoing: false });
  bridgeSocket.feedHead(head);
  return bridgeSocket;
}

export interface ConnectOptions {
  host?: string;
  port?: number;
  path?: string;
  timeoutMs?: number;
}

export function connectToWebSocket(options: ConnectOptions): Promise<BridgeSocket> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 29180;
  const path = options.path ?? "/agent";
  const key = randomBytes(16).toString("base64");

  return new Promise<BridgeSocket>((resolve, reject) => {
    const request = httpRequest({
      host,
      port,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
      },
    });

    const timer = setTimeout(() => {
      cleanup();
      request.destroy();
      reject(new Error(`websocket connect to ${host}:${port}${path} timed out`));
    }, options.timeoutMs ?? 5000);

    const cleanup = () => {
      clearTimeout(timer);
      request.off("upgrade", onUpgrade);
      request.off("response", onResponse);
      request.off("error", onError);
    };

    const onUpgrade = (_res: IncomingMessage, socket: Duplex, head: Buffer) => {
      cleanup();
      const bridgeSocket = new BridgeSocket(socket, { expectMaskedInput: false, maskOutgoing: true });
      bridgeSocket.feedHead(head);
      resolve(bridgeSocket);
    };

    const onResponse = () => {
      cleanup();
      reject(new Error(`websocket upgrade failed for ${host}:${port}${path}`));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    request.on("upgrade", onUpgrade);
    request.on("response", onResponse);
    request.on("error", onError);
    request.end();
  });
}
