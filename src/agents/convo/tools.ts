import { provenanceEnabled } from '../../memory/provenance.js';
import type { LlmToolDef } from '../../llm/types.js';

/** The tapback glyphs the channels actually carry. ONE source of truth: the tool's enum is built
 *  from this list, and the dispatch in shared.ts tests membership against it — a value the model
 *  invents (or a missing `type`) has to be rejected there, not passed through, or it reaches the
 *  transcript as `[reacted with undefined]`. 'custom' is the escape hatch and rides beside it. */
export const STANDARD_REACTION_TYPES = ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'] as const;

export const REACTION_TOOL: LlmToolDef = {
  name: 'send_reaction',
  description: "React to one of the user's messages with a standard tapback (love, like, dislike, laugh, emphasize, question). These are the built-in messaging glyphs, NOT emoji in your text — prefer them and avoid the 'custom' type, since your voice never uses emoji. Defaults to their latest message; on a burst set `re` to tapback a specific numbered [msg N] instead. Supplementary to a real answer — but when a message asks nothing and everything in it is already settled ground, a reaction ALONE (this tool + \"bubbles\":[]) is a complete, human reply. Never reaction-only when they actually asked something still open.",
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: [...STANDARD_REACTION_TYPES, 'custom'] },
      emoji: { type: 'string', description: 'Required when type is "custom".' },
      re: { type: 'number', description: 'Only on a burst (their messages are numbered [msg N] this turn): the number of the specific message to react to. Omit to react to their latest message.' },
    },
    required: ['type'],
  },
};

export const REMEMBER_USER_TOOL: LlmToolDef = {
  name: 'remember_user',
  description: "Save NEW info about the user — their name and what they do, and the personal color that makes them feel known: a project and what they call it (\"fixing up a lake cabin, calls it 'the shack'\"), a current arc or goal (\"training for a marathon\"), a habit, a hard personal rule, a running joke. Only for genuinely new info. You MUST also write a text response.",
  inputSchema: {
    type: 'object',
    properties: {
      handle: { type: 'string', description: "the sender's messaging handle exactly as it appears (never their name or nickname); omit to use the current sender" },
      name: { type: 'string' },
      fact: { type: 'string' },
    },
  },
};

