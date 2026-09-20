import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, isProduction } from './config/index.js';
import { logger } from './utils/logger.js';
import { clock } from './utils/time.js';
import { ApiError, createErrorHandler } from './utils/http.js';
import { apiRouter } from './routes/index.js';
import { attachRealtime } from './services/realtime.js';
import { startMonitoring, stopMonitoring } from './services/monitoring.js';
import { db, databaseStatus } from './db/client.js';
import { store } from './domain/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = logger.child('server');

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(
    cors({
      origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((entry) => entry.trim()),
      credentials: false,
    }),
  );
  app.use(express.json({ limit: '256kb' }));

  // Lightweight request log — enough to demo the API without drowning the console.
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - startedAt;
      const line = `${req.method} ${req.originalUrl} → ${res.statusCode} (${ms} ms)`;
      if (res.statusCode >= 500) log.error(line);
      else if (res.statusCode >= 400) log.warn(line);
      else log.debug(line);
    });
    next();
  });

  app.use('/api', apiRouter);

  // Anything else under /api is a 404 in the API's own envelope.
  app.use('/api', (req, res, next) => next(new ApiError(404, 'NOT_FOUND', `No API route matches ${req.method} ${req.originalUrl}`)));

  // Production build of the client, served from the same origin as the API.
  const clientDist = path.resolve(__dirname, '../../client/dist');
  if (existsSync(clientDist)) {
    // Hashed assets are immutable; index.html must never be cached or a deploy
    // would keep serving the old bundle.
    app.use(
      '/assets',
      express.static(path.join(clientDist, 'assets'), {
        index: false,
        immutable: true,
        maxAge: '1y',
      }),
    );
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/socket.io') || req.path.startsWith('/api')) return next();
      res.setHeader('Cache-Control', 'no-store');
      return res.sendFile(path.join(clientDist, 'index.html'));
    });
  } else {
    app.get('/', (req, res) =>
      res.json({
        data: {
          service: 'TravelGuard AI API',
          note: 'The client build was not found. Run `npm run build` in the client workspace, or use the Vite dev server on :5173.',
          endpoints: ['/api/health', '/api/bootstrap', '/api/reference', '/api/demo/scenarios'],
        },
        meta: { serverTime: new Date().toISOString() },
      }),
    );
  }

  app.use(createErrorHandler(log));
  return app;
}

export function startServer(port = config.port) {
  const app = createApp();
  const server = createServer(app);

  attachRealtime(server);
  startMonitoring();

  server.listen(port, '0.0.0.0', () => {
    const trip = store.activeTrip();
    log.info(`TravelGuard API listening on http://0.0.0.0:${port} (${config.env})`);
    log.info(`Simulation clock anchored at ${clock.now().toISOString()} · travel date ${trip.startDate}`);
    log.info(`Database: ${databaseStatus().connected ? 'connected' : 'in-memory only'} · AI layer: ${config.ai.provider}`);
  });

  const shutdown = async (signal) => {
    log.info(`${signal} received — shutting down`);
    stopMonitoring();
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 4000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error(`unhandled rejection: ${reason}`));

  return server;
}

if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  startServer();
}

export { isProduction };
