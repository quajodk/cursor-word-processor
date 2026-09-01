import { memo, useEffect, useRef } from "react";
import type { EditorController } from "../editor/controller";
import type { Alignment, ParagraphStyle } from "./prefs";

/**
 * The React side of the editing surface — and deliberately almost nothing.
 *
 * The `<div ref>` below is handed to ProseMirror once and never rendered into again: React does
 * not know or care what is inside it, so a keystroke causes no reconciliation at all. Everything
 * this component *does* re-render for (the running head, the paragraph setting) changes at human
 * frequency, and none of it is inside the mount point.
 */

export interface EditorPaneProps {
  controller: EditorController;
  headLeft: string;
  headRight: string;
  paragraph: ParagraphStyle;
  alignment: Alignment;
}

export const EditorPane = memo(function EditorPane({
  controller,
  headLeft,
  headRight,
  paragraph,
  alignment,
}: EditorPaneProps) {
  const mount = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mount.current) controller.mount(mount.current);
    return () => controller.destroy();
  }, [controller]);

  return (
    <div className="doc-scroll">
      <article className="doc-page" data-para={paragraph} data-align={alignment}>
        <div className="doc-runhead" aria-hidden="true">
          <span>{headLeft}</span>
          <span className="doc-runhead-right">{headRight}</span>
        </div>
        <div ref={mount} />
      </article>
    </div>
  );
});
