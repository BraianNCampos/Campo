# Contexto de build: apps/ingest  (docker build -t campo-ingest apps/ingest)
FROM golang:1.24.7-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags="-s -w" -o /out/ingest ./cmd/ingest \
 && go build -trimpath -ldflags="-s -w" -o /out/simulator ./cmd/simulator

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/ingest /out/simulator /
EXPOSE 8080
USER nonroot:nonroot
# El simulador se lanza con: docker run --entrypoint /simulator campo-ingest -broker tcp://mqtt:1883
ENTRYPOINT ["/ingest"]
