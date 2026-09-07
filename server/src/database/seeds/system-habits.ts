/**
 * AURA's own habits, seeded for every user at provisioning.
 *
 * These are the four things the product observes on the user's behalf rather than
 * asking them to tick off: `is_system` habits are logged from events (API_DESIGN.md
 * §11), so they accumulate whether or not the user ever opens a habits screen. They
 * exist from day one because a streak needs history, and history cannot be
 * backfilled after the fact.
 *
 * The titles are the copy the user sees. All four are stated as things to keep doing,
 * never as things not to fail at.
 */
export interface SystemHabitSeed {
  key: string;
  title: string;
  cadence: 'daily' | 'weekly' | 'custom';
  icon: string;
}

export const SYSTEM_HABITS: readonly SystemHabitSeed[] = [
  {
    key: 'meal_logging_consistency',
    title: 'Log what you eat',
    cadence: 'daily',
    icon: 'utensils',
  },
  { key: 'workout_consistency', title: 'Move your body', cadence: 'daily', icon: 'activity' },
  { key: 'sleep_consistency', title: 'Wind down at a steady time', cadence: 'daily', icon: 'moon' },
  { key: 'plan_adherence', title: 'Follow through on your day', cadence: 'daily', icon: 'target' },
] as const;
