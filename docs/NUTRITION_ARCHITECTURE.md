# AURA — Nutrition Architecture

> Rule 6: nutrition data comes from a real database. The LLM identifies food; it never
> states calories.

---

## 1. The anti-pattern this design exists to prevent

```
❌  Photo → Claude → "850 calories"
```

Three things are wrong with it, and only the third is fatal:

1. It is inaccurate — LLMs approximate nutrition figures from training data.
2. It is unauditable — no source, no way to correct the underlying value.
3. **It is unfalsifiable and irreproducible.** The same plate photographed twice yields
   different numbers, and there is nothing to point at when a user says "that's wrong."

AURA's pipeline instead:

```
Photo / text
    ↓
Vision AI or text parser        →  WHAT the food is, and roughly how much
    ↓
FoodResolver                    →  match to a real food record
    ↓
PortionResolver                 →  household measure → grams
    ↓
NutritionCalculator             →  grams × per-100g values
    ↓
Confidence assembly             →  per item and per meal
    ↓
User confirmation               →  the user always outranks every provider
    ↓
Database (denormalised snapshot)
```

The model contributes only the first box. Everything downstream is data and arithmetic.

---

## 2. Provider interface

```ts
// server/src/nutrition/providers/nutrition-provider.ts
export interface NutritionProvider {
  readonly name: 'local' | 'usda' | 'off';
  readonly priority: number;              // lower wins
  readonly dataQuality: 'high' | 'medium' | 'low';

  search(query: string, opts: SearchOpts): Promise<FoodCandidate[]>;
  getById(externalId: string): Promise<FoodRecord | null>;
  getByBarcode?(barcode: string): Promise<FoodRecord | null>;
}

export interface FoodRecord {
  externalId: string;
  canonicalName: string;
  nameVi?: string;
  nameEn: string;
  category: string;
  per100g: { kcal: number; proteinG: number; carbsG: number;
             fatG: number; fiberG: number };
  micronutrients?: Record<string, number>;
  portions?: Array<{ label: string; labelVi?: string; grams: number }>;
  dataQuality: 'high' | 'medium' | 'low';
}
```

Three implementations register into a resolver chain:

| Provider | Priority | Covers | Why |
|---|---|---|---|
| `LocalFoodProvider` | **1** | Vietnamese dishes, household portions | The only source that knows what *cá kho tộ* is |
| `UsdaProvider` | 2 | Generic whole foods, ingredients | Authoritative, well-curated, free |
| `OpenFoodFactsProvider` | 3 | Packaged goods, drinks, snacks, **barcodes** | The only one with barcode coverage |

**Local is first, not last.** For the target user, most meals are Vietnamese home cooking.
Searching USDA for "thịt kho" returns nothing useful; searching it for "pork, braised"
returns a US-cut approximation of a dish cooked in caramel and fish sauce. Our own dataset is
the primary source, and the external APIs fill the long tail.

---

## 3. `LocalFoodProvider` — the Vietnamese food dataset

Rows in `foods` with `provider='local'`, seeded in Phase 3, authored rather than fetched.
Roughly 300 entries covering the realistic daily diet:

| Category | Examples |
|---|---|
| Cơm & tinh bột | cơm trắng, cơm tấm, xôi, bún, phở, miến, bánh mì |
| Món mặn | thịt kho tộ, cá kho, gà kho gừng, sườn ram, trứng chiên, tôm rim |
| Canh & lẩu | canh chua, canh rau ngót, canh bí đao, canh cải thịt bằm |
| Rau | rau muống xào tỏi, rau luộc, dưa leo, giá xào, salad |
| Món nước | phở bò, bún bò Huế, hủ tiếu, mì quảng, bún riêu |
| Ăn vặt & đồ uống | chè, bánh flan, cà phê sữa đá, trà đá, nước mía, sinh tố |

Each row carries `food_portions` in the units people actually use:

```
cơm trắng   1 chén      = 150 g      (default)
            1 chén đầy  = 200 g
            nửa chén    =  75 g
phở bò      tô nhỏ      = 400 g
            tô thường   = 500 g      (default)
            tô đặc biệt = 650 g
cá kho      1 khứa      =  80 g      (default)
canh        1 chén      = 200 g      (default)
```

**Household measures are the real unit of Vietnamese meal logging.** A user says
"2 chén cơm", never "300 grams of cooked rice". A nutrition system that only speaks grams
forces a conversion the user cannot perform, and the friction ends the logging habit.
`food_portions` is what makes `LogModal`'s existing portion chips
(`'Small' | '2 bowls' | 'Large'`) resolvable to real numbers.

Sources for the seed values: Vietnamese National Institute of Nutrition composition tables
where available, USDA equivalents for component ingredients otherwise. Every row records
`dataQuality`, and composed dishes are marked `medium` — an honest label for a recipe-dependent
estimate.

---

## 4. Resolution pipeline

```ts
// server/src/nutrition/food-resolver.ts
async function resolve(input: DetectedItem, userId: string): Promise<ResolvedItem>
```

Order of attempts, first success wins:

