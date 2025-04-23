// Guesty MCP Server – Refactored for production use
// -----------------------------------------------------
// * Single-flight OAuth token refresh with back-off
// * Axios keep-alive agent + auto-retry on 429/5xx
// * Basic env-var validation & configurable CORS
// * Endpoint constants, health-check, stricter manifest
// -----------------------------------------------------

const express = require('express');
const axios = require('axios');
const axiosRetry = require('axios-retry');
const cors = require('cors');
const dotenv = require('dotenv');
const https = require('https');
const { URLSearchParams } = require('url');

// ---------------------------------------------------------------------------
// 1 · Load & validate environment variables
// ---------------------------------------------------------------------------

dotenv.config();

const REQUIRED_ENV = [
  'GUESTY_CLIENT_ID',
  'GUESTY_CLIENT_SECRET',
];

REQUIRED_ENV.forEach((key) => {
  if (!process.env[key]) {
    console.error(`❌ Missing required env var: ${key}`);
    process.exit(1);
  }
});

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',').map((o) => o.trim());

// ---------------------------------------------------------------------------
// 2 · Constants & helpers
// ---------------------------------------------------------------------------

const ENDPOINTS = {
  LISTINGS: '/listings',
  RESERVATIONS: '/reservations',
  GUESTS: '/guests',
  COMMUNICATIONS: '/communications',
};

const API = {
  BASE: 'https://open-api.guesty.com/v1',
  TOKEN: 'https://open-api.guesty.com/oauth2/token',
};

// Axios global agent (keep-alive)
const httpsAgent = new https.Agent({ keepAlive: true });

// Create a dedicated axios instance
const api = axios.create({
  baseURL: API.BASE,
  httpsAgent,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
});

// Retry policy – exponential back-off, max 3 attempts
axiosRetry(api, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (err) => {
    if (!err.response) return true; // network / timeout
    const { status } = err.response;
    return status === 429 || status >= 500;
  },
});

// ---------------------------------------------------------------------------
// 3 · OAuth token management (single-flight)
// ---------------------------------------------------------------------------

let accessToken = null;
let tokenExpiresAt = 0; // epoch ms
let refreshingPromise = null;

async function requestNewToken() {
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'open-api',
    client_id: process.env.GUESTY_CLIENT_ID,
    client_secret: process.env.GUESTY_CLIENT_SECRET,
  });

  const { data } = await axios.post(API.TOKEN, params, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    httpsAgent,
  });

  accessToken = data.access_token;
  // 10 % buffer or 5 min, whichever smaller
  const bufferMs = Math.min(300_000, data.expires_in * 100);
  tokenExpiresAt = Date.now() + data.expires_in * 1000 - bufferMs;
  return accessToken;
}

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;

  if (refreshingPromise) return refreshingPromise; // single-flight

  refreshingPromise = requestNewToken()
    .catch((err) => {
      console.error('🔒 OAuth refresh failed:', err.response?.data || err.message);
      throw err;
    })
    .finally(() => {
      refreshingPromise = null;
    });

  return refreshingPromise;
}

// ---------------------------------------------------------------------------
// 4 · Thin API wrapper with auth header injection & pagination helpers
// ---------------------------------------------------------------------------

async function apiRequest(method, url, { data, params } = {}) {
  const token = await getAccessToken();
  return api.request({ method, url, data, params, headers: { Authorization: `Bearer ${token}` } })
    .then((r) => r.data)
    .catch((err) => {
      console.error(`🔥 API ${method.toUpperCase()} ${url} failed`, err.response?.data || err.message);
      throw err;
    });
}

const guesty = {
  get: (url, params) => apiRequest('get', url, { params }),
  post: (url, data) => apiRequest('post', url, { data }),
  put: (url, data) => apiRequest('put', url, { data }),
  delete: (url) => apiRequest('delete', url),

  // auto-paginate helper – collects all pages (beware large data)
  async listAll(url, params = {}) {
    const pageSize = params.limit || 100;
    let skip = params.skip || 0;
    const all = [];

    /* eslint-disable no-constant-condition */
    while (true) {
      const batch = await guesty.get(url, { ...params, limit: pageSize, skip });
      const results = batch.results ?? batch;
      all.push(...results);
      if (results.length < pageSize) break; // last page
      skip += pageSize;
    }
    /* eslint-enable */

    return all;
  },
};

// ---------------------------------------------------------------------------
// 5 · Express app & middleware
// ---------------------------------------------------------------------------

const app = express();

app.use(express.json());
app.use(cors({
  origin: (origin, cb) => {
    if (!ALLOWED_ORIGINS || ALLOWED_ORIGINS.length === 0) return cb(null, true);
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
}));

app.set('trust proxy', true);

// Health-check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage().rss,
  });
});

