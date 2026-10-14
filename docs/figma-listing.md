# Figma Community listing

Copy for the publish form in the Figma desktop app (Plugins → Manage plugins → Publish).

## Name

Token Check

## Tagline

Find colors that aren't tied to your design system, and snap them to the nearest token.

## Description

Token Check finds solid fills and strokes that use a raw color instead of a color variable or color style, and helps you fix them.

How it works
- Scan the whole page or just your selection.
- Each off-system color is listed with its nearest token, measured by how close the colors look (OKLab), not by raw RGB numbers.
- Click a row to jump to the layer.
- Press Snap to bind a close color to its token, or Bind exact matches to fix every color that already matches a token exactly, with no visual change.
- Colors with no close token are flagged but never snapped, because that would change the design.

Good to know
- Snaps to the color variables in this file, and resolves light and dark modes correctly. Library variables are coming next.
- Colors inside instances are skipped, because they belong to the main component. Fix them there.
- Hidden layers and text with more than one color are skipped for now.
- No network access. Nothing leaves your file.

Open source: github.com/ernkerr/token-check

## Category

Design tools (or a design systems category if the form offers one)

## Images

- Icon: docs/icon.png (128 × 128)
- Thumbnail: docs/cover.png (1920 × 1080)

## Support contact

https://github.com/ernkerr/token-check/issues
