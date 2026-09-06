import React, { useState } from 'react';
import { ASSETS } from '../data/initialData';

interface Message {
  id: string;
  sender: 'aura' | 'user';
  text: string;
  time: string;
  suggestionPill?: string;
}

export const AICoachView: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'm1',
      sender: 'aura',
      text: 'Xin chào Thanh! 🌿 I am your mindful companion AURA. There are no expectations or rigid calorie targets here. How is your rhythm feeling today?',
      time: '16:45 PM',
    },
    {
      id: 'm2',
      sender: 'user',
      text: 'I felt a bit guilty because I missed my planned gym workout this evening.',
      time: '16:46 PM',
    },
    {
      id: 'm3',
      sender: 'aura',
      text: 'I hear you, and that is completely natural to feel. But let’s gently reframe it: you went for a 40-minute walk at 18:30 instead. Your body was communicating fatigue after a full week, and you chose gentle sustained circulation instead of punishing strain. You didn’t abandon your rhythm — you adapted it mindfully. That is true health craftsmanship. 🍵',
      time: '16:47 PM',
      suggestionPill: 'Would you like a 5-minute restorative bedtime breathing prompt?',
    },
  ]);

  const [inputVal, setInputVal] = useState('');
  const [isTyping, setIsTyping] = useState(false);

  const quickPrompts = [
    'Help me reframe missing gym today',
    'Gentle dinner ideas for late evenings',
    'How to sleep better after a busy week',
    'Mindful Vietnamese home cooking tips',
  ];

  const handleSend = (text: string) => {
    if (!text.trim()) return;

    const userMsg: Message = {
      id: 'u-' + Date.now(),
      sender: 'user',
      text: text.trim(),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputVal('');
    setIsTyping(true);

    setTimeout(() => {
      let replyText =
        'Thank you for sharing this with me. Remember that consistency is not about doing 100% every single day; it is about showing up with kindness for where you are right now. Let your body rest, stay hydrated with warm water, and honor your pace.';

      if (text.toLowerCase().includes('dinner') || text.toLowerCase().includes('tối')) {
        replyText =
          'For a late or gentle dinner, favor warm comforting soups like Canh cải bắp thịt bằm, Canh chua cá, or steamed egg with a small bowl of rice. Warm broth soothes the vagus nerve and aids digestion before bedtime.';
      } else if (text.toLowerCase().includes('sleep') || text.toLowerCase().includes('ngủ')) {
        replyText =
          'To unwind deeply tonight: dim overhead lights 45 minutes before bed, sip warm artichoke or chamomile tea (trà atisô), and disconnect from blue light screens. Your mind will gently settle.';
      } else if (text.toLowerCase().includes('cook') || text.toLowerCase().includes('cơm')) {
        replyText =
          'Vietnamese home cuisine is naturally rich in balance: always having a bowl of broth (canh), colorful vegetables (rau), and moderate protein. Cooking with fresh lemongrass, ginger, and turmeric also reduces inflammation.';
      }

      const auraReply: Message = {
        id: 'a-' + Date.now(),
        sender: 'aura',
        text: replyText,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      setMessages((prev) => [...prev, auraReply]);
      setIsTyping(false);
    }, 1000);
  };

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-8 space-y-6 animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-bold text-[#9f4118] uppercase tracking-wider">
            <span>Mindful AI Companion</span>
            <span>•</span>
            <span className="text-[#56423b] font-medium">Safe Reflection</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold text-[#1e1b17] tracking-tight mt-1">
            Talk with AURA
          </h1>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#e6deff] text-[#1b0062] text-xs font-bold self-start sm:self-center">
          <span>✨</span>
          <span>Zero Guilt · Gentle Coaching</span>
        </div>
      </div>

      {/* Quick Prompt Chips */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar">
        {quickPrompts.map((prompt, idx) => (
          <button
            key={idx}
            onClick={() => handleSend(prompt)}
            className="px-3.5 py-1.5 rounded-full bg-white hover:bg-[#ffdbce] text-xs font-semibold text-[#1e1b17] border border-[#eee7e1] transition-all flex-shrink-0 shadow-xs active:scale-95"
          >
            {prompt}
          </button>
        ))}
      </div>

      {/* Chat Container */}
      <div className="bg-white rounded-3xl p-6 border border-[#eee7e1] shadow-xs flex flex-col h-[500px]">
        {/* Messages scroll area */}
        <div className="flex-1 overflow-y-auto space-y-4 pr-2">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex items-start gap-3 ${
                m.sender === 'user' ? 'flex-row-reverse' : ''
              }`}
            >
              {m.sender === 'aura' ? (
                <div className="w-9 h-9 rounded-full bg-[#ffdbce] text-[#7f2b01] flex items-center justify-center text-sm font-bold flex-shrink-0 shadow-xs">
                  ✨
                </div>
              ) : (
                <img
                  alt="User"
                  src={ASSETS.thanhAvatar}
                  className="w-9 h-9 rounded-full object-cover ring-2 ring-[#ffdbce] flex-shrink-0"
                />
              )}
              <div
                className={`max-w-[80%] rounded-2xl p-4 text-xs sm:text-sm leading-relaxed ${
                  m.sender === 'user'
                    ? 'bg-[#9f4118] text-white rounded-tr-none'
                    : 'bg-[#faf2ec] text-[#1e1b17] rounded-tl-none border border-[#eee7e1]'
                }`}
              >
                <p>{m.text}</p>
                {m.suggestionPill && (
                  <button
                    onClick={() => handleSend(m.suggestionPill!)}
                    className="mt-3 px-3 py-1.5 rounded-full bg-white text-[#0b513b] text-xs font-bold border border-[#adedd0] block hover:bg-[#adedd0]/30 transition-colors"
                  >
                    🌿 {m.suggestionPill}
                  </button>
                )}
                <div
                  className={`text-[10px] mt-2 ${
                    m.sender === 'user' ? 'text-white/70' : 'text-[#8a726a]'
                  }`}
                >
                  {m.time}
                </div>
              </div>
            </div>
          ))}

          {isTyping && (
            <div className="flex items-center gap-2 text-xs text-[#8a726a] pl-12">
              <span className="w-2 h-2 rounded-full bg-[#ff8a5b] animate-pulse" />
              <span>AURA is reflecting gently...</span>
            </div>
          )}
        </div>

        {/* Input Bar */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend(inputVal);
          }}
          className="pt-4 border-t border-[#eee7e1] flex items-center gap-2"
        >
          <input
            type="text"
            placeholder="Ask AURA for mindful perspective, meal ideas, or evening reframing..."
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            className="flex-1 bg-[#faf2ec] px-4 py-2.5 rounded-full text-xs sm:text-sm text-[#1e1b17] placeholder:text-[#8a726a] focus:outline-none border border-transparent focus:border-[#ff8a5b]"
          />
          <button
            type="submit"
            className="px-5 py-2.5 rounded-full bg-[#9f4118] hover:bg-[#ff8a5b] text-white text-xs font-bold transition-all flex items-center gap-1 shadow-xs"
          >
            <span>Send</span>
            <span className="material-symbols-outlined text-[16px]">arrow_upward</span>
          </button>
        </form>
      </div>
    </div>
  );
};
