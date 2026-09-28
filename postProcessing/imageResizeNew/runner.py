"""Sandbox-headless imageResizeNew (Phase 15.7).

Adapted from post-scripts/imageResizeNew.py. The core algorithm is
unchanged: for every SKU that has both a `;frontImage` and a
`;frontFullImage` file in the given directory, pad the shorter of the two
(by transparent rows, top or bottom depending on which is shorter) so both
share the taller image's height. Only `;frontFullImage` (B) is ever
modified, exactly as the original script documented.

Differences from the original personal script:
  - No interactive confirm() prompts — always proceeds (Sandbox's own Final
    Review is the human checkpoint downstream, not this script).
  - No hardcoded personal folder path — takes --dir on the command line.
  - Emits one final RESULT_JSON line to stdout instead of print-only
    reporting, so the calling adapter can determine success/failure and
    which SKUs were touched without scraping human-readable output.
"""
import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

from PIL import Image

MAX_WORKERS = 16


def apply_operation(op):
    product_code = op["product_code"]
    img_b_path = op["img_b_path"]
    action = op["action"]

    with Image.open(img_b_path) as img_b:
        img_b = img_b.convert("RGBA")
        width_b, height_b = img_b.width, img_b.height
        target_height = op["target_height"]
        diff = target_height - height_b

        if diff <= 0:
            return {"sku": product_code, "changed": False}

        new_img_b = Image.new("RGBA", (width_b, target_height), (0, 0, 0, 0))
        alpha_b = img_b.getchannel("A")
        paste_y = 0 if action == "pad_bottom" else diff
        new_img_b.paste(img_b, (0, paste_y), mask=alpha_b)
        new_img_b.save(img_b_path, format="PNG")

    return {"sku": product_code, "changed": True, "action": action, "diff": diff}


def find_pairs(folder_path):
    image_pairs = {}
    for filename in os.listdir(folder_path):
        if filename.startswith("."):
            continue
        if ";" not in filename:
            continue
        product_code, tag = filename.split(";", 1)
        if tag.startswith("frontImage"):
            image_pairs.setdefault(product_code, {})["A"] = filename
        elif tag.startswith("frontFullImage"):
            image_pairs.setdefault(product_code, {})["B"] = filename
    return image_pairs


def plan_operations(folder_path, image_pairs):
    operations = []
    unpaired = []
    for product_code, images in image_pairs.items():
        if "A" not in images or "B" not in images:
            unpaired.append(product_code)
            continue

        img_a_path = os.path.join(folder_path, images["A"])
        img_b_path = os.path.join(folder_path, images["B"])

        with Image.open(img_a_path) as img_a, Image.open(img_b_path) as img_b:
            height_a = img_a.height
            height_b = img_b.height

        if height_a == height_b:
            continue

        if height_a > height_b:
            operations.append({
                "product_code": product_code,
                "action": "pad_bottom",
                "img_b_path": img_b_path,
                "target_height": height_a,
            })
        else:
            operations.append({
                "product_code": product_code,
                "action": "pad_top",
                "img_b_path": img_b_path,
                "target_height": height_b,
            })
    return operations, unpaired


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True, help="Directory containing ;frontImage/;frontFullImage pairs")
    args = parser.parse_args()

    if not os.path.isdir(args.dir):
        print(f"RESULT_JSON:{json.dumps({'ok': False, 'error': f'Directory not found: {args.dir}'})}")
        sys.exit(1)

    try:
        image_pairs = find_pairs(args.dir)
        operations, unpaired = plan_operations(args.dir, image_pairs)

        results = []
        if operations:
            with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
                futures = [executor.submit(apply_operation, op) for op in operations]
                for future in as_completed(futures):
                    results.append(future.result())

        print(f"RESULT_JSON:{json.dumps({'ok': True, 'padded': results, 'unpaired': unpaired})}")
    except Exception as exc:  # noqa: BLE001 - report honestly, never fake success
        print(f"Error: {exc}", file=sys.stderr)
        print(f"RESULT_JSON:{json.dumps({'ok': False, 'error': str(exc)})}")
        sys.exit(1)


if __name__ == "__main__":
    main()
