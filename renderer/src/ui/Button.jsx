export default function Button({ icon: Icon, children, reason, title, className = '', ...props }) {
  const label = (Array.isArray(children) ? children : [children]).filter(child => typeof child === 'string').join(' ');
  return <span className="button-wrap" title={reason || title}>
    <button {...props} disabled={Boolean(reason)} className={className}
      title={reason || title} aria-label={props['aria-label'] || (reason ? `${label}: ${reason}` : undefined)}>
      {Icon && <Icon aria-hidden="true" />}{children}
    </button>
  </span>;
}
