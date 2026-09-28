# JewelSense API for frontend developers

This API removes a plain catalogue background from a ring or loose gemstone.
Ring requests can return three aligned transparent layers so the ring can be
placed around a hand image.

## Connection details

- Local base URL: `http://127.0.0.1:8200`
- Request body: `multipart/form-data`
- Required form field: `file`
- Authentication: none in the service; add it at the gateway if required
- CORS: currently allows all origins, methods, and headers

Do not set the multipart `Content-Type` header in browser code. `fetch` adds
the boundary when it sends a `FormData` body.

## Which endpoint to use

| Need | Endpoint | Response |
| --- | --- | --- |
| All ring layers and review metadata | `POST /segment` | JSON containing three base64 PNGs |
| One ring layer only | `POST /segment/full`, `/front`, or `/back` | Raw PNG |
| One loose gemstone cutout | `POST /segment-gem` | Raw PNG |
| Service status | `GET /health` | JSON |

Use one `/segment` request when the UI needs all three ring layers. Calling
the three single-layer endpoints separately runs segmentation three times.

## Image contract

Send a JPEG, PNG, or WebP catalogue image with one ring or one loose gemstone
on a plain background. Images of at least 1000×1000 pixels give the model the
best edge detail. Smaller images are accepted and may be internally enlarged.

For `/segment-gem`, an upload that already contains transparent pixels keeps
its embedded alpha unchanged. The service does not run background inference
over an existing cutout.

Every ring output PNG:

- has an alpha channel;
- is tightly cropped to the nonzero encoded alpha bounds;
- has no transparent padding outside the segmented object.

Gemstone output is different: after tight segmentation, the stone is placed
on the physical-scale transparent canvas described below.

All three ring PNGs use the full ring matte's single shared crop. Their widths,
heights, and pixel coordinates therefore remain identical. Never crop the
front and back layers independently.

For a virtual try-on, composite ring layers in this order:

1. back layer;
2. hand image;
3. front layer.

Apply the same crop, scale, and position to both ring layers. Use `full` for a
standalone cutout or preview; do not place it on top of `front` and `back`.

## Ring segmentation

### `POST /segment`

Send the image in the `file` form field:

```bash
curl -F 'file=@ring.jpg' http://127.0.0.1:8200/segment
```

Response type:

```ts
type RingSegmentation = {
  full: string;
  front: string;
  back: string;
  ring_px: number;
  back_px: number;
  back_fraction: number;
  needs_review: boolean;
  source_width: number;
  source_height: number;
  crop: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  processing_width: number;
  processing_height: number;
  supersampled: boolean;
  low_resolution_input: boolean;
  ms: number;
};
```

Example response, with PNG values shortened:

```json
{
  "full": "iVBORw0KGgo...",
  "front": "iVBORw0KGgo...",
  "back": "iVBORw0KGgo...",
  "ring_px": 54619,
  "back_px": 3525,
  "back_fraction": 0.0645,
  "needs_review": false,
  "source_width": 499,
  "source_height": 499,
  "crop": { "x": 47, "y": 174, "width": 405, "height": 151 },
  "processing_width": 1000,
  "processing_height": 1000,
  "supersampled": true,
  "low_resolution_input": true,
  "ms": 199.2
}
```

The `full`, `front`, and `back` values contain base64-encoded PNG bytes. They
do not include a data-URL prefix.

For latency-sensitive previews, call `POST /segment?compact=1`. The response
keeps `full` and all diagnostic fields, replaces `front` and `back` with
`front_mask` and `back_mask`, and sets `transport` to
`"compact-alpha-masks"`. The masks are transparent PNGs whose alpha channels
define layer ownership. Display the full PNG through the corresponding CSS
mask, or apply the mask with canvas `destination-in`. This avoids transferring
the ring's identical RGB pixels three times. The bundled review UI uses this
compact form; the default response remains backward compatible.

