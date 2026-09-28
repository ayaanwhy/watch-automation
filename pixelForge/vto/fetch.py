"""Pull full/front pairs from the Topaz product API into a training folder.

The API pages over products; each product carries variants, and each variant's
`VariantImageJson` holds a `frontFullImage` (whole ring) and a `frontImage`
(ring minus the part behind the finger). Those two are the training pair.

    TOKEN=... python -m vto.fetch --token "$TOKEN" --pages 5 --out data/pairs

The bearer token is short-lived (~14 min), so metadata for every page is
fetched first and cached to pairs.json; image downloads hit CloudFront, which
needs no auth and can be resumed later with --from-cache.
"""

import argparse
import json
import os
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

import cv2

API = "https://topaz.clouddeploy.in/api/v1/product/get"
HEADERS = {
    "accept": "application/json",
    "origin": "https://ruby.clouddeploy.in",
}


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--token", help="bearer token (omit with --from-cache)")
    p.add_argument("--pages", type=int, default=0, help="0 = derive from totalRecords")
    p.add_argument("--brand", default="NivodaConnectApp")
    p.add_argument("--tenant", default="458")
    p.add_argument("--category", default=None, help="iCategoryId filter, e.g. 1158 for rings")
    p.add_argument("--page-size", type=int, default=12)
    p.add_argument("--out", default="data/pairs")
    p.add_argument("--cache", default="data/pairs.json")
    p.add_argument("--from-cache", action="store_true",
                   help="skip the API and download from a previous pairs.json")
    p.add_argument("--limit", type=int, default=0, help="0 = all")
    p.add_argument("--workers", type=int, default=12)
    return p.parse_args()


def fetch_page(page, args):
    url = f"{API}?iPageNumber={page}&iPageSize={args.page_size}&bIsUpdated=false"
    if args.category:
        url += f"&iCategoryId={args.category}"
    req = urllib.request.Request(url, headers={
        **HEADERS, "brandname": args.brand, "tenantid": str(args.tenant),
        "authorization": f"Bearer {args.token}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def collect(args):
    pairs, seen = [], set()
    total_pages = args.pages
    page = 0
    while True:
        page += 1
        if total_pages and page > total_pages:
            break
        try:
            d = fetch_page(page, args)
        except urllib.error.HTTPError as e:
            raise SystemExit(f"page {page}: HTTP {e.code} - token expired? "
                             f"({len(pairs)} pairs collected so far)")
        data = d.get("data", {})
        products = data.get("productData", [])
        if not total_pages:
            total = data.get("totalRecords") or 0
            total_pages = max(1, -(-total // args.page_size))
            print(f"[i] {total} products -> {total_pages} pages")
        if not products:
            break
        for prod in products:
            sku = prod.get("sSKU") or f"p{prod.get('iProductId')}"
            for var in json.loads(prod.get("VariantJson") or "[]"):
                imgs = {e["sTag"]: e["sURL"] for e in (var.get("VariantImageJson") or [])}
                vid = var.get("iVariantId")
                if vid in seen or "frontFullImage" not in imgs or "frontImage" not in imgs:
                    continue
                seen.add(vid)
                pairs.append({"id": f"{sku}_{vid}".replace("/", "-"),
                              "full": imgs["frontFullImage"],
                              "front": imgs["frontImage"]})
        print(f"[i] page {page}/{total_pages}: {len(products)} products, "
              f"{len(pairs)} pairs so far", flush=True)
    return pairs


def usable(path):
    im = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    return im is not None and im.ndim == 3 and im.shape[2] == 4


def main():
    args = parse_args()
    os.makedirs(os.path.dirname(args.cache) or ".", exist_ok=True)

    if args.from_cache:
        pairs = json.load(open(args.cache))
        print(f"[i] {len(pairs)} pairs from {args.cache}")
    else:
        if not args.token:
            raise SystemExit("--token required (or use --from-cache)")
        pairs = collect(args)
        json.dump(pairs, open(args.cache, "w"), indent=1)
        print(f"[✓] cached {len(pairs)} pairs -> {args.cache}")

    if args.limit:
        pairs = pairs[:args.limit]
    os.makedirs(args.out, exist_ok=True)

    def grab(p):
        d = os.path.join(args.out, p["id"])
        fu, fr = os.path.join(d, "full.png"), os.path.join(d, "front.png")
        if os.path.exists(fu) and os.path.exists(fr):
            return True
        os.makedirs(d, exist_ok=True)
        try:
            urllib.request.urlretrieve(p["full"], fu)
            urllib.request.urlretrieve(p["front"], fr)
            return usable(fu) and usable(fr)
        except Exception:
            return False

    kept = skipped = done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(grab, p): p for p in pairs}
        for f in as_completed(futs):
            done += 1
            if f.result():
                kept += 1
            else:
                skipped += 1
            if done % 100 == 0:
                print(f"    {done}/{len(pairs)}  kept={kept} skipped={skipped}", flush=True)
    print(f"[✓] {kept} usable pairs in {args.out}  ({skipped} skipped)")


if __name__ == "__main__":
    main()
