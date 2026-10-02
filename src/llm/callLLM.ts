import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { MODELS, MAX_TOKENS, PROVIDERS, THINKING, EFFORT, CACHE_SYSTEM, TEMPERATURE } from './models.js';
import { BUBBLE_ENVELOPE_SCHEMA, buildEnvelopeSchema, parseReply } from '../pipeline/bubbleJson.js';
import { buildOpenRouterParams, buildOpenAIParams, hasDocument, hasNativeMedia, isLengthStarved, starvedRetryEnabled, llmCallTimeoutMs, toStreamingParams, type OpenRouterParams, type StreamingParams } from './openrouterRequest.js';
import { renderTimestamps } from './timedMessages.js';
import { inlineImageBlocks } from './inlineImages.js';
import { inlineMediaBlocks } from './inlineMedia.js';
import { record } from '../diagnostics/trace.js';
import { recordTokenUsage } from '../db/repositories/tokenUsage.js';
import { fromAnthropicContent, fromOpenRouterMessage } from './serverToolText.js';
import { shouldFallback } from './fallbackPolicy.js';
import { isTruncatedStop, starvedError, isStarvedError, bumpStarvedBudget, starvedRetryCap } from './truncation.js';
import { reportError } from '../diagnostics/errorLog.js';
import { checkCallBudgets, reportTaskUsage } from './budget.js';
import { isLaneConfigured, laneEnvVar, laneKey, laneBaseUrl, laneUnconfiguredError, noLaneConfiguredError } from './laneKeys.js';
import type { LlmRequest, LlmResult, LlmContentBlock, LlmProvider, LlmRole } from './types.js';

// Clients are built LAZILY and rebuilt when the key changes. A lane whose key is unset or BLANK
// (`ANTHROPIC_API_KEY=` — see laneKeys.ts) must end up with NO client at all: `new Anthropic()`
// accepts a blank key and only throws from inside the first request, which is how a keyless
// fallback leg used to bury the primary lane's real error.
let anthropicLane: { key: string; client: Anthropic } | null = null;
function anthropicClient(): Anthropic | null {
  const key = laneKey('anthropic');
  if (!key) return null;
  if (anthropicLane?.key !== key.value) {
    // ANTHROPIC_AUTH_TOKEN configures the lane just as well as an api key — send whichever we have,
    // as the matching option (the SDK resolves exactly one auth header). Everything else (base URL,
    // …) keeps coming from the SDK's own env defaults.
    anthropicLane = {
      key: key.value,
      client: new Anthropic(key.envVar === 'ANTHROPIC_AUTH_TOKEN' ? { authToken: key.value } : { apiKey: key.value }),
    };
  }
  return anthropicLane.client;
}

// Both OpenAI-compatible lanes take an env-configurable base URL (laneBaseUrl, read at CALL time so a
// .env edit between runs is honoured). The lane cache keys on key AND base URL, so repointing
// OPENAI_BASE_URL (or the key) rebuilds the client rather than reusing a stale connection.
let openrouterLane: { key: string; baseURL: string; client: OpenAI } | null = null;
function openrouterClient(): OpenAI | null {
  const key = laneKey('openrouter');
  if (!key) return null;
  const baseURL = laneBaseUrl('openrouter');
  if (openrouterLane?.key !== key.value || openrouterLane?.baseURL !== baseURL) {
    openrouterLane = { key: key.value, baseURL, client: new OpenAI({ apiKey: key.value, baseURL }) };
  }
  return openrouterLane.client;
}

let openaiLane: { key: string; baseURL: string; client: OpenAI } | null = null;
function openaiClient(): OpenAI | null {
  const key = laneKey('openai');
  if (!key) return null;
  const baseURL = laneBaseUrl('openai');
  if (openaiLane?.key !== key.value || openaiLane?.baseURL !== baseURL) {
    openaiLane = { key: key.value, baseURL, client: new OpenAI({ apiKey: key.value, baseURL }) };
  }
  return openaiLane.client;
}

// --- Anthropic ------------------------------------------------------------
export function toAnthropicContent(content: string | LlmContentBlock[]): Anthropic.ContentBlockParam[] | string {
  if (typeof content === 'string') return content;
  const out: Anthropic.ContentBlockParam[] = [];
  for (const b of content) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text });
    else if (b.type === 'image') {
      // A prefetched `data:<mime>;base64,…` URL (MM's verified fetch, or the ops read_attachment image
      // lane) must map to a base64 source — Anthropic's `url` source cannot read data: URLs (400).
      const m = /^data:([^;]+);base64,(.*)$/s.exec(b.url);
      out.push(m
        ? { type: 'image', source: { type: 'base64', media_type: m[1] as 'image/jpeg', data: m[2] } }
        : { type: 'image', source: { type: 'url', url: b.url } });
    }
    else if (b.type === 'document') out.push({ type: 'document', source: { type: 'base64', media_type: b.mediaType as 'application/pdf', data: b.data } });
    else {
      // audio | video — Anthropic has no native support. The fallback guard (hasNativeMedia) keeps
      // these off this path in practice; this is a belt-and-suspenders drop-with-note so a
      // misconfigured role degrades to text instead of throwing.
      console.warn(`[llm] ${b.type} block dropped on the Anthropic path (unsupported)`);
      out.push({ type: 'text', text: `[${b.type} attachment omitted: not supported on this model]` });
    }
  }
  return out;
}

// The web_search server tool can return stop_reason 'pause_turn' mid-turn; we must echo the
// response content back verbatim (it carries encrypted citation tokens) and continue. Bound the
// continuations so a runaway can't loop. SDK 0.39 doesn't type these wire features — hence the casts.
const MAX_PAUSE_CONTINUATIONS = 4;

/** Restore inputs SDK 0.39's stream accumulator drops: it applies input_json_delta only to
 *  'tool_use' blocks, so server-tool blocks (web_search's server_tool_use) end the stream with an
 *  empty input. Patch them from our own raw-delta buffers, keyed by content-block index. Client
 *  tool_use blocks are left to the SDK (its partial-JSON accumulation already handled them). */
export function patchServerToolInputs(content: Array<{ type: string; input?: unknown }>, inputBufs: Map<number, string>): void {
  for (const [index, buf] of inputBufs) {
    const block = content[index];
    if (!block || block.type === 'tool_use' || !buf) continue;
    try { block.input = JSON.parse(buf); } catch { /* partial JSON — leave the SDK's snapshot */ }
  }
}

/** One `cache_control`-carrying text block. The remainder block after a prefix split has no marker. */
type AnthropicSystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

/** How many `cache_control` blocks one request may carry — the provider's own limit. A caller that
 *  offers more breakpoints than this keeps its first four, which are the most stable ones. */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * The breakpoints actually usable on `system`, in order: positive, no further than its end, and each
 * one strictly past the last (a zero-length block is rejected by the API, and an offset that doesn't
 * advance is exactly what an EMPTY stable slot hands in). An offset AT the end is usable: it is what
 * Convo declares for a system message that is stable end to end, whose history-bearing tail rides
 * in the messages instead (agents/convo/promptSections.ts). Capped at the provider's limit. Pure.
 */
