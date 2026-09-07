import type { FoodRepository } from '../food-repository.js';
import { toCandidate } from '../food-repository.js';
import { tokenOverlap } from '../normalize.js';
import type { FoodCandidate, NutritionProvider, SearchOptions } from '../types.js';

/**
 * The Vietnamese dataset, and the reason the whole provider chain is ordered the way it
 * is (NUTRITION_ARCHITECTURE.md §2).
 *
 * Local is **first, not last**. For the target user most meals are Vietnamese home
 * cooking: searching USDA for "thịt kho" returns nothing useful, and searching it for
 * "pork, braised" returns a US-cut approximation of a dish cooked in caramel and fish
 * sauce. The external providers fill the long tail; this one carries the everyday case.
 *
 * It is also the only provider that cannot fail on a network — which is why meal logging
 * keeps working when USDA is down.
 */
export class LocalFoodProvider implements NutritionProvider {
  readonly name = 'local' as const;
  readonly priority = 1;
  readonly dataQuality = 'high' as const;

  constructor(private readonly repository: FoodRepository) {}

  async search(query: string, options: SearchOptions = {}): Promise<FoodCandidate[]> {
    const limit = options.limit ?? 10;

    // An exact hit on the normalised name is the fast path and outranks everything.
    const exact = await this.repository.findExact(query, 'local');
    const candidates: FoodCandidate[] = exact ? [toCandidate(exact, 0.95, 'exact')] : [];

    const fuzzy = await this.repository.searchFuzzy(query, { limit: limit + 5, provider: 'local' });

    for (const { row, similarity } of fuzzy) {
      if (exact && row.id === exact.id) continue;

      // Trigram similarity decides *whether* something matches; token overlap breaks ties
      // between things that do. "com tam" against "Cơm tấm sườn bì chả" scores poorly on
      // trigrams over the whole string but is obviously the right family.
      const overlap = tokenOverlap(query, `${row.nameVi ?? ''} ${row.nameEn}`);
      const blended = similarity * 0.7 + overlap * 0.3;

      // §4 step 3: a fuzzy local hit sits between 0.70 and 0.90 — never as high as exact.
      candidates.push(toCandidate(row, clampFuzzy(blended), 'fuzzy'));
    }

    return candidates.sort((a, b) => b.matchConfidence - a.matchConfidence).slice(0, limit);
  }

  async getById(foodId: string): Promise<FoodCandidate | null> {
    const row = await this.repository.findById(foodId);
    if (!row || row.provider !== 'local') return null;
    // Asked for by id, so identification is not in question.
    return toCandidate(row, 1, 'exact');
  }
}

function clampFuzzy(score: number): number {
  const bounded = Math.min(0.9, Math.max(0.7, score));
  return Math.round(bounded * 1000) / 1000;
}
