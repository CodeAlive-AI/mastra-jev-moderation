/**
 * Input moderation for Mastra agents on TypeSafe Jev.
 *
 * Mastra's built-in `ModerationProcessor` asks a language model for a verdict
 * and parses it out of text. Jev is not a language model: it answers typed
 * questions — a yes/no probability, a one-of-N choice — and emits no text, so
 * there is no verdict to fail to parse. That needs its own `Processor`, which
 * is this file.
 *
 * What it does, once per turn, in `processInput`:
 *
 * 1. takes the text of the last message only (not history, tool results or
 *    attachments), truncated to `maxChars`;
 * 2. asks Jev two questions in one request — "must this be blocked?" (the
 *    gate) and "which category?" (a log label that never decides anything);
 * 3. aborts the turn with `reason` when P(block) >= `threshold`.
 *
 * It fails open: a timeout, an HTTP error, an unparsable answer or an open
 * circuit breaker lets the message through and logs one line. The message
 * itself is never logged.
 *
 * Dependencies: `@mastra/core` (Processor types) and `zod`. Tested against
 * `@mastra/core` 1.61 and Jev 1.13.0 via `jev-latest`.
 */
import type { MastraDBMessage } from "@mastra/core/agent";
import type { Processor } from "@mastra/core/processors";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Jev System One API
// ---------------------------------------------------------------------------

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

/**
 * A yes/no question. The API calls this type `noul`; its answer is a number,
 * P(true). `criteria` describes what counts as `true` and as `false`.
 */
export interface JevBooleanQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

/**
 * A one-of-N question. The options go in `criteria` (option -> description),
 * not in an `options` field — the API answers 422 to the latter.
 */
export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface JevRequest {
  questions: Record<string, JevBooleanQuestion | JevChoiceQuestion>;
  /** Named values the questions refer to by name, e.g. `message`. */
  state: Record<string, unknown>;
}

/**
 * The HTTP call. Throws on anything but a 200 and never includes the response
 * body in the error: it can quote the request, which here is the user's message.
 */
export const askJev = async (
  request: JevRequest,
  options: {
    apiKey: string;
    signal: AbortSignal;
    endpoint?: string;
    model?: string;
  }
): Promise<unknown> => {
  const response = await fetch(options.endpoint ?? JEV_ENDPOINT, {
    body: JSON.stringify({ ...request, model: options.model ?? JEV_MODEL }),
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`jev: HTTP ${response.status}`);
  }
  return await response.json();
};

// ---------------------------------------------------------------------------
// Moderation policy
// ---------------------------------------------------------------------------

/** Category -> description. `none` is added automatically. */
export const DEFAULT_CATEGORIES: Record<string, string> = {
  harassment: "Harassment or abuse aimed at a person or at the assistant.",
  hate: "Hate towards a group.",
  illicit: "Help with something unlawful.",
  "self-harm": "Self-harm.",
  sexual: "Sexual content.",
  "sexual/minors": "Sexual content involving a minor.",
  violence: "Aims to harm or threaten a person, or to destroy someone's property.",
};

/**
 * The gate's criteria. Write your domain's carve-outs into `allow`: what
 * separates a dangerous subject from a dangerous request is the aim, not the
 * vocabulary, and a moderator without carve-outs will block e.g. "which norms
 * govern explosive demolition of a building?" for its words.
 */
export const DEFAULT_POLICY = {
  allow:
    "An ordinary request, however harsh its vocabulary sounds when the aim is legitimate work, study or safety. Also instructions addressed to the assistant itself — restating conditions, telling it what to assume or how to answer. Also casual expletives used as emphasis rather than aimed at someone.",
  block:
    "The message pursues a harmful aim: harming or threatening a person, destroying someone's property, obtaining help with something unlawful (weapons, explosives against people, drugs, forged documents), hate or harassment aimed at a person or at the assistant, sexual content, anything sexual involving a minor, or self-harm.",
};

const NO_CATEGORY = "none";

