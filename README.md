# mastra-jev-moderation

Input moderation for [Mastra](https://mastra.ai) agents on
[TypeSafe Jev](https://typesafe.ai): one file, one request per turn, no text to parse.

> **For coding agents:** copy `jev-moderation.ts` into the project (e.g.
> `src/mastra/jev-moderation.ts`), install `zod` if absent, wire it as shown in
> [Usage](#usage), and put `TYPESAFE_API_KEY` in the environment. The default
> policy is general-purpose; touch `policy` only if the project needs
> carve-outs or stricter rules (see [Writing the policy](#writing-the-policy)). Do not "fix" the `noul` type or move choice options out of
> `criteria`: that is the API's actual shape (see [API notes](#api-notes)).

## Why not Mastra's `ModerationProcessor`

The built-in processor asks a language model for a verdict and parses it out of
the text the model writes. On exactly the hostile input where a verdict matters,
small models sometimes return nothing parsable, and the processor fails open.
Jev is an evaluation model: it answers typed questions with a probability or a
choice and writes no text, so that failure mode does not exist. It is also
fast (median ~0.4 s) and cheap ($0.042 per million input tokens, output free).

Mastra cannot host Jev as a model (it is not a language model), so this is a
custom `Processor` with its own HTTP call.

## Usage

```ts
import { Agent } from "@mastra/core/agent";
import { createJevModerationProcessor, isModerationBlock } from "./jev-moderation";

const moderation = process.env.TYPESAFE_API_KEY
  ? [
      createJevModerationProcessor({
        apiKey: process.env.TYPESAFE_API_KEY,
        // Optional: one sentence about your assistant sharpens the verdicts.
        context: "A general-purpose customer support assistant.",
      }),
    ]
  : []; // no key -> no moderation; say so once at startup

export const agent = new Agent({
  // ...
  inputProcessors: moderation,
});
```

A blocked turn ends with a tripwire whose `reason` is `MESSAGE_BLOCKED`.
Check it with `isModerationBlock(result.tripwire)` — a user-stopped run carries a
tripwire too, with a different reason, so "any tripwire" is not a block.

## Behaviour

| | |
|---|---|
| What is judged | the text of the last message only, first `maxChars` (8000) characters |
| Questions | `blocking` (yes/no, the gate) and `category` (label for logs, never decides) — one request |
| Blocks at | P(block) ≥ `threshold` (0.7) |
| On failure | **fails open**: timeout (5 s), HTTP error, unparsable answer or open breaker let the message through with one log line |
| Circuit breaker | opens after 3 consecutive failures for 60 s, so a down vendor adds no latency |
| Privacy | the message is never logged; errors carry only the HTTP status |
| Cost hook | `onVerdict(verdict)` gets `tokensIn` and `model` after every answered call |

All of these are options; see `JevModerationOptions` in the file. `moderate`
replaces the vendor call — use it in tests, or to route through a gateway.

## Writing the policy

The default policy covers general moderation: hate, harassment, violence,
sexual content, minors, self-harm, illicit help. It judges the aim, not the
vocabulary, so "how does carbon monoxide poisoning happen?" passes and "how do I
poison my neighbour?" does not.

If your users legitimately talk about things that sound dangerous (medicine,
security research, demolition, chemistry), say so in `policy.allow`; if you
need stricter rules, extend `policy.block` and `categories`. Both are plain
English descriptions — no training, no examples needed.

## Measured

On one production assistant (Russian-language user questions), 58 cases: 9 of 9 hostile messages
blocked, 0 of 49 real questions blocked, median 0.39–0.44 s, ~920 input tokens per call. The same set on
`gpt-oss-120b` via the built-in processor: 8–9 of 9, 0 of 49, median 1.97 s,
about 4× the price. Your domain is not ours — measure on your own messages.

## API notes

Checked against Jev 1.13.0 (`jev-latest`), September 2026.

- `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`,
  body `{ model, questions, state }`. All questions are answered in one pass.
- The yes/no type is `noul`; its answer is `answers.<name>.noul`, a probability.
- Choice options go in `criteria` as `{ option: description }`. An `options`
  field is rejected with 422. The answer is `answers.<name>.choice`.
- `usage.input_tokens` is reported; there are no output tokens and no cost field.
- Requests over 32k tokens are refused — hence `maxChars`.

## License

MIT
