"""Collect license-described gemstone candidates from Wikimedia Commons."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import time
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from PIL import Image

from ..isolation import HERE, safe_output


API = "https://commons.wikimedia.org/w/api.php"
USER_AGENT = "JewelSense-validator-data-collector/1.0"
ALLOWED_LICENSE_PREFIXES = ("CC0", "Public domain", "CC BY ")
ALLOWED_MIME = {"image/jpeg": ".jpg", "image/png": ".png",
                "image/webp": ".webp"}


def clean_metadata(value: str | None) -> str | None:
    if not value:
        return None
    value = re.sub(r"<[^>]+>", " ", html.unescape(value))
    return " ".join(value.split())


def license_allowed(name: str | None) -> bool:
    return bool(name and name.startswith(ALLOWED_LICENSE_PREFIXES))


def _api(params: dict, timeout: float) -> dict:
    url = API + "?" + urlencode({"format": "json", "formatversion": 2,
                                  **params})
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=timeout) as response:
        return json.load(response)


def category_files(category: str, *, width: int, timeout: float):
    continuation = {}
    while True:
        payload = _api({
            "action": "query",
            "generator": "categorymembers",
            "gcmtitle": category,
            "gcmtype": "file",
            "gcmlimit": "50",
            "prop": "imageinfo",
            "iiprop": "url|mime|extmetadata",
            "iiurlwidth": str(width),
            **continuation,
        }, timeout)
        yield from payload.get("query", {}).get("pages", [])
        continuation = payload.get("continue") or {}
        if not continuation:
            break


def _download(url: str, timeout: float) -> bytes:
    request = Request(url, headers={"User-Agent": USER_AGENT,
                                    "Accept": "image/*"})
    for attempt in range(3):
        try:
            with urlopen(request, timeout=timeout) as response:
                body = response.read()
            with Image.open(BytesIO(body)) as image:
                image.verify()
            return body
        except HTTPError as exc:
            if exc.code != 429 or attempt == 2:
                raise
            retry_after = exc.headers.get("Retry-After")
            wait = float(retry_after) if retry_after else 10.0 * (attempt + 1)
            time.sleep(min(max(wait, 5.0), 60.0))
    raise RuntimeError("unreachable download retry state")


def collect(categories: list[str], output: Path, *, max_files: int = 200,
            width: int = 1200, delay: float = 0.25,
            timeout: float = 30.0) -> dict:
    output = safe_output(output, HERE / "data")
    output.mkdir(parents=True, exist_ok=True)
    seen_pages = set()
    hashes = {}
    records = []
    accepted = 0
    skipped_license = skipped_type = duplicates = failures = 0

    for category in categories:
        if accepted >= max_files:
            break
        for page in category_files(category, width=width, timeout=timeout):
            page_id = int(page["pageid"])
            if page_id in seen_pages:
                continue
            seen_pages.add(page_id)
            info = (page.get("imageinfo") or [{}])[0]
            mime = info.get("mime")
            if mime not in ALLOWED_MIME:
                skipped_type += 1
                continue
            metadata = info.get("extmetadata") or {}
            license_name = (metadata.get("LicenseShortName") or {}).get("value")
            if not license_allowed(license_name):
                skipped_license += 1
                continue
            image_url = info.get("thumburl") or info.get("url")
            if not image_url:
                failures += 1
                continue
            relative = f"{page_id}/image{ALLOWED_MIME[mime]}"
            path = output / relative
            reused = path.is_file()
            try:
                if reused:
                    body = path.read_bytes()
                    with Image.open(BytesIO(body)) as image:
                        image.verify()
                else:
                    body = _download(image_url, timeout)
            except (OSError, TimeoutError, ValueError) as exc:
                failures += 1
                records.append({"page_id": page_id, "title": page["title"],
                                "image_url": image_url, "error": str(exc)})
                continue
            digest = hashlib.sha256(body).hexdigest()
            duplicate_of = hashes.get(digest)
            if duplicate_of:
                duplicates += 1
                continue
            if not reused:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(body)
            hashes[digest] = relative
            records.append({
                "page_id": page_id,
                "title": page["title"],
                "description_url": info.get("descriptionurl"),
                "image_url": image_url,
                "file": relative,
                "sha256": digest,
                "mime": mime,
                "license": license_name,
                "license_url": (metadata.get("LicenseUrl") or {}).get("value"),
                "artist": clean_metadata(
                    (metadata.get("Artist") or {}).get("value")),
                "credit": clean_metadata(
                    (metadata.get("Credit") or {}).get("value")),
                "categories": [category],
            })
            accepted += 1
            if accepted % 25 == 0:
                print(f"collected {accepted}/{max_files}", flush=True)
            if accepted >= max_files:
                break
            if delay and not reused:
                time.sleep(delay)

    report = {
        "schema_version": 1,
        "source": "Wikimedia Commons API",
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "license_policy": (
            "CC0, public-domain and CC BY files only; retain per-file "
            "attribution from this provenance file."),
        "categories": categories,
        "downloaded_or_reused": accepted,
        "duplicates_skipped": duplicates,
        "license_skipped": skipped_license,
        "type_skipped": skipped_type,
        "failures": failures,
        "files": records,
    }
    (output / "provenance.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    return report


def _read_categories(path: Path) -> list[str]:
    categories = []
    for raw in path.read_text().splitlines():
        value = raw.strip()
        if not value or value.startswith("#"):
            continue
        if not value.startswith("Category:"):
            value = "Category:" + value
        categories.append(value)
    if not categories:
        raise ValueError(f"no categories found in {path}")
    return categories


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--category-file", required=True)
    parser.add_argument(
        "--output",
        default="product_validator/data/external/commons_gems")
    parser.add_argument("--max-files", type=int, default=200)
    # 1024 is a standard Commons thumbnail width. Non-standard transforms are
    # throttled more aggressively by the image servers.
    parser.add_argument("--width", type=int, default=1024)
    parser.add_argument("--delay", type=float, default=1.0)
    parser.add_argument("--timeout", type=float, default=30.0)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = collect(
        _read_categories(Path(args.category_file)), Path(args.output),
        max_files=args.max_files, width=args.width,
        delay=max(0.0, args.delay), timeout=args.timeout)
    keys = ("downloaded_or_reused", "duplicates_skipped", "license_skipped",
            "type_skipped", "failures")
    print(json.dumps({key: report[key] for key in keys}, indent=2))


if __name__ == "__main__":
    main()