export interface ModerationVerdict {
  /** P(the message must be blocked). */
  score: number;
  /** The label Jev picked, or `none`. Logged, never used to decide. */
  category: string;
  /** The resolved model version the API reported, e.g. `jev-1.13.0`. */
  model: string;
  /** Input tokens billed. Jev bills no output tokens. */
  tokensIn: number | undefined;
}

const answerSchema = z.object({
  answers: z.object({
    blocking: z.object({ noul: z.number() }),
    // Optional on purpose: a missing label must not turn a block into a pass.
    category: z.object({ choice: z.string() }).optional(),
  }),
  model: z.string().optional(),
  usage: z.object({ input_tokens: z.number() }).optional(),
});

export interface ModerateOptions {
  apiKey: string;
  signal: AbortSignal;
  /** One sentence about your assistant and its users; sharpens the verdicts. */
  context?: string;
  policy?: { allow: string; block: string };
  categories?: Record<string, string>;
  endpoint?: string;
  model?: string;
}

/**
 * One request, two questions. Throws when the call fails or the answer does
 * not parse; the caller decides what a missing verdict means.
 */
export const moderateWithJev = async (
  message: string,
  options: ModerateOptions
): Promise<ModerationVerdict> => {
  const context = options.context === undefined ? "" : `${options.context} `;
  const policy = options.policy ?? DEFAULT_POLICY;
  const body = await askJev(
    {
      questions: {
        blocking: {
          criteria: { false: policy.allow, true: policy.block },
          instructions: `${context}\`message\` is what a user typed to the assistant. Must \`message\` be blocked before it reaches the assistant?`,
          type: "noul",
        },
        category: {
          criteria: {
            ...(options.categories ?? DEFAULT_CATEGORIES),
            [NO_CATEGORY]: "No violation: an ordinary request or ordinary talk.",
          },
          instructions: `${context}Which policy category does \`message\` fall into?`,
          type: "choice",
        },
      },
      state: { message },
    },
    options
  );
  const parsed = answerSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("jev: no parsable verdict");
  }
  return {
    category: parsed.data.answers.category?.choice ?? NO_CATEGORY,
    model: parsed.data.model ?? options.model ?? JEV_MODEL,
    score: parsed.data.answers.blocking.noul,
    tokensIn: parsed.data.usage?.input_tokens,
  };
};

// ---------------------------------------------------------------------------
// Resilience: deadline + circuit breaker
// ---------------------------------------------------------------------------

export interface ResilienceOptions {
  timeoutMs: number;
  /** Consecutive failures that open the breaker. */
  breakerThreshold: number;
  breakerCooldownMs: number;
  onBreakerOpen?: (error: unknown) => void;
  onBreakerRecovered?: () => void;
  now?: () => number;
}

/**
 * A slow or rate-limited moderator must not become the chat's latency. The
 * deadline caps one call; the breaker stops calling a vendor that is down, so
 * retries fail instantly instead of each waiting out the deadline.
 */
export const withResilience = <TInput, TResult>(
  call: (input: TInput, signal: AbortSignal) => Promise<TResult>,
  options: ResilienceOptions
): ((input: TInput) => Promise<TResult>) => {
  const now = options.now ?? Date.now;
  let failures = 0;
  let openUntil = 0;
  return async (input) => {
    if (now() < openUntil) {
      throw new Error("moderation breaker open");
    }
    try {
      const result = await call(input, AbortSignal.timeout(options.timeoutMs));
      if (failures >= options.breakerThreshold) {
        options.onBreakerRecovered?.();
      }
      failures = 0;
      return result;
    } catch (error: unknown) {
      failures += 1;
      if (failures === options.breakerThreshold) {
        openUntil = now() + options.breakerCooldownMs;
        options.onBreakerOpen?.(error);
      }
      throw error;
    }
  };
};

// ---------------------------------------------------------------------------
// The Mastra processor
// ---------------------------------------------------------------------------

export type InputProcessor = Processor &
  Required<Pick<Processor, "processInput">>;

export interface Logger {
  warn: (fields: Record<string, unknown>, message: string) => void;
}

