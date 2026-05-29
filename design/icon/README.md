# Reverie app icon (placeholder)

A warm **aura** gradient icon: a dynamic, dark, grainy folding color field in a
macOS squircle. No letter, no wordmark.

> Placeholder. Chosen frame: `fold-04`. Wired into
> `apps/desktop/src-tauri/icons/` + `tauri.conf.json` (`bundle.icon`).

## How it's made

1. **Generate** abstract folding color fields in Draw Things (FLUX.2 Klein 4B) —
   prompts ask for dynamic, asymmetric, folding light over deep black, heavy
   grain. Output lands in `aura/` as `fold-*.png`. FLUX gives good structure but
   a wandering palette (it drifts magenta/teal), so we don't keep its color.
2. **Grade** to the brand palette — `grade.py` takes only the luminance/structure
   and applies a warm gradient-map (deep warm-black → dusty clay/rose → cream)
   plus fine film grain. Output in `graded/`. This guarantees a muted warm aura,
   no orange, no second hue.
3. **Build** the asset set — `build_assets.py` shapes the chosen graded frame into
   a macOS squircle (1024 canvas, ~832 body, continuous corner) and emits
   `icon.icns`, `icon.ico`, the Tauri PNGs, and Windows Store logos into `build/`.

```bash
cd design/icon
python3 grade.py fold-04-warm    # re-grade (tweak ramp/grain in grade.py)
python3 build_assets.py          # rebuild build/ from graded/fold-04-warm-graded.png
# then copy build/* into apps/desktop/src-tauri/icons/
```

Needs Python + Pillow, macOS `iconutil`, and ImageMagick (`magick`).

## To change the icon

Pick a different `fold-*` (or generate new ones), point `grade.py` /
`build_assets.py` at it, rebuild, and recopy into `src-tauri/icons/`.

## Notes

- `bundle.active` is left `false` in `tauri.conf.json`. Flip it to `true` when you
  want `tauri build` to bundle a distributable `.app` with the `.icns` embedded.
- This is explicitly a placeholder; the aura is "good enough for now."
