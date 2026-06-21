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

describe('shellStore.dismissSessionReentry', () => {
  beforeEach(() => {
    useShellStore.setState({ shell: fallbackShellSnapshot() });
  });

  it('marks only the matching session summary dismissed', () => {
    const base = fallbackShellSnapshot();
    const sessions = [
      { id: 'a', reentrySummary: { fields: { currentGoal: 'g' }, dismissed: false } },
      { id: 'b', reentrySummary: { fields: { currentGoal: 'g' }, dismissed: false } },
    ] as unknown as typeof base.sessions;
    useShellStore.setState({ shell: { ...base, sessions } });

    useShellStore.getState().dismissSessionReentry('a');

    const after = useShellStore.getState().shell.sessions;
    expect(after.find(s => s.id === 'a')?.reentrySummary?.dismissed).toBe(true);
    expect(after.find(s => s.id === 'b')?.reentrySummary?.dismissed).toBe(false);
  });

  it('is a no-op when already dismissed or no summary (keeps reference)', () => {
    const base = fallbackShellSnapshot();
    const sessions = [
      { id: 'a', reentrySummary: { fields: { currentGoal: 'g' }, dismissed: true } },
      { id: 'b' },
    ] as unknown as typeof base.sessions;
    useShellStore.setState({ shell: { ...base, sessions } });

    const before = useShellStore.getState().shell;
    useShellStore.getState().dismissSessionReentry('a');
    expect(useShellStore.getState().shell).toBe(before);

    useShellStore.getState().dismissSessionReentry('b');
    expect(useShellStore.getState().shell).toBe(before);

    useShellStore.getState().dismissSessionReentry('missing');
    expect(useShellStore.getState().shell).toBe(before);
  });
});
