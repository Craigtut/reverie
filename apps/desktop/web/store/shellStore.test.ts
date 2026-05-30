import { beforeEach, describe, expect, it } from 'vitest';

import { fallbackShellSnapshot } from '../domain';
import { useShellStore } from './shellStore';

describe('shellStore.patchSessionTitle', () => {
  beforeEach(() => {
    useShellStore.setState({ shell: fallbackShellSnapshot() });
  });

  it('updates only the matching session', () => {
    const base = fallbackShellSnapshot();
    const sessions = [
      { id: 'a', title: 'Claude Code' },
      { id: 'b', title: 'Codex' },
    ] as unknown as typeof base.sessions;
    useShellStore.setState({ shell: { ...base, sessions } });

    useShellStore.getState().patchSessionTitle('a', 'Fixing the parser');

    const after = useShellStore.getState().shell.sessions;
    expect(after.find(s => s.id === 'a')?.title).toBe('Fixing the parser');
    expect(after.find(s => s.id === 'b')?.title).toBe('Codex');
  });

  it('is a no-op for an unchanged title or unknown session (keeps reference)', () => {
    const base = fallbackShellSnapshot();
    const sessions = [{ id: 'a', title: 'Fixing the parser' }] as unknown as typeof base.sessions;
    useShellStore.setState({ shell: { ...base, sessions } });

    const before = useShellStore.getState().shell;
    useShellStore.getState().patchSessionTitle('a', 'Fixing the parser');
    expect(useShellStore.getState().shell).toBe(before);

    useShellStore.getState().patchSessionTitle('missing', 'whatever');
    expect(useShellStore.getState().shell).toBe(before);
  });
});