function cacheCutPoints(offsets: readonly number[] | undefined, len: number): number[] {
  const cuts: number[] = [];
  for (const offset of offsets ?? []) {
    if (!Number.isFinite(offset) || offset <= 0 || offset > len) continue;
    if (cuts.length && offset <= cuts[cuts.length - 1]) continue;
    cuts.push(offset);
    if (cuts.length === MAX_CACHE_BREAKPOINTS) break;
  }
  return cuts;
}

/**
 * Build the Anthropic `system` param, caching the stable prefixes for opted-in roles. Sub-
 * 1024/4096-token cached spans silently won't cache (no error). Three shapes:
 *  • caching off → the bare string (Anthropic bills it as ordinary input every call).
 *  • caching on WITH breakpoints → one block per span between them, each of those carrying
 *    `cache_control`, plus the remainder after the last one as a final UNcached block when there is
 *    one. Convo hands in two: the static persona head, then the end of the system message, which is
 *    stable WITHIN a chat (agents/convo/promptSections.ts) — so its system is two cached blocks and
 *    no remainder. Without any split the single breakpoint would
 *    sit after the per-turn-varying tail (current time to ms, dossier, …), making every turn a full
 *    cache WRITE — no reads, ~25% premium, and the write tokens still count toward the daily cap.
 *    That is the bug the first breakpoint fixes; the second one is the same argument one level in —
 *    a prefix that only changes when the chat's tools or gates change should not be re-billed on
 *    every turn just because the clock moved. With ONE breakpoint the output is byte-identical to
 *    what the single-length signature emitted.
 *  • caching on with no usable breakpoint → the whole system as one cached block (roles whose
 *    system is stable end to end).
 * Exported for unit tests.
 */
export function buildAnthropicSystem(
  system: string | undefined,
  cacheEnabled: boolean,
  cacheBreakpoints: readonly number[] | undefined,
): string | AnthropicSystemBlock[] | undefined {
  if (!system) return undefined;
  if (!cacheEnabled) return system;
  const cuts = cacheCutPoints(cacheBreakpoints, system.length);
  if (!cuts.length) return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  const blocks: AnthropicSystemBlock[] = [];
  let from = 0;
  for (const cut of cuts) {
    blocks.push({ type: 'text', text: system.slice(from, cut), cache_control: { type: 'ephemeral' } });
    from = cut;
  }
  if (from < system.length) blocks.push({ type: 'text', text: system.slice(from) });
  return blocks;
}

