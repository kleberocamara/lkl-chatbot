# Solicitação de suporte — C6 Bank API — Extrato retorna 403 Forbidden

**Empresa:** Grupo de Gráficas LKL Ltda
**Ambiente:** Produção (`https://baas-api.c6bank.info`) — não sandbox
**Data do teste:** 18/07/2026, 09:45 (America/Sao_Paulo)

## Resumo

Nossa integração usa a API do C6 Bank para emissão de boletos, cobranças PIX,
consulta de DDA e lotes de pagamento — todos esses endpoints funcionam
normalmente com as credenciais atuais. O endpoint de **extrato (statement)**,
porém, retorna `403 Forbidden` de forma consistente, impedindo a reconciliação
automática de pagamentos.

## O que foi testado

**Endpoint:** `GET /v1/statement/`
**Parâmetros:** `start_date` e `end_date` (intervalo de 30 dias)
**Autenticação:** OAuth2 `client_credentials` via `POST /v1/auth/` — o token é
obtido com sucesso (essa parte funciona; usamos o mesmo token nos demais
endpoints abaixo).

**Requisição (equivalente ao que nosso backend envia):**
```
GET https://baas-api.c6bank.info/v1/statement/?start_date=2026-06-18&end_date=2026-07-18
Authorization: Bearer <token válido, obtido via /v1/auth/>
Content-Type: application/json
partner-software-name: Grafica LKL
partner-software-version: 1.0.0
```

**Resposta recebida:**
```
HTTP 403 Forbidden
"Consulte a documentação. Forbidden"
```

## Evidência de que as credenciais estão corretas e ativas

Com o **mesmo token** e o **mesmo client_id/client_secret**, os seguintes
endpoints funcionam normalmente em produção:

- `POST /v1/bank_slips/` (emissão de boleto) — OK
- `GET /v1/bank_slips/{id}` (consulta de boleto) — OK
- `PUT/PATCH /v2/pix/cob/{txid}` (cobrança PIX) — OK
- Consulta de DDA — OK
- Criação e submissão de lote de pagamento — OK

Ou seja, o problema é específico do produto/escopo de **Extrato**, não das
credenciais em si.

## O que precisamos

1. **Liberação do produto "Extrato/Statement"** para as credenciais de API
   da nossa integração (mesmo `client_id` usado nos endpoints acima).
2. Confirmação de qual é o **endpoint correto** para consulta de **saldo em
   conta** (ex: `/v1/balance`, `/v1/account/balance`, ou equivalente) — hoje
   não temos nenhuma integração com saldo, e gostaríamos de habilitar também,
   se possível na mesma liberação.
3. Se houver algum **escopo (scope) adicional** a ser solicitado no momento
   da autenticação (`client_credentials`), pedimos a documentação exata —
   hoje não enviamos nenhum parâmetro de `scope` na chamada a `/v1/auth/`,
   apenas `grant_type`, `client_id` e `client_secret`.

## Contato técnico

Kleber Câmara — desenvolvimento do sistema interno da Gráfica LKL.