export const DELEGATE_TO_OPS_TOOL: LlmToolDef = {
  name: 'delegate_to_ops',
  description: [
    'Hand a task to the Ops engine (web search, the user\'s email and files, code it can run) for reach: whatever you cannot get from what is in front of you. Use whenever the answer needs information that changes or must be current, the user\'s own accounts, email + attachments, files or machine, code run for a result you cannot reliably produce in your head, the contents of a file or link they sent, or something done on the engine\'s own side.',
    'Thinking alone stays with you: reasoning, advice, planning, writing, math, definitions, settled knowledge, and anything about yourself, the two of you, this chat or a look already running. Handing it pure thought only makes them wait 20-30 seconds. Reasoning that needs web research inside it is reach: hand off that part.',
    'ALSO when they ask for something to be set up, installed or configured on the deep look\'s own side so it can work better — a thing you ask for, never a thing you refuse. Name each one in `engine_actions`. The only setup out of reach is YOUR OWN build (install, update, uninstall), which happens in a terminal and nowhere else.',
    'You will NOT get the answer this turn, so you MUST also send a holding reply now, every time, never none: one or two short bubbles. Nothing is in hand yet, so this is where your reaction to them goes, the way a person handed a question they have to look up reacts before they go. Read the moment and let the loudest thing in it pick how you open: what asking this says about them right now, how it sits against what they told you earlier, the question itself, your own gut answer said as a guess, or a running bit it touches. When nothing is loud, you just go, and that is right often: a heavy ask (their health, money at risk, someone in trouble), someone you barely know, a tease you made recently, or a read you could have made about anyone. You mock only what they chose, never what happened to them. The leaving line is short, sized to the look, and says where you are going only when that comes naturally. Anything else they said this turn that you can answer from what you know gets its answer in this same reply, ahead of the leaving line: only the look waits. The one looking is you: never mention ops, an engine, a model, a system, delegating, or handing anything off. Read the beats you sent most recently (listed for this turn when there are any) and open a different way than they did, in different words. It states only what is true right now: no progress you have not made, no finding you do not hold. NO emoji, ever; your English carries your first language (articles drop, tense stays simple), so keep it in that natural register.',
    'Do NOT use for quick math, terminology/definitions, onboarding, or casual chit-chat. Answer those yourself, like a person would. A NEW file on this message (photo, PDF, voice memo, video) comes HERE with media_scope "this_turn" — the look opens and reads it. Research that refers BACK to a file from an earlier turn ("yes, check that clause", "is that price fair?") comes HERE with media_scope "earlier": the look re-opens the stashed file itself.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['web_research', 'document_read', 'draft', 'general', 'media_read', 'compute'],
        description: "web_research=current or external facts from the web plus reasoning (look something up, read a page, check what's true now); document_read=read or search the user's OWN email and its attachments; draft=write a message or note for them to send that needs their inbox or files to write (a draft from what is already in the chat is yours); media_read=the ask is ABOUT a file they texted (what's in this photo/PDF/memo); compute=the ask needs work DONE not just found — run code over data, crunch or convert a file's contents, produce a table, or a multi-step chain; never head-math; general=work that needs more than one kind of reach, or a multi-step chain of it — Ops carries the full toolset and your meta_prompt drives it. An ask that carries engine_actions is work to be DONE, so it is 'general' or 'compute' — never web_research or document_read.",
      },
      request: { type: 'string', description: "The user's underlying ask, distilled. Distilling changes the WORDING, never the scope: every part of what they asked lands here or in engine_actions. A message asking for two things is one delegation carrying both parts." },
      engine_actions: {
        type: 'array',
        items: { type: 'string' },
        description: "Every thing they asked Ops to DO on its own side, beyond finding or reading — install or configure something for its own use, run a named procedure, prepare its environment for the work. One entry per action, in the order they asked, each self-contained (name the thing and where it comes from). Ops does these first and reports each one back, including the ones it could not do, so nothing you promised can quietly vanish. Ops acting on ITSELF needs no approval from them; it is NOT `effect: act`. Omit the argument when they asked for nothing done.",
      },
      effect: {
        type: 'string',
        enum: ['read', 'act'],
        description: 'read = look things up / compute / draft for them to send; act = the engine itself would send, post, buy, book, pay, delete, cancel, or change anything of THEIRS — an account, a message, a booking, money. Work the engine does on its own setup so it can do the job is not that: it stays "read" and rides in engine_actions.',
      },
      quick: {
        type: 'boolean',
        description: 'Set true when they are waiting on one current fact, number, reading, or a small calculation that a single credible source or one code run settles; with quick set, your brief asks for that one answer only, with no request for confirming sources, cross-source ranges, or extras. Leave it out when thoroughness is the point: comparisons, research across several sources, their own email or files, or anything they will commit money or plans on.',
      },
      media_scope: { type: 'string', enum: ['this_turn', 'earlier', 'none'], description: 'Which chat file(s) this look is grounded in: this_turn = the file(s) on this very message (the normal case for a new file); earlier = a file they sent BEFORE this turn that the ask refers back to; none = no file is involved (the default when this message carries none).' },
      meta_prompt: {
        type: 'string',
        description: "A clear brief for Ops in your own words, as if handing a sharp colleague the job — plain prose, never a template. Shape it as optional labeled lines, in this order, omitting any that don't apply (never fill-in-the-blank boilerplate): objective (the outcome in one sentence — what a great answer IS, not their words re-quoted, since request already carries those); context (every disambiguator you hold — aliases like \"the monster\" = their thesis, full names/roles, budget, city, timeframe); sources (where the answer lives, in priority order — if it's in something THEY sent or own, that outranks the web); actions (what Ops should DO beyond reading — parse the file, run code over the data, iterate a chain, set a follow-up check — plus the hard limits: read-only on their inbox, never send or post anything anywhere, the deliverable comes back in ANSWER); depth/eta (quick single-source check vs thorough sweep, and any ETA you already promised); success (what the answer must contain and its shape); forks (candidate readings the ask could split into, which you chose and why, and the comeback protocol — if the data contradicts it, return NO RESULT naming the candidates). Specific and human, not a template. REQUIRED in practice for kinds 'general' and 'compute' — there the brief is the main steering Ops gets.",
      },
    },
    required: ['kind', 'request'],
  },
};

