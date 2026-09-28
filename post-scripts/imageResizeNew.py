import os
from PIL import Image
from concurrent.futures import ThreadPoolExecutor, as_completed

# False = normal behaviour

# True  = invert top/bottom padding logic

FLIP_PADDING_DIRECTION = False

# Number of worker threads for applying changes
MAX_WORKERS = 16

def apply_operation(op):
    product_code = op["product_code"]
    img_b_path = op["img_b_path"]
    action = op["action"]

    try:
        with Image.open(img_b_path) as img_b:
            img_b = img_b.convert("RGBA")
            width_b, height_b = img_b.width, img_b.height

            target_height = op.get("target_height", op.get("new_height"))
            diff = target_height - height_b

            if diff <= 0:
                return f"{product_code}: Skipping - already tall enough."

            new_img_b = Image.new(
                "RGBA",
                (width_b, target_height),
                (0, 0, 0, 0)
            )

            alpha_b = img_b.getchannel("A")

            if action == "pad_bottom":

                # Keep image at top
                paste_y = 0

            else:

                # Push image downward
                paste_y = diff

            new_img_b.paste(img_b, (0, paste_y), mask=alpha_b)
            new_img_b.save(img_b_path, format="PNG")

            return (
                f"{product_code}: ✔ Padded B at "
                f"{'TOP' if action == 'pad_top' else 'BOTTOM'} "
                f"by {diff}px."
            )

    except Exception as e:
        return f"Error processing {product_code}: {e}"

def adjust_image_heights(folder_path):
    # Collect image pairs by product code
    image_pairs = {}
    for filename in os.listdir(folder_path):
        # Ignore macOS metadata files
        if filename.startswith("._"):
            continue
        # Ignore hidden macOS files (.DS_Store, etc.)
        if filename.startswith("."):
            continue
        print(f"Checking: {filename}")
        if ';' in filename:
            parts = filename.split(';')
            if len(parts) == 2:
                product_code, tag = parts
                print(f"Found product: {product_code}, Tag: {tag}")
                if tag.startswith('frontImage'):
                    image_pairs.setdefault(product_code, {})['A'] = filename
                elif tag.startswith('frontFullImage'):
                    image_pairs.setdefault(product_code, {})['B'] = filename

    # Print recognized product codes
    print("\nRecognized products:", ', '.join(image_pairs.keys()) if image_pairs else "None")

    # --- Pair analysis (before any measuring/resizing) ---
    pair_count = 0
    unpaired = []

    for product_code, images in image_pairs.items():
        has_a = 'A' in images
        has_b = 'B' in images
        if has_a and has_b:
            pair_count += 1
        else:
            unpaired.append((product_code, images.get('A'), images.get('B')))

    print("\n================ PAIR SUMMARY ================")
    print(f"Total product codes found: {len(image_pairs)}")
    print(f"Valid pairs (A + B): {pair_count}")
    print(f"Products with missing pair: {len(unpaired)}")

    if unpaired:
        print("\nProducts missing one side (A or B):")
        for product_code, a_name, b_name in unpaired:
            print(f"  {product_code}: A = {a_name if a_name else 'MISSING'}, "
                  f"B = {b_name if b_name else 'MISSING'}")

    # First confirmation: proceed to inspect & plan?
    if pair_count == 0:
        print("\nNo valid pairs found. Nothing to inspect.")
        return

    confirm_pairs = input(
        "\nProceed to inspect these pairs and plan resizing operations? [y/N]: "
    ).strip().lower()
    if confirm_pairs not in ("y", "yes"):
        print("Aborted before inspection. No images were read or modified.")
        return

    # --- First pass: inspect and plan (no writes yet) ---
    print("\n================ INSPECTION & PLAN ================")
    operations = []
    for product_code, images in image_pairs.items():
        if 'A' not in images or 'B' not in images:
            # already logged above, so just skip
            continue

        img_a_path = os.path.join(folder_path, images['A'])
        img_b_path = os.path.join(folder_path, images['B'])

        try:
            with Image.open(img_a_path) as img_a, Image.open(img_b_path) as img_b:
                img_a = img_a.convert("RGBA")
                img_b = img_b.convert("RGBA")

                height_a = img_a.height
                height_b = img_b.height

                print(f"{product_code}: A (frontImage) height = {height_a}, "
                      f"B (frontFullImage) height = {height_b}")

                if height_a == height_b:
                    print(f"  → Skipping {product_code} – heights already match.")
                    continue

                if height_a > height_b:

                    diff = height_a - height_b

                    action = "pad_top" if FLIP_PADDING_DIRECTION else "pad_bottom"
                    side = "TOP" if action == "pad_top" else "BOTTOM"

                    print(
                        f"  → PLAN: Pad B at {side} by {diff}px "
                        f"(B height {height_b} → {height_a})."
                    )

                    operations.append({
                        "product_code": product_code,
                        "action": action,
                        "img_b_path": img_b_path,
                        "target_height": height_a,
                        "diff": diff
                    })

                else:

                    diff = height_b - height_a
                    new_height = height_b + diff

                    action = "pad_bottom" if FLIP_PADDING_DIRECTION else "pad_top"
                    side = "BOTTOM" if action == "pad_bottom" else "TOP"

                    print(
                        f"  → PLAN: Pad B at {side} by {diff}px "
                        f"(B height {height_b} → {new_height})."
                    )

                    operations.append({
                        "product_code": product_code,
                        "action": action,
                        "img_b_path": img_b_path,
                        "original_height": height_b,
                        "new_height": new_height,
                        "target_height": new_height,
                        "diff": diff
                    })

        except Exception as e:
            print(f"Error inspecting {product_code}: {e}")

    if not operations:
        print("\nNo changes needed. All valid pairs either matched in height or were unusable.")
        return

    print(f"\nPlanned operations: {len(operations)} pair(s) will modify ONLY B (frontFullImage).")

    # Second confirmation: actually resize?
    confirm_apply = input(
        "Proceed with these changes and modify the images? [y/N]: "
    ).strip().lower()
    if confirm_apply not in ("y", "yes"):
        print("Aborted after planning. No images were modified.")
        return

    # --- Second pass: apply operations ---
    print("\n================ APPLYING CHANGES ================")
    print(f"Using {MAX_WORKERS} worker thread(s)...")

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = [executor.submit(apply_operation, op) for op in operations]

        for future in as_completed(futures):
            print(future.result())

    print("\nAll planned B (frontFullImage) adjustments completed.")

    print("\nAll planned B (frontFullImage) adjustments completed.")

if __name__ == "__main__":
    folder_path = "/Volumes/PortableSSD 1/demo clients/misc/slot10/exported"
    if not os.path.exists(folder_path):
        print(f"Folder '{folder_path}' not found.")
    else:
        adjust_image_heights(folder_path)
