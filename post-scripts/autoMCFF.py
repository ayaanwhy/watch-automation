import os
from PIL import Image

# ======================
# CONFIG
# ======================
IMAGE_FOLDER = "/Volumes/PortableSSD 1/demo clients/shopifystore/compare/bracelets"

# 👇 change this whenever
ASSUMED_WIDTH_MM = 60

IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".tiff")

# ======================
# LOGIC
# ======================
def main():
    if not os.path.isdir(IMAGE_FOLDER):
        print("❌ Invalid image folder path.")
        return

    print(f"\n📏 Width assumed as {ASSUMED_WIDTH_MM} mm\n")

    for filename in os.listdir(IMAGE_FOLDER):
        if filename.startswith("._"):
            continue

        if not filename.lower().endswith(IMAGE_EXTENSIONS):
            continue

        filepath = os.path.join(IMAGE_FOLDER, filename)

        try:
            with Image.open(filepath) as img:
                width_px, height_px = img.size

                mm_per_pixel = ASSUMED_WIDTH_MM / width_px
                height_mm = height_px * mm_per_pixel

                name = os.path.splitext(filename)[0]

                print(
                    f"{name} → "
                    f"{ASSUMED_WIDTH_MM:.2f} mm × {height_mm:.2f} mm"
                )

        except Exception as e:
            print(f"⚠️ Failed to process {filename}: {e}")


if __name__ == "__main__":
    main()
