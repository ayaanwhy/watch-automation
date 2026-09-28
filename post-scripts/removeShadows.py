import os
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
from tqdm import tqdm

# --- CONFIGURATION ---

INPUT_FOLDER = "/Volumes/PortableSSD 1/demo clients/misc/Downloads/Seilnacht/upscaled/watches"

OUTPUT_FOLDER = "/Volumes/PortableSSD 1/demo clients/misc/slot10/compare"

SHADOW_THRESHOLD = 90

# ❗️ Number of worker threads
# Try:
# 4 = conservative
# 8 = good for most systems
# 16 = fast SSDs / lots of images
NUM_THREADS = 8


def process_image(image_path, output_path, threshold):
    """
    Removes shadows, rotates 270 degrees, trims the new left edge, and saves a single PNG image.
    """
    try:
        with Image.open(image_path) as img:
            if img.mode != 'RGBA':
                img = img.convert('RGBA')

            # --- 1. Remove shadows ---
            alpha_channel = img.getchannel('A')
            new_alpha_channel = alpha_channel.point(
                lambda p: 0 if p < threshold else p
            )
            img.putalpha(new_alpha_channel)

            # --- 2. Rotate the image ---
            img = img.transpose(Image.Transpose.ROTATE_270)

            # --- 3. Trim the new left edge of the rotated image ---
            bbox = img.getbbox()

            if bbox:
                left_trim_box = (bbox[0], 0, img.width, img.height)
                img = img.crop(left_trim_box)

            # --- 4. Save the final result ---
            img.save(output_path, 'PNG')

    except Exception as e:
        print(f"\n❌ Error processing {os.path.basename(image_path)}: {e}")


def main():
    """
    Main function to find PNGs and process them.
    """
    if not os.path.isdir(INPUT_FOLDER) or "path/to" in INPUT_FOLDER:
        print("❌ Error: Please set the `INPUT_FOLDER` variable to a valid directory.")
        return

    os.makedirs(OUTPUT_FOLDER, exist_ok=True)
    print(f"✅ Output will be saved to: {os.path.abspath(OUTPUT_FOLDER)}")

    png_files = [
        f for f in os.listdir(INPUT_FOLDER)
        if f.lower().endswith('.png') and not f.startswith('._')
    ]

    if not png_files:
        print(f"🤷 No valid PNG files were found in '{INPUT_FOLDER}'.")
        return

    print(f"🔎 Found {len(png_files)} PNG images to process.")
    print(f"🧵 Using {NUM_THREADS} threads")

    jobs = [
        (
            os.path.join(INPUT_FOLDER, filename),
            os.path.join(OUTPUT_FOLDER, filename),
            SHADOW_THRESHOLD
        )
        for filename in png_files
    ]

    with ThreadPoolExecutor(max_workers=NUM_THREADS) as executor:
        list(
            tqdm(
                executor.map(lambda args: process_image(*args), jobs),
                total=len(jobs),
                desc="Processing Images"
            )
        )

    print("\n✨ All images have been processed!")


if __name__ == "__main__":
    main()