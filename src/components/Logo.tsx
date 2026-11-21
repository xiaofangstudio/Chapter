export function Logo({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-label="Chapter"
    >
      <path d="M6 17.5c9-4.6 18-4.6 26 0v31c-8-4.6-17-4.6-26 0z" />
      <path d="M58 17.5c-9-4.6-18-4.6-26 0v31c8-4.6 17-4.6 26 0z" />
      <path d="M32 18v30.5" strokeWidth="1.8" opacity="0.75" />
    </svg>
  );
}
