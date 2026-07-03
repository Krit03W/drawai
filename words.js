// Fallback word lists used when the OpenAI API is unavailable, tiered by
// difficulty 1 (easy) … 5 (nearly impossible to draw).
export const FALLBACK_WORDS = {
  1: [
    'Cat', 'Dog', 'Sun', 'House', 'Fish', 'Ball', 'Apple', 'Tree',
    'Star', 'Car', 'Flower', 'Banana', 'Egg', 'Moon', 'Cup', 'Book',
  ],
  2: [
    'Monkey', 'Pizza', 'Elephant', 'Rocket', 'Bicycle', 'Butterfly',
    'Guitar', 'Penguin', 'Umbrella', 'Snowman', 'Spider', 'Rainbow',
    'Hamburger', 'Owl', 'Whale', 'Ice cream',
  ],
  3: [
    'Lighthouse', 'Volcano', 'Telescope', 'Scarecrow', 'Waterfall',
    'Submarine', 'Windmill', 'Helicopter', 'Mermaid', 'Castle',
    'Campfire', 'Skateboard', 'Cactus', 'Kangaroo', 'Dragon', 'Anchor',
  ],
  4: [
    'Traffic jam', 'Earthquake', 'Sleepwalking', 'Time machine',
    'Haunted house', 'Tug of war', 'Hibernation', 'Mirage',
    'Avalanche', 'Camouflage', 'Stampede', 'Quicksand',
    'Solar eclipse', 'Shadow puppet', 'Treasure hunt', 'Fireworks show',
  ],
  5: [
    'Gravity', 'Democracy', 'Inflation', 'Sarcasm', 'Nostalgia',
    'Wifi signal', 'Déjà vu', 'Procrastination', 'Karma', 'Jealousy',
    'Algorithm', 'Silence', 'Monday morning', 'Inner peace',
    'Existential crisis', 'The future',
  ],
};

export function pickUniqueWords(count, difficulty = 2, exclude = []) {
  const used = new Set(exclude.map(w => w.toLowerCase()));
  let pool = (FALLBACK_WORDS[difficulty] || FALLBACK_WORDS[2])
    .filter(w => !used.has(w.toLowerCase()));
  // If the tier is exhausted, allow reuse rather than running out of words.
  if (pool.length < count) pool = [...(FALLBACK_WORDS[difficulty] || FALLBACK_WORDS[2])];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}
