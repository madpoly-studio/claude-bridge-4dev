// Endpoint MCP của bus tại `/mcp` (streamable HTTP, STATELESS: mỗi request một server + transport mới).
// Dùng `Server` mức thấp thay vì `McpServer` vì cần: liệt kê tool theo role của token, và trả lỗi
// validate input dạng BusErrorBody (McpServer tự trả text thường cho lỗi schema).
import { BUS_MCP_PATH, BUS_MCP_SERVER_NAME } from "@claude-bridge/protocol";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { BusError } from "./errors.js";
import { type McpPrincipal, buildBusTools, callBusTool, inputJsonSchema, toolsForRole } from "./mcpTools.js";
import type { TaskBus } from "./taskBus.js";
import { type BusTokens, bearerToken } from "./tokens.js";

export interface McpEndpointDeps {
  bus: TaskBus;
  tokens: BusTokens;
  serverVersion: string;
}

export function registerMcpEndpoint(app: FastifyInstance, deps: McpEndpointDeps): void {
  const tools = buildBusTools(deps.bus);

  const resolvePrincipal = (header: string | string[] | undefined): McpPrincipal => {
    const token = bearerToken(header);
    if (!token) throw new BusError("UNAUTHORIZED", "missing bearer token");
    if (deps.tokens.isOrchestratorToken(token)) return { role: "orchestrator" };
    const taskId = deps.bus.resolveTaskToken(token);
    if (taskId) return { role: "worker", task_id: taskId };
    throw new BusError("UNAUTHORIZED", "invalid bus token");
  };

  const createServer = (principal: McpPrincipal): Server => {
    const server = new Server({ name: BUS_MCP_SERVER_NAME, version: deps.serverVersion }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: toolsForRole(principal).map((name) => {
        const t = tools.get(name);
        if (!t) throw new Error(`bus tool ${name} is not defined`);
        return { name: t.name, description: t.description, inputSchema: inputJsonSchema(t.schema) };
      }),
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) =>
      callBusTool(tools, principal, request.params.name, request.params.arguments),
    );
    return server;
  };

  app.post(BUS_MCP_PATH, async (request, reply) => {
    let principal: McpPrincipal;
    try {
      principal = resolvePrincipal(request.headers.authorization);
    } catch (err) {
      if (err instanceof BusError) return reply.code(401).send(err.toBody());
      throw err;
    }
    const server = createServer(principal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // Stateless: không có stream SSE độc lập và không có session để xóa.
  const methodNotAllowed = async (_req: unknown, reply: FastifyReply) =>
    reply
      .code(405)
      .header("allow", "POST")
      .send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless MCP endpoint)" }, id: null });
  app.get(BUS_MCP_PATH, methodNotAllowed);
  app.delete(BUS_MCP_PATH, methodNotAllowed);
}