```
1. user_food_aliases           this user already corrected this exact phrase   → conf 1.00
2. exact match, local          normalised name hit in the VN dataset           → conf 0.95
3. fuzzy match, local          pg_trgm similarity ≥ 0.45 on unaccented text    → conf 0.70–0.90
4. cached foods                a previous USDA/OFF lookup for this term        → conf 0.85
5. USDA search                 top hit above relevance threshold               → conf 0.60–0.80
6. Open Food Facts search      packaged / branded fallback                     → conf 0.50–0.70
7. unresolved                  stored with kcal = null                         → conf 0.00
```

Step 1 is what makes AURA improve with use. When a user corrects "cơm mẹ nấu" to *cơm trắng*,
that alias is written, and every future log of that phrase resolves instantly at full
confidence. **This is personalisation without fine-tuning anything.**

Step 3 relies on `pg_trgm` over a diacritic-stripped column, so `thit kho`, `thịt kho` and
`thit-kho` all match. Vietnamese input arrives with inconsistent diacritics constantly —
particularly from voice transcription — and exact matching would fail most real input.

**Step 7 is the important one.** When nothing resolves, the item is stored with
`kcal: null`, `source: 'unresolved'`, and surfaced in the response's `unresolved[]` array.
The UI asks the user to identify it. AURA never fills the gap with a plausible number.

---

## 5. Portion resolution

```
quantity + unit + portionLabel  →  grams
```

| Input | Resolution |
|---|---|
| `2` `bowl` (food has portions) | `2 × food_portions['1 chén'].grams` = 300 g |
| `1` `serving` + `medium` | default portion × 1.0 |
| `1` `serving` + `small` / `large` | default × **0.7** / × **1.4** |
| `150` `g` | 150 g, confidence 1.0 |
| `1` `piece` (egg, banana) | `food_portions['1 quả'].grams` |
| unit unknown for this food | category default; confidence × 0.7 |

The small/medium/large multipliers (0.7 / 1.0 / 1.4) are a documented assumption, not a
measurement. They are stated here so they can be challenged and tuned rather than buried in
code, and any item resolved through them carries reduced confidence.

---

## 6. Confidence

Per item:

```
confidence = identification × portion × dataQuality
```

| Factor | Range | Meaning |
|---|---|---|
| identification | 0.3–1.0 | vision score, text-match score, or 1.0 if user-stated |
| portion | 0.5–1.0 | 1.0 explicit grams; 0.85 known household portion; 0.6 inferred size |
| dataQuality | 0.7–1.0 | local high = 1.0; composed dish = 0.85; OFF crowd data = 0.7 |

Meal confidence is the **sample-size-weighted minimum**, not the mean:

```ts
mealConfidence = min(itemConfidences) * 0.6 + avg(itemConfidences) * 0.4;
```

One badly-guessed item should visibly lower the whole meal's confidence. Averaging hides a
0.3 item behind three 0.9 items, and the user then trusts a total they should be checking.

Any item with `source='user'` is pinned to `1.0`. **The user is the highest-priority provider
in the system.**

### What the UI does with it

| Confidence | Presentation |
|---|---|
| ≥ 0.85 | shown plainly; "Looks right" is the primary action |
| 0.60–0.84 | soft "estimate" marker; edit affordance emphasised |
| < 0.60 | explicitly flagged; AURA asks rather than asserts |
| unresolved | no number at all; "Help me identify this?" |

---

## 7. Caching and rate limits

External providers are rate-limited and slow; both are cached into `foods` on first use.

| Provider | Limit | Cache TTL | Notes |
|---|---|---|---|
| USDA FDC | 1,000/hr per key | 90 days | `X-Api-Key` header; requires `USDA_API_KEY` |
| Open Food Facts | courtesy limit | 30 days | **Requires a descriptive `User-Agent`** identifying the app — anonymous clients get blocked |
| Local | — | never expires | authored data |

Cache warming: the top ~200 Vietnamese foods are pre-seeded, so a typical user's first week
resolves almost entirely from local data with **zero external calls**.

A network failure to USDA or OFF is not an error — the resolver falls through to the next
provider and finally to `unresolved`. Nutrition lookup never blocks meal logging.

---

## 8. The §10 stance — tracking without obsession

`GET /api/nutrition/daily` deliberately leads with behaviour, not calories:

```json
{ "focus":     { "vegetableServings": 3, "proteinServings": 2, "distinctFoods": 9,
                 "wholeFoodRatio": 0.78, "waterMl": 1500, "mealConsistency": "steady" },
  "nutrition": { "kcal": 1840, "isEstimate": true, "confidence": 0.81 },
  "disclaimer": "Estimates based on typical portions — adjust anything that looks off." }
```

- `focus` is always present and comes first in the payload.
- `nutrition` is **omitted entirely** when `preferences.showCalories = false` — the server does
  not send a number the user has asked not to see. Client-side hiding is not sufficient;
  a value that reaches the browser will eventually reach a UI surface.
- `isEstimate` is required by the schema and cannot be false.
- No goal weights, no deficits, no "remaining calories", no streak penalty for exceeding
  anything. The API vocabulary contains no concept of a calorie target.

Tracked as primary signals: meal variety, food groups, protein-containing meals, vegetable
servings, whole-food ratio, hydration, meal timing consistency.

