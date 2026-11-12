interface LogoProps {
  size?: number;
  showText?: boolean;
  className?: string;
}

export default function Logo({ size = 32, showText = true, className = '' }: LogoProps) {
  return (
    <div className={`inline-flex items-center gap-2.5 ${className}`}>
      <img
        src="/logo.svg?v=dropsilo"
        alt={showText ? '' : 'DropSilo'}
        width={size}
        height={size}
        className="block shrink-0"
      />
      {showText && (
        <span className="text-lg font-bold tracking-tight text-ink sm:text-xl">
          DropSilo
        </span>
      )}
    </div>
  );
}
