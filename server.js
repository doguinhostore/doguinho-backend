/**
 * Doguinho Store — Backend (pedidos + keys + revendedores)
 * Zero dependências (Node nativo)
 *
 *   ADMIN_API_KEY=Sedanpgs4 PUBLIC_ORIGIN=* node server.js
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
const RESELLERS_FILE = path.join(DATA_DIR, 'resellers.json');
const RESELLER_ORDERS_FILE = path.join(DATA_DIR, 'reseller_orders.json');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const RATE_FILE = path.join(DATA_DIR, 'rate.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
for (const [f, def] of [
  [ORDERS_FILE, '[]'],
  [KEYS_FILE, '{}'],
  [RESELLERS_FILE, '[]'],
  [RESELLER_ORDERS_FILE, '[]'],
  [TOKENS_FILE, '{}'],
  [RATE_FILE, '{}']
]) {
  if (!fs.existsSync(f)) fs.writeFileSync(f, def, 'utf8');
}

function readJson(file, fallback) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8') || 'null');
    return v == null ? fallback : v;
  } catch { return fallback; }
}
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function loadOrders() { const l = readJson(ORDERS_FILE, []); return Array.isArray(l) ? l : []; }
function saveOrders(list) { writeJson(ORDERS_FILE, list); }
function loadKeys() { const o = readJson(KEYS_FILE, {}); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; }
function saveKeys(obj) { writeJson(KEYS_FILE, obj); }
function loadResellers() { const l = readJson(RESELLERS_FILE, []); return Array.isArray(l) ? l : []; }
function saveResellers(list) { writeJson(RESELLERS_FILE, list); }
function loadResellerOrders() { const l = readJson(RESELLER_ORDERS_FILE, []); return Array.isArray(l) ? l : []; }
function saveResellerOrders(list) { writeJson(RESELLER_ORDERS_FILE, list); }
function loadTokens() { const o = readJson(TOKENS_FILE, {}); return o && typeof o === 'object' ? o : {}; }
function saveTokens(obj) { writeJson(TOKENS_FILE, obj); }

function generateOrderId(prefix) {
  const t = Date.now().toString(36).toUpperCase();
  const r = crypto.randomBytes(2).toString('hex').toUpperCase();
  return (prefix || 'DG') + '-' + t + '-' + r;
}
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  try {
    const h = crypto.scryptSync(String(password), salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
  } catch { return false; }
}
function publicReseller(r) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    balance: Number(r.balance) || 0,
    discountPercent: Number(r.discountPercent) || 20,
    status: r.status || 'active',
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  };
}
function parsePriceBR(v) {
  if (typeof v === 'number') return v;
  const s = String(v || '0').trim().replace(/R\$\s?/i, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
function formatPriceBR(n) {
  return (Math.round(n * 100) / 100).toFixed(2).replace('.', ',');
}
function findStockTitle(title) {
  const stock = loadKeys();
  if (stock[title] && stock[title].length) return title;
  const t = String(title || '').trim().toLowerCase();
  for (const k of Object.keys(stock)) {
    if (k.toLowerCase() === t && stock[k] && stock[k].length) return k;
  }
  // partial match
  for (const k of Object.keys(stock)) {
    if ((k.toLowerCase().includes(t) || t.includes(k.toLowerCase())) && stock[k] && stock[k].length) return k;
  }
  return null;
}
function allocateKey(title) {
  const stock = loadKeys();
  const real = findStockTitle(title);
  if (!real) return null;
  const list = stock[real];
  if (!list || !list.length) return null;
  const key = list.shift();
  if (!list.length) delete stock[real];
  else stock[real] = list;
  saveKeys(stock);
  return key;
}
function stockCount(title) {
  const stock = loadKeys();
  const real = findStockTitle(title);
  return real ? (stock[real] || []).length : 0;
}

/** Rate limit simples em memória + disco */
const rateMem = {};
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  if (!rateMem[key]) rateMem[key] = [];
  rateMem[key] = rateMem[key].filter(t => now - t < windowMs);
  if (rateMem[key].length >= max) return false;
  rateMem[key].push(now);
  return true;
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
    orderId: body.orderId || (existing && existing.orderId) || generateOrderId('DG'),
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
    rejectedAt: body.rejectedAt || (existing && existing.rejectedAt) || null,
    cancelledAt: body.cancelledAt || (existing && existing.cancelledAt) || null
  };
}

