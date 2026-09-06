import { CrewMember, HighFiveFeedItem, MealLogDraft, TimelineSection } from '../types';

export const ASSETS = {
  logo: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDQahE7Ttl84b8MQIw4EO3lcPBtVSm8BkCbBQuPVgGG0izh0M6RrUnjsZaWnGPrGn6xtBN6s_tbu4nQwM8EPGNjhvQJwx8QJMN1GNmPiofhF7xbqXB3IQqG6yS4hOqa6wfNsidbx4dliCSivTpeSIo-6_oN-0rRq9XYF9GaVWVSDPPA4fqxMqqneFlbdYg1KOwrdplgMvtaIB9He47cANtFugqAg17nPkfzVQvptqoqrKZZGSHrugc56Q',
  thanhAvatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDytiulPCgbP0_rZVQeX4ttnHw4wMzxFCFHYtD046PHZdup1hGcaXmKnXBYIUS9cBgAY-DRkp1dx8BAfERo4SNJmY6jg3kKFb-C2OLQLQAt5xVGgqvEaGCXXFT-F1WcE0hKak-NPRPVs_SJKSHhLWMSF0dPbBM2tikQMa9Fs4LgKBTxIQwtAMdyccoT4TwUCeJtWypBHwvIhYP3siKp7xaSgRBtYKnvOBbRU4lu1eHkIs_vTJWxbLMvRg',
  coffee: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDNUjwCWfMMPPEedOjek_33ag7ZPK9-kp0CYatTYFPxWU0oYyv9ZWwE1nYC6UDnEwhdCyFHBcr7ly95Yr7dOpJMBtIhYiDvuKFOKlqpUcmStHX_wwDyRuJpZ2rKRoSBL3H85qEL8YvcHoos2YlPB7YxrsGLZ2L0yYzo2eK5GuN_Wl_5XEHtNh6a1hnobkZGnYgV5ye9aC5J1jH0FZkRVXRx2H7szl5afVPXnZgLBkkPmcTuU1iVPglljw',
  pho: 'https://lh3.googleusercontent.com/aida-public/AB6AXuD3cEd55ll_GwUzasLuN3QA110keBG3q6qL-wGDbS1fteo9JXrj5d7QeFPDQyPLPXhLJ3kJ8yeCtyk2MPqhZTDUX6LRvPMU-rB2ibs_CmJJvk7fhZVe_5cA67HPumKtoXp3t9bydRwjn1EbycpBjlfCGjGNpSsv9xHtGplu6SmRnVQHKMRvcqYcGmUvV6731u6vM8rDVe0PzJFmUVRg5xzqjvJ9grxtDARPxVyBpF4rJ-7YJ9vdX-YpYQ',
  fruit: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBSkbWUmUSvoQEsePcm4-IRB7_O9iJQcYLMn837fGaL2el_VWqfhYM5VnQrDyEO0PaLt-UUiCLkCWd7efwusenh39aZKlyc3litOoREnzBThqkpXhc0GBcKtnbOrYAOnM1RyJaLTGlTiTkySoME0IRbQMXhQ73-_3hy98QZQMYP0LQob_gN1Isd7aeDQBPJDciRdEeNRNxuVgdn6T1b6Uzw--23-2bnMa8P9fRRd5ji9J-wyGvosf0wXA',
  journalTea: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBNxixLH8406loDQgg8UGcbdObMCUXwAWg19WaLKK7zpQ10sTzcsZPe3PQWzzKN9seaOwVCgwqbBmp1EZLX3q9OQFSvipOCKa7pNWvhLWfHLV8-cs-h1EcM-uKTooWPYo3w6d3X0J-hSO8FzPI82EAGixnyN-F3XM5MY0Tc2EIJf2uz0bPn6rBMj46VORAjpj_luuVY9N7o1m03n-1iaRMSUDjDhwjPk5KF4wGB1DGjKyw6ps-TigSr2w',
  thanhCard: 'https://lh3.googleusercontent.com/aida-public/AB6AXuB12GdMHuxUmFCBnPa-S-NJ8kC7cmIevqiM_yBrPBbh3V0-E9WIlMXkxBOSgD97NiKFdBQztcLoMZ08nRdiE74eqCaU9AHs9gPhZ2DHsil-dA1JmypFKWoiW9S5k1S6x-_-vPcFJ0nrReHJ2Ejzw-NP41fBGtppD8IO6KOh7kegxm3IJZ4y-Ku8BS9vo0WBp_CdjOUF5vsBBj0VqWHaBQrw3t1ptEXAoyhjMpT7TodVO8BH5xYQiKORkA',
  minhAnhAvatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuAjH5FlmyHwkfJoVrXB-3kyedM3MsmQxQ8RBerFVq7iIvXyYEQ2nu6BauV_EBSrGlOKlkPOBwY-J22qjKx3ijCnCio4CLiUV9rADqnjYBDlE3He-GHNbYKEQoLF5QpXhvFZ1Qlx31xrapKBexxz39t4qV4H_ZhgfUBFyDpTVf4uUOYjaxp25AAhNaDsWvSiJ-ekHJiPSnxIihBkvTKD7HFE6Q1qF9rZfJ-po4tDTHY-4k30F0EG7KxLpw',
  baoLongAvatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuAeKhjN2O-VamTHgt8-mtf0jwCHiLbxf6pvRq1E4jzfWgSDdujT3mM326WTKOGtqdCZ84Q_B8K3l6aleZmV6UOT-cuAQ6wx2LF1L660_gsF86n0KuTVOeYvqKwNhS-LfpuhES8wPsjb-XYZYVnUZHUFXm4CxgpgS3MzsjuW0j36UbTanPCN1eUFmIuq1RsufNNj82uIakBJks1D5dOwMEfhfhkPyE9Y5RSz9BGDQWYEpA5y5Kp6RUNOCg',
  linhDanAvatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBIhS7CxeTmFcS0OrgqRgDqmTCD3s4Han6p8ikbs2rD3nJTeCGAnOd4Nrm_xhh4c7FGn7g5L_dYuJB-b_wKm8J6uY-RR_hbb73b2HmDIo0pUY1pPqa1QHVkhpgWzrycXXr3mZkeBUgWPpJXWVJfPkzJChp5YhRYq-2yI3LhFQYrGlhBnkHpLvu34z0fEtCggCeQPg1MmYQFsE1BT-yk0aA8sohGMf96c4YJZ_8g0Xbv4A6KK77OYVLchQ'
};

