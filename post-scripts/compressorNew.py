import os
import threading
from PIL import Image
import pillow_avif
from concurrent.futures import ThreadPoolExecutor, as_completed

# =======================
# CONFIG
# =======================
# Add as many input folders as you need — they all compress into one shared OUTPUT_FOLDER.
INPUT_FOLDERS = [
    # "/Volumes/PortableSSD 1/demo clients/seiko/Exports/slot8/exported2",
    # "/Volumes/PortableSSD 1/demo clients/seiko/Exports/slot8/compare2",
    # "/Volumes/PortableSSD 1/demo clients/misc/slot10/exported",
    "/Volumes/PortableSSD 1/demo clients/misc/slot10/compare-2k",

    # "/Volumes/PortableSSD 1/demo clients/titan/batches/batch15c/exported",
    # "/Volumes/PortableSSD 1/demo clients/titan/batches/batch15c/compare"
    # "/Volumes/PortableSSD 1/demo clients/crgems/Exports/slot3/compare",
    # "/Volumes/PortableSSD 1/demo clients/crgems/Exports/slot3/resized"
]

OUTPUT_FOLDER = "/Volumes/PortableSSD 1/demo clients/misc/slot10/compressed"

QUALITY = 90
SPEED = 6
MAX_IMAGES = None  # per-folder limit
THREADS = 16

# PNG quantization settings (lossy-but-visually-lossless)
PNG_MIN_QUALITY = 0   # Lower = smaller file, more color loss (0–100)
PNG_MAX_QUALITY = 98   # Upper bound — keeps it near-lossless
PNG_DITHERING = 1.0    # 0.0 = no dither, 1.0 = full (smoother gradients)

os.makedirs(OUTPUT_FOLDER, exist_ok=True)

# =======================
# CONFIRMATION
# =======================
print("📁 Input folders queued:")
for in_folder in INPUT_FOLDERS:
    exists = "✅" if os.path.isdir(in_folder) else "❌ MISSING"
    print(f"   {exists}  {in_folder}")
print(f"\n📤 Output folder: {OUTPUT_FOLDER}")

proceed = input("\nProceed with these folders? [y/n]: ").strip().lower()
if proceed != "y":
    print("Aborted.")
    raise SystemExit

# =======================
# STATS (thread-safe)
# =======================
stats_lock = threading.Lock()
total_original = 0
total_compressed = 0
processed = 0
failed = 0

def kb(b):
    return b / 1024

# =======================
# FORMAT SELECTION
# =======================
while True:
    choice = input("Output format? [1] PNG  [2] AVIF: ").strip()
    if choice == "1":
        OUTPUT_FORMAT = "PNG"
        OUTPUT_EXT = ".png"
        break
    elif choice == "2":
        OUTPUT_FORMAT = "AVIF"
        OUTPUT_EXT = ".avif"
        break
    else:
        print("Invalid choice. Please enter 1 or 2.")

print(f"\n✅ Output format set to: {OUTPUT_FORMAT}\n")

if OUTPUT_FORMAT == "PNG":
    try:
        import imagequant
        USE_QUANTIZATION = True
        print("🎨 PNG quantization enabled (near-lossless, high compression)\n")
    except ImportError:
        USE_QUANTIZATION = False
        print("⚠️  imagequant not found — falling back to standard PNG optimize.")
        print("    For best results: pip install imagequant\n")
else:
    USE_QUANTIZATION = False

