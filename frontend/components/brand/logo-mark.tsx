export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label="Alpha Payments"
    >
      <defs>
        <linearGradient id="alpha-chevron" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#f4f4f5" />
          <stop offset="45%" stopColor="#a1a1aa" />
          <stop offset="100%" stopColor="#e4e4e7" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="#0a0a0b" />
      <path
        d="M16 8.5L23 23.5H19.6L16 15.7L12.4 23.5H9L16 8.5Z"
        fill="url(#alpha-chevron)"
      />
    </svg>
  );
}
