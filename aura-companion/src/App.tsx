import React, { useState } from 'react';
import { TabType, MealLogDraft, TimelineSection, CrewMember, HighFiveFeedItem } from './types';
import { INITIAL_TIMELINE, INITIAL_CREW, INITIAL_FEED } from './data/initialData';
import { Header } from './components/Header';
import { BottomBar } from './components/BottomBar';
import { LogModal } from './components/LogModal';
import { TodayView } from './components/TodayView';
import { InsightsView } from './components/InsightsView';
import { CrewView } from './components/CrewView';
import { HistoryView } from './components/HistoryView';
import { AICoachView } from './components/AICoachView';

export function App() {
  const [currentTab, setCurrentTab] = useState<TabType>('today');
  const [isLogModalOpen, setIsLogModalOpen] = useState(false);
  const [logModalInitialPrompt, setLogModalInitialPrompt] = useState<string | undefined>(undefined);
  const [selectedMood, setSelectedMood] = useState<string>('good');
  const [streakCount, setStreakCount] = useState<number>(5);
  const [timeline, setTimeline] = useState<TimelineSection[]>(INITIAL_TIMELINE);
  const [crew, setCrew] = useState<CrewMember[]>(INITIAL_CREW);
  const [feed, setFeed] = useState<HighFiveFeedItem[]>(INITIAL_FEED);

  const handleOpenLogModal = (prompt?: string) => {
    setLogModalInitialPrompt(prompt);
    setIsLogModalOpen(true);
  };

  const handleAddLogSuccess = (mealDraft: MealLogDraft) => {
    // Generate new event from draft
    const newEvent = {
      id: 'log-' + Date.now(),
      time: mealDraft.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      title: mealDraft.mealType + ' Nourishment',
      statusBadge: 'Logged',
      statusType: 'success' as const,
      description: mealDraft.rawInput.replace(/^[“"]|[”"]$/g, ''),
      tags: mealDraft.foods.map((f) => `${f.icon} ${f.vietnameseName} (${f.selectedPortion})`),
      note: {
        title: 'AURA Note',
        content: mealDraft.mindfulNote,
      },
    };

    // Add to afternoon or create entry
    setTimeline((prev) => {
      return prev.map((section) => {
        if (section.id === 'afternoon') {
          return {
            ...section,
            events: [newEvent, ...section.events],
          };
        }
        return section;
      });
    });

    // Also add to feed
    const newFeedItem: HighFiveFeedItem = {
      id: 'f-' + Date.now(),
      author: 'Thanh (You)',
      action: `logged ${mealDraft.mealType}`,
      timeAgo: 'Just now',
      quote: `“${mealDraft.foods.map((f) => f.vietnameseName).join(', ')}”`,
      reactions: [
        { emoji: '🍵', count: 1, userReacted: true },
        { emoji: '👏', count: 1 },
      ],
    };
    setFeed((prev) => [newFeedItem, ...prev]);
  };

  // Crew reactions
  const handleSendReaction = (feedId: string, emoji: string) => {
    setFeed((prev) =>
      prev.map((item) => {
        if (item.id === feedId) {
          const existing = item.reactions.find((r) => r.emoji === emoji);
          if (existing) {
            return {
              ...item,
              reactions: item.reactions.map((r) =>
                r.emoji === emoji
                  ? { ...r, count: r.count + 1, userReacted: true }
                  : r
              ),
            };
          } else {
            return {
              ...item,
              reactions: [...item.reactions, { emoji, count: 1, userReacted: true }],
            };
          }
        }
        return item;
      })
    );
  };

  const handleSendCheer = (memberId: string, actionType: 'five' | 'tea') => {
    setCrew((prev) =>
      prev.map((m) => {
        if (m.id === memberId) {
          return {
            ...m,
            highFivesCount: actionType === 'five' ? m.highFivesCount + 1 : m.highFivesCount,
            teaCount: actionType === 'tea' ? m.teaCount + 1 : m.teaCount,
          };
        }
        return m;
      })
    );
  };

  const handleBrewTeaRound = () => {
    setCrew((prev) =>
      prev.map((m) => (m.isCurrentUser ? m : { ...m, teaCount: m.teaCount + 1 }))
    );
  };

  const handleHighFiveAll = () => {
    setCrew((prev) =>
      prev.map((m) => (m.isCurrentUser ? m : { ...m, highFivesCount: m.highFivesCount + 1 }))
    );
  };

  return (
    <div className="min-h-screen bg-[#fff8f3] text-[#1e1b17] flex flex-col font-sans selection:bg-[#ffdbce] selection:text-[#370e00] pb-28">
      {/* Fixed Header */}
      <Header
        currentTab={currentTab}
        onSelectTab={setCurrentTab}
        onOpenLog={() => handleOpenLogModal()}
        streakCount={streakCount}
      />

      {/* Main Content Area */}
      <main className="flex-1 pt-24">
        {currentTab === 'today' && (
          <TodayView
            timeline={timeline}
            onOpenLogModal={handleOpenLogModal}
            onSelectMood={setSelectedMood}
            selectedMood={selectedMood}
          />
        )}

        {currentTab === 'insights' && (
          <InsightsView
            onOpenLogModal={handleOpenLogModal}
            onNavigateToCoach={() => setCurrentTab('ai-coach')}
          />
        )}

        {currentTab === 'crew' && (
          <CrewView
            crew={crew}
            feed={feed}
            onSendReaction={handleSendReaction}
            onSendCheer={handleSendCheer}
            onBrewTeaRound={handleBrewTeaRound}
            onHighFiveAll={handleHighFiveAll}
          />
        )}

        {currentTab === 'history' && (
          <HistoryView onOpenLogModal={handleOpenLogModal} />
        )}

        {currentTab === 'ai-coach' && <AICoachView />}
      </main>

      {/* Floating Ambient Bottom Bar */}
      <BottomBar
        onOpenLog={handleOpenLogModal}
        onQuickVoice={() => handleOpenLogModal('Đang lắng nghe giọng nói của bạn...')}
      />

      {/* Live Context Log Modal */}
      <LogModal
        isOpen={isLogModalOpen}
        onClose={() => setIsLogModalOpen(false)}
        onAddLogSuccess={handleAddLogSuccess}
        initialPrompt={logModalInitialPrompt}
      />
    </div>
  );
}

export default App;
