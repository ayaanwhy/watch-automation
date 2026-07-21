"""
runner_base.py — Shared NDJSON-runner orchestration for the Python
processing pipelines (Universal Preprocessing, Ring & Bracelet) — Phase 11D.

Both electron_runner.py and runner.py independently reimplemented the same
protocol shell: stdout emission, the cooperative-cancellation stdin listener,
input-directory validation/discovery, the outer per-image batch loop
(checkpoint → process → success/failure accounting), the terminal 'done'
event, and the exit-code contract. This module is that one shell.

What stays independent (per Phase 11's "preserve independent processing
implementations" — this module never touches either): the actual per-image
work (Universal Preprocessing's 5-stage GPU pipeline vs. Ring & Bracelet's
single CPU mask bake), argument definitions beyond the two universal
--input-dir/--output-dir flags, and Universal Preprocessing's own profiling
infrastructure (heartbeats, RSS/MPS stats, the profile report file) — none
of which Ring & Bracelet has or needs.

Exit codes (both runners' own docstrings already documented this identically
before this extraction):
  0 — every image succeeded
  1 — fatal startup failure, or zero images succeeded
  2 — partial success (at least one image failed, at least one succeeded)
  3 — cancelled cooperatively at a safe checkpoint
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from pathlib import Path
from typing import Callable

EXIT_CANCELLED = 3


def emit(event: dict) -> None:
    """Write one JSON event to the real stdout (NDJSON protocol).

    Uses sys.__stdout__ directly so this is safe to call even while a
    caller has redirected sys.stdout elsewhere (e.g. electron_runner.py's
    _quiet() context manager), and safe to call from a background thread.
    """
    print(json.dumps(event), file=sys.__stdout__, flush=True)


def add_common_io_args(parser: argparse.ArgumentParser) -> None:
    """Adds the two flags every pipeline requires, identically."""
    parser.add_argument("--input-dir", required=True, help="Folder containing source images.")
    parser.add_argument("--output-dir", required=True, help="Folder for output artefacts.")


def resolve_io_dirs(raw_input_dir: str, raw_output_dir: str) -> tuple[Path, Path]:
    """Expands ~ and resolves both paths to absolute — both runners already
    did exactly this before validating/creating them."""
    return (
        Path(raw_input_dir).expanduser().resolve(),
        Path(raw_output_dir).expanduser().resolve(),
    )


def start_cancel_listener(cancel_event: threading.Event) -> threading.Thread:
    """Starts the background daemon thread that reads {"cmd":"cancel"} lines
    from stdin and sets cancel_event.

    Only sets the event and emits an acknowledgement — never acts on the
    request itself. The caller's batch loop is the only thing that checks
    it, and only at its own safe checkpoints (between images, or — for
    Universal Preprocessing — also between pipeline stages within one
    image). This is what guarantees the process never tears down mid-GPU-
    kernel on the MPS backend.
    """
    def _listen() -> None:
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(cmd, dict) and cmd.get("cmd") == "cancel" and not cancel_event.is_set():
                cancel_event.set()
                emit({"type": "cancel_requested"})

    thread = threading.Thread(target=_listen, daemon=True)
    thread.start()
    return thread


def discover_images(input_dir: Path, extensions: set[str]) -> list[Path]:
    """Sorted list of real image files directly under input_dir.

    Skips macOS '._name' AppleDouble sidecar files — these carry a real
    image extension but aren't real images, and would otherwise be fed
    straight into the pipeline and fail to decode.
    """
    return sorted(
        p for p in input_dir.iterdir()
        if p.is_file() and not p.name.startswith("._")
        and p.suffix.lower() in extensions
    )


def discover_and_validate(input_dir: Path, extensions: set[str]) -> list[Path] | None:
    """Validates the input directory and discovers its images in one step.

    Returns the sorted image list, or None if a 'fatal' event was already
    emitted (missing directory, or no supported images) — the caller should
    return exit code 1 in that case, matching both runners' existing
    behavior exactly.
    """
    if not input_dir.is_dir():
        emit({"type": "fatal", "error": f"Input directory not found: {input_dir}"})
        return None
    images = discover_images(input_dir, extensions)
    if not images:
        emit({"type": "fatal", "error": f"No supported images found in {input_dir}"})
        return None
    return images


def emit_start(images: list[Path]) -> None:
    emit({"type": "start", "total": len(images), "images": [p.name for p in images]})


def emit_error(index: int, total: int, input_path: Path, exc: Exception) -> None:
    """The standard per-image 'error' event shape — identical across both
    runners already."""
    emit({
        "type": "error",
        "index": index,
        "total": total,
        "image": input_path.name,
        "error": str(exc),
        "fatal": False,
    })


class BatchOutcome:
    """Mutable accumulator for run_batch's result — a plain class (not a
    dataclass/NamedTuple) since total_ms is only known once the loop below
    has finished, unlike the other three fields."""
    __slots__ = ("succeeded", "failed", "cancelled", "total_ms")

    def __init__(self) -> None:
        self.succeeded = 0
        self.failed = 0
        self.cancelled = False
        self.total_ms = 0


def run_batch(
    images: list[Path],
    cancel_event: threading.Event,
    process_one: Callable[[int, int, Path], None],
    on_error: Callable[[int, int, Path, Exception], None] = emit_error,
) -> BatchOutcome:
    """The shared outer per-image loop.

    Checks the cancellation checkpoint before each image, calls
    process_one(index, total, input_path) — which owns emitting its own
    'progress'/'complete' events, since those payloads differ per pipeline
    — and accounts success/failure. process_one raising is the only failure
    signal; on_error emits the 'error' event (defaults to the shared shape
    both runners already used identically).

    Sub-checkpoints WITHIN one image's processing (Universal Preprocessing
    checks between its 5 stages, never mid-GPU-kernel) are process_one's own
    concern, not this loop's.
    """
    outcome = BatchOutcome()
    total = len(images)
    batch_t0 = time.perf_counter()

    for index, input_path in enumerate(images, start=1):
        if cancel_event.is_set():
            outcome.cancelled = True
            break
        try:
            process_one(index, total, input_path)
            outcome.succeeded += 1
        except Exception as exc:
            on_error(index, total, input_path, exc)
            outcome.failed += 1

    outcome.total_ms = int((time.perf_counter() - batch_t0) * 1000)
    return outcome


def emit_done_and_exit_code(outcome: BatchOutcome) -> int:
    """Emits the terminal 'done' event and returns the process exit code —
    both runners defined this identically."""
    emit({
        "type": "done",
        "succeeded": outcome.succeeded,
        "failed": outcome.failed,
        "total_duration_ms": outcome.total_ms,
        "cancelled": outcome.cancelled,
    })
    if outcome.cancelled:
        return EXIT_CANCELLED
    if outcome.succeeded == 0:
        return 1
    if outcome.failed > 0:
        return 2
    return 0
