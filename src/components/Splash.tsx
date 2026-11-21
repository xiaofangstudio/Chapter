import { Logo } from "./Logo";

export function Splash({ leaving }: { leaving: boolean }) {
  return (
    <div className={`splash${leaving ? " leaving" : ""}`}>
      <div className="splash-inner">
        <Logo size={64} className="splash-logo" />
        <div className="splash-word">Chapter</div>
        <div className="splash-bar">
          <i />
        </div>
      </div>
    </div>
  );
}
