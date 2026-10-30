// Keyboard hint shown inside a button, e.g. "N".
export default function Kbd({ children }) {
  return (
    <kbd className="kbd" aria-hidden>
      {children}
    </kbd>
  );
}