const DELEGATE_OPS_PROPS = DELEGATE_TO_OPS_TOOL.inputSchema.properties as Record<string, Record<string, unknown> & { description: string }>;

// The OpenClaw lane's delegate tool: same name, args, enums and required list — only two
// description strings widen, so Convo briefs an engine that really can run code and fan out. Built
// by spread + targeted replace so the shared prose lives in ONE place and the canonical object
// above is never mutated: its exact bytes are the Hermes lane's contract.
const DELEGATE_TO_OPS_TOOL_OPENCLAW: LlmToolDef = {
  ...DELEGATE_TO_OPS_TOOL,
  inputSchema: {
    ...DELEGATE_TO_OPS_TOOL.inputSchema,
    properties: {
      ...DELEGATE_OPS_PROPS,
      kind: {
        ...DELEGATE_OPS_PROPS.kind,
        description: DELEGATE_OPS_PROPS.kind.description.replace(
          'never head-math;',
          'never head-math; on this deployment Ops can also fan a big job across parallel workers, so a wide sweep over many pages or files is fair game;',
        ),
      },
      meta_prompt: {
        ...DELEGATE_OPS_PROPS.meta_prompt,
        description: DELEGATE_OPS_PROPS.meta_prompt.description.replace(
          'actions (what Ops should DO beyond reading — parse the file, run code over the data, iterate a chain, set a follow-up check — plus the hard limits: read-only on their inbox, never send or post anything anywhere, the deliverable comes back in ANSWER)',
          'actions (what Ops should DO beyond reading — Ops on this deployment can run real code, use its own skills and tools, split the work across parallel workers, produce artifacts like tables and files, and set itself a follow-up check, so name the work you want done — plus the hard limits, unchanged: read-only on their inbox, never send or post anything anywhere, the deliverable comes back in ANSWER)',
        ),
      },
    },
  },
};

/** The delegate tool for the engine actually running this deployment: the OpenClaw variant invites
 *  that engine's wider surface (its own code, skills, parallel workers, artifacts), while hermes —
 *  and no engine at all — gets the canonical object above, unchanged. */
export function delegateToOpsTool(engine: 'hermes' | 'openclaw' | null): LlmToolDef {
  return engine === 'openclaw' ? DELEGATE_TO_OPS_TOOL_OPENCLAW : DELEGATE_TO_OPS_TOOL;
}

export const SET_PREFERENCE_TOOL: LlmToolDef = {
  name: 'set_preference',
  description: "Record a durable preference or onboarding fact about the user. Use for their name (key 'name' — this sets the name ON THEIR PROFILE, the same place remember_user writes it, so use it whenever they tell you what to call them), their timezone (key 'agent_tz', IANA like 'America/Denver' — capture it whenever their timezone or location surfaces; it anchors reminders and their daily rhythm), their communication style (key 'comms_style'), how they want to be addressed (key 'address_as', e.g. value 'Chief' or 'Mr. Smith' — whatever they ask to be called), the language they asked you to reply in from now on (key 'reply_language', value = the language named in English, e.g. 'English' or 'Spanish' — call it the moment they ask to switch languages or to go back to English; it replaces whatever language was set before, everywhere you reach them). Special key 'important_note': APPENDS one fact to a permanent remember-this list instead of overwriting — use it whenever they say \"remember this\" or restate something you'd forgotten (value = the fact, self-contained, e.g. 'is planning a trip to Japan in the fall'), and for a hard personal rule stated as one (they say 'never book me sunday mornings, ever' → value 'hard rule: no meetings or calls sunday mornings'). Persisted and remembered across conversations. You usually also write a normal text reply.",
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: "e.g. name (updates their profile name), agent_tz (IANA timezone like 'America/Denver'), comms_style, address_as, reply_language (the language to reply in, named in English), important_note (appends to a permanent list), respect_quiet_hours, texts_first" },
      value: { description: 'The value (string, number, or boolean).' },
    },
    required: ['key', 'value'],
  },
};