async function callAnthropic(req: LlmRequest): Promise<LlmResult> {
  const client = anthropicClient();
  if (!client) throw laneUnconfiguredError('anthropic');
  const model = req.modelOverride || MODELS[req.role].anthropic;
  // The cap actually sent: a per-call override BINDS over the role ceiling (the small hardcoded
  // caps), and it is what the starvation guard and the ledger must report.
  const maxTokensSent = req.maxTokens ?? MAX_TOKENS[req.role];
  // toolsViaJson: tools travel inside the envelope schema + prompt docs, never as the native param
  // (same either/or as the OpenRouter path — both channels at once risks double-dispatch).
  const tools: Anthropic.Tool[] = req.toolsViaJson ? [] : (req.tools ?? []).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
  if (req.enableWebSearch) {
    tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: req.webSearchMaxUses ?? 3 } as unknown as Anthropic.Tool);
  }

  // Structured message timestamps become in-band content here (the API rejects unknown keys).
  const messages: Anthropic.MessageParam[] = renderTimestamps(req.messages).map(m => ({
    role: m.role,
    content: toAnthropicContent(m.content),
  }));

  // Per-role tuning (Ops opts in; see models.ts). Adaptive thinking + effort raise accuracy on the
  // multi-step tool loop; caching the stable system prefix cuts the repeated cost across steps.
  const thinking = THINKING[req.role];
  const effort = EFFORT[req.role];
  const temp = req.temperature ?? TEMPERATURE[req.role] ?? undefined;
  // temperature and extended thinking are mutually exclusive on Claude 4.x (the API 400s). When
  // thinking is on, drop temperature and warn so a misconfig is visible.
  const sendTemp = temp !== undefined && !thinking;
  if (temp !== undefined && thinking) {
    console.warn(`[llm] ${req.role}: temperature ignored — mutually exclusive with adaptive thinking on Claude 4.x (set thinking off to use it)`);
  }
  // Cache the stable system prefixes for opted-in roles (see buildAnthropicSystem).
  const systemParam = buildAnthropicSystem(req.system, CACHE_SYSTEM[req.role], req.systemCacheBreakpoints);

  // jsonBubbles: enforce the bubble envelope AT THE API on this path too, via structured outputs
  // (output_config.format, GA — coexists with tools exactly like OpenRouter's response_format).
  // This closes the fallback hole where a transient OpenRouter failure landed a jsonBubbles turn on
  // Anthropic with NO schema enforcement, letting prompt-only prose slip out to the bubble splitter.
  const buildOutputConfig = (withFormat: boolean, withEffort = true): Record<string, unknown> | undefined => {
    const cfg: Record<string, unknown> = {};
    if (withEffort && effort) cfg.effort = effort;
    if (withFormat && req.jsonBubbles) {
      cfg.format = { type: 'json_schema', schema: req.envelopeSchema ?? (req.toolsViaJson ? buildEnvelopeSchema(req.tools) : BUBBLE_ENVELOPE_SCHEMA) };
    }
    return Object.keys(cfg).length ? cfg : undefined;
  };

  // SDK 0.39 doesn't type adaptive thinking or output_config; cast the whole params bag (same
  // precedent as the web_search tool + pause_turn casts elsewhere in this file).
  // STREAMING, not create(): the SDK hard-rejects non-streaming requests whose max_tokens implies
  // >10 min of generation (throws at >21,333 tokens) — with the 64k Ops ceiling that error fires on
  // EVERY call and, being statusless, silently reroutes the whole role to the OpenRouter fallback
  // lane. finalMessage() accumulates the stream back into a complete Message — content blocks,
  // tool_use inputs, usage, stop_reason all arrive as before, EXCEPT server-tool inputs: SDK 0.39's
  // accumulator predates server tools and only rebuilds input_json_delta for blocks of type
  // 'tool_use', so a server_tool_use block (web_search) would come back with an empty input — and
  // the pause_turn echo must be verbatim. We accumulate the raw deltas ourselves and patch the
  // final message.
  // Every wire request leg, captured for diagnostics (the /dashboard "RAW request (wire, sent)"
  // view), symmetric with rawLegs (the response legs) below. Snapshot the messages ARRAY per leg —
  // shallow, since the content objects are never mutated, only appended to across a pause_turn
  // continuation — so a later messages.push does not retroactively rewrite an earlier leg's body.
  const requestLegs: unknown[] = [];
  const create = async (outputConfig: Record<string, unknown> | undefined = buildOutputConfig(true)) => {
    const body = {
      model,
      max_tokens: maxTokensSent,
      ...(sendTemp ? { temperature: temp } : {}),
      ...(systemParam !== undefined ? { system: systemParam } : {}),
      ...(thinking ? { thinking: { type: 'adaptive' } } : {}),
      ...(outputConfig ? { output_config: outputConfig } : {}),
      ...(tools.length ? { tools } : {}),
      messages,
    };
    requestLegs.push({ ...body, messages: [...messages] });
    // Document requests: one retry, not the SDK default two — each retry re-uploads the full
    // base64 payload (megabytes) and re-bills the parse.
    const stream = client.messages.stream(
      body as unknown as Anthropic.MessageStreamParams,
      { signal: req.signal, ...(hasDocument(req) ? { maxRetries: 1 } : {}) },
    );
    const inputBufs = new Map<number, string>();
    stream.on('streamEvent', (event: unknown) => {
      const e = event as { type?: string; index?: number; delta?: { type?: string; partial_json?: string } };
      if (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta' && typeof e.index === 'number') {
        inputBufs.set(e.index, (inputBufs.get(e.index) ?? '') + (e.delta.partial_json ?? ''));
      }
    });
    const msg = await stream.finalMessage();
    patchServerToolInputs(msg.content as Array<{ type: string; input?: unknown }>, inputBufs);
    return msg;
  };

  let resp: Awaited<ReturnType<typeof create>>;
  try {
    resp = await create();
  } catch (err) {
    // Never let schema enforcement take down a chat turn: on a 400 for a jsonBubbles request
    // (e.g. a model/schema-shape rejection), retry once WITHOUT the format — the persona's own
    // JSON contract still applies, and parseReply's passthrough remains the floor beneath that.
    // The retry ALSO drops effort: a jsonBubbles role that opts into reasoning effort (Convo/MM)
    // can land its Anthropic FALLBACK on a model that rejects output_config.effort (e.g. Haiku 4.5),
    // and effort is exactly as likely as the schema to be what 400'd — dropping both lets the fallback
    // degrade to a plain reply instead of erroring the whole turn.
    // Under toolsViaJson the retry deliberately does NOT re-attach native tools: the system prompt
    // still documents the full tool_calls protocol, so a prompt-only envelope carries the turn
    // (mixing native tools back in is the one way to double-dispatch the same action).
    if (req.jsonBubbles && (err as { status?: number })?.status === 400) {
      console.warn('[llm] output_config rejected on Anthropic — retrying without schema enforcement or effort (prompt-level JSON only)');
      // The turn survives, but it survives UNENFORCED (prompt-level JSON only) — a standing
      // model/schema misconfig otherwise leaves no trail beyond this line.
      reportError({
        source: 'llm', category: 'degraded', severity: 'warn',
        message: 'output_config rejected on Anthropic — degraded to prompt-only JSON',
        detail: { model, role: req.role },
        chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
      });
      resp = await create(buildOutputConfig(false, false));
    } else {
      throw err;
    }
  }
  const textParts: string[] = [];
  const serverTextParts: string[] = [];
  let toolCalls: LlmResult['toolCalls'] = [];
  // Accumulate usage across pause_turn continuations (web_search), each leg billed separately.
  const usage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  // Every wire response leg, verbatim — diagnostics-only (the /dashboard "raw" view).
  const rawLegs: unknown[] = [];

  for (let i = 0; ; i++) {
    rawLegs.push(resp);
    const u = resp.usage;
    if (u) {
      usage.inputTokens += u.input_tokens ?? 0;
      usage.outputTokens += u.output_tokens ?? 0;
      usage.cacheCreationInputTokens += u.cache_creation_input_tokens ?? 0;
      usage.cacheReadInputTokens += u.cache_read_input_tokens ?? 0;
    }
    const stepToolCalls: LlmResult['toolCalls'] = [];
    for (const block of resp.content) {
      if (block.type === 'text') textParts.push(block.text);
      else if (block.type === 'tool_use') {
        stepToolCalls.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
      }
      // server_tool_use / web_search_tool_result blocks are resolved server-side; ignore them here.
    }
    toolCalls = stepToolCalls;
    // Harvest server-side web_search results (titles/urls/cited snippets) from this leg's content —
    // they never arrive as a client tool_use, so Ops can only ground web-sourced facts if we surface
    // them (see serverToolText.ts). Accumulated across pause_turn legs.
    const legWeb = fromAnthropicContent(resp.content);
    if (legWeb) serverTextParts.push(legWeb);

    // Continue the same turn while the server tool (web_search) pauses, bounded.
    if ((resp.stop_reason as string) === 'pause_turn' && i < MAX_PAUSE_CONTINUATIONS) {
      messages.push({ role: 'assistant', content: resp.content as unknown as Anthropic.MessageParam['content'] });
      resp = await create();
      continue;
    }
    break;
  }

  const text = textParts.length ? textParts.join('\n') : null;
  // Reasoning starvation, the Anthropic twin of the OpenRouter guard below (isLengthStarved):
  // adaptive thinking / output_config.effort spend against max_tokens, so the whole budget can go
  // to reasoning and the reply arrive with stop_reason 'max_tokens' and NOTHING in it. Returned as
  // a normal result it reads as an "empty reply" and callers retry with identical params (starving
  // identically). Throw instead — statusless, so shouldFallback salvages the turn on the other
  // lane, and callLLM retries there with a BIGGER budget (bumpStarvedBudget).
  if (isTruncatedStop(resp.stop_reason) && !text?.trim() && !toolCalls.length) {
    throw starvedError('anthropic', model, maxTokensSent);
  }

  return {
    text,
    toolCalls,
    stopReason: resp.stop_reason ?? null,
    truncated: isTruncatedStop(resp.stop_reason),
    provider: 'anthropic',
    model,
    usage,
    serverToolText: serverTextParts.length ? serverTextParts.join('\n') : undefined,
    raw: rawLegs.length === 1 ? rawLegs[0] : rawLegs,
    rawRequest: requestLegs.length === 1 ? requestLegs[0] : requestLegs,
  };
}

// --- OpenAI-compatible lanes (openrouter + openai) ------------------------
// Request shaping lives in the pure, unit-tested ./openrouterRequest module: buildOpenRouterParams
// (openrouter.ai + proprietary extras) vs buildOpenAIParams (generic body, any OpenAI-compatible
// base URL). Here we only make the call + parse the reply. Both lanes are the same OpenAI SDK.

/** The one SDK method these lanes use. Injectable into callOpenAICompatible ONLY so the starvation
 *  policy (does it retry, with which cap, with reasoning off) is unit-testable against a fake
 *  provider — no key, no network. Production callers pass nothing. */
export type ChatSender = (
  params: OpenRouterParams,
  opts: { signal?: AbortSignal; maxRetries?: number },
) => Promise<OpenAI.Chat.Completions.ChatCompletion>;

/** The streaming twin of ChatSender, used when the request sets onTextDelta. Injectable for the same
 *  reason (tests hand in a fake chunk sequence); production callers pass nothing and get the SDK's
 *  own stream. The body arrives already in its streamed form (toStreamingParams). */
export type StreamSender = (
  params: StreamingParams,
  opts: { signal?: AbortSignal; maxRetries?: number },
) => AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

/** One streamed leg, read to its end. `error` is set only when the stream broke AFTER emitting (a
 *  break before the first delta is rethrown, so it reaches the retry and fallback policy exactly as
 *  a non-streamed failure would). */
interface StreamedLeg {
  resp: OpenAI.Chat.Completions.ChatCompletion;
  emitted: boolean;
  error?: unknown;
}

