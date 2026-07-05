/**
 * ACIL MCP — MCPServer
 *
 * Implements the Model Context Protocol (MCP) JSON-RPC 2.0 stdio transport.
 * See: https://spec.modelcontextprotocol.io
 *
 * Protocol flow:
 *   1. Client sends initialize request → server responds with capabilities
 *   2. Client sends tools/list request → server responds with tool schemas
 *   3. Client sends tools/call request → server executes tool, returns result
 *
 * All communication is over stdin/stdout as newline-delimited JSON.
 *
 * Author: imKrisK — Wave 11 MCP Integration
 */

import * as readline from 'readline';
import { ACILRuntime } from './ACILRuntime';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id:      string | number | null;
  method:  string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id:      string | number | null;
  result?: unknown;
  error?:  { code: number; message: string };
}

// ── Tool schemas (MCP JSON Schema) ────────────────────────────────────────────

const TOOLS = [
  {
    name: 'acil_preflight',
    description: 'Pre-execution ACIL cost governance check. Call BEFORE sending a prompt to any LLM. Returns estimated cost, enforcement state, whether CCT compression is recommended, and a cheaper model suggestion.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt:       { type: 'string',  description: 'The prompt text you are about to send' },
        model:        { type: 'string',  description: 'The model you intend to use (e.g. "gpt-4o", "claude-3-5-sonnet")' },
        session_type: { type: 'string',  description: 'Optional session type hint: DEBUGGING | ARCHITECTURE | BOILERPLATE | AGENTIC | CODE_REVIEW | EXPLORATION | DOCUMENTATION' },
      },
      required: ['prompt', 'model'],
    },
  },
  {
    name: 'acil_status',
    description: 'Get current ACIL budget status: balance, spend percentage, today\'s cost, developer archetype, and enforcement state.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'acil_forecast',
    description: 'Forecast when your AI credit budget will be exhausted. Returns exhaustion date, days remaining, and risk level (LOW/MEDIUM/HIGH/CRITICAL).',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Forecast horizon in days (default: 30)' },
      },
    },
  },
  {
    name: 'acil_budget',
    description: 'Get or update your ACIL monthly budget allocation.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set'], description: '"get" returns current budget. "set" updates it.' },
        value:  { type: 'number', description: 'New monthly budget in USD (required when action is "set")' },
      },
      required: ['action'],
    },
  },
  {
    name: 'acil_feedback',
    description: 'Record developer feedback on an ACIL recommendation. This closes the MetaRecursiveLoop and improves future predictions.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['MODEL_SUB_ACCEPTED','MODEL_SUB_REJECTED','CCT_ACCEPTED','CCT_REJECTED','SOFT_BLOCK_OVERRIDDEN','AGENTIC_CONFIRMED','AGENTIC_CANCELLED','BUDGET_INCREASED','BUDGET_IGNORED'],
          description: 'The feedback action to record',
        },
        context: { type: 'string', description: 'Optional context string (e.g. "gpt-4o→gpt-4o-mini", "savings=34%")' },
      },
      required: ['action'],
    },
  },
  {
    name: 'acil_feedback_summary',
    description: 'Get a summary of feedback signals collected so far — accept rates, threshold biases, and learning recommendations.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'acil_compliance',
    description: 'Export a HMAC-signed audit batch for compliance purposes (SOC 2, HIPAA, EU AI Act). Returns a tamper-proof JSON envelope with CSV payload.',
    inputSchema: {
      type: 'object',
      properties: {
        hmac_key: { type: 'string', description: 'HMAC signing key. Keep this in a secrets manager.' },
      },
      required: ['hmac_key'],
    },
  },
];

// ── MCPServer ─────────────────────────────────────────────────────────────────

export class MCPServer {
  private _runtime: ACILRuntime;

  constructor(runtime: ACILRuntime) {
    this._runtime = runtime;
  }

  start(): void {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const req = JSON.parse(trimmed) as JsonRpcRequest;
        void this._handle(req).then(res => {
          if (res !== null) {
            process.stdout.write(JSON.stringify(res) + '\n');
          }
        });
      } catch {
        // Malformed JSON — send parse error
        const err: JsonRpcResponse = {
          jsonrpc: '2.0', id: null,
          error: { code: -32700, message: 'Parse error' },
        };
        process.stdout.write(JSON.stringify(err) + '\n');
      }
    });
    rl.on('close', () => process.exit(0));
  }

  private async _handle(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null;

    switch (req.method) {
      // ── MCP lifecycle ───────────────────────────────────────────────────
      case 'initialize':
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities:    { tools: { listChanged: false } },
            serverInfo:      { name: 'acil-mcp', version: '0.1.0' },
          },
        };

      case 'notifications/initialized':
        return null; // notification — no response

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      // ── Tool discovery ──────────────────────────────────────────────────
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

      // ── Tool execution ──────────────────────────────────────────────────
      case 'tools/call':
        return await this._callTool(req);

      default:
        return {
          jsonrpc: '2.0', id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        };
    }
  }

  private async _callTool(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id     = req.id ?? null;
    const params = (req.params ?? {}) as Record<string, unknown>;
    const name   = params['name'] as string | undefined;
    const args   = (params['arguments'] ?? {}) as Record<string, unknown>;

    try {
      let content: unknown;

      switch (name) {
        case 'acil_preflight': {
          const prompt   = String(args['prompt']  ?? '');
          const model    = String(args['model']   ?? 'copilot-premium');
          const sessType = args['session_type'] as string | undefined;
          content = await this._runtime.preflight(
            prompt,
            model as import('@nit-in/acil').ModelId,
            sessType as import('@nit-in/acil').SessionType | undefined,
          );
          break;
        }
        case 'acil_status': {
          content = this._runtime.getStatus();
          break;
        }
        case 'acil_forecast': {
          const days = typeof args['days'] === 'number' ? args['days'] : 30;
          content = this._runtime.getForecast(days);
          break;
        }
        case 'acil_budget': {
          const action = String(args['action'] ?? 'get') as 'get' | 'set';
          const value  = typeof args['value'] === 'number' ? args['value'] : undefined;
          content = this._runtime.getOrSetBudget(action, value);
          break;
        }
        case 'acil_feedback': {
          const action  = String(args['action']  ?? '');
          const context = args['context'] ? String(args['context']) : undefined;
          this._runtime.recordFeedback(action, context);
          content = { recorded: true, action };
          break;
        }
        case 'acil_feedback_summary': {
          content = this._runtime.getFeedbackSummary();
          break;
        }
        case 'acil_compliance': {
          const hmacKey = String(args['hmac_key'] ?? '');
          if (!hmacKey) {
            return { jsonrpc: '2.0', id, error: { code: -32602, message: 'hmac_key is required' } };
          }
          content = this._runtime.exportCompliance(hmacKey);
          break;
        }
        default:
          return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      }

      return {
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(content, null, 2) }],
          isError: false,
        },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: `ACIL error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        },
      };
    }
  }
}
