import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';

import { env, isProduction } from './config/env.js';
import routes from './routes/index.js';
import healthRoutes from './routes/health.routes.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';
import { registerSamplingSubscribers } from './subscribers/sampling.subscriber.js';
import { registerPricingSubscribers } from './subscribers/pricing.subscriber.js';

const app = express();

app.set('trust proxy', 1);
app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || env.corsOrigin.includes(origin) || env.corsOrigin.includes('*')) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(compression());
app.use(morgan(isProduction ? 'combined' : 'dev'));

// Login and registration are the only brute-forceable endpoints, so they get a tighter limit.
app.use(
  '/api/auth',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false })
);
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

// Outside /api, so the rate limiters above do not apply — probes must never be throttled.
app.use('/health', healthRoutes);

app.use('/api', routes);

// Cross-module automation: completing a stage creates the next department's task [§C.1].
// Registered once here rather than inside a module, so the modules stay unaware of each other.
registerSamplingSubscribers();
registerPricingSubscribers();

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
