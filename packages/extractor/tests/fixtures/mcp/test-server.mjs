import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const ITEMS = [
  { id: '1', name: 'alpha', status: 'open', updatedAt: '2026-03-25T00:00:00.000Z' },
  { id: '2', name: 'beta', status: 'open', updatedAt: '2026-03-26T00:00:00.000Z' },
  { id: '3', name: 'gamma', status: 'closed', updatedAt: '2026-03-27T00:00:00.000Z' },
];

function buildPage(cursorValue, status) {
  const filtered = status ? ITEMS.filter((item) => item.status === status) : ITEMS;
  if (cursorValue) {
    const cursorIndex = filtered.findIndex((item) => item.id === cursorValue);
    if (cursorIndex === -1) {
      throw new Error(`Unknown cursor: ${cursorValue}`);
    }
  }
  const startIndex = cursorValue ? filtered.findIndex((item) => item.id === cursorValue) + 1 : 0;
  const page = filtered.slice(startIndex, startIndex + 1);
  const hasMore = startIndex + page.length < filtered.length;
  const next = hasMore ? (page[page.length - 1]?.id ?? null) : null;

  return {
    items: page,
    pageInfo: {
      endCursor: next,
    },
  };
}

const TOOLS = [
  {
    name: 'list_items',
    description: 'Lists fixture items',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' }, after: { type: 'string' } },
    },
  },
  {
    name: 'lookup_item',
    description: 'Looks up item by id',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'text_only_items',
    description: 'Returns JSON as text',
    inputSchema: { type: 'object', properties: { status: { type: 'string' } } },
  },
  {
    name: 'error_tool',
    description: 'Always errors',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'slow_tool',
    description: 'Slow tool for timeout tests',
    inputSchema: { type: 'object', properties: { delay_ms: { type: 'number' } } },
  },
  {
    name: 'offset_items',
    description: 'Offset paginated items',
    inputSchema: {
      type: 'object',
      properties: { offset: { type: 'number' }, limit: { type: 'number' } },
    },
  },
  {
    name: 'paged_items',
    description: 'Page number paginated items',
    inputSchema: {
      type: 'object',
      properties: { page: { type: 'number' }, per_page: { type: 'number' } },
    },
  },
  {
    name: 'rate_limited_tool',
    description: 'Rate limit error',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'auth_error_tool',
    description: 'Auth error',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_with_since',
    description: 'Lists items updated since a timestamp',
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'string' } },
    },
  },
  {
    name: 'search_with_filter_groups',
    description: 'Returns the received HubSpot-style filter groups',
    inputSchema: {
      type: 'object',
      properties: { filterGroups: { type: 'array' } },
    },
  },
  {
    name: 'list_with_output_schema',
    description: 'Declares an output schema for discovery',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', examples: ['secret-id'] },
              updatedAt: { type: 'string', format: 'date-time', default: '2026-01-01T00:00:00Z' },
            },
          },
        },
      },
    },
  },
  {
    name: 'get_requires_empty_object',
    description: 'Requires callers to send an object even when it has no arguments',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'evil_redirect',
    description: 'Returns redirect-like data that should remain inert',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_error_leaks_values',
    description: 'Errors with token-like values for redaction tests',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_item',
    description: 'Mutating tool that discovery must not dry-run',
    inputSchema: { type: 'object', properties: {} },
  },
];

const server = new Server(
  { name: 'extractor-test-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'list_items': {
      const result = buildPage(args?.after, args?.status);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    case 'lookup_item': {
      const item = ITEMS.find((entry) => entry.id === args?.id) ?? null;
      return { content: [{ type: 'text', text: JSON.stringify({ item }) }] };
    }
    case 'text_only_items': {
      const result = buildPage(undefined, args?.status);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    case 'error_tool': {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Something went wrong in the tool' }],
      };
    }
    case 'slow_tool': {
      const delay = args?.delay_ms ?? 5000;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { content: [{ type: 'text', text: '{"ok": true}' }] };
    }
    case 'offset_items': {
      const off = args?.offset ?? 0;
      const lim = args?.limit ?? 10;
      const allItems = Array.from({ length: 35 }, (_, i) => ({ id: i + 1, name: `item_${i + 1}` }));
      const page = allItems.slice(off, off + lim);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              items: page,
              meta: { total: allItems.length, offset: off, limit: lim },
            }),
          },
        ],
      };
    }
    case 'paged_items': {
      const pg = args?.page ?? 1;
      const pp = args?.per_page ?? 10;
      const allItems = Array.from({ length: 35 }, (_, i) => ({ id: i + 1, name: `item_${i + 1}` }));
      const totalPages = Math.ceil(allItems.length / pp);
      const start = (pg - 1) * pp;
      const pageItems = allItems.slice(start, start + pp);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              items: pageItems,
              meta: { total: allItems.length, pages: totalPages, page: pg, per_page: pp },
            }),
          },
        ],
      };
    }
    case 'rate_limited_tool': {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Rate limit exceeded. Too many requests. Please retry after 5 seconds.',
          },
        ],
      };
    }
    case 'auth_error_tool': {
      return {
        isError: true,
        content: [
          { type: 'text', text: 'Unauthorized: Invalid credentials. Please check your API key.' },
        ],
      };
    }
    case 'list_with_since': {
      const since = args?.since ?? '1970-01-01T00:00:00.000Z';
      const result = {
        items: ITEMS.filter((item) => item.updatedAt >= since),
      };
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    case 'search_with_filter_groups': {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ received: args ?? {} }),
          },
        ],
      };
    }
    case 'list_with_output_schema': {
      return {
        structuredContent: {
          items: ITEMS,
        },
        content: [{ type: 'text', text: JSON.stringify({ items: ITEMS }) }],
      };
    }
    case 'get_requires_empty_object': {
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Arguments must be an object' }],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
      };
    }
    case 'evil_redirect': {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              redirectUrl: 'https://169.254.169.254/latest/meta-data',
              items: [],
            }),
          },
        ],
      };
    }
    case 'list_error_leaks_values': {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'token sk-test_1234567890abcdef and email admin@example.com and api_key ghp_1234567890abcdef',
          },
        ],
      };
    }
    case 'create_item': {
      return {
        isError: true,
        content: [{ type: 'text', text: 'create_item should not be called by discovery' }],
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
