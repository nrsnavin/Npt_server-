import Anthropic from '@anthropic-ai/sdk';

/**
 * The one door to the model, with the budgets every call through it is held to.
 *
 * Four features ask the model something — the assistant reads a question, the task dialog
 * suggests a department, the review ranks the plant's problems, the lead coach reads an activity
 * log. Each had its own copy of the same thirty lines: a lazily built client, a refusal check, a
 * text-block dig, a `JSON.parse`, a Zod recheck and a catch that falls back. Four copies is how
 * a gap gets into all four at once, and one did:
 *
 * **Every one of those four promised a timeout fallback in its own comment, and none set a
 * timeout.** The SDK defaults to ten minutes with two retries, so a hung connection held an
 * Express handler for up to half an hour while somebody watched a dialog that said "Reading the
 * task…". The fallback logic was all correct and simply never ran, because nothing ever gave up.
 * That is the shape of bug that survives code review four times and dies the moment there is one
 * place to look.
 *
 * So: one client, one place where a request is made, and a budget that must be named at the call
 * site. The helper returns the validated object or `null`, and `null` means "use your fallback"
 * — whatever went wrong. No caller needs to know the difference between a refusal, a truncation
 * and a reset connection, and every caller has something sensible to do without the model.
 */

/**
 * How long a caller is prepared to wait, and how many times it is worth asking again.
 *
 * Named budgets rather than numbers at the call sites, because the question "how long may this
 * block a person?" has exactly two answers in this app and they should not be re-decided per
 * feature.
 *
 * One retry, not the SDK's two. A retry is worth having — a 529 on an overloaded minute is
 * genuinely transient — but the budget is the *total* wait a person is exposed to, and two
 * retries with backoff turns an eight-second ceiling into something over thirty. Where there is
 * a good answer available locally, waiting is the worse trade.
 */
export const BUDGETS = {
  /** Somebody is watching a dialog or a panel. Give up early and let the rules answer. */
  interactive: { timeout: 8000, maxRetries: 1 },
  /** A judgement worth a moment, off the critical path — a dashboard card, a coach's reading. */
  considered: { timeout: 25000, maxRetries: 1 },
};

export const llmConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

/**
 * Whether a model takes the `effort` setting.
 *
 * Haiku 4.5 takes structured output but answers `effort` with a 400. Every call through here
 * sent it, so the four query features that default to Haiku — the summary, the reply draft, the
 * phrase search and the urgency reading — were refused on every request and quietly fell back
 * to the rules. The fallback was so good at its job that nothing looked broken.
 */
export const takesEffort = (model) => !/haiku/i.test(String(model || ''));

let client;
/**
 * Built once, and only when a key exists.
 *
 * Constructing it eagerly would make the module throw at import time on every deployment that
 * has not configured a key — including the test suite, which must never reach the network.
 */
function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

/**
 * Asks for one structured answer, and returns it validated or `null`.
 *
 * `null` on: no key, a refusal, a response truncated at `max_tokens`, no text block, a body that
 * is not JSON, a body that fails `schema`, a timeout, a network error, a 5xx. Each is logged
 * with what actually happened — the cause matters to whoever reads the logs even though it
 * changes nothing for the caller, and a truncation diagnosed as a network failure is how a
 * `max_tokens` ceiling stays too low for a year.
 *
 * `format` must carry real JSON Schema `enum`s where the answer has to be one of a fixed set.
 * The generator available here turns `z.enum([...])` into a plain string with the permitted
 * values mentioned in its *description*, which is a request rather than a constraint — and for
 * every one of these features the point is that the model cannot name a value the code does not
 * implement. `schema` then rechecks on the way back: structured output constrains generation,
 * and this rejects anything that slips past it.
 */
export async function askForJson({
  label,
  model,
  system,
  user,
  format,
  schema,
  effort = 'low',
  maxTokens = 1024,
  budget = BUDGETS.interactive,
}) {
  const api = anthropic();
  if (!api) return null;

  try {
    const response = await api.messages.create(
      {
        model,
        max_tokens: maxTokens,
        system,
        /*
         * Thinking stays adaptive rather than disabled. Effort is how latency is bought here:
         * disabling thinking on these models brings its own failure modes, and low effort is the
         * cheaper, better-behaved route to the same wait.
         */
        output_config: { ...(takesEffort(model) ? { effort } : {}), format },
        messages: [{ role: 'user', content: user }],
      },
      /* The budget the caller named. Without this the SDK waits ten minutes, twice. */
      { timeout: budget.timeout, maxRetries: budget.maxRetries }
    );

    /* A refusal is a 200 with nothing usable in it. Treat it as a read that did not happen. */
    if (response.stop_reason === 'refusal') {
      console.warn(`[${label}] the model declined; using the fallback`);
      return null;
    }

    /*
     * Truncated at the ceiling.
     *
     * Worth its own branch rather than being left to fail in `JSON.parse` below. It did fall
     * back correctly — a half-written object is not valid JSON — but it was logged as though the
     * network had failed, which is the one diagnosis that would stop anybody raising
     * `max_tokens`. The distinction is invisible to the person waiting and the whole story to
     * whoever is reading the logs a month later.
     */
    if (response.stop_reason === 'max_tokens') {
      console.warn(`[${label}] the answer hit the ${maxTokens}-token ceiling; using the fallback`);
      return null;
    }

    const body = (response.content || []).find((block) => block.type === 'text')?.text;
    if (!body) {
      console.warn(`[${label}] the model returned no text; using the fallback`);
      return null;
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      console.warn(`[${label}] the answer was not JSON; using the fallback`);
      return null;
    }

    const checked = schema.safeParse(parsed);
    if (!checked.success) {
      console.warn(
        `[${label}] the answer did not match the agreed shape; using the fallback:`,
        checked.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ')
      );
      return null;
    }

    return checked.data;
  } catch (error) {
    /*
     * Logged, not raised. Every caller has a local answer, and a bad afternoon on somebody
     * else's network is not a reason for the plant to lose a feature.
     */
    console.error(`[${label}] the model could not be reached; using the fallback:`, error.message);
    return null;
  }
}
