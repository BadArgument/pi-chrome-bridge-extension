import type { BrowserScriptResult } from "../shared/browser-types";

export function injectScript(script: string): BrowserScriptResult {
  try {
    const evaluated = (0, eval)(`(${script})`);
    if (typeof evaluated !== "function") {
      return { ok: false, error: "script must evaluate to a function" };
    }
    return { ok: true, result: {} };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
