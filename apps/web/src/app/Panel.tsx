import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

/**
 * The panel contract.
 *
 * Three panels open into the same slot in the main column — agent, fidelity, changes — and
 * before this component each of them was its own small product. They had three focus policies
 * (two grabbed focus on open, one left it in the document), two words for the same button
 * (`Close` and `esc`), two header designs typed twice and a third that had no heading at all,
 * and between them exactly zero working Escape keys: the fidelity pane had no key handling,
 * and the changes pane had a correct Escape handler on a `<section>` that nothing ever focused,
 * under a button that advertised the key.
 *
 * So the contract is stated once, here, and every panel in the slot is built from it:
 *
 *   - The panel is the focus target. `tabIndex={-1}` plus a focus on mount, because the fix
 *     for a handler that never fires is to give the element focus, not to move the handler up
 *     to the window where it would fight the editor for the key.
 *   - Escape closes it. The key handler is on the panel itself, so it fires wherever focus has
 *     since travelled inside it; the keyboard system guarantees a focused panel is handed its
 *     own Escape, and editor-scoped bindings do not fire while a panel holds focus.
 *   - The close button says **Close**. One word. `esc` was a second word for the same act that
 *     also doubled as documentation for a key that did not work.
 *   - The header is this markup, not four retypings of it.
 *
 * `name` keeps each panel's existing outer class on the element so the stylesheet keeps
 * matching while the panel CSS is unified in parallel; the shared `panel` / `panel-head` /
 * `panel-close` classes are what the unified rules should hang off.
 */

export interface PanelProps {
  /** The panel's existing class — `agent`, `fidelity`, `scriv-diff`. */
  name: string;
  /** Names the panel in its heading and to a screen reader. Both, so they cannot drift. */
  title: string;
  /** One line under the title saying what the panel does with this document. */
  subtitle?: ReactNode;
  /** Header controls that belong to the panel itself, such as the changes pane's mode tabs. */
  controls?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

export function Panel({ name, title, subtitle, controls, onClose, children }: PanelProps) {
  const ref = useRef<HTMLElement>(null);

  // Take the focus the panel needs in order to be closed again. Flipping a boolean and
  // leaving focus in the document is what made Escape unreachable in two of these three.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <section
      ref={ref}
      className={`panel ${name}`}
      // `region`, not `dialog`. None of these traps focus, none blocks the document, and the
      // writer can keep typing with one open — announcing "dialog" promises a modality the app
      // does not implement. It is also what `CommentsPane` already used, so this follows the
      // app's own prior art rather than introducing a fourth opinion.
      role="region"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className={`panel-head ${name}-head`}>
        <h2>{title}</h2>
        {subtitle ? <span className="panel-sub">{subtitle}</span> : null}
        {controls}
        <button type="button" className="panel-close" onClick={onClose} aria-label={`Close ${title}`}>
          Close
        </button>
      </header>
      {children}
    </section>
  );
}