// ---------------------------------------------------------------------------
// 6 · MCP Manifest & handlers
// ---------------------------------------------------------------------------

const MCP_MANIFEST = {
  schema_version: '1',
  name: 'guesty-mcp',
  description: 'MCP server for Guesty Property Management API',
  system_prompt: 'You are a Guesty integration assistant. Handle property, reservation, guest & message operations.',
  tools: [
    {
      name: 'list_properties',
      description: 'List Guesty properties with optional filtering',
      parameters: {
        type: 'object',
        properties: {
          filters: {
            type: 'object',
            description: 'JSON filtering criteria for properties'
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of results to return'
          },
          skip: {
            type: 'integer',
            description: 'Number of results to skip for pagination'
          }
        }
      }
    },
    {
      name: 'get_property',
      description: 'Get details for a specific property by ID',
      parameters: {
        type: 'object',
        required: ['property_id'],
        properties: {
          property_id: {
            type: 'string',
            description: 'ID of the property to retrieve'
          },
          fields: {
            type: 'string',
            description: 'Comma-separated list of fields to include in the response'
          }
        }
      }
    },
    {
      name: 'check_availability',
      description: 'Check availability of properties for specific dates',
      parameters: {
        type: 'object',
        required: ['check_in', 'check_out'],
        properties: {
          property_id: {
            type: 'string',
            description: 'Optional ID of a specific property to check'
          },
          check_in: {
            type: 'string',
            description: 'Check-in date in YYYY-MM-DD format'
          },
          check_out: {
            type: 'string',
            description: 'Check-out date in YYYY-MM-DD format'
          },
          min_occupancy: {
            type: 'integer',
            description: 'Minimum occupancy requirement'
          }
        }
      }
    },
    {
      name: 'list_reservations',
      description: 'List reservations with optional filtering',
      parameters: {
        type: 'object',
        properties: {
          filters: {
            type: 'object',
            description: 'JSON filtering criteria for reservations'
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of results to return'
          },
          skip: {
            type: 'integer',
            description: 'Number of results to skip for pagination'
          }
        }
      }
    },
    {
      name: 'get_reservation',
      description: 'Get details for a specific reservation by ID',
      parameters: {
        type: 'object',
        required: ['reservation_id'],
        properties: {
          reservation_id: {
            type: 'string',
            description: 'ID of the reservation to retrieve'
          },
          fields: {
            type: 'string',
            description: 'Comma-separated list of fields to include in the response'
          }
        }
      }
    },
    {
      name: 'create_reservation',
      description: 'Create a new reservation in Guesty',
      parameters: {
        type: 'object',
        required: ['listing_id', 'check_in_date', 'check_out_date'],
        properties: {
          listing_id: {
            type: 'string',
            description: 'ID of the property for the reservation'
          },
          check_in_date: {
            type: 'string',
            description: 'Check-in date in YYYY-MM-DD format'
          },
          check_out_date: {
            type: 'string',
            description: 'Check-out date in YYYY-MM-DD format'
          },
          guest_id: {
            type: 'string',
            description: 'ID of an existing guest (if available)'
          },
          guest_data: {
            type: 'object',
            description: 'Data for creating a new guest if guest_id is not provided'
          },
          status: {
            type: 'string',
            description: 'Reservation status (default: inquiry)',
            enum: ['inquiry', 'pending', 'confirmed', 'canceled']
          }
        }
      }
    },
    {
      name: 'send_guest_message',
      description: 'Send a message to a guest for a specific reservation',
      parameters: {
        type: 'object',
        required: ['reservation_id', 'message'],
        properties: {
          reservation_id: {
            type: 'string',
            description: 'ID of the reservation'
          },
          message: {
            type: 'string',
            description: 'Message content to send to the guest'
          },
          subject: {
            type: 'string',
            description: 'Subject line for the message (default: "Message from Property Manager")'
          }
        }
      }
    },
    {
      name: 'get_guest_messages',
      description: 'Get message history for a specific reservation',
      parameters: {
        type: 'object',
        required: ['reservation_id'],
        properties: {
          reservation_id: {
            type: 'string',
            description: 'ID of the reservation'
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of messages to return'
          }
        }
      }
    }
  ],
};

//--------------------------------------------------
// Tool handler implementations
//--------------------------------------------------

function stringifyFilters(filters) {
  if (!filters) return undefined;
  return typeof filters === 'string' ? filters : JSON.stringify(filters);
}

