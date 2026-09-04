import test from "node:test";
import assert from "node:assert/strict";
import { attachToolRenderMeta, buildBrowserTitleLine, buildToolResultView, renderToolResult } from "../pi-extension/render";
import { MAX_INLINE_HTML } from "../pi-extension/shared/limits";

test("renderToolResult truncates long html to temp file", async () => {
  const html = `<div>${"a".repeat(MAX_INLINE_HTML + 128)}</div>`;
  const result = await renderToolResult("browser_snapshot", { html });
  assert.equal(result.content[0]?.type, "text");
  assert.match(result.content[0]?.text ?? "", /truncated=true tempFile=/);
  assert.equal((result.details as { truncated: boolean }).truncated, true);
});

test("renderToolResult renders browser_filter as html", async () => {
  const html = "<section><div>match</div></section>";
  const result = await renderToolResult("browser_filter", { html, rootCount: 1, totalNodes: 2 });
  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.text, html);
});

test("buildToolResultView collapses html tools and keeps expanded html", async () => {
  const html = "<section>\n  <div>match</div>\n</section>";
  const result = await renderToolResult("browser_filter", { html, rootCount: 1, totalNodes: 2 });
  const view = buildToolResultView("browser_filter", result);

  assert.match(view.collapsed[0] ?? "", /39 chars · 1 roots · 2 nodes/);
  assert.match(view.collapsed[1] ?? "", /<section> <div>match<\/div> <\/section>/);
  assert.match(view.collapsed[2] ?? "", /ctrl\+o to expand/);
  assert.equal(view.expanded[1], html);
});

test("buildToolResultView summarizes tab lists in collapsed mode", async () => {
  const result = await renderToolResult("browser_tabs", [
    { tabID: "1", title: "First tab", url: "https://example.com", active: true, executorReady: true },
    { tabID: "2", title: "Second tab", url: "https://example.org", active: false, injectable: true },
    { tabID: "3", title: "Third tab", active: false },
    { tabID: "4", title: "Fourth tab", active: false },
  ]);
  const view = buildToolResultView("browser_tabs", result);

  assert.equal(view.collapsed[0], "4 tabs");
  assert.match(view.collapsed[1] ?? "", /1 \[active, ready\] First tab/);
  assert.match(view.collapsed[3] ?? "", /3 Third tab/);
  assert.equal(view.collapsed[4], "... (1 more tabs, ctrl+o to expand)");
  assert.equal(view.expanded.length, 5);
});

test("buildBrowserTitleLine formats bold actions, accent selectors, and dim urls", async () => {
  const theme = {
    fg(color: string, text: string) {
      return `<${color}>${text}</${color}>`;
    },
    bold(text: string) {
      return `<b>${text}</b>`;
    },
  };

  const filterResult = attachToolRenderMeta(
    await renderToolResult("browser_filter", { html: "<div>ok</div>", rootCount: 1, totalNodes: 1 }),
    { selector: ".cta", tabURL: "https://example.com" },
  );
  const navigateResult = attachToolRenderMeta(
    await renderToolResult("browser_navigate", { ok: true }),
    { action: "goto", url: "https://example.org" },
  );
  const actResult = attachToolRenderMeta(
    await renderToolResult("browser_act", { ok: true, action: "click" }),
    { action: "click", selector: ".cta button", tabURL: "https://example.net" },
  );
  const tabsResult = attachToolRenderMeta(await renderToolResult("browser_tabs", []), { action: "activate" });

  assert.equal(
    buildBrowserTitleLine("browser_filter", filterResult, theme),
    "<toolTitle><b>browser_filter</b></toolTitle> <accent>.cta</accent> <dim>https://example.com</dim>",
  );
  assert.equal(
    buildBrowserTitleLine("browser_navigate", navigateResult, theme),
    "<toolTitle><b>browser_navigate</b></toolTitle> <toolTitle><b>goto</b></toolTitle> <dim>https://example.org</dim>",
  );
  assert.equal(
    buildBrowserTitleLine("browser_act", actResult, theme),
    "<toolTitle><b>browser_act</b></toolTitle> <toolTitle><b>click</b></toolTitle> <accent>.cta button</accent> <dim>https://example.net</dim>",
  );
  assert.equal(
    buildBrowserTitleLine("browser_tabs", tabsResult, theme),
    "<toolTitle><b>browser_tabs</b></toolTitle> <toolTitle><b>activate</b></toolTitle>",
  );
});
