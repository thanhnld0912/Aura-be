import { rankLocalMatches } from '../food-match.js';
import type { FoodRepository } from '../food-repository.js';
import { toCandidate } from '../food-repository.js';
import { tokenize } from '../normalize.js';
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

    // Three ways into the pool, one judge. The exact row, the trigram neighbours (typos,
    // run-together words) and every row sharing a whole word with the query — the last is
    // what lets "gà" be heard in "thịt gà". `rankLocalMatches` then decides what the
    // phrase means, including whether an "exact" hit really is one ("bò" is not "bơ").
    const [exact, fuzzy, byWord] = await Promise.all([
      this.repository.findExact(query, 'local'),
      this.repository.searchFuzzy(query, { limit: POOL_SIZE, provider: 'local' }),
      this.repository.searchByWords(tokenize(query), { limit: POOL_SIZE, provider: 'local' }),
    ]);

    const pool = [...(exact ? [exact] : []), ...fuzzy.map((hit) => hit.row), ...byWord];

    return rankLocalMatches(query, pool)
      .slice(0, limit)
      .map((ranked) => toCandidate(ranked.food, ranked.confidence, ranked.matchedBy));
  }

  async getById(foodId: string): Promise<FoodCandidate | null> {
    const row = await this.repository.findById(foodId);
    if (!row || row.provider !== 'local') return null;
    // Asked for by id, so identification is not in question.
    return toCandidate(row, 1, 'exact');
  }
}

/**
 * How many rows each retrieval path contributes. The local dataset is a few hundred rows,
 * so this is generous: ambiguity is judged from the pool, and a pool cut too short would
 * hide the second reading that makes a phrase ambiguous.
 */
const POOL_SIZE = 60;
