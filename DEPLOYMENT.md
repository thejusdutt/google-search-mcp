# Deployment Guide for TUI AD Integration

This guide explains how to deploy the Google Search MCP server with TUI Active Directory authentication.

## Architecture

- **Authentication**: TUI AD SSO via JWT tokens
- **Google API Keys**: Users provide their own keys with each request
- **Hosting**: Custom infrastructure (Kubernetes, Docker, etc.)
- **Gateway**: `https://mcp.devops.tui/google-search/mcp`

## Prerequisites

1. Access to TUI's Kubernetes cluster or hosting infrastructure
2. A bearer token for MCP Registry health checks
3. (Optional) Default Google API credentials for fallback

## Step 1: Build the Docker Image

```bash
# Build the project
npm run build

# Build Docker image
docker build -t google-search-mcp:latest .
```

## Step 2: Deploy to Infrastructure

### Kubernetes Example

Create a deployment manifest:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: google-search-mcp
  namespace: your-namespace
spec:
  replicas: 2
  selector:
    matchLabels:
      app: google-search-mcp
  template:
    metadata:
      labels:
        app: google-search-mcp
    spec:
      containers:
      - name: google-search-mcp
        image: google-search-mcp:latest
        ports:
        - containerPort: 3000
        env:
        - name: HOSTED_MODE
          value: "true"
        - name: HEALTH_CHECK_TOKEN
          valueFrom:
            secretKeyRef:
              name: google-search-mcp-secrets
              key: health-check-token
        # Optional: Default Google API credentials
        - name: GOOGLE_API_KEY
          valueFrom:
            secretKeyRef:
              name: google-search-mcp-secrets
              key: google-api-key
              optional: true
        - name: GOOGLE_CX
          valueFrom:
            secretKeyRef:
              name: google-search-mcp-secrets
              key: google-cx
              optional: true
---
apiVersion: v1
kind: Service
metadata:
  name: google-search-mcp
  namespace: your-namespace
spec:
  selector:
    app: google-search-mcp
  ports:
  - port: 80
    targetPort: 3000
  type: ClusterIP
```

Create secrets:

```bash
kubectl create secret generic google-search-mcp-secrets \
  --from-literal=health-check-token='your-bearer-token' \
  --from-literal=google-api-key='optional-default-key' \
  --from-literal=google-cx='optional-default-cx' \
  -n your-namespace
```

## Step 3: Register with MCP Gateway

### Option A: Via Runway UI

1. Go to Runway MCP Registry
2. Click "Register MCP Server"
3. Select "Put MCP Server behind TUI AD" → "Custom Infrastructure"
4. Fill in:
   - **Name**: Google Search Server
   - **URL**: `http://google-search-mcp.your-namespace.svc.cluster.local`
   - **Tools Authentication Method**: Bearer Token
   - **Bearer Token**: Your health check token
   - **Owner**: Your Runway Group
   - **Description**: See below

```
MCP server for comprehensive web search using Google Custom Search JSON API with full page content extraction.

Tools:
- google_search: Fast snippet-only search
- deep_search: Full content extraction with Readability
- deep_search_news: News-optimized search

Users provide their own Google API credentials via tool parameters (google_api_key and google_cx).

GitHub: https://github.com/thejusdutt/google-search-mcp
```

### Option B: Via MCPProxy CRD

Create an MCPProxy custom resource:

```yaml
apiVersion: mcp.devops.tui/v1
kind: MCPProxy
metadata:
  name: google-search
spec:
  targetUrl: http://google-search-mcp.your-namespace.svc.cluster.local
  authMethod: bearer
  bearerToken: your-health-check-token
  path: /google-search/mcp
```

## Step 4: User Configuration

After deployment, users access the server via the Gateway:

```json
{
  "mcpServers": {
    "google-search": {
      "url": "https://mcp.devops.tui/google-search/mcp",
      "auth": {
        "type": "oauth2"
      }
    }
  }
}
```

Users provide their Google API credentials with each tool call:

```javascript
google_search({
  query: "React best practices",
  google_api_key: "user-api-key",
  google_cx: "user-cx-id"
})
```

## Authentication Flow

1. User authenticates with TUI AD via OAuth2
2. Gateway validates JWT token against `https://idp.devops.tui/keys`
3. Request forwarded to MCP server with JWT in `Authorization` header
4. MCP server validates token (or accepts health check bearer token)
5. User's Google API credentials passed as tool parameters
6. Search performed with user's quota

## Monitoring

The MCP Registry performs periodic health checks using the bearer token. Ensure your server responds to health check requests.

## Troubleshooting

### Authentication Errors

- Verify `HOSTED_MODE=true` is set
- Check `HEALTH_CHECK_TOKEN` matches what's registered
- Ensure JWT validation endpoint is accessible: `https://idp.devops.tui/keys`

### Google API Errors

- Users must provide valid `google_api_key` and `google_cx` parameters
- Or set default credentials via `GOOGLE_API_KEY` and `GOOGLE_CX` environment variables

### Health Check Failures

- Verify bearer token is correct
- Check server logs for authentication errors
- Ensure server is accessible from MCP Registry

## Security Notes

1. **Never log or store user JWT tokens**
2. **Health check bearer token should be kept secret**
3. **User Google API keys are passed per-request, not stored**
4. **Validate all JWT tokens against TUI IdP**

## Support

For issues or questions:
- GitHub: https://github.com/thejusdutt/google-search-mcp/issues
- Internal: Contact your Runway Group owner
