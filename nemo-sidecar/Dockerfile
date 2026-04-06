# NeMo Guardrails Sidecar for Cushion Gov
#
# This runs the NeMo Guardrails server as a sidecar service alongside
# the main Express application. The Express app calls this service
# via REST to apply Colang-defined guardrails.
#
# Build:  docker build -t cushion-gov-nemo-sidecar ./nemo-sidecar
# Run:    docker run -p 8090:8090 -e OPENAI_API_KEY=$OPENAI_API_KEY cushion-gov-nemo-sidecar
#
# Or use docker-compose (see docker/docker-compose.yml)

FROM python:3.11-slim

WORKDIR /app

# Install NeMo Guardrails
RUN pip install --no-cache-dir nemoguardrails

# Copy guardrail configuration
COPY config/ /app/config/

EXPOSE 8090

# Start the NeMo Guardrails API server
CMD ["nemoguardrails", "server", "--config", "/app/config", "--port", "8090"]
