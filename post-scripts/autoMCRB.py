import os
import csv
from PIL import Image

# === CONFIG ===
FOLDER_PATH = "/Volumes/PortableSSD 1/demo clients/misc/compare-demo/bracelet"
TARGET_WIDTH_MM = 60  # <- set your desired width in millimeters


def process_images(folder_path, target_width_mm, compare_only):
    rows = []

    for filename in os.listdir(folder_path):
        if filename.startswith("._"):
            continue

        # Filter by ;compare tag if selected
        name_no_ext = os.path.splitext(filename)[0]
        if compare_only and not name_no_ext.endswith(";compare"):
            continue

        file_path = os.path.join(folder_path, filename)

        try:
            with Image.open(file_path) as img:
                width_px, height_px = img.size

                aspect_ratio = height_px / width_px
                height_mm = target_width_mm * aspect_ratio

                print(filename)
                print(f"  Output Size: {target_width_mm:.2f} mm (W) x {height_mm:.2f} mm (H)")
                print("-" * 40)

                rows.append([
                    name_no_ext,
                    round(target_width_mm, 2),
                    round(height_mm, 2)
                ])

        except Exception as e:
            print(f"Skipping {filename}: {e}")

    csv_path = os.path.join(folder_path, "dimensions.csv")

    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["SKU", "Width", "Height"])
        writer.writerows(rows)

    print(f"\n{len(rows)} image(s) processed.")
    print(f"CSV saved to: {csv_path}")


# === Run ===
print("Run on:")
print("  [1] All images in folder")
print("  [2] Only images with ';compare' tag")
choice = input("Enter 1 or 2: ").strip()

if choice == "1":
    compare_only = False
    print("\nProcessing all images...\n")
elif choice == "2":
    compare_only = True
    print("\nProcessing only ';compare' images...\n")
else:
    print("Invalid choice. Exiting.")
    exit()

process_images(FOLDER_PATH, TARGET_WIDTH_MM, compare_only)