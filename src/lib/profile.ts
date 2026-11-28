export interface LocalProfile {
  name: string;
  avatar: string | null;
  showAvatar: boolean;
  showGreeting: boolean;
  showPrompts: boolean;
  weather: string;
  temperature: string;
}

const PROFILE_KEY = "chapter.localProfile";

export const DEFAULT_PROFILE: LocalProfile = {
  name: "小方工作室",
  avatar: null,
  showAvatar: true,
  showGreeting: true,
  showPrompts: true,
  weather: "晴朗",
  temperature: "14",
};

export function readLocalProfile(): LocalProfile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return DEFAULT_PROFILE;
    const parsed = JSON.parse(raw) as Partial<LocalProfile>;
    return {
      name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.slice(0, 24) : DEFAULT_PROFILE.name,
      avatar:
        typeof parsed.avatar === "string" && parsed.avatar.startsWith("data:image/")
          ? parsed.avatar
          : null,
      showAvatar: parsed.showAvatar !== false,
      showGreeting: parsed.showGreeting !== false,
      showPrompts: parsed.showPrompts !== false,
      weather:
        typeof parsed.weather === "string" && parsed.weather.trim()
          ? parsed.weather.slice(0, 16)
          : DEFAULT_PROFILE.weather,
      temperature:
        typeof parsed.temperature === "string" && parsed.temperature.trim()
          ? parsed.temperature.slice(0, 8)
          : DEFAULT_PROFILE.temperature,
    };
  } catch {
    return DEFAULT_PROFILE;
  }
}

export function writeLocalProfile(profile: LocalProfile) {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    /* 存不下就只在本次生效 */
  }
}

/** 按本地时间给问候；11 点多会落在“中午好”，和截图一致。 */
export function greetingForHour(hour = new Date().getHours()): string {
  if (hour >= 5 && hour < 11) return "早上好";
  if (hour >= 11 && hour < 13) return "中午好";
  if (hour >= 13 && hour < 18) return "下午好";
  if (hour >= 18 && hour < 23) return "晚上好";
  return "夜深了";
}

export function weatherEmoji(weather: string, hour = new Date().getHours()): string {
  if (hour >= 19 || hour < 5) return "🌙";
  if (/雨|rain/i.test(weather)) return "🌧️";
  if (/雪|snow/i.test(weather)) return "❄️";
  if (/雷|storm/i.test(weather)) return "⛈️";
  if (/多云|阴|cloud/i.test(weather)) return "🌤️";
  if (/风|wind/i.test(weather)) return "🌬️";
  return "☀️";
}