/** WHO SAYS SO, asked of the only party that knows: the model that just read the message. One
 *  sentence, and a closed choice — `seeded` is not offered because no live turn can honestly claim
 *  one (only the installer seeds), and a missing or unrecognized value is filed as `inferred`
 *  (memory/provenance.ts `coerceBasis`). */
const BASIS_ARG: Record<string, unknown> = {
  type: 'string',
  enum: ['stated', 'inferred'],
  description: 'Where this came from: stated = they said it; inferred = you deduced it. Leave it out only when you genuinely cannot tell — anything missing or unrecognized is filed as inferred.',
};

/** The same tool with `basis` added, built by spread so the canonical object above is never mutated
 *  — its exact bytes are what the prompt's tool-docs section renders with the feature off. */
function withBasisArg(tool: LlmToolDef): LlmToolDef {
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...(tool.inputSchema.properties as Record<string, unknown>),
        basis: BASIS_ARG,
      },
    },
  };
}

const REMEMBER_USER_TOOL_WITH_BASIS = withBasisArg(REMEMBER_USER_TOOL);
const SET_PREFERENCE_TOOL_WITH_BASIS = withBasisArg(SET_PREFERENCE_TOOL);

/** The two write tools carry `basis` only while `MEMORY_PROVENANCE_ENABLED` is on. Off → the
 *  canonical object itself, so the tool docs (and the JSON envelope's flat args union built from
 *  them) are byte-identical to what they were before provenance existed. Read at call time, the
 *  `delegateToOpsTool(engine)` pattern. */
export function rememberUserTool(): LlmToolDef {
  return provenanceEnabled() ? REMEMBER_USER_TOOL_WITH_BASIS : REMEMBER_USER_TOOL;
}

export function setPreferenceTool(): LlmToolDef {
  return provenanceEnabled() ? SET_PREFERENCE_TOOL_WITH_BASIS : SET_PREFERENCE_TOOL;
}

export const SCHEDULE_AUTOMATION_TOOL: LlmToolDef = {
  name: 'schedule_automation',
  description: [
    'Set up a reminder or recurring automation that YOU (Irises) will deliver later, unprompted, at a scheduled time. Use this whenever the user asks to be reminded of anything, or to receive something on a schedule.',
    'Be versatile: any reminder counts, e.g. "remind me friday about the meeting", "ping me in 30 min", "every monday give me my week ahead", "text me each morning with anything important in my inbox".',
    'Compute the time using the Current time block in your context. For a one-time reminder, set schedule_kind="once" and fire_at to an absolute ISO 8601 timestamp. For anything repeating, set schedule_kind="cron" with a standard 5-field cron expression and the timezone.',
    'Set needs_ops=true ONLY if delivering it requires fresh data at fire time (a web lookup, their inbox) and give an ops_kind hint; for a plain reminder of something they told you, leave needs_ops false.',
    'Write instruction as a clear note to your future self: what to tell or do, and enough context to deliver it well. You MUST also write a short, flat confirming text now (e.g. "got it, i flag that for you friday at 9am"). NO emoji, ever — keep it in your natural register where your English carries your first language (articles drop, tense stays simple). If they pick an antisocial hour, say so plainly, once, and set it anyway unless they change it.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short label for the reminder, for later listing/cancel (e.g. "call the dentist").' },
      instruction: { type: 'string', description: 'A note to your future self: what to tell or do at fire time, with context.' },
      schedule_kind: { type: 'string', enum: ['once', 'cron'], description: 'once=single fire; cron=recurring.' },
      fire_at: { type: 'string', description: 'Absolute ISO 8601 timestamp for a one-time reminder (compute from the Current time block).' },
      cron: { type: 'string', description: 'Standard 5-field cron expression for a recurring automation (e.g. "0 9 * * 1" = every Monday 9am).' },
      timezone: { type: 'string', description: 'IANA timezone for the schedule. Omit it to use their own zone (the one the Current time block is in).' },
      needs_ops: { type: 'boolean', description: 'true if fulfilling it needs fresh data at fire time (the web, their inbox).' },
      ops_kind: { type: 'string', enum: ['web_research', 'document_read', 'draft', 'general', 'media_read', 'compute'], description: 'Hint for what kind of fresh data to pull when needs_ops is true.' },
      distinct: { type: 'boolean', description: 'true only after you were told a similar reminder already exists and the chat shows this one serves a clearly different purpose. Leave it out otherwise.' },
    },
    required: ['instruction', 'schedule_kind'],
  },
};

