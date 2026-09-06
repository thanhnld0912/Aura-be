import React, { useState } from 'react';
import { ActivityCategory, FoodItem, MealLogDraft } from '../types';
import { ASSETS, INITIAL_MEAL_DRAFT } from '../data/initialData';

interface LogModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddLogSuccess: (log: MealLogDraft) => void;
  initialPrompt?: string;
}

export const LogModal: React.FC<LogModalProps> = ({
  isOpen,
  onClose,
  onAddLogSuccess,
  initialPrompt,
}) => {
  if (!isOpen) return null;

  const [activeCategory, setActiveCategory] = useState<ActivityCategory>('eat');
  const [activeMode, setActiveMode] = useState<'photo' | 'describe' | 'quick'>('describe');
  const [mealDraft, setMealDraft] = useState<MealLogDraft>({
    ...INITIAL_MEAL_DRAFT,
    rawInput: initialPrompt || INITIAL_MEAL_DRAFT.rawInput,
  });
  const [isEditingInput, setIsEditingInput] = useState(false);
  const [inputText, setInputText] = useState(mealDraft.rawInput);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavedSuccess, setIsSavedSuccess] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [fastLogged, setFastLogged] = useState(false);

  // Update portion of a food item
  const handlePortionChange = (foodId: string, newPortion: string) => {
    setMealDraft((prev) => {
      const updatedFoods = prev.foods.map((food) =>
        food.id === foodId ? { ...food, selectedPortion: newPortion } : food
      );
      // Recalculate estimated calories gently
      let calAdjustment = 0;
      if (foodId === 'rice') {
        calAdjustment = newPortion === 'Small' ? -100 : newPortion === 'Large' ? 120 : 0;
      }
      if (foodId === 'fish') {
        calAdjustment = newPortion === 'Small' ? -60 : newPortion === '2 cutlets' ? 140 : 0;
      }
      return {
        ...prev,
        foods: updatedFoods,
        estCalories: Math.max(300, 540 + calAdjustment),
      };
    });
  };

  const handleSubOptionChange = (foodId: string, subOption: string) => {
    setMealDraft((prev) => ({
      ...prev,
      foods: prev.foods.map((food) =>
        food.id === foodId ? { ...food, selectedSubOption: subOption } : food
      ),
    }));
  };

  const handleConfirmSave = () => {
    setIsSaving(true);
    setTimeout(() => {
      setIsSaving(false);
      setIsSavedSuccess(true);
      setTimeout(() => {
        onAddLogSuccess(mealDraft);
        setIsSavedSuccess(false);
        onClose();
      }, 1200);
    }, 600);
  };

  const handleSimulateVoice = () => {
    setIsListening(true);
    setTimeout(() => {
      setInputText('“Vừa ăn một tô bún bò Huế thơm phức và uống trà đá.”');
      setMealDraft((prev) => ({
        ...prev,
        rawInput: '“Vừa ăn một tô bún bò Huế thơm phức và uống trà đá.”',
        translation: 'Translation: “Just enjoyed a fragrant bowl of Hue spicy beef noodle soup and iced tea.”',
        foods: [
          {
            id: 'bun-bo',
            name: 'Bún Bò Huế',
            vietnameseName: 'Bún bò tái nạm',
            icon: '🍜',
            defaultPortion: '1 bowl',
            portionOptions: ['Small', '1 bowl', 'Special bowl'],
            selectedPortion: '1 bowl',
            tagColor: 'primary',
          },
          {
            id: 'herbs',
            name: 'Fresh Herbs',
            vietnameseName: 'Rau sống & hoa chuối',
            icon: '🌿',
            defaultPortion: 'Generous',
            portionOptions: [],
            selectedPortion: 'Generous',
            tagColor: 'secondary',
          },
        ],
        estCalories: 580,
        mindfulNote: 'Rich beef broth paired with fresh banana blossom and herbs provides iron and digestive enzymes.',
      }));
      setIsListening(false);
    }, 1500);
  };

  const handleQuickInspirationLog = (title: string, vName: string, icon: string, cal: number) => {
    const customMeal: MealLogDraft = {
      category: 'eat',
      rawInput: `“Đã dùng ${vName}.”`,
      translation: `Translation: “Enjoyed ${title}.”`,
      mealType: 'Snack / Drink',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      tag: 'Mindful Moment ✨',
      foods: [
        {
          id: 'quick-' + Date.now(),
          name: title,
          vietnameseName: vName,
          icon: icon,
          defaultPortion: '1 portion',
          portionOptions: ['Normal', 'Large'],
          selectedPortion: 'Normal',
        },
      ],
      carbs: Math.round(cal * 0.12),
      protein: Math.round(cal * 0.04),
      fiberLevel: 'Moderate',
      estCalories: cal,
      mindfulNote: `Logged ${title} with ease. Staying hydrated and present.`,
    };
    onAddLogSuccess(customMeal);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#1e1b17]/40 backdrop-blur-md flex justify-center p-3 sm:p-6 lg:p-8 animate-in fade-in duration-200">
      <div className="relative w-full max-w-5xl my-auto">
        {/* Glow Accents */}
        <div className="absolute -top-12 left-1/4 w-80 h-80 bg-[#ffdbce]/40 rounded-full blur-3xl pointer-events-none -z-10" />
        <div className="absolute top-1/3 -right-10 w-72 h-72 bg-[#e6deff]/30 rounded-full blur-3xl pointer-events-none -z-10" />

        {/* Modal Container */}
        <div className="bg-white rounded-3xl shadow-[0_24px_54px_-12px_rgba(75,40,20,0.14),0_4px_20px_rgba(45,42,38,0.06)] p-5 sm:p-8 lg:p-10 relative overflow-hidden border border-[#eee7e1]/80 max-h-[92vh] overflow-y-auto">
          {/* Header Ribbon */}
          <div className="flex items-center justify-between gap-4 pb-6 border-b border-[#eee7e1]/60">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-[#ffdbce] flex items-center justify-center text-[#7f2b01] shadow-sm flex-shrink-0">
                <span className="material-symbols-outlined text-[24px]">auto_awesome</span>
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-xl sm:text-2xl font-bold text-[#1e1b17]">What happened?</h2>
                  <span className="px-2.5 py-0.5 bg-[#adedd0] text-[#306d56] rounded-full text-xs font-bold">
                    Live Context
                  </span>
                </div>
                <p className="text-xs sm:text-sm text-[#56423b] mt-0.5">
                  Log naturally in Vietnamese or English — AURA extracts the mindful details
                </p>
              </div>
            </div>
            <button
              aria-label="Close composer"
              onClick={onClose}
              className="w-10 h-10 rounded-full bg-[#eee7e1] hover:bg-[#e8e1db] text-[#56423b] hover:text-[#1e1b17] flex items-center justify-center transition-all duration-200 flex-shrink-0"
              type="button"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>

          {/* Activity Category Selector */}
          <div className="flex items-center gap-2 overflow-x-auto py-4 no-scrollbar">
            {[
              { key: 'eat', label: 'I ate', icon: '🍱' },
              { key: 'workout', label: 'I worked out', icon: '🏋️' },
              { key: 'walk', label: 'I walked', icon: '🚶' },
              { key: 'water', label: 'I drank water', icon: '💧' },
              { key: 'sleep', label: 'I slept', icon: '😴' },
              { key: 'check-in', label: 'Check-in', icon: '😊' },
              { key: 'other', label: 'Something else', icon: '✍️' },
            ].map((cat) => {
              const isActive = activeCategory === cat.key;
              return (
                <button
                  key={cat.key}
                  onClick={() => setActiveCategory(cat.key as ActivityCategory)}
                  className={`px-4 py-2 rounded-full text-sm font-semibold flex items-center gap-2 flex-shrink-0 transition-all active:scale-95 ${
                    isActive
                      ? 'bg-[#9f4118] text-white shadow-[0_8px_20px_-4px_rgba(255,138,91,0.4)]'
                      : 'bg-[#faf2ec] hover:bg-[#f4ede6] text-[#56423b]'
                  }`}
                  type="button"
                >
                  <span className="text-base">{cat.icon}</span>
                  <span>{cat.label}</span>
                </button>
              );
            })}
          </div>

          {/* 3 Giant Visual Modes Bar */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1 pb-6">
            {/* Mode 1: Photo */}
            <button
              onClick={() => setActiveMode('photo')}
              type="button"
              className={`text-left rounded-2xl p-4 transition-all duration-300 flex items-center gap-3 border ${
                activeMode === 'photo'
                  ? 'bg-[#ffdbce]/40 border-[#ff8a5b] shadow-sm'
                  : 'bg-[#faf2ec] hover:bg-[#f4ede6] border-transparent'
              }`}
            >
              <div className="w-11 h-11 rounded-full bg-white flex items-center justify-center text-[#9f4118] shadow-sm flex-shrink-0">
                <span className="material-symbols-outlined text-[24px]">photo_camera</span>
              </div>
              <div className="min-w-0">
                <div className="text-sm font-bold text-[#1e1b17]">Take a photo</div>
                <p className="text-xs text-[#56423b] truncate">Let AI estimate ingredients</p>
              </div>
            </button>

            {/* Mode 2: Natural Language (Active) */}
            <button
              onClick={() => setActiveMode('describe')}
              type="button"
              className={`text-left rounded-2xl p-4 transition-all duration-300 flex items-center gap-3 border ${
                activeMode === 'describe'
                  ? 'bg-[#ffdbce]/60 border-[#ff8a5b]/60 shadow-[0_6px_20px_-6px_rgba(255,138,91,0.25)]'
                  : 'bg-[#faf2ec] hover:bg-[#f4ede6] border-transparent'
              }`}
            >
              <div className="w-11 h-11 rounded-full bg-[#9f4118] text-white flex items-center justify-center shadow-md flex-shrink-0">
                <span className="material-symbols-outlined text-[24px]">edit_note</span>
              </div>
              <div className="min-w-0">
                <div className="text-sm font-bold text-[#370e00] flex items-center gap-2">
                  <span>Tell AURA</span>
                  <span className="w-2 h-2 rounded-full bg-[#9f4118] animate-pulse" />
                </div>
                <p className="text-xs text-[#7f2b01] truncate">Just describe your meal</p>
              </div>
            </button>

            {/* Mode 3: Quick Add */}
            <button
              onClick={() => setActiveMode('quick')}
              type="button"
              className={`text-left rounded-2xl p-4 transition-all duration-300 flex items-center gap-3 border ${
                activeMode === 'quick'
                  ? 'bg-[#adedd0]/50 border-[#2b6952] shadow-sm'
                  : 'bg-[#faf2ec] hover:bg-[#f4ede6] border-transparent'
              }`}
            >
              <div className="w-11 h-11 rounded-full bg-white flex items-center justify-center text-[#2b6952] shadow-sm flex-shrink-0">
                <span className="material-symbols-outlined text-[24px]">bolt</span>
              </div>
              <div className="min-w-0">
                <div className="text-sm font-bold text-[#1e1b17]">Quick add</div>
                <p className="text-xs text-[#56423b] truncate">Pick the main ingredients</p>
              </div>
            </button>
          </div>

          {/* Conversational Input Card */}
          <div className="rounded-2xl bg-[#faf2ec] p-4 sm:p-5 transition-all mb-6 border border-[#eee7e1]/80">
            <div className="flex items-center justify-between pb-2 text-[#56423b] text-xs font-semibold">
              <div className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[16px] text-[#9f4118]">forum</span>
                <span>Thanh's Voice & Text Log</span>
              </div>
              <span className="text-[#2b6952] font-bold tracking-wider uppercase">Extracted Just Now</span>
            </div>

            {/* Simulated Natural Text Input */}
            <div className="relative flex items-start gap-3 py-2">
              <div className="w-2.5 h-2.5 rounded-full bg-[#ff8a5b] mt-2 flex-shrink-0 animate-ping" />
              <div className="w-full">
                {isEditingInput ? (
                  <div className="space-y-2">
                    <textarea
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      className="w-full bg-white rounded-xl p-3 text-base text-[#1e1b17] border border-[#ff8a5b] focus:outline-none"
                      rows={2}
                    />
                    <button
                      onClick={() => {
                        setMealDraft((prev) => ({ ...prev, rawInput: inputText }));
                        setIsEditingInput(false);
                      }}
                      className="px-3 py-1 bg-[#9f4118] text-white rounded-full text-xs font-semibold"
                    >
                      Update
                    </button>
                  </div>
                ) : (
                  <div>
                    <div
                      onClick={() => setIsEditingInput(true)}
                      className="text-lg sm:text-xl font-semibold text-[#1e1b17] leading-snug cursor-pointer hover:text-[#9f4118] transition-colors"
                      title="Click to edit raw text"
                    >
                      {mealDraft.rawInput}
                    </div>
                    <p className="text-xs sm:text-sm text-[#56423b]/80 pt-1">
                      {mealDraft.translation}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Input Footer Micro controls */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-[#e8e1db]/60">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="px-2.5 py-1 bg-[#e8e1db] text-[#56423b] rounded-full text-xs font-medium">
                  Meal: {mealDraft.mealType}
                </span>
                <span className="px-2.5 py-1 bg-[#e8e1db] text-[#56423b] rounded-full text-xs font-medium">
                  Time: {mealDraft.time}
                </span>
                <span className="px-2.5 py-1 bg-[#adedd0] text-[#306d56] rounded-full text-xs font-semibold">
                  {mealDraft.tag}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleSimulateVoice}
                  className={`p-2 rounded-full transition-colors ${
                    isListening
                      ? 'bg-[#ff8a5b] text-white animate-bounce'
                      : 'bg-white hover:bg-[#eee7e1] text-[#56423b]'
                  }`}
                  title={isListening ? 'Listening...' : 'Simulate voice dictation'}
                  type="button"
                >
                  <span className="material-symbols-outlined text-[18px]">mic</span>
                </button>
                <button
                  onClick={() => setActiveMode('photo')}
                  className="p-2 rounded-full bg-white hover:bg-[#eee7e1] text-[#56423b] transition-colors"
                  title="Add photo attach"
                  type="button"
                >
                  <span className="material-symbols-outlined text-[18px]">add_a_photo</span>
                </button>
              </div>
            </div>
          </div>

          {/* AI Instant Understanding Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mb-8">
            {/* Left Col: Food Elements & Portions */}
            <div className="lg:col-span-8 flex flex-col gap-4">
              {/* AI Speech Bubble Header */}
              <div className="flex items-start gap-3 bg-gradient-to-r from-[#e6deff]/40 via-[#faf2ec] to-[#ffdbce]/20 p-4 rounded-2xl border border-[#eee7e1]/60">
                <div className="relative flex-shrink-0">
                  <div className="w-11 h-11 rounded-full bg-[#6050af] text-white flex items-center justify-center font-bold text-lg shadow-sm">
                    ✨
                  </div>
                  <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-[#b0f0d2] rounded-full flex items-center justify-center text-[10px]">
                    🌱
                  </div>
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-[#1e1b17]">AURA Nutritionist</span>
                    <span className="text-xs text-[#56423b]">Instant parsing</span>
                  </div>
                  <p className="text-sm text-[#56423b] mt-0.5">
                    I understood! Here is what I captured from your home-cooked meal:
                  </p>
                </div>
              </div>

              {/* Parsed Food Elements Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {mealDraft.foods.map((food) => (
                  <div
                    key={food.id}
                    className="bg-white p-4 rounded-2xl shadow-sm border border-[#eee7e1] flex flex-col justify-between gap-3 hover:border-[#ff8a5b]/40 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <span className="text-2xl p-2 bg-[#faf2ec] rounded-full">
                          {food.icon}
                        </span>
                        <div>
                          <h3 className="text-base font-bold text-[#1e1b17]">{food.name}</h3>
                          <span className="text-xs text-[#56423b]">{food.vietnameseName}</span>
                        </div>
                      </div>
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-xs font-bold ${
                          food.tagColor === 'primary'
                            ? 'bg-[#ffdbce] text-[#7f2b01]'
                            : food.tagColor === 'secondary'
                            ? 'bg-[#adedd0] text-[#306d56]'
                            : 'bg-[#e8e1db] text-[#56423b]'
                        }`}
                      >
                        {food.selectedPortion}
                      </span>
                    </div>

                    {/* Portion Buttons */}
                    {food.portionOptions.length > 0 && (
                      <div className="pt-2 flex items-center gap-2">
                        <span className="text-xs text-[#56423b] flex-shrink-0">Portion:</span>
                        <div className="flex items-center gap-1 bg-[#faf2ec] p-1 rounded-full text-xs">
                          {food.portionOptions.map((opt) => (
                            <button
                              key={opt}
                              onClick={() => handlePortionChange(food.id, opt)}
                              className={`px-2.5 py-0.5 rounded-full text-xs transition-all ${
                                food.selectedPortion === opt
                                  ? 'bg-white font-bold text-[#9f4118] shadow-xs'
                                  : 'text-[#56423b] hover:text-[#1e1b17]'
                              }`}
                              type="button"
                            >
                              {opt}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Sub Options (e.g., garlic/oil or broth) */}
                    {food.subOptions && (
                      <div className="pt-2 flex items-center gap-2">
                        <span className="text-xs text-[#56423b] flex-shrink-0">
                          {food.subOptionLabel || 'Option:'}
                        </span>
                        <div className="flex items-center gap-1 bg-[#faf2ec] p-1 rounded-full text-xs">
                          {food.subOptions.map((subOpt) => (
                            <button
                              key={subOpt}
                              onClick={() => handleSubOptionChange(food.id, subOpt)}
                              className={`px-2.5 py-0.5 rounded-full text-xs transition-all ${
                                food.selectedSubOption === subOpt
                                  ? 'bg-white font-bold text-[#1e1b17] shadow-xs'
                                  : 'text-[#56423b] hover:text-[#1e1b17]'
                              }`}
                              type="button"
                            >
                              {subOpt}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Action Buttons Bar */}
              <div className="flex flex-col sm:flex-row items-center gap-3 pt-2">
                <button
                  id="confirm-log-btn"
                  onClick={handleConfirmSave}
                  disabled={isSaving || isSavedSuccess}
                  className={`w-full sm:flex-1 py-3 px-6 rounded-full font-bold text-sm shadow-[0_10px_24px_-4px_rgba(255,138,91,0.4)] hover:scale-[1.01] active:scale-[0.98] transition-all flex items-center justify-center gap-2 text-white ${
                    isSavedSuccess
                      ? 'bg-[#2b6952]'
                      : 'bg-[#9f4118] hover:bg-[#ff8a5b]'
                  }`}
                  type="button"
                >
                  {isSaving ? (
                    <>
                      <span className="material-symbols-outlined text-[20px] animate-spin">sync</span>
                      <span>Saving to timeline...</span>
                    </>
                  ) : isSavedSuccess ? (
                    <>
                      <span className="material-symbols-outlined text-[20px]">task_alt</span>
                      <span>Logged! +25 Mindful pts 🎉</span>
                    </>
                  ) : (
                    <>
                      <span className="material-symbols-outlined text-[20px]">check_circle</span>
                      <span>✓ Looks right — Add to today's timeline</span>
                    </>
                  )}
                </button>

                <button
                  onClick={() => setIsEditingInput(!isEditingInput)}
                  className="w-full sm:w-auto py-3 px-6 rounded-full bg-[#faf2ec] hover:bg-[#f4ede6] text-[#1e1b17] font-semibold text-sm transition-colors flex items-center justify-center gap-2 border border-[#eee7e1]"
                  type="button"
                >
                  <span className="material-symbols-outlined text-[18px]">tune</span>
                  <span>✏️ Edit details</span>
                </button>
              </div>
            </div>

            {/* Right Col: Nutritional Balance & Mindful Insight */}
            <div className="lg:col-span-4 flex flex-col gap-4">
              <div className="bg-[#faf2ec] p-5 rounded-2xl border border-[#eee7e1] flex flex-col justify-between h-full">
                <div>
                  <div className="flex items-center justify-between pb-3 border-b border-[#eee7e1]">
                    <span className="text-sm font-bold text-[#1e1b17]">Mindful Breakdown</span>
                    <span className="text-xs px-2.5 py-0.5 bg-white rounded-full text-[#2b6952] font-bold shadow-xs">
                      Balanced plate
                    </span>
                  </div>

                  {/* Macro Bars */}
                  <div className="space-y-4 pt-3">
                    <div>
                      <div className="flex justify-between text-xs pb-1">
                        <span className="text-[#56423b]">Carbohydrates (Rice)</span>
                        <span className="font-semibold text-[#1e1b17]">{mealDraft.carbs}g</span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-[#e8e1db] overflow-hidden">
                        <div className="h-full bg-[#9f4118] rounded-full" style={{ width: '58%' }} />
                      </div>
                    </div>

                    <div>
                      <div className="flex justify-between text-xs pb-1">
                        <span className="text-[#56423b]">Protein (Braised fish)</span>
                        <span className="font-semibold text-[#1e1b17]">{mealDraft.protein}g</span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-[#e8e1db] overflow-hidden">
                        <div className="h-full bg-[#2b6952] rounded-full" style={{ width: '48%' }} />
                      </div>
                    </div>

                    <div>
                      <div className="flex justify-between text-xs pb-1">
                        <span className="text-[#56423b]">Fiber & Greens</span>
                        <span className="font-semibold text-[#1e1b17]">{mealDraft.fiberLevel}</span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-[#e8e1db] overflow-hidden">
                        <div className="h-full bg-[#6050af] rounded-full" style={{ width: '85%' }} />
                      </div>
                    </div>
                  </div>

                  {/* Estimated Energy Pill */}
                  <div className="mt-5 p-3 bg-white rounded-xl shadow-xs flex items-center justify-between border border-[#eee7e1]">
                    <div className="flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-[18px] text-[#9f4118]">
                        local_fire_department
                      </span>
                      <span className="text-xs font-semibold text-[#1e1b17]">Est. Energy</span>
                    </div>
                    <span className="text-base font-bold text-[#9f4118]">
                      ~{mealDraft.estCalories} kcal
                    </span>
                  </div>
                </div>

                {/* Warm AI Note */}
                <div className="mt-4 p-3 rounded-xl bg-[#adedd0]/40 flex items-start gap-2 border border-[#adedd0]/60">
                  <span className="text-base mt-0.5">🌿</span>
                  <p className="text-xs text-[#0b513b] leading-relaxed">
                    {mealDraft.mindfulNote}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Section 4: 1-Tap Fast Log Widget */}
          <div className="pt-2">
            <div className="bg-gradient-to-r from-[#faf2ec] via-[#ffdbce]/25 to-[#faf2ec] p-4 sm:p-5 rounded-2xl border border-[#eee7e1]">
              <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-full bg-white text-[#9f4118] flex items-center justify-center shadow-xs text-xl flex-shrink-0">
                    ⚡
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-base font-bold text-[#1e1b17]">
                        Eat this again? 1-Tap Fast Log
                      </h4>
                      <span className="px-2 py-0.5 bg-[#ffdbce] text-[#7f2b01] rounded-full text-[11px] font-bold">
                        Favorite Habit
                      </span>
                    </div>
                    <p className="text-sm text-[#56423b] font-medium mt-0.5">
                      Cơm nhà: Cơm + thịt kho trứng + canh rau ngót
                    </p>
                    <span className="text-xs text-[#56423b]/70">
                      Logged 4 times this month (typical weeknight dinner)
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 w-full md:w-auto">
                  <button
                    onClick={() => {
                      setFastLogged(true);
                      setTimeout(() => {
                        handleQuickInspirationLog('Cơm thịt kho trứng & canh rau ngót', 'Cơm nhà kinh điển', '🍲', 510);
                      }, 400);
                    }}
                    className="flex-1 md:flex-none px-5 py-2 rounded-full bg-[#9f4118] text-white text-xs font-bold hover:shadow-md transition-all active:scale-95"
                    type="button"
                  >
                    {fastLogged ? 'Logging...' : 'Yes, similar portion'}
                  </button>
                  <button
                    onClick={() => {
                      setInputText('Cơm + thịt kho trứng + canh rau ngót');
                      setIsEditingInput(true);
                    }}
                    className="px-4 py-2 rounded-full bg-white hover:bg-[#faf2ec] text-[#1e1b17] text-xs font-semibold transition-colors border border-[#eee7e1]"
                    type="button"
                  >
                    Change
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Young Adult Lifestyle Food Moments Cards */}
          <div className="mt-6 pt-2 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div
              onClick={() => handleQuickInspirationLog('Cà phê sữa đá', 'Cà phê sữa đá', '☕', 140)}
              className="rounded-2xl p-3 bg-white shadow-xs border border-[#eee7e1] flex items-center gap-3 hover:scale-[1.02] transition-transform cursor-pointer"
            >
              <div
                className="w-12 h-12 rounded-xl bg-cover bg-center flex-shrink-0"
                style={{ backgroundImage: `url('${ASSETS.coffee}')` }}
              />
              <div className="min-w-0">
                <span className="text-[10px] text-[#9f4118] uppercase font-bold tracking-wider">
                  Quick Drink
                </span>
                <p className="text-xs font-bold text-[#1e1b17] truncate">Cà phê sữa đá</p>
                <span className="text-[11px] text-[#56423b]">Tap to log 1 glass</span>
              </div>
            </div>

            <div
              onClick={() => handleQuickInspirationLog('Phở bò tái chín', 'Phở bò', '🍜', 490)}
              className="rounded-2xl p-3 bg-white shadow-xs border border-[#eee7e1] flex items-center gap-3 hover:scale-[1.02] transition-transform cursor-pointer"
            >
              <div
                className="w-12 h-12 rounded-xl bg-cover bg-center flex-shrink-0"
                style={{ backgroundImage: `url('${ASSETS.pho}')` }}
              />
              <div className="min-w-0">
                <span className="text-[10px] text-[#2b6952] uppercase font-bold tracking-wider">
                  Breakfast Classic
                </span>
                <p className="text-xs font-bold text-[#1e1b17] truncate">Phở bò tái chín</p>
                <span className="text-[11px] text-[#56423b]">Tap to log 1 bowl</span>
              </div>
            </div>

            <div
              onClick={() => handleQuickInspirationLog('Trái cây dĩa (Ổi, xoài)', 'Trái cây', '🍉', 95)}
              className="rounded-2xl p-3 bg-white shadow-xs border border-[#eee7e1] flex items-center gap-3 hover:scale-[1.02] transition-transform cursor-pointer"
            >
              <div
                className="w-12 h-12 rounded-xl bg-cover bg-center flex-shrink-0"
                style={{ backgroundImage: `url('${ASSETS.fruit}')` }}
              />
              <div className="min-w-0">
                <span className="text-[10px] text-[#6050af] uppercase font-bold tracking-wider">
                  Mindful Snack
                </span>
                <p className="text-xs font-bold text-[#1e1b17] truncate">Trái cây dĩa (Ổi, xoài)</p>
                <span className="text-[11px] text-[#56423b]">Tap to log light snack</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
