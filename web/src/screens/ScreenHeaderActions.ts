/**
 * web/src/screens/ScreenHeaderActions.ts — splits a screen header's action
 * row into the actions an operator acts on and the exports they occasionally
 * reach for.
 *
 * Every screen shipped the same three or four links in full — "Copy view
 * link", "Export CSV", "Download server CSV" — ahead of the one or two
 * buttons that actually differ. On Mist that was nine buttons wrapping to a
 * 62px band; on Compliance and UXI the row wrapped to 76px. The links are
 * worth keeping and worth hiding: they are deliberate, occasional actions,
 * not the reason anyone opened the screen.
 *
 * The split is by label rather than by an explicit prop so that no screen has
 * to be edited to opt in, and so a new export added later folds itself away.
 */
import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react';

/** "Copy filter link", "Export renewals CSV", "Download AP health CSV". */
const EXPORT_LABEL = /^(copy|export|download)\b/i;

/*
 * Filter fields had been passed in as screen "actions" too. Each renders its
 * label above its control, so one field is 42px against a 28px button, and
 * five of them wrap: Compliance ran to 147px of header and UXI to 161px,
 * with the title pushed up against a two-storey wall of dropdowns. They are
 * not actions — they narrow what the screen shows — so they get their own
 * row underneath, where they can be read left to right.
 */
const FILTER_CLASS = /(^|\s)(nt-filter-field|nt-w-\d+)(\s|$)/;

function isFilterField(node: ReactNode): boolean {
  if (!isValidElement(node)) return false;
  const { className } = (node as ReactElement<{ className?: unknown }>).props;
  return typeof className === 'string' && FILTER_CLASS.test(className);
}

/** Reads a button's label when it is written as plain text between the tags. */
function labelOf(node: ReactNode): string | null {
  if (!isValidElement(node)) return null;
  const { children } = (node as ReactElement<{ children?: ReactNode }>).props;
  if (typeof children === 'string') return children.trim();
  // <Button>Download server CSV{suffix}</Button> — lead with the text part.
  if (Array.isArray(children)) {
    const first = children.find((c) => typeof c === 'string' && c.trim() !== '');
    return typeof first === 'string' ? first.trim() : null;
  }
  return null;
}

/** Flattens fragments so a screen can group its actions however it likes. */
function flatten(node: ReactNode): ReactNode[] {
  return Children.toArray(node).flatMap((child) => {
    if (isValidElement(child) && child.type === Fragment) {
      return flatten((child as ReactElement<{ children?: ReactNode }>).props.children);
    }
    return [child];
  });
}

export function splitHeaderActions(actions: ReactNode): {
  inline: ReactNode[];
  overflow: ReactNode[];
  filters: ReactNode[];
} {
  const flat = flatten(actions);

  /* A single field alongside two buttons is not a filter bar; it only earns
     its own row once there is a set of them. */
  const candidates = flat.filter(isFilterField);
  const filters = candidates.length >= 2 ? candidates : [];
  const rest = filters.length > 0 ? flat.filter((child) => !filters.includes(child)) : flat;

  const overflow = rest.filter((child) => {
    const label = labelOf(child);
    return label !== null && EXPORT_LABEL.test(label);
  });
  /* One stray link reads better in place than behind a menu that hides a
     single item — only collapse once there is a group to collapse. */
  if (overflow.length < 2) return { inline: rest, overflow: [], filters };
  return { inline: rest.filter((child) => !overflow.includes(child)), overflow, filters };
}
