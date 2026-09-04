declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionToolResult {
    content: Array<{ type: string; text?: string }>;
    details: unknown;
  }

  export interface CommandCompletionItem {
    value: string;
    label: string;
  }

  export interface ExtensionContext {
    notify?(message: string, level?: "info" | "warn" | "error"): void;
    ui: {
      notify(message: string, level?: "info" | "warn" | "error"): void;
      setStatus(key: string, value?: string): void;
    };
    sessionManager?: {
      getSessionFile?: () => string | undefined;
    };
  }

  export interface ExtensionToolDefinition<TParams = unknown> {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(
      toolCallId: string,
      params: TParams,
      signal: AbortSignal,
      onUpdate: (value: unknown) => void,
      ctx: ExtensionContext,
    ): Promise<ExtensionToolResult>;
    renderCall?(args: TParams, theme: unknown, context?: unknown): unknown;
    renderResult?(
      result: ExtensionToolResult,
      options: { expanded?: boolean; isPartial?: boolean },
      theme: unknown,
      context?: unknown,
    ): unknown;
  }

  export interface ExtensionCommandDefinition {
    description: string;
    getArgumentCompletions?(prefix: string): Promise<CommandCompletionItem[] | null> | CommandCompletionItem[] | null;
    handler(args: string, ctx: ExtensionContext): Promise<void> | void;
  }

  export interface ExtensionAPI {
    on(eventName: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
    registerTool<TParams>(definition: ExtensionToolDefinition<TParams>): void;
    registerCommand(name: string, definition: ExtensionCommandDefinition): void;
  }
}
