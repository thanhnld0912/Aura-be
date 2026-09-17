import type { SafetyCategory } from '../ai/safety/index.js';

/**
 * What the agent says when the safety gate stops a message — written by people, not by a
 * model.
 *
 * A message that reads as a crisis, a request to restrict or purge, or a request for a
 * diagnosis or a dose is **not sent to the model** (SECURITY.md §7). The person gets a
 * short, kind, fixed reply instead: no advice, no detail, no judgement, and a pointer to a
 * person who can help. Nothing here names the category that matched, so the reply cannot
 * be used to probe the classifier.
 *
 * 115 is Vietnam's emergency medical number. The English text names no number, because
 * an English reader may be anywhere.
 */

export type SafetyReplyKind = 'support' | 'boundary';

type Locale = 'vi' | 'en';

const REPLIES: Record<SafetyCategory, { kind: SafetyReplyKind; text: Record<Locale, string> }> = {
  sensitive_crisis: {
    kind: 'support',
    text: {
      vi: 'Mình rất tiếc khi bạn đang phải trải qua cảm giác này, và bạn không phải một mình đối mặt với nó. Hãy nói chuyện ngay với một người bạn tin tưởng hoặc một chuyên gia tâm lý. Nếu bạn đang gặp nguy hiểm ngay lúc này, hãy gọi cấp cứu 115 hoặc đến cơ sở y tế gần nhất.',
      en: "I'm really sorry you're going through this, and you don't have to face it alone. Please reach out to someone you trust or a mental health professional now. If you are in immediate danger, contact your local emergency services or go to the nearest emergency department.",
    },
  },
  unsafe_food_behavior: {
    kind: 'support',
    text: {
      vi: 'Mình không thể hướng dẫn những cách ăn uống hoặc kiểm soát cân nặng có thể gây hại cho bạn. Nếu chuyện ăn uống hay cân nặng đang làm bạn căng thẳng, trò chuyện với bác sĩ hoặc chuyên gia dinh dưỡng có thể giúp. Mình luôn sẵn sàng cùng bạn giữ những bữa ăn đều đặn và thói quen bền vững.',
      en: "I can't help with ways of eating or controlling weight that could hurt you. If food or weight is weighing on you, talking with a doctor or a dietitian can really help. I'm glad to help you keep regular meals and routines that last.",
    },
  },
  unsafe_health_request: {
    kind: 'support',
    text: {
      vi: 'Mình không thể chẩn đoán, kê thuốc hay tư vấn liều dùng. Hãy trao đổi với bác sĩ hoặc dược sĩ về triệu chứng hay thuốc của bạn. Nếu triệu chứng nghiêm trọng hoặc xuất hiện đột ngột, như đau ngực hay khó thở, hãy gọi cấp cứu 115 ngay.',
      en: "I can't diagnose, prescribe or advise on doses. Please talk with a doctor or pharmacist about your symptoms or medication. If symptoms are severe or sudden, such as chest pain or trouble breathing, contact emergency services right away.",
    },
  },
  prompt_injection: {
    kind: 'boundary',
    text: {
      vi: 'Mình tập trung vào sức khỏe, dinh dưỡng, vận động và thói quen trong AURA. Bạn có thể hỏi mình về bữa ăn, kế hoạch hoặc tuần của bạn.',
      en: 'I focus on health, nutrition, movement and habits in AURA. You can ask me about your meals, your plan or your week.',
    },
  },
  off_topic_misuse: {
    kind: 'boundary',
    text: {
      vi: 'Mình tập trung vào sức khỏe, dinh dưỡng, vận động và thói quen trong AURA. Bạn có thể hỏi mình về bữa ăn, kế hoạch hoặc tuần của bạn.',
      en: 'I focus on health, nutrition, movement and habits in AURA. You can ask me about your meals, your plan or your week.',
    },
  },
};

export function safetyReply(category: SafetyCategory, locale: Locale): { kind: SafetyReplyKind; text: string } {
  const reply = REPLIES[category];
  return { kind: reply.kind, text: reply.text[locale] };
}

export function disabledReply(locale: Locale): string {
  return locale === 'vi'
    ? 'Tính năng trò chuyện với AI đang tắt trong cài đặt của bạn. Bạn có thể bật lại trong phần tùy chọn.'
    : 'AI features are turned off in your settings. You can turn them back on in your preferences.';
}