---

## 9. Worked example

Input: `"Tôi ăn 2 chén cơm với thịt kho trứng và canh rau."`

```
Parse (Haiku 4.5) →
  [ {rice, 2, bowl}, {braised_pork, 1, serving, medium},
    {egg, 1, piece}, {vegetable_soup, 1, bowl, medium} ]

Resolve →
  cơm trắng          local exact    1 chén = 150 g  → 300 g   conf 0.95×1.00×1.00 = 0.95
  thịt kho           local exact    default = 100 g → 100 g   conf 0.95×0.85×0.85 = 0.69
  trứng gà           local exact    1 quả  =  50 g  →  50 g   conf 0.95×1.00×1.00 = 0.95
  canh rau (generic) local fuzzy    1 chén = 200 g  → 200 g   conf 0.72×0.85×0.85 = 0.52

Calculate →
  cơm      300 g × 130 kcal/100g = 390 kcal
  thịt kho 100 g × 285           = 285 kcal
  trứng     50 g × 155           =  78 kcal
  canh     200 g ×  22           =  44 kcal
  ─────────────────────────────────────────
  total                            797 kcal   protein 34 g   fiber 5 g

Meal confidence = min(0.52)×0.6 + avg(0.78)×0.4 = 0.62   → "estimate" marker shown
```

The soup drags meal confidence to 0.62, and correctly so: "canh rau" is genuinely ambiguous —
it could be any of a dozen dishes. The UI surfaces that, the user picks the specific one, an
alias is written, and next time it resolves at 0.95.

**That loop — ambiguity surfaced, user corrects, system learns — is the whole design.**

---

## 10. Phase 3 implementation notes

What shipped, and where the implementation decided something this document left open.

### The dataset, honestly

**183 foods and 299 portions**, not the ~300 §3 estimated. The shortfall is deliberate:
padding with variations to reach a round number is exactly what makes a food database
useless, and every row here is a distinct dish someone would actually log. The gap is real
work remaining, not a rounding error — see Known limitations in the Phase 3 report.

Provenance is a column, not a convention. `foods.source_reference` is required for every
local row and states the basis:

| `data_quality` | Rows | Basis |
|---|---|---|
| `high` | 64 | Single-ingredient foods whose composition is stable across sources; values consistent with USDA FoodData Central standard-reference entries |
| `medium` | 110 | Composed Vietnamese dishes, summed from a typical recipe's ingredients and divided by finished weight |
| `low` | 9 | Dishes and sweetened drinks whose recipe varies so widely the figure is an order of magnitude |

**These are not laboratory measurements**, and the dataset says so in the file header. They
have not been checked against the Vietnamese National Institute of Nutrition composition
tables, which is the right source for production and the obvious next improvement.

### Search

`foods.search_name` and `search_name_en` hold the diacritic-free forms. Normalisation runs
in TypeScript rather than SQL, because `unaccent()` is only STABLE and cannot honestly back
an index expression; `đ` needs an explicit rule, since NFD does not decompose it.

The query took two attempts. **Filtering uses `word_similarity`, ranking uses `similarity`.**
Plain similarity compares whole strings, so `similarity('com', 'com trang')` sits far below
any usable threshold and "cơm" found no rice at all. Ranking then prefers the shorter name,
which is how "rice" came to mean *cơm gà* — hence `foods.search_priority`, a curated
tiebreak applied only when the query matches as complete words.

### Portions

`ml` is treated as grams. Accurate for water-like liquids and the convention the per-100g
figures already assume; stated here rather than buried.

Fallback grams when a food has no portion for the requested unit: bowl 200, plate 250,
serving 150, piece 60. Applied only after the food's own portions have been tried, and
always at reduced confidence.

### Parsing

`MealParser` is an interface whose output type has **no field capable of holding a nutrition
value**. That is the boundary, and it is structural rather than advisory: whatever reads the
sentence — the rule-based parser today, Claude in Phase 4 — can say "two bowls of cơm" and
has no channel through which to assert that this is 390 kcal.

Phase 3 ships `RuleBasedMealParser`: deterministic, no model, no network, no key. It handles
quantities (digits, fractions, Vietnamese number words), household measures, size
adjectives, and the connectives that separate foods. Where it cannot read a fragment it
returns it in `ambiguous` rather than guessing.

One implementation detail worth recording: the connective split cannot use `\b`. JavaScript
word boundaries are ASCII-only, so `\bvà\b` never matches — `à` is not a word character to
the engine, leaving no boundary after it, and "cơm và trứng" stayed a single fragment.

### Calorie visibility

`showCalories: false` **omits the key from the payload** rather than nulling it. Energy is
`.optional()` in the response schema and the serializer only emits declared keys, so the
number never reaches the browser. Covered by a test that asserts the value appears nowhere
in the meal, daily or weekly responses.

### What AI does and does not do in Phase 3

Nothing. No model is called anywhere in this phase. The pipeline is parse → resolve →
calculate, and every step is deterministic and reproducible. Phase 4 replaces the parser and
adds vision *behind the same interfaces*, and inherits the same constraint.