async function listProperties(params = {}) {
  // Input validation
  if (params.limit && (!Number.isInteger(params.limit) || params.limit < 1)) {
    throw new Error('ValidationError: limit must be a positive integer');
  }
  if (params.skip && (!Number.isInteger(params.skip) || params.skip < 0)) {
    throw new Error('ValidationError: skip must be a non-negative integer');
  }
  
  const query = { ...params, filters: stringifyFilters(params.filters) };
  console.log(`[listProperties] Querying properties with params: ${JSON.stringify(query)}`);
  return guesty.get(ENDPOINTS.LISTINGS, query);
}

async function getProperty({ property_id, fields }) {
  // Input validation
  if (!property_id) {
    throw new Error('ValidationError: property_id is required');
  }
  
  const query = fields ? { fields } : undefined;
  console.log(`[getProperty] Fetching property: ${property_id}`);
  return guesty.get(`${ENDPOINTS.LISTINGS}/${property_id}`, query)
    .catch(err => {
      if (err.response?.status === 404) {
        throw new Error('NotFoundError: Property not found');
      }
      throw err;
    });
}

async function checkAvailability({ property_id, check_in, check_out, min_occupancy }) {
  // Input validation
  if (!check_in || !check_out) {
    throw new Error('ValidationError: check_in and check_out dates are required');
  }
  
  // Validate date format (YYYY-MM-DD)
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(check_in) || !dateRegex.test(check_out)) {
    throw new Error('ValidationError: dates must be in YYYY-MM-DD format');
  }
  
  // Validate check_out is after check_in
  if (new Date(check_in) >= new Date(check_out)) {
    throw new Error('ValidationError: check_out date must be after check_in date');
  }
  
  if (min_occupancy && (!Number.isInteger(min_occupancy) || min_occupancy < 1)) {
    throw new Error('ValidationError: min_occupancy must be a positive integer');
  }

  const availableParams = {
    checkIn: check_in,
    checkOut: check_out,
  };
  if (min_occupancy) availableParams.minOccupancy = min_occupancy;

  const query = {
    available: JSON.stringify(availableParams),
  };
  if (property_id) query.ids = property_id;

  console.log(`[checkAvailability] Checking availability for dates: ${check_in} to ${check_out}`);
  return guesty.get(ENDPOINTS.LISTINGS, query);
}

async function listReservations(params = {}) {
  // Input validation
  if (params.limit && (!Number.isInteger(params.limit) || params.limit < 1)) {
    throw new Error('ValidationError: limit must be a positive integer');
  }
  if (params.skip && (!Number.isInteger(params.skip) || params.skip < 0)) {
    throw new Error('ValidationError: skip must be a non-negative integer');
  }
  
  const query = { ...params, filters: stringifyFilters(params.filters) };
  console.log(`[listReservations] Querying reservations with params: ${JSON.stringify(query)}`);
  return guesty.get(ENDPOINTS.RESERVATIONS, query);
}

async function getReservation({ reservation_id, fields }) {
  // Input validation
  if (!reservation_id) {
    throw new Error('ValidationError: reservation_id is required');
  }
  
  const query = fields ? { fields } : undefined;
  console.log(`[getReservation] Fetching reservation: ${reservation_id}`);
  return guesty.get(`${ENDPOINTS.RESERVATIONS}/${reservation_id}`, query)
    .catch(err => {
      if (err.response?.status === 404) {
        throw new Error('NotFoundError: Reservation not found');
      }
      throw err;
    });
}

async function createReservation({ listing_id, check_in_date, check_out_date, guest_id, guest_data, status = 'inquiry' }) {
  // Input validation
  if (!listing_id) {
    throw new Error('ValidationError: listing_id is required');
  }
  if (!check_in_date || !check_out_date) {
    throw new Error('ValidationError: check_in_date and check_out_date are required');
  }
  
  // Validate date format (YYYY-MM-DD)
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(check_in_date) || !dateRegex.test(check_out_date)) {
    throw new Error('ValidationError: dates must be in YYYY-MM-DD format');
  }
  
  // Validate check_out is after check_in
  if (new Date(check_in_date) >= new Date(check_out_date)) {
    throw new Error('ValidationError: check_out_date must be after check_in_date');
  }
  
  // Validate reservation status
  const validStatuses = ['inquiry', 'pending', 'confirmed', 'canceled'];
  if (status && !validStatuses.includes(status)) {
    throw new Error(`ValidationError: status must be one of ${validStatuses.join(', ')}`);
  }
  
  // Validate that at least one of guest_id or guest_data is provided
  if (!guest_id && !guest_data) {
    throw new Error('ValidationError: either guest_id or guest_data must be provided');
  }

  const reservation = {
    listingId: listing_id,
    checkInDate: check_in_date,
    checkOutDate: check_out_date,
    status,
  };

  console.log(`[createReservation] Creating reservation for listing: ${listing_id}`);
  
  try {
    if (guest_id) {
      reservation.guestId = guest_id;
    } else if (guest_data) {
      console.log('[createReservation] Creating new guest');
      const newGuest = await guesty.post(ENDPOINTS.GUESTS, guest_data);
      reservation.guestId = newGuest._id;
    }
  
    return guesty.post(ENDPOINTS.RESERVATIONS, reservation);
  } catch (err) {
    if (err.response?.status === 404 && err.response?.data?.includes('listing')) {
      throw new Error('NotFoundError: Listing not found');
    }
    if (err.response?.status === 404 && err.response?.data?.includes('guest')) {
      throw new Error('NotFoundError: Guest not found');
    }
    if (err.response?.status === 409) {
      throw new Error('ConflictError: Property is not available for the specified dates');
    }
    throw err;
  }
}

