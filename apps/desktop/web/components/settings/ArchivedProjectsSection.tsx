import { css } from '../../styled-system/css';
import { shortenCwd } from '../../domain';
import type { ShellProject } from '../../domain';
import { useShellStore } from '../../store';
import { Typography } from '../primitives/Typography';

// The workspace's archived projects, the one place they surface after being
// removed from the rail. There is deliberately no Restore button here: a project
// is anchored to a folder, so re-adding that folder reconnects it (with its
// topics and sessions intact). The only action is a permanent purge, for when
// you want the data gone for good. Renders nothing when no project is archived.
export function ArchivedProjectsSection({
  onDeleteProject,
}: {
  onDeleteProject: (project: ShellProject) => void;
}) {
  const shell = useShellStore(s => s.shell);
  const archived = shell.projects.filter(project => project.archived);
  if (archived.length === 0) return null;

  return (
    <section className={settingsGroupClass} aria-labelledby="settings-archived-projects-label">
      <Typography
        as="h2"
        id="settings-archived-projects-label"
        variant="tiny"
        tone="faint"
        uppercase
        style={{ letterSpacing: '0.12em' }}
      >
        Archived projects
      </Typography>
      <Typography as="p" variant="caption" tone="faint" style={{ lineHeight: 1.5 }}>
        Removed from the workspace, kept here in case you want the data gone. To bring one back,
        re-add its folder: Reverie reconnects it with its topics and sessions.
      </Typography>
      <ul className={listClass} data-testid="settings-archived-projects">
        {archived.map(project => {
          const focusIds = new Set(
            shell.focuses.filter(focus => focus.projectId === project.id).map(focus => focus.id),
          );
          const sessionCount = shell.sessions.filter(session =>
            focusIds.has(session.focusId),
          ).length;
          return (
            <li key={project.id} className={rowClass}>
              <div className={rowTextClass}>
                <Typography as="span" variant="smallBody" tone="default">
                  {project.name}
                </Typography>
                <Typography
                  as="span"
                  variant="caption"
                  tone="faint"
                  className={pathClass}
                  title={project.path}
                >
                  {shortenCwd(project.path)}
                </Typography>
                <Typography as="span" variant="caption" tone="ghost">
                  {focusIds.size} {focusIds.size === 1 ? 'topic' : 'topics'} · {sessionCount}{' '}
                  {sessionCount === 1 ? 'session' : 'sessions'}
                </Typography>
              </div>
              <button
                type="button"
                className={deleteButtonClass}
                data-testid="settings-archived-project-delete"
                onClick={() => onDeleteProject(project)}
              >
                <Typography as="span" variant="caption" tone="inherit">
                  Delete data
                </Typography>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const settingsGroupClass = css({
  display: 'grid',
  gap: '12px',
});

const listClass = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
});

const rowClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '16px',
  padding: '12px 16px',
  border: '1px solid var(--line)',
  borderRadius: '16px',
  background: 'color-mix(in srgb, var(--surface-1) 80%, transparent)',
});

const rowTextClass = css({
  display: 'grid',
  gap: '2px',
  minWidth: 0,
});

const pathClass = css({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const deleteButtonClass = css({
  flexShrink: 0,
  background: 'transparent',
  border: '1px solid var(--line)',
  borderRadius: '999px',
  padding: '6px 14px',
  cursor: 'pointer',
  color: 'var(--text-3)',
  transition: 'border-color 0.15s ease, color 0.15s ease',
  _hover: { borderColor: 'var(--bad)', color: 'var(--bad)' },
});
