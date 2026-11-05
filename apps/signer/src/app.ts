import { timingSafeEqual, createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignerRefusal, type Signer } from './signer.js';

export interface SignerAppOptions {
  signer: Signer;
  /** Bearer token the API presents. Possession lets a caller ask, never decide. */
  token: string;
  logger?: boolean;
}

const sha = (s: string) => createHash('sha256').update(s).digest();

const signBody = {
  type: 'object',
  required: ['intent', 'approvals'],
  additionalProperties: false,
  properties: {
    intent: { type: 'object' },
    intentHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    approvals: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        required: ['userId', 'credentialId', 'assertion'],
        additionalProperties: false,
        properties: {
          userId: { type: 'string', maxLength: 64 },
          credentialId: { type: 'string', maxLength: 1400 },
          assertion: { type: 'object' },
        },
      },
    },
  },
} as const;

export function buildSignerApp({ signer, token, logger = false }: SignerAppOptions): FastifyInstance {
  const app = Fastify({ logger, bodyLimit: 256 * 1024, ajv: { customOptions: { removeAdditional: false } } });
  const expected = sha(token);

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!timingSafeEqual(sha(given), expected)) {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'missing or wrong service token' } });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof SignerRefusal) {
      return reply.status(422).send({ error: { code: 'REFUSED', reason: err.reason, message: err.message, detail: err.detail } });
    }
    const e = err as { validation?: unknown; statusCode?: number; message?: string };
    if (e.validation || (e.statusCode && e.statusCode < 500)) {
      return reply.status(e.statusCode ?? 400).send({ error: { code: 'BAD_REQUEST', message: e.message ?? 'bad request' } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal error' } });
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/v1/status', async () => signer.status());

  app.post<{ Body: Parameters<Signer['signPayout']>[0] }>('/v1/payouts/sign', { schema: { body: signBody } }, async (req) =>
    signer.signPayout(req.body),
  );
  app.post<{ Body: Parameters<Signer['applyGovernance']>[0] }>('/v1/governance/apply', { schema: { body: signBody } }, async (req) =>
    signer.applyGovernance(req.body),
  );

  app.post<{ Body: { reason: string } }>(
    '/v1/breaker/trip',
    { schema: { body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } } } } },
    async (req) => {
      await signer.tripBreaker(req.body.reason);
      return signer.status();
    },
  );

  app.get<{ Querystring: { after?: number } }>(
    '/v1/log',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { after: { type: 'integer', minimum: 0 } } } } },
    async (req) => ({ entries: await signer.log(req.query.after ?? 0) }),
  );
  app.get('/v1/refusals', async () => ({ refusals: await signer.refusals() }));
  app.get('/v1/payees', async () => ({ payees: await signer.payees() }));
  app.get('/v1/approvers', async () => ({ approvers: await signer.approvers() }));

  app.post<{ Body: { seq: number; hash: string } }>(
    '/v1/anchors',
    {
      schema: {
        body: {
          type: 'object', required: ['seq', 'hash'], additionalProperties: false,
          properties: { seq: { type: 'integer', minimum: 1 }, hash: { type: 'string', pattern: '^[0-9a-f]{64}$' } },
        },
      },
    },
    async (req) => signer.anchor(req.body.seq, req.body.hash),
  );
  app.get('/v1/anchors', async () => ({ anchors: await signer.anchors() }));

  return app;
}
