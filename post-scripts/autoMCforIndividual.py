import os
import pandas as pd
from PIL import Image

# -----------------------------
# CONFIGURATION
# -----------------------------

sheet_path = "/Volumes/PortableSSD 1/demo clients/rometsch/sheets/jewellery.xlsx"   # Path to your sheet (xlsx or csv)
image_folder = "/Volumes/PortableSSD 1/demo clients/rometsch/Batches/slot6/exported/"     # Folder containing SKU images
sku_column = "SKU"          # Column name for SKUs in sheet
width_column = "Product Width (mm)"        # Column name for width in mm
height_column = "Product Height (mm)"    # Column name for height values in mm
image_extensions = (".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff")

# -----------------------------
# SELECT MODE
# -----------------------------

print("Select operation mode:")
print("1 - Use sheet HEIGHT to calculate WIDTH")
print("2 - Use sheet WIDTH to calculate HEIGHT")

mode = input("Enter 1 or 2: ").strip()

if mode not in ["1", "2"]:
    print("Invalid selection. Exiting.")
    exit()

# -----------------------------
# LOAD SHEET
# -----------------------------

if sheet_path.endswith(".csv"):
    df = pd.read_csv(sheet_path)
else:
    df = pd.read_excel(sheet_path)

df[sku_column] = df[sku_column].astype(str).str.strip()

sku_width_map = dict(zip(df[sku_column], df[width_column]))
sku_height_map = dict(zip(df[sku_column], df[height_column]))

# -----------------------------
# PROCESS IMAGES
# -----------------------------

for filename in os.listdir(image_folder):
    if filename.lower().endswith(image_extensions):
        sku_from_image = os.path.splitext(filename)[0].strip()

        image_path = os.path.join(image_folder, filename)

        if sku_from_image not in df[sku_column].values:
            print(f"{sku_from_image} - SKU not found in sheet")
            continue

        with Image.open(image_path) as img:
            width_px, height_px = img.size

        if mode == "1":
            # Height known → calculate width
            sheet_height = sku_height_map.get(sku_from_image)

            if pd.isna(sheet_height):
                print(f"{sku_from_image} - Height missing in sheet")
                continue

            calculated_width = (width_px / height_px) * sheet_height
            calculated_width = round(calculated_width, 2)

            print(f"{sku_from_image} - {calculated_width} x {sheet_height}")

        elif mode == "2":
            # Width known → calculate height
            sheet_width = sku_width_map.get(sku_from_image)

            if pd.isna(sheet_width):
                print(f"{sku_from_image} - Width missing in sheet")
                continue

            calculated_height = (height_px / width_px) * sheet_width
            calculated_height = round(calculated_height, 2)

            print(f"{sku_from_image} - {sheet_width} x {calculated_height}")