/** The wire fields the SDK's chunk type doesn't declare: OpenRouter's upstream `provider` name on
 *  every chunk, and the reasoning / citation deltas it and deepseek-style endpoints stream. */
type ChunkExtras = { provider?: string };
type DeltaExtras = {
  reasoning?: string | null;
  reasoning_content?: string | null;
  reasoning_details?: unknown[];
  annotations?: unknown[];
};

/**
 * Read a completion stream back into the ChatCompletion a non-streamed call would have returned, so
 * everything after the send (the starvation check, the tool-call parse, the usage builder, the raw
 * trace) runs on one shape and cannot drift between the two paths.
 *
 * Only `delta.content` is text: it is accumulated AND forwarded, one call per non-empty delta.
 * Reasoning deltas (`reasoning` / `reasoning_content` / `reasoning_details`) are chain-of-thought,
 * never reply, so they never reach the sink and never enter the text; they are kept on the
 * synthesized message under the names the non-streamed OpenRouter body uses, so the raw trace reads
 * the same either way. Usage arrives on the final chunk (include_usage, with `choices: []`) and is
 * copied through verbatim, so prompt_tokens_details.cached_tokens and
 * completion_tokens_details.reasoning_tokens — what the ledger and the latency benchmark read — are
 * exactly the provider's. A stream cut short never sends that chunk, so its usage stays undefined.
 *
 * A stream that merely STOPS is treated as broken, never as finished. The SDK's iterator swallows
 * an abort (openai core/streaming.js returns quietly on isAbortError), so a caller's cancel or the
 * wall-clock abort ends the loop exactly like a clean end — and a connection the provider closes
 * early ends it the same way. Neither carries a finish_reason, so: the loop ending with the signal
 * aborted, or with no finish_reason ever seen, or a chunk carrying an `error` body, all throw INSIDE
 * the try and take the same before/after-emission rule as a transport throw.
 */