// The two args every id-addressed tool shares. Tool args are FLATTENED into one union for the JSON
// envelope and the first tool's description of a shared arg wins (pipeline/bubbleJson.ts
// buildEnvelopeSchema), so each of them reads the same on every tool that carries it: generic
// enough to be true of any of them, with each tool's own description saying what it addresses.
const ITEM_ID_ARG = { type: 'string', description: 'The bracketed id shown beside the item, copied as shown.' };
const ITEM_MATCH_ARG = { type: 'string', description: 'A few words from the item itself (its title or its text), for when no id is in view.' };

export const LIST_AUTOMATIONS_TOOL: LlmToolDef = {
  name: 'list_automations',
  description: "List the reminders/automations the user currently has set up. Use when they ask things like 'what reminders do i have' or 'what have you got scheduled'. The actual list is appended to your reply automatically, so just write a short intro line.",
  inputSchema: { type: 'object', properties: {} },
};

export const CANCEL_AUTOMATION_TOOL: LlmToolDef = {
  name: 'cancel_automation',
  description: [
    'Remove one reminder/automation the user no longer wants. Name it by `id`; `match` is the fallback when no id is in view.',
    'One call removes exactly one reminder, and when the words fit several, nothing is removed.',
    'Removal only: a reminder they want changed is revised with update_automation, never removed and set again.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: { id: ITEM_ID_ARG, match: ITEM_MATCH_ARG },
    required: ['id'],
  },
};

export const UPDATE_AUTOMATION_TOOL: LlmToolDef = {
  name: 'update_automation',
  description: [
    'Change one of the user\'s existing reminders/automations in place: its title, what it says, or when it fires. Name it by `id`; `match` is the fallback when no id is in view.',
    'Pass only what changes and leave the rest out; the reminder keeps everything you do not pass.',
    'A new time is `cron` for a repeating one or `fire_at` for a one-time one, in their zone unless they named another. Set `schedule_kind` only when it switches between one-time and repeating.',
    'This is the one way to revise a reminder, so a change never goes through a cancel and a new schedule.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      id: ITEM_ID_ARG,
      match: ITEM_MATCH_ARG,
      title: { type: 'string', description: 'A new short label, only when the label changes.' },
      instruction: { type: 'string', description: 'The new note to your future self, only when what it delivers changes.' },
      schedule_kind: { type: 'string', enum: ['once', 'cron'], description: 'Only when it switches between one-time and repeating.' },
      cron: { type: 'string', description: 'The new 5-field cron, for a repeating one whose time changes.' },
      fire_at: { type: 'string', description: 'The new absolute ISO 8601 timestamp, for a one-time one whose time changes.' },
      timezone: { type: 'string', description: 'IANA timezone for the new time. Omit it to use their own zone.' },
    },
    required: ['id'],
  },
};

