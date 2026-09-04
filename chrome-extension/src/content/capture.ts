import type { BrowserFilterInput, CaptureResult } from "../shared/browser-types";
import { DEFAULT_CAPTURE_MAX_NODES } from "../shared/limits";

interface Budget {
  remaining: number;
}

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "OPTION"]);

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isElementVisible(element: Element): boolean {
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }
  if (Number.parseFloat(style.opacity || "1") <= 0.01) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 1 && rect.height <= 1) {
    return false;
  }
  return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
}

function isImportantElement(element: Element): boolean {
  if (!isElementVisible(element)) {
    return false;
  }
  const htmlElement = element as HTMLElement;
  if (INTERACTIVE_TAGS.has(element.tagName)) {
    return true;
  }
  if (element.hasAttribute("role")) {
    return true;
  }
  if (Array.from(element.attributes).some((attribute) => attribute.name.startsWith("aria-"))) {
    return true;
  }
  if (collapseWhitespace(htmlElement.innerText || htmlElement.textContent || "")) {
    return true;
  }
  if (element.shadowRoot) {
    return true;
  }
  return false;
}

function getParentElementAcrossShadow(element: Element): Element | null {
  if (element.parentElement) {
    return element.parentElement;
  }
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function hasImportantAncestor(element: Element, set: Set<Element>): boolean {
  let current = getParentElementAcrossShadow(element);
  while (current) {
    if (set.has(current)) {
      return true;
    }
    current = getParentElementAcrossShadow(current);
  }
  return false;
}

function walkElements(root: Document | DocumentFragment | Element, visit: (element: Element) => boolean | void): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);

  while (walker.nextNode()) {
    const element = walker.currentNode as Element;
    if (visit(element) === false) {
      return false;
    }
    if (element.shadowRoot && walkElements(element.shadowRoot, visit) === false) {
      return false;
    }
  }

  return true;
}

function collectRoots(maxNodes: number): Element[] {
  const candidates = new Set<Element>();
  const root = document.body ?? document.documentElement;

  walkElements(root, (element) => {
    if (SKIP_TAGS.has(element.tagName)) {
      return;
    }
    if (!isImportantElement(element)) {
      return;
    }
    candidates.add(element);
    if (candidates.size >= maxNodes) {
      return false;
    }
  });

  return Array.from(candidates).filter((element) => !hasImportantAncestor(element, candidates));
}

function serializeAttributes(element: Element): string {
  return element
    .getAttributeNames()
    .map((name) => ` ${name}="${escapeHtml(element.getAttribute(name) ?? "")}"`)
    .join("");
}

function serializeNode(node: ChildNode, budget: Budget, visibleOnly: boolean): string {
  if (budget.remaining <= 0) {
    return "";
  }
  if (node.nodeType === Node.TEXT_NODE) {
    const text = collapseWhitespace(node.textContent || "");
    return text ? escapeHtml(text) : "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }
  return serializeElement(node as Element, budget, visibleOnly);
}

function serializeShadowRoot(root: ShadowRoot, budget: Budget, visibleOnly: boolean): string {
  let html = "<template shadowrootmode=\"open\">";
  for (const child of Array.from(root.childNodes)) {
    if (budget.remaining <= 0) {
      break;
    }
    html += serializeNode(child as ChildNode, budget, visibleOnly);
  }
  html += "</template>";
  return html;
}

function serializeChildren(element: Element, budget: Budget, visibleOnly: boolean): string {
  let html = "";
  if (element.shadowRoot) {
    html += serializeShadowRoot(element.shadowRoot, budget, visibleOnly);
  }
  for (const child of Array.from(element.childNodes)) {
    if (budget.remaining <= 0) {
      break;
    }
    html += serializeNode(child as ChildNode, budget, visibleOnly);
  }
  return html;
}

function serializeElement(element: Element, budget: Budget, visibleOnly: boolean): string {
  if (budget.remaining <= 0 || SKIP_TAGS.has(element.tagName) || (visibleOnly && !isElementVisible(element))) {
    return "";
  }

  budget.remaining -= 1;
  const tagName = element.tagName.toLowerCase();
  const children = serializeChildren(element, budget, visibleOnly);
  return `<${tagName}${serializeAttributes(element)}>${children}</${tagName}>`;
}

function renderForest(roots: Element[], maxNodes: number, visibleOnly: boolean): CaptureResult {
  const budget: Budget = { remaining: maxNodes };
  const html = roots.map((root) => serializeElement(root, budget, visibleOnly)).filter(Boolean).join("\n");
  return {
    html,
    rootCount: roots.length,
    totalNodes: Math.max(0, maxNodes - budget.remaining),
  };
}

function collectMatchingRoots(selector: string, maxNodes: number): Element[] {
  const matches = new Set<Element>();
  const root = document.body ?? document.documentElement;

  if (root.matches(selector)) {
    matches.add(root);
  }

  walkElements(root, (element) => {
    if (SKIP_TAGS.has(element.tagName)) {
      return;
    }
    if (!element.matches(selector)) {
      return;
    }
    matches.add(element);
    if (matches.size >= maxNodes) {
      return false;
    }
  });

  return Array.from(matches).filter((element) => !hasImportantAncestor(element, matches));
}

export function captureVisibleHtml(maxNodes = DEFAULT_CAPTURE_MAX_NODES): CaptureResult {
  return renderForest(collectRoots(maxNodes), maxNodes, true);
}

export function captureFilteredHtml(input: BrowserFilterInput): CaptureResult {
  const maxNodes = input.maxNodes ?? DEFAULT_CAPTURE_MAX_NODES;
  return renderForest(collectMatchingRoots(input.selector, maxNodes), maxNodes, false);
}