async function sendGuestMessage({ reservation_id, message, subject = 'Message from Property Manager' }) {
  // Input validation
  if (!reservation_id) {
    throw new Error('ValidationError: reservation_id is required');
  }
  if (!message || message.trim() === '') {
    throw new Error('ValidationError: message is required and cannot be empty');
  }

  console.log(`[sendGuestMessage] Sending message for reservation: ${reservation_id}`);
  
  try {
    const reservation = await guesty.get(`${ENDPOINTS.RESERVATIONS}/${reservation_id}`);
    if (!reservation || !reservation.guestId) {
      throw new Error('NotFoundError: Reservation or guest not found');
    }

    const payload = {
      reservationId: reservation_id,
      guestId: reservation.guestId,
      message,
      subject,
    };

    return guesty.post(ENDPOINTS.COMMUNICATIONS, payload);
  } catch (err) {
    if (err.response?.status === 404) {
      throw new Error('NotFoundError: Reservation not found');
    }
    throw err;
  }
}

async function getGuestMessages({ reservation_id, limit }) {
  // Input validation
  if (!reservation_id) {
    throw new Error('ValidationError: reservation_id is required');
  }
  if (limit && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('ValidationError: limit must be a positive integer');
  }
  
  const query = { reservationId: reservation_id };
  if (limit) query.limit = limit;
  
  console.log(`[getGuestMessages] Fetching messages for reservation: ${reservation_id}`);
  return guesty.get(ENDPOINTS.COMMUNICATIONS, query)
    .catch(err => {
      if (err.response?.status === 404) {
        throw new Error('NotFoundError: Reservation not found');
      }
      throw err;
    });
}

//--------------------------------------------------
// 7 · MCP endpoint
//--------------------------------------------------

app.post('/mcp', async (req, res) => {
  const { type } = req.body;
  try {
    if (type === 'ping') return res.json({ type: 'pong' });
    if (type === 'manifest') return res.json({ type: 'manifest', manifest: MCP_MANIFEST });

    if (type === 'tool_call') {
      const { tool_name, tool_params, call_id } = req.body;
      let result;

      switch (tool_name) {
        case 'list_properties':
          result = await listProperties(tool_params);
          break;
        case 'get_property':
          result = await getProperty(tool_params);
          break;
        case 'check_availability':
          result = await checkAvailability(tool_params);
          break;
        case 'list_reservations':
          result = await listReservations(tool_params);
          break;
        case 'get_reservation':
          result = await getReservation(tool_params);
          break;
        case 'create_reservation':
          result = await createReservation(tool_params);
          break;
        case 'send_guest_message':
          result = await sendGuestMessage(tool_params);
          break;
        case 'get_guest_messages':
          result = await getGuestMessages(tool_params);
          break;
        default:
          throw new Error(`Unknown tool: ${tool_name}`);
      }

      return res.json({ type: 'tool_result', call_id, result });
    }

    return res.status(400).json({ type: 'error', error: { message: `Unknown type: ${type}` } });
  } catch (err) {
    console.error(`[ERROR] ${err.message}`, err.stack);
    
    // Determine appropriate status code and error type
    let statusCode = 500;
    let errorType = 'ServerError';
    
    if (err.message.startsWith('ValidationError:')) {
      statusCode = 400;
      errorType = 'ValidationError';
    } else if (err.message.startsWith('NotFoundError:')) {
      statusCode = 404;
      errorType = 'NotFoundError';
    } else if (err.message.startsWith('ConflictError:')) {
      statusCode = 409;
      errorType = 'ConflictError';
    } else if (err.response?.status) {
      statusCode = err.response.status;
    }
    
    return res.status(statusCode).json({
      type: 'error',
      error: { 
        type: errorType,
        message: err.message,
        details: err.response?.data || null 
      },
    });
  }
});

// ---------------------------------------------------------------------------
// 8 · Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`🚀 Guesty MCP server listening on :${PORT}`);
});