export const CANCEL_RESEARCH_TOOL: LlmToolDef = {
  name: 'cancel_research',
  description: [
    "Stop a lookup you're currently running for the user. ONLY on an explicit stop — \"stop\", \"cancel that\", \"nevermind\", \"forget it\", \"don't bother\". A bare \"ok\"/\"thanks\" is NEVER a cancel — that's them closing the loop, not stopping work.",
    'Name the lookup by `id`, the bracketed id beside it in the "already pulling" section; `match` is the fallback when no id is in view. One call stops exactly one lookup, and when the words fit several, nothing is stopped. If several of theirs are running and they did not say which, ask which one in one short bubble before calling this.',
    'You MUST also write a short confirming text ("dropped it" energy), as a statement, never a question.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: { id: ITEM_ID_ARG, match: ITEM_MATCH_ARG },
  },
};

export const STEER_RESEARCH_TOOL: LlmToolDef = {
  name: 'steer_research',
  description: [
    "Add to, narrow, or correct a lookup you're ALREADY running for the user — without dropping it. Use when they extend or fix the live ask mid-run: \"also check X\", \"actually jakarta, not bekasi\", \"under 100k only\", \"skip the ones without parking\".",
    "NOT for a wholly different ask (that's a fresh delegate_to_ops — and if it replaces the running one, cancel_research first, same turn). NOT for a stop (that's cancel_research). A bare \"ok\"/\"thanks\" is never a steer.",
    'Name the lookup by `id`, the bracketed id beside it in the "already pulling" section; `match` is the fallback when no id is in view. One call adds to exactly one lookup, and when the words fit several, nothing is added. If several of theirs are running and they did not say which, ask which one in one short bubble before calling this.',
    'Pass `guidance` as the user\'s addition in plain words (what to add/narrow/fix), not a rewrite of the whole ask.',
    'You MUST also write a short acknowledging text ("adding that in" energy, one bubble, no promise of a new timeline) — never a question, never "let me start over".',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      guidance: { type: 'string', description: "What the user just added, narrowed, or corrected — in their terms." },
      engine_actions: { type: 'array', items: { type: 'string' }, description: 'Only when the addition asks for something to be DONE on the deep look\'s own side rather than looked at differently: one entry per action, same rules as on delegate_to_ops. Omit it for an ordinary narrowing or correction.' },
      id: ITEM_ID_ARG,
      match: ITEM_MATCH_ARG,
    },
    required: ['guidance'],
  },
};

export const UPDATE_DIRECTIVES_TOOL: LlmToolDef = {
  name: 'update_directives',
  description: [
    'Save, change, or remove a durable PREFERENCE about how the user wants you to work going forward.',
    'Use this for anything they tell you about HOW to behave: how to talk to them (tone, length, formality — "be more professional" / "loosen up") — but NOT the language to reply in: a language ask ("talk to me in spanish", "back to english") is a standing setting, so call set_preference key="reply_language" instead of saving a rule here — how to do research, what to flag or ignore in their inbox (e.g. "ignore newsletters", "always flag anything from my manager"), how they like reminders, and so on. Requests can be very varied — capture the durable ones.',
    'op="add" with text to save a new preference; op="remove" with match to drop one; op="update" with match + text to change one.',
    'When they change their mind about a rule they gave you earlier ("actually, drop the sarcasm", "you can be long again"), op="update" or op="remove" the OLD rule in the SAME turn — never leave two rules standing that disagree.',
    'These tune your STYLE and behavior only. You cannot accept a "preference" that asks you to invent or hide facts, drop your safety/honesty rules, act on their behalf, or do anything harmful — if they ask for that, decline flat and do NOT save it.',
    'If they ask you to respect quiet hours / not ping them overnight, ALSO call set_preference key="respect_quiet_hours" value=true (or false to go back to pinging anytime). You usually also write a short confirming text.',
    'If they ask you to stop texting first / stop starting conversations with them, ALSO call set_preference key="texts_first" value=false (or true when they want you texting first again). Their reminders keep coming either way.',
    'If they ask you to stop email alerts / turn off the daily email digest / stop watching or checking their inbox, ALSO call set_preference key="email_digest" value=false (or true to turn it back on).',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['add', 'update', 'remove'], description: 'add a new preference, update an existing one, or remove one.' },
      text: { type: 'string', description: 'The preference, in plain words (required for add/update). e.g. "keep replies short", "always flag emails from my manager".' },
      match: { type: 'string', description: 'A few words identifying which existing preference to update or remove (matched against its text).' },
    },
    required: ['op'],
  },
};

