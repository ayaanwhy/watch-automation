"""Freeze and verify the current ring-segmentation production runtime.

The command copies every file required to run the current API, captures deterministic
smoke responses from the live service, starts the copied runtime locally on CPU and
CUDA, and seals the resulting evidence folder with SHA-256 hashes. It refuses to
overwrite an existing freeze.

Example:

    .venv/bin/python -m ring_v2.freeze_production \
      --out ring_v2/artifacts/production-freeze-20260904 \
      --live-url https://pixelforge.clouddeploy.in \
      --smoke rings/editor-batch-production-585/source/core-round-4-prongs-single.jpg
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from typing import Any
import urllib.error
import urllib.request
import uuid

import cv2
import numpy as np


SCHEMA_VERSION = 1
RUNTIME_FILES = (
    "deploy/__init__.py",
    "deploy/serve.py",
    "deploy/model.onnx",
    "deploy/model.json",
    "deploy/ownership_refiner.onnx",
    "deploy/ownership_refiner.json",
    "deploy/requirements.txt",
    "deploy/requirements.gpu.txt",
    "deploy/Dockerfile",
    "deploy/Dockerfile.gpu",
    "deploy/web/index.html",
    "vto/__init__.py",
    "vto/post.py",
    "vto/configurator_benchmark.py",
)
PACKAGE_NAMES = (
    "onnxruntime",
    "onnxruntime-gpu",
    "opencv-python-headless",
    "numpy",
    "fastapi",
    "uvicorn",
    "python-multipart",
    "protobuf",
)
LAYERS = ("full", "front", "back")
ROLLBACK_MAX_CHANGED_FRACTION = 0.0025
ROLLBACK_MAX_RGBA_MAE_U8 = 0.10


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def run_text(command: list[str], cwd: Path | None = None) -> str | None:
    try:
        return subprocess.check_output(
            command, cwd=cwd, stderr=subprocess.STDOUT, text=True,
            timeout=15).strip()
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None


def git_record(repo: Path) -> dict[str, Any]:
    return {
        "branch": run_text(["git", "branch", "--show-current"], repo),
        "commit": run_text(["git", "rev-parse", "HEAD"], repo),
        "commit_date": run_text(
            ["git", "show", "-s", "--format=%cI", "HEAD"], repo),
        "status_porcelain": (run_text(
            ["git", "status", "--short", "--untracked-files=all"], repo)
            or "").splitlines(),
        "tracked_diff_sha256": sha256_bytes((run_text(
            ["git", "diff", "--binary", "HEAD"], repo) or "").encode()),
    }


def environment_record() -> dict[str, Any]:
    packages = {}
    for name in PACKAGE_NAMES:
        try:
            packages[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            continue
    providers: list[str] = []
    ort_version = None
    try:
        import onnxruntime as ort
        ort_version = ort.__version__
        providers = ort.get_available_providers()
    except ImportError:
        pass
    return {
        "python": sys.version,
        "executable": sys.executable,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "packages": packages,
        "onnxruntime_version": ort_version,
        "onnxruntime_available_providers": providers,
        "nvidia_smi": run_text([
            "nvidia-smi", "--query-gpu=name,driver_version,memory.total",
            "--format=csv,noheader"], None),
    }


def copy_runtime(repo: Path, destination: Path) -> list[dict[str, Any]]:
    records = []
    for relative in RUNTIME_FILES:
        source = repo / relative
        if not source.is_file():
            raise FileNotFoundError(f"required runtime file is missing: {relative}")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        records.append({
            "path": relative,
            "bytes": target.stat().st_size,
            "sha256": sha256_file(target),
        })
    return records


def copy_smokes(smokes: list[Path], destination: Path) -> list[dict[str, Any]]:
    seen_names: set[str] = set()
    records = []
    for source in smokes:
        source = source.resolve()
        if not source.is_file():
            raise FileNotFoundError(f"smoke source is missing: {source}")
        name = source.name
        if name in seen_names:
            raise ValueError(f"smoke basenames must be unique: {name}")
        seen_names.add(name)
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        image = cv2.imread(str(target), cv2.IMREAD_UNCHANGED)
        if image is None:
            raise ValueError(f"cannot decode smoke source: {source}")
        records.append({
            "case_id": source.stem,
            "file": f"smoke/sources/{name}",
            "bytes": target.stat().st_size,
            "sha256": sha256_file(target),
            "width": int(image.shape[1]),
            "height": int(image.shape[0]),
            "channels": 1 if image.ndim == 2 else int(image.shape[2]),
        })
    return records


def request_json(url: str, timeout: float = 60.0) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def multipart_image(path: Path) -> tuple[bytes, str]:
    boundary = f"----JewelSenseFreeze{uuid.uuid4().hex}"
    prefix = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
        "Content-Type: image/jpeg\r\n\r\n"
    ).encode()
    body = prefix + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    return body, boundary


def post_segment(base_url: str, path: Path,
                 timeout: float = 120.0) -> tuple[dict[str, Any], float]:
    body, boundary = multipart_image(path)
    request = urllib.request.Request(
        base_url.rstrip("/") + "/segment", data=body, method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        })
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read())
    return payload, round(1000.0 * (time.perf_counter() - started), 3)


def decode_png(encoded: str) -> tuple[bytes, np.ndarray]:
    data = base64.b64decode(encoded, validate=True)
    image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None or image.ndim != 3 or image.shape[2] != 4:
        raise ValueError("API layer is not a decodable RGBA PNG")
    return data, image


def normalized_metadata(payload: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in payload.items()
            if key not in (*LAYERS, "front_mask", "back_mask", "ms")}


def layer_record(data: bytes, image: np.ndarray, relative: str) -> dict[str, Any]:
    alpha = image[..., 3]
    return {
        "file": relative,
        "sha256": sha256_bytes(data),
        "bytes": len(data),
        "width": int(image.shape[1]),
        "height": int(image.shape[0]),
        "alpha_nonzero": int(np.count_nonzero(alpha)),
        "alpha_solid": int(np.count_nonzero(alpha == 255)),
    }


def capture_case(base_url: str, source: Path, output: Path,
                 repeats: int = 2) -> dict[str, Any]:
    attempts = []
    decoded_first: dict[str, np.ndarray] = {}
    for attempt in range(repeats):
        payload, wall_ms = post_segment(base_url, source)
        layers = {}
        for layer in LAYERS:
            if layer not in payload:
                raise ValueError(f"API response is missing {layer!r}")
            data, image = decode_png(payload[layer])
            prefix = source.stem if attempt == 0 else f"{source.stem}/repeat-{attempt + 1}"
            relative = f"{prefix}/{layer}.png"
            destination = output / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            if attempt == 0:
                decoded_first[layer] = image
            layers[layer] = layer_record(data, image, relative)
        attempts.append({
            "wall_ms": wall_ms,
            "server_ms": payload.get("ms"),
            "metadata": normalized_metadata(payload),
            "layers": layers,
        })

    full = decoded_first["full"][..., 3].astype(np.int16)
    front = decoded_first["front"][..., 3].astype(np.int16)
    back = decoded_first["back"][..., 3].astype(np.int16)
    if full.shape != front.shape or full.shape != back.shape:
        raise ValueError(f"layer dimensions differ for {source.stem}")
    partition_error = np.abs(front + back - full)
    deterministic = all(
        attempts[0]["metadata"] == current["metadata"] and
        all(attempts[0]["layers"][layer]["sha256"] ==
            current["layers"][layer]["sha256"] for layer in LAYERS)
        for current in attempts[1:])
    return {
        "case_id": source.stem,
        "source_sha256": sha256_file(source),
        "deterministic": deterministic,
        "partition_max_error_u8": int(partition_error.max()),
        "partition_error_pixels": int(np.count_nonzero(partition_error > 1)),
        "attempts": attempts,
    }


def capture_target(name: str, base_url: str, source_dir: Path,
                   smoke_records: list[dict[str, Any]], destination: Path,
                   expected_provider: str | None = None) -> dict[str, Any]:
    health = request_json(base_url.rstrip("/") + "/health")
    if expected_provider and expected_provider not in health.get("providers", []):
        raise RuntimeError(
            f"{name} does not use required provider {expected_provider}: "
            f"{health.get('providers')}")
    target_dir = destination / name
    cases = [capture_case(base_url, source_dir / Path(item["file"]).name,
                          target_dir) for item in smoke_records]
    return {
        "name": name,
        "base_url": base_url,
        "health": health,
        "health_sha256": sha256_bytes(
            json.dumps(health, sort_keys=True).encode()),
        "cases": cases,
        "all_deterministic": all(case["deterministic"] for case in cases),
        "partition_integrity": all(
            case["partition_error_pixels"] == 0 for case in cases),
    }


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_health(url: str, process: subprocess.Popen,
                    timeout: float = 60.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    error = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"rollback server exited with {process.returncode}")
        try:
            return request_json(url, timeout=2.0)
        except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
            error = exc
            time.sleep(0.25)
    raise TimeoutError(f"rollback server did not become healthy: {error}")


def local_capture(name: str, runtime_root: Path, provider: str,
                  source_dir: Path, smoke_records: list[dict[str, Any]],
                  captures_dir: Path, logs_dir: Path) -> dict[str, Any]:
    port = free_port()
    base_url = f"http://127.0.0.1:{port}"
    env = os.environ.copy()
    env.update({
        "PYTHONPATH": str(runtime_root),
        "RING_MODEL": "deploy/model.onnx",
        "RING_OWNERSHIP_REFINER": "deploy/ownership_refiner.onnx",
        "RING_PROVIDER": provider,
        "WEB_CONCURRENCY": "1",
    })
    logs_dir.mkdir(parents=True, exist_ok=True)
    log_path = logs_dir / f"{name}.log"
    with log_path.open("wb") as log:
        process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "deploy.serve:app",
             "--host", "127.0.0.1", "--port", str(port), "--workers", "1"],
            cwd=runtime_root, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            wait_for_health(base_url + "/health", process)
            capture = capture_target(
                name, base_url, source_dir, smoke_records, captures_dir,
                expected_provider=provider)
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
    capture["server_log"] = f"logs/{log_path.name}"
    return capture


def stable_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    """Metadata that should not move with known stochastic boundary pixels."""
    unstable = {"ring_px", "back_px", "back_fraction", "crop"}
    return {key: value for key, value in metadata.items() if key not in unstable}


def restore_source_canvas(image: np.ndarray,
                          metadata: dict[str, Any] | None) -> np.ndarray:
    if not metadata or "crop" not in metadata:
        return image
    width = int(metadata["source_width"])
    height = int(metadata["source_height"])
    crop = metadata["crop"]
    x, y = int(crop["x"]), int(crop["y"])
    crop_width, crop_height = int(crop["width"]), int(crop["height"])
    if image.shape[:2] != (crop_height, crop_width):
        raise ValueError("captured PNG dimensions do not match response crop metadata")
    if x < 0 or y < 0 or x + crop_width > width or y + crop_height > height:
        raise ValueError("response crop lies outside the source canvas")
    canvas = np.zeros((height, width) + image.shape[2:], image.dtype)
    canvas[y:y + crop_height, x:x + crop_width] = image
    return canvas


def image_difference(reference_path: Path, candidate_path: Path,
                     reference_metadata: dict[str, Any] | None = None,
                     candidate_metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    reference = cv2.imread(str(reference_path), cv2.IMREAD_UNCHANGED)
    candidate = cv2.imread(str(candidate_path), cv2.IMREAD_UNCHANGED)
    if reference is None or candidate is None:
        raise ValueError("cannot decode captured comparison layer")
    reference = restore_source_canvas(reference, reference_metadata)
    candidate = restore_source_canvas(candidate, candidate_metadata)
    if reference.shape != candidate.shape:
        return {"shape_equal": False, "compatible": False}
    # RGB beneath zero alpha is not observable, and antialiased RGB contributes in
    # proportion to alpha. Compare visible premultiplied RGBA while retaining raw PNG
    # SHA-256 separately for exact reproducibility evidence.
    def visible_rgba(image: np.ndarray) -> np.ndarray:
        alpha = image[..., 3:4].astype(np.float32) / 255.0
        rgb = np.rint(image[..., :3].astype(np.float32) * alpha).astype(np.uint8)
        return np.concatenate((rgb, image[..., 3:4]), axis=2)

    reference = visible_rgba(reference)
    candidate = visible_rgba(candidate)
    difference = np.abs(reference.astype(np.int16) - candidate.astype(np.int16))
    changed = np.any(difference != 0, axis=2)
    changed_fraction = float(changed.mean())
    mean_abs = float(difference.mean())
    return {
        "shape_equal": True,
        "comparison_space": "source-canvas-premultiplied-rgba",
        "changed_pixels": int(np.count_nonzero(changed)),
        "changed_fraction": changed_fraction,
        "mean_abs_u8": mean_abs,
        "max_abs_u8": int(difference.max()),
        "compatible": (
            changed_fraction <= ROLLBACK_MAX_CHANGED_FRACTION and
            mean_abs <= ROLLBACK_MAX_RGBA_MAE_U8),
    }


def compare_capture(reference: dict[str, Any], candidate: dict[str, Any],
                    captures_root: Path | None = None) -> dict[str, Any]:
    reference_cases = {case["case_id"]: case for case in reference["cases"]}
    candidate_cases = {case["case_id"]: case for case in candidate["cases"]}
    rows = []
    for case_id in sorted(reference_cases):
        if case_id not in candidate_cases:
            raise ValueError(f"candidate capture is missing {case_id}")
        left_attempts = reference_cases[case_id]["attempts"]
        right_attempts = candidate_cases[case_id]["attempts"]
        if len(left_attempts) != len(right_attempts):
            raise ValueError(f"attempt count differs for {case_id}")
        attempts = []
        for index, (left, right) in enumerate(zip(left_attempts, right_attempts)):
            layer_equal = {
                layer: left["layers"][layer]["sha256"] ==
                       right["layers"][layer]["sha256"]
                for layer in LAYERS
            }
            exact = left["metadata"] == right["metadata"] and all(
                layer_equal.values())
            pixel_difference = {}
            if captures_root is not None:
                for layer in LAYERS:
                    pixel_difference[layer] = image_difference(
                        captures_root / reference["name"] /
                        left["layers"][layer]["file"],
                        captures_root / candidate["name"] /
                        right["layers"][layer]["file"],
                        left["metadata"], right["metadata"])
                compatible = (
                    stable_metadata(left["metadata"]) ==
                    stable_metadata(right["metadata"]) and
                    all(item["compatible"] for item in
                        pixel_difference.values()))
            else:
                compatible = exact
            attempts.append({
                "attempt": index + 1,
                "metadata_equal": left["metadata"] == right["metadata"],
                "layer_sha256_equal": layer_equal,
                "pixel_difference": pixel_difference,
                "exact": exact,
                "compatible": compatible,
            })
        rows.append({
            "case_id": case_id,
            "attempts": attempts,
            "exact": all(attempt["exact"] for attempt in attempts),
            "compatible": all(attempt["compatible"] for attempt in attempts),
        })
    return {
        "reference": reference["name"],
        "candidate": candidate["name"],
        "cases": rows,
        "all_exact": all(row["exact"] for row in rows),
        "all_compatible": all(row["compatible"] for row in rows),
        "compatibility_limits": {
            "max_changed_fraction": ROLLBACK_MAX_CHANGED_FRACTION,
            "max_rgba_mae_u8": ROLLBACK_MAX_RGBA_MAE_U8,
        },
    }


def seal_tree(root: Path) -> dict[str, Any]:
    files = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        if path.name == "seal.json":
            continue
        files.append({
            "path": path.relative_to(root).as_posix(),
            "bytes": path.stat().st_size,
            "sha256": sha256_file(path),
        })
    return {
        "schema_version": SCHEMA_VERSION,
        "sealed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "file_count": len(files),
        "files": files,
        "content_manifest_sha256": sha256_bytes(
            json.dumps(files, sort_keys=True).encode()),
    }


def rollback_instructions() -> str:
    return """# Frozen production rollback

