# syntax=docker/dockerfile:1

# CPU production image. Use Dockerfile.gpu on an NVIDIA host.
FROM python:3.11-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8200 \
    WEB_CONCURRENCY=1 \
    RING_MODEL=deploy/model.onnx \
    RING_OWNERSHIP_REFINER=deploy/ownership_refiner.onnx \
    RING_PROVIDER=CPUExecutionProvider \
    RING_THREADS=4

WORKDIR /app

# Install dependencies before copying application files so code-only changes
# can reuse Docker's dependency layer.
COPY deploy/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

RUN groupadd --system jewelsense \
    && useradd --system --gid jewelsense --create-home jewelsense

COPY --chown=jewelsense:jewelsense deploy /app/deploy
COPY --chown=jewelsense:jewelsense vto/__init__.py vto/post.py /app/vto/

USER jewelsense

EXPOSE 8200

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import json, os, urllib.request; data=json.load(urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '8200') + '/health', timeout=4)); assert data['ok']" || exit 1

# One worker loads one copy of both ONNX models. Scale with containers rather
# than increasing WEB_CONCURRENCY unless memory use has been measured.
CMD ["sh", "-c", "exec uvicorn deploy.serve:app --host 0.0.0.0 --port \"${PORT}\" --workers \"${WEB_CONCURRENCY}\" --proxy-headers --forwarded-allow-ips \"${FORWARDED_ALLOW_IPS:-*}\""]
