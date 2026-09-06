import React, { useState } from 'react';
import { TimelineSection, MealLogDraft } from '../types';

interface TodayViewProps {
  timeline: TimelineSection[];
  onOpenLogModal: (initialPrompt?: string) => void;
  onSelectMood: (mood: string) => void;
  selectedMood: string;
}

export const TodayView: React.FC<TodayViewProps> = ({
  timeline,
  onOpenLogModal,
  onSelectMood,
  selectedMood,
}) => {
  const [selectedTag, setSelectedTag] = useState<string>('Pretty normal');
  const [showNoteInput, setShowNoteInput] = useState(false);
  const [checkInNote, setCheckInNote] = useState('');
  const [noteSaved, setNoteSaved] = useState(false);

  const moodOptions = [
    { id: 'low', emoji: '🥱', label: 'Low energy' },
    { id: 'okay', emoji: '😐', label: 'Okay' },
    { id: 'good', emoji: '🙂', label: 'Good' },
    { id: 'great', emoji: '✨', label: 'Great' },
  ];

  const tagOptions = [
    'Pretty normal',
    'Busy',
    'Better than expected',
    "Didn't go as planned",
  ];

  const handleSaveNote = () => {
    setNoteSaved(true);
    setTimeout(() => {
      setShowNoteInput(false);
      setNoteSaved(false);
    }, 1200);
  };

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-8 space-y-8 animate-in fade-in duration-300">
      {/* Top Header & Body Clock sync */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-bold text-[#9f4118] uppercase tracking-wider">
            <span>Daily Rhythm</span>
            <span>•</span>
            <span className="text-[#56423b] font-medium">Friday, September 4</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold text-[#1e1b17] tracking-tight mt-1">
            Hey Thanh 👋
          </h1>
        </div>
        <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#faf2ec] border border-[#eee7e1] text-xs font-semibold text-[#56423b] self-start sm:self-center shadow-xs">
          <span className="w-2 h-2 rounded-full bg-[#2b6952] animate-pulse" />
          <span>Synced with body clock · 16:45 PM</span>
        </div>
      </div>

      {/* Hero Card: Today • Gentle Flow */}
      <div className="bg-gradient-to-br from-[#faf2ec] via-white to-[#ffdbce]/20 rounded-3xl p-6 sm:p-8 border border-[#eee7e1] shadow-[0_12px_36px_-8px_rgba(45,42,38,0.06)] relative overflow-hidden">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex-1 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-[#9f4118]">
                Today • Gentle Flow
              </span>
              <span className="px-2 py-0.5 bg-[#adedd0] text-[#306d56] rounded-full text-[11px] font-bold">
                Balance On Track
              </span>
            </div>
            <p className="text-base sm:text-lg text-[#1e1b17] font-medium leading-relaxed">
              You're doing pretty well today. Your energy is staying steady despite schedule adjustments.
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-[#56423b]">
              <span className="px-2.5 py-1 bg-white rounded-full border border-[#eee7e1] font-semibold text-[#1e1b17]">
                ✓ 3 things done
              </span>
              <span className="px-2.5 py-1 bg-[#ffdbce]/60 rounded-full border border-[#ffdbce] font-semibold text-[#7f2b01]">
                ⚡ 1 changed
              </span>
              <span className="px-2.5 py-1 bg-[#faf2ec] rounded-full border border-[#eee7e1] font-semibold">
                ⏳ 2 upcoming
              </span>
            </div>
          </div>

          {/* 72% Flow Ring with SVG */}
          <div className="flex flex-col items-center justify-center relative flex-shrink-0">
            <div className="relative w-28 h-28 flex items-center justify-center">
              <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
                <circle
                  cx="50"
                  cy="50"
                  r="42"
                  stroke="#eee7e1"
                  strokeWidth="8"
                  fill="transparent"
                />
                <circle
                  cx="50"
                  cy="50"
                  r="42"
                  stroke="#9f4118"
                  strokeWidth="8"
                  strokeDasharray="264"
                  strokeDashoffset={264 - (264 * 72) / 100}
                  strokeLinecap="round"
                  fill="transparent"
                  className="transition-all duration-1000 ease-out"
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                <span className="text-2xl font-black text-[#1e1b17] leading-none">72%</span>
                <span className="text-[10px] font-bold text-[#8a726a] uppercase tracking-wider mt-0.5">
                  Flow
                </span>
              </div>
            </div>
            <span className="text-[11px] text-[#56423b] mt-2 font-medium">Harmonious rhythm</span>
          </div>
        </div>

        {/* Inspirational quote foot */}
        <div className="mt-6 pt-4 border-t border-[#eee7e1]/80 flex items-center gap-2 text-xs text-[#56423b] italic">
          <span>“You don't have to live perfectly. Just tell AURA what actually happened.”</span>
        </div>
      </div>

      {/* < 20 SEC CHECK-IN */}
      <div className="bg-white rounded-3xl p-6 border border-[#eee7e1] shadow-xs space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-[#ffdbce] text-[#7f2b01] flex items-center justify-center text-xs font-bold">
              ⚡
            </span>
            <h2 className="text-base font-bold text-[#1e1b17]">&lt; 20 SEC CHECK-IN</h2>
          </div>
          <span className="text-xs text-[#2b6952] font-semibold">Saved automatically</span>
        </div>

        {/* Mood Selection Buttons */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {moodOptions.map((mood) => {
            const isSelected = selectedMood === mood.id;
            return (
              <button
                key={mood.id}
                onClick={() => onSelectMood(mood.id)}
                className={`p-3 rounded-2xl border text-center transition-all duration-200 flex flex-col items-center gap-1.5 ${
                  isSelected
                    ? 'bg-[#ffdbce]/50 border-[#ff8a5b] text-[#7f2b01] shadow-xs scale-[1.02]'
                    : 'bg-[#faf2ec] border-transparent hover:border-[#eee7e1] text-[#56423b]'
                }`}
                type="button"
              >
                <span className="text-2xl">{mood.emoji}</span>
                <span className="text-xs font-bold">{mood.label}</span>
              </button>
            );
          })}
        </div>

        {/* Tag pills */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {tagOptions.map((tag) => {
            const isSelected = selectedTag === tag;
            return (
              <button
                key={tag}
                onClick={() => setSelectedTag(tag)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
                  isSelected
                    ? 'bg-[#1e1b17] text-white'
                    : 'bg-[#faf2ec] text-[#56423b] hover:bg-[#eee7e1]'
                }`}
                type="button"
              >
                {tag}
              </button>
            );
          })}
          <button
            onClick={() => setShowNoteInput(!showNoteInput)}
            className="px-3 py-1.5 rounded-full text-xs font-semibold bg-white border border-[#eee7e1] text-[#9f4118] hover:bg-[#faf2ec] transition-colors"
            type="button"
          >
            + Add a note
          </button>
        </div>

        {/* Expandable note input */}
        {showNoteInput && (
          <div className="p-3 bg-[#faf2ec] rounded-2xl border border-[#eee7e1] space-y-2 animate-in fade-in duration-150">
            <textarea
              placeholder="How are you feeling right now? Anything mindful on your mind?"
              value={checkInNote}
              onChange={(e) => setCheckInNote(e.target.value)}
              className="w-full bg-white rounded-xl p-2.5 text-xs text-[#1e1b17] border border-[#eee7e1] focus:outline-none"
              rows={2}
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowNoteInput(false)}
                className="px-3 py-1 rounded-full text-xs text-[#56423b]"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveNote}
                className="px-4 py-1 rounded-full text-xs font-bold bg-[#9f4118] text-white"
              >
                {noteSaved ? 'Saved! ✓' : 'Save Reflection'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Plan vs. Actual Spotlight */}
      <div className="bg-gradient-to-r from-[#faf2ec] via-white to-[#faf2ec] rounded-3xl p-6 border border-[#eee7e1] shadow-xs space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-[#9f4118]">
            Plan vs. Actual Spotlight
          </span>
          <span className="px-2 py-0.5 bg-[#adedd0] text-[#306d56] rounded-full text-[11px] font-bold">
            Gentle Pivot
          </span>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 p-4 rounded-2xl bg-[#fff8f3] border border-[#ffdbce]/60">
          <div className="flex-1">
            <span className="text-[11px] font-bold text-[#8a726a] uppercase">Planned</span>
            <p className="text-sm font-bold text-[#1e1b17] mt-0.5">Gym at 18:00</p>
          </div>
          <div className="w-8 h-8 rounded-full bg-[#ffdbce] text-[#7f2b01] flex items-center justify-center self-center flex-shrink-0">
            <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
          </div>
          <div className="flex-1">
            <span className="text-[11px] font-bold text-[#2b6952] uppercase">What actually happened</span>
            <p className="text-sm font-bold text-[#1e1b17] mt-0.5">Walked for 40 minutes at 18:30</p>
          </div>
        </div>

        {/* AURA Reflection */}
        <div className="p-3.5 rounded-2xl bg-[#adedd0]/30 border border-[#adedd0] flex items-start gap-2.5">
          <span className="text-base mt-0.5">💡</span>
          <div>
            <span className="text-xs font-bold text-[#0b513b]">AURA Reflection:</span>
            <p className="text-xs text-[#0b513b] leading-relaxed mt-0.5">
              “That still counts as movement. You changed the plan, but you didn't abandon the day.”
            </p>
          </div>
        </div>
      </div>

      {/* Today's Story (Timeline) */}
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-extrabold text-[#1e1b17]">Today's Story</h2>
          <button
            onClick={() => onOpenLogModal()}
            className="text-xs font-bold text-[#9f4118] hover:underline flex items-center gap-1"
          >
            <span>+ Log moment</span>
          </button>
        </div>

        {timeline.map((section) => (
          <div key={section.id} className="bg-white rounded-3xl p-6 border border-[#eee7e1] shadow-xs space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[#eee7e1]/80">
              <div className="flex items-center gap-2">
                <span className="text-xl">{section.icon}</span>
                <h3 className="text-base font-bold text-[#1e1b17]">{section.period}</h3>
              </div>
              <span className="text-xs font-semibold text-[#8a726a]">{section.timeRange}</span>
            </div>

            <div className="space-y-4">
              {section.events.map((event) => (
                <div key={event.id} className="flex items-start gap-4 p-3 rounded-2xl hover:bg-[#faf2ec]/50 transition-colors">
                  <div className="text-xs font-bold text-[#8a726a] w-12 pt-0.5 flex-shrink-0">
                    {event.time}
                  </div>
                  <div className="flex-1 space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="text-sm font-bold text-[#1e1b17]">{event.title}</h4>
                      {event.statusBadge && (
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            event.statusType === 'warning'
                              ? 'bg-[#ffdad6] text-[#93000a]'
                              : event.statusType === 'success'
                              ? 'bg-[#adedd0] text-[#306d56]'
                              : event.statusType === 'urgent'
                              ? 'bg-[#ffdbce] text-[#7f2b01]'
                              : 'bg-[#eee7e1] text-[#56423b]'
                          }`}
                        >
                          {event.statusBadge}
                        </span>
                      )}
                    </div>

                    {event.description && (
                      <p className="text-xs text-[#56423b] leading-relaxed whitespace-pre-line">
                        {event.description}
                      </p>
                    )}

                    {event.tags && event.tags.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 pt-1">
                        {event.tags.map((tag, idx) => (
                          <span
                            key={idx}
                            className="px-2 py-0.5 bg-[#faf2ec] rounded-full text-[11px] font-medium text-[#1e1b17] border border-[#eee7e1]"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}

                    {event.extraPill && (
                      <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-[#ffdbce]/40 rounded-full text-[11px] font-semibold text-[#7f2b01]">
                        <span className="material-symbols-outlined text-[14px]">
                          {event.extraPill.icon}
                        </span>
                        <span>{event.extraPill.text}</span>
                      </div>
                    )}

                    {event.note && (
                      <div className="p-3 bg-[#faf2ec] rounded-xl border border-[#eee7e1] mt-2">
                        <span className="text-[11px] font-bold text-[#9f4118]">
                          {event.note.title}:
                        </span>
                        <p className="text-xs text-[#56423b] mt-0.5">{event.note.content}</p>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {section.summaryFootnote && (
              <div className="pt-3 border-t border-[#eee7e1]/60 text-[11px] text-[#8a726a] flex items-center justify-between">
                <span>{section.summaryFootnote}</span>
                <span className="text-[#2b6952] font-semibold">✓ Logged</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Need a quick adjustment? chips */}
      <div className="p-6 bg-gradient-to-r from-[#ffdbce]/30 via-[#faf2ec] to-[#adedd0]/30 rounded-3xl border border-[#eee7e1] flex flex-col sm:flex-row items-center justify-between gap-4">
        <div>
          <h4 className="text-sm font-bold text-[#1e1b17]">Need a quick adjustment?</h4>
          <p className="text-xs text-[#56423b]">Tap to quickly log or tweak today's remaining flow.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => onOpenLogModal('Đã ăn bữa tối nhẹ.')}
            className="px-3.5 py-1.5 rounded-full bg-white hover:bg-[#faf2ec] text-xs font-semibold text-[#1e1b17] shadow-xs border border-[#eee7e1]"
            type="button"
          >
            🍱 Ate
          </button>
          <button
            onClick={() => onOpenLogModal('Vừa hoàn thành 30 phút đi bộ nhẹ nhàng.')}
            className="px-3.5 py-1.5 rounded-full bg-white hover:bg-[#faf2ec] text-xs font-semibold text-[#1e1b17] shadow-xs border border-[#eee7e1]"
            type="button"
          >
            🏋️ Workout
          </button>
          <button
            onClick={() => onOpenLogModal('Đã uống 1 ly nước ấm 350ml.')}
            className="px-3.5 py-1.5 rounded-full bg-white hover:bg-[#faf2ec] text-xs font-semibold text-[#1e1b17] shadow-xs border border-[#eee7e1]"
            type="button"
          >
            💧 Water
          </button>
          <button
            onClick={() => onOpenLogModal('Chuẩn bị đi ngủ lúc 22:30.')}
            className="px-3.5 py-1.5 rounded-full bg-white hover:bg-[#faf2ec] text-xs font-semibold text-[#1e1b17] shadow-xs border border-[#eee7e1]"
            type="button"
          >
            😴 Sleep
          </button>
        </div>
      </div>
    </div>
  );
};
