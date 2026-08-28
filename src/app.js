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
import { registerOrderSubscribers } from './subscribers/orders.subscriber.js';
import { registerQuotationSubscribers } from './subscribers/quotation.subscriber.js';

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

/*
 * The tight limit belongs on guessing a credential, not on holding one.
 *
 * It used to cover all of `/api/auth`, which includes `/auth/me` — the call the app makes on
 * every boot to find out who is signed in. Fifty per fifteen minutes is generous for one
 * person guessing passwords and mean for a plant office behind one NAT address, where a
 * dozen people opening the app and refreshing it spend the budget on nothing but session
 * checks and then cannot sign in at all. The failure looks like a broken login, so nobody
 * connects it to the limit.
 *
 * So the strict bucket is the unauthenticated ones — where a wrong answer is an attempt at
 * somebody's account — and everything else falls through to the ordinary API limit. The OTP
 * routes keep their own tighter limits on top, in auth.routes.js.
 */
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/auth/login', credentialLimiter);
app.use('/api/auth/register', credentialLimiter);
app.use('/api/auth/otp', credentialLimiter);
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

// Outside /api, so the rate limiters above do not apply — probes must never be throttled.
app.use('/health', healthRoutes);

app.use('/api', routes);

// Cross-module automation: completing a stage creates the next department's task [§C.1].
// Registered once here rather than inside a module, so the modules stay unaware of each other.
registerSamplingSubscribers();
registerPricingSubscribers();
registerOrderSubscribers();
registerQuotationSubscribers();

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
