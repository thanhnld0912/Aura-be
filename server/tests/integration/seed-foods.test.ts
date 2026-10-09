import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedFoods } from '../../src/database/seeds/seed-foods.js';
import { VN_FOODS, type SeedFood } from '../../src/database/seeds/vn-foods/index.js';
import type { PortionDefinition } from '../../src/nutrition/types.js';
import { createDatabaseHarness, hasDatabase, testUserId, type DatabaseHarness } from '../helpers/database.js';

/**
 * Portion identity across re-seeds.
 *
 * The regression this guards: the seed used to delete every portion of a food and insert
 * the set again, so each run gave every portion a new id. `meal_items.portion_id` is
 * `ON DELETE SET NULL`, so every deploy that ran the seed quietly erased which portion each
 * logged meal had been measured in. A re-seed must now keep the id of every portion that is
 * still the same portion, and never delete one a meal may point at.
 */

const FOOD_ID = 'test-seed-rice';

const portion = (label: string, grams: number, extra: Partial<PortionDefinition> = {}): PortionDefinition => ({
  label,
  grams,
  ...extra,
});

const testFood = (portions: PortionDefinition[]): SeedFood => ({
  externalId: FOOD_ID,
  nameVi: 'cơm thử nghiệm',
  nameEn: 'test rice',
  category: 'rice_grain',
  per100g: { kcal: 130, proteinG: 2.7, carbsG: 28, fatG: 0.3, fiberG: 0.4 },
  dataQuality: 'high',
  sourceReference: 'Test fixture: a stand-in food for the portion identity tests',
  portions,
});

const BASE = [
  portion('half bowl', 75, { labelVi: 'nửa chén' }),
  portion('1 bowl', 150, { labelVi: '1 chén', isDefault: true }),
  portion('large bowl', 300, { labelVi: '1 tô' }),
];

