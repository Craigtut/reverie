import { useEffect, useRef, useState } from 'react';

import { css } from '../../styled-system/css';
import { Typography } from '../primitives/Typography';
import type { DispatchRouting, ShellFocus, ShellProject } from '../../domain';

// The editable destination for a dispatch: shows where the work will land
// (General, or a project + topic) and opens a custom popover (no native menu, so
// it never blurs the always-on-top window) to correct it. The classifier
// proposes; the user disposes.

interface DestinationChipProps {
  routing: DispatchRouting | null;
  pending: boolean;
  projects: ShellProject[];
  focuses: ShellFocus[];
  generalLabel: string;
  sessionTitle: string;
  onChange: (routing: DispatchRouting) => void;
  onOpenChange?: (open: boolean) => void;
}

export function DestinationChip({
  routing,
  pending,
  projects,
  focuses,
  generalLabel,
  sessionTitle,
  onChange,
  onOpenChange,
}: DestinationChipProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const liveProjects = projects.filter(project => !project.archived);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const projectName = (id?: string | null) =>
    liveProjects.find(project => project.id === id)?.name ?? 'Project';
  const topicTitle = (id?: string | null) =>
    focuses.find(focus => focus.id === id)?.title ?? 'topic';

  const uncertain = (routing?.confidence ?? 1) < 0.5;
  const label = describeRouting();

  function describeRouting(): string {
    if (pending && !routing) return 'routing…';
    if (!routing || routing.scope === 'general') return `→ ${generalLabel}`;
    const name = projectName(routing.projectId);
    if (routing.isNewTopic) {
      return `→ ${name} · ${routing.newTopicTitle?.trim() || 'new topic'} (new)`;
    }
    return `→ ${name} · ${topicTitle(routing.topicId)}`;
  }

  function pick(next: DispatchRouting) {
    onChange(next);
    setOpen(false);
  }

  const general = (): DispatchRouting => ({
    scope: 'general',
    projectId: null,
    topicId: null,
    isNewTopic: false,
    newTopicTitle: null,
    sessionTitle,
    confidence: routing?.confidence ?? null,
  });

  return (
    <div ref={rootRef} className={rootClass}>
      <button
        type="button"
        className={chipClass}
        data-uncertain={uncertain ? 'true' : 'false'}
        onClick={() => setOpen(value => !value)}
        title="Change destination"
      >
        <Typography variant="caption" tone={pending && !routing ? 'faint' : 'muted'}>
          {label}
        </Typography>
        {pending && !routing ? <span className={shimmerClass} aria-hidden="true" /> : null}
      </button>

      {open ? (
        <div className={menuClass}>
          <button type="button" className={itemClass} onClick={() => pick(general())}>
            <Typography variant="caption" tone="default">
              {generalLabel}
            </Typography>
            <Typography variant="tiny" tone="faint">
              One-off, no project
            </Typography>
          </button>

          {liveProjects.map(project => {
            const topics = focuses.filter(
              focus => !focus.archived && focus.projectId === project.id,
            );
            return (
              <div key={project.id} className={groupClass}>
                <Typography className={groupHeaderClass} variant="tiny" tone="faint" uppercase>
                  {project.name}
                </Typography>
                {topics.map(topic => (
                  <button
                    key={topic.id}
                    type="button"
                    className={itemClass}
                    onClick={() =>
                      pick({
                        scope: 'project',
                        projectId: project.id,
                        topicId: topic.id,
                        isNewTopic: false,
                        newTopicTitle: null,
                        sessionTitle,
                        confidence: routing?.confidence ?? null,
                      })
                    }
                  >
                    <Typography variant="caption" tone="default">
                      {topic.title}
                    </Typography>
                  </button>
                ))}
                <button
                  type="button"
                  className={itemClass}
                  onClick={() =>
                    pick({
                      scope: 'project',
                      projectId: project.id,
                      topicId: null,
                      isNewTopic: true,
                      newTopicTitle: routing?.newTopicTitle?.trim() || sessionTitle || 'New topic',
                      sessionTitle,
                      confidence: routing?.confidence ?? null,
                    })
                  }
                >
                  <Typography variant="caption" tone="muted">
                    + New topic
                  </Typography>
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

const rootClass = css({ position: 'relative', flex: 1, minWidth: 0 });

const chipClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  maxWidth: '100%',
  height: '26px',
  paddingX: '10px',
  borderRadius: '8px',
  border: '1px solid var(--line-faint)',
  background: 'var(--surface-2)',
  cursor: 'pointer',
  transition: 'background 0.15s ease, border-color 0.15s ease',
  _hover: { background: 'var(--surface-3)' },
  '&[data-uncertain="true"]': { borderColor: 'var(--warn)' },
});

const shimmerClass = css({
  width: '22px',
  height: '3px',
  borderRadius: '2px',
  background: 'linear-gradient(90deg, var(--line-faint), var(--text-3), var(--line-faint))',
  backgroundSize: '200% 100%',
  animation: 'dispatchRouting 1.1s ease-in-out infinite',
});

const menuClass = css({
  position: 'absolute',
  top: 'calc(100% + 6px)',
  left: 0,
  zIndex: 20,
  minWidth: '240px',
  maxHeight: '300px',
  overflowY: 'auto',
  padding: '4px',
  borderRadius: '10px',
  border: '1px solid var(--line-strong)',
  background: 'var(--surface-1)',
  boxShadow: 'var(--shadow)',
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
});

const groupClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  paddingTop: '4px',
  marginTop: '2px',
  borderTop: '1px solid var(--line-faint)',
});

const groupHeaderClass = css({
  paddingX: '8px',
  paddingY: '2px',
  letterSpacing: '0.08em',
});

const itemClass = css({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '1px',
  textAlign: 'left',
  width: '100%',
  paddingX: '8px',
  paddingY: '5px',
  borderRadius: '7px',
  background: 'transparent',
  cursor: 'pointer',
  _hover: { background: 'var(--surface-3)' },
});
