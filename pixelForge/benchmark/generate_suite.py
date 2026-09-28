"""Generate the deterministic Buchroeders geometry/appearance coverage suite."""

import argparse
import json
import re
from pathlib import Path


SOURCE_PAGE = ("https://brdiamonds.com/pages/custom-engagement-ring?stage=Select+Setting"
               "&sort=PRICE-ASC&rconfigShow=true"
               "&currentSKU=3644575a38494a5536304c324e4555&ringRegion=us")
SHAPES = ["Round", "Oval", "Cushion", "Princess", "Pear", "Emerald", "Marquise"]
HEADS = ["4 Prongs", "Basket", "Peg Head", "Pave", "Single Halo", "Crown",
         "Flower Halo"]
MOUNTINGS = ["Single", "Double", "Double Twist", "Knife Edge", "Square Edge",
             "Tapered", "Contemporary", "Hidden Halo", "Split"]
SIDE_SETTINGS = ["U-Pave", "Channel", "Prong", "Bead", "Pave"]
SIDE_STONES = ["Diamond", "Alt. Sapphire", "Alt. Emerald", "Alt. Ruby"]
METALS = ["14K White Gold", "14K Yellow Gold", "14K Rose Gold", "Platinum"]

DEFAULTS = {
    "Center diamond type": "Lab-grown",
    "Center stone size": "1 ct",
    "Ring head metal": "14K White Gold",
    "Side setting": "U-Pave",
    "Side stones type": "Diamond",
    "Side stones length": "1/2",
    "Mounting metal": "14K White Gold",
}


def slug(value):
    return re.sub(r"(^-|-$)", "", re.sub(r"[^a-z0-9]+", "-", value.lower()))


def case(case_id, selections, notes=""):
    return {"id": case_id, "selections": selections, **({"notes": notes} if notes else {})}


def generate_cases():
    cases = []
    # Exhaust the three controls that most strongly change silhouette and seam.
    for shape in SHAPES:
        for head in HEADS:
            for mounting in MOUNTINGS:
                cases.append(case(
                    f"core-{slug(shape)}-{slug(head)}-{slug(mounting)}",
                    {"Center stone shape": shape, "Ring head type": head,
                     "Mounting type": mounting}))

    # Exercise clipping/scale risks at both ends without multiplying every shank.
    for shape in SHAPES:
        for head in HEADS:
            for size in ("0.25 ct", "10 ct"):
                cases.append(case(
                    f"extreme-{slug(shape)}-{slug(head)}-{slug(size)}",
                    {"Center stone shape": shape, "Ring head type": head,
                     "Mounting type": "Single", "Center stone size": size}))

    # Side-setting geometry, colour and length have their own compact full cross.
    for setting in SIDE_SETTINGS:
        for stone in SIDE_STONES:
            for length in ("1/2", "3/4"):
                cases.append(case(
                    f"side-{slug(setting)}-{slug(stone)}-{slug(length)}",
                    {"Center stone shape": "Round", "Ring head type": "Basket",
                     "Mounting type": "Single", "Side setting": setting,
                     "Side stones type": stone, "Side stones length": length}))
    cases.append(case("side-none", {
        "Center stone shape": "Round", "Ring head type": "Basket",
        "Mounting type": "Single", "Side setting": "None",
        "Side stones type": None, "Side stones length": None,
    }))

    # Karat variants are integration checks; segmentation covers colour families.
    for head_metal in METALS:
        for mounting_metal in METALS:
            cases.append(case(
                f"metal-{slug(head_metal)}-{slug(mounting_metal)}",
                {"Center stone shape": "Oval", "Ring head type": "4 Prongs",
                 "Mounting type": "Tapered", "Ring head metal": head_metal,
                 "Mounting metal": mounting_metal}))

    # Natural/lab choice should not alter geometry, but every shape gets one API check.
    for shape in SHAPES:
        cases.append(case(f"natural-{slug(shape)}", {
            "Center diamond type": "Natural", "Center stone shape": shape,
            "Ring head type": "4 Prongs", "Mounting type": "Single",
        }))

    cases.extend([
        case("risk-marquise-flower-hidden-emerald-10ct", {
            "Center stone shape": "Marquise", "Center stone size": "10 ct",
            "Ring head type": "Flower Halo", "Mounting type": "Hidden Halo",
            "Side stones type": "Alt. Emerald", "Side stones length": "3/4",
            "Ring head metal": "14K Rose Gold", "Mounting metal": "Platinum",
        }),
        case("risk-pear-flower-split-ruby-10ct", {
            "Center stone shape": "Pear", "Center stone size": "10 ct",
            "Ring head type": "Flower Halo", "Mounting type": "Split",
            "Side stones type": "Alt. Ruby", "Side stones length": "3/4",
            "Ring head metal": "14K White Gold", "Mounting metal": "14K Rose Gold",
        }),
        case("risk-princess-single-halo-double-sapphire-025ct", {
            "Center stone shape": "Princess", "Center stone size": "0.25 ct",
            "Ring head type": "Single Halo", "Mounting type": "Double",
            "Side stones type": "Alt. Sapphire", "Side stones length": "1/2",
            "Ring head metal": "14K Yellow Gold", "Mounting metal": "14K White Gold",
        }),
    ])
    return cases


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="benchmark/suites/ultimate-v1.json")
    args = parser.parse_args()
    output = {
        "schema_version": 1,
        "name": "buchroeders-ultimate-v1",
        "source_page": SOURCE_PAGE,
        "defaults": DEFAULTS,
        "coverage": {
            "core_shape_head_mounting": len(SHAPES) * len(HEADS) * len(MOUNTINGS),
            "size_extremes": len(SHAPES) * len(HEADS) * 2,
            "side_setting_colour_length": len(SIDE_SETTINGS) * len(SIDE_STONES) * 2 + 1,
            "metal_colour_pairs": len(METALS) ** 2,
            "natural_shape_checks": len(SHAPES),
            "curated_high_risk": 3,
        },
        "cases": generate_cases(),
    }
    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(output, indent=2) + "\n")
    print(f"{path}: {len(output['cases'])} cases")


if __name__ == "__main__":
    main()
