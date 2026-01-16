# MCP Registry Documentation

## Overview

The MCP Registry is a catalog in Runway where teams can discover and register Model Context Protocol (MCP) servers. MCP is a protocol that allows tools and data sources to be exposed to AI assistants.

## MCP Gateway

The MCP Gateway is a reverse proxy that adds OAuth2 authentication to MCP servers. It allows teams to expose their MCP servers to TUI colleagues authenticated via TUI Active Directory SSO, eliminating the need to implement authentication in each MCP server individually.

For MCP servers that require AWS IAM authentication, the Gateway integrates with an AWS SigV4 proxy that signs requests and forwards them to the destination server.

## Supported Server Types

The MCP Registry supports three types of MCP servers:

| Type | Authentication | Hosting | Gateway Required |
|------|---------------|---------|------------------|
| AWS AgentCore Runtime | TUI AD SSO | AWS AgentCore Runtime | Yes |
| Custom Infrastructure | TUI AD SSO | Custom platform/infrastructure (e.g. Kubernetes) | Yes |
| Third-Party | Own authentication | External or internal | No |

### TUI AD Authenticated Servers

**AWS AgentCore Runtime and Custom Infrastructure:**
- Both variants register with the MCP Gateway
- Gateway adds OAuth2 authentication via TUI Active Directory
- Users authenticate once with their TUI credentials
- Suitable for internal tools and services
- AWS AgentCore Runtime servers can be created using the AWS Bedrock AgentCore Deployment template

### Third-Party Servers

- External or internal MCP servers with their own authentication
- Registered in the catalog for discovery only
- Users authenticate directly with the service (authentication handled by the server itself)
- Gateway integration not required

## Cross-Account AWS Access

For AWS AgentCore Runtime servers hosted in different AWS accounts, the SigV4 proxy supports cross-account access through IAM role assumption.

### Setup Requirements

1. Create an IAM role in your AWS account with permissions to access the AgentCore Runtime

2. Configure the role's trust policy to allow the SigV4 proxy to assume it:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::251673624907:role/ehda-prod-mcp-sigv4-proxy"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

3. Specify the role ARN when registering the MCP server in Runway

4. The SigV4 proxy will assume this role before signing requests to your AgentCore Runtime

## Registration Details

### Server Information

When registering an MCP server, you need to provide:

- **Name**: Descriptive name for your server (avoid using "MCP" in the name)
- **Description**: Detailed description of what the server does
- **Owner**: Runway Group that owns this MCP server. All members of the configured Runway group have permission to delete the MCP server

### Configuration by Type

#### AWS AgentCore Runtime (TUI AD)

- **Agent Runtime ARN**: The AgentCore Runtime ARN where your MCP server is deployed
- **IAM Role ARN**: IAM role that allows invoking the AgentCore Runtime and can be assumed by the SigV4 proxy
- **Gateway URL**: `https://mcp.devops.tui/<name-as-slug>/mcp`

#### Custom Infrastructure (TUI AD)

- **URL**: The URL where your MCP server is accessible (can be internal)
- **Tools Authentication Method**: None or Bearer Token (authentication method used by the MCP Registry to perform health checks and fetch tools from your MCP server)
- **Bearer Token**: Required if authentication method is Bearer. This token is used by the MCP Registry for health checks and tool discovery. End users accessing your MCP server will authenticate with their own JWT token issued by our IdP, not this bearer token.
- **Gateway URL**: `https://mcp.devops.tui/<name-as-slug>/mcp`

#### Third-Party

- **URL**: The URL where the third-party MCP server is accessible
- No Gateway integration

## Authentication and Authorization

### Authentication

The authentication mechanism varies depending on your hosting platform choice:

#### AWS AgentCore Runtime

When using AWS AgentCore Runtime, all requests are routed through the AWS SigV4 Proxy. This proxy:

- Assumes the IAM role you specified during registration
- Signs requests using AWS Signature Version 4
- Forwards authenticated requests to your AgentCore Runtime

You can leverage AWS IAM in your MCP server for authentication. The user's JWT token (containing email and other user information) is forwarded in the `X-Original-Authorization` header. However, since AgentCore Runtime requires custom headers to have a specific prefix, the token is accessible under:

```
X-Amzn-Bedrock-AgentCore-Runtime-Custom-Authorization
```

**Important**: Add `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Authorization` to the allowlist in your AgentCore Runtime configuration (all custom headers must have the `X-Amzn-Bedrock-AgentCore-Runtime-Custom-` prefix).

#### Custom Infrastructure

For custom-hosted MCP servers, you need to implement two authentication mechanisms:

1. **Bearer Token Authentication** (for MCP Registry operations):
   - Used by the MCP Registry to perform health checks and fetch available tools
   - Configure a static bearer token during registration
   - Validate this token for requests from the MCP Registry

2. **JWT Token Validation** (for end-user requests):
   - End users access your MCP server through the Gateway with their own JWT token issued by our IdP
   - The JWT token is sent in the standard Authorization header
   - Validate tokens against: `https://idp.devops.tui/keys`

### Authorization

To implement authorization in your MCP server, extract user information from the JWT token to determine which user is accessing your server.

#### JWT Token Location

| Hosting Platform | Header Name |
|-----------------|-------------|
| AWS AgentCore Runtime | `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Authorization` |
| Custom Infrastructure | `Authorization` |

#### Token Validation and User Extraction

**OIDC Configuration**: `https://idp.devops.tui/.well-known/openid-configuration`

**Example (TypeScript)**:

```typescript
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

const client = jwksClient({
  jwksUri: 'https://idp.devops.tui/keys',
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    const signingKey = key.getPublicKey();
    callback(null, signingKey);
  });
}

// Extract token based on hosting platform
const token =
  req.headers['x-amzn-bedrock-agentcore-runtime-custom-authorization'] ?? // AgentCore
  req.headers['authorization']; // Custom

// Validate and decode token
jwt.verify(token, getKey, { algorithms: ['RS256'] }, (err, decoded) => {
  if (err) {
    // Token validation failed
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Extract user information
  const userEmail = decoded.email;
  const userName = decoded.name;

  // Implement your authorization logic
  if (!isUserAuthorized(userEmail)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  // Process request
});
```

#### Token Validation Steps

1. Extract the JWT token from the appropriate header
2. Verify the token signature using the public keys from `https://idp.devops.tui/keys`
3. Check token expiration
4. Extract user information (email, name, groups, etc.)
5. Implement your authorization logic based on user attributes

## Architecture Overview

The MCP (Model Context Protocol) Registry provides secure access to MCP servers through OAuth2 authentication and AWS IAM integration.

### Components

| Component | Description | Responsibilities |
|-----------|-------------|------------------|
| MCP Gateway | Reverse proxy for MCP servers | - Adds OAuth2 support<br>- Handles dynamic client registration (DCR)<br>- Routes requests to appropriate MCP servers |
| Dex | OpenID Connect (OIDC) server provider | - Manages OAuth2/OIDC flows<br>- Issues access tokens<br>- Integrates with upstream IdP |
| IdP | Identity Provider (Microsoft Entra AD) | - Authenticates users<br>- Provides user identity information<br>- TUI's Active Directory integration |
| AWS SigV4 Proxy | IAM authentication proxy | - Assumes IAM roles<br>- Signs HTTP requests with AWS Signature V4<br>- Forwards authenticated requests to MCP servers |
| MCP Server | Model Context Protocol server | - Custom or AWS AgentCore Runtime hosted<br>- Processes tool calls and requests<br>- Returns responses to clients |

### Authentication Flow

The authentication flow involves the following sequence:

1. User initiates MCP connection
2. MCP Gateway returns 401 Unauthorized with OAuth2 metadata
3. User requests protected resource metadata and OAuth2 server metadata
4. User performs Dynamic Client Registration (DCR) with Dex
5. Dex creates OIDC client and returns credentials
6. Authorization request redirected through IdP (MS Entra AD) and Dex
7. User receives authorization callback
8. User exchanges authorization code for access token
9. User reinitializes MCP connection with access token in Authorization header
10. MCP Gateway verifies access token
11. For AWS servers: SigV4 Proxy assumes IAM role and signs request
12. Request forwarded to MCP Server
13. Server processes tool calls and returns responses

### Authorization Flow

During tool calls:
1. User sends tools/call request with access token
2. MCP Gateway verifies token and forwards request
3. AWS SigV4 Proxy (if applicable) signs request with AWS credentials
4. MCP Server processes request and returns response
5. Response flows back through the gateway to the user

## MCP Registry Workflow

### Registry Components

| Component | Description | Responsibilities |
|-----------|-------------|------------------|
| Runway | Frontend application | - Provides UI for MCP server registration<br>- Displays available MCP servers and tools<br>- Interacts with ContextForge API |
| ContextForge | MCP server management service | - Discovers and catalogs MCP tools<br>- Performs health checks<br>- Maintains MCP server database<br>- Validates server connections |
| MCP Gateway | Reverse proxy for MCP servers | - Optional registration target<br>- Provides OAuth2-protected access<br>- Configured via MCPProxy CRDs |

### Server Registration and Discovery Flow

#### Discovery Flow

1. User browses MCP Registry in Runway
2. Runway fetches server list from ContextForge API (GET /servers)
3. ContextForge returns all registered servers with their available tools
4. Runway displays the catalog to the user

#### Registration Flow

1. User opens registration form in Runway
2. User fills out server details (URL, name, optional Gateway registration)
3. Runway submits registration request to ContextForge (POST /servers)
4. ContextForge validates connection to MCP server
5. ContextForge fetches available tools from MCP server
6. ContextForge stores server and tools in database
7. If Gateway registration selected, Runway creates an MCPProxy CRD in the Kubernetes cluster
8. Gateway watches CRD and configures proxy automatically
9. User receives confirmation of successful registration

#### Maintenance

- ContextForge continuously performs health checks on registered servers
- Database is updated with current server status and available tools
- Health check loop runs periodically to maintain server status accuracy

## Key URLs and Endpoints

- **Gateway Base URL**: `https://mcp.devops.tui/<name-as-slug>/mcp`
- **IdP OIDC Configuration**: `https://idp.devops.tui/.well-known/openid-configuration`
- **JWT Validation Keys**: `https://idp.devops.tui/keys`
- **SigV4 Proxy IAM Role**: `arn:aws:iam::251673624907:role/ehda-prod-mcp-sigv4-proxy`

## Best Practices

1. **Naming**: Avoid using "MCP" in your server name
2. **Security**: Never share bearer tokens used for health checks with end users
3. **Authorization**: Always validate JWT tokens and implement proper authorization logic
4. **IAM Roles**: For cross-account access, ensure trust policies are properly configured
5. **Health Checks**: Ensure your MCP server responds to health check requests from ContextForge
6. **Custom Headers**: For AgentCore Runtime, remember to add custom headers to the allowlist

---

**Document Metadata:**
- Component: backstage
- Owner: Developer Experience
- Lifecycle: production
- Source: Runway - TUI's Developer Portal based on backstage.io
