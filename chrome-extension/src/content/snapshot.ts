import type { SnapshotResult } from "../shared/browser-types";

function cloneSerializableNode(node: ChildNode, ownerDocument: Document): Node | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return ownerDocument.createTextNode(node.textContent ?? "");
  }

  if (node.nodeType === Node.COMMENT_NODE) {
    return ownerDocument.createComment(node.textContent ?? "");
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const element = node as Element;
  const clone = element.cloneNode(false) as Element;

  if (element instanceof HTMLTemplateElement && clone instanceof HTMLTemplateElement) {
    for (const child of Array.from(element.content.childNodes)) {
      const childClone = cloneSerializableNode(child as ChildNode, ownerDocument);
      if (childClone) {
        clone.content.appendChild(childClone);
      }
    }
    return clone;
  }

  if (element.shadowRoot) {
    const shadowTemplate = ownerDocument.createElement("template");
    shadowTemplate.setAttribute("shadowrootmode", "open");
    for (const child of Array.from(element.shadowRoot.childNodes)) {
      const childClone = cloneSerializableNode(child as ChildNode, ownerDocument);
      if (childClone) {
        shadowTemplate.content.appendChild(childClone);
      }
    }
    clone.appendChild(shadowTemplate);
  }

  for (const child of Array.from(element.childNodes)) {
    const childClone = cloneSerializableNode(child as ChildNode, ownerDocument);
    if (childClone) {
      clone.appendChild(childClone);
    }
  }

  return clone;
}

export function getSnapshot(): SnapshotResult {
  const clone = cloneSerializableNode(document.documentElement, document) as HTMLElement | null;
  return {
    html: clone?.outerHTML ?? document.documentElement.outerHTML,
  };
}
