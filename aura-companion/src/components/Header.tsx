import React, { useState } from 'react';
import { TabType } from '../types';
import { ASSETS } from '../data/initialData';

interface HeaderProps {
  currentTab: TabType;
  onSelectTab: (tab: TabType) => void;
  onOpenLog: () => void;
  streakCount: number;
}

export const Header: React.FC<HeaderProps> = ({
  currentTab,
  onSelectTab,
  streakCount,
}) => {
  const [showNotifications, setShowNotifications] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);

  const notifications = [
    {
      id: 1,
      title: 'Minh Anh sent you a warm cup of tea 🍵',
      time: '12m ago',
      read: false,
    },
    {
      id: 2,
      title: 'Shared quest "Weekend Reset Flow" is 100% completed! ✨',
      time: '1h ago',
      read: false,
    },
    {
      id: 3,
      title: 'AURA noticed an evening rhythm pattern in your log 👀',
      time: '3h ago',
      read: true,
    },
  ];

  return (
    <header className="fixed top-0 left-0 right-0 w-full z-50 bg-[#fff8f3]/90 backdrop-blur-xl shadow-[0_1px_12px_rgba(45,42,38,0.03)] border-b border-[#eee7e1]/60">
      <div className="h-20 max-w-7xl mx-auto px-4 lg:px-8 flex items-center justify-between gap-4">
        {/* Brand Logo & Companion pill */}
        <button
          onClick={() => onSelectTab('today')}
          className="flex items-center gap-2.5 text-left focus:outline-none group"
        >
          <img
            alt="AURA Brand Logo"
            className="h-8 w-auto object-contain transition-transform group-hover:scale-105"
            src={ASSETS.logo}
          />
          <span className="text-[22px] font-bold tracking-tight text-[#1e1b17]">
            AURA
          </span>
          <span className="px-2 py-0.5 rounded-full bg-[#adedd0] text-[#306d56] text-[11px] font-bold lowercase tracking-wide">
            companion
          </span>
        </button>

        {/* Navigation Tabs */}
        <nav
          className="hidden md:flex items-center p-1 bg-[#faf2ec] rounded-full shadow-inner"
          aria-label="Main Navigation"
        >
          <button
            onClick={() => onSelectTab('today')}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all duration-200 ${
              currentTab === 'today'
                ? 'bg-white text-[#9f4118] shadow-[0_4px_16px_-4px_rgba(255,138,91,0.25)] font-bold'
                : 'text-[#56423b] hover:text-[#1e1b17]'
            }`}
          >
            Today
          </button>
          <button
            onClick={() => onSelectTab('insights')}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all duration-200 ${
              currentTab === 'insights'
                ? 'bg-white text-[#9f4118] shadow-[0_4px_16px_-4px_rgba(255,138,91,0.25)] font-bold'
                : 'text-[#56423b] hover:text-[#1e1b17]'
            }`}
          >
            Insights
          </button>
          <button
            onClick={() => onSelectTab('history')}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all duration-200 ${
              currentTab === 'history'
                ? 'bg-white text-[#9f4118] shadow-[0_4px_16px_-4px_rgba(255,138,91,0.25)] font-bold'
                : 'text-[#56423b] hover:text-[#1e1b17]'
            }`}
          >
            History
          </button>
          <button
            onClick={() => onSelectTab('crew')}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all duration-200 ${
              currentTab === 'crew'
                ? 'bg-white text-[#9f4118] shadow-[0_4px_16px_-4px_rgba(255,138,91,0.25)] font-bold'
                : 'text-[#56423b] hover:text-[#1e1b17]'
            }`}
          >
            Crew
          </button>
          <button
            onClick={() => onSelectTab('ai-coach')}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all duration-200 flex items-center gap-1 ${
              currentTab === 'ai-coach'
                ? 'bg-white text-[#9f4118] shadow-[0_4px_16px_-4px_rgba(255,138,91,0.25)] font-bold'
                : 'text-[#56423b] hover:text-[#1e1b17]'
            }`}
          >
            <span>AI Coach</span>
            <span className="text-xs">✨</span>
          </button>
        </nav>

        {/* Right tools: Streak, Notification, Avatar */}
        <div className="flex items-center gap-3 relative">
          {/* Streak pill */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#ffdbce] text-[#7f2b01] text-xs font-bold shadow-[0_2px_8px_rgba(255,138,91,0.15)]">
            <span className="text-sm">🔥</span>
            <span>{streakCount} days</span>
          </div>

          {/* Notification button & dropdown */}
          <div className="relative">
            <button
              aria-label="Notifications"
              onClick={() => {
                setShowNotifications(!showNotifications);
                setShowProfileMenu(false);
              }}
              className="w-9 h-9 rounded-full bg-white flex items-center justify-center text-[#56423b] hover:text-[#1e1b17] shadow-[0_2px_8px_rgba(45,42,38,0.04)] hover:shadow-md transition-all relative"
              type="button"
            >
              <span className="material-symbols-outlined text-[20px]">notifications</span>
              <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-[#ff8a5b]" />
            </button>

            {showNotifications && (
              <div className="absolute right-0 mt-3 w-80 bg-white rounded-2xl shadow-xl p-4 border border-[#eee7e1] z-50 animate-in fade-in zoom-in-95 duration-150">
                <div className="flex items-center justify-between pb-3 border-b border-[#eee7e1]">
                  <span className="font-bold text-sm text-[#1e1b17]">Notifications</span>
                  <span className="text-xs text-[#2b6952] font-semibold">2 new</span>
                </div>
                <div className="divide-y divide-[#faf2ec]">
                  {notifications.map((n) => (
                    <div key={n.id} className="py-2.5 hover:bg-[#faf2ec]/50 rounded-lg px-2 transition-colors">
                      <p className="text-xs font-medium text-[#1e1b17]">{n.title}</p>
                      <span className="text-[10px] text-[#8a726a]">{n.time}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* User profile with avatar */}
          <div className="relative pl-1">
            <button
              onClick={() => {
                setShowProfileMenu(!showProfileMenu);
                setShowNotifications(false);
              }}
              className="flex items-center focus:outline-none"
              type="button"
            >
              <img
                alt="Thanh Profile"
                className="w-8 h-8 rounded-full object-cover ring-2 ring-[#ffdbce] hover:ring-[#ff8a5b] transition-all"
                src={ASSETS.thanhAvatar}
              />
            </button>

            {showProfileMenu && (
              <div className="absolute right-0 mt-3 w-56 bg-white rounded-2xl shadow-xl p-3 border border-[#eee7e1] z-50 animate-in fade-in zoom-in-95 duration-150">
                <div className="flex items-center gap-2.5 pb-3 border-b border-[#eee7e1] px-1">
                  <img
                    alt="Thanh"
                    className="w-9 h-9 rounded-full object-cover"
                    src={ASSETS.thanhAvatar}
                  />
                  <div>
                    <p className="text-sm font-bold text-[#1e1b17]">Thanh</p>
                    <p className="text-[11px] text-[#8a726a]">Gentle Flow Plan</p>
                  </div>
                </div>
                <div className="pt-2 text-xs space-y-1">
                  <button
                    onClick={() => {
                      onSelectTab('today');
                      setShowProfileMenu(false);
                    }}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-[#faf2ec] text-[#56423b] font-medium"
                  >
                    Daily Rhythm
                  </button>
                  <button
                    onClick={() => {
                      onSelectTab('insights');
                      setShowProfileMenu(false);
                    }}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-[#faf2ec] text-[#56423b] font-medium"
                  >
                    Mindful Insights
                  </button>
                  <button
                    onClick={() => {
                      onSelectTab('crew');
                      setShowProfileMenu(false);
                    }}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-[#faf2ec] text-[#56423b] font-medium"
                  >
                    Crew Sanctuary
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
