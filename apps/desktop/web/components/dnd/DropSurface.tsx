import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { droppedPathLabel } from '../../domain';
import { createDropField, type DropFieldHandle } from '../../dropField';
import type { FileDropModel } from '../../hooks';
import { css } from '../../styled-system/css';
import { Typography } from '../primitives/Typography';

export interface DropSurfaceProps {
  // The model from useFileDrop. Drives the rise, the gravity-well, the splash.
  model: FileDropModel;
  // The zone kind this surface visualizes. It rises to full and shows its plate
  // only when the cursor is over a target of this kind; for other accepted kinds
  // (e.g. a tab vs. the body) it stays at the faint armed whisper.
  zone: string;
  // Destination-plate content, shown while hovering a VALID target of `zone`.
  icon?: ReactNode;
  label?: string;
  sublabel?: string;
  // Plate content while hovering an INVALID target (e.g. not a folder, not
  // running). Falls back to label/sublabel if omitted.
  invalidLabel?: string;
  invalidSublabel?: string;
  // Show the filename chip that rides the cursor. Default false (opt-in).
  showChip?: boolean;
  // How strongly the field rises when a drag is loose but not over this zone
  // (the ambient "you can drop here" whisper). 0 disables it. Default 0.16.
  armedLevel?: number;
  className?: string;
}

