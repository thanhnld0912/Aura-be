import React, { useState } from 'react';

interface BottomBarProps {
  onOpenLog: (initialText?: string) => void;
  onQuickVoice: () => void;
}

export const BottomBar: React.FC<BottomBarProps> = ({ onOpenLog, onQuickVoice }) => {
  const [inputText, setInputText] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) {
      onOpenLog();
      return;
    }
    onOpenLog(inputText);
    setInputText('');
  };

  return (
    <div className="fixed bottom-6 inset-x-0 z-40 flex justify-center px-4 pointer-events-none">
      <div className="w-full max-w-xl pointer-events-auto bg-white/95 backdrop-blur-2xl p-2 rounded-full shadow-[0_16px_36px_-6px_rgba(45,42,38,0.14)] border border-[#eee7e1]/80 flex items-center gap-2">
        {/* Quick Add / Open Modal Button */}
        <button
          onClick={() => onOpenLog()}
          className="w-10 h-10 rounded-full bg-[#9f4118] text-white flex items-center justify-center flex-shrink-0 shadow-[0_4px_12px_rgba(255,138,91,0.35)] hover:scale-105 active:scale-95 transition-transform"
          type="button"
          aria-label="Create log"
        >
          <span className="material-symbols-outlined text-[20px]">add</span>
        </button>

        {/* Text Input */}
        <form onSubmit={handleSubmit} className="flex-1 min-w-0">
          <input
            className="w-full bg-transparent px-3 py-1.5 text-sm text-[#1e1b17] placeholder:text-[#56423b]/60 focus:outline-none"
            placeholder="+ Tell AURA what happened... 🎤"
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
          />
        </form>

        {/* Voice Button */}
        <button
          onClick={onQuickVoice}
          className="px-3.5 py-1.5 rounded-full bg-[#eee7e1] hover:bg-[#e8e1db] text-[#1e1b17] text-xs font-semibold transition-colors flex items-center gap-1.5 flex-shrink-0"
          type="button"
        >
          <span className="material-symbols-outlined text-[16px] text-[#9f4118]">mic</span>
          <span>Voice</span>
        </button>

        {/* Sparkle Auto Action */}
        <button
          onClick={() => onOpenLog(inputText || 'Trưa nay mẹ nấu cá kho, rau muống xào và canh. Tôi ăn 2 chén cơm.')}
          className="w-9 h-9 rounded-full bg-[#e6deff] text-[#1b0062] hover:bg-[#c9beff] flex items-center justify-center flex-shrink-0 transition-colors"
          type="button"
          title="Auto parse mindful details"
        >
          <span className="material-symbols-outlined text-[18px]">auto_awesome</span>
        </button>
      </div>
    </div>
  );
};