export const INITIAL_MEAL_DRAFT: MealLogDraft = {
  category: 'eat',
  rawInput: '“Trưa nay mẹ nấu cá kho, rau muống xào và canh. Tôi ăn 2 chén cơm.”',
  translation: 'Translation: “Mom cooked braised fish, stir-fried morning glory and vegetable soup for lunch. I had 2 bowls of rice.”',
  mealType: 'Lunch',
  time: '12:45 PM',
  tag: 'Home-cooked ❤️',
  foods: [
    {
      id: 'rice',
      name: 'Rice',
      vietnameseName: 'Cơm trắng',
      icon: '🍚',
      defaultPortion: '2 bowls',
      portionOptions: ['Small', '2 bowls', 'Large'],
      selectedPortion: '2 bowls',
      tagColor: 'primary'
    },
    {
      id: 'fish',
      name: 'Braised Fish',
      vietnameseName: 'Cá kho tộ',
      icon: '🐟',
      defaultPortion: '1 portion',
      portionOptions: ['Small', '1 cutlet', '2 cutlets'],
      selectedPortion: '1 cutlet',
      tagColor: 'secondary'
    },
    {
      id: 'spinach',
      name: 'Water Spinach',
      vietnameseName: 'Rau muống xào',
      icon: '🥬',
      defaultPortion: 'Medium plate',
      portionOptions: [],
      selectedPortion: 'Medium plate',
      subOptionLabel: 'Garlic / oil:',
      subOptions: ['Light', 'Normal'],
      selectedSubOption: 'Normal',
      tagColor: 'neutral'
    },
    {
      id: 'soup',
      name: 'Vegetable Soup',
      vietnameseName: 'Canh rau củ',
      icon: '🍲',
      defaultPortion: '1 small bowl',
      portionOptions: [],
      selectedPortion: '1 small bowl',
      subOptionLabel: 'Soup base:',
      subOptions: ['Clear broth', 'Meat broth'],
      selectedSubOption: 'Clear broth',
      tagColor: 'secondary'
    }
  ],
  carbs: 62,
  protein: 26,
  fiberLevel: 'High (Canh + Rau)',
  estCalories: 540,
  mindfulNote: 'Home meals with fish and water spinach are rich in Omega-3 and potassium. Great energy choice for your afternoon!'
};

