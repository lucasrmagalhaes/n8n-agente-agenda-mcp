#!/usr/bin/env node
/**
 * Confere a estrutura dos workflows exportáveis contra os typeVersions
 * do n8n 2.44.6 / 2.45.3 (ver README). Não executa o n8n.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const EXPECTED = {
  "@n8n/n8n-nodes-langchain.chatTrigger": 1.5,
  "@n8n/n8n-nodes-langchain.agent": 3.1,
  "@n8n/n8n-nodes-langchain.lmChatGoogleGemini": 1.2,
  "@n8n/n8n-nodes-langchain.lmChatOllama": 1,
  "@n8n/n8n-nodes-langchain.memoryBufferWindow": 1.4,
  "@n8n/n8n-nodes-langchain.toolThink": 1.1,
  "@n8n/n8n-nodes-langchain.mcpClientTool": 1.4,
  "@n8n/n8n-nodes-langchain.mcpTrigger": 2.1,
  "n8n-nodes-base.googleCalendarTool": 1.3,
  "n8n-nodes-base.stickyNote": 1,
};

const CALENDAR_TOOLS = [
  "create_google_calendar_event",
  "list_google_calendar_events",
  "reschedule_google_calendar_event",
  "delete_google_calendar_event",
];

const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z\-_]{20,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /ya29\.[0-9A-Za-z\-_]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const seenIds = new Set();

function claimId(file, label, id) {
  if (typeof id !== "string" || !UUID_V4.test(id)) fail(file, `${label} não é UUID v4: ${id}`);
  if (seenIds.has(id)) fail(file, `id repetido entre os workflows: ${id} (${label})`);
  seenIds.add(id);
}

function fail(file, message) {
  throw new Error(`${file}: ${message}`);
}

function load(relative) {
  const raw = readFileSync(resolve(root, relative), "utf8");
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(raw)) fail(relative, `possível segredo encontrado (${pattern})`);
  }
  return JSON.parse(raw);
}

function assertConnection(workflow, file, from, type, to) {
  const group = workflow.connections[from]?.[type];
  const hit = group?.some((outputs) => outputs.some((edge) => edge.node === to && edge.type === type));
  if (!hit) fail(file, `falta conexão ${from} -[${type}]-> ${to}`);
}

function validate(relative, { modelType, modelName, mcpPath }) {
  const workflow = load(relative);
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
    fail(relative, "nodes vazio");
  }
  if (workflow.active !== false) fail(relative, "workflow deve ser importado inativo");
  if (workflow.settings?.executionOrder !== "v1") fail(relative, "executionOrder");
  if (workflow.settings?.timezone !== "America/Sao_Paulo") fail(relative, "timezone do workflow");

  const byName = new Map();
  for (const node of workflow.nodes) {
    if (byName.has(node.name)) fail(relative, `nome duplicado: ${node.name}`);
    byName.set(node.name, node);
    const expected = EXPECTED[node.type];
    if (expected === undefined) fail(relative, `tipo desconhecido: ${node.type}`);
    if (node.typeVersion !== expected) {
      fail(relative, `${node.name} typeVersion ${node.typeVersion}, esperado ${expected}`);
    }
    if (!node.id || !Array.isArray(node.position)) fail(relative, `${node.name} sem id/position`);
    claimId(relative, `${node.name} id`, node.id);
    const expectsWebhook =
      node.type === "@n8n/n8n-nodes-langchain.chatTrigger" ||
      node.type === "@n8n/n8n-nodes-langchain.mcpTrigger";
    if (expectsWebhook) {
      if (!node.webhookId) fail(relative, `${node.name} sem webhookId`);
      claimId(relative, `${node.name} webhookId`, node.webhookId);
    } else if (node.webhookId) {
      fail(relative, `${node.name} não deveria ter webhookId`);
    }
  }

  const chat = byName.get("When chat message received");
  const agent = byName.get("AI Agent");
  const memory = byName.get("Simple Memory");
  const think = byName.get("Think");
  const client = byName.get("MCP Client");
  const server = byName.get("MCP Server Trigger");
  const model = [...byName.values()].find((node) => node.type === modelType);
  if (!chat || !agent || !memory || !think || !client || !server || !model) {
    fail(relative, "nó obrigatório ausente");
  }

  if (chat.parameters.public !== true) fail(relative, "Chat Trigger deve ser public: true");
  if (chat.parameters.mode !== "hostedChat") fail(relative, "Chat Trigger deve usar hostedChat");

  if (agent.parameters.promptType !== "define") fail(relative, "promptType");
  if (agent.parameters.text !== "={{ $json.chatInput }}") fail(relative, "prompt do chat");
  const system = agent.parameters.options?.systemMessage ?? "";
  if (!system.includes("{{ $now.setZone('America/Sao_Paulo') }}")) {
    fail(relative, "system message sem $now.setZone");
  }
  if (!system.includes("listagem de eventos")) fail(relative, "system message da aula");
  if (!system.startsWith("=")) fail(relative, "system message precisa iniciar com =");

  if (memory.parameters.contextWindowLength !== 10) fail(relative, "janela de memória");
  if (memory.parameters.sessionIdType !== "fromInput") fail(relative, "sessionIdType");

  if (client.parameters.serverTransport !== "httpStreamable") fail(relative, "transporte MCP");
  if (client.parameters.authentication !== "none") fail(relative, "auth do MCP client");
  const endpoint = `http://localhost:5678/mcp/${mcpPath}`;
  if (client.parameters.endpointUrl !== endpoint) fail(relative, `endpoint MCP: ${client.parameters.endpointUrl}`);
  if (String(client.parameters.endpointUrl).includes("/sse")) fail(relative, "URL não pode usar /sse no trigger v2");
  if (server.parameters.path !== mcpPath) fail(relative, "path do MCP Server Trigger");
  if (server.parameters.authentication !== "none") fail(relative, "auth do MCP trigger");

  if (modelType === "@n8n/n8n-nodes-langchain.lmChatGoogleGemini") {
    if (model.parameters.modelName !== "models/gemini-3.5-flash-lite") fail(relative, "modelo Gemini");
    const cred = model.credentials?.googlePalmApi;
    if (!cred || cred.id !== "PLACEHOLDER_GEMINI") fail(relative, "placeholder Gemini");
  } else {
    if (model.parameters.model !== "llama3.2") fail(relative, "modelo Ollama");
    if (model.credentials?.ollamaApi?.id !== "PLACEHOLDER_OLLAMA") fail(relative, "placeholder Ollama");
  }

  for (const name of CALENDAR_TOOLS) {
    const node = byName.get(name);
    if (!node) fail(relative, `tool ausente: ${name}`);
    if (node.parameters.descriptionType !== "manual") fail(relative, `${name} descriptionType`);
    if (!node.parameters.toolDescription || node.parameters.toolDescription.length < 40) {
      fail(relative, `${name} sem tool description`);
    }
    if (node.parameters.calendar?.value !== "COLOQUE_SEU_EMAIL@gmail.com") {
      fail(relative, `${name} calendar placeholder`);
    }
    if (node.credentials?.googleCalendarOAuth2Api?.id !== "PLACEHOLDER_GOOGLE_CALENDAR") {
      fail(relative, `${name} credencial`);
    }
    const blob = JSON.stringify(node.parameters);
    if (!blob.includes("$fromAI(")) fail(relative, `${name} sem $fromAI`);
  }

  const create = byName.get("create_google_calendar_event");
  if (create.parameters.operation !== "create") fail(relative, "operation create");
  if (!create.parameters.additionalFields?.summary?.includes("$fromAI('summary'")) {
    fail(relative, "summary");
  }
  if (!create.parameters.additionalFields?.description?.includes("$fromAI('description'")) {
    fail(relative, "description");
  }
  const attendee = create.parameters.additionalFields?.attendees?.[0] ?? "";
  if (!attendee.includes("$fromAI('attendee'")) fail(relative, "attendee");
  if (!String(create.parameters.end).includes("30")) fail(relative, "duração de 30 min no end");

  const list = byName.get("list_google_calendar_events");
  if (list.parameters.operation !== "getAll" || list.parameters.returnAll !== true) {
    fail(relative, "getAll/returnAll");
  }
  if (!String(list.parameters.timeMin).includes("$fromAI('start'")) fail(relative, "timeMin");
  if (!String(list.parameters.timeMax).includes("$fromAI('end'")) fail(relative, "timeMax");
  if (!/\$fromAI\(\s*'start'\s*,\s*'[^']*'\s*,\s*'string'\s*\)/.test(String(list.parameters.timeMin))) {
    fail(relative, "start da listagem deve continuar obrigatório");
  }
  if (!/\$fromAI\(\s*'end'\s*,\s*'[^']*'\s*,\s*'string'\s*\)/.test(String(list.parameters.timeMax))) {
    fail(relative, "end da listagem deve continuar obrigatório");
  }
  const attendeeQuery = String(list.parameters.options?.query ?? "");
  if (
    !/\$fromAI\(\s*'attendee_email'\s*,\s*'[^']*'\s*,\s*'string'\s*,\s*''\s*\)/.test(attendeeQuery)
  ) {
    fail(relative, "attendee_email deve ser opcional, com default vazio no $fromAI");
  }

  const update = byName.get("reschedule_google_calendar_event");
  if (update.parameters.operation !== "update") fail(relative, "update");
  if (!String(update.parameters.eventId).includes("$fromAI('event_id'")) fail(relative, "event_id update");
  if (!String(update.parameters.updateFields?.start).includes("$fromAI('new_start'")) fail(relative, "new_start");
  if (!String(update.parameters.updateFields?.end).includes("$fromAI('new_end'")) fail(relative, "new_end");

  const del = byName.get("delete_google_calendar_event");
  if (del.parameters.operation !== "delete") fail(relative, "delete");
  if (!String(del.parameters.eventId).includes("$fromAI('event_id'")) fail(relative, "event_id delete");
  if (!del.parameters.toolDescription.toLowerCase().includes("e-mail")) {
    fail(relative, "delete deve pedir o e-mail");
  }

  assertConnection(workflow, relative, "When chat message received", "main", "AI Agent");
  assertConnection(workflow, relative, model.name, "ai_languageModel", "AI Agent");
  assertConnection(workflow, relative, "Simple Memory", "ai_memory", "AI Agent");
  assertConnection(workflow, relative, "Think", "ai_tool", "AI Agent");
  assertConnection(workflow, relative, "MCP Client", "ai_tool", "AI Agent");
  for (const name of CALENDAR_TOOLS) {
    assertConnection(workflow, relative, name, "ai_tool", "MCP Server Trigger");
  }

  const referenced = new Set();
  for (const [from, outputs] of Object.entries(workflow.connections)) {
    if (!byName.has(from)) fail(relative, `conexão de nó inexistente: ${from}`);
    for (const group of Object.values(outputs)) {
      for (const edges of group) {
        for (const edge of edges) {
          if (!byName.has(edge.node)) fail(relative, `conexão para nó inexistente: ${edge.node}`);
          referenced.add(edge.node);
        }
      }
    }
  }
  if (!referenced.has("AI Agent") || !referenced.has("MCP Server Trigger")) {
    fail(relative, "agente ou MCP trigger sem entradas");
  }

  console.log(`ok ${relative} (${workflow.nodes.length} nós, modelo ${modelName})`);
}

validate("workflows/agente-agenda-mcp.json", {
  modelType: "@n8n/n8n-nodes-langchain.lmChatGoogleGemini",
  modelName: "models/gemini-3.5-flash-lite",
  mcpPath: "agenda",
});
validate("workflows/agente-agenda-mcp-ollama.json", {
  modelType: "@n8n/n8n-nodes-langchain.lmChatOllama",
  modelName: "llama3.2",
  mcpPath: "agenda-ollama",
});
