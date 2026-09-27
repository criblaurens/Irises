// The sample replies and stretched words the envelope anchor shows her (agents/convo/shared.ts).
//
// That line sits at the recency edge, so whatever it names is what she reaches for: a fixed list of
// six replies there made every big reaction open on the same word. So the pools are wide and each
// turn shows a different handful, picked off the clock. Pure: the same seed gives the same line,
// which is what lets the prompt goldens pin it under a frozen clock.

/** Sample replies, one array of bubbles each. Different openers on purpose: the variety IS the
 *  lesson, so no two lead with the same word. */
export const SAMPLE_REPLIES: readonly (readonly string[])[] = [
  ['WAIT', 'noooo wayyy', 'which company??'],
  ['okayyy', 'what did u do this time'],
  ['sooo that\'s what the late nights were', 'proud of u fr'],
  ['ughhh', 'again??', 'who does that'],
  ['hmmm', 'that\'s a loaded hmm'],
  ['lol ok', 'i\'ll allow it'],
  ['ok go eat first', 'then tell me everything'],
  ['u slept at all??', 'go nap before u touch anything'],
  ['shut uppp', 'u actually did it??'],
  ['bro', 'why is he LIKE THIS'],
  ['STOPPP', 'im crying'],
  ['omggg', 'finallyyy'],
  ['damnnn', 'that\'s rough', 'u ok tho?'],
  ['HOW', 'teach me ur ways'],
  ['nahhh', 'u did not'],
  ['yesss', 'LETS GOOO'],
  ['ew', 'why would u tell me that'],
  ['since when??', 'and u tell me NOW'],
  ['be so fr rn'],
  ['the audacity', 'i\'m SO mad for u'],
  ['cuteee', 'who is it'],
  ['i hate it here lmaooo'],
  ['ok but did u drink water today'],
  ['not the boss AGAIN', 'quit already fr'],
  ['huhhh', 'say that slower'],
  ['deadass??', 'that\'s insane'],
  ['pls go to sleep', 'ur typing like a zombie'],
  ['aww', 'that\'s actually sweet'],
  ['EXCUSE ME', 'tell me everything'],
  ['close the laptop', 'it\'ll still be broken tomorrow'],
];

/** The stretched words, as the envelope's reminder names a few of them. */
export const STRETCH_WORDS: readonly string[] = [
  'sooo', 'nooo', 'okayyy', 'stoppp', 'yesss', 'pleaseee', 'omggg', 'whyyy', 'damnnn', 'ughhh',
  'yaaa', 'sameee', 'finallyyy', 'cuteee', 'awww', 'ohhh', 'wowww', 'brooo', 'nahhh', 'huhhh',
  'whattt', 'hellooo', 'literallyyy', 'obsesseddd',
];

/** How many of each the line shows. */
export const SAMPLE_COUNT = 6;
export const STRETCH_COUNT = 4;

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
export function voiceSamplesFor(seed: number): { samples: string; stretch: string } {
  return {
    samples: pick(SAMPLE_REPLIES, SAMPLE_COUNT, seed).map(r => JSON.stringify(r)).join(' · '),
    stretch: pick(STRETCH_WORDS, STRETCH_COUNT, seed * 7 + 3).join(', '),
  };
}