| Field | Meaning |
| --- | --- |
| `full` | Entire ring cutout. |
| `front` | Ring pixels rendered in front of the hand. |
| `back` | Rear band pixels rendered behind the hand. |
| `ring_px` | Foreground pixel count in the returned full mask. Diagnostic only. |
| `back_px` | Foreground pixel count in the returned back mask. Diagnostic only. |
| `back_fraction` | `back_px / ring_px`, rounded to four decimals. |
| `needs_review` | `true` when the back-layer ratio is outside the expected range. This is a review heuristic, not a confidence score. |
| `source_width`, `source_height` | Uploaded image dimensions. |
| `crop` | Tight output rectangle in uploaded-image coordinates. All three ring PNGs use this exact rectangle. |
| `processing_width`, `processing_height` | Internal dimensions used for segmentation. |
| `supersampled` | Whether the server processed a resized working image. |
| `low_resolution_input` | Whether the shorter source dimension is below the recommended 1000 pixels. |
| `ms` | Server processing time in milliseconds; network and browser decoding time are excluded. |

Browser example:

```js
const API_BASE = ""; // Same origin. Set a full URL only when CORS is configured.

async function readApiError(response) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return `Request failed with HTTP ${response.status}`;
  }

  if (typeof body.detail === "string") return body.detail;
  if (Array.isArray(body.detail)) {
    return body.detail.map((item) => item.msg).join(", ");
  }
  return `Request failed with HTTP ${response.status}`;
}

async function segmentRing(file, signal) {
  const form = new FormData();
  form.append("file", file, file.name);

  const response = await fetch(`${API_BASE}/segment`, {
    method: "POST",
    body: form,
    signal,
  });

  if (!response.ok) throw new Error(await readApiError(response));

  const result = await response.json();
  return {
    ...result,
    imageUrls: {
      full: `data:image/png;base64,${result.full}`,
      front: `data:image/png;base64,${result.front}`,
      back: `data:image/png;base64,${result.back}`,
    },
  };
}
```

Cancel an obsolete request when the user selects another file:

```js
let activeRequest;

async function handleFile(file) {
  activeRequest?.abort();
  activeRequest = new AbortController();
  return segmentRing(file, activeRequest.signal);
}
```

## One ring layer as a PNG

### `POST /segment/{layer}`

`layer` must be `full`, `front`, or `back`. The response body is a raw
`image/png`, which is useful when the UI or another service needs only one
layer. The body is tightly cropped using the full ring matte, even when the
requested layer is `front` or `back`.

The response includes `X-Source-Width`, `X-Source-Height`, `X-Crop-X`,
`X-Crop-Y`, `X-Crop-Width`, and `X-Crop-Height` headers. These describe the
crop in uploaded-image coordinates.

```js
async function getRingLayer(file, layer) {
  const allowed = new Set(["full", "front", "back"]);
  if (!allowed.has(layer)) throw new Error("Invalid ring layer");

  const form = new FormData();
  form.append("file", file, file.name);

  const response = await fetch(`${API_BASE}/segment/${layer}`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) throw new Error(await readApiError(response));

  const blob = await response.blob();
  return {
    imageUrl: URL.createObjectURL(blob),
    source: {
      width: Number(response.headers.get("X-Source-Width")),
      height: Number(response.headers.get("X-Source-Height")),
    },
    crop: {
      x: Number(response.headers.get("X-Crop-X")),
      y: Number(response.headers.get("X-Crop-Y")),
      width: Number(response.headers.get("X-Crop-Width")),
      height: Number(response.headers.get("X-Crop-Height")),
    },
  };
}
```

Call `URL.revokeObjectURL(result.imageUrl)` when the cutout is replaced.

## Gemstone segmentation

### `POST /segment-gem`

Use this endpoint for one loose gemstone, not a ring. It returns one raw RGBA
PNG. It does not return front/back layers or JSON metadata.

Send `width` and `height` as the gemstone's physical dimensions in
millimetres. Send both values or omit both. When both are omitted, the API uses
10 mm × 10 mm so older clients continue to work.

The output uses a 500px-wide transparent canvas representing 20 mm, or
25 px/mm. The tightly segmented gemstone is resized to `width × 25` pixels,
its source aspect ratio is preserved, and it is centred horizontally. The
canvas height equals the resized gemstone height, leaving no top/bottom
padding. When the
width/height orientation and pixel orientation disagree, the gemstone is
rotated 90° clockwise before resizing. This is the same physical layout as the
catalogue script at one quarter of its original pixel density.

