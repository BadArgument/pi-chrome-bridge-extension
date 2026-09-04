import type { BrowserNavigateInput, BrowserNavigateResult } from "../shared/browser-types";

export function runNavigate(input: BrowserNavigateInput): BrowserNavigateResult {
  switch (input.action) {
    case "goto": {
      if (!input.url) {
        return { ok: false };
      }
      window.location.href = input.url;
      return { ok: true };
    }
    case "reload": {
      window.location.reload();
      return { ok: true };
    }
    case "back": {
      window.history.back();
      return { ok: true };
    }
    case "forward": {
      window.history.forward();
      return { ok: true };
    }
  }
}
