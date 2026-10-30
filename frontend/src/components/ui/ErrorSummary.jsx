import { useEffect, useRef } from 'react';
import { ExclamationCircleOutlined } from '@ant-design/icons';
import './ErrorSummary.css';

/**
 * Top-of-form list of errors, shown after a failed submit. It receives focus so screen readers
 * announce it, and each entry links to its field. items: [{ name, message }], fieldIds: { name: domId }.
 */
export default function ErrorSummary({ title, items, fieldIds = {} }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!items.length) return undefined;
    const id = requestAnimationFrame(() => ref.current && ref.current.focus());
    return () => cancelAnimationFrame(id);
  }, [items]);
  if (!items.length) return null;
  return (
    <div ref={ref} tabIndex={-1} role="alert" className="error-summary fade-in">
      <p className="error-summary__title">
        <ExclamationCircleOutlined aria-hidden /> {title}
      </p>
      <ul>
        {items.map((it) => (
          <li key={it.name}>{fieldIds[it.name] ? <a href={`#${fieldIds[it.name]}`}>{it.message}</a> : it.message}</li>
        ))}
      </ul>
    </div>
  );
}