Both dimensions must be greater than zero and no larger than 20 mm. Sending
only one dimension returns HTTP 422.

```bash
curl -f \
  -F 'file=@gemstone.jpg' \
  -F 'width=6.5' \
  -F 'height=8.0' \
  http://127.0.0.1:8200/segment-gem \
  --output gemstone.png
```

```js
async function segmentGemstone(file, widthMm, heightMm) {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("width", String(widthMm));
  form.append("height", String(heightMm));

  const response = await fetch(`${API_BASE}/segment-gem`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) throw new Error(await readApiError(response));

  const blob = await response.blob();
  return {
    imageUrl: URL.createObjectURL(blob),
    source: {
      width: Number(response.headers.get("X-Source-Width")),
      height: Number(response.headers.get("X-Source-Height")),
    },
    crop: {
      x: Number(response.headers.get("X-Crop-X")),
      y: Number(response.headers.get("X-Crop-Y")),
      width: Number(response.headers.get("X-Crop-Width")),
      height: Number(response.headers.get("X-Crop-Height")),
    },
    physicalSize: {
      widthMm: Number(response.headers.get("X-Gem-Width-Mm")),
      heightMm: Number(response.headers.get("X-Gem-Height-Mm")),
    },
    output: {
      width: Number(response.headers.get("X-Output-Width")),
      height: Number(response.headers.get("X-Output-Height")),
      rotated: response.headers.get("X-Gem-Rotated") === "true",
    },
  };
}
```

The six `X-Source-*` and `X-Crop-*` headers describe the segmentation crop in
the uploaded image. The gemstone response adds these headers:

| Header | Meaning |
| --- | --- |
| `X-Gem-Width-Mm`, `X-Gem-Height-Mm` | Requested or defaulted physical dimensions. |
| `X-Gem-Canvas-Px` | Transparent canvas width; currently `500`. |
| `X-Gem-Canvas-Mm` | Physical width represented by the canvas; currently `20`. |
| `X-Gem-Rotated` | `true` when orientation normalization rotated the cutout clockwise. |
| `X-Output-Width`, `X-Output-Height` | Actual returned PNG dimensions. |

Call `URL.revokeObjectURL(result.imageUrl)` when the cutout is replaced.

## Health check

### `GET /health`

Use `ok` for availability and display `providers[0]` when the UI needs to show
the active runtime.

```js
const response = await fetch(`${API_BASE}/health`, { cache: "no-store" });
if (!response.ok) throw new Error("Segmentation service is unavailable");

const health = await response.json();
console.log(health.ok, health.providers[0], health.model);
```

The response also contains model and post-processing configuration for
diagnostics. Frontend behavior should not depend on those internal thresholds.

## Errors

Expected request errors use FastAPI's JSON format. Infrastructure failures and
unhandled server errors may return a non-JSON body, so error parsing must have
a generic fallback.

| Status | Cause | Example `detail` |
| --- | --- | --- |
| `400` | Uploaded bytes are not a decodable image | `"could not decode image"` |
| `404` | Invalid value in `/segment/{layer}` | `"layer must be full, front or back"` |
| `422` | Missing file, one missing gemstone dimension, or invalid gemstone size | Validation-error array or a string `detail` |
| `500` | Inference or PNG encoding failed | No stable body; show a generic server error |

Treat `AbortError` separately from a real failure so cancelled requests do not
show an error message. Do not automatically retry `400`, `404`, or `422`
responses. A gateway may also return its own `401`, `413`, `429`, or `5xx`
response when authentication, upload limits, rate limits, or upstream health
checks are configured.

## Production integration

- Keep the browser and API on the same origin when possible. The service
  temporarily permits every CORS origin; restrict this at the gateway before
  public production use.
- Put authentication, TLS, upload-size limits, and rate limiting at the
  gateway or reverse proxy; they are not built into this service.
- Allow at least 30 seconds at the proxy. The browser should show progress and
  let the user cancel while a request is running.
- Limit the file picker to image types and reject obviously oversized files in
  the UI before upload. The service does not publish a fixed byte limit.
- Show a review warning when `needs_review` is true, but still allow the user
  to inspect the returned layers.
