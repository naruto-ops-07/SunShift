# Build from the repository root:  docker build -f api/Dockerfile -t sunshift-api .
FROM python:3.11-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 SUNSHIFT_ROSTER=/app/shared/feeder07.json
COPY api/requirements.txt /app/api/requirements.txt
RUN pip install --no-cache-dir -r /app/api/requirements.txt
COPY shared /app/shared
COPY api /app/api
WORKDIR /app/api
EXPOSE 8000
CMD ["sh", "-c", "uvicorn sunshift.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
