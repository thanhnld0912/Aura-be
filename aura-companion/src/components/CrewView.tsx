import React, { useState } from 'react';
import { CrewMember, HighFiveFeedItem } from '../types';

interface CrewViewProps {
  crew: CrewMember[];
  feed: HighFiveFeedItem[];
  onSendReaction: (feedId: string, emoji: string) => void;
  onSendCheer: (memberId: string, actionType: 'five' | 'tea') => void;
  onBrewTeaRound: () => void;
  onHighFiveAll: () => void;
}

export const CrewView: React.FC<CrewViewProps> = ({
  crew,
  feed,
  onSendReaction,
  onSendCheer,
  onBrewTeaRound,
  onHighFiveAll,
}) => {
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
  };

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-8 space-y-8 animate-in fade-in duration-300 relative">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-24 left-1/2 transform -translate-x-1/2 z-50 px-4 py-2 bg-[#1e1b17] text-white rounded-full text-xs font-bold shadow-xl animate-in fade-in duration-150 flex items-center gap-2">
          <span>✨</span>
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-bold text-[#9f4118] uppercase tracking-wider">
            <span>Our Crew</span>
            <span>•</span>
            <span className="text-[#56423b] font-medium">Circle of 4 · Sprint 04</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold text-[#1e1b17] tracking-tight mt-1">
            Safe Sanctuary
          </h1>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#adedd0]/60 text-[#306d56] text-xs font-bold self-start sm:self-center">
          <span className="w-2 h-2 rounded-full bg-[#2b6952] animate-pulse" />
          <span>All 4 Companions Active</span>
        </div>
      </div>

      {/* Safe Sanctuary Promise Banner */}
      <div className="p-4 rounded-2xl bg-gradient-to-r from-[#ffdbce]/30 via-[#faf2ec] to-[#e6deff]/30 border border-[#eee7e1] flex items-center gap-3">
        <span className="text-2xl flex-shrink-0">🕊️</span>
        <div className="text-xs text-[#56423b] leading-relaxed">
          <strong className="text-[#1e1b17]">Sanctuary Promise:</strong> No weight, body size, or calorie competition. Only positive daily presence, mutual support, and mindful tea.
        </div>
      </div>

      {/* Shared Crew Quest: Weekend Reset Flow */}
      <div className="bg-white rounded-3xl p-6 border border-[#eee7e1] shadow-xs space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <span className="text-xs font-bold uppercase tracking-wider text-[#9f4118]">
              Shared Crew Quest
            </span>
            <h2 className="text-lg font-bold text-[#1e1b17]">Weekend Reset Flow</h2>
            <p className="text-xs text-[#56423b]">
              Group hydration goal & 1 mindful outdoor pause each.
            </p>
          </div>
          <span className="px-3 py-1 bg-[#adedd0] text-[#306d56] rounded-full text-xs font-bold flex-shrink-0">
            100% On Track!
          </span>
        </div>

        {/* Progress Bar */}
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs font-semibold">
            <span className="text-[#56423b]">Crew completion</span>
            <span className="text-[#2b6952]">4 of 4 completed (100%)</span>
          </div>
          <div className="w-full h-3 rounded-full bg-[#eee7e1] overflow-hidden">
            <div className="h-full bg-gradient-to-r from-[#2b6952] to-[#94d4b7] rounded-full w-full" />
          </div>
        </div>

        {/* AURA Coach Note */}
        <div className="p-3 bg-[#faf2ec] rounded-xl border border-[#eee7e1] text-xs text-[#56423b] flex items-center gap-2">
          <span>✨</span>
          <span>
            <strong>AURA Note:</strong> All 4 companions took time to unwind and log honestly today.
          </span>
        </div>
      </div>

      {/* Companions Grid */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-extrabold text-[#1e1b17]">Crew Companions</h2>
          <span className="text-xs text-[#8a726a]">Private circle</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {crew.map((member) => (
            <div
              key={member.id}
              className={`p-5 rounded-3xl border transition-all flex flex-col justify-between gap-4 ${
                member.isCurrentUser
                  ? 'bg-gradient-to-br from-[#faf2ec] to-white border-[#ffdbce] shadow-sm'
                  : 'bg-white border-[#eee7e1] shadow-xs'
              }`}
            >
              {/* Member Top: Avatar, Name, Streak, Badges */}
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="relative flex-shrink-0">
                    <img
                      alt={member.name}
                      src={member.avatar}
                      className="w-12 h-12 rounded-full object-cover ring-2 ring-[#eee7e1]"
                    />
                    {member.online && (
                      <span className="absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full bg-[#2b6952] ring-2 ring-white" />
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-bold text-[#1e1b17]">{member.name}</h3>
                      {member.isCurrentUser && (
                        <span className="px-2 py-0.5 rounded-full bg-[#ffdbce] text-[#7f2b01] text-[10px] font-bold">
                          You
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-[#56423b] mt-0.5">
                      <span>🔥 {member.streakDays} days</span>
                      {member.badge && (
                        <>
                          <span>•</span>
                          <span className="font-semibold text-[#2b6952]">{member.badge}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Received Cheers counters */}
                <div className="flex items-center gap-2 text-xs font-semibold text-[#56423b]">
                  <span className="flex items-center gap-1 bg-[#faf2ec] px-2 py-1 rounded-full border border-[#eee7e1]">
                    ✋ {member.highFivesCount}
                  </span>
                  <span className="flex items-center gap-1 bg-[#faf2ec] px-2 py-1 rounded-full border border-[#eee7e1]">
                    🍵 {member.teaCount}
                  </span>
                </div>
              </div>

              {/* Status Quote */}
              <p className="text-xs text-[#1e1b17] italic bg-[#fff8f3] p-2.5 rounded-xl border border-[#ffdbce]/40">
                {member.statusQuote}
              </p>

              {/* Recent Activity Pill */}
              <div className="p-3 bg-[#faf2ec] rounded-2xl border border-[#eee7e1] flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-base">{member.recentActivity.icon}</span>
                  <div>
                    <p className="font-bold text-[#1e1b17]">
                      {member.recentActivity.title}
                    </p>
                    <span className="text-[10px] text-[#8a726a]">
                      {member.recentActivity.timeAgo}
                    </span>
                  </div>
                </div>
                {member.recentActivity.highlightTag && (
                  <span className="px-2 py-0.5 bg-white rounded-full text-[10px] font-bold text-[#2b6952] border border-[#eee7e1]">
                    {member.recentActivity.highlightTag}
                  </span>
                )}
              </div>

              {/* Interaction Buttons */}
              <div className="flex items-center gap-2 pt-1">
                {member.isCurrentUser ? (
                  <div className="w-full text-center text-xs font-semibold text-[#2b6952] py-2 bg-[#adedd0]/30 rounded-full border border-[#adedd0]">
                    Your mindful journey inspires the circle ✨
                  </div>
                ) : (
                  <>
                    <button
                      onClick={() => {
                        onSendCheer(member.id, 'five');
                        showToast(`High five sent to ${member.name}! ✋`);
                      }}
                      className="flex-1 py-2 px-3 rounded-full bg-[#faf2ec] hover:bg-[#ffdbce] text-[#1e1b17] hover:text-[#7f2b01] text-xs font-bold transition-colors flex items-center justify-center gap-1.5 border border-[#eee7e1]"
                      type="button"
                    >
                      <span>✋</span>
                      <span>High Five</span>
                    </button>
                    <button
                      onClick={() => {
                        onSendCheer(member.id, 'tea');
                        showToast(`Brewed a warm cup of tea for ${member.name}! 🍵`);
                      }}
                      className="flex-1 py-2 px-3 rounded-full bg-[#faf2ec] hover:bg-[#adedd0] text-[#1e1b17] hover:text-[#0b513b] text-xs font-bold transition-colors flex items-center justify-center gap-1.5 border border-[#eee7e1]"
                      type="button"
                    >
                      <span>🍵</span>
                      <span>Send Tea</span>
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Quick Crew Action Bar */}
      <div className="p-4 bg-gradient-to-r from-[#ffdbce]/40 via-[#faf2ec] to-[#adedd0]/40 rounded-3xl border border-[#eee7e1] flex flex-col sm:flex-row items-center justify-between gap-4">
        <div>
          <h4 className="text-sm font-bold text-[#1e1b17]">Quick Crew Actions</h4>
          <p className="text-xs text-[#56423b]">Share gentle appreciation across your private circle.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              onHighFiveAll();
              showToast('High fives sent to all 3 companions! ✋✨');
            }}
            className="px-4 py-2 rounded-full bg-white hover:bg-[#faf2ec] text-xs font-bold text-[#1e1b17] border border-[#eee7e1] shadow-xs transition-colors"
            type="button"
          >
            ✋ Send high five to all
          </button>
          <button
            onClick={() => {
              onBrewTeaRound();
              showToast('Tea round brewed for the whole crew! 🍵🌿');
            }}
            className="px-4 py-2 rounded-full bg-[#2b6952] hover:bg-[#0b513b] text-xs font-bold text-white shadow-xs transition-colors"
            type="button"
          >
            🍵 Brew tea round
          </button>
        </div>
      </div>

      {/* High Five Feed */}
      <div className="bg-white rounded-3xl p-6 border border-[#eee7e1] shadow-xs space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-[#eee7e1]">
          <div className="flex items-center gap-2">
            <span className="text-lg">💬</span>
            <h3 className="text-base font-bold text-[#1e1b17]">High Five Feed</h3>
          </div>
          <span className="text-xs text-[#8a726a]">Real-time circle updates</span>
        </div>

        <div className="divide-y divide-[#faf2ec]">
          {feed.map((item) => (
            <div key={item.id} className="py-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-[#1e1b17]">{item.author}</span>
                  <span className="text-xs text-[#56423b]">{item.action}</span>
                </div>
                <span className="text-[11px] text-[#8a726a]">{item.timeAgo}</span>
              </div>

              <p className="text-xs text-[#1e1b17] italic pl-2 border-l-2 border-[#ff8a5b]">
                {item.quote}
              </p>

              {item.customEventPill && (
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#adedd0]/40 text-[#0b513b] text-xs font-semibold">
                  <span>{item.customEventPill.emoji}</span>
                  <span>{item.customEventPill.text}</span>
                </div>
              )}

              {/* Interactive Reaction buttons */}
              {item.reactions.length > 0 && (
                <div className="flex items-center gap-2 pt-1">
                  {item.reactions.map((r, i) => (
                    <button
                      key={i}
                      onClick={() => onSendReaction(item.id, r.emoji)}
                      className={`px-3 py-1 rounded-full text-xs font-bold transition-all flex items-center gap-1.5 ${
                        r.userReacted
                          ? 'bg-[#ffdbce] text-[#7f2b01] border border-[#ff8a5b]'
                          : 'bg-[#faf2ec] hover:bg-[#eee7e1] text-[#56423b]'
                      }`}
                      type="button"
                    >
                      <span>{r.emoji}</span>
                      <span>{r.count}</span>
                    </button>
                  ))}
                  <button
                    onClick={() => onSendReaction(item.id, '🍵')}
                    className="p-1 rounded-full text-xs text-[#8a726a] hover:text-[#1e1b17]"
                    title="Add reaction"
                    type="button"
                  >
                    + React
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Crew Philosophy */}
      <div className="text-center py-4 text-xs text-[#8a726a] space-y-1">
        <p>A circle of friends holding space for progress over perfection.</p>
        <p className="font-semibold text-[#56423b]">Safe · Private · Kind</p>
      </div>
    </div>
  );
};
