interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Open Brewery DB MCP.
 *
 * Keyless directory of breweries worldwide — search by city, state, name, type,
 * or postal code; look up a single brewery; find breweries near a lat/lng point;
 * or free-text search across name and city. Data from api.openbrewerydb.org (v1).
 */


const BASE = 'https://api.openbrewerydb.org/v1';
const UA = 'pipeworx/1.0 (+https://pipeworx.io)';

const BREWERY_TYPES = 'micro|nano|regional|brewpub|large|planning|bar|contract|proprietor|closed';

const tools: McpToolExport['tools'] = [
  {
    name: 'search_breweries',
    description:
      'Search the Open Brewery DB directory by city, state, name, type, or postal code. At least one filter is required. Keyless. Returns compact brewery records (name, type, address, geo, phone, website).',
    inputSchema: {
      type: 'object',
      properties: {
        by_city: { type: 'string', description: 'Filter by city name, e.g. "Portland".' },
        by_state: {
          type: 'string',
          description: 'Filter by full state/province name, e.g. "California" (not "CA").',
        },
        by_name: { type: 'string', description: 'Filter by brewery name (partial match).' },
        by_type: {
          type: 'string',
          description: `Filter by brewery type: ${BREWERY_TYPES}.`,
        },
        by_postal: { type: 'string', description: 'Filter by postal/ZIP code, e.g. "97209".' },
        limit: { type: 'number', description: 'Max results (default 20, max 50).' },
      },
    },
  },
  {
    name: 'get_brewery',
    description:
      'Get a single brewery by its Open Brewery DB id (uuid or slug). Keyless. Returns the full compact brewery record.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The brewery id (uuid or slug), e.g. "madtree-brewing-cincinnati".' },
      },
      required: ['id'],
    },
  },
  {
    name: 'breweries_near',
    description:
      'Find breweries near a latitude/longitude point, sorted by distance. Keyless. Returns the origin point and nearby compact brewery records.',
    inputSchema: {
      type: 'object',
      properties: {
        latitude: { type: 'number', description: 'Origin latitude, e.g. 45.52.' },
        longitude: { type: 'number', description: 'Origin longitude, e.g. -122.68.' },
        limit: { type: 'number', description: 'Max results (default 15, max 50).' },
      },
      required: ['latitude', 'longitude'],
    },
  },
  {
    name: 'search_text',
    description:
      'Free-text search across brewery name and city in the Open Brewery DB directory. Keyless. Returns compact brewery records.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text query, e.g. "dog", "hop", "Cincinnati".' },
        limit: { type: 'number', description: 'Max results (default 15, max 50).' },
      },
      required: ['query'],
    },
  },
];

function clampLimit(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 50);
}

function compactBrewery(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    id: raw.id,
    name: raw.name,
    type: raw.brewery_type,
    address: raw.address_1,
    city: raw.city,
    state: raw.state_province,
    postal_code: raw.postal_code,
    country: raw.country,
    phone: raw.phone,
    website: raw.website_url,
    latitude: raw.latitude,
    longitude: raw.longitude,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'search_breweries':
        return searchBreweries(args);
      case 'get_brewery':
        return getBrewery(args);
      case 'breweries_near':
        return breweriesNear(args);
      case 'search_text':
        return searchText(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function searchBreweries(args: Record<string, unknown>): Promise<unknown> {
  const filters: Array<[string, string]> = [];
  for (const key of ['by_city', 'by_state', 'by_name', 'by_type', 'by_postal'] as const) {
    const v = typeof args[key] === 'string' ? (args[key] as string).trim() : '';
    if (v) filters.push([key, v]);
  }
  if (filters.length === 0) {
    return { error: 'provide at least one filter: by_city, by_state, by_name, by_type, or by_postal' };
  }
  const limit = clampLimit(args.limit, 20);

  const params = filters.map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  params.push(`per_page=${limit}`, 'page=1');
  const url = `${BASE}/breweries?${params.join('&')}`;

  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) return { error: `openbrewerydb: ${res.status} ${(await res.text()).slice(0, 200)}` };

  const arr = (await res.json()) as Array<Record<string, unknown>>;
  const list = Array.isArray(arr) ? arr : [];
  return { count: list.length, breweries: list.map(compactBrewery) };
}

async function getBrewery(args: Record<string, unknown>): Promise<unknown> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return { error: 'provide a brewery id', id: args.id ?? null };

  const url = `${BASE}/breweries/${encodeURIComponent(id)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (res.status === 404) return { error: 'brewery not found', id };
  if (!res.ok) return { error: `openbrewerydb: ${res.status} ${(await res.text()).slice(0, 200)}` };

  const raw = (await res.json()) as Record<string, unknown>;
  return compactBrewery(raw);
}

async function breweriesNear(args: Record<string, unknown>): Promise<unknown> {
  const latitude = typeof args.latitude === 'number' ? args.latitude : Number(args.latitude);
  const longitude = typeof args.longitude === 'number' ? args.longitude : Number(args.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { error: 'provide numeric latitude and longitude' };
  }
  const limit = clampLimit(args.limit, 15);

  const url = `${BASE}/breweries?by_dist=${latitude},${longitude}&per_page=${limit}`;
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) return { error: `openbrewerydb: ${res.status} ${(await res.text()).slice(0, 200)}` };

  const arr = (await res.json()) as Array<Record<string, unknown>>;
  const list = Array.isArray(arr) ? arr : [];
  return {
    count: list.length,
    origin: { latitude, longitude },
    breweries: list.map(compactBrewery),
  };
}

async function searchText(args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { error: 'provide a query', query: args.query ?? null };
  const limit = clampLimit(args.limit, 15);

  const url = `${BASE}/breweries/search?query=${encodeURIComponent(query)}&per_page=${limit}`;
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) return { error: `openbrewerydb: ${res.status} ${(await res.text()).slice(0, 200)}` };

  const arr = (await res.json()) as Array<Record<string, unknown>>;
  const list = Array.isArray(arr) ? arr : [];
  return { count: list.length, breweries: list.map(compactBrewery) };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