function send(res, status, data, origin) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin || PUBLIC_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Api-Key, X-Reseller-Token, Authorization',
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
  const key = req.headers['x-admin-key'] || req.headers['x-api-key'] || url.searchParams.get('adminKey') || '';
  return key && key === ADMIN_API_KEY;
}

function getResellerToken(req) {
  const h = req.headers['x-reseller-token'] || req.headers['authorization'] || '';
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  return String(h || '').trim();
}

function authReseller(req) {
  const token = getResellerToken(req);
  if (!token) return null;
  const tokens = loadTokens();
  const entry = tokens[token];
  if (!entry || !entry.resellerId) return null;
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    delete tokens[token];
    saveTokens(tokens);
    return null;
  }
  const r = loadResellers().find(x => x.id === entry.resellerId);
  if (!r || r.status !== 'active') return null;
  return { token, reseller: r };
}

const RANK = {
  rejected: 0, cancelled: 0,
  awaiting_payment: 1, awaiting_validation: 2,
  validated: 3, awaiting_stock: 3, delivered: 4
};

const server = http.createServer(async (req, res) => {
  const origin = PUBLIC_ORIGIN === '*' ? (req.headers.origin || '*') : PUBLIC_ORIGIN;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Api-Key, X-Reseller-Token, Authorization',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  let url;
  try { url = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
  catch { return send(res, 400, { ok: false, error: 'URL inválida' }, origin); }

  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method || 'GET';

  try {
    if (method === 'GET' && (p === '/' || p === '/api/health')) {
      return send(res, 200, {
        ok: true,
        service: 'Doguinho Store API',
        version: '1.1.0',
        time: new Date().toISOString(),
        orders: loadOrders().length,
        resellers: loadResellers().length
      }, origin);
    }

    // ----- Pedidos públicos (site) -----
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
        if (newR < oldR && order.status !== 'rejected' && order.status !== 'cancelled') order.status = existing.status;
        const idx = list.findIndex(o => o.orderId === existing.orderId);
        list[idx] = order;
      } else list.push(order);
      saveOrders(list);
      return send(res, 200, { ok: true, order }, origin);
    }

    const mOrderGet = p.match(/^\/api\/orders\/([^/]+)$/);
    if (method === 'GET' && mOrderGet) {
      const order = loadOrders().find(o => o.orderId === decodeURIComponent(mOrderGet[1]));
      if (!order) return send(res, 404, { ok: false, error: 'Pedido não encontrado' }, origin);
      const safe = { ...order };
      if (safe.allocated) safe.allocated = safe.allocated.map(a => ({ title: a.title, price: a.price, hasKey: !!a.key }));
      return send(res, 200, { ok: true, order: safe }, origin);
    }
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

    // ========== REVENDEDOR (auth) ==========
    if (method === 'POST' && p === '/api/reseller/login') {
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'ip';
      if (!rateLimit('login:' + ip, 10, 15 * 60 * 1000)) {
        return send(res, 429, { ok: false, error: 'Muitas tentativas. Aguarde 15 min.' }, origin);
      }
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!email || !password) return send(res, 400, { ok: false, error: 'E-mail e senha obrigatórios' }, origin);
      const r = loadResellers().find(x => x.email === email);
      if (!r || !verifyPassword(password, r.salt, r.passwordHash)) {
        return send(res, 401, { ok: false, error: 'E-mail ou senha inválidos' }, origin);
      }
      if (r.status !== 'active') return send(res, 403, { ok: false, error: 'Conta desativada' }, origin);
      const token = crypto.randomBytes(32).toString('hex');
      const tokens = loadTokens();
      tokens[token] = {
        resellerId: r.id,
        createdAt: Date.now(),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
      };
      saveTokens(tokens);
      return send(res, 200, { ok: true, token, reseller: publicReseller(r) }, origin);
    }

    if (method === 'POST' && p === '/api/reseller/logout') {
      const token = getResellerToken(req);
      if (token) {
        const tokens = loadTokens();
        delete tokens[token];
        saveTokens(tokens);
      }
      return send(res, 200, { ok: true }, origin);
    }

    if (method === 'GET' && p === '/api/reseller/me') {
      const auth = authReseller(req);
      if (!auth) return send(res, 401, { ok: false, error: 'Não autenticado' }, origin);
      return send(res, 200, { ok: true, reseller: publicReseller(auth.reseller) }, origin);
    }

    // Catálogo com preço de custo (não devolve keys)
    if (method === 'POST' && p === '/api/reseller/catalog') {
      const auth = authReseller(req);
      if (!auth) return send(res, 401, { ok: false, error: 'Não autenticado' }, origin);
      const body = await readBody(req);
      const games = Array.isArray(body.games) ? body.games : [];
      const disc = Number(auth.reseller.discountPercent) || 20;
      const catalog = games.map(g => {
        const retail = parsePriceBR(g.price);
        const cost = Math.round(retail * (1 - disc / 100) * 100) / 100;
        return {
          title: g.title,
          retailPrice: formatPriceBR(retail),
          costPrice: formatPriceBR(cost),
          discountPercent: disc,
          stock: stockCount(g.title) > 0 ? 'disponível' : 'sob encomenda',
          inStock: stockCount(g.title) > 0
        };
      }).filter(g => g.title);
      return send(res, 200, {
        ok: true,
        discountPercent: disc,
        catalog
      }, origin);
    }

    // Compra revendedor: cria pedido PIX (sem liberar key ainda)
    if (method === 'POST' && p === '/api/reseller/order') {
      const auth = authReseller(req);
      if (!auth) return send(res, 401, { ok: false, error: 'Não autenticado' }, origin);
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'ip';
      if (!rateLimit('order:' + auth.reseller.id + ':' + ip, 30, 60 * 60 * 1000)) {
        return send(res, 429, { ok: false, error: 'Limite de pedidos por hora atingido' }, origin);
      }
      const body = await readBody(req);
      const title = String(body.title || '').trim();
      const retailPrice = parsePriceBR(body.retailPrice != null ? body.retailPrice : body.price);
      if (!title || retailPrice <= 0) {
        return send(res, 400, { ok: false, error: 'Informe title e preço de vitrine' }, origin);
      }
      const r = auth.reseller;
      const disc = Number(r.discountPercent) || 20;
      const cost = Math.round(retailPrice * (1 - disc / 100) * 100) / 100;
      const now = new Date().toISOString();
      const order = {
        orderId: generateOrderId('RV'),
        resellerId: r.id,
        resellerEmail: r.email,
        resellerName: r.name,
        title,
        retailPrice: formatPriceBR(retailPrice),
        costPrice: formatPriceBR(cost),
        discountPercent: disc,
        key: null,
        status: 'awaiting_payment',
        proofSent: false,
        createdAt: now,
        updatedAt: now,
        validatedAt: null,
        deliveredAt: null
      };
      const ro = loadResellerOrders();
      ro.unshift(order);
      saveResellerOrders(ro.slice(0, 5000));
      console.log('[reseller-order-pix]', r.email, title, order.orderId, order.costPrice);
      // key NÃO é enviada até validação do comprovante
      return send(res, 200, {
        ok: true,
        order: {
          orderId: order.orderId,
          title: order.title,
          costPrice: order.costPrice,
          retailPrice: order.retailPrice,
          discountPercent: order.discountPercent,
          status: order.status,
          createdAt: order.createdAt
        }
      }, origin);
    }

    // Revendedor marca que enviou comprovante
    if (method === 'POST' && p === '/api/reseller/order/proof') {
      const auth = authReseller(req);
      if (!auth) return send(res, 401, { ok: false, error: 'Não autenticado' }, origin);
      const body = await readBody(req);
      const orderId = String(body.orderId || '').trim();
      if (!orderId) return send(res, 400, { ok: false, error: 'orderId obrigatório' }, origin);
      const list = loadResellerOrders();
      const idx = list.findIndex(o => o.orderId === orderId && o.resellerId === auth.reseller.id);
      if (idx < 0) return send(res, 404, { ok: false, error: 'Pedido não encontrado' }, origin);
      const o = list[idx];
      if (o.status === 'delivered' || o.status === 'cancelled' || o.status === 'rejected') {
        return send(res, 400, { ok: false, error: 'Pedido já finalizado' }, origin);
      }
      o.status = 'awaiting_validation';
      o.proofSent = true;
      o.updatedAt = new Date().toISOString();
      list[idx] = o;
      saveResellerOrders(list);
      return send(res, 200, {
        ok: true,
        order: {
          orderId: o.orderId,
          title: o.title,
          costPrice: o.costPrice,
          status: o.status,
          proofSent: true
        }
      }, origin);
    }

    // Histórico do revendedor (keys mascaradas parcialmente na listagem? full for owner)
    if (method === 'GET' && p === '/api/reseller/orders') {
      const auth = authReseller(req);
      if (!auth) return send(res, 401, { ok: false, error: 'Não autenticado' }, origin);
      const list = loadResellerOrders()
        .filter(o => o.resellerId === auth.reseller.id)
        .slice(0, 200)
        .map(o => ({
          orderId: o.orderId,
          title: o.title,
          costPrice: o.costPrice,
          retailPrice: o.retailPrice,
          key: o.status === 'delivered' ? o.key : null,
          status: o.status,
          proofSent: !!o.proofSent,
          createdAt: o.createdAt
        }));
      return send(res, 200, { ok: true, orders: list }, origin);
    }

    // ========== ADMIN ==========
    if (p.startsWith('/api/admin') && !isAdmin(req, url)) {
      return send(res, 401, { ok: false, error: 'Não autorizado. Informe X-Admin-Key.' }, origin);
    }

    if (method === 'GET' && p === '/api/admin/orders') {
      let list = loadOrders();
      const status = url.searchParams.get('status');
      if (status === 'pending') list = list.filter(o => o.status !== 'delivered' && o.status !== 'rejected' && o.status !== 'cancelled');
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
      const summary = Object.keys(stock).map(t => ({ title: t, count: (stock[t] || []).length }));
      return send(res, 200, { ok: true, stock, summary }, origin);
    }
    if (method === 'POST' && p === '/api/admin/keys') {
      const body = await readBody(req);
      const title = String(body.title || '').trim();
      const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
      if (!title || !keys.length) return send(res, 400, { ok: false, error: 'Informe title e keys[]' }, origin);
      const stock = loadKeys();
      stock[title] = Array.from(new Set((stock[title] || []).concat(keys)));
      saveKeys(stock);
      return send(res, 200, { ok: true, title, count: stock[title].length }, origin);
    }

    // --- Admin resellers ---
    if (method === 'GET' && p === '/api/admin/resellers') {
      return send(res, 200, {
        ok: true,
        resellers: loadResellers().map(publicReseller)
      }, origin);
    }

    if (method === 'POST' && p === '/api/admin/resellers') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const discountPercent = body.discountPercent != null ? Number(body.discountPercent) : 20;
      if (!name || !email || !password) {
        return send(res, 400, { ok: false, error: 'name, email e password obrigatórios' }, origin);
      }
      if (password.length < 8) {
        return send(res, 400, { ok: false, error: 'Senha mínima de 8 caracteres' }, origin);
      }
      const list = loadResellers();
      if (list.some(x => x.email === email)) {
        return send(res, 409, { ok: false, error: 'E-mail já cadastrado' }, origin);
      }
      const { salt, hash } = hashPassword(password);
      const now = new Date().toISOString();
      const r = {
        id: 'rev_' + crypto.randomBytes(4).toString('hex'),
        name,
        email,
        salt,
        passwordHash: hash,
        balance: Number(body.balance) || 0,
        discountPercent: isNaN(discountPercent) ? 20 : discountPercent,
        status: 'active',
        createdAt: now,
        updatedAt: now
      };
      list.push(r);
      saveResellers(list);
      return send(res, 200, { ok: true, reseller: publicReseller(r) }, origin);
    }

    const mRev = p.match(/^\/api\/admin\/resellers\/([^/]+)$/);
    if (method === 'PATCH' && mRev) {
      const id = decodeURIComponent(mRev[1]);
      const list = loadResellers();
      const idx = list.findIndex(x => x.id === id);
      if (idx < 0) return send(res, 404, { ok: false, error: 'Revendedor não encontrado' }, origin);
      const body = await readBody(req);
      const r = list[idx];
      if (body.name) r.name = String(body.name).trim();
      if (body.email) r.email = String(body.email).trim().toLowerCase();
      if (body.discountPercent != null && !isNaN(Number(body.discountPercent))) {
        r.discountPercent = Number(body.discountPercent);
      }
      if (body.status === 'active' || body.status === 'disabled') r.status = body.status;
      if (body.password && String(body.password).length >= 8) {
        const hp = hashPassword(body.password);
        r.salt = hp.salt;
        r.passwordHash = hp.hash;
      }
      // addBalance: soma; setBalance: define
      if (body.addBalance != null && !isNaN(Number(body.addBalance))) {
        r.balance = Math.round(((Number(r.balance) || 0) + Number(body.addBalance)) * 100) / 100;
      }
      if (body.setBalance != null && !isNaN(Number(body.setBalance))) {
        r.balance = Math.round(Number(body.setBalance) * 100) / 100;
      }
      r.updatedAt = new Date().toISOString();
      list[idx] = r;
      saveResellers(list);
      return send(res, 200, { ok: true, reseller: publicReseller(r) }, origin);
    }

    if (method === 'GET' && p === '/api/admin/reseller-orders') {
      const list = loadResellerOrders().slice(0, 300).map(o => ({
        orderId: o.orderId,
        resellerId: o.resellerId,
        resellerEmail: o.resellerEmail,
        resellerName: o.resellerName,
        title: o.title,
        costPrice: o.costPrice,
        retailPrice: o.retailPrice,
        discountPercent: o.discountPercent,
        // admin vê key
        key: o.key,
        status: o.status,
        createdAt: o.createdAt
      }));
      return send(res, 200, { ok: true, orders: list }, origin);
    }

    
    // Admin valida PIX do revendedor e libera key
    if (method === 'POST' && p === '/api/admin/reseller-orders/validate') {
      const body = await readBody(req);
      const orderId = String(body.orderId || '').trim();
      if (!orderId) return send(res, 400, { ok: false, error: 'orderId obrigatório' }, origin);
      const list = loadResellerOrders();
      const idx = list.findIndex(o => o.orderId === orderId);
      if (idx < 0) return send(res, 404, { ok: false, error: 'Pedido não encontrado' }, origin);
      const o = list[idx];
      if (o.status === 'delivered') {
        return send(res, 200, { ok: true, order: o, message: 'Já entregue' }, origin);
      }
      if (o.status === 'cancelled' || o.status === 'rejected') {
        return send(res, 400, { ok: false, error: 'Pedido cancelado/rejeitado' }, origin);
      }
      // Admin pode enviar key do estoque local do navegador
      let key = body.key ? String(body.key).trim() : '';
      if (!key) key = allocateKey(o.title);
      if (!key) {
        o.status = 'awaiting_stock';
        o.validatedAt = new Date().toISOString();
        o.updatedAt = new Date().toISOString();
        list[idx] = o;
        saveResellerOrders(list);
        return send(res, 409, {
          ok: false,
          error: 'Sem key no servidor. O painel tentará usar o estoque local do navegador.',
          needLocalKey: true,
          order: { orderId: o.orderId, status: o.status, title: o.title, resellerEmail: o.resellerEmail }
        }, origin);
      }
      o.key = key;
      o.status = 'delivered';
      o.proofSent = true;
      o.validatedAt = new Date().toISOString();
      o.deliveredAt = new Date().toISOString();
      o.updatedAt = new Date().toISOString();
      list[idx] = o;
      saveResellerOrders(list);
      console.log('[reseller-validate]', orderId, o.title, 'key-ok');
      return send(res, 200, {
        ok: true,
        order: {
          orderId: o.orderId,
          title: o.title,
          costPrice: o.costPrice,
          key: o.key,
          status: o.status,
          resellerEmail: o.resellerEmail,
          resellerName: o.resellerName,
          deliveredAt: o.deliveredAt
        }
      }, origin);
    }

    if (method === 'POST' && p === '/api/admin/reseller-orders/reject') {
      const body = await readBody(req);
      const orderId = String(body.orderId || '').trim();
      const list = loadResellerOrders();
      const idx = list.findIndex(o => o.orderId === orderId);
      if (idx < 0) return send(res, 404, { ok: false, error: 'Pedido não encontrado' }, origin);
      list[idx].status = 'rejected';
      list[idx].updatedAt = new Date().toISOString();
      saveResellerOrders(list);
      return send(res, 200, { ok: true, order: list[idx] }, origin);
    }

    return send(res, 404, { ok: false, error: 'Rota não encontrada: ' + method + ' ' + p }, origin);
  } catch (e) {
    console.error(e);
    return send(res, 500, { ok: false, error: e.message || 'Erro interno' }, origin);
  }
});

server.listen(PORT, () => {
  console.log(`Doguinho API :${PORT}`);
  console.log(`Admin key: ${ADMIN_API_KEY === 'Sedanpgs4' ? '(padrão)' : '(custom)'}`);
  console.log(`PUBLIC_ORIGIN=${PUBLIC_ORIGIN}`);
});