# =======================
# WORKER
# =======================
def process_image(in_folder, out_filename, filename):
    global total_original, total_compressed, processed, failed

    in_path = os.path.join(in_folder, filename)
    out_path = os.path.join(OUTPUT_FOLDER, out_filename)
    original_size = os.path.getsize(in_path)

    try:
        with Image.open(in_path) as img:
            if img.mode in ("P", "PA"):
                img = img.convert("RGBA")

            if OUTPUT_FORMAT == "PNG":
                if USE_QUANTIZATION:
                    # Quantize to 256 colors — the big savings happen here
                    quantized = imagequant.quantize_pil_image(
                        img,
                        dithering_level=PNG_DITHERING,
                        min_quality=PNG_MIN_QUALITY,
                        max_quality=PNG_MAX_QUALITY,
                    )
                    quantized.save(out_path, format="PNG", optimize=True)
                else:
                    img.save(out_path, format="PNG", optimize=True)
            else:
                img.save(out_path, format="AVIF", quality=QUALITY, speed=SPEED)

        compressed_size = os.path.getsize(out_path)
        saved = original_size - compressed_size
        percent = (saved / original_size) * 100 if original_size else 0

        with stats_lock:
            total_original += original_size
            total_compressed += compressed_size
            processed += 1

        print(
            f"🔥 [{os.path.basename(in_folder)}] {filename} → {out_filename} | "
            f"{kb(original_size):.1f} KB → {kb(compressed_size):.1f} KB "
            f"({percent:.1f}% saved)"
        )

    except Exception as e:
        with stats_lock:
            processed += 1
            failed += 1
        print(f"❌ [{os.path.basename(in_folder)}] {filename} failed — {e}")

# =======================
# COLLECT FILES (all folders → one flat output)
# =======================
jobs = []  # list of (in_folder, out_filename, filename)
seen_out_names = set()
collisions = 0

for in_folder in INPUT_FOLDERS:
    if not os.path.isdir(in_folder):
        print(f"⚠️  Skipping missing folder: {in_folder}")
        continue

    folder_files = [
        f for f in os.listdir(in_folder)
        if f.lower().endswith(".png") and not f.startswith("._")
    ]

    if MAX_IMAGES is not None:
        folder_files = folder_files[:MAX_IMAGES]
        print(f"⚠️  Limited to {MAX_IMAGES} images for {in_folder}")

    print(f"📂 {in_folder} → {len(folder_files)} images queued")

    for f in folder_files:
        out_filename = os.path.splitext(f)[0] + OUTPUT_EXT

        # Collision handling: if two input folders produce the same output
        # filename, prefix subsequent ones with their source folder name so
        # nothing silently overwrites.
        if out_filename in seen_out_names:
            source_tag = os.path.basename(os.path.normpath(in_folder))
            out_filename = f"{source_tag}_{out_filename}"
            collisions += 1

        seen_out_names.add(out_filename)
        jobs.append((in_folder, out_filename, f))

if collisions:
    print(f"⚠️  {collisions} filename collision(s) detected — colliding files were prefixed with their source folder name.")

print(f"\n🚀 Processing {len(jobs)} images total across {THREADS} threads...\n")

# =======================
# PROCESS
# =======================
with ThreadPoolExecutor(max_workers=THREADS) as executor:
    futures = {
        executor.submit(process_image, in_folder, out_filename, f): f
        for in_folder, out_filename, f in jobs
    }
    for future in as_completed(futures):
        pass

# =======================
# SUMMARY
# =======================
total_saved = total_original - total_compressed
total_percent = (total_saved / total_original) * 100 if total_original else 0

print("\n📉 FINAL DAMAGE REPORT")
print(f"Format used:      {OUTPUT_FORMAT}")
print(f"Threads used:     {THREADS}")
print(f"Input folders:    {len(INPUT_FOLDERS)}")
print(f"Output folder:    {OUTPUT_FOLDER}")
print(f"Images processed: {processed}" + (f" / {MAX_IMAGES} per folder (limited)" if MAX_IMAGES else ""))
print(f"Filename collisions resolved: {collisions}")
print(f"Failed:           {failed}")
print(f"Original total:   {kb(total_original):.1f} KB")
print(f"Compressed total: {kb(total_compressed):.1f} KB")
print(f"Saved:            {kb(total_saved):.1f} KB ({total_percent:.1f}%)")
print("\n✨ Images quantized. Pixels survived. Filesizes did not.")