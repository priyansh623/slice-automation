// Stable identifiers for the B-roll categories the classification refers to.
//
// Category names and slugs are editable in the app, so they are never used to find a category.
// Each key below is only a label used inside broll-import/classification.json (it equals the
// slug the category had when it was created). The id is the identity, and parentId records the
// parent it must have. A script run fails if an id is missing, is not a Soma-wide category, or
// sits under a different parent than recorded here.
//
// These ids belong to the production database project "Slice - Soma Automation". Another
// database needs its own map.

export interface CategoryMapEntry {
  id: number;
  parentId: number | null;
}

export type CategoryMap = Record<string, CategoryMapEntry>;

const primary = (id: number): CategoryMapEntry => ({ id, parentId: null });
const sub = (id: number, parentId: number): CategoryMapEntry => ({ id, parentId });

export const BROLL_CATEGORY_MAP: CategoryMap = {
  // primary categories
  'groceries': primary(1),
  'payments-finance': primary(2),
  'health-fitness': primary(3),
  'home-living': primary(4),
  'work-education': primary(5),
  'delivery-logistics': primary(6),
  'lifestyle-leisure': primary(7),
  'travel-transport': primary(8),
  'digital-products-ui': primary(9),
  'food-beverage': primary(10),
  'cards': primary(11),
  'shopping-retail': primary(12),

  // Shopping & Retail (12)
  'in-store-browsing': sub(13, 12),
  'checkout-payment': sub(14, 12),
  'product-display': sub(15, 12),
  'bags-after-purchase': sub(51, 12),
  // Food & Beverage (10)
  'cafe-coffee': sub(16, 10),
  'restaurant-dining': sub(17, 10),
  'street-food': sub(18, 10),
  'food-at-home': sub(52, 10),
  // Groceries (1)
  'supermarket-aisles': sub(19, 1),
  'fresh-produce': sub(20, 1),
  'groceries-checkout': sub(21, 1),
  // Payments & Finance (2)
  'mobile-payment': sub(22, 2),
  'card-tap': sub(23, 2),
  'banking-app': sub(24, 2),
  'rewards-cashback': sub(49, 2),
  // Cards (11)
  'card-reveal': sub(25, 11),
  'card-lifestyle': sub(26, 11),
  'card-benefits': sub(27, 11),
  // Travel & Transport (8)
  'airport': sub(28, 8),
  'train-transit': sub(29, 8),
  'road-trip': sub(30, 8),
  'cab-ride-hailing': sub(50, 8),
  // Delivery & Logistics (6)
  'package-delivery': sub(31, 6),
  'last-mile': sub(32, 6),
  'courier': sub(33, 6),
  'quick-commerce': sub(53, 6),
  // Lifestyle & Leisure (7)
  'social-outings': sub(34, 7),
  'entertainment': sub(35, 7),
  'relaxation': sub(36, 7),
  // Work & Education (5)
  'office-workspace': sub(37, 5),
  'study-learning': sub(38, 5),
  'collaboration': sub(39, 5),
  // Digital Products & UI (9)
  'app-walkthrough': sub(40, 9),
  'dashboard': sub(41, 9),
  'notification': sub(42, 9),
  // Health & Fitness (3)
  'gym-workout': sub(43, 3),
  'outdoor-activity': sub(44, 3),
  'wellness': sub(45, 3),
  // Home & Living (4)
  'interior-lifestyle': sub(46, 4),
  'cooking-at-home': sub(47, 4),
  'home-improvement': sub(48, 4),
};

// Checks the map on its own, without a database: no two keys share an id, every parent is a
// primary category in the map, and no entry is its own parent.
export function validateCategoryMap(map: CategoryMap): string[] {
  const errors: string[] = [];
  const keyById = new Map<number, string>();
  for (const [key, entry] of Object.entries(map)) {
    const other = keyById.get(entry.id);
    if (other) errors.push(`'${key}' and '${other}' share category id ${entry.id}`);
    keyById.set(entry.id, key);
    if (entry.parentId === entry.id) errors.push(`'${key}' is its own parent`);
  }
  for (const [key, entry] of Object.entries(map)) {
    if (entry.parentId === null) continue;
    const parentKey = keyById.get(entry.parentId);
    if (!parentKey) errors.push(`'${key}' has parent id ${entry.parentId}, which is not in the map`);
    else if (map[parentKey].parentId !== null) errors.push(`'${key}' has parent '${parentKey}', which is not a primary category`);
  }
  return errors;
}
