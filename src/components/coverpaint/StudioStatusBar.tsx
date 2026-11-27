import { useEffect, useState } from "react";

/** 手机全屏画室的模拟系统状态栏：安全区、摄像头开孔、时间与电量。桌面隐藏。 */
export function StudioStatusBar() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(t);
  }, []);
  const hm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return (
    <div className="cpr-statusbar" aria-hidden="true">
      <span className="cpr-status-time">{hm}</span>
      <i className="cpr-notch" />
      <span className="cpr-status-icons">
        <b className="cpr-signal"><i /><i /><i /><i /></b>
        <b className="cpr-wifi" />
        <b className="cpr-battery"><i /></b>
      </span>
    </div>
  );
}
