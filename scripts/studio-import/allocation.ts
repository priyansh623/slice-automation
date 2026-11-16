/**
 * The approved allocation of the 54 source images to the eight Scene Packs, with the confidence and review notes of the final
 * visual audit. The rule: if an identifiable SETTING exists it decides the primary pack; if none exists the ACTIVITY does.
 * Secondary concepts help search and recommendations and never create another pack membership.
 *
 * Nothing here describes a person. The stable reference IMG-001..IMG-054 follows the inventory order and is permanent.
 */
export interface PackDef { key: string; letter: string; name: string; description: string }

export const PACKS: PackDef[] = [
  { letter: 'A', key: 'cafes-restaurants-eating-out', name: 'Cafés, Restaurants & Eating Out', description: 'Cafés, restaurants, pizza outlets, a dessert parlour, a street tea stall and a tea-shop counter: meals, drinks, desserts, takeaway and paying.' },
  { letter: 'B', key: 'home-life', name: 'Home Life', description: 'Home kitchen, living-room sofa, bedroom and a decorated party room: cooking, relaxing, using a phone or laptop at home.' },
  { letter: 'C', key: 'workspace-laptop', name: 'Workspace & Laptop', description: 'Home or office desks and tables: laptop work, notebooks and phone use at a desk.' },
  { letter: 'D', key: 'gym-fitness', name: 'Gym & Fitness', description: 'Gym floor and machines: barbell row, barbell curl and lat pulldown.' },
  { letter: 'E', key: 'travel-outdoors', name: 'Travel & Outdoors', description: 'A roadside motorbike, a waterfall and a misty hill trail.' },
  { letter: 'F', key: 'lounge-relaxed-spaces', name: 'Lounge & Relaxed Spaces', description: 'Two lounges: a sunlit window lounge and a hotel-style lounge.' },
  { letter: 'G', key: 'plain-backdrop-portraits-talking-head', name: 'Plain Backdrop: Portraits & Talking Head', description: 'Neutral standing, selfie and microphone shots on plain walls.' },
  { letter: 'H', key: 'plain-backdrop-phone-payment-moments', name: 'Plain Backdrop: Phone & Payment Moments', description: 'Phone use, a card or app screen shown to camera, and a receipt moment.' },
];

export type Confidence = 'high' | 'medium' | 'low';
export interface Allocation {
  pack: string; secondary: string[]; confidence: Confidence; alt?: string; note?: string;
  /** Scene fields that replace the inventory's values where the inventory's setting is doubtful (the manifest builder applies them). */
  fields?: { environment?: string; description?: string };
}

const A = (pack: string, confidence: Confidence, secondary: string, extra: { alt?: string; note?: string; fields?: Allocation['fields'] } = {}): Allocation => ({ pack, confidence, secondary: secondary.split(',').map((s) => s.trim()).filter(Boolean), ...extra });

