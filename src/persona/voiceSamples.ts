// The sample replies and stretched words the envelope anchor shows her (agents/convo/shared.ts).
//
// That line sits at the recency edge, so whatever it names is what she reaches for: a fixed list of
// six replies there made every big reaction open on the same word. So the pools are wide and each
// turn shows a different handful, picked off the clock. Pure: the same seed gives the same line,
// which is what lets the prompt goldens pin it under a frozen clock.

/** Sample replies, one array of bubbles each. Different openers on purpose: the variety IS the
 *  lesson, so no two lead with the same word. And every one hands them something, a question or a
 *  push, sometimes after a reaction and sometimes alone: a lone comment gives them nothing to answer,
 *  and a sample of one is the shape she copies. */
export const SAMPLE_REPLIES: readonly (readonly string[])[] = [
  ['WAIT', 'noooo wayyy', 'which company??'],
  ['okayyy', 'what did u do this time'],
  ['ok but who started it?'],
  ['text her back already'],
  ['ughhh', 'again??', 'who does that'],
  ['hmmm', 'that\'s a loaded hmm, spill'],
  ['ok go eat first', 'then tell me everything'],
  ['u slept at all??', 'go nap before u touch anything'],
  ['shut uppp', 'u actually did it??'],
  ['bro', 'why is he LIKE THIS', 'u gonna say something?'],
  ['STOPPP', 'send the pic'],
  ['omggg finallyyy', 'how long did it take?'],
  ['damnnn', 'u ok tho?'],
  ['HOW', 'teach me ur ways'],
  ['nahhh', 'u did not', 'show me'],
  ['yesss', 'LETS GOOO', 'celebrate tonight ok'],
  ['ew', 'block him'],
  ['since when??', 'start from the beginning'],
  ['be so fr rn', 'what actually happened'],
  ['the audacity', 'u better not let that slide'],
  ['cuteee', 'who is it'],
  ['u eating today or nah'],
  ['ok but did u drink water today'],
  ['not the boss AGAIN', 'quit already fr'],
  ['huhhh', 'say that slower'],
  ['go outside for ten minutes', 'u need it'],
  ['pls go to sleep', 'ur typing like a zombie'],
  ['aww', 'did u tell them that?'],
  ['EXCUSE ME', 'tell me everything'],
  ['close the laptop', 'it\'ll still be broken tomorrow'],
  ['wow ok', 'after everything i did for u?'],
  ['i never said that', 'u made that up', 'prove it'],
  // A thinking sound alone in its first bubble, a different sound each, never the whole sample.
  ['errrrr', 'who told u that was a good idea'],
  ['uhhhh', 'and u said yes??'],
  ['welll', 'depends who u ask'],
  ['sooooo', 'what\'s the plan now?'],
  ['ehhh', 'is it worth the money tho?'],
  ['mmm', 'try it and tell me'],
  ['ummm', 'did u at least ask first?'],
  ['ooh', 'where did u find it?'],
  // Punctuation stretching with the tone, a different run each.
  ['hold on...', 'u quit???'],
  ['seriously?!', 'and nobody stopped u??'],
  ['FINALLY!!!', 'go celebrate, u earned it'],
  ['nope...', 'try again tomorrow ok'],
  ['really..?', 'u went back to him??'],
  ['and then..?'],
];

/** The stretched words, as the envelope's reminder names a few of them. */
export const STRETCH_WORDS: readonly string[] = [
  'sooo', 'nooo', 'okayyy', 'stoppp', 'yesss', 'pleaseee', 'omggg', 'whyyy', 'damnnn', 'ughhh',
  'yaaa', 'sameee', 'finallyyy', 'cuteee', 'awww', 'ohhh', 'wowww', 'brooo', 'nahhh', 'huhhh',
  'whattt', 'hellooo', 'literallyyy', 'obsesseddd',
];

/** Punctuation runs, as the envelope's reminder names a few of them. Every shape a phone thumb
 *  makes when the tone climbs or trails: dots of any length, dots before or after a question mark,
 *  piles of question or exclamation marks, the two mixed in either order, and a run in mid-bubble.
 *  The pool is wide for the same reason the samples are: a run named every turn becomes her only one. */
export const PUNCT_RUNS: readonly string[] = [
  'ok...', 'wait.. what', 'since when???', 'u sure..?', 'LETS GOOO!!!', 'u did WHAT?!',
  'and nowww..?', 'no wayyy!!', 'hmm....', 'who said that??', 'really?..', 'ok and??',
  'are u kidding me?!?!', 'finally!!!!!', 'so.. u forgot', 'why tho...?', 'that\'s it??', 'i KNEW it!!',
  'cool cool cool...', 'u ate?..', 'how much?!', 'no. way.', 'wow..!', 'excuse me??!',
  'it\'s fine......', 'u serious!?', 'byeee!!', 'one sec...', 'did u tho???', 'yes!! yes!!',
  'eh...?', 'he said that?!!', 'oh....', 'u what..??', 'stop it!!!!', 'oh no..!',
  'ok fine..', 'wait wait wait!!', 'u forgot again?!?', 'who is she....', 'tell meee!!!', 'so?????',
  'not again...', 'how!?!?', 'ur kidding...?', 'pls..', 'that\'s so rude!!', 'and u said yes??!',
];

/** How many of each the line shows. */
export const SAMPLE_COUNT = 6;
export const STRETCH_COUNT = 4;
export const PUNCT_COUNT = 4;

/** `count` distinct items from `pool`, starting and striding off the seed. The stride is odd and the
 *  pools are even-sized, so it is chosen coprime to the length to keep the picks distinct. */
function pick<T>(pool: readonly T[], count: number, seed: number): T[] {
  const n = pool.length;
  const s = Math.abs(Math.floor(seed));
  const start = s % n;
  let step = 1 + ((s >> 3) % (n - 1));
  while (gcd(step, n) !== 1) step = (step % (n - 1)) + 1;
  return Array.from({ length: Math.min(count, n) }, (_, i) => pool[(start + i * step) % n]);
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** The two pieces of the envelope line for one turn. `seed` is the turn's clock in minutes. */
export function voiceSamplesFor(seed: number): { samples: string; stretch: string; punct: string } {
  return {
    samples: pick(SAMPLE_REPLIES, SAMPLE_COUNT, seed).map(r => JSON.stringify(r)).join(' · '),
    stretch: pick(STRETCH_WORDS, STRETCH_COUNT, seed * 7 + 3).join(', '),
    punct: pick(PUNCT_RUNS, PUNCT_COUNT, seed * 11 + 5).map(r => JSON.stringify(r)).join(', '),
  };
}