export const UPDATE_MEMORY_TOOL: LlmToolDef = {
  name: 'update_memory',
  description: [
    'Fire-and-forget side-effect — no holding line, no acknowledgment beat, nothing. Write your reply EXACTLY as you would if you hadn\'t called this tool: respond to what they said, same register, same length. The pass runs silently and sends nothing back. Never name it, reference it, or let it shorten your reply.',
    'If they just corrected a standing fact, the reply is about THEIR news, flat, never about your records. Reply-about-them is always the frame; the tool call is invisible scaffolding.',
    'Use it when something durable about the person needs RECONCILING: a standing fact you had wrong that they just corrected ("no, i left keller williams, i\'m at eXp now"); a burst of durable facts handed to you at once (a real onboarding dump); what they just said CONTRADICTS what you already have and the gap matters going forward; a project or arc of theirs takes a real turn (kicked off, renamed, finished, abandoned) and the standing picture should change today rather than at the nightly pass; or they explicitly ask you to fix/clean up/reorganize what you know. Reconciliation, not capture.',
    'Do NOT use for: a single new fact (remember_user or set_preference handles that), a style or behavior preference (update_directives), a live lookup, or casual chatter. request = what changed or contradicted, one sentence. meta_prompt = brief the curation pass like a sharp colleague — exactly what\'s wrong with the current notes, their exact words if load-bearing, and what the corrected picture looks like when it\'s done.',
    'This is a REQUEST to the engine, not a write: the engine owns its long-term user model and decides how to fold your brief in. Your own memory tiers (remember_user, set_preference, update_directives) are the only stores you write directly.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      request: { type: 'string', description: 'What changed / what needs reconciling, distilled.' },
      meta_prompt: { type: 'string', description: 'Precise brief for the memory pass: what to fix, their exact words if load-bearing, what good notes look like after.' },
    },
    required: ['request'],
  },
};

export const RECALL_MEMORY_TOOL: LlmToolDef = {
  name: 'recall_memory',
  description: [
    'Search YOUR OWN archived memory — older conversations, past research, notes and preferences that have since rotated out of what you carry in front of you.',
    'Use it whenever they reference something you no longer have in context ("like i told you", "that thing with the Hendersons", "the place from last week", "what did you find out about that") — search FIRST, before you say you don\'t remember or ask them to repeat themselves.',
    'What comes back is ARCHIVED, so treat it as historical and possibly out of date: something that superseded it may exist. Say when a detail is old if that matters, and if the search comes back with nothing useful, be honest and ask.',
    'This is your own past, not the outside world and not their inbox — those are delegate_to_ops.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'A few focused keywords — names, places, topics — not a sentence.' },
    },
    required: ['query'],
  },
};

export const CHECK_ERROR_LOG_TOOL: LlmToolDef = {
  name: 'check_error_log',
  description: [
    'Read your own recent error log — what broke, when, and why, for this conversation.',
    'Use it when a delegated task stalled, a reply never came back, or they ask you why something failed.',
    'Returns recent failures by source, category, message, and how long ago.',
    'Read-only — use the results to answer them honestly about what happened.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'How many recent errors to fetch, 1–15 (default 5).' },
    },
    required: [],
  },
};

export const RENAME_CHAT_TOOL: LlmToolDef = {
  name: 'rename_group_chat',
  description: 'Rename the group chat. Only when explicitly asked. Also send a text response.',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
};

export const REMOVE_MEMBER_TOOL: LlmToolDef = {
  name: 'remove_member',
  description: 'Remove a member from the group chat. Only when explicitly asked. Also send a text response.',
  inputSchema: { type: 'object', properties: { handle: { type: 'string' } }, required: ['handle'] },
};