// The reusable visual + motion layer for a file drop, stacked over a drop zone
// (pointer-events:none so the native drop still lands beneath). It owns the
// dropField lattice and reacts to the FileDropModel: rising on hover, pulling a
// gravity-well dimple toward the pointer, and splashing a droplet ripple on
// drop. Pair it with useFileDrop and a [data-drop-zone] element. Domain-free:
// give it a plate (icon/label) and it works for any drop target.
export function DropSurface({
  model,
  zone,
  icon,
  label,
  sublabel,
  invalidLabel,
  invalidSublabel,
  showChip = false,
  armedLevel = 0.16,
  className,
}: DropSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fieldRef = useRef<DropFieldHandle | null>(null);
  const lastDrop = useRef(0);
  // The bounding rect of the active drop zone, so the destination plate centers
  // over THAT zone (e.g. the terminal) rather than the whole window.
  const [zoneRect, setZoneRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const field = createDropField(canvas);
    fieldRef.current = field;
    const observer = new ResizeObserver(() => field.resize());
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      field.destroy();
      fieldRef.current = null;
    };
  }, []);

  const onZone = model.target?.kind === zone;
  const overZone = model.phase === 'over' && onZone;
  const valid = Boolean(model.target?.valid);
  const dragActive = model.phase !== 'idle';

  // Field rise: faint whisper while a drag is loose, full over a valid target of
  // this zone, dim over an invalid one, held up through this zone's confirm
  // splash, and down when a drop lands on some other zone.
  const level =
    model.phase === 'idle'
      ? 0
      : model.phase === 'armed'
        ? armedLevel
        : model.phase === 'over'
          ? overZone
            ? valid
              ? 1
              : 0.5
            : armedLevel
          : onZone
            ? 1
            : 0;

  useEffect(() => {
    const field = fieldRef.current;
    const canvas = canvasRef.current;
    if (!field) return;
    field.setIntensity(level);

    if (overZone && model.pointer && canvas) {
      const rect = canvas.getBoundingClientRect();
      field.setPointer(model.pointer.x - rect.left, model.pointer.y - rect.top);
    } else {
      field.setPointer(null);
    }

    if (model.dropCount !== lastDrop.current) {
      lastDrop.current = model.dropCount;
      if (onZone && valid && model.pointer && canvas) {
        const rect = canvas.getBoundingClientRect();
        field.splash(model.pointer.x - rect.left, model.pointer.y - rect.top);
      }
    }
  }, [model, level, overZone, onZone, valid]);

  // Measure the active zone's element so the plate anchors over it. Keyed on the
  // target (not the pointer), so it measures once per hover, before paint.
  const targetId = model.target?.id;
  useLayoutEffect(() => {
    if (!overZone) {
      setZoneRect(null);
      return;
    }
    const selector = targetId
      ? `[data-drop-zone="${zone}"][data-drop-id="${CSS.escape(targetId)}"]`
      : `[data-drop-zone="${zone}"]`;
    const el = document.querySelector(selector);
    setZoneRect(el ? el.getBoundingClientRect() : null);
  }, [overZone, zone, targetId]);

  const fileCount = model.files.length;
  const primaryFile = fileCount > 0 ? droppedPathLabel(model.files[0]) : '';
  const showPlate = overZone && (label || invalidLabel);
  const plateLabel = valid ? label : (invalidLabel ?? label);
  const plateSub = valid ? sublabel : (invalidSublabel ?? sublabel);

  return (
    <div
      className={className ? `${overlayRootClass} ${className}` : overlayRootClass}
      aria-hidden="true"
    >
      <div className={scrimClass} style={{ opacity: Math.min(1, level * 0.58) }} />
      <canvas ref={canvasRef} className={canvasClass} data-testid="drop-field" />

      <div
        className={plateWrapClass}
        data-shown={showPlate && zoneRect ? 'true' : 'false'}
        style={
          zoneRect
            ? {
                left: `${zoneRect.left}px`,
                top: `${zoneRect.top}px`,
                width: `${zoneRect.width}px`,
                height: `${zoneRect.height}px`,
                paddingBottom: `${Math.max(20, zoneRect.height * 0.13)}px`,
              }
            : undefined
        }
      >
        <div className={plateClass} data-valid={valid ? 'true' : 'false'}>
          {icon}
          <div className={plateTextClass}>
            {plateLabel ? (
              <Typography as="span" variant="caption" tone="default">
                {plateLabel}
              </Typography>
            ) : null}
            {plateSub ? (
              <Typography as="span" variant="tiny" tone="muted" className={plateSubClass}>
                {plateSub}
              </Typography>
            ) : null}
          </div>
        </div>
      </div>

      {/* The carried-file chip portals to document.body so it rides ABOVE the
          chrome at the cursor, even though the field itself sits behind it. */}
      {showChip && dragActive && model.pointer && fileCount > 0
        ? createPortal(
            <div
              className={chipClass}
              style={{ left: `${model.pointer.x}px`, top: `${model.pointer.y}px` }}
            >
              <span className={chipDotClass} />
              <Typography
                as="span"
                variant="tiny"
                tone="default"
                className={chipNameClass}
                style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                }}
              >
                {primaryFile}
              </Typography>
              {fileCount > 1 ? (
                <Typography as="span" variant="tiny" tone="muted" className={chipCountClass}>
                  +{fileCount - 1}
                </Typography>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

// Full-window, fixed layer: the dot field spans the whole app (the canvas origin
// is the viewport origin, so pointer coords need no container offset). Mount it
// inside the canvas-stage stacking context; z-index 1 places it ABOVE the
// terminal yet BELOW the lifted tabs (z2) and the sidebar (z3), so the chrome
// stays crisp on top. pointer-events none keeps the app interactive and lets the
// native drop fall through. The carried chip portals out to ride above the chrome.
const overlayRootClass = css({
  position: 'fixed',
  inset: 0,
  zIndex: 1,
  pointerEvents: 'none',
  overflow: 'hidden',
});

const scrimClass = css({
  position: 'absolute',
  inset: 0,
  // A soft vignette toward the edges so the whole app gently recedes during a
  // drag without blacking out; the cursor region stays clear for the dome.
  background:
    'radial-gradient(140% 140% at 50% 45%, transparent 38%, color-mix(in srgb, #050504 80%, transparent))',
  transition: 'opacity 220ms ease',
});

const canvasClass = css({
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
});

// Positioned (via inline left/top/width/height) over the active zone's rect, so
// the plate centers over the terminal, not the window. Lower third, like before.
const plateWrapClass = css({
  position: 'absolute',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'flex-end',
  opacity: 0,
  transform: 'translateY(6px)',
  transition: 'opacity 220ms ease, transform 220ms ease',
  '&[data-shown="true"]': { opacity: 1, transform: 'translateY(0)' },
});

const plateClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '10px',
  padding: '9px 15px 9px 13px',
  borderRadius: '12px',
  border: '1px solid color-mix(in srgb, var(--good) 26%, var(--line-strong))',
  background: 'color-mix(in srgb, #14120f 78%, transparent)',
  boxShadow: '0 10px 34px rgba(0,0,0,0.45)',
  backdropFilter: 'blur(6px)',
  '&[data-valid="false"]': {
    border: '1px solid var(--line-strong)',
    opacity: 0.85,
  },
});

const plateTextClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '1px',
  minWidth: 0,
});

const plateSubClass = css({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: '260px',
});

const chipClass = css({
  position: 'fixed',
  zIndex: 60,
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '4px 9px',
  borderRadius: '999px',
  border: '1px solid var(--line-strong)',
  background: 'color-mix(in srgb, #14120f 86%, transparent)',
  boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
  backdropFilter: 'blur(6px)',
  transform: 'translate(14px, 16px)',
  maxWidth: '320px',
});

const chipDotClass = css({
  width: '6px',
  height: '6px',
  borderRadius: '999px',
  background: 'var(--good)',
  flexShrink: 0,
});

const chipNameClass = css({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const chipCountClass = css({
  flexShrink: 0,
});
