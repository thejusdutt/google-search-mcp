# Google Search MCP Server

An MCP (Model Context Protocol) server that performs comprehensive web searches using Google Custom Search JSON API with advanced content extraction using Mozilla's Readability algorithm.

## Features

- **Three Search Modes**:
  - `google_search` - Fast snippet-only search for quick lookups
  - `deep_search` - Full content extraction with Readability algorithm
  - `deep_search_news` - News-optimized deep search
- **Google Custom Search API** - Uses official Google Custom Search JSON API
- **Advanced Content Extraction** - Uses Mozilla's Readability algorithm (same as Firefox Reader View) for clean article extraction
- **Multiple Search Types** - Web search, news search, and image search
- **Domain Filtering** - Include or exclude specific domains from results
- **Retry Logic** - Automatic retries with exponential backoff for reliability
- **Controlled Concurrency** - Fetches pages in batches to avoid overwhelming servers

## Deployment Modes

This MCP server supports two deployment modes:

### 1. Local/Third-Party Mode (Default)
Run via npx with user-provided Google API credentials:
```json
{
  "mcpServers": {
    "google-search": {
      "command": "npx",
      "args": ["-y", "@thejusdutt/google-search-mcp"],
      "env": {
        "GOOGLE_API_KEY": "your-google-api-key",
        "GOOGLE_CX": "your-search-engine-id"
      }
    }
  }
}
```

### 2. Hosted Mode with TUI AD Authentication
Deploy to infrastructure with TUI Active Directory SSO authentication:

**Environment Variables:**
- `HOSTED_MODE=true` - Enables authentication
- `HEALTH_CHECK_TOKEN` - Bearer token for MCP Registry health checks
- `GOOGLE_API_KEY` (optional) - Default API key if users don't provide their own
- `GOOGLE_CX` (optional) - Default Search Engine ID if users don't provide their own

**Authentication:**
- Health checks use bearer token authentication
- End users authenticate via TUI AD (JWT tokens validated against `https://idp.devops.tui/keys`)
- Users can pass their own `google_api_key` and `google_cx` parameters with each tool call

**Gateway URL:** `https://mcp.devops.tui/google-search/mcp`

## Prerequisites

### Get Google Custom Search API Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the "Custom Search API"
4. Go to "Credentials" and create an API key
5. Go to [Programmable Search Engine](https://programmablesearchengine.google.com/)
6. Create a new search engine and get your Search Engine ID (CX)

You'll need:
- `GOOGLE_API_KEY` - Your Google Cloud API key
- `GOOGLE_CX` - Your Programmable Search Engine ID

## Installation

### Using npx (Recommended)

No installation needed - just configure your MCP client:

```json
{
  "mcpServers": {
    "google-search": {
      "command": "npx",
      "args": ["-y", "@thejusdutt/google-search-mcp"],
      "env": {
        "GOOGLE_API_KEY": "your-google-api-key",
        "GOOGLE_CX": "your-search-engine-id"
      }
    }
  }
}
```

### Global Installation

```bash
npm install -g @thejusdutt/google-search-mcp
```

Then configure:

```json
{
  "mcpServers": {
    "google-search": {
      "command": "google-search-mcp",
      "env": {
        "GOOGLE_API_KEY": "your-google-api-key",
        "GOOGLE_CX": "your-search-engine-id"
      }
    }
  }
}
```

## Tools

### `google_search`

Simple Google search for quick lookups. Returns snippets only without fetching full page content.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | The search query |
| `num_results` | number | 10 | Number of results (1-10) |
| `google_api_key` | string | - | Google API key (optional, uses server default) |
| `google_cx` | string | - | Search Engine ID (optional, uses server default) |

**Example:**

```javascript
// Quick search with snippets only
google_search({ query: "React hooks tutorial" })

// With custom API credentials
google_search({ 
  query: "React hooks tutorial",
  google_api_key: "your-key",
  google_cx: "your-cx"
})
```

### `deep_search`

Comprehensive web search with full content extraction.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | The search query |
| `num_results` | number | 10 | Number of results (1-10) |
| `max_content_per_page` | number | 50000 | Max characters per page (5000-100000) |
| `search_type` | string | "web" | Search type: "web", "news", or "images" |
| `include_domains` | string | - | Comma-separated domains to include |
| `exclude_domains` | string | - | Comma-separated domains to exclude |
| `google_api_key` | string | - | Google API key (optional, uses server default) |
| `google_cx` | string | - | Search Engine ID (optional, uses server default) |

**Examples:**

```javascript
// Basic web search
deep_search({ query: "React best practices 2025" })

// News search
deep_search({ query: "AI announcements", search_type: "news" })

// Search specific sites only
deep_search({ 
  query: "TypeScript tips",
  include_domains: "github.com,dev.to"
})

// Exclude certain sites
deep_search({
  query: "web development trends",
  exclude_domains: "pinterest.com,facebook.com"
})
```

### `deep_search_news`

Convenience wrapper for news search. Equivalent to calling `deep_search` with `search_type: "news"` and optimized content limits.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | The news topic to search |
| `num_results` | number | 10 | Number of articles (1-10) |
| `max_content_per_page` | number | 30000 | Max characters per article |
| `google_api_key` | string | - | Google API key (optional, uses server default) |
| `google_cx` | string | - | Search Engine ID (optional, uses server default) |

**Example:**

```javascript
deep_search_news({ query: "OpenAI latest updates" })
```

## Configuration

### Kiro

Add to `~/.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "google-search": {
      "command": "npx",
      "args": ["-y", "@thejusdutt/google-search-mcp"],
      "env": {
        "GOOGLE_API_KEY": "your-google-api-key",
        "GOOGLE_CX": "your-search-engine-id"
      }
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "google-search": {
      "command": "npx",
      "args": ["-y", "@thejusdutt/google-search-mcp"],
      "env": {
        "GOOGLE_API_KEY": "your-google-api-key",
        "GOOGLE_CX": "your-search-engine-id"
      }
    }
  }
}
```

## How It Works

1. **Search** - Queries Google Custom Search API to get top results
2. **Fetch** - Downloads each result page with retry logic
3. **Extract** - Uses Mozilla Readability to extract clean article content
4. **Format** - Returns consolidated markdown with full content from each page

## Requirements

- Node.js 18+
- Google Cloud API key with Custom Search API enabled
- Programmable Search Engine ID (CX)

## License

MIT

## Author

[thejusdutt](https://github.com/thejusdutt)

## Contributing

Issues and PRs welcome at [GitHub](https://github.com/thejusdutt/google-search-mcp)
