export interface Card {
  id: number
  title: string
  author: { firstName: string; lastName: string }
  year: number
}

const ADJECTIVES = [
  'Old', 'Quiet', 'Glass', 'Amber', 'Northern', 'Salt', 'Paper', 'Hidden', 'Late', 'Bright',
  'Copper', 'Winter', 'Little', 'Broken', 'Golden', 'River', 'Silent', 'Wild', 'Second', 'Last',
]

const NOUNS = [
  'Harbor', 'Machine', 'Garden', 'Letter', 'City', 'Atlas', 'Orchard', 'Bridge', 'Library', 'Coast',
  'Market', 'Lantern', 'Voyage', 'Notebook', 'Kingdom', 'Station', 'Mirror', 'Field', 'Archive', 'Sea',
]

const FIRST = [
  'Ada', 'James', 'Ursula', 'Ernest', 'John', 'Ann', 'Olga', 'Mateo', 'Priya', 'Leila',
  'Hugo', 'Nora', 'Søren', 'Chloé', 'Idris', 'Mina', 'Elena', 'Jonah', 'Ruth', 'Kenji',
]

const LAST = [
  'Lovelace', 'Baldwin', 'Le Guin', 'Hemingway', 'Scalzi', 'Young', 'Tokarczuk', 'García', 'Nair', 'Abdi',
  'Moreau', 'Kline', 'Kierkegaard', 'Dubois', 'Okeke', 'Farouk', 'Petrova', 'Ellison', 'Ozeki', 'Abe',
]

/** Stable 100k-card catalog. A handful of real titles sit at the front of the drawer. */
export function makeCatalog(count = 100_000): Card[] {
  const cards: Card[] = new Array(count)
  cards[0] = {
    id: 0,
    title: 'The Old Man and the Sea',
    author: { firstName: 'Ernest', lastName: 'Hemingway' },
    year: 1952,
  }
  cards[1] = {
    id: 1,
    title: "Old Man's War",
    author: { firstName: 'John', lastName: 'Scalzi' },
    year: 2005,
  }
  cards[2] = {
    id: 2,
    title: 'The Young Man',
    author: { firstName: 'Ann', lastName: 'Young' },
    year: 1998,
  }
  for (let i = 3; i < count; i += 1) {
    const accent = i % 53 === 0 ? ' Café' : i % 89 === 0 ? ' Naïve' : ''
    const extra = i % 17 === 0 ? ' Sea' : ''
    cards[i] = {
      id: i,
      title: `${ADJECTIVES[i % ADJECTIVES.length]} ${NOUNS[(i * 3) % NOUNS.length]}${extra}${accent}`,
      author: {
        firstName: FIRST[(i * 5) % FIRST.length]!,
        lastName: LAST[(i * 7) % LAST.length]!,
      },
      year: 1850 + (i % 170),
    }
  }
  return cards
}
