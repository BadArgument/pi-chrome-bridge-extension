import type { BrowserFetchInput, BrowserFetchResult } from "../shared/browser-types";

function headersToObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export async function runFetch(input: BrowserFetchInput): Promise<BrowserFetchResult> {
  try {
    const response = await fetch(input.url, {
      method: input.body?.method ?? "GET",
      headers: input.body?.headers,
      body: input.body?.payload,
      credentials: input.body?.credentials ?? "same-origin",
    });

    const headers = headersToObject(response.headers);
    const responseType = input.body?.responseType ?? "text";

    if (responseType === "blob") {
      const buffer = new Uint8Array(await response.arrayBuffer());
      return {
        ok: true,
        status: response.status,
        statusText: response.statusText,
        headers,
        mimeType: response.headers.get("content-type") ?? undefined,
        size: buffer.byteLength,
        data: toBase64(buffer),
        encoding: "base64",
      };
    }

    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      headers,
      data: await response.text(),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: "FETCH_FAILED",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