async function readStream(
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  onTextDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<StreamedLeg> {
  let text = '';
  let reasoning = '';
  const reasoningDetails: unknown[] = [];
  const annotations: unknown[] = [];
  const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[] = [];
  let finish: string | null = null;
  let usage: OpenAI.Completions.CompletionUsage | undefined;
  let id = '';
  let created = 0;
  let model = '';
  let upstream: string | undefined;
  let emitted = false;
  let error: unknown;
  try {
    for await (const ch of stream) {
      // OpenRouter reports a mid-stream provider failure as a chunk with an `error` body (the SDK
      // throws on most of these itself; this catches the ones it lets through).
      const chunkErr = (ch as { error?: { message?: string } | string }).error;
      if (chunkErr) {
        throw new Error(`stream error chunk: ${typeof chunkErr === 'string' ? chunkErr : chunkErr.message ?? JSON.stringify(chunkErr)}`);
      }
      id ||= ch.id ?? '';
      created ||= ch.created ?? 0;
      model ||= ch.model ?? '';
      upstream ??= (ch as ChunkExtras).provider;
      if (ch.usage) usage = ch.usage;
      const c = ch.choices?.[0];
      if (!c) continue;
      if (c.finish_reason) finish = c.finish_reason;
      const d = c.delta as (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & DeltaExtras) | undefined;
      if (!d) continue;
      if (typeof d.reasoning === 'string') reasoning += d.reasoning;
      else if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
      if (Array.isArray(d.reasoning_details)) reasoningDetails.push(...d.reasoning_details);
      if (Array.isArray(d.annotations)) annotations.push(...d.annotations);
      // Native tool calls stream as fragments keyed by index: the id and name once, the arguments
      // JSON in pieces. The written-tool-call roles (toolsViaJson) never use these; they are here so
      // the result shape really is the non-streamed one for any caller.
      for (const tc of d.tool_calls ?? []) {
        const slot = (toolCalls[tc.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name = tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
      if (d.content) {
        text += d.content;
        emitted = true;
        onTextDelta(d.content);
      }
    }
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('stream aborted before it finished');
    }
    if (finish === null) throw new Error('stream ended without a finish_reason (cut off mid-reply)');
  } catch (err) {
    // Nothing went out yet: this is an ordinary failed call, and the lane policy above it (starved
    // retry, cross-lane fallback) still owns it. Once something went out it is not: see
    // LlmResult.emitted.
    if (!emitted) throw err;
    error = err;
  }
  const calls = toolCalls.filter(Boolean);
  const message = {
    role: 'assistant' as const,
    content: text || null,
    refusal: null,
    ...(calls.length ? { tool_calls: calls } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(reasoningDetails.length ? { reasoning_details: reasoningDetails } : {}),
    ...(annotations.length ? { annotations } : {}),
  };
  const resp = {
    id, object: 'chat.completion', created, model,
    ...(upstream ? { provider: upstream } : {}),
    choices: [{ index: 0, message, finish_reason: finish, logprobs: null }],
    ...(usage ? { usage } : {}),
  } as unknown as OpenAI.Chat.Completions.ChatCompletion;
  return { resp, emitted, ...(error !== undefined ? { error } : {}) };
}

export async function callOpenAICompatible(
  req: LlmRequest,
  provider: 'openrouter' | 'openai',
  sendOverride?: ChatSender,
  streamOverride?: StreamSender,
): Promise<LlmResult> {
  const onTextDelta = req.onTextDelta;
  let send = sendOverride;
  let stream = streamOverride;
  if (!send || (onTextDelta && !stream)) {
    const client = provider === 'openrouter' ? openrouterClient() : openaiClient();
    if (!client) throw laneUnconfiguredError(provider);
    send ??= (p, o) => client.chat.completions.create(p, o);
    stream ??= async function* (p, o) { yield* await client.chat.completions.create(p, o); };
  }
  const sendPlain = send;
  const sendStream = stream;
  // Inline remote media as base64 first — providers (esp. Google/Gemini) can't reliably fetch remote
  // image/audio/video URLs, and messaging-CDN links are often not publicly retrievable. Each inliner
  // only touches its own block types, so the order is irrelevant.
  const prepared = await inlineMediaBlocks(await inlineImageBlocks(req));
  /** This request's body. `maxTokens`/`disableReasoning` are the starved retry's two changes; the
   *  rest of the body is rebuilt identically, so nothing else about the call drifts between legs.
   *  The return is a UNION, not the OpenRouter type: the generic lane's body genuinely has no
   *  `reasoning`/`provider`/`plugins`, and casting it up would let a later read of those fields
   *  typecheck on an openai-lane request. Everything used below (`model`, `max_tokens`, and the
   *  send itself, which takes the wider type) is common to both. */
  const build = (
    opts?: { maxTokens?: number; disableReasoning?: boolean },
  ): OpenRouterParams | OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming => {
    const r = opts?.maxTokens !== undefined ? { ...prepared, maxTokens: opts.maxTokens } : prepared;
    return provider === 'openrouter'
      ? buildOpenRouterParams(r, { disableReasoning: opts?.disableReasoning })
      : buildOpenAIParams(r);
  };
  let params = build();
  const model = params.model;
  /** The cap that actually produced the reply, set ONLY when the starved retry lands. callLLM
   *  derives max_tokens_sent for the ledger and the llm:truncated trail from the REQUEST, so
   *  without this a landed retry writes a row describing a call that never happened
   *  (output_tokens from the 600-token leg against max_tokens_sent=200). */
  let servedMaxTokens: number | undefined;

  // signal: cancel the in-flight HTTP request, not just the loop around it (see LlmRequest.signal).
  // Document requests get one retry, not the default two — a retry re-uploads the full base64 body.
  const sendOpts = { signal: req.signal, ...(hasDocument(req) ? { maxRetries: 1 } : {}) };
  /** One leg of the call, streamed when the caller asked for deltas. `body` is what actually went on
   *  the wire (the streamed form differs from `params`), which is what rawRequest must show. */
  const sendLeg = async (
    p: typeof params,
  ): Promise<{ resp: OpenAI.Chat.Completions.ChatCompletion; body: unknown; emitted: boolean; error?: unknown }> => {
    if (!onTextDelta || !sendStream) return { resp: await sendPlain(p, sendOpts), body: p, emitted: false };
    const body = toStreamingParams(p);
    return { ...(await readStream(sendStream(body, sendOpts), onTextDelta, sendOpts.signal)), body };
  };
  const first = await sendLeg(params);
  let resp = first.resp;
  let sentBody = first.body;
  /** Whether any delta reached the caller, and the break that ended a stream after one did. */
  let emitted = first.emitted;
  let streamError = first.error;
  let choice = resp.choices[0];
  /** The STARVED leg's usage, kept when a retry replaces `resp`: that leg still consumed a prompt
   *  and burned its whole completion cap on reasoning, and both are billed. Folded into the returned
   *  usage below so reportTaskUsage (task budget enforcement) and the ledger see the real spend. */
  let starvedUsage: typeof resp.usage;

  // Reasoning starvation: the whole max_tokens budget went to chain-of-thought and the reply carries
  // no content/tool call at all. An identical retry starves identically, so it gets ONE same-lane
  // retry with a real budget (starvedRetryCap: 3x, floored at 600) and reasoning switched off — the
  // two things that were wrong. This is the live classify-lane failure: a 200-token climate eval on
  // an inherited deepseek-v4 spent the whole cap thinking, so the relationship climate never moved.
  // Cheaper and more faithful than the cross-lane salvage below it: same model, same prompt, just
  // room to answer. Flag LLM_STARVED_RETRY; off → straight to the throw, as before.
  // Never after emission: text the caller already holds cannot be re-asked. (A leg that emitted has
  // content, so it cannot read as starved either — the guard says it rather than relying on that.)
  if (!emitted && isLengthStarved(choice) && starvedRetryEnabled()) {
    const cap = params.max_tokens ?? MAX_TOKENS[req.role];
    const retriedCap = starvedRetryCap(cap);
    let ok = false;
    let error: string | undefined;
    let retryErr: unknown;
    let starvedCap = cap;
    try {
      const retryParams = build({ maxTokens: retriedCap, disableReasoning: true });
      const retryLeg = await sendLeg(retryParams);
      const retryResp = retryLeg.resp;
      const retryChoice = retryResp.choices[0];
      // A retry leg that streamed and then broke still had content, so it counts as landed: its
      // partial is served (with its break) rather than swapped for a starvation throw.
      ok = !isLengthStarved(retryChoice);
      if (ok) {
        starvedUsage = resp.usage;
        resp = retryResp; choice = retryChoice; params = retryParams; servedMaxTokens = retriedCap;
        sentBody = retryLeg.body; emitted = retryLeg.emitted; streamError = retryLeg.error;
      }
      else starvedCap = retriedCap;   // the budget that actually failed last
    } catch (err) {
      // A 3x cap can exceed what a provider accepts, and a retry can hit any transport failure. Keep
      // the ORIGINAL starvation error as the one that surfaces: it is statusless and marked, which is
      // what makes callLLM's cross-lane salvage (with bumpStarvedBudget) still run. The cause is not
      // lost — it rides on the receipt below.
      retryErr = err;
      error = String((err as Error)?.message ?? err).slice(0, 300);
    }
    // Fires on EVERY starvation, retry landed or not — a starving lane is a pattern, and `ok: false`
    // twice in a row is what says the cap was never the whole story.
    record({
      type: 'event', label: 'llm:starved_retry', role: req.role,
      chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
      detail: { role: req.role, model, cap, retriedCap, ok, ...(error ? { error } : {}) },
    });
    // A cancelled retry surfaces as the cancellation it is. callLLM checks the signal rather than
    // the error, so the abort is honoured either way — but dressing it up as starvation would put a
    // starvation line in the error log for a turn the caller simply walked away from.
    if (retryErr !== undefined && req.signal?.aborted) throw retryErr;
    if (!ok) throw starvedError(provider, model, starvedCap);
  }
  // The unretried throw (flag off), and the shape callers have always seen: a status-less error is
  // retryable per shouldFallback, so callLLM salvages the turn on a fallback lane, and the message
  // lands in traces via the ERROR record path. starvedError also MARKS the error, which is how
  // callLLM knows to retry with a BIGGER budget rather than re-sending the same cap to a second
  // model that would starve on it too.
  if (isLengthStarved(choice)) {
    throw starvedError(provider, model, params.max_tokens ?? MAX_TOKENS[req.role]);
  }
  const toolCalls: LlmResult['toolCalls'] = [];
  // A stream that broke after emitting: the reply is served as far as it got (stopReason 'error',
  // below), and the break gets its own receipt, since nothing throws to leave the usual error trail.
  // Half-streamed native tool calls are dropped — arguments cut mid-JSON are not a call.
  const broken = streamError !== undefined;
  if (broken) {
    record({
      type: 'event', label: 'llm:stream_error', role: req.role,
      chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
      detail: {
        role: req.role, provider, model, chars: choice.message.content?.length ?? 0,
        error: String((streamError as Error)?.message ?? streamError).slice(0, 300),
      },
    });
  }
  for (const tc of broken ? [] : choice.message.tool_calls ?? []) {
    if (tc.type === 'function') {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore malformed */ }
      toolCalls.push({ id: tc.id, name: tc.function.name, input });
    }
  }
  const u = resp.usage;
  // BOTH legs when a starved retry landed: the leg that starved is billed too (its prompt, plus the
  // completion cap it spent on reasoning), and this usage is the only accounting path — it feeds
  // reportTaskUsage's budget enforcement and the token_usage row. Undefined stays undefined when
  // NEITHER leg reported usage, so a silent provider still writes no phantom zeros.
  // The one consequence: on that path output_tokens is the SUM across two legs, so it can exceed
  // max_tokens_sent (the SERVED cap) — `truncated`/stop_reason, not the output==cap equality, is
  // what identifies a reply that hit its ceiling there.
  const cachedOf = (x?: typeof u) =>
    ((x as { prompt_tokens_details?: { cached_tokens?: number } } | undefined)?.prompt_tokens_details?.cached_tokens) ?? 0;
  const cached = cachedOf(u) + cachedOf(starvedUsage);
  const usage = u || starvedUsage
    ? {
      // Cache reads are billed (and fed to budget enforcement) separately from fresh input, the way
      // the Anthropic lane already reports them — so input here is the UNCACHED remainder and the
      // row's generated total_tokens still sums to what the provider counted.
      inputTokens: (u?.prompt_tokens ?? 0) + (starvedUsage?.prompt_tokens ?? 0) - cached,
      outputTokens: (u?.completion_tokens ?? 0) + (starvedUsage?.completion_tokens ?? 0),
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: cached,
    }
    : undefined;
  // Server-tool text is an OpenRouter concept; a generic OpenAI endpoint returns none, so this is a
  // harmless no-op on the openai lane.
  const serverToolText = fromOpenRouterMessage(choice.message);
  return {
    text: choice.message.content || null,
    toolCalls,
    stopReason: broken ? 'error' : choice.finish_reason ?? null,
    truncated: !broken && isTruncatedStop(choice.finish_reason),
    provider,
    model,
    usage,
    ...(servedMaxTokens !== undefined ? { servedMaxTokens } : {}),
    serverToolText: serverToolText || undefined,
    // On a streamed call this is the ChatCompletion readStream synthesized from the chunks.
    raw: resp,
    // The body that produced `resp`: build() makes fresh objects, the starved retry reassigns
    // sentBody with its leg, and a streamed leg records its streamed form — so this always pairs
    // with the `raw` response leg above.
    rawRequest: sentBody,
    ...(onTextDelta ? { emitted } : {}),
  };
}

function runOn(provider: LlmProvider, req: LlmRequest): Promise<LlmResult> {
  if (provider === 'anthropic') return callAnthropic(req);
  return callOpenAICompatible(req, provider);
}

/** The VOICE roles: every call that sits on a live turn — Convo, the composer (which runs on the
 *  convo role), the classify lane and Fallfirm. `ops` is deliberately absent: a deep-work role call
 *  is a research run bounded by the orchestrator's own per-leg deadline (agents/orchestrator.ts),
 *  and a conversational window would cut it in half. */
const VOICE_ROLES: ReadonlySet<LlmRole> = new Set<LlmRole>(['convo', 'classify', 'fallfirm']);

/** A voice call that never came back. Deliberately shaped like the transient provider failures
 *  fallbackPolicy already salvages — statusless, and nothing an abort sniff would catch — so the
 *  other lane gets its own window, and when that fails too the throw reaches the caller, where the
 *  Fallfirm floor voices it. */
function laneTimeoutError(provider: LlmProvider, model: string, ms: number): Error {
  return new Error(`${provider} call timed out after ${ms}ms (model=${model}) — nothing came back inside the per-call limit`);
}

/**
 * One lane dispatch under a hard wall clock (LLM_CALL_TIMEOUT_MS, 120s by default).
 *
 * Why a RACE and not just an abort: the found hang was a local Convo call sitting on the OpenRouter
 * lane for ~25 minutes (`agent: 1516078ms`) — the SDK's own 600s timeout times its retries, with
 * nothing above it. An abort alone trusts the lane to reject when asked; the race is what guarantees
 * the TURN comes back, whether or not anything downstream honours the signal. Both happen: the
 * controller fires first (a real socket is released, not abandoned), then the race rejects.
 *
 * The timer is deliberately NOT unref'd, for the reason engineBackend.ts's queue wait gives: an
 * unref'd timer is skipped exactly when the loop has nothing else holding it, which is precisely the
 * hang this exists to end. It is cleared on every path, so it holds the loop at most one window and
 * only while a call is genuinely in flight.
 *
 * A STREAMED call (req.onTextDelta) that already emitted when the window closes does not reject:
 * the text the caller holds is handed back as the result (stopReason 'error', emitted: true), the
 * same as a stream that broke mid-reply (see LlmResult.emitted). Rejecting would send the turn to
 * the other lane for a second reply to a message whose first one is already going out. The tally
 * is kept HERE, from the deltas themselves, because the lane is exactly what stopped answering —
 * and deltas a lane delivers after the race settled are dropped, so the caller never receives text
 * that is not in the result it was handed.
 *
 * Off (or a non-voice role) → `run` is called with the caller's own request object, untouched.
 */
async function runWithCallTimeout(run: LaneRunner, provider: LlmProvider, req: LlmRequest): Promise<LlmResult> {
  const ms = VOICE_ROLES.has(req.role) ? llmCallTimeoutMs() : null;
  if (ms === null) return run(provider, req);
  const ctl = new AbortController();
  const signal = req.signal ? AbortSignal.any([req.signal, ctl.signal]) : ctl.signal;
  const sink = req.onTextDelta;
  let streamed = '';
  let emitted = false;
  let settled = false;
  const onTextDelta = sink
    ? (delta: string) => {
      if (settled) return;
      emitted = true;
      streamed += delta;
      sink(delta);
    }
    : undefined;
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<LlmResult>((resolve, reject) => {
    timer = setTimeout(() => {
      const model = req.modelOverride || MODELS[req.role][provider];
      // Release the socket, hand the turn back, THEN write the receipt — in that order, so nothing
      // that could go wrong on the diagnostics side can leave the turn hanging, which is the whole
      // failure this function exists to end.
      ctl.abort();
      settled = true;
      if (emitted) {
        // Deliberately NO `raw` and NO `usage`: the lane that stopped answering never sent its final
        // chunk, so there is nothing true to put there. Readers of those fields — the token ledger
        // (writes zeros) and the latency benchmark (reads raw.usage.* and raw.provider off traces) —
        // see a call with no provider numbers, which is what this was.
        resolve({
          text: streamed, toolCalls: [], stopReason: 'error', truncated: false,
          provider, model, emitted: true,
        });
      } else {
        reject(laneTimeoutError(provider, model, ms));
      }
      record({
        type: 'event', label: 'llm:timeout', role: req.role,
        chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
        detail: { role: req.role, model, ms, ...(emitted ? { emitted: true, chars: streamed.length } : {}) },
      });
    }, ms);
  });
  const call = run(provider, { ...req, signal, ...(onTextDelta ? { onTextDelta } : {}) });
  // The race's loser must never surface as an unhandled rejection: that is FATAL in this process
  // (diagnostics/errorLog.ts exits(1) on one), so a lane that rejects late — with its abort error,
  // after we already gave up — would take the whole VM down with it.
  call.catch(() => { /* the race already settled this call */ });
  try {
    return await Promise.race([call, expiry]);
  } finally {
    settled = true;
    clearTimeout(timer);
  }
}

/** Which lane actually runs a request. Injectable into callLLM ONLY so the lane policy (is the
 *  fallback attempted, which error surfaces) is unit-testable without touching a provider —
 *  production callers pass nothing. */
type LaneRunner = (provider: LlmProvider, req: LlmRequest) => Promise<LlmResult>;

/** A failed call must leave ALL THREE trails: an ERROR trace event (with the provider that
 *  failed — the dashboard renders it), a status='error' row in the durable ledger, and an
 *  error_log row (the cross-agent view, where a dead lane or a starving cap reads as a pattern
 *  instead of one row per role). `req` is the request as SENT — the starved-fallback leg passes
 *  its bumped copy, so maxTokensSent reports the budget that actually failed. */
function recordLlmError(req: LlmRequest, provider: LlmProvider, err: unknown, start: number): void {
  const message = String((err as Error)?.message ?? err);
  const model = req.modelOverride || MODELS[req.role][provider];
  const maxTokensSent = req.maxTokens ?? MAX_TOKENS[req.role];
  record({
    type: 'llm', role: req.role, label: req.trace?.label,
    chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
    provider, model,
    system: req.system, messages: req.messages, response: `ERROR: ${message}`,
    latencyMs: Date.now() - start,
  });
  // The caller cancelled it (a reply replaced by a newer text, an engine stop): not a failure, so no
  // error report, and the ledger keeps it apart from the calls whose latency and errors it measures.
  const cancelled = !!req.signal?.aborted;
  // trace:false — the ERROR llm record above is already this turn's error event; a mirror here
  // would double-count it in error_count.
  if (!cancelled) reportError({
    source: req.role, category: 'llm_error', err,
    chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
    detail: { provider, model, label: req.trace?.label, maxTokensSent },
    trace: false,
  });
  void recordTokenUsage({
    handle: req.trace?.handle, chatId: req.trace?.chatId, taskId: req.trace?.taskId,
    role: req.role, label: req.trace?.label,
    provider, model,
    latencyMs: Date.now() - start, status: cancelled ? 'aborted' : 'error', error: message,
    maxTokensSent,
  }).catch(() => { /* swallow: never surface analytics failures */ });
}

// Preferred fallback lane order per primary — the FIRST CONFIGURED one is used (a single fallback
// attempt, as before; now selected from three lanes instead of the old binary flip). Anthropic leads
// the OpenAI-compatible lanes' lists because it is first-party billing with hand-picked same-tier
// slugs — the only safe salvage target for the 402/bad-model exceptions in fallbackPolicy.
const FALLBACK_ORDER: Record<LlmProvider, readonly LlmProvider[]> = {
  openrouter: ['anthropic', 'openai'],
  openai: ['anthropic', 'openrouter'],
  anthropic: ['openrouter', 'openai'],
};

/**
 * Single entry point used by every agent. Each role has a PRIMARY provider (its <ROLE>_PROVIDER,
 * default Anthropic); on a transient failure it falls back to the first CONFIGURED other lane
 * (FALLBACK_ORDER). Usable means CONFIGURED — a lane whose key is unset or blank is never attempted,
 * on either side (see laneKeys.ts; no provider is "always available", not even Anthropic).
 * `run` is the lane dispatcher, injectable for unit tests only — production callers pass nothing.
 */
export async function callLLM(req: LlmRequest, run: LaneRunner = runOn): Promise<LlmResult> {
  const start = Date.now();
  const primary: LlmProvider = req.providerOverride ?? PROVIDERS[req.role];
  const fallback: LlmProvider | undefined = FALLBACK_ORDER[primary].find(p => isLaneConfigured(p));
  // No lane at all for this role: fail fast, before the budget gate and before any dispatch, with
  // both env vars named. Config precedes cost — and dispatching either lane could only produce an
  // SDK auth error from deep inside a request, which reads as provider trouble rather than as the
  // missing key it is.
  if (!isLaneConfigured(primary) && !fallback) {
    const err = noLaneConfiguredError(req.role);
    recordLlmError(req, primary, err, start);
    throw err;
  }
  // The cap sent to the PRIMARY lane, and (separately) the cap that actually produced the result —
  // they differ when a starved primary fell back on a bumped budget, and when the lane itself took
  // its own same-lane starved retry (LlmResult.servedMaxTokens, folded in after the run below). The
  // ledger records the served one, so "output_tokens == max_tokens_sent" stays a reliable
  // truncation signature.
  const maxTokensSent = req.maxTokens ?? MAX_TOKENS[req.role];
  let servedMaxTokens = maxTokensSent;
  // Budget gates run BEFORE any provider dispatch. BudgetExceededError is nonFallbackable (see
  // fallbackPolicy) — a tripped breaker must fail loud, never re-bill on the other lane. Recorded
  // like any failed call so the trip is visible in traces + the ledger.
  try {
    await checkCallBudgets(req);
  } catch (err) {
    recordLlmError(req, primary, err, start);
    throw err;
  }
  // Cross-provider fallback would re-parse any PDF with the OTHER provider's engine (Anthropic
  // native vision vs OpenRouter's file-parser/OCR). Document extraction persists the parsed facts
  // (dates/parties/amounts), so a silent engine swap on a transient blip could write subtly-wrong
  // data as status:'ok'. For document requests we therefore do NOT fall back by default — a clean
  // failure (the caller degrades gracefully) beats durably-wrong data. Callers whose output is
  // conversational (MM) may opt in via allowDocumentFallback — a slightly different PDF parse beats
  // no answer when the result isn't persisted as facts. Non-document requests unaffected.
  // Also never fall back when the request carries native audio/video: the MM route runs
  // primary=openrouter, and Anthropic can't take audio/video — a fallback would silently drop the
  // media (wrong answer) or 400. A clean failure (the caller degrades) is better.
  // 'unconfigured' is the third reason and the only one that logs: the lane has no key, so
  // attempting it can produce nothing but an auth error (see the skip branch below).
  const fallbackBlocked: 'document' | 'media' | 'unconfigured' | null =
    hasDocument(req) && !req.allowDocumentFallback ? 'document'
      : hasNativeMedia(req) ? 'media'
        : !fallback ? 'unconfigured'
          : null;

  // Whether any streamed delta reached the caller on the primary leg. The lanes already RETURN
  // rather than throw once they emitted (LlmResult.emitted), so this is the belt under that: a
  // failure that still escapes after emission must never re-run the turn on another lane, which
  // would hand the caller a second, different reply on top of the one already going out.
  let deltasOut = false;
  const sink = req.onTextDelta;
  const primaryReq: LlmRequest = sink
    ? { ...req, onTextDelta: (delta: string) => { deltasOut = true; sink(delta); } }
    : req;

  let result: LlmResult;
  let fellBack = false;
  try {
    result = await runWithCallTimeout(run, primary, primaryReq);
  } catch (err) {
    // The caller's own signal is the authoritative abort check — SDK abort errors are unreliable
    // to sniff (Anthropic's APIUserAbortError never sets .name, so it reads as a generic Error).
    // A cancelled call must never re-bill on the other lane.
    if (req.signal?.aborted) {
      recordLlmError(req, primary, err, start);
      throw err;
    }
    if (!fallbackBlocked && !deltasOut && fallback && shouldFallback(err, fallback)) {
      const status = (err as { status?: number })?.status ?? 'network';
      console.warn(`[llm] ${primary} call failed (${status}), falling back to ${fallback}`);
      // A starved primary must NOT be retried on the same budget: the whole cap went to reasoning,
      // and the other lane's model would spend it the same way. Double it (floored 1024, clamped to
      // the role ceiling) so the retry has room for actual content. Only the tiny per-call caps
      // really grow — a call already at its ceiling gets the same number back.
      const starved = isStarvedError(err);
      const retryMaxTokens = starved ? bumpStarvedBudget(maxTokensSent, MAX_TOKENS[req.role]) : undefined;
      const fbReq = retryMaxTokens !== undefined ? { ...req, maxTokens: retryMaxTokens } : req;
      // Make the lane switch visible: it shows in the orchestration graph and feeds
      // the health overview's fallback counter (console.warn alone hid every one).
      record({
        type: 'event', label: 'llm:fallback', role: req.role,
        chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
        detail: {
          from: primary, to: fallback,
          status,
          message: String((err as Error)?.message ?? err).slice(0, 300),
          ...(starved ? { reason: 'length_starved', maxTokensSent, retryMaxTokens } : {}),
        },
      });
      // Durable trail for EVERY lane switch, not just starvation: a lane that keeps failing is a
      // provider-health pattern, and the trace ring loses it on restart. No token_usage row for the
      // failed primary — status='error' there would double-count the call in llm_role_stats, which
      // already counts the (successful) fallback row. trace:false: the event above is the trail.
      reportError({
        source: req.role, category: 'llm_fallback', severity: 'warn',
        message: `${primary} lane failed (${status}) — falling back to ${fallback}`,
        detail: {
          from: primary, to: fallback, status,
          reason: starved ? 'length_starved' : 'transient',
          ...(starved ? { maxTokensSent, retryMaxTokens } : {}),
        },
        chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
        trace: false,
      });
      try {
        result = await runWithCallTimeout(run, fallback, fbReq);
        fellBack = true;
        if (retryMaxTokens !== undefined) servedMaxTokens = retryMaxTokens;
      } catch (fbErr) {
        // The fallback lane failing was previously recorded NOWHERE — leave both trails. fbReq, not
        // req: the bumped budget is what this leg actually sent.
        recordLlmError(fbReq, fallback, fbErr, start);
        throw fbErr;
      }
    } else {
      // No configured fallback lane, but the failure WOULD have salvaged — the single-key setup,
      // where one lane serves everything and the others sit blank in .env. It used to be attempted
      // anyway, and the SDK's "Could not resolve authentication method" from that leg replaced THIS
      // error — the one carrying the status the floor acts on. One warn line (trace:false —
      // recordLlmError below is this turn's error event) so a permanently keyless fallback still
      // reads as a pattern in the error log. Judged against the PREFERRED lane, even though it is
      // unconfigured, so the directional 402/bad-model salvage still gates the message correctly.
      const preferred = FALLBACK_ORDER[primary][0];
      if (fallbackBlocked === 'unconfigured' && shouldFallback(err, preferred)) {
        const status = (err as { status?: number })?.status ?? 'network';
        const missing = FALLBACK_ORDER[primary].map(laneEnvVar).join(' or ');
        reportError({
          source: req.role, category: 'llm_fallback', severity: 'warn',
          message: `${primary} lane failed (${status}) — no fallback lane configured (set ${missing})`,
          detail: { from: primary, to: null, status, reason: 'fallback_unconfigured', missing },
          chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
          trace: false,
        });
      }
      recordLlmError(req, primary, err, start);
      throw err;
    }
  }
  // A lane that raised its own cap mid-call (the starved retry) reports the budget that actually
  // answered. It wins over the cross-lane bump above: if the fallback leg ALSO retried in-lane, its
  // retried cap is the last one sent, and this runs after both.
  if (result.servedMaxTokens !== undefined) servedMaxTokens = result.servedMaxTokens;
  // toolsViaJson: the model WROTE its tool calls into the JSON envelope — parse them back into
  // result.toolCalls here, BEFORE record(), so tracing/the dashboard see them exactly like native
  // calls and every caller dispatches identically. Dedupe against any native calls (belt-and-braces:
  // a misconfig or a provider that tool-called anyway must not double-dispatch one action).
  // NOT from a broken partial (a stream that emitted, then broke or timed out): its envelope is cut
  // mid-JSON, and parseReply's repair tiers would happily close a half-written tool_calls entry into
  // an action nobody finished asking for. Same rule as the lane's native calls on that path.
  const brokenPartial = result.emitted === true && result.stopReason === 'error';
  if (req.toolsViaJson && !brokenPartial) {
    const envCalls = parseReply(result.text).toolCalls ?? [];
    if (envCalls.length) {
      const seen = new Set(result.toolCalls.map(t => `${t.name} ${JSON.stringify(t.input)}`));
      for (const c of envCalls) {
        const key = `${c.name} ${JSON.stringify(c.input)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.toolCalls.push({ name: c.name, input: c.input });
      }
    }
  }
  // Feed the task's budget (if one is registered for this taskId) — the single accounting path
  // that sees loop steps AND tool-internal calls alike.
  reportTaskUsage(req.trace?.taskId, result.usage);
  record({
    type: 'llm', role: req.role, label: req.trace?.label,
    chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
    provider: result.provider, model: result.model,
    system: req.system, messages: req.messages,
    response: result.text, toolCalls: result.toolCalls.map(t => ({ name: t.name, input: t.input })),
    raw: result.raw, rawRequest: result.rawRequest,
    latencyMs: Date.now() - start,
  });
  // The ONE seam where truncation-with-content is visible: the starvation guards above only catch
  // the empty case, and a reply that got cut off mid-sentence throws nothing at all — it just
  // returns short, so half-written dossiers persist and Judge verdicts lose their tool call. Every
  // lane and both fallback outcomes pass through here, so one report covers them; callers that must
  // fail CLOSED on a partial answer read result.truncated themselves.
  if (result.truncated) {
    const truncDetail = {
      provider: result.provider, model: result.model, stopReason: result.stopReason,
      maxTokensSent: servedMaxTokens,
      outputTokens: result.usage?.outputTokens ?? null,
      hasText: !!result.text?.trim(), toolCalls: result.toolCalls.length,
      ...(fellBack ? { fallbackFrom: primary } : {}),
    };
    record({
      type: 'event', label: 'llm:truncated', role: req.role,
      chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
      detail: truncDetail,
    });
    reportError({
      source: req.role, category: 'truncation', severity: 'warn',
      message: `${result.model} cut off at the completion cap (stop_reason=${result.stopReason}, `
        + `output=${result.usage?.outputTokens ?? '?'}/${servedMaxTokens})`,
      detail: truncDetail,
      chatId: req.trace?.chatId, handle: req.trace?.handle, taskId: req.trace?.taskId,
      trace: false,   // the llm:truncated event above is the trail
    });
  }
  // Persist the call in the durable ledger (per-call, bound to the channel identity via
  // trace.handle). Recorded even when the provider returned no usage (zeros) so call
  // counts stay complete. Fire-and-forget: analytics must never break a reply.
  void recordTokenUsage({
    handle: req.trace?.handle, chatId: req.trace?.chatId, taskId: req.trace?.taskId,
    role: req.role, label: req.trace?.label,
    provider: result.provider, model: result.model, usage: result.usage,
    latencyMs: Date.now() - start,
    fallbackFrom: fellBack ? primary : undefined,
    status: 'ok',
    // Truncated calls stay status='ok' (a third status would drop them from llm_role_stats /
    // llm_hourly, which count status in ('ok','error')) — the flag is how they're found.
    stopReason: result.stopReason ?? undefined,
    maxTokensSent: servedMaxTokens,
    truncated: result.truncated,
  }).catch(() => { /* swallow: never surface analytics failures */ });
  return result;
}

export type { LlmRequest, LlmResult } from './types.js';
