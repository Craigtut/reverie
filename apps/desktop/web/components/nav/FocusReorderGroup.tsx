import { useRef, useState, type ReactNode } from 'react';
import { Reorder } from 'motion/react';

import { css } from '../../styled-system/css';
import type { ShellFocus } from '../../domain';

// Drag-to-reorder wrapper for a project's (or General's) focus rows. The whole
// row is the drag affordance, so you grab a focus anywhere and drop it in a new
// spot; a press that does not move still passes through as a click (open the
// focus) or a caret toggle. Order is held locally for an instant, snap-free drop
// and the caller persists it, after which the shell snapshot reconciles back
// into place. Neighbors slide out of the way and the dragged row lifts slightly,
// the one bit of playful motion in an otherwise calm rail.
export function FocusReorderGroup({
  focuses,
  onReorder,
  renderFocus,
}: {
  focuses: ShellFocus[];
  onReorder: (orderedIds: string[]) => void;
  renderFocus: (focus: ShellFocus) => ReactNode;
}) {
  const ids = focuses.map(focus => focus.id);
  const [order, setOrder] = useState<string[]>(ids);

  // Reset the local order only when the *set* of focuses changes (one added,
  // removed, or archived), not when a persist merely rewrites sort_order. That
  // keeps an in-flight optimistic reorder from being clobbered by the snapshot
  // it just produced, while still picking up real membership changes.
  const membershipKey = [...ids].sort().join('|');
  const membershipRef = useRef(membershipKey);
  if (membershipRef.current !== membershipKey) {
    membershipRef.current = membershipKey;
    setOrder(ids);
  }

  const byId = new Map(focuses.map(focus => [focus.id, focus]));
  const ordered = order
    .map(id => byId.get(id))
    .filter((focus): focus is ShellFocus => Boolean(focus));

  return (
    <Reorder.Group
      as="div"
      axis="y"
      values={order}
      onReorder={next => {
        setOrder(next);
        onReorder(next);
      }}
      className={groupClass}
    >
      {ordered.map(focus => (
        <Reorder.Item
          key={focus.id}
          value={focus.id}
          as="div"
          className={itemClass}
          whileDrag={{ scale: 1.015, zIndex: 5 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        >
          {renderFocus(focus)}
        </Reorder.Item>
      ))}
    </Reorder.Group>
  );
}

const groupClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '1px',
});

const itemClass = css({
  position: 'relative',
});
