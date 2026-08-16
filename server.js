/**
 * Doguinho Store — Backend de sincronização de pedidos
 * Zero dependências (só módulos nativos do Node.js)
 *
 * Uso:
 *   ADMIN_API_KEY=Sedanpgs4 node server.js
 *
 * Env:
 *   PORT (padrão 3847)
 *   ADMIN_API_KEY
 *   PUBLIC_ORIGIN (* ou URL do site)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 3847;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'Sedanpgs4';
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || '*';
const DATA_DIR = path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]', 'utf8');
if (!fs.existsSync(KEYS_FILE)) fs.writeFileSync(KEYS_FILE, '{}', 'utf8');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8') || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function loadOrders() {
  const list = readJson(ORDERS_FILE, []);
  return Array.isArray(list) ? list : [];
}
function saveOrders(list) { writeJson(ORDERS_FILE, list); }
function loadKeys() {
  const obj = readJson(KEYS_FILE, {});
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
}
function saveKeys(obj) { writeJson(KEYS_FILE, obj); }

function generateOrderId() {
  const t = Date.now().toString(36).toUpperCase();
  const r = crypto.randomBytes(2).toString('hex').toUpperCase();
  return 'DG-' + t + '-' + r;
}

function normalizeOrder(body, existing) {
  const now = new Date().toISOString();
  const items = Array.isArray(body.items)
    ? body.items.map(i => ({
        title: String(i.title || '').trim(),
        price: String(i.price != null ? i.price : '').trim()
      })).filter(i => i.title)
    : (existing && existing.items) || [];

  return {
    orderId: body.orderId || (existing && existing.orderId) || generateOrderId(),
    email: String(body.email || (existing && existing.email) || '').trim().toLowerCase(),
    total: String(body.total != null ? body.total : (existing && existing.total) || '0,00'),
    items,
    status: body.status || (existing && existing.status) || 'awaiting_payment',
    proofSent: body.proofSent != null ? !!body.proofSent : !!(existing && existing.proofSent),
    source: body.source || (existing && existing.source) || 'api',
    createdAt: (existing && existing.createdAt) || body.createdAt || now,
    updatedAt: now,
    validatedAt: body.validatedAt || (existing && existing.validatedAt) || null,
    deliveredAt: body.deliveredAt || (existing && existing.deliveredAt) || null,
    allocated: body.allocated || (existing && existing.allocated) || null,
    waitingItems: body.waitingItems || (existing && existing.waitingItems) || null,
    notes: body.notes != null ? body.notes : (existing && existing.notes) || '',
    rejectedAt: body.rejectedAt || (existing && existing.rejectedAt) || null
  };
}

function send(res, status, data, origin) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin || PUBLIC_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Api-Key',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function isAdmin(req, url) {
  const key =
    req.headers['x-admin-key'] ||
    req.headers['x-api-key'] ||
    url.searchParams.get('adminKey') ||
    '';
  return key && key === ADMIN_API_KEY;
}

const RANK = {
  rejected: 0,
  awaiting_payment: 1,
  awaiting_validation: 2,
  validated: 3,
  awaiting_stock: 3,
  delivered: 4
};

const server = http.createServer(async (req, res) => {
  const origin = PUBLIC_ORIGIN === '*' ? (req.headers.origin || '*') : PUBLIC_ORIGIN;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Api-Key',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch {
    return send(res, 400, { ok: false, error: 'URL inválida' }, origin);
  }

  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method || 'GET';

  try {
    // Health
    if (method === 'GET' && (p === '/' || p === '/api/health')) {
      return send(res, 200, {
        ok: true,
        service: 'Doguinho Store API',
        version: '1.0.0',
        time: new Date().toISOString(),
        orders: loadOrders().length
      }, origin);
    }

    // POST /api/orders — cliente
    if (method === 'POST' && p === '/api/orders') {
      const body = await readBody(req);
      if (!body.email && !(body.items && body.items.length)) {
        return send(res, 400, { ok: false, error: 'Informe email e/ou items' }, origin);
      }
      const list = loadOrders();
      let existing = body.orderId ? list.find(o => o.orderId === body.orderId) : null;
      const order = normalizeOrder(body, existing);
      if (existing) {
        const oldR = RANK[existing.status] || 0;
        const newR = RANK[order.status] || 0;
        if (newR < oldR && order.status !== 'rejected') order.status = existing.status;
        const idx = list.findIndex(o => o.orderId === existing.orderId);
        list[idx] = order;
      } else {
        list.push(order);
      }
      saveOrders(list);
      console.log('[orders] upsert', order.orderId, order.status, order.email);
      return send(res, 200, { ok: true, order }, origin);
    }

    // GET /api/orders/:id
    const mOrderGet = p.match(/^\/api\/orders\/([^/]+)$/);
    if (method === 'GET' && mOrderGet) {
      const order = loadOrders().find(o => o.orderId === decodeURIComponent(mOrderGet[1]));
      if (!order) return send(res, 404, { ok: false, error: 'Pedido não encontrado' }, origin);
      const safe = { ...order };
      if (safe.allocated) {
        safe.allocated = safe.allocated.map(a => ({ title: a.title, price: a.price, hasKey: !!a.key }));
      }
      return send(res, 200, { ok: true, order: safe }, origin);
    }

    // PATCH /api/orders/:id — cliente (limitado)
    if (method === 'PATCH' && mOrderGet) {
      const list = loadOrders();
      const idx = list.findIndex(o => o.orderId === decodeURIComponent(mOrderGet[1]));
      if (idx < 0) return send(res, 404, { ok: false, error: 'Pedido não encontrado' }, origin);
      const body = await readBody(req);
      const allowed = {};
      if (body.proofSent != null) allowed.proofSent = !!body.proofSent;
      if (body.status === 'awaiting_validation' || body.status === 'awaiting_payment') allowed.status = body.status;
      if (body.email) allowed.email = String(body.email).trim().toLowerCase();
      const order = normalizeOrder({ ...list[idx], ...allowed }, list[idx]);
      list[idx] = order;
      saveOrders(list);
      return send(res, 200, { ok: true, order }, origin);
    }

    // ----- Admin -----
    if (p.startsWith('/api/admin') && !isAdmin(req, url)) {
      return send(res, 401, { ok: false, error: 'Não autorizado. Informe X-Admin-Key.' }, origin);
    }

    if (method === 'GET' && p === '/api/admin/orders') {
      let list = loadOrders();
      const status = url.searchParams.get('status');
      if (status === 'pending') list = list.filter(o => o.status !== 'delivered' && o.status !== 'rejected');
      else if (status) list = list.filter(o => o.status === status);
      list = list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      return send(res, 200, { ok: true, count: list.length, orders: list }, origin);
    }

    if (method === 'POST' && p === '/api/admin/orders') {
      const body = await readBody(req);
      const list = loadOrders();
      const order = normalizeOrder({
        ...body,
        status: body.status || 'awaiting_validation',
        proofSent: body.proofSent != null ? body.proofSent : true,
        source: body.source || 'admin_manual'
      }, null);
      list.push(order);
      saveOrders(list);
      return send(res, 200, { ok: true, order }, origin);
    }

    const mAdminPatch = p.match(/^\/api\/admin\/orders\/([^/]+)$/);
    if (method === 'PATCH' && mAdminPatch) {
      const list = loadOrders();
      const idx = list.findIndex(o => o.orderId === decodeURIComponent(mAdminPatch[1]));
      if (idx < 0) return send(res, 404, { ok: false, error: 'Pedido não encontrado' }, origin);
      const body = await readBody(req);
      const order = normalizeOrder(body, list[idx]);
      order.orderId = list[idx].orderId;
      list[idx] = order;
      saveOrders(list);
      return send(res, 200, { ok: true, order }, origin);
    }

    if (method === 'GET' && p === '/api/admin/keys') {
      const stock = loadKeys();
      const summary = Object.keys(stock).sort().map(title => ({
        title,
        count: Array.isArray(stock[title]) ? stock[title].length : 0
      }));
      return send(res, 200, { ok: true, stock, summary }, origin);
    }

    if (method === 'POST' && p === '/api/admin/keys') {
      const body = await readBody(req);
      const { title, keys } = body;
      if (!title || !Array.isArray(keys) || !keys.length) {
        return send(res, 400, { ok: false, error: 'Informe title e keys[]' }, origin);
      }
      const stock = loadKeys();
      const clean = keys.map(k => String(k).trim()).filter(Boolean);
      stock[title] = Array.from(new Set([...(stock[title] || []), ...clean]));
      saveKeys(stock);
      return send(res, 200, { ok: true, title, count: stock[title].length }, origin);
    }

    if (method === 'POST' && p === '/api/admin/keys/import') {
      const body = await readBody(req);
      const incoming = body.stock || body;
      if (typeof incoming !== 'object' || Array.isArray(incoming)) {
        return send(res, 400, { ok: false, error: 'Formato inválido' }, origin);
      }
      const stock = loadKeys();
      Object.keys(incoming).forEach(title => {
        const arr = Array.isArray(incoming[title]) ? incoming[title].map(String) : [];
        stock[title] = Array.from(new Set([...(stock[title] || []), ...arr]));
      });
      saveKeys(stock);
      return send(res, 200, { ok: true, titles: Object.keys(stock).length }, origin);
    }

    if (method === 'POST' && p === '/api/admin/keys/allocate') {
      const body = await readBody(req);
      const title = body.title || '';
      if (!title) return send(res, 400, { ok: false, error: 'title obrigatório' }, origin);
      const stock = loadKeys();
      const list = stock[title];
      if (!list || !list.length) return send(res, 200, { ok: true, key: null, remaining: 0 }, origin);
      const key = list.shift();
      if (!list.length) delete stock[title];
      else stock[title] = list;
      saveKeys(stock);
      return send(res, 200, { ok: true, key, remaining: (stock[title] || []).length }, origin);
    }

    send(res, 404, { ok: false, error: 'Rota não encontrada', path: p }, origin);
  } catch (e) {
    console.error(e);
    send(res, 500, { ok: false, error: e.message || 'Erro interno' }, origin);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Doguinho API em http://0.0.0.0:${PORT}`);
  console.log(`Admin key: ${ADMIN_API_KEY === 'Sedanpgs4' ? '(padrão)' : '(custom)'}`);
});