describe.skipIf(!hasDatabase)('food seed — portion identity', () => {
  let harness: DatabaseHarness;
  const userId = testUserId('a');

  beforeAll(async () => {
    harness = await createDatabaseHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  const seed = (dataset: readonly SeedFood[]) => seedFoods(harness.database.db, dataset);

  /** The test food's portions, by label. */
  const portionsOf = async (externalId = FOOD_ID) => {
    const rows = await harness.sql<{ id: string; label: string; labelVi: string | null; grams: string; isDefault: boolean }[]>`
      select fp.id, fp.label, fp.label_vi as "labelVi", fp.grams::text as grams, fp.is_default as "isDefault"
      from food_portions fp join foods f on f.id = fp.food_id
      where f.provider = 'local' and f.external_id = ${externalId}
      order by fp.label`;
    return new Map(rows.map((row) => [row.label, row]));
  };

  /** A draft meal with one item measured in the given portion: the history a re-seed must keep. */
  const logMealIn = async (portionId: string) => {
    await harness.sql`insert into users (id, email) values (${userId}, 'seed@example.com') on conflict do nothing`;
    const [meal] = await harness.sql<{ id: string }[]>`
      insert into meals (user_id, meal_type) values (${userId}, 'lunch') returning id`;
    const [item] = await harness.sql<{ id: string }[]>`
      insert into meal_items (meal_id, food_id, portion_id, detected_name, quantity, unit, grams_resolved,
                              portion_label, kcal, protein_g, carbs_g, fat_g, fiber_g, source, confidence)
      select ${meal!.id}, fp.food_id, fp.id, 'cơm', 1, 'bowl', fp.grams, 'medium', 195, 4.05, 42, 0.45, 0.6, 'local', 0.85
      from food_portions fp where fp.id = ${portionId}
      returning id`;
    return item!.id;
  };

  /** Everything a logged item records: its portion link and its nutrition snapshot. */
  const itemState = async (itemId: string) => {
    type ItemState = {
      portionId: string | null; foodId: string | null; quantity: string; unit: string; grams: string | null;
      portionLabel: string | null; kcal: string | null; protein: string | null; carbs: string | null;
      fat: string | null; fiber: string | null;
    };
    const [row] = await harness.sql<ItemState[]>`
      select portion_id as "portionId", food_id as "foodId", quantity::text as quantity, unit::text as unit,
             grams_resolved::text as grams, portion_label::text as "portionLabel", kcal::text as kcal,
             protein_g::text as protein, carbs_g::text as carbs, fat_g::text as fat, fiber_g::text as fiber
      from meal_items where id = ${itemId}`;
    return row!;
  };

  const foodIds = () => harness.sql<{ id: string; externalId: string }[]>`
    select id, external_id as "externalId" from foods where provider = 'local' order by external_id`;

  it('A: seeds the full dataset — every food and every portion', async () => {
    const result = await seed(VN_FOODS);
    const expectedPortions = VN_FOODS.reduce((sum, food) => sum + food.portions.length, 0);

    const [counts] = await harness.sql<{ foods: number; portions: number }[]>`
      select (select count(*) from foods where provider = 'local')::int as foods,
             (select count(*) from food_portions)::int as portions`;
    expect(counts).toEqual({ foods: VN_FOODS.length, portions: expectedPortions });
    expect(result).toMatchObject({
      foodsUpserted: VN_FOODS.length,
      portionsInserted: expectedPortions,
      portionsUpdated: 0,
      portionsUnchanged: 0,
      portionsRetained: 0,
    });
  });

  it('B: a second run of the same dataset keeps every food and portion id and adds no rows', async () => {
    await seed(VN_FOODS);
    const foodsBefore = await foodIds();
    const before = await harness.sql<{ id: string; key: string }[]>`
      select fp.id, f.external_id || '/' || fp.label as key from food_portions fp join foods f on f.id = fp.food_id order by 2`;

    const again = await seed(VN_FOODS);
    const after = await harness.sql<{ id: string; key: string }[]>`
      select fp.id, f.external_id || '/' || fp.label as key from food_portions fp join foods f on f.id = fp.food_id order by 2`;

    expect(await foodIds()).toEqual(foodsBefore);
    expect(after).toEqual(before);
    expect(again).toMatchObject({ portionsInserted: 0, portionsUpdated: 0, portionsUnchanged: before.length, portionsRetained: 0 });
  });

  it('C: a re-seed leaves a logged meal pointing at the portion it was measured in', async () => {
    await seed([testFood(BASE)]);
    const bowl = (await portionsOf()).get('1 bowl')!;
    const itemId = await logMealIn(bowl.id);
    const loggedBefore = await itemState(itemId);

    await seed([testFood(BASE)]);
    await seed(VN_FOODS.concat(testFood(BASE)));

    expect(await itemState(itemId)).toEqual(loggedBefore);
    expect(loggedBefore.portionId).toBe(bowl.id);
    expect((await portionsOf()).get('1 bowl')?.id).toBe(bowl.id);
  });

  it('D: a corrected portion is updated in place, keeping its id and its meals', async () => {
    await seed([testFood(BASE)]);
    const bowl = (await portionsOf()).get('1 bowl')!;
    const itemId = await logMealIn(bowl.id);

    // Same portion (the label differs only in case), with a corrected figure and wording.
    const corrected = [BASE[0]!, portion('1 Bowl', 160, { labelVi: '1 chén cơm', isDefault: true }), BASE[2]!];
    const result = await seed([testFood(corrected)]);

    const updated = (await portionsOf()).get('1 Bowl')!;
    expect(updated).toEqual({ id: bowl.id, label: '1 Bowl', labelVi: '1 chén cơm', grams: '160.00', isDefault: true });
    expect(result).toMatchObject({ portionsInserted: 0, portionsUpdated: 1, portionsUnchanged: 2 });
    // The meal keeps the portion and the nutrition it was logged with — nothing is recalculated.
    expect(await itemState(itemId)).toMatchObject({
      portionId: bowl.id,
      grams: '150.00',
      portionLabel: 'medium',
      kcal: '195.00',
      protein: '4.05',
      carbs: '42.00',
      fat: '0.45',
      fiber: '0.60',
    });
  });

  it('E: a new portion is inserted once, however many times the seed runs', async () => {
    await seed([testFood(BASE)]);
    const idsBefore = new Map([...(await portionsOf())].map(([label, row]) => [label, row.id]));
    const withPlate = [...BASE, portion('1 plate', 200, { labelVi: '1 đĩa' })];

    const first = await seed([testFood(withPlate)]);
    const second = await seed([testFood(withPlate)]);

    const portions = await portionsOf();
    expect([...portions.keys()].sort()).toEqual(['1 bowl', '1 plate', 'half bowl', 'large bowl']);
    for (const [label, id] of idsBefore) expect(portions.get(label)?.id, label).toBe(id);
    expect(first).toMatchObject({ portionsInserted: 1, portionsUnchanged: 3 });
    expect(second).toMatchObject({ portionsInserted: 0, portionsUnchanged: 4 });
  });

  it('F: refuses a dataset that names one portion twice, and writes nothing', async () => {
    const duplicated = [...BASE, portion('1  BOWL', 155)];
    await expect(seed([testFood(duplicated)])).rejects.toThrow(/duplicate portion/);

    const [counts] = await harness.sql<{ foods: number; portions: number }[]>`
      select (select count(*) from foods)::int as foods, (select count(*) from food_portions)::int as portions`;
    expect(counts).toEqual({ foods: 0, portions: 0 });
  });

  it('F: refuses to choose between two existing rows for one portion, and rolls back', async () => {
    await seed([testFood(BASE)]);
    const bowl = (await portionsOf()).get('1 bowl')!;
    // Two rows a historical meal could mean — the seed must not pick one.
    await harness.sql`
      insert into food_portions (food_id, label, grams)
      select food_id, '1 BOWL', 150 from food_portions where id = ${bowl.id}`;

    const changed = [BASE[0]!, BASE[1]!, portion('large bowl', 320, { labelVi: '1 tô' })];
    await expect(seed([testFood(changed)])).rejects.toThrow(/more than one "1 (bowl|BOWL)" portion/);

    // Nothing from the failed run landed: the other portion keeps its old figure.
    const portions = await harness.sql<{ label: string; grams: string }[]>`
      select fp.label, fp.grams::text as grams from food_portions fp order by fp.label`;
    expect(portions).toEqual([
      { label: '1 BOWL', grams: '150.00' },
      { label: '1 bowl', grams: '150.00' },
      { label: 'half bowl', grams: '75.00' },
      { label: 'large bowl', grams: '300.00' },
    ]);
  });

  it('rolls back every food when a later food fails partway through the run', async () => {
    const second: SeedFood = { ...testFood(BASE), externalId: 'test-seed-noodles', nameVi: 'mì thử nghiệm', nameEn: 'test noodles' };
    await seed([testFood(BASE), second]);
    // The second food is made ambiguous, so the run fails after the first food's changes were queued.
    await harness.sql`
      insert into food_portions (food_id, label, grams)
      select f.id, 'Half Bowl', 75 from foods f where f.external_id = 'test-seed-noodles'`;

    const firstChanged = testFood([BASE[0]!, portion('1 bowl', 175, { labelVi: '1 chén', isDefault: true }), BASE[2]!]);
    await expect(seed([firstChanged, second])).rejects.toThrow(/test-seed-noodles/);

    // The first food's correction did not land: one transaction, all or nothing.
    expect((await portionsOf()).get('1 bowl')?.grams).toBe('150.00');
  });

  it('G: a portion that leaves the dataset is kept, with its meals, and stops being the default', async () => {
    await seed([testFood(BASE)]);
    const bowl = (await portionsOf()).get('1 bowl')!;
    const itemId = await logMealIn(bowl.id);

    // The new dataset drops "1 bowl" and makes the large bowl the default.
    const without = [BASE[0]!, portion('large bowl', 300, { labelVi: '1 tô', isDefault: true })];
    const first = await seed([testFood(without)]);
    const second = await seed([testFood(without)]);

    const portions = await portionsOf();
    expect(portions.get('1 bowl')).toMatchObject({ id: bowl.id, grams: '150.00', isDefault: false });
    expect([...portions.values()].filter((row) => row.isDefault).map((row) => row.label)).toEqual(['large bowl']);
    expect(await itemState(itemId)).toMatchObject({ portionId: bowl.id });
    expect(first).toMatchObject({ portionsRetained: 1, portionsUpdated: 1 });
    expect(second).toMatchObject({ portionsRetained: 1, portionsUpdated: 0, portionsInserted: 0 });
  });

  it('serialises concurrent runs, so two deploys racing cannot duplicate a portion', async () => {
    await Promise.all([seed([testFood(BASE)]), seed([testFood(BASE)])]);

    const [counts] = await harness.sql<{ foods: number; portions: number }[]>`
      select (select count(*) from foods)::int as foods, (select count(*) from food_portions)::int as portions`;
    expect(counts).toEqual({ foods: 1, portions: 3 });
  });
});
