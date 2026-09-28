# Deploy JewelSense

JewelSense is one stateless HTTP service. The API, test frontend, base model,
and ownership refiner are bundled into the image. It does not need a database
or a mounted volume.

## Choose CPU or GPU

Use the CPU image when traffic is light or the host has no NVIDIA GPU. Use the
GPU image for production throughput. Both images expose the same API on port
`8200`.

The GPU host must be Linux with:

- a compatible NVIDIA driver;
- Docker;
- NVIDIA Container Toolkit.

Confirm Docker can see the GPU before building JewelSense:

```bash
docker run --rm --gpus all nvidia/cuda:13.0.2-base-ubuntu24.04 nvidia-smi
```

If this command fails, fix the host's NVIDIA container setup first.

## Run on CPU

From the repository root:

```bash
docker compose up --build -d
```

The service is available at `http://localhost:8200`. To use another host port:

```bash
JEWELSENSE_PORT=8080 docker compose up --build -d
```

View logs or stop the service:

```bash
docker compose logs -f api
docker compose down
```

## Run on an NVIDIA GPU

Build and start the GPU image:

```bash
docker build -f deploy/Dockerfile.gpu -t jewelsense-api:gpu .
docker run -d \
  --name jewelsense-api \
  --restart unless-stopped \
  --gpus all \
  -p 8200:8200 \
  jewelsense-api:gpu
```

Do not override `RING_PROVIDER`. The GPU image sets it to
`CUDAExecutionProvider` and the service refuses to start if CUDA is not
actually available. This prevents an unnoticed CPU fallback.

## Verify the deployment

Wait for the container to become healthy:

```bash
docker inspect --format '{{.State.Health.Status}}' jewelsense-api
curl http://localhost:8200/health
```

For CPU, `/health` should include:

```json
{
  "ok": true,
  "provider_required": "CPUExecutionProvider"
}
```

For GPU, it should include:

```json
{
  "ok": true,
  "provider_required": "CUDAExecutionProvider"
}
```

Then test an actual image:

```bash
curl -f \
  -F 'file=@ring.jpg' \
  http://localhost:8200/segment/front \
  --output front.png
```

Open `http://localhost:8200/` to use the bundled testing frontend.

## Publish to a registry

Use an immutable release tag so rollback is straightforward:

```bash
docker tag jewelsense-api:gpu registry.example.com/jewelsense-api:2026-09-01
docker push registry.example.com/jewelsense-api:2026-09-01
```

On the production host, pull that exact tag and run it with the same GPU
command shown above. To roll back, start the previous tag.

## Production settings

The useful runtime settings are:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8200` | Port inside the container. |
| `WEB_CONCURRENCY` | `1` | Uvicorn worker count. Keep this at one unless memory use is measured. |
| `RING_THREADS` | `4` | CPU threads used by ONNX Runtime. |
| `RING_PROVIDER` | Set by image | `CPUExecutionProvider` or `CUDAExecutionProvider`. |
| `FORWARDED_ALLOW_IPS` | `*` | Proxies whose forwarded headers Uvicorn accepts. Restrict this on an untrusted network. |
| `GEM_CANVAS_PX` | `500` | Width of the transparent gemstone canvas; output height is trimmed. |
| `GEM_CANVAS_MM` | `20` | Physical width represented by that canvas. |
| `GEM_MAX_DIMENSION_MM` | `20` | Largest accepted gemstone width or height. |
| `GEM_DEFAULT_WIDTH_MM` | `10` | Gemstone width used when the request omits both dimensions. |
| `GEM_DEFAULT_HEIGHT_MM` | `10` | Gemstone height used when the request omits both dimensions. |

Do not tune segmentation thresholds in production without rerunning the
benchmark. The defaults in `deploy/serve.py` are part of the validated model
pipeline.

Each worker loads both ONNX models. Start with one worker per container and
scale by running more containers behind a load balancer. This avoids loading
several model copies into one GPU.

## Reverse proxy and frontend

The simplest deployment serves the bundled frontend and API from the same
hostname. The API currently permits cross-origin requests from any origin so
the separate frontend can integrate during development. Restrict origins at
the gateway before exposing the service publicly.

At the proxy or ingress:

- allow `POST` requests with `multipart/form-data`;
- set the upload limit high enough for catalogue images;
- use a request timeout of at least 30 seconds;
- enable TLS;
- add authentication if the endpoint is public.

Do not expose the container's development port directly to the public
internet. Put it behind the platform ingress or a reverse proxy.

## Deployment checklist

Before directing traffic to a new image:

1. `/health` returns HTTP 200 and the expected provider.
2. A real ring produces non-empty `full`, `front`, and `back` layers.
3. A real gemstone succeeds through `/segment-gem` with explicit `width` and
   `height`, and the returned PNG/header dimensions match the requested scale.
4. Container memory remains stable under expected concurrency.
5. The previous immutable image tag is still available for rollback.
