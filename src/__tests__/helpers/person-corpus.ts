/** Samples shared by the TypeScript and SQL person-filter tests: descriptions that must go, scene terms that must stay. */
export const EXCLUDED: Array<[text: string, mustNotRemain: string[]]> = [
  ['young woman at a cafe table', ['young', 'woman']], ['an elderly man reading', ['elderly', 'man']], ['a man in a white tee', ['man', 'tee']],
  ['bearded guy with a mug', ['bearded', 'guy']], ['long curly hair, smiling', ['curly', 'hair']], ['her hair tied back', ['hair']], ['fair skin and dark skin tone', ['skin']],
  ['athletic build, slim body', ['build', 'body']], ['a 35 years old customer', ['years']], ['young people laughing', ['young', 'people']], ['dark-haired', ['haired']],
  ['busy_homemaker', ['homemaker']], ['gen z creator', ['gen']], ['black sunglasses and a hoodie', ['sunglasses', 'hoodie']], ['slim Indian guy', ['slim', 'Indian', 'guy']],
  ['teenage girl on a sofa', ['teenage', 'girl']], ['she holds a phone', ['she']], ['in her 30s', ['30s']], ['a young adult', ['young', 'adult']], ['muscular man, stubble, moustache', ['muscular', 'stubble', 'moustache']],
];
export const LEGITIMATE = [
  'hair salon', 'old building', 'young audience', 'slim laptop', 'Indian restaurant', 'wavy pattern wallpaper', 'ring light', 'watch on the shelf', 'baseball cap on a hook',
  'crowd of people walking', 'hair dryer on the counter', 'skin care products', 'old town street', 'athletic shoes display', 'a person in the distance', 'elderly care home',
  'old fashioned diner', 'curly fries', 'black coffee', 'white walls', 'brown leather sofa', 'short film studio', 'tall bookshelf', 'Asian fusion kitchen', 'adult swim pool',
];

