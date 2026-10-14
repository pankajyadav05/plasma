/** What one CLI-driven chat run needs, whichever CLI runs it. */
export interface CliRun {
  /** How to start the program (a Windows shim already resolved). */
  launch: { command: string; args: string[] };
  /** Empty directory the CLI runs in. */
  cwd: string;
  model: string;
  /** Plasma's system prompt. */
  system: string;
  /** The conversation so far (compact transcript) plus the latest user message. */
  prompt: string;
  /** Images of the latest user message. */
  images: Array<{ mediaType: string; data: string; url: string }>;
  /** Plasma's tools for this chat; null = a task, no tools at all. */
  endpoint: { url: string; token: string } | null;
  /** Claude: file holding the system prompt. */
  systemPromptPath?: string;
  /** Names of the tools offered (Codex limits its MCP server to these). */
  toolNames?: string[];
  /** Claude: file holding the MCP config. */
  mcpConfigPath?: string;
  onDelta(text: string): void;
  signal: AbortSignal;
  timeoutMs?: number;
  /** Reasoning effort for the turn, when the user picked one the model offers (Codex: turn/start, Claude: --effort). */
  effort?: string;
  /** Codex: service tier for the turn (Fast), when picked. */
  serviceTier?: string;
  /** Codex: called for each flag name the installed version refused. */
  appVersion?: string;
}

export type CliRunResult = { ok: true } | { ok: false; message: string; aborted?: boolean };
