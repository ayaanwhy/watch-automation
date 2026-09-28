import os
import pandas as pd
from PIL import Image

# =======================
# CONFIG
# =======================
IMAGE_FOLDER = "/Volumes/PortableSSD 1/demo clients/crgems/Exports/slot3/exported"
SHEET_PATH  = "/Volumes/PortableSSD 1/demo clients/crgems/sheets/VTO-S4.xlsx"  # .xlsx OR .csv
OUTPUT_FOLDER = "/Volumes/PortableSSD 1/demo clients/crgems/Exports/slot3/resized"

CANVAS_PX = 2000
CANVAS_MM = 20
MAX_IMAGES = None  # set to None for no limit

os.makedirs(OUTPUT_FOLDER, exist_ok=True)

# =======================
# LOAD DATA (EXCEL / CSV)
# =======================
ext = os.path.splitext(SHEET_PATH)[1].lower()

if ext in [".xlsx", ".xls"]:
    df = pd.read_excel(SHEET_PATH)
elif ext == ".csv":
    df = pd.read_csv(SHEET_PATH)
else:
    raise ValueError("Sheet must be .xlsx, .xls, or .csv")

# Now need Width, Height, AND Shape (Shape drives the pear-specific method)
required_cols = {"SKU", "Width", "Height", "Shape"}
if not required_cols.issubset(df.columns):
    raise ValueError("Sheet must contain columns: 'SKU', 'Width', 'Height', and 'Shape'")

df["SKU"] = df["SKU"].astype(str)
df["Width"] = pd.to_numeric(df["Width"], errors="coerce")
df["Height"] = pd.to_numeric(df["Height"], errors="coerce")
df["Shape"] = df["Shape"].fillna("").astype(str)

# sku -> (width_mm, height_mm)
sku_to_mm = dict(zip(df["SKU"], zip(df["Width"], df["Height"])))

# sku -> shape string (used to detect pear stones, case-insensitive substring match)
sku_to_shape = dict(zip(df["SKU"], df["Shape"]))


def is_pear(sku):
    return "pear" in sku_to_shape.get(sku, "").lower()


# =======================
# SCAN IMAGES
# =======================
image_files = [
    f for f in os.listdir(IMAGE_FOLDER)
    if f.lower().endswith(".png") and not f.startswith("._")
]

# SKU is whatever comes before the first ';' — anything after it is a tag
# (e.g. "ABC123;frontImage.png" -> SKU "ABC123")
sku_to_filename = {}
for f in image_files:
    base = os.path.splitext(f)[0]
    sku = base.split(";")[0]
    sku_to_filename[sku] = f  # last match wins if a SKU has multiple tagged files

image_skus = list(sku_to_filename.keys())

matched = []
unmatched_images = []
unmatched_skus = []

for sku in image_skus:
    if sku in sku_to_mm:
        matched.append(sku)
    else:
        unmatched_images.append(sku)

for sku in sku_to_mm:
    if sku not in image_skus:
        unmatched_skus.append(sku)

# preserve order, kill duplicates
matched = list(dict.fromkeys(matched))

if MAX_IMAGES is not None:
    matched = matched[:MAX_IMAGES]

# =======================
# STEP 1 — REPORT
# =======================
print("\n--- SCAN REPORT ---")
print(f"Images found: {len(image_files)}")
print(f"SKUs in sheet: {len(sku_to_mm)}")
print(f"Matched SKUs (to be processed): {len(matched)}"
      + (f" / capped at {MAX_IMAGES}" if MAX_IMAGES else ""))

if unmatched_images:
    print("\nImages with NO matching SKU:")
    for sku in unmatched_images:
        print(f" - {sku}")

# if unmatched_skus:
#     print("\nSKUs in sheet with NO image:")
#     for sku in unmatched_skus:
#         print(f" - {sku}")

confirm = input("\nProceed to width calculation preview? (y/n): ").strip().lower()
if confirm != "y":
    print("aborted. nothing touched. vibes intact.")
    exit()

# =======================
# STEP 2 — WIDTH PREVIEW
# Target width in px is normally driven by the sheet's Width column.
# EXCEPTION: Pear-shaped SKUs get force-rotated 90° CW before resizing,
# so their target width is pulled from Height mm instead (swapped),
# since that's the mm value that will line up with the new width axis
# after rotation.
# =======================
px_per_mm = CANVAS_PX / CANVAS_MM
resize_plan = {}

print("\n--- RESIZE PREVIEW ---")
for sku in matched:
    width_mm, height_mm = sku_to_mm[sku]

    if is_pear(sku):
        target_mm = height_mm  # swapped — this SKU will be force-rotated
        target_px = int(round(target_mm * px_per_mm))
        resize_plan[sku] = target_px
        print(f"{sku} [PEAR]: {target_mm} mm (swapped from Height) → {target_px}px wide")
    else:
        target_mm = width_mm
        target_px = int(round(target_mm * px_per_mm))
        resize_plan[sku] = target_px
        print(f"{sku}: {target_mm} mm → {target_px}px wide")

confirm = input("\nApply these changes and generate images? (y/n): ").strip().lower()
if confirm != "y":
    print("stood down. nothing rendered.")
    exit()

rotation_confirm = input(
    "\nEnable rotation check? (y = check + rotate if needed, n = process as-is like before): ").strip().lower()
ROTATION_ENABLED = (rotation_confirm == "y")

# =======================
# STEP 3 — PROCESS IMAGES
# =======================
print("\n--- PROCESSING ---")

for sku in matched:
    img_path = os.path.join(IMAGE_FOLDER, sku_to_filename[sku])
    out_path = os.path.join(OUTPUT_FOLDER, f"{sku}.png")  # output stays clean, no tag suffix

    width_mm, height_mm = sku_to_mm[sku]

    with Image.open(img_path) as img:
        orig_w, orig_h = img.size

        # -----------------------------------------
        # ROTATION — one of three methods per SKU:
        #
        # 1) PEAR (forced): Shape column contains "pear" -> always rotate
        #    90° CW, no check. mm dims were already swapped in Step 2.
        #
        # 2) CONDITIONAL (existing check, non-pear only, gated by
        #    ROTATION_ENABLED): rotate only if longer-side-in-px and
        #    longer-side-in-mm disagree.
        #
        # 3) NORMAL: no rotation at all.
        # -----------------------------------------
        rotated = False
        method = "normal"

        if is_pear(sku):
            img = img.rotate(-90, expand=True)  # -90 = 90° clockwise
            orig_w, orig_h = img.size
            rotated = True
            method = "pear-forced"

        elif ROTATION_ENABLED:
            mm_longer_is_width = width_mm >= height_mm
            px_longer_is_width = orig_w >= orig_h

            if mm_longer_is_width != px_longer_is_width:
                img = img.rotate(-90, expand=True)  # -90 = 90° clockwise
                orig_w, orig_h = img.size
                rotated = True
                method = "conditional"

        new_w = resize_plan[sku]
        scale = new_w / orig_w
        new_h = int(round(orig_h * scale))

        resized = img.resize((new_w, new_h), Image.LANCZOS)
        resized = resized.convert("RGBA")

        canvas = Image.new("RGBA", (CANVAS_PX, new_h), (0, 0, 0, 0))
        x_offset = (CANVAS_PX - new_w) // 2

        canvas.paste(resized, (x_offset, 0), resized)
        canvas.save(out_path)

        rot_note = f" [rotated 90° CW — {method}]" if rotated else f" [{method}]"
        print(f"{sku}: {orig_w}x{orig_h}{rot_note} → {CANVAS_PX}x{new_h}")

print("\ndone. centered. padded. spiritually aligned.")