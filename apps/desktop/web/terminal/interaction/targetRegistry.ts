import type { InteractionProbe, InteractionTarget, TargetResolver } from './types';

// The target resolver registry. Resolvers recognize what is semantically under
// the pointer; higher priority wins. Adding a new kind of interactive thing
// (issue refs, commit SHAs, file paths) is one registerResolver call: the event
// plumbing and the renderer never change.
const resolvers: TargetResolver[] = [];

export function registerResolver(resolver: TargetResolver): void {
  const existing = resolvers.findIndex(r => r.id === resolver.id);
  if (existing >= 0) resolvers.splice(existing, 1);
  resolvers.push(resolver);
  resolvers.sort((a, b) => b.priority - a.priority);
}

export function clearResolvers(): void {
  resolvers.length = 0;
}

// All targets any resolver recognizes, already in priority order.
export function resolveTargets(probe: InteractionProbe): InteractionTarget[] {
  const targets: InteractionTarget[] = [];
  for (const resolver of resolvers) targets.push(...resolver.resolve(probe));
  return targets;
}

// The single highest-priority target (what the context menu acts on).
export function resolveTopTarget(probe: InteractionProbe): InteractionTarget | null {
  for (const resolver of resolvers) {
    const found = resolver.resolve(probe);
    if (found.length > 0) return found[0];
  }
  return null;
}
