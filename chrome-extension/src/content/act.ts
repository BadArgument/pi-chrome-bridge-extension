import type { BrowserActInput, BrowserActResult } from "../shared/browser-types";

function failure(error: string, message?: string): BrowserActResult {
  return { ok: false, error, message };
}

function queryElement(selector: string): Element | null {
  return queryElementInRoot(document, selector);
}

function queryElementInRoot(root: Document | DocumentFragment | Element, selector: string): Element | null {
  const children = root instanceof Element ? Array.from(root.children) : Array.from(root.children);

  for (const child of children) {
    if (child.matches(selector)) {
      return child;
    }

    if (child.shadowRoot) {
      const inShadow = queryElementInRoot(child.shadowRoot, selector);
      if (inShadow) {
        return inShadow;
      }
    }

    const inLightDom = queryElementInRoot(child, selector);
    if (inLightDom) {
      return inLightDom;
    }
  }

  return null;
}

function asInteractable(element: Element): HTMLElement | null {
  return element instanceof HTMLElement ? element : null;
}

function getMousePosition(element: Element) {
  const rect = element.getBoundingClientRect();
  return {
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
}

function dispatchPointerLikeEvent(element: Element, type: string): void {
  const position = getMousePosition(element);
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    button: 0,
    buttons: type === "pointerup" || type === "mouseup" || type === "click" ? 0 : 1,
    ...position,
  };

  if (type.startsWith("pointer") && typeof PointerEvent === "function") {
    element.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    return;
  }

  element.dispatchEvent(new MouseEvent(type, init));
}

function dispatchKeyboard(element: Element, type: "keydown" | "keyup" | "keypress", keys: string[]): void {
  for (const key of keys) {
    element.dispatchEvent(
      new KeyboardEvent(type, {
        key,
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
  }
}

function setNativeValue(target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const prototype =
    target instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLSelectElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor?.set?.call(target, value);
}

function runInput(element: Element, value: string | undefined): BrowserActResult {
  const target = asInteractable(element);
  if (!target || !("value" in target)) {
    return failure("ELEMENT_NOT_INTERACTABLE");
  }

  const inputTarget = target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  target.focus();
  setNativeValue(inputTarget, value ?? "");
  target.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, composed: true, data: value ?? "" }));
  target.dispatchEvent(new Event("change", { bubbles: true, cancelable: true, composed: true }));
  return { ok: true, message: "input applied" };
}

function parseScrollDelta(value: string | number | undefined, axis: "x" | "y"): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value === "number") {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return 0;
  }
  if (/^-?\d+(\.\d+)?$/.test(normalized)) {
    return Number.parseFloat(normalized);
  }

  const match = normalized.match(/^(-?\d+(?:\.\d+)?)(px|vw|vh|%)$/);
  if (!match) {
    return Number.NaN;
  }

  const amount = Number.parseFloat(match[1]);
  const unit = match[2];
  if (unit === "px") {
    return amount;
  }

  const base = unit === "vw" ? window.innerWidth : unit === "vh" ? window.innerHeight : axis === "x" ? window.innerWidth : window.innerHeight;
  return (amount / 100) * base;
}

function runScroll(input: BrowserActInput): BrowserActResult {
  const top = parseScrollDelta(input.scrollDeltaY, "y");
  const left = parseScrollDelta(input.scrollDeltaX, "x");
  if (Number.isNaN(top) || Number.isNaN(left)) {
    return failure("INVALID_REQUEST", "invalid scroll delta");
  }

  window.scrollBy({ top, left, behavior: "instant" });
  return { ok: true, message: `window scrolled by x=${left}, y=${top}` };
}

function runDrag(source: Element, input: BrowserActInput): BrowserActResult {
  if (!input.targetSelector) {
    return failure("DRAG_TARGET_NOT_FOUND", "targetSelector required for drag");
  }
  const target = queryElement(input.targetSelector);
  if (!target) {
    return failure("DRAG_TARGET_NOT_FOUND");
  }

  const dataTransfer = typeof DataTransfer === "function" ? new DataTransfer() : undefined;
  const events: Array<[Element, string]> = [
    [source, "dragstart"],
    [target, "dragenter"],
    [target, "dragover"],
    [target, "drop"],
    [source, "dragend"],
  ];

  for (const [element, type] of events) {
    element.dispatchEvent(
      new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }),
    );
  }

  return { ok: true, message: "drag dispatched" };
}

export function runAct(input: BrowserActInput): BrowserActResult {
  try {
    if (input.action === "scroll") {
      return runScroll(input);
    }

    if (!input.selector) {
      return failure("ELEMENT_NOT_FOUND", "selector required");
    }

    const element = queryElement(input.selector);
    if (!element) {
      return failure("ELEMENT_NOT_FOUND");
    }

    switch (input.action) {
      case "click": {
        const target = asInteractable(element);
        target?.scrollIntoView({ block: "center", inline: "center" });
        target?.focus?.();
        dispatchPointerLikeEvent(element, "pointerdown");
        dispatchPointerLikeEvent(element, "mousedown");
        dispatchPointerLikeEvent(element, "pointerup");
        dispatchPointerLikeEvent(element, "mouseup");
        if (target && typeof target.click === "function") {
          target.click();
        } else {
          dispatchPointerLikeEvent(element, "click");
        }
        return { ok: true, message: "click applied" };
      }
      case "focus": {
        const target = asInteractable(element);
        if (!target) {
          return failure("ELEMENT_NOT_INTERACTABLE");
        }
        target.focus();
        return { ok: true, message: "focused" };
      }
      case "input": {
        return runInput(element, input.value);
      }
      case "keydown":
      case "keyup":
      case "keypress": {
        const target = asInteractable(element);
        if (!target) {
          return failure("ELEMENT_NOT_INTERACTABLE");
        }
        target.focus();
        dispatchKeyboard(target, input.action, input.keys ?? []);
        return { ok: true, message: `${input.action} dispatched` };
      }
      case "drag": {
        return runDrag(element, input);
      }
    }
  } catch (error) {
    return failure("ACT_DISPATCH_FAILED", error instanceof Error ? error.message : String(error));
  }
}