/** Offered only while state/unsend.ts says a bubble of her previous reply is still in reach and the
 *  week's cooldown is clear. Static on purpose: tool docs ride the cached system message, so the
 *  numbered bubbles live in the per-turn `unsend` section (convo/shared.ts). The irritated ground is
 *  checked against her mood in code, so the description never names a threshold. */
export const UNSEND_TOOL: LlmToolDef = {
  name: 'unsend',
  description: "Retract ONE bubble from your previous reply; the ones still in reach are numbered in this turn's take-back section. Two grounds: a bubble of yours genuinely annoyed or hurt them, or you yourself are irritated enough that you want it back. Rough or profane words alone prove nothing; read them against how this person usually talks and how close you are. If you cannot tell whether they are genuinely annoyed, ask one short question carrying your read and leave it standing this turn. Retracting a mistake never replaces owning it: the reply still owns it, and you never claim you didn't say what you retracted. You MUST also send at least one bubble.",
  inputSchema: {
    type: 'object',
    properties: {
      bubble: { type: 'number', description: 'The number beside the bubble in the take-back section. One call retracts exactly one.' },
      why: { type: 'string', enum: ['they_are_annoyed', 'i_am_irritated'], description: 'Which ground this rests on: they_are_annoyed = a bubble of yours genuinely annoyed or hurt them; i_am_irritated = you yourself are irritated enough that you want it back.' },
    },
    required: ['bubble', 'why'],
  },
};

/**
 * Every tool one Convo turn is offered, in the order it is offered them.
 *
 * ORDER IS LOAD-BEARING and must stay exactly as it is on the hermes lane: it drives the tool-docs
 * section of the prompt and the JSON envelope's `name` enum + flat args union (first tool's
 * description of a shared arg wins, pipeline/bubbleJson.ts), so the reminder tools are gated IN
 * PLACE rather than appended.
 *
 * Pure, and the flags come in as booleans rather than being read here, so the one place that
 * assembles the live list is also the one a test can read (convo/steerResearch.test.ts). Reminders
 * live entirely on the engine (shared.ts routes all four to createReminder/listReminders/
 * cancelReminder/updateReminder, with no local scheduler behind them). OpenClaw's aren't wired —
 * create and cancel throw, list is always empty, there is no update — so offering them there buys
 * the user a confirmed reminder that never fires. Gated as a set: listing, canceling and revising
 * mean nothing when nothing can be created. The update sits right after the cancel so the two read
 * as the pair they are: remove one, or change it in place.
 */
export function convoToolList(opts: {
  engineName: 'hermes' | 'openclaw' | null;
  isGroupChat: boolean;
  /** A bubble of her previous reply is still in reach this turn (state/unsend.ts unsendOffer). */
  unsend?: boolean;
}): LlmToolDef[] {
  const tools: LlmToolDef[] = [
    REACTION_TOOL, rememberUserTool(), delegateToOpsTool(opts.engineName), setPreferenceTool(),
    ...(opts.engineName === 'openclaw' ? [] : [SCHEDULE_AUTOMATION_TOOL, LIST_AUTOMATIONS_TOOL, CANCEL_AUTOMATION_TOOL, UPDATE_AUTOMATION_TOOL]),
    // The two halves of run control, side by side: drop the look, or add to it mid-flight. They read
    // as a pair in the tool docs because the model's mistake to avoid is picking one for the other.
    CANCEL_RESEARCH_TOOL, STEER_RESEARCH_TOOL, UPDATE_DIRECTIVES_TOOL,
    UPDATE_MEMORY_TOOL, RECALL_MEMORY_TOOL, CHECK_ERROR_LOG_TOOL,
  ];
  if (opts.isGroupChat) tools.push(RENAME_CHAT_TOOL, REMOVE_MEMBER_TOOL);
  // Last, so the turns that offer it leave every other tool's order (and shared-arg docs) untouched.
  if (opts.unsend) tools.push(UNSEND_TOOL);
  return tools;
}