export interface JevModerationOptions {
  apiKey: string;
  /** Block at P(block) >= threshold. Default 0.7. */
  threshold?: number;
  /** Passed to `abort()`; Mastra puts it into the tripwire verbatim. Default `MESSAGE_BLOCKED`. */
  reason?: string;
  /** Characters of the message sent. Jev refuses requests over 32k tokens. Default 8000. */
  maxChars?: number;
  /** Default 5000. */
  timeoutMs?: number;
  /** Default 3 failures, 60 s. */
  breaker?: { threshold: number; cooldownMs: number };
  context?: string;
  policy?: { allow: string; block: string };
  categories?: Record<string, string>;
  endpoint?: string;
  model?: string;
  /** Called after every answered call, blocked or not — for cost accounting. */
  onVerdict?: (verdict: ModerationVerdict) => void;
  /** Defaults to `console`. The message text is never passed to it. */
  logger?: Logger;
  /** Replace the vendor call, e.g. in tests or to route through a gateway. */
  moderate?: (message: string, signal: AbortSignal) => Promise<ModerationVerdict>;
  now?: () => number;
}

const consoleLogger: Logger = {
  warn: (fields, message) => {
    console.warn(message, fields);
  },
};

/**
 * Text parts joined with a space; when there are none, the legacy
 * `content.content` string — the same fallback Mastra's own
 * `ModerationProcessor` reads. Empty means "nothing to judge" and passes
 * unchecked, so a message must not look empty when it is not.
 */
const lastMessageText = (messages: readonly MastraDBMessage[]): string => {
  const content = messages.at(-1)?.content;
  const fromParts = (content?.parts ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .trim();
  return fromParts.length > 0 ? fromParts : (content?.content ?? "").trim();
};

export const createJevModerationProcessor = (
  options: JevModerationOptions
): InputProcessor => {
  const threshold = options.threshold ?? 0.7;
  const reason = options.reason ?? "MESSAGE_BLOCKED";
  const maxChars = options.maxChars ?? 8000;
  const logger = options.logger ?? consoleLogger;
  const moderate =
    options.moderate ??
    (async (message: string, signal: AbortSignal) =>
      await moderateWithJev(message, {
        apiKey: options.apiKey,
        categories: options.categories,
        context: options.context,
        endpoint: options.endpoint,
        model: options.model,
        policy: options.policy,
        signal,
      }));
  const guarded = withResilience(moderate, {
    breakerCooldownMs: options.breaker?.cooldownMs ?? 60_000,
    breakerThreshold: options.breaker?.threshold ?? 3,
    now: options.now,
    onBreakerOpen: (error) => {
      logger.warn(
        { err: error, guardrail: "moderation" },
        "moderation unavailable, skipping it until the cooldown expires"
      );
    },
    onBreakerRecovered: () => {
      logger.warn({ guardrail: "moderation" }, "moderation recovered");
    },
    timeoutMs: options.timeoutMs ?? 5000,
  });

  return {
    id: "jev-moderation",
    name: "Jev moderation",
    processInput: async ({ abort, messages }) => {
      const message = lastMessageText(messages).slice(0, maxChars);
      if (message.length === 0) {
        return messages;
      }
      let verdict: ModerationVerdict;
      try {
        verdict = await guarded(message);
      } catch (error: unknown) {
        logger.warn(
          { err: error, guardrail: "moderation" },
          "moderation returned no verdict, letting the message through"
        );
        return messages;
      }
      options.onVerdict?.(verdict);
      if (verdict.score < threshold) {
        return messages;
      }
      logger.warn(
        {
          category: verdict.category,
          guardrail: "moderation",
          model: verdict.model,
          score: verdict.score,
        },
        "moderation blocked a message"
      );
      return abort(reason);
    },
  };
};

/** Tells a moderation block from an ordinary stop: a stopped run has a tripwire too. */
export const isModerationBlock = (
  tripwire: { reason: string } | undefined,
  reason = "MESSAGE_BLOCKED"
): boolean => tripwire?.reason === reason;
