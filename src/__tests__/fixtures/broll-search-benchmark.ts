/**
 * Relevance benchmark for B-roll search, run against the 28 clips in the shared library (titles, tags, named
 * brands and categories as classified; see broll-benchmark-library.json).
 *
 * Labels were written by hand from clip titles and categories, before the matcher was run:
 *   direct   the clip itself shows what was asked for
 *   related  a neighbouring activity that a user who asked this might reasonably want after the direct matches
 *   (everything else is irrelevant)
 * Clips are referred to by their import ref (C01 ...).
 */
export interface BenchmarkQuery {
  q: string;
  kind: 'broad' | 'specific';
  direct: string[];
  related?: string[];
  note?: string;
}

const FOOD_DIRECT = ['C01', 'C07', 'C12', 'C13', 'C14', 'C18', 'C19', 'C24', 'C25', 'C27', 'C29', 'C31'];

export const BENCHMARK: BenchmarkQuery[] = [
  // Broad: concepts that should also bring related footage, after the direct matches
  { q: 'payment', kind: 'broad', direct: ['C20'], related: ['C21', 'C26', 'C31'] },
  { q: 'pay', kind: 'broad', direct: ['C20'], related: ['C21', 'C26', 'C31'] },
  { q: 'cashback', kind: 'broad', direct: ['C21', 'C26'], related: ['C20'] },
  { q: 'rewards', kind: 'broad', direct: ['C21', 'C26'], related: ['C20'] },
  { q: 'banking', kind: 'broad', direct: ['C21', 'C26'], related: ['C20'] },
  { q: 'card', kind: 'broad', direct: ['C31'], related: ['C20'] },
  { q: 'shopping', kind: 'broad', direct: ['C04', 'C08', 'C29', 'C30', 'C32'], related: ['C20', 'C09', 'C19'] },
  { q: 'retail', kind: 'broad', direct: ['C04', 'C08', 'C29', 'C30', 'C32'], related: ['C20', 'C09', 'C19'] },
  { q: 'groceries', kind: 'broad', direct: ['C19', 'C29', 'C32'], related: ['C09'] },
  { q: 'food', kind: 'broad', direct: FOOD_DIRECT, related: ['C32'] },
  { q: 'drink', kind: 'broad', direct: ['C01', 'C02', 'C12', 'C13', 'C14', 'C24', 'C25', 'C31'], related: ['C07', 'C18', 'C19', 'C27', 'C29'] },
  { q: 'coffee', kind: 'broad', direct: ['C12', 'C25', 'C31'], related: ['C26'] },
  { q: 'cafe', kind: 'broad', direct: ['C25', 'C26', 'C31'], related: ['C12'] },
  { q: 'chai', kind: 'broad', direct: ['C13', 'C24'] },
  { q: 'tea', kind: 'broad', direct: ['C13', 'C24'] },
  { q: 'delivery', kind: 'broad', direct: ['C09', 'C19', 'C23'] },
  { q: 'travel', kind: 'broad', direct: ['C02', 'C03', 'C06', 'C11'] },
  { q: 'cab', kind: 'broad', direct: ['C06', 'C11'] },
  { q: 'taxi', kind: 'broad', direct: ['C06', 'C11'] },
  { q: 'entertainment', kind: 'broad', direct: ['C15', 'C16', 'C18', 'C28'] },
  { q: 'gaming', kind: 'broad', direct: ['C14', 'C16', 'C28'] },
  { q: 'relaxing', kind: 'broad', direct: ['C03', 'C13', 'C14', 'C18'] },
  { q: 'social outing', kind: 'broad', direct: ['C24', 'C25', 'C31'] },
  { q: 'person using phone', kind: 'broad', direct: ['C20'], related: ['C21', 'C26'], note: 'phone: only the mobile-payment clip names a phone; app screens are related' },
  { q: 'app', kind: 'broad', direct: ['C20', 'C21', 'C26'] },
  { q: 'cooking', kind: 'broad', direct: ['C27'] },
  { q: 'paying with phone', kind: 'broad', direct: ['C20'], related: ['C21', 'C26'] },
  { q: 'coffee at a cafe', kind: 'broad', direct: ['C25', 'C31'], related: ['C12', 'C26'] },
  { q: 'food delivery', kind: 'broad', direct: ['C19'] },
  // Added after a held-out probe exposed gaps in the first lexicon (buy/purchase, money, clothes/clothing)
  { q: 'money', kind: 'broad', direct: ['C20', 'C21', 'C26'] },
  { q: 'buying clothes', kind: 'specific', direct: ['C30'] },
  { q: 'buying snacks', kind: 'specific', direct: ['C29'] },
  // Broad queries with nothing in the library: must return nothing, not stretch
  { q: 'work', kind: 'broad', direct: [], note: 'no workplace footage exists; the gaming-laptop clip is not work' },
  { q: 'someone working', kind: 'broad', direct: [] },
  { q: 'office', kind: 'broad', direct: [] },
  { q: 'gym workout', kind: 'broad', direct: [] },
  // Specific: strict, direct only, never widened
  { q: 'person paying at a counter', kind: 'specific', direct: ['C20'] },
  { q: 'holding a phone', kind: 'specific', direct: ['C20'] },
  { q: 'person paying with cash', kind: 'specific', direct: [], note: 'digital payment footage must not stand in for cash' },
  { q: 'scanning QR code', kind: 'specific', direct: [], note: 'no QR footage exists' },
  { q: 'QR code', kind: 'specific', direct: [] },
  { q: 'unboxing', kind: 'specific', direct: [], note: 'holding or turning a parcel is not unboxing' },
  { q: 'airport', kind: 'specific', direct: [], note: 'the plane clip is in-flight, not an airport' },
  { q: 'car', kind: 'specific', direct: ['C01', 'C07'], note: 'a cab is not a car' },
  { q: 'flight', kind: 'specific', direct: ['C02'] },
  { q: 'hotel', kind: 'specific', direct: ['C03'] },
  { q: 'parcel', kind: 'specific', direct: ['C23'] },
  { q: 'quick commerce', kind: 'specific', direct: ['C09', 'C19'] },
  { q: 'blinkit', kind: 'specific', direct: ['C09', 'C19'] },
  { q: 'disney', kind: 'specific', direct: ['C09'] },
  { q: 'starbucks', kind: 'specific', direct: ['C04'] },
  { q: 'coca cola', kind: 'specific', direct: ['C02'] },
  { q: 'playstation', kind: 'specific', direct: ['C16', 'C28'] },
  { q: 'controller', kind: 'specific', direct: ['C16', 'C28'] },
  { q: 'movie', kind: 'specific', direct: ['C18'] },
  { q: 'popcorn', kind: 'specific', direct: ['C18'] },
  { q: 'go kart', kind: 'specific', direct: ['C15'] },
  { q: 'iced coffee', kind: 'specific', direct: ['C12', 'C25', 'C31'] },
  { q: 'stirring', kind: 'specific', direct: ['C14', 'C25'] },
  { q: 'scrolling', kind: 'specific', direct: ['C26'] },
  { q: 'activity screen', kind: 'specific', direct: ['C26'] },
  { q: 'cashback rows', kind: 'specific', direct: ['C21'] },
  { q: 'supermarket', kind: 'specific', direct: ['C32'] },
  { q: 'minimart', kind: 'specific', direct: ['C29'] },
  { q: 'bag', kind: 'specific', direct: ['C04', 'C08', 'C09', 'C19', 'C30'] },
  { q: 'shopping bag', kind: 'specific', direct: ['C04', 'C08', 'C30'], note: 'a delivery bag is not a shopping bag' },
  { q: 'kraft bag', kind: 'specific', direct: ['C08', 'C30'] },
  { q: 'snack', kind: 'specific', direct: ['C27', 'C29'] },
  { q: 'noodles', kind: 'specific', direct: ['C12'] },
  { q: 'momos', kind: 'specific', direct: ['C07'] },
  { q: 'street food', kind: 'specific', direct: ['C07', 'C24'] },
  { q: 'person at a cafe table', kind: 'specific', direct: ['C25', 'C31'] },
];
