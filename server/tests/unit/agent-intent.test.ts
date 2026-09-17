import { describe, expect, it } from 'vitest';
import { classifyIntent, type AgentIntent, type AgentScope } from '../../src/agent/intent.js';

/**
 * Deterministic intent and scope (Task 8). The same message always selects the same
 * records, and a general question selects none.
 */

const cases: Array<[string, AgentIntent, AgentScope]> = [
  ['Hôm nay tôi đã ăn gì?', 'meals', { kind: 'day', day: 'today' }],
  ['hom nay toi an gi', 'meals', { kind: 'day', day: 'today' }],
  ['What did I eat today?', 'meals', { kind: 'day', day: 'today' }],
  ['Hôm nay tôi ăn bao nhiêu calo?', 'nutrition', { kind: 'day', day: 'today' }],
  ['Tuần này tôi hoàn thành kế hoạch như thế nào?', 'plan', { kind: 'week', week: 'this' }],
  ['Những ngày nào tôi thường bỏ bữa sáng?', 'patterns', { kind: 'week', week: 'this' }],
  ['Tuần này có pattern gì đáng chú ý?', 'patterns', { kind: 'week', week: 'this' }],
  ['Tôi có thể cải thiện việc duy trì thói quen như thế nào?', 'habits', { kind: 'week', week: 'this' }],
  ['Giải thích weekly summary của tôi.', 'weekly', { kind: 'week', week: 'this' }],
  ['Ngày hôm nay tôi còn việc gì trong kế hoạch?', 'plan', { kind: 'day', day: 'today' }],
  ['Hôm qua tôi tập gì?', 'activity', { kind: 'day', day: 'yesterday' }],
  ['How did I sleep last night?', 'activity', { kind: 'day', day: 'yesterday' }],
  ['Tâm trạng của tôi hôm nay thế nào?', 'checkins', { kind: 'day', day: 'today' }],
  ['Tuần trước của tôi thế nào?', 'weekly', { kind: 'week', week: 'last' }],
  ['Hôm nay của tôi thế nào?', 'today', { kind: 'day', day: 'today' }],
  ['Protein là gì?', 'general', { kind: 'none' }],
  ['Sleep có ảnh hưởng gì đến recovery?', 'general', { kind: 'none' }],
  ['Vì sao hydration quan trọng?', 'general', { kind: 'none' }],
  ['How to improve sleep?', 'general', { kind: 'none' }],
  ['Tôi thấy hơi mệt', 'general', { kind: 'none' }],
  ['asdf qwer', 'general', { kind: 'none' }],
];

describe('agent intent', () => {
  it.each(cases)('%s → %s', (message, intent, scope) => {
    const result = classifyIntent(message);
    expect(result.intent).toBe(intent);
    expect(result.scope).toEqual(scope);
  });

  it('keeps every topic it saw, so a meals-and-patterns question reads both', () => {
    expect(classifyIntent('Những ngày nào tôi thường bỏ bữa sáng?').topics).toEqual(['patterns', 'meals']);
  });

  it('is deterministic', () => {
    const message = 'Tuần này tôi ăn uống và tập luyện thế nào?';
    expect(classifyIntent(message)).toEqual(classifyIntent(message));
  });
});
