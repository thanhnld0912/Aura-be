import React, { useState } from 'react';

interface HistoryViewProps {
  onOpenLogModal: (prompt?: string) => void;
}

export const HistoryView: React.FC<HistoryViewProps> = ({ onOpenLogModal }) => {
  const [selectedRange, setSelectedRange] = useState<'week' | 'month' | 'all'>('week');
  const [filterType, setFilterType] = useState<string>('all');

  const historyEntries = [
    {
      id: 'h1',
      date: 'Thursday, September 3',
      events: [
        {
          time: '23:15',
          title: 'Bedtime Rest',
          badge: '7.8 hrs deep',
          type: 'sleep',
          desc: 'Read 2 chapters of book before lights out. Very restful transition.',
          reflection: 'Consistent wind-down ritual helped deep sleep phase increase by 24%.',
        },
        {
          time: '19:00',
          title: 'Dinner Nourishment',
          badge: 'Home-cooked',
          type: 'food',
          desc: 'Canh chua cá lóc, cơm gạo lứt, rau luộc chấm kho quẹt.',
          reflection: 'Sour soup provided natural hydration and electrolyte replenishment.',
        },
        {
          time: '17:45',
          title: 'Sunset Brisk Walk',
          badge: '45 mins · 5.2k steps',
          type: 'movement',
          desc: 'Walk around the neighborhood lake as twilight settled.',
          reflection: 'Fresh breeze cleared workday cognitive fatigue.',
        },
      ],
    },
    {
      id: 'h2',
      date: 'Wednesday, September 2',
      events: [
        {
          time: '20:15',
          title: 'Late Dinner Adaptation',
          badge: 'Gentle Pivot',
          type: 'food',
          desc: 'Overtime at office. Ate phở bò tái nearby instead of fast food.',
          reflection: 'Smart warm comfort choice. Kept broth light to aid overnight digestion.',
        },
        {
          time: '12:45',
          title: 'Office Lunch',
          badge: 'Social Meal',
          type: 'food',
          desc: 'Bún chả with coworkers. Shared fresh herb plate.',
          reflection: 'Mindful chewing and social connection boosted midday mood.',
        },
      ],
    },
    {
      id: 'h3',
      date: 'Tuesday, September 1',
      events: [
        {
          time: '06:45',
          title: 'Morning Yoga Stretch',
          badge: '25 mins',
          type: 'movement',
          desc: 'Spine mobilizations and gentle child poses.',
          reflection: 'Awoke stiff lumbar and eased sitting tension before screen time.',
        },
        {
          time: '08:00',
          title: 'Hydration & Cà phê sáng',
          badge: 'Mindful Sip',
          type: 'food',
          desc: 'Large warm glass of water first, followed by black coffee with a splash of milk.',
          reflection: 'Hydration before caffeine preserved calm focus without jitter.',
        },
      ],
    },
  ];

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-8 space-y-8 animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-bold text-[#9f4118] uppercase tracking-wider">
            <span>Rhythm Archive</span>
            <span>•</span>
            <span className="text-[#56423b] font-medium">Memory Journal</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold text-[#1e1b17] tracking-tight mt-1">
            History & Patterns
          </h1>
        </div>
        <div className="flex items-center p-1 bg-[#faf2ec] rounded-full border border-[#eee7e1] self-start sm:self-center">
          {(['week', 'month', 'all'] as const).map((range) => (
            <button
              key={range}
              onClick={() => setSelectedRange(range)}
              className={`px-3 py-1 text-xs font-bold rounded-full capitalize transition-colors ${
                selectedRange === range
                  ? 'bg-white text-[#9f4118] shadow-xs'
                  : 'text-[#56423b] hover:text-[#1e1b17]'
              }`}
            >
              {range === 'all' ? 'All Time' : `This ${range}`}
            </button>
          ))}
        </div>
      </div>

      {/* Filter Chips */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar">
        {[
          { id: 'all', label: 'All Logs', icon: '✨' },
          { id: 'food', label: 'Nourishment', icon: '🍱' },
          { id: 'movement', label: 'Movement', icon: '🚶' },
          { id: 'sleep', label: 'Sleep & Rest', icon: '😴' },
        ].map((chip) => (
          <button
            key={chip.id}
            onClick={() => setFilterType(chip.id)}
            className={`px-3.5 py-1.5 rounded-full text-xs font-bold flex items-center gap-1.5 transition-all flex-shrink-0 ${
              filterType === chip.id
                ? 'bg-[#9f4118] text-white shadow-xs'
                : 'bg-[#faf2ec] text-[#56423b] hover:bg-[#eee7e1]'
            }`}
          >
            <span>{chip.icon}</span>
            <span>{chip.label}</span>
          </button>
        ))}
      </div>

      {/* Timeline Days */}
      <div className="space-y-6">
        {historyEntries.map((day) => {
          const filteredEvents =
            filterType === 'all'
              ? day.events
              : day.events.filter((e) => e.type === filterType);

          if (filteredEvents.length === 0) return null;

          return (
            <div key={day.id} className="bg-white rounded-3xl p-6 border border-[#eee7e1] shadow-xs space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-[#eee7e1]">
                <h2 className="text-base font-bold text-[#1e1b17]">{day.date}</h2>
                <span className="text-xs text-[#2b6952] font-semibold">
                  {filteredEvents.length} mindful entries
                </span>
              </div>

              <div className="space-y-4">
                {filteredEvents.map((evt, idx) => (
                  <div key={idx} className="p-4 rounded-2xl bg-[#faf2ec]/60 border border-[#eee7e1] space-y-2">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-[#9f4118]">{evt.time}</span>
                        <h3 className="text-sm font-bold text-[#1e1b17]">{evt.title}</h3>
                      </div>
                      <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-white text-[#2b6952] border border-[#eee7e1]">
                        {evt.badge}
                      </span>
                    </div>
                    <p className="text-xs text-[#56423b] leading-relaxed">{evt.desc}</p>
                    <div className="p-2.5 rounded-xl bg-white text-[11px] text-[#0b513b] border border-[#adedd0]/50 flex items-start gap-1.5">
                      <span className="text-xs">🌿</span>
                      <span>{evt.reflection}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Bottom log invitation */}
      <div className="p-6 rounded-3xl bg-gradient-to-r from-[#faf2ec] via-white to-[#faf2ec] border border-[#eee7e1] text-center space-y-2">
        <h3 className="text-base font-bold text-[#1e1b17]">Looking for a past day?</h3>
        <p className="text-xs text-[#56423b]">
          Every moment logged without guilt builds self-compassion over time.
        </p>
        <button
          onClick={() => onOpenLogModal()}
          className="mt-2 px-5 py-2 rounded-full bg-[#9f4118] text-white text-xs font-bold hover:bg-[#ff8a5b] transition-colors"
        >
          + Add reflection to history
        </button>
      </div>
    </div>
  );
};
