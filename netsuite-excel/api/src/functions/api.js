import azureFunctions from '@azure/functions'; // CommonJS package: import the default, then take `app`
import { meService, periodsService, reportsService, runService } from '../lib/service.js';

const { app } = azureFunctions;

const PRINCIPAL = 'x-ms-client-principal';

function toResponse(r) {
  return { status: r.status, jsonBody: r.body, headers: { 'Cache-Control': 'no-store' } };
}

app.http('me', {
  route: 'me',
  methods: ['GET'],
  authLevel: 'anonymous', // Easy Auth + the IT-owned route config gate access; identity is read from the principal header
  handler: async (req) => toResponse(await meService(req.headers.get(PRINCIPAL))),
});

app.http('reports', {
  route: 'reports',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (req) => toResponse(await reportsService(req.headers.get(PRINCIPAL))),
});

app.http('periods', {
  route: 'periods',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (req, ctx) =>
    toResponse(await periodsService(req.headers.get(PRINCIPAL), { log: (m) => ctx.log(m) })),
});

app.http('run', {
  route: 'run',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (req, ctx) =>
    toResponse(await runService(req.headers.get(PRINCIPAL), await req.text(), { log: (m) => ctx.log(m) })),
});
