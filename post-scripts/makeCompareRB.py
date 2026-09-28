#!/usr/bin/env python3
"""Create missing ``;compare`` images from ``;frontFullImage`` images.

The script does not write anything until the proposed output images have been
shown in a preview window and the user explicitly chooses "Create images".

Requires Pillow:  python3 -m pip install Pillow
"""

from __future__ import annotations

import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

try:
    from PIL import Image, ImageOps, ImageTk
except ImportError:
    print("This script needs Pillow. Install it with: python3 -m pip install Pillow")
    raise SystemExit(1)


TAGS = {"frontImage", "frontFullImage", "compare"}
IMAGE_EXTENSIONS = {".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}

# Set this once for each job, then run this script normally.
TARGET_FOLDER = Path("/path/to/target/folder")


@dataclass(frozen=True)
class ProposedImage:
    sku: str
    source: Path
    destination: Path


def parse_sku_tag(path: Path) -> tuple[str, str] | None:
    """Return (SKU, tag) only when the tag is the final semicolon field."""
    if path.suffix.lower() not in IMAGE_EXTENSIONS or path.name.startswith("._"):
        return None
    if ";" not in path.stem:
        return None
    sku, tag = path.stem.rsplit(";", 1)
    return (sku, tag) if sku and tag in TAGS else None


def find_proposals(folder: Path) -> tuple[list[ProposedImage], list[str]]:
    """Scan recursively and return one proposal per SKU without a compare image."""
    by_sku: dict[str, dict[str, list[Path]]] = defaultdict(lambda: defaultdict(list))
    for path in sorted(folder.rglob("*")):
        if not path.is_file():
            continue
        parsed = parse_sku_tag(path)
        if parsed:
            sku, tag = parsed
            by_sku[sku][tag].append(path)

    proposals: list[ProposedImage] = []
    notes: list[str] = []
    for sku, tagged_paths in sorted(by_sku.items()):
        if tagged_paths.get("compare") or not tagged_paths.get("frontFullImage"):
            continue

        sources = tagged_paths["frontFullImage"]
        source = sources[0]
        destination = source.with_name(f"{sku};compare{source.suffix}")
        if destination.exists():
            notes.append(f"Skipped {sku}: destination already exists: {destination}")
            continue
        if len(sources) > 1:
            notes.append(
                f"{sku} has {len(sources)} frontFullImage files; using {source.relative_to(folder)}"
            )
        proposals.append(ProposedImage(sku, source, destination))
    return proposals, notes


def trim_transparent_rows(image: Image.Image) -> Image.Image:
    """Remove fully transparent rows above and below the visible image content.

    The left and right dimensions are deliberately retained. Images without an
    alpha channel, or which are completely transparent, are left unchanged.
    """
    if "A" not in image.getbands():
        # Palette images can store transparency separately instead of exposing
        # an alpha band. Convert those before looking for transparent rows.
        if "transparency" not in image.info:
            return image.copy()
        image = image.convert("RGBA")
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        return image.copy()
    _, top, _, bottom = bbox
    return image.crop((0, top, image.width, bottom))


def preview_and_confirm(proposals: Iterable[ProposedImage], root_folder: Path) -> bool:
    """Display all proposed *trimmed* images in a scrollable review window."""
    import tkinter as tk
    from tkinter import messagebox

    proposal_list = list(proposals)
    root = tk.Tk()
    root.title(f"Review {len(proposal_list)} proposed compare images")
    root.geometry("1000x720")
    accepted = False

    header = tk.Label(
        root,
        text=("These are previews of the new ;compare images. "
              "Nothing has been changed yet."),
        anchor="w",
        padx=12,
        pady=10,
    )
    header.pack(fill="x")

    outer = tk.Frame(root)
    outer.pack(fill="both", expand=True)
    canvas = tk.Canvas(outer)
    scrollbar = tk.Scrollbar(outer, orient="vertical", command=canvas.yview)
    content = tk.Frame(canvas)
    content.bind("<Configure>", lambda _event: canvas.configure(scrollregion=canvas.bbox("all")))
    canvas.create_window((0, 0), window=content, anchor="nw")
    canvas.configure(yscrollcommand=scrollbar.set)
    canvas.pack(side="left", fill="both", expand=True)
    scrollbar.pack(side="right", fill="y")

    # ImageTk objects must be retained for as long as their labels are visible.
    thumbnails: list[ImageTk.PhotoImage] = []
    for row, proposal in enumerate(proposal_list):
        try:
            with Image.open(proposal.source) as original:
                preview = trim_transparent_rows(ImageOps.exif_transpose(original))
                preview.thumbnail((300, 220))
                thumbnail = ImageTk.PhotoImage(preview.convert("RGBA"))
        except Exception as error:
            tk.Label(content, text=f"Could not preview {proposal.source.name}: {error}", fg="red").grid(
                row=row, column=0, columnspan=2, sticky="w", padx=12, pady=8
            )
            continue
        thumbnails.append(thumbnail)
        tk.Label(content, image=thumbnail).grid(row=row, column=0, padx=12, pady=10)
        tk.Label(
            content,
            text=(f"SKU: {proposal.sku}\n"
                  f"From: {proposal.source.relative_to(root_folder)}\n"
                  f"To:   {proposal.destination.relative_to(root_folder)}"),
            justify="left",
            anchor="w",
            wraplength=620,
        ).grid(row=row, column=1, sticky="w", padx=(0, 12), pady=10)

    buttons = tk.Frame(root, padx=12, pady=10)
    buttons.pack(fill="x")

    def approve() -> None:
        nonlocal accepted
        if messagebox.askyesno("Confirm image creation", f"Create {len(proposal_list)} compare image(s)?"):
            accepted = True
            root.destroy()

    tk.Button(buttons, text="Cancel", command=root.destroy).pack(side="right")
    tk.Button(buttons, text="Create images", command=approve).pack(side="right", padx=(0, 8))
    root.mainloop()
    return accepted


def create_images(proposals: Iterable[ProposedImage]) -> tuple[int, list[str]]:
    created = 0
    errors: list[str] = []
    for proposal in proposals:
        try:
            with Image.open(proposal.source) as original:
                trimmed = trim_transparent_rows(ImageOps.exif_transpose(original))
                trimmed.save(proposal.destination)
            created += 1
        except Exception as error:
            errors.append(f"{proposal.source}: {error}")
    return created, errors


def main() -> None:
    folder = TARGET_FOLDER.expanduser().resolve()
    if not folder.is_dir():
        sys.exit(f"TARGET_FOLDER is not a valid folder: {folder}")

    proposals, notes = find_proposals(folder)
    print(f"Found {len(proposals)} SKU(s) that need a compare image.")
    for note in notes:
        print(f"Note: {note}")
    if not proposals:
        return
    if not preview_and_confirm(proposals, folder):
        print("Cancelled; no files were changed.")
        return

    created, errors = create_images(proposals)
    print(f"Created {created} compare image(s).")
    for error in errors:
        print(f"Error: {error}")


if __name__ == "__main__":
    main()