export const INITIAL_TIMELINE: TimelineSection[] = [
  {
    id: 'morning',
    period: 'Morning',
    timeRange: '07:00 - 12:00',
    icon: '🌅',
    summaryFootnote: 'Morning rhythm completed with balance.',
    events: [
      {
        id: 'wake',
        time: '07:20',
        title: 'Wake up',
        statusBadge: 'Different from plan',
        statusType: 'warning',
        description: '45 minutes later than planned. Slept heavily after a long Thursday night.'
      },
      {
        id: 'breakfast',
        time: '08:00',
        title: 'Breakfast',
        statusBadge: 'Skipped',
        statusType: 'neutral',
        description: 'Skipped meal. Not hungry right after waking.',
        extraPill: {
          icon: 'water_drop',
          text: 'AURA: Water logged at 08:30 (500ml)'
        }
      }
    ]
  },
  {
    id: 'afternoon',
    period: 'Afternoon',
    timeRange: '12:00 - 17:30',
    icon: '☀️',
    summaryFootnote: 'Energy remained stable without 3PM slump.',
    events: [
      {
        id: 'lunch',
        time: '12:30',
        title: 'Lunch Nourishment',
        statusBadge: 'Satisfying',
        statusType: 'success',
        description: '',
        tags: ['🍚 Rice', '🐷 Braised pork', '🥚 Egg', '🥬 Vegetables'],
        note: {
          title: 'AURA Note',
          content: 'Different from meal plan, but shares a very similar macro & fiber meal structure. Well chosen.'
        }
      },
      {
        id: 'stretch',
        time: '15:00',
        title: 'Desk Stretch & Hydration',
        description: 'Took a 10 min break away from screen.'
      }
    ]
  },
  {
    id: 'evening',
    period: 'Evening',
    timeRange: 'HAPPENING NEXT',
    icon: '🌙',
    summaryFootnote: 'Evening wind-down goal is 22:30.',
    events: [
      {
        id: 'workout',
        time: '18:30',
        title: 'Workout Session',
        statusBadge: 'In 45 mins',
        statusType: 'urgent',
        description: 'Status: Not started yet\nA 30m brisk outdoor walk or gentle cardio.'
      },
      {
        id: 'dinner',
        time: '19:30',
        title: 'Dinner',
        statusBadge: 'Scheduled',
        statusType: 'neutral',
        description: 'Planned: Grilled chicken or home meal\nChange to takeout or skip?'
      }
    ]
  }
];

export const INITIAL_CREW: CrewMember[] = [
  {
    id: 'thanh',
    name: 'Thanh',
    avatar: ASSETS.thanhCard,
    isCurrentUser: true,
    streakDays: 5,
    badge: '17 logs',
    badgeType: 'secondary',
    statusQuote: '“Just had homemade lunch & fresh fruit”',
    recentActivity: {
      icon: '🍱',
      title: 'Mindful Cook',
      timeAgo: '12m ago',
      highlightTag: 'Home-cooked'
    },
    highFivesCount: 4,
    teaCount: 3,
    online: true
  },
  {
    id: 'minh-anh',
    name: 'Minh Anh',
    avatar: ASSETS.minhAnhAvatar,
    streakDays: 7,
    statusQuote: '“Feeling energized after morning mat”',
    recentActivity: {
      icon: '🏋️',
      title: 'Morning Yoga (35m)',
      timeAgo: '8m ago',
      highlightTag: 'Done'
    },
    highFivesCount: 12,
    teaCount: 5,
    online: true
  },
  {
    id: 'bao-long',
    name: 'Bao Long',
    avatar: ASSETS.baoLongAvatar,
    streakDays: 4,
    badge: '12k steps',
    badgeType: 'neutral',
    statusQuote: '“Swapped run for long evening walk”',
    recentActivity: {
      icon: '⚡',
      title: 'Gentle Pivot',
      timeAgo: '42m ago',
      highlightTag: 'Self-Care win'
    },
    highFivesCount: 9,
    teaCount: 6,
    online: true
  },
  {
    id: 'linh-dan',
    name: 'Linh Dan',
    avatar: ASSETS.linhDanAvatar,
    streakDays: 6,
    badge: '8.4 hrs',
    badgeType: 'secondary',
    statusQuote: '“Rest day well deserved & books”',
    recentActivity: {
      icon: '🌙',
      title: 'Deep Sleep Target',
      timeAgo: '3h ago',
      highlightTag: '100% Met'
    },
    highFivesCount: 8,
    teaCount: 11,
    online: false
  }
];

export const INITIAL_FEED: HighFiveFeedItem[] = [
  {
    id: 'f1',
    author: 'Minh Anh',
    action: 'completed Morning Yoga',
    timeAgo: '8m ago',
    quote: '“Started with stiff shoulders, ending with deep peace.”',
    reactions: [
      { emoji: '✋', count: 3 },
      { emoji: '🍵', count: 2 },
      { emoji: '👏', count: 4 }
    ]
  },
  {
    id: 'f2',
    author: 'Bao Long',
    action: 'logged 12k Walk',
    timeAgo: '42m ago',
    quote: '“No knee strain today. Listened to body cues.”',
    reactions: [
      { emoji: '👏', count: 5, label: 'Proud of you' },
      { emoji: '🍵', count: 1 }
    ]
  },
  {
    id: 'f3',
    author: 'Thanh (You)',
    action: 'logged Homemade Lunch',
    timeAgo: '1h ago',
    quote: '“Steamed lemongrass chicken & warm brown rice.”',
    reactions: [],
    customEventPill: {
      emoji: '🍵',
      text: 'Minh Anh sent a cup of tea · Long high-fived ✋'
    }
  },
  {
    id: 'f4',
    author: 'Linh Dan',
    action: 'reached Sleep Goal',
    timeAgo: '3h ago',
    quote: '“Finally unbroken sleep after a long work week.”',
    reactions: [
      { emoji: '🤍', count: 6, label: 'Rest well' }
    ]
  }
];