/** Keyed by "<source folder>/<file name>". */
export const ALLOCATION: Record<string, Allocation> = {
  '1/main_image.png': A('C', 'high', 'portrait, laptop, phone'),
  '1/cooking_at_home.png': A('B', 'high', 'kitchen, cooking, burgers'),
  '1/drinking_coffee.png': A('A', 'high', 'coffee, cafe table'),
  '1/eating_food.png': A('A', 'high', 'soup, dessert, dining'),
  '1/looking_at_phone.png': A('C', 'medium', 'phone, desk', { alt: 'H', note: 'Phone use at a desk; the desk is the identifiable setting.' }),
  '1/showing_phone.png': A('C', 'medium', 'card app, phone demo', { alt: 'H', note: 'App screen shown at a desk; the desk is the identifiable setting.' }),
  '1/working.png': A('C', 'high', 'laptop, typing'),
  '2/main_image.png': A('G', 'medium', 'selfie, phone', { note: 'Mirror selfie against a lit tiled wall; no identifiable setting.' }),
  '2/eating_icecream.png': A('A', 'high', 'dessert, night'),
  '2/eating_pizza.png': A('A', 'high', 'pizza, frappe'),
  '2/holding_pizzas.png': A('B', 'medium', 'takeaway, food delivery, party', {
    alt: 'A',
    note: 'Setting discrepancy: the inventory names a different setting, but the image looks like a decorated home or party room (garlands, balloons, a wall clock). Placed in Home Life; the setting is not confirmed, so it needs a human check.',
    fields: { environment: 'decorated room (home or party setting, to be confirmed)', description: 'A decorated room with marigold garlands, balloons and a wall clock, with a stack of pizza boxes being carried.' },
  }),
  '2/looking_at_empty_pocket.png': A('A', 'high', 'empty wallet, overspending'),
  '2/looking_at_phone.png': A('H', 'medium', 'phone', { note: 'Plain wall, no identifiable setting.' }),
  '2/paying_at_counter.png': A('A', 'medium', 'qr payment, cashless, tea shop', { note: 'Setting discrepancy: the inventory says retail counter; the image shows a cafe or tea-shop counter (cake fridge, tea menu).' }),
  '2/posing_for_food.png': A('A', 'high', 'restaurant meal, phone'),
  '2/showing_phone_to_screen.png': A('A', 'medium', 'card app, restaurant', { alt: 'H', note: 'App screen shown in a restaurant booth; the restaurant is the identifiable setting.' }),
  '3/main_image.png': A('G', 'high', 'neutral portrait'),
  '3/cooking.png': A('B', 'high', 'kitchen, noodles, steam'),
  '3/looking_at_phone.png': A('H', 'medium', 'phone', { note: 'Plain wall, no identifiable setting.' }),
  '3/scrolling_on_bed.png': A('B', 'high', 'bedroom, phone'),
  '3/showing_card.png': A('H', 'high', 'card, brand card'),
  '4/main_image.png': A('G', 'high', 'neutral portrait'),
  '4/looking_at_bill.png': A('H', 'high', 'receipt, bill shock'),
  '4/showing_slice_card.png': A('H', 'high', 'card, brand card'),
  '4/using_phone.png': A('H', 'medium', 'app screen, from behind', { note: 'Seen from behind, no identifiable setting; face not visible.' }),
  '5/main_image.png': A('G', 'high', 'neutral portrait'),
  '5/bench_pressing.png': A('D', 'high', 'barbell row, from behind', { note: 'Filename does not match the content (a bent-over barbell row).' }),
  '5/holding_a_mic.png': A('G', 'medium', 'talking to camera, microphone'),
  '5/lifting_dumbell.png': A('D', 'high', 'barbell curl', { note: 'Filename does not match the content (a barbell curl).' }),
  '5/rod_pulling.png': A('D', 'high', 'lat pulldown, cable machine'),
  '5/showing_card.png': A('H', 'high', 'card, brand card'),
  '5/showing_phone.png': A('H', 'high', 'app screen, brand ui'),
  '5/using_phone.png': A('H', 'medium', 'phone', { note: 'Plain wall, no identifiable setting.' }),
  '6/main_image.png': A('G', 'high', 'talking to camera, explainer'),
  '6/drinking_coffee.png': A('B', 'medium', 'sofa, laptop, coffee', { alt: 'C', note: 'A living-room sofa is the identifiable setting; laptop work is the activity.' }),
  '6/on_a_bike.png': A('E', 'medium', 'motorbike, road trip', { note: 'The inventory says riding; the motorbike is parked.' }),
  '6/talking_on_a_phone.png': A('H', 'medium', 'phone call', { note: 'Plain room, no identifiable setting.' }),
  '7/main_image.png': A('F', 'medium', 'relaxing, window view', { alt: 'E', note: 'Sunlit lounge with a view of pine trees.' }),
  '7/at_a_tapri.png': A('A', 'medium', 'street food, tea stall, regional signage', { alt: 'E', note: 'Street tea stall with non-English signage.' }),
  '7/holding_mic.png': A('F', 'high', 'talking to camera, microphone'),
  '7/near_a_waterfall.png': A('E', 'high', 'waterfall, trekking pole, nature'),
  '7/showing_credit_card.png': A('F', 'medium', 'card, brand card', { alt: 'H', note: 'Card shown in a lounge; the lounge is the identifiable setting.' }),
  '7/trekking.png': A('E', 'high', 'hill trail, fog'),
  '8/main_image.png': A('F', 'high', 'phone, lounge'),
  '8/holding_a_mic.png': A('F', 'high', 'talking to camera, microphone'),
  '8/scrolling_on_phone.png': A('A', 'high', 'cafe, pastry display, phone'),
  '8/showing_credit_card.png': A('A', 'medium', 'cafe, coworking, card', { alt: 'C', note: 'Same venue as IMG-015 (lattice ceiling, marble counter).' }),
  '8/showing_phone.png': A('F', 'medium', 'card app, lounge', { alt: 'H', note: 'App screen shown in a lounge; the lounge is the identifiable setting.' }),
  '8/working_on_laptop.png': A('C', 'high', 'laptop, notebooks, office', { note: 'Setting discrepancy: the inventory says home desk; the image shows an office-style desk.' }),
  '9/main_image.png': A('G', 'high', 'neutral portrait'),
  '9/relaxing_on_sofa.png': A('B', 'high', 'sofa, phone, relaxing'),
  '9/showing_card.png': A('H', 'high', 'card, brand card'),
  '9/watching_phone.png': A('H', 'medium', 'phone', { note: 'Plain wall, no identifiable setting.' }),
  '9/working_on_laptop.png': A('C', 'medium', 'laptop, cafe table', { alt: 'A', note: 'Setting discrepancy: the inventory says home desk; the image shows a polished table by a leather banquette (cafe-like).' }),
};
