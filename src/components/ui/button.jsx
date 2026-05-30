export function Button({
  children,
  className = "",
  variant = "default",
  type = "button",
  ...props
}) {
  const base =
    "inline-flex items-center justify-center whitespace-nowrap px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-slate-300 disabled:pointer-events-none disabled:opacity-50";
  const variants = {
    default: "bg-slate-900 text-white hover:bg-slate-800",
    outline: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
  };

  return (
    <button
      type={type}
      className={`${base} ${variants[variant] || variants.default} ${className}`.trim()}
      {...props}
    >
      {children}
    </button>
  );
}
