import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';

import { env, isProduction } from './config/env.js';
import routes from './routes/index.js';
import healthRoutes from './routes/health.routes.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';
import ApiError from './utils/ApiError.js';
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
/*
 * The general ceiling, and the one knob on it.
 *
 * 300 a minute is what a deployed server allows a single caller, and that stays the default —
 * nothing about production changes unless somebody sets the variable. It became configurable
 * because the test suites drive this app in-process at a speed no person can: one file walking
 * fifty sample requests through their stages spends several hundred calls in a few seconds and
 * starts getting 429s, which reads as a broken feature rather than as a limiter doing its job.
 *
 * Configurable rather than disabled under NODE_ENV, so the limiter is still mounted and still
 * behaves the same way — only the number moves, and only where somebody has said so.
 */
const requestsPerMinute = Number(process.env.RATE_LIMIT_MAX) || 300;

/**
 * Who a request is, for the purpose of counting it: a signed-in person, or else an address.
 *
 * The limit used to be per IP address, which is the wrong unit for this app. The plant office
 * reaches the server through one public address, so every person in the building shared one
 * budget of 300 a minute — and a screen costs eight to ten calls. A dozen people working
 * normally, or one person moving quickly, spent it for everybody, and the whole office then
 * saw failed screens at once with nothing to connect it to a limit. The credential limiter
 * above already learned this lesson about NAT; this one had not.
 *
 * So a request carrying a valid session is counted against that person. The token is
 * *verified*, not just read: keying on the raw header would let anybody mint a fresh bucket per
 * request by sending random tokens, which is a way around the limit rather than a fairer one.
 * Anything without a valid session — the login page, a scanner, an expired tab — is still
 * counted by address, exactly as before.
 */
const callerKey = (req) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const { sub } = jwt.verify(token, env.jwtSecret);
      if (sub) return `user:${sub}`;
    } catch {
      /* An invalid or expired token is counted like no token at all. */
    }
  }
  return `ip:${req.ip}`;
};

app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: requestsPerMinute,
  keyGenerator: callerKey,
  standardHeaders: true,
  legacyHeaders: false,
}));

// Outside /api, so the rate limiters above do not apply — probes must never be throttled.
app.use('/health', healthRoutes);

/*
 * A query string carries plain values, never objects.
 *
 * Express parses `?customer[$ne]=x` into `{ customer: { $ne: 'x' } }`, and most list filters
 * copy a parameter straight into the Mongo filter — so a hand-typed address could put an
 * operator there. Scope is enforced separately and held under every operator the audit tried,
 * but `$regex` against an id field made Mongoose throw, and nine lists answered with a 500.
 * The screens only ever send flat values (repeated keys for a list are still fine), so anything
 * shaped like an object is refused here, once, instead of in every controller.
 */
const holdsObject = (value) =>
  Array.isArray(value) ? value.some(holdsObject) : value !== null && typeof value === 'object';

app.use('/api', (req, _res, next) => {
  const bad = Object.keys(req.query).find((key) => holdsObject(req.query[key]));
  if (bad) return next(ApiError.badRequest(`The filter "${bad}" must be a plain value`));
  return next();
});

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
