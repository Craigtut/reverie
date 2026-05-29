import type {
  ActionContext,
  ActionGroup,
  InteractionTarget,
  MenuItemModel,
  TerminalAction,
} from './types';

// The action registry: the "register one action" seam. Each action declares the
// target kinds it applies to; the menu is assembled by filtering + grouping
// registered actions for a resolved target. The registry knows nothing about the
// app (everything it needs arrives via ActionContext).
const actions: TerminalAction[] = [];

// Display order of groups in the menu; dividers are drawn between groups.
const GROUP_ORDER: ActionGroup[] = ['clipboard', 'open', 'search', 'agent', 'find', 'select'];

export function registerAction<T extends InteractionTarget>(action: TerminalAction<T>): void {
  const existing = actions.findIndex(a => a.id === action.id);
  if (existing >= 0) actions.splice(existing, 1);
  // Widen on store: actionsFor only ever hands an action a target whose kind it
  // declared, so the invoke/label/predicate callbacks receive a matching target.
  actions.push(action as unknown as TerminalAction);
}

export function clearActions(): void {
  actions.length = 0;
}

// The actions that apply to a target (kind match + not hidden by isAvailable),
// sorted by group then order.
export function actionsFor(target: InteractionTarget, ctx: ActionContext): TerminalAction[] {
  return actions
    .filter(
      action => action.kinds.includes(target.kind) && (action.isAvailable?.(target, ctx) ?? true),
    )
    .sort((a, b) => {
      const groupDelta = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
      return groupDelta !== 0 ? groupDelta : a.order - b.order;
    });
}

// Build the flat menu model the React menu renders. `onInvoke` runs the action;
// the menu component is responsible for closing itself around the call.
export function buildMenuItems(target: InteractionTarget, ctx: ActionContext): MenuItemModel[] {
  return actionsFor(target, ctx).map(action => ({
    id: action.id,
    label: typeof action.label === 'function' ? action.label(target, ctx) : action.label,
    group: action.group,
    enabled: action.isEnabled?.(target, ctx) ?? true,
    onInvoke: () => {
      void action.invoke(target, ctx);
    },
  }));
}
