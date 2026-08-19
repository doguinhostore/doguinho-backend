# Doguinho Store API

Pedidos + estoque de keys + **revendedores**.

## Subir

```bash
ADMIN_API_KEY=Sedanpgs4 PUBLIC_ORIGIN=* node server.js
```

No Render: Build vazio ou `echo skip` | Start: `node server.js`  
Env: `ADMIN_API_KEY`, `PUBLIC_ORIGIN=*`

## Revendedores

| Método | Rota | Auth |
|--------|------|------|
| POST | `/api/reseller/login` | — |
| GET | `/api/reseller/me` | token |
| POST | `/api/reseller/catalog` | token |
| POST | `/api/reseller/order` | token (retorna key) |
| GET | `/api/reseller/orders` | token |
| GET/POST | `/api/admin/resellers` | X-Admin-Key |
| PATCH | `/api/admin/resellers/:id` | X-Admin-Key (`addBalance`, `discountPercent`) |
| GET | `/api/admin/reseller-orders` | X-Admin-Key |

Preço de custo = preço vitrine × (1 − desconto%). Padrão **20%**.

Keys **nunca** vão no HTML público; só na resposta autenticada de `/api/reseller/order`.

## Persistência de dados (importante no Render)

O plano free do Render **apaga a pasta `data/`** a cada redeploy/reinício.

Opções:
1. **Persistent Disk** (Render): monte em `/var/data` e defina env `DATA_DIR=/var/data`
2. Use o botão **Restaurar revendedores do backup local** no painel admin (backup fica no navegador ao criar a conta)

Sem uma dessas opções, os revendedores “somem” depois que o servidor dorme/reinicia.
