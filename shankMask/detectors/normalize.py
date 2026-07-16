import math


def _num(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _point(value):
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return [_num(value[0]), _num(value[1])]
    return None


def _dist(a, b):
    return math.hypot(b[0] - a[0], b[1] - a[1])


def _polygon(value):
    if not isinstance(value, list) or not value:
        return None
    points = []
    biggest = 0.0
    for entry in value:
        point = _point(entry)
        if point:
            points.append(point)
            biggest = max(biggest, point[0], point[1])
    if not points:
        return None
    if biggest > 1.5:
        divisor = biggest if biggest > 100 else 100
        points = [[x / divisor, y / divisor] for x, y in points]
    return points


def _container(raw):
    if not isinstance(raw, dict):
        return {}
    inner = raw.get("results")
    if isinstance(inner, dict):
        return inner
    return raw


def _kind(data, hint):
    if data.get("ear_coordinates") or data.get("ear_coordinate"):
        return "ear"
    if data.get("neck_mask_wide"):
        return "neck"
    coords = data.get("coordinates")
    if isinstance(coords, dict) and any(
        isinstance(coords.get(k), list) for k in ("Ring", "Index", "Middle", "Pinky")
    ):
        return "finger"
    if data.get("wrist") or data.get("wrist_result"):
        return "wrist"
    return (hint or "wrist").lower()


def _ear(data):
    raw = data.get("ear_coordinates") or data.get("ear_coordinate") or data.get("coordinates")
    point = None
    if isinstance(raw, list) and raw:
        point = _point(raw[0])
    point = point or [0.5, 0.5]
    phy = _num(data.get("phy_to_norm")) or None
    return {
        "bodyType": "ear",
        "center": point,
        "left": None,
        "right": None,
        "rotation": 0,
        "polygon": _polygon(data.get("polygon")),
        "phyToNorm": phy,
        "zoom": _num(data.get("zoom_factor"), 1),
    }


def _neck(data):
    wide = data.get("neck_mask_wide") or {}
    left = _point(wide.get("left_point")) or [0.35, 0.5]
    right = _point(wide.get("right_point")) or [0.65, 0.5]
    center = [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2]
    return {
        "bodyType": "neck",
        "left": left,
        "right": right,
        "center": center,
        "rotation": _num(wide.get("rotation_angle")),
        "polygon": _polygon(data.get("polygon")),
    }


def _finger(data):
    coords = data.get("coordinates") or {}
    chosen = None
    for name in ("Ring", "Index", "Middle", "Pinky"):
        if isinstance(coords.get(name), list) and coords.get(name):
            chosen = name
            break
    if chosen is None and isinstance(coords, dict):
        for name, samples in coords.items():
            if isinstance(samples, list) and samples:
                chosen = name
                break

    seat = None
    if chosen:
        samples = [s for s in coords[chosen] if isinstance(s, dict)]
        if samples:
            base = max(
                samples,
                key=lambda s: (_point(s.get("center")) or [0, 0])[1],
            )
            left = _point(base.get("left"))
            right = _point(base.get("right"))
            if left and right:
                center = _point(base.get("center")) or [
                    (left[0] + right[0]) / 2,
                    (left[1] + right[1]) / 2,
                ]
                seat = {
                    "left": left,
                    "right": right,
                    "center": center,
                    "width": _num(base.get("width")) or _dist(left, right),
                    "rotation": _num(base.get("rotation_angle")),
                }
    if seat is None:
        seat = {
            "left": [0.35, 0.55],
            "right": [0.65, 0.55],
            "center": [0.5, 0.55],
            "width": 0.3,
            "rotation": 0,
        }

    polygon = data.get("polygon")
    if isinstance(polygon, dict) and chosen:
        polygon = polygon.get(chosen)

    return {
        "bodyType": "finger",
        "hand": data.get("hand", "Right"),
        "finger": chosen,
        "polygon": _polygon(polygon),
        **seat,
    }


def _wrist(data):
    wrist = data.get("wrist") or data.get("wrist_result") or {}
    coords = wrist.get("coordinates") or []
    first = coords[0] if isinstance(coords, list) and coords else {}
    if not isinstance(first, dict):
        first = {}
    left = _point(first.get("left")) or _point(wrist.get("left")) or [0.35, 0.55]
    right = _point(first.get("right")) or _point(wrist.get("right")) or [0.65, 0.55]
    center = _point(first.get("center")) or _point(wrist.get("center")) or [
        (left[0] + right[0]) / 2,
        (left[1] + right[1]) / 2,
    ]
    return {
        "bodyType": "wrist",
        "left": left,
        "right": right,
        "center": center,
        "rotation": _num(first.get("rotation_angle") or wrist.get("rotation_angle")),
        "width": _num(first.get("width")) or _dist(left, right),
        "polygon": _polygon(wrist.get("polygon") or data.get("polygon")),
    }


def normalize(raw, body_type=None):
    data = _container(raw)
    kind = _kind(data, body_type)
    if kind == "ear":
        return _ear(data)
    if kind == "neck":
        return _neck(data)
    if kind == "finger":
        return _finger(data)
    return _wrist(data)
