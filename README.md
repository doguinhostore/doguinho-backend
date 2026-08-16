# Doguinho Store — Backend de Pedidos

API REST **sem dependências** (só Node.js nativo) para sincronizar pedidos entre qualquer celular/PC.

## Subir localmente

```bash
cd doguinho-backend
ADMIN_API_KEY=Sedanpgs4 node server.js
```

Abre em `http://localhost:3847`

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `PORT` | `3847` | Porta HTTP |
| `ADMIN_API_KEY` | `Sedanpgs4` | Header `X-Admin-Key` do painel |
| `PUBLIC_ORIGIN` | `*` | CORS (em produção use a URL do site) |

## Configurar no HTML

No arquivo `doguinho-store.html`, procure `BACKEND_CONFIG`:

```js
const BACKEND_CONFIG = {
  ENABLED: true,
  BASE_URL: 'http://localhost:3847',  // ou URL pública após o deploy
  ADMIN_KEY: 'Sedanpgs4'
};
```

## Endpoints

| Método | Rota | Quem |
|--------|------|------|
| POST | `/api/orders` | Cliente (checkout) |
| GET | `/api/orders/:id` | Público (status) |
| GET | `/api/admin/orders?status=pending` | Admin |
| POST | `/api/admin/orders` | Admin (manual) |
| PATCH | `/api/admin/orders/:id` | Admin (validar/rejeitar) |
| GET/POST | `/api/admin/keys` | Admin (estoque) |

## Deploy rápido

### Railway / Render / Fly.io
1. Envie a pasta `doguinho-backend`
2. Start command: `node server.js`
3. Defina `ADMIN_API_KEY` e `PUBLIC_ORIGIN=https://seu-dominio-do-site.com`
4. Copie a URL HTTPS gerada para `BACKEND_CONFIG.BASE_URL` no HTML

### VPS (Ubuntu)
```bash
node server.js
# ou com PM2:
pm2 start server.js --name doguinho-api
```

## Persistência

- Pedidos: `data/orders.json`
- Keys: `data/keys.json`

Em hospedagens que apagam o disco ao reiniciar, monte um volume persistente ou troque por um banco depois.

## Segurança

- Troque `ADMIN_API_KEY` em produção
- Restrinja `PUBLIC_ORIGIN` ao domínio do site
- Use HTTPS no deploy