This folder contains the exact CPU/GPU runtime files and smoke evidence recorded in
`manifest.json`. Verify `seal.json` before use. The live deployment captured by this
freeze used `CPUExecutionProvider`.

## Start with the current Python environment

From this freeze directory:

```bash
cd runtime
RING_MODEL=deploy/model.onnx \\
RING_OWNERSHIP_REFINER=deploy/ownership_refiner.onnx \\
RING_PROVIDER=CPUExecutionProvider \\
PYTHONPATH=. \\
python -m uvicorn deploy.serve:app --host 127.0.0.1 --port 8201 --workers 1
```

## Build an isolated CPU container

From `runtime/`:

```bash
docker build --file deploy/Dockerfile --tag jewelsense-api:rollback .
docker run --rm --name jewelsense-api-rollback -p 127.0.0.1:8201:8200 \\
  jewelsense-api:rollback
```

## Verify

In another shell from this freeze directory:

```bash
curl -fsS http://127.0.0.1:8201/health
curl -fsS -F 'file=@smoke/sources/core-round-4-prongs-single.jpg' \\
  http://127.0.0.1:8201/segment > /tmp/jewelsense-rollback-smoke.json
```

The current production path is known to be slightly nondeterministic because its
GrabCut contour refinement consumes mutable OpenCV RNG state. `manifest.json` records
both the exact hashes and the strict compatibility tolerance used for this freeze.
Do not replace the live service without following the deployment rollback procedure and
checking the preserved smoke cases.
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--live-url", required=True)
    parser.add_argument("--smoke", type=Path, action="append", required=True)
    parser.add_argument("--skip-cuda", action="store_true",
                        help="capture only live and rollback CPU providers")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    repo = args.repo.resolve()
    output = args.out.resolve()
    if output.exists():
        raise FileExistsError(f"refusing to overwrite existing freeze: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent))
    try:
        runtime_root = staging / "runtime"
        source_dir = staging / "smoke" / "sources"
        runtime_files = copy_runtime(repo, runtime_root)
        smoke_records = copy_smokes(args.smoke, source_dir)
        captures_dir = staging / "captures"

        print("[1/4] capturing live production")
        live = capture_target(
            "live-production", args.live_url, source_dir, smoke_records,
            captures_dir)
        print("[2/4] verifying copied rollback runtime on CPU")
        rollback_cpu = local_capture(
            "rollback-cpu", runtime_root, "CPUExecutionProvider", source_dir,
            smoke_records, captures_dir, staging / "logs")
        comparisons = [compare_capture(live, rollback_cpu, captures_dir)]
        captures = [live, rollback_cpu]

        if not args.skip_cuda:
            print("[3/4] recording copied rollback runtime on CUDA")
            rollback_cuda = local_capture(
                "rollback-cuda", runtime_root, "CUDAExecutionProvider", source_dir,
                smoke_records, captures_dir, staging / "logs")
            captures.append(rollback_cuda)
            comparisons.append(compare_capture(
                rollback_cpu, rollback_cuda, captures_dir))
        else:
            print("[3/4] CUDA capture skipped by request")

        complete = (
            all(capture["partition_integrity"] for capture in captures) and
            comparisons[0]["all_compatible"])
        known_defects = []
        if not live["all_deterministic"]:
            known_defects.append({
                "id": "production-request-nondeterminism",
                "summary": (
                    "Repeated identical requests produce small pixel changes. "
                    "A controlled cv2.setRNGSeed test points to mutable OpenCV "
                    "RNG state in the GrabCut contour-refinement path."),
                "release_gate": "V2 output must be deterministic.",
            })
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "complete": complete,
            "repository": git_record(repo),
            "environment": environment_record(),
            "runtime_files": runtime_files,
            "smoke_sources": smoke_records,
            "captures": captures,
            "comparisons": comparisons,
            "known_defects": known_defects,
            "notes": [
                "Live provider and local CUDA benchmark are separate baselines.",
                "Exact live-to-rollback hashes are impossible while production uses mutable GrabCut RNG state.",
                "Rollback compatibility restores tight crops to source coordinates, then requires stable non-crop metadata and <=0.25% changed RGBA pixels with <=0.10/255 mean absolute channel error.",
                "Production nondeterminism is preserved as a baseline defect, not hidden.",
                "CUDA differences are recorded but do not invalidate CPU rollback.",
            ],
        }
        (staging / "ROLLBACK.md").write_text(rollback_instructions())
        write_json(staging / "manifest.json", manifest)
        write_json(staging / "seal.json", seal_tree(staging))
        staging.rename(output)
        print(f"[4/4] sealed freeze -> {output}")
        if not complete:
            raise RuntimeError(
                "freeze was sealed but rollback verification did not pass; "
                "inspect manifest.json")
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        raise


if __name__ == "__main__":
    main()
