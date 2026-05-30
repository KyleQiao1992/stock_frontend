export function Card({ children, className = "", ...props }) {
  return (
    <div className={`border border-slate-200 bg-white shadow-sm ${className}`.trim()} {...props}>
      {children}
    </div>
  );
}

export function CardContent({ children, className = "", ...props }) {
  return (
    <div className={className} {...props}>
      {children}
    </div>
  );
}
