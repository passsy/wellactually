import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** A tool as the MCP server lists it. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** What a tool call answered. */
export interface McpResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

/** How long the server may take to answer before the call gives up. Starting it is the slow part. */
const TIMEOUT_MS = 30_000;

/**
 * The few calls of the Model Context Protocol an agent without MCP needs to
 * offer the server's tools as its own: list them, call one.
 *
 * It speaks newline-delimited JSON-RPC over the server's stdio, which is all
 * the protocol asks of a local server.
 */
export class McpClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private ready: Promise<void> | null = null;

  private readonly file: string;
  private readonly args: string[];
  private readonly client: { name: string; version: string };
  private readonly cwd: string;

  constructor(file: string, args: string[], client: { name: string; version: string }, cwd: string) {
    this.file = file;
    this.args = args;
    this.client = client;
    this.cwd = cwd;
  }

  /** Starts the server once, on first use, and introduces the client. */
  private start(): Promise<void> {
    this.ready ??= (async () => {
      const child = spawn(this.file, this.args, { cwd: this.cwd, stdio: ["pipe", "pipe", "ignore"] });
      this.child = child;
      child.on("exit", () => {
        this.child = null;
        this.ready = null;
        for (const { reject } of this.waiting.values()) {
          reject(new Error("the wellactually MCP server stopped"));
        }
        this.waiting.clear();
      });
      child.on("error", (error) => {
        for (const { reject } of this.waiting.values()) {
          reject(error);
        }
        this.waiting.clear();
      });
      createInterface({ input: child.stdout! }).on("line", (line) => this.receive(line));
      await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: this.client });
      this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    })();
    return this.ready;
  }

  async listTools(): Promise<McpTool[]> {
    await this.start();
    const result = (await this.request("tools/list", {})) as { tools?: McpTool[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: unknown, meta: Record<string, unknown>): Promise<McpResult> {
    await this.start();
    return (await this.request("tools/call", { name, arguments: args ?? {}, _meta: meta })) as McpResult;
  }

  close(): void {
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`the wellactually MCP server did not answer ${method}`));
      }, TIMEOUT_MS);
      this.waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private send(message: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const waiting = this.waiting.get(message.id);
    if (!waiting) {
      return;
    }
    this.waiting.delete(message.id);
    if (message.error) {
      waiting.reject(new Error(message.error.message ?? "the wellactually MCP server failed"));
    } else {
      waiting.resolve(message.result);
    }
  }
}
