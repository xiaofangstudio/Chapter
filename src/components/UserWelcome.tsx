import { companionDays } from "../lib/welcome";
import { greetingForHour, weatherEmoji, type LocalProfile } from "../lib/profile";

export function UserAvatar({
  profile,
  size = 48,
  className = "",
}: {
  profile: LocalProfile;
  size?: number;
  className?: string;
}) {
  const name = profile.name.trim() || "小方工作室";
  return (
    <span
      className={`user-avatar${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {profile.avatar ? (
        <img src={profile.avatar} alt="" />
      ) : (
        <i style={{ fontSize: Math.round(size * 0.42) }}>{name.slice(0, 1)}</i>
      )}
    </span>
  );
}

/** 本地作者名片 + 时间问候 + 天气温度 + 陪你第几天。 */
export function UserWelcome({
  profile,
  variant = "hero",
}: {
  profile: LocalProfile;
  variant?: "hero" | "workbench";
}) {
  const name = profile.name.trim() || "小方工作室";
  const weather = profile.weather.trim() || "晴朗";
  const tempRaw = profile.temperature.trim() || "14";
  const temp = /[°℃]/.test(tempRaw) || /度$/.test(tempRaw) ? tempRaw : `${tempRaw}°C`;
  const hour = new Date().getHours();
  const days = companionDays();
  const showAvatar = profile.showAvatar !== false;

  return (
    <div className={`user-welcome user-welcome-${variant}${showAvatar ? "" : " user-welcome-no-avatar"}`}>
      {showAvatar && <UserAvatar profile={profile} size={variant === "hero" ? 54 : 42} />}
      <div className="user-welcome-copy">
        <div className="user-welcome-line">
          <strong>{greetingForHour(hour)}，{name}</strong>
          <span className="user-welcome-emoji">{weatherEmoji(weather, hour)}</span>
        </div>
        <span className="user-welcome-sub">
          今天天气{weather}，{temp}
          <i>·</i>
          Chapter 陪你第 {days} 天
        </span>
      </div>
    </div>
  );
}
