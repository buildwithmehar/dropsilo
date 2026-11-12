export default function SuccessCheck({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="success-check"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 2.5 2.5L16 9" pathLength="1" />
    </svg>
  );
}
