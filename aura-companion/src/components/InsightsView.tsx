import React, { useState } from 'react';
import { ASSETS } from '../data/initialData';

interface InsightsViewProps {
  onOpenLogModal: (prompt?: string) => void;
  onNavigateToCoach: () => void;
}

export const InsightsView: React.FC<InsightsViewProps> = ({
  onOpenLogModal,
  onNavigateToCoach,
}) => {
  const [showDataBreakdown, setShowDataBreakdown] = useState(false);
  const [activeReelIndex, setActiveReelIndex] = useState(0);
  const [nextWeekPlanned, setNextWeekPlanned] = useState(false);

  const reels = [
    {
      title: 'Weekday Harmony',
      tag: 'Mon - Wed',
      desc: 'Your morning rhythms aligned smoothly with body clock cues. Energy was at 84% without coffee crashes.',
      badge: 'Peak Flow',
      color: 'primary',
    },
    {
      title: 'Friday Dinner Shift',
      tag: 'Gentle Pivot',
      desc: 'Instead of skipping dinner after a busy workday, you enjoyed hot phở with colleagues. Perfect warmth.',
      badge: 'Nourished',
      color: 'secondary',
    },
    {
      title: 'Steady Movement',
      tag: 'Activity',
      desc: 'Swapped high-intensity gym sessions for 40-minute scenic walks. Your heart rate recovery improved by 14%.',
      badge: 'Stamina',
      color: 'neutral',
    },
    {
      title: 'Mindful Fueling',
      tag: 'Nutrition',
      desc: 'Home-cooked braised fish & water spinach provided rich Omega-3 and magnesium for deeper evening sleep.',
      badge: 'Greens Champion',
      color: 'secondary',
    },
  ];

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-8 space-y-8 animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-bold text-[#9f4118] uppercase tracking-wider">
            <span>Weekly Synthesis</span>
            <span>•</span>
            <span className="text-[#56423b] font-medium">Nov 10 - Nov 17</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold text-[#1e1b17] tracking-tight mt-1">
            Mindful Insights
          </h1>
        </div>
        <div className="flex items-center gap-2 text-xs text-[#8a726a] self-start sm:self-center">
          <span className="w-2 h-2 rounded-full bg-[#2b6952]" />
          <span>Refreshed 28 mins ago</span>
        </div>
      </div>

      {/* Playful Badges / Milestones */}
      <div className="flex items-center gap-3 overflow-x-auto pb-1 no-scrollbar">
        <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#adedd0]/50 text-[#0b513b] text-xs font-bold border border-[#adedd0] flex-shrink-0">
          <span>🌱</span>
          <span>Growing Sprout · Lvl 3</span>
        </div>
        <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#ffdbce] text-[#7f2b01] text-xs font-bold border border-[#ffb599] flex-shrink-0">
          <span>🔥</span>
          <span>5-Day Flow Streak</span>
        </div>
        <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#e6deff] text-[#1b0062] text-xs font-bold border border-[#c9beff] flex-shrink-0">
          <span>✨</span>
          <span>2 Patterns Unveiled</span>
        </div>
      </div>

      {/* AURA noticed something card */}
      <div className="bg-gradient-to-br from-[#faf2ec] via-white to-[#ffdbce]/25 rounded-3xl p-6 sm:p-8 border border-[#eee7e1] shadow-[0_12px_36px_-8px_rgba(45,42,38,0.06)] space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-xl">👀</span>
              <h2 className="text-xl font-bold text-[#1e1b17]">AURA noticed something</h2>
            </div>
            <span className="text-xs font-semibold text-[#8a726a]">Over the last 10 days</span>
          </div>
          <span className="px-3 py-1 rounded-full bg-[#ffdbce] text-[#7f2b01] text-xs font-bold">
            Gentle Correlation
          </span>
        </div>

        <p className="text-base sm:text-lg text-[#1e1b17] font-medium leading-relaxed">
          “When your bedtime shifted past <strong className="text-[#9f4118]">23:45</strong>, a ripple gently touched the rest of your day...”
        </p>

        {/* 3 Observed Patterns */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="bg-white p-4 rounded-2xl border border-[#eee7e1] shadow-xs space-y-1">
            <span className="text-xs font-bold text-[#9f4118]">01. Breakfast Skipped</span>
            <p className="text-xs text-[#56423b]">
              3 of 4 late evenings resulted in delayed morning appetite.
            </p>
          </div>
          <div className="bg-white p-4 rounded-2xl border border-[#eee7e1] shadow-xs space-y-1">
            <span className="text-xs font-bold text-[#2b6952]">02. Lunch Delayed</span>
            <p className="text-xs text-[#56423b]">
              Pushed past 13:30, leading to sudden hunger and cravings.
            </p>
          </div>
          <div className="bg-white p-4 rounded-2xl border border-[#eee7e1] shadow-xs space-y-1">
            <span className="text-xs font-bold text-[#6050af]">03. Morning Movement</span>
            <p className="text-xs text-[#56423b]">
              Replaced by slow rest — totally valid, but changed your stamina curve.
            </p>
          </div>
        </div>

        {/* Note from AURA */}
        <div className="p-3.5 rounded-2xl bg-[#adedd0]/30 border border-[#adedd0] flex items-start gap-2.5">
          <span className="text-base mt-0.5">💬</span>
          <p className="text-xs text-[#0b513b] leading-relaxed">
            <strong>Companion note:</strong> Small shifts in rest ripple into nourishment and pacing. No guilt or strict rules needed — simply having awareness brings gentle realignment.
          </p>
        </div>

        {/* 10-Day Sleep vs Meal Timing Curve */}
        <div className="bg-white p-5 rounded-2xl border border-[#eee7e1] space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-[#1e1b17]">10-Day Sleep vs. Meal Timing Curve</h3>
              <p className="text-xs text-[#8a726a]">Correlation between bedtime shift and first meal</p>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="flex items-center gap-1 text-[#9f4118] font-bold">
                <span className="w-2 h-2 rounded-full bg-[#9f4118]" /> Bedtime
              </span>
              <span className="flex items-center gap-1 text-[#2b6952] font-bold">
                <span className="w-2 h-2 rounded-full bg-[#2b6952]" /> First Meal
              </span>
            </div>
          </div>

          {/* SVG Interactive Visualizer */}
          <div className="relative w-full h-40 bg-[#fff8f3] rounded-xl p-3 flex items-center justify-center overflow-hidden">
            {/* Natural window band */}
            <div className="absolute inset-x-0 top-6 h-14 bg-[#adedd0]/20 border-y border-[#adedd0]/40 flex items-center px-3 justify-between pointer-events-none">
              <span className="text-[10px] text-[#2b6952] font-bold uppercase tracking-wider">
                Natural Window (22:30 - 23:30)
              </span>
              <span className="text-[10px] text-[#2b6952]">Optimal recovery</span>
            </div>

            <svg className="w-full h-full" viewBox="0 0 500 120" preserveAspectRatio="none">
              {/* Bedtime Line */}
              <path
                d="M 10 40 Q 60 45 110 35 T 210 50 T 310 95 T 410 80 T 490 45"
                fill="none"
                stroke="#9f4118"
                strokeWidth="3"
                strokeLinecap="round"
              />
              {/* Meal Line */}
              <path
                d="M 10 50 Q 60 55 110 48 T 210 55 T 310 90 T 410 85 T 490 55"
                fill="none"
                stroke="#2b6952"
                strokeWidth="2.5"
                strokeDasharray="4 4"
                strokeLinecap="round"
              />
              {/* Dots */}
              <circle cx="310" cy="95" r="5" fill="#9f4118" />
              <circle cx="310" cy="90" r="4" fill="#2b6952" />
            </svg>

            {/* Callout Annotation */}
            <div className="absolute top-16 right-1/3 bg-[#ffdbce] px-2.5 py-1 rounded-full text-[10px] font-bold text-[#7f2b01] shadow-xs border border-[#ff8a5b]">
              ⚡ Shifted +65m
            </div>
          </div>

          <div className="flex justify-between text-[11px] text-[#8a726a] pt-1">
            <span>Nov 7 (Thu)</span>
            <span>Nov 10 (Sun)</span>
            <span>Nov 13 (Wed - Shift)</span>
            <span>Nov 16 (Today)</span>
          </div>
        </div>

        {/* Buttons */}
        <div className="flex flex-col sm:flex-row items-center gap-3 pt-1">
          <button
            onClick={() => onNavigateToCoach()}
            className="w-full sm:flex-1 py-3 px-5 rounded-full bg-[#9f4118] hover:bg-[#ff8a5b] text-white font-bold text-xs shadow-md transition-all flex items-center justify-center gap-2"
            type="button"
          >
            <span className="material-symbols-outlined text-[16px]">tune</span>
            <span>Adjust schedule smoothly with AURA</span>
          </button>
          <button
            onClick={() => setShowDataBreakdown(!showDataBreakdown)}
            className="w-full sm:w-auto py-3 px-5 rounded-full bg-white hover:bg-[#faf2ec] text-[#1e1b17] font-semibold text-xs border border-[#eee7e1] transition-colors"
            type="button"
          >
            {showDataBreakdown ? 'Hide data breakdown' : 'Show me the data breakdown'}
          </button>
        </div>

        {/* Toggled Data Breakdown */}
        {showDataBreakdown && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 animate-in fade-in duration-200">
            <div className="p-3 bg-white rounded-xl border border-[#eee7e1]">
              <span className="text-[10px] text-[#8a726a] uppercase font-bold">Sleep Midpoint</span>
              <p className="text-base font-bold text-[#1e1b17] mt-0.5">03:42 AM</p>
              <span className="text-[10px] text-[#2b6952]">Stable consistency</span>
            </div>
            <div className="p-3 bg-white rounded-xl border border-[#eee7e1]">
              <span className="text-[10px] text-[#8a726a] uppercase font-bold">Digestive Gap</span>
              <p className="text-base font-bold text-[#1e1b17] mt-0.5">11.4 hrs</p>
              <span className="text-[10px] text-[#2b6952]">Gentle overnight rest</span>
            </div>
            <div className="p-3 bg-white rounded-xl border border-[#eee7e1]">
              <span className="text-[10px] text-[#8a726a] uppercase font-bold">Energy Correlate</span>
              <p className="text-base font-bold text-[#1e1b17] mt-0.5">+18%</p>
              <span className="text-[10px] text-[#9f4118]">With home-cooked lunch</span>
            </div>
            <div className="p-3 bg-white rounded-xl border border-[#eee7e1]">
              <span className="text-[10px] text-[#8a726a] uppercase font-bold">Recovery Ready</span>
              <p className="text-base font-bold text-[#1e1b17] mt-0.5">86%</p>
              <span className="text-[10px] text-[#2b6952]">Deep delta restored</span>
            </div>
          </div>
        )}
      </div>

      {/* YOUR WEEK · Here's what happened */}
      <div className="space-y-4">
        <h2 className="text-xl font-extrabold text-[#1e1b17]">YOUR WEEK · Here's what happened</h2>

        {/* 4 Big Stat Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="p-5 rounded-3xl bg-white border border-[#eee7e1] shadow-xs flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[#8a726a]">Workouts</span>
              <span className="text-xl">🏋️</span>
            </div>
            <div className="mt-4">
              <div className="text-2xl sm:text-3xl font-black text-[#1e1b17]">4 done</div>
              <span className="text-[11px] text-[#2b6952] font-semibold">+1 from last week</span>
            </div>
          </div>

          <div className="p-5 rounded-3xl bg-white border border-[#eee7e1] shadow-xs flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[#8a726a]">Meals Logged</span>
              <span className="text-xl">🍱</span>
            </div>
            <div className="mt-4">
              <div className="text-2xl sm:text-3xl font-black text-[#1e1b17]">17 logged</div>
              <span className="text-[11px] text-[#9f4118] font-semibold">82% home-cooked ❤️</span>
            </div>
          </div>

          <div className="p-5 rounded-3xl bg-white border border-[#eee7e1] shadow-xs flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[#8a726a]">Sleep Rest</span>
              <span className="text-xl">😴</span>
            </div>
            <div className="mt-4">
              <div className="text-2xl sm:text-3xl font-black text-[#1e1b17]">7.1h avg</div>
              <span className="text-[11px] text-[#2b6952] font-semibold">+20m deeper rest</span>
            </div>
          </div>

          <div className="p-5 rounded-3xl bg-white border border-[#eee7e1] shadow-xs flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[#8a726a]">Plan Adherence</span>
              <span className="text-xl">✨</span>
            </div>
            <div className="mt-4">
              <div className="text-2xl sm:text-3xl font-black text-[#1e1b17]">78%</div>
              <span className="text-[11px] text-[#6050af] font-semibold">Flexible & kind</span>
            </div>
          </div>
        </div>

        {/* Weekly Highlight Reels Carousel */}
        <div className="bg-white rounded-3xl p-6 border border-[#eee7e1] shadow-xs space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-bold text-[#1e1b17]">Weekly Highlights</h3>
              <p className="text-xs text-[#8a726a]">Memorable mindful milestones from the week</p>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() =>
                  setActiveReelIndex((prev) => (prev > 0 ? prev - 1 : reels.length - 1))
                }
                className="w-8 h-8 rounded-full bg-[#faf2ec] hover:bg-[#eee7e1] text-[#56423b] flex items-center justify-center transition-colors"
                type="button"
              >
                <span className="material-symbols-outlined text-[18px]">chevron_left</span>
              </button>
              <button
                onClick={() =>
                  setActiveReelIndex((prev) => (prev < reels.length - 1 ? prev + 1 : 0))
                }
                className="w-8 h-8 rounded-full bg-[#faf2ec] hover:bg-[#eee7e1] text-[#56423b] flex items-center justify-center transition-colors"
                type="button"
              >
                <span className="material-symbols-outlined text-[18px]">chevron_right</span>
              </button>
            </div>
          </div>

          {/* Current Reel Item Card */}
          <div className="p-5 rounded-2xl bg-[#faf2ec] border border-[#eee7e1] flex flex-col md:flex-row items-start md:items-center justify-between gap-4 transition-all">
            <div className="space-y-1.5 flex-1">
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-[#ffdbce] text-[#7f2b01]">
                  {reels[activeReelIndex].tag}
                </span>
                <span className="text-sm font-bold text-[#1e1b17]">
                  {reels[activeReelIndex].title}
                </span>
              </div>
              <p className="text-xs sm:text-sm text-[#56423b] leading-relaxed">
                {reels[activeReelIndex].desc}
              </p>
            </div>
            <span className="px-3 py-1 bg-white rounded-full text-xs font-bold text-[#2b6952] border border-[#eee7e1] shadow-xs flex-shrink-0">
              {reels[activeReelIndex].badge}
            </span>
          </div>

          <div className="flex justify-center gap-1.5 pt-1">
            {reels.map((_, i) => (
              <button
                key={i}
                onClick={() => setActiveReelIndex(i)}
                className={`h-1.5 rounded-full transition-all ${
                  activeReelIndex === i ? 'w-6 bg-[#9f4118]' : 'w-2 bg-[#eee7e1]'
                }`}
                type="button"
              />
            ))}
          </div>
        </div>
      </div>

      {/* Next Week Gentle Forward Plan */}
      <div className="bg-gradient-to-r from-[#faf2ec] via-white to-[#faf2ec] rounded-3xl p-6 sm:p-8 border border-[#eee7e1] shadow-xs space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className="text-xs font-bold uppercase tracking-wider text-[#9f4118]">
              Forward Horizon
            </span>
            <h2 className="text-xl font-bold text-[#1e1b17] mt-0.5">
              Next Week Gentle Forward Plan
            </h2>
          </div>
          <span className="px-3 py-1 bg-[#adedd0] text-[#306d56] rounded-full text-xs font-bold">
            Suggested by AURA
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="p-4 bg-[#fff8f3] rounded-2xl border border-[#ffdbce]/60 space-y-1">
            <span className="text-xs font-bold text-[#9f4118]">1. Sustainable Movement</span>
            <p className="text-xs text-[#56423b]">
              Keep 2–3 gentle walks on busy days rather than forcing long intense sessions.
            </p>
          </div>
          <div className="p-4 bg-[#fff8f3] rounded-2xl border border-[#ffdbce]/60 space-y-1">
            <span className="text-xs font-bold text-[#2b6952]">2. Weekend Buffer</span>
            <p className="text-xs text-[#56423b]">
              Buffer meal times by 30 minutes to reduce evening digestion pressure.
            </p>
          </div>
          <div className="p-4 bg-[#fff8f3] rounded-2xl border border-[#ffdbce]/60 space-y-1">
            <span className="text-xs font-bold text-[#6050af]">3. Solidify Habit</span>
            <p className="text-xs text-[#56423b]">
              Celebrate consistency before introducing new challenges.
            </p>
          </div>
        </div>

        {/* Action Button & Micro-Intention */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-2">
          <button
            onClick={() => setNextWeekPlanned(true)}
            className="w-full sm:w-auto px-6 py-3 rounded-full bg-[#9f4118] hover:bg-[#ff8a5b] text-white text-xs font-bold shadow-md transition-all flex items-center justify-center gap-2"
            type="button"
          >
            <span>✨</span>
            <span>
              {nextWeekPlanned
                ? 'Next week rhythm saved! 🎉'
                : 'Build my next week with AURA ✨'}
            </span>
          </button>
          <span className="text-xs text-[#8a726a]">Takes only 45 seconds</span>
        </div>

        {/* Weekly Micro-Intention Card with Asset Image */}
        <div className="p-4 rounded-2xl bg-white border border-[#eee7e1] flex items-center gap-4">
          <div
            className="w-14 h-14 rounded-xl bg-cover bg-center flex-shrink-0 shadow-xs"
            style={{ backgroundImage: `url('${ASSETS.journalTea}')` }}
          />
          <div className="min-w-0 flex-1">
            <span className="text-[10px] text-[#9f4118] uppercase font-bold tracking-wider">
              Weekly Micro-Intention
            </span>
            <p className="text-sm font-bold text-[#1e1b17] italic">
              “Space to breathe, room to grow.”
            </p>
            <span className="text-xs text-[#56423b]">
              Target sleep window: <strong>22:45 – 23:15</strong>
            </span>
          </div>
        </div>
      </div>

      {/* Reassurance Footer */}
      <div className="text-center py-4 text-xs text-[#8a726a]">
        AURA respects your pace. No guilt, no penalty rings, just mindful companionship.
      </div>
    </div>
  );
};
