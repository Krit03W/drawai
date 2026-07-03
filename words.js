// Fallback word list used when the OpenAI API is unavailable.
// Simple, drawable, concrete nouns.
export const FALLBACK_WORDS = [
  'Monkey', 'Pizza', 'Elephant', 'Rocket', 'Bicycle',
  'Butterfly', 'Guitar', 'Lighthouse', 'Octopus', 'Umbrella',
  'Penguin', 'Volcano', 'Sandwich', 'Helicopter', 'Cactus',
  'Snowman', 'Tornado', 'Mermaid', 'Robot', 'Dragon',
  'Giraffe', 'Waterfall', 'Telescope', 'Scarecrow', 'Submarine',
  'Kangaroo', 'Windmill', 'Ice cream', 'Spider', 'Castle',
  'Dinosaur', 'Rainbow', 'Anchor', 'Ladder', 'Whale',
  'Campfire', 'Trophy', 'Skateboard', 'Owl', 'Hamburger',
];

export function pickUniqueWords(count) {
  const pool = [...FALLBACK_WORDS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}
