import type { FastifyInstance } from 'fastify';
import type { Env } from '../config/env.js';
import type { Database } from '../database/client.js';
import { registerAuth } from '../modules/auth/auth.plugin.js';
import { authRoutes } from '../modules/auth/auth.routes.js';
import { AuthService } from '../modules/auth/auth.service.js';
import { createJwtVerifier } from '../modules/auth/jwt.js';
import {
  createSupabaseAuthClient,
  type SupabaseAuthClient,
} from '../modules/auth/supabase-auth-client.js';
import { checkinsRoutes } from '../modules/checkins/checkins.routes.js';
import { CheckinsRepository } from '../modules/checkins/checkins.repository.js';
import { CheckinsService } from '../modules/checkins/checkins.service.js';
import { DailyEventsRepository } from '../modules/daily-events/daily-events.repository.js';
import { dailyEventsRoutes } from '../modules/daily-events/daily-events.routes.js';
import {
  DailyEventsService,
  type DayRefresher,
} from '../modules/daily-events/daily-events.service.js';
import { DailyPlansRepository } from '../modules/daily-plans/daily-plans.repository.js';
import { dailyPlansRoutes } from '../modules/daily-plans/daily-plans.routes.js';
import { DailyPlansService } from '../modules/daily-plans/daily-plans.service.js';
import { healthRoutes } from '../modules/health/health.routes.js';
import { MealsRepository } from '../modules/meals/meals.repository.js';
import { mealsRoutes } from '../modules/meals/meals.routes.js';
import { MealsService } from '../modules/meals/meals.service.js';
import { nutritionRoutes } from '../modules/nutrition/nutrition.routes.js';
import { FoodRepository } from '../nutrition/food-repository.js';
import { FoodResolver } from '../nutrition/food-resolver.js';
import { RuleBasedMealParser } from '../nutrition/parser/rule-based-parser.js';
import { LocalFoodProvider } from '../nutrition/providers/local-food-provider.js';
import { OpenFoodFactsProvider } from '../nutrition/providers/open-food-facts-provider.js';
import { UsdaProvider } from '../nutrition/providers/usda-provider.js';
import type { NutritionProvider } from '../nutrition/types.js';
import { DailySummariesRepository } from '../modules/summaries/daily-summaries.repository.js';
import { DayService } from '../modules/summaries/day.service.js';
import { UsersRepository } from '../modules/users/users.repository.js';
import { usersRoutes } from '../modules/users/users.routes.js';
import { UsersService } from '../modules/users/users.service.js';

/**
 * The `/api` surface and the composition root for the modules behind it.
 *
 * Each module is a Fastify plugin, which is what gives the modular monolith its
 * boundaries: routes, schemas and hooks are encapsulated, so extracting a module later
 * means moving a directory rather than untangling shared middleware
 * (ARCHITECTURE.md §5).
 *
 * Wiring order encodes the dependency graph. `DailyEventsService` receives the day
 * refresher as a **thunk**, because `DayService` needs the events service in turn —
 * reading events is how it reconciles. The lazy accessor breaks that cycle without a
 * setter, and every other edge is a plain constructor argument.
 */
export interface RouteDependencies {
  env: Env;
  database: Database;
  /** Injected by tests so sign-out does not reach the network. */
  supabaseAuth?: SupabaseAuthClient;
}

export async function registerRoutes(
  app: FastifyInstance,
  options: RouteDependencies,
): Promise<void> {
  const { env, database } = options;
  const db = database.db;

  // ── Repositories ────────────────────────────────────────────────────────────
  const usersRepository = new UsersRepository(db);
  const eventsRepository = new DailyEventsRepository(db);
  const plansRepository = new DailyPlansRepository(db);
  const summariesRepository = new DailySummariesRepository(db);
  const checkinsRepository = new CheckinsRepository(db);
  const mealsRepository = new MealsRepository(db);
  const foodRepository = new FoodRepository(db);

  // ── Services ────────────────────────────────────────────────────────────────
  const usersService = new UsersService(usersRepository);

  // Declared before it is constructed so the thunks below can close over it.
  let dayService: DayService;
  const dayRefresher: DayRefresher = {
    async refresh(userId, localDate, timeZone) {
      await dayService.refresh(userId, localDate, timeZone);
    },
  };

  const eventsService = new DailyEventsService(eventsRepository, () => dayRefresher);
  const plansService = new DailyPlansService(plansRepository, eventsService);
  dayService = new DayService(plansService, eventsService, summariesRepository);

  const checkinsService = new CheckinsService(checkinsRepository, () => dayRefresher);

  /**
   * The provider chain (NUTRITION_ARCHITECTURE.md §2). Local is always present; the
   * external providers register only when configured, because a provider with no key
   * that fails every call is worse than one that is honestly absent.
   */
  const providers: NutritionProvider[] = [new LocalFoodProvider(foodRepository)];
  if (env.USDA_API_KEY) {
    providers.push(
      new UsdaProvider({ apiKey: env.USDA_API_KEY, baseUrl: env.USDA_BASE_URL }, foodRepository),
    );
  }
  if (env.OPEN_FOOD_FACTS_USER_AGENT) {
    providers.push(
      new OpenFoodFactsProvider(
        { baseUrl: env.OPEN_FOOD_FACTS_BASE_URL, userAgent: env.OPEN_FOOD_FACTS_USER_AGENT },
        foodRepository,
      ),
    );
  }

  const foodResolver = new FoodResolver({ providers, repository: foodRepository });
  const mealsService = new MealsService({
    repository: mealsRepository,
    resolver: foodResolver,
    foods: foodRepository,
    events: eventsService,
    getDayRefresher: () => dayRefresher,
    // Phase 3 ships the deterministic parser; the Claude implementation plugs in here
    // behind the same interface in Phase 4.
    parser: new RuleBasedMealParser(),
  });

  const jwtVerifier = createJwtVerifier({
    // Supabase issues tokens under `<project>/auth/v1`.
    issuer: new URL('/auth/v1', env.SUPABASE_URL).toString(),
    secret: env.SUPABASE_JWT_SECRET,
    jwksUri: new URL('/auth/v1/.well-known/jwks.json', env.SUPABASE_URL).toString(),
  });
  const authService = new AuthService(jwtVerifier, usersService);

  const supabaseAuth =
    options.supabaseAuth ??
    createSupabaseAuthClient({
      supabaseUrl: env.SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    });

  registerAuth(app, authService);

  // ── Routes ──────────────────────────────────────────────────────────────────
  await app.register(healthRoutes, { database });
  await app.register(authRoutes, { prefix: '/auth', authService, supabaseAuth });
  await app.register(usersRoutes, { prefix: '/users', usersService });
  await app.register(dailyPlansRoutes, { prefix: '/daily-plan', plansService });
  await app.register(dailyEventsRoutes, { prefix: '/events', eventsService });
  await app.register(checkinsRoutes, { prefix: '/checkins', checkinsService });
  await app.register(mealsRoutes, { prefix: '/meals', mealsService, usersService });
  await app.register(nutritionRoutes, {
    prefix: '/nutrition',
    providers,
    foods: foodRepository,
    resolver: foodResolver,
    mealsRepository,
    usersService,
  });

  /**
   * Still to come, with their phases: `meals` and `nutrition` in Phase 3, `agent` in
   * Phase 4, `patterns` and `insights` in Phase 5, `groups` in Phase 8.
   */
}
