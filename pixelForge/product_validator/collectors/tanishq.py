"""Download public Tanishq product-gallery images with provenance.

This collector reads explicitly supplied product URLs.  It does not crawl
search, cart, account or checkout routes.  Images are stored below the
isolated validator data directory and remain ignored by Git.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen

from PIL import Image

from ..isolation import HERE, safe_output


PRODUCT_CODE = re.compile(r"^[a-z0-9]{10,24}$", re.IGNORECASE)
IMAGE_TEMPLATE = (
    "https://www.tanishq.co.in/dw/image/v2/BKCK_PRD/"
    "on/demandware.static/-/Sites-Tanishq-product-catalog/default/"
    "images/hi-res/{code}_{index}.jpg?sw={size}&sh={size}"
)
USER_AGENT = "JewelSense-validator-data-collector/1.0"
# The Demandware image transform returns 500, rather than 404, when a valid
# product has no image at the requested gallery index.
MISSING_IMAGE_STATUSES = {404, 500}


def canonical_product_url(value: str) -> str:
    """Validate a public Tanishq product URL and remove tracking arguments."""
    parsed = urlparse(value.strip())
    if parsed.scheme != "https" or parsed.netloc.lower() != "www.tanishq.co.in":
        raise ValueError(f"not a Tanishq HTTPS URL: {value}")
    if not parsed.path.startswith("/product/") or not parsed.path.endswith(".html"):
        raise ValueError(f"not a Tanishq product page: {value}")
    query = dict(parse_qsl(parsed.query))
    clean_query = urlencode({"lang": query.get("lang", "en_IN")})
    return urlunparse((parsed.scheme, parsed.netloc.lower(), parsed.path,
                       "", clean_query, ""))


def product_code(product_url: str) -> str:
    stem = Path(urlparse(canonical_product_url(product_url)).path).stem
    code = stem.rsplit("-", 1)[-1]
    if not PRODUCT_CODE.fullmatch(code):
        raise ValueError(f"cannot determine product code from {product_url}")
    return code.upper()


def gallery_url(code: str, index: int, size: int = 1200) -> str:
    if not PRODUCT_CODE.fullmatch(code):
        raise ValueError(f"invalid product code: {code}")
    if index < 1 or size < 224 or size > 2400:
        raise ValueError("invalid gallery index or image size")
    return IMAGE_TEMPLATE.format(code=code.upper(), index=index, size=size)


def _download(url: str, timeout: float) -> tuple[bytes, str]:
    request = Request(url, headers={"User-Agent": USER_AGENT,
                                    "Accept": "image/jpeg,image/*"})
    for attempt in range(3):
        try:
            with urlopen(request, timeout=timeout) as response:
                content_type = response.headers.get_content_type()
                body = response.read()
            break
        except HTTPError as exc:
            # The CDN also uses 500 for a missing slot, but genuine images can
            # transiently return 500 under load. Retry before calling it absent.
            if exc.code != 500 or attempt == 2:
                raise
            time.sleep(0.5 * (attempt + 1))
        except URLError:
            if attempt == 2:
                raise
            time.sleep(0.5 * (attempt + 1))
    if not content_type.startswith("image/"):
        raise ValueError(f"unexpected content type {content_type} for {url}")
    with Image.open(BytesIO(body)) as image:
        image.verify()
    return body, content_type


def collect(urls: list[str], output: Path, *, max_images: int = 8,
            size: int = 1200, delay: float = 0.75,
            timeout: float = 30.0) -> dict:
    output = safe_output(output, HERE / "data")
    output.mkdir(parents=True, exist_ok=True)
    products = []
    global_hashes: dict[str, str] = {}
    downloaded = existing = skipped = failures = 0

    canonical_urls = sorted({canonical_product_url(value) for value in urls})
    for position, page_url in enumerate(canonical_urls, 1):
        code = product_code(page_url)
        product_dir = output / code
        product_dir.mkdir(parents=True, exist_ok=True)
        images = []
        misses = 0
        for index in range(1, max_images + 1):
            image_url = gallery_url(code, index, size)
            relative = f"{code}/{index:02d}.jpg"
            path = output / relative
            if path.is_file():
                body = path.read_bytes()
                with Image.open(BytesIO(body)) as image:
                    image.verify()
                digest = hashlib.sha256(body).hexdigest()
                duplicate_of = global_hashes.get(digest)
                global_hashes.setdefault(digest, relative)
                images.append({
                    "index": index,
                    "url": image_url,
                    "file": relative,
                    "sha256": digest,
                    "content_type": "image/jpeg",
                    "duplicate_of": duplicate_of,
                    "reused": True,
                })
                existing += 1
                continue
            try:
                body, content_type = _download(image_url, timeout)
            except HTTPError as exc:
                if exc.code in MISSING_IMAGE_STATUSES:
                    misses += 1
                    if misses >= 2:
                        break
                    continue
                failures += 1
                images.append({"index": index, "url": image_url,
                               "error": f"HTTP {exc.code}"})
                continue
            except (URLError, TimeoutError, ValueError, OSError) as exc:
                failures += 1
                images.append({"index": index, "url": image_url,
                               "error": str(exc)})
                continue

            digest = hashlib.sha256(body).hexdigest()
            duplicate_of = global_hashes.get(digest)
            if duplicate_of is None:
                path.write_bytes(body)
                global_hashes[digest] = relative
                downloaded += 1
            else:
                skipped += 1
            images.append({
                "index": index,
                "url": image_url,
                "file": None if duplicate_of else relative,
                "sha256": digest,
                "content_type": content_type,
                "duplicate_of": duplicate_of,
            })
            if delay:
                time.sleep(delay)
        products.append({"product_code": code, "product_url": page_url,
                         "images": images})
        print(f"[{position}/{len(canonical_urls)}] {code}: "
              f"{sum(bool(item.get('file')) for item in images)} images",
              flush=True)

    report = {
        "schema_version": 1,
        "source": "Tanishq public product galleries",
        "source_category": (
            "https://www.tanishq.co.in/shop/finger-rings?lang=en_IN"),
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "usage_note": (
            "Provenance copy for internal validator review. Confirm image "
            "reuse rights before distributing images or a derived model."),
        "product_count": len(products),
        "downloaded": downloaded,
        "existing_reused": existing,
        "duplicates_skipped": skipped,
        "failures": failures,
        "products": products,
    }
    (output / "provenance.json").write_text(
        json.dumps(report, indent=2) + "\n")
    return report


def _read_urls(path: Path) -> list[str]:
    values = []
    for raw in path.read_text().splitlines():
        value = raw.strip()
        if value and not value.startswith("#"):
            values.append(value)
    if not values:
        raise ValueError(f"no product URLs found in {path}")
    return values


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url-file", required=True)
    parser.add_argument(
        "--output",
        default="product_validator/data/external/tanishq_rings")
    parser.add_argument("--max-images", type=int, default=8)
    parser.add_argument("--size", type=int, default=1200)
    parser.add_argument("--delay", type=float, default=0.75)
    parser.add_argument("--timeout", type=float, default=30.0)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = collect(
        _read_urls(Path(args.url_file)), Path(args.output),
        max_images=args.max_images, size=args.size,
        delay=max(0.0, args.delay), timeout=args.timeout)
    print(json.dumps({key: report[key] for key in
                      ("product_count", "downloaded", "existing_reused",
                       "duplicates_skipped", "failures")}, indent=2))


if __name__ == "__main__":
    main()
