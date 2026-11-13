import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { meService, periodsService, reportsService, runService, Reply } from '../lib/service';

const PRINCIPAL = 'x-ms-client-principal';

function toResponse(r: Reply): HttpResponseInit {
  return { status: r.status, jsonBody: r.body, headers: { 'Cache-Control': 'no-store' } };
}

app.http('me', {
  route: 'me',
  methods: ['GET'],
  authLevel: 'anonymous', // Easy Auth + the IT-owned route config gate access; identity is read from the principal header
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => toResponse(await meService(req.headers.get(PRINCIPAL))),
});

app.http('reports', {
  route: 'reports',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => toResponse(await reportsService(req.headers.get(PRINCIPAL))),
});

app.http('periods', {
  route: 'periods',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> =>
    toResponse(await periodsService(req.headers.get(PRINCIPAL), { log: (m) => ctx.log(m) })),
});

app.http('run', {
  route: 'run',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> =>
    toResponse(await runService(req.headers.get(PRINCIPAL), await req.text(), { log: (m) => ctx.log(m) })),
});
