-- B-roll hierarchical category system
-- broll_categories: self-referencing tree; scope='soma' for Soma-wide, scope='brand' for brand extensions
CREATE TABLE broll_categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  scope TEXT NOT NULL DEFAULT 'soma',   -- 'soma' | 'brand'
  brand_scope TEXT,                      -- non-null when scope='brand'; matches broll_clips.brand text
  parent_id INTEGER REFERENCES broll_categories(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(slug, brand_scope)
);

CREATE INDEX broll_categories_parent_id_idx ON broll_categories(parent_id);

-- broll_clip_categories: many-to-many join table
CREATE TABLE broll_clip_categories (
  clip_id INTEGER NOT NULL REFERENCES broll_clips(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES broll_categories(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (clip_id, category_id)
);

CREATE INDEX broll_clip_categories_category_id_idx ON broll_clip_categories(category_id);

-- No policies: the app reaches these tables through its server-side connection only
ALTER TABLE broll_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE broll_clip_categories ENABLE ROW LEVEL SECURITY;

-- ── Seed: Soma-wide taxonomy (idempotent — WHERE NOT EXISTS guards against re-run) ───

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Shopping & Retail', 'shopping-retail', 'soma', NULL, 1, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
WHERE NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'shopping-retail' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Food & Beverage', 'food-beverage', 'soma', NULL, 2, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
WHERE NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'food-beverage' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Groceries', 'groceries', 'soma', NULL, 3, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
WHERE NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'groceries' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Payments & Finance', 'payments-finance', 'soma', NULL, 4, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
WHERE NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'payments-finance' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Cards', 'cards', 'soma', NULL, 5, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
WHERE NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'cards' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Travel & Transport', 'travel-transport', 'soma', NULL, 6, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
WHERE NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'travel-transport' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Delivery & Logistics', 'delivery-logistics', 'soma', NULL, 7, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
WHERE NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'delivery-logistics' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Lifestyle & Leisure', 'lifestyle-leisure', 'soma', NULL, 8, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
WHERE NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'lifestyle-leisure' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Work & Education', 'work-education', 'soma', NULL, 9, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
WHERE NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'work-education' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Digital Products & UI', 'digital-products-ui', 'soma', NULL, 10, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
WHERE NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'digital-products-ui' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Health & Fitness', 'health-fitness', 'soma', NULL, 11, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
WHERE NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'health-fitness' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Home & Living', 'home-living', 'soma', NULL, 12, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
WHERE NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'home-living' AND brand_scope IS NULL);

-- Shopping & Retail subcategories
INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'In-store browsing', 'in-store-browsing', 'soma', id, 1, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'shopping-retail' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'in-store-browsing' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Checkout & payment', 'checkout-payment', 'soma', id, 2, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'shopping-retail' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'checkout-payment' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Product display', 'product-display', 'soma', id, 3, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'shopping-retail' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'product-display' AND brand_scope IS NULL);

-- Food & Beverage subcategories
INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Café & coffee', 'cafe-coffee', 'soma', id, 1, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'food-beverage' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'cafe-coffee' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Restaurant dining', 'restaurant-dining', 'soma', id, 2, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'food-beverage' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'restaurant-dining' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Street food', 'street-food', 'soma', id, 3, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'food-beverage' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'street-food' AND brand_scope IS NULL);

-- Groceries subcategories
INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Supermarket aisles', 'supermarket-aisles', 'soma', id, 1, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'groceries' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'supermarket-aisles' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Fresh produce', 'fresh-produce', 'soma', id, 2, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'groceries' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'fresh-produce' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Checkout', 'groceries-checkout', 'soma', id, 3, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'groceries' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'groceries-checkout' AND brand_scope IS NULL);

-- Payments & Finance subcategories
INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Mobile payment', 'mobile-payment', 'soma', id, 1, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'payments-finance' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'mobile-payment' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Card tap', 'card-tap', 'soma', id, 2, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'payments-finance' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'card-tap' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Banking app', 'banking-app', 'soma', id, 3, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'payments-finance' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'banking-app' AND brand_scope IS NULL);

-- Cards subcategories
INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Card reveal', 'card-reveal', 'soma', id, 1, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'cards' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'card-reveal' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Card lifestyle', 'card-lifestyle', 'soma', id, 2, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'cards' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'card-lifestyle' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Card benefits', 'card-benefits', 'soma', id, 3, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'cards' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'card-benefits' AND brand_scope IS NULL);

-- Travel & Transport subcategories
INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Airport', 'airport', 'soma', id, 1, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'travel-transport' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'airport' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Train & transit', 'train-transit', 'soma', id, 2, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'travel-transport' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'train-transit' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Road trip', 'road-trip', 'soma', id, 3, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'travel-transport' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'road-trip' AND brand_scope IS NULL);

-- Delivery & Logistics subcategories
INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Package delivery', 'package-delivery', 'soma', id, 1, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'delivery-logistics' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'package-delivery' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Last-mile', 'last-mile', 'soma', id, 2, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'delivery-logistics' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'last-mile' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Courier', 'courier', 'soma', id, 3, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'delivery-logistics' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'courier' AND brand_scope IS NULL);

-- Lifestyle & Leisure subcategories
INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Social outings', 'social-outings', 'soma', id, 1, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'lifestyle-leisure' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'social-outings' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Entertainment', 'entertainment', 'soma', id, 2, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'lifestyle-leisure' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'entertainment' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Relaxation', 'relaxation', 'soma', id, 3, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'lifestyle-leisure' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'relaxation' AND brand_scope IS NULL);

-- Work & Education subcategories
INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Office & workspace', 'office-workspace', 'soma', id, 1, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'work-education' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'office-workspace' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Study & learning', 'study-learning', 'soma', id, 2, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'work-education' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'study-learning' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Collaboration', 'collaboration', 'soma', id, 3, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'work-education' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'collaboration' AND brand_scope IS NULL);

-- Digital Products & UI subcategories
INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'App walkthrough', 'app-walkthrough', 'soma', id, 1, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'digital-products-ui' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'app-walkthrough' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Dashboard', 'dashboard', 'soma', id, 2, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'digital-products-ui' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'dashboard' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Notification', 'notification', 'soma', id, 3, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'digital-products-ui' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'notification' AND brand_scope IS NULL);

-- Health & Fitness subcategories
INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Gym & workout', 'gym-workout', 'soma', id, 1, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'health-fitness' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'gym-workout' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Outdoor activity', 'outdoor-activity', 'soma', id, 2, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'health-fitness' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'outdoor-activity' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Wellness', 'wellness', 'soma', id, 3, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'health-fitness' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'wellness' AND brand_scope IS NULL);

-- Home & Living subcategories
INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Interior lifestyle', 'interior-lifestyle', 'soma', id, 1, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'home-living' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'interior-lifestyle' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Cooking at home', 'cooking-at-home', 'soma', id, 2, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'home-living' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'cooking-at-home' AND brand_scope IS NULL);

INSERT INTO broll_categories (name, slug, scope, parent_id, sort_order, created_at, updated_at)
SELECT 'Home improvement', 'home-improvement', 'soma', id, 3, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM broll_categories WHERE slug = 'home-living' AND brand_scope IS NULL
AND NOT EXISTS (SELECT 1 FROM broll_categories WHERE slug = 'home-improvement' AND brand_scope IS NULL);
