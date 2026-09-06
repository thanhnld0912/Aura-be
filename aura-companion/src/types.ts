export type TabType = 'today' | 'insights' | 'history' | 'crew' | 'ai-coach';

export type ActivityCategory = 'eat' | 'workout' | 'walk' | 'water' | 'sleep' | 'check-in' | 'other';

export interface FoodItem {
  id: string;
  name: string;
  vietnameseName: string;
  icon: string;
  defaultPortion: string;
  portionOptions: string[];
  selectedPortion: string;
  subOptionLabel?: string;
  subOptions?: string[];
  selectedSubOption?: string;
  tagColor?: 'primary' | 'secondary' | 'neutral';
}

export interface MealLogDraft {
  category: ActivityCategory;
  rawInput: string;
  translation: string;
  mealType: string;
  time: string;
  tag: string;
  foods: FoodItem[];
  carbs: number;
  protein: number;
  fiberLevel: string;
  estCalories: number;
  mindfulNote: string;
}

export interface TimelineEvent {
  id: string;
  time: string;
  title: string;
  statusBadge?: string;
  statusType?: 'warning' | 'neutral' | 'success' | 'urgent';
  description: string;
  extraPill?: {
    icon: string;
    text: string;
  };
  tags?: string[];
  note?: {
    title: string;
    content: string;
  };
}

export interface TimelineSection {
  id: string;
  period: string;
  timeRange: string;
  icon: string;
  summaryFootnote?: string;
  events: TimelineEvent[];
}

export interface CrewMember {
  id: string;
  name: string;
  avatar: string;
  isCurrentUser?: boolean;
  streakDays: number;
  badge?: string;
  badgeType?: 'primary' | 'secondary' | 'neutral';
  statusQuote: string;
  recentActivity: {
    icon: string;
    title: string;
    timeAgo: string;
    highlightTag?: string;
  };
  highFivesCount: number;
  teaCount: number;
  online: boolean;
}

export interface HighFiveFeedItem {
  id: string;
  author: string;
  action: string;
  timeAgo: string;
  quote: string;
  reactions: {
    emoji: string;
    count: number;
    label?: string;
    userReacted?: boolean;
  }[];
  customEventPill?: {
    emoji: string;
    text: string;
  };
}
